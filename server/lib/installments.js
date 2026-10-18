// installments.js — פיצול קנייה ל-N תשלומים חודשיים (כמו חיוב אשראי ישראלי)
// 1,200 ₪ ב-12 תשלומים → 12 עסקאות של 100 ₪, אחת לחודש מהתאריך הראשון.
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { categorizeFull } from './categorize.js';
import { addMonthsClamped, localDate, monthsBetween, nextCycleStart } from './dates.js';

export const MAX_INSTALLMENTS = 36;

/**
 * יוצר קבוצת תשלומים. amount = הסכום הכולל.
 * מחזיר { group, count, per_amount, first } — first = העסקה של החודש הראשון.
 */
export async function addInstallments({
  date, amount, count, merchant = '', category_id = null, source = 'manual',
}) {
  count = Number(count);
  amount = Number(amount);
  if (!Number.isInteger(count) || count < 2 || count > MAX_INSTALLMENTS) {
    throw new Error(`מספר תשלומים חייב להיות 2–${MAX_INSTALLMENTS}`);
  }
  merchant = String(merchant).slice(0, 200);

  // קטגוריזציה פעם אחת לכל הקבוצה
  if (!category_id && merchant) {
    const suggestion = await categorizeFull(merchant);
    if (suggestion) category_id = suggestion.category_id;
  }

  const group = randomUUID();
  // עיגול לאגורות; התשלום האחרון סופג את שארית העיגול כך שהסכום מתאזן בדיוק
  const per = Math.round((amount / count) * 100) / 100;
  const last = Math.round((amount - per * (count - 1)) * 100) / 100;

  const insert = db.prepare(`
    INSERT INTO transactions (date, amount, type, merchant, description, category_id, source, installment_group)
    VALUES (?, ?, 'expense', ?, ?, ?, ?, ?)
  `);

  let firstId = null;
  for (let k = 0; k < count; k++) {
    const rowDate = addMonthsClamped(date, k);
    const rowAmount = k === count - 1 ? last : per;
    const result = insert.run(rowDate, rowAmount, merchant,
      `תשלום ${k + 1}/${count}`, category_id, source, group);
    if (k === 0) firstId = result.lastInsertRowid;
  }

  const first = db.prepare(`
    SELECT t.*, c.name AS category_name, c.icon AS category_icon
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.id = ?
  `).get(firstId);

  return { group, count, per_amount: per, total: amount, first };
}

/** מוחק קבוצת תשלומים שלמה. מחזיר כמה נמחקו. */
export function deleteInstallmentGroup(group) {
  return db.prepare('DELETE FROM transactions WHERE installment_group = ?').run(group).changes;
}

export const INSTALLMENT_DESC = /^תשלום (\d+)\/(\d+)$/;

/**
 * מאתר תוכנית תשלומים קיימת של בית עסק לפי סה"כ התשלומים (n ב-"תשלום k/n").
 * משמש גם לתיוג ידני (tagInstallment) וגם לייבוא, כדי ששניהם יזהו את אותה
 * תוכנית. מחזיר את השורה המייצגת או null.
 */
export function findInstallmentPlan(merchant, count, excludeId = null) {
  const candidates = db.prepare(`
    SELECT id, installment_group, description FROM transactions
    WHERE merchant = ? AND installment_group IS NOT NULL AND (? IS NULL OR id != ?)
  `).all(merchant, excludeId, excludeId);
  return candidates.find((r) => {
    const m = r.description?.match(INSTALLMENT_DESC);
    return m && Number(m[2]) === count;
  }) ?? null;
}

/** תיאור → { index, total } או null */
function parseDesc(desc) {
  const m = desc?.match(INSTALLMENT_DESC);
  return m ? { index: Number(m[1]), total: Number(m[2]) } : null;
}

function representativePayment(row, groupSize) {
  const payment = parseDesc(row.description);
  return groupSize === 1 && ['pdf', 'csv'].includes(row.source)
    && payment && Number.isSafeInteger(payment.index) && Number.isSafeInteger(payment.total)
    && payment.total >= 2 && payment.index >= 1 && payment.index <= payment.total
    ? payment : null;
}

