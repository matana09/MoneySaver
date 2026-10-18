// textExpense.js — פירוש הודעה חופשית לבוט:
// "קפה גרג 25" / "25 דלק" / "הכנסה 500 בונוס" / "קפה גרג 25 03/07" (תאריך אופציונלי)
// "מחשב 3600 ב-12 תשלומים" — פיצול לתשלומים חודשיים
import { localDate, normalizeDayMonth } from './dates.js';

const DATE_RE = /(?:^|\s)(\d{1,2}[\/.]\d{1,2}(?:[\/.]\d{2,4})?)(?:\s|$)/;
const INSTALLMENTS_RE = /\s*ב?-?\s*(\d{1,2})\s*תשלומים\s*/;
const AMOUNT_RE = /(?<amount>\d+(?:\.\d{1,2})?)\s*(?:ש"ח|שח|₪)?/;

export function parseTextExpense(text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;

  const isIncome = /^הכנסה\s+/.test(clean);
  let body = isIncome ? clean.replace(/^הכנסה\s+/, '') : clean;

  // תשלומים — מחולץ ראשון, אחרת הסכום עלול לתפוס את ה"12" מ"12 תשלומים"
  let installments = null;
  const im = body.match(INSTALLMENTS_RE);
  if (im) {
    installments = Number(im[1]);
    body = body.replace(im[0], ' ').replace(/\s+/g, ' ').trim();
  }

  // תאריך אופציונלי — מחולץ לפני הסכום, אחרת הסכום עלול לתפוס את ה"05" מ"05/07"
  let date = localDate();
  const dm = body.match(DATE_RE);
  if (dm) {
    date = normalizeDayMonth(dm[1]);
    body = body.replace(dm[1], ' ').replace(/\s+/g, ' ').trim();
  }

  const m = body.match(AMOUNT_RE);
  if (!m?.groups?.amount) return null;
  const amount = Number(m.groups.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  // בית העסק: כל מה שמסביב לסכום
  const merchant = body.replace(m[0], ' ').replace(/\s+/g, ' ').trim();

  return {
    date,
    amount,
    merchant: merchant || (isIncome ? 'הכנסה' : 'הוצאה'),
    type: isIncome ? 'income' : 'expense',
    installments: isIncome ? null : installments,
  };
}
