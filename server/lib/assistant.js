// assistant.js — צ'אט חופשי על כל נתוני האפליקציה (web בכל הטאבים + בוט טלגרם).
//
// האתגר המרכזי: לתת למודל הקשר אמיתי בלי לדחוס את כל ה-DB לפרומפט. הפתרון —
// שתי שכבות:
//   1. snapshot — תמצית קומפקטית וקבועת-גודל של הטאב הנוכחי (מצטברים, לא שורות
//      גולמיות). נבנית מראש ונשלחת תמיד.
//   2. שאילתות לפי דרישה — אם המודל צריך נתון שאינו בתמצית, הוא מחזיר שורה
//      אחת `#DATA <שם> <ארגומנטים>` מתוך whitelist קשיח (DATA_QUERIES). השרת
//      מריץ, מצרף את התוצאה, ושואל שוב. עד MAX_ROUNDS סבבים.
//
// למה לא function-calling של הספק: המנוע מתחלף (Gemini / ChatGPT דרך Codex CLI),
// ולשניהם חוזה שונה. הפרוטוקול הטקסטואלי עובד זהה בשניהם, והוא בטוח באותה מידה —
// המודל לעולם לא כותב SQL, רק בוחר שם שאילתה מרשימה סגורה.
import { db } from '../db.js';
import { stripIdentifiers } from './payslip.js';
import {
  stripMortgagePii, dataSummary, tracksSummary, checksSummary, mortgageDetail,
} from './mortgage.js';
import { getMarketRates, marketRatesSummary } from './marketRates.js';
import { computeCycleFlow, cycleDayFn, cycleDayForMonth } from '../routes/flow.js';
import { cycleWindow, localDate } from './dates.js';
import { llmAnalyze } from './llm.js';
import { FAST_MODEL } from './codex.js';
import { usageSummary } from './llmUsage.js';

/* ==================== קבועים ==================== */

export const VIEW_LABELS = {
  dashboard: 'דשבורד',
  transactions: 'עסקאות',
  import: 'ייבוא',
  categories: 'קטגוריות',
  income: 'הכנסות והוצאות',
  payslip: 'תלוש משכורת',
  mortgage: 'משכנתא',
  settings: 'הגדרות',
  general: 'כללי (בוט טלגרם)',
};
export const VIEWS = Object.keys(VIEW_LABELS);
export const DEFAULT_VIEW = 'general';

export const MAX_QUESTION = 1000;
const MAX_HISTORY = 20;          // שומרים 20 חילופים אחרונים ב-DB
const PROMPT_HISTORY = 8;        // מתוכם נשלחים לפרומפט — מספיק להקשר, לא מנפח
const MAX_ROUNDS = 2;            // כמה פעמים המודל רשאי לבקש נתונים נוספים
const MAX_BLOCK_CHARS = 6000;    // תקרה לגודל תוצאת שאילתה בודדת

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const fmtNum = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 0 });
const fmtNum2 = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 2 });
const ils = (n) => `${fmtNum.format(Math.round(Number(n) || 0))} ש"ח`;

/** ניקוי טקסט חופשי שהמשתמש הזין ב-DB (שם עסק, הערה) לפני שליחה החוצה */
function scrub(s) {
  return stripMortgagePii(String(s ?? '')).text;
}

/** הזזת חודש 'YYYY-MM' ב-delta */
function shiftMonth(month, delta) {
  const [y, m] = String(month).split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** חודש תקין, אחרת החודש הנוכחי */
export function safeMonth(month) {
  return MONTH_RE.test(String(month ?? '')) ? String(month) : localDate().slice(0, 7);
}

export function safeView(view) {
  return VIEWS.includes(String(view ?? '')) ? String(view) : DEFAULT_VIEW;
}

/**
 * טווח תאריכים מארגומנט טקסטואלי של המודל:
 *   'cycle:YYYY-MM' → חלון מחזור 10→10 · 'YYYY-MM' → חודש קלנדרי · 'all' → הכול.
 * מחזיר { start, end, label }.
 */
function parseRange(token, fallbackMonth) {
  const t = String(token ?? '').trim();
  if (t === 'all' || t === 'הכל') return { start: '0000-01-01', end: '9999-12-31', label: 'כל התקופות' };
  const cyc = t.match(/^cycle:(\d{4}-\d{2})$/);
  if (cyc) {
    const w = cycleWindow(cyc[1], cycleDayFn);
    return { start: w.start, end: w.end, label: `מחזור ${w.label}` };
  }
  const month = MONTH_RE.test(t) ? t : safeMonth(fallbackMonth);
  return { start: `${month}-01`, end: `${month}-31`, label: `חודש ${month}` };
}

/* ==================== שאילתות בסיס (משותפות לתמצית ולשאילתות לפי דרישה) ==================== */

const EFF = 'COALESCE(t.charge_date, t.date)';

function txRows(start, end, { limit = 40, categoryName = null, type = null } = {}) {
  const where = [`${EFF} >= ?`, `${EFF} <= ?`];
  const params = [start, end];
  if (categoryName) { where.push('c.name = ?'); params.push(categoryName); }
  if (type) { where.push('t.type = ?'); params.push(type); }
  return db.prepare(`
    SELECT ${EFF} AS d, t.amount, t.type, t.merchant, t.description,
           COALESCE(c.name, 'ללא קטגוריה') AS cat, t.source, t.installment_group
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    WHERE ${where.join(' AND ')}
    ORDER BY d DESC, t.id DESC LIMIT ?
  `).all(...params, limit);
}

function txTable(rows) {
  if (!rows.length) return '(אין עסקאות בטווח)';
  const head = '| תאריך | סכום | סוג | בית עסק | קטגוריה |';
  const sep = '|---|---|---|---|---|';
  const body = rows.map((r) => `| ${r.d} | ${ils(r.amount)} | ${r.type === 'income' ? 'הכנסה' : 'הוצאה'} `
    + `| ${scrub(r.merchant) || '—'}${r.description ? ` (${scrub(r.description)})` : ''} | ${r.cat} |`);
  return [head, sep, ...body].join('\n');
}

function rangeTotals(start, end) {
  const t = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN type='expense' THEN amount END), 0) AS expenses,
           COALESCE(SUM(CASE WHEN type='income'  THEN amount END), 0) AS income,
           COUNT(*) AS n
    FROM transactions WHERE COALESCE(charge_date, date) >= ? AND COALESCE(charge_date, date) <= ?
  `).get(start, end);
  return t;
}

function categoryTotals(start, end, limit = 15) {
  return db.prepare(`
    SELECT COALESCE(c.name, 'ללא קטגוריה') AS name, SUM(t.amount) AS total, COUNT(*) AS n
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.type = 'expense' AND ${EFF} >= ? AND ${EFF} <= ?
    GROUP BY c.id ORDER BY total DESC LIMIT ?
  `).all(start, end, limit);
}

function merchantTotals(start, end, limit = 15) {
  return db.prepare(`
    SELECT t.merchant AS name, SUM(t.amount) AS total, COUNT(*) AS n
    FROM transactions t
    WHERE t.type = 'expense' AND ${EFF} >= ? AND ${EFF} <= ?
    GROUP BY t.merchant ORDER BY total DESC LIMIT ?
  `).all(start, end, limit);
}

function totalsTable(rows, firstCol) {
  if (!rows.length) return '(אין נתונים)';
  return [`| ${firstCol} | סה"כ | עסקאות |`, '|---|---|---|',
    ...rows.map((r) => `| ${scrub(r.name) || '—'} | ${ils(r.total)} | ${r.n} |`)].join('\n');
}

