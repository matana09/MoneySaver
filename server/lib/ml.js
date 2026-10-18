// ml.js — לקוח ל-service הפייתון (scikit-learn) + fallback מלא ב-Node
// ה-service רץ על פורט מקומי; אם Python/sklearn לא זמינים — האפליקציה ממשיכה לעבוד.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { db } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ML_PORT = process.env.ML_PORT || 8300;
const ML_BASE = `http://127.0.0.1:${ML_PORT}`;

let mlAvailable = false;
let mlProcess = null;

/* ---------- הפעלת ה-service ---------- */
export function startMlService() {
  const script = path.join(__dirname, '..', '..', 'ml', 'service.py');
  try {
    mlProcess = spawn('python', [script, String(ML_PORT)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    mlProcess.stdout.on('data', (d) => {
      const line = d.toString().trim();
      if (line.includes('ML_READY')) {
        mlAvailable = true;
        console.log('  מנוע ML:  פעיל (scikit-learn)');
      }
    });
    mlProcess.stderr.on('data', () => {});
    mlProcess.on('exit', () => { mlAvailable = false; });
    mlProcess.unref?.();
  } catch {
    mlAvailable = false;
  }
  // אם תוך 15 שניות אין ML_READY — ממשיכים עם fallback
  setTimeout(() => {
    if (!mlAvailable) console.log('  מנוע ML:  לא זמין — עובדים עם חוקים והיסטוריה בלבד');
  }, 15000);
}

export function stopMlService() {
  try { mlProcess?.kill(); } catch { /* noop */ }
}

async function mlFetch(pathName, body, timeoutMs = 4000) {
  if (!mlAvailable) return null;
  try {
    const res = await fetch(ML_BASE + pathName, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/* ---------- קטגוריזציה ---------- */
export async function mlCategorize(merchant) {
  return mlFetch('/categorize', { merchant });
}

export async function mlTrain(labeled) {
  return mlFetch('/train', { data: labeled }, 30000);
}

export function mlStatus() {
  return { available: mlAvailable };
}

/* ---------- חיזוי סוף חודש ---------- */
// אוסף לכל חודש היסטורי את ההוצאה המצטברת לפי יום — לאימון רגרסיה
function monthlyDailyCumulative() {
  return db.prepare(`
    SELECT substr(COALESCE(charge_date, date), 1, 7) AS month,
           CAST(substr(COALESCE(charge_date, date), 9, 2) AS INTEGER) AS day,
           SUM(amount) AS daily
    FROM transactions WHERE type = 'expense'
    GROUP BY month, day ORDER BY month, day
  `).all();
}

/* fallback ב-Node: קצב יומי — ממוצע היסטורי אם קיים, אחרת קצב החודש הנוכחי */
function naiveForecast(month) {
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const now = new Date();
  const isCurrent = month === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const dayNow = isCurrent ? now.getDate() : daysInMonth;

  const { spent } = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS spent FROM transactions
    WHERE type = 'expense' AND substr(COALESCE(charge_date, date), 1, 7) = ?
  `).get(month);

  // ממוצע הוצאה חודשית מ-3 החודשים הקודמים המלאים
  const prev = db.prepare(`
    SELECT AVG(total) AS avg_total FROM (
      SELECT SUM(amount) AS total FROM transactions
      WHERE type = 'expense' AND substr(COALESCE(charge_date, date), 1, 7) < ?
      GROUP BY substr(COALESCE(charge_date, date), 1, 7) ORDER BY substr(COALESCE(charge_date, date), 1, 7) DESC LIMIT 3
    )
  `).get(month);

  let predicted;
  if (prev?.avg_total) {
    // משקללים: מה שהוצא בפועל + החלק היחסי הצפוי מהממוצע ההיסטורי לימים שנותרו
    const remainingShare = (daysInMonth - dayNow) / daysInMonth;
    predicted = spent + prev.avg_total * remainingShare;
  } else if (dayNow > 0 && spent > 0) {
    predicted = (spent / dayNow) * daysInMonth; // קצב נוכחי
  } else {
    predicted = spent;
  }
  return { predicted_expenses: Math.round(predicted), method: prev?.avg_total ? 'history-blend' : 'pace', spent };
}

export async function forecastMonth(month) {
  // ניסיון דרך sklearn; אחרת fallback
  const history = monthlyDailyCumulative();
  const now = new Date();
  const isCurrent = month === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();

  const mlResult = await mlFetch('/forecast', {
    history,
    month,
    day_now: isCurrent ? now.getDate() : daysInMonth,
    days_in_month: daysInMonth,
  });
  if (mlResult?.predicted_expenses !== undefined) {
    return { ...mlResult, method: 'sklearn' };
  }
  return naiveForecast(month);
}
