// smsParser.js — חילוץ עסקה מהודעות SMS של בנקים וחברות אשראי ישראליות
// תבניות לפי שולח + תבנית גנרית. best-effort: מחזיר null אם אין התאמה בטוחה.
import { normalizeDayMonth } from './dates.js';

const AMOUNT = String.raw`(?<amount>[\d,]+(?:\.\d{1,2})?)`;
const DATE = String.raw`(?<date>\d{1,2}[\/.]\d{1,2}(?:[\/.]\d{2,4})?)`;

// תבניות ספציפיות (מכסות ניסוחים נפוצים של Isracard/Cal/Max/בנקים)
const TEMPLATES = [
  // ישראכרט (תאריך לפני הסכום): "אושרה עסקה ב-10/07 בסך 237.00 ש"ח בMOJO."
  // שם העסק צמוד ל-ב ונגמר בנקודה — עוצרים בנקודה/פסיק כדי לא לבלוע את הזנב.
  {
    name: 'isracard',
    re: new RegExp(String.raw`אושרה\s+עסק[הת]\s+ב[-:]?\s*${DATE}\s+בסך\s*${AMOUNT}\s*(?:ש"ח|שח|₪|ILS)\s+ב[-:]?\s*(?<merchant>[^.,\n]+)`, 's'),
  },
  // "אושרה עסקה בסך 89.90 ש"ח ב-קפה גרג בתאריך 05/07"
  {
    name: 'approved',
    re: new RegExp(String.raw`(?:אושרה|בוצעה)\s+עסק[הת].*?בסך\s*${AMOUNT}\s*(?:ש"ח|שח|₪|ILS).*?ב[-:]?\s*(?<merchant>.+?)(?:\s+בתאריך\s*${DATE}|\s*$)`, 's'),
  },
  // "חיוב בסך 250 ₪ בפז יהוד ב-04/07"
  {
    name: 'charge',
    re: new RegExp(String.raw`חיוב\s*(?:בסך)?\s*${AMOUNT}\s*(?:ש"ח|שח|₪).*?ב[-:]?\s*(?<merchant>.+?)(?:\s+ב[-:]?\s*${DATE}|\s*$)`, 's'),
  },
  // "בכרטיסך המסתיים ב-1234 בוצע חיוב של 432.50 ש"ח בשופרסל דיל"
  {
    name: 'card-suffix',
    re: new RegExp(String.raw`בכרטיס.*?(?:בוצעה?|נרשמה?)\s+(?:עסקה|חיוב)\s*(?:של|בסך)?\s*${AMOUNT}\s*(?:ש"ח|שח|₪).*?ב[-:]?\s*(?<merchant>.+?)(?:\s+בתאריך\s*${DATE}|\.|$)`, 's'),
  },
  // גנרי: סכום עם ₪/ש"ח + "ב-<בית עסק>"
  {
    name: 'generic',
    re: new RegExp(String.raw`${AMOUNT}\s*(?:ש"ח|שח|₪).*?ב[-:]\s*(?<merchant>[^,.\n]+)`, 's'),
  },
];

/** מנסה לחלץ עסקה מטקסט SMS. מחזיר {date, amount, merchant, template} או null */
export function parseSms(text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  for (const tpl of TEMPLATES) {
    const m = clean.match(tpl.re);
    if (!m?.groups) continue;
    const amount = Number(m.groups.amount.replace(/,/g, ''));
    const merchant = m.groups.merchant?.trim().replace(/[.,:;]+$/, '');
    if (!Number.isFinite(amount) || amount <= 0 || !merchant) continue;
    return {
      date: normalizeDayMonth(m.groups.date),
      amount,
      merchant,
      template: tpl.name,
    };
  }
  return null;
}

/** האם הטקסט נראה כמו SMS בנקאי (להבדיל מהודעה חופשית לבוט) */
export function looksLikeBankSms(text) {
  return /(?:אושרה|בוצעה?|חיוב|בכרטיס|כרטיסך|בסך)/.test(text) && /(?:ש"ח|שח|₪)/.test(text);
}
