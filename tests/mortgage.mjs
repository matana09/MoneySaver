// בדיקות: משכנתא — server/lib/mortgage.js + /api/mortgage.
// אף בדיקה לא קוראת ל-Gemini האמיתי (אין מפתח ב-DB של הבדיקות) — הכיסוי של
// analyze/ask הוא על הוולידציה ועל מסלול "אין מפתח".
// ה-fixture של התלוש ממוחזר כאן רק כדי לבדוק את צנרת העלאת ה-PDF.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  normalizeMortgageData, normalizeTracks, stripMortgagePii, runMortgageChecks,
  buildMortgageAnalysisPrompt, buildMortgageQuestionPrompt,
  dataSummary, tracksSummary, TRACK_TYPE_HE, MAX_TRACKS,
} from '../server/lib/mortgage.js';
import {
  parseAnnualStatements, normalizeHistory, historyDerived, historySummary,
  fillFromTotal, firstNumber,
} from '../server/lib/mortgageHistory.js';
import {
  parseCsv, parseBoiRate, parseMortgageAverages, isStalePeriod,
  marketRatesSummary, effectivePrime, PRIME_SPREAD,
  parseCbsIndex, indexValueAt, latestIndex, estimatePropertyValue,
} from '../server/lib/marketRates.js';
import {
  annuityPayment, monthsToPayoff, monthlyCpi, trackPayment,
  simulatableTracks, simulatePlan, buildSimulation, monthsHe, endMonth,
  applyLumpSum, repriceForShock,
} from '../server/lib/mortgageSim.js';
import { splitPages, isBoilerplatePage, stripBoilerplate } from '../server/lib/docTrim.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.MS_BASE;
const HDRS = { Connection: 'close' };
const JSON_HDRS = { 'Content-Type': 'application/json', ...HDRS };

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
  cond ? pass++ : fail++;
};
const byId = (checks, id) => checks.find((c) => c.id === id);

console.log('========== משכנתא ==========\n');

/* ---------- נרמול הפרטים הכלליים ---------- */
const rawData = {
  balance_total: '1,250,000', property_value: 2100000, remaining_months: '204',
  monthly_payment: '7,850.50', net_income: 24000, other_obligations: 1200,
  extra_monthly: 1500, lump_sum: 100000, prime_rate: 6.0,
  origination_date: '2019-03', borrower_ages: '38 ו-36', risk_level: 'med',
  expected_changes: 'העלאת שכר צפויה בשנה הבאה',
  hacker: 'DROP TABLE', id: 99,                       // מפתחות זרים
};
const data = normalizeMortgageData(rawData);
check('normalizeMortgageData: פסיקי אלפים מתפרשים', data.balance_total === 1250000, String(data.balance_total));
check('normalizeMortgageData: סכום עשרוני נשמר', data.monthly_payment === 7850.5, String(data.monthly_payment));
check('normalizeMortgageData: מפתחות זרים נזרקים',
  !('hacker' in data) && !('id' in data), Object.keys(data).join(','));
check('normalizeMortgageData: רמת סיכון תקפה נשמרת', data.risk_level === 'med');
check('normalizeMortgageData: רמת סיכון לא תקפה נזרקת',
  normalizeMortgageData({ risk_level: 'insane' }).risk_level === undefined);
check('normalizeMortgageData: NaN נזרק',
  normalizeMortgageData({ net_income: 'לא מספר' }).net_income === undefined);
check('normalizeMortgageData: מספר שלילי נזרק',
  normalizeMortgageData({ balance_total: -500 }).balance_total === undefined);
check('normalizeMortgageData: שדה ריק לא נשמר (חסר ≠ אפס)',
  normalizeMortgageData({ lump_sum: '' }).lump_sum === undefined);
check('normalizeMortgageData: 0 מפורש כן נשמר',
  normalizeMortgageData({ other_obligations: 0 }).other_obligations === 0);
check('normalizeMortgageData: קלט לא-אובייקט → אובייקט ריק',
  Object.keys(normalizeMortgageData(null)).length === 0);
check('normalizeMortgageData: טקסט חופשי נחתך ל-2000 תווים',
  normalizeMortgageData({ notes: 'א'.repeat(5000) }).notes.length === 2000);

/* ---------- נרמול המסלולים ---------- */
const rawTracks = [
  { name: 'מסלול 1 — פריים', type: 'prime', balance: 500000, rate: 5.5, prime_margin: '-0.5', remaining_months: 204, monthly_payment: 3400 },
  { name: 'מסלול 2 — קבועה לא צמודה', type: 'fixed_unlinked', balance: 450000, rate: 4.2, remaining_months: 204, monthly_payment: 2900, prepay_fee: 8000 },
  { name: 'מסלול 3 — קבועה צמודה', type: 'fixed_linked', balance: 300000, rate: 3.1, remaining_months: 204, monthly_payment: 1550 },
];
const tracks = normalizeTracks(rawTracks);
check('normalizeTracks: שלושה מסלולים', tracks.length === 3, String(tracks.length));
check('normalizeTracks: מרווח פריים שלילי נשמר (P-0.5%)', tracks[0].prime_margin === -0.5, String(tracks[0].prime_margin));
check('normalizeTracks: מסלול צמוד מסומן אוטומטית', tracks[2].cpi_linked === 1);
check('normalizeTracks: מסלול לא צמוד לא מסומן', tracks[1].cpi_linked === 0);
check('normalizeTracks: סוג לא מוכר → other', normalizeTracks([{ type: 'bitcoin' }])[0].type === 'other');
check('normalizeTracks: מסלול בלי שם מקבל שם ברירת מחדל',
  normalizeTracks([{ balance: 1000 }])[0].name === 'מסלול 1');
check(`normalizeTracks: לא יותר מ-${MAX_TRACKS} מסלולים`,
  normalizeTracks(Array.from({ length: 40 }, () => ({ balance: 1000 }))).length === MAX_TRACKS);
check('normalizeTracks: קלט שאינו מערך → מערך ריק', normalizeTracks('חחח').length === 0);
check('normalizeTracks: כל סוגי המסלולים ממופים לעברית',
  Object.values(TRACK_TYPE_HE).every((he) => typeof he === 'string' && he.length > 1));

/* ---------- הסרת פרטים מזהים ---------- */
const docText = [
  'דוח יתרות משכנתא — בנק לאומי',
  '10-1234567-01-73',                     // מספר חשבון בפורמט לאומי, בשורה נפרדת
  'שם הלווה: ישראל ישראלי',
  'ת.ז. 123456789',
  'מספר הלוואה 1122334455',
  'גוש 1234 חלקה 145 תת חלקה 12',
  'רחוב הרצל 15, תל אביב',
  'טלפון 054-7654321',
  'יתרת קרן 1,250,000.00',
  'החזר חודשי 7,850.50',
].join('\n');
const { text: clean, removed } = stripMortgagePii(docText);
check('stripMortgagePii: ת"ז הוסרה', !clean.includes('123456789'), clean.split('\n')[2]);
check('stripMortgagePii: מספר הלוואה הוסר', !clean.includes('1122334455'));
// דוחות לאומי מדפיסים את מספר החשבון בשורה נפרדת בלי מילת הקשר
check('stripMortgagePii: מספר חשבון בפורמט בנקאי הוסר גם בשורה בלי הקשר',
  !clean.includes('1234567') && clean.includes('[מספר חשבון הוסר]'));
check('stripMortgagePii: תאריך ISO לא נפגע', stripMortgagePii('נכון לתאריך 2026-07-30').text.includes('2026-07-30'));
check('stripMortgagePii: טווח שעות לא נפגע', stripMortgagePii('שעות פעילות 08:30-16:00').text.includes('08:30-16:00'));
check('stripMortgagePii: גוש/חלקה — השורה הוסרה',
  !clean.includes('1234') && clean.includes('[פרטי הנכס הוסרו]'));
check('stripMortgagePii: שם הלווה הוסר', !clean.includes('ישראל ישראלי'));
check('stripMortgagePii: כתובת הוסרה (דרך stripPii של התלוש)', !clean.includes('הרצל'));
// stripPii של התלוש מכסה "רחוב/רח'" בלבד; שדרות/שדרת/שד' נוספו כאן
check('stripMortgagePii: כתובת מסוג "שדרות" הוסרה',
  !stripMortgagePii('שדרות ירושלים 45, נתניה').text.includes('ירושלים'));
check('stripMortgagePii: כתובת מסוג "שדרת" הוסרה',
  !stripMortgagePii('11/21 שדרת האגמים').text.includes('האגמים'));
check('stripMortgagePii: טלפון הוסר', !clean.includes('7654321'));
check('stripMortgagePii: סכומים לא נפגעו',
  clean.includes('1,250,000.00') && clean.includes('7,850.50'));
