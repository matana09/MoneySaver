// categoryAssign.js — שיוך קטגוריה לעסקה: בודדת, או לכל העסקאות של אותו בית עסק.
// מקור אמת יחיד ל-web (routes/transactions.js) ולבוט (bot.js) — ראו כלל ה-parity.
//
// למה "כל העסקאות של אותו בית עסק": שיוך ידני של PAYBOX ל"אוכל בחוץ" תיקן עד
// היום שורה אחת בלבד. אחרי שיוך גורף, גם עסקאות *עתידיות* של אותו בית עסק
// ייקלטו נכון — historyMatch (categorize.js) בוחר את הקטגוריה השכיחה לבית העסק.
import { db } from '../db.js';

// השוואת שמות בית עסק: TRIM + LOWER. LOWER ב-SQLite עובד על ASCII בלבד — מספיק
// כאן (בעברית אין רישיות; "PAYBOX"/"PayBox" כן מתאחדים). שם ריק לא מקבץ כלום.
const SAME_MERCHANT = "LOWER(TRIM(merchant)) = LOWER(TRIM(?)) AND TRIM(merchant) != ''";

export function getTransaction(id) {
  return db.prepare(`
    SELECT t.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.id = ?
  `).get(Number(id));
}

/** קטגוריה לפי מזהה, או null עבור 0/null/'' ("— ללא —"). זורק אם ה-id לא קיים. */
export function resolveCategory(categoryId) {
  if (categoryId === null || categoryId === undefined || categoryId === '' || Number(categoryId) === 0) return null;
  const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(categoryId));
  if (!cat) throw new Error('category_id לא קיים');
  return cat;
}

/**
 * כמה עסקאות *אחרות* יש לאותו בית עסק (ואותו סוג), וכמה מהן עדיין לא משויכות
 * ל-categoryId. משמש להצעת "להחיל על כל העסקאות של X?" — בלי להציע כשאין מה לעדכן.
 */
export function merchantPeers(tx, categoryId) {
  const merchant = String(tx.merchant ?? '').trim();
  if (!merchant) return { merchant, total: 0, differing: 0 };
  const catId = categoryId === null || categoryId === undefined || categoryId === '' || Number(categoryId) === 0
    ? null : Number(categoryId);
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN category_id IS NOT ? THEN 1 ELSE 0 END) AS differing
    FROM transactions
    WHERE ${SAME_MERCHANT} AND type = ? AND id != ?
  `).get(catId, merchant, tx.type, tx.id);
  return { merchant, total: row.total || 0, differing: row.differing || 0 };
}

/**
 * שיוך הקטגוריה. applyAll = כל העסקאות של אותו בית עסק ואותו סוג (כולל זו שנבחרה).
 * מחזיר { transaction, category, merchant, updated } — updated = מספר השורות שהשתנו בפועל.
 * זורק Error עם הודעה בעברית על עסקה/קטגוריה לא קיימת.
 */
export function assignCategory(id, categoryId, { applyAll = false } = {}) {
  const tx = getTransaction(id);
  if (!tx) throw new Error('עסקה לא נמצאה');
  const category = resolveCategory(categoryId);
  const catId = category ? category.id : null;
  const merchant = String(tx.merchant ?? '').trim();

  let updated;
  if (applyAll && merchant) {
    // node:sqlite בלי db.transaction() — עדכון יחיד, אטומי מעצמו
    updated = db.prepare(`
      UPDATE transactions SET category_id = ?
      WHERE ${SAME_MERCHANT} AND type = ? AND category_id IS NOT ?
    `).run(catId, merchant, tx.type, catId).changes;
  } else {
    updated = db.prepare('UPDATE transactions SET category_id = ? WHERE id = ? AND category_id IS NOT ?')
      .run(catId, tx.id, catId).changes;
  }

  return { transaction: getTransaction(tx.id), category, merchant, updated };
}
