// בדיקות: זיהוי עסקאות כפולות — server/lib/duplicates.js.
// הרקע: אותה עסקה נכנסה פעמיים, פעם מ-SMS בשם קצר ("DEMO SHOP") ופעם מדוח PDF
// בשם המלא ("DEMO SHOP ASIAN FOODBAR"). ההשוואה המדויקת פספסה אותה (15.08).
// רץ מול שרת הבדיקות (פורט 3100, DB זמני) — לעולם לא מול 3000.
import { db } from '../server/db.js';
import { normalizeMerchant, merchantMatch, findDuplicate, scanDuplicates,
         ignoreDuplicateGroup, clearIgnoredDuplicates, ignoredCount } from '../server/lib/duplicates.js';
import { enrichRows } from '../server/lib/importer.js';

const BASE = process.env.MS_BASE || 'http://127.0.0.1:3100';
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
  cond ? pass++ : fail++;
};

console.log('========== זיהוי כפילויות ==========\n');

// ---------- normalizeMerchant ----------
check('normalize: רווחים כפולים מתכווצים', normalizeMerchant('  DEMO SHOP   BAR ') === 'DEMO SHOP BAR');
check('normalize: פיסוק הופך לרווח', normalizeMerchant('גאיה עיצובים-צמרת') === 'גאיה עיצובים צמרת');
check('normalize: רישיות מנוטרלת', normalizeMerchant('paybox') === 'PAYBOX');
check('normalize: גרש עברי מוסר', normalizeMerchant("טיקצ'אק") === 'טיקצ אק');
check('normalize: ריק', normalizeMerchant(null) === '');

// ---------- merchantMatch ----------
check('match: שם זהה → exact', merchantMatch('תן ביס', 'תן ביס') === 'exact');
check('match: רישיות ורווחים → exact', merchantMatch('PAYBOX', '  paybox ') === 'exact');
check('match: SMS קצר מול PDF מלא → similar', merchantMatch('DEMO SHOP', 'DEMO SHOP ASIAN FOODBAR') === 'similar');
check('match: סניף/עיר נוספים → similar', merchantMatch('ארומה', 'ארומה עיר ימים נתניה') === 'similar');
check('match: שם שנחתך באמצע מילה → similar',
  merchantMatch('מאפה נאמן - קניון עיר ימים', 'מאפה נאמן - קניון עי') === 'similar');
// הגנה מפני over-matching — הבדיקה הזו שומרת על tests/ocr.mjs
check('match: שגיאת OCR עם מילה משותפת אינה התאמה', merchantMatch('DANN הקסום', 'האגם הקסום') === null);
check('match: בתי עסק שונים אינם התאמה', merchantMatch('שופרסל', 'רמי לוי') === null);
check('match: קידומת קצרה מ-4 תווים אינה מספיקה', merchantMatch('אבג', 'אבגד') === null);
check('match: שם ריק אינו מתאים לכלום', merchantMatch('', 'DEMO SHOP') === null);
check('match: סיומת אינה קידומת (לא מתאים)', merchantMatch('הקסום', 'האגם הקסום') === null);