// משותף ל-web ולבוט: העברת תשלום משתמשת במועדו החודשי, ולא בתאריך הקנייה.
// מספר התשלום שהועבר נשמר בנפרד מהתיאור שמתעדכן בדוח של החודש הבא.
export function installmentChargeDetails(tx, value, cycleDay, { newPlan = false } = {}) {
  if (value === null) return { charge_date: null, installment_charge_index: null };
  const groupSize = newPlan && tx.installment_group ? 1 : tx.installment_group
    ? db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE installment_group = ? AND type = 'expense'")
      .get(tx.installment_group).n
    : 0;
  const payment = tx.type === 'expense' ? representativePayment(tx, groupSize) : null;
  const index = payment ? (tx.installment_charge_index ?? payment.index) : null;
  const date = index === null ? tx.date : addMonthsClamped(tx.date, index - 1);
  return {
    charge_date: value === 'next' ? nextCycleStart(date, cycleDay) : value,
    installment_charge_index: index,
  };
}

/**
 * הוצאות לתזרים לפי מועד התשלום, בלי לשנות את תאריך הרכישה ב-DB.
 * תוכנית מיובאת שמיוצגת בשורה אחת נפרסת לפי אותו לוח חודשי של תצוגת
 * התשלומים. לוח עם שורות נפרדות נשאר לפי התאריכים והסכומים שנשמרו.
 * charge_date גובר רק על התשלום המדווח, לא על שאר התוכנית.
 */
export function expenseEntriesInRange(start, end) {
  // במחזור שכבר נסגר סופרים רק חיובים מדווחים, לא תשלומים שטרם יובאו.
  const closed = end < localDate();
  const rows = db.prepare(`
    SELECT t.id, t.date, t.charge_date, t.installment_charge_index, t.amount, t.category_id,
           t.installment_group, t.description, t.source,
           c.name AS category_name, c.color AS category_color, c.icon AS category_icon
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.type = 'expense' AND (
      COALESCE(t.charge_date, t.date) BETWEEN ? AND ? OR t.installment_group IS NOT NULL
    )
    ORDER BY t.date, t.id
  `).all(start, end);
  const groups = new Map();
  const entries = [];
  const append = (row, date, index = parseDesc(row.description)?.index ?? null) => {
    if (date >= start && date <= end) entries.push({ ...row, date, installment_index: index });
  };
  for (const row of rows) {
    if (!row.installment_group) {
      append(row, row.charge_date || row.date);
      continue;
    }
    if (!groups.has(row.installment_group)) groups.set(row.installment_group, []);
    groups.get(row.installment_group).push(row);
  }
  for (const txs of groups.values()) {
    const row = txs[0];
    const payment = representativePayment(row, txs.length);
    if (!payment) {
      for (const tx of txs) append(tx, tx.charge_date || tx.date);
      continue;
    }
    // בודקים רק חודשים שבחלון: גם תוכנית ארוכה לא יוצרת לולאה על כל התשלומים.
    // חלון עם יום עוגן משתנה עשוי להכיל שני תשלומים חודשיים.
    const first = Math.max(1, monthsBetween(row.date, start) + 1);
    const last = Math.min(payment.total, monthsBetween(row.date, end) + 1);
    for (let index = first; index <= last; index++) {
      if (row.charge_date && index === (row.installment_charge_index ?? payment.index)) continue;
      if (closed && index > payment.index) continue;
      append(row, addMonthsClamped(row.date, index - 1), index);
    }
    if (row.charge_date) append(row, row.charge_date, row.installment_charge_index ?? payment.index);
  }
  return entries;
}

/**
 * לוח הזמנים של תוכנית תשלומים — תשלום j מחויב חודש אחרי j−1. **לשני מקורות
 * התוכניות יש משמעות שונה לתאריך של השורה**, וזה ההבדל הקריטי כאן:
 *
 * 1. `addInstallments` (הזנה ידנית) יוצר שורה לכל תשלום, וכל שורה נושאת את
 *    *מועד החיוב שלה*. לכן תשלום j נופל ב-date(k) + (j − k) חודשים.
 * 2. שורה בודדת שתויגה מדוח PDF (`tagInstallment` / עדכון-במקום בייבוא) נושאת
 *    את **תאריך העסקה המקורית**, לא את מועד החיוב של התשלום הנוכחי: הדוח מדווח
 *    "תשלום 37 מתוך 48" על קנייה מ-2023. `commitRows` מעדכן רק את ה-description
 *    ומשאיר את התאריך. לכן תשלום j נופל ב-date + (j − 1) חודשים.
 *
 * ההנחה שהתאריך הוא תמיד מועד החיוב הזיזה תוכניות PDF בכמה חודשים ואף הסתירה
 * תוכניות פעילות (שטראוס 37/48 מ-2023 נראתה כאילו הסתיימה ב-2024).
 *
 * מחזיר { index, total, date } לתשלום שנופל בחלון [start, end], או null אם
 * התוכנית טרם התחילה או שכבר הסתיימה (index מחוץ ל-1..n) — ואז היא לא מוצגת
 * במחזור הזה.
 */
