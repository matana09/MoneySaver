// importer.js — פרסינג CSV/PDF של בנקים וחברות אשראי ישראליות + זיהוי כפילויות
import { parse as parseCsvSync } from 'csv-parse/sync';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db } from '../db.js';
import { suggestCategory } from './categorize.js';
import { findInstallmentPlan, installmentChargeDetails } from './installments.js';
import { findDuplicate } from './duplicates.js';
import { cycleWindow, cycleAnchorOf, cycleAnchorForToday, nextCycleStart, addMonthsClamped } from './dates.js';

const require = createRequire(import.meta.url);

/* ---------- קידוד ---------- */
// קבצי CSV מבנקים ישראליים מגיעים לרוב ב-UTF-8 או windows-1255
export function decodeBuffer(buf) {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (!utf8.includes('�')) return utf8;
  return new TextDecoder('windows-1255').decode(buf);
}

/* ---------- תאריכים וסכומים ---------- */
export function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);                    // ISO
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);        // dd/mm/yyyy
  if (m) {
    const [, d, mo, y] = m;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

export function parseAmount(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/[₪ʼ"']/g, '').replace(/,/g, '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/* ---------- זיהוי עמודות לפי כותרות ---------- */
const COLUMN_HINTS = {
  date:     ['תאריך רכישה', 'תאריך עסקה', 'תאריך העסקה', 'תאריך חיוב', 'תאריך'],
  merchant: ['שם בית עסק', 'שם בית העסק', 'בית עסק', 'תיאור פעולה', 'תיאור', 'פרטים', 'שם העסק'],
  amount:   ['סכום חיוב', 'סכום החיוב', 'סכום עסקה', 'סכום בש"ח', 'סכום'],
  debit:    ['חובה', 'בחובה'],
  credit:   ['זכות', 'בזכות'],
};

function findColumn(headers, hints) {
  for (const hint of hints) {
    const idx = headers.findIndex((h) => h && h.replace(/\s+/g, ' ').trim().includes(hint));
    if (idx !== -1) return idx;
  }
  return -1;
}

/* ---------- CSV ---------- */
export function parseCsv(buf) {
  const text = decodeBuffer(buf).replace(/^﻿/, '');
  let records;
  try {
    records = parseCsvSync(text, { relax_column_count: true, skip_empty_lines: true, trim: true });
  } catch {
    throw new Error('קובץ CSV לא תקין');
  }
  if (!records.length) throw new Error('קובץ ריק');

  // איתור שורת הכותרת (קבצי אשראי מכילים שורות כותרת-על לפני הטבלה)
  let headerIdx = -1, cols = null;
  for (let i = 0; i < Math.min(records.length, 15); i++) {
    const headers = records[i].map(String);
    const dateCol = findColumn(headers, COLUMN_HINTS.date);
    if (dateCol === -1) continue;
    const merchantCol = findColumn(headers, COLUMN_HINTS.merchant);
    const amountCol = findColumn(headers, COLUMN_HINTS.amount);
    const debitCol = findColumn(headers, COLUMN_HINTS.debit);
    const creditCol = findColumn(headers, COLUMN_HINTS.credit);
    if (merchantCol !== -1 && (amountCol !== -1 || debitCol !== -1)) {
      headerIdx = i;
      cols = { dateCol, merchantCol, amountCol, debitCol, creditCol };
      break;
    }
  }
  if (headerIdx === -1) throw new Error('לא זוהו עמודות (תאריך / בית עסק / סכום) — בדוק את פורמט הקובץ');

  const rows = [];
  let skipped = 0;
  for (const rec of records.slice(headerIdx + 1)) {
    const date = parseDate(rec[cols.dateCol]);
    const merchant = String(rec[cols.merchantCol] ?? '').trim();
    let amount = null, type = 'expense';

    if (cols.amountCol !== -1) {
      amount = parseAmount(rec[cols.amountCol]);
      if (amount !== null && amount < 0) { amount = -amount; type = 'income'; } // זיכוי
    }
    if (amount === null && cols.debitCol !== -1) {
      const debit = parseAmount(rec[cols.debitCol]);
      const credit = cols.creditCol !== -1 ? parseAmount(rec[cols.creditCol]) : null;
      if (debit) { amount = debit; type = 'expense'; }
      else if (credit) { amount = credit; type = 'income'; }
    }

    if (!date || !merchant || !amount) { skipped++; continue; }
    rows.push({ date, merchant, amount, type });
  }
  return { rows, skipped, format: 'csv' };
}

/* ---------- PDF ---------- */
// עברית ב-PDF נשמרת לרוב בסדר ויזואלי (הפוך) — היפוך best-effort
export function fixHebrew(s) {
  if (!/[֐-׿]/.test(s)) return s;
  const words = s.split(/\s+/);
  const fixed = words.map((w) => (/[֐-׿]/.test(w) ? [...w].reverse().join('') : w));
  return fixed.reverse().join(' ');
}

// פורמט A (גנרי): תאריך בתחילת השורה, בית עסק, סכום בסוף
const PDF_LINE = /(\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4})\s+(.+?)\s+(-?[\d,]+\.?\d*)\s*₪?\s*$/;

const DATE_ANYWHERE = /(\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4})/;
const MONEY_FIELD = /^-?[\d,]+\.\d{1,2}$/;

// שדה "מידע נוסף" מכיל את מספר התשלום לפני התאריך: "37 / 48 26/07/2023".
// ברכישה רגילה הוא "null 15/07/2026". העוגן לתחילת השדה + הרווח הנדרש אחרי
// המונה מונעים התאמה בטעות לתאריך עצמו ("12/03/2026" — אין רווח לפני '/').
const INSTALLMENT_FIELD = /^(\d+)\s*\/\s*(\d+)\s/;

// פורמט B (אשראי ישראלי, מופרד ב-Tab): "<קוד> <בית עסק>\t<סכום>\tnull <תאריך>\tכן/לא"
// מזוהה לפי: שדה כספי (עם 2 ספרות עשרוניות) + שדה עם תאריך. בית העסק = השדה הראשון בלי הקוד המספרי.
function matchTabbedCredit(line) {
  if (!line.includes('\t')) return null;
  const parts = line.split('\t').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const amountField = parts.find((p) => MONEY_FIELD.test(p.replace(/[₪\s]/g, '')));
  const dateField = parts.find((p) => DATE_ANYWHERE.test(p));
  if (!amountField || !dateField) return null;

  // בית העסק = השדה הראשון, בלי קוד בית העסק המספרי בהתחלה.
  // שמות עסק לועזיים ארוכים (למשל "OPENAI *CHATGPT SUBS") נשברים ב-PDF לשורות
  // נפרדות מהסכום — אז השדה הראשון בשורה הוא הסכום עצמו ואין בו בית עסק.
  // מסמנים merchant=null כדי ש-parseStatementText ישלים אותו מהשורות שקדמו.
  const merchant = MONEY_FIELD.test(parts[0].replace(/[₪\s]/g, ''))
    ? null
    : parts[0].replace(/^\d+\s+/, '').trim() || null;
  const rawDate = dateField.match(DATE_ANYWHERE)[1];
  const inst = dateField.match(INSTALLMENT_FIELD);
  const installment = inst ? { index: Number(inst[1]), count: Number(inst[2]) } : null;
  return { rawDate, merchant, rawAmount: amountField, installment };
}

// פורמט A דרך regex (מחזיר את אותו מבנה כמו matchTabbedCredit)
function matchDateFirst(line) {
  const m = line.match(PDF_LINE);
  if (!m) return null;
  return { rawDate: m[1], merchant: fixHebrew(m[2].trim()), rawAmount: m[3] };
}

// חילוץ טקסט גולמי מ-PDF — משותף לייבוא דוחות בנק ולתלושי משכורת
// (server/lib/payslip.js). מחזיר את הטקסט כפי שהוא; היפוך RTL (fixHebrew)
// נעשה אצל הצרכן, לפי שורה, כי כל פורמט דורש טיפול אחר.
export async function extractPdfText(buf) {
  // pdf-parse v2: מחלקה PDFParse, לא פונקציה. new PDFParse({ data }) → getText()
  const { PDFParse, PasswordException } = require('pdf-parse');
  let text;
  let parser;
  try {
    parser = new PDFParse({ data: buf });
    ({ text } = await parser.getText());
  } catch (err) {
    if (err instanceof PasswordException || /password/i.test(err?.message ?? '')) {
      throw new Error('ה-PDF מוגן בסיסמה — הסר את ההגנה ונסה שוב');
    }
    throw new Error(`קריאת ה-PDF נכשלה: ${err?.message ?? 'קובץ לא תקין'}`);
  } finally {
    try { await parser?.destroy(); } catch { /* noop */ }
  }

  if (!text || !text.trim()) {
    throw new Error('ה-PDF לא מכיל טקסט קריא (כנראה סרוק כתמונה) — נסה CSV או צילום ברור');
  }
  return text;
}

export async function parsePdf(buf) {
  const text = await extractPdfText(buf);
  const { rows, skipped } = parseStatementText(text);
  if (!rows.length) {
    throw new Error('הטקסט נקרא אך לא זוהו שורות עסקה (תאריך + סכום). ייתכן שהפורמט לא נתמך — נסה CSV');
  }
  return { rows, skipped, format: 'pdf' };
}

// טבלת "רכישה בדולר" (מטבע חוץ) — מבנה שונה לגמרי מהטבלה השקלית: אין סכום
// בש"ח (מתברר רק בדוח הבא, כשההמרה כבר בוצעה), ותאריך הרכישה מופיע יחד עם
// הסכום הזר באותו שדה. שם בית העסק לעתים נמשך לשורה *אחרי* השורה (לא לפניה
// כמו בטבלה השקלית) — למשל "ANTHROPIC*" ואז "CLAUDE SU" בשורה הבאה.
// קבוצות: 1=תאריך חיוב (לא בשימוש), 2=סכום זר, 3=מטבע, 4=סכום זר (שוב),
// 5=תאריך רכישה, 6=תחילת שם בית העסק.
const FX_ROW = /^(\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4})\t([\d,]+\.\d{2})\s+\S+\t(.+?)\t([\d,]+\.\d{2})\s+(\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4})\t(.+)$/;
// שורת "כן/לא" (הצגת כרטיס) שמסמנת את סוף שם בית העסק בטבלת המטבע-חוץ
const CARD_FLAG_LINE = /^(כן|לא)$/;

