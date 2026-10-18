// בדיקות פרסינג טקסט של דוחות — פורמטים אמיתיים (רגרסיה).
// לא דורש שרת; ייבוא ישיר של הפונקציה הטהורה.
import { parseStatementText } from '../server/lib/importer.js';
import { parseSms } from '../server/lib/smsParser.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
  cond ? pass++ : fail++;
};

console.log('========== פרסינג דוחות PDF ==========\n');

// פורמט אשראי ישראלי (בנק יהב) — מופרד Tab: "<קוד> <בית עסק>\t<סכום>\tnull <תאריך>\tכן/לא"
const yahav = [
  'סכום חיוב)₪( תיאור פעולה\tמספר זיהוי עיסקה\tמידע נוסף תאריך\tהצגת כרטיס', // כותרת — לדילוג
  '9011 מוסך דוגמה\t110.00\tnull 12/03/2024\tכן',
  '9012 חנות ציוד דוגמה )מרכז(\t6.50\tnull 12/03/2024\tכן',
  '9013 מרכול דוגמה\t175.25\tnull 12/03/2024\tכן',
  '0 יהב- דמי כרטיס\t0.00\tnull 20/03/2024\tלא', // סכום 0 — לדילוג
  '9014 משרד דוגמה\t510.00\tnull 25/06/2026\tלא',
  'עמוד | 1',        // מטא — לדילוג
  '-- 1 of 4 --',    // מטא — לדילוג
].join('\n');

const r = parseStatementText(yahav);
check('פורמט יהב: 4 עסקאות חולצו (כותרת+0+מטא דולגו)', r.rows.length === 4, `rows=${r.rows.length}`);
check('תאריך נכון (DD/MM/YYYY → ISO)', r.rows[0].date === '2024-03-12', r.rows[0].date);
check('סכום נכון', r.rows[0].amount === 110, String(r.rows[0].amount));
check('בית עסק בלי קוד מספרי מוביל', r.rows[0].merchant === 'מוסך דוגמה', r.rows[0].merchant);
check('עברית בסדר לוגי תקין (לא הפוך)', r.rows[1].merchant === 'חנות ציוד דוגמה )מרכז(', r.rows[1].merchant);
check('סכום 0 (דמי כרטיס) דולג', !r.rows.some((x) => x.amount === 0));
check('סך הכל מדויק', Math.round(r.rows.reduce((s, x) => s + x.amount, 0) * 100) / 100 === 801.75,
  String(r.rows.reduce((s, x) => s + x.amount, 0)));

// שם עסק לועזי ארוך שנשבר ב-PDF לשורות נפרדות מהסכום (באג "70" במקום OPENAI)
const splitMerchant = [
  '9021 סטודיו דוגמה\t355.00\tnull 13/03/2024\tכן',
  '9022 OPENAI *CHATGPT', // שבר שם עסק — שורה 1
  'SUBS',                    // שבר שם עסק — שורה 2
  '70.00\tnull 13/03/2024\tלא', // סכום+תאריך בלי בית עסק
  '9023 SAMPLE VIDEO\t44.50\tnull 14/03/2024\tלא', // שם לועזי קצר — נשאר בשורה אחת
].join('\n');
const sm = parseStatementText(splitMerchant);
check('שם לועזי שבור אוחד: 3 עסקאות', sm.rows.length === 3, `rows=${sm.rows.length}`);
const openai = sm.rows.find((x) => x.amount === 70);
check('בית עסק שוחזר מהשורות שקדמו (לא "70")',
  openai && openai.merchant === 'OPENAI *CHATGPT SUBS', openai?.merchant);
check('תאריך העסקה השבורה נכון', openai?.date === '2024-03-13', openai?.date);
check('שם לועזי קצר בשורה אחת עדיין תקין',
  sm.rows.some((x) => x.merchant === 'SAMPLE VIDEO'), 'SAMPLE VIDEO');

// מספר תשלום מעמודת "מידע נוסף" — "17 / 48 12/03/2023" מול "null 14/03/2024".
// זהו המקור האמין למספר התשלום; בלעדיו הייבוא הגדיל את המונה עיוורת בכל העלאה.
const withInstallments = [
  '9031 שירות מים דוגמה\t87.50\t17 / 48 12/03/2023\tלא',
  '9032 שירות עיצוב דוגמה\t825.00\t4 / 4 13/03/2024\tלא',
  '9033 מוסך דוגמה נוסף\t1,125.00\tnull 14/03/2024\tכן',
].join('\n');
const inst = parseStatementText(withInstallments);
check('תשלומים: 3 עסקאות חולצו', inst.rows.length === 3, `rows=${inst.rows.length}`);
check('תשלומים: "17 / 48" נקרא כ-index/count',
  inst.rows[0].installment?.index === 17 && inst.rows[0].installment?.count === 48,
  JSON.stringify(inst.rows[0].installment));
check('תשלומים: התאריך עדיין נכון (לא בולע את מספר התשלום)',
  inst.rows[0].date === '2023-03-12', inst.rows[0].date);
