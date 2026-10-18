// ocr.js — צילום דוח אשראי/בנק מהטלפון (JPG/PNG) → שורות עסקה.
//
// תמונה של דוח היא בד"כ **טבלה** (עמודות: תאריך | תיאור פעולה | מספר זיהוי |
// הצגת כרטיס | סכום | ...), לא טקסט לינארי כמו PDF. OCR של טבלה לא מייצר טקסט
// רציף שמתאים ל-regex של PDF (parseStatementText) — הוא מפרק כל שורה למילים
// בודדות עם bounding box. לכן כאן מפרקים לפי מיקום פיזי (מילה→שורה→שדה), לא
// לפי טקסט שטוח: מבקשים מ-Tesseract פלט מובנה (blocks→paragraphs→lines→words),
// ולכל שורה מזהים תאריך/סכום לפי תבנית (regex, בלי תלות בסדר/כיוון), ומצרפים
// את שאר המילים (אחרי סינון מספר-זיהוי/"כן"/"לא"/רעש) לשם בית העסק.
//
// הערה: קריאת ה-OCR הראשונה מורידה את קובצי השפה (heb+eng) מהאינטרנט (חד-פעמי,
// נשמר מקומית לאחר מכן) — כמו pip install למנוע ה-ML. אין תלות רשת בהרצות הבאות.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createWorker } from 'tesseract.js';
import { Jimp } from 'jimp';
import { parseDate, parseAmount } from './importer.js';

let workerPromise = null;
function getWorker() {
  if (!workerPromise) workerPromise = createWorker('heb+eng');
  return workerPromise;
}

/** סוגר את ה-worker (בדיקות בלבד — מונע handle תלוי בסוף תהליך הבדיקות) */
export async function terminateOcrWorker() {
  if (!workerPromise) return;
  const worker = await workerPromise;
  workerPromise = null;
  await worker.terminate();
}

/** מחלץ טקסט גולמי מתמונה (JPG/PNG buffer) — לדיבוג/שימוש עתידי; parseImage
 *  לא משתמש בזה (הטקסט השטוח מאבד את מבנה העמודות של טבלה). */
export async function extractTextFromImage(buf) {
  const worker = await getWorker();
  const { data } = await worker.recognize(buf);
  return data.text;
}

/** מחיקת קווי טבלה מהתמונה לפני OCR. מסגרות תאים בדוח (הקווים האפורים סביב כל
 *  תא) הורסות את זיהוי Tesseract לחלוטין (הטקסט יוצא ג'יבריש — אומת אמפירית).
 *  הזיהוי: רצף כהה רציף ארוך בשורת פיקסלים (קו אופקי) או בעמודת פיקסלים (קו
 *  אנכי) — הרבה מעבר לאורך קו של אות — נמחק ללבן. ספים יחסיים לרזולוציה:
 *  אופקי ≥ 15% מרוחב התמונה, אנכי ≥ 8% מגובהה (אות ≈ 1-3% מקוטן התמונה).
 *  מגבלה: צילום עקום מפרק את הקו לרצפים קצרים שלא נתפסים — הצלמה ישרה עוזרת. */
// סף בהירות לזיהוי קו: מתחת = "כהה". גבוה במכוון (200) — אחרי דחיסת JPG,
// הקטנה ו-upscale קווי הטבלה נמרחים לאפור בהיר (~180-200) וסף נמוך מפספס
// אותם. בטוח לטקסט: רק רצפים באורך קו-טבלה נמחקים, אותיות קצרות בהרבה.
const DARK = 200;

