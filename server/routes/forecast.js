// חיזוי תזרים סוף חודש
import { Router } from 'express';
import { db } from '../db.js';
import { forecastMonth } from '../lib/ml.js';
import { computeFlow } from './flow.js';

const router = Router();

// GET /api/forecast/:month — חיזוי + פירוק לפי קטגוריה + מצטבר יומי לגרף
router.get('/:month', async (req, res) => {
  const { month } = req.params;
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month בפורמט YYYY-MM' });

  const flow = computeFlow(month);
  const forecast = await forecastMonth(month);
  const predicted = forecast.predicted_expenses ?? flow.actual_expenses;

  // עדכון ה-snapshot עם החיזוי
  db.prepare('UPDATE monthly_flow SET expected_expenses = ? WHERE month = ?').run(predicted, month);

  // מצטבר יומי בפועל (לקו הגרף)
  const daily = db.prepare(`
    SELECT CAST(substr(COALESCE(charge_date, date), 9, 2) AS INTEGER) AS day, SUM(amount) AS total
    FROM transactions WHERE type = 'expense' AND substr(COALESCE(charge_date, date), 1, 7) = ?
    GROUP BY day ORDER BY day
  `).all(month);

  // חיזוי ממוצע לקטגוריה לפי התפלגות 3 חודשים אחרונים
  const catShare = db.prepare(`
    SELECT COALESCE(c.name, 'ללא קטגוריה') AS name, COALESCE(c.color, '#8896a6') AS color,
           SUM(t.amount) AS total
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.type = 'expense' AND substr(COALESCE(t.charge_date, t.date), 1, 7) < ?
    GROUP BY c.id ORDER BY total DESC LIMIT 8
  `).all(month);
  const shareSum = catShare.reduce((s, c) => s + c.total, 0);

  res.json({
    month,
    ...forecast,
    predicted_expenses: predicted,
    predicted_remaining: flow.total_income - predicted,
    total_income: flow.total_income,
    actual_expenses: flow.actual_expenses,
    daily_actual: daily,
    days_in_month: new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate(),
    by_category_predicted: shareSum > 0
      ? catShare.map((c) => ({ ...c, predicted: Math.round((c.total / shareSum) * predicted) }))
      : [],
  });
});

export default router;