// המרה קבועה לש"ח לעסקאות מטבע-חוץ ידועות — אין שער חליפין בדוח "חיובים
// קרובים", וההמרה בפועל תופיע רק בדוח הבא. עסקה זרה שלא מופיעה כאן מדולגת
// (לא מתועדת בסכום שגוי), עד שתתווסף כאן.
const FOREIGN_CURRENCY_FIXED_ILS = [
  { pattern: /ANTHROPIC|CLAUDE/i, ils: 70, merchant: 'ANTHROPIC CLAUDE' },
];

/** חילוץ שורות עסקה מטקסט דוח (מיוצא לבדיקות רגרסיה על פורמטים אמיתיים) */
// שורות מטא/כותרת שאינן שברי בית עסק (מספרי עמוד, סכום כולל, מסגרת אשראי)
const META_LINE = /^עמוד\b|^--.*--$|סה"כ|^₪/;

export function parseStatementText(text) {
  const rows = [];
  let skipped = 0;
  let pending = []; // שברי שם בית עסק לועזי שנשברו לשורות נפרדות לפני שורת הסכום
  const lines = text.split('\n');

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].trim();
    if (!line) continue;

    const fx = FX_ROW.exec(line);
    if (fx) {
      pending = [];
      // שם בית העסק עשוי להימשך לשורה/שורות הבאות, עד "כן"/"לא" (הצגת כרטיס)
      let merchant = fx[6].trim();
      let peek = idx + 1;
      while (peek < lines.length && lines[peek].trim() && !CARD_FLAG_LINE.test(lines[peek].trim())
        && !FX_ROW.test(lines[peek]) && !lines[peek].includes('\t')) {
        merchant += ' ' + lines[peek].trim();
        peek++;
      }
      idx = peek - 1;

      const known = FOREIGN_CURRENCY_FIXED_ILS.find((f) => f.pattern.test(merchant));
      const date = parseDate(fx[5]);
      if (!known || !date) { skipped++; continue; }
      rows.push({ date, merchant: known.merchant, amount: known.ils, type: 'expense', installment: null });
      continue;
    }

    // מנסה קודם פורמט אשראי מופרד-Tab, אחרת פורמט תאריך-ראשון גנרי
    const parsed = matchTabbedCredit(line) ?? matchDateFirst(line);
    if (!parsed) {
      // שורת טקסט שאינה עסקה — ייתכן שבר של שם בית עסק לועזי שנשבר לשורה נפרדת.
      // נצבור רק שורות טקסט "נקיות" (בלי Tab ובלי מטא), אחרת מאפסים.
      if (!line.includes('\t') && !META_LINE.test(line)) pending.push(line);
      else pending = [];
      skipped++;
      continue;
    }
    // בית עסק חסר בשורה (שם לועזי שנשבר) → משלימים מהשורות שנצברו לפניה
    let merchant = parsed.merchant;
    if (!merchant && pending.length) {
      merchant = pending.join(' ').replace(/^\d+\s+/, '').trim();
    }
    pending = [];
    const date = parseDate(parsed.rawDate);
    let amount = parseAmount(parsed.rawAmount);
    let type = 'expense';
    if (amount !== null && amount < 0) { amount = -amount; type = 'income'; }
    if (!date || !merchant || !amount) { skipped++; continue; }
    rows.push({ date, merchant, amount, type, installment: parsed.installment ?? null });
  }
  return { rows, skipped };
}