export async function stripTableLines(buf) {
  const image = await Jimp.read(buf);
  image.greyscale();
  // upscale לתמונות קטנות: Tesseract צריך טקסט בגובה ~30px+; צילום/הורדה מהבנק
  // מגיע לא פעם ברזולוציה נמוכה (~700px) שבה חצי מהתאים יוצאים ג'יבריש —
  // אומת אמפירית מול debug של העלאה אמיתית. הגדלה bicubic עד צלע ארוכה ~1800px.
  const maxSide = Math.max(image.bitmap.width, image.bitmap.height);
  if (maxSide < 1800) {
    const scale = Math.min(3, 1800 / maxSide);
    image.resize({
      w: Math.round(image.bitmap.width * scale),
      h: Math.round(image.bitmap.height * scale),
    });
  }
  const { width, height, data } = image.bitmap; // RGBA
  const minHRun = Math.max(60, Math.floor(width * 0.15));
  const minVRun = Math.max(60, Math.floor(height * 0.08));
  const lum = (x, y) => data[(y * width + x) * 4]; // greyscale → R=G=B
  const whiten = (x, y) => {
    const i = (y * width + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 255;
  };

  // קווים אופקיים: רצפים כהים ארוכים בתוך שורת פיקסלים. removedPerY נאסף כדי
  // לזהות את קווי-הרוחב של הטבלה — הם מפרידי השורות המדויקים ביותר שיש
  // (משמשים את parseImage לשיוך תאים לשורות, כולל תא עם שם על שתי שורות).
  const removedPerY = new Array(height).fill(0);
  for (let y = 0; y < height; y++) {
    let runStart = -1;
    for (let x = 0; x <= width; x++) {
      const dark = x < width && lum(x, y) < DARK;
      if (dark && runStart === -1) runStart = x;
      if (!dark && runStart !== -1) {
        if (x - runStart >= minHRun) {
          for (let k = runStart; k < x; k++) whiten(k, y);
          removedPerY[y] += x - runStart;
        }
        runStart = -1;
      }
    }
  }
  // קווים אנכיים: רצפים כהים ארוכים בתוך עמודת פיקסלים
  for (let x = 0; x < width; x++) {
    let runStart = -1;
    for (let y = 0; y <= height; y++) {
      const dark = y < height && lum(x, y) < DARK;
      if (dark && runStart === -1) runStart = y;
      if (!dark && runStart !== -1) {
        if (y - runStart >= minVRun) for (let k = runStart; k < y; k++) whiten(x, k);
        runStart = -1;
      }
    }
  }

  // מפרידי שורות: y-ים שבהם נמחק קו החוצה לפחות 40% מהרוחב; y-ים צמודים
  // (עובי הקו) מתמזגים למפריד אחד (מרכז הקו).
  const separators = [];
  let segStart = -1;
  for (let y = 0; y <= height; y++) {
    const isLine = y < height && removedPerY[y] >= width * 0.4;
    if (isLine && segStart === -1) segStart = y;
    if (!isLine && segStart !== -1) {
      separators.push(Math.round((segStart + y - 1) / 2));
      segStart = -1;
    }
  }
  return { buffer: await image.getBuffer('image/png'), separators };
}

const BIDI_MARKS = /[‎‏​]/g; // סימוני כיווניות נסתרים ש-OCR משאיר (LRM/RLM/ZWSP)
const DATE_TOKEN = /^\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4}$/;
const AMOUNT_TOKEN = /^-?[\d,]+\.\d{2}$/; // סכום — תמיד עם 2 ספרות עשרוניות (מבדיל ממספר זיהוי עיסקה)
const COMMA_AMOUNT = /^-?\d{1,6},\d{2}$/; // OCR קורא לפעמים פסיק במקום הנקודה העשרונית
const PURE_DIGITS = /^\d+$/; // מספר זיהוי עיסקה, קוד בית-עסק וכו' — לא חלק משם בית העסק
const CARD_FLAG = /^(כן|לא|קן|לו)$/; // עמודת "הצגת כרטיס" (כולל misreads נפוצים של OCR)
const STRAY = /^[=|׀\-_.<>)(\]\[]+$/; // שברי קווי טבלה שה-OCR קרא כטקסט
const LATIN_NOISE = /^[a-zA-Z]{1,2}$/; // אות-שתיים לטיניות בודדות — רעש OCR, לא שם עסק
// מילות כותרת/כותרת-על/סיכום בדוח — שורות כאלה אינן עסקאות
const META_WORD = /^(סה"כ|סהכ|רכישה|בש"ח|תאריך|תיאור|פעולה|מספר|זיהוי|עיסקה|עסקה|הצגת|כרטיס|סכום|חיוב|מידע|נוסף|סך|יתרה)$/;

function cleanWord(raw) {
  let t = raw.replace(BIDI_MARKS, '').trim();
  // "37,00" (פסיק עשרוני מ-OCR) → "37.00"; לא נוגע באלפים כמו "2,168.21"
  if (COMMA_AMOUNT.test(t)) t = t.replace(',', '.');
  return t;
}

