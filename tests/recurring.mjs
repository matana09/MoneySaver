// בדיקות: הוצאות קבועות אוטומטיות — dueOccurrences (טהורה) + runRecurring
// (idempotency, catch-up, active) + API CRUD. ראו server/lib/recurring.js.
// ה-runner מגדיר MONEYSAVER_DATA_DIR — ה-DB זמני; MS_BASE — שרת בדיקות 3100.
import { db } from '../server/db.js';
import { dueOccurrences, runRecurring } from '../server/lib/recurring.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
  cond ? pass++ : fail++;
};

const BASE = process.env.MS_BASE;
const HDRS = { 'Content-Type': 'application/json', Connection: 'close' };

console.log('========== הוצאות קבועות אוטומטיות ==========\n');

/* ---------- dueOccurrences (טהורה) ---------- */
// 2026-07-12 הוא יום ראשון (getDay=0). שבועי יום שלישי (2).
const wk = { freq: 'weekly', day: 2, last_added: null, created_at: '2026-06-20 10:00:00' };
const occWk = dueOccurrences(wk, '2026-07-12');
check('שבועי: כל ימי שלישי מאז היצירה', JSON.stringify(occWk) === JSON.stringify(['2026-06-23', '2026-06-30', '2026-07-07']), occWk.join(','));

// last_added חוסם את מה שכבר נוסף
const occWk2 = dueOccurrences({ ...wk, last_added: '2026-06-30' }, '2026-07-12');
check('שבועי: last_added חוסם מופעים שנוספו', JSON.stringify(occWk2) === JSON.stringify(['2026-07-07']), occWk2.join(','));

// היום עצמו הוא מופע — נכלל
const occToday = dueOccurrences({ freq: 'weekly', day: 0, last_added: null, created_at: '2026-07-10 08:00:00' }, '2026-07-12');
check('שבועי: היום עצמו (יום המופע) נכלל', JSON.stringify(occToday) === JSON.stringify(['2026-07-12']), occToday.join(','));

// חודשי ביום 1
const mo = { freq: 'monthly', day: 1, last_added: null, created_at: '2026-05-15 10:00:00' };
const occMo = dueOccurrences(mo, '2026-07-12');
check('חודשי: מופעי 1 בחודש מאז היצירה', JSON.stringify(occMo) === JSON.stringify(['2026-06-01', '2026-07-01']), occMo.join(','));

// תקרת catch-up: הגדרה ישנה מאוד — לא יותר מ-60 יום אחורה
const old = { freq: 'weekly', day: 2, last_added: null, created_at: '2020-01-01 10:00:00' };
const occOld = dueOccurrences(old, '2026-07-12');
check('catch-up חסום ל-60 יום אחורה', occOld.length <= 9 && occOld[0] >= '2026-05-13', `n=${occOld.length} first=${occOld[0]}`);

// אין מופעים לפני created_at
const fresh = dueOccurrences({ freq: 'monthly', day: 1, last_added: null, created_at: '2026-07-05 10:00:00' }, '2026-07-12');
check('אין מופעים לפני תאריך היצירה', fresh.length === 0, `n=${fresh.length}`);

/* ---------- חודשי 29–31: הצמדה ליום האחרון בחודש קצר ---------- */
// יום 31: ינואר 31, פברואר 28 (2026 אינה מעוברת), מרץ 31, אפריל 30
const d31 = dueOccurrences({ freq: 'monthly', day: 31, last_added: null, created_at: '2026-01-01 10:00:00' }, '2026-04-30');
check('חודשי 31: מופע בכל חודש, נדחק ליום האחרון בקצר',
  JSON.stringify(d31) === JSON.stringify(['2026-03-31', '2026-04-30']), d31.join(','));

// יום 30 בפברואר → 28. סריקה מוגבלת ל-60 יום אחורה, לכן מתחילים מפברואר
const d30 = dueOccurrences({ freq: 'monthly', day: 30, last_added: null, created_at: '2026-02-01 10:00:00' }, '2026-03-31');
check('חודשי 30: פברואר נדחק ל-28',
  JSON.stringify(d30) === JSON.stringify(['2026-02-28', '2026-03-30']), d30.join(','));

// שנה מעוברת: 2024 — פברואר 29
const leap = dueOccurrences({ freq: 'monthly', day: 31, last_added: null, created_at: '2024-02-01 10:00:00' }, '2024-02-29');
check('חודשי 31 בשנה מעוברת: פברואר נדחק ל-29',
  JSON.stringify(leap) === JSON.stringify(['2024-02-29']), leap.join(','));

// בדיוק מופע אחד בחודש — לא כפילות בחודש קצר
const feb = dueOccurrences({ freq: 'monthly', day: 31, last_added: null, created_at: '2026-02-01 10:00:00' }, '2026-02-28');
check('חודשי 31: מופע יחיד בפברואר (בלי כפילות)', feb.length === 1, feb.join(','));