// ---------- findDuplicate ----------
// 2014 — טווח מבודד שאף מערך אחר לא נוגע בו
function insertTx({ date, amount, merchant, type = 'expense', source = 'sms' }) {
  return db.prepare(
    'INSERT INTO transactions (date, amount, type, merchant, description, source) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(date, amount, type, merchant, '', source).lastInsertRowid;
}

const smsId = insertTx({ date: '2014-02-11', amount: 237, merchant: 'DEMO SHOP', source: 'sms' });

const hit = findDuplicate({ date: '2014-02-11', amount: 237, merchant: 'DEMO SHOP ASIAN FOODBAR', type: 'expense' });
check('findDuplicate: שם מורחב מזוהה מול השם הקצר', hit?.id === smsId, JSON.stringify(hit));
check('findDuplicate: מדווח על רמת ההתאמה', hit?.level === 'similar', hit?.level);
check('findDuplicate: סכום שונה אינו כפילות',
  findDuplicate({ date: '2014-02-11', amount: 238, merchant: 'DEMO SHOP', type: 'expense' }) === null);
check('findDuplicate: תאריך שונה אינו כפילות',
  findDuplicate({ date: '2014-02-12', amount: 237, merchant: 'DEMO SHOP', type: 'expense' }) === null);
check('findDuplicate: סוג שונה אינו כפילות',
  findDuplicate({ date: '2014-02-11', amount: 237, merchant: 'DEMO SHOP', type: 'income' }) === null);
check('findDuplicate: בית עסק אחר באותו תאריך וסכום אינו כפילות',
  findDuplicate({ date: '2014-02-11', amount: 237, merchant: 'ביס דיל', type: 'expense' }) === null);
check('findDuplicate: excludeId מונע השוואה של שורה לעצמה',
  findDuplicate({ date: '2014-02-11', amount: 237, merchant: 'DEMO SHOP', type: 'expense' }, { excludeId: smsId }) === null);

// ---------- enrichRows: הזרימה שנכשלה בפועל ----------
const pdfRow = [{ date: '2014-02-11', amount: 237, merchant: 'DEMO SHOP ASIAN FOODBAR', type: 'expense' }];
const [enriched] = enrichRows(pdfRow, 'pdf');
check('ייבוא PDF: שם מורחב מסומן ככפילות מול SMS קיים', enriched.duplicate === true);
check('ייבוא PDF: מדווח מול איזו עסקה', enriched.duplicate_of?.id === smsId, JSON.stringify(enriched.duplicate_of));
check('ייבוא PDF: מדווח את המקור של העסקה הקיימת', enriched.duplicate_of?.source === 'sms');

const otherRow = [{ date: '2014-02-11', amount: 237, merchant: 'חנות אחרת לגמרי', type: 'expense' }];
check('ייבוא PDF: בית עסק אחר באותו תאריך+סכום לא מסומן', enrichRows(otherRow, 'pdf')[0].duplicate === false);

// ---------- scanDuplicates ----------
const pdfId = insertTx({ date: '2014-02-11', amount: 237, merchant: 'DEMO SHOP ASIAN FOODBAR', source: 'pdf' });
insertTx({ date: '2014-02-11', amount: 237, merchant: 'עסק ללא קשר', source: 'pdf' });

const groups = scanDuplicates().filter((g) => g.date === '2014-02-11');
check('scan: מזהה את הקבוצה', groups.length === 1, `n=${groups.length}`);
check('scan: הקבוצה מכילה בדיוק את שתי השורות', groups[0]?.rows.length === 2,
  JSON.stringify(groups[0]?.rows.map((r) => r.merchant)));
check('scan: כוללת את שתי ה-id', groups[0]?.rows.map((r) => r.id).sort().join(',') === [smsId, pdfId].sort().join(','));
check('scan: רמת ההתאמה similar (שמות שונים)', groups[0]?.level === 'similar', groups[0]?.level);
check('scan: מדווחת את שני המקורות', groups[0]?.sources.sort().join('+') === 'pdf+sms', groups[0]?.sources.join('+'));
check('scan: עסק ללא קשר לא נכנס לקבוצה',
  !groups[0]?.rows.some((r) => r.merchant === 'עסק ללא קשר'));

// שורות של אותה תוכנית תשלומים אינן כפילות
const grp = 'dup-test-group';
const i1 = db.prepare("INSERT INTO transactions (date, amount, type, merchant, description, source, installment_group) VALUES ('2014-03-05', 99, 'expense', 'רהיטי בדיקה', 'תשלום 1/3', 'pdf', ?)").run(grp).lastInsertRowid;
const i2 = db.prepare("INSERT INTO transactions (date, amount, type, merchant, description, source, installment_group) VALUES ('2014-03-05', 99, 'expense', 'רהיטי בדיקה', 'תשלום 2/3', 'pdf', ?)").run(grp).lastInsertRowid;
check('scan: שתי שורות של אותה תוכנית תשלומים אינן כפילות',
  scanDuplicates().every((g) => g.date !== '2014-03-05'));

// ---------- מחזור חיוב שונה = לא כפילות ----------
// דוח "פירוט חיובים קרובים" מציג עסקה שנרכשה לפני סגירת המחזור אבל תחויב
// רק בדוח הבא, ולכן היא נראית ככפילות של השורה שכבר נספרה במחזור הקודם.
// "📅 העבר למחזור הבא" (charge_date) מפריד ביניהן — והקבוצה חייבת לרדת
// מהרשימה, אחרת הפאנל היה מציג אותה שוב בכל טעינה למרות שטופלה.
const dupGroupOf = (date) => scanDuplicates().find((g) => g.date === date);
const setChg = db.prepare('UPDATE transactions SET charge_date = ? WHERE id = ?');

check('scan: charge_date מוחזר בשורות (ה-UI מציג מצב ומאפשר ביטול)',
  dupGroupOf('2014-02-11')?.rows.every((r) => 'charge_date' in r));

setChg.run('2014-03-11', pdfId);
check('scan: אחרי העברה למחזור הבא — הקבוצה יורדת מהרשימה',
  dupGroupOf('2014-02-11') === undefined, JSON.stringify(dupGroupOf('2014-02-11')?.rows.map((r) => r.id)));

setChg.run('2014-03-11', smsId);
check('scan: שתי שורות שהועברו לאותו מחזור — עדיין כפילות',
  dupGroupOf('2014-02-11')?.rows.length === 2, `n=${dupGroupOf('2014-02-11')?.rows.length}`);

setChg.run(null, smsId);
setChg.run(null, pdfId);
check('scan: ביטול ההעברה מחזיר את הקבוצה (פעולה הפיכה)',
  dupGroupOf('2014-02-11')?.rows.length === 2);

// אותה זרימה דרך ה-API של ה-web: PUT charge_date='next' → הקבוצה נעלמת
const putNext = await fetch(`${BASE}/api/transactions/${pdfId}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Connection: 'close' },
  body: JSON.stringify({ charge_date: 'next' }),
});
check('API: PUT charge_date=next על שורה כפולה מחזיר 200', putNext.status === 200, `status=${putNext.status}`);
const afterMove = await (await fetch(`${BASE}/api/transactions/duplicates`, { headers: { Connection: 'close' } })).json();
check('API: אחרי ההעברה הקבוצה כבר לא מוחזרת מ-/duplicates',
  !afterMove.groups.some((g) => g.date === '2014-02-11'));
await fetch(`${BASE}/api/transactions/${pdfId}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Connection: 'close' },
  body: JSON.stringify({ charge_date: null }),
});
check('API: אחרי ביטול ההעברה הקבוצה חוזרת',
  (await (await fetch(`${BASE}/api/transactions/duplicates`, { headers: { Connection: 'close' } })).json())
    .groups.some((g) => g.date === '2014-02-11'));