check('תשלומים: "4 / 4" (תשלום אחרון) נקרא נכון',
  inst.rows[1].installment?.index === 4 && inst.rows[1].installment?.count === 4,
  JSON.stringify(inst.rows[1].installment));
check('תשלומים: רכישה רגילה ("null") ללא installment',
  inst.rows[2].installment === null, JSON.stringify(inst.rows[2].installment));
check('תשלומים: תאריך רכישה רגילה נכון', inst.rows[2].date === '2024-03-14', inst.rows[2].date);

// טבלת "רכישה בדולר" (מטבע חוץ) — מבנה עמודות שונה לגמרי מהטבלה השקלית, בלי
// סכום בש"ח; שם בית העסק נמשך לשורה הבאה (לא לפני, כמו OPENAI למעלה).
// נתונים מומצאים בפורמט מטבע חוץ; שם הספק נשמר לבדיקת שער ההמרה המוגדר.
const fxLines = [
  'סכום חיוב תאריך\tסכום ב )USD( מטבע מקור תיאור פעולה\tמספר זיהוי עיסקה',
  'רכישה בדולר ארה״ב',
  'תאריך חיוב\tהצגת כרטיס',
  '22/03/2024\t20.00 9041\tדולר ארה"ב\t20.00 14/03/2024\tANTHROPIC*',
  'CLAUDE SU',
  'לא',
  '20.00 סה"כ)USD(',
].join('\n');
const fx = parseStatementText(fxLines);
check('מטבע חוץ (Anthropic): שורה אחת חולצה', fx.rows.length === 1, `rows=${fx.rows.length}`);
check('מטבע חוץ: תאריך הרכישה (לא תאריך החיוב)', fx.rows[0]?.date === '2024-03-14', fx.rows[0]?.date);
check('מטבע חוץ: שם בית העסק אוחד משתי השורות', fx.rows[0]?.merchant === 'ANTHROPIC CLAUDE', fx.rows[0]?.merchant);
check('מטבע חוץ: הומר לסכום ש"ח קבוע (לא 20 הדולרים הגולמיים)', fx.rows[0]?.amount === 70, String(fx.rows[0]?.amount));
check('מטבע חוץ: סה"כ USD לא נספר כעסקה', fx.rows.length === 1);

// בית עסק זר לא מוכר — מדולג (לא מיובא בסכום שגוי)
const fxUnknown = [
  '22/03/2024\t50.00 123456\tיורו\t50.00 15/03/2024\tSOME EURO SHOP',
  'לא',
].join('\n');
const fxU = parseStatementText(fxUnknown);
check('מטבע חוץ: בית עסק לא מוכר מדולג ולא מיובא בסכום שגוי', fxU.rows.length === 0, `rows=${fxU.rows.length}`);

// פורמט גנרי: תאריך בתחילת השורה
const generic = [
  '16/03/2024 SAMPLE HEALTH 93.50',
  '17/03/2024 SAMPLE FUEL 265.00',
  'כותרת ללא תאריך שתדולג',
].join('\n');
const g = parseStatementText(generic);
check('פורמט גנרי (תאריך-ראשון): 2 עסקאות', g.rows.length === 2, `rows=${g.rows.length}`);
check('פורמט גנרי — סכום בסוף השורה', g.rows[0].amount === 93.5, String(g.rows[0].amount));

// פרסינג SMS — טמפלט ישראכרט (תאריך לפני הסכום, שם עסק צמוד ל-ב ונגמר בנקודה)
const isracardSms = `שלום,
בכרטיסך המסתיים , אושרה עסקה ב-12/03 בסך 219.00 ש"ח בDEMO SHOP.
למידע נוסף באפליקציה ובאתר: https://example.com/app.
לשירותך,  ישראכרט`;
const s1 = parseSms(isracardSms);
check('SMS ישראכרט: בית עסק נקי (בלי זנב הקישור)', s1?.merchant === 'DEMO SHOP', s1?.merchant);
check('SMS ישראכרט: סכום נכון', s1?.amount === 219, String(s1?.amount));
check('SMS ישראכרט: תאריך חולץ מההודעה (12/03)', s1?.date === '2026-03-12', s1?.date);

const s2 = parseSms('בכרטיסך המסתיים , אושרה עסקה ב-13/03 בסך 27.00 ש"ח בחנות דוגמה.\nלמידע נוסף: https://example.com/info. לשירותך, ישראכרט');
check('SMS ישראכרט: שם עברי עם רווח', s2?.merchant === 'חנות דוגמה', s2?.merchant);

// רגרסיה — התבניות הישנות עדיין עובדות
check('SMS ישן (approved) עדיין נפרס',
  parseSms('אושרה עסקה בסך 93.50 ש"ח ב-בית קפה דוגמה בתאריך 14/03')?.merchant === 'בית קפה דוגמה');
check('SMS ריק → null', parseSms('') === null);

console.log(`\n========== parsers: ${pass}/${pass + fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
