// בדיקות: מחזור תזרים 10→10 — cycleWindow/cycleAnchorForToday/nextCycleStart
// (טהורות) + computeCycleFlow (בקטינג לפי חלון, גבולות כוללים, חיזוי פרופורציונלי,
// charge_date). ראו server/lib/dates.js, server/routes/flow.js.
import { db } from '../server/db.js';
import { cycleWindow, cycleAnchorForToday, nextCycleStart, cycleAnchorOf } from '../server/lib/dates.js';
import { computeCycleFlow } from '../server/routes/flow.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
  cond ? pass++ : fail++;
};

console.log('========== מחזור תזרים 10→10 ==========\n');

// ---------- cycleWindow (טהורה) ----------
const w = cycleWindow('2026-07', 10);
check('cycleWindow: start = D+1 של חודש ההתחלה', w.start === '2026-07-11', w.start);
check('cycleWindow: end = D של החודש הבא', w.end === '2026-08-10', w.end);
check('cycleWindow: תווית טווח עברית', w.label.includes('יולי') && w.label.includes('אוגוסט'), w.label);

const wRoll = cycleWindow('2026-12', 10);
check('cycleWindow: גלישת שנה', wRoll.start === '2026-12-11' && wRoll.end === '2027-01-10', `${wRoll.start}..${wRoll.end}`);

const wCustom = cycleWindow('2026-07', 1);
check('cycleWindow: יום עוגן מותאם (1)', wCustom.start === '2026-07-02' && wCustom.end === '2026-08-01', `${wCustom.start}..${wCustom.end}`);

// ---------- cycleAnchorForToday (טהורה, כולל יום גרייס D+1) ----------
// חודש index 6 = יולי
// יום 9 מאוגוסט ואילך — לבדיקה שהעוגן מכבד יום תלוי-חודש (ראו הבלוק בהמשך)
const dayFnEarly = (month) => (month >= '2026-08' ? 9 : 10);
check('anchor: יום < D → החודש הקודם', cycleAnchorForToday(10, new Date(2026, 6, 5)) === '2026-06');
check('anchor: יום == D → החודש הקודם (גבול)', cycleAnchorForToday(10, new Date(2026, 6, 10)) === '2026-06');
// המחזור מתחיל ב-D+1, ולכן באותו יום הדשבורד כבר על המחזור החדש. היה כאן
// "יום גרייס" שדחה את המעבר ל-D+2 — הוסר; הדשבורד נתקע על מחזור שנסגר.
check('anchor: יום == D+1 → כבר המחזור החדש (בלי גרייס)',
  cycleAnchorForToday(10, new Date(2026, 6, 11)) === '2026-07', cycleAnchorForToday(10, new Date(2026, 6, 11)));
check('anchor: יום > D+1 → החודש הנוכחי', cycleAnchorForToday(10, new Date(2026, 6, 12)) === '2026-07');
check('anchor: 16 באוגוסט → מחזור אוגוסט–ספטמבר (הבאג שדווח)',
  cycleAnchorForToday(10, new Date(2026, 7, 16)) === '2026-08', cycleAnchorForToday(10, new Date(2026, 7, 16)));
// העוגן והחלון חייבים להסכים: היום חייב ליפול בתוך החלון שמוצג
for (const day of [1, 10, 11, 16, 28]) {
  const now = new Date(2026, 7, day);
  const a = cycleAnchorForToday(10, now);
  const w = cycleWindow(a, 10);
  const iso = `2026-08-${String(day).padStart(2, '0')}`;
  check(`anchor+window עקביים ב-${iso}`, iso >= w.start && iso <= w.end, `${iso} לא בתוך ${w.start}..${w.end}`);
}
check('anchor: מכבד יום עוגן תלוי-חודש',
  cycleAnchorForToday(dayFnEarly, new Date(2026, 7, 10)) === '2026-08', cycleAnchorForToday(dayFnEarly, new Date(2026, 7, 10)));

