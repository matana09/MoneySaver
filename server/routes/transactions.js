// CRUD עסקאות
import { Router } from 'express';
import { db } from '../db.js';
import { addTransaction } from '../lib/addTransaction.js';
import { addInstallments, deleteInstallmentGroup, tagInstallment, listInstallmentGroups, installmentChargeDetails, MAX_INSTALLMENTS } from '../lib/installments.js';
import { assignCategory, merchantPeers, getTransaction } from '../lib/categoryAssign.js';
import { scanDuplicates, ignoreDuplicateGroup, clearIgnoredDuplicates, ignoredCount } from '../lib/duplicates.js';
import { cycleDayFn } from './flow.js';
import { notifyTransactionAdded, notifyTransactionChanged, notifyAllUsers } from '../bot.js';

const router = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validate(body, { partial = false } = {}) {
  const errors = [];
  const has = (k) => body[k] !== undefined;

  if (!partial || has('date')) {
    if (!ISO_DATE.test(body.date ?? '')) errors.push('date חייב להיות בפורמט YYYY-MM-DD');
  }
  if (!partial || has('amount')) {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) errors.push('amount חייב להיות מספר חיובי');
  }
  if (has('type') && !['expense', 'income'].includes(body.type)) {
    errors.push("type חייב להיות 'expense' או 'income'");
  }
  if (has('category_id') && body.category_id !== null) {
    const cat = db.prepare('SELECT id FROM categories WHERE id = ?').get(body.category_id);
    if (!cat) errors.push('category_id לא קיים');
  }
  return errors;
}

// מיון מותר — allowlist קבוע (בלי הזרקת קלט ל-SQL). ברירת מחדל: תאריך אפקטיבי חדש→ישן.
const EFF_DATE = 'COALESCE(t.charge_date, t.date)';
const SORT_SQL = {
  date_desc: `${EFF_DATE} DESC, t.id DESC`,
  date_asc: `${EFF_DATE} ASC, t.id ASC`,
  amount_desc: 't.amount DESC, t.id DESC',
  amount_asc: 't.amount ASC, t.id DESC',
  category: `c.name IS NULL, c.name ASC, ${EFF_DATE} DESC`,
};

