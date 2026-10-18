// בדיקות: תלוש משכורת — server/lib/payslip.js + /api/payslip.
// ה-fixture (tests/fixtures/payslip-sample.pdf) נוצר חד-פעמית ב-reportlab: תלוש
// סינתטי עם עברית אמיתית, ת"ז/חשבון בנק/כתובת מזויפים, וסכומים שמסתדרים בדיוק
// (12500 − 2832.50 = 9667.50). הטקסט יוצא מה-PDF בסדר ויזואלי (הפוך) — בדיוק
// כמו תלוש אמיתי, ולכן הבדיקה מכסה את מסלול fixHebrew.
// אף בדיקה לא קוראת ל-Gemini האמיתי (אין מפתח ב-DB של הבדיקות).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  detectMonth, parsePayslipText, stripPii, runChecks, buildAnalysisPrompt, buildQuestionPrompt,
  stripLatexPlain, splitMessage, prevMonth,
} from '../server/lib/payslip.js';
import { extractPdfText } from '../server/lib/importer.js';
import { quotaErrorMessage } from '../server/lib/gemini.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.MS_BASE;
const HDRS = { Connection: 'close' };

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
  cond ? pass++ : fail++;
};

console.log('========== תלוש משכורת ==========\n');

const fixture = readFileSync(path.join(__dirname, 'fixtures', 'payslip-sample.pdf'));
const text = await extractPdfText(fixture);

/* ---------- זיהוי חודש ---------- */
check('detectMonth: MM/YYYY בשורת "תלוש שכר לחודש"', detectMonth(text) === '2026-06', detectMonth(text));
check('detectMonth: שם חודש עברי + שנה', detectMonth('תלוש שכר חודש מרץ 2026') === '2026-03');
check('detectMonth: אין תאריך → null', detectMonth('שכר יסוד 11000') === null);
check('detectMonth: שנה לא סבירה נדחית', detectMonth('חודש 05/1990') === null);
check('prevMonth: גלישה בין שנים', prevMonth('2026-01') === '2025-12', prevMonth('2026-01'));

/* ---------- חילוץ שדות ---------- */
const { fields, confidence } = parsePayslipText(text);
check('parsePayslipText: ברוטו', fields.gross === 12500, String(fields.gross));
check('parsePayslipText: נטו', fields.net === 9667.5, String(fields.net));
check('parsePayslipText: שכר יסוד', fields.base_salary === 11000, String(fields.base_salary));
check('parsePayslipText: מס הכנסה', fields.income_tax === 950, String(fields.income_tax));
check('parsePayslipText: ביטוח לאומי', fields.national_insurance === 430, String(fields.national_insurance));
check('parsePayslipText: דמי בריאות', fields.health_tax === 390, String(fields.health_tax));
check('parsePayslipText: פנסיה עובד/מעביד',
  fields.pension_employee === 750 && fields.pension_employer === 812.5,
  `${fields.pension_employee}/${fields.pension_employer}`);
check('parsePayslipText: קרן השתלמות עובד/מעביד',
  fields.study_fund_employee === 312.5 && fields.study_fund_employer === 937.5,
  `${fields.study_fund_employee}/${fields.study_fund_employer}`);
check('parsePayslipText: נקודות זיכוי (ספירה, לא סכום)', fields.credit_points === 2.25, String(fields.credit_points));
check('parsePayslipText: שעות עבודה', fields.hours === 182, String(fields.hours));
// ה-fixture מכסה 13 מתוך 15 שדות אפשריים (אין בו סה"כ ניכויים ושכר מבוטח) → ~87%
check('parsePayslipText: confidence גבוה על תלוש מלא', confidence >= 85, `${confidence}%`);

// טקסט בסדר לוגי (לא הפוך) — הפרסר חייב לתפוס את שתי הצורות
const logical = 'שכר ברוטו 8000.00\nנטו לתשלום 6500.00\nמס הכנסה 500.00';
const logicalFields = parsePayslipText(logical).fields;
check('parsePayslipText: גם טקסט בסדר לוגי (לא ויזואלי)',
  logicalFields.gross === 8000 && logicalFields.net === 6500, JSON.stringify(logicalFields));

check('parsePayslipText: טקסט ריק → אין שדות', Object.keys(parsePayslipText('').fields).length === 0);

