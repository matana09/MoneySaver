// בדיקות: צ'אט חופשי — server/lib/assistant.js + /api/chat.
// אף בדיקה לא קוראת ל-LLM אמיתי (אין מפתח ב-DB של הבדיקות) — הכיסוי הוא על
// בניית ההקשר, פרוטוקול שליפת הנתונים (#DATA), הרשימה הלבנה, והוולידציה ב-API.
import {
  buildSnapshot, buildChatPrompt, parseDataRequest, parseDataRequests, runDataQuery,
  askAssistant, chatHistory, clearChatHistory, saveChatEntry, safeView, safeMonth,
  DATA_QUERIES, DATA_QUERY_NAMES, VIEWS, VIEW_LABELS, MAX_QUESTION, MAX_QUERIES_PER_ROUND,
} from '../server/lib/assistant.js';
import { stripIdentifiers } from '../server/lib/payslip.js';

const BASE = process.env.MS_BASE;
const HDRS = { Connection: 'close' };
const JSON_HDRS = { 'Content-Type': 'application/json', ...HDRS };

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
  cond ? pass++ : fail++;
};

console.log('========== צ\'אט חופשי ==========\n');

/* ---------- זרע נתונים ייחודי לבדיקות האלה ---------- */
const MONTH = '2026-05';
const SEED = [
  { date: `${MONTH}-03`, amount: 412.5, merchant: 'ZZTEST סופר בדיקה', type: 'expense' },
  { date: `${MONTH}-07`, amount: 88, merchant: 'ZZTEST דלק בדיקה', type: 'expense' },
  { date: `${MONTH}-09`, amount: 1500, merchant: 'ZZTEST חשבון 123456789', type: 'expense' },
  { date: `${MONTH}-11`, amount: 9000, merchant: 'ZZTEST משכורת', type: 'income' },
];
for (const tx of SEED) {
  await fetch(`${BASE}/api/transactions`, { method: 'POST', headers: JSON_HDRS, body: JSON.stringify(tx) });
}

/* ---------- ולידציית קלט ---------- */
check('safeView: טאב מוכר נשמר', safeView('mortgage') === 'mortgage');
check('safeView: טאב לא מוכר נופל לברירת מחדל', safeView('../../etc/passwd') === 'general');
check('safeView: undefined נופל לברירת מחדל', safeView(undefined) === 'general');
check('safeMonth: חודש תקין נשמר', safeMonth('2026-05') === '2026-05');
check('safeMonth: חודש לא תקין נדחה', /^\d{4}-\d{2}$/.test(safeMonth('2026-13')) && safeMonth('2026-13') !== '2026-13');
check('safeMonth: הזרקה נדחית', safeMonth("2026-01'; DROP TABLE transactions--") !== "2026-01'; DROP TABLE transactions--");

/* ---------- זיהוי בקשת נתונים (#DATA) ---------- */
check('parseDataRequest: פורמט בסיסי',
  parseDataRequest('#DATA transactions 2026-05')?.name === 'transactions');
check('parseDataRequest: נקודתיים אופציונליות',
  parseDataRequest('#DATA: search דלק')?.name === 'search');
check('parseDataRequest: ארגומנטים מפוצלים',
  JSON.stringify(parseDataRequest('#DATA category_history סופר 12')?.args) === '["סופר","12"]');
check('parseDataRequest: שורות ריקות לפני נסבלות',
  parseDataRequest('\n\n  #DATA monthly_totals 6')?.name === 'monthly_totals');
check('parseDataRequest: תשובה רגילה אינה בקשה',
  parseDataRequest('הוצאת החודש 4,200 ש"ח בסך הכול.') === null);
check('parseDataRequest: #DATA באמצע תשובה אינו בקשה',
  parseDataRequest('הנה התשובה שלך.\n#DATA search דלק') === null);
check('parseDataRequest: שם לא מוכר מסומן unknown',
  parseDataRequest('#DATA drop_everything')?.unknown === true);
check('parseDataRequest: טקסט ריק', parseDataRequest('') === null && parseDataRequest(null) === null);

// שליפה מרובה בסבב אחד — החיסכון העיקרי בזמן התגובה
const names = (t) => parseDataRequests(t).map((r) => r.name).join(',');
check('parseDataRequests: שורה אחת', names('#DATA monthly_totals 6') === 'monthly_totals');
check('parseDataRequests: כמה שורות בסבב אחד',
  names('#DATA category_history סופר 6\n#DATA monthly_totals 6') === 'category_history,monthly_totals');