/* ---------- כפילויות + העשרה ---------- */
export function externalId(row, seq = 0) {
  return createHash('sha1')
    .update(`${row.date}|${row.amount}|${row.merchant}|${row.type}|${seq}`)
    .digest('hex');
}

/**
 * מידע מחזור לשורת ייבוא: לאיזה מחזור היא תיפול, והאם המחזור הזה כבר נסגר.
 * דוח "פירוט חיובים קרובים" מכיל עסקאות מיום סגירת המחזור — לפי תאריך הרכישה
 * הן נופלות למחזור שכבר חויב, אף שהדוח מציג אותן כחיוב **עתידי**. אנחנו רק
 * מדווחים את העובדה; ההחלטה אם להזיז היא של המשתמש (`next_cycle` בשורה).
 */
function cycleInfo(row, cycleDay, today) {
  const anchor = cycleAnchorForToday(cycleDay, today);
  const current = cycleWindow(anchor, cycleDay);
  const index = Number(row.installment?.index);
  const count = Number(row.installment?.count);
  const installment = row.type === 'expense' && Number.isSafeInteger(index) && Number.isSafeInteger(count)
    && count >= 2 && index >= 1 && index <= count;
  // בדוח תשלומים התאריך הוא תאריך הקנייה; המחזור שייך לתשלום המדווח.
  const date = installment ? addMonthsClamped(row.date, index - 1) : row.date;
  const w = cycleWindow(cycleAnchorOf(date, cycleDay), cycleDay);
  return {
    cycle_label: w.label,
    cycle_closed: date < current.start,       // נופלת למחזור שכבר נסגר
    next_cycle_date: nextCycleStart(date, cycleDay),
    next_cycle: false,                             // ברירת מחדל: לא מזיזים
  };
}