// ---------- nextCycleStart (טהורה) — "העבר למחזור הבא" ----------
check('nextCycleStart: יום <= cycleDay → מחזור הבא מתחיל בחודש הזה',
  nextCycleStart('2026-07-09', 10) === '2026-07-11', nextCycleStart('2026-07-09', 10));
check('nextCycleStart: יום > cycleDay → מחזור הבא מתחיל בחודש הבא',
  nextCycleStart('2026-07-15', 10) === '2026-08-11', nextCycleStart('2026-07-15', 10));
check('nextCycleStart: גלישת שנה (יום > cycleDay בדצמבר)',
  nextCycleStart('2026-12-25', 10) === '2027-01-11', nextCycleStart('2026-12-25', 10));
check('nextCycleStart: גבול — יום == cycleDay',
  nextCycleStart('2026-07-10', 10) === '2026-07-11', nextCycleStart('2026-07-10', 10));

// ---------- יום עוגן שמשתנה מחודש מסוים ואילך (טהור) ----------
// התרחיש: דוח "חיובים קרובים" כולל את יום סגירת המחזור, ולכן עסקאות של ה-10
// נופלות למחזור שכבר חויב. שינוי היום ל-9 **מאוגוסט ואילך** מזיז את הגבול
// פעם אחת בלבד: יולי נגמר ב-08-09 ואוגוסט מתחיל ב-08-10. חודשים קודמים
// חייבים להישאר זהים בדיוק — זו כל הנקודה של השינוי תלוי-התאריך.
const dayFn = (month) => (month >= '2026-08' ? 9 : 10);

const wJun = cycleWindow('2026-06', dayFn);
check('יום משתנה: מחזור יוני (לפני השינוי) לא זז',
  wJun.start === '2026-06-11' && wJun.end === '2026-07-10', `${wJun.start}..${wJun.end}`);

const wJul = cycleWindow('2026-07', dayFn);
check('יום משתנה: מחזור יולי — התחלה ישנה, סגירה לפי היום החדש',
  wJul.start === '2026-07-11' && wJul.end === '2026-08-09', `${wJul.start}..${wJul.end}`);

const wAug = cycleWindow('2026-08', dayFn);
check('יום משתנה: מחזור אוגוסט מתחיל ב-10 (בלי חפיפה ובלי חור)',
  wAug.start === '2026-08-10' && wAug.end === '2026-09-09', `${wAug.start}..${wAug.end}`);

check('יום משתנה: אין חפיפה בין יולי לאוגוסט', wJul.end < wAug.start, `${wJul.end} < ${wAug.start}`);
check('יום משתנה: אין חור בין יולי לאוגוסט',
  new Date(`${wAug.start}T12:00:00`) - new Date(`${wJul.end}T12:00:00`) === 86400000);

check('יום משתנה: 2026-08-10 עובר למחזור הפתוח',
  cycleAnchorOf('2026-08-10', dayFn) === '2026-08', cycleAnchorOf('2026-08-10', dayFn));
check('יום משתנה: 2026-08-10 היה במחזור שנסגר ביום קבוע 10',
  cycleAnchorOf('2026-08-10', 10) === '2026-07', cycleAnchorOf('2026-08-10', 10));
check('יום משתנה: 2026-08-09 נשאר במחזור יולי',
  cycleAnchorOf('2026-08-09', dayFn) === '2026-07', cycleAnchorOf('2026-08-09', dayFn));
check('יום משתנה: nextCycleStart מכבד את היום החדש',
  nextCycleStart('2026-08-12', dayFn) === '2026-09-10', nextCycleStart('2026-08-12', dayFn));
check('יום קבוע כמספר עדיין עובד (תאימות לאחור)',
  cycleWindow('2026-07', 10).end === '2026-08-10');

