// docTrim.js — קיצוץ טקסט מנופח (boilerplate) ממסמכי הבנק לפני שהם נכנסים
// לפרומפט הניתוח. פונקציות טהורות, בלי DB ובלי רשת.
//
// למה זה קיים: דוחות לאומי מגיעים עם עמודי הסבר גנריים — שאלות ותשובות על
// פירעון מוקדם, נוסחת עמלת ההיוון, ציטוטי צו הבנקאות, וטבלת דוגמאות עם מספרים
// מומצאים. בדוח "פירוט יתרות ועמלות פירעון מוקדם" 7 מתוך 8 עמודים הם טקסט כזה,
// זהה לכל לקוח, ורק עמוד אחד מכיל את הנתונים בפועל. הפרומפט תפח ל-113K תווים,
// **Codex עבר את מגבלת 180 השניות ונפל ל-Gemini**, והנתונים האמיתיים נקברו בין
// פסקאות משפטיות. הקיצוץ נעשה **רק בדרך לפרומפט** — הטקסט המלא נשאר ב-DB
// וה-PDF המקורי תמיד זמין לצפייה.

// כותרות שמכריזות על עצמן כדף הסבר — גוברות גם על עוגני הנתונים, כי דף שמסביר
// מה משמעות כל שדה מזכיר בהכרח את שמות השדות ("יתרת קרן", "שיערוך קרן") בלי
// להכיל ולו מספר אחד אמיתי. שים לב לעיגון: "דף הסבר למצב חשבון" הוא ההסבר,
// ואילו "מצב חשבון מתומצת לשנת" (בלי "דף הסבר") הוא הדוח עצמו.
const STRONG_BOILERPLATE = [
  /דף\s+הסבר\s+למצב\s+חשבון/,
  /דף\s+הסבר\s*[-–]?\s*עמלות\s+פרעון\s+מוקדם/,
  /שאלות\s+ותשובות\s+בנושא/,
  /דוגמאות\s+לחישוב\s+שיעור\s+עמלת\s+פרעון\s+מוקדם/,
  /נספח\s+לדף\s+הסבר/,
];

// עוגני "זה עמוד גנרי" — כותרות של דפי ההסבר וציטוטי חקיקה
const BOILERPLATE = [
  /שאלות ותשובות בנושא/,
  /דף הסבר\s*[-–]?\s*עמלות פרעון מוקדם/,
  /דוגמאות לחישוב שיעור עמלת פרעון מוקדם/,
  /נספח לדף הסבר/,
  /צו הבנקאות/,
  /חוק הבנקאות/,
  /המפקח על הבנקים/,
  /הוראת שעה/,
  /להמחשה בלבד/,
  /Term SOFR|EURIBOR|יוריבור|ליבור/,
  /רשם המשכונות/,
  /אישור על הסרת השעבוד/,
];

// עוגני "יש כאן נתונים אמיתיים" — שדות שמופיעים רק בדוחות עם המספרים של הלקוח.
// עמוד שמכיל אחד מאלה נשמר תמיד, גם אם יש בו גם טקסט משפטי.
const DATA_MARKERS = [
  /מצב חשבון מתומצת/,
  /יתרת קרן/,
  /סכום מתן/,
  /תאריך מתן/,
  /גובה\s+החזר\s+חודשי/,
  /יתרה לסילוק/,
  /בסיס הצמדה/,
  /מדד בסיס/,
  /שיערוך קרן/,
  /ריבית כוללת חזויה/,
  /ריבית לצורכי השוואה/,
  /שיטת פירעון ההלוואה/,
  /תאריך סיום/,
  /סה"כ עמלות פירעון מוקדם/,
];

// מספר עוגני boilerplate שנדרשים כדי להכריז על עמוד כגנרי. שניים ומעלה —
// עוגן בודד עלול להופיע כהערת שוליים דווקא בעמוד נתונים.
const BOILERPLATE_MIN = 2;
// עמוד קצר מזה הוא שארית חילוץ (כתובת, תאריך בודד) ולא תוכן
const STUB_CHARS = 60;
// רשת ביטחון: אם הקיצוץ משאיר פחות מזה מהמקור, מחזירים את הטקסט המלא.
// עדיף פרומפט ארוך מפרומפט שאיבד נתונים.
const MIN_KEPT_RATIO = 0.02;

const PAGE_SPLIT = /^-- \d+ of \d+ --$/m;

const countHits = (text, patterns) => patterns.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);

/**
 * מחלק את הטקסט לעמודים לפי הסמנים ש-pdf-parse מוסיף. בלי סמנים — עמוד אחד.
 */
export function splitPages(text = '') {
  const parts = String(text).split(PAGE_SPLIT).map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts : [];
}

/**
 * האם העמוד הוא הסבר גנרי שאפשר לוותר עליו.
 * עמוד עם נתוני לקוח נשמר תמיד — הכלל הוא "דחה רק כשאין ספק" — למעט עמוד
 * שכותרתו מכריזה עליו כדף הסבר.
 */
export function isBoilerplatePage(page = '') {
  if (countHits(page, STRONG_BOILERPLATE) > 0) return true;
  // שארית עמוד: כתובת שמוסכה, תאריך משלוח בודד — אין בה מה לנתח
  if (page.replace(/\s+/g, ' ').trim().length < STUB_CHARS) return true;
  if (countHits(page, DATA_MARKERS) > 0) return false;
  return countHits(page, BOILERPLATE) >= BOILERPLATE_MIN;
}

/** מפתח השוואה לזיהוי עמודים כפולים — רווחים/טאבים מנורמלים */
const pageKey = (p) => p.replace(/\s+/g, ' ').trim();

/**
 * קיצוץ עמודי ההסבר הגנריים.
 * מחזיר { text, pagesKept, pagesTotal, removedChars } — המונים נכנסים ללוג
 * ולבדיקות, כדי שיהיה אפשר לראות כמה נחסך בלי לפתוח את הפרומפט.
 */
export function stripBoilerplate(text = '') {
  const src = String(text ?? '');
  const pages = splitPages(src);
  if (pages.length < 2) return { text: src, pagesKept: pages.length, pagesTotal: pages.length, removedChars: 0 };

  // סינון + הסרת כפילויות. בקובץ מאוחד של כמה דוחות שנתיים אותו עמוד הסבר
  // חוזר זהה בכל שנה — אין שום ערך בשליחתו למודל חמש פעמים.
  const seen = new Set();
  const kept = [];
  let duplicates = 0;
  for (const p of pages) {
    if (isBoilerplatePage(p)) continue;
    const key = pageKey(p);
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    kept.push(p);
  }
  const out = kept.join('\n\n');
  // כל העמודים נראים גנריים, או שנשאר שבריר זניח — כנראה מסמך בפורמט אחר.
  // מחזירים את המקור: פרומפט ארוך עדיף על נתונים חסרים.
  if (!kept.length || out.length < src.length * MIN_KEPT_RATIO) {
    return { text: src, pagesKept: pages.length, pagesTotal: pages.length, removedChars: 0 };
  }
  return {
    text: out,
    pagesKept: kept.length,
    pagesTotal: pages.length,
    duplicates,
    removedChars: src.length - out.length,
  };
}