// הכנסה — אין מחזור חיוב, ולכן אין כפתור העברה (parity מול `txDetailView`)
const incA = insertTx({ date: '2014-04-07', amount: 500, merchant: 'החזר בדיקה', type: 'income', source: 'sms' });
const incB = insertTx({ date: '2014-04-07', amount: 500, merchant: 'החזר בדיקה', type: 'income', source: 'pdf' });

// ---------- API ----------
const res = await fetch(`${BASE}/api/transactions/duplicates`, { headers: { Connection: 'close' } });
const body = await res.json();
check('API: GET /duplicates מחזיר 200', res.status === 200, `status=${res.status}`);
check('API: מחזיר total_groups ו-total_extra',
  typeof body.total_groups === 'number' && typeof body.total_extra === 'number', JSON.stringify({ g: body.total_groups, e: body.total_extra }));
check('API: הקבוצה שלנו מופיעה', body.groups.some((g) => g.date === '2014-02-11'));
check('API: total_extra = סך השורות העודפות',
  body.total_extra === body.groups.reduce((s, g) => s + g.rows.length - 1, 0));

// ---------- תצוגת הבוט ----------
const { duplicatesView } = await import('../server/bot.js');

// ---------- "לא כפילות" — חיובים נפרדים ----------
// שלוש כרטיסיות רכבת באותו יום, אותו סכום ואותו שם — לדוח האשראי מספר עסקה
// שונה לכל אחת, ולכן אלו שלושה חיובים אמיתיים. עד שנוסף הסימון הזה הדרך
// היחידה להוריד את הקבוצה מהפאנל הייתה למחוק שורה אמיתית או להעביר אותה
// למחזור הבא — שתיהן משבשות את הנתונים (נתוני רגרסיה מומצאים).
const rail = ['sms', 'pdf', 'pdf'].map((src) =>
  insertTx({ date: '2014-05-20', amount: 42, merchant: 'תחבורה לדוגמה', source: src }));

