// הכנסות (משכורת, קצבאות, מתנות וכו') — כל הכנסה עם תאריך מלא; ללא תאריך
// נחשבת "תמיד רלוונטית" ונספרת בכל תקופה (ראו server/routes/flow.js)
import { Router } from 'express';
import { db } from '../db.js';
import { cycleWindow } from '../lib/dates.js';
import { cycleDayFn } from './flow.js';
import { notifyIncomeChanged } from '../bot.js';

const router = Router();
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

// יום־בחודש לתבנית הכנסה קבועה. מחזיר null (ריק/לא נשלח → נגזר מ-date אח"כ),
// מספר 1–31, או false אם לא תקין.
function parseDayOfMonth(v) {
  if (v === undefined || v === null || v === '') return null;
  const d = Number(v);
  return Number.isInteger(d) && d >= 1 && d <= 31 ? d : false;
}

// GET /api/income            — כל ההכנסות (תאימות לאחור)
// GET /api/income?month=YYYY-MM — רק ההכנסות של מחזור התזרים (10→10) של אותו
// חודש־עוגן, בדיוק כמו ההוצאות בדשבורד. שורה בלי תאריך (legacy) נספרת בכל מחזור.
router.get('/', (req, res) => {
  const { month } = req.query;
  if (!month) return res.json(db.prepare('SELECT * FROM income ORDER BY id').all());
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month חייב להיות בפורמט YYYY-MM' });

  const cycle = cycleWindow(month, cycleDayFn);
  const rows = db.prepare(`
    SELECT * FROM income
    WHERE date IS NULL OR (date >= ? AND date <= ?)
    ORDER BY date IS NULL DESC, date, id
  `).all(cycle.start, cycle.end);
  const total = rows.reduce((s, i) => s + (i.active ? i.amount : 0), 0);
  res.json({ cycle, total, incomes: rows });
});

// POST /api/income
router.post('/', (req, res) => {
  const name = (req.body.name ?? '').trim();
  const amount = Number(req.body.amount);
  if (!name) return res.status(400).json({ error: 'name חובה' });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount חייב להיות מספר חיובי' });
  if (req.body.date && !ISO_DATE.test(req.body.date)) return res.status(400).json({ error: 'date חייב להיות בפורמט YYYY-MM-DD' });

  const date = req.body.date || null;
  // recurring=1 — הכנסה קבועה (קצבה וכו'): נוצר מופע חדש אוטומטית ביום day_of_month
  // בכל חודש (server/lib/recurringIncome.js). day_of_month ריק → נגזר מהיום ב-date.
  const recurring = req.body.recurring ? 1 : 0;
  const day = parseDayOfMonth(req.body.day_of_month);
  if (day === false) return res.status(400).json({ error: 'day_of_month חייב להיות יום בחודש (1–31)' });
  const result = db.prepare('INSERT INTO income (name, amount, date, recurring, day_of_month) VALUES (?, ?, ?, ?, ?)')
    .run(name, amount, date, recurring, recurring ? day : null);
  const row = db.prepare('SELECT * FROM income WHERE id = ?').get(result.lastInsertRowid);
  notifyIncomeChanged(row).catch(() => {});
  res.status(201).json(row);
});

// PUT /api/income/:id
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM income WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'הכנסה לא נמצאה' });

  const amount = req.body.amount !== undefined ? Number(req.body.amount) : existing.amount;
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount חייב להיות מספר חיובי' });
  if (req.body.date && !ISO_DATE.test(req.body.date)) return res.status(400).json({ error: 'date חייב להיות בפורמט YYYY-MM-DD' });

  const recurring = req.body.recurring !== undefined ? (req.body.recurring ? 1 : 0) : existing.recurring;
  const date = req.body.date !== undefined ? (req.body.date || null) : existing.date;
  // day_of_month: אם נשלח — ולידציה; אם לא — נשמר הקיים. הכנסה שאינה קבועה
  // מאבדת את היום (null) כדי שלא תיווצר תבנית מיותמת.
  let day = existing.day_of_month;
  if (req.body.day_of_month !== undefined) {
    day = parseDayOfMonth(req.body.day_of_month);
    if (day === false) return res.status(400).json({ error: 'day_of_month חייב להיות יום בחודש (1–31)' });
  }
  // הכנסה שהופכת לקבועה בלי day_of_month מפורש — נגזר מהיום שבתאריך, כדי שהתג
  // "· N בחודש" יופיע והמנוע יֵדע מתי ליצור מופעים. ביטול קביעות מנקה ל-null.
  const finalDay = recurring ? (day || (date ? Number(date.slice(8, 10)) : null)) : null;
  db.prepare('UPDATE income SET name = ?, amount = ?, date = ?, active = ?, recurring = ?, day_of_month = ? WHERE id = ?')
    .run((req.body.name ?? existing.name).trim(), amount, date,
         req.body.active !== undefined ? (req.body.active ? 1 : 0) : existing.active,
         recurring, finalDay, existing.id);
  const row = db.prepare('SELECT * FROM income WHERE id = ?').get(existing.id);
  if (['name', 'amount', 'date', 'active', 'recurring', 'day_of_month'].some((key) => row[key] !== existing[key])) {
    notifyIncomeChanged(row, { action: 'updated' }).catch(() => {});
  }
  res.json(row);
});

// DELETE /api/income/:id
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM income WHERE id = ?').get(req.params.id);
  const result = db.prepare('DELETE FROM income WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'הכנסה לא נמצאה' });
  notifyIncomeChanged(existing, { action: 'deleted' }).catch(() => {});
  res.json({ deleted: true });
});

export default router;
