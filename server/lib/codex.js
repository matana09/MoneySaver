// codex.js — גשר ל-Codex CLI הרשמי של OpenAI, כדי להשתמש במנוי ChatGPT Plus
// בלי לקנות API. ההתחברות נעשית פעם אחת בטרמינל (`codex login`, OAuth בדפדפן);
// ה-tokens נשמרים ב-~/.codex/auth.json ונקראים ע"י ה-CLI בלבד — השרת לא נוגע בהם.
//
// כללי ברזל בקובץ הזה:
//   1. **הפרומפט עובר ב-stdin, לעולם לא כארגומנט** — טקסט תלוש/משכנתא מכיל
//      תווים שמפרש shell היה בולע, וארגומנט ארוך נחתך ב-Windows.
//   2. **הארגומנטים (args) קבועים בקוד, אף פעם לא טקסט משתמש** — הפרמטר
//      היחיד שהיה עלול להיות דינמי (`model`) לא מגיע ממקור חיצוני בפועל.
//      זו ההגנה האמיתית מפני הזרקה — לא ה-shell option (ראו סעיף 3).
//   3. **ב-Windows חובה `shell: true`** — codex.cmd הוא batch script, לא
//      קובץ הרצה מקורי; Windows CreateProcess לא יכול להריץ אותו ישירות
//      (spawn נכשל עם EINVAL). כדי להימנע מאזהרת ה-escaping של Node
//      (DEP0190 — args array + shell:true) בונים מחרוזת פקודה יחידה במקום
//      להעביר args כמערך; זה בטוח כי כל טוקן קבוע-מראש (ללא רווחים/גרשיים).
//   4. **sandbox לקריאה בלבד ובלי אישורי כלים** — Codex הוא סוכן שיודע להריץ
//      פקודות; PDF עוין עם prompt-injection לא יקבל הרשאה לכתוב או להריץ.
//   5. **לא מגדירים OPENAI_API_KEY** ומנקים אותו מהסביבה — נוכחות מפתח גורמת
//      ל-CLI לחייב דרך חשבון ה-Platform במקום להשתמש במכסת המנוי.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

/** MONEYSAVER_NO_NET=1 — הבדיקות לא נוגעות במכסה של המשתמש */
const NO_NET = () => process.env.MONEYSAVER_NO_NET === '1';

const IS_WIN = process.platform === 'win32';
// ב-Windows ה-CLI מותקן כ-codex.cmd (batch script); בלינוקס/מק בינארי רגיל.
const CODEX_BIN = IS_WIN ? 'codex.cmd' : 'codex';

/** תיקיית עבודה ריקה וקבועה לסוכן (ראו ההסבר על -C ב-codexAnalyze) */
let emptyDirCache = null;
function emptyWorkdir() {
  if (!emptyDirCache) {
    emptyDirCache = path.join(tmpdir(), 'moneysaver-codex-workdir');
    try { mkdirSync(emptyDirCache, { recursive: true }); } catch { /* קיימת */ }
  }
  return emptyDirCache;
}

/** סביבה נקייה מכל מפתח API — הגנה מפני זליגה לחיוב לפי token */
function cleanEnv() {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_API_BASE;
  delete env.OPENAI_BASE_URL;
  return env;
}

