// בדיקות: ייבוא מתמונה (JPG/PNG) דרך OCR — server/lib/ocr.js.
// שני fixtures (PIL, tests/fixtures/): ocr-sample.png — שתי שורות טקסט לינארי
// (כמו PDF); ocr-table-sample.png — טבלה אמיתית בעברית (תאריך|תיאור פעולה|
// מספר זיהוי|הצגת כרטיס|סכום), מדמה דוח אשראי שצולם כתמונה. בודקים את הצינור
// האמיתי — OCR אמיתי, לא מדומה — מקצה לקצה.
// ריצה איטית יחסית (כמה שניות, כמו עליית מנוע ה-ML) — אין דרך סבירה לזרז OCR אמיתי.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseImage, terminateOcrWorker } from '../server/lib/ocr.js';
import { enrichRows } from '../server/lib/importer.js';
import { db } from '../server/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
  cond ? pass++ : fail++;
};

console.log('========== ייבוא מתמונה (OCR) ==========\n');

const fixture = readFileSync(path.join(__dirname, 'fixtures', 'ocr-sample.png'));
const parsed = await parseImage(fixture);

check('parseImage: format = jpg', parsed.format === 'jpg', parsed.format);
check('parseImage: זוהו 2 שורות עסקה', parsed.rows.length === 2, `n=${parsed.rows.length}`);
check('parseImage: שורה ראשונה — תאריך+בית עסק+סכום נכונים',
  parsed.rows[0]?.date === '2024-03-02' && parsed.rows[0]?.merchant === 'SAMPLE CAFE' && parsed.rows[0]?.amount === 24.5,
  JSON.stringify(parsed.rows[0]));
check('parseImage: שורה שנייה — תאריך+בית עסק+סכום נכונים',
  parsed.rows[1]?.date === '2024-03-05' && parsed.rows[1]?.merchant === 'SAMPLE MARKET' && parsed.rows[1]?.amount === 132.4,
  JSON.stringify(parsed.rows[1]));

// --- טבלה עברית (תאריך|תיאור פעולה|מספר זיהוי|הצגת כרטיס|סכום) — מבנה טבלה
// אמיתי, לא טקסט לינארי. בודק את פירוק ה-bbox לפי מיקום מילה (parseTableRow),
// כולל סינון "מספר זיהוי עיסקה" ו"כן/לא" (עמודת הצגת כרטיס) משם בית העסק.
const tableFixture = readFileSync(path.join(__dirname, 'fixtures', 'ocr-table-sample.png'));
const tparsed = await parseImage(tableFixture);

check('parseImage (טבלה): זוהו 3 שורות עסקה', tparsed.rows.length === 3, `n=${tparsed.rows.length}`);
// שם באנגלית: תאריך+סכום מדויקים תמיד; תחילת השם ("SAMPLE") רגישה לרעש OCR —
// בודקים את החלק היציב של השם בלבד
check('parseImage (טבלה): שורה 2 — "ASIAN FOODBAR" 219.00 (אנגלית, ללא מספר זיהוי/כן)',
  tparsed.rows[1]?.date === '2024-03-03' && tparsed.rows[1]?.merchant?.includes('ASIAN FOODBAR') && tparsed.rows[1]?.amount === 219,
  JSON.stringify(tparsed.rows[1]));
check('parseImage (טבלה): שורה 3 — עברית עם נקודות ("ממתקי דוגמה") 29.00',
  tparsed.rows[2]?.date === '2024-03-06' && tparsed.rows[2]?.merchant === 'ממתקי דוגמה' && tparsed.rows[2]?.amount === 29,
  JSON.stringify(tparsed.rows[2]));
// שורה 1: תאריך+סכום תמיד נכונים (regex, לא תלוי OCR של שם); שם בית העסק
// עצמו תלוי-איכות-OCR ולא נבדק כאן מדויק (ראו הערה ב-ocr.js על מגבלת דיוק)
check('parseImage (טבלה): שורה 1 — תאריך+סכום נכונים',
  tparsed.rows[0]?.date === '2024-03-02' && tparsed.rows[0]?.amount === 41,
  JSON.stringify(tparsed.rows[0]));

// --- טבלה עם מסגרות תאים (ocr-table-borders.png) — טבלה סינתטית לשחזור מבנה הדוח
// עם שורות בדויות: כל 12 השורות, מסגרות סביב כל תא (הורסות את זיהוי
// Tesseract בלי stripTableLines), ותא אחד עם שם על שתי שורות (SAMPLE ASIAN /
// FOODBAR — מאוחד לשורה אחת דרך מפרידי קווי הטבלה). כותרת + סה"כ מסוננות.
const borderedFixture = readFileSync(path.join(__dirname, 'fixtures', 'ocr-table-borders.png'));
const bparsed = await parseImage(borderedFixture);

check('parseImage (טבלה עם מסגרות): זוהו כל 12 שורות העסקה', bparsed.rows.length === 12, `n=${bparsed.rows.length}`);
check('parseImage (מסגרות): כל התאריכים והסכומים מדויקים',
  JSON.stringify(bparsed.rows.map((r) => [r.date, r.amount])) === JSON.stringify([
    ['2024-03-02', 41], ['2024-03-03', 26], ['2024-03-03', 520], ['2024-03-03', 8.5],
    ['2024-03-03', 142.61], ['2024-03-03', 219], ['2024-03-05', 302.44], ['2024-03-06', 29],
    ['2024-03-07', 15.6], ['2024-03-07', 112.4], ['2024-03-08', 411.3], ['2024-03-08', 18],
  ]), JSON.stringify(bparsed.rows.map((r) => [r.date, r.amount])));
