// categorize.js — קטגוריזציה היברידית: חוקים → היסטוריה → ML
import { db } from '../db.js';
import { mlCategorize } from './ml.js';
import { safeTest } from './safeRegex.js';

/* שכבה 1: חוקים (regex על שם בית העסק) */
export function ruleMatch(merchant) {
  const rules = db.prepare(`
    SELECT r.pattern, r.category_id FROM rules r ORDER BY r.priority DESC, r.id
  `).all();
  for (const rule of rules) {
    if (safeTest(rule.pattern, merchant)) {
      return { category_id: rule.category_id, source: 'rule' };
    }
  }
  return null;
}

/* שכבה 2: התאמה מדויקת מההיסטוריה (הקטגוריה השכיחה לאותו בית עסק) */
export function historyMatch(merchant) {
  const row = db.prepare(`
    SELECT category_id, COUNT(*) AS n FROM transactions
    WHERE merchant = ? AND category_id IS NOT NULL AND type = 'expense'
    GROUP BY category_id ORDER BY n DESC LIMIT 1
  `).get(merchant.trim());
  return row ? { category_id: row.category_id, source: 'history' } : null;
}

/* קטגוריזציה סינכרונית (חוקים + היסטוריה) — לייבוא ולתצוגה מקדימה */
export function suggestCategory(merchant) {
  if (!merchant?.trim()) return null;
  return ruleMatch(merchant) ?? historyMatch(merchant);
}

/* קטגוריזציה מלאה כולל ML (אסינכרונית) — לעסקאות נכנסות */
export async function categorizeFull(merchant) {
  const quick = suggestCategory(merchant);
  if (quick) return quick;
  const ml = await mlCategorize(merchant);
  if (ml && ml.confidence >= 0.45) {
    return { category_id: ml.category_id, source: 'ml', confidence: ml.confidence };
  }
  return null;
}

/* נתוני אימון למודל: כל העסקאות המתויגות */
export function labeledData() {
  return db.prepare(`
    SELECT merchant, category_id FROM transactions
    WHERE category_id IS NOT NULL AND merchant != '' AND type = 'expense'
  `).all();
}
