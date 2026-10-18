// addTransaction.js — הוספת עסקה עם קטגוריזציה אוטומטית (משמש את ה-API ואת הבוט)
import { db } from '../db.js';
import { categorizeFull } from './categorize.js';

// בדיקת כפילות עברה ל-server/lib/duplicates.js (התאמת שם ברפיון, לא רק מדויקת).
// מיוצאת מכאן להמשך תאימות — הבוט ו-routes/import.js מייבאים אותה מכאן.
export { findDuplicate } from './duplicates.js';

export async function addTransaction({
  date, amount, type = 'expense', merchant = '', description = '',
  category_id = null, source = 'manual', external_id = null, recurring_id = null,
}) {
  // cap אורך שדות טקסט — הגנה מפני קלט ענק
  merchant = String(merchant).slice(0, 200);
  description = String(description).slice(0, 500);
  let catSource = category_id ? 'manual' : null;
  if (!category_id && type === 'expense' && merchant) {
    const suggestion = await categorizeFull(merchant);
    if (suggestion) {
      category_id = suggestion.category_id;
      catSource = suggestion.source;
    }
  }
  const result = db.prepare(`
    INSERT INTO transactions (date, amount, type, merchant, description, category_id, source, external_id, recurring_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(date, Number(amount), type, merchant.trim(), description.trim(), category_id, source, external_id, recurring_id);

  const row = db.prepare(`
    SELECT t.*, c.name AS category_name, c.icon AS category_icon
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.id = ?
  `).get(result.lastInsertRowid);
  return { ...row, category_source: catSource };
}