function monthlyTotals(limit = 12) {
  return db.prepare(`
    SELECT substr(COALESCE(charge_date, date), 1, 7) AS m,
           COALESCE(SUM(CASE WHEN type='expense' THEN amount END), 0) AS expenses,
           COALESCE(SUM(CASE WHEN type='income'  THEN amount END), 0) AS income,
           COUNT(*) AS n
    FROM transactions GROUP BY m ORDER BY m DESC LIMIT ?
  `).all(limit);
}

/* ==================== תמציות לפי טאב ==================== */

/** כותרת קבועה — נשלחת בכל שאלה, בכל טאב. קטנה בכוונה. */
function globalBlock(month) {
  const cycleDay = cycleDayFn;
  const flow = computeCycleFlow(month, cycleDay);
  const prevFlow = computeCycleFlow(shiftMonth(month, -1), cycleDay);
  const span = db.prepare('SELECT MIN(date) AS a, MAX(date) AS b, COUNT(*) AS n FROM transactions').get();
  const lines = [
    `- היום: ${localDate()}`,
    `- החודש/מחזור שהמשתמש מסתכל עליו בממשק: ${month} (מחזור ${flow.label}, יום עוגן ${cycleDayForMonth(month)})`,
    `- הכנסות במחזור: ${ils(flow.total_income)} · הוצאות: ${ils(flow.actual_expenses)} · נשאר: ${ils(flow.remaining)}`,
    flow.days_left > 0 ? `- נותרו ${flow.days_left} ימים במחזור · תקציב יומי: ${ils(flow.daily_budget)}` : null,
    `- המחזור הקודם (${prevFlow.label}): הכנסות ${ils(prevFlow.total_income)} · הוצאות ${ils(prevFlow.actual_expenses)}`,
    span.n ? `- ב-DB ${span.n} עסקאות, מ-${span.a} עד ${span.b}` : '- אין עדיין עסקאות ב-DB',
  ].filter(Boolean);
  return lines.join('\n');
}

function dashboardBlock(month) {
  const cycleDay = cycleDayFn;
  const flow = computeCycleFlow(month, cycleDay);
  const prev = computeCycleFlow(shiftMonth(month, -1), cycleDay);
  const prevByCat = new Map(prev.by_category.map((c) => [c.name, c.total]));
  const cats = flow.by_category.slice(0, 12).map((c) => {
    const p = prevByCat.get(c.name);
    const delta = p ? `${c.total >= p ? '+' : ''}${Math.round(((c.total - p) / p) * 100)}%` : '—';
    return `| ${c.name} | ${ils(c.total)} | ${p ? ils(p) : '—'} | ${delta} |`;
  });
  const w = cycleWindow(month, cycleDay);
  return [
    `חלון המחזור: ${w.start} עד ${w.end}`,
    `הוצאות בפועל: ${ils(flow.actual_expenses)} · חיזוי סוף מחזור (לפי הקצב): ${ils(flow.predicted_expenses)}`,
    `ימים שחלפו במחזור: ${flow.days_elapsed} מתוך ${flow.cycle_length}`,
    '',
    '### הוצאות לפי קטגוריה במחזור (מול המחזור הקודם)',
    '| קטגוריה | המחזור הזה | המחזור הקודם | שינוי |',
    '|---|---|---|---|',
    ...cats,
    '',
    '### בתי העסק הגדולים במחזור',
    totalsTable(merchantTotals(w.start, w.end, 10), 'בית עסק'),
  ].join('\n');
}

function transactionsBlock(month) {
  const w = cycleWindow(month, cycleDayFn);
  const t = rangeTotals(w.start, w.end);
  return [
    `סה"כ במחזור ${w.start}–${w.end}: ${t.n} עסקאות · הוצאות ${ils(t.expenses)} · הכנסות ${ils(t.income)}`,
    '',
    '### 25 העסקאות האחרונות במחזור',
    txTable(txRows(w.start, w.end, { limit: 25 })),
    '',
    '### 10 העסקאות הגדולות במחזור',
    txTable(db.prepare(`
      SELECT ${EFF} AS d, t.amount, t.type, t.merchant, t.description,
             COALESCE(c.name, 'ללא קטגוריה') AS cat
      FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.type = 'expense' AND ${EFF} >= ? AND ${EFF} <= ?
      ORDER BY t.amount DESC LIMIT 10
    `).all(w.start, w.end)),
  ].join('\n');
}

