// watchdog.js — בדיקת חיים כל 10 דקות (scheduled task). אם השרת לא עונה:
// מפעיל מחדש את ה-task ושולח התראה לטלגרם. דטרמיניסטי, בלי AI.
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// עקבי עם server/db.js — env override אחיד לכל צרכני ה-DB
const DATA_DIR = process.env.MONEYSAVER_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'moneysaver.db');
const HEALTH_URL = 'http://127.0.0.1:3000/api/health';
const TASK_NAME = 'MoneySaver-Tzarim';

async function isHealthy() {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5000) });
    return res.ok && (await res.json()).ok === true;
  } catch {
    return false;
  }
}

/**
 * שרת חי אך עסוק ≠ שרת מת. קריאת LLM דרך Codex CLI מריצה תהליך כבד ומעכבת את
 * ה-event loop לשניות בודדות — נמדד: /api/health ענה תוך 3.1 שניות תוך כדי
 * שאלה בצ'אט. בדיקה בודדת עם timeout של 5 שניות הרגה בפועל שרת תקין באמצע
 * בקשה (נצפה 31/07/2026). לכן: מכריזים על מוות רק אחרי 3 כישלונות רצופים.
 */
async function isDead({ attempts = 3, gapMs = 8000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (await isHealthy()) return false;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  return true;
}

function getSetting(key) {
  if (!existsSync(DB_PATH)) return null;
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
    } finally {
      db.close();
    }
  } catch {
    // SQLITE_BUSY חולף / DB עוד בלי סכמה — עדיף לוותר על ההתראה מלהקריס את ה-watchdog
    return null;
  }
}

async function notifyTelegram(text) {
  const token = getSetting('telegram_token');
  const chatIds = [getSetting('telegram_chat_id'), getSetting('telegram_chat_id_2')].filter(Boolean);
  if (!token || !chatIds.length) return;
  for (const chatId of chatIds) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(10000),
      });
    } catch { /* אין רשת — נדווח בפעם הבאה */ }
  }
}

// ---------- main ----------
if (!(await isDead())) process.exit(0); // הכול תקין (או עסוק) — יציאה שקטה

console.log('השרת לא ענה ב-3 בדיקות רצופות — מפעיל מחדש דרך ה-task…');
// StopExisting של ה-task הורג רק את wscript.exe (עוטף run-hidden.vbs), לא את
// node.exe הבן — הוא נשאר יתום, ו-/Run הבא היה יוצר node שני → getUpdates 409
// conflict → הבוט מפסיק להגיב (health עדיין עונה, אז לא היה מתאושש). לכן הורגים
// קודם כירורגית לפי CommandLine — רק MoneySaver, לעולם לא taskkill גורף (CLAUDE.md).
const killOrphans =
  "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','wscript.exe') -and " +
  "($_.CommandLine -like '*MONEY SAVER*run-hidden.vbs*' -or $_.CommandLine -like '*server/index.js*') } | " +
  "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
try { execSync(`schtasks /End /TN "${TASK_NAME}"`, { stdio: 'ignore' }); } catch { /* לא רץ */ }
try { execSync(`powershell -NoProfile -Command "${killOrphans}"`, { stdio: 'ignore' }); } catch { /* אין שאריות */ }
try {
  execSync(`schtasks /Run /TN "${TASK_NAME}"`, { stdio: 'ignore' });
} catch { /* task לא רשום? נדווח למטה */ }

// המתנה לעלייה (עד 45 שניות — כולל עליית ML)
let recovered = false;
for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  if (await isHealthy()) { recovered = true; break; }
}

const now = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
if (recovered) {
  // בלי הודעת טלגרם: ברוב המקרים זה חלון קצר שנתפס תוך כדי restart יזום (deploy),
  // לא תקלה אמיתית — לוג מקומי מספיק. התראה נשלחת רק כשההתאוששות נכשלת (למטה).
  console.log('השרת התאושש.');
} else {
  console.log('השרת לא התאושש!');
  await notifyTelegram(`🚨 MoneySaver לא מגיב ולא הצליח לעלות מחדש (${now}). בדוק את המחשב.`);
  process.exit(1);
}
