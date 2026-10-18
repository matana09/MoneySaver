// duplicates.js — זיהוי עסקאות כפולות. מקור אמת יחיד לייבוא, ל-SMS, ל-web ולבוט.
//
// למה זה קיים: אותה עסקה נכנסת פעמיים משני מקורות עם שם שונה — ה-SMS מהבנק
// שולח שם קצר ("MOJO") והדוח מחברת האשראי שולח את השם המלא ("MOJO ASIAN
// FOODBAR"). ההשוואה המדויקת שהייתה כאן קודם פספסה בדיוק את זה (15.08:
// שתי עסקאות MOJO ב-10.07, אותו סכום, אחת מ-SMS ואחת מ-PDF).
//
// הכלל: **אותו תאריך + אותו סכום + אותו סוג** הם תנאי סף קשיח, ורק אז
// משווים שמות. זה מה שמאפשר להשוות שמות ברפיון בלי להציף בהתראות שווא.
import { db } from '../db.js';

/** תאריך החיוב האפקטיבי — לפיו העסקה משויכת למחזור (כמו COALESCE ב-SQL). */
export const effectiveDate = (row) => row.charge_date || row.date;

// סימני פיסוק שמופיעים בשמות בתי עסק בצורה לא עקבית בין מקורות
const PUNCT = /["'`׳״.\-–—_,()[\]{}\/\\|*+:;]/g;

/** נרמול שם בית עסק להשוואה: בלי פיסוק, רווח יחיד, אותיות גדולות. */
export function normalizeMerchant(name) {
  return String(name ?? '')
    .replace(PUNCT, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

// אורך מינימלי לשם הקצר כדי שקידומת תיחשב התאמה — בלי זה "א" היה תופס הכול
const MIN_PREFIX = 4;

/**
 * השוואת שני שמות בית עסק: 'exact' | 'similar' | null.
 *
 * 'similar' = השם הקצר הוא **קידומת** של הארוך. זה הדפוס האמיתי בנתונים:
 * דוחות אשראי מוסיפים סניף/עיר ("ארומה" → "ארומה עיר ימים נתניה"), וגם
 * חותכים שמות באורך קבוע ("מאפה נאמן - קניון עי"). בכוונה **לא** "מכיל"
 * כללי ולא חפיפת מילים: "DANN הקסום" מול "האגם הקסום" (שגיאת OCR) חולקים
 * מילה אבל אינם אותה עסקה, ואסור לסמן אותם.
 */
export function merchantMatch(a, b) {
  const x = normalizeMerchant(a);
  const y = normalizeMerchant(b);
  if (!x || !y) return null;
  if (x === y) return 'exact';
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= MIN_PREFIX && long.startsWith(short)) return 'similar';
  return null;
}

/**
 * האם העסקה כבר קיימת. מחזיר את השורה הקיימת עם `level` ('exact'/'similar'),
 * או null. `excludeId` — כדי לא להשוות שורה לעצמה.
 */
export function findDuplicate({ date, amount, merchant, type = 'expense' }, { excludeId = null } = {}) {
  const params = [date, Number(amount), type];
  let sql = `SELECT id, date, amount, type, merchant, source, installment_group
             FROM transactions WHERE date = ? AND amount = ? AND type = ?`;
  if (excludeId) { sql += ' AND id != ?'; params.push(Number(excludeId)); }
  for (const row of db.prepare(sql).all(...params)) {
    const level = merchantMatch(row.merchant, merchant);
    if (level) return { ...row, level };
  }
  return null;
}

/**
 * סריקת כל ה-DB לקבוצות כפילות קיימות. מקבץ לפי תאריך+סכום+סוג, ובתוך כל
 * דלי מקבץ שורות ששמות בתי העסק שלהן תואמים (`merchantMatch`).
 * שתי שורות של אותה תוכנית תשלומים אינן כפילות — הן אותה תוכנית.
 * שתי שורות ששויכו למחזורי חיוב שונים אינן כפילות — ראו בגוף הלולאה.
 */
export function scanDuplicates({ applyIgnores = true } = {}) {
  const ignored = applyIgnores ? ignoredPairs() : new Set();
  const all = db.prepare(`
    SELECT t.id, t.date, t.amount, t.type, t.merchant, t.source, t.description,
           t.installment_group, t.category_id, t.charge_date,
           c.name AS category_name, c.icon AS category_icon, c.color AS category_color
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    ORDER BY t.date DESC, t.id
  `).all();

  const buckets = new Map();
  for (const row of all) {
    const key = `${row.date}|${row.amount}|${row.type}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }

  const groups = [];
  for (const rows of buckets.values()) {
    if (rows.length < 2) continue;
    const used = new Set();
    for (let i = 0; i < rows.length; i++) {
      if (used.has(rows[i].id)) continue;
      const cluster = [rows[i]];
      for (let j = i + 1; j < rows.length; j++) {
        if (used.has(rows[j].id)) continue;
        if (!merchantMatch(rows[i].merchant, rows[j].merchant)) continue;
        // אותה תוכנית תשלומים = אותה עסקה מפוצלת, לא כפילות
        if (rows[i].installment_group && rows[i].installment_group === rows[j].installment_group) continue;
        // המשתמש הכריע במפורש "לא כפילות" (שלוש כרטיסיות רכבת באותו יום —
        // שלושה חיובים אמיתיים עם מספר עסקה שונה בדוח). ראו למטה.
        if (ignored.has(pairKey(rows[i].id, rows[j].id))) continue;
        // מחזורי חיוב שונים = המשתמש כבר הכריע. דוח "פירוט חיובים קרובים"
        // מציג עסקה שנרכשה לפני סגירת המחזור אבל תחויב בדוח הבא, ולכן היא
        // נראית ככפילות של השורה שכבר נקלטה במחזור הקודם. אחרי "📅 העבר
        // למחזור הבא" (charge_date) שתי השורות יושבות במחזורים שונים, וסימון
        // חוזר שלהן ככפילות היה מחזיר את הקבוצה בכל טעינה של הפאנל למרות
        // שטופלה. ניקוי charge_date מחזיר אותן לרשימה.
        if (effectiveDate(rows[i]) !== effectiveDate(rows[j])) continue;
        cluster.push(rows[j]);
        used.add(rows[j].id);
      }
      if (cluster.length < 2) continue;
      used.add(rows[i].id);
      const names = new Set(cluster.map((r) => normalizeMerchant(r.merchant)));
      groups.push({
        date: rows[i].date,
        amount: rows[i].amount,
        type: rows[i].type,
        level: names.size === 1 ? 'exact' : 'similar',
        // מקורות שונים (sms מול pdf) = הסימן המובהק לכפילות מכונה
        sources: [...new Set(cluster.map((r) => r.source))],
        rows: cluster,
      });
    }
  }
  groups.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return groups;
}

/* ---------- "לא כפילות" — הכרעה מפורשת של המשתמש ---------- */
// שלוש כרטיסיות רכבת באותו יום ובאותו סכום הן שלושה חיובים אמיתיים (לדוח
// האשראי מספר עסקה שונה לכל אחת), אבל מבחינת הסורק הן קבוצה מושלמת. בלי
// דרך לומר "אלו לא כפילויות" המשתמש נאלץ למחוק שורה אמיתית או להעביר אותה
// למחזור הבא — שתיהן משבשות את הנתונים. הזוגות שנשמרו כאן מדולגים בסריקה.

/** מפתח קנוני לזוג — תמיד קטן|גדול, כדי שסדר הבדיקה לא ישנה. */
const pairKey = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);

/** כל הזוגות שסומנו "לא כפילות", כ-Set של מפתחות. */
export function ignoredPairs() {
  const set = new Set();
  for (const r of db.prepare('SELECT a, b FROM duplicate_ignores').all()) set.add(pairKey(r.a, r.b));
  return set;
}

/** כמה זוגות מסומנים כרגע (לתצוגת "שחזר" בפאנל). */
export function ignoredCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM duplicate_ignores').get().n;
}

/**
 * סימון הקבוצה שאליה שייכת `rowId` כ"לא כפילות": כל הזוגות בתוכה נשמרים.
 * הסריקה נעשית **בלי** הדילוגים הקיימים, כדי שהקבוצה תימצא כפי שהיא.
 * מחזיר { pairs, rows } — 0 אם השורה כבר לא בקבוצה כלשהי.
 */
export function ignoreDuplicateGroup(rowId) {
  const id = Number(rowId);
  const group = scanDuplicates({ applyIgnores: false }).find((g) => g.rows.some((r) => r.id === id));
  if (!group) return { pairs: 0, rows: 0 };
  const ids = group.rows.map((r) => r.id);
  const insert = db.prepare('INSERT OR IGNORE INTO duplicate_ignores (a, b) VALUES (?, ?)');
  let pairs = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
      pairs += insert.run(a, b).changes;
    }
  }
  return { pairs, rows: ids.length, merchant: group.rows[0].merchant, date: group.date, amount: group.amount };
}

/** ביטול כל הסימונים — הקבוצות חוזרות לפאנל. פעולה הפיכה בלחיצה. */
export function clearIgnoredDuplicates() {
  return db.prepare('DELETE FROM duplicate_ignores').run().changes;
}