check('stripMortgagePii: מדווח כמה פרטים הוסרו', removed >= 5, `removed=${removed}`);
check('stripMortgagePii: טקסט נקי לא משתנה', stripMortgagePii('יתרת קרן 1,250,000.00').removed === 0);

/* ---------- בדיקות מקומיות ---------- */
const checks = runMortgageChecks(data, tracks);

// אובייקט ריק → רק בדיקות "חסר נתון", בלי ממצא מומצא על נתונים שלא קיימים
check('runMortgageChecks: אובייקט ריק → אין בדיקות שווא',
  runMortgageChecks({}, []).every((c) => ['no_tracks', 'no_prime_rate', 'no_property_value'].includes(c.id)),
  runMortgageChecks({}, []).map((c) => c.id).join(','));

// יחס החזר להכנסה: (7850.5 + 1200) / 24000 = 37.7% → warn
check('runMortgageChecks: dti בטווח 30-40 → warn',
  byId(checks, 'dti')?.status === 'warn', byId(checks, 'dti')?.detail);
check('runMortgageChecks: dti מתחת ל-30 → ok',
  byId(runMortgageChecks({ monthly_payment: 5000, net_income: 24000 }, []), 'dti')?.status === 'ok');
check('runMortgageChecks: dti מעל 40 → fail',
  byId(runMortgageChecks({ monthly_payment: 12000, net_income: 24000 }, []), 'dti')?.status === 'fail');
check('runMortgageChecks: dti לא מחושב בלי הכנסה',
  byId(runMortgageChecks({ monthly_payment: 5000 }, []), 'dti') === undefined);

// יתרות: 500000+450000+300000 = 1,250,000 = היתרה שהוצהרה
check('runMortgageChecks: סכום יתרות תואם → ok',
  byId(checks, 'tracks_balance_sum')?.status === 'ok', byId(checks, 'tracks_balance_sum')?.detail);
const mismatched = runMortgageChecks({ balance_total: 1000000 }, tracks);
check('runMortgageChecks: פער יתרות גדול → fail',
  byId(mismatched, 'tracks_balance_sum')?.status === 'fail', byId(mismatched, 'tracks_balance_sum')?.detail);

// החזרים: 3400+2900+1550 = 7850 מול 7850.5 → פער זניח
check('runMortgageChecks: סכום החזרים תואם → ok',
  byId(checks, 'tracks_payment_sum')?.status === 'ok', byId(checks, 'tracks_payment_sum')?.detail);

// LTV: 1,250,000 / 2,100,000 = 59.5% → ok
check('runMortgageChecks: LTV מתחת ל-60 → ok',
  byId(checks, 'ltv')?.status === 'ok', byId(checks, 'ltv')?.detail);
check('runMortgageChecks: LTV מעל 75 → fail',
  byId(runMortgageChecks({ balance_total: 800000, property_value: 1000000 }, []), 'ltv')?.status === 'fail');

// תמהיל: פריים 40% → ok, קבועה 60% → ok, צמוד 24% → ok
check('runMortgageChecks: חלק פריים סביר → ok', byId(checks, 'prime_share')?.status === 'ok', byId(checks, 'prime_share')?.detail);
check('runMortgageChecks: חלק קבועה מעל שליש → ok', byId(checks, 'fixed_share')?.status === 'ok', byId(checks, 'fixed_share')?.detail);
check('runMortgageChecks: מגבלת בנק ישראל מוזכרת בפירוט',
  /שני שליש/.test(byId(checks, 'prime_share')?.detail ?? '') &&
  /שליש/.test(byId(checks, 'fixed_share')?.detail ?? ''));

const primeHeavy = normalizeTracks([
  { name: 'פריים', type: 'prime', balance: 900000 },
  { name: 'קבועה', type: 'fixed_unlinked', balance: 100000 },
]);
const heavyChecks = runMortgageChecks({ balance_total: 1000000 }, primeHeavy);
check('runMortgageChecks: פריים מעל שני שלישים → warn',
  byId(heavyChecks, 'prime_share')?.status === 'warn', byId(heavyChecks, 'prime_share')?.detail);
check('runMortgageChecks: קבועה מתחת לשליש → warn',
  byId(heavyChecks, 'fixed_share')?.status === 'warn', byId(heavyChecks, 'fixed_share')?.detail);

const linkedHeavy = normalizeTracks([
  { name: 'צמודה', type: 'fixed_linked', balance: 800000 },
  { name: 'פריים', type: 'prime', balance: 200000 },
]);
check('runMortgageChecks: חשיפה גבוהה למדד → warn',
  byId(runMortgageChecks({ balance_total: 1000000 }, linkedHeavy), 'cpi_share')?.status === 'warn');

check('runMortgageChecks: מסלול עם נתונים חסרים מסומן',
  byId(runMortgageChecks({}, normalizeTracks([{ name: 'חסר', type: 'prime' }])), 'track_missing_data')?.status === 'warn');
check('runMortgageChecks: מסלולים מלאים → אין אזהרת נתונים חסרים',
  byId(checks, 'track_missing_data') === undefined);
check('runMortgageChecks: ריבית פריים הוזנה → אין אזהרה',
  byId(checks, 'no_prime_rate') === undefined);
check('runMortgageChecks: בלי ריבית פריים → warn',
  byId(runMortgageChecks({}, []), 'no_prime_rate')?.status === 'warn');
check('runMortgageChecks: כל בדיקה בפורמט התקני',
  checks.every((c) => c.id && c.label && ['ok', 'warn', 'fail'].includes(c.status) && c.detail));

/* ---------- נתוני שוק מבנק ישראל (פונקציות טהורות; בלי רשת) ---------- */
// fixture מקוצר מהפלט האמיתי של מאגר הסדרות. עמודת DATA_SOURCE מכילה פסיק
// בתוך גרשיים — בדיוק המקרה ששובר פרסור CSV נאיבי.
const NOW = new Date('2026-07-30T12:00:00');
const BOI_CSV = [
  'SERIES_CODE,FREQ,BIR_COVERAGE,INDEXATION_TYPE,IR_FV_TYPE,DATA_TYPE,BS_ITEM,LTV,PTI,UNIT_MEASURE,DATA_SOURCE,TIME_PERIOD,OBS_VALUE',
  'S1,M,N,NI,F,R,A2C,L0,P01,PT,"D877-16240,D877-1003175",2026-02,4.74',
  'S2,M,N,CPI,F,R,A2C,L0,P01,PT,D877-14976,2026-02,3.25',
  'S3,M,N,CPI,A,R,A2C,L0,P01,PT,D877-14983,2026-02,3.26',
  'S4,M,N,NI,A,R,A2C,L0,P01,PT,D877-16247,2024-01,5.12',       // סדרה שהופסקה
  'S5,M,N,CPI,V,RM,A2C,L0,P01,PT,D877-14981,2026-02,1.45',
  'S6,M,N,NI,F,R,A2B2,L0,P01,PT,D877-14657,2026-02,6.65',      // הלוואה לכל מטרה — חייב להיסנן
  'S7,M,N,NI,F,B,A2C,L0,P01,ILS,D877-15794,2026-02,1312481.71', // יתרה בשקלים — חייב להיסנן
].join('\n');

const csvRows = parseCsv(BOI_CSV);
check('parseCsv: כל השורות נקראו', csvRows.length === 7, String(csvRows.length));
check('parseCsv: שדה בגרשיים עם פסיק לא שובר את העמודות',
  csvRows[0].DATA_SOURCE === 'D877-16240,D877-1003175' && csvRows[0].OBS_VALUE === '4.74',
  `${csvRows[0].DATA_SOURCE} / ${csvRows[0].OBS_VALUE}`);
check('parseCsv: קלט ריק → מערך ריק', parseCsv('').length === 0);

const boi = parseBoiRate({ currentInterest: 3.5, lastPublishedDate: '2026-07-12T08:59:20Z', nextInterestDate: '2026-09-01T00:00:00Z' });
check('parseBoiRate: ריבית בנק ישראל', boi.rate === 3.5, String(boi.rate));
check(`parseBoiRate: פריים = ריבית + ${PRIME_SPREAD}`, boi.prime === 5, String(boi.prime));
check('parseBoiRate: מועד ההחלטה הבאה נשמר', boi.next_decision === '2026-09-01T00:00:00Z');
check('parseBoiRate: תשובה לא תקינה → null', parseBoiRate({ foo: 1 }) === null);