// יום 28 ממשיך לעבוד כרגיל (רגרסיה)
const d28 = dueOccurrences({ freq: 'monthly', day: 28, last_added: null, created_at: '2026-02-01 10:00:00' }, '2026-03-31');
check('חודשי 28: התנהגות ללא שינוי',
  JSON.stringify(d28) === JSON.stringify(['2026-02-28', '2026-03-28']), d28.join(','));

// מעבר שעון קיץ (ישראל: יום שישי האחרון במרץ). קפיצה ב-86400000 מ"ש הסיטה את
// השעה ל-13:00 והפילה את המופע של היום עצמו — כאן הוא חייב להופיע.
const dst = dueOccurrences({ freq: 'monthly', day: 31, last_added: null, created_at: '2026-03-01 10:00:00' }, '2026-03-31');
check('מעבר שעון: המופע של 31.3 לא נעלם',
  JSON.stringify(dst) === JSON.stringify(['2026-03-31']), dst.join(','));

const dstWk = dueOccurrences({ freq: 'weekly', day: 2, last_added: null, created_at: '2026-03-20 10:00:00' }, '2026-03-31');
check('מעבר שעון: שבועי לא מאבד ימים',
  JSON.stringify(dstWk) === JSON.stringify(['2026-03-24', '2026-03-31']), dstWk.join(','));

