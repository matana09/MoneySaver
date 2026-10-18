// חוקי קטגוריזציה (regex → קטגוריה)
import { Router } from 'express';
import { db } from '../db.js';
import { validateUserRegex } from '../lib/safeRegex.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json(db.prepare(`
    SELECT r.*, c.name AS category_name, c.icon AS category_icon
    FROM rules r JOIN categories c ON c.id = r.category_id
    ORDER BY r.priority DESC, r.id
  `).all());
});

router.post('/', (req, res) => {
  const { pattern, category_id, priority = 0 } = req.body;
  if (!pattern?.trim()) return res.status(400).json({ error: 'pattern חובה' });
  const check = validateUserRegex(pattern);
  if (!check.ok) return res.status(400).json({ error: check.error });
  const cat = db.prepare('SELECT id FROM categories WHERE id = ?').get(category_id);
  if (!cat) return res.status(400).json({ error: 'category_id לא קיים' });

  const result = db.prepare('INSERT INTO rules (pattern, category_id, priority) VALUES (?, ?, ?)')
    .run(pattern.trim(), category_id, Number(priority) || 0);
  res.status(201).json(db.prepare('SELECT * FROM rules WHERE id = ?').get(result.lastInsertRowid));
});

router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM rules WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'חוק לא נמצא' });
  res.json({ deleted: true });
});

export default router;