const averages = parseMortgageAverages(BOI_CSV, NOW);
const avgBy = (k) => averages.find((a) => a.key === k);
check('parseMortgageAverages: קל"צ', avgBy('fixed_unlinked')?.value === 4.74, String(avgBy('fixed_unlinked')?.value));
check('parseMortgageAverages: ק"צ', avgBy('fixed_linked')?.value === 3.25);
check('parseMortgageAverages: מרווח במשתנה צמודה', avgBy('var_linked_margin')?.value === 1.45);
check('parseMortgageAverages: תקופת הדיווח נשמרת', avgBy('fixed_unlinked')?.period === '2026-02');
check('parseMortgageAverages: הלוואה לכל מטרה (A2B2) מסוננת',
  !averages.some((a) => a.value === 6.65), JSON.stringify(averages.map((a) => a.value)));
check('parseMortgageAverages: יתרה בשקלים מסוננת', !averages.some((a) => a.value > 1000));
check('parseMortgageAverages: סדרה מ-2024 מסומנת כמיושנת', avgBy('unlinked_all')?.stale === true);
check('parseMortgageAverages: סדרה עדכנית לא מסומנת', avgBy('fixed_unlinked')?.stale === false);
check('parseMortgageAverages: CSV ריק → מערך ריק', parseMortgageAverages('').length === 0);

check('isStalePeriod: לפני שנתיים → מיושן', isStalePeriod('2024-01', NOW) === true);
check('isStalePeriod: לפני חמישה חודשים → תקין', isStalePeriod('2026-02', NOW) === false);
check('isStalePeriod: תקופה לא תקינה → false', isStalePeriod('לא תאריך', NOW) === false);

/* ---------- מדד מחירי הדירות (למ"ס) ---------- */
// מבנה התשובה האמיתי של api.cbs.gov.il — הסדרות מגיעות בסדר יורד
const CBS_JSON = {
  month: [{
    code: 60300,
    name: 'מרכז',
    date: [
      { year: 2026, month: 4, currBase: { baseDesc: '2017 אוקטובר', value: 589.9 } },
      { year: 2026, month: 3, currBase: { baseDesc: '2017 אוקטובר', value: 589.9 } },
      { year: 2026, month: 2, currBase: { baseDesc: '2017 אוקטובר', value: 590.5 } },
      { year: 2019, month: 3, currBase: { baseDesc: '2017 אוקטובר', value: 310.0 } },
    ],
  }],
};
const cbs = parseCbsIndex(CBS_JSON);
check('parseCbsIndex: כל הנקודות נקראו', cbs.points.length === 4, String(cbs.points.length));
check('parseCbsIndex: מסודר בסדר עולה',
  cbs.points[0].period === '2019-03' && cbs.points[3].period === '2026-04',
  cbs.points.map((p) => p.period).join(','));
check('parseCbsIndex: תיאור הבסיס נשמר', cbs.base === '2017 אוקטובר');
check('parseCbsIndex: תשובה לא תקינה → null', parseCbsIndex({ foo: 1 }) === null);

check('latestIndex: הנקודה האחרונה', latestIndex(cbs).period === '2026-04' && latestIndex(cbs).value === 589.9);
check('indexValueAt: התאמה מדויקת', indexValueAt(cbs, '2019-03')?.value === 310);
check('indexValueAt: חודש בלי נקודה → הנקודה האחרונה שלפניו',
  indexValueAt(cbs, '2025-12')?.period === '2019-03', indexValueAt(cbs, '2025-12')?.period);
check('indexValueAt: חודש לפני תחילת הסדרה → null', indexValueAt(cbs, '2010-01') === null);

const housingMarket = { housing: { center: { label: 'מחוז המרכז', ...cbs } } };
const est = estimatePropertyValue(
  { property_value_base: 1200000, property_value_base_month: '2019-03', property_region: 'center' },
  housingMarket,
);
// 1,200,000 × (589.9 / 310) = 2,283,483 → מעוגל לאלף
check('estimatePropertyValue: הצמדה למדד', est.value === 2283000, String(est.value));
check('estimatePropertyValue: מקור = index', est.source === 'index');
check('estimatePropertyValue: ההסבר כולל את שיעור השינוי ואת המחוז',
  /%/.test(est.detail) && est.detail.includes('מחוז המרכז'), est.detail);
check('estimatePropertyValue: הזנה ידנית גוברת',
  estimatePropertyValue({ property_value: 3000000, property_value_base: 1200000, property_value_base_month: '2019-03' }, housingMarket).value === 3000000);
check('estimatePropertyValue: בלי עוגן → null',
  estimatePropertyValue({}, housingMarket).value === null);
check('estimatePropertyValue: בלי מדד — העוגן מוחזר בלי הצמדה',
  estimatePropertyValue({ property_value_base: 1200000, property_value_base_month: '2019-03' }, null).value === 1200000);
check('estimatePropertyValue: מחוז לא מוכר → נופל לארצי',
  estimatePropertyValue({ property_value_base: 100, property_value_base_month: '2019-03', property_region: 'mars' },
    { housing: { national: { label: 'ארצי', ...cbs } } }).source === 'index');

check('normalizeMortgageData: שדות שווי הנכס נשמרים',
  normalizeMortgageData({ property_value_base: '1,200,000', property_value_base_month: '2019-03', property_region: 'center' })
    .property_value_base === 1200000);
check('normalizeMortgageData: מחוז לא תקין נזרק',
  normalizeMortgageData({ property_region: 'atlantis' }).property_region === undefined);

const ltvChecks = runMortgageChecks(
  { balance_total: 800000, property_value_base: 1200000, property_value_base_month: '2019-03', property_region: 'center' },
  [], housingMarket,
);
check('runMortgageChecks: LTV מחושב מהשווי המוצמד',
  byId(ltvChecks, 'ltv')?.status === 'ok' && /35\.0%/.test(byId(ltvChecks, 'ltv')?.detail ?? ''),
  byId(ltvChecks, 'ltv')?.detail);
check('runMortgageChecks: בדיקת שווי הנכס מסבירה את מקור ההערכה',
  byId(ltvChecks, 'property_value')?.detail.includes('מדד מחירי הדירות'));
check('runMortgageChecks: בלי שווי נכס → warn',
  byId(runMortgageChecks({ balance_total: 800000 }, [], null), 'no_property_value')?.status === 'warn');

const market = { boi, averages, housing: housingMarket.housing, errors: [], fetched_at: NOW.toISOString() };
const mSummary = marketRatesSummary(market);
check('marketRatesSummary: ריבית הפריים מודגשת', mSummary.includes('ריבית הפריים: 5.00%'));
check('marketRatesSummary: ריבית בנק ישראל', mSummary.includes('3.50%'));
check('marketRatesSummary: הריביות הממוצעות נכללות', mSummary.includes('4.74%') && mSummary.includes('3.25%'));
check('marketRatesSummary: תקופת דיווח מוצגת', mSummary.includes('2026-02'));
check('marketRatesSummary: סדרה מיושנת מסומנת במפורש למודל', mSummary.includes('נתון מיושן'));
check('marketRatesSummary: בלי נתונים → מחרוזת ריקה', marketRatesSummary(null) === '');

check('effectivePrime: הזנה ידנית גוברת על בנק ישראל',
  effectivePrime({ prime_rate: 6.25 }, market).value === 6.25);
check('effectivePrime: בלי הזנה ידנית — הנתון מבנק ישראל',
  effectivePrime({}, market).value === 5 && effectivePrime({}, market).source === 'boi');
check('effectivePrime: בלי כלום → null', effectivePrime({}, null).value === null);

// הבדיקות המקומיות עם נתוני שוק
const marketChecks = runMortgageChecks(
  { balance_total: 1000000 },
  normalizeTracks([
    { name: 'קל"צ יקר', type: 'fixed_unlinked', balance: 500000, rate: 5.9 },
    { name: 'ק"צ סביר', type: 'fixed_linked', balance: 500000, rate: 3.3 },
  ]),
  market,
);
check('runMortgageChecks: ריבית פריים אוטומטית → ok',
  byId(marketChecks, 'prime_rate')?.status === 'ok' && /בנק ישראל/.test(byId(marketChecks, 'prime_rate')?.detail ?? ''),
  byId(marketChecks, 'prime_rate')?.detail);
check('runMortgageChecks: מסלול קבוע יקר מהשוק → warn',
  byId(marketChecks, 'track_vs_market_0')?.status === 'warn', byId(marketChecks, 'track_vs_market_0')?.detail);
check('runMortgageChecks: מסלול קבוע בטווח השוק → ok',
  byId(marketChecks, 'track_vs_market_1')?.status === 'ok', byId(marketChecks, 'track_vs_market_1')?.detail);
check('runMortgageChecks: השוואה מציגה את ממוצע השוק ואת תקופת הדיווח',
  /4\.74%/.test(byId(marketChecks, 'track_vs_market_0')?.detail ?? '')
  && /2026-02/.test(byId(marketChecks, 'track_vs_market_0')?.detail ?? ''));
check('runMortgageChecks: מסלול פריים לא מושווה לממוצע בודד',
  !runMortgageChecks({}, normalizeTracks([{ type: 'prime', balance: 1000, rate: 5 }]), market)
    .some((c) => c.id.startsWith('track_vs_market')));