/* ---------- runRecurring: idempotency + active ---------- */
function insertRec({ merchant, amount, freq, day, active = 1, created_at = '2026-07-01 10:00:00', hour = null }) {
  return db.prepare(`
    INSERT INTO recurring_expenses (merchant, amount, freq, day, active, created_at, hour)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(merchant, amount, freq, day, active, created_at, hour).lastInsertRowid;
}
const txCount = (recId) => db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE recurring_id = ?').get(recId).n;

// שבועי יום שישי (5): מאז 2026-07-01 עד 2026-07-12 → 3/7, 10/7
const recA = insertRec({ merchant: 'REC-TEST חוג', amount: 150, freq: 'weekly', day: 5 });
const added1 = await runRecurring('2026-07-12');
const mineA = added1.filter((t) => t.recurring_id === recA);
check('runRecurring: נוספו כל המופעים שהגיע זמנם', mineA.length === 2 && txCount(recA) === 2,
  `added=${mineA.length} dates=${mineA.map((t) => t.date).join(',')}`);
check('runRecurring: last_added עודכן למופע האחרון',
  db.prepare('SELECT last_added FROM recurring_expenses WHERE id = ?').get(recA).last_added === '2026-07-10');

// הרצה שנייה — לא מוסיפה כלום (idempotent)
const added2 = await runRecurring('2026-07-12');
check('runRecurring: הרצה כפולה לא מוסיפה כפילויות',
  added2.filter((t) => t.recurring_id === recA).length === 0 && txCount(recA) === 2, `count=${txCount(recA)}`);

// unique index — הגנה קשיחה גם מול INSERT ישיר
let uniqueBlocked = false;
try {
  db.prepare("INSERT INTO transactions (date, amount, type, merchant, source, recurring_id) VALUES ('2026-07-10', 150, 'expense', 'REC-TEST חוג', 'manual', ?)").run(recA);
} catch { uniqueBlocked = true; }
check('unique index חוסם מופע כפול גם ב-INSERT ישיר', uniqueBlocked);

// הגדרה מושבתת — לא מוסיפה
const recB = insertRec({ merchant: 'REC-TEST מושבת', amount: 99, freq: 'weekly', day: 5, active: 0 });
await runRecurring('2026-07-12');
check('הגדרה מושבתת (active=0) לא מוסיפה עסקאות', txCount(recB) === 0);

/* ---------- hour: המופע של היום מחכה עד שהשעה מגיעה ---------- */
// 2026-07-12 הוא יום ראשון (0). שעה 9: בטיק של 07:00 לא נוסף, בטיק של 09:00 כן.
const recH = insertRec({ merchant: 'REC-TEST שירות לדוגמה', amount: 360, freq: 'weekly', day: 0, created_at: '2026-07-10 08:00:00', hour: 9 });
await runRecurring('2026-07-12', 7);
check('hour: לפני השעה — המופע של היום לא נוסף', txCount(recH) === 0);
await runRecurring('2026-07-12', 9);
check('hour: בהגעת השעה — המופע נוסף', txCount(recH) === 1,
  db.prepare('SELECT date FROM transactions WHERE recurring_id = ?').get(recH)?.date);
await runRecurring('2026-07-12', 10);
check('hour: אחרי ההוספה — טיק נוסף לא מכפיל', txCount(recH) === 1);
// מופע של יום שעבר (catch-up) לא מחכה לשעה — היום כבר עבר
const recH2 = insertRec({ merchant: 'REC-TEST עבר', amount: 50, freq: 'weekly', day: 0, created_at: '2026-07-10 08:00:00', hour: 9 });
await runRecurring('2026-07-13', 6);
check('hour: מופע של אתמול (catch-up) נוסף גם לפני השעה', txCount(recH2) === 1);

/* ---------- API CRUD ---------- */
const createRes = await fetch(`${BASE}/api/recurring`, {
  method: 'POST', headers: HDRS,
  body: JSON.stringify({ merchant: 'REC-API שכר דירה', amount: 4500, freq: 'monthly', day: 1 }),
});
const created = await createRes.json();
check('POST /api/recurring יוצר הגדרה', createRes.status === 201 && created.id > 0, `status=${createRes.status}`);

const badDay = await fetch(`${BASE}/api/recurring`, {
  method: 'POST', headers: HDRS,
  body: JSON.stringify({ merchant: 'X', amount: 10, freq: 'weekly', day: 9 }),
});
check('POST: day שבועי מחוץ לטווח נדחה (400)', badDay.status === 400, `status=${badDay.status}`);

// 29–31 מותרים מאז ההצמדה ליום האחרון בחודש קצר (monthlyDayFor)
const dayMo31 = await fetch(`${BASE}/api/recurring`, {
  method: 'POST', headers: HDRS,
  body: JSON.stringify({ merchant: 'יום 31', amount: 10, freq: 'monthly', day: 31 }),
});
check('POST: day חודשי 31 מתקבל (נדחק ליום האחרון בחודש קצר)', dayMo31.status === 201, `status=${dayMo31.status}`);
// משביתים מיד — אחרת בהרצה ביום האחרון בחודש הכלל הזה מוסיף עסקה אמיתית
// ל-DB הזמני ומזהם סוויטות אחרות (הבדיקות חולקות DB אחד)
if (dayMo31.status === 201) {
  const rec31 = await dayMo31.json();
  await fetch(`${BASE}/api/recurring/${rec31.id}`, {
    method: 'PUT', headers: HDRS, body: JSON.stringify({ active: false }),
  });
}

const badDayMo = await fetch(`${BASE}/api/recurring`, {
  method: 'POST', headers: HDRS,
  body: JSON.stringify({ merchant: 'X', amount: 10, freq: 'monthly', day: 32 }),
});
check('POST: day חודשי 32 נדחה (400, מקסימום 31)', badDayMo.status === 400, `status=${badDayMo.status}`);

const tglRes = await fetch(`${BASE}/api/recurring/${created.id}`, {
  method: 'PUT', headers: HDRS, body: JSON.stringify({ active: false }),
});
const toggled = await tglRes.json();
check('PUT: השבתה (active=0)', tglRes.status === 200 && toggled.active === 0, `active=${toggled.active}`);

// hour דרך ה-API: נשמר ביצירה, נדחה מחוץ לטווח, ומתנקה עם null
const withHour = await (await fetch(`${BASE}/api/recurring`, {
  method: 'POST', headers: HDRS,
  body: JSON.stringify({ merchant: 'REC-API שעה', amount: 10, freq: 'weekly', day: 0, hour: 7 }),
})).json();
check('POST: hour נשמר', withHour.hour === 7, `hour=${withHour.hour}`);
const badHour = await fetch(`${BASE}/api/recurring/${withHour.id}`, {
  method: 'PUT', headers: HDRS, body: JSON.stringify({ hour: 24 }),
});
check('PUT: hour מחוץ לטווח נדחה (400)', badHour.status === 400, `status=${badHour.status}`);
const clearedHour = await (await fetch(`${BASE}/api/recurring/${withHour.id}`, {
  method: 'PUT', headers: HDRS, body: JSON.stringify({ hour: null }),
})).json();
check('PUT: hour=null מנקה את השעה', clearedHour.hour === null, `hour=${clearedHour.hour}`);

// מחיקת הגדרה משאירה עסקאות קיימות
const txBefore = txCount(recA);
await fetch(`${BASE}/api/recurring/${recA}`, { method: 'DELETE', headers: HDRS });
check('DELETE: ההגדרה נמחקת והעסקאות שכבר נוספו נשארות',
  !db.prepare('SELECT 1 FROM recurring_expenses WHERE id = ?').get(recA) && txCount(recA) === txBefore,
  `tx=${txCount(recA)}`);

// POST /run — טריגר ידני
const runRes = await fetch(`${BASE}/api/recurring/run`, { method: 'POST', headers: HDRS });
check('POST /api/recurring/run מחזיר תקין', runRes.status === 200 && typeof (await runRes.json()).added === 'number');

console.log(`\n========== recurring: ${pass}/${pass + fail} ==========`);
// exitCode במקום process.exit() — נותן ל-sockets להיסגר נקי (ראו cycle.mjs)
process.exitCode = fail === 0 ? 0 : 1;