// גרש כפול לכל טוקן שמכיל רווח/גרש — כרגע אף טוקן לא מכיל, זו הגנת-משנה בלבד.
const quote = (s) => (/[\s"]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));

/** הרצת codex עם ארגומנטים; הפרומפט (אם יש) נכתב ל-stdin */
function run(args, { input = null, timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = IS_WIN
        // מחרוזת פקודה יחידה — לא args array — כדי לא לעורר את DEP0190
        // ולהריץ את ה-batch script דרך cmd.exe (shell:true הכרחי כאן).
        ? spawn([CODEX_BIN, ...args].map(quote).join(' '), { env: cleanEnv(), shell: true, windowsHide: true })
        : spawn(CODEX_BIN, args, { env: cleanEnv(), shell: false, windowsHide: true });
    } catch (err) {
      return resolve({ ok: false, code: -1, stdout: '', stderr: String(err?.message ?? err) });
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    // תקרת פלט — תשובת מודל שיצאה משליטה לא תנפח את הזיכרון
    const MAX = 2_000_000;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      // ב-Windows child.pid הוא ה-cmd.exe שעוטף את codex.cmd → node.exe;
      // SIGKILL רגיל לא הורג את עץ התהליכים, לכן taskkill /T (כמו ב-tests/run-tests.mjs).
      if (IS_WIN) {
        try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* noop */ }
      } else {
        try { child.kill('SIGKILL'); } catch { /* noop */ }
      }
      resolve({ ok: false, code: -2, stdout, stderr: 'timeout' });
    }, timeoutMs);

    child.stdout.on('data', (d) => { if (stdout.length < MAX) stdout += d.toString(); });
    child.stderr.on('data', (d) => { if (stderr.length < MAX) stderr += d.toString(); });
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: String(err?.message ?? err) });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });

    if (input !== null) {
      child.stdin.on('error', () => { /* הצינור נסגר מוקדם — נטפל דרך close */ });
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

// ~/.codex/auth.json מכיל את השדה auth_mode: 'chatgpt' = שימוש במכסת המנוי,
// 'apikey' = חיוב לפי token דרך חשבון ה-Platform. זו ההוכחה החד-משמעית
// היחידה לאיזה ערוץ חיוב פעיל — לכן codexAnalyze חוסם כל מצב שאינו chatgpt.
// נקראים רק שני השדות האלה; ה-tokens עצמם לא נוגעים בקוד ולא נכנסים ללוג.
function readAuthMode() {
  try {
    const raw = readFileSync(path.join(homedir(), '.codex', 'auth.json'), 'utf8');
    const j = JSON.parse(raw);
    return {
      mode: typeof j?.auth_mode === 'string' ? j.auth_mode : null,
      keyStored: Boolean(j?.OPENAI_API_KEY),
    };
  } catch {
    return { mode: null, keyStored: false };
  }
}

/**
 * האם הגשר זמין: ה-CLI מותקן ומחובר. התוצאה נשמרת ב-cache לדקה — הבדיקה
 * מריצה תהליך, ו-GET /api/settings נקרא בכל טעינת עמוד.
 */
let statusCache = { at: 0, value: null };
export async function codexStatus({ maxAgeMs = 60000 } = {}) {
  if (NO_NET()) return { installed: false, loggedIn: false, reason: 'שליפה מושבתת (MONEYSAVER_NO_NET)' };
  if (statusCache.value && Date.now() - statusCache.at < maxAgeMs) return statusCache.value;

  const version = await run(['--version'], { timeoutMs: 15000 });
  let value;
  if (!version.ok) {
    value = {
      installed: false,
      loggedIn: false,
      reason: 'Codex CLI לא מותקן — הרץ בטרמינל: npm i -g @openai/codex',
    };
  } else {
    const login = await run(['login', 'status'], { timeoutMs: 20000 });
    const text = `${login.stdout}\n${login.stderr}`;
    // ה-CLI מדפיס את חשבון ה-ChatGPT המחובר; קוד יציאה 0 = מחובר
    const loggedIn = login.ok && !/not logged in|לא מחובר/i.test(text);
    const auth = readAuthMode();
    value = {
      installed: true,
      version: version.stdout.trim().slice(0, 60),
      loggedIn,
      reason: loggedIn ? null : 'לא מחובר — הרץ בטרמינל: codex login (נפתח דפדפן, בלי סיסמה כאן)',
      // אזהרה: מפתח API בסביבה גורם ל-CLI לחייב דרך חשבון ה-Platform
      apiKeyInEnv: Boolean(process.env.OPENAI_API_KEY),
      // 'chatgpt' = שימוש במכסת המנוי; 'apikey' = חיוב לפי token בחשבון Platform
      authMode: auth.mode,
      authKeyStored: auth.keyStored,
    };
  }
  statusCache = { at: Date.now(), value };
  return value;
}

/** איפוס ה-cache — אחרי שהמשתמש התחבר ורוצה לראות את השינוי מיד */
export function clearCodexStatusCache() {
  statusCache = { at: 0, value: null };
}

/**
 * המודל המהיר לשאלות קצרות (הצ'אט החופשי). נמדד על אותו פרומפט, 3 דגימות:
 * gpt-5.6-sol (הדיפולט) 13.4s בממוצע · gpt-5.5 9.6s — שניהם 3/3 בציות
 * לפרוטוקול ה-#DATA. gpt-5.4-mini נבדק ונפסל: 70s וגם לא הבין את הפרוטוקול.
 * ניתוח תלוש ומשכנתא נשארים על הדיפולט (החזק) — הם רצים פעם בחודש.
 */
export const FAST_MODEL = 'gpt-5.5';

// מודל שהוסר משירות / לא מוכר — הטריגר לנפילה לדיפולט של ה-CLI
const MODEL_GONE_RE = /unknown model|model not found|unsupported model|no such model|invalid model|model_not_found/i;

// זיהוי מיצוי מכסה בהודעת השגיאה של ה-CLI — כדי לסמן את המד ולנפול ל-Gemini
const QUOTA_RE = /rate limit|usage limit|quota|too many requests|429|limit reached/i;
export function isQuotaError(text) {
  return QUOTA_RE.test(String(text ?? ''));
}

/**
 * שולח פרומפט דרך Codex ומחזיר { text, model } — אותו חוזה כמו geminiAnalyze,
 * כדי ש-llm.js יוכל להחליף ביניהם בלי שהקוראים יידעו.
 * זורק Error עם הודעה בעברית.
 */
export async function codexAnalyze(promptText, { timeoutMs = 180000, model = null } = {}) {
  if (NO_NET()) throw new Error('שליפה מושבתת בבדיקות (MONEYSAVER_NO_NET)');

  // מצב ההתקנה/התחברות משתנה לעתים נדירות והבדיקה שלו מריצה שני תהליכים
  // (~1.3s). לכן cache ארוך כאן — אבל **חסם התשלום לא נסמך עליו**: auth.json
  // נקרא טרי בכל קריאה (קריאת קובץ, בלי תהליך), כך שמעבר ל-apikey נתפס מיד.
  const status = await codexStatus({ maxAgeMs: 600000 });
  if (!status.installed) throw new Error(status.reason);
  if (!status.loggedIn) throw new Error(status.reason);

  const auth = readAuthMode();

  // חסם תשלום קשיח: רצים אך ורק במצב מנוי. כל מצב אחר (apikey) היה מחייב
  // לפי token דרך חשבון ה-Platform — מעבר ל-20$ של המנוי. עדיף להיכשל
  // וליפול ל-Gemini מאשר לגבות כסף שהמשתמש לא ביקש.
  if (auth.mode !== 'chatgpt') {
    throw new Error(
      `Codex לא במצב מנוי (auth_mode=${auth.mode ?? 'לא ידוע'}) — הרצה כזו הייתה מחויבת לפי token`
      + ' בחשבון ה-Platform. הרץ בטרמינל: codex logout ואז codex login (ובחר "Sign in with ChatGPT")',
    );
  }
  if (process.env.OPENAI_API_KEY || auth.keyStored) {
    throw new Error(
      'נמצא מפתח OPENAI_API_KEY — הרצה כזו עלולה להתחייב לפי token במקום להשתמש במכסת המנוי.'
      + ' הסר את המפתח (משתנה סביבה או ~/.codex/auth.json) ונסה שוב',
    );
  }

  // exec = מצב לא-אינטראקטיבי — אין בו בקשות אישור בכלל (הן שייכות רק למצב
  // האינטראקטיבי). --sandbox read-only הוא ההגבלה שמונעת מ-Codex לכתוב
  // קבצים או להריץ פקודות, גם אם הפרומפט (או PDF עוין) יבקש זאת.
  // הדגל --ask-for-approval לא קיים ב-exec בגרסה 0.146.0 (nonexistent flag נבדק).
  //
  // -C <תיקייה ריקה>: שורש העבודה של הסוכן. בלי זה Codex מקבל את תיקיית
  //   הפרויקט כ-workdir, סורק אותה ויכול למשוך קבצים לקונטקסט — מיותר (הפרומפט
  //   שלנו עומד בפני עצמו), איטי, וגם חושף את הקוד. נמדד: ~2 שניות לקריאה.
  // --ephemeral: בלי כתיבת קובצי session לדיסק. אנחנו לא משתמשים ב-resume.
  const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check',
    '-C', emptyWorkdir(), '--ephemeral'];
  if (model) args.push('--model', model);
  args.push('-'); // קרא את הפרומפט מ-stdin

  let res = await run(args, { input: promptText, timeoutMs });

  // מודל נקוב שהוסר משירות — נופלים לדיפולט של ה-CLI במקום להיכשל. אותו לקח
  // כמו ב-Gemini (CLAUDE.md): ספק מוציא גרסאות משירות בלי התראה, וקוד שנועל
  // גרסה נשבר בשקט. כאן הנעילה מכוונת (מהירות) ולכן נדרשת רשת ביטחון.
  if (!res.ok && model && MODEL_GONE_RE.test(`${res.stderr}\n${res.stdout}`)) {
    const fallbackArgs = args.filter((a, i) => a !== '--model' && args[i - 1] !== '--model');
    res = await run(fallbackArgs, { input: promptText, timeoutMs });
  }

  if (!res.ok) {
    const detail = `${res.stderr}\n${res.stdout}`.trim();
    if (res.code === -2) throw new Error('הניתוח ארך יותר מדי (timeout) — נסה שוב');
    if (isQuotaError(detail)) {
      throw new Error('חריגה ממכסת ה-Codex של מנוי ChatGPT — המכסה מתחדשת בחלון הבא, או עבור ל-Gemini בהגדרות');
    }
    throw new Error(`Codex החזיר שגיאה: ${detail.slice(0, 300) || `קוד יציאה ${res.code}`}`);
  }

  const text = extractAnswer(res.stdout);
  if (!text) throw new Error('Codex החזיר תשובה ריקה — נסה שוב');
  return { text, model: model ?? 'chatgpt-codex' };
}

/**
 * חילוץ תשובת המודל מהפלט. `codex exec` מדפיס גם שורות סטטוס (זמן, מודל,
 * "tokens used") סביב התשובה עצמה — מסירים אותן כדי שהמשתמש יראה רק Markdown.
 * מיוצא לבדיקות.
 */
export function extractAnswer(stdout) {
  const raw = String(stdout ?? '');
  const lines = raw.split(/\r?\n/);
  const out = [];
  const NOISE = /^\s*(?:\[[\d:.T-]+\]|tokens used|model:|workdir:|provider:|approval:|sandbox:|reasoning|codex\b|user\b|--------)/i;
  for (const line of lines) {
    if (NOISE.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}