function importBlock() {
  const bySource = db.prepare(`
    SELECT source, COUNT(*) AS n, MAX(created_at) AS last FROM transactions GROUP BY source ORDER BY n DESC
  `).all();
  const uncategorized = db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NULL").get().n;
  const groups = db.prepare(`
    SELECT installment_group AS g, COUNT(*) AS n, SUM(amount) AS total, MIN(date) AS first
    FROM transactions WHERE installment_group IS NOT NULL GROUP BY installment_group
    ORDER BY first DESC LIMIT 10
  `).all();
  return [
    '### עסקאות לפי מקור ייבוא',
    bySource.length
      ? ['| מקור | כמות | אחרון |', '|---|---|---|',
        ...bySource.map((r) => `| ${r.source} | ${r.n} | ${r.last ?? '—'} |`)].join('\n')
      : '(אין עסקאות)',
    '',
    `עסקאות ללא קטגוריה: ${uncategorized}`,
    '',
    '### תוכניות תשלומים פעילות (10 אחרונות)',
    groups.length
      ? ['| קבוצה | תשלומים | סה"כ | ראשון |', '|---|---|---|---|',
        ...groups.map((r) => `| ${r.g} | ${r.n} | ${ils(r.total)} | ${r.first} |`)].join('\n')
      : '(אין תוכניות תשלומים)',
  ].join('\n');
}

function categoriesBlock(month) {
  const w = cycleWindow(month, cycleDayFn);
  const cats = db.prepare('SELECT id, name, icon FROM categories ORDER BY name').all();
  const rules = db.prepare(`
    SELECT r.pattern, c.name AS cat, r.priority FROM rules r
    JOIN categories c ON c.id = r.category_id ORDER BY r.priority DESC, r.id LIMIT 40
  `).all();
  const uncat = db.prepare(`
    SELECT merchant, COUNT(*) AS n, SUM(amount) AS total FROM transactions
    WHERE category_id IS NULL AND type = 'expense'
    GROUP BY merchant ORDER BY total DESC LIMIT 10
  `).all();
  return [
    `קטגוריות מוגדרות (${cats.length}): ${cats.map((c) => `${c.icon} ${c.name}`).join(' · ')}`,
    '',
    '### הוצאות לפי קטגוריה במחזור הנוכחי',
    totalsTable(categoryTotals(w.start, w.end, 20), 'קטגוריה'),
    '',
    '### כללי קטגוריזציה אוטומטית (regex על שם בית העסק)',
    rules.length
      ? ['| תבנית | קטגוריה | עדיפות |', '|---|---|---|',
        ...rules.map((r) => `| \`${r.pattern}\` | ${r.cat} | ${r.priority} |`)].join('\n')
      : '(אין כללים)',
    '',
    '### בתי עסק ללא קטגוריה (הגדולים ביותר, כל הזמנים)',
    totalsTable(uncat, 'בית עסק'),
  ].join('\n');
}

function incomeBlock(month) {
  const w = cycleWindow(month, cycleDayFn);
  const income = db.prepare(`
    SELECT name, amount, day_of_month, date, active, recurring, recurring_parent_id
    FROM income ORDER BY active DESC, COALESCE(date, '9999') DESC, id DESC LIMIT 40
  `).all();
  const rec = db.prepare(`
    SELECT r.merchant, r.amount, r.freq, r.day, r.hour, r.active, r.last_added, c.name AS cat
    FROM recurring_expenses r LEFT JOIN categories c ON c.id = r.category_id
    ORDER BY r.active DESC, r.id
  `).all();
  const subs = db.prepare(`
    SELECT name, amount, end_date, remind_days, active FROM subscriptions ORDER BY end_date LIMIT 30
  `).all();
  const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  const recSum = rec.filter((r) => r.active && r.freq === 'monthly').reduce((s, r) => s + r.amount, 0)
    + rec.filter((r) => r.active && r.freq === 'weekly').reduce((s, r) => s + r.amount * 4.33, 0);
  return [
    '### הכנסות מוגדרות',
    income.length
      ? ['| שם | סכום | תאריך / יום בחודש | פעילה | חוזרת |', '|---|---|---|---|---|',
        ...income.map((r) => `| ${scrub(r.name)} | ${ils(r.amount)} | ${r.date ?? (r.day_of_month ? `${r.day_of_month} בחודש` : 'ללא תאריך')} `
          + `| ${r.active ? 'כן' : 'לא'} | ${r.recurring ? 'תבנית' : (r.recurring_parent_id ? 'מופע' : 'לא')} |`)].join('\n')
      : '(אין הכנסות מוגדרות)',
    '',
    `### הוצאות קבועות (עלות חודשית משוערת: ${ils(recSum)})`,
    rec.length
      ? ['| שם | סכום | תדירות | קטגוריה | פעילה | מופע אחרון |', '|---|---|---|---|---|---|',
        ...rec.map((r) => `| ${scrub(r.merchant)} | ${ils(r.amount)} `
          + `| ${r.freq === 'weekly' ? `כל יום ${DAYS[r.day]}` : `כל ${r.day} בחודש`}${r.hour !== null && r.hour !== undefined ? ` ב-${r.hour}:00` : ''} `
          + `| ${r.cat ?? '—'} | ${r.active ? 'כן' : 'לא'} | ${r.last_added ?? '—'} |`)].join('\n')
      : '(אין הוצאות קבועות)',
    '',
    '### מנויים במעקב חידוש',
    subs.length
      ? ['| מנוי | עלות | מועד חידוש | התראה לפני | פעיל |', '|---|---|---|---|---|',
        ...subs.map((s) => `| ${scrub(s.name)} | ${s.amount ? ils(s.amount) : '—'} | ${s.end_date} | ${s.remind_days} ימים | ${s.active ? 'כן' : 'לא'} |`)].join('\n')
      : '(אין מנויים במעקב)',
    '',
    `סה"כ בפועל במחזור: הכנסות ${ils(rangeTotals(w.start, w.end).income)}`,
  ].join('\n');
}

