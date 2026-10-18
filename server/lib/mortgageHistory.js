// mortgageHistory.js — היסטוריית תשלומי משכנתא לפי שנה, מתוך "מצב חשבון מתומצת"
// השנתי של הבנק. משלים את טבלת mortgage, שמחזיקה רק מצב נוכחי בלי היסטוריה.
//
// הפרסר מתמודד עם שני מכשולים אמיתיים בטקסט שיוצא מ-PDF של לאומי:
//   1. סדר ויזואלי הפוך — "11 . 11,000" הוא 11,000.11. קיים במקביל לפורמט
//      התקין ("15,500.21"), לפעמים באותו מסמך.
//   2. חילוץ חסר — חלק מהמספרים יוצאים קטועים ("14, 6" במקום 14,000.16).
//      במקרה כזה הרכיב מושלם מתוך הסכום הכולל, שתמיד מופיע במלואו.
// לכן הזרימה היא parse → הצגה לאישור המשתמש → שמירה, ולא שמירה אוטומטית.
import { db } from '../db.js';

/* ---------- זיהוי מספרים ---------- */
// סדר תקין: 15,500.21 ; סדר ויזואלי הפוך: 21 . 15,500
const NUM_STD = /(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})(?![\d.,])/;
const NUM_REV = /(\d{1,2})\s*\.\s*(\d{1,3}(?:,\d{3})*|\d+)(?![\d.,])/;
// תאריכים (31.12.2025, 12/19) — נראים כמו מספרים ונתפסים בטעות
const DATE_RE = /\b\d{1,2}\s*[./]\s*\d{1,2}\s*[./]\s*\d{2,4}\b|\b\d{2}\/\d{2,4}\b/g;

/** המספר הראשון בקטע, בכל אחד משני הפורמטים. תאריכים מוסרים קודם. */
export function firstNumber(raw) {
  const s = String(raw ?? '').replace(DATE_RE, ' ');
  const std = s.match(NUM_STD);
  const rev = s.match(NUM_REV);
  const iStd = std ? std.index : Infinity;
  const iRev = rev ? rev.index : Infinity;
  if (iStd === Infinity && iRev === Infinity) return null;
  if (iStd <= iRev) return parseFloat(std[1].replace(/,/g, '') + '.' + std[2]);
  return parseFloat(rev[2].replace(/,/g, '') + '.' + rev[1]);
}

// חיפוש ערך אחרי תווית. stop מגביל את הקטע כדי שלא ייתפס מספר של השדה הבא.
function grab(chunk, label, stop) {
  const m = chunk.match(label);
  if (!m) return { found: false, val: null };
  let seg = chunk.slice(m.index + m[0].length);
  if (stop) {
    const j = seg.search(stop);
    if (j > 0) seg = seg.slice(0, j);
  }
  return { found: true, val: firstNumber(seg.slice(0, 80)) };
}

/**
 * השלמת רכיב חסר יחיד מתוך הסכום הכולל. פועל רק כשחסר בדיוק אחד — אחרת
 * אי אפשר לדעת איך הפער מתחלק, ועדיף להשאיר null ולתת למשתמש להשלים.
 */
export function fillFromTotal(parts, total) {
  if (typeof total !== 'number') return null;
  const missing = Object.keys(parts).filter((k) => parts[k] == null);
  if (missing.length !== 1) return null;
  const sum = Object.values(parts).reduce((a, b) => a + (b ?? 0), 0);
  const val = Math.round((total - sum) * 100) / 100;
  return val >= 0 ? { key: missing[0], val } : null;
}

/* ---------- הפרסר ---------- */
const YEAR_RE = /מצב\s+חשבון\s+מתומצת\s+לשנת\s+(\d{4})/g;

/**
 * חילוץ כל דוחות "מצב חשבון מתומצת" מטקסט PDF (גם קובץ מאוחד של כמה שנים).
 * מחזיר { rows, warnings } — rows ממוינות לפי שנה, כל שורה עם `derived`
 * (שמות השדות שהושלמו מהסכום) ו-`gap` (סטייה מהסכום המוצהר, לאימות).
 */