export function planPaymentInWindow(txs, start, end) {
  const tagged = txs.filter((t) => parseDesc(t.description));
  if (!tagged.length) return null;
  // עוגן = השורה המתויגת האחרונה (העדכנית ביותר); total = הגדול שנראה
  const anchor = tagged.at(-1);
  const { index: anchorIndex } = parseDesc(anchor.description);
  const total = Math.max(...tagged.map((t) => parseDesc(t.description).total));
  // כמה שורות מתויגות יש → לוח חיובים מלא (מקרה 1). שורה אחת → תאריך העסקה (2).
  const base = tagged.length > 1 ? anchorIndex : 1;
  // הפרש החודשים בין תחילת החלון לעוגן נותן מועמד; בודקים גם שכנים, כי החלון
  // הוא 10→10 ולא חודש קלנדרי (תשלום ב-10.8 שייך לחלון שמתחיל ב-11.7).
  const guess = base + monthsBetween(anchor.date, start);
  for (const index of [guess, guess + 1, guess - 1, guess + 2]) {
    if (index < 1 || index > total) continue;
    const date = addMonthsClamped(anchor.date, index - base);
    if (date >= start && date <= end) return { index, total, date };
  }
  return null;
}

/**
 * כל תוכניות התשלומים הקיימות (כל קבוצת installment_group), בכל הקטגוריות.
 *
 * בלי חלון: מצב כל-הזמנים — paid_count = מספר התשלום האחרון שתאריכו הגיע.
 * עם חלון ({ start, end } של מחזור): רשומה לכל תשלום שמועדו האפקטיבי בחלון,
 * לרבות שתי רשומות לאותה תוכנית כששינוי יום הסגירה או העברה כוללים שני חיובים.
 * index הוא מספר התשלום המסוים. תוכנית שהסתיימה נעלמת מעצמה.
 * `projected: true` = התשלום נגזר מלוח הזמנים אבל עדיין אין לו שורה ב-DB
 * (הדוח של החודש טרם יובא).
 */
export function listInstallmentGroups({ start = null, end = null } = {}) {
  const rows = db.prepare(`
    SELECT t.*, c.name AS category_name, c.icon AS category_icon
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.installment_group IS NOT NULL
    ORDER BY t.date
  `).all();

  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.installment_group)) groups.set(row.installment_group, []);
    groups.get(row.installment_group).push(row);
  }

  const today = localDate();
  const windowed = Boolean(start && end);

  if (windowed) {
    const dueByGroup = new Map();
    for (const entry of expenseEntriesInRange(start, end)) {
      if (!entry.installment_group) continue;
      if (!dueByGroup.has(entry.installment_group)) dueByGroup.set(entry.installment_group, []);
      dueByGroup.get(entry.installment_group).push(entry);
    }
    return [...groups.entries()].flatMap(([group, txs]) => {
      const due = dueByGroup.get(group);
      if (!due) return []; // אין תשלום אפקטיבי בחלון — לא משחזרים שורה שנמחקה
      const expenseTxs = txs.filter((tx) => tx.type === 'expense');
      const representative = expenseTxs.length === 1 ? representativePayment(expenseTxs[0], 1) : null;
      const totals = expenseTxs.map((tx) => parseDesc(tx.description)?.total)
        .filter((total) => Number.isSafeInteger(total) && total >= 1);
      const totalCount = representative?.total ?? (totals.length ? Math.max(...totals) : expenseTxs.length);
      return due.map((entry) => {
        const tx = expenseTxs.find((row) => row.id === entry.id);
        const index = entry.installment_index ?? expenseTxs.indexOf(tx) + 1;
        // שורה מיובאת מאשרת את התשלום שדווח ואת התשלום שאליו הוצמדה העברה.
        // שאר התשלומים נגזרים מהלוח. בלוח עם שורות נפרדות כל שורה היא חיוב אמיתי.
        const pinned = tx.charge_date && index === (tx.installment_charge_index ?? representative?.index);
        const projected = Boolean(representative && index > representative.index && !pinned);
        return {
          group,
          merchant: tx.merchant,
          category_name: tx.category_name,
          category_icon: tx.category_icon,
          index,
          paid_count: index, // תאימות לאחור לצרכנים ישנים
          total_count: totalCount,
          due_date: entry.date,
          projected,
          amount: entry.amount,
          transactions: projected ? [] : [tx],
        };
      });
    }).sort((a, b) => (a.merchant || '').localeCompare(b.merchant || '', 'he')
      || a.due_date.localeCompare(b.due_date) || a.index - b.index);
  }

  return [...groups.entries()].map(([group, txs]) => {
    // "שולם" = מספר התשלום הגבוה ביותר שתויג *ושכבר הגיע תאריכו* (למשל
    // "תשלום 36/48" → 36 כבר שולמו). שורות עתידיות (כמו ב-addInstallments,
    // שיוצר מראש את כל התשלומים כולל חודשים הבאים) לא נספרות כ"שולמו" עדיין.
    const dueTxs = txs.filter((t) => t.date <= today);
    const indices = dueTxs.map((t) => Number(t.description?.match(INSTALLMENT_DESC)?.[1])).filter(Boolean);
    const totals = txs.map((t) => Number(t.description?.match(INSTALLMENT_DESC)?.[2])).filter(Boolean);
    const totalCount = totals.length ? Math.max(...totals) : txs.length;
    const paidCount = indices.length ? Math.max(...indices) : dueTxs.length;
    // סכום התשלום החודשי הקבוע — לא סכום מצטבר. עולה מספר התשלום (3/4 → 4/4),
    // הסכום עצמו לא משתנה; לוקחים את השורה האחרונה (העדכנית ביותר) כמייצגת.
    const latest = (dueTxs.length ? dueTxs : txs).at(-1);
    return {
      group,
      merchant: txs[0].merchant,
      category_name: txs[0].category_name,
      category_icon: txs[0].category_icon,
      paid_count: paidCount,
      total_count: totalCount,
      amount: latest.amount,
      transactions: txs,
    };
  }).sort((a, b) => (a.merchant || '').localeCompare(b.merchant || '', 'he'));
}

