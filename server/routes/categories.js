// קטגוריות — קריאה + ניהול בסיסי
import { Router } from 'express';
import { db } from '../db.js';
import { installmentsCategoryTotal } from '../lib/installments.js';

const router = Router();

// GET /api/categories — כולל סכום הוצאות לכל קטגוריה בתקופה הנבחרת.
// תקופה: חלון מחזור (from/to ISO, כולל שני הקצוות — משמש טאב הקטגוריות) או, אם אין,
// חודש קלנדרי (month=YYYY-MM, ברירת מחדל / תאימות לאחור).
// יוצא מן הכלל "תשלומים": שורה של תוכנית שיובאה מ-PDF נושאת את תאריך העסקה
// המקורית ולא את מועד החיוב, ולכן סכום לפי שורות היה נתקע על אותו ערך בכל
// מחזור. במקומו — סה"כ התשלומים שמועדם בחלון (installmentsCategoryTotal),
// אותו מספר שמוצג ברשימת התוכניות שמתחת לקטגוריה.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
router.get('/', (req, res) => {
  const { from, to } = req.query;
  const useRange = ISO_DATE.test(from ?? '') && ISO_DATE.test(to ?? '');
  // תנאי הכללת עסקה בסכום התקופה — לפי תאריך אפקטיבי (charge_date אם הוגדר,
  // אחרת date)
  const periodCond = useRange
    ? '(COALESCE(t.charge_date, t.date) >= ? AND COALESCE(t.charge_date, t.date) <= ?)'
    : 'substr(COALESCE(t.charge_date, t.date), 1, 7) = ?';
  const periodParams = useRange ? [from, to] : [req.query.month || new Date().toISOString().slice(0, 7)];
  const rows = db.prepare(`
    SELECT c.*,
           COALESCE(SUM(CASE
             WHEN t.type = 'expense' AND ${periodCond}
             THEN t.amount
           END), 0) AS month_total
    FROM categories c
    LEFT JOIN transactions t ON t.category_id = c.id
    GROUP BY c.id
    ORDER BY c.id
  `).all(...periodParams);

  // "תשלומים" — לפי מועדי התשלום בחלון. במצב חודש קלנדרי (תאימות לאחור) גוזרים
  // חלון מהחודש עצמו: היום הראשון עד האחרון בו.
  const payments = rows.find((r) => r.name === 'תשלומים');
  if (payments) {
    const month = MONTH.test(req.query.month ?? '') ? req.query.month : null;
    let win = null;
    if (useRange) win = { start: from, end: to };
    else if (month) {
      const [y, m] = month.split('-').map(Number);
      const lastDay = new Date(y, m, 0).getDate();
      win = { start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, '0')}` };
    }
    if (win) payments.month_total = installmentsCategoryTotal('תשלומים', win);
  }
  res.json(rows);
});

// ולידציית שדות הצגה — מונעת stored XSS/CSS-injection (icon/color מוזרקים ל-DOM).
// color: hex בלבד. icon: קצר ובלי תווי HTML (אימוג'י תקין עובר). name: בלי < > (הגנת עומק).
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;
const HTML_CHARS = /[<>]/;

function cleanDisplayFields(body, fallback = {}) {
  const errors = [];
  let name = body.name !== undefined ? String(body.name).trim() : fallback.name;
  let color = body.color !== undefined ? String(body.color).trim() : fallback.color;
  let icon = body.icon !== undefined ? String(body.icon).trim() : fallback.icon;

  if (name !== undefined) {
    if (!name) errors.push('name חובה');
    else if (name.length > 40 || HTML_CHARS.test(name)) errors.push('name לא תקין (עד 40 תווים, בלי < >)');
  }
  if (color && !HEX_COLOR.test(color)) errors.push('color חייב להיות קוד hex (למשל #4caf7d)');
  if (icon && (icon.length > 16 || HTML_CHARS.test(icon))) errors.push('icon לא תקין (אימוג\'י קצר בלבד)');

  return { errors, name, color: color || '#8896a6', icon: icon || '💳' };
}

// POST /api/categories
router.post('/', (req, res) => {
  const { errors, name, color, icon } = cleanDisplayFields(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join(', ') });
  try {
    const result = db.prepare('INSERT INTO categories (name, color, icon) VALUES (?, ?, ?)')
      .run(name, color, icon);
    res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid));
  } catch {
    res.status(409).json({ error: 'קטגוריה בשם זה כבר קיימת' });
  }
});

// PUT /api/categories/:id
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'קטגוריה לא נמצאה' });
  const { errors, name, color, icon } = cleanDisplayFields(req.body, existing);
  if (errors.length) return res.status(400).json({ error: errors.join(', ') });
  db.prepare('UPDATE categories SET name = ?, color = ?, icon = ? WHERE id = ?')
    .run(name, color, icon, existing.id);
  res.json(db.prepare('SELECT * FROM categories WHERE id = ?').get(existing.id));
});

// DELETE /api/categories/:id — העסקאות נשארות עם category_id = NULL
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'קטגוריה לא נמצאה' });
  res.json({ deleted: true });
});

export default router;