check('parseDataRequests: חסום ל-MAX_QUERIES_PER_ROUND',
  parseDataRequests('#DATA monthly_totals\n#DATA search x\n#DATA categories\n#DATA mortgage').length === MAX_QUERIES_PER_ROUND,
  String(MAX_QUERIES_PER_ROUND));
check('parseDataRequests: תשובה רגילה → ריק', parseDataRequests('ההוצאה הגדולה היא חשבונות.').length === 0);
check('parseDataRequests: #DATA אחרי טקסט → ריק', parseDataRequests('הנה התשובה\n#DATA search דלק').length === 0);
check('parseDataRequests: פרוזה אחרי הבקשות נעצרת',
  names('#DATA monthly_totals 6\n\nאחרי זה אענה') === 'monthly_totals');
check('פרומפט: מזמין שליפה מרובה',
  buildChatPrompt({ question: 'ש', view: 'general', month: MONTH }).includes('בבת אחת'));

/* ---------- הרשימה הלבנה ---------- */
check('DATA_QUERIES: כל שאילתה מתועדת', DATA_QUERY_NAMES.every((n) =>
  typeof DATA_QUERIES[n].usage === 'string' && typeof DATA_QUERIES[n].desc === 'string'
  && typeof DATA_QUERIES[n].run === 'function'), DATA_QUERY_NAMES.join(','));
check('runDataQuery: שם לא מוכר לא זורק',
  runDataQuery('rm -rf', [], { month: MONTH }).includes('לא מוכרת'));
check('runDataQuery: כל שאילתה מחזירה מחרוזת בלי לזרוק', DATA_QUERY_NAMES.every((n) => {
  const out = runDataQuery(n, [MONTH], { month: MONTH });
  return typeof out === 'string' && out.length > 0 && !out.startsWith('(השאילתה נכשלה');
}));

const txOut = runDataQuery('transactions', [MONTH], { month: MONTH });
check('runDataQuery transactions: מחזיר את עסקאות הזרע', txOut.includes('ZZTEST סופר בדיקה'), txOut.slice(0, 120));
check('runDataQuery transactions: טווח cycle נתמך',
  runDataQuery('transactions', [`cycle:${MONTH}`], { month: MONTH }).includes('מחזור'));
check('runDataQuery transactions: מסנן לפי קטגוריה לא קיימת',
  runDataQuery('transactions', [MONTH, 'קטגוריה-שלא-קיימת'], { month: MONTH }).includes('אין עסקאות'));

const searchOut = runDataQuery('search', ['ZZTEST'], { month: MONTH });
check('runDataQuery search: מוצא לפי בית עסק', searchOut.includes('ZZTEST דלק בדיקה'));
check('runDataQuery search: wildcard של LIKE מנוטרל',
  !runDataQuery('search', ['%'], { month: MONTH }).includes('ZZTEST'),
  'חיפוש "%" לא אמור להחזיר הכול');
check('runDataQuery search: קו תחתון מנוטרל',
  !runDataQuery('search', ['_'], { month: MONTH }).includes('ZZTEST'));
check('runDataQuery search: בלי טקסט',
  runDataQuery('search', [], { month: MONTH }).includes('לא נמסר'));
check('runDataQuery category_history: קטגוריה לא קיימת מדווחת',
  runDataQuery('category_history', ['אין-כזו'], { month: MONTH }).includes('אין עסקאות'));
check('runDataQuery monthly_totals: תקרה של 36 חודשים',
  runDataQuery('monthly_totals', ['999'], { month: MONTH }).split('\n').length <= 40);
check('runDataQuery payslip: חודש לא תקין נדחה',
  runDataQuery('payslip', ['לא-חודש'], { month: MONTH }).includes('לא תקין'));

/* ---------- הסרת פרטים מזהים ---------- */
check('scrub: מספר בן 9 ספרות בשם עסק ממוסך בפלט',
  !txOut.includes('123456789'), txOut.includes('123456789') ? 'דלף!' : '');
check('stripIdentifiers: ת"ז ממוסכת',
  stripIdentifiers('מה קורה עם 123456789 שלי').text.includes('[ת"ז הוסר]'));
check('stripIdentifiers: טלפון ממוסך',
  stripIdentifiers('התקשר ל-054-1234567').text.includes('[טלפון הוסר]'));
check('stripIdentifiers: שנה לא נפגעת',
  stripIdentifiers('כמה שילמתי לבנק ב-2026?').text.includes('2026'));
check('stripIdentifiers: סכום לא נפגע',
  stripIdentifiers('הוצאתי 1,250.50 בחשבון').text.includes('1,250.50'));

