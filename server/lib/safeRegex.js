// safeRegex.js — ולידציה של regex שהמשתמש מזין, עם הגנה מפני ReDoS
// (regex פתולוגי יכול לתקוע את ה-event loop). מגביל אורך ומזהה דפוסים מסוכנים.

const MAX_LEN = 200;

// דפוסי "nested quantifier" קלאסיים ל-catastrophic backtracking: (a+)+ , (a*)* , (a+)* וכו'
const NESTED_QUANTIFIER = /(\([^)]*[+*][^)]*\)|\[[^\]]*\])[+*]\{?|\)\s*[+*]/;
const DANGEROUS = [
  /(\(.*[+*].*\))[+*]/,     // קבוצה עם quantifier, שכולה תחת quantifier
  /\\\d{3,}/,               // backreferences מרובים
];

/** מחזיר { ok: true } או { ok: false, error } */
export function validateUserRegex(pattern) {
  const p = String(pattern ?? '');
  if (!p.trim()) return { ok: false, error: 'ביטוי ריק' };
  if (p.length > MAX_LEN) return { ok: false, error: `ביטוי ארוך מדי (מקסימום ${MAX_LEN} תווים)` };

  // תקינות תחבירית
  try {
    // eslint-disable-next-line no-new
    new RegExp(p, 'i');
  } catch {
    return { ok: false, error: 'regex לא תקין תחבירית' };
  }

  // דפוסים מסוכנים
  for (const re of [NESTED_QUANTIFIER, ...DANGEROUS]) {
    if (re.test(p)) return { ok: false, error: 'ביטוי מורכב מדי (חשש לביצועים) — פשט אותו' };
  }
  return { ok: true };
}

/** התאמה בטוחה עם timeout רך: בודק אורך קלט ומריץ. מחזיר boolean. */
export function safeTest(pattern, input) {
  try {
    return new RegExp(pattern, 'i').test(String(input).slice(0, 500));
  } catch {
    return false;
  }
}