function payslipBlock(month) {
  const list = db.prepare('SELECT month, analysis_at, fields_json, checks_json FROM payslips ORDER BY month DESC LIMIT 24').all();
  if (!list.length) return '(לא הועלו תלושים)';
  // ברירת מחדל: התלוש של החודש שנבחר בממשק; אם אין — האחרון
  const target = list.find((r) => r.month === month) ?? list[0];
  const fields = JSON.parse(target.fields_json || '{}');
  const checks = JSON.parse(target.checks_json || '[]');
  const row = db.prepare('SELECT analysis_md FROM payslips WHERE month = ?').get(target.month);
  const trend = list.slice(0, 12).map((r) => {
    const f = JSON.parse(r.fields_json || '{}');
    return `| ${r.month} | ${f.gross ? ils(f.gross) : '—'} | ${f.net ? ils(f.net) : '—'} | ${f.income_tax ? ils(f.income_tax) : '—'} |`;
  });
  return [
    `תלושים שמורים: ${list.map((r) => r.month).join(', ')}`,
    '',
    `### התלוש המוצג — ${target.month}`,
    Object.entries(fields).length
      ? Object.entries(fields).map(([k, v]) => `- ${k}: ${fmtNum2.format(v)}`).join('\n')
      : '(לא חולצו שדות)',
    '',
    '### בדיקות מקומיות',
    checks.length ? checks.map((c) => `- ${c.label}: ${c.status} — ${c.detail}`).join('\n') : '(אין בדיקות)',
    '',
    '### מגמה (ברוטו / נטו / מס הכנסה)',
    ['| חודש | ברוטו | נטו | מס הכנסה |', '|---|---|---|---|', ...trend].join('\n'),
    '',
    row?.analysis_md
      ? `### תמצית הניתוח הקודם של התלוש\n${row.analysis_md.slice(0, 1500)}`
      : '(התלוש עדיין לא נותח)',
  ].join('\n');
}

function mortgageBlock() {
  const market = getMarketRates();
  const detail = mortgageDetail(market);
  if (!detail.updated_at && !detail.tracks.length) return '(לא הוזנו נתוני משכנתא)';
  const marketText = marketRatesSummary(market);
  return [
    '### פרטי המשכנתא',
    dataSummary(detail.data, market),
    '',
    '### המסלולים',
    tracksSummary(detail.tracks),
    '',
    '### בדיקות מקומיות',
    checksSummary(detail.checks),
    marketText ? `\n### נתוני שוק עדכניים (בנק ישראל — השתמש רק בהם)\n${marketText}` : '',
    detail.analysis_md ? `\n### תמצית הניתוח הקודם\n${detail.analysis_md.slice(0, 2000)}` : '',
  ].join('\n');
}

function settingsBlock() {
  const usage = usageSummary();
  const get = (k, d = '') => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? d;
  // סודות לא נשלחים לעולם — רק אינדיקציה אם הוגדרו
  return [
    `- מנוע ה-AI הפעיל: ${get('llm_engine', 'gemini')}`,
    `- מפתח Gemini מוגדר: ${get('gemini_api_key') ? 'כן' : 'לא'}`,
    `- טוקן טלגרם מוגדר: ${get('telegram_token') ? 'כן' : 'לא'} · משתמשים מחוברים: ${[get('telegram_chat_id'), get('telegram_chat_id_2')].filter(Boolean).length}`,
    `- יום עוגן המחזור: ${get('cycle_day', '10')}`,
    `- ימי התראה: ${get('notify_days', '0,2,4')} · שעת התראה: ${get('notify_hour', '9')}`,
    `- קיבוע מקלדת בבוט: ${get('menu_persistent', '0') === '1' ? 'מופעל' : 'כבוי'}`,
    '',
    '### שימוש במנועי ה-AI היום',
    ['| מנוע | היום | סה"כ | מוצה |', '|---|---|---|---|',
      ...Object.entries(usage.engines).map(([e, u]) => `| ${e} | ${u.count_today} | ${u.total} | ${u.exhausted ? 'כן' : 'לא'} |`)].join('\n'),
  ].join('\n');
}

/** תמצית "כללית" — לבוט, שאין לו טאבים. קצרה, ומכסה את הראשי שבכל תחום. */
function generalBlock(month) {
  const w = cycleWindow(month, cycleDayFn);
  // הוצאות קבועות ומנויים נכנסים לתמצית הכללית למרות שהיא קצרה: הן ישות
  // נפרדת וקטנה, והבוט נשאל עליהן ישירות ("מה ההוצאה הקבועה הגדולה שלי")
  const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  const rec = db.prepare(`
    SELECT merchant, amount, freq, day FROM recurring_expenses WHERE active = 1 ORDER BY amount DESC LIMIT 15
  `).all();
  const subs = db.prepare('SELECT name, amount, end_date FROM subscriptions WHERE active = 1 ORDER BY end_date LIMIT 10').all();
  const ps = db.prepare('SELECT month, fields_json FROM payslips ORDER BY month DESC LIMIT 1').get();
  const mgRow = db.prepare('SELECT tracks_json, data_json FROM mortgage WHERE id = 1').get();
  const psFields = ps ? JSON.parse(ps.fields_json || '{}') : {};
  const mgTracks = mgRow ? JSON.parse(mgRow.tracks_json || '[]') : [];
  const mgData = mgRow ? JSON.parse(mgRow.data_json || '{}') : {};
  return [
    '### הוצאות לפי קטגוריה במחזור הנוכחי',
    totalsTable(categoryTotals(w.start, w.end, 12), 'קטגוריה'),
    '',
    '### 12 העסקאות האחרונות',
    txTable(txRows(w.start, w.end, { limit: 12 })),
    '',
    '### הוצאות קבועות פעילות (ישות נפרדת — חיוב שחוזר מעצמו, לא עסקה בודדת)',
    rec.length
      ? ['| שם | סכום | תדירות |', '|---|---|---|',
        ...rec.map((r) => `| ${scrub(r.merchant)} | ${ils(r.amount)} `
          + `| ${r.freq === 'weekly' ? `כל יום ${DAYS[r.day]}` : `כל ${r.day} בחודש`} |`)].join('\n')
      : '(אין הוצאות קבועות)',
    '',
    '### מנויים במעקב חידוש',
    subs.length
      ? subs.map((s) => `- ${scrub(s.name)}${s.amount ? ` — ${ils(s.amount)}` : ''} (חידוש ${s.end_date})`).join('\n')
      : '(אין מנויים במעקב)',
    '',
    ps ? `תלוש אחרון: ${ps.month} — ברוטו ${psFields.gross ? ils(psFields.gross) : '—'}, נטו ${psFields.net ? ils(psFields.net) : '—'}` : 'לא הועלו תלושים.',
    mgTracks.length
      ? `משכנתא: ${mgTracks.length} מסלולים, יתרה ${ils(mgTracks.reduce((s, t) => s + (t.balance || 0), 0))}`
        + (mgData.monthly_payment ? `, החזר חודשי ${ils(mgData.monthly_payment)}` : '')
      : 'לא הוזנו נתוני משכנתא.',
  ].join('\n');
}

