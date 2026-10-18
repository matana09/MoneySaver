// recurring.js — מנוע הוצאות קבועות: חישוב מופעים שהגיע זמנם והוספתם כעסקאות.
// idempotent: unique index על (recurring_id, date) + בדיקת קיום לפני הוספה.
// catch-up: מחשב כבוי ביום המופע → המופעים החסרים נוספים בעלייה הבאה (עד 60 יום).
import { db } from '../db.js';
import { addTransaction } from './addTransaction.js';
import { localDate } from './dates.js';

const MS_DAY = 86400000;
const CATCHUP_DAYS = 60; // תקרת השלמה אחורה — לא להציף אחרי השבתה ארוכה

/** יום המופע בפועל בחודש שאליו d שייך. יום שאינו קיים באותו חודש נדחק ליום
 *  האחרון בו: 31 בפברואר → 28 (או 29 במעוברת), 31 באפריל → 30. בלי ההצמדה
 *  הזו הוצאה של ה-31 הייתה מדלגת לגמרי על כל חודש קצר. */
function monthlyDayFor(day, d) {
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return Math.min(day, daysInMonth);
}

/** רשימת תאריכי ISO של מופעים שטרם נוספו עבור הגדרה אחת — טהורה.
 *  rec: { freq: 'weekly'|'monthly', day, last_added, created_at }.
 *  טווח הסריקה: מ-max(last_added+1, תאריך היצירה, today-60) עד today (כולל). */
export function dueOccurrences(rec, today = localDate()) {
  const todayD = new Date(`${today}T12:00:00`);
  const floorCandidates = [new Date(todayD.getTime() - CATCHUP_DAYS * MS_DAY)];
  if (rec.created_at) floorCandidates.push(new Date(`${String(rec.created_at).slice(0, 10)}T12:00:00`));
  if (rec.last_added) floorCandidates.push(new Date(new Date(`${rec.last_added}T12:00:00`).getTime() + MS_DAY));
  const floorRaw = new Date(Math.max(...floorCandidates.map((d) => d.getTime())));
  // מעוגן ל-12:00 מקומי: קפיצה ב-86400000 מ"ש חוצה מעבר שעון (סוף מרץ בישראל)
  // ומסיטה את השעה ל-13:00, כך שהיום האחרון נכשל ב-d <= todayD והמופע של אותו
  // יום נעלם. בנייה מחדש של התאריך המקומי שומרת על 12:00 בכל צעד.
  const from = new Date(floorRaw.getFullYear(), floorRaw.getMonth(), floorRaw.getDate(), 12);

  const out = [];
  for (let d = from; d <= todayD; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 12)) {
    const match = rec.freq === 'weekly'
      ? d.getDay() === rec.day
      : d.getDate() === monthlyDayFor(rec.day, d);
    if (match) {
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
  }
  return out;
}

/** מריץ את כל ההגדרות הפעילות ומוסיף עסקאות למופעים שהגיע זמנם.
 *  מחזיר את העסקאות שנוספו (להתראות טלגרם).
 *  hourNow — השעה הנוכחית (0–23), להזרקה בבדיקות. */
export async function runRecurring(today = localDate(), hourNow = new Date().getHours()) {
  const added = [];
  const recs = db.prepare('SELECT * FROM recurring_expenses WHERE active = 1').all();
  const exists = db.prepare('SELECT 1 AS x FROM transactions WHERE recurring_id = ? AND date = ?');
  for (const rec of recs) {
    for (const date of dueOccurrences(rec, today)) {
      if (exists.get(rec.id, date)) continue; // כבר נוסף (idempotency)
      // הגדרה עם שעה (hour): המופע של היום מחכה עד שהשעה תגיע — הטיק של אותה
      // שעה יוסיף אותו (הטיקים מיושרים ל-:00, ראו index.js). מופעי עבר (catch-up
      // אחרי השבתה) נוספים מיד — אין טעם לחכות לשעה של יום שכבר עבר.
      if (date === today && rec.hour != null && hourNow < rec.hour) continue;
      const tx = await addTransaction({
        date, amount: rec.amount, type: 'expense', merchant: rec.merchant,
        category_id: rec.category_id, source: 'manual', recurring_id: rec.id,
      });
      added.push({ ...tx, freq: rec.freq, day: rec.day });
      db.prepare('UPDATE recurring_expenses SET last_added = ? WHERE id = ? AND (last_added IS NULL OR last_added < ?)')
        .run(date, rec.id, date);
    }
  }
  return added;
}