// ---------- computeCycleFlow: בקטינג לפי חלון + גבולות כוללים ----------
// חלון עבר (2019) שאף מערך אחר לא נוגע בו — דטרמיניסטי.
function insertTx({ date, amount, merchant, type = 'expense' }) {
  return db.prepare(
    'INSERT INTO transactions (date, amount, type, merchant, description, source) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(date, amount, type, merchant, '', 'pdf').lastInsertRowid;
}

// מחזור 2019-03 → חלון 2019-03-11 .. 2019-04-10
insertTx({ date: '2019-03-11', amount: 100, merchant: 'CYC start' });   // גבול תחתון — כלול
insertTx({ date: '2019-03-20', amount: 200, merchant: 'CYC mid' });     // אמצע — כלול
insertTx({ date: '2019-04-10', amount: 300, merchant: 'CYC end' });     // גבול עליון — כלול
insertTx({ date: '2019-03-10', amount: 999, merchant: 'CYC before' });  // יום לפני — לא כלול
insertTx({ date: '2019-04-11', amount: 999, merchant: 'CYC after' });   // יום אחרי — לא כלול
insertTx({ date: '2019-03-25', amount: 500, merchant: 'CYC income', type: 'income' }); // הכנסה בחלון

const f = computeCycleFlow('2019-03', 10);
check('computeCycleFlow: חלון נכון', f.start === '2019-03-11' && f.end === '2019-04-10', `${f.start}..${f.end}`);
check('computeCycleFlow: הוצאות רק בתוך החלון (גבולות כוללים)', f.actual_expenses === 600, `expenses=${f.actual_expenses}`);
check('computeCycleFlow: הכנסה בחלון נספרת', f.actual_income === 500, `income=${f.actual_income}`);
check('computeCycleFlow: אורך מחזור', f.cycle_length === 31, `len=${f.cycle_length}`);

// מחזור עבר → כל הימים חלפו, אין ימים שנותרו, חיזוי = בפועל
check('computeCycleFlow: מחזור עבר — 0 ימים נותרו', f.days_left === 0, `days_left=${f.days_left}`);
check('computeCycleFlow: מחזור עבר — days_elapsed = אורך המחזור', f.days_elapsed === f.cycle_length, `elapsed=${f.days_elapsed}`);
check('computeCycleFlow: חיזוי סוף מחזור = בפועל כשהמחזור הסתיים', f.predicted_expenses === 600, `pred=${f.predicted_expenses}`);

// מצטבר יומי — 3 ימים עם הוצאה בחלון
check('computeCycleFlow: מצטבר יומי כולל רק ימי החלון', f.daily.length === 3, `days=${f.daily.length}`);

// ---------- הכנסות עם תאריך: נספרות רק בחלון שלהן; בלי תאריך = תמיד (legacy) ----------
// חלון נפרד (2018-05) שלא נוגע בבדיקות אחרות. בודקים דלתא, לא ערך מוחלט —
// ייתכנו הכנסות ללא-תאריך גלובליות מ-suites אחרים (למשל acceptance.py) שכבר
// נספרות בכל חלון וישפיעו על הבסיס.
function insertIncome({ name, amount, date = null }) {
  return db.prepare('INSERT INTO income (name, amount, date) VALUES (?, ?, ?)').run(name, amount, date).lastInsertRowid;
}
const baseline5 = computeCycleFlow('2018-05', 10).expected_income;
const baseline1 = computeCycleFlow('2017-01', 10).expected_income;

insertIncome({ name: 'IN-WINDOW', amount: 1000, date: '2018-05-20' });   // בתוך 2018-05-11..2018-06-10
insertIncome({ name: 'OUT-WINDOW', amount: 2000, date: '2018-01-01' }); // מחוץ לחלון — לא נספרת
insertIncome({ name: 'NO-DATE', amount: 300 });                          // ללא תאריך — נספרת בכל חלון

const f2 = computeCycleFlow('2018-05', 10);
check('computeCycleFlow: הכנסה מתוארכת בתוך החלון נספרת (+1000+300)',
  f2.expected_income - baseline5 === 1300, `delta=${f2.expected_income - baseline5}`);

const f3 = computeCycleFlow('2017-01', 10); // חלון אחר לגמרי — IN/OUT-WINDOW לא אמורות להשפיע, רק NO-DATE
check('computeCycleFlow: הכנסה מתוארכת מחוץ לחלון לא נספרת; ללא-תאריך נספרת בכל חלון (+300)',
  f3.expected_income - baseline1 === 300, `delta=${f3.expected_income - baseline1}`);

// ---------- endpoint /api/categories?from=&to= — סכום קטגוריה לפי חלון מחזור ----------
// טאב הקטגוריות עבר מחודש קלנדרי לחלון מחזור 10→10. "תשלומים" נספרת כמו כולן.
const BASE = process.env.MS_BASE;
async function catTotal(name, qs) {
  // Connection: close — לא לשמר keep-alive socket, אחרת process.exit בסוף מפעיל
  // assertion של libuv (handle סוגר) ומחזיר קוד יציאה שאינו 0.
  const rows = await (await fetch(`${BASE}/api/categories${qs}`, { headers: { Connection: 'close' } })).json();
  const row = rows.find((c) => c.name === name);
  return row ? row.month_total : null;
}
function insertCatTx(catId, { date, amount, merchant }) {
  db.prepare(
    "INSERT INTO transactions (date, amount, type, merchant, description, source, category_id) VALUES (?, ?, 'expense', ?, '', 'pdf', ?)"
  ).run(date, amount, merchant, catId);
}

// קטגוריה ייעודית + עסקאות בחלון 2019-03-11..2019-04-10 ומחוצה לו
const catId = db.prepare("INSERT INTO categories (name, color, icon) VALUES ('CYCTEST', '#123456', '🧪')").run().lastInsertRowid;
insertCatTx(catId, { date: '2019-03-20', amount: 200, merchant: 'in-window' });
insertCatTx(catId, { date: '2019-03-05', amount: 999, merchant: 'before-window' }); // מחוץ לחלון — לא כלול

const inWin = await catTotal('CYCTEST', '?from=2019-03-11&to=2019-04-10');
check('categories endpoint: סכום קטגוריה רק בתוך חלון המחזור', inWin === 200, `total=${inWin}`);

// רגרסיה: פעם ל"תשלומים" היה סה"כ כל-הזמנים ("לפי תוכנית"), וכך היא נשארה תקועה
// על אותו סכום בכל מחזור — כולל תוכניות שהסתיימו לפני שנים. עכשיו היא נספרת לפי
// החלון כמו כל קטגוריה אחרת: עסקה מחוץ לחלון לא משפיעה, בתוכו כן.
let payCat = db.prepare("SELECT id FROM categories WHERE name = 'תשלומים'").get();
if (!payCat) payCat = { id: db.prepare("INSERT INTO categories (name, color, icon) VALUES ('תשלומים', '#8896a6', '💳')").run().lastInsertRowid };
const payBaseline = await catTotal('תשלומים', '?from=2019-03-11&to=2019-04-10');
insertCatTx(payCat.id, { date: '2019-03-05', amount: 400, merchant: 'pay-out-of-window' }); // מחוץ לחלון
const payAfterOut = await catTotal('תשלומים', '?from=2019-03-11&to=2019-04-10');
check('categories endpoint: "תשלומים" — עסקה מחוץ לחלון לא נספרת',
  payAfterOut - payBaseline === 0, `delta=${payAfterOut - payBaseline}`);
insertCatTx(payCat.id, { date: '2019-03-20', amount: 400, merchant: 'pay-in-window' }); // בתוך החלון
const payAfterIn = await catTotal('תשלומים', '?from=2019-03-11&to=2019-04-10');
check('categories endpoint: "תשלומים" — עסקה בתוך החלון נספרת (+400)',
  payAfterIn - payBaseline === 400, `delta=${payAfterIn - payBaseline}`);

// ---------- charge_date: שיוך תקופה לפי תאריך אפקטיבי COALESCE(charge_date, date) ----------
// חלון עוגן 2021-02 (בידוד מוחלט מיתר הבדיקות): 2021-02-11..2021-03-10.
// המחזור הבא (עוגן 2021-03): 2021-03-11..2021-04-10.
const cdBaselineA = computeCycleFlow('2021-02', 10).actual_expenses;
const cdBaselineB = computeCycleFlow('2021-03', 10).actual_expenses;
const cdTxId = insertTx({ date: '2021-02-15', amount: 250, merchant: 'CHARGE-DATE TX' }); // תאריך רכישה בחלון A
db.prepare('UPDATE transactions SET charge_date = ? WHERE id = ?').run('2021-03-15', cdTxId); // חיוב בפועל בחלון B

const cdA = computeCycleFlow('2021-02', 10).actual_expenses;
const cdB = computeCycleFlow('2021-03', 10).actual_expenses;
check('computeCycleFlow: עסקה עם charge_date לא נספרת במחזור תאריך הרכישה',
  cdA - cdBaselineA === 0, `deltaA=${cdA - cdBaselineA}`);
check('computeCycleFlow: עסקה עם charge_date נספרת במחזור החיוב האפקטיבי',
  cdB - cdBaselineB === 250, `deltaB=${cdB - cdBaselineB}`);

// endpoint /api/categories — אותו כלל
const cdCatId = db.prepare("INSERT INTO categories (name, color, icon) VALUES ('CHGDATETEST', '#654321', '📅')").run().lastInsertRowid;
db.prepare('UPDATE transactions SET category_id = ? WHERE id = ?').run(cdCatId, cdTxId);
const catInA = await catTotal('CHGDATETEST', '?from=2021-02-11&to=2021-03-10');
const catInB = await catTotal('CHGDATETEST', '?from=2021-03-11&to=2021-04-10');
check('categories endpoint: charge_date — לא נספרת בחלון תאריך הרכישה', catInA === 0, `total=${catInA}`);
check('categories endpoint: charge_date — נספרת בחלון החיוב האפקטיבי', catInB === 250, `total=${catInB}`);

// endpoint /api/transactions?from&to — אותו כלל
async function txIdsInRange(from, to) {
  const res = await (await fetch(`${BASE}/api/transactions?from=${from}&to=${to}&limit=500`, { headers: { Connection: 'close' } })).json();
  return res.transactions.map((t) => t.id);
}
check('transactions endpoint: charge_date — לא מוחזרת בטווח תאריך הרכישה',
  !(await txIdsInRange('2021-02-11', '2021-03-10')).includes(cdTxId));
check('transactions endpoint: charge_date — מוחזרת בטווח החיוב האפקטיבי',
  (await txIdsInRange('2021-03-11', '2021-04-10')).includes(cdTxId));

// PUT /api/transactions/:id — charge_date: 'next' | null | ISO לא תקין
const settings = await (await fetch(`${BASE}/api/settings`, { headers: { Connection: 'close' } })).json();
const cycleDay = Number(settings.cycle_day || 10);
const putTxId = insertTx({ date: '2021-05-09', amount: 37, merchant: 'PUT CHARGE-DATE' }); // יום <= 10 → מחזור הבא מתחיל באותו חודש
const putNextRes = await (await fetch(`${BASE}/api/transactions/${putTxId}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', Connection: 'close' },
  body: JSON.stringify({ charge_date: 'next' }),
})).json();
check("PUT charge_date='next' מחשב נכון לפי תאריך הרכישה + cycle_day",
  putNextRes.charge_date === nextCycleStart('2021-05-09', cycleDay), `got=${putNextRes.charge_date}`);

const putClearRes = await (await fetch(`${BASE}/api/transactions/${putTxId}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', Connection: 'close' },
  body: JSON.stringify({ charge_date: null }),
})).json();
check('PUT charge_date=null מנקה (חוזר לשיוך לפי תאריך רכישה)', putClearRes.charge_date === null, `got=${putClearRes.charge_date}`);