export function enrichRows(rows, source, { fuzzyDup = false, cycleDay = 10, today = new Date() } = {}) {
  const seen = new Map(); // ספירת שכפולים בתוך הקובץ עצמו
  // כפילות "רכה" — תאריך+סכום בלי בית עסק. לייבוא מתמונה (OCR) בלבד: שם בית
  // העסק שה-OCR קרא עלול לצאת שונה מהשם שנשמר בייבוא PDF/SMS קודם של אותה
  // עסקה, וההתאמה המדויקת מפספסת. סימון-יתר זול (checkbox בתצוגה המקדימה),
  // כפילות שנכנסת — יקרה.
  const fuzzyCheck = db.prepare(`
    SELECT id FROM transactions
    WHERE date = ? AND amount = ? AND type = ?
    LIMIT 1
  `);
  const extCheck = db.prepare('SELECT id FROM transactions WHERE source = ? AND external_id = ?');

  return rows.map((row) => {
    const key = `${row.date}|${row.amount}|${row.merchant}|${row.type}`;
    const seq = seen.get(key) ?? 0;
    seen.set(key, seq + 1);
    const ext = externalId(row, seq);
    const suggestion = row.type === 'expense' ? suggestCategory(row.merchant) : null;
    const base = {
      ...row,
      external_id: ext,
      category_id: suggestion?.category_id ?? null,
      category_source: suggestion?.source ?? null,
      ...cycleInfo(row, cycleDay, today),
    };

    // תוכנית תשלומים: מספר התשלום נלקח מעמודת "מידע נוסף" בדוח ("37 / 48"),
    // ולא מהגדלה עיוורת של השורה הקודמת. כל תוכנית מיוצגת בשורה אחת שמספר
    // התשלום שלה מתעדכן במקום — כך שהעלאה חוזרת של אותו דוח אידמפוטנטית.
    if (row.installment) {
      const { index, count } = row.installment;
      const description = `תשלום ${index}/${count}`;
      const plan = findInstallmentPlan(row.merchant, count);
      if (plan) {
        return {
          ...base, description, duplicate: false,
          installment_group: plan.installment_group,
          installment_update: { id: plan.id, description },
        };
      }
      return {
        ...base, description, duplicate: false,
        installment_group: randomUUID(),
        installment_update: null,
      };
    }

    // findDuplicate תופס גם שם חלקי — הדוח מחברת האשראי מרחיב את השם שה-SMS
    // שלח ("MOJO" → "MOJO ASIAN FOODBAR") ובלי זה אותה עסקה נכנסת פעמיים.
    const existing = findDuplicate(row);
    const duplicate = Boolean(existing || extCheck.get(source, ext)
      || (fuzzyDup && fuzzyCheck.get(row.date, row.amount, row.type)));

    return {
      ...base, duplicate, description: '',
      // למה סומנה ככפילות — מוצג בתצוגה המקדימה כדי שההחלטה תהיה מודעת
      duplicate_of: existing ? { id: existing.id, merchant: existing.merchant, source: existing.source, level: existing.level } : null,
      installment_group: null,
      installment_update: null,
    };
  });
}

