// dates.js — תאריכים בזמן מקומי (לא UTC — אחרת הוצאה ב-00:30 נרשמת ליום/חודש הקודם)
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** מוסיף k חודשים לתאריך ISO עם הצמדת יום (31/01 + חודש → 28/02, לא 03/03) */
export function addMonthsClamped(isoDate, k) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const target = new Date(y, m - 1 + k, 1);
  const daysInMonth = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  const day = Math.min(d, daysInMonth);
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** הפרש חודשים שלמים בין שני תאריכי ISO (לחישוב אורך מנוי לחידוש) */
export function monthsBetween(startIso, endIso) {
  const [sy, sm] = startIso.split('-').map(Number);
  const [ey, em] = endIso.split('-').map(Number);
  return (ey - sy) * 12 + (em - sm);
}

const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

/** חודש עוקב כמחרוזת YYYY-MM. */
export function nextMonthStr(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** יום העוגן לחודש נתון. `cycleDay` הוא **מספר** (יום קבוע לכל הזמנים) או
 *  **פונקציה** `month → יום` (יום שמשתנה מתאריך מסוים ואילך — ראו
 *  `cycleDayFn` ב-`server/routes/flow.js`). מאפשר לשנות את יום החיוב מכאן
 *  והלאה בלי לחתוך מחדש חודשים היסטוריים. */
const dayFor = (cycleDay, month) => (typeof cycleDay === 'function' ? cycleDay(month) : cycleDay);

/** חלון מחזור תזרים לפי חודש־התחלה ויום עוגן D.
 *  start = D+1 של חודש ההתחלה, end = D של החודש הבא (שני הקצוות כלולים).
 *  דוגמה: cycleWindow('2026-07', 10) → { start:'2026-07-11', end:'2026-08-10' }.
 *  **כל קצה לוקח את היום של החודש שבו הוא נופל** — כך שכשהיום משתנה
 *  (10→9 מאוגוסט) הגבול בין המחזורים זז בדיוק פעם אחת, בלי חפיפה ובלי חור:
 *  יולי נגמר ב-08-09 ואוגוסט מתחיל ב-08-10.
 *  שימוש ב-Date מקומי (לא toISOString — באג חצות). */
export function cycleWindow(anchorMonth, cycleDay = 10) {
  const [y, m] = anchorMonth.split('-').map(Number);
  const start = new Date(y, m - 1, dayFor(cycleDay, anchorMonth) + 1);      // D+1 של חודש ההתחלה
  const end = new Date(y, m, dayFor(cycleDay, nextMonthStr(anchorMonth))); // D של החודש הבא
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const label = `${start.getDate()} ${HE_MONTHS[start.getMonth()]} – ${end.getDate()} ${HE_MONTHS[end.getMonth()]}`;
  return { start: iso(start), end: iso(end), label };
}

/** חודש־העוגן של המחזור שמכיל את התאריך. */
export function cycleAnchorOf(dateIso, cycleDay = 10) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const month = `${y}-${String(m).padStart(2, '0')}`;
  if (d > dayFor(cycleDay, month)) return month;
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** תחילת המחזור הבא אחרי המחזור שמכיל את dateIso (10→10). משמש "העבר למחזור
 *  הבא" — עסקה שנרכשה סמוך לסוף מחזור אבל מחויבת בפועל בדוח הבא.
 *  דוגמה: nextCycleStart('2026-07-09', 10) → '2026-07-11' (העסקה בתוך המחזור
 *  יוני–יולי; המחזור הבא — יולי–אוגוסט — מתחיל ב-11 ביולי). */
export function nextCycleStart(dateIso, cycleDay = 10) {
  // עוגן המחזור שמכיל את dateIso, ואז תחילת המחזור שאחריו = D+1 של החודש
  // שאחרי העוגן. ה-D נלקח מאותו חודש שבו הגבול נופל (ראו `cycleWindow`).
  const after = nextMonthStr(cycleAnchorOf(dateIso, cycleDay));
  const [y, m] = after.split('-').map(Number);
  const start = new Date(y, m - 1, dayFor(cycleDay, after) + 1);
  return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
}

/** חודש־ההתחלה של המחזור המכיל את היום — בדיוק אותו כלל כמו `cycleAnchorOf`
 *  על התאריך של היום. המחזור מתחיל ב-D+1, ולכן **ביום D+1 עצמו הדשבורד כבר
 *  מציג את המחזור החדש** (ב-10 בחודש רואים 11.07–10.08, ב-11 בחודש כבר
 *  11.08–10.09). היה כאן יום גרייס נוסף שדחה את המעבר ליום D+2 — הוסר
 *  לבקשת המשתמש: מחזור ריק בתחילתו עדיף על מחזור שנסגר ונראה כאילו הוא פעיל. */
export function cycleAnchorForToday(cycleDay = 10, now = new Date()) {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return cycleAnchorOf(today, cycleDay);
}

/** dd/mm או dd/mm/yy(yy) → YYYY-MM-DD; ללא שנה — שנה נוכחית, ואם עתידי — שנה שעברה */
export function normalizeDayMonth(raw) {
  if (!raw) return localDate();
  const m = String(raw).match(/^(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?$/);
  if (!m) return localDate();
  const now = new Date();
  const year = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : String(now.getFullYear());
  let date = `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (!m[3] && date > localDate(now)) {
    date = `${Number(year) - 1}${date.slice(4)}`;
  }
  return date;
}