/* ---------- הסרת פרטים מזהים ---------- */
const { text: clean, removed } = stripPii(text);
check('stripPii: ת"ז (9 ספרות) הוסרה', !clean.includes('123456789') && clean.includes('[ת"ז הוסר]'));
check('stripPii: מספר חשבון בנק הוסר', !clean.includes('45678901'));
check('stripPii: שורת כתובת הוסרה', !clean.includes('הרצל') && clean.includes('[כתובת הוסרה]'));
check('stripPii: מספר עמית בקופה הוסר', !clean.includes('998877665'));
check('stripPii: סכומים נשמרו (לא נפגעו בהסרה)',
  clean.includes('12500.00') && clean.includes('9667.50') && clean.includes('2.25'));
check('stripPii: מדווח כמה פרטים הוסרו', removed >= 4, `removed=${removed}`);
check('stripPii: טקסט נקי לא משתנה', stripPii('שכר ברוטו 8000.00').removed === 0);

/* ---------- בדיקות שפיות ---------- */
const checks = runChecks(fields);
const byId = (id) => checks.find((c) => c.id === id);
check('runChecks: net_math תקין כשהחישוב מסתדר', byId('net_math')?.status === 'ok', byId('net_math')?.detail);
check('runChecks: שיעור פנסיה עובד תקין (6%)', byId('pension_employee_rate')?.status === 'ok', byId('pension_employee_rate')?.detail);
check('runChecks: שיעור פנסיה מעביד תקין (6.5%)', byId('pension_employer_rate')?.status === 'ok', byId('pension_employer_rate')?.detail);

const broken = runChecks({ ...fields, net: 8000 });
check('runChecks: net_math נכשל כשיש פער גדול',
  broken.find((c) => c.id === 'net_math')?.status === 'fail',
  broken.find((c) => c.id === 'net_math')?.detail);

const missingNi = runChecks({ gross: 12500, net: 10000 });
check('runChecks: מתריע על ביטוח לאומי חסר',
  missingNi.some((c) => c.id === 'missing_national_insurance' && c.status === 'warn'));

const mom = runChecks(fields, { gross: 9000, net: 7000, credit_points: 2.25 });
check('runChecks: דלתא >10% מול החודש הקודם מסומנת',
  mom.find((c) => c.id === 'mom_gross')?.status === 'warn',
  mom.find((c) => c.id === 'mom_gross')?.detail);
check('runChecks: אין דלתא כששינוי קטן',
  !runChecks(fields, { gross: 12400, net: 9600 }).some((c) => c.id === 'mom_gross'));
check('runChecks: שינוי בנקודות זיכוי מסומן',
  runChecks(fields, { credit_points: 2.75 }).some((c) => c.id === 'credit_points_change'));
check('runChecks: בלי נתונים — אין בדיקות שווא', runChecks({}).length === 0);

/* ---------- פרומפט ---------- */
const prompt = buildAnalysisPrompt(fields, clean, '2026-06');
for (const section of ['## הסבר רכיבים', '## בדיקת חישובים', '## נקודות זיכוי',
  '## דירוג ממצאים', '## תוכנית פעולה', '## טיוטת הודעה למחלקת שכר', '## סיכום']) {
  check(`buildAnalysisPrompt: מכיל "${section}"`, prompt.includes(section));
}
check('buildAnalysisPrompt: שנת המס נגזרת מחודש התלוש', prompt.includes('2026'));
check('buildAnalysisPrompt: לא מכיל פרטים מזהים', !prompt.includes('123456789') && !prompt.includes('45678901'));
check('buildAnalysisPrompt: כולל את השדות שחולצו', prompt.includes('שכר ברוטו: 12,500'));
check('buildAnalysisPrompt: השוואה לחודש קודם רק כשיש נתונים',
  !prompt.includes('החודש הקודם') && buildAnalysisPrompt(fields, clean, '2026-06', { gross: 9000 }).includes('החודש הקודם'));

// הפרומפט אוסר על סימון LaTeX במפורש (המודל נוטה להחליק לשם)
check('buildAnalysisPrompt: אוסר על סימון LaTeX', prompt.includes('\\text') && prompt.includes('אסור'));

