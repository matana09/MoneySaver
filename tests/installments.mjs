// בדיקות: תיוג עסקה קיימת כתשלום (בלי יצירת שורות עתידיות) + זיהוי המשך
// תשלומים בייבוא (לא כפילות) — ראו server/lib/installments.js, server/lib/importer.js.
import { db } from '../server/db.js';
import { tagInstallment, listInstallmentGroups, planPaymentInWindow, installmentsCategoryTotal, installmentChargeDetails } from '../server/lib/installments.js';
import { enrichRows, commitRows } from '../server/lib/importer.js';
import { localDate, addMonthsClamped, cycleWindow } from '../server/lib/dates.js';
import { computeCycleFlow, computeFlow } from '../server/routes/flow.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
  cond ? pass++ : fail++;
};

console.log('========== תיוג תשלומים + המשך בייבוא ==========\n');

function insertTx({ date, amount, merchant, type = 'expense' }) {
  return db.prepare(
    'INSERT INTO transactions (date, amount, type, merchant, description, source) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(date, amount, type, merchant, '', 'pdf').lastInsertRowid;
}

// תיוג עסקה בודדת (כמו KSP שיובאה מ-PDF כשורה אחת) — בלי שורות עתידיות
const kspId = insertTx({ date: '2026-07-10', amount: 1690, merchant: 'KSP TEST' });
const tagged = tagInstallment(kspId, 1, 2);
check('תיוג: description מעודכן', tagged.description === 'תשלום 1/2', tagged.description);
check('תיוג: installment_group נוצר', Boolean(tagged.installment_group));
const countAfterTag = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE merchant = ?').get('KSP TEST').n;
check('תיוג: לא נוצרו שורות עתידיות', countAfterTag === 1, `n=${countAfterTag}`);

// קלט לא תקין נדחה
let threw = false;
try { tagInstallment(kspId, 5, 2); } catch { threw = true; }
check('תיוג: אינדקס גדול מהסה"כ נדחה', threw);

// עסקה שנייה, אותו בית עסק, אותו סה"כ — מצטרפת אוטומטית לאותה קבוצה
const other = insertTx({ date: '2020-01-01', amount: 1, merchant: 'KSP TEST' });
const tagged2 = tagInstallment(other, 2, 2);
check('תיוג: הצטרפות אוטומטית לאותה קבוצה', tagged2.installment_group === tagged.installment_group);

// ---------- ייבוא: מספר התשלום נלקח מהדוח ומעדכן את התוכנית במקום ----------
// תוכנית מתויגת "תשלום 1/3"; הדוח הבא מדווח "2 / 3" על אותה תוכנית — התוצאה
// היא עדכון השורה הקיימת, לא שורה נוספת.
const merchant2 = 'ZARA CONT ' + Date.now(); // שם ייחודי כדי לא להתנגש עם רצים קודמים
const origId = insertTx({ date: '2026-05-05', amount: 300, merchant: merchant2 });
const origTag = tagInstallment(origId, 1, 3);

const [enriched] = enrichRows(
  [{ date: '2026-05-05', amount: 300, merchant: merchant2, type: 'expense', installment: { index: 2, count: 3 } }], 'pdf');
check('ייבוא: תוכנית קיימת לא מסומנת ככפילות', enriched.duplicate === false);
check('ייבוא: מספר התשלום נלקח מהדוח ("תשלום 2/3")', enriched.description === 'תשלום 2/3', enriched.description);
check('ייבוא: אותה installment_group', enriched.installment_group === origTag.installment_group);
check('ייבוא: מסומן כעדכון-במקום', enriched.installment_update?.id === origId, `${enriched.installment_update?.id}`);

const commitRes = commitRows([enriched], 'pdf');
check('ייבוא: נספר כעדכון ולא כהוספה', commitRes.updated === 1 && commitRes.inserted === 0,
  `updated=${commitRes.updated} inserted=${commitRes.inserted}`);
const rows = db.prepare('SELECT * FROM transactions WHERE merchant = ? ORDER BY id').all(merchant2);
check('ייבוא: נשארה שורה אחת בלבד', rows.length === 1, `rows=${rows.length}`);
check('ייבוא: התיאור עודכן במקום', rows[0].description === 'תשלום 2/3', rows[0].description);

// ---------- אידמפוטנטיות: העלאה חוזרת של אותו דוח לא משנה דבר ----------
// הבאג שדווח: העלאה חוזרת של אותו PDF יצרה שורה שנייה לכל תוכנית תשלומים,
// כי מספר התשלום הוגדל עיוורת ב-1 במקום להיקרא מעמודת "מידע נוסף".
const idemMerchant = 'זרקא טסט ' + Date.now();
const pdfRow = { date: '2026-04-10', amount: 950, merchant: idemMerchant, type: 'expense', installment: { index: 4, count: 4 } };

const first = commitRows(enrichRows([pdfRow], 'pdf'), 'pdf');
check('אידמפוטנטיות: תוכנית חדשה מהדוח נוצרה כשורה אחת', first.inserted === 1, `inserted=${first.inserted}`);
const afterFirst = db.prepare('SELECT * FROM transactions WHERE merchant = ?').all(idemMerchant);
check('אידמפוטנטיות: תויגה נכון מהדוח בלי תיוג ידני',
  afterFirst.length === 1 && afterFirst[0].description === 'תשלום 4/4' && afterFirst[0].installment_group,
  JSON.stringify(afterFirst.map((r) => r.description)));

const second = commitRows(enrichRows([pdfRow], 'pdf'), 'pdf');
check('אידמפוטנטיות: העלאה חוזרת לא מוסיפה שורה', second.inserted === 0, `inserted=${second.inserted}`);
const afterSecond = db.prepare('SELECT * FROM transactions WHERE merchant = ?').all(idemMerchant);
check('אידמפוטנטיות: עדיין שורה אחת עם אותו מספר תשלום',
  afterSecond.length === 1 && afterSecond[0].description === 'תשלום 4/4',
  `n=${afterSecond.length} desc=${afterSecond[0]?.description}`);

// דוח של חודש הבא על אותה תוכנית (12 תשלומים, 5→6) — מעדכן במקום, שורה אחת
const monthlyMerchant = 'אלקטרוניקס טסט ' + Date.now();
const mk = (index) => ({ date: '2026-03-12', amount: 75, merchant: monthlyMerchant, type: 'expense', installment: { index, count: 12 } });
commitRows(enrichRows([mk(5)], 'pdf'), 'pdf');
const advance = commitRows(enrichRows([mk(6)], 'pdf'), 'pdf');
check('חודש הבא: נספר כעדכון, לא כהוספה', advance.updated === 1 && advance.inserted === 0,
  `updated=${advance.updated} inserted=${advance.inserted}`);
const monthlyRows = db.prepare('SELECT description FROM transactions WHERE merchant = ?').all(monthlyMerchant);
check('חודש הבא: שורה אחת שהתקדמה ל-6/12',
  monthlyRows.length === 1 && monthlyRows[0].description === 'תשלום 6/12',
  `n=${monthlyRows.length} desc=${monthlyRows[0]?.description}`);

// ---------- רגרסיה: כפילות רגילה (בלי תיוג) עדיין נחסמת ----------
const plainMerchant = 'PLAIN DUP ' + Date.now();
insertTx({ date: '2026-05-06', amount: 55, merchant: plainMerchant });
const [plainEnriched] = enrichRows([{ date: '2026-05-06', amount: 55, merchant: plainMerchant, type: 'expense' }], 'pdf');
check('רגרסיה: כפילות רגילה (לא מתויגת) עדיין נחסמת', plainEnriched.duplicate === true);

// ---------- listInstallmentGroups: "סה"כ תשלומים" ----------
const groups = listInstallmentGroups();
const kspGroup = groups.find((g) => g.group === tagged.installment_group);
check('listInstallmentGroups: קבוצת KSP נמצאת', Boolean(kspGroup));
check('listInstallmentGroups: paid_count/total_count נכונים',
  kspGroup?.paid_count === 2 && kspGroup?.total_count === 2,
  `paid=${kspGroup?.paid_count} total=${kspGroup?.total_count}`);
check('listInstallmentGroups: amount = סכום התשלום החודשי הקבוע (לא סכום מצטבר)',
  kspGroup?.amount === 1690, `${kspGroup?.amount}`);
const contGroup = groups.find((g) => g.group === origTag.installment_group);
check('listInstallmentGroups: "שולם" משקף את מספר התשלום שעודכן מהדוח', contGroup?.paid_count === 2,
  `paid=${contGroup?.paid_count}`);

// שורה בודדת שתויגה "תשלום 36/48" (כמו בדוח בנק אמיתי — יש לנו רק שורה אחת
// מקומית) — "שולם" צריך להראות 36 (מספר התשלום שתויג), לא 1 (כמות השורות)
const bigId = insertTx({ date: '2023-07-26', amount: 92, merchant: 'שטראוס טסט ' + Date.now() });
const bigTag = tagInstallment(bigId, 36, 48);
const bigGroup = listInstallmentGroups().find((g) => g.group === bigTag.installment_group);
check('listInstallmentGroups: "שולם" = מספר התשלום המתויג, לא כמות שורות',
  bigGroup?.paid_count === 36 && bigGroup?.total_count === 48,
  `paid=${bigGroup?.paid_count} total=${bigGroup?.total_count}`);

// קבוצה שנוצרה מראש עם כל התשלומים (כמו addInstallments) — כולל שורה עתידית.
// "שולם" צריך לספור רק שורות שתאריכן כבר הגיע, לא תשלומים עתידיים שכבר קיימים ב-DB.
const futureGroup = 'test-group-' + Date.now();
const today = localDate();
const futureDate = addMonthsClamped(today, 1);
db.prepare('INSERT INTO transactions (date, amount, type, merchant, description, source, installment_group) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run(today, 500, 'expense', 'FUTURE TEST', 'תשלום 1/2', 'manual', futureGroup);
db.prepare('INSERT INTO transactions (date, amount, type, merchant, description, source, installment_group) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run(futureDate, 500, 'expense', 'FUTURE TEST', 'תשלום 2/2', 'manual', futureGroup);
const futureGroupResult = listInstallmentGroups().find((g) => g.group === futureGroup);
check('listInstallmentGroups: תשלום עתידי לא נספר כ"שולם"',
  futureGroupResult?.paid_count === 1 && futureGroupResult?.total_count === 2,
  `paid=${futureGroupResult?.paid_count} total=${futureGroupResult?.total_count}`);
check('listInstallmentGroups: amount לא מושפע מתשלום עתידי',
  futureGroupResult?.amount === 500, `${futureGroupResult?.amount}`);

// ---------- מספר התשלום לפי מחזור (הבאג שדווח) ----------
// KSP: תשלום 1/2 ב-10.07 ו-2/2 ב-10.08. בחלון 11.06–10.07 זה 1/2, בחלון
// 11.07–10.08 זה 2/2, ובחלון 11.08–10.09 התוכנית נגמרה ולא מוצגת כלל.
const kspTxs = [
  { date: '2026-07-10', amount: 1690, description: 'תשלום 1/2' },
  { date: '2026-08-10', amount: 1690, description: 'תשלום 2/2' },
];
const june = planPaymentInWindow(kspTxs, '2026-06-11', '2026-07-10');
const july = planPaymentInWindow(kspTxs, '2026-07-11', '2026-08-10');
const august = planPaymentInWindow(kspTxs, '2026-08-11', '2026-09-10');
check('מחזור: יוני = תשלום 1 מתוך 2', june?.index === 1 && june?.total === 2, JSON.stringify(june));
check('מחזור: יולי = תשלום 2 מתוך 2', july?.index === 2 && july?.total === 2, JSON.stringify(july));
check('מחזור: אוגוסט — התוכנית הסתיימה, לא מוצגת', august === null, JSON.stringify(august));

// שורה בודדת שתויגה מדוח PDF: התאריך הוא **תאריך העסקה המקורית**, לא מועד
// החיוב של התשלום הנוכחי (commitRows מעדכן רק את ה-description). לכן תשלום j
// נופל ב-date + (j−1) חודשים: קנייה ב-12.03 → תשלום 5 ב-12.07 (המחזור שבו
// הדוח אכן דיווח 5/12), תשלום 4 במחזור שלפניו.
const singleRow = [{ date: '2026-03-12', amount: 75, description: 'תשלום 5/12' }];
const p1 = planPaymentInWindow(singleRow, '2026-03-11', '2026-04-10');
const p4 = planPaymentInWindow(singleRow, '2026-06-11', '2026-07-10');
const p5 = planPaymentInWindow(singleRow, '2026-07-11', '2026-08-10');
const p12 = planPaymentInWindow(singleRow, '2027-02-11', '2027-03-10'); // 12.03.2026 + 11 חודשים
const after = planPaymentInWindow(singleRow, '2027-03-11', '2027-04-10');
check('שורה מ-PDF: חודש העסקה = תשלום 1', p1?.index === 1, JSON.stringify(p1));
check('שורה מ-PDF: מחזור יוני = תשלום 4', p4?.index === 4, JSON.stringify(p4));
check('שורה מ-PDF: מחזור יולי = 5 (כפי שדווח בדוח)', p5?.index === 5, JSON.stringify(p5));
check('שורה מ-PDF: התשלום ה-12 עדיין בתוך התוכנית', p12?.index === 12, JSON.stringify(p12));
check('שורה מ-PDF: אחרי התשלום האחרון — null', after === null, JSON.stringify(after));

// רגרסיה על הבאג שדווח: שטראוס — קנייה ב-26.07.2023, 48 תשלומים, הדוח של יולי
// 2026 מדווח 37/48. ההנחה השגויה (התאריך = מועד חיוב של תשלום 37) "סיימה" את
// התוכנית ב-2024 והעלימה אותה לגמרי.
const strauss = [{ date: '2023-07-26', amount: 92, description: 'תשלום 37/48' }];
const sJune = planPaymentInWindow(strauss, '2026-06-11', '2026-07-10');
const sJuly = planPaymentInWindow(strauss, '2026-07-11', '2026-08-10');
check('שטראוס: מחזור יוני = 36 מתוך 48', sJune?.index === 36 && sJune?.total === 48, JSON.stringify(sJune));
check('שטראוס: מחזור יולי = 37 מתוך 48 (כמו בדוח)', sJuly?.index === 37, JSON.stringify(sJuly));
check('שטראוס: התוכנית עדיין פעילה ב-2027',
  planPaymentInWindow(strauss, '2027-05-11', '2027-06-10')?.index === 47);
check('שטראוס: אחרי תשלום 48 — null',
  planPaymentInWindow(strauss, '2027-07-11', '2027-08-10') === null);

// תוכנית שטרם התחילה לא מוצגת במחזור שלפניה
const notYet = planPaymentInWindow(kspTxs, '2026-05-11', '2026-06-10');
check('מחזור שלפני התשלום הראשון — לא מוצגת', notYet === null, JSON.stringify(notYet));

// ---------- listInstallmentGroups עם חלון ----------
const catName = 'תשלומים-טסט-' + Date.now();
const catId = db.prepare('INSERT INTO categories (name, color, icon) VALUES (?, ?, ?)')
  .run(catName, '#8896a6', '💳').lastInsertRowid;
const catGroup = 'cat-total-' + Date.now();
const insCat = db.prepare('INSERT INTO transactions (date, amount, type, merchant, description, category_id, source, installment_group) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
insCat.run('2026-07-10', 1690, 'expense', 'KSP CAT', 'תשלום 1/2', catId, 'pdf', catGroup);
insCat.run('2026-08-10', 1690, 'expense', 'KSP CAT', 'תשלום 2/2', catId, 'pdf', catGroup);

const winJuly = listInstallmentGroups({ start: '2026-07-11', end: '2026-08-10' })
  .find((g) => g.group === catGroup);
check('חלון: הקבוצה מוחזרת עם index של המחזור', winJuly?.index === 2 && winJuly?.total_count === 2,
  `index=${winJuly?.index} total=${winJuly?.total_count}`);
check('חלון: יש עסקה אמיתית במחזור → projected=false', winJuly?.projected === false, `${winJuly?.projected}`);
check('חלון: אחרי סיום התוכנית היא לא ברשימה',
  !listInstallmentGroups({ start: '2026-08-11', end: '2026-09-10' }).some((g) => g.group === catGroup));

// תוכנית מ-PDF (שורה אחת, תאריך = תאריך העסקה): במחזור שהדוח דיווח עליו
// (תשלום 5) יש רישום אמיתי; במחזור הבא (תשלום 6) התשלום חזוי עד שיובא הדוח.
const projGroup = 'proj-' + Date.now();
insCat.run('2026-03-12', 75, 'expense', 'PROJ CAT', 'תשלום 5/12', catId, 'pdf', projGroup);
const reported = listInstallmentGroups({ start: '2026-07-11', end: '2026-08-10' }).find((g) => g.group === projGroup);
check('חלון: המחזור שדווח בדוח — index 5, לא חזוי',
  reported?.index === 5 && reported?.projected === false,
  `index=${reported?.index} projected=${reported?.projected}`);
check('חלון: amount = התשלום החודשי', reported?.amount === 75, `${reported?.amount}`);
const nextCycle = listInstallmentGroups({ start: '2026-08-11', end: '2026-09-10' }).find((g) => g.group === projGroup);
check('חלון: מחזור סגור אינו מציג תשלום שטרם יובא',
  nextCycle === undefined,
  `index=${nextCycle?.index} projected=${nextCycle?.projected}`);

// ---------- installmentsCategoryTotal: משתנה מחודש לחודש ----------
// בקטגוריה שתי תוכניות: KSP (1690, שני תשלומים 07–08) ו-PROJ (75, תשלום 5
// ביולי). יולי = שתיהן; אוגוסט = רק PROJ (KSP הסתיימה) — הסכום חייב להשתנות.
// שורת תוכנית שיובאה מ-PDF נושאת תאריך עסקה מ-03.2026, ולכן סכום לפי שורות
// היה מפספס אותה לגמרי — זו בדיוק התקיעה שדווחה.
const totJuly = installmentsCategoryTotal(catName, { start: '2026-07-11', end: '2026-08-10' });
const totAug = installmentsCategoryTotal(catName, { start: '2026-08-11', end: '2026-09-10' });
check('סה"כ קטגוריה: יולי = שתי התוכניות (1690+75)', totJuly === 1765, `${totJuly}`);
check('סה"כ קטגוריה: מחזור סגור אינו כולל חיוב שטרם יובא', totAug === 0, `${totAug}`);
check('סה"כ קטגוריה: הסכום משתנה בין מחזורים', totJuly !== totAug);
// עסקה בודדת (בלי תוכנית) בחלון נספרת בנוסף
db.prepare('INSERT INTO transactions (date, amount, type, merchant, description, category_id, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run('2026-08-20', 40, 'expense', 'חד פעמי', '', catId, 'pdf');
check('סה"כ קטגוריה: עסקה בודדת נשמרת בלי החיוב החזוי (40)',
  installmentsCategoryTotal(catName, { start: '2026-08-11', end: '2026-09-10' }) === 40,
  `${installmentsCategoryTotal(catName, { start: '2026-08-11', end: '2026-09-10' })}`);
let winThrew = false;
try { installmentsCategoryTotal(catName); } catch { winThrew = true; }
check('סה"כ קטגוריה: בלי חלון נזרקת שגיאה (אין יותר מצב כל-הזמנים)', winThrew);

// ---------- תזרים: מועדי החיוב של תשלומי PDF, בלי שינוי תאריכי הרכישה ----------
const cashflowName = 'תזרים-תשלומים-טסט-' + Date.now();
const cashflowCategory = db.prepare('INSERT INTO categories (name, color, icon) VALUES (?, ?, ?)')
  .run(cashflowName, '#8896a6', '💳').lastInsertRowid;
const cashflowIds = [];
const monthlySnapshots = new Map();
let cashflowSeq = 0;
const cashflowInsert = db.prepare(`
  INSERT INTO transactions (date, amount, type, merchant, description, category_id, source, installment_group, charge_date)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
function cashflowTx({ date, amount, index, count, source = 'pdf', type = 'expense',
  group = null, charge_date = null, merchant = null }) {
  const id = cashflowInsert.run(date, amount, type,
    merchant ?? `${cashflowName} ${++cashflowSeq}`, `תשלום ${index}/${count}`,
    cashflowCategory, source, group ?? `${cashflowName}-group-${++cashflowSeq}`, charge_date).lastInsertRowid;
  cashflowIds.push(id);
  return id;
}
function calendarFlow(month) {
  if (!monthlySnapshots.has(month)) {
    monthlySnapshots.set(month, db.prepare('SELECT * FROM monthly_flow WHERE month = ?').get(month) ?? null);
  }
  return computeFlow(month);
}
const cashflowTotal = (flow) => flow.by_category.find((c) => c.name === cashflowName)?.total ?? 0;
const dayTotal = (flow, date) => flow.daily.find((d) => d.d === date)?.total ?? 0;
const sameAmount = (actual, expected) => Math.abs(actual - expected) < 0.001;

try {
  // גבול הסגירה: עד סוף המחזור התשלום החזוי מוצג, ולמחרת הוא נעלם.
  const projectionStart = `${localDate().slice(0, 7)}-01`;
  const projectionId = cashflowTx({ date: addMonthsClamped(projectionStart, -1), amount: 23, index: 1, count: 3 });
  const projectionTx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(projectionId);
  const projectedToday = listInstallmentGroups({ start: projectionStart, end: localDate() })
    .find((g) => g.group === projectionTx.installment_group);
  const futureDate = addMonthsClamped(projectionTx.date, 2);
  const projectedFuture = listInstallmentGroups({ start: futureDate, end: futureDate })
    .find((g) => g.group === projectionTx.installment_group);
  check('רשימת תשלומים: חיוב חזוי נשמר ביום סגירת המחזור',
    projectedToday?.index === 2 && projectedToday.projected && projectedToday.amount === 23);
  check('רשימת תשלומים: חיוב חזוי נשמר במחזור עתידי',
    projectedFuture?.index === 3 && projectedFuture.projected && projectedFuture.amount === 23);
  check('סה"כ: החיוב החזוי נכלל ביום הסגירה וגם בעתיד',
    installmentsCategoryTotal(cashflowName, { start: projectionStart, end: localDate() }) === 23
      && installmentsCategoryTotal(cashflowName, { start: futureDate, end: futureDate }) === 23);
  db.prepare('DELETE FROM transactions WHERE id = ?').run(projectionId);

  // נתוני הרגרסיה המקוריים; השוואה לבסיס מבודדת עסקאות של מערכים קודמים.
  const incidentBaseline = computeCycleFlow('2026-09', 10);
  const incidentCalendarBaseline = calendarFlow('2026-09');
  const incident = [
    { date: '2023-07-26', amount: 92, index: 39, count: 48 },
    { date: '2026-03-12', amount: 75, index: 7, count: 12 },
    { date: '2026-08-14', amount: 1500, index: 2, count: 2 },
  ].map((row) => {
    const merchant = `${cashflowName} incident ${++cashflowSeq}`;
    return { ...row, merchant, id: cashflowTx({ ...row, merchant }) };
  });
  const incidentFlow = computeCycleFlow('2026-09', 10);
  check('תזרים PDF: שלושת חיובי ספטמבר מוסיפים 1,667 לדשבורד',
    sameAmount(incidentFlow.actual_expenses - incidentBaseline.actual_expenses, 1667),
    `delta=${incidentFlow.actual_expenses - incidentBaseline.actual_expenses}`);
  check('תזרים PDF: הקטגוריה בדשבורד כוללת את אותם 1,667', cashflowTotal(incidentFlow) === 1667,
    `category=${cashflowTotal(incidentFlow)}`);
  check('תזרים PDF: סך קטגוריית התשלומים תואם את הדשבורד',
    installmentsCategoryTotal(cashflowName, { start: incidentFlow.start, end: incidentFlow.end }) === cashflowTotal(incidentFlow));
  for (const [date, amount] of [['2026-09-12', 75], ['2026-09-14', 1500], ['2026-09-26', 92]]) {
    check(`תזרים PDF: מצטבר יומי כולל את החיוב ב-${date}`,
      sameAmount(dayTotal(incidentFlow, date) - dayTotal(incidentBaseline, date), amount));
  }
  check('תזרים PDF: סכום הימים שווה לסכום ההוצאות',
    sameAmount(incidentFlow.daily.reduce((sum, day) => sum + day.total, 0), incidentFlow.actual_expenses));
  const incidentCalendar = calendarFlow('2026-09');
  check('תזרים PDF: גם חודש קלנדרי כולל את התשלומים הנוכחיים',
    sameAmount(incidentCalendar.actual_expenses - incidentCalendarBaseline.actual_expenses, 1667)
      && cashflowTotal(incidentCalendar) === 1667);
  check('תזרים PDF: חישוב התזרים משאיר את תאריכי הרכישה ללא שינוי',
    incident.every((row) => {
      const stored = db.prepare('SELECT date, charge_date FROM transactions WHERE id = ?').get(row.id);
      return stored.date === row.date && stored.charge_date === null;
    }));

  const incidentImport = (rows) => rows.map(({ date, amount, merchant, index, count }) => ({
    date, amount, merchant, type: 'expense', installment: { index, count },
  }));
  const repeatedIncident = commitRows(enrichRows(incidentImport(incident), 'pdf'), 'pdf');
  check('תזרים PDF: ייבוא חוזר אינו מוסיף או משנה תשלום',
    repeatedIncident.inserted === 0 && repeatedIncident.updated === 0
      && cashflowTotal(computeCycleFlow('2026-09', 10)) === 1667);
  const advancedIncident = commitRows(enrichRows(incidentImport(incident.slice(0, 2)
    .map((row) => ({ ...row, index: row.index + 1 }))), 'pdf'), 'pdf');
  check('תזרים PDF: הדוח הבא אינו משנה את סך ההוצאות ההיסטורי',
    advancedIncident.inserted === 0 && advancedIncident.updated === 2
      && cashflowTotal(computeCycleFlow('2026-09', 10)) === 1667);

  // בלוח ידני כל שורה נושאת חיוב אמיתי, לרבות אגורת העיגול בתשלום האחרון.
  const manualGroup = `${cashflowName}-manual`;
  cashflowTx({ date: '1987-01-15', amount: 333.33, index: 1, count: 3, source: 'manual', group: manualGroup });
  cashflowTx({ date: '1987-02-15', amount: 333.33, index: 2, count: 3, source: 'manual', group: manualGroup });
  const manualLast = cashflowTx({ date: '1987-03-15', amount: 333.34, index: 3, count: 3, source: 'manual', group: manualGroup });
  check('תזרים ידני: כל חודש נספר פעם אחת עם סכום השורה המקורי',
    cashflowTotal(calendarFlow('1987-01')) === 333.33
      && cashflowTotal(calendarFlow('1987-02')) === 333.33
      && cashflowTotal(calendarFlow('1987-03')) === 333.34);
  check('תזרים ידני: סכומי שלושת התשלומים שומרים על 1,000 בדיוק',
    sameAmount(['1987-01', '1987-02', '1987-03'].reduce((sum, month) => sum + cashflowTotal(calendarFlow(month)), 0), 1000));
  db.prepare('UPDATE transactions SET charge_date = ? WHERE id = ?').run('1987-04-15', manualLast);
  check('תזרים ידני: העברת מחזור מזיזה רק את השורה שנבחרה',
    cashflowTotal(calendarFlow('1987-03')) === 0
      && cashflowTotal(calendarFlow('1987-04')) === 333.34
      && cashflowTotal(calendarFlow('1987-02')) === 333.33);

  // charge_date הוא חריגה לתשלום המדווח בלבד, ולא עוגן חדש לכל התוכנית.
  const legacyMovedId = cashflowTx({ date: '1988-01-15', amount: 80, index: 2, count: 3, charge_date: '1988-03-05' });
  check('תזרים PDF: charge_date מבטל את החיוב המקורי של התשלום המדווח',
    cashflowTotal(calendarFlow('1988-01')) === 80 && cashflowTotal(calendarFlow('1988-02')) === 0);
  const movedFlow = computeCycleFlow('1988-03', 1);
  check('תזרים PDF: במחזור סגור נשמר החיוב שהועבר בלי התשלום הבא שטרם יובא',
    cashflowTotal(calendarFlow('1988-03')) === 80 && cashflowTotal(movedFlow) === 80
      && dayTotal(movedFlow, '1988-03-05') === 80 && dayTotal(movedFlow, '1988-03-15') === 0);
  check('תזרים PDF: סך הקטגוריה כולל גם חיוב שהועבר וגם את החיוב הבא',
    installmentsCategoryTotal(cashflowName, { start: movedFlow.start, end: movedFlow.end }) === cashflowTotal(movedFlow));
  const legacyMoved = db.prepare('SELECT * FROM transactions WHERE id = ?').get(legacyMovedId);
  commitRows(enrichRows([{ date: legacyMoved.date, amount: legacyMoved.amount, merchant: legacyMoved.merchant,
    type: 'expense', installment: { index: 3, count: 3 } }], 'pdf'), 'pdf');
  const legacyAdvanced = db.prepare('SELECT * FROM transactions WHERE id = ?').get(legacyMovedId);
  check('תזרים PDF: עדכון דוח מקבע מספר תשלום בהעברה ישנה ללא מטא-נתון',
    legacyAdvanced.installment_charge_index === 2 && legacyAdvanced.description === 'תשלום 3/3'
      && cashflowTotal(calendarFlow('1988-02')) === 0 && cashflowTotal(calendarFlow('1988-03')) === 160);
  const movedFebruaryList = listInstallmentGroups({ start: '1988-02-01', end: '1988-02-29' })
    .filter((g) => g.group === legacyMoved.installment_group);
  const movedMarchList = listInstallmentGroups({ start: '1988-03-01', end: '1988-03-31' })
    .filter((g) => g.group === legacyMoved.installment_group);
  check('רשימת תשלומים: חיוב שהועבר אינו מוצג בחודש המקורי', movedFebruaryList.length === 0);
  check('רשימת תשלומים: ההעברה נשארת שייכת לתשלום 2 גם אחרי ייבוא תשלום 3',
    movedMarchList.length === 2
      && movedMarchList.some((g) => g.index === 2 && g.due_date === '1988-03-05' && g.amount === 80)
      && movedMarchList.some((g) => g.index === 3 && g.due_date === '1988-03-15' && g.amount === 80)
      && movedMarchList.reduce((sum, g) => sum + g.amount, 0) === cashflowTotal(calendarFlow('1988-03')));

  cashflowTx({ date: '1989-01-18', amount: 90, index: 3, count: 3 });
  check('תזרים PDF: תשלום אחרון נספר בחודשו ולא מייצר חיובים אחרי סיום',
    cashflowTotal(calendarFlow('1989-03')) === 90 && cashflowTotal(calendarFlow('1989-04')) === 0);

  cashflowTx({ date: '1990-01-18', amount: 100, index: 2, count: 3 });
  cashflowTx({ date: '1990-02-18', amount: 20, index: 2, count: 3, type: 'income' });
  const refundFlow = calendarFlow('1990-02');
  check('תזרים: זיכוי נשאר הכנסה ולא משוכפל כתוכנית הוצאות',
    refundFlow.actual_income === 20 && cashflowTotal(refundFlow) === 100);
  check('תזרים: זיכוי מתויג אינו מייצר הכנסה בחודש הבא', calendarFlow('1990-03').actual_income === 0);

  cashflowTx({ date: '1991-01-20', amount: 55, index: 5, count: 6, source: 'csv' });
  const wideFlow = computeCycleFlow('1991-05', (month) => month >= '1991-06' ? 28 : 1);
  check('תזרים: חלון סגור רחב כולל רק את התשלום המדווח',
    wideFlow.start === '1991-05-02' && wideFlow.end === '1991-06-28'
      && cashflowTotal(wideFlow) === 55 && dayTotal(wideFlow, '1991-05-20') === 55
      && dayTotal(wideFlow, '1991-06-20') === 0);
  check('תזרים: סך הקטגוריה סופר את שני התשלומים בחלון רחב',
    installmentsCategoryTotal(cashflowName, { start: wideFlow.start, end: wideFlow.end }) === cashflowTotal(wideFlow));
  const wideList = listInstallmentGroups({ start: wideFlow.start, end: wideFlow.end })
    .filter((g) => g.category_name === cashflowName);
  check('רשימת תשלומים: חלון סגור רחב מציג רק חיובים מדווחים',
    wideList.length === 1 && wideList.every((g) => g.amount === 55)
      && wideList.some((g) => g.index === 5 && g.due_date === '1991-05-20')
      && !wideList.some((g) => g.index === 6)
      && wideList.reduce((sum, g) => sum + g.amount, 0) === cashflowTotal(wideFlow));

  cashflowTx({ date: '1992-01-31', amount: 13, index: 3, count: 4 });
  const leapFlow = computeCycleFlow('1992-02', 28);
  const marchEndFlow = computeCycleFlow('1992-03', 28);
  check('תזרים: סוף חודש מוצמד ל-29 בפברואר בשנה מעוברת',
    cashflowTotal(leapFlow) === 13 && dayTotal(leapFlow, '1992-02-29') === 13);
  check('תזרים: מרץ חוזר ליום 31 בלי לצבור הצמדה מפברואר',
    cashflowTotal(marchEndFlow) === 13 && dayTotal(marchEndFlow, '1992-03-31') === 13);

  const partialGroup = `${cashflowName}-partial`;
  cashflowTx({ date: '1993-01-15', amount: 17, index: 1, count: 3, source: 'manual', group: partialGroup });
  cashflowTx({ date: '1993-03-15', amount: 17.02, index: 3, count: 3, source: 'manual', group: partialGroup });
  check('תזרים ידני: מחיקה חלקית אינה משחזרת חיוב שנמחק',
    cashflowTotal(calendarFlow('1993-01')) === 17 && cashflowTotal(calendarFlow('1993-02')) === 0
      && cashflowTotal(calendarFlow('1993-03')) === 17.02);
  check('רשימת תשלומים: מחיקה חלקית אינה מציגה את התשלום הידני החסר',
    !listInstallmentGroups({ start: '1993-02-01', end: '1993-02-28' }).some((g) => g.group === partialGroup));
  cashflowTx({ date: '1994-04-20', amount: 40, index: 2, count: 2, source: 'manual' });
  check('תזרים ידני: שורה יחידה של תשלום 2/2 אינה הופכת לתוכנית משוערת',
    cashflowTotal(calendarFlow('1994-04')) === 40 && cashflowTotal(calendarFlow('1994-05')) === 0);

  // בתצוגת הייבוא תשלום 7 מרכישה במרץ שייך לספטמבר, לא למחזור הרכישה.
  const nextImportMerchant = `${cashflowName} import-next`;
  const nextImportRow = (index) => ({ date: '2000-03-12', amount: 75, merchant: nextImportMerchant,
    type: 'expense', installment: { index, count: 12 } });
  const previewOptions = { cycleDay: 10, today: new Date(2000, 8, 20) };
  const [nextImportPreview] = enrichRows([nextImportRow(7)], 'pdf', previewOptions);
  check('ייבוא PDF: מחזור תשלום 7 מחושב ממועד החיוב בספטמבר',
    nextImportPreview.cycle_label === cycleWindow('2000-09', 10).label
      && nextImportPreview.cycle_closed === false && nextImportPreview.next_cycle_date === '2000-10-11'
      && nextImportPreview.date === '2000-03-12', JSON.stringify({
      label: nextImportPreview.cycle_label, closed: nextImportPreview.cycle_closed, next: nextImportPreview.next_cycle_date,
    }));
  const [closedImportPreview] = enrichRows([nextImportRow(7)], 'pdf', {
    cycleDay: 10, today: new Date(2000, 9, 12),
  });
  check('ייבוא PDF: סגירת המחזור נקבעת לפי מועד התשלום ולא תאריך הרכישה',
    closedImportPreview.cycle_closed === true && closedImportPreview.next_cycle_date === '2000-10-11');
  nextImportPreview.next_cycle = true;
  nextImportPreview.category_id = cashflowCategory;
  const nextImportFirst = commitRows([nextImportPreview], 'pdf', { cycleDay: 10 });
  const nextImported = db.prepare('SELECT * FROM transactions WHERE merchant = ?').get(nextImportMerchant);
  if (nextImported) cashflowIds.push(nextImported.id);
  check('ייבוא PDF: העברת תוכנית חדשה שומרת את תאריך הרכישה ומקבעת תשלום 7',
    nextImportFirst.inserted === 1 && nextImported?.date === '2000-03-12'
      && nextImported.charge_date === '2000-10-11' && nextImported.installment_charge_index === 7);
  const [nextImportRepeat] = enrichRows([nextImportRow(7)], 'pdf', previewOptions);
  nextImportRepeat.next_cycle = true;
  const nextImportRepeated = commitRows([nextImportRepeat], 'pdf', { cycleDay: 10 });
  check('ייבוא PDF: אישור חוזר של אותה העברת מחזור אינו נספר כעדכון',
    nextImportRepeated.inserted === 0 && nextImportRepeated.updated === 0
      && cashflowTotal(calendarFlow('2000-09')) === 0 && cashflowTotal(calendarFlow('2000-10')) === 75);
  const [nextImportAdvance] = enrichRows([nextImportRow(8)], 'pdf', previewOptions);
  nextImportAdvance.next_cycle = false;
  commitRows([nextImportAdvance], 'pdf', { cycleDay: 10 });
  const nextImportPreserved = db.prepare('SELECT * FROM transactions WHERE merchant = ?').get(nextImportMerchant);
  check('ייבוא PDF: ללא בקשת העברה חדשה הדוח הבא שומר את תשלום 7 באוקטובר',
    nextImportPreserved.description === 'תשלום 8/12' && nextImportPreserved.charge_date === '2000-10-11'
      && nextImportPreserved.installment_charge_index === 7
      && cashflowTotal(calendarFlow('2000-09')) === 0 && cashflowTotal(calendarFlow('2000-10')) === 150);
  const [nextImportNewMove] = enrichRows([nextImportRow(8)], 'pdf', previewOptions);
  nextImportNewMove.next_cycle = true;
  const nextImportReplaced = commitRows([nextImportNewMove], 'pdf', { cycleDay: 10 });
  const nextImportMovedAgain = db.prepare('SELECT * FROM transactions WHERE merchant = ?').get(nextImportMerchant);
  check('ייבוא PDF: בחירת העברה לתשלום 8 מקבעת את התשלום החדש בנובמבר',
    nextImportReplaced.updated === 1 && nextImportMovedAgain.charge_date === '2000-11-11'
      && nextImportMovedAgain.installment_charge_index === 8
      && cashflowTotal(calendarFlow('2000-09')) === 75 && cashflowTotal(calendarFlow('2000-10')) === 0);

  const pinnedMovedId = cashflowTx({ date: '1996-01-15', amount: 80, index: 2, count: 3 });
  const pinnedMoved = db.prepare('SELECT * FROM transactions WHERE id = ?').get(pinnedMovedId);
  const nextInstallment = installmentChargeDetails(pinnedMoved, 'next', 10);
  check('העברת PDF: המחזור הבא מחושב ממועד תשלום 2 ולא מהרכישה בינואר',
    nextInstallment.charge_date === '1996-03-11' && nextInstallment.installment_charge_index === 2,
    JSON.stringify(nextInstallment));
  const explicitInstallment = installmentChargeDetails(pinnedMoved, '1996-03-05', 10);
  db.prepare('UPDATE transactions SET charge_date = ?, installment_charge_index = ? WHERE id = ?')
    .run(explicitInstallment.charge_date, explicitInstallment.installment_charge_index, pinnedMovedId);
  commitRows(enrichRows([{ date: pinnedMoved.date, amount: pinnedMoved.amount, merchant: pinnedMoved.merchant,
    type: 'expense', installment: { index: 3, count: 3 } }], 'pdf'), 'pdf');
  const pinnedAdvanced = db.prepare('SELECT * FROM transactions WHERE id = ?').get(pinnedMovedId);
  check('העברת PDF: מספר התשלום שהועבר נשמר גם כשהדוח מתקדם ל-3/3',
    pinnedAdvanced.installment_charge_index === 2 && pinnedAdvanced.charge_date === '1996-03-05'
      && cashflowTotal(calendarFlow('1996-02')) === 0 && cashflowTotal(calendarFlow('1996-03')) === 160);
  const clearedInstallment = installmentChargeDetails(pinnedAdvanced, null, 10);
  check('העברת PDF: ביטול מנקה גם את התאריך וגם את מספר התשלום שהועבר',
    clearedInstallment.charge_date === null && clearedInstallment.installment_charge_index === null);

  // בדיקת נתיב web רק מול שרת הבדיקות המבודד, לעולם לא מול פורט 3000.
  const cashflowBase = new URL(process.env.MS_BASE || 'http://127.0.0.1:3100');
  if (cashflowBase.port !== '3100') throw new Error('בדיקת העברת תשלום דורשת פורט בדיקות 3100');
  const putCashflowCharge = async (id, charge_date) => {
    const response = await fetch(new URL(`/api/transactions/${id}`, cashflowBase), {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ charge_date }), signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, row: await response.json() };
  };
  const apiMovedId = cashflowTx({ date: '1997-03-12', amount: 75, index: 7, count: 12 });
  const apiMove = await putCashflowCharge(apiMovedId, 'next');
  check('API: תשלום 7 של רכישה במרץ מועבר מהחיוב בספטמבר לאוקטובר',
    apiMove.status === 200 && apiMove.row.charge_date === '1997-10-11'
      && apiMove.row.installment_charge_index === 7 && apiMove.row.date === '1997-03-12',
    JSON.stringify(apiMove.row));
  const apiImportRow = { date: apiMove.row.date, amount: apiMove.row.amount, merchant: apiMove.row.merchant,
    type: 'expense', installment: { index: 8, count: 12 } };
  commitRows(enrichRows([apiImportRow], 'pdf'), 'pdf');
  const apiAdvanced = db.prepare('SELECT * FROM transactions WHERE id = ?').get(apiMovedId);
  check('API: ייבוא החודש הבא שומר את ההעברה המקורית ואת ספטמבר ללא החיוב',
    apiAdvanced.installment_charge_index === 7 && apiAdvanced.charge_date === '1997-10-11'
      && cashflowTotal(calendarFlow('1997-09')) === 0 && cashflowTotal(calendarFlow('1997-10')) === 150);
  const apiClear = await putCashflowCharge(apiMovedId, null);
  commitRows(enrichRows([apiImportRow], 'pdf'), 'pdf');
  const apiCleared = db.prepare('SELECT * FROM transactions WHERE id = ?').get(apiMovedId);
  check('API: ביטול ההעברה נשמר בייבוא חוזר ומחזיר את שני חודשי החיוב',
    apiClear.status === 200 && apiClear.row.charge_date === null && apiClear.row.installment_charge_index === null
      && apiCleared.charge_date === null && apiCleared.installment_charge_index === null
      && cashflowTotal(calendarFlow('1997-09')) === 75 && cashflowTotal(calendarFlow('1997-10')) === 75);
  const ordinaryId = cashflowInsert.run('1998-03-12', 12, 'expense', `${cashflowName} ordinary`, '',
    cashflowCategory, 'pdf', null, null).lastInsertRowid;
  cashflowIds.push(ordinaryId);
  const ordinaryMove = await putCashflowCharge(ordinaryId, 'next');
  check('API: העברת עסקה רגילה ממשיכה להתבסס על תאריך הרכישה',
    ordinaryMove.status === 200 && ordinaryMove.row.charge_date === '1998-04-11'
      && ordinaryMove.row.installment_charge_index === null);

  // קצב החיזוי חייב להשתמש באותם חיובים שהגרף וסכום ההוצאות מציגים.
  const todayFlowBaseline = computeCycleFlow(localDate().slice(0, 7), 1);
  cashflowTx({ date: addMonthsClamped(todayFlowBaseline.start, -36), amount: 12345, index: 37, count: 38 });
  const todayFlow = computeCycleFlow(localDate().slice(0, 7), 1);
  const todaySpent = todayFlow.daily.filter((day) => day.d <= localDate()).reduce((sum, day) => sum + day.total, 0);
  const todayForecast = Math.round(Math.max(todayFlow.actual_expenses,
    todaySpent / todayFlow.days_elapsed * todayFlow.cycle_length));
  check('תזרים: קצב החיזוי כולל תשלום PDF שכבר הגיע מועדו',
    todayFlow.predicted_expenses === todayForecast && todayFlow.predicted_expenses > todayFlowBaseline.predicted_expenses,
    `predicted=${todayFlow.predicted_expenses} expected=${todayForecast}`);
} finally {
  const removeCashflowTx = db.prepare('DELETE FROM transactions WHERE id = ?');
  for (const id of cashflowIds) removeCashflowTx.run(id);
  db.prepare('DELETE FROM categories WHERE id = ?').run(cashflowCategory);
  const restoreMonthly = db.prepare(`
    INSERT INTO monthly_flow (month, expected_income, actual_income, actual_expenses, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(month) DO UPDATE SET expected_income = excluded.expected_income,
      actual_income = excluded.actual_income, actual_expenses = excluded.actual_expenses,
      updated_at = excluded.updated_at
  `);
  for (const [month, snapshot] of monthlySnapshots) {
    if (snapshot) restoreMonthly.run(snapshot.month, snapshot.expected_income, snapshot.actual_income,
      snapshot.actual_expenses, snapshot.updated_at);
    else db.prepare('DELETE FROM monthly_flow WHERE month = ?').run(month);
  }
}

console.log(`\n========== installments: ${pass}/${pass + fail} ==========`);
// exitCode נותן ל-sockets להיסגר ומונע assertion של libuv ב-Windows.
process.exitCode = fail === 0 ? 0 : 1;