// GET /api/transactions?month=YYYY-MM&from=YYYY-MM-DD&to=YYYY-MM-DD&category_id=&type=&q=&sort=&limit=&offset=
router.get('/', (req, res) => {
  const { month, from, to, category_id, type, q } = req.query;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Number(req.query.offset) || 0;
  const orderBy = SORT_SQL[req.query.sort] || SORT_SQL.date_desc;

  const where = [];
  const params = [];
  // סינון תקופה לפי תאריך אפקטיבי (charge_date אם הוגדר, אחרת date)
  if (month) { where.push(`substr(${EFF_DATE}, 1, 7) = ?`); params.push(month); }
  // טווח תאריכים כולל (למשל חלון מחזור בדשבורד) — לצד/במקום month
  if (from && ISO_DATE.test(from)) { where.push(`${EFF_DATE} >= ?`); params.push(from); }
  if (to && ISO_DATE.test(to)) { where.push(`${EFF_DATE} <= ?`); params.push(to); }
  // 'none' → עסקאות ללא קטגוריה (category_id IS NULL); אחרת סינון לפי מזהה
  if (category_id === 'none') { where.push('category_id IS NULL'); }
  else if (category_id) { where.push('category_id = ?'); params.push(Number(category_id)); }
  if (type) { where.push('type = ?'); params.push(type); }
  if (q) { where.push('(merchant LIKE ? OR description LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT t.*, c.name AS category_name, c.color AS category_color, c.icon AS category_icon
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    ${whereSql}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM transactions t ${whereSql}`).get(...params);
  res.json({ transactions: rows, total });
});

// GET /api/transactions/installments — תוכניות התשלומים (כל קבוצת installment_group),
// בכל הקטגוריות. עם from/to (חלון מחזור) מוחזרות רק תוכניות שיש להן תשלום במחזור
// הזה, כל אחת עם מספר התשלום של אותו מחזור; בלי טווח — מצב כל-הזמנים.
router.get('/installments', (req, res) => {
  const { from, to } = req.query;
  const range = ISO_DATE.test(from ?? '') && ISO_DATE.test(to ?? '')
    ? { start: from, end: to } : {};
  res.json(listInstallmentGroups(range));
});

// GET /api/transactions/duplicates — סריקת כל ה-DB לקבוצות כפילות קיימות
// (אותו תאריך+סכום+סוג ושם בית עסק תואם, גם חלקית). קריאה בלבד — המחיקה
// נעשית דרך DELETE /:id הרגיל, אחרי שהמשתמש בחר איזו שורה להשאיר.
router.get('/duplicates', (req, res) => {
  const groups = scanDuplicates();
  res.json({
    groups,
    total_groups: groups.length,
    total_extra: groups.reduce((s, g) => s + g.rows.length - 1, 0),
    ignored_pairs: ignoredCount(),
  });
});

// POST /api/transactions/duplicates/ignore — "לא כפילות": כל הזוגות בקבוצה
// שאליה שייכת השורה נשמרים והקבוצה יורדת מהפאנל לצמיתות. הדפוס: שלוש
// כרטיסיות רכבת באותו יום ובאותו סכום, שלכל אחת מספר עסקה משלה בדוח.
// אינה נוגעת בנתוני העסקאות עצמן, ולכן בלחיצה אחת (הפיכה דרך DELETE למטה).
router.post('/duplicates/ignore', (req, res) => {
  const id = Number(req.body?.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id לא תקין' });
  const result = ignoreDuplicateGroup(id);
  if (!result.rows) return res.status(404).json({ error: 'הקבוצה כבר לא קיימת' });
  res.json(result);
});

// DELETE /api/transactions/duplicates/ignore — ביטול כל הסימונים
router.delete('/duplicates/ignore', (req, res) => {
  res.json({ cleared: clearIgnoredDuplicates() });
});

// POST /api/transactions — קטגוריזציה אוטומטית אם לא נבחרה קטגוריה.
// installments >= 2 → פיצול לקבוצת תשלומים חודשיים.
router.post('/', async (req, res) => {
  const errors = validate(req.body);
  if (errors.length) return res.status(400).json({ errors });

  const { date, amount, type = 'expense', merchant = '', description = '',
          category_id = null, source = 'manual', external_id = null } = req.body;

  if (req.body.installments !== undefined && req.body.installments !== null && req.body.installments !== '' && Number(req.body.installments) !== 1) {
    const count = Number(req.body.installments);
    if (!Number.isInteger(count) || count < 2 || count > MAX_INSTALLMENTS) {
      return res.status(400).json({ errors: [`installments חייב להיות 2–${MAX_INSTALLMENTS}`] });
    }
    if (type !== 'expense') return res.status(400).json({ errors: ['תשלומים זמינים להוצאות בלבד'] });
    const result = await addInstallments({ date, amount, count, merchant, category_id, source });
    // web — בלי זהות משתמש ידועה, מודיעים לשני הצדדים המחוברים (ראו notifyTransactionAdded)
    notifyTransactionAdded({
      type: 'expense', merchant, amount: result.total, date: result.first.date,
      category_name: result.first.category_name, category_icon: result.first.category_icon,
    }).catch(() => {});
    return res.status(201).json({ ...result.first, installments: result });
  }

  const row = await addTransaction({ date, amount, type, merchant, description, category_id, source, external_id });
  notifyTransactionAdded(row).catch(() => {});
  res.status(201).json(row);
});

// PUT /api/transactions/:id
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'עסקה לא נמצאה' });

  const errors = validate(req.body, { partial: true });
  if (errors.length) return res.status(400).json({ errors });

  const fields = ['date', 'amount', 'type', 'merchant', 'description', 'category_id'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      params.push(f === 'amount' ? Number(req.body[f]) : req.body[f]);
    }
  }

  // charge_date — שיוך תקופה שונה מתאריך הרכישה (עסקה שנרכשה סמוך לסוף מחזור אבל
  // מחויבת בפועל בדוח הבא). בתוכנית מיובאת 'next' מחושב ממועד התשלום המדווח;
  // מספרו נשמר בנפרד כדי שייבוא הדוח הבא לא יזיז את ההעברה לתשלום אחר.
  // null מנקה גם את המספר שנשמר; ISO מלא נשמר כמו שהוא.
  if (req.body.charge_date !== undefined) {
    const value = req.body.charge_date;
    if (value !== 'next' && value !== null && !ISO_DATE.test(value)) {
      return res.status(400).json({ error: 'charge_date חייב להיות "next", null, או תאריך בפורמט YYYY-MM-DD' });
    }
    const charge = installmentChargeDetails(existing, value, cycleDayFn);
    updates.push('charge_date = ?', 'installment_charge_index = ?');
    params.push(charge.charge_date, charge.installment_charge_index);
  }

  if (!updates.length) return res.status(400).json({ error: 'אין שדות לעדכון' });

  db.prepare(`UPDATE transactions SET ${updates.join(', ')} WHERE id = ?`).run(...params, existing.id);
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(existing.id);
  if (Object.keys(row).some((key) => row[key] !== existing[key])) {
    notifyTransactionChanged(row, { action: 'updated' }).catch(() => {});
  }
  res.json(row);
});

// GET /api/transactions/:id/merchant-peers?category_id= — כמה עסקאות אחרות יש
// לאותו בית עסק, וכמה מהן עדיין לא בקטגוריה המבוקשת. משמש את ה-UI כדי להציע
// "להחיל גם על שאר העסקאות של X?" רק כשבאמת יש מה לעדכן.
router.get('/:id/merchant-peers', (req, res) => {
  const tx = getTransaction(req.params.id);
  if (!tx) return res.status(404).json({ error: 'עסקה לא נמצאה' });
  res.json(merchantPeers(tx, req.query.category_id ?? null));
});

// PUT /api/transactions/:id/category — שיוך קטגוריה. apply_all=true משייך את כל
// העסקאות של אותו בית עסק (ואותו סוג), לא רק את הנבחרת. category_id null/0 = ללא.
router.put('/:id/category', (req, res) => {
  try {
    const result = assignCategory(req.params.id, req.body.category_id ?? null, {
      applyAll: req.body.apply_all === true || req.body.apply_all === '1',
    });
    notifyTransactionChanged({ ...result.transaction, category_name: result.category?.name },
      { action: 'updated', count: result.updated }).catch(() => {});
    res.json({
      ...result.transaction,
      updated: result.updated,
      merchant: result.merchant,
      category_name: result.category ? result.category.name : null,
    });
  } catch (err) {
    res.status(err.message === 'עסקה לא נמצאה' ? 404 : 400).json({ error: err.message });
  }
});

// PUT /api/transactions/:id/installment — תיוג עסקה קיימת (למשל שיובאה מ-PDF
// כשורה בודדת) כ"תשלום index/count", בלי ליצור שורות עתידיות.
router.put('/:id/installment', (req, res) => {
  const { index, count } = req.body;
  try {
    const row = tagInstallment(Number(req.params.id), index, count);
    notifyTransactionChanged(row, { action: 'updated' }).catch(() => {});
    res.json(row);
  } catch (err) {
    res.status(400).json({ errors: [err.message] });
  }
});

// DELETE /api/transactions/:id (?group=1 — מחיקת כל קבוצת התשלומים של העסקה)
router.delete('/:id', (req, res) => {
  if (req.query.group) {
    const row = db.prepare('SELECT installment_group FROM transactions WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'עסקה לא נמצאה' });
    if (row.installment_group) {
      const deleted = deleteInstallmentGroup(row.installment_group);
      if (deleted) notifyAllUsers(`🗑 בוטלו ${deleted} תשלומים.`).catch(() => {});
      return res.json({ deleted: true, count: deleted });
    }
    // עסקה רגילה — נופל למחיקה בודדת
  }
  const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  const result = db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'עסקה לא נמצאה' });
  notifyTransactionChanged(existing, { action: 'deleted' }).catch(() => {});
  res.json({ deleted: true, count: 1 });
});

export default router;