/* ---------- פרומפט שאלת המשך ---------- */
const qPrompt = buildQuestionPrompt({
  question: 'מגיע לי החזר מס?',
  fields, strippedText: clean, month: '2026-06',
  analysisMd: '## סיכום\nהתלוש תקין.',
  history: [{ q: 'מה הברוטו?', a: '12,500 ש"ח' }],
});
check('buildQuestionPrompt: כולל את השאלה', qPrompt.includes('מגיע לי החזר מס?'));
check('buildQuestionPrompt: כולל את הניתוח הקודם', qPrompt.includes('התלוש תקין'));
check('buildQuestionPrompt: כולל היסטוריית שאלות', qPrompt.includes('מה הברוטו?'));
check('buildQuestionPrompt: כולל את שדות התלוש', qPrompt.includes('שכר ברוטו: 12,500'));
check('buildQuestionPrompt: בלי פרטים מזהים', !qPrompt.includes('123456789'));
check('buildQuestionPrompt: בלי היסטוריה — אין סעיף שאלות קודמות',
  !buildQuestionPrompt({ question: 'מה?', fields, strippedText: clean, month: '2026-06' }).includes('שאלות קודמות'));

/* ---------- ניקוי LaTeX ---------- */
check('stripLatexPlain: \\text מוסר',
  stripLatexPlain('\\text{ברוטו} = 12500') === 'ברוטו = 12500', stripLatexPlain('\\text{ברוטו} = 12500'));
check('stripLatexPlain: \\mathbf מוסר', stripLatexPlain('\\mathbf{נטו}') === 'נטו');
check('stripLatexPlain: $...$ מוסר', stripLatexPlain('הסכום $12,500$ ש"ח') === 'הסכום 12,500 ש"ח');
check('stripLatexPlain: \\times → ×', stripLatexPlain('20000 \\times 6\\%') === '20000 × 6%');
check('stripLatexPlain: \\frac הופך לחילוק קריא',
  stripLatexPlain('\\frac{1200}{20000}') === '(1200 ÷ 20000)', stripLatexPlain('\\frac{1200}{20000}'));
check('stripLatexPlain: \\approx → ≈', stripLatexPlain('a \\approx b') === 'a ≈ b');
// פקודות מקוננות — מה שהופיע בפועל בפלט של Gemini
check('stripLatexPlain: פקודות מקוננות מוסרות במלואן',
  stripLatexPlain('\\mathbf{23,356.43 \\text{ש"ח}}') === '23,356.43 ש"ח',
  JSON.stringify(stripLatexPlain('\\mathbf{23,356.43 \\text{ש"ח}}')));
check('stripLatexPlain: בלוק $$ שלם עם קינון',
  stripLatexPlain('$$\\text{ברוטו (22,365.76)} - \\text{ניכויים (5,566.76)} = \\mathbf{16,799.00 \\text{ש"ח}}$$')
    === 'ברוטו (22,365.76) - ניכויים (5,566.76) = 16,799.00 ש"ח',
  JSON.stringify(stripLatexPlain('$$\\text{ברוטו (22,365.76)} - \\text{ניכויים (5,566.76)} = \\mathbf{16,799.00 \\text{ש"ח}}$$')));
check('stripLatexPlain: לא נשאר אף תו LaTeX',
  !/\\(?:text|mathbf|frac)|[{}]/.test(stripLatexPlain('$$\\frac{\\text{א}}{\\mathbf{ב}}$$')));
// תשובת מודל שנקטעה באמצע token — הפקודה נשארת בלי סוגר
check('stripLatexPlain: פקודה קטועה (בלי סוגר) מנוקה',
  stripLatexPlain('הסכום = \\mathbf{3') === 'הסכום = 3', JSON.stringify(stripLatexPlain('הסכום = \\mathbf{3')));
check('stripLatexPlain: טקסט רגיל לא נפגע',
  stripLatexPlain('ברוטו 22,365.76 − ניכויים 5,566.76 = 16,799.00 ש"ח')
    === 'ברוטו 22,365.76 − ניכויים 5,566.76 = 16,799.00 ש"ח');

/* ---------- הודעת שגיאת מכסה (429) ---------- */
// גוף שגיאה אמיתי מ-Google כשלמפתח אין מכסה חינמית ל-Pro (לא זמני!)
const zeroQuotaBody = 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro';
check('quotaErrorMessage: מכסה 0 → הודעה ייעודית (לא "נסה שוב")',
  quotaErrorMessage(zeroQuotaBody, 'gemini-pro-latest').includes('לא זמין') &&
  !quotaErrorMessage(zeroQuotaBody, 'gemini-pro-latest').includes('נסה שוב'));