const VIEW_BLOCKS = {
  dashboard: dashboardBlock,
  transactions: transactionsBlock,
  import: importBlock,
  categories: categoriesBlock,
  income: incomeBlock,
  payslip: payslipBlock,
  mortgage: () => mortgageBlock(),
  settings: () => settingsBlock(),
  general: generalBlock,
};

/**
 * התמצית המלאה שנשלחת לפרומפט: הכותרת הגלובלית + הבלוק של הטאב הנוכחי.
 * מיוצאת לבדיקות.
 */
export function buildSnapshot(view = DEFAULT_VIEW, month = null) {
  const v = safeView(view);
  const m = safeMonth(month);
  const fn = VIEW_BLOCKS[v] ?? generalBlock;
  let block;
  try {
    block = fn(m);
  } catch (err) {
    block = `(שגיאה בבניית ההקשר של הטאב: ${err.message})`;
  }
  return [
    '## מצב כללי',
    globalBlock(m),
    '',
    `## הקשר הטאב הנוכחי — ${VIEW_LABELS[v]}`,
    block,
  ].join('\n');
}

/* ==================== שאילתות לפי דרישה (whitelist) ==================== */

/** בריחה מתווי wildcard של LIKE — קלט משתמש/מודל לא יהפוך לחיפוש רחב */
function likeTerm(s) {
  return `%${String(s ?? '').replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export const DATA_QUERIES = {
  transactions: {
    usage: 'transactions <YYYY-MM | cycle:YYYY-MM | all> [שם קטגוריה]',
    desc: 'רשימת עסקאות בטווח (עד 60), אפשר לסנן לפי קטגוריה',
    run: (args, ctx) => {
      const range = parseRange(args[0], ctx.month);
      const cat = args.slice(1).join(' ').trim() || null;
      const rows = txRows(range.start, range.end, { limit: 60, categoryName: cat });
      const t = rangeTotals(range.start, range.end);
      const hint = cat && !rows.length
        ? `\n(אולי שם הקטגוריה אינו מדויק. הקיימות: ${db.prepare('SELECT name FROM categories ORDER BY name').all().map((c) => c.name).join(', ')})`
        : '';
      return `עסקאות — ${range.label}${cat ? ` · קטגוריה: ${cat}` : ''}\n`
        + `סה"כ בטווח: ${t.n} עסקאות · הוצאות ${ils(t.expenses)} · הכנסות ${ils(t.income)}\n\n`
        + txTable(rows) + hint
        + (rows.length === 60 ? '\n\n(הוצגו 60 השורות האחרונות בלבד)' : '');
    },
  },
  search: {
    usage: 'search <טקסט חופשי>',
    desc: 'חיפוש עסקאות לפי שם בית עסק או תיאור, בכל התאריכים (עד 40)',
    run: (args) => {
      const term = args.join(' ').trim();
      if (!term) return '(לא נמסר טקסט לחיפוש)';
      const rows = db.prepare(`
        SELECT ${EFF} AS d, t.amount, t.type, t.merchant, t.description,
               COALESCE(c.name, 'ללא קטגוריה') AS cat
        FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
        WHERE (t.merchant LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\')
        ORDER BY d DESC LIMIT 40
      `).all(likeTerm(term), likeTerm(term));
      const sum = rows.reduce((s, r) => s + (r.type === 'expense' ? r.amount : 0), 0);
      return `חיפוש "${term}" — ${rows.length} תוצאות, סה"כ הוצאות ${ils(sum)}\n\n${txTable(rows)}`;
    },
  },
  top_merchants: {
    usage: 'top_merchants <YYYY-MM | cycle:YYYY-MM | all>',
    desc: 'בתי העסק עם ההוצאה הגבוהה ביותר בטווח (עד 25)',
    run: (args, ctx) => {
      const range = parseRange(args[0], ctx.month);
      return `בתי עסק — ${range.label}\n\n${totalsTable(merchantTotals(range.start, range.end, 25), 'בית עסק')}`;
    },
  },
  category_totals: {
    usage: 'category_totals <YYYY-MM | cycle:YYYY-MM | all>',
    desc: 'סכום ההוצאות לפי קטגוריה בטווח',
    run: (args, ctx) => {
      const range = parseRange(args[0], ctx.month);
      return `קטגוריות — ${range.label}\n\n${totalsTable(categoryTotals(range.start, range.end, 30), 'קטגוריה')}`;
    },
  },
  category_history: {
    usage: 'category_history <שם קטגוריה> [מספר חודשים]',
    desc: 'הוצאה חודש-אחר-חודש בקטגוריה מסוימת (עד 24 חודשים)',
    run: (args) => {
      const n = Number(args[args.length - 1]);
      const months = Number.isInteger(n) && n > 0 ? Math.min(n, 24) : 12;
      const name = (Number.isInteger(n) ? args.slice(0, -1) : args).join(' ').trim();
      if (!name) return '(לא נמסר שם קטגוריה)';
      const rows = db.prepare(`
        SELECT substr(${EFF}, 1, 7) AS m, SUM(t.amount) AS total, COUNT(*) AS n
        FROM transactions t JOIN categories c ON c.id = t.category_id
        WHERE t.type = 'expense' AND c.name = ?
        GROUP BY m ORDER BY m DESC LIMIT ?
      `).all(name, months);
      if (!rows.length) {
        // שם קטגוריה חייב להיות מדויק — מחזירים את הרשימה כדי שהמודל יוכל
        // לתקן בשליפה הבאה במקום להסיק שאין נתונים
        const names = db.prepare('SELECT name FROM categories ORDER BY name').all().map((c) => c.name);
        return `(אין עסקאות בקטגוריה "${name}". הקטגוריות הקיימות: ${names.join(', ')})`;
      }
      const avg = rows.reduce((s, r) => s + r.total, 0) / rows.length;
      return `קטגוריה "${name}" — ${rows.length} חודשים, ממוצע ${ils(avg)} לחודש\n\n`
        + ['| חודש | סה"כ | עסקאות |', '|---|---|---|',
          ...rows.map((r) => `| ${r.m} | ${ils(r.total)} | ${r.n} |`)].join('\n');
    },
  },
  monthly_totals: {
    usage: 'monthly_totals [מספר חודשים]',
    desc: 'סיכום הכנסות והוצאות לפי חודש קלנדרי (עד 36)',
    run: (args) => {
      const n = Number(args[0]);
      const rows = monthlyTotals(Number.isInteger(n) && n > 0 ? Math.min(n, 36) : 12);
      if (!rows.length) return '(אין עסקאות)';
      return ['| חודש | הכנסות | הוצאות | מאזן | עסקאות |', '|---|---|---|---|---|',
        ...rows.map((r) => `| ${r.m} | ${ils(r.income)} | ${ils(r.expenses)} | ${ils(r.income - r.expenses)} | ${r.n} |`)].join('\n');
    },
  },
  payslip: {
    usage: 'payslip <YYYY-MM>',
    desc: 'שדות התלוש והבדיקות המקומיות לחודש מסוים',
    run: (args) => {
      const m = args[0];
      if (!MONTH_RE.test(String(m ?? ''))) return '(חודש לא תקין — צפוי YYYY-MM)';
      const row = db.prepare('SELECT month, fields_json, checks_json, analysis_md FROM payslips WHERE month = ?').get(m);
      if (!row) return `(לא נמצא תלוש לחודש ${m})`;
      const fields = JSON.parse(row.fields_json || '{}');
      const checks = JSON.parse(row.checks_json || '[]');
      return `תלוש ${row.month}\n`
        + Object.entries(fields).map(([k, v]) => `- ${k}: ${fmtNum2.format(v)}`).join('\n')
        + (checks.length ? `\n\nבדיקות:\n${checks.map((c) => `- ${c.label}: ${c.status} — ${c.detail}`).join('\n')}` : '')
        + (row.analysis_md ? `\n\nניתוח קודם (תמצית):\n${row.analysis_md.slice(0, 1200)}` : '');
    },
  },
  payslip_list: {
    usage: 'payslip_list',
    desc: 'כל התלושים השמורים עם ברוטו ונטו',
    run: () => {
      const rows = db.prepare('SELECT month, fields_json FROM payslips ORDER BY month DESC LIMIT 36').all();
      if (!rows.length) return '(לא הועלו תלושים)';
      return ['| חודש | ברוטו | נטו | מס הכנסה | ביטוח לאומי |', '|---|---|---|---|---|',
        ...rows.map((r) => {
          const f = JSON.parse(r.fields_json || '{}');
          return `| ${r.month} | ${f.gross ? ils(f.gross) : '—'} | ${f.net ? ils(f.net) : '—'} `
            + `| ${f.income_tax ? ils(f.income_tax) : '—'} | ${f.national_insurance ? ils(f.national_insurance) : '—'} |`;
        })].join('\n');
    },
  },
  mortgage: {
    usage: 'mortgage',
    desc: 'נתוני המשכנתא המלאים, המסלולים, הבדיקות ונתוני השוק',
    run: () => mortgageBlock(),
  },
  recurring: {
    usage: 'recurring',
    desc: 'הוצאות קבועות, הכנסות מוגדרות ומנויים במעקב',
    run: (_args, ctx) => incomeBlock(ctx.month),
  },
  installments: {
    usage: 'installments',
    desc: 'תוכניות תשלומים (עסקה שפוצלה לתשלומים חודשיים)',
    run: () => {
      const rows = db.prepare(`
        SELECT installment_group AS g, COUNT(*) AS n, SUM(amount) AS total,
               MIN(date) AS first, MAX(date) AS last, MIN(merchant) AS merchant
        FROM transactions WHERE installment_group IS NOT NULL
        GROUP BY installment_group ORDER BY first DESC LIMIT 30
      `).all();
      if (!rows.length) return '(אין תוכניות תשלומים)';
      return ['| בית עסק | תשלומים | סה"כ | ראשון | אחרון |', '|---|---|---|---|---|',
        ...rows.map((r) => `| ${scrub(r.merchant)} | ${r.n} | ${ils(r.total)} | ${r.first} | ${r.last} |`)].join('\n');
    },
  },
  categories: {
    usage: 'categories',
    desc: 'רשימת הקטגוריות וכללי הקטגוריזציה',
    run: (_args, ctx) => categoriesBlock(ctx.month),
  },
};

