// בדיקות: הכנסות לפי מחזור תזרים (10→10) + הכנסה קבועה (recurring=1): מופע חדש
// נוצר אוטומטית ביום day_of_month בכל חודש — אך רק דרך ה-scheduler
// (runRecurringIncome), לא בצפייה (GET). ראו server/lib/recurringIncome.js.
import { db } from '../server/db.js';
import { runRecurringIncome } from '../server/lib/recurringIncome.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
  cond ? pass++ : fail++;
};

const BASE = process.env.MS_BASE;
const HDRS = { 'Content-Type': 'application/json', Connection: 'close' };

console.log('========== הכנסות לפי מחזור + תג "קבועה" ==========\n');

function addIncome({ name, amount, date, recurring = 0 }) {
  return db.prepare('INSERT INTO income (name, amount, date, recurring) VALUES (?, ?, ?, ?)')
    .run(name, amount, date, recurring).lastInsertRowid;
}
const clearIncome = () => db.exec('DELETE FROM income');

/* ---------- שיוך למחזור 10→10 ---------- */
// מחזור יוני–יולי = 11/06 עד 10/07. מחזור יולי–אוגוסט = 11/07 עד 10/08.
clearIncome();
addIncome({ name: 'משכורת', amount: 15000, date: '2026-07-09', recurring: 1 }); // יוני–יולי
addIncome({ name: 'קצבת ילדים', amount: 300, date: '2026-06-21' });    // יוני–יולי
addIncome({ name: 'מתנה', amount: 1000, date: '2026-07-10' });         // יוני–יולי (גבול סוף, כולל)
addIncome({ name: 'הכנסה לדוגמה', amount: 4200, date: '2026-07-12' }); // יולי–אוגוסט
addIncome({ name: 'הכנסה ללא תאריך', amount: 100, date: null });        // כל מחזור

const juneJuly = await (await fetch(`${BASE}/api/income?month=2026-06`, { headers: HDRS })).json();
const names = juneJuly.incomes.map((i) => i.name);
check('מחזור יוני–יולי: החלון נכון',
  juneJuly.cycle.start === '2026-06-11' && juneJuly.cycle.end === '2026-07-10',
  `${juneJuly.cycle.start}..${juneJuly.cycle.end}`);
check('מחזור יוני–יולי: כולל את המשכורת (09/07) ואת קצבת הילדים (21/06)',
  names.includes('משכורת') && names.includes('קצבת ילדים'), names.join(','));
check('מחזור יוני–יולי: גבול סוף (10/07) נכלל', names.includes('מתנה'), names.join(','));
check('מחזור יוני–יולי: הכנסה של המחזור הבא (12/07) לא נכללת',
  !names.includes('הכנסה לדוגמה'), names.join(','));
check('מחזור יוני–יולי: הכנסה ללא תאריך נספרת', names.includes('הכנסה ללא תאריך'), names.join(','));
check('מחזור יוני–יולי: סה"כ מסתכם נכון',
  juneJuly.total === 15000 + 300 + 1000 + 100, String(juneJuly.total));

const julyAug = await (await fetch(`${BASE}/api/income?month=2026-07`, { headers: HDRS })).json();
const names2 = julyAug.incomes.map((i) => i.name);
check('מחזור יולי–אוגוסט: החלון נכון',
  julyAug.cycle.start === '2026-07-11' && julyAug.cycle.end === '2026-08-10',
  `${julyAug.cycle.start}..${julyAug.cycle.end}`);
check('מחזור יולי–אוגוסט: כולל את 12/07 בלבד — אין העתקה אוטומטית של המשכורת מהמחזור הקודם',
  names2.includes('הכנסה לדוגמה') && !names2.includes('משכורת'), names2.join(','));
check('מחזור יולי–אוגוסט: אין שורות שנוצרו מאליהן (רק הכנסה ללא תאריך + מה שהוזן ידנית)',
  julyAug.incomes.length === 2, `n=${julyAug.incomes.length} names=${names2.join(',')}`);

