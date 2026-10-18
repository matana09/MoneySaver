// backup.js — גיבוי יומי של ה-DB (snapshot עקבי דרך VACUUM INTO) + רוטציה.
// דטרמיניסטי לחלוטין — רץ מ-scheduled task, בלי AI. נתיבים אבסולוטיים (לא תלוי cwd).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { localDate } from '../server/lib/dates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
// עקבי עם server/db.js — env override אחיד לכל צרכני ה-DB
const DATA_DIR = process.env.MONEYSAVER_DATA_DIR || path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'moneysaver.db');
const BACKUP_DIR = path.join(ROOT, 'backups');
const KEEP = 14; // שבועיים של גיבויים יומיים

if (!existsSync(DB_PATH)) {
  console.log('אין DB לגבות עדיין.');
  process.exit(0);
}
mkdirSync(BACKUP_DIR, { recursive: true });

const stamp = localDate(); // YYYY-MM-DD מקומי — לא UTC (באג חצות)
const target = path.join(BACKUP_DIR, `moneysaver-${stamp}.db`);

// VACUUM INTO דורש שהיעד לא יהיה קיים — גיבוי חוזר באותו יום מחליף את הקודם
if (existsSync(target)) unlinkSync(target);

const db = new DatabaseSync(DB_PATH, { readOnly: true });
try {
  // snapshot עקבי גם כשהשרת כותב במקביל (WAL)
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  console.log(`גיבוי נשמר: ${target}`);
} finally {
  db.close();
}

// רוטציה — משאירים את KEEP החדשים
const backups = readdirSync(BACKUP_DIR)
  .filter((f) => /^moneysaver-\d{4}-\d{2}-\d{2}\.db$/.test(f))
  .map((f) => ({ f, mtime: statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

for (const old of backups.slice(KEEP)) {
  unlinkSync(path.join(BACKUP_DIR, old.f));
  console.log(`נמחק גיבוי ישן: ${old.f}`);
}
console.log(`סה"כ גיבויים: ${Math.min(backups.length, KEEP)}`);