export const DATA_QUERY_NAMES = Object.keys(DATA_QUERIES);

/** שורת #DATA בודדת → { name, args } (או null אם אינה בפורמט) */
function parseDataLine(line) {
  const m = String(line).trim().match(/^#DATA:?\s+(\S+)\s*(.*)$/i);
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (!Object.hasOwn(DATA_QUERIES, name)) return { name, args: [], unknown: true };
  return { name, args: m[2].trim() ? m[2].trim().split(/\s+/) : [] };
}

/**
 * זיהוי בקשת נתונים בתשובת המודל. מוכר רק כשהשורה הראשונה שאינה ריקה מתחילה
 * ב-#DATA — כדי ש-"#DATA" שמופיע בתוך תשובה ארוכה לא ייחשב בקשה.
 * מחזיר { name, args } או null. מיוצא לבדיקות.
 */
export function parseDataRequest(text) {
  const first = String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean);
  return first ? parseDataLine(first) : null;
}

/**
 * כל שורות ה-#DATA הרצופות בראש התשובה. שליפה מרובה בסבב אחד היא החיסכון
 * הגדול בזמן: כל סבב הוא הרצה נוספת של ה-CLI + הסקה (8–60 שניות), ולכן עדיף
 * שהמודל יבקש הכול בבת אחת מאשר שאילתה אחת בכל פעם.
 * מוגבל ל-MAX_QUERIES_PER_ROUND. מיוצא לבדיקות.
 */
export const MAX_QUERIES_PER_ROUND = 3;
export function parseDataRequests(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) { if (out.length) break; continue; }   // שורה ריקה אחרי בקשות = סוף הבלוק
    const req = parseDataLine(t);
    if (!req) break;                               // טקסט רגיל = לא בקשה
    out.push(req);
    if (out.length >= MAX_QUERIES_PER_ROUND) break;
  }
  return out;
}

/** הרצת שאילתה מהרשימה הלבנה. תמיד מחזירה מחרוזת (גם בשגיאה). */
export function runDataQuery(name, args, ctx = {}) {
  const q = DATA_QUERIES[name];
  if (!q) return `(שאילתה לא מוכרת: ${name})`;
  try {
    return String(q.run(args, { month: safeMonth(ctx.month) }) ?? '').slice(0, MAX_BLOCK_CHARS);
  } catch (err) {
    return `(השאילתה נכשלה: ${err.message})`;
  }
}