check('quotaErrorMessage: מציין את שם המודל שנכשל',
  quotaErrorMessage(zeroQuotaBody, 'gemini-pro-latest').includes('gemini-pro-latest'));
// מכסה רגילה שחלפה (RPM/RPD) — לא limit:0 — נשארת ההודעה הזמנית
const rateLimitBody = 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 15, model: gemini-flash-latest. Please retry in 12s.';
check('quotaErrorMessage: מכסה זמנית (limit>0) → הודעת "נסה שוב"',
  quotaErrorMessage(rateLimitBody, 'gemini-flash-latest').includes('נסה שוב'));

/* ---------- פיצול הודעות טלגרם ---------- */
const long = Array.from({ length: 400 }, (_, i) => `שורה מספר ${i} עם קצת טקסט נוסף`).join('\n\n');
const chunks = splitMessage(long);
check('splitMessage: כל צ׳אנק מתחת למגבלת טלגרם', chunks.every((c) => c.length <= 4096), `n=${chunks.length}`);
check('splitMessage: לא אבד תוכן', chunks.join('').replace(/\s/g, '') === long.replace(/\s/g, ''));
check('splitMessage: טקסט קצר נשאר הודעה אחת', splitMessage('שלום').length === 1);

/* ---------- API ---------- */
async function upload(buf, filename, month = null) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/pdf' }), filename);
  if (month) fd.append('month', month);
  const res = await fetch(`${BASE}/api/payslip/upload`, { method: 'POST', body: fd, headers: HDRS });
  return { status: res.status, body: await res.json() };
}

const up = await upload(fixture, 'payslip.pdf');
check('API upload: 200 והחודש זוהה', up.status === 200 && up.body.month === '2026-06', `${up.status} ${up.body.month ?? up.body.error}`);
check('API upload: שדות נשמרו', up.body.fields?.gross === 12500);
check('API upload: העלאה ראשונה אינה החלפה', up.body.replaced === false);
check('API upload: דיווח על הסרת פרטים מזהים', up.body.piiRemoved >= 4, String(up.body.piiRemoved));

const up2 = await upload(fixture, 'payslip-v2.pdf');
check('API upload: העלאה חוזרת לאותו חודש מסומנת כהחלפה', up2.body.replaced === true);

const list = await (await fetch(`${BASE}/api/payslip`, { headers: HDRS })).json();
check('API list: שורה אחת לחודש (בלי כפילות)', list.filter((p) => p.month === '2026-06').length === 1, `n=${list.length}`);
check('API list: לא מחזיר את ה-BLOB ואת הטקסט',
  list[0] && !('pdf' in list[0]) && !('extracted_text' in list[0]), Object.keys(list[0] ?? {}).join(','));
check('API list: שם הקובץ עודכן בהחלפה', list.find((p) => p.month === '2026-06')?.filename === 'payslip-v2.pdf');

const detail = await (await fetch(`${BASE}/api/payslip/2026-06`, { headers: HDRS })).json();
check('API detail: כולל פרומפט מוכן להעתקה', typeof detail.prompt === 'string' && detail.prompt.includes('## סיכום'));
check('API detail: הפרומפט נקי מפרטים מזהים', !detail.prompt.includes('123456789'));
check('API detail: אין ניתוח לפני הרצה', detail.analysis_md === null);

const pdfRes = await fetch(`${BASE}/api/payslip/2026-06/pdf`, { headers: HDRS });
const pdfBytes = Buffer.from(await pdfRes.arrayBuffer());
check('API pdf: content-type נכון', pdfRes.headers.get('content-type')?.includes('application/pdf'));
check('API pdf: הקובץ חוזר זהה לבייט', pdfBytes.length === fixture.length && pdfBytes.equals(fixture), `${pdfBytes.length}/${fixture.length}`);

const noKey = await fetch(`${BASE}/api/payslip/2026-06/analyze`, { method: 'POST', headers: HDRS });
const noKeyBody = await noKey.json();
check('API analyze: בלי מפתח Gemini → 400 עם הודעה בעברית',
  noKey.status === 400 && noKeyBody.noKey === true && /מפתח/.test(noKeyBody.error), `${noKey.status} ${noKeyBody.error}`);

