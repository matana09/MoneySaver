// מנויים והתחייבויות עם תאריך סיום — תזכורת חידוש דרך הבוט
import { Router } from 'express';
import { db } from '../db.js';
import { localDate, addMonthsClamped, monthsBetween } from '../lib/dates.js';

const router = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function daysLeft(endDate) {
  return Math.ceil((new Date(endDate + 'T12:00:00') - new Date(localDate() + 'T12:00:00')) / 86400000);
}

function withComputed(row) {
  return { ...row, days_left: daysLeft(row.end_date) };
}

/** מנויים פעילים שהתזכורת שלהם רלוונטית היום — משמש גם את הבוט */
export function dueSubscriptions(today = localDate()) {
  return db.prepare(`
    SELECT * FROM subscriptions
    WHERE active = 1
      AND (last_reminded IS NULL OR last_reminded != ?)
  `).all(today).filter((s) => daysLeft(s.end_date) <= s.remind_days);
}

export function markReminded(id, today = localDate()) {
  db.prepare('UPDATE subscriptions SET last_reminded = ? WHERE id = ?').run(today, id);
}

/** חידוש: מאריך את המנוי באותו אורך תקופה (שנה→שנה, חודש→חודש) */
export function renewSubscription(id) {
  const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
  if (!sub) return null;
  const months = monthsBetween(sub.start_date, sub.end_date);
  const newStart = sub.end_date;
  const newEnd = months >= 1
    ? addMonthsClamped(sub.end_date, months)
    : addMonthsClamped(sub.end_date, 12); // תקופה לא ברורה — ברירת מחדל שנה
  db.prepare(`
    UPDATE subscriptions SET start_date = ?, end_date = ?, last_reminded = NULL, active = 1
    WHERE id = ?
  `).run(newStart, newEnd, id);
  return withComputed(db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id));
}

// GET /api/subscriptions (?due=1 — רק אלה שדורשים תזכורת)
router.get('/', (req, res) => {
  if (req.query.due) return res.json(dueSubscriptions().map(withComputed));
  const rows = db.prepare('SELECT * FROM subscriptions ORDER BY end_date').all();
  res.json(rows.map(withComputed));
});

// POST /api/subscriptions
router.post('/', (req, res) => {
  const name = (req.body.name ?? '').trim();
  const { start_date, end_date } = req.body;
  if (!name) return res.status(400).json({ error: 'name חובה' });
  if (!ISO_DATE.test(start_date ?? '') || !ISO_DATE.test(end_date ?? '')) {
    return res.status(400).json({ error: 'start_date ו-end_date בפורמט YYYY-MM-DD' });
  }
  if (end_date <= start_date) return res.status(400).json({ error: 'end_date חייב להיות אחרי start_date' });
  const amount = req.body.amount != null && req.body.amount !== '' ? Number(req.body.amount) : null;
  if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
    return res.status(400).json({ error: 'amount לא תקין' });
  }
  const remind = Number(req.body.remind_days) || 14;

  const result = db.prepare(`
    INSERT INTO subscriptions (name, amount, start_date, end_date, remind_days)
    VALUES (?, ?, ?, ?, ?)
  `).run(name.slice(0, 200), amount, start_date, end_date, remind);
  res.status(201).json(withComputed(db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(result.lastInsertRowid)));
});

// POST /api/subscriptions/:id/renew — חידוש לתקופה נוספת באותו אורך
router.post('/:id/renew', (req, res) => {
  const renewed = renewSubscription(Number(req.params.id));
  if (!renewed) return res.status(404).json({ error: 'מנוי לא נמצא' });
  res.json(renewed);
});

// PUT /api/subscriptions/:id — עדכון/השבתה
router.put('/:id', (req, res) => {
  const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'מנוי לא נמצא' });
  const next = {
    name: (req.body.name ?? sub.name),
    amount: req.body.amount !== undefined ? (req.body.amount === null ? null : Number(req.body.amount)) : sub.amount,
    end_date: req.body.end_date ?? sub.end_date,
    remind_days: req.body.remind_days !== undefined ? Number(req.body.remind_days) : sub.remind_days,
    active: req.body.active !== undefined ? (req.body.active ? 1 : 0) : sub.active,
  };
  if (!ISO_DATE.test(next.end_date)) return res.status(400).json({ error: 'end_date בפורמט YYYY-MM-DD' });
  db.prepare(`
    UPDATE subscriptions SET name = ?, amount = ?, end_date = ?, remind_days = ?, active = ?
    WHERE id = ?
  `).run(String(next.name).trim().slice(0, 200), next.amount, next.end_date, next.remind_days, next.active, sub.id);
  res.json(withComputed(db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(sub.id)));
});

// DELETE /api/subscriptions/:id
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM subscriptions WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'מנוי לא נמצא' });
  res.json({ deleted: true });
});

export default router;