/* ==================== הפרומפט ==================== */

// כללי הפלט — זהים לאלה של התלוש והמשכנתא, כי אותו רינדור מציג את שלושתם
// (renderMarkdown + stripLatex ב-web, stripLatexPlain בבוט).
const OUTPUT_RULES = `## כללי מענה (חובה)
- ענה בעברית, ב-Markdown, קצר וישיר. בלי הקדמות ובלי חזרה על השאלה.
- **אסור סימון LaTeX או מתמטי**: בלי \\text, \\mathbf, \\frac, \\times, ובלי $ או \\( \\). נוסחאות כטקסט רגיל: "4,500 × 12 = 54,000 ש"ח".
- סכומים בפורמט ישראלי עם פסיק אלפים וסימן ש"ח. אחוזים עם ספרה אחת אחרי הנקודה.
- **אל תמציא מספרים**. השתמש אך ורק בנתונים שמופיעים למטה או שקיבלת דרך שליפת נתונים.
- נתון שאינו בתמצית **אינו נתון חסר** — הוא נתון שלא שלפת. אל תכתוב "אין נתונים" לפני שניסית לשלוף אותו. רק אם השליפה חזרה ריקה — דווח שאין.
- הפרד בין נתון שמופיע בנתונים לבין חישוב או הערכה שביצעת.
- טבלאות Markdown להשוואות — הן מוצגות יפה בממשק.
- מין המשתמש אינו ידוע — נסח בלשון ניטרלית ("כדאי לבדוק", "אפשר לצמצם").
- אל תמליץ על מוצרים פיננסיים ספציפיים ואל תציג את עצמך כיועץ מוסמך.`;

function queriesHelp() {
  return Object.entries(DATA_QUERIES)
    .map(([name, q]) => `- \`${q.usage}\` — ${q.desc}`)
    .join('\n');
}

const PROTOCOL = (roundsLeft) => `## שלב ראשון — בדוק אם חסרים לך נתונים (לפני שאתה כותב תשובה)
התמצית שלמטה מכסה **רק את המחזור הנוכחי ואת הטאב הפעיל** — היא חלק זעיר מה-DB,
שמכיל שנים של עסקאות, תלושים והיסטוריה. אתה יכול לשלוף ממנו בעצמך.

**חובה לשלוף** (ולא לענות ישירות) כאשר השאלה נוגעת ל:
- תקופה שאינה המחזור הנוכחי — "6 החודשים האחרונים", "השנה", חודש מסוים, "מתי התחלתי";
- קטגוריה או בית עסק לאורך זמן, השוואה בין חודשים, ממוצעים או מגמות;
- כל נתון שאינו מופיע מילולית בתמצית שלמטה.

איך שולפים: החזר **שורות #DATA בלבד**, בלי שום טקסט לפניהן או אחריהן (בלי הסבר, בלי התנצלות):

#DATA <שם שאילתה> <ארגומנטים>

**בקש בבת אחת את כל מה שתצטרך — עד ${MAX_QUERIES_PER_ROUND} שורות.** כל סבב שליפה עולה זמן המתנה
ארוך למשתמש, ולכן עדיף לשלוף שלוש שאילתות יחד מאשר אחת בכל פעם. בספק — בקש יותר.

דוגמה לשליפה מרובה:
#DATA category_history סופר 6
#DATA monthly_totals 6

דוגמאות נוספות: \`#DATA search דלק\` · \`#DATA transactions cycle:2026-07 סופר\`

השאילתות המותרות (רק אלה — כל שם אחר ייכשל):
${queriesHelp()}

### בחירת השאילתה הנכונה — התאם לסוג השאלה
- שאלה על **קטגוריה מסוימת** לאורך זמן ("כמה על סופר ב-6 חודשים") → \`category_history <שם הקטגוריה> <מספר חודשים>\`. שם הקטגוריה חייב להיות מדויק כפי שהוא מופיע בתמצית.
- שאלה על **סך ההוצאות או ההכנסות** לפי חודש, בלי פילוח → \`monthly_totals\`.
- שאלה על **חלוקה בין קטגוריות** בתקופה אחת → \`category_totals\`.
- שאלה על **בית עסק מסוים** או שם חופשי ("כמה בזלים", "מתי קניתי ב-IKEA") → \`search\`.
- שאלה על **רשימת עסקאות** בחודש או במחזור → \`transactions\`.
- שאלה על **תלוש, משכורת, מס** → \`payslip_list\` או \`payslip <חודש>\`.
- שאלה על **משכנתא, ריבית, מיחזור** → \`mortgage\`.
- שאלה על **הוצאה קבועה / הוצאות קבועות / מנוי / מנויים / הכנסה קבועה** → \`recurring\`. שים לב: "הוצאה קבועה" היא ישות נפרדת באפליקציה (חיוב שחוזר כל חודש או שבוע) — **לא** "ההוצאה הגדולה ביותר" ולא עסקה רגילה.

נותרו לך ${roundsLeft} שליפות. אם השליפה הראשונה לא ענתה על השאלה — שלוף שוב שאילתה אחרת
במקום להתפשר על תשובה חלקית. תשובה שכותבת "אין נתונים" בלי ששלפת קודם — שגויה.
אחרי השליפה האחרונה חובה לענות תשובה מלאה עם מה שיש.`;

/**
 * בניית הפרומפט. dataBlocks = תוצאות שאילתות שכבר בוצעו בסבב הזה.
 * מיוצאת לבדיקות.
 */
