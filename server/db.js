// db.js — SQLite לוקאלי דרך node:sqlite (מובנה ב-Node, בלי תלות native)
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// MONEYSAVER_DATA_DIR — override לבדיקות: DB מבודד במקום נתוני האמת
const DATA_DIR = process.env.MONEYSAVER_DATA_DIR || path.join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'moneysaver.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS categories (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL DEFAULT '#8896a6',
    icon  TEXT NOT NULL DEFAULT '💳'
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT NOT NULL,                       -- ISO: YYYY-MM-DD
    amount      REAL NOT NULL CHECK (amount > 0),    -- תמיד חיובי; הכיוון לפי type
    type        TEXT NOT NULL DEFAULT 'expense' CHECK (type IN ('expense','income')),
    merchant    TEXT NOT NULL DEFAULT '',            -- בית עסק
    description TEXT NOT NULL DEFAULT '',
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    source      TEXT NOT NULL DEFAULT 'manual'       -- manual | csv | pdf | telegram | sms
                CHECK (source IN ('manual','csv','pdf','telegram','sms')),
    external_id TEXT,                                -- מזהה מקור לזיהוי כפילויות בייבוא
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_external
    ON transactions(source, external_id) WHERE external_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS income (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,                      -- למשל: משכורת
    amount       REAL NOT NULL CHECK (amount > 0),
    day_of_month INTEGER CHECK (day_of_month BETWEEN 1 AND 31),
    active       INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS monthly_flow (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    month             TEXT NOT NULL UNIQUE,          -- 'YYYY-MM'
    expected_income   REAL NOT NULL DEFAULT 0,
    expected_expenses REAL NOT NULL DEFAULT 0,       -- חיזוי (שלב 4)
    actual_income     REAL NOT NULL DEFAULT 0,
    actual_expenses   REAL NOT NULL DEFAULT 0,
    updated_at        TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS rules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern     TEXT NOT NULL,                       -- regex על שם בית העסק
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    priority    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,                    -- למשל: אינטרנט בזק
    amount        REAL,                             -- עלות (אינפורמטיבי)
    start_date    TEXT NOT NULL,                    -- YYYY-MM-DD
    end_date      TEXT NOT NULL,                    -- YYYY-MM-DD — מועד החידוש
    remind_days   INTEGER NOT NULL DEFAULT 14,      -- כמה ימים לפני הסיום להתריע
    last_reminded TEXT,                             -- YYYY-MM-DD של התזכורת האחרונה
    active        INTEGER NOT NULL DEFAULT 1
  );

  -- הוצאות קבועות שמתווספות אוטומטית כעסקאות (חוג שבועי, שכר דירה חודשי).
  -- המנוע: server/lib/recurring.js; ה-scheduler: server/index.js (שעתי + בעלייה).
  CREATE TABLE IF NOT EXISTS recurring_expenses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    merchant    TEXT NOT NULL,
    amount      REAL NOT NULL CHECK (amount > 0),
    freq        TEXT NOT NULL CHECK (freq IN ('weekly','monthly')),
    day         INTEGER NOT NULL,   -- weekly: 0-6 (0=ראשון, כמו DAY_NAMES בבוט); monthly: 1-31 (29-31 נדחקים ליום האחרון בחודש קצר)
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    last_added  TEXT,               -- תאריך המופע האחרון שנוסף
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  -- תלושי משכורת — תלוש אחד לחודש. ה-PDF נשמר כ-BLOB בתוך ה-DB כדי שהגיבוי
  -- היומי (VACUUM INTO) יכסה אותו אוטומטית. לעולם לא SELECT * מהטבלה הזו —
  -- תמיד עמודות מפורשות, כדי לא לגרור את ה-BLOB לרשימות.
  CREATE TABLE IF NOT EXISTS payslips (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    month          TEXT NOT NULL UNIQUE,               -- 'YYYY-MM'
    filename       TEXT NOT NULL DEFAULT '',
    pdf            BLOB NOT NULL,
    extracted_text TEXT NOT NULL DEFAULT '',           -- טקסט אחרי הסרת פרטים מזהים
    fields_json    TEXT NOT NULL DEFAULT '{}',         -- שדות שחולצו (ברוטו, נטו...)
    checks_json    TEXT NOT NULL DEFAULT '[]',         -- תוצאות בדיקות שפיות
    analysis_md    TEXT,                               -- ניתוח LLM (Markdown, עברית)
    analysis_at    TEXT,
    analysis_model TEXT,
    uploaded_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  -- משכנתא — רשומה אחת (singleton, id=1) המתארת את המצב הנוכחי, ניתנת לעריכה.
  -- לא היסטוריה חודשית כמו התלוש: משכנתא היא מצב מתמשך שמתעדכן.
  CREATE TABLE IF NOT EXISTS mortgage (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    data_json      TEXT NOT NULL DEFAULT '{}',         -- פרטים כלליים (הטופס)
    tracks_json    TEXT NOT NULL DEFAULT '[]',         -- מסלולים
    checks_json    TEXT NOT NULL DEFAULT '[]',         -- בדיקות מקומיות
    analysis_md    TEXT,                               -- ניתוח LLM (Markdown, עברית)
    analysis_at    TEXT,
    analysis_model TEXT,
    qa_json        TEXT NOT NULL DEFAULT '[]',         -- שאלות המשך (20 אחרונות)
    updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  -- מסמכי משכנתא (דוח יתרות, לוח סילוקין). כמו payslips: ה-PDF כ-BLOB כדי
  -- שהגיבוי היומי יכסה אותו, ולעולם לא SELECT * מהטבלה.
  -- צ'אט חופשי (server/lib/assistant.js) — היסטוריית שאלות ותשובות, משותפת
  -- ל-web ולבוט כדי שהשיחה תימשך בין המסכים. view = הטאב שממנו נשאלה השאלה
  -- (רק להצגה ולהקשר); הטבלה נגזמת ל-20 השורות האחרונות בכל שמירה.
  CREATE TABLE IF NOT EXISTS chat_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    view       TEXT NOT NULL DEFAULT 'general',
    question   TEXT NOT NULL,
    answer     TEXT NOT NULL,
    model      TEXT NOT NULL DEFAULT '',
    source     TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','bot')),
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS mortgage_docs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    kind           TEXT NOT NULL DEFAULT 'balance' CHECK (kind IN ('balance','schedule','other')),
    filename       TEXT NOT NULL DEFAULT '',
    pdf            BLOB NOT NULL,
    extracted_text TEXT NOT NULL DEFAULT '',           -- טקסט אחרי הסרת פרטים מזהים
    uploaded_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  -- היסטוריית תשלומי משכנתא לפי שנה, מדוח "מצב חשבון מתומצת" השנתי של הבנק.
  -- טבלת mortgage מחזיקה מצב נוכחי בלבד; כאן נשמרת המגמה לאורך השנים, שממנה
  -- רואים כמה קרן נפרעה בפועל מול כמה הצמדה נצברה במקביל.
  -- השנה היא המפתח — דוח אחד לשנה, וטעינה חוזרת מעדכנת את אותה שורה.
  CREATE TABLE IF NOT EXISTS mortgage_history (
    year               INTEGER PRIMARY KEY,
    paid_principal     REAL,                           -- קרן ששולמה במהלך השנה
    paid_cpi_principal REAL,                           -- הצמדת קרן ששולמה
    paid_interest      REAL,
    paid_cpi_interest  REAL,
    paid_other         REAL,                           -- הוצאות אחרות (לא בכל שנה)
    paid_total         REAL,
    bal_principal      REAL,                           -- יתרת קרן ל-31.12
    bal_cpi            REAL,                           -- הפרשי הצמדה שנצברו
    bal_accrued        REAL,                           -- ריבית שנצברה וטרם חויבה
    bal_total          REAL,
    updated_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
`);

// מיגרציה: שעה להוצאה קבועה — המופע של היום נוסף רק החל משעה זו (0–23).
// null = ברירת מחדל: נוסף בטיק הראשון של היום. מופעי עבר (catch-up) לא מחכים לשעה.
{
  const cols = db.prepare('PRAGMA table_info(recurring_expenses)').all().map((c) => c.name);
  if (!cols.includes('hour')) {
    db.exec('ALTER TABLE recurring_expenses ADD COLUMN hour INTEGER');
  }
}

// מיגרציה: עמודת קבוצת תשלומים (פיצול קנייה ל-N חיובים חודשיים)
{
  const cols = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
  if (!cols.includes('installment_group')) {
    db.exec('ALTER TABLE transactions ADD COLUMN installment_group TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_instgroup ON transactions(installment_group)');
  }
}

// מיגרציה: עמודת תאריך בהכנסות — במקום יום-בחודש הקבוע, הכנסה מסוימת (משכורת
// החודש, מתנה וכו') עם תאריך מלא. שורות ישנות בלי תאריך (NULL) ממשיכות
// להיספר בכל תקופה כברירת מחדל לאחור (ראו server/routes/flow.js).
{
  const cols = db.prepare('PRAGMA table_info(income)').all().map((c) => c.name);
  if (!cols.includes('date')) {
    db.exec('ALTER TABLE income ADD COLUMN date TEXT');
  }
}

// מיגרציה: עמודת תאריך חיוב — עסקה שנרכשה סמוך לסוף מחזור אבל מחויבת בפועל
// בדוח של המחזור הבא. כשמוגדרת, כל שיוך לתקופה (דשבורד/קטגוריות/רשימות) נעשה
// לפי COALESCE(charge_date, date) במקום date בלבד. NULL = ברירת מחדל (תאריך רכישה).
{
  const cols = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
  if (!cols.includes('charge_date')) {
    db.exec('ALTER TABLE transactions ADD COLUMN charge_date TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_effdate ON transactions(COALESCE(charge_date, date))');
  }
}

// מיגרציה: מספר התשלום שאליו שייך charge_date בתוכנית מיובאת בעלת שורה אחת.
// מספר התשלום המדווח מתקדם בכל ייבוא; ההעברה נשארת שייכת לתשלום שנבחר.
// משלימים מטא-נתונים פעם אחת בלבד, בלי לשנות תאריכים או סכומים קיימים.
{
  const cols = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
  if (!cols.includes('installment_charge_index')) {
    db.exec('ALTER TABLE transactions ADD COLUMN installment_charge_index INTEGER');
    const rows = db.prepare(`
      SELECT t.id, t.description FROM transactions t
      WHERE t.type = 'expense' AND t.source IN ('pdf', 'csv')
        AND t.charge_date IS NOT NULL AND t.installment_group IS NOT NULL
        AND (SELECT COUNT(*) FROM transactions p
             WHERE p.type = 'expense' AND p.installment_group = t.installment_group) = 1
    `).all();
    const pin = db.prepare('UPDATE transactions SET installment_charge_index = ? WHERE id = ?');
    for (const row of rows) {
      const match = row.description?.match(/^תשלום (\d+)\/(\d+)$/);
      if (!match) continue;
      const index = Number(match[1]);
      const total = Number(match[2]);
      if (Number.isSafeInteger(index) && Number.isSafeInteger(total)
        && total >= 2 && index >= 1 && index <= total) pin.run(index, row.id);
    }
  }
}

// מיגרציה: יום עוגן המחזור לאורך זמן. `settings.cycle_day` הוא ערך הבסיס
// (חל על כל חודש שקודם לשורה הראשונה כאן); כל שורה מציינת "מהחודש הזה ואילך
// היום הוא X". נועד לשינוי יום החיוב מכאן והלאה **בלי לחתוך מחדש חודשים
// היסטוריים** — הדשבורד של יוני חייב להישאר בדיוק כפי שהיה.
db.exec(`
  CREATE TABLE IF NOT EXISTS cycle_days (
    effective_month TEXT PRIMARY KEY,                 -- YYYY-MM
    day             INTEGER NOT NULL CHECK (day BETWEEN 1 AND 28),
    created_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
`);

// מיגרציה: עמודת מקור הוצאה קבועה — עסקה שנוספה אוטומטית ממנוע ה-recurring.
// ה-unique index מבטיח idempotency: אותו מופע (הגדרה+תאריך) לא נכנס פעמיים
// גם אם ה-scheduler רץ שוב (עלייה מחדש, catch-up וכו').
{
  const cols = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
  if (!cols.includes('recurring_id')) {
    db.exec('ALTER TABLE transactions ADD COLUMN recurring_id INTEGER');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_recurring_once ON transactions(recurring_id, date) WHERE recurring_id IS NOT NULL');
  }
}

// מיגרציה: הכנסות חוזרות — הכנסה שמסומנת recurring=1 מייצרת אוטומטית מופע חדש
// בכל חודש ביום שלה (משכורת, קצבה). המופעים הם שורות income רגילות עם
// recurring_parent_id, כך שניתן לערוך סכום של מחזור בודד בלי להשפיע על השאר.
// ה-unique index מבטיח idempotency בדיוק כמו במנוע ההוצאות הקבועות.
{
  const cols = db.prepare('PRAGMA table_info(income)').all().map((c) => c.name);
  if (!cols.includes('recurring')) {
    db.exec('ALTER TABLE income ADD COLUMN recurring INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE income ADD COLUMN recurring_parent_id INTEGER');
    db.exec('ALTER TABLE income ADD COLUMN last_added TEXT');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_income_recurring_once ON income(recurring_parent_id, date) WHERE recurring_parent_id IS NOT NULL');
  }
}

// מיגרציה: שאלות המשך על תלוש — היסטוריית שיחה חופשית מול המודל אחרי הניתוח.
// JSON array של { q, a, at, model }. נשמרת בשורת התלוש כדי שתישרד restart ותיכנס לגיבוי.
{
  const cols = db.prepare('PRAGMA table_info(payslips)').all().map((c) => c.name);
  if (cols.length && !cols.includes('qa_json')) {
    db.exec("ALTER TABLE payslips ADD COLUMN qa_json TEXT NOT NULL DEFAULT '[]'");
  }
}

// מיגרציה: זוגות עסקאות שהמשתמש סימן במפורש "לא כפילות". הדפוס האמיתי:
// שלוש כרטיסיות רכבת באותו יום, אותו סכום ואותו שם — לדוח האשראי יש מספר
// עסקה שונה לכל אחת, ולכן אלו שלושה חיובים אמיתיים. עד כה הדרך היחידה
// להוריד קבוצה כזו מהפאנל הייתה למחוק שורה או להעביר אותה למחזור הבא —
// שתיהן משבשות את הנתונים. כאן זו הכרעה מפורשת שנשמרת.
// המפתח הוא **זוג** ולא קבוצה: קבוצה של 3 שורות היא 3 זוגות, וכך שורה
// רביעית שתיכנס בעתיד עדיין תסומן מול הקיימות. a < b תמיד (סדר קנוני).
db.exec(`
  CREATE TABLE IF NOT EXISTS duplicate_ignores (
    a          INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    b          INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    PRIMARY KEY (a, b),
    CHECK (a < b)
  );
`);

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

// seed קטגוריות ברירת מחדל (רק אם הטבלה ריקה)
const { n } = db.prepare('SELECT COUNT(*) AS n FROM categories').get();
if (n === 0) {
  const insert = db.prepare('INSERT INTO categories (name, color, icon) VALUES (?, ?, ?)');
  const defaults = [
    ['סופר',          '#4caf7d', '🛒'],
    ['אוכל בחוץ',     '#ff9f43', '🍽️'],
    ['דלק ותחבורה',   '#5b8def', '⛽'],
    ['חשבונות',       '#9b6ff3', '🧾'],
    ['דיור',          '#38b2ac', '🏠'],
    ['בריאות',        '#ef6a8b', '💊'],
    ['ביגוד וקניות',  '#f3c04f', '🛍️'],
    ['בילויים',       '#e26fd0', '🎬'],
    ['חינוך',         '#6fc3e2', '📚'],
    ['אחר',           '#8896a6', '💳'],
  ];
  for (const row of defaults) insert.run(...row);
}