/** שורת טבלה אחת (מילים עם bbox) → עסקה, או null אם לא זוהה תאריך+סכום+בית-עסק.
 *  לא ממיינים לפי כיוון — מסתמכים על סדר המילים כפי שהוחזר מ-Tesseract (הוא כבר
 *  מבצע ניתוח כיווניות per-line; מיון גורף לפי x0 שובר שורות מעורבות עברית+אנגלית). */
function parseTableRow(words) {
  const tokens = words.map((w) => cleanWord(w.text)).filter(Boolean);
  let dateTok = null;
  let amountTok = null;
  const merchantParts = [];
  for (const t of tokens) {
    if (!dateTok && DATE_TOKEN.test(t)) { dateTok = t; continue; }
    if (!amountTok && AMOUNT_TOKEN.test(t)) { amountTok = t; continue; }
    // תאריך/סכום עודפים = שאריות שורה שכנה שמוזגה (מפריד שלא זוהה) — לא שם עסק
    if (DATE_TOKEN.test(t) || AMOUNT_TOKEN.test(t)) continue;
    if (CARD_FLAG.test(t) || PURE_DIGITS.test(t) || STRAY.test(t) || LATIN_NOISE.test(t)) continue;
    merchantParts.push(t);
  }
  if (!dateTok || !amountTok || !merchantParts.length) return null;

  const date = parseDate(dateTok);
  let amount = parseAmount(amountTok);
  let type = 'expense';
  if (amount !== null && amount < 0) { amount = -amount; type = 'income'; }
  const merchant = merchantParts.join(' ').trim();
  if (!date || !merchant || !amount) return null;
  return { date, merchant, amount, type };
}

/** האם קבוצת מילים היא שורת עסקה שנכשלה בפענוח — להבדיל מכותרת/כותרת-על/סה"כ?
 *  משמש רק לספירת "לא זוהו" בתצוגה המקדימה: המשתמש רוצה לראות כשלים אמיתיים
 *  של עסקאות, לא שורות מטא שמסוננות במכוון.
 *  שורת עסקה מזוהה לפי תאריך; אם התאריך נקרא שגוי — סכום ללא מילת מטא מספיק. */
function looksLikeTransactionRow(words) {
  const tokens = words.map((w) => cleanWord(w.text)).filter(Boolean);
  if (tokens.some((t) => DATE_TOKEN.test(t))) return true;
  const hasAmount = tokens.some((t) => AMOUNT_TOKEN.test(t));
  const hasMeta = tokens.some((t) => META_WORD.test(t));
  return hasAmount && !hasMeta;
}

// בתוך שורה: תאים מימין לשמאל (טבלה עברית; תאריך בעמודה הימנית) לפי הקצה הימני
// (x1). שני מקטעים באותו תא (שם על שתי שורות, כמו "MOJO ASIAN"/"FOODBAR") חולקים
// קצה ימני דומה — שובר השוויון הוא הגובה (העליון קודם), כדי שהשם ייצא בסדר נכון.
// סדר המילים בתוך כל מקטע נשמר כפי ש-Tesseract החזיר (כיווניות פנימית כבר טופלה).
function flattenRowSegments(segs) {
  return segs
    .sort((a, b) => (Math.abs(b.x1 - a.x1) > 15 ? b.x1 - a.x1 : a.y0 - b.y0))
    .flatMap((s) => s.words);
}

/** שיוך מקטעים לשורות טבלה לפי מפרידי הקווים האופקיים שנמחקו ב-stripTableLines.
 *  הקווים הם חלוקת השורות המדויקת של הטבלה עצמה — תא עם טקסט על שתי שורות
 *  נופל כולו בין אותם שני מפרידים ומתאחד נכון. */
function groupByBands(segments, separators) {
  const bands = new Map();
  for (const seg of segments) {
    const cy = (seg.y0 + seg.y1) / 2;
    let idx = 0;
    while (idx < separators.length && separators[idx] < cy) idx++;
    if (!bands.has(idx)) bands.set(idx, []);
    bands.get(idx).push(seg);
  }
  return [...bands.entries()].sort((a, b) => a[0] - b[0]).map(([, segs]) => flattenRowSegments(segs));
}

