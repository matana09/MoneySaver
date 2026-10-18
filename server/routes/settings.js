// הגדרות — טלגרם, התראות, ML
import { Router } from 'express';
import { getSetting, setSetting } from '../db.js';
import { mlStatus, mlTrain } from '../lib/ml.js';
import { labeledData } from '../lib/categorize.js';
import { restartBot, botStatus, pushMenuToUsers } from '../bot.js';
import { codexStatus, clearCodexStatusCache } from '../lib/codex.js';
import { usageSummary } from '../lib/llmUsage.js';
import { DEFAULT_ENGINE } from '../lib/llm.js';
import { setCycleDayFrom, clearCycleDayHistory, cycleDayHistory, cycleDayFn } from './flow.js';
import { cycleAnchorForToday, cycleWindow } from '../lib/dates.js';

const router = Router();

const KEYS = ['telegram_token', 'telegram_chat_id', 'telegram_chat_id_2', 'notify_days', 'notify_hour', 'cycle_day', 'menu_persistent', 'gemini_api_key', 'llm_engine'];
// מפתחות שלא מוחזרים במלואם ב-GET (מסכה) ולא נשמרים כשחוזרת המסכה מהטופס
const SECRET_KEYS = ['telegram_token', 'gemini_api_key'];
const DEFAULTS = { notify_days: '0,2,4', notify_hour: '9', cycle_day: '10', menu_persistent: '0', llm_engine: DEFAULT_ENGINE }; // א'/ג'/ה' ב-9:00; מחזור 10; קיבוע מקלדת כבוי

router.get('/', async (_req, res) => {
  const out = {};
  for (const k of KEYS) out[k] = getSetting(k, DEFAULTS[k] ?? '');
  // לא מחזירים סודות במלואם — רק אינדיקציה + 4 תווים אחרונים
  for (const k of SECRET_KEYS) {
    out[`${k}_set`] = Boolean(out[k]);
    out[k] = out[k] ? '••••' + out[k].slice(-4) : '';
  }
  // שינויי יום העוגן לאורך זמן — כדי שההגדרות יציגו "10 עד יולי, 9 מאוגוסט"
  out.cycle_day_history = cycleDayHistory();
  // המחזור שמכיל את היום — זה מה ש"החל מהמחזור הנוכחי" יעשה בפועל
  const anchor = cycleAnchorForToday(cycleDayFn);
  out.cycle_current = { month: anchor, label: cycleWindow(anchor, cycleDayFn).label };
  out.ml = mlStatus();
  out.bot = botStatus();
  // מצב הגשר ל-ChatGPT (Codex CLI) ומוני השימוש בשני המנועים
  out.codex = await codexStatus();
  out.usage = usageSummary();
  res.json(out);
});

// בדיקה מחדש של החיבור ל-Codex (אחרי `codex login` בטרמינל)
router.post('/codex/recheck', async (_req, res) => {
  clearCodexStatusCache();
  res.json({ codex: await codexStatus() });
});

router.put('/', async (req, res) => {
  let botChanged = false;
  let menuChanged = false;
  for (const k of KEYS) {
    if (req.body[k] === undefined) continue;
    if (SECRET_KEYS.includes(k) && String(req.body[k]).includes('••••')) continue; // המסכה חזרה מהטופס
    if (k === 'cycle_day') {
      const d = Number(req.body[k]);
      if (!Number.isInteger(d) || d < 1 || d > 28) return res.status(400).json({ error: 'cycle_day חייב להיות מספר שלם 1–28' });
      // `cycle_day_from` (YYYY-MM) — החל את היום החדש **מהחודש הזה ואילך בלבד**,
      // כך שחודשים שכבר נסגרו נשארים חתוכים כפי שהיו. בלי הדגל, שינוי היום
      // חותך מחדש את כל ההיסטוריה (ההתנהגות הישנה — נשמרה במכוון).
      let from = req.body.cycle_day_from;
      if (from !== undefined && from !== null && from !== '') {
        // 'current' (סנטינל) — המחזור שמכיל את היום, מחושב **בשרת**. הלקוח לא
        // שולח חודש: `currentMonth` ב-web הוא החודש שהמשתמש *מסתכל* עליו, ושמירה
        // ממנו הייתה חותכת מחדש חודש שכבר נסגר.
        if (from === 'current') from = cycleAnchorForToday(cycleDayFn);
        if (!/^\d{4}-\d{2}$/.test(from)) return res.status(400).json({ error: 'cycle_day_from חייב להיות בפורמט YYYY-MM' });
        setCycleDayFrom(from, d);
        continue; // ערך הבסיס ב-settings לא משתנה — הוא מה שחל על העבר
      }
      clearCycleDayHistory(); // חזרה ליום גלובלי אחד
    }
    if (k === 'llm_engine' && !['gemini', 'chatgpt'].includes(req.body[k])) {
      return res.status(400).json({ error: 'מנוע לא מוכר (gemini / chatgpt)' });
    }
    if (k === 'menu_persistent' && req.body[k] !== getSetting('menu_persistent', '0')) menuChanged = true;
    setSetting(k, req.body[k]);
    // menu_persistent — המקלדת נבנית מחדש ב-startBot, לכן שינוי דורש restart של הבוט
    if (k === 'telegram_token' || k === 'telegram_chat_id' || k === 'telegram_chat_id_2' || k === 'menu_persistent') botChanged = true;
  }
  if (botChanged) await restartBot();
  // דגל הקיבוע השתנה מה-web: המקלדת הפעילה בטלגרם היא זו שצורפה להודעה האחרונה,
  // לכן חובה לשלוח הודעת רענון עם המקלדת החדשה — אחרת השינוי לא נראה בצ'אט.
  if (menuChanged) {
    await pushMenuToUsers(getSetting('menu_persistent', '0') === '1'
      ? '📌 קיבוע מקלדת הופעל — התפריט יופיע אוטומטית בכניסה לצ\'אט. אם "חזרה" נתקע, שלח /settings וכבה.'
      : '📌 קיבוע מקלדת כובה 👇');
  }
  res.json({ saved: true, bot: botStatus() });
});

// אימון ידני מחדש של המודל
router.post('/train', async (_req, res) => {
  const result = await mlTrain(labeledData());
  res.json(result ?? { trained: false, reason: 'ml_unavailable' });
});

export default router;