check('parseImage (מסגרות): שמות בית עסק בעברית מזוהים (מדגם)',
  bparsed.rows[8]?.merchant === 'מרכול מרכז' && bparsed.rows[10]?.merchant === 'בית מרקחת מרכז'
  && bparsed.rows[4]?.merchant === 'מרכול דוגמה',
  `${bparsed.rows[8]?.merchant} | ${bparsed.rows[10]?.merchant} | ${bparsed.rows[4]?.merchant}`);
check('parseImage (מסגרות): תא שם על שתי שורות מאוחד לשורת עסקה אחת (219.00)',
  bparsed.rows.filter((r) => r.amount === 219).length === 1);
// "לא זוהו" סופר רק כשל אמיתי בפענוח עסקה — כותרת/כותרת-על/סה"כ לא נספרות
// (הן מסוננות במכוון; ספירתן בלבלה את המשתמש בתצוגה המקדימה)
check('parseImage (מסגרות): כותרת ושורת סה"כ לא נספרות כ"לא זוהו"', bparsed.skipped === 0, `skipped=${bparsed.skipped}`);

// --- רזולוציה נמוכה + JPG (ocr-table-lowres.jpg) — תנאי רזולוציה נמוכה:
// אותה טבלה מוקטנת ל-735px ודחוסה JPG. בלי upscale וסף קו גבוה (DARK=200) חצי
// מהשורות יצאו ג'יבריש/מוזגו (אומת מול debug של העלאה אמיתית).
const lowresFixture = readFileSync(path.join(__dirname, 'fixtures', 'ocr-table-lowres.jpg'));
const lparsed = await parseImage(lowresFixture);
check('parseImage (רזולוציה נמוכה): זוהו כל 12 שורות העסקה', lparsed.rows.length === 12, `n=${lparsed.rows.length}`);
check('parseImage (רזולוציה נמוכה): כל התאריכים והסכומים מדויקים',
  JSON.stringify(lparsed.rows.map((r) => [r.date, r.amount])) === JSON.stringify([
    ['2024-03-02', 41], ['2024-03-03', 26], ['2024-03-03', 520], ['2024-03-03', 8.5],
    ['2024-03-03', 142.61], ['2024-03-03', 219], ['2024-03-05', 302.44], ['2024-03-06', 29],
    ['2024-03-07', 15.6], ['2024-03-07', 112.4], ['2024-03-08', 411.3], ['2024-03-08', 18],
  ]), JSON.stringify(lparsed.rows.map((r) => [r.date, r.amount])));
check('parseImage (רזולוציה נמוכה): אין "לא זוהו" כשכל העסקאות נקראו', lparsed.skipped === 0, `skipped=${lparsed.skipped}`);

// תמונה ריקה/בלי טקסט קריא → שגיאה ברורה, לא קריסה
let blankErr = null;
try {
  const blank = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'
  );
  await parseImage(blank);
} catch (err) {
  blankErr = err;
}
check('parseImage: תמונה בלי טקסט → שגיאה ברורה (לא קריסה)', blankErr instanceof Error, blankErr?.message);

await terminateOcrWorker();

// --- דדופ לייבוא מתמונה: עסקה קיימת לא נכנסת פעמיים ---
// תאריך ייעודי בעבר הרחוק (2015) — בידוד מלא מיתר מערכי הבדיקות.
db.prepare(`
  INSERT INTO transactions (date, amount, type, merchant, description, source)
  VALUES ('2015-03-17', 88.5, 'expense', 'האגם הקסום', '', 'pdf')
`).run();

// התאמה מדויקת (תאריך+סכום+בית עסק) — נתפסת גם בלי fuzzy (חוצת-מקורות)
const exact = enrichRows([{ date: '2015-03-17', merchant: 'האגם הקסום', amount: 88.5, type: 'expense' }], 'pdf');
check('דדופ: שם זהה מזוהה ככפילות (התאמה מדויקת, חוצת-מקורות)', exact[0].duplicate === true);

// OCR קרא את שם בית העסק שונה — בלי fuzzy מפספס, עם fuzzy (תאריך+סכום) נתפס
const misread = [{ date: '2015-03-17', merchant: 'DANN הקסום', amount: 88.5, type: 'expense' }];
check('דדופ: שם שגוי מ-OCR לא נתפס בהתאמה מדויקת (בלי fuzzy)',
  enrichRows(misread, 'pdf')[0].duplicate === false);
check('דדופ: שם שגוי מ-OCR כן נתפס עם fuzzyDup (תאריך+סכום)',
  enrichRows(misread, 'pdf', { fuzzyDup: true })[0].duplicate === true);

// עסקה שונה באמת (אותו תאריך, סכום אחר) — לא מסומנת גם עם fuzzy
check('דדופ: סכום שונה באותו תאריך לא מסומן ככפילות (fuzzy לא רחב מדי)',
  enrichRows([{ date: '2015-03-17', merchant: 'חנות אחרת', amount: 12, type: 'expense' }], 'pdf', { fuzzyDup: true })[0].duplicate === false);

console.log(`\n========== ocr: ${pass}/${pass + fail} ==========`);
process.exitCode = fail === 0 ? 0 : 1;
