// llmUsage.js — מונה שימוש במנועי ה-LLM (Gemini / ChatGPT דרך Codex).
// למה ספירה מקומית: אף אחד מהמנועים לא מחזיר "כמה נשאר לי" בתשובה רגילה.
// Gemini לא חושף את המכסה בכלל; לכן סופרים כאן כל בקשה, ומסמנים "מוצה"
// כשמגיעה שגיאת 429. זו אינדיקציה, לא נתון רשמי — וכך גם מוצג ב-UI.
import { getSetting, setSetting } from '../db.js';

const SETTING_KEY = 'llm_usage_json';
export const ENGINES = ['gemini', 'chatgpt'];

/**
 * מכסת ה-RPD של Gemini מתאפסת בחצות שעון קליפורניה — כ-10:00 בבוקר שעון
 * ישראל בקיץ (ראו CLAUDE.md). מחזיר את מועד האיפוס הבא בזמן מקומי.
 */
export function nextGeminiReset(now = new Date()) {
  const reset = new Date(now);
  reset.setHours(10, 0, 0, 0);
  if (reset <= now) reset.setDate(reset.getDate() + 1);
  return reset;
}

/** מחרוזת יום מקומית (לא toISOString — באג חצות, ראו server/lib/dates.js) */
function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function emptyEngine() {
  return { day: null, count: 0, total: 0, last_at: null, exhausted_at: null, last_error: null };
}

function read() {
  const raw = getSetting(SETTING_KEY, '');
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
  for (const e of ENGINES) data[e] = { ...emptyEngine(), ...(data[e] ?? {}) };
  return data;
}

function write(data) {
  setSetting(SETTING_KEY, JSON.stringify(data));
}

/** איפוס המונה היומי כשהתחלף היום (לפי מועד האיפוס של המכסה) */
function rollDay(entry, now) {
  // היום "נשבר" ב-10:00 — בקשה ב-09:00 שייכת ליום הקודם מבחינת המכסה
  const shifted = new Date(now);
  shifted.setHours(shifted.getHours() - 10);
  const day = localDay(shifted);
  if (entry.day !== day) {
    entry.day = day;
    entry.count = 0;
    entry.exhausted_at = null;
    entry.last_error = null;
  }
  return entry;
}

/** רישום בקשה מוצלחת */
export function recordUsage(engine, now = new Date()) {
  if (!ENGINES.includes(engine)) return;
  const data = read();
  const entry = rollDay(data[engine], now);
  entry.count += 1;
  entry.total += 1;
  entry.last_at = now.toISOString();
  // הצלחה מנקה שגיאה קודמת — אחרת המשתמש רואה "מוצתה" או שגיאה ישנה
  // לצד מונה שממשיך לעלות, וזה מטעה.
  entry.last_error = null;
  entry.exhausted_at = null;
  write(data);
}

/** רישום כישלון. quota=true מסמן שהמכסה מוצתה (429) */
export function recordFailure(engine, message, { quota = false } = {}, now = new Date()) {
  if (!ENGINES.includes(engine)) return;
  const data = read();
  const entry = rollDay(data[engine], now);
  entry.last_error = String(message ?? '').slice(0, 300);
  if (quota) entry.exhausted_at = now.toISOString();
  write(data);
}

/**
 * סיכום לתצוגה. כולל את מועד האיפוס הבא ואת מצב המיצוי.
 * אין כאן "כמה נשאר" — אף מנוע לא מספק את המספר הזה.
 */
export function usageSummary(now = new Date()) {
  const data = read();
  const out = { reset_at: nextGeminiReset(now).toISOString(), engines: {} };
  for (const e of ENGINES) {
    const entry = rollDay({ ...data[e] }, now);
    out.engines[e] = {
      count_today: entry.count,
      total: entry.total,
      last_at: entry.last_at,
      exhausted: Boolean(entry.exhausted_at),
      exhausted_at: entry.exhausted_at,
      last_error: entry.last_error,
    };
  }
  return out;
}
