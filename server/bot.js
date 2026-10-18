// bot.js — בוט טלגרם: פאריטי מלא מול ה-web (CRUD דרך inline keyboards) + הרשאה + התראות
import os from 'node:os';
import { Bot, Keyboard, InlineKeyboard } from 'grammy';
import { db, getSetting, setSetting } from './db.js';
import { addTransaction, findDuplicate } from './lib/addTransaction.js';
import { parseSms, looksLikeBankSms } from './lib/smsParser.js';
import { parseTextExpense } from './lib/textExpense.js';
import { parseCsv, parsePdf, enrichRows, commitRows, extractPdfText } from './lib/importer.js';
import { detectMonth, storePayslip, payslipFields, prevMonth, buildAnalysisPrompt, buildQuestionPrompt, stripLatexPlain, splitMessage, MONTH_RE } from './lib/payslip.js';
import { llmAnalyze, llmReady } from './lib/llm.js';
import { askAssistant, chatHistory, clearChatHistory } from './lib/assistant.js';
import { parseImage } from './lib/ocr.js';
import { validateUserRegex } from './lib/safeRegex.js';
import { addInstallments, deleteInstallmentGroup, tagInstallment, listInstallmentGroups, installmentsCategoryTotal, installmentChargeDetails } from './lib/installments.js';
import { normalizeDayMonth, localDate, cycleWindow, cycleAnchorForToday } from './lib/dates.js';
import { computeFlow, computeCycleFlow, cycleDaySetting, cycleDayFn, cycleDayForMonth } from './routes/flow.js';
import { dueSubscriptions, markReminded, renewSubscription } from './routes/subscriptions.js';
import { runRecurring } from './lib/recurring.js';
import { templateDay } from './lib/recurringIncome.js';
import { forecastMonth, mlStatus, mlTrain } from './lib/ml.js';
import { labeledData } from './lib/categorize.js';
import { assignCategory, merchantPeers } from './lib/categoryAssign.js';
import { scanDuplicates, ignoreDuplicateGroup, clearIgnoredDuplicates, ignoredCount } from './lib/duplicates.js';
import { activityMessage, importMessage, deliverNotification } from './lib/sharedNotifications.js';

let bot = null;
let status = { active: false, error: null };
let notifyTimer = null;

// state לקלט טקסט רב-שלבי (per chat): { action, data }
const pending = new Map();
// תצוגות ייבוא ממתינות לאישור (per chat): { source, rows }
const pendingImport = new Map();

