// הוצאות קבועות — CRUD + טריגר ידני. המנוע: server/lib/recurring.js.
import { Router } from 'express';
import { db } from '../db.js';
import { runRecurring } from '../lib/recurring.js';

const router = Router();

function validate(body, { partial = false } = {}) {
  const errors = [];
  const has = (k) => body[k] !== undefined;

  const merchant = has('merchant') ? String(body.merchant).trim() : undefined;
  if (!partial || has('merchant')) {
    if (!merchant) errors.push('merchant חובה');
    else if (merchant.length > 200) errors.push('merchant עד 200 תווים');
  }
  if (!partial || has('amount')) {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) errors.push('amount חייב להיות מספר חיובי');
  }
  const freq = has('freq') ? body.freq : undefined;
  if ((!partial || has('freq')) && !['weekly', 'monthly'].includes(freq)) {
    errors.push("freq חייב להיות 'weekly' או 'monthly'");
  }
  if (!partial || has('day') || has('freq')) {
    const day = Number(body.day);
    const f = freq ?? body._existingFreq; // בעדכון חלקי — נבדק מול ה-freq בפועל
    if (!Number.isInteger(day)) errors.push('day חייב להיות מספר שלם');
    else if (f === 'weekly' && (day < 0 || day > 6)) errors.push('day שבועי: 0 (ראשון) עד 6 (שבת)');
    // 29–31 מותרים: בחודש שאין בו את היום, המופע נדחק ליום האחרון בחודש
    // (ראו monthlyDayFor ב-server/lib/recurring.js)
    else if (f === 'monthly' && (day < 1 || day > 31)) errors.push('day חודשי: 1 עד 31');
  }
  if (has('category_id') && body.category_id !== null) {
    const cat = db.prepare('SELECT id FROM categories WHERE id = ?').get(body.category_id);
    if (!cat) errors.push('category_id לא קיים');
  }
  // hour — שעה ביום שממנה המופע של היום נוסף (0–23); null = הטיק הראשון של היום
  if (has('hour') && body.hour !== null) {
    const h = Number(body.hour);
    if (!Number.isInteger(h) || h < 0 || h > 23) errors.push('hour חייב להיות שעה (0–23) או null');
  }
  return errors;
}

const SELECT_ONE = `
  SELECT r.*, c.name AS category_name, c.icon AS category_icon
  FROM recurring_expenses r LEFT JOIN categories c ON c.id = r.category_id
  WHERE r.id = ?`;

// GET /api/recurring
router.get('/', (_req, res) => {
  res.json(db.prepare(`
    SELECT r.*, c.name AS category_name, c.icon AS category_icon
    FROM recurring_expenses r LEFT JOIN categories c ON c.id = r.category_id
    ORDER BY r.id
  `).all());
});

// POST /api/recurring — {merchant, amount, freq, day, category_id?}
router.post('/', (req, res) => {
  const errors = validate(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join(', ') });
  const result = db.prepare(`
    INSERT INTO recurring_expenses (merchant, amount, freq, day, category_id, hour)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(String(req.body.merchant).trim().slice(0, 200), Number(req.body.amount),
         req.body.freq, Number(req.body.day), req.body.category_id ?? null,
         req.body.hour ?? null);
  res.status(201).json(db.prepare(SELECT_ONE).get(result.lastInsertRowid));
});

// PUT /api/recurring/:id — עדכון חלקי (כולל active toggle)
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM recurring_expenses WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'הוצאה קבועה לא נמצאה' });
  // day נבדק מול ה-freq החדש אם נשלח, אחרת מול הקיים
  const errors = validate({ ...req.body, _existingFreq: existing.freq },
    { partial: true });
  if (errors.length) return res.status(400).json({ error: errors.join(', ') });

  const next = {
    merchant: req.body.merchant !== undefined ? String(req.body.merchant).trim().slice(0, 200) : existing.merchant,
    amount: req.body.amount !== undefined ? Number(req.body.amount) : existing.amount,
    freq: req.body.freq ?? existing.freq,
    day: req.body.day !== undefined ? Number(req.body.day) : existing.day,
    category_id: req.body.category_id !== undefined ? req.body.category_id : existing.category_id,
    active: req.body.active !== undefined ? (req.body.active ? 1 : 0) : existing.active,
    hour: req.body.hour !== undefined ? req.body.hour : existing.hour,
  };
  db.prepare(`
    UPDATE recurring_expenses SET merchant = ?, amount = ?, freq = ?, day = ?, category_id = ?, active = ?, hour = ?
    WHERE id = ?
  `).run(next.merchant, next.amount, next.freq, next.day, next.category_id, next.active, next.hour, existing.id);
  res.json(db.prepare(SELECT_ONE).get(existing.id));
});

// DELETE /api/recurring/:id — מוחק את ההגדרה; עסקאות שכבר נוספו נשארות
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM recurring_expenses WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'הוצאה קבועה לא נמצאה' });
  res.json({ deleted: true });
});

// POST /api/recurring/run — טריגר ידני (בדיקות / "הרץ עכשיו")
router.post('/run', async (_req, res) => {
  const added = await runRecurring();
  res.json({ added: added.length, transactions: added });
});

export default router;