// סדרה מיושנת לא משמשת להשוואה — גם אם היא הסדרה של סוג המסלול
const staleMarket = { boi, averages: [{ key: 'fixed_unlinked', label: 'קל"צ', value: 4.74, period: '2024-01', stale: true }], errors: [] };
check('runMortgageChecks: סדרה מיושנת לא משמשת להשוואה',
  !runMortgageChecks({}, normalizeTracks([{ type: 'fixed_unlinked', balance: 1000, rate: 6 }]), staleMarket)
    .some((c) => c.id.startsWith('track_vs_market')));

const marketPrompt = buildMortgageAnalysisPrompt(data, tracks, checks, [], market);
check('buildMortgageAnalysisPrompt: בלוק נתוני השוק מוזרק', marketPrompt.includes('## נתוני שוק עדכניים'));
check('buildMortgageAnalysisPrompt: הפריים העדכני בפרומפט', marketPrompt.includes('5.00%'));
check('buildMortgageAnalysisPrompt: בלי נתוני שוק — אזהרה מפורשת למודל',
  buildMortgageAnalysisPrompt(data, tracks, checks, [], null).includes('שליפת נתוני השוק מבנק ישראל נכשלה'));
check('buildMortgageQuestionPrompt: נתוני השוק נכללים',
  buildMortgageQuestionPrompt({ question: 'מה כדאי?', data, tracks, market }).includes('נתוני שוק עדכניים'));

/* ---------- סיכומי נתונים ---------- */
const dSum = dataSummary(data);
check('dataSummary: סכומים בפורמט ישראלי עם ₪', dSum.includes('1,250,000') && dSum.includes('₪'));
check('dataSummary: חודשים מוצגים גם בשנים', dSum.includes('204 חודשים') && dSum.includes('17.0 שנים'));
check('dataSummary: רמת סיכון בעברית', dSum.includes('בינונית'));
check('dataSummary: שדות שלא הוזנו מפורטים במפורש', dSum.includes('נתונים שלא הוזנו'));
check('dataSummary: טופס ריק → הודעה מתאימה', dataSummary({}).includes('לא הוזנו פרטים כלליים'));

const tSum = tracksSummary(tracks);
check('tracksSummary: טבלת Markdown תקנית', tSum.startsWith('| מסלול |') && tSum.split('\n').length === 5);
check('tracksSummary: סוג המסלול בעברית', tSum.includes('פריים') && tSum.includes('קבועה צמודה'));
check('tracksSummary: מרווח פריים שלילי מוצג', tSum.includes('-0.5%'));
check('tracksSummary: שדה חסר מוצג כמקף', tSum.includes('—'));
check('tracksSummary: בלי מסלולים → הודעה מתאימה', tracksSummary([]).includes('לא הוזנו מסלולים'));

/* ---------- פרומפט הניתוח ---------- */
const prompt = buildMortgageAnalysisPrompt(data, tracks, checks, [{ kind: 'balance', filename: 'yitrot.pdf', text: clean }]);
const SECTIONS = [
  '## תמונת מצב', '## ניתוח מסלול-מסלול', '## אפשרויות חיסכון', '## פירוט כל אפשרות',
  '## שלוש חלופות', '## תרחישי לחץ', '## פירעון מוקדם', '## הנחות שהנחתי',
  '## דירוג ממצאים', '## מסקנה', '## רשימת פעולות', '## נתונים חסרים',
];
for (const s of SECTIONS) {
  check(`buildMortgageAnalysisPrompt: כולל את הסעיף "${s}"`, prompt.includes(s));
}
check('buildMortgageAnalysisPrompt: איסור LaTeX מפורש', prompt.includes('אסור להשתמש בסימון LaTeX'));
check('buildMortgageAnalysisPrompt: איסור המצאת נתוני שוק', prompt.includes('אל תמציא נתוני שוק'));
check('buildMortgageAnalysisPrompt: מגבלות בנק ישראל על התמהיל',
  prompt.includes('לפחות שליש') && prompt.includes('עד שני שלישים'));
check('buildMortgageAnalysisPrompt: מדרגות LTV', prompt.includes('75%') && prompt.includes('LTV'));
check('buildMortgageAnalysisPrompt: הסבר עמלת היוון', prompt.includes('עמלת היוון'));
check('buildMortgageAnalysisPrompt: מיחזור פנימי מול חיצוני',
  prompt.includes('מיחזור פנימי') && prompt.includes('מיחזור חיצוני'));
check('buildMortgageAnalysisPrompt: תרחישי הלחץ הנדרשים',
  prompt.includes('1%') && prompt.includes('2%') && prompt.includes('4%') && prompt.includes('50,000'));
check('buildMortgageAnalysisPrompt: לשון ניטרלית נדרשת', prompt.includes('לשון ניטרלית'));
check('buildMortgageAnalysisPrompt: הסתייגות מייעוץ מוסמך', prompt.includes('יועץ משכנתאות מורשה'));
check('buildMortgageAnalysisPrompt: נתוני המסלולים בגוף הפרומפט', prompt.includes('| מסלול |'));
check('buildMortgageAnalysisPrompt: תוצאות הבדיקות המקומיות מוזרקות', prompt.includes('יחס ההחזר להכנסה נטו'));
check('buildMortgageAnalysisPrompt: טקסט המסמך מצורף', prompt.includes('## מסמכים שצורפו') && prompt.includes('דוח יתרות'));
check('buildMortgageAnalysisPrompt: הפרומפט נקי מפרטים מזהים',
  !prompt.includes('123456789') && !prompt.includes('ישראל ישראלי') && !prompt.includes('1122334455'));
// גם טקסט חופשי שהמשתמש הקליד עובר ניקוי — לא רק טקסט המסמכים
const piiNotePrompt = buildMortgageAnalysisPrompt(
  { ...data, notes: 'הנכס ברחוב הרצל 15 תל אביב', property_value_source: 'שמאות משדרות רוטשילד 3' },
  tracks, checks, [], market,
);
check('buildMortgageAnalysisPrompt: כתובת בשדה טקסט חופשי של המשתמש מוסרת',
  !piiNotePrompt.includes('הרצל') && !piiNotePrompt.includes('רוטשילד'));
check('buildMortgageAnalysisPrompt: בלי נתונים בכלל עדיין תקין',
  buildMortgageAnalysisPrompt().includes('## תמונת מצב'));

/* ---------- פרומפט שאלת המשך ---------- */
const q1 = buildMortgageQuestionPrompt({ question: 'כמה אחסוך אם אקצר בחמש שנים?', data, tracks });
check('buildMortgageQuestionPrompt: השאלה מופיעה', q1.includes('כמה אחסוך אם אקצר בחמש שנים?'));
check('buildMortgageQuestionPrompt: איסור LaTeX', q1.includes('אסור סימון LaTeX'));
check('buildMortgageQuestionPrompt: איסור המצאת נתוני שוק', q1.includes('אל תמציא נתוני שוק'));
check('buildMortgageQuestionPrompt: בלי היסטוריה — אין סעיף שאלות קודמות', !q1.includes('שאלות קודמות'));
const q2 = buildMortgageQuestionPrompt({
  question: 'ומה לגבי המסלול הצמוד?', data, tracks,
  analysisMd: '## תמונת מצב\nהמשכנתא תקינה', history: [{ q: 'שאלה קודמת', a: 'תשובה קודמת' }],
});
check('buildMortgageQuestionPrompt: היסטוריה נכנסת לפרומפט',
  q2.includes('שאלות קודמות') && q2.includes('תשובה קודמת'));
check('buildMortgageQuestionPrompt: הניתוח הקודם נכנס לפרומפט', q2.includes('המשכנתא תקינה'));

/* ---------- API ---------- */
const get = (p) => fetch(`${BASE}/api/mortgage${p}`, { headers: HDRS });

const empty = await (await get('')).json();
check('API GET: מצב התחלתי ריק', Object.keys(empty.data).length === 0 && empty.tracks.length === 0);
check('API GET: אין ניתוח לפני הרצה', empty.analysis_md === null);
check('API GET: prompt קיים גם בלי נתונים', typeof empty.prompt === 'string' && empty.prompt.includes('## מסקנה'));
check('API GET: docs מוחזר כמערך', Array.isArray(empty.docs));

// נתוני השוק: בבדיקות MONEYSAVER_NO_NET=1 → אין שליפה, והשגיאות מדווחות
// בלי להפיל את הנתיב (ראו tests/run-tests.mjs ו-server/lib/marketRates.js)
const marketRes = await fetch(`${BASE}/api/mortgage/market`, { headers: HDRS });
const marketBody = await marketRes.json();
check('API market: 200 גם כשהשליפה מושבתת', marketRes.status === 200, String(marketRes.status));
check('API market: הכישלון מדווח ב-errors ולא כחריגה',
  marketBody.errors?.length >= 2 && marketBody.fetched_at === null, JSON.stringify(marketBody.errors?.length));
