// run-tests.mjs — מריץ את כל מערכי הבדיקות מול שרת מבודד (DB זמני, פורט 3100).
// לעולם לא נוגע בנתוני האמת שב-data/ או בבוט הטלגרם החי.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TMP_DATA = path.join(__dirname, '.tmp', 'data');
const PORT = 3100;
const ML_PORT = 8301;
const BASE = `http://127.0.0.1:${PORT}`;

const testEnv = {
  ...process.env,
  PORT: String(PORT),
  ML_PORT: String(ML_PORT),
  MONEYSAVER_DATA_DIR: TMP_DATA,
  MS_BASE: BASE,
  PYTHONIOENCODING: 'utf-8',
  // שליפת נתוני השוק מבנק ישראל (server/lib/marketRates.js) לא רצה בבדיקות —
  // הן לא תלויות באינטרנט. הפונקציות הטהורות נבדקות מול fixture.
  MONEYSAVER_NO_NET: '1',
  MONEYSAVER_WEB_PASSWORD: '',
  MONEYSAVER_PUBLIC_ORIGIN: '',
  MONEYSAVER_TRUST_LOCAL_PROXY: '0',
};

function log(msg) { console.log(`[runner] ${msg}`); }

function cleanupTestData() {
  const target = path.resolve(__dirname, '.tmp');
  if (path.dirname(target) !== path.resolve(ROOT, 'tests')) throw new Error('Unsafe test cleanup path');
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

async function waitForHealth(timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch { /* עוד לא למעלה */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ייבוא sklearn איטי (נמדד ~25s כשמופע prod רץ במקביל) — לכן 60s
async function waitForMl(timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/settings`, { signal: AbortSignal.timeout(2000) });
      if ((await res.json()).ml?.available) return true;
    } catch { /* noop */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false; // ממשיכים גם בלי ML — A5 ידווח
}

function runSuite(name, cmd, args) {
  log(`--- ${name} ---`);
  const res = spawnSync(cmd, args, {
    cwd: ROOT, env: testEnv, stdio: 'inherit', encoding: 'utf-8',
  });
  return res.status === 0;
}

// ---------- main ----------
// אם מופע יתום מריצה קודמת עדיין מחזיק את 3100 — waitForHealth היה מזהה אותו
// כשרת טרי והבדיקות היו רצות מול state מיושן. נכשלים בקול רם במקום.
try {
  await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
  console.error(`[runner] ❌ פורט ${PORT} כבר תפוס — כנראה שרת בדיקות יתום מריצה קודמת.`);
  console.error('[runner] הרוג אותו: Get-NetTCPConnection -LocalPort 3100 | % { Stop-Process -Id $_.OwningProcess -Force }');
  process.exit(1);
} catch { /* הפורט פנוי — ממשיכים */ }

cleanupTestData();
mkdirSync(TMP_DATA, { recursive: true });

log(`מרים שרת בדיקות מבודד על פורט ${PORT} (DB זמני: tests/.tmp)`);
const server = spawn('node', ['server/index.js'], {
  cwd: ROOT, env: testEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

let failed = 0;
try {
  if (!(await waitForHealth())) throw new Error('שרת הבדיקות לא עלה תוך 60 שניות');
  log('שרת למעלה. ממתין למנוע ML…');
  log((await waitForMl()) ? 'ML פעיל.' : 'ML לא זמין — ממשיכים (A5 עלול להיכשל).');

  const suites = [
    ['web-access', 'node', ['tests/web_access.mjs']],
    ['publication', 'node', ['tests/publication.mjs']],
    ['acceptance', 'python', ['tests/acceptance.py']],
    ['security-web', 'python', ['tests/security_web.py']],
    ['security-bot', 'node', ['tests/sec_bot.mjs']],
    ['shared-notifications', 'node', ['tests/shared_notifications.mjs']],
    ['parsers', 'node', ['tests/parsers.mjs']],
    ['installments', 'node', ['tests/installments.mjs']],
    ['cycle', 'node', ['tests/cycle.mjs']],
    ['category-assign', 'node', ['tests/category_assign.mjs']],
    ['duplicates', 'node', ['tests/duplicates.mjs']],
    ['recurring', 'node', ['tests/recurring.mjs']],
    ['income-cycle', 'node', ['tests/income_cycle.mjs']],
    ['ocr', 'node', ['tests/ocr.mjs']],
    ['payslip', 'node', ['tests/payslip.mjs']],
    ['mortgage', 'node', ['tests/mortgage.mjs']],
    ['assistant', 'node', ['tests/assistant.mjs']],
  ];
  for (const [name, cmd, args] of suites) {
    if (!runSuite(name, cmd, args)) failed++;
  }
} catch (err) {
  console.error(`[runner] שגיאה: ${err.message}`);
  failed++;
} finally {
  // הריגת עץ התהליכים (node + ילד ה-python של ה-ML) — ב-Windows דרך taskkill /T
  try { spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* noop */ }
  cleanupTestData();
}

console.log(failed === 0
  ? '\n[runner] ✅ כל המערכים עברו'
  : `\n[runner] ❌ ${failed} מערכים נכשלו`);
process.exit(failed === 0 ? 0 : 1);