const railGroup = () => scanDuplicates().find((g) => g.date === '2014-05-20');
check('לא כפילות: שלוש שורות זהות מקובצות יחד', railGroup()?.rows.length === 3,
  `n=${railGroup()?.rows.length}`);

const ignoredBefore = ignoredCount();
const marked = ignoreDuplicateGroup(rail[0]);
check('לא כפילות: הסימון מדווח על כל שורות הקבוצה', marked.rows === 3, JSON.stringify(marked));
check('לא כפילות: קבוצה של 3 שורות היא 3 זוגות', ignoredCount() - ignoredBefore === 3,
  `pairs=${ignoredCount() - ignoredBefore}`);
check('לא כפילות: הקבוצה יורדת מהסריקה', railGroup() === undefined,
  JSON.stringify(railGroup()?.rows.map((r) => r.id)));
check('לא כפילות: סריקה בלי דילוגים עדיין רואה את הקבוצה (בסיס ל-ignore חוזר)',
  scanDuplicates({ applyIgnores: false }).some((g) => g.date === '2014-05-20'));
check('לא כפילות: סימון חוזר לא מכפיל זוגות',
  ignoreDuplicateGroup(rail[0]).rows === 3 && ignoredCount() - ignoredBefore === 3);
check('לא כפילות: שורה שאינה בקבוצה מחזירה 0', ignoreDuplicateGroup(rail[0] + 99999).rows === 0);

// קבוצה אחרת באותו DB לא נפגעת מהסימון
check('לא כפילות: קבוצות אחרות נשארות', scanDuplicates().some((g) => g.date === '2014-02-11'));

// API — parity מול ה-web
const apiDup = () => fetch(`${BASE}/api/transactions/duplicates`, { headers: { Connection: 'close' } })
  .then((r) => r.json());
const ignState = await apiDup();
check('API: /duplicates מדווח את מספר הזוגות המסומנים', ignState.ignored_pairs === ignoredCount(),
  `${ignState.ignored_pairs} vs ${ignoredCount()}`);
check('API: הקבוצה המסומנת לא מוחזרת', !ignState.groups.some((g) => g.date === '2014-05-20'));

const clearRes = await fetch(`${BASE}/api/transactions/duplicates/ignore`, {
  method: 'DELETE', headers: { Connection: 'close' },
});
check('API: DELETE /duplicates/ignore מחזיר 200', clearRes.status === 200, `status=${clearRes.status}`);
check('API: אחרי הביטול הקבוצה חוזרת (פעולה הפיכה)',
  (await apiDup()).groups.some((g) => g.date === '2014-05-20'));

const postRes = await fetch(`${BASE}/api/transactions/duplicates/ignore`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Connection: 'close' },
  body: JSON.stringify({ id: rail[0] }),
});
check('API: POST /duplicates/ignore מחזיר 200', postRes.status === 200, `status=${postRes.status}`);
check('API: אחרי POST הקבוצה יורדת מהרשימה',
  !(await apiDup()).groups.some((g) => g.date === '2014-05-20'));