check('API market/refresh: 200', (await fetch(`${BASE}/api/mortgage/market/refresh`, { method: 'POST', headers: HDRS })).status === 200);
check('API GET: הפרומפט מזהיר על היעדר נתוני שוק', empty.prompt.includes('שליפת נתוני השוק'));

const put = await fetch(`${BASE}/api/mortgage`, {
  method: 'PUT', headers: JSON_HDRS, body: JSON.stringify({ data: rawData, tracks: rawTracks }),
});
const putBody = await put.json();
check('API PUT: 200 והנתונים נשמרו', put.status === 200 && putBody.data.balance_total === 1250000, String(put.status));
check('API PUT: מפתחות זרים לא נשמרו', !('hacker' in putBody.data));
check('API PUT: הבדיקות חוזרות מיד', Array.isArray(putBody.checks) && putBody.checks.length > 0);
check('API PUT: updated_at נקבע', typeof putBody.updated_at === 'string' && putBody.updated_at.length >= 10);

const detail = await (await get('')).json();
check('API GET: הנתונים נשמרו בין בקשות', detail.data.monthly_payment === 7850.5);
check('API GET: המסלולים נשמרו', detail.tracks.length === 3 && detail.tracks[0].type === 'prime');
check('API GET: הפרומפט כולל את נתוני המשתמש', detail.prompt.includes('1,250,000'));
check('API GET: qa מוחזר כמערך ריק בהתחלה', Array.isArray(detail.qa) && detail.qa.length === 0);

// שמירה חוזרת לא יוצרת שורה שנייה (singleton) ולא מכפילה מסלולים
await fetch(`${BASE}/api/mortgage`, {
  method: 'PUT', headers: JSON_HDRS, body: JSON.stringify({ data: { net_income: 30000 }, tracks: [] }),
});
const after = await (await get('')).json();
check('API PUT: שמירה חוזרת מחליפה ולא מוסיפה', after.tracks.length === 0 && after.data.net_income === 30000);
check('API PUT: גוף ריק לא מפיל את השרת', (await fetch(`${BASE}/api/mortgage`, { method: 'PUT', headers: JSON_HDRS, body: '{}' })).status === 200);

// החזרת הנתונים המלאים להמשך הבדיקות
await fetch(`${BASE}/api/mortgage`, {
  method: 'PUT', headers: JSON_HDRS, body: JSON.stringify({ data: rawData, tracks: rawTracks }),
});

/* ---------- מסמכים ---------- */
const fixture = readFileSync(path.join(__dirname, 'fixtures', 'payslip-sample.pdf'));
async function uploadDoc(buf, filename, kind = 'balance') {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/pdf' }), filename);
  fd.append('kind', kind);
  const res = await fetch(`${BASE}/api/mortgage/docs`, { method: 'POST', body: fd, headers: HDRS });
  return { status: res.status, body: await res.json() };
}

const doc = await uploadDoc(fixture, 'yitrot.pdf');
check('API docs: העלאת PDF → 200', doc.status === 200, `${doc.status} ${doc.body.error ?? ''}`);
check('API docs: סוג המסמך נשמר', doc.body.kind === 'balance');
check('API docs: דיווח על הסרת פרטים מזהים', doc.body.piiRemoved >= 1, String(doc.body.piiRemoved));
check('API docs: הרשימה חוזרת בתשובה', Array.isArray(doc.body.docs) && doc.body.docs.length === 1);
check('API docs: הרשימה לא מחזירה את ה-BLOB',
  doc.body.docs[0] && !('pdf' in doc.body.docs[0]) && !('extracted_text' in doc.body.docs[0]),
  Object.keys(doc.body.docs[0] ?? {}).join(','));

const docId = doc.body.id;
const pdfRes = await fetch(`${BASE}/api/mortgage/docs/${docId}/pdf`, { headers: HDRS });
const pdfBytes = Buffer.from(await pdfRes.arrayBuffer());
check('API docs pdf: content-type נכון', pdfRes.headers.get('content-type')?.includes('application/pdf'));
check('API docs pdf: הקובץ חוזר זהה לבייט', pdfBytes.equals(fixture), `${pdfBytes.length}/${fixture.length}`);
check('API docs pdf: מזהה לא קיים → 404',
  (await fetch(`${BASE}/api/mortgage/docs/99999/pdf`, { headers: HDRS })).status === 404);
check('API docs pdf: מזהה לא תקין → 400',
  (await fetch(`${BASE}/api/mortgage/docs/abc/pdf`, { headers: HDRS })).status === 400);

const notPdf = await uploadDoc(Buffer.from('MZ fake exe'), 'evil.exe');
check('API docs: קובץ שאינו PDF נדחה (400)', notPdf.status === 400, `${notPdf.status} ${notPdf.body.error}`);
const brokenPdf = await uploadDoc(Buffer.from('not really a pdf'), 'broken.pdf');
check('API docs: PDF פגום → 422 עם הודעה ברורה', brokenPdf.status === 422, `${brokenPdf.status} ${brokenPdf.body.error}`);

// מגבלת 5 מסמכים: כבר יש 1, מוסיפים 4 ואז מנסים חמישי נוסף
for (let i = 0; i < 4; i++) await uploadDoc(fixture, `doc${i}.pdf`, 'schedule');
const overflow = await uploadDoc(fixture, 'too-many.pdf');
check('API docs: מעל 5 מסמכים → 400', overflow.status === 400, `${overflow.status} ${overflow.body.error}`);

const prompt2 = (await (await get('')).json()).prompt;
check('API GET: טקסט המסמכים נכנס לפרומפט', prompt2.includes('## מסמכים שצורפו'));
check('API GET: הפרומפט נקי מפרטים מזהים של המסמך', !prompt2.includes('123456789'));

const delDoc = await fetch(`${BASE}/api/mortgage/docs/${docId}`, { method: 'DELETE', headers: HDRS });
const delBody = await delDoc.json();
check('API docs: מחיקה → 200 והרשימה מתעדכנת', delDoc.status === 200 && delBody.docs.length === 4, String(delDoc.status));
check('API docs: מחיקה חוזרת → 404',
  (await fetch(`${BASE}/api/mortgage/docs/${docId}`, { method: 'DELETE', headers: HDRS })).status === 404);

/* ---------- ניתוח ושאלות (בלי מפתח Gemini) ---------- */
const analyze = await fetch(`${BASE}/api/mortgage/analyze`, { method: 'POST', headers: HDRS });
const analyzeBody = await analyze.json();
check('API analyze: בלי מפתח Gemini → 400 עם הודעה בעברית',
  analyze.status === 400 && analyzeBody.noKey === true && /מפתח/.test(analyzeBody.error),
  `${analyze.status} ${analyzeBody.error}`);

const askNoKey = await fetch(`${BASE}/api/mortgage/ask`, {
  method: 'POST', headers: JSON_HDRS, body: JSON.stringify({ question: 'כמה אחסוך במיחזור?' }),
});
const askNoKeyBody = await askNoKey.json();
check('API ask: בלי מפתח Gemini → 400', askNoKey.status === 400 && askNoKeyBody.noKey === true, String(askNoKey.status));

const askEmpty = await fetch(`${BASE}/api/mortgage/ask`, {
  method: 'POST', headers: JSON_HDRS, body: JSON.stringify({ question: '   ' }),
});
check('API ask: שאלה ריקה → 400 (לפני בדיקת המפתח)', askEmpty.status === 400, String(askEmpty.status));

const askLong = await fetch(`${BASE}/api/mortgage/ask`, {
  method: 'POST', headers: JSON_HDRS, body: JSON.stringify({ question: 'א'.repeat(1001) }),
});
check('API ask: שאלה ארוכה מדי → 400', askLong.status === 400, String(askLong.status));

check('API qa: ניקוי היסטוריה → 200',
  (await fetch(`${BASE}/api/mortgage/qa`, { method: 'DELETE', headers: HDRS })).status === 200);

/* ---------- היסטוריית תשלומים שנתית ---------- */
const annualText = readFileSync(path.join(__dirname, 'fixtures', 'mortgage-annual.txt'), 'utf8');
const parsed = parseAnnualStatements(annualText);

check('parse: נמצאו שלוש השנים', parsed.rows.length === 3, String(parsed.rows.length));
check('parse: אין אזהרות', parsed.warnings.length === 0, parsed.warnings.join(' | '));
check('parse: השנים ממוינות', parsed.rows.map((r) => r.year).join(',') === '2017,2020,2023');

