// תזרים — הכנסות פחות הוצאות + "כמה נשאר להוציא". שני מצבים:
//  • חודש קלנדרי (computeFlow) — משמש בוט/קטגוריות/חיזוי.
//  • מחזור תזרים 10→10 (computeCycleFlow) — משמש הדשבורד.
import { Router } from 'express';
import { db, getSetting } from '../db.js';
import { cycleWindow, nextMonthStr, cycleAnchorForToday } from '../lib/dates.js';
import { expenseEntriesInRange } from '../lib/installments.js';

const router = Router();

const MONTH_RE = /^\d{4}-\d{2}$/;

// ליבה משותפת: תזרים על טווח תאריכים כולל [start, end] (ISO).
function computeFlowRange(start, end) {
  // הכנסות פעילות בטווח: שורה עם תאריך נספרת רק אם התאריך בתוך [start,end]
  // (משכורת/מתנה של תקופה ספציפית); שורה בלי תאריך (legacy) נספרת תמיד.
  const { expected_income } = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS expected_income FROM income WHERE active = 1 AND (date IS NULL OR (date >= ? AND date <= ?))"
  ).get(start, end);

  const { actual_income } = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS actual_income FROM transactions
    WHERE type = 'income' AND COALESCE(charge_date, date) >= ? AND COALESCE(charge_date, date) <= ?
  `).get(start, end);

  // מקור משותף לסכום, לפילוח ולגרף: תשלום מיובא נספר במועדו החודשי,
  // ולא בתאריך הרכישה המקורי. אגורות שלמות מונעות פערים בין המצטברים.
  const expenses = expenseEntriesInRange(start, end);
  let expenseCents = 0;
  const categories = new Map();
  const days = new Map();
  for (const tx of expenses) {
    const cents = Math.round(tx.amount * 100);
    expenseCents += cents;
    days.set(tx.date, (days.get(tx.date) || 0) + cents);
    if (!categories.has(tx.category_id)) {
      categories.set(tx.category_id, {
        name: tx.category_name ?? 'ללא קטגוריה',
        color: tx.category_color ?? '#8896a6',
        icon: tx.category_icon ?? '❔',
        cents: 0,
      });
    }
    categories.get(tx.category_id).cents += cents;
  }
  const actual_expenses = expenseCents / 100;
  const by_category = [...categories.values()]
    .map(({ cents, ...category }) => ({ ...category, total: cents / 100 }))
    .sort((a, b) => b.total - a.total);
  const daily = [...days.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([d, cents]) => ({ d, total: cents / 100 }));

  const total_income = expected_income + actual_income;
  const remaining = total_income - actual_expenses;

  return { expected_income, actual_income, total_income, actual_expenses, remaining, by_category, daily };
}

export function computeFlow(month) {
  const base = computeFlowRange(`${month}-01`, `${month}-31`);

  // כמה ימים נשארו בחודש (כולל היום, אם זה החודש הנוכחי)
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const now = new Date();
  const isCurrentMonth = month === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const daysLeft = isCurrentMonth ? daysInMonth - now.getDate() + 1 : 0;

  // עדכון snapshot בטבלת monthly_flow (רק לחודשים קלנדריים)
  db.prepare(`
    INSERT INTO monthly_flow (month, expected_income, actual_income, actual_expenses, updated_at)
    VALUES (?, ?, ?, ?, datetime('now', 'localtime'))
    ON CONFLICT(month) DO UPDATE SET
      expected_income = excluded.expected_income,
      actual_income   = excluded.actual_income,
      actual_expenses = excluded.actual_expenses,
      updated_at      = excluded.updated_at
  `).run(month, base.expected_income, base.actual_income, base.actual_expenses);

  return {
    month,
    ...base,
    days_left: daysLeft,
    daily_budget: daysLeft > 0 && base.remaining > 0 ? base.remaining / daysLeft : 0,
  };
}

export function cycleDaySetting() {
  const d = Number(getSetting('cycle_day', '10'));
  return Number.isInteger(d) && d >= 1 && d <= 28 ? d : 10;
}

// יום העוגן שחל על חודש נתון: השורה האחרונה ב-cycle_days שתחילתה <= החודש,
// ואם אין כזו — ערך הבסיס מ-settings. כך שינוי היום "מכאן והלאה" לא נוגע
// בחודשים שכבר נסגרו. **תמיד להעביר את `cycleDayFn` (ולא מספר) לכל חישוב
// חלון** — מספר קבוע מתעלם מההיסטוריה ומחזיר את המחזורים הישנים לחיתוך שגוי.
const cycleDayRow = db.prepare(
  'SELECT day FROM cycle_days WHERE effective_month <= ? ORDER BY effective_month DESC LIMIT 1'
);
export function cycleDayForMonth(month) {
  return cycleDayRow.get(month)?.day ?? cycleDaySetting();
}
export const cycleDayFn = (month) => cycleDayForMonth(month);

/** חלון המחזור לחודש־התחלה, לפי היום שחל בכל קצה. */
export const cycleWindowFor = (anchorMonth) => cycleWindow(anchorMonth, cycleDayFn);

/** רשימת השינויים ביום העוגן (לתצוגה בהגדרות). */
export const cycleDayHistory = () =>
  db.prepare('SELECT effective_month, day FROM cycle_days ORDER BY effective_month').all();

/** "מהחודש הזה ואילך היום הוא X". שמירה חוזרת לאותו חודש דורסת. */
export function setCycleDayFrom(month, day) {
  db.prepare(`
    INSERT INTO cycle_days (effective_month, day) VALUES (?, ?)
    ON CONFLICT(effective_month) DO UPDATE SET day = excluded.day
  `).run(month, day);
}

/** חזרה ליום עוגן גלובלי אחד (מוחק את כל השינויים תלויי-התאריך). */
export const clearCycleDayHistory = () => db.prepare('DELETE FROM cycle_days').run();

// תזרים מחזור 10→10 לפי חודש־התחלה. מוסיף מטא־מחזור, מצטבר יומי, וחיזוי פרופורציונלי.
// לא כותב ל-monthly_flow (הטבלה קלנדרית; snapshot היסטוריה לא־קריטי).
export function computeCycleFlow(anchorMonth, cycleDay = cycleDayFn) {
  const { start, end, label } = cycleWindow(anchorMonth, cycleDay);
  const base = computeFlowRange(start, end);

  // ימי המחזור וכמה נשארו עד סוף המחזור (ה-D), אם היום בתוך החלון
  const MS_DAY = 86400000;
  const startD = new Date(`${start}T12:00:00`);
  const endD = new Date(`${end}T12:00:00`);
  const cycleLength = Math.round((endD - startD) / MS_DAY) + 1;
  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const inCycle = todayIso >= start && todayIso <= end;
  const todayD = new Date(`${todayIso}T12:00:00`);
  const daysElapsed = inCycle ? Math.round((todayD - startD) / MS_DAY) + 1 : cycleLength;
  const daysLeft = inCycle ? Math.round((endD - todayD) / MS_DAY) : 0;

  // "הוצא בפועל עד כה" — רק שורות שתאריכן האפקטיבי הגיע. שורות תשלום עתידיות
  // בחלון לא מנפחות את הקצב. חיזוי = פרופורציה מהקצב, אבל לא פחות מהחיובים הידועים
  // בחלון (base.actual_expenses כולל תשלומים עתידיים מחויבים).
  const cutoff = inCycle ? todayIso : end;
  const spentSoFar = base.daily.filter(({ d }) => d <= cutoff)
    .reduce((sum, { total }) => sum + Math.round(total * 100), 0) / 100;
  const proportional = daysElapsed > 0 ? (spentSoFar / daysElapsed) * cycleLength : 0;
  const predicted_expenses = Math.round(Math.max(proportional, base.actual_expenses));

  return {
    anchor_month: anchorMonth,
    start, end, label,
    // היום שבו המחזור **נסגר** — זה מה שהמשתמש מכיר כ"יום החיוב". נלקח מהחודש
    // שבו הקצה נופל, כי היום עשוי להשתנות באמצע (ראו `cycleDayForMonth`).
    cycle_day: cycleDayForMonth(nextMonthStr(anchorMonth)),
    cycle_length: cycleLength,
    days_elapsed: daysElapsed,
    ...base,
    days_left: daysLeft,
    daily_budget: daysLeft > 0 && base.remaining > 0 ? base.remaining / daysLeft : 0,
    predicted_expenses,
    predicted_remaining: base.total_income - predicted_expenses,
  };
}

// GET /api/flow/cycle/:month  (חודש־התחלה של המחזור, YYYY-MM)
router.get('/cycle/:month', (req, res) => {
  const { month } = req.params;
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month חייב להיות בפורמט YYYY-MM' });
  res.json(computeCycleFlow(month));
});

// GET /api/flow/current — המחזור שמכיל את היום. חייב להירשם **לפני** '/:month',
// אחרת 'current' נתפס כפרמטר חודש ונדחה. ה-web קורא לזה בעלייה כדי לדעת על
// איזה מחזור לפתוח, במקום לחשב לבד (הלקוח לא מכיר את `cycle_days`).
router.get('/current', (_req, res) => {
  const anchor = cycleAnchorForToday(cycleDayFn);
  res.json({ anchor_month: anchor, ...cycleWindow(anchor, cycleDayFn) });
});

// GET /api/flow/:month  (למשל /api/flow/2026-07)
router.get('/:month', (req, res) => {
  const { month } = req.params;
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month חייב להיות בפורמט YYYY-MM' });
  res.json(computeFlow(month));
});

// GET /api/flow/history/list — סיכומי חודשים קודמים (להשוואות בשלב 5)
router.get('/history/list', (_req, res) => {
  res.json(db.prepare('SELECT * FROM monthly_flow ORDER BY month DESC LIMIT 24').all());
});

export default router;