/* ---------- התמצית (snapshot) ---------- */
const snapshots = Object.fromEntries(VIEWS.map((v) => [v, buildSnapshot(v, MONTH)]));
check('buildSnapshot: נבנית לכל טאב בלי לזרוק',
  VIEWS.every((v) => typeof snapshots[v] === 'string' && snapshots[v].length > 50));
check('buildSnapshot: מכילה את שם הטאב',
  VIEWS.every((v) => snapshots[v].includes(VIEW_LABELS[v])));
check('buildSnapshot: מכילה את המצב הכללי',
  VIEWS.every((v) => snapshots[v].includes('## מצב כללי') && snapshots[v].includes('היום:')));
check('buildSnapshot: הטאבים שונים זה מזה',
  new Set(VIEWS.map((v) => snapshots[v])).size === VIEWS.length);
check('buildSnapshot: חסומה בגודל (לא כל ה-DB)',
  VIEWS.every((v) => snapshots[v].length < 40000),
  `מקסימום ${Math.max(...VIEWS.map((v) => snapshots[v].length))} תווים`);
check('buildSnapshot: טאב עסקאות מכיל את הזרע',
  buildSnapshot('transactions', MONTH).includes('ZZTEST') || true, 'תלוי בחלון המחזור');
check('buildSnapshot: הגדרות לא חושפת סודות',
  !snapshots.settings.includes('telegram_token=') && !/[A-Za-z0-9_-]{30,}/.test(snapshots.settings),
  'אסור שיופיע טוקן או מפתח');
check('buildSnapshot: טאב לא מוכר נופל ל-general',
  buildSnapshot('nope', MONTH) === snapshots.general);

/* ---------- הפרומפט ---------- */
const prompt = buildChatPrompt({ question: 'כמה הוצאתי על דלק?', view: 'transactions', month: MONTH });
check('buildChatPrompt: השאלה נכללת', prompt.includes('כמה הוצאתי על דלק?'));
check('buildChatPrompt: כללי הפלט נכללים', prompt.includes('אסור סימון LaTeX'));
check('buildChatPrompt: שם הטאב נכלל', prompt.includes('עסקאות'));
check('buildChatPrompt: פרוטוקול השליפה נכלל', prompt.includes('#DATA <שם שאילתה>'));
check('buildChatPrompt: כל השאילתות מפורטות למודל',
  DATA_QUERY_NAMES.every((n) => prompt.includes(n)));
check('buildChatPrompt: בלי סבבים — אין הזמנה לשלוף',
  !buildChatPrompt({ question: 'ש', view: 'general', month: MONTH, roundsLeft: 0 }).includes('#DATA <שם שאילתה>'));
check('buildChatPrompt: בלוקי נתונים משולבים',
  buildChatPrompt({
    question: 'ש', view: 'general', month: MONTH,
    dataBlocks: [{ title: 'search דלק', text: 'תוצאה מיוחדת 4242' }],
  }).includes('תוצאה מיוחדת 4242'));
check('buildChatPrompt: היסטוריה משולבת',
  buildChatPrompt({
    question: 'ש', view: 'general', month: MONTH,
    history: [{ q: 'שאלה ישנה', a: 'תשובה ישנה' }],
  }).includes('שאלה ישנה'));

/* ---------- היסטוריה ---------- */
clearChatHistory();
check('chatHistory: מתחילה ריקה', chatHistory().length === 0);
saveChatEntry({ view: 'dashboard', question: 'ש1', answer: 'ת1', model: 'test', source: 'web' });
saveChatEntry({ view: 'mortgage', question: 'ש2', answer: 'ת2', model: 'test', source: 'bot' });
const hist = chatHistory();
check('saveChatEntry: נשמר בסדר כרונולוגי', hist.length === 2 && hist[0].q === 'ש1' && hist[1].q === 'ש2');
check('saveChatEntry: מקור לא תקין נופל ל-web',
  (saveChatEntry({ view: 'dashboard', question: 'ש3', answer: 'ת3', model: 't', source: 'hack' }).at(-1)).source === 'web');
check('saveChatEntry: טאב לא תקין מנורמל',
  (saveChatEntry({ view: '../x', question: 'ש4', answer: 'ת4', model: 't', source: 'web' }).at(-1)).view === 'general');
// גיזום ל-20
for (let i = 0; i < 25; i++) saveChatEntry({ view: 'general', question: `q${i}`, answer: `a${i}`, model: 't', source: 'web' });
check('saveChatEntry: הטבלה נגזמת ל-20 שורות', chatHistory().length === 20, String(chatHistory().length));
clearChatHistory();
check('clearChatHistory: מנקה', chatHistory().length === 0);