const fmtILS = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });
const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// escape לתווי Markdown (legacy) בטקסט חופשי — שמות עסק כמו "OPENAI *CHATGPT" שוברים אחרת
function escapeMd(s) {
  return String(s ?? '').replace(/([_*`[\]])/g, '\\$1');
}

const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

// הזזת חודש (מחרוזת 'YYYY-MM') ב-delta חודשים, עם גלישת שנה
function shiftMonthStr(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthLabelHe(month) {
  const [y, m] = month.split('-').map(Number);
  return `${HE_MONTHS[m - 1]} ${y}`;
}
// תוויות קומפקטיות לכפתור הניווט האמצעי בבוט בלבד — טקסט מלא לא נראה על כפתור
// Telegram (נחתך). טקסט ההודעה עצמו (שאינו כפתור) ממשיך להציג תווית מלאה.
function monthLabelShort(month) {
  return month.slice(5, 7); // "MM" בלבד
}
function cycleLabelShort(start, end) {
  return `${start.slice(5, 7)} - ${end.slice(5, 7)}`; // "MM - MM"
}

/**
 * החלטת הרשאה — פונקציה טהורה (בדיקה ביחידה).
 * @returns 'allow' | 'claim' | 'deny'
 *   claim = אין עדיין בעלים; רק /start רשאי לתבוע בעלות
 *   deny  = יש בעלים והפונה אינו הוא → חסימה
 */
export function authDecision(fromId, ownerId, isStart) {
  const from = String(fromId ?? '');
  const owner = String(ownerId ?? '');
  if (!owner) return isStart ? 'allow' : 'claim';
  return from === owner ? 'allow' : 'deny';
}

/**
 * גרסה דו-בעלים, הרשאות זהות (למשל בני/בנות זוג) — פונקציה טהורה (בדיקה ביחידה).
 * owner1 מוקצה ראשון (זהה ל-authDecision); owner2 נתבע רק דרך /start כשowner1 כבר תפוס.
 * @returns 'allow' | 'claim' | 'deny'
 */
export function authDecisionMulti(fromId, owner1, owner2, isStart) {
  const from = String(fromId ?? '');
  const o1 = String(owner1 ?? '');
  const o2 = String(owner2 ?? '');
  if (o1 && from === o1) return 'allow';
  if (o2 && from === o2) return 'allow';
  if (!o1) return isStart ? 'allow' : 'claim'; // slot 1 פנוי
  if (!o2) return isStart ? 'allow' : 'deny';  // slot 1 תפוס, slot 2 פנוי — נתבע רק דרך /start
  return 'deny';                                // שני ה-slots תפוסים ולא תואם
}

// מקלדת התפריט. is_persistent רק דרך הדגל menu_persistent (ברירת מחדל כבוי!) —
// הדגל גרם בעבר ללולאת back ב-Android (הקליינט כופה את המקלדת מחדש אחרי "חזרה").
// המשתמש יכול לנסות להפעיל בהגדרות; אם ה-back נתקע — /settings (פקודת טקסט,
// עובדת תמיד) מכבה מיד. שכבת הבסיס: כל תשובת טקסט מצרפת מחדש את MENU.
export function buildMenu(persistent = getSetting('menu_persistent', '0') === '1') {
  // חיזוי הוסר מהמקלדת לבקשת המשתמש (הגדרות תפס את מקומו). הפקודה /forecast
  // ו-openForecast עדיין קיימות — להחזרת הכפתור: החלף '⚙️ הגדרות' חזרה ל-'🔮 חיזוי'.
  const kb = new Keyboard()
    .text('🏠 דשבורד').text('📋 עסקאות').row()
    .text('🏷️ קטגוריות').text('💵 הכנסות והוצאות').row()
    .text('⚙️ הגדרות').text('📥 ייבוא').row()
    .text('💬 שאלה חופשית')
    .resized();
  return persistent ? kb.persistent() : kb;
}
let MENU = buildMenu();

// תוויות הכפתורים הקבועים (reply keyboard) + מילות ניווט — לחיצה עליהן מבטלת
// זרימת קלט ממתינה (escape hatch ב-middleware). חייב להישאר תואם ל-buildMenu().
const NAV_LABELS = new Set([
  '🏠 דשבורד', '📋 עסקאות', '🏷️ קטגוריות', '💵 הכנסות והוצאות',
  '⚙️ הגדרות', '📥 ייבוא', '💬 שאלה חופשית', 'תפריט', 'menu',
]);

function lanUrl() {
  const nets = os.networkInterfaces();
  const lan = Object.values(nets).flat().find((n) => n?.family === 'IPv4' && !n.internal)?.address;
  return lan ? `http://${lan}:3000` : 'http://localhost:3000';
}

/* ==================== תצוגות טקסט (read) ==================== */
// הדשבורד עובד לפי מחזור תזרים 10→10 (כמו ה-web) — נעוץ זמנית על מחזור
// יולי–אוגוסט לפי בקשת המשתמש, עד הודעה חדשה.
// עוגן המחזור הנוכחי. **פונקציה ולא קבוע** — קבוע היה נקפא בעליית
// התהליך, והשרת רץ בלי restart ימים. מוערך בכל קריאה (ברירת מחדל
// של פרמטר מחושבת מחדש בכל קריאה), כך שהמעבר למחזור הבא קורה לבד.
const currentCycleAnchor = () => cycleAnchorForToday(cycleDayFn);

export async function flowMessage(anchorMonth = currentCycleAnchor()) {
  const flow = computeCycleFlow(anchorMonth);
  const lines = [
    `💰 *מצב התזרים — ${flow.label}*`, '',
    `נשאר להוציא במחזור: *${fmtILS.format(flow.remaining)}*`,
    `הכנסות: ${fmtILS.format(flow.total_income)} · הוצאות: ${fmtILS.format(flow.actual_expenses)}`,
  ];
  if (flow.days_left > 0 && flow.daily_budget > 0) {
    lines.push(`תקציב יומי: ${fmtILS.format(flow.daily_budget)} (${flow.days_left} ימים נותרו)`);
  }
  // חיזוי סוף מחזור — מוסתר כרגע לבקשת המשתמש (זמין בטאב "חיזוי" / forecastMessage)
  if (flow.by_category.length) {
    lines.push('', '*לפי קטגוריות:*');
    // ‏ (RLM) בתחילת השורה — כופה כיוון RTL כדי ששם קטגוריה לועזי (PayBox / BIT)
    // לא יהפוך את סדר השורה משמאל לימין
    for (const c of flow.by_category) lines.push(`‏${c.icon} ${c.name}: ${fmtILS.format(c.total)}`);
  }
  return lines.join('\n');
}

// דשבורד עם ניווט מחזורים (הבא/[טווח]/קודם) — inline; ה-MENU (reply keyboard) נשאר דבוק
async function dashView(anchorMonth = currentCycleAnchor()) {
  const w = cycleWindow(anchorMonth, cycleDayFn);
  const kb = new InlineKeyboard()
    .text('הבא ◀', `dash:mon:${shiftMonthStr(anchorMonth, 1)}`)
    .text(cycleLabelShort(w.start, w.end), 'noop')
    .text('▶ קודם', `dash:mon:${shiftMonthStr(anchorMonth, -1)}`);
  return { text: await flowMessage(anchorMonth), keyboard: kb };
}

async function forecastMessage() {
  const month = currentMonth();
  const flow = computeFlow(month);
  const fc = await forecastMonth(month);
  const predicted = fc.predicted_expenses ?? flow.actual_expenses;
  const lines = [
    '🔮 *חיזוי סוף חודש*', '',
    `הוצא עד כה: ${fmtILS.format(flow.actual_expenses)}`,
    `הוצאות חזויות: *${fmtILS.format(predicted)}*`,
    `יתרה צפויה: *${fmtILS.format(flow.total_income - predicted)}*`,
  ];
  if (fc.method) lines.push('', `שיטה: ${fc.method}${fc.months_used ? ` (${fc.months_used} חודשי היסטוריה)` : ''}`);
  return lines.join('\n');
}

/* ==================== עסקאות (inline) ==================== */
const TX_PAGE = 10; // עסקאות לעמוד ברשימת החודש

// חיפוש — כפתור לכל תוצאה (בלי עימוד; טקסט חיפוש חופשי לא בטוח ב-callback_data)
function txSearchView(filter) {
  const rows = db.prepare(`
    SELECT t.*, c.icon AS category_icon FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    WHERE (t.merchant LIKE ? OR t.description LIKE ?) ORDER BY t.date DESC, t.id DESC LIMIT 12
  `).all(`%${filter}%`, `%${filter}%`);
  const kb = new InlineKeyboard();
  for (const t of rows) {
    const sign = t.type === 'income' ? '+' : '−';
    const icon = t.type === 'income' ? '💵' : (t.category_icon || '💳');
    const inst = t.installment_group ? ` (${t.description})` : '';
    kb.text(`${icon} ${(t.merchant || '—').slice(0, 20)}${inst} ${sign}${fmtILS.format(t.amount)}`, `tx:view:${t.id}`).row();
  }
  kb.text('🔍 חיפוש', 'tx:search').text('🏠 דשבורד', 'nav:dash');
  const title = `📋 *תוצאות חיפוש "${escapeMd(filter)}"*`;
  return { text: rows.length ? title : `${title}\n\nלא נמצאו עסקאות.`, keyboard: kb };
}

// רשימת עסקאות של חודש — טקסט ממוספר קומפקטי + עימוד; לעריכה/מחיקה שולחים
// מספר או שם בית עסק אחרי לחיצה על "ניהול עסקה" (ראו tx:manage ב-handleCallback)
function txListView(filter = null, month = currentMonth(), page = 0) {
  if (filter) return txSearchView(filter);

  const { total } = db.prepare(
    "SELECT COUNT(*) AS total FROM transactions WHERE substr(COALESCE(charge_date, date), 1, 7) = ?"
  ).get(month);
  const pages = Math.max(1, Math.ceil(total / TX_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const rows = db.prepare(`
    SELECT t.*, c.icon AS category_icon FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    WHERE substr(COALESCE(t.charge_date, t.date), 1, 7) = ? ORDER BY COALESCE(t.charge_date, t.date) DESC, t.id DESC LIMIT ? OFFSET ?
  `).all(month, TX_PAGE, page * TX_PAGE);

  const kb = new InlineKeyboard();
  // ניווט חודשים
  kb.text('הבא ◀', `tx:mon:${shiftMonthStr(month, 1)}`)
    .text(monthLabelShort(month), 'noop')
    .text('▶ קודם', `tx:mon:${shiftMonthStr(month, -1)}`).row();
  // ניווט עמודים (רק אם יש יותר מעמוד אחד)
  if (pages > 1) {
    if (page < pages - 1) kb.text('הבא ◀', `tx:page:${month}:${page + 1}`);
    kb.text(`עמ' ${page + 1}/${pages}`, 'noop');
    if (page > 0) kb.text('▶ הקודם', `tx:page:${month}:${page - 1}`);
    kb.row();
  }
  kb.text('🔁 כפילויות', 'tx:dups').row();
  kb.text('✏️ ניהול עסקה', `tx:manage:${month}:${page}`).text('🏠 דשבורד', 'nav:dash');

  // ‏ (RLM) בתחילת כל שורה — כופה כיוון RTL כדי ששם עסק לועזי (MOJO) יופיע כמו עברי
  const lines = rows.map((t, i) => {
    const sign = t.type === 'income' ? '+' : '−';
    const inst = t.installment_group ? ` · ${escapeMd(t.description)}` : '';
    // בלי מקף מפריד לפני הסכום — הסימן (−/+) כבר משמש כמפריד, ושניהם יחד
    // נראו בעברית כשני מקפים רצופים ("צ'ק — −445 ₪")
    return `‏${i + 1}. ${t.date.slice(8)}/${t.date.slice(5, 7)} ${escapeMd(t.merchant || '—')}${inst} ${sign} ${fmtILS.format(t.amount)}`;
  });
  const title = `📋 *עסקאות — ${monthLabelHe(month)}*`;
  const hint = total ? '\n\nלעריכה/מחיקה: "✏️ ניהול עסקה" ואז שלח מספר מהרשימה או שם בית עסק.' : '';
  const text = total
    ? `${title}\n\n${lines.join('\n')}${hint}`
    : `${title}\n\nאין עסקאות. שלח "קפה גרג 25" להוספה.`;
  return { text, keyboard: kb };
}

// שיוך העסקה למחזור החיוב הבא, או ביטול השיוך. משותף לפירוט העסקה
// (`tx:chg`) ולפאנל הכפילויות (`tx:dupchg`). מקביל ל-`charge_date: 'next'`
// ב-`PUT /api/transactions/:id`, כולל חישוב ממועד התשלום בתוכנית מיובאת.
// מחזיר false אם העסקה נמחקה בינתיים (הודעה ישנה בצ'אט עם כפתור ישן).
function setChargeDate(id, mode) {
  const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  if (!t) return false;
  const charge = installmentChargeDetails(t, mode === 'next' ? 'next' : null, cycleDayFn);
  db.prepare('UPDATE transactions SET charge_date = ?, installment_charge_index = ? WHERE id = ?')
    .run(charge.charge_date, charge.installment_charge_index, id);
  return true;
}

function txDetailView(id) {
  const t = db.prepare(`
    SELECT t.*, c.name AS category_name, c.icon AS category_icon
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?
  `).get(id);
  if (!t) return { text: 'העסקה נמחקה.', keyboard: new InlineKeyboard().text('◀ רשימה', 'tx:list') };
  const sign = t.type === 'income' ? '+' : '−';
  const text = [
    `${t.type === 'income' ? '💵' : (t.category_icon || '💳')} *${t.merchant || '—'}*`, '',
    `סכום: *${sign}${fmtILS.format(t.amount)}*`,
    `תאריך: ${t.date}`,
    ...(t.installment_group ? [`תשלום: ${escapeMd(t.description)}`] : []),
    `קטגוריה: ${t.category_name ? `${t.category_icon} ${t.category_name}` : '— ללא —'}`,
    ...(t.charge_date ? [`מחזור חיוב: הועבר למחזור הבא`] : []),
    `מקור: ${t.source}`,
  ].join('\n');
  const kb = new InlineKeyboard()
    .text('🗑 מחק', `tx:delask:${id}`).text('✏️ קטגוריה', `tx:cat:${id}`).row();
  if (t.type === 'expense') {
    kb.text('🔢 תשלומים', `tx:inst:${id}`)
      .text(t.charge_date ? '📅 בטל העברת מחזור' : '📅 העבר למחזור הבא', `tx:chg:${id}:${t.charge_date ? 'clear' : 'next'}`).row();
  }
  kb.text('◀ רשימה', 'tx:list');
  return { text, keyboard: kb };
}

// כפילויות שכבר ב-DB. מקור אמת משותף עם ה-web (`scanDuplicates`).
// המחיקה עוברת ב-`tx:delask` — אותו מסך אישור כמו כל מחיקת עסקה.
// לצד המחיקה יש `tx:dupchg` — "זו לא כפילות, זה החיוב של המחזור הבא":
// מסמן charge_date ובכך מפריד את השורה מזו שכבר נספרה במחזור הקודם,
// והקבוצה יורדת מהרשימה. פעולה הפיכה, ולכן בלחיצה אחת (בשונה ממחיקה).
// ו-`tx:dupok` — "אלו חיובים נפרדים" (שלוש כרטיסיות רכבת באותו יום, כל אחת
// עם מספר עסקה משלה בדוח): שומר את זוגות הקבוצה ב-duplicate_ignores בלי
// לגעת בנתונים. הפיך דרך `tx:dupclr`. parity מלא מול הפאנל ב-web.
const DUP_GROUPS_PER_VIEW = 5;
export function duplicatesView() {
  const groups = scanDuplicates();
  const ignored = ignoredCount();
  const kb = new InlineKeyboard();
  const restoreRow = () => {
    if (ignored) kb.text(`↩️ שחזר ${ignored} סימוני "לא כפילות"`, 'tx:dupclr').row();
  };
  if (!groups.length) {
    restoreRow();
    kb.text('◀ רשימה', 'tx:list').text('🏠 דשבורד', 'nav:dash');
    return { text: '🔁 *כפילויות*\n\n‏✅ לא נמצאו עסקאות כפולות.', keyboard: kb };
  }
  const shown = groups.slice(0, DUP_GROUPS_PER_VIEW);
  const extra = groups.reduce((s, g) => s + g.rows.length - 1, 0);
  const lines = [
    '🔁 *כפילויות*', '',
    `‏נמצאו ${groups.length} קבוצות (${extra} שורות עודפות).`,
    '‏אותו תאריך, אותו סכום ושם בית עסק תואם — לרוב אותה עסקה שנקלטה גם מ-SMS וגם מדוח האשראי.',
    '‏אם השורה כבר חויבה במחזור הקודם והדוח מציג אותה כחיוב קרוב — 📅 מעביר אותה למחזור הבא במקום למחוק.',
    '‏ואם אלו באמת חיובים נפרדים (שלוש כרטיסיות רכבת באותו יום) — ✔️ מוריד את הקבוצה מהרשימה בלי לשנות נתונים.',
    '',
  ];
  for (const g of shown) {
    lines.push(`‏*${g.date.slice(8)}/${g.date.slice(5, 7)} — ${fmtILS.format(g.amount)}*`);
    for (const r of g.rows) {
      lines.push(`‏  • ${escapeMd(r.merchant || '—')} _(${r.source})_${r.charge_date ? ' — 📅 מחזור הבא' : ''}`);
      kb.text(`🗑 ${(r.merchant || '—').slice(0, 12)} · ${r.source}`, `tx:delask:${r.id}`);
      // מחזור חיוב רלוונטי להוצאות בלבד (כמו ב-`txDetailView` וב-web)
      if (g.type !== 'income') {
        kb.text(r.charge_date ? '📅 בטל' : '📅 מחזור הבא', `tx:dupchg:${r.id}:${r.charge_date ? 'clear' : 'next'}`);
      }
      kb.row();
    }
    // ✔️ פועל על הקבוצה כולה — לכן שורה משלו, מזוהה לפי השורה הראשונה בקבוצה
    kb.text('✔️ לא כפילות — חיובים נפרדים', `tx:dupok:${g.rows[0].id}`).row();
    lines.push('');
  }
  if (groups.length > shown.length) {
    lines.push(`‏(מוצגות ${shown.length} קבוצות ראשונות — השאר ב-web: ${lanUrl()}/#transactions)`);
  }
  restoreRow();
  kb.text('◀ רשימה', 'tx:list').text('🏠 דשבורד', 'nav:dash');
  return { text: lines.join('\n'), keyboard: kb };
}

// אישור לפני מחיקת עסקה מפירוט העסקה. **סדר הכפתורים מכוון**: "◀ ביטול"
// ראשון, כי `txDetailView` מציג את "🗑 מחק" באותו מיקום (שורה 0, עמודה 0) —
// לחיצה כפולה מהירה על אותו מקום תיפול על הביטול ולא על המחיקה.
// (מאותה סיבה `categoryDeleteConfirmView` מציג את הביטול בשורה 1, מול ה-🗑
// שיושב בשורה 1 ב-`categoryDetailView`.)
export function txDeleteConfirmView(id) {
  const t = db.prepare(`
    SELECT t.*, c.name AS category_name, c.icon AS category_icon
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?
  `).get(id);
  if (!t) return { text: 'העסקה כבר נמחקה.', keyboard: new InlineKeyboard().text('◀ רשימה', 'tx:list') };
  const sign = t.type === 'income' ? '+' : '−';
  const lines = [
    '🗑 *למחוק את העסקה?*', '',
    `‏${escapeMd(t.merchant || '—')} ${sign} ${fmtILS.format(t.amount)}`,
    `‏תאריך: ${t.date}`,
    ...(t.category_name ? [`‏קטגוריה: ${t.category_icon} ${escapeMd(t.category_name)}`] : []),
  ];
  // עסקה בתוכנית תשלומים — להבהיר שנמחקת שורה אחת ולא כל התוכנית
  if (t.installment_group) {
    lines.push('', `‏זו שורה בתוכנית תשלומים (${escapeMd(t.description)}) — תימחק רק היא, שאר התשלומים יישארו.`);
  }
  lines.push('', '‏המחיקה סופית.');
  const kb = new InlineKeyboard()
    .text('◀ ביטול', `tx:view:${id}`).row()
    .text('🗑 כן, מחק', `tx:del:${id}`);
  return { text: lines.join('\n'), keyboard: kb };
}

function txCategoryPicker(id) {
  const cats = db.prepare('SELECT * FROM categories ORDER BY id').all();
  const kb = new InlineKeyboard();
  cats.forEach((c, i) => {
    kb.text(`${c.icon} ${c.name}`, `tx:setcat:${id}:${c.id}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row().text('— ללא —', `tx:setcat:${id}:0`).text('◀ חזרה', `tx:view:${id}`);
  return { text: 'בחר קטגוריה:', keyboard: kb };
}

// אחרי שיוך קטגוריה לעסקה בודדת — הצעה להחיל על כל העסקאות של אותו בית עסק.
// עולה רק כשיש עסקאות אחרות שעדיין בקטגוריה אחרת (peers.differing > 0).
export function txApplyAllView(id, catId, peers, category) {
  const label = category ? `${category.icon} ${category.name}` : '— ללא קטגוריה —';
  const text = [
    `✅ הקטגוריה של העסקה עודכנה ל-${label}.`, '',
    `‏ל-*${escapeMd(peers.merchant)}* יש עוד ${peers.differing} עסקאות בקטגוריה אחרת.`,
    '‏לשייך גם אותן? כך גם עסקאות עתידיות של בית העסק ייקלטו לקטגוריה הזו.',
  ].join('\n');
  const kb = new InlineKeyboard()
    .text(`✅ כן — שייך את כל ${peers.differing}`, `tx:catall:${id}:${catId}`).row()
    .text('לא, רק העסקה הזו', `tx:view:${id}`);
  return { text, keyboard: kb };
}

/* ==================== קטגוריות + חוקים (inline) ==================== */
// "תשלומים" — סה"כ לפי מועדי התשלום בחלון, לא לפי שורות (ראו ההסבר ב-
// server/lib/installments.js). מקור אמת יחיד המשותף ל-web ולבוט.

// פרמטר anchor = חודש־עוגן של מחזור (YYYY-MM). הסכומים לפי חלון המחזור 10→10, כמו
// הדשבורד. shiftMonthStr(anchor, ±1) מזיז מחזור שלם קדימה/אחורה.
function categoriesView(anchor = currentMonth()) {
  const flow = computeCycleFlow(anchor);
  const totals = new Map(flow.by_category.map((c) => [c.name, c.total]));
  totals.set('תשלומים', installmentsCategoryTotal('תשלומים', { start: flow.start, end: flow.end }));
  const cats = db.prepare('SELECT * FROM categories ORDER BY id').all();
  const kb = new InlineKeyboard();
  // שורת ניווט מחזורים: הבא / [MM-MM] / קודם
  kb.text('הבא ◀', `cat:mon:${shiftMonthStr(anchor, 1)}`)
    .text(cycleLabelShort(flow.start, flow.end), 'noop')
    .text('▶ קודם', `cat:mon:${shiftMonthStr(anchor, -1)}`).row();
  let categoryColumns = 0;
  cats.forEach((c) => {
    const spent = totals.get(c.name) || 0;
    const amountSeparator = /^paybox\s*\/\s*bit$/i.test(c.name.trim()) ? '' : ' ';
    // שם הקטגוריה והסכום ארוכים מדי לחצי שורה בטלפון — שורה מלאה לתשלומים.
    const fullWidth = c.name.trim() === 'תשלומים';
    if (fullWidth && categoryColumns) {
      kb.row();
      categoryColumns = 0;
    }
    kb.text(`${c.icon} ${c.name.trimEnd()}${spent ? `${amountSeparator}${fmtILS.format(spent)}` : ''}`, `cat:view:${c.id}:${anchor}`);
    categoryColumns++;
    if (fullWidth || categoryColumns === 2) {
      kb.row();
      categoryColumns = 0;
    }
  });
  kb.row().text('❔ ללא קטגוריה', `cat:none:${anchor}`).row()
    .text('➕ קטגוריה', 'cat:add').text('📏 חוקים', 'rule:list').row()
    .text('🧠 אמן מודל', 'train').text('🏠 דשבורד', 'nav:dash');
  return { text: `🏷️ *קטגוריות* — ${flow.label}\nבחר קטגוריה לפירוט`, keyboard: kb };
}

// עסקאות ללא קטגוריה (category_id IS NULL) בחלון המחזור הנבחר — לתיוג ידני
function uncategorizedView(anchor = currentMonth()) {
  const { start, end, label } = cycleWindow(anchor, cycleDayFn);
  const txs = db.prepare(`
    SELECT date, amount, merchant, description, installment_group FROM transactions
    WHERE category_id IS NULL AND COALESCE(charge_date, date) >= ? AND COALESCE(charge_date, date) <= ?
    ORDER BY COALESCE(charge_date, date) DESC, id DESC LIMIT 20
  `).all(start, end);
  const total = txs.reduce((s, t) => s + t.amount, 0);
  const kb = new InlineKeyboard()
    .text('הבא ◀', `cat:none:${shiftMonthStr(anchor, 1)}`)
    .text(cycleLabelShort(start, end), 'noop')
    .text('▶ קודם', `cat:none:${shiftMonthStr(anchor, -1)}`).row()
    .text('◀ רשימה', `cat:mon:${anchor}`);
  const list = txs.length
    ? txs.map((t) => `‏• ${t.date.slice(8)}/${t.date.slice(5, 7)} ${escapeMd(t.merchant || '—')} — ${fmtILS.format(t.amount)}`).join('\n')
    : '_אין עסקאות ללא קטגוריה במחזור זה._';
  return {
    text: `❔ *ללא קטגוריה* — ${label}\n${txs.length} עסקאות · ${fmtILS.format(total)}\n\n${list}`,
    keyboard: kb,
  };
}

// חיובי התשלומים של המחזור לפי מועדם האפקטיבי, עם מספר כל תשלום.
// העברה יכולה להציג שני חיובים לאותה תוכנית; תשלום צפוי מסומן בטקסט.
function installmentsListView(anchor = currentMonth()) {
  const { start, end, label } = cycleWindow(anchor, cycleDayFn);
  const groups = listInstallmentGroups({ start, end });
  const kb = new InlineKeyboard()
    .text('הבא ◀', `cat:ins:${shiftMonthStr(anchor, 1)}`)
    .text(cycleLabelShort(start, end), 'noop')
    .text('▶ קודם', `cat:ins:${shiftMonthStr(anchor, -1)}`).row()
    .text('◀ קטגוריות', `cat:mon:${anchor}`);
  if (!groups.length) {
    return { text: `*תשלומים* — ${label}\n\n_אין תוכנית תשלומים פעילה במחזור זה._`, keyboard: kb };
  }
  const total = groups.reduce((s, g) => s + g.amount, 0);
  const programCount = new Set(groups.map((g) => g.group)).size;
  const lines = groups.map((g) =>
    `‏${escapeMd(g.merchant || '—')} — תשלום ${g.index} מתוך ${g.total_count} (${fmtILS.format(g.amount)})${g.projected ? ' · טרם יובא' : ''}`);
  return {
    text: `*תשלומים* — ${label}\n${programCount} תוכניות · ${fmtILS.format(total)}\n\n${lines.join('\n')}`,
    keyboard: kb,
  };
}

// פרמטר anchor = חודש־עוגן של מחזור. עסקאות הקטגוריה מסוננות לחלון המחזור 10→10.
function categoryDetailView(id, anchor = currentMonth()) {
  const c = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  if (!c) return { text: 'הקטגוריה נמחקה.', keyboard: new InlineKeyboard().text('◀ רשימה', 'cat:list') };
  // "תשלומים" — במקום רשימת עסקאות רגילה, תוכניות התשלומים של המחזור עם k/n
  if (c.name === 'תשלומים') return installmentsListView(anchor);
  // עסקאות הקטגוריה בחלון המחזור, חדש→ישן. ניווט מחזורים דרך הכפתורים ◀ ▶.
  const { start, end, label } = cycleWindow(anchor, cycleDayFn);
  const txs = db.prepare(`
    SELECT date, amount, merchant, description, installment_group FROM transactions
    WHERE category_id = ? AND COALESCE(charge_date, date) >= ? AND COALESCE(charge_date, date) <= ?
    ORDER BY COALESCE(charge_date, date) DESC, id DESC LIMIT 20
  `).all(id, start, end);
  const cycleTotal = txs.reduce((s, t) => s + t.amount, 0);
  const kb = new InlineKeyboard()
    .text('הבא ◀', `cat:view:${id}:${shiftMonthStr(anchor, 1)}`)
    .text(cycleLabelShort(start, end), 'noop')
    .text('▶ קודם', `cat:view:${id}:${shiftMonthStr(anchor, -1)}`).row()
    .text('🗑 מחק', `cat:delask:${id}:${anchor}`).text('✏️ שנה שם', `cat:rename:${id}`).row()
    .text('◀ רשימה', `cat:mon:${anchor}`);
  // ‏ (RLM) בתחילת כל שורה — כופה כיוון RTL כדי ששם עסק לועזי (MOJO) יופיע כמו עברי
  const list = txs.length
    ? txs.map((t) => {
        const inst = t.installment_group ? ` · ${escapeMd(t.description)}` : '';
        return `‏• ${t.date.slice(8)}/${t.date.slice(5, 7)} ${escapeMd(t.merchant || '—')}${inst} — ${fmtILS.format(t.amount)}`;
      }).join('\n')
    : '_אין עסקאות במחזור זה._';
  return {
    text: `${c.icon} *${c.name}* — ${label}\n${txs.length} עסקאות · ${fmtILS.format(cycleTotal)}\n\n${list}`,
    keyboard: kb,
  };
}

// אישור לפני מחיקת קטגוריה. מחיקה מאפסת את `category_id` של **כל** עסקאות
// הקטגוריה (ראו `DELETE /api/categories/:id`) — לחיצה בודדת בלי אישור מחקה
// בפועל קטגוריה שלמה ואת השיוך של 21 עסקאות (15.08). ה-web תמיד שאל `confirm`;
// זו השלמת ה-parity.
export function categoryDeleteConfirmView(id, anchor = currentMonth()) {
  const c = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  if (!c) return { text: 'הקטגוריה כבר נמחקה.', keyboard: new InlineKeyboard().text('◀ רשימה', 'cat:list') };
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?').get(id);
  const text = [
    `🗑 *למחוק את הקטגוריה ${escapeMd(c.icon)} ${escapeMd(c.name)}?*`, '',
    n ? `‏${n} עסקאות ישויכו ל"ללא קטגוריה". העסקאות עצמן לא נמחקות.`
      : '‏אין עסקאות משויכות לקטגוריה זו.',
    '‏את הקטגוריה עצמה אי אפשר לשחזר מהבוט.',
  ].join('\n');
  const kb = new InlineKeyboard()
    .text('🗑 כן, מחק', `cat:del:${id}`).row()
    .text('◀ ביטול', `cat:view:${id}:${anchor}`);
  return { text, keyboard: kb };
}

function rulesView() {
  const rules = db.prepare(`
    SELECT r.*, c.name AS category_name, c.icon AS category_icon
    FROM rules r JOIN categories c ON c.id = r.category_id ORDER BY r.priority DESC, r.id
  `).all();
  const kb = new InlineKeyboard();
  for (const r of rules) {
    kb.text(`🗑 ${r.pattern} → ${r.category_icon} ${r.category_name}`, `rule:del:${r.id}`).row();
  }
  kb.text('➕ הוסף חוק', 'rule:add').text('◀ קטגוריות', 'cat:list');
  const text = rules.length
    ? '📏 *חוקי סיווג* (regex → קטגוריה)\nלחיצה מוחקת חוק. חוקים מנצחים את ה-ML.'
    : '📏 *חוקי סיווג*\n\nאין חוקים. הוסף חוק שממפה שם בית עסק לקטגוריה.';
  return { text, keyboard: kb };
}

function ruleCategoryPicker() {
  const cats = db.prepare('SELECT * FROM categories ORDER BY id').all();
  const kb = new InlineKeyboard();
  cats.forEach((c, i) => {
    kb.text(`${c.icon} ${c.name}`, `rule:cat:${c.id}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row().text('❌ ביטול', 'rule:list');
  return { text: 'לאיזו קטגוריה למפות?', keyboard: kb };
}

/* ==================== הכנסות (inline) ==================== */
function incomeView(anchorMonth = currentCycleAnchor()) {
  // הכנסות משויכות למחזור התזרים (10→10) בדיוק כמו ההוצאות. שורה בלי תאריך
  // (legacy) נספרת בכל מחזור.
  const { start, end, label } = cycleWindow(anchorMonth, cycleDayFn);
  const rows = db.prepare(`
    SELECT * FROM income
    WHERE date IS NULL OR (date >= ? AND date <= ?)
    ORDER BY date IS NULL DESC, date, id
  `).all(start, end);
  const kb = new InlineKeyboard();
  let total = 0;
  for (const i of rows) {
    if (i.active) total += i.amount;
    const dateTag = i.date ? ` · ${i.date.slice(8)}/${i.date.slice(5, 7)}` : '';
    const recurTag = (i.recurring || i.recurring_parent_id) ? ' 🔁' : '';
    kb.text(`${i.active ? '✅' : '⏸'} ${i.name} ${fmtILS.format(i.amount)}${dateTag}${recurTag}`, `inc:view:${i.id}`).row();
  }
  // שורת ניווט מחזורים — משפיעה על ה"סה"כ" למעלה ועל "הכנסות שנרשמו" למטה
  kb.text('הבא ◀', `inc:mon:${shiftMonthStr(anchorMonth, 1)}`)
    .text(cycleLabelShort(start, end), 'noop')
    .text('▶ קודם', `inc:mon:${shiftMonthStr(anchorMonth, -1)}`).row();
  kb.text('➕ הוסף הכנסה', 'inc:add').text('📄 מנויים', 'sub:list').row()
    .text('🔁 קבועות', 'rec:list').text('🏠 דשבורד', 'nav:dash');
  const fixed = rows.length
    ? `💵 *הכנסות והוצאות*\nסה"כ הכנסות ל-${label}: *${fmtILS.format(total)}*`
    : `💵 *הכנסות והוצאות*\n\nאין הכנסות במחזור ${label}. הוסף למשל משכורת.`;
  // הכנסות בפועל שנרשמו במחזור הנבחר (transactions type=income)
  const actual = db.prepare(`
    SELECT date, amount, merchant FROM transactions
    WHERE type = 'income' AND COALESCE(charge_date, date) >= ? AND COALESCE(charge_date, date) <= ?
    ORDER BY COALESCE(charge_date, date) DESC, id DESC LIMIT 12
  `).all(start, end);
  const actualSum = actual.reduce((s, t) => s + t.amount, 0);
  const actualText = `\n\n*הכנסות שנרשמו — ${label}:* ${actual.length ? fmtILS.format(actualSum) : '—'}` +
    (actual.length ? '\n' + actual.map((t) =>
      `‏• ${t.date.slice(8)}/${t.date.slice(5, 7)} ${escapeMd(t.merchant || '—')} — ${fmtILS.format(t.amount)}`).join('\n') : '');
  return { text: fixed + actualText, keyboard: kb };
}

/* ==================== מנויים (inline) ==================== */
function subsDaysLeft(endDate) {
  return Math.ceil((new Date(endDate + 'T12:00:00') - new Date(localDate() + 'T12:00:00')) / 86400000);
}

function subscriptionsListView() {
  const rows = db.prepare('SELECT * FROM subscriptions ORDER BY end_date').all();
  const kb = new InlineKeyboard();
  for (const s of rows) {
    const left = subsDaysLeft(s.end_date);
    const flag = !s.active ? '⏸' : left < 0 ? '🔴' : left <= s.remind_days ? '⚠️' : '✅';
    kb.text(`${flag} ${s.name}${s.amount ? ` ${fmtILS.format(s.amount)}` : ''} · ${left} ימים`, `sub:view:${s.id}`).row();
  }
  kb.text('➕ הוסף מנוי', 'sub:add').text('◀ הכנסות', 'inc:list');
  const text = rows.length
    ? '📄 *מנויים והתחייבויות*\nלפי תאריך חידוש. ⚠️ = מתקרב לסיום.'
    : '📄 *מנויים*\n\nאין מנויים. הוסף למשל: אינטרנט, ביטוח, ספוטיפיי — ואזכיר לך לחדש.';
  return { text, keyboard: kb };
}

function subscriptionDetailView(id) {
  const s = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
  if (!s) return { text: 'המנוי נמחק.', keyboard: new InlineKeyboard().text('◀ מנויים', 'sub:list') };
  const left = subsDaysLeft(s.end_date);
  const text = [
    `📄 *${s.name}*`, '',
    s.amount ? `עלות: ${fmtILS.format(s.amount)}` : null,
    `תקופה: ${s.start_date} → ${s.end_date}`,
    `נשארו: *${left} ימים*${left <= s.remind_days ? ' ⚠️' : ''}`,
    `תזכורת: ${s.remind_days} ימים לפני הסיום`,
    s.active ? null : '⏸ מושבת — לא יישלחו תזכורות',
  ].filter(Boolean).join('\n');
  const kb = new InlineKeyboard()
    .text('🔄 חידשתי (תקופה נוספת)', `sub:renew:${id}`).row()
    .text(s.active ? '⏸ הפסק מעקב' : '▶ הפעל', `sub:tgl:${id}`).text('🗑 מחק', `sub:del:${id}`).row()
    .text('◀ מנויים', 'sub:list');
  return { text, keyboard: kb };
}

/* ==================== הוצאות קבועות (inline) ==================== */
// תווית תדירות: "כל יום שלישי" / "כל 1 בחודש"
function recFreqLabel(r) {
  const base = r.freq === 'weekly' ? `כל יום ${DAY_NAMES[r.day]}` : `כל ${r.day} בחודש`;
  return r.hour != null ? `${base} ב-${String(r.hour).padStart(2, '0')}:00` : base;
}

function recListView() {
  const rows = db.prepare(`
    SELECT r.*, c.name AS category_name, c.icon AS category_icon
    FROM recurring_expenses r LEFT JOIN categories c ON c.id = r.category_id ORDER BY r.id
  `).all();
  const kb = new InlineKeyboard();
  for (const r of rows) {
    kb.text(`${r.active ? '🔁' : '⏸'} ${r.merchant} ${fmtILS.format(r.amount)} · ${recFreqLabel(r)}`, `rec:view:${r.id}`).row();
  }
  kb.text('➕ הוצאה קבועה', 'rec:add').text('◀ הכנסות', 'inc:list');
  const text = rows.length
    ? '🔁 *הוצאות קבועות*\nנוספות אוטומטית כעסקאות בכל מופע. ⏸ = מושבתת.'
    : '🔁 *הוצאות קבועות*\n\nאין עדיין. הוסף למשל: חוג שבועי, שכר דירה — ויתווספו אוטומטית.';
  return { text, keyboard: kb };
}

function recDetailView(id) {
  const r = db.prepare(`
    SELECT r.*, c.name AS category_name, c.icon AS category_icon
    FROM recurring_expenses r LEFT JOIN categories c ON c.id = r.category_id WHERE r.id = ?
  `).get(id);
  if (!r) return { text: 'ההוצאה הקבועה נמחקה.', keyboard: new InlineKeyboard().text('◀ רשימה', 'rec:list') };
  const text = [
    `🔁 *${r.merchant}*`, '',
    `סכום: *${fmtILS.format(r.amount)}*`,
    `תדירות: ${recFreqLabel(r)}`,
    `קטגוריה: ${r.category_name ? `${r.category_icon} ${r.category_name}` : '— אוטומטית —'}`,
    r.last_added ? `נוספה לאחרונה: ${r.last_added}` : 'טרם נוספה',
    r.active ? null : '⏸ מושבתת — לא יתווספו עסקאות',
  ].filter(Boolean).join('\n');
  const kb = new InlineKeyboard()
    .text(r.active ? '⏸ השבת' : '▶ הפעל', `rec:tgl:${id}`).text('🗑 מחק', `rec:del:${id}`).row()
    .text('🕐 שעה', `rec:hour:${id}`).text('🏷 קטגוריה', `rec:setcat:${id}`).row()
    .text('◀ רשימה', 'rec:list');
  return { text, keyboard: kb };
}

// שינוי קטגוריה להוצאה קבועה קיימת (rec:setcat → rec:pickcat). בשונה מבורר
// ההוספה (recCategoryPicker) — כאן ה-id של ההוצאה נישא ב-callback ולא ב-pending,
// כי אין זרימה רב-שלבית שנשמרת.
function recEditCategoryPicker(id) {
  const r = db.prepare('SELECT merchant, category_id FROM recurring_expenses WHERE id = ?').get(id);
  if (!r) return { text: 'ההוצאה הקבועה נמחקה.', keyboard: new InlineKeyboard().text('◀ רשימה', 'rec:list') };
  const cats = db.prepare('SELECT * FROM categories ORDER BY id').all();
  const kb = new InlineKeyboard();
  cats.forEach((c, i) => {
    kb.text(`${c.id === r.category_id ? '✅ ' : ''}${c.icon} ${c.name}`, `rec:pickcat:${id}:${c.id}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row().text(`${r.category_id ? '' : '✅ '}🤖 אוטומטית`, `rec:pickcat:${id}:0`)
    .text('❌ ביטול', `rec:view:${id}`);
  return {
    text: `🏷 *${escapeMd(r.merchant)}* — לאיזו קטגוריה לשייך?\n(אוטומטית = לפי חוקים/ML בכל מופע)`,
    keyboard: kb,
  };
}

// בוררי תדירות/יום/קטגוריה לזרימת ההוספה (rec:add → טקסט → freq → day → cat)
function recFreqPicker() {
  const kb = new InlineKeyboard()
    .text('📅 כל שבוע', 'rec:freq:weekly').text('🗓 כל חודש', 'rec:freq:monthly').row()
    .text('❌ ביטול', 'rec:list');
  return { text: 'באיזו תדירות?', keyboard: kb };
}

function recDayPicker(freq) {
  const kb = new InlineKeyboard();
  if (freq === 'weekly') {
    DAY_NAMES.forEach((name, i) => {
      kb.text(`יום ${name}`, `rec:day:${i}`);
      if (i % 3 === 2) kb.row();
    });
  } else {
    // 29–31 לא קיימים בכל חודש — בחודש קצר המופע נדחק ליום האחרון בו
    const PER_ROW = 7;
    for (let d = 1; d <= 31; d++) {
      kb.text(String(d), `rec:day:${d}`);
      if (d % PER_ROW === 0) kb.row();
    }
    // ריפוד השורה האחרונה עד לרוחב מלא: טלגרם מותח את הכפתורים בשורה באופן
    // שווה, כך ש-29–31 לבדם היו רחבים פי שניים משאר הימים
    for (let i = 31 % PER_ROW; i > 0 && i < PER_ROW; i++) kb.text('·', 'noop');
  }
  kb.row().text('❌ ביטול', 'rec:list');
  return {
    text: freq === 'weekly'
      ? 'באיזה יום בשבוע?'
      : 'באיזה יום בחודש? (1–31)\n29–31: בחודש שאין בו את היום, החיוב ייכנס ביום האחרון בחודש.',
    keyboard: kb,
  };
}

function recCategoryPicker() {
  const cats = db.prepare('SELECT * FROM categories ORDER BY id').all();
  const kb = new InlineKeyboard();
  cats.forEach((c, i) => {
    kb.text(`${c.icon} ${c.name}`, `rec:cat:${c.id}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row().text('🤖 אוטומטית', 'rec:cat:0').text('❌ ביטול', 'rec:list');
  return { text: 'איזו קטגוריה? (אוטומטית = לפי חוקים/ML)', keyboard: kb };
}

function incomeDetailView(id) {
  const i = db.prepare('SELECT * FROM income WHERE id = ?').get(id);
  if (!i) return { text: 'ההכנסה נמחקה.', keyboard: new InlineKeyboard().text('◀ רשימה', 'inc:list') };
  const kb = new InlineKeyboard()
    .text('✏️ ערוך סכום', `inc:editamt:${id}`).text('📅 ערוך תאריך', `inc:editdate:${id}`).row();
  // מופע (recurring_parent_id) הוא כבר חלק מסדרה קבועה — לא מציעים "סמן כקבועה"
  // שלא ייווצר תבנית כפולה (סכנת הכנסה כפולה בחודש הבא).
  if (i.recurring_parent_id) kb.text('✏️ ערוך שם', `inc:editname:${id}`).row();
  else kb.text('✏️ ערוך שם', `inc:editname:${id}`).text(i.recurring ? '🔁 בטל קבועה' : '↻ סמן כקבועה', `inc:recur:${id}`).row();
  kb.text(i.active ? '⏸ השבת' : '▶ הפעל', `inc:tgl:${id}`).text('🗑 מחק', `inc:del:${id}`).row()
    .text('◀ רשימה', 'inc:list');
  const recurDay = i.day_of_month || (i.date ? Number(i.date.slice(8, 10)) : null);
  const recurLine = (i.recurring || i.recurring_parent_id)
    ? `\nקבועה 🔁 — ${i.recurring ? 'נוספת אוטומטית' : 'מופע חודשי'}${recurDay ? ` ב-${recurDay} לחודש` : ''} בסכום זה`
    : '';
  return { text: `💵 *${i.name}*\n\nסכום: *${fmtILS.format(i.amount)}*\nמצב: ${i.active ? 'פעילה' : 'מושבתת'}${i.date ? `\nתאריך: ${i.date}` : '\nללא תאריך — נספרת בכל מחזור'}${recurLine}`, keyboard: kb };
}

/* ==================== הגדרות (inline) ==================== */
function settingsView() {
  const days = (getSetting('notify_days', '0,2,4')).split(',').filter(Boolean).map(Number);
  const hour = getSetting('notify_hour', '9');
  const ml = mlStatus();
  const kb = new InlineKeyboard();
  DAY_NAMES.forEach((name, i) => {
    kb.text(`${days.includes(i) ? '🔔' : '🔕'} ${name}`, `notify:day:${i}`);
    if (i % 3 === 2) kb.row();
  });
  const pinned = getSetting('menu_persistent', '0') === '1';
  kb.row().text(`🕐 שעת התראה: ${hour}:00`, 'notify:hour').row()
    .text(`📌 קיבוע מקלדת: ${pinned ? 'פעיל' : 'כבוי'}`, 'notify:pin').row()
    .text('🧠 אמן מודל', 'train').text('🏠 דשבורד', 'nav:dash');
  const text = [
    '⚙️ *הגדרות ומצב מערכת*', '',
    `🤖 בוט: פעיל${status.username ? ` (@${status.username})` : ''}`,
    `🧠 מנוע ML: ${ml.available ? 'פעיל' : 'כבוי (חוקים בלבד)'}`,
    `🔔 התראות: ${days.length ? days.map((d) => DAY_NAMES[d]).join(', ') : 'כבויות'} בשעה ${hour}:00`,
    `📌 קיבוע מקלדת: ${pinned ? 'פעיל (ניסיוני)' : 'כבוי'} — אם "חזרה" נתקע בטלפון, כבה כאן או שלח /settings`, '',
    `Token, גיבוי DB וייצוא — ב-web: ${lanUrl()}/#settings`,
  ].join('\n');
  return { text, keyboard: kb };
}

/* ==================== ייבוא (inline) ==================== */
function importIntro() {
  const kb = new InlineKeyboard().text('🧾 העלאת תלוש משכורת', 'imp:payslip');
  return {
    text: ['📥 *ייבוא נתונים*', '',
      'שלח לי כאן:',
      '• קובץ CSV / PDF מהבנק — אציג תצוגה מקדימה לאישור',
      '• צילום של הדוח (JPG/PNG) — OCR אוטומטי, כמה שניות',
      '• העברת SMS מהבנק — אחלץ עסקה',
      '• תלוש משכורת (PDF) — דרך הכפתור למטה',
      '', `תצוגה מקדימה עם בחירת שורות בודדות — ב-web: ${lanUrl()}/#import`].join('\n'),
    keyboard: kb,
  };
}

/* ==================== callback router ==================== */
async function edit(ctx, view) {
  try {
    await ctx.editMessageText(view.text, { parse_mode: 'Markdown', reply_markup: view.keyboard });
  } catch {
    await ctx.reply(view.text, { parse_mode: 'Markdown', reply_markup: view.keyboard });
  }
}

async function handleCallback(ctx) {
  const data = ctx.callbackQuery.data;
  const [ns, action, ...rest] = data.split(':');
  const ack = (msg) => ctx.answerCallbackQuery(msg ? { text: msg } : undefined);

  try {
    // ניווט כללי
    if (data === 'nav:dash') { await edit(ctx, await dashView()); return ack(); }
    if (ns === 'dash' && action === 'mon') { await edit(ctx, await dashView(rest[0])); return ack(); }
    if (data === 'nav:settings') { await edit(ctx, settingsView()); return ack(); }
    if (data === 'noop') return ack();
    if (data === 'train') {
      await ack('מאמן…');
      const r = await mlTrain(labeledData());
      const msg = r?.trained ? `✅ אומן על ${r.samples} עסקאות (${r.classes} קטגוריות)`
        : r?.reason === 'not_enough_data' ? `אין מספיק נתונים (${r.samples ?? 0}) — צריך 8+ ב-2 קטגוריות`
        : 'מנוע ML לא זמין';
      return ctx.reply(msg, { reply_markup: MENU });
    }

    // עסקאות
    if (ns === 'tx') {
      if (action === 'list') { await edit(ctx, txListView()); return ack(); }
      if (action === 'mon') { await edit(ctx, txListView(null, rest[0])); return ack(); }
      if (action === 'page') { await edit(ctx, txListView(null, rest[0], Number(rest[1]))); return ack(); }
      if (action === 'view') { await edit(ctx, txDetailView(Number(rest[0]))); return ack(); }
      if (action === 'cat') { await edit(ctx, txCategoryPicker(Number(rest[0]))); return ack(); }
      if (action === 'setcat') {
        const [id, cat] = rest.map(Number);
        let result;
        try { result = assignCategory(id, cat); }
        catch { await edit(ctx, txDetailView(id)); return ack('העסקה לא נמצאה'); }
        notifyTransactionChanged({ ...result.transaction, category_name: result.category?.name },
          { action: 'updated', excludeChatId: ctx.chat.id }).catch(() => {});
        const peers = merchantPeers(result.transaction, cat);
        if (peers.differing > 0) {
          await edit(ctx, txApplyAllView(id, cat, peers, result.category));
          return ack('קטגוריה עודכנה');
        }
        await edit(ctx, txDetailView(id));
        return ack('קטגוריה עודכנה');
      }
      // שיוך גורף לכל העסקאות של אותו בית עסק (אותו סוג)
      if (action === 'catall') {
        const [id, cat] = rest.map(Number);
        let result;
        try { result = assignCategory(id, cat, { applyAll: true }); }
        catch { await edit(ctx, txDetailView(id)); return ack('העסקה לא נמצאה'); }
        await edit(ctx, txDetailView(id));
        notifyTransactionChanged({ ...result.transaction, category_name: result.category?.name },
          { action: 'updated', count: result.updated, excludeChatId: ctx.chat.id }).catch(() => {});
        return ack(`✅ ${result.updated} עסקאות של "${result.merchant}" עודכנו`);
      }
      if (action === 'chg') {
        const id = Number(rest[0]);
        if (!setChargeDate(id, rest[1])) { await edit(ctx, txListView()); return ack('העסקה לא נמצאה'); }
        notifyTransactionChanged(db.prepare('SELECT * FROM transactions WHERE id = ?').get(id),
          { action: 'updated', excludeChatId: ctx.chat.id }).catch(() => {});
        await edit(ctx, txDetailView(id));
        return ack(rest[1] === 'next' ? 'הועבר למחזור הבא' : 'ההעברה בוטלה');
      }
      // אותה פעולה מתוך פאנל הכפילויות — חוזרים לפאנל ולא לפירוט העסקה,
      // כדי שהמשתמש יראה מיד שהקבוצה ירדה מהרשימה ויוכל לטפל בבאה.
      if (action === 'dupchg') {
        const id = Number(rest[0]);
        const ok = setChargeDate(id, rest[1]);
        if (ok) notifyTransactionChanged(db.prepare('SELECT * FROM transactions WHERE id = ?').get(id),
          { action: 'updated', excludeChatId: ctx.chat.id }).catch(() => {});
        await edit(ctx, duplicatesView());
        return ack(!ok ? 'העסקה לא נמצאה'
          : rest[1] === 'next' ? '📅 הועבר למחזור הבא — לא כפילות' : 'ההעברה בוטלה');
      }
      // מחיקת עסקה מפירוט העסקה — תמיד דרך מסך אישור. כפתורי "🗑 ביטול"
      // שמופיעים מיד אחרי הוספה (SMS / טקסט) נשארים בלחיצה אחת: הם undo
      // לעסקה שנוצרה באותו רגע, ובהם האישור רק מפריע.
      if (action === 'delask') {
        await edit(ctx, txDeleteConfirmView(Number(rest[0])));
        return ack();
      }
      if (action === 'del') {
        const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(rest[0]));
        db.prepare('DELETE FROM transactions WHERE id = ?').run(Number(rest[0]));
        if (row) notifyTransactionChanged(row, { action: 'deleted', excludeChatId: ctx.chat.id }).catch(() => {});
        await edit(ctx, txListView());
        return ack('נמחקה');
      }
      // ✔️ "אלו חיובים נפרדים" — לא נוגע בנתוני העסקאות, ולכן בלחיצה אחת
      // (כמו `dupchg`, ובשונה ממחיקה). הפיך דרך `dupclr`.
      if (action === 'dupok') {
        const result = ignoreDuplicateGroup(Number(rest[0]));
        await edit(ctx, duplicatesView());
        return ack(result.rows ? `✔️ ${result.rows} שורות סומנו כחיובים נפרדים` : 'הקבוצה כבר לא קיימת');
      }
      if (action === 'dupclr') {
        const cleared = clearIgnoredDuplicates();
        await edit(ctx, duplicatesView());
        return ack(`↩️ ${cleared} סימונים בוטלו`);
      }
      if (action === 'dups') { await edit(ctx, duplicatesView()); return ack(); }
      if (action === 'search') {
        pending.set(String(ctx.chat.id), { action: 'tx_search' });
        await ctx.reply('הקלד מילת חיפוש (שם בית עסק):', { reply_markup: MENU });
        return ack();
      }
      if (action === 'inst') {
        pending.set(String(ctx.chat.id), { action: 'tx_tag_installment', id: Number(rest[0]) });
        await ctx.reply('הקלד מספר תשלום מתוך סה"כ, למשל 1/3:', { reply_markup: MENU });
        return ack();
      }
      if (action === 'instlist') { await edit(ctx, installmentsListView(rest[0])); return ack(); }
      if (action === 'manage') {
        const [month, page] = rest;
        const ids = db.prepare(`
          SELECT id FROM transactions WHERE substr(COALESCE(charge_date, date), 1, 7) = ?
          ORDER BY COALESCE(charge_date, date) DESC, id DESC LIMIT ? OFFSET ?
        `).all(month, TX_PAGE, Number(page) * TX_PAGE).map((r) => r.id);
        pending.set(String(ctx.chat.id), { action: 'tx_manage', ids });
        await ctx.reply('שלח את מספר העסקה מהרשימה למעלה, או את שם בית העסק לחיפוש:', { reply_markup: MENU });
        return ack();
      }
    }

    // קטגוריות
    if (ns === 'cat') {
      if (action === 'list') { await edit(ctx, categoriesView()); return ack(); }
      if (action === 'mon') { await edit(ctx, categoriesView(rest[0])); return ack(); }
      if (action === 'none') { await edit(ctx, uncategorizedView(rest[0])); return ack(); }
      if (action === 'ins') { await edit(ctx, installmentsListView(rest[0])); return ack(); }
      if (action === 'view') { await edit(ctx, categoryDetailView(Number(rest[0]), rest[1])); return ack(); }
      // מחיקת קטגוריה — תמיד דרך מסך אישור (delask), לעולם לא בלחיצה בודדת
      if (action === 'delask') {
        await edit(ctx, categoryDeleteConfirmView(Number(rest[0]), rest[1]));
        return ack();
      }
      if (action === 'del') {
        db.prepare('DELETE FROM categories WHERE id = ?').run(Number(rest[0]));
        await edit(ctx, categoriesView());
        return ack('הקטגוריה נמחקה');
      }
      if (action === 'add') {
        pending.set(String(ctx.chat.id), { action: 'add_cat' });
        await ctx.reply('שם הקטגוריה החדשה (אפשר להתחיל באימוג\'י, למשל "🎁 מתנות"):');
        return ack();
      }
      if (action === 'rename') {
        pending.set(String(ctx.chat.id), { action: 'rename_cat', id: Number(rest[0]) });
        await ctx.reply('השם החדש לקטגוריה:', { reply_markup: MENU });
        return ack();
      }
    }

    // חוקים
    if (ns === 'rule') {
      if (action === 'list') { await edit(ctx, rulesView()); return ack(); }
      if (action === 'del') {
        db.prepare('DELETE FROM rules WHERE id = ?').run(Number(rest[0]));
        await edit(ctx, rulesView());
        return ack('החוק נמחק');
      }
      if (action === 'add') {
        pending.set(String(ctx.chat.id), { action: 'add_rule_pattern' });
        await ctx.reply('הקלד ביטוי לזיהוי (regex), למשל: שופרסל|רמי לוי', { reply_markup: MENU });
        return ack();
      }
      if (action === 'cat') {
        const p = pending.get(String(ctx.chat.id));
        if (p?.action === 'add_rule_cat' && p.pattern) {
          db.prepare('INSERT INTO rules (pattern, category_id) VALUES (?, ?)').run(p.pattern, Number(rest[0]));
          pending.delete(String(ctx.chat.id));
          await edit(ctx, rulesView());
          return ack('החוק נוסף');
        }
        return ack();
      }
    }

    // הכנסות
    if (ns === 'inc') {
      if (action === 'list') { await edit(ctx, incomeView()); return ack(); }
      if (action === 'mon') { await edit(ctx, incomeView(rest[0])); return ack(); }
      if (action === 'view') { await edit(ctx, incomeDetailView(Number(rest[0]))); return ack(); }
      if (action === 'tgl') {
        const i = db.prepare('SELECT * FROM income WHERE id = ?').get(Number(rest[0]));
        if (i) {
          db.prepare('UPDATE income SET active = ? WHERE id = ?').run(i.active ? 0 : 1, i.id);
          notifyIncomeChanged({ ...i, active: i.active ? 0 : 1 }, { action: 'updated', excludeChatId: ctx.chat.id }).catch(() => {});
        }
        await edit(ctx, incomeDetailView(Number(rest[0])));
        return ack('עודכן');
      }
      if (action === 'recur') {
        // סימון כקבועה גוזר day_of_month מהתאריך (כמו PUT ב-routes/income.js);
        // ביטול מנקה ל-null שלא תישאר תבנית מיותמת.
        const i = db.prepare('SELECT * FROM income WHERE id = ?').get(Number(rest[0]));
        if (i) {
          if (i.recurring) db.prepare('UPDATE income SET recurring = 0, day_of_month = NULL WHERE id = ?').run(i.id);
          else db.prepare('UPDATE income SET recurring = 1, day_of_month = ? WHERE id = ?').run(templateDay(i), i.id);
          notifyIncomeChanged(db.prepare('SELECT * FROM income WHERE id = ?').get(i.id),
            { action: 'updated', excludeChatId: ctx.chat.id }).catch(() => {});
        }
        await edit(ctx, incomeDetailView(Number(rest[0])));
        return ack(i?.recurring ? 'בוטלה קביעות' : 'סומנה כקבועה');
      }
      if (action === 'del') {
        const row = db.prepare('SELECT * FROM income WHERE id = ?').get(Number(rest[0]));
        db.prepare('DELETE FROM income WHERE id = ?').run(Number(rest[0]));
        if (row) notifyIncomeChanged(row, { action: 'deleted', excludeChatId: ctx.chat.id }).catch(() => {});
        await edit(ctx, incomeView());
        return ack('נמחקה');
      }
      if (action === 'add') {
        pending.set(String(ctx.chat.id), { action: 'add_income' });
        await ctx.reply('הקלד: שם, סכום, ותאריך אופציונלי. למשל: "משכורת 14000" או "מתנה 500 10/07"', { reply_markup: MENU });
        return ack();
      }
      if (action === 'editname') {
        pending.set(String(ctx.chat.id), { action: 'edit_income_name', id: Number(rest[0]) });
        await ctx.reply('הקלד את השם החדש להכנסה:', { reply_markup: MENU });
        return ack();
      }
      if (action === 'editamt') {
        pending.set(String(ctx.chat.id), { action: 'edit_income_amount', id: Number(rest[0]) });
        await ctx.reply('הקלד את הסכום החדש (למשל: 14500):', { reply_markup: MENU });
        return ack();
      }
      if (action === 'editdate') {
        pending.set(String(ctx.chat.id), { action: 'edit_income_date', id: Number(rest[0]) });
        await ctx.reply('הקלד תאריך חדש (למשל: 10/07), או "בלי" כדי להסיר תאריך (תיספר בכל חודש):', { reply_markup: MENU });
        return ack();
      }
    }

    // ביטול קבוצת תשלומים (מיד אחרי יצירה)
    if (ns === 'tx' && action === 'delgroup') {
      const deleted = deleteInstallmentGroup(rest.join(':'));
      if (deleted) notifyAllUsers(`🗑 בוטלו ${deleted} תשלומים.`, null, { excludeChatId: ctx.chat.id }).catch(() => {});
      await edit(ctx, { text: `🗑 בוטלו ${deleted} תשלומים.`, keyboard: new InlineKeyboard().text('🏠 דשבורד', 'nav:dash') });
      return ack('בוטל');
    }

    // מנויים
    if (ns === 'sub') {
      if (action === 'list') { await edit(ctx, subscriptionsListView()); return ack(); }
      if (action === 'view') { await edit(ctx, subscriptionDetailView(Number(rest[0]))); return ack(); }
      if (action === 'renew') {
        const renewed = renewSubscription(Number(rest[0]));
        if (renewed) {
          await edit(ctx, { text: `✅ *${renewed.name}* חודש!\nתקופה חדשה עד *${renewed.end_date}* — אזכיר לקראת הסיום.`, keyboard: new InlineKeyboard().text('◀ מנויים', 'sub:list') });
        }
        return ack('חודש');
      }
      if (action === 'tgl') {
        const s = db.prepare('SELECT active FROM subscriptions WHERE id = ?').get(Number(rest[0]));
        if (s) db.prepare('UPDATE subscriptions SET active = ? WHERE id = ?').run(s.active ? 0 : 1, Number(rest[0]));
        await edit(ctx, subscriptionDetailView(Number(rest[0])));
        return ack('עודכן');
      }
      if (action === 'del') {
        db.prepare('DELETE FROM subscriptions WHERE id = ?').run(Number(rest[0]));
        await edit(ctx, subscriptionsListView());
        return ack('נמחק');
      }
      if (action === 'add') {
        pending.set(String(ctx.chat.id), { action: 'add_sub' });
        await ctx.reply('הקלד: שם, סכום (אופציונלי), ותאריך סיום.\nלמשל: "אינטרנט 99 עד 15/01/2027"', { reply_markup: MENU });
        return ack();
      }
      if (action === 'snooze') {
        // "הזכר מחר" — לא מסמן כלום; התזכורת תחזור מחר אוטומטית
        await edit(ctx, { text: '🔕 בסדר, אזכיר שוב מחר.', keyboard: new InlineKeyboard().text('📄 מנויים', 'sub:list') });
        return ack();
      }
    }

    // הוצאות קבועות
    if (ns === 'rec') {
      if (action === 'list') { pending.delete(String(ctx.chat.id)); await edit(ctx, recListView()); return ack(); }
      if (action === 'view') { await edit(ctx, recDetailView(Number(rest[0]))); return ack(); }
      if (action === 'tgl') {
        const r = db.prepare('SELECT active FROM recurring_expenses WHERE id = ?').get(Number(rest[0]));
        if (r) db.prepare('UPDATE recurring_expenses SET active = ? WHERE id = ?').run(r.active ? 0 : 1, Number(rest[0]));
        await edit(ctx, recDetailView(Number(rest[0])));
        return ack('עודכן');
      }
      if (action === 'del') {
        db.prepare('DELETE FROM recurring_expenses WHERE id = ?').run(Number(rest[0]));
        await edit(ctx, recListView());
        return ack('נמחקה (עסקאות קיימות נשארו)');
      }
      if (action === 'add') {
        pending.set(String(ctx.chat.id), { action: 'add_recurring_text' });
        await ctx.reply('הקלד: שם וסכום. למשל: "חוג כדורגל 150"', { reply_markup: MENU });
        return ack();
      }
      if (action === 'setcat') { await edit(ctx, recEditCategoryPicker(Number(rest[0]))); return ack(); }
      if (action === 'pickcat') {
        const id = Number(rest[0]);
        // 0 = "אוטומטית" → NULL, וכל מופע יסווג מחדש לפי חוקים/ML
        const catId = Number(rest[1]) || null;
        const exists = db.prepare('SELECT id FROM recurring_expenses WHERE id = ?').get(id);
        if (!exists) { await edit(ctx, recListView()); return ack('ההוצאה נמחקה'); }
        if (catId && !db.prepare('SELECT id FROM categories WHERE id = ?').get(catId)) {
          await edit(ctx, recDetailView(id));
          return ack('הקטגוריה נמחקה');
        }
        db.prepare('UPDATE recurring_expenses SET category_id = ? WHERE id = ?').run(catId, id);
        await edit(ctx, recDetailView(id));
        return ack('הקטגוריה עודכנה');
      }
      if (action === 'hour') {
        pending.set(String(ctx.chat.id), { action: 'rec_set_hour', id: Number(rest[0]) });
        await ctx.reply('באיזו שעה להוסיף את המופע? (0–23, למשל 7)\nאו "בלי" — המופע נוסף בטיק הראשון של היום.', { reply_markup: MENU });
        return ack();
      }
      // המשך זרימת ההוספה — הנתונים שנאספו עד כה ב-pending
      const p = pending.get(String(ctx.chat.id));
      if (action === 'freq' && p?.action === 'add_recurring_pick') {
        pending.set(String(ctx.chat.id), { ...p, freq: rest[0] });
        await edit(ctx, recDayPicker(rest[0]));
        return ack();
      }
      if (action === 'day' && p?.action === 'add_recurring_pick' && p.freq) {
        pending.set(String(ctx.chat.id), { ...p, day: Number(rest[0]) });
        await edit(ctx, recCategoryPicker());
        return ack();
      }
      if (action === 'cat' && p?.action === 'add_recurring_pick' && p.freq && p.day !== undefined) {
        pending.delete(String(ctx.chat.id));
        const catId = Number(rest[0]) || null;
        const result = db.prepare(`
          INSERT INTO recurring_expenses (merchant, amount, freq, day, category_id)
          VALUES (?, ?, ?, ?, ?)
        `).run(p.merchant, p.amount, p.freq, p.day, catId);
        // אם היום הוא יום המופע — העסקה הראשונה נוספת מיד (לא מחכים לטיק השעתי)
        const added = await runRecurring();
        const todayAdded = added.find((a) => a.recurring_id === result.lastInsertRowid);
        await edit(ctx, {
          text: `✅ נוספה הוצאה קבועה: ${p.merchant} — ${fmtILS.format(p.amount)}` +
            (todayAdded ? '\n📌 היום הוא יום המופע — העסקה הראשונה נוספה עכשיו.' : ''),
          keyboard: new InlineKeyboard().text('◀ קבועות', 'rec:list').text('🏠 דשבורד', 'nav:dash'),
        });
        return ack('נוצרה');
      }
    }

    // התראות
    if (ns === 'notify') {
      if (action === 'day') {
        const set = new Set((getSetting('notify_days', '0,2,4')).split(',').filter(Boolean));
        const d = rest[0];
        if (set.has(d)) set.delete(d); else set.add(d);
        setSetting('notify_days', [...set].sort().join(','));
        await edit(ctx, settingsView());
        return ack();
      }
      if (action === 'hour') {
        pending.set(String(ctx.chat.id), { action: 'set_hour' });
        await ctx.reply('באיזו שעה לשלוח התראות? (0–23)', { reply_markup: MENU });
        return ack();
      }
      if (action === 'pin') {
        // toggle קיבוע המקלדת (is_persistent). ניסיוני — עלול לתקוע את כפתור
        // ה"חזרה" ב-Android; המקלדת החדשה נשלחת מיד כדי שהשינוי ייכנס לתוקף.
        const next = getSetting('menu_persistent', '0') === '1' ? '0' : '1';
        setSetting('menu_persistent', next);
        MENU = buildMenu();
        await edit(ctx, settingsView());
        await ctx.reply(next === '1'
          ? '📌 קיבוע מקלדת הופעל (ניסיוני). אם כפתור "חזרה" נתקע — שלח /settings וכבה.'
          : '📌 קיבוע מקלדת כובה.', { reply_markup: MENU });
        return ack(next === '1' ? 'הופעל' : 'כובה');
      }
    }

    // ייבוא — אישור/ביטול
    if (ns === 'imp') {
      const key = String(ctx.chat.id);
      // מצב המתנה לתלוש: ה-PDF הבא ייקלט כתלוש משכורת ולא כדוח בנק.
      // ה-middleware של הזרימות מנקה את ה-pending בלחיצת כפתור תפריט (חילוץ).
      if (action === 'payslip') {
        pending.set(key, { action: 'payslip_wait_pdf' });
        await ctx.reply('🧾 שלח עכשיו את קובץ ה-PDF של תלוש המשכורת.\nלביטול — לחץ על כל כפתור בתפריט.', { reply_markup: MENU });
        return ack();
      }
      const imp = pendingImport.get(key);
      // החלטת מחזור החיוב לפני האישור — parity מול כפתור 📅 בתצוגה המקדימה
      // ב-web. בבוט אין טבלה לכל שורה, ולכן ההחלטה חלה על כל השורות שנופלות
      // למחזור שכבר נסגר יחד. הפיך, ולכן בלחיצה אחת.
      if (action === 'cyc' && imp) {
        const next = rest[0] === 'next';
        for (const r of imp.rows) if (r.cycle_closed) r.next_cycle = next;
        await edit(ctx, importPreviewView(imp));
        return ack(next ? '📅 יועברו למחזור הבא' : 'ההעברה בוטלה');
      }
      if (action === 'commit' && imp) {
        const r = commitRows(imp.rows, imp.source, { cycleDay: cycleDayFn });
        notifyImportCommitted(r, { excludeChatId: ctx.chat.id }).catch(() => {});
        pendingImport.delete(key);
        if (r.inserted > 0) mlTrain(labeledData()).catch(() => {});
        // ספירה מלאה "X מתוך Z שבקובץ" — כדי לא לפספס עסקאות
        const of = imp.total ? ` מתוך ${imp.total} שבקובץ` : '';
        const extra = `${r.updated ? ` · עודכנו ${r.updated} תוכניות תשלומים` : ''}${r.skippedDup ? ` · דולגו ${r.skippedDup} כפילויות` : ''}`;
        await edit(ctx, { text: `✅ נוספו ${r.inserted}${of} עסקאות${extra}`, keyboard: new InlineKeyboard().text('🏠 דשבורד', 'nav:dash') });
        return ack('נשמר');
      }
      if (action === 'cancel') {
        pendingImport.delete(key);
        await edit(ctx, { text: 'הייבוא בוטל.', keyboard: new InlineKeyboard().text('🏠 דשבורד', 'nav:dash') });
        return ack();
      }
    }

    // צ'אט חופשי — כניסה מחדש לזרימה / ניקוי היסטוריה
    if (ns === 'ask') {
      const key = String(ctx.chat.id);
      if (action === 'more') {
        pending.set(key, { action: 'chat_ask' });
        await ack();
        return ctx.reply('💬 מה השאלה?', { reply_markup: MENU });
      }
      if (action === 'clear') {
        clearChatHistory();
        pending.delete(key);
        await ack('נוקה');
        return ctx.reply('🧹 היסטוריית השיחה נוקתה (גם ב-web).', { reply_markup: MENU });
      }
      return ack();
    }

    // תלוש משכורת — ניתוח/מחיקה
    if (ns === 'ps') {
      const month = rest[0];
      if (!MONTH_RE.test(month ?? '')) return ack();
      if (action === 'del') {
        db.prepare('DELETE FROM payslips WHERE month = ?').run(month);
        await edit(ctx, { text: `🗑 תלוש ${month} נמחק.`, keyboard: new InlineKeyboard().text('🏠 דשבורד', 'nav:dash') });
        return ack('נמחק');
      }
      if (action === 'an') {
        const ready = llmReady();
        if (!ready.ok) {
          await ack();
          return ctx.reply(`${ready.error}\nהגדרות ב-web: ${lanUrl()}/#settings\n(או פתח את התלוש ב-${lanUrl()}/#payslip והעתק את הפרומפט לצ׳אטבוט).`, { reply_markup: MENU });
        }
        const row = db.prepare('SELECT extracted_text, fields_json FROM payslips WHERE month = ?').get(month);
        if (!row) { await ack(); return ctx.reply('לא נמצא תלוש לחודש הזה.', { reply_markup: MENU }); }
        await ack('מנתח…');
        await ctx.reply('🔍 מנתח את התלוש… ⏳ זה עשוי לקחת עד דקה', { reply_markup: MENU });
        try {
          const fields = JSON.parse(row.fields_json);
          const prompt = buildAnalysisPrompt(fields, row.extracted_text, month, payslipFields(prevMonth(month)));
          const { text, model } = await llmAnalyze(prompt);
          // ניתוח חדש מאפס את שאלות ההמשך — הן התייחסו לניתוח הקודם
          db.prepare(`UPDATE payslips SET analysis_md = ?, analysis_at = datetime('now','localtime'), analysis_model = ?, qa_json = '[]' WHERE month = ?`)
            .run(text, model, month);
          // בלי parse_mode — ה-Markdown של המודל שובר את הפרסר של טלגרם
          const chunks = splitMessage(stripLatexPlain(text));
          for (let i = 0; i < chunks.length; i++) {
            const last = i === chunks.length - 1;
            await ctx.reply(chunks[i], last
              ? { reply_markup: new InlineKeyboard().text('💬 שאל שאלה על התלוש', `ps:ask:${month}`).row().text('🏠 דשבורד', 'nav:dash') }
              : undefined);
          }
        } catch (err) {
          await ctx.reply(`❌ ${err.message}`, { reply_markup: MENU });
        }
        return;
      }
      // שאלת המשך חופשית — פותח זרימת קלט טקסט
      if (action === 'ask') {
        const row = db.prepare('SELECT analysis_md FROM payslips WHERE month = ?').get(month);
        if (!row) { await ack(); return ctx.reply('לא נמצא תלוש לחודש הזה.', { reply_markup: MENU }); }
        pending.set(String(ctx.chat.id), { action: 'payslip_ask', month });
        await ack();
        return ctx.reply(
          `💬 שאל כל שאלה על תלוש ${month}.\nלדוגמה: "מגיע לי החזר מס?" · "למה הנטו ירד החודש?"\n(לחיצה על כפתור בתפריט מבטלת)`,
          { reply_markup: MENU });
      }
      return ack();
    }

    return ack();
  } catch (err) {
    return ctx.answerCallbackQuery({ text: `שגיאה: ${err.message}`.slice(0, 190) });
  }
}

/* ==================== קלט טקסט רב-שלבי ==================== */
async function handlePending(ctx, p) {
  const key = String(ctx.chat.id);
  const text = ctx.message.text.trim();

  // ממתין לקובץ ולא לטקסט — משאירים את הזרימה פתוחה ומזכירים מה נדרש
  if (p.action === 'payslip_wait_pdf') {
    return ctx.reply('🧾 ממתין לקובץ PDF של התלוש. שלח אותו כמסמך, או לחץ על כפתור בתפריט לביטול.', { reply_markup: MENU });
  }
  // צ'אט חופשי על כל נתוני האפליקציה (server/lib/assistant.js — אותו מנוע ואותו
  // הקשר כמו הפאנל ב-web). בשונה משאר הזרימות, ה-pending נשאר פעיל גם אחרי
  // תשובה מוצלחת — כך השיחה נמשכת; יציאה בלחיצה על כפתור תפריט (escape hatch).
  if (p.action === 'chat_ask') {
    const ready = llmReady();
    if (!ready.ok) {
      pending.delete(key);
      return ctx.reply(`${ready.error}\nהגדרות ב-web: ${lanUrl()}/#settings`, { reply_markup: MENU });
    }
    await ctx.reply('💭 חושב… ⏳', { reply_markup: MENU });
    try {
      // view=general — לבוט אין טאבים, ולכן תמצית כללית; שאילתות נוספות
      // נשלפות ע"י המודל לפי הצורך דרך פרוטוקול ה-#DATA.
      const { text: answer, queries } = await askAssistant({
        question: text, view: 'general', month: currentMonth(), source: 'bot',
      });
      const chunks = splitMessage(stripLatexPlain(answer));
      for (let i = 0; i < chunks.length; i++) {
        const last = i === chunks.length - 1;
        await ctx.reply(chunks[i], last
          ? {
            reply_markup: new InlineKeyboard()
              .text('💬 שאלה נוספת', 'ask:more').row()
              .text('🧹 נקה שיחה', 'ask:clear').text('🏠 דשבורד', 'nav:dash'),
          }
          : undefined);
      }
      if (queries?.length) {
        await ctx.reply(`📎 נתונים שנשלפו: ${queries.join(' · ')}`, { reply_markup: MENU });
      }
    } catch (err) {
      // הזרימה נשארת פתוחה — אפשר לנסח מחדש בלי ללחוץ שוב על הכפתור
      await ctx.reply(`❌ ${err.message}\nאפשר לנסות לנסח מחדש, או ללחוץ על כפתור בתפריט ליציאה.`, { reply_markup: MENU });
    }
    return;
  }
  // שאלת המשך על התלוש. ה-pending נמחק רק אחרי תשובה מוצלחת, כדי ששגיאת רשת
  // לא תזרוק את המשתמש מהזרימה.
  if (p.action === 'payslip_ask') {
    const ready = llmReady();
    if (!ready.ok) {
      pending.delete(key);
      return ctx.reply(`${ready.error}\nהגדרות ב-web: ${lanUrl()}/#settings`, { reply_markup: MENU });
    }
    const row = db.prepare('SELECT extracted_text, fields_json, analysis_md, qa_json FROM payslips WHERE month = ?').get(p.month);
    if (!row) {
      pending.delete(key);
      return ctx.reply('לא נמצא תלוש לחודש הזה.', { reply_markup: MENU });
    }
    await ctx.reply('💭 חושב… ⏳', { reply_markup: MENU });
    try {
      const history = JSON.parse(row.qa_json || '[]');
      const prompt = buildQuestionPrompt({
        question: text,
        fields: JSON.parse(row.fields_json),
        strippedText: row.extracted_text,
        month: p.month,
        analysisMd: row.analysis_md,
        history,
      });
      const { text: answer, model } = await llmAnalyze(prompt);
      const entry = { q: text, a: answer, at: new Date().toISOString().slice(0, 19).replace('T', ' '), model };
      db.prepare('UPDATE payslips SET qa_json = ? WHERE month = ?')
        .run(JSON.stringify([...history, entry].slice(-20)), p.month);
      pending.delete(key);
      const chunks = splitMessage(stripLatexPlain(answer));
      for (let i = 0; i < chunks.length; i++) {
        const last = i === chunks.length - 1;
        await ctx.reply(chunks[i], last
          ? { reply_markup: new InlineKeyboard().text('💬 שאלה נוספת', `ps:ask:${p.month}`).row().text('🏠 דשבורד', 'nav:dash') }
          : undefined);
      }
    } catch (err) {
      // הזרימה נשארת פתוחה — המשתמש יכול לנסח מחדש בלי ללחוץ שוב על הכפתור
      await ctx.reply(`❌ ${err.message}\n\nנסה לנסח מחדש, או לחץ על כפתור בתפריט לביטול.`, { reply_markup: MENU });
    }
    return;
  }
  if (p.action === 'tx_search') {
    pending.delete(key);
    return ctx.reply(txListView(text).text, { parse_mode: 'Markdown', reply_markup: txListView(text).keyboard });
  }
  if (p.action === 'tx_tag_installment') {
    const m = text.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (!m) return ctx.reply('פורמט לא תקין. הקלד למשל: 1/3', { reply_markup: MENU });
    try {
      const row = tagInstallment(p.id, Number(m[1]), Number(m[2]));
      notifyTransactionChanged(row, { action: 'updated', excludeChatId: ctx.chat.id }).catch(() => {});
    } catch (err) {
      return ctx.reply(`❌ ${err.message}`, { reply_markup: MENU });
    }
    pending.delete(key);
    const view = txDetailView(p.id);
    return ctx.reply(view.text, { parse_mode: 'Markdown', reply_markup: view.keyboard });
  }
  if (p.action === 'tx_manage') {
    pending.delete(key);
    const num = Number(text);
    if (Number.isInteger(num) && num >= 1 && num <= p.ids.length) {
      const view = txDetailView(p.ids[num - 1]);
      return ctx.reply(view.text, { parse_mode: 'Markdown', reply_markup: view.keyboard });
    }
    const view = txListView(text);
    return ctx.reply(view.text, { parse_mode: 'Markdown', reply_markup: view.keyboard });
  }
  if (p.action === 'add_cat') {
    const m = text.match(/^(\p{Emoji}️?)?\s*(.+)$/u);
    const icon = m?.[1] || '💳';
    const name = (m?.[2] || text).trim();
    // הגנת עומק: שם קטגוריה בלי תווי HTML (מוצג ב-web) ובאורך סביר
    if (!name || name.length > 40 || /[<>]/.test(name)) return ctx.reply('שם לא תקין (עד 40 תווים, בלי < >).', { reply_markup: MENU });
    try {
      db.prepare('INSERT INTO categories (name, icon) VALUES (?, ?)').run(name, icon);
    } catch {
      return ctx.reply('קטגוריה בשם זה כבר קיימת. נסה שם אחר.', { reply_markup: MENU });
    }
    pending.delete(key);
    return ctx.reply(`✅ נוספה קטגוריה: ${icon} ${name}`, { reply_markup: MENU });
  }
  if (p.action === 'rename_cat') {
    const name = text.trim();
    if (!name || name.length > 40 || /[<>]/.test(name)) return ctx.reply('שם לא תקין (עד 40 תווים, בלי < >).', { reply_markup: MENU });
    pending.delete(key);
    db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, p.id);
    return ctx.reply(`✅ השם עודכן ל-${name}`, { reply_markup: MENU });
  }
  if (p.action === 'add_rule_pattern') {
    const check = validateUserRegex(text);
    if (!check.ok) return ctx.reply(`❌ ${check.error}`, { reply_markup: MENU });
    pending.set(key, { action: 'add_rule_cat', pattern: text });
    const picker = ruleCategoryPicker();
    return ctx.reply(picker.text, { reply_markup: picker.keyboard });
  }
  if (p.action === 'add_recurring_text') {
    // "חוג כדורגל 150" → שם + סכום; ההמשך (תדירות/יום/קטגוריה) בכפתורים
    const m = text.match(/^(.+?)\s+(\d+(?:\.\d{1,2})?)$/);
    if (!m) return ctx.reply('פורמט שגוי. נסה: "חוג כדורגל 150"', { reply_markup: MENU });
    const merchant = m[1].trim().slice(0, 200);
    const amount = Number(m[2]);
    if (!merchant || !(amount > 0)) return ctx.reply('שם או סכום לא תקינים. נסה שוב.', { reply_markup: MENU });
    pending.set(key, { action: 'add_recurring_pick', merchant, amount });
    const picker = recFreqPicker();
    return ctx.reply(picker.text, { reply_markup: picker.keyboard });
  }
  if (p.action === 'add_recurring_pick') {
    // באמצע בחירת כפתורים — טקסט חופשי לא רלוונטי; מזכירים איפה אנחנו
    return ctx.reply('בחר מהכפתורים למעלה (תדירות/יום/קטגוריה), או לחץ ❌ ביטול.', { reply_markup: MENU });
  }
  // שעה להוצאה קבועה — "7" / "בלי" (ראו public/app.js כפתור 🕐, אותה סמנטיקה)
  if (p.action === 'rec_set_hour') {
    const r = db.prepare('SELECT * FROM recurring_expenses WHERE id = ?').get(p.id);
    if (!r) { pending.delete(key); return ctx.reply('ההוצאה הקבועה נמחקה בינתיים.', { reply_markup: MENU }); }
    const t = text.trim();
    let hour = null;
    if (!/^(בלי|ללא)$/.test(t)) {
      hour = Number(t);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        return ctx.reply('שעה לא תקינה. הקלד מספר 0–23, או "בלי".', { reply_markup: MENU });
      }
    }
    pending.delete(key);
    db.prepare('UPDATE recurring_expenses SET hour = ? WHERE id = ?').run(hour, p.id);
    const view = recDetailView(p.id);
    return ctx.reply(
      `✅ ${hour != null ? `השעה נקבעה ל-${String(hour).padStart(2, '0')}:00` : 'השעה הוסרה — המופע נוסף בטיק הראשון של היום'}\n\n${view.text}`,
      { parse_mode: 'Markdown', reply_markup: view.keyboard },
    );
  }
  if (p.action === 'add_income') {
    // סכום ותאריך אופציונליים בכל מיקום; יתרת הטקסט היא שם ההכנסה.
    let body = text.replace(/\s+/g, ' ').trim();
    let date = null;
    const dm = body.match(/(?:^|\s)(\d{1,2}[\/.]\d{1,2}(?:[\/.]\d{2,4})?)(?:\s|$)/);
    if (dm) { date = normalizeDayMonth(dm[1]); body = body.replace(dm[1], ' ').replace(/\s+/g, ' ').trim(); }
    const am = body.match(/(?<![\d.])(\d+(?:\.\d{1,2})?)(?![\d.])/);
    if (!am) return ctx.reply('פורמט שגוי. נסה: "משכורת 14000", "מתנה 500 10/07" או "1000 מתנה 15.6"', { reply_markup: MENU });
    const amount = Number(am[1]);
    if (!(amount > 0)) return ctx.reply('סכום לא תקין. נסה שוב, למשל: "משכורת 14000".', { reply_markup: MENU });
    const name = body.replace(am[0], ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name) return ctx.reply('חסר שם להכנסה. נסה: "מתנה 500" או "1000 מתנה 15.6".', { reply_markup: MENU });
    pending.delete(key);
    const result = db.prepare('INSERT INTO income (name, amount, date) VALUES (?, ?, ?)').run(name, amount, date);
    notifyIncomeChanged(db.prepare('SELECT * FROM income WHERE id = ?').get(result.lastInsertRowid),
      { excludeChatId: ctx.chat.id }).catch(() => {});
    return ctx.reply(`✅ נוספה הכנסה: ${name} — ${fmtILS.format(amount)}${date ? ` (${date})` : ''}`, { reply_markup: MENU });
  }
  // עריכת סכום הכנסה קבועה — משכורת ודומיה משתנות מדי חודש (ראו public/app.js startIncomeAmountEdit)
  if (p.action === 'edit_income_name') {
    const name = text.trim().slice(0, 60);
    if (!name) return ctx.reply('שם ריק. נסה שוב.', { reply_markup: MENU });
    const row = db.prepare('SELECT * FROM income WHERE id = ?').get(p.id);
    if (!row) { pending.delete(key); return ctx.reply('ההכנסה נמחקה בינתיים.', { reply_markup: MENU }); }
    pending.delete(key);
    db.prepare('UPDATE income SET name = ? WHERE id = ?').run(name, p.id);
    if (row.name !== name) notifyIncomeChanged({ ...row, name: name }, { action: 'updated', excludeChatId: ctx.chat.id }).catch(() => {});
    const view = incomeDetailView(p.id);
    return ctx.reply(`✅ השם עודכן ל-${name}\n\n${view.text}`, { parse_mode: 'Markdown', reply_markup: view.keyboard });
  }
  if (p.action === 'edit_income_amount') {
    const amount = Number(text.replace(/[,₪\s]/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) return ctx.reply('סכום לא תקין. נסה שוב, למשל: 14500', { reply_markup: MENU });
    const row = db.prepare('SELECT * FROM income WHERE id = ?').get(p.id);
    if (!row) { pending.delete(key); return ctx.reply('ההכנסה נמחקה בינתיים.', { reply_markup: MENU }); }
    pending.delete(key);
    db.prepare('UPDATE income SET amount = ? WHERE id = ?').run(amount, p.id);
    if (row.amount !== amount) notifyIncomeChanged({ ...row, amount: amount }, { action: 'updated', excludeChatId: ctx.chat.id }).catch(() => {});
    const view = incomeDetailView(p.id);
    return ctx.reply(`✅ הסכום עודכן ל-${fmtILS.format(amount)}\n\n${view.text}`, { parse_mode: 'Markdown', reply_markup: view.keyboard });
  }
  // עריכת תאריך הכנסה — "בלי"/"ללא" מסירים תאריך (נספרת בכל חודש), אחרת dd/mm(/yyyy)
  if (p.action === 'edit_income_date') {
    const row = db.prepare('SELECT * FROM income WHERE id = ?').get(p.id);
    if (!row) { pending.delete(key); return ctx.reply('ההכנסה נמחקה בינתיים.', { reply_markup: MENU }); }
    const clear = /^(בלי|ללא|נקה|מחק)$/.test(text.trim());
    const date = clear ? null : normalizeDayMonth(text.trim());
    if (!clear && date === localDate() && !/\d/.test(text)) {
      return ctx.reply('פורמט לא תקין. הקלד למשל: 10/07, או "בלי" כדי להסיר תאריך.', { reply_markup: MENU });
    }
    pending.delete(key);
    db.prepare('UPDATE income SET date = ? WHERE id = ?').run(date, p.id);
    if (row.date !== date) notifyIncomeChanged({ ...row, date: date }, { action: 'updated', excludeChatId: ctx.chat.id }).catch(() => {});
    const view = incomeDetailView(p.id);
    return ctx.reply(`✅ התאריך עודכן${date ? ` ל-${date}` : ' — הוסר (נספרת בכל חודש)'}\n\n${view.text}`, { parse_mode: 'Markdown', reply_markup: view.keyboard });
  }
  if (p.action === 'add_sub') {
    // "אינטרנט 99 עד 15/01/2027" / "ביטוח עד 01/09/2026"
    const m = text.match(/^(.+?)(?:\s+(\d+(?:\.\d{1,2})?))?\s+עד\s+(\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4})$/);
    if (!m) return ctx.reply('פורמט שגוי. נסה: "אינטרנט 99 עד 15/01/2027"', { reply_markup: MENU });
    const endDate = normalizeDayMonth(m[3]);
    if (endDate <= localDate()) return ctx.reply('תאריך הסיום חייב להיות בעתיד. נסה שוב, למשל: "אינטרנט 99 עד 15/01/2027".', { reply_markup: MENU });
    pending.delete(key);
    db.prepare(`
      INSERT INTO subscriptions (name, amount, start_date, end_date) VALUES (?, ?, ?, ?)
    `).run(m[1].trim().slice(0, 200), m[2] ? Number(m[2]) : null, localDate(), endDate);
    return ctx.reply(`✅ נוסף מנוי: ${m[1].trim()} עד ${endDate}\nאזכיר לך לחדש 14 יום לפני הסיום 🔔`, { reply_markup: MENU });
  }
  if (p.action === 'set_hour') {
    const h = Number(text);
    if (!Number.isInteger(h) || h < 0 || h > 23) return ctx.reply('שעה לא תקינה (0–23).', { reply_markup: MENU });
    pending.delete(key);
    setSetting('notify_hour', String(h));
    return ctx.reply(`✅ שעת התראה: ${h}:00`, { reply_markup: MENU });
  }
  pending.delete(key);
}

/* ==================== מסמכים (CSV/PDF/תמונה) עם אישור ==================== */
const MAX_IMPORT_SIZE = 20 * 1024 * 1024; // 20MB — תמונות מהטלפון גדולות מ-CSV/PDF טיפוסי

// תצוגה מקדימה + כפתורי אישור/ביטול — משותף ל-handleDocument ול-handlePhoto.
// fuzzyDup: כפילות "רכה" (תאריך+סכום בלי בית עסק) — לתמונות OCR בלבד.
async function presentImportPreview(ctx, parsed, source, icon, { fuzzyDup = false } = {}) {
  const rows = enrichRows(parsed.rows, source, { fuzzyDup, cycleDay: cycleDayFn });
  const newRows = rows.filter((r) => !r.duplicate);
  // total = כמה עסקאות זוהו בקובץ (לספירת "X מתוך Z" אחרי האישור)
  pendingImport.set(String(ctx.chat.id), { source, rows: newRows, total: parsed.rows.length, skipped: parsed.skipped });

  const view = importPreviewView(pendingImport.get(String(ctx.chat.id)), icon);
  await ctx.reply(view.text, { parse_mode: 'Markdown', reply_markup: view.keyboard });
}

// הודעת התצוגה המקדימה + המקלדת. מופרדת כדי ש-`imp:cyc` יוכל לרנדר מחדש
// אחרי שינוי ההחלטה על מחזור החיוב, בלי לפרסר את הקובץ שוב.
export function importPreviewView(imp, icon = '📄') {
  const rows = imp.rows;
  // שורות שלפי תאריך הרכישה נופלות למחזור שכבר נסגר — הדפוס של דוח
  // "פירוט חיובים קרובים", שכולל גם את יום סגירת המחזור.
  const closed = rows.filter((r) => r.cycle_closed);
  const moved = closed.some((r) => r.next_cycle);
  const preview = rows.slice(0, 8).map((r) =>
    `${r.next_cycle ? '📅' : r.cycle_closed ? '⚠️' : '•'} ${r.date.slice(5)} ${r.merchant.slice(0, 22)} ${fmtILS.format(r.amount)}`).join('\n');
  const kb = new InlineKeyboard();
  if (closed.length) {
    kb.text(moved ? `↩︎ בטל — ${closed.length} לפי תאריך הרכישה` : `📅 ${closed.length} למחזור הבא`,
      `imp:cyc:${moved ? 'clear' : 'next'}`).row();
  }
  kb.text(`✅ אשר ${rows.length}`, 'imp:commit').text('❌ בטל', 'imp:cancel');
  const cycleNote = closed.length
    ? `\n‏⚠️ ${closed.length} שורות נופלות למחזור שכבר נסגר${moved ? ' — יועברו למחזור הבא 📅' : ''}.`
    : '';
  const text =
    `${icon} *תצוגה מקדימה — ${imp.total} עסקאות*\n` +
    `${rows.length} חדשות · ${imp.total - rows.length} כפילויות${imp.skipped ? ` · ${imp.skipped} לא זוהו` : ''}${cycleNote}\n\n` +
    `${preview}${rows.length > 8 ? '\n…' : ''}`;
  return { text, keyboard: kb };
}

// הורדת קובץ שנשלח לבוט → Buffer
async function downloadFile(ctx) {
  const file = await ctx.getFile();
  const token = getSetting('telegram_token');
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  return Buffer.from(await res.arrayBuffer());
}

// תלוש משכורת — נכנס רק כשהמשתמש לחץ "העלאת תלוש" (pending), אחרת PDF נקלט
// כדוח בנק כרגיל.
async function handlePayslipDocument(ctx, filename) {
  await ctx.reply('🧾 קורא את התלוש… ⏳', { reply_markup: MENU });
  try {
    const buf = await downloadFile(ctx);
    const text = await extractPdfText(buf);
    const month = detectMonth(text);
    if (!month) {
      return ctx.reply(`לא זוהה חודש בתלוש. העלה אותו ב-web ובחר את החודש ידנית: ${lanUrl()}/#payslip`, { reply_markup: MENU });
    }
    const r = storePayslip({ buf, filename, month, text });
    const lines = [
      `🧾 *תלוש ${month}* ${r.replaced ? '(הוחלף)' : 'נשמר'}`,
      r.fields.gross ? `ברוטו: ${fmtILS.format(r.fields.gross)}` : null,
      r.fields.net ? `נטו: ${fmtILS.format(r.fields.net)}` : null,
      r.piiRemoved ? `🔒 הוסרו ${r.piiRemoved} פרטים מזהים` : null,
      '',
    ].filter((l) => l !== null);
    const icon = { ok: '✅', warn: '🟡', fail: '🔴' };
    const bad = r.checks.filter((c) => c.status !== 'ok');
    lines.push(bad.length ? '*ממצאים:*' : '✅ כל הבדיקות האוטומטיות תקינות');
    for (const c of bad.slice(0, 3)) lines.push(`${icon[c.status]} ${escapeMd(c.label)} — ${escapeMd(c.detail)}`);
    if (bad.length > 3) lines.push(`…ועוד ${bad.length - 3}`);

    const kb = new InlineKeyboard()
      .text('🔍 נתח עם Gemini', `ps:an:${month}`).row()
      .text('💬 שאל שאלה', `ps:ask:${month}`).row()
      .text('🗑 מחק', `ps:del:${month}`).text('🏠 דשבורד', 'nav:dash');
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown', reply_markup: kb });
  } catch (err) {
    await ctx.reply(`❌ ${err.message}`, { reply_markup: MENU });
  }
}

async function handleDocument(ctx) {
  const doc = ctx.message.document;
  const name = (doc.file_name ?? '').toLowerCase();
  if (!name.endsWith('.csv') && !name.endsWith('.pdf')) {
    return ctx.reply('קבצי CSV או PDF בלבד כמסמך. לתמונה (JPG/PNG) — שלח כתמונה רגילה, לא כקובץ מצורף.', { reply_markup: MENU });
  }
  if (doc.file_size > MAX_IMPORT_SIZE) return ctx.reply('הקובץ גדול מדי (מקסימום 20MB).', { reply_markup: MENU });

  // מצב "ממתין לתלוש" — ה-PDF הזה הוא תלוש משכורת, לא דוח בנק
  const key = String(ctx.chat.id);
  if (pending.get(key)?.action === 'payslip_wait_pdf') {
    pending.delete(key);
    if (!name.endsWith('.pdf')) return ctx.reply('תלוש משכורת חייב להיות PDF. נסה שוב דרך כפתור הייבוא.', { reply_markup: MENU });
    return handlePayslipDocument(ctx, doc.file_name ?? '');
  }

  await ctx.reply('מעבד את הקובץ… ⏳', { reply_markup: MENU });
  try {
    const buf = await downloadFile(ctx);
    const parsed = name.endsWith('.pdf') ? await parsePdf(buf) : parseCsv(buf);
    const source = parsed.format === 'csv' ? 'csv' : 'pdf';
    await presentImportPreview(ctx, parsed, source, '📥');
  } catch (err) {
    await ctx.reply(`❌ ${err.message}`, { reply_markup: MENU });
  }
}

// צילום דוח מהטלפון (JPG/PNG) → OCR → אותה תצוגה מקדימה כמו PDF/CSV.
// תמונה מתויגת source='pdf' (אותה סמנטיקת ייבוא/dedup, ראו server/lib/ocr.js).
async function handlePhoto(ctx) {
  const sizes = ctx.message.photo;
  const largest = sizes[sizes.length - 1]; // טלגרם ממיין מהקטן לגדול
  if (largest.file_size && largest.file_size > MAX_IMPORT_SIZE) {
    return ctx.reply('התמונה גדולה מדי (מקסימום 20MB).', { reply_markup: MENU });
  }
  await ctx.reply('קורא את התמונה (OCR)… ⏳ זה עשוי לקחת כמה שניות', { reply_markup: MENU });
  try {
    const buf = await downloadFile(ctx);
    const parsed = await parseImage(buf);
    await presentImportPreview(ctx, parsed, 'pdf', '📷', { fuzzyDup: true });
  } catch (err) {
    await ctx.reply(`❌ ${err.message}`, { reply_markup: MENU });
  }
}

/* ==================== טקסט חופשי ==================== */
async function handleText(ctx) {
  const key = String(ctx.chat.id);
  const p = pending.get(key);
  if (p) return handlePending(ctx, p);

  const text = ctx.message.text;

  if (/^(מצב|תזרים|סטטוס)$/.test(text.trim())) {
    return ctx.reply(await flowMessage(), { parse_mode: 'Markdown', reply_markup: MENU });
  }
  // חיפוש טקסט חופשי — "חפש מפעילה" / "חיפוש רמי לוי". מחפש merchant+description
  // בכל התאריכים (כמו ה-q ב-web ו-txSearchView דרך הכפתור 🔍).
  const searchM = text.trim().match(/^(?:חפש|חיפוש)\s+(.+)$/s);
  if (searchM) {
    const v = txSearchView(searchM[1].trim().slice(0, 60));
    return ctx.reply(v.text, { parse_mode: 'Markdown', reply_markup: v.keyboard });
  }
  if (looksLikeBankSms(text)) {
    const sms = parseSms(text);
    if (sms) {
      if (findDuplicate({ ...sms, type: 'expense' })) {
        return ctx.reply(`⚠️ SMS זה כבר נקלט: ${sms.merchant} — ${fmtILS.format(sms.amount)} (${sms.date}).\nלא נוסף שוב.`, { reply_markup: MENU });
      }
      const tx = await addTransaction({ ...sms, source: 'sms' });
      notifyTransactionAdded(tx, { excludeChatId: ctx.chat.id }).catch(() => {});
      const kb = new InlineKeyboard()
        .text('🗑 ביטול', `tx:del:${tx.id}`).text('✏️ קטגוריה', `tx:cat:${tx.id}`)
        .text('📅 מחזור הבא', `tx:chg:${tx.id}:next`);
      return ctx.reply(`📩 נקלט מ-SMS:\n${tx.merchant} — ${fmtILS.format(tx.amount)} (${tx.date})` +
        (tx.category_name ? `\nקטגוריה: ${tx.category_icon} ${tx.category_name}` : ''), { reply_markup: kb });
    }
    return ctx.reply('זיהיתי SMS אבל לא חילצתי פרטים. שלח: "בית עסק סכום"', { reply_markup: MENU });
  }
  const parsed = parseTextExpense(text);
  if (!parsed) {
    return ctx.reply('לא הבנתי 🤔\nשלח: "קפה גרג 25", "מחשב 3600 ב-12 תשלומים", "הכנסה 500 בונוס", "חפש מפעילה", "מצב", 💬 שאלה חופשית, או בחר מהתפריט.', { reply_markup: MENU });
  }

  // תשלומים: "מחשב 3600 ב-12 תשלומים" → פיצול חודשי
  if (parsed.installments && parsed.installments >= 2) {
    try {
      const result = await addInstallments({
        date: parsed.date, amount: parsed.amount, count: parsed.installments,
        merchant: parsed.merchant, source: 'telegram',
      });
      notifyTransactionAdded(
        { type: 'expense', merchant: parsed.merchant, amount: result.total, date: result.first.date,
          category_name: result.first.category_name, category_icon: result.first.category_icon },
        { excludeChatId: ctx.chat.id }
      ).catch(() => {});
      const kb = new InlineKeyboard().text('🗑 בטל את כל התשלומים', `tx:delgroup:${result.group}`);
      return ctx.reply(
        `✅ נשמר: ${parsed.merchant} — ${fmtILS.format(result.total)} ב-${result.count} תשלומים\n` +
        `כל חודש: ${fmtILS.format(result.per_amount)} (מ-${result.first.date})` +
        (result.first.category_name ? `\nקטגוריה: ${result.first.category_icon} ${result.first.category_name}` : ''),
        { reply_markup: kb }
      );
    } catch (err) {
      return ctx.reply(`❌ ${err.message}`, { reply_markup: MENU });
    }
  }

  const tx = await addTransaction({ ...parsed, source: 'telegram' });
  notifyTransactionAdded(tx, { excludeChatId: ctx.chat.id }).catch(() => {});
  const sign = tx.type === 'income' ? '+' : '−';
  const kb = new InlineKeyboard().text('🗑 ביטול', `tx:del:${tx.id}`).text('✏️ קטגוריה', `tx:cat:${tx.id}`);
  return ctx.reply(`✅ נשמר: ${tx.merchant} ${sign}${fmtILS.format(tx.amount)}` +
    (tx.category_name ? `\nקטגוריה: ${tx.category_icon} ${tx.category_name}` : ''), { reply_markup: kb });
}

/* ==================== התראות מתוזמנות ==================== */
// chatIds — שני ה-slots שווי-ההרשאות (אם שניהם מחוברים, שניהם מקבלים את אותה התראה).
// due מחושב פעם אחת ומסומן reminded פעם אחת — לא לפי כל נמען, אחרת נמען שני היה מפוספס
// כי dueSubscriptions מסנן last_reminded=today אחרי השליחה הראשונה.
async function sendSubscriptionReminders(chatIds) {
  const due = dueSubscriptions();
  for (const s of due) {
    const left = subsDaysLeft(s.end_date);
    const kb = new InlineKeyboard()
      .text('🔄 חידשתי', `sub:renew:${s.id}`).text('🔕 מחר', `sub:snooze:${s.id}`).row()
      .text('⏸ הפסק מעקב', `sub:tgl:${s.id}`);
    const when = left < 0 ? `פג לפני ${-left} ימים ⚠️` : left === 0 ? 'מסתיים *היום*' : `מסתיים בעוד *${left} ימים*`;
    for (const chatId of chatIds) {
      try {
        await bot.api.sendMessage(chatId,
          `🔔 *תזכורת חידוש מנוי*\n\n📄 *${s.name}*${s.amount ? ` (${fmtILS.format(s.amount)})` : ''}\n${when} — ${s.end_date.split('-').reverse().join('/')}`,
          { parse_mode: 'Markdown', reply_markup: kb });
      } catch { /* צ'אט לא זמין — ננסה מחר */ }
    }
    markReminded(s.id);
  }
}

/** שולח לשני המשתמשים הודעה עם מקלדת התפריט העדכנית. נקרא אחרי שינוי
 *  menu_persistent מה-web — בלי זה הדגל נשמר אבל המקלדת בצ'אט נשארת הישנה
 *  (המקלדת הפעילה בטלגרם היא זו שצורפה להודעה האחרונה, לא ה-state בשרת). */
export async function pushMenuToUsers(text = '📌 התפריט רוענן 👇') {
  if (!bot || !status.active) return false;
  const chatIds = [getSetting('telegram_chat_id'), getSetting('telegram_chat_id_2')].filter(Boolean);
  for (const chatId of chatIds) {
    try { await bot.api.sendMessage(chatId, text, { reply_markup: MENU }); } catch { /* צ'אט לא זמין */ }
  }
  return true;
}

/** broadcast לשני המשתמשים המחוברים (slots שווי-הרשאות). משמש את scheduler
 *  ההוצאות הקבועות ב-server/index.js. inlineKeyboard: מערך שורות של
 *  {text, callback_data} (פורמט ה-API הגולמי של טלגרם), או null בלי כפתורים. */
export async function notifyAllUsers(text, inlineKeyboard = null, options = {}) {
  if (!bot || !status.active) return false;
  const chatIds = [getSetting('telegram_chat_id'), getSetting('telegram_chat_id_2')].filter(Boolean);
  const opts = inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {};
  return deliverNotification((id, message, settings) => bot.api.sendMessage(id, message, settings),
    chatIds, text, opts, { ...options, onError: (id, err) =>
      console.error(`[bot] notification failed for chat ${id}:`, err?.description || err?.message) });
}

export function notifyIncomeChanged(row, options = {}) {
  return notifyAllUsers(activityMessage(row, { ...options, income: true }), null, options);
}

export function notifyTransactionChanged(row, options = {}) {
  return notifyAllUsers(activityMessage(row, options), null, options);
}

export function notifyImportCommitted(result, options = {}) {
  const text = importMessage(result);
  return text ? notifyAllUsers(text, null, options) : Promise.resolve(false);
}

/** התראה לבן/בת הזוג כשמתווספת עסקה (הכנסה/הוצאה) בודדת — web או בוט.
 *  excludeChatId: לדלג על מי שכבר ראה אישור באותו צ'אט (הוספה דרך הבוט
 *  עצמו מקבלת תשובה ישירה — לא לשלוח לו גם broadcast); web (בלי זהות
 *  ידועה) לא מדלג על אף אחד — שני הצדדים מקבלים. עסקאות מייבוא bulk
 *  (CSV/PDF, tx:manage) לא עוברות כאן במכוון — היו מציפות בהודעות. */
export async function notifyTransactionAdded(tx, { excludeChatId } = {}) {
  const sign = tx.type === 'income' ? '+' : '−';
  const icon = tx.type === 'income' ? '💵' : (tx.category_icon || '💳');
  const text = [
    `${icon} עסקה חדשה: ${tx.merchant || '—'} ${sign}${fmtILS.format(tx.amount)}`,
    tx.category_name ? `קטגוריה: ${tx.category_icon} ${tx.category_name}` : null,
    tx.date ? `תאריך: ${tx.date}` : null,
  ].filter(Boolean).join('\n');
  return notifyAllUsers(text, null, { excludeChatId });
}

function startNotifier() {
  clearInterval(notifyTimer);
  let lastSent = '';
  notifyTimer = setInterval(async () => {
    if (!bot || !status.active) return;
    const chatIds = [getSetting('telegram_chat_id'), getSetting('telegram_chat_id_2')].filter(Boolean);
    if (!chatIds.length) return;
    const days = (getSetting('notify_days', '0,2,4')).split(',').filter(Boolean).map(Number);
    const hour = Number(getSetting('notify_hour', '9'));
    const now = new Date();
    const today = localDate(now);
    if (now.getHours() === hour && lastSent !== today) {
      lastSent = today;
      // תזכורות חידוש מנוי — כל יום בשעת ההתראה (markReminded מונע כפילות יומית)
      await sendSubscriptionReminders(chatIds);
      // סיכום תזרים — רק בימים שנבחרו, לכל הנמענים
      if (days.includes(now.getDay())) {
        const text = await flowMessage();
        for (const chatId of chatIds) {
          try { await bot.api.sendMessage(chatId, text, { parse_mode: 'Markdown' }); } catch { /* retry next */ }
        }
      }
    }
  }, 60 * 1000);
  notifyTimer.unref?.();
}

/* ==================== מחזור חיים ==================== */
export async function startBot() {
  const token = getSetting('telegram_token');
  if (!token) {
    status = { active: false, error: null };
    console.log('  בוט:      לא מוגדר (הוסף token בעמוד ההגדרות)');
    return;
  }
  try {
    bot = new Bot(token);

    // error boundary — שגיאה ב-handler בודד (Markdown פגום, ערך undefined,
    // רשת) לא תפיל את לולאת ה-polling. בלי זה הבוט "חי" מבחינת health אך מפסיק
    // להגיב, וה-watchdog (שבודק רק health) לא מזהה. מדפיס לוג וממשיך.
    bot.catch((err) => {
      const uid = err.ctx?.update?.update_id;
      console.error(`[bot] שגיאת handler (update ${uid ?? '?'}):`, err.error?.message ?? err.error);
    });

    // ---- שכבת הרשאה: שני slots שווי-הרשאות (למשל בני/בנות זוג) ----
    bot.use(async (ctx, next) => {
      const owner1 = getSetting('telegram_chat_id', '');
      const owner2 = getSetting('telegram_chat_id_2', '');
      const isStart = Boolean(ctx.message?.text?.startsWith('/start'));
      const decision = authDecisionMulti(ctx.from?.id, owner1, owner2, isStart);
      if (decision === 'allow') return next();
      if (decision === 'claim') return ctx.reply('שלח /start כדי לחבר את החשבון.');
      // deny — גורם זר: חסימה שקטה, בלי לחשוף מידע
    });

    // escape hatch — לחיצה על כפתור תפריט או פקודת "/" מבטלת זרימת קלט ממתינה.
    // בלי זה, אחרי שגיאה בזרימה (ה-pending נשמר בכוונה כדי לנסות שוב) לחיצת
    // כפתור פותחת אמנם את התצוגה — אך ה-pending נשאר, וההודעה הבאה עדיין נקלטת
    // כקלט הזרימה. כאן מנקים אותו כשברור שהמשתמש עבר לניווט אחר.
    bot.use(async (ctx, next) => {
      const t = ctx.message?.text?.trim();
      if (t && (NAV_LABELS.has(t) || t.startsWith('/'))) pending.delete(String(ctx.chat.id));
      return next();
    });

    bot.command('start', async (ctx) => {
      const owner1 = getSetting('telegram_chat_id', '');
      const owner2 = getSetting('telegram_chat_id_2', '');
      const from = String(ctx.from.id);
      if (!owner1) setSetting('telegram_chat_id', from);
      else if (!owner2 && from !== owner1) setSetting('telegram_chat_id_2', from);
      await ctx.reply(
        'שלום! אני MoneySaver 💰\n\n' +
        'התפריט למטה = כל העמודים ב-web. אפשר לצפות, להוסיף, לערוך ולמחוק — הכול מכאן.\n\n' +
        'קיצורים בהודעה:\n' +
        '• "קפה גרג 25" — הוצאה להיום\n' +
        '• "קפה גרג 25 03/07" — ליום אחר\n' +
        '• "הכנסה 500 בונוס" — הכנסה\n' +
        '• "חפש מפעילה" — חיפוש עסקאות בכל התאריכים\n' +
        '• 💬 שאלה חופשית (או /ask) — לשאול על הנתונים שלך בשפה חופשית\n' +
        '• העברת SMS / קובץ CSV/PDF\n\n' +
        'נרשמת להתראות תזרים 🎉',
        { reply_markup: MENU }
      );
    });

    // "תפריט" / פקודת /menu — החזרת המקלדת אם כווצה או נעלמה
    const showMenu = (ctx) => ctx.reply('התפריט זמין למטה 👇', { reply_markup: MENU });
    bot.hears(/^(תפריט|menu)$/i, showMenu);
    bot.command('menu', showMenu);

    // תפריט תחתון → תצוגות אינטראקטיביות. אותן תצוגות משרתות גם את הפקודות
    // הנייטיביות (כפתור ☰ ליד שורת הקלט — קבוע בעיצוב, לא מושפע מכפתור "חזרה").
    const openDash = async (ctx) => { const v = await dashView(); return ctx.reply(v.text, { parse_mode: 'Markdown', reply_markup: v.keyboard }); };
    const openTx = (ctx) => { const v = txListView(); return ctx.reply(v.text, { parse_mode: 'Markdown', reply_markup: v.keyboard }); };
    const openCats = (ctx) => { const v = categoriesView(); return ctx.reply(v.text, { parse_mode: 'Markdown', reply_markup: v.keyboard }); };
    const openMoney = (ctx) => { const v = incomeView(); return ctx.reply(v.text, { parse_mode: 'Markdown', reply_markup: v.keyboard }); };
    const openForecast = async (ctx) => ctx.reply(await forecastMessage(), { parse_mode: 'Markdown', reply_markup: MENU });
    const openImport = (ctx) => { const v = importIntro(); return ctx.reply(v.text, { parse_mode: 'Markdown', reply_markup: v.keyboard }); };
    const openSettings = (ctx) => { const v = settingsView(); return ctx.reply(v.text, { parse_mode: 'Markdown', reply_markup: v.keyboard }); };
    // צ'אט חופשי — מדליק זרימת קלט שנשארת פתוחה עד לחיצה על כפתור תפריט
    const openAsk = (ctx) => {
      const ready = llmReady();
      if (!ready.ok) return ctx.reply(`${ready.error}\nהגדרות ב-web: ${lanUrl()}/#settings`, { reply_markup: MENU });
      pending.set(String(ctx.chat.id), { action: 'chat_ask' });
      const n = chatHistory().length;
      return ctx.reply(
        '💬 *שאלה חופשית*\nשאל כל שאלה על הנתונים שלך — עסקאות, קטגוריות, הכנסות, תלוש או משכנתא.\n\n'
        + 'לדוגמה:\n• על מה הוצאתי הכי הרבה החודש?\n• כמה עולות לי ההוצאות הקבועות?\n'
        + '• האם הנטו בתלוש השתנה?\n\n'
        + (n ? `_בשיחה ${n} שאלות קודמות (משותפות עם ה-web)._\n` : '')
        + '_לחיצה על כפתור בתפריט מסיימת את השיחה._',
        { parse_mode: 'Markdown', reply_markup: MENU }
      );
    };

    bot.hears('🏠 דשבורד', openDash);       bot.command('dash', openDash);
    bot.hears('📋 עסקאות', openTx);          bot.command('tx', openTx);
    bot.hears('🏷️ קטגוריות', openCats);      bot.command('cat', openCats);
    bot.hears('💵 הכנסות והוצאות', openMoney); bot.command('money', openMoney);
    bot.hears('🔮 חיזוי', openForecast);      bot.command('forecast', openForecast);
    bot.hears('📥 ייבוא', openImport);        bot.command('import', openImport);
    bot.hears('⚙️ הגדרות', openSettings);     bot.command('settings', openSettings);
    bot.hears('💬 שאלה חופשית', openAsk);      bot.command('ask', openAsk);

    bot.on('callback_query:data', handleCallback);
    bot.on('message:document', handleDocument);
    bot.on('message:photo', handlePhoto);
    bot.on('message:text', handleText);

    await bot.init();

    // המקלדת נבנית מחדש לפי הדגל השמור (menu_persistent) — רלוונטי אחרי restart
    MENU = buildMenu();

    // המשתמש לא רוצה את הטקסט "תפריט" שמופיע ליד כפתור ה-☰ — זו מחרוזת קבועה
    // של טלגרם לכפתור מסוג commands (setMyCommands), לא ניתנת להחלפה ב-API.
    // לכן אין רישום פקודות. הפקודות עצמן (/dash, /settings וכו') ממשיכות לעבוד
    // בהקלדה ידנית — /settings הוא מנגנון החילוץ אם ה-back נתקע.
    try {
      await bot.api.deleteMyCommands();
    } catch (err) {
      console.log(`  בוט:      ניקוי פקודות נכשל — ${err.message}`);
    }

    bot.start({ drop_pending_updates: true });
    status = { active: true, error: null, username: bot.botInfo.username };
    console.log(`  בוט:      פעיל (@${bot.botInfo.username})`);
    startNotifier();
  } catch (err) {
    status = { active: false, error: err.message };
    console.log(`  בוט:      שגיאה — ${err.message}`);
  }
}

export async function restartBot() {
  try { await bot?.stop(); } catch { /* noop */ }
  bot = null;
  clearInterval(notifyTimer);
  await startBot();
}

export function botStatus() {
  return status;
}
