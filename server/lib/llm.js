// llm.js — נקודת כניסה אחת לכל קריאת LLM באפליקציה (תלוש, משכנתא, web ובוט).
// בוחרת מנוע לפי ההגדרה `llm_engine`, סופרת שימוש, ונופלת ל-Gemini כשהמנוע
// המועדף נכשל. הקוראים מקבלים תמיד { text, model } — אותו חוזה כמו קודם.
import { getSetting } from '../db.js';
import { geminiAnalyze } from './gemini.js';
import { codexAnalyze, isQuotaError } from './codex.js';
import { recordUsage, recordFailure } from './llmUsage.js';

export const DEFAULT_ENGINE = 'gemini';

// תקרת הזמן לניתוח מלא (תלוש/משכנתא) במסלול Codex. נמדד בפועל על פרומפט
// המשכנתא (70K תווים, אחרי `stripBoilerplate`): **329 שניות**. תקרת ברירת
// המחדל של 180 שניות הפילה כל ניתוח משכנתא ל-Gemini עם
// "הניתוח ארך יותר מדי" — המשתמש בחר ChatGPT וקיבל Gemini בלי להבין למה.
// 480 שניות = המדידה + ~45% מרווח. הצ'אט החופשי נשאר על הדיפולט: הפרומפט שם
// קטן, והמשתמש מחכה לתשובה מול המסך.
export const ANALYSIS_TIMEOUT_MS = 480000;

/** המנוע שנבחר בהגדרות (gemini = ברירת מחדל; chatgpt = דרך מנוי ChatGPT) */
export function currentEngine() {
  return getSetting('llm_engine', DEFAULT_ENGINE) === 'chatgpt' ? 'chatgpt' : 'gemini';
}

/** האם יש מפתח Gemini — נדרש גם כרשת ביטחון למצב chatgpt */
function geminiKey() {
  return getSetting('gemini_api_key', '');
}

/**
 * הרצת פרומפט מול המנוע הפעיל.
 * codexModel — מודל נקוב למסלול ה-Codex בלבד (Gemini מתעלם). משמש את הצ'אט
 * החופשי כדי לרוץ על מודל מהיר יותר; ניתוח תלוש/משכנתא נשאר על הדיפולט.
 * מחזיר { text, model, engine, fellBack } — fellBack=true כשהמנוע המועדף
 * נכשל והתשובה הגיעה מ-Gemini (ה-UI מציג זאת למשתמש).
 * זורק Error עם הודעה בעברית כשגם הנפילה נכשלה.
 */
export async function llmAnalyze(promptText, { timeoutMs = 180000, codexModel = null } = {}) {
  const engine = currentEngine();

  if (engine === 'chatgpt') {
    try {
      const { text, model } = await codexAnalyze(promptText, { timeoutMs, model: codexModel });
      recordUsage('chatgpt');
      return { text, model, engine: 'chatgpt', fellBack: false };
    } catch (err) {
      const msg = err?.message ?? 'שגיאה לא ידועה';
      recordFailure('chatgpt', msg, { quota: isQuotaError(msg) });
      // בלי מפתח Gemini אין לאן ליפול — מחזירים את השגיאה המקורית כמות שהיא
      if (!geminiKey()) throw err;
      const { text, model } = await geminiAnalyze(promptText, geminiKey(), { timeoutMs });
      recordUsage('gemini');
      return { text, model, engine: 'gemini', fellBack: true, fallbackReason: msg };
    }
  }

  const key = geminiKey();
  if (!key) throw new Error('לא הוגדר מפתח Gemini');
  try {
    const { text, model } = await geminiAnalyze(promptText, key, { timeoutMs });
    recordUsage('gemini');
    return { text, model, engine: 'gemini', fellBack: false };
  } catch (err) {
    const msg = err?.message ?? 'שגיאה לא ידועה';
    recordFailure('gemini', msg, { quota: /מכסת|429|quota/i.test(msg) });
    throw err;
  }
}

/**
 * האם אפשר להריץ ניתוח בכלל — משמש את ה-routes במקום בדיקת מפתח Gemini בלבד.
 * מחזיר { ok, error } ; error מוכן להצגה למשתמש.
 */
export function llmReady() {
  if (currentEngine() === 'chatgpt') return { ok: true };
  if (geminiKey()) return { ok: true };
  return {
    ok: false,
    error: 'לא הוגדר מפתח Gemini — הוסף אותו בהגדרות, עבור למנוע ChatGPT, או השתמש בכפתור "העתק פרומפט" והדבק בצ׳אטבוט',
  };
}