const badPost = await fetch(`${BASE}/api/transactions/duplicates/ignore`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Connection: 'close' },
  body: JSON.stringify({ id: 'לא מספר' }),
});
check('API: id לא תקין → 400', badPost.status === 400, `status=${badPost.status}`);

// מחיקת שורה מנקה את הסימונים שלה (ON DELETE CASCADE) — בלי זה id ממוחזר
// היה יורש סימון של עסקה אחרת לגמרי.
const railPairs = ignoredCount();
db.prepare('DELETE FROM transactions WHERE id = ?').run(rail[2]);
check('לא כפילות: מחיקת שורה מנקה את הזוגות שלה', ignoredCount() === railPairs - 2,
  `${ignoredCount()} vs ${railPairs - 2}`);

clearIgnoredDuplicates();
check('לא כפילות: clearIgnoredDuplicates מאפס', ignoredCount() === 0);

const view = duplicatesView();
check('בוט: התצוגה מזכירה את בית העסק', view.text.includes('DEMO SHOP'), view.text.slice(0, 120));
const cb = view.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
check('בוט: המחיקה עוברת במסך האישור (tx:delask)', cb.includes(`tx:delask:${smsId}`), cb.join(' | '));
check('בוט: אין קריאת מחיקה ישירה מהרשימה', !cb.some((d) => d.startsWith('tx:del:')), cb.join(' | '));
check('בוט: כוכביות Markdown מאוזנות', (view.text.match(/(?<!\\)\*/g) || []).length % 2 === 0);
// "העבר למחזור הבא" מהפאנל — בלחיצה אחת (פעולה הפיכה, בשונה ממחיקה)
check('בוט: כפתור העברה למחזור הבא לצד המחיקה', cb.includes(`tx:dupchg:${smsId}:next`), cb.join(' | '));
check('בוט: הכנסה מוצגת בפאנל', view.text.includes('החזר בדיקה'), view.text.slice(0, 200));
check('בוט: להכנסה אין כפתור מחזור חיוב',
  !cb.some((d) => d === `tx:dupchg:${incA}:next` || d === `tx:dupchg:${incB}:next`), cb.join(' | '));
check('בוט: להכנסה עדיין יש מחיקה דרך מסך אישור', cb.includes(`tx:delask:${incA}`), cb.join(' | '));
// ✔️ "לא כפילות" — parity מול הפאנל ב-web. פועל על הקבוצה, לא על שורה בודדת.
check('בוט: לכל קבוצה יש כפתור "לא כפילות"', cb.some((d) => d.startsWith('tx:dupok:')), cb.join(' | '));
check('בוט: אין כפתור שחזור כשאין סימונים', !cb.includes('tx:dupclr'), cb.join(' | '));
ignoreDuplicateGroup(smsId);
const viewAfter = duplicatesView();
const cbAfter = viewAfter.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
check('בוט: אחרי סימון מופיע כפתור שחזור', cbAfter.includes('tx:dupclr'), cbAfter.join(' | '));
check('בוט: הקבוצה המסומנת ירדה מהתצוגה', !viewAfter.text.includes('DEMO SHOP'), viewAfter.text.slice(0, 160));
check('בוט: כוכביות Markdown מאוזנות גם אחרי סימון',
  (viewAfter.text.match(/(?<!\\)\*/g) || []).length % 2 === 0);
clearIgnoredDuplicates();

// ניקוי — רק השורות שהמערך יצר
const del = db.prepare('DELETE FROM transactions WHERE id = ?');
for (const id of [smsId, pdfId, i1, i2, incA, incB, ...rail]) del.run(id);
db.prepare("DELETE FROM transactions WHERE merchant = 'עסק ללא קשר'").run();

console.log(`\n========== duplicates: ${pass}/${pass + fail} ==========`);
process.exitCode = fail === 0 ? 0 : 1;