const y2017 = parsed.rows.find((r) => r.year === 2017);
check('parse: סדר ויזואלי הפוך — "11 . 11,000" נקרא 11,000.11',
  y2017.paid_principal === 11000.11, String(y2017.paid_principal));
check('parse: הוצאות אחרות נקראו כשהתווית קיימת',
  y2017.paid_other === 1300.55, String(y2017.paid_other));
check('parse: יתרות בסדר הפוך', y2017.bal_total === 453400.66, String(y2017.bal_total));
check('parse: 2017 מסתכם לסה"כ המוצהר', y2017.gap_paid === 0 && y2017.gap_bal === 0);

const y2020 = parsed.rows.find((r) => r.year === 2020);
check('parse: כותרת מופרדת בטאבים זוהתה', !!y2020);
check('parse: רכיב שנקטע בחילוץ הושלם מהסכום',
  y2020.paid_principal === 14000.16, String(y2020.paid_principal));
check('parse: היתרה שנקטעה הושלמה מהסכום',
  y2020.bal_principal === 420000.14, String(y2020.bal_principal));
check('parse: השדות שהושלמו מסומנים ב-derived',
  y2020.derived.includes('paid_principal') && y2020.derived.includes('bal_principal'),
  y2020.derived.join(','));
check('parse: הוצאות אחרות = 0 כשאין תווית', y2020.paid_other === 0, String(y2020.paid_other));

const y2023 = parsed.rows.find((r) => r.year === 2023);
check('parse: פורמט מספרים תקין', y2023.paid_principal === 15500.21, String(y2023.paid_principal));
check('parse: תאריך (31.12.2023) לא נתפס כסכום ריבית שנצברה',
  y2023.bal_accrued === 1000.53, String(y2023.bal_accrued));

check('parse: טקסט בלי דוחות → אזהרה ובלי שורות', (() => {
  const r = parseAnnualStatements('שלום עולם, אין כאן דוח');
  return r.rows.length === 0 && r.warnings.length === 1;
})());

// מלכודת אמיתית: הכלל שממסך מספרי חשבון בנק חל על כל שורה שמכילה "חשבון",
// והכותרת השנתית היא "מצב חשבון מתומצת לשנת 2017" — כך שמיסוך לפני הפרסינג
// מוחק את השנה ואף דוח לא מזוהה. לכן /history/parse רץ על הטקסט הגולמי
// (הפלט שלו הוא סכמה מספרית סגורה, בלי טקסט חופשי). אם מישהו "יתקן" את זה
// ויוסיף מיסוך — הבדיקה הזו תיפול ותסביר למה.
check('PII: מיסוך לפני הפרסינג היה מוחק את שנת הדוח', (() => {
  const { text } = stripMortgagePii('מצב חשבון מתומצת לשנת 2017 - בשקלים חדשים');
  return !/2017/.test(text) && parseAnnualStatements(text).rows.length === 0;
})());
check('PII: הפרסר על הטקסט הגולמי מזהה את השנה',
  parseAnnualStatements(annualText).rows.some((r) => r.year === 2017));

/* השלמה מהסכום — פונקציה טהורה */
check('fillFromTotal: משלים רכיב חסר יחיד',
  fillFromTotal({ a: 10, b: null, c: 5 }, 20)?.val === 5);
check('fillFromTotal: שני חסרים → null (אי אפשר לדעת את החלוקה)',
  fillFromTotal({ a: null, b: null, c: 5 }, 20) === null);
check('fillFromTotal: תוצאה שלילית נדחית',
  fillFromTotal({ a: 30, b: null }, 20) === null);
check('fillFromTotal: בלי סכום כולל → null', fillFromTotal({ a: null }, null) === null);

check('firstNumber: בוחר את הפורמט שמופיע ראשון', firstNumber('קרן 15,500.21') === 15500.21);
check('firstNumber: אין מספר → null', firstNumber('אין כאן מספר') === null);

/* נרמול */
check('normalizeHistory: שנה לא תקינה נדחית', normalizeHistory([{ year: 1800 }]).length === 0);
check('normalizeHistory: מפתחות זרים לא נשמרים', (() => {
  const [row] = normalizeHistory([{ year: 2020, paid_total: 100, hacker: 'DROP TABLE' }]);
  return row && !('hacker' in row) && row.paid_total === 100;
})());
check('normalizeHistory: סכום שלילי נדחה',
  !('paid_total' in (normalizeHistory([{ year: 2020, paid_total: -5 }])[0] ?? {})));
check('normalizeHistory: שנה כפולה — האחרונה גוברת', (() => {
  const rows = normalizeHistory([{ year: 2020, paid_total: 1 }, { year: 2020, paid_total: 2 }]);
  return rows.length === 1 && rows[0].paid_total === 2;
})());
check('normalizeHistory: מיון לפי שנה',
  normalizeHistory([{ year: 2020 }, { year: 2017 }]).map((r) => r.year).join(',') === '2017,2020');

/* תובנות מחושבות */
const derived = historyDerived(parsed.rows);
check('historyDerived: אחוז הקרן מסך התשלומים', derived.principal_share === 40.5, String(derived.principal_share));
check('historyDerived: ההצמדה שנוספה', derived.cpi_added === 40500.2, String(derived.cpi_added));
check('historyDerived: ירידת היתרה קטנה מירידת הקרן',
  derived.balance_drop < derived.principal_drop, `${derived.balance_drop} < ${derived.principal_drop}`);
check('historyDerived: רשימה ריקה → null', historyDerived([]) === null);

/* סיכום לפרומפט */
const histMd = historySummary(parsed.rows);
check('historySummary: טבלת Markdown עם כל השנים',
  histMd.includes('| 2017 |') && histMd.includes('| 2020 |') && histMd.includes('| 2023 |'));
check('historySummary: משפט הסיכום כולל את פער ההצמדה', histMd.includes('הפרשי ההצמדה על הקרן גדלו'));
check('historySummary: רשימה ריקה → מחרוזת ריקה', historySummary([]) === '');

/* ההיסטוריה נכנסת לפרומפט הניתוח */
const promptWithHist = buildMortgageAnalysisPrompt({}, [], [], [], null, parsed.rows);
check('prompt: סעיף ההיסטוריה נוסף', promptWithHist.includes('היסטוריית תשלומים שנתית'));
check('prompt: בלי היסטוריה — אין סעיף',
  !buildMortgageAnalysisPrompt({}, [], [], [], null, []).includes('היסטוריית תשלומים שנתית'));

/* API */
const histPut = await fetch(`${BASE}/api/mortgage/history`, {
  method: 'PUT', headers: JSON_HDRS, body: JSON.stringify({ rows: parsed.rows }),
});
const histPutBody = await histPut.json();
check('API PUT history: 200 עם שלוש שנים',
  histPut.status === 200 && histPutBody.rows.length === 3, String(histPut.status));
check('API PUT history: derived מוחזר', histPutBody.derived?.years === 3);

const histGet = await (await fetch(`${BASE}/api/mortgage/history`, { headers: HDRS })).json();
check('API GET history: השורות נשמרו', histGet.rows.length === 3, String(histGet.rows.length));
check('API GET history: ערך נשמר נכון',
  histGet.rows.find((r) => r.year === 2017)?.paid_principal === 11000.11);

const histUpsert = await fetch(`${BASE}/api/mortgage/history`, {
  method: 'PUT', headers: JSON_HDRS, body: JSON.stringify({ rows: [{ year: 2017, paid_total: 999 }] }),
});
check('API PUT history: שמירה חוזרת מעדכנת ולא מכפילה',
  (await histUpsert.json()).rows.length === 3);

const histDelYear = await fetch(`${BASE}/api/mortgage/history/2020`, { method: 'DELETE', headers: HDRS });
check('API DELETE history/:year: 200 ונשארו שתיים',
  histDelYear.status === 200 && (await histDelYear.json()).rows.length === 2);
check('API DELETE history/:year: שנה שלא קיימת → 404',
  (await fetch(`${BASE}/api/mortgage/history/1999`, { method: 'DELETE', headers: HDRS })).status === 404);

check('API GET: ההיסטוריה מוחזרת בפירוט המשכנתא',
  (await (await get('')).json()).history?.length === 2);

check('API DELETE history: ניקוי הכל',
  (await (await fetch(`${BASE}/api/mortgage/history`, { method: 'DELETE', headers: HDRS })).json()).rows.length === 0);

/* ---------- סימולציית "מה יקרה אם" ---------- */
// מסלול בודד, לא צמוד, במספרים עגולים — כדי שאפשר יהיה לאמת מול נוסחה ידנית
const simTrack = { name: 'בדיקה', type: 'fixed_unlinked', cpi_linked: 0, balance: 100000, rate: 5, remaining_months: 120 };