/**
 * סה"כ קטגוריית "תשלומים" למחזור מסוים = התשלומים שמועדם בחלון הזה.
 *
 * למה לא סכום השורות בתקופה, כמו בכל קטגוריה אחרת: שורה של תוכנית שיובאה מ-PDF
 * נושאת את **תאריך העסקה המקורית** ולא את מועד החיוב (ראו planPaymentInWindow),
 * ולכן היא נופלת בתקופה של הקנייה ולא בזו של החיוב. התוצאה הייתה סכום שנתקע על
 * אותו ערך מחזור אחר מחזור — נספרו רק תוכניות שנקנו במקרה באותו חלון.
 *
 * כאן נספר כל תשלום שמועדו האפקטיבי בחלון, ובנוסף עסקאות בקטגוריה שאינן
 * חלק מתוכנית. העברה או שינוי יום הסגירה עשויים לכלול שני חיובים של אותה
 * תוכנית. הסכום והרשימה משתמשים באותו לוח ומשתנים כשתוכניות מתחילות ומסתיימות.
 *
 * גם תזרים הדשבורד משתמש בלוח החודשי לתוכניות מיובאות שמיוצגות בשורה אחת
 * (`expenseEntriesInRange`), כדי שלא יישמטו בגלל תאריך הרכישה המקורי.
 */
export function installmentsCategoryTotal(categoryName = 'תשלומים', { start, end } = {}) {
  if (!start || !end) throw new Error('installmentsCategoryTotal דורש חלון מחזור');
  return expenseEntriesInRange(start, end)
    .filter((tx) => tx.category_name === categoryName)
    .reduce((cents, tx) => cents + Math.round(tx.amount * 100), 0) / 100;
}

/**
 * מתייג עסקה קיימת (למשל שיובאה מ-PDF כשורה בודדת) כ"תשלום index/count",
 * בלי ליצור שורות עתידיות — אלה יגיעו בעצמן בייבוא הבא. אם קיימת כבר עסקה
 * אחרת של אותו בית עסק שתויגה עם אותו סה"כ תשלומים, מצטרפים לאותה קבוצה
 * (installment_group) כדי שהספירה/התצוגה יתייחסו אליהן כרצף אחד.
 */
export function tagInstallment(id, index, count) {
  index = Number(index);
  count = Number(count);
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 2 || index < 1 || index > count) {
    throw new Error(`מספר תשלום לא תקין (צריך 1–${count || '?'})`);
  }
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  if (!tx) throw new Error('העסקה לא נמצאה');

  const match = findInstallmentPlan(tx.merchant, count, id);
  const group = match?.installment_group ?? randomUUID();
  const description = `תשלום ${index}/${count}`;
  db.prepare('UPDATE transactions SET description = ?, installment_group = ? WHERE id = ?').run(description, group, id);
  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
}