check('month לא תקין נדחה (400)',
  (await fetch(`${BASE}/api/income?month=2026-7`, { headers: HDRS })).status === 400);

/* ---------- רגרסיה: צפייה (GET) לא יוצרת מופעים ---------- */
// הבאג הישן: המנגנון נקרא בכל GET, ויצר מופעים במחזורים עתידיים שהמשתמש דפדף
// אליהם — עם סכום ישן, לפני שההכנסה התקבלה. עכשיו המנגנון רץ רק ב-scheduler;
// דפדוף GET בין מחזורים (עתידיים ועברו) לא יוצר אף שורה.
for (const m of ['2026-08', '2026-09', '2026-10', '2026-05', '2026-04']) {
  await fetch(`${BASE}/api/income?month=${m}`, { headers: HDRS });
}
const countAfterBrowsing = db.prepare("SELECT COUNT(*) AS n FROM income WHERE name = 'משכורת'").get().n;
check('דפדוף בין כמה מחזורים (GET) לא יוצר שורות משכורת נוספות',
  countAfterBrowsing === 1, `n=${countAfterBrowsing}`);
check('צפייה בהכנסות לא מפעילה את המנגנון (אין recurring_parent_id)',
  db.prepare('SELECT COUNT(*) AS n FROM income WHERE recurring_parent_id IS NOT NULL').get().n === 0);

/* ---------- מנוע הכנסה קבועה: מופע נוצר ביום day_of_month, לא מראש ---------- */
clearIncome();
const tplId = db.prepare('INSERT INTO income (name, amount, date, recurring, day_of_month) VALUES (?, ?, ?, 1, 20)')
  .run('קצבת ילדים', 300, '2026-07-20').lastInsertRowid;
// לפני שהגיע ה-20 הבא — אין מופע חדש (התבנית עצמה היא המופע של יולי)
check('לא נוצר מופע לפני שהיום הבא (20) הגיע',
  runRecurringIncome('2026-08-05').length === 0);
// ב-20.8 — נוצר מופע אוגוסט, מקושר לתבנית, בסכום הקבוע
const aug = runRecurringIncome('2026-08-20');
check('מופע נוצר ב-20 לחודש בסכום הקבוע',
  aug.length === 1 && aug[0].date === '2026-08-20' && aug[0].amount === 300,
  JSON.stringify(aug.map((r) => [r.date, r.amount])));
check('המופע מקושר לתבנית (recurring_parent_id)', aug[0]?.recurring_parent_id === tplId);
check('המופע עצמו אינו תבנית (recurring=0)', aug[0]?.recurring === 0 || aug[0]?.recurring === null);
// idempotent — ריצה חוזרת באותו יום לא מכפילה
check('ריצה חוזרת לא מוסיפה מופע כפול', runRecurringIncome('2026-08-20').length === 0);
// לא עתידי — ריצה ב-20.8 לא יוצרת את ספטמבר
check('אין מופע עתידי (ספטמבר) לפני זמנו',
  db.prepare("SELECT COUNT(*) AS n FROM income WHERE recurring_parent_id = ? AND date = '2026-09-20'").get(tplId).n === 0);

/* ---------- catch-up: מחשב כבוי כמה חודשים → מופעים חסרים נוספים בעלייה ---------- */
clearIncome();
db.prepare('INSERT INTO income (name, amount, date, recurring, day_of_month) VALUES (?, ?, ?, 1, 20)')
  .run('קצבה', 300, '2026-06-20');
const caught = runRecurringIncome('2026-08-25'); // מ-06-20: חסרים 07-20 ו-08-20
check('catch-up: מופעים חסרים (יולי+אוגוסט) נוספים יחד',
  caught.length === 2 && caught.every((r) => r.amount === 300),
  JSON.stringify(caught.map((r) => r.date)));

/* ---------- הכנסה שאינה קבועה (recurring=0) לא נוצרת אוטומטית ---------- */
clearIncome();
db.prepare('INSERT INTO income (name, amount, date, recurring) VALUES (?, ?, ?, 0)')
  .run('משכורת', 15000, '2026-07-09');