check('annuityPayment: שפיצר על 100,000 ב-5% ל-120 חודשים ≈ 1,060.66',
  Math.abs(annuityPayment(100000, 5, 120) - 1060.66) < 0.01,
  String(annuityPayment(100000, 5, 120)?.toFixed(2)));
check('annuityPayment: ריבית 0 → חלוקה שווה', annuityPayment(1200, 0, 12) === 100);
check('annuityPayment: קלט חסר → null', annuityPayment(null, 5, 120) === null && annuityPayment(100000, 5, 0) === null);

check('monthsToPayoff: התשלום השפיצרי סוגר בדיוק בתקופה', monthsToPayoff(100000, 5, 1060.66) === 120,
  String(monthsToPayoff(100000, 5, 1060.66)));
check('monthsToPayoff: תשלום שאינו מכסה את הריבית → null (החוב רק גדל)',
  monthsToPayoff(100000, 5, 400) === null);

check('monthlyCpi: 2% שנתי → ריבית דריבית, לא חלוקה ב-12',
  Math.abs(monthlyCpi(2) - 0.001652) < 1e-5 && monthlyCpi(2) < 2 / 100 / 12,
  String(monthlyCpi(2)));
check('monthlyCpi: 0 → 0', monthlyCpi(0) === 0 && monthlyCpi(undefined) === 0);

check('trackPayment: מעדיף את ההחזר שהוזן מדוח הבנק',
  trackPayment({ ...simTrack, monthly_payment: 1200 }) === 1200);
check('trackPayment: בהיעדר החזר — מחשב שפיצר',
  Math.abs(trackPayment(simTrack) - 1060.66) < 0.01);

const { usable, skipped } = simulatableTracks([simTrack, { name: 'חסר', balance: 5000 }]);
check('simulatableTracks: מסלול בלי ריבית/החזר מסונן ומדווח',
  usable.length === 1 && skipped.length === 1 && skipped[0] === 'חסר');

const simBase = simulatePlan(usable, { cpiAnnual: 0, rollover: false });
check('simulatePlan: בלי תוספת נסגר בדיוק בתקופה המקורית', simBase.months === 120, String(simBase.months));
check('simulatePlan: סה"כ ששולם = קרן + ריבית',
  Math.abs(simBase.totalPaid - (100000 + simBase.totalInterest)) < 1, String(simBase.totalPaid.toFixed(2)));

const simExtra = simulatePlan(usable, { extraMonthly: 500, cpiAnnual: 0, rollover: false });
check('simulatePlan: תוספת של 500 מקצרת את התקופה', simExtra.months < simBase.months, `${simExtra.months} < ${simBase.months}`);
check('simulatePlan: תוספת מקטינה את סך הריבית', simExtra.totalInterest < simBase.totalInterest);
check('simulatePlan: התוספת נכללת בתשלום החודש הראשון',
  Math.abs(simExtra.firstMonthOutlay - (simBase.firstMonthOutlay + 500)) < 0.01);

const simLump = simulatePlan(usable, { lumpSum: 20000, cpiAnnual: 0, rollover: false });
check('simulatePlan: פירעון חד-פעמי מקצר את התקופה', simLump.months < simBase.months);

// הצמדה: אותה ריבית, מדד 3% — הקרן גדלה ולכן משולם יותר
const linked = simulatableTracks([{ ...simTrack, type: 'fixed_linked', cpi_linked: 1 }]).usable;
const simLinked = simulatePlan(linked, { cpiAnnual: 3, rollover: false });
check('simulatePlan: מסלול צמוד — ההצמדה נצברת ומדווחת בנפרד',
  simLinked.totalIndexation > 0 && simLinked.totalPaid > simBase.totalPaid,
  `הצמדה: ${simLinked.totalIndexation.toFixed(0)}`);
check('simulatePlan: במסלול לא צמוד אין הצמדה גם כשהמדד גבוה',
  simulatePlan(usable, { cpiAnnual: 5, rollover: false }).totalIndexation === 0);

// גדר ביטחון: תשלום שאינו מכסה את הריבית לא יתקע את הלולאה
const stuck = simulatePlan([{ name: 'תקוע', balance: 100000, rate: 10, payment: 100, cpi_linked: 0 }], { rollover: false });
check('simulatePlan: תשלום נמוך מהריבית → capped ולא לולאה אינסופית',
  stuck.capped === true && stuck.months === null);

check('monthsHe: 26 חודשים → "2 שנים ו-2 חודשים"', monthsHe(26) === '2 שנים ו-2 חודשים', monthsHe(26));
check('monthsHe: 24 → "2 שנים" בלי שארית', monthsHe(24) === '2 שנים');
check('monthsHe: פחות משנה', monthsHe(7) === '7 חודשים');
check('monthsHe: יחיד תקין — "שנה" ו-"חודש", לא "1 שנים"',
  monthsHe(12) === 'שנה' && monthsHe(13) === 'שנה וחודש' && monthsHe(25) === '2 שנים וחודש' && monthsHe(1) === 'חודש',
  `${monthsHe(12)} · ${monthsHe(13)} · ${monthsHe(25)}`);
check('endMonth: 12 חודשים קדימה', endMonth(12, new Date(2026, 7, 1)) === '2027-08', String(endMonth(12, new Date(2026, 7, 1))));

// המסלול היקר (ריבית + הצמדה) הוא זה שמקבל את הכסף הנוסף
const twoTracks = simulatableTracks([
  { name: 'זול לא צמוד', type: 'fixed_unlinked', cpi_linked: 0, balance: 100000, rate: 4.5, remaining_months: 120 },
  { name: 'יקר צמוד', type: 'fixed_linked', cpi_linked: 1, balance: 100000, rate: 3.5, remaining_months: 120 },
]).usable;
const routed = simulatePlan(twoTracks, { extraMonthly: 1000, cpiAnnual: 3, rollover: false });
check('simulatePlan: הכסף הנוסף מנותב לצמוד היקר (3.5%+3% > 4.5%) ולא לנומינלי הגבוה',
  routed.perTrack.find((t) => t.name === 'יקר צמוד').months
  < routed.perTrack.find((t) => t.name === 'זול לא צמוד').months);

const full = buildSimulation({ tracks: [simTrack], extraMonthly: 500, cpiAnnual: 0 });
check('buildSimulation: מחזיר ok עם השוואה מלאה', full.ok === true && full.diff.monthsSaved > 0);
check('buildSimulation: החיסכון הכולל חיובי ומחושב מהפרש התשלומים',
  Math.abs(full.diff.totalSaved - (full.baseline.totalPaid - full.withExtra.totalPaid)) < 0.01);
check('buildSimulation: ההחזר הנוכחי = סכום ההחזרים במסלולים',
  Math.abs(full.currentPayment - 1060.66) < 0.01);
check('buildSimulation: בלי מסלולים ראויים → ok=false עם הסבר',
  buildSimulation({ tracks: [{ name: 'ריק' }] }).ok === false);

// תרחישי ריבית — קבועה לא מושפעת, פריים כן
check('buildSimulation: מסלול קבוע אינו מושפע מעליית ריבית',
  full.rateRisk.every((r) => Math.abs(r.monthlyDelta) < 0.01 && r.affectedBalance === 0));
const primeSim = buildSimulation({
  tracks: [{ name: 'פריים', type: 'prime', cpi_linked: 0, balance: 200000, rate: 4.6, remaining_months: 240 }],
  cpiAnnual: 0,
});
check('buildSimulation: שני תרחישי ריבית (1% ו-2%)',
  primeSim.rateRisk.length === 2 && primeSim.rateRisk[0].shock === 1 && primeSim.rateRisk[1].shock === 2);
check('buildSimulation: עליית ריבית מגדילה את ההחזר במסלול פריים',
  primeSim.rateRisk[0].monthlyDelta > 0 && primeSim.rateRisk[1].monthlyDelta > primeSim.rateRisk[0].monthlyDelta,
  `+${primeSim.rateRisk[0].monthlyDelta.toFixed(2)} / +${primeSim.rateRisk[1].monthlyDelta.toFixed(2)}`);
check('buildSimulation: היתרה המושפעת = יתרת מסלול הפריים',
  primeSim.rateRisk[0].affectedBalance === 200000);

/* ---------- תרחיש ריבית: מגיב לתוספת ולפירעון ---------- */
// באג שדווח: השדות ב"מה קורה אם הריבית תעלה" לא זזו כשהוזנה תוספת/פירעון.
// שני שורשים: (1) התרחיש רץ על המסלולים המקוריים ולא על התוכנית; (2) העלאת
// ריבית עדכנה את הריבית בלבד והשאירה את ההחזר — כלומר האריכה את התקופה
// במקום לייקר את ההחזר, בסתירה למה שהטבלה מצהירה.
const riskTracks = [
  { name: 'פריים', type: 'prime', cpi_linked: 0, balance: 200000, rate: 4.6, remaining_months: 240, monthly_payment: 1270 },
  { name: 'קבועה', type: 'fixed_unlinked', cpi_linked: 0, balance: 200000, rate: 3.5, remaining_months: 240, monthly_payment: 1160 },
];
const riskPlain = buildSimulation({ tracks: riskTracks, cpiAnnual: 0 });
const riskExtra = buildSimulation({ tracks: riskTracks, extraMonthly: 1500, cpiAnnual: 0 });
const riskLump = buildSimulation({ tracks: riskTracks, lumpSum: 150000, cpiAnnual: 0 });