export function parseAnnualStatements(text) {
  const src = String(text ?? '');
  const rows = [];
  const warnings = [];
  const marks = [];
  YEAR_RE.lastIndex = 0;
  let m;
  while ((m = YEAR_RE.exec(src))) marks.push({ year: Number(m[1]), idx: m.index });

  for (let i = 0; i < marks.length; i++) {
    const { year } = marks[i];
    const block = src.slice(marks[i].idx, marks[i + 1]?.idx ?? src.length);

    const bIdx = block.search(/ריכוז\s+מרכיבי\s+התשלומים/);
    const dIdx = block.search(/ריכוז\s+יתרות\s+תיקי\s+הלוואות/);
    if (bIdx < 0 && dIdx < 0) {
      warnings.push(`${year}: לא נמצאו סעיפי המרכיבים והיתרות בדוח`);
      continue;
    }
    const b = bIdx >= 0 ? block.slice(bIdx, dIdx > bIdx ? dIdx : bIdx + 900) : '';
    const d = dIdx >= 0 ? block.slice(dIdx, dIdx + 900) : '';

    // סעיף ב — מרכיבי התשלומים ששולמו במהלך השנה
    const paidTotal = grab(b, /סה"כ/, null).val;
    // "הוצאות אחרות" מופיע רק בחלק מהשנים — היעדר התווית פירושו 0, לא חסר
    const other = grab(b, /הוצאות\s+אחרות[^\n]*?\(/, /סה"כ/);
    const paid = {
      paid_principal:     grab(b, /קרן\s/, /הצמדת/).val,
      paid_cpi_principal: grab(b, /הצמדת\s+קרן/, /ריבית/).val,
      paid_interest:      grab(b, /(?:^|[^ת])\s*ריבית(?!\s+שהצטברה)/, /הצמדת|סה"כ/).val,
      paid_cpi_interest:  grab(b, /הצמדת\s+ריבית/, /הוצאות|סה"כ/).val,
      paid_other:         other.found ? other.val : 0,
    };
    const fixPaid = fillFromTotal(paid, paidTotal);
    if (fixPaid) paid[fixPaid.key] = fixPaid.val;

    // סעיף ד — יתרות ליום 31.12 של אותה שנה
    const balTotal = grab(d, /סה"כ\s+יתרות/, null).val;
    const bal = {
      bal_principal: grab(d, /יתרות\s+קרן/, /הפרשי/).val,
      bal_cpi:       grab(d, /הפרשי\s+הצמדה/, /ריבית/).val,
      bal_accrued:   grab(d, /ריבית\s+שהצטברה/, /סה"כ/).val,
    };
    const fixBal = fillFromTotal(bal, balTotal);
    if (fixBal) bal[fixBal.key] = fixBal.val;

    const derived = [fixPaid?.key, fixBal?.key].filter(Boolean);
    const gapOf = (parts, total) => (typeof total === 'number'
      ? Math.round((Object.values(parts).reduce((a, x) => a + (x ?? 0), 0) - total) * 100) / 100
      : null);

    const row = {
      year, ...paid, paid_total: paidTotal, ...bal, bal_total: balTotal,
      derived,
      gap_paid: gapOf(paid, paidTotal),
      gap_bal: gapOf(bal, balTotal),
    };
    // סטייה מעל שקל = הפרסר קרא משהו לא נכון; המשתמש רואה אזהרה ומתקן ידנית
    if (row.gap_paid !== null && Math.abs(row.gap_paid) > 1) {
      warnings.push(`${year}: מרכיבי התשלומים לא מסתכמים לסה"כ (פער ${row.gap_paid} ש"ח)`);
    }
    if (row.gap_bal !== null && Math.abs(row.gap_bal) > 1) {
      warnings.push(`${year}: מרכיבי היתרה לא מסתכמים לסה"כ (פער ${row.gap_bal} ש"ח)`);
    }
    rows.push(row);
  }
  rows.sort((a, b2) => a.year - b2.year);
  if (!rows.length) warnings.push('לא נמצא אף דוח "מצב חשבון מתומצת לשנת ..." בקובץ');
  return { rows, warnings };
}

/* ---------- נרמול ואחסון ---------- */
const NUM_FIELDS = [
  'paid_principal', 'paid_cpi_principal', 'paid_interest', 'paid_cpi_interest',
  'paid_other', 'paid_total', 'bal_principal', 'bal_cpi', 'bal_accrued', 'bal_total',
];

const MIN_YEAR = 1980;
const MAX_YEAR = 2100;

/** נרמול שורה בודדת — whitelist קשיח, שנה תקינה, מספרים לא שליליים */
export function normalizeHistoryRow(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const year = Number(src.year);
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) return null;
  const out = { year };
  for (const k of NUM_FIELDS) {
    const v = src[k];
    if (v === null || v === undefined || v === '') continue;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.-]/g, ''));
    if (Number.isFinite(n) && n >= 0) out[k] = Math.round(n * 100) / 100;
  }
  return out;
}

/** נרמול מערך שורות — שנה כפולה נשמרת פעם אחת (האחרונה גוברת) */
export function normalizeHistory(input = []) {
  const arr = Array.isArray(input) ? input : [];
  const byYear = new Map();
  for (const raw of arr) {
    const row = normalizeHistoryRow(raw);
    if (row) byYear.set(row.year, row);
  }
  return [...byYear.values()].sort((a, b) => a.year - b.year);
}

/** כל שורות ההיסטוריה, ממוינות לפי שנה */
export function mortgageHistory() {
  return db.prepare(`
    SELECT year, paid_principal, paid_cpi_principal, paid_interest, paid_cpi_interest,
           paid_other, paid_total, bal_principal, bal_cpi, bal_accrued, bal_total
    FROM mortgage_history ORDER BY year
  `).all();
}

/**
 * שמירת שורות (upsert לפי שנה — שנים אחרות שכבר קיימות לא נמחקות).
 * העדכון עטוף בטרנזקציה כדי שקובץ שנטען חלקית לא ישאיר היסטוריה חצי-מעודכנת.
 * `node:sqlite` לא מספק `db.transaction()` של better-sqlite3 — לכן BEGIN ידני.
 */
export function saveHistory(rowsInput) {
  const rows = normalizeHistory(rowsInput);
  const cols = ['year', ...NUM_FIELDS];
  const stmt = db.prepare(`
    INSERT INTO mortgage_history (${cols.join(', ')})
    VALUES (${cols.map(() => '?').join(', ')})
    ON CONFLICT(year) DO UPDATE SET
      ${NUM_FIELDS.map((c) => `${c} = excluded.${c}`).join(',\n      ')},
      updated_at = datetime('now','localtime')
  `);
  db.exec('BEGIN');
  try {
    for (const row of rows) stmt.run(...cols.map((c) => row[c] ?? null));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return mortgageHistory();
}

/** מחיקת שנה בודדת */
export function deleteHistoryYear(year) {
  const y = Number(year);
  if (!Number.isInteger(y)) return 0;
  return db.prepare('DELETE FROM mortgage_history WHERE year = ?').run(y).changes;
}

/** מחיקת כל ההיסטוריה */
export function clearHistory() {
  return db.prepare('DELETE FROM mortgage_history').run().changes;
}

/* ---------- תובנות מחושבות ---------- */
const sum = (rows, key) => rows.reduce((a, r) => a + (r[key] ?? 0), 0);

/**
 * המספרים שעונים על השאלה "למה היתרה לא יורדת": כמה קרן נפרעה בפועל מול
 * כמה הצמדה נצברה במקביל. פונקציה טהורה — נבדקת בלי DB.
 */
export function historyDerived(rows = []) {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => a.year - b.year);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const paidTotal = sum(sorted, 'paid_total');
  const paidPrincipal = sum(sorted, 'paid_principal');
  const paidInterest = sum(sorted, 'paid_interest') + sum(sorted, 'paid_cpi_interest');
  const cpiAdded = (last.bal_cpi ?? 0) - (first.bal_cpi ?? 0);
  const balanceDrop = (first.bal_total ?? 0) - (last.bal_total ?? 0);
  return {
    years: sorted.length,
    from_year: first.year,
    to_year: last.year,
    paid_total: Math.round(paidTotal * 100) / 100,
    paid_principal: Math.round(paidPrincipal * 100) / 100,
    paid_interest: Math.round(paidInterest * 100) / 100,
    // אחוז מכל שקל ששולם שהלך להקטנת הקרן
    principal_share: paidTotal > 0 ? Math.round((paidPrincipal / paidTotal) * 1000) / 10 : null,
    cpi_added: Math.round(cpiAdded * 100) / 100,
    balance_drop: Math.round(balanceDrop * 100) / 100,
    principal_drop: Math.round(((first.bal_principal ?? 0) - (last.bal_principal ?? 0)) * 100) / 100,
  };
}

const fmt = (n) => (typeof n === 'number'
  ? new Intl.NumberFormat('he-IL', { maximumFractionDigits: 0 }).format(n) : '—');

/** טבלת ההיסטוריה לפרומפט — מוסיפה למודל את המגמה, לא רק תמונת רגע */
export function historySummary(rows = []) {
  if (!rows.length) return '';
  const head = '| שנה | שולם קרן | שולם ריבית | הצמדת קרן | הצמדת ריבית | סה"כ שולם | יתרת קרן | הפרשי הצמדה | יתרה כוללת |';
  const sep = '|---|---|---|---|---|---|---|---|---|';
  const body = [...rows].sort((a, b) => a.year - b.year).map((r) => `| ${r.year} | ${
    fmt(r.paid_principal)} | ${fmt(r.paid_interest)} | ${fmt(r.paid_cpi_principal)} | ${
    fmt(r.paid_cpi_interest)} | ${fmt(r.paid_total)} | ${fmt(r.bal_principal)} | ${
    fmt(r.bal_cpi)} | ${fmt(r.bal_total)} |`);
  const d = historyDerived(rows);
  const note = d ? `\nסיכום ${d.years} השנים (${d.from_year}–${d.to_year}): שולמו ${fmt(d.paid_total)} ש"ח,`
    + ` מתוכם ${fmt(d.paid_principal)} ש"ח קרן (${d.principal_share}%) ו-${fmt(d.paid_interest)} ש"ח ריבית והצמדת ריבית.`
    + ` הפרשי ההצמדה על הקרן גדלו ב-${fmt(d.cpi_added)} ש"ח באותה תקופה,`
    + ` ולכן היתרה הכוללת ירדה רק ב-${fmt(d.balance_drop)} ש"ח בעוד שהקרן ירדה ב-${fmt(d.principal_drop)} ש"ח.` : '';
  return [head, sep, ...body].join('\n') + note;
}