const putBadRes = await fetch(`${BASE}/api/transactions/${putTxId}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', Connection: 'close' },
  body: JSON.stringify({ charge_date: 'לא-תאריך' }),
});
check('PUT charge_date בפורמט לא תקין נדחה (400)', putBadRes.status === 400, `status=${putBadRes.status}`);

// ---------- API: שינוי יום העוגן "מהמחזור הנוכחי ואילך" ----------
// המצב שנשמר הוא שורה ב-cycle_days; ערך הבסיס ב-settings **לא** משתנה, כי הוא
// מה שחל על העבר. cycle_day_from='current' נפתר בשרת (ולא מהחודש שהמשתמש
// מסתכל עליו ב-UI — שמירה משם הייתה חותכת מחדש חודש שכבר נסגר).
const j = async (url, opts) => (await fetch(`${BASE}${url}`, { headers: { 'Content-Type': 'application/json', Connection: 'close' }, ...opts })).json();

const winBefore = await j('/api/flow/cycle/2019-03');
const setRes = await j('/api/settings', { method: 'PUT', body: JSON.stringify({ cycle_day: '9', cycle_day_from: 'current' }) });
check('API: שמירת יום עוגן מהמחזור הנוכחי מחזירה saved', setRes.saved === true, JSON.stringify(setRes));

const sAfter = await j('/api/settings');
check('API: נרשמה שורת שינוי אחת', (sAfter.cycle_day_history || []).length === 1, JSON.stringify(sAfter.cycle_day_history));
check('API: היום החדש נרשם', sAfter.cycle_day_history?.[0]?.day === 9);
check('API: ערך הבסיס ב-settings לא השתנה (הוא מה שחל על העבר)',
  sAfter.cycle_day === '10', `cycle_day=${sAfter.cycle_day}`);
check('API: מוחזר המחזור הנוכחי לתצוגה', /^\d{4}-\d{2}$/.test(sAfter.cycle_current?.month ?? ''), JSON.stringify(sAfter.cycle_current));

const winAfter = await j('/api/flow/cycle/2019-03');
check('API: מחזור היסטורי (2019-03) לא זז בכלל',
  winAfter.start === winBefore.start && winAfter.end === winBefore.end,
  `${winBefore.start}..${winBefore.end} → ${winAfter.start}..${winAfter.end}`);
check('API: והסכומים בו זהים', winAfter.actual_expenses === winBefore.actual_expenses,
  `${winBefore.actual_expenses} → ${winAfter.actual_expenses}`);

const badFrom = await fetch(`${BASE}/api/settings`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', Connection: 'close' },
  body: JSON.stringify({ cycle_day: '9', cycle_day_from: 'לא-חודש' }),
});
check('API: cycle_day_from בפורמט שגוי נדחה (400)', badFrom.status === 400, `status=${badFrom.status}`);

// ניקוי — חזרה ליום גלובלי 10, אחרת שאר הסוויטות ירוצו מול חלונות שונים
await j('/api/settings', { method: 'PUT', body: JSON.stringify({ cycle_day: '10', cycle_day_from: '' }) });
const sClean = await j('/api/settings');
check('API: שמירה בלי cycle_day_from מנקה את השינויים (חזרה ליום גלובלי)',
  (sClean.cycle_day_history || []).length === 0, JSON.stringify(sClean.cycle_day_history));

console.log(`\n========== cycle: ${pass}/${pass + fail} ==========`);
// exitCode במקום process.exit() כדי לתת ל-sockets/handles להיסגר נקי (מונע assertion של libuv)
process.exitCode = fail === 0 ? 0 : 1;