check('rateRisk: תוספת חודשית משנה את העלות הנוספת בתרחיש',
  riskExtra.rateRisk[1].extraCost < riskPlain.rateRisk[1].extraCost,
  `${Math.round(riskExtra.rateRisk[1].extraCost)} < ${Math.round(riskPlain.rateRisk[1].extraCost)}`);
check('rateRisk: תוספת חודשית מקצרת גם את התרחיש',
  riskExtra.rateRisk[1].months < riskPlain.rateRisk[1].months);
check('rateRisk: totalMonthly כולל את התוספת של המשתמש',
  Math.abs(riskExtra.rateRisk[0].totalMonthly - (riskExtra.rateRisk[0].monthlyPayment + 1500)) < 0.01);
check('rateRisk: פירעון חד-פעמי מקטין את היתרה החשופה',
  riskLump.rateRisk[0].affectedBalance < riskPlain.rateRisk[0].affectedBalance,
  `${Math.round(riskLump.rateRisk[0].affectedBalance)} < ${Math.round(riskPlain.rateRisk[0].affectedBalance)}`);
check('rateRisk: פירעון חד-פעמי מוזיל את ההחזר שהבנק יגבה בתרחיש',
  riskLump.rateRisk[0].monthlyPayment < riskPlain.rateRisk[0].monthlyPayment);

check('repriceForShock: מסלול קבוע לא משתנה',
  repriceForShock(riskTracks.map((t) => ({ ...t, payment: t.monthly_payment })), 2)[1].rate === 3.5);
check('repriceForShock: בפריים גם הריבית וגם ההחזר עולים — התקופה נשמרת',
  (() => {
    const [p] = repriceForShock(riskTracks.map((t) => ({ ...t, payment: t.monthly_payment })), 2);
    return p.rate === 6.6 && p.payment > 1270;
  })());
check('repriceForShock: בלי שוק מחזיר את המערך כמות שהוא',
  repriceForShock(riskTracks, 0) === riskTracks);

check('applyLumpSum: מוריד מהמסלול היקר ביותר קודם',
  applyLumpSum([
    { name: 'זול', cpi_linked: 0, rate: 3, balance: 100000 },
    { name: 'יקר', cpi_linked: 0, rate: 5, balance: 100000 },
  ], 40000, 0).tracks.find((t) => t.name === 'יקר').balance === 60000);
check('applyLumpSum: עודף גולש למסלול הבא',
  applyLumpSum([
    { name: 'זול', cpi_linked: 0, rate: 3, balance: 100000 },
    { name: 'יקר', cpi_linked: 0, rate: 5, balance: 50000 },
  ], 70000, 0).total === 70000);
check('applyLumpSum: סכום גדול מכל היתרות לא יוצר יתרה שלילית',
  applyLumpSum([{ name: 'א', cpi_linked: 0, rate: 5, balance: 10000 }], 999999, 0).tracks[0].balance === 0);
check('applyLumpSum: בלי סכום — המסלולים חוזרים כמות שהם',
  applyLumpSum([{ name: 'א', cpi_linked: 0, rate: 5, balance: 10000 }], 0, 0).total === 0);
check('simulatePlan: הפירעון החד-פעמי נספר בסך ששולם (לא נעלם)',
  Math.abs(simulatePlan(usable, { lumpSum: 20000, cpiAnnual: 0, rollover: false }).perTrack[0].paid
    - (20000 + 100000 - 20000 + simLump.totalInterest)) < 1,
  String(simLump.totalPaid.toFixed(2)));

/* ---------- קיצוץ boilerplate מהמסמכים ---------- */
const PAGE = (n) => `\n-- ${n} of 9 --\n`;
const dataPage = 'מצב חשבון מתומצת לשנת 2019\nיתרת קרן 703,431.61\nשיערוך קרן 95,324.07';
const legalPage = 'דף הסבר - עמלות פרעון מוקדם\nנגיד בנק ישראל קבע בצו הבנקאות התשס"ב\nהמפקח על הבנקים רשאי לעדכן';
const explainPage = 'דף הסבר למצב חשבון המשכנתא מתומצת לשנת 2020\nיתרת קרן — משמעות השדה\nשיערוך קרן — משמעות השדה';
const stubPage = '[כתובת הוסרה]';

check('splitPages: מפצל לפי סמני העמודים של pdf-parse',
  splitPages(`${dataPage}${PAGE(1)}${legalPage}${PAGE(2)}`).length === 2);
check('isBoilerplatePage: עמוד נתונים נשמר', isBoilerplatePage(dataPage) === false);
check('isBoilerplatePage: דף הסבר משפטי נזרק', isBoilerplatePage(legalPage) === true);
check('isBoilerplatePage: "דף הסבר למצב חשבון" נזרק למרות שמות שדות הנתונים',
  isBoilerplatePage(explainPage) === true);
check('isBoilerplatePage: שארית קצרה (כתובת בלבד) נזרקת', isBoilerplatePage(stubPage) === true);

const trimmed = stripBoilerplate(
  [dataPage, legalPage, explainPage, stubPage, dataPage].join(PAGE(1)) + PAGE(6));
check('stripBoilerplate: נשאר רק עמוד הנתונים', trimmed.pagesKept === 1,
  `${trimmed.pagesKept}/${trimmed.pagesTotal}`);
check('stripBoilerplate: עמוד זהה שחוזר נספר ככפילות', trimmed.duplicates === 1);
check('stripBoilerplate: הנתונים עצמם שרדו', trimmed.text.includes('703,431.61'));
check('stripBoilerplate: מדווח כמה תווים נחסכו', trimmed.removedChars > 0);
check('stripBoilerplate: בלי סמני עמודים — הטקסט חוזר כמות שהוא',
  stripBoilerplate(legalPage).text === legalPage);
check('stripBoilerplate: רשת ביטחון — כשהכול נראה גנרי מוחזר המקור המלא',
  (() => {
    const all = [legalPage, explainPage].join(PAGE(1));
    return stripBoilerplate(all).text === all;
  })());
check('stripBoilerplate: קלט ריק לא זורק', stripBoilerplate('').text === '' && stripBoilerplate().text === '');

/* ---------- API של הסימולציה ---------- */
const simApi = await (await fetch(`${BASE}/api/mortgage/simulate`, {
  method: 'POST', headers: JSON_HDRS,
  body: JSON.stringify({ tracks: [simTrack], extra_monthly: 500, cpi_annual: 2 }),
})).json();
check('API simulate: מחזיר השוואה מלאה', simApi.ok === true && simApi.diff.monthsSaved > 0);
check('API simulate: קלט לא מספרי לא מפיל את החישוב',
  (await (await fetch(`${BASE}/api/mortgage/simulate`, {
    method: 'POST', headers: JSON_HDRS,
    body: JSON.stringify({ tracks: [simTrack], extra_monthly: 'abc', lump_sum: -5 }),
  })).json()).ok === true);
check('API simulate: הנחת אינפלציה חריגה נחתכת ל-15%',
  (await (await fetch(`${BASE}/api/mortgage/simulate`, {
    method: 'POST', headers: JSON_HDRS,
    body: JSON.stringify({ tracks: [simTrack], cpi_annual: 900 }),
  })).json()).cpiAnnual === 15);
check('API simulate: בלי מסלולים בגוף — נופל לשמורים ב-DB',
  typeof (await (await fetch(`${BASE}/api/mortgage/simulate`, {
    method: 'POST', headers: JSON_HDRS, body: JSON.stringify({ extra_monthly: 100 }),
  })).json()).ok === 'boolean');

/* ---------- מחיקה ---------- */
const del = await fetch(`${BASE}/api/mortgage`, { method: 'DELETE', headers: HDRS });
check('API DELETE: 200', del.status === 200, String(del.status));
const afterDel = await (await get('')).json();
check('API DELETE: הנתונים נמחקו', Object.keys(afterDel.data).length === 0 && afterDel.tracks.length === 0);
check('API DELETE: המסמכים נמחקו יחד עם הנתונים', afterDel.docs.length === 0, String(afterDel.docs.length));

console.log(`\n========== mortgage: ${pass}/${pass + fail} ==========`);
process.exitCode = fail === 0 ? 0 : 1;
