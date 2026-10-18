// recurringIncome.js — מנוע הכנסות חוזרות: קצבה/הכנסה קבועה שחוזרת ב-day_of_month
// בכל חודש. הכנסה שמסומנת recurring=1 היא התבנית; כל מופע חודשי נשמר כשורת income
// נפרדת עם recurring_parent_id, כדי שניתן יהיה לערוך סכום של חודש בודד בלי להשפיע
// על שאר החודשים. המופע נוצר רק כשהיום שלו הגיע בפועל (dueOccurrences עד today) —
// לא מראש; כך אין סכומים שגויים במחזורים עתידיים לפני שההכנסה התקבלה.
// catch-up: אם המחשב היה כבוי ביום המופע, הוא נוסף בעלייה הבאה (עד 60 יום אחורה).
// idempotent: בדיקת קיום (recurring_parent_id, date) לפני הוספה.
import { db } from '../db.js';
import { localDate } from './dates.js';
import { dueOccurrences } from './recurring.js';

/** יום־בחודש של תבנית: day_of_month אם הוגדר, אחרת היום מתוך התאריך הראשון. */
export function templateDay(tpl) {
  if (tpl.day_of_month) return tpl.day_of_month;
  return tpl.date ? Number(tpl.date.slice(8, 10)) : null;
}

/** מריץ את כל התבניות הפעילות ומוסיף מופעים שהגיע זמנם. מחזיר את מה שנוסף. */
export function runRecurringIncome(today = localDate()) {
  const added = [];
  const templates = db.prepare('SELECT * FROM income WHERE recurring = 1 AND active = 1').all();
  const exists = db.prepare('SELECT 1 AS x FROM income WHERE recurring_parent_id = ? AND date = ?');
  const insert = db.prepare(
    'INSERT INTO income (name, amount, date, active, recurring_parent_id) VALUES (?, ?, ?, 1, ?)'
  );

  for (const tpl of templates) {
    const day = templateDay(tpl);
    if (!day || !tpl.date) continue; // תבנית בלי תאריך — אין ממה לגזור מופעים
    // last_added מתחיל מהתאריך של התבנית עצמה: המופע הראשון כבר קיים (התבנית),
    // ולכן הסריקה מתחילה מהיום שאחריו.
    const occurrences = dueOccurrences(
      { freq: 'monthly', day, last_added: tpl.last_added || tpl.date, created_at: tpl.date },
      today,
    );
    for (const date of occurrences) {
      if (date <= tpl.date) continue;        // לא לשכפל את התבנית עצמה
      if (exists.get(tpl.id, date)) continue; // כבר נוסף (idempotency)
      const result = insert.run(tpl.name, tpl.amount, date, tpl.id);
      added.push(db.prepare('SELECT * FROM income WHERE id = ?').get(result.lastInsertRowid));
      db.prepare('UPDATE income SET last_added = ? WHERE id = ? AND (last_added IS NULL OR last_added < ?)')
        .run(date, tpl.id, date);
    }
  }
  return added;
}