/** קיבוץ לפי חפיפה אנכית — fallback לתמונות בלי קווי טבלה (טקסט לינארי,
 *  טבלה בלי מסגרות): מקטעים שחולקים לפחות מחצית מגובהם מתאחדים לשורה. */
function clusterSegmentsIntoRows(segments) {
  const sorted = [...segments].sort((a, b) => a.y0 - b.y0);
  const clusters = [];
  for (const seg of sorted) {
    const last = clusters[clusters.length - 1];
    const overlap = last ? Math.min(last.y1, seg.y1) - Math.max(last.y0, seg.y0) : -1;
    const minH = last ? Math.min(last.y1 - last.y0, seg.y1 - seg.y0) : 0;
    if (last && overlap > 0.5 * minH) {
      last.segs.push(seg);
      last.y0 = Math.min(last.y0, seg.y0);
      last.y1 = Math.max(last.y1, seg.y1);
    } else {
      clusters.push({ segs: [seg], y0: seg.y0, y1: seg.y1 });
    }
  }
  return clusters.map((c) => flattenRowSegments(c.segs));
}

// תמונה → שורות עסקה, לפי מבנה טבלה (ראו הסבר למעלה). איכות ה-OCR תלויה
// בבהירות/יישור/רזולוציית הצילום — לכן, בדיוק כמו PDF/CSV, התוצאה עוברת דרך
// תצוגה מקדימה לפני שמירה (לא נשמר ישירות; ניתן לתקן שם בית עסק/קטגוריה).
export async function parseImage(buf) {
  const worker = await getWorker();
  // עיבוד מקדים: מחיקת קווי הטבלה — בלעדיו Tesseract מחזיר ג'יבריש על דוח עם
  // מסגרות תאים. אם העיבוד נכשל (פורמט לא נתמך וכו') ממשיכים עם המקור.
  const pre = await stripTableLines(buf).catch(() => ({ buffer: buf, separators: [] }));
  const { data } = await worker.recognize(pre.buffer, {}, { blocks: true });

  // מקטע = "שורת" Tesseract: תא בודד בטבלה עם מסגרות, או שורה שלמה בלעדיהן
  const segments = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        const words = line.words ?? [];
        if (words.length) {
          segments.push({ words, y0: line.bbox.y0, y1: line.bbox.y1, x0: line.bbox.x0, x1: line.bbox.x1 });
        }
      }
    }
  }
  if (!segments.length) {
    throw new Error('לא זוהה טקסט בתמונה — נסה צילום ברור וישר יותר, או קובץ PDF/CSV');
  }

  // שיוך לשורות: קווי הטבלה (אם זוהו מספיק) הם המפרידים המדויקים ביותר;
  // אחרת — קיבוץ לפי חפיפה אנכית.
  const rowGroups = pre.separators.length >= 3
    ? groupByBands(segments, pre.separators)
    : clusterSegmentsIntoRows(segments);

  const rows = [];
  let skipped = 0;
  for (const rowWords of rowGroups) {
    const row = parseTableRow(rowWords);
    if (row) rows.push(row);
    // רק שורות שנראות כעסקה נספרות כ"לא זוהו" — כותרת/סה"כ/רעש לא מבלבלים
    else if (looksLikeTransactionRow(rowWords)) skipped++;
  }

  // צילומי debug מכילים נתונים פיננסיים גולמיים. כתיבה רק בהפעלה מפורשת.
  if (process.env.MONEYSAVER_OCR_DEBUG === '1') try {
    const dir = process.env.MONEYSAVER_DATA_DIR || 'data';
    writeFileSync(path.join(dir, 'ocr-debug-last.json'), JSON.stringify({
      time: new Date().toISOString(),
      separators: pre.separators,
      groups: rowGroups.map((words) => words.map((w) => cleanWord(w.text))),
      rows, skipped,
    }, null, 2));
  } catch { /* noop */ }

  if (!rows.length) {
    throw new Error('הטקסט זוהה אך לא נמצאו שורות עסקה (תאריך + בית עסק + סכום) — נסה צילום ברור/ישר יותר, או ודא שהתמונה כוללת את טבלת העסקאות במלואה');
  }
  return { rows, skipped, format: 'jpg' };
}