// שאלות המשך — אותה הגנת "אין מפתח", וולידציה על גוף הבקשה
const askJson = { 'Content-Type': 'application/json', ...HDRS };
const askNoKey = await fetch(`${BASE}/api/payslip/2026-06/ask`, {
  method: 'POST', headers: askJson, body: JSON.stringify({ question: 'מגיע לי החזר מס?' }),
});
const askNoKeyBody = await askNoKey.json();
check('API ask: בלי מפתח Gemini → 400 עם הודעה בעברית',
  askNoKey.status === 400 && askNoKeyBody.noKey === true, `${askNoKey.status} ${askNoKeyBody.error}`);

const askEmpty = await fetch(`${BASE}/api/payslip/2026-06/ask`, {
  method: 'POST', headers: askJson, body: JSON.stringify({ question: '   ' }),
});
check('API ask: שאלה ריקה → 400', askEmpty.status === 400, String(askEmpty.status));

const askLong = await fetch(`${BASE}/api/payslip/2026-06/ask`, {
  method: 'POST', headers: askJson, body: JSON.stringify({ question: 'א'.repeat(1001) }),
});
check('API ask: שאלה ארוכה מדי → 400', askLong.status === 400, String(askLong.status));

const askBadMonth = await fetch(`${BASE}/api/payslip/2026-13/ask`, {
  method: 'POST', headers: askJson, body: JSON.stringify({ question: 'בדיקה' }),
});
check('API ask: חודש לא תקין → 400', askBadMonth.status === 400, String(askBadMonth.status));

const detailQa = await (await fetch(`${BASE}/api/payslip/2026-06`, { headers: HDRS })).json();
check('API detail: qa מוחזר כמערך ריק בהתחלה', Array.isArray(detailQa.qa) && detailQa.qa.length === 0);

const clearQa = await fetch(`${BASE}/api/payslip/2026-06/qa`, { method: 'DELETE', headers: HDRS });
check('API qa: ניקוי היסטוריה → 200', clearQa.status === 200, String(clearQa.status));
const clearMissing = await fetch(`${BASE}/api/payslip/2019-01/qa`, { method: 'DELETE', headers: HDRS });
check('API qa: ניקוי לחודש בלי תלוש → 404', clearMissing.status === 404, String(clearMissing.status));

const badMonth = await fetch(`${BASE}/api/payslip/2026-13`, { headers: HDRS });
check('API: חודש לא תקין (2026-13) → 400', badMonth.status === 400, String(badMonth.status));
const badMonth2 = await fetch(`${BASE}/api/payslip/abc`, { headers: HDRS });
check('API: חודש לא תקין (abc) → 400', badMonth2.status === 400, String(badMonth2.status));
const missing = await fetch(`${BASE}/api/payslip/2019-01`, { headers: HDRS });
check('API: חודש בלי תלוש → 404', missing.status === 404, String(missing.status));

const notPdf = await upload(Buffer.from('MZ fake exe'), 'evil.exe');
check('API upload: קובץ שאינו PDF נדחה (400)', notPdf.status === 400, `${notPdf.status} ${notPdf.body.error}`);
const brokenPdf = await upload(Buffer.from('not really a pdf'), 'broken.pdf');
check('API upload: PDF פגום → 422 עם הודעה ברורה', brokenPdf.status === 422, `${brokenPdf.status} ${brokenPdf.body.error}`);

const overrideUp = await upload(fixture, 'payslip.pdf', '2026-07');
check('API upload: month override גובר על הזיהוי האוטומטי', overrideUp.body.month === '2026-07', overrideUp.body.month);
const badOverride = await upload(fixture, 'payslip.pdf', '2026-99');
check('API upload: month override לא תקין → 400', badOverride.status === 400, String(badOverride.status));

// החודש הקודם (2026-06) קיים ← בדיקת ההשוואה בין חודשים רצה בפועל
check('API upload: בדיקות מול החודש הקודם מופעלות אוטומטית',
  Array.isArray(overrideUp.body.checks) && overrideUp.body.checks.length > 0);

for (const m of ['2026-06', '2026-07']) {
  const del = await fetch(`${BASE}/api/payslip/${m}`, { method: 'DELETE', headers: HDRS });
  check(`API delete: ${m} נמחק`, del.status === 200, String(del.status));
}
const delAgain = await fetch(`${BASE}/api/payslip/2026-06`, { method: 'DELETE', headers: HDRS });
check('API delete: מחיקה חוזרת → 404', delAgain.status === 404, String(delAgain.status));

console.log(`\n========== payslip: ${pass}/${pass + fail} ==========`);
process.exitCode = fail === 0 ? 0 : 1;