export function buildChatPrompt({
  question, view = DEFAULT_VIEW, month = null, history = [], snapshot = null,
  dataBlocks = [], roundsLeft = MAX_ROUNDS,
}) {
  const v = safeView(view);
  const m = safeMonth(month);
  const snap = snapshot ?? buildSnapshot(v, m);
  // ההיסטוריה שימושית להמשכיות, אבל בלי הסתייגות מפורשת היא "מושכת" את
  // השליפה לנושא הקודם (נמדד: שאלה על הוצאות קבועות נשלפה כעסקאות בקטגוריה
  // שנדונה בשאלה הקודמת).
  const prior = history.length
    ? '\n## השיחה עד כה (רקע בלבד)\n' + history.map((h, i) => `${i + 1}. ש: ${h.q}\n   ת: ${h.a}`).join('\n')
      + '\n\n**השאלה החדשה עומדת בפני עצמה.** אל תגרור אליה קטגוריה, חודש או נושא מהשיחה הקודמת אלא אם היא מפנה אליהם במפורש ("ומה לגבי…", "וביוני?").\n'
    : '';
  const data = dataBlocks.length
    ? '\n## נתונים שנשלפו לבקשתך\n' + dataBlocks.map((b) => `### ${b.title}\n${b.text}`).join('\n\n')
      + (roundsLeft > 0
        ? '\n\n**אם הנתונים האלה עדיין לא עונים על השאלה — שלוף שאילתה אחרת (#DATA) במקום לענות תשובה חלקית.**\n'
        : '\n')
    : '';
  // סדר הסעיפים אינו מקרי: פרוטוקול השליפה מופיע **לפני** כללי המענה. כשהיה
  // אחריהם, המודל העדיף את הכלל "אם נתון חסר — אמור זאת" וענה מהתמצית בלבד
  // במקום לשלוף (נמדד בפועל מול Codex).
  return `אתה העוזר האישי של MoneySaver — אפליקציה לוקאלית לניהול הוצאות של משתמש יחיד בישראל.
המשתמש נמצא כרגע בטאב "${VIEW_LABELS[v]}" ושואל שאלה. ענה עליה על סמך הנתונים שלו בלבד.

${roundsLeft > 0 ? PROTOCOL(roundsLeft) : '## שליפת נתונים\nמיצית את מכסת השליפות. ענה עכשיו תשובה מלאה על סמך מה שיש, וציין במפורש כל נתון שחסר.'}

${OUTPUT_RULES}

${snap}
${data}${prior}
## השאלה
${question}`;
}

/* ==================== היסטוריה ==================== */

/** N החילופים האחרונים, מהישן לחדש (הסדר שהמודל מצפה לו) */
export function chatHistory(limit = MAX_HISTORY) {
  const rows = db.prepare(`
    SELECT id, view, question AS q, answer AS a, model, source, created_at AS at
    FROM chat_history ORDER BY id DESC LIMIT ?
  `).all(Math.min(Math.max(Number(limit) || MAX_HISTORY, 1), MAX_HISTORY));
  return rows.reverse();
}

export function saveChatEntry({ view, question, answer, model, source }) {
  db.prepare(`
    INSERT INTO chat_history (view, question, answer, model, source) VALUES (?, ?, ?, ?, ?)
  `).run(safeView(view), String(question), String(answer), String(model ?? ''), source === 'bot' ? 'bot' : 'web');
  // גיזום — שומרים MAX_HISTORY אחרונים בלבד, כך שהטבלה לא גדלה ללא גבול
  db.prepare(`
    DELETE FROM chat_history WHERE id NOT IN (SELECT id FROM chat_history ORDER BY id DESC LIMIT ?)
  `).run(MAX_HISTORY);
  return chatHistory();
}

export function clearChatHistory() {
  db.prepare('DELETE FROM chat_history').run();
}

/* ==================== התזמור ==================== */

/**
 * שאלה חופשית. מריץ את לולאת הפרומפט → (#DATA) → פרומפט, ושומר בהיסטוריה.
 * מחזיר { text, model, engine, fellBack, queries } ; זורק Error בהודעה בעברית.
 */
export async function askAssistant({ question, view = DEFAULT_VIEW, month = null, source = 'web', save = true }) {
  const q = String(question ?? '').trim();
  if (!q) throw new Error('לא נשלחה שאלה');
  if (q.length > MAX_QUESTION) throw new Error(`השאלה ארוכה מדי (עד ${MAX_QUESTION} תווים)`);

  const v = safeView(view);
  const m = safeMonth(month);
  // מהשאלה מוסרים רק מזהים חד-משמעיים (ת"ז, טלפון). ההסרה המלאה של stripPii
  // תלוית-הקשר הייתה ממסכת גם "כמה שילמתי לבנק ב-2026" ושוברת את הפיצ'ר;
  // הנתונים מה-DB עצמם עוברים ניקוי מלא (scrub) בבניית התמצית.
  const cleanQ = stripIdentifiers(q).text;

  const history = chatHistory().slice(-PROMPT_HISTORY);
  const snapshot = buildSnapshot(v, m);
  const dataBlocks = [];
  let last = null;

  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const prompt = buildChatPrompt({
      question: cleanQ, view: v, month: m, history, snapshot, dataBlocks,
      roundsLeft: MAX_ROUNDS - round,
    });
    // FAST_MODEL — הצ'אט הוא שאלות קצרות שבהן ההמתנה מורגשת מיד, ולכן רץ על
    // מודל מהיר יותר מהדיפולט. רלוונטי ל-Codex בלבד; Gemini מתעלם.
    last = await llmAnalyze(prompt, { codexModel: FAST_MODEL });
    const reqs = round < MAX_ROUNDS ? parseDataRequests(last.text) : [];
    if (!reqs.length) break;
    for (const req of reqs) {
      dataBlocks.push({
        title: req.unknown ? `${req.name} (שאילתה לא מוכרת)` : `${req.name} ${req.args.join(' ')}`.trim(),
        text: req.unknown
          ? `(אין שאילתה בשם "${req.name}". השאילתות המותרות: ${DATA_QUERY_NAMES.join(', ')})`
          : runDataQuery(req.name, req.args, { month: m }),
      });
    }
  }

  // רשת ביטחון: אם המודל סיים בבקשת נתונים למרות שנגמרו הסבבים — לא מציגים
  // למשתמש שורת פרוטוקול גולמית
  if (parseDataRequest(last.text)) {
    last = { ...last, text: 'לא הצלחתי לאתר את הנתונים הדרושים לשאלה הזו. נסה לנסח אותה בצורה ממוקדת יותר (למשל: לציין חודש או קטגוריה).' };
  }

  const entry = {
    q, a: last.text, model: last.model, view: v,
    at: new Date().toISOString().slice(0, 19).replace('T', ' '),
  };
  const updated = save
    ? saveChatEntry({ view: v, question: q, answer: last.text, model: last.model, source })
    : chatHistory();

  return {
    entry,
    history: updated,
    text: last.text,
    model: last.model,
    engine: last.engine,
    fellBack: last.fellBack,
    queries: dataBlocks.map((b) => b.title),
  };
}