check('recurring=0 (משכורת) לא נוצרת אוטומטית לעולם',
  runRecurringIncome('2027-12-31').length === 0);

/* ---------- API: הכנסה קבועה — CRUD + day_of_month ---------- */
clearIncome();
const created = await (await fetch(`${BASE}/api/income`, {
  method: 'POST', headers: HDRS,
  body: JSON.stringify({ name: 'קצבה API', amount: 300, date: '2026-07-20', recurring: true, day_of_month: 20 }),
})).json();
check('API: POST עם recurring=true נשמר', created.recurring === 1, `recurring=${created.recurring}`);
check('API: POST שומר day_of_month', created.day_of_month === 20, `day=${created.day_of_month}`);

const badDay = await fetch(`${BASE}/api/income`, {
  method: 'POST', headers: HDRS,
  body: JSON.stringify({ name: 'יום פסול', amount: 100, recurring: true, day_of_month: 40 }),
});
check('API: day_of_month מחוץ לטווח נדחה (400)', badDay.status === 400, `status=${badDay.status}`);

const noDateOk = await fetch(`${BASE}/api/income`, {
  method: 'POST', headers: HDRS,
  body: JSON.stringify({ name: 'קבועה בלי תאריך', amount: 100, recurring: true }),
});
check('API: קבועה בלי תאריך מותר (לא תיצור מופעים עד שיוגדר תאריך)',
  noDateOk.status === 201, `status=${noDateOk.status}`);

// סימון כקבועה בלי day_of_month מפורש (כמו כפתור ↻ ב-web/bot) — נגזר מהיום שבתאריך,
// כדי שהתג "· N בחודש" יופיע. מונע רגרסיה: קודם day_of_month נשאר null.
const plain = await (await fetch(`${BASE}/api/income`, {
  method: 'POST', headers: HDRS,
  body: JSON.stringify({ name: 'קצבה רגילה', amount: 500, date: '2026-07-18' }),
})).json();
const madeRecurring = await (await fetch(`${BASE}/api/income/${plain.id}`, {
  method: 'PUT', headers: HDRS, body: JSON.stringify({ recurring: true }),
})).json();
check('API: סימון כקבועה בלי day_of_month גוזר מהתאריך',
  madeRecurring.recurring === 1 && madeRecurring.day_of_month === 18,
  `recurring=${madeRecurring.recurring} day=${madeRecurring.day_of_month}`);

const toggled = await (await fetch(`${BASE}/api/income/${created.id}`, {
  method: 'PUT', headers: HDRS, body: JSON.stringify({ recurring: false }),
})).json();
check('API: PUT מבטל קביעות', toggled.recurring === 0, `recurring=${toggled.recurring}`);
check('API: ביטול קביעות מנקה את day_of_month', toggled.day_of_month === null, `day=${toggled.day_of_month}`);

// עריכת סכום משכורת במחזור אחד לא משפיעה על שום דבר אחר — בדיקת בידוד בסיסית
clearIncome();
const juneRow = addIncome({ name: 'משכורת', amount: 15000, date: '2026-06-09', recurring: 1 });
const julyRow = addIncome({ name: 'משכורת', amount: 20000, date: '2026-07-09', recurring: 1 });
db.prepare('UPDATE income SET amount = ? WHERE id = ?').run(30000, julyRow);
check('עריכת סכום שורה אחת לא משנה שורה אחרת עם אותו שם',
  db.prepare('SELECT amount FROM income WHERE id = ?').get(juneRow).amount === 15000,
  String(db.prepare('SELECT amount FROM income WHERE id = ?').get(juneRow).amount));

clearIncome();
console.log(`\n========== income_cycle: ${pass}/${pass + fail} ==========`);
// exitCode במקום process.exit() כדי לתת ל-sockets/handles להיסגר נקי (מונע assertion של libuv)
process.exitCode = fail === 0 ? 0 : 1;