/* ---------- שמירה ---------- */
export function commitRows(rows, source, { cycleDay = 10 } = {}) {
  const insert = db.prepare(`
    INSERT INTO transactions (date, amount, type, merchant, description, category_id, source, external_id, installment_group, charge_date, installment_charge_index)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, external_id) WHERE external_id IS NOT NULL DO NOTHING
  `);
  const updateInstallment = db.prepare('UPDATE transactions SET description = ? WHERE id = ? AND description IS NOT ?');
  const moveInstallment = db.prepare(`
    UPDATE transactions SET description = ?, charge_date = ?, installment_charge_index = ?
    WHERE id = ? AND (description IS NOT ? OR charge_date IS NOT ? OR installment_charge_index IS NOT ?)
  `);
  const existingInstallment = db.prepare('SELECT * FROM transactions WHERE id = ?');
  const pinInstallmentCharge = db.prepare(`
    UPDATE transactions SET installment_charge_index = ?
    WHERE id = ? AND installment_charge_index IS NULL
  `);
  let inserted = 0, skippedDup = 0, updated = 0;
  for (const row of rows) {
    // תוכנית תשלומים שכבר קיימת: מעדכנים את מספר התשלום במקום, בלי שורה חדשה
    if (row.installment_update) {
      const { description, id } = row.installment_update;
      const existing = existingInstallment.get(id);
      if (row.next_cycle && existing) {
        // אישור מפורש בתצוגה המקדימה מתייחס לתשלום שבדוח החדש.
        const charge = installmentChargeDetails({ ...existing, description, installment_charge_index: null }, 'next', cycleDay);
        updated += Number(moveInstallment.run(description, charge.charge_date, charge.installment_charge_index,
          id, description, charge.charge_date, charge.installment_charge_index).changes);
        continue;
      }
      // בתיעוד ישן בלי מספר מוצמד, מקבעים את התשלום לפני קידום התיאור.
      // התאריך והסכום נשארים ללא שינוי, וגם ייבוא חוזר אינו נספר כעדכון.
      if (existing?.charge_date && existing.installment_charge_index === null) {
        const charge = installmentChargeDetails(existing, existing.charge_date, cycleDay);
        if (charge.installment_charge_index !== null) {
          pinInstallmentCharge.run(charge.installment_charge_index, id);
        }
      }
      // העלאה חוזרת של אותו דוח אינה עדכון ואינה מצדיקה התראה נוספת.
      // מספר תשלום מוצמד שכבר נשמר אינו מתקדם יחד עם התיאור המדווח.
      updated += Number(updateInstallment.run(description, id, description).changes);
      continue;
    }
    if (row.duplicate && !row.force) { skippedDup++; continue; }
    // המשתמש אישר ידנית שורה שסומנה ככפילות (checkbox מסומן למרות הדגל): ה-
    // external_id שלה זהה במתכוון לעסקה קיימת (אותו תאריך+סכום+בית עסק), אז
    // ON CONFLICT יחסום את ההכנסה בשקט גם עם force. מנטרלים dedup רק במקרה הזה,
    // ולא לכל השורות — כדי לשמור הגנה מפני שליחה כפולה של שורות רגילות.
    const externalId = (row.duplicate && row.force) ? null : row.external_id;
    // המשתמש סימן בתצוגה המקדימה "זה החיוב של המחזור הבא" — התאריך מחושב
    // כאן בשרת ממועד התשלום (או מתאריך הרכישה בעסקה רגילה), ולא נלקח מהלקוח.
    const charge = row.next_cycle ? installmentChargeDetails({
      date: row.date, type: row.type, source, description: row.description ?? '',
      installment_group: row.installment_group ?? null,
    }, 'next', cycleDay, { newPlan: true }) : { charge_date: null, installment_charge_index: null };
    const result = insert.run(row.date, row.amount, row.type, row.merchant, row.description ?? '',
      row.category_id ?? null, source, externalId, row.installment_group ?? null,
      charge.charge_date, charge.installment_charge_index);
    if (result.changes > 0) inserted++;
    else skippedDup++;
  }
  return { inserted, skippedDup, updated };
}