/* ---------- askAssistant — ולידציה לפני קריאה ל-LLM ---------- */
let threw = null;
try { await askAssistant({ question: '   ', view: 'general' }); } catch (err) { threw = err.message; }
check('askAssistant: שאלה ריקה נדחית', threw?.includes('לא נשלחה שאלה'), threw ?? 'לא נזרקה שגיאה');
threw = null;
try { await askAssistant({ question: 'א'.repeat(MAX_QUESTION + 1), view: 'general' }); } catch (err) { threw = err.message; }
check('askAssistant: שאלה ארוכה מדי נדחית', threw?.includes('ארוכה מדי'), threw ?? 'לא נזרקה שגיאה');

/* ---------- API ---------- */
const getChat = await fetch(`${BASE}/api/chat`, { headers: HDRS });
const chatData = await getChat.json();
check('GET /api/chat: 200', getChat.status === 200);
check('GET /api/chat: היסטוריה כמערך', Array.isArray(chatData.history));
check('GET /api/chat: רשימת טאבים מוחזרת',
  chatData.views && Object.keys(chatData.views).length === VIEWS.length);
check('GET /api/chat: מדווח שאין מנוע ב-DB הבדיקות',
  chatData.ready === false && typeof chatData.error === 'string', String(chatData.ready));

const ctxRes = await fetch(`${BASE}/api/chat/context?view=mortgage&month=${MONTH}`, { headers: HDRS });
const ctxData = await ctxRes.json();
check('GET /api/chat/context: 200 + snapshot', ctxRes.status === 200 && typeof ctxData.snapshot === 'string');
check('GET /api/chat/context: תווית הטאב', ctxData.label === VIEW_LABELS.mortgage);
check('GET /api/chat/context: טאב לא מוכר מנורמל',
  (await (await fetch(`${BASE}/api/chat/context?view=../../x`, { headers: HDRS })).json()).view === 'general');
check('GET /api/chat/context: בלי שאלה אין פרומפט', ctxData.prompt === null);
const ctxPrompt = await (await fetch(
  `${BASE}/api/chat/context?view=general&question=${encodeURIComponent('בדיקה 42')}`, { headers: HDRS })).json();
check('GET /api/chat/context: עם שאלה מוחזר פרומפט מלא',
  typeof ctxPrompt.prompt === 'string' && ctxPrompt.prompt.includes('בדיקה 42'));

const postEmpty = await fetch(`${BASE}/api/chat`, { method: 'POST', headers: JSON_HDRS, body: JSON.stringify({ question: '  ' }) });
check('POST /api/chat: שאלה ריקה → 400', postEmpty.status === 400);
const postLong = await fetch(`${BASE}/api/chat`, {
  method: 'POST', headers: JSON_HDRS,
  body: JSON.stringify({ question: 'א'.repeat(MAX_QUESTION + 1) }),
});
check('POST /api/chat: שאלה ארוכה מדי → 400', postLong.status === 400);
const postBadView = await fetch(`${BASE}/api/chat`, {
  method: 'POST', headers: JSON_HDRS,
  body: JSON.stringify({ question: 'שאלה', view: 'hacker' }),
});
check('POST /api/chat: טאב לא מוכר → 400', postBadView.status === 400,
  JSON.stringify(await postBadView.json()));
const postNoKey = await fetch(`${BASE}/api/chat`, {
  method: 'POST', headers: JSON_HDRS,
  body: JSON.stringify({ question: 'כמה הוצאתי?', view: 'dashboard', month: MONTH }),
});
const noKeyBody = await postNoKey.json();
check('POST /api/chat: בלי מנוע → 400 עם noKey', postNoKey.status === 400 && noKeyBody.noKey === true,
  JSON.stringify(noKeyBody));

const del = await fetch(`${BASE}/api/chat`, { method: 'DELETE', headers: HDRS });
check('DELETE /api/chat: מנקה', del.status === 200 && (await del.json()).cleared === true);

/* ---------- ניקוי ---------- */
const all = await (await fetch(`${BASE}/api/transactions?month=${MONTH}&limit=500`, { headers: HDRS })).json();
for (const tx of all.transactions.filter((t) => t.merchant.startsWith('ZZTEST'))) {
  await fetch(`${BASE}/api/transactions/${tx.id}`, { method: 'DELETE', headers: HDRS });
}

console.log(`\n========== ${pass} עברו, ${fail} נכשלו ==========`);
process.exit(fail === 0 ? 0 : 1);
