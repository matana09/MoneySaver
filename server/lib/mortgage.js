// mortgage.js — משכנתא: נרמול קלט, הסרת פרטים מזהים, בדיקות מקומיות, בניית פרומפט.
// כל הפונקציות טהורות (למעט אלה שבסוף הקובץ, שנוגעות ב-DB) — כדי שיהיו ניתנות
// לבדיקה בלי שרת, בדיוק כמו server/lib/payslip.js.
import { db } from '../db.js';
import { parseAmount } from './importer.js';
import { stripPii } from './payslip.js';
import { mortgageHistory, historySummary } from './mortgageHistory.js';
import { stripBoilerplate } from './docTrim.js';
import {
  marketRatesSummary, effectivePrime, estimatePropertyValue,
  MARKET_KEY_BY_TRACK, HOUSING_REGION_KEYS,
} from './marketRates.js';

/* ---------- סוגי מסלולים ---------- */
export const TRACK_TYPE_HE = {
  prime:              'פריים',
  fixed_unlinked:     'קבועה לא צמודה',
  fixed_linked:       'קבועה צמודה',
  variable_linked:    'משתנה צמודה',
  variable_unlinked:  'משתנה לא צמודה',
  other:              'אחר',
};
export const TRACK_TYPES = Object.keys(TRACK_TYPE_HE);

// מסלולים שבהם הריבית קבועה לכל התקופה (לחישוב מגבלת השליש של בנק ישראל)
const FIXED_TYPES = new Set(['fixed_unlinked', 'fixed_linked']);
// מסלולים שהקרן בהם צמודה למדד גם בלי סימון מפורש של המשתמש
const LINKED_TYPES = new Set(['fixed_linked', 'variable_linked']);

export const RISK_LEVELS = { low: 'נמוכה', med: 'בינונית', high: 'גבוהה' };

export const MAX_TRACKS = 15;
export const MAX_DOCS = 5;
const MAX_TEXT = 2000;

/* ---------- נרמול קלט ---------- */
// כל שדה מספרי עובר דרך parseAmount (מסיר ₪ ופסיקי אלפים) ונדחה אם אינו סופי
// או שלילי. שדה ריק/חסר לא נשמר בכלל — כך "אין נתון" נבדל מ-0.
function num(v) {
  if (v === null || v === undefined || v === '') return undefined;
  const n = parseAmount(v);
  if (n === null || !Number.isFinite(n) || n < 0) return undefined;
  return n;
}

function text(v, max = MAX_TEXT) {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s ? s.slice(0, max) : undefined;
}

// שדות הטופס הכללי: מספריים, טקסטואליים ורמת סיכון
const DATA_NUM = [
  'balance_total', 'property_value', 'property_value_base', 'remaining_months', 'monthly_payment',
  'net_income', 'other_obligations', 'extra_monthly', 'lump_sum', 'prime_rate',
];
const DATA_TEXT = [
  'origination_date', 'borrower_ages', 'expected_changes', 'market_rates', 'notes',
  'property_value_base_month', 'property_value_source',
];

/** נרמול הפרטים הכלליים — whitelist מלא, בלי מפתחות זרים */
export function normalizeMortgageData(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const k of DATA_NUM) {
    const v = num(src[k]);
    if (v !== undefined) out[k] = v;
  }
  const SHORT_TEXT = new Set(['origination_date', 'property_value_base_month']);
  for (const k of DATA_TEXT) {
    const v = text(src[k], SHORT_TEXT.has(k) ? 20 : MAX_TEXT);
    if (v !== undefined) out[k] = v;
  }
  if (RISK_LEVELS[src.risk_level]) out.risk_level = src.risk_level;
  // מחוז לצורך הצמדת שווי הנכס למדד מחירי הדירות של הלמ"ס
  if (HOUSING_REGION_KEYS.includes(src.property_region)) out.property_region = src.property_region;
  return out;
}

const TRACK_NUM = [
  'balance', 'rate', 'prime_margin', 'remaining_months',
  'monthly_payment', 'prepay_fee', 'payoff_amount',
];

/** נרמול מערך המסלולים — עד MAX_TRACKS, כל מסלול whitelist */
export function normalizeTracks(input = []) {
  const arr = Array.isArray(input) ? input.slice(0, MAX_TRACKS) : [];
  return arr.map((raw, i) => {
    const src = raw && typeof raw === 'object' ? raw : {};
    const t = {
      name: text(src.name, 60) ?? `מסלול ${i + 1}`,
      type: TRACK_TYPES.includes(src.type) ? src.type : 'other',
      cpi_linked: src.cpi_linked ? 1 : 0,
    };
    // מרווח פריים יכול להיות שלילי (P-0.5%) — לכן לא עובר דרך num()
    if (src.prime_margin !== undefined && src.prime_margin !== null && src.prime_margin !== '') {
      const m = parseAmount(src.prime_margin);
      if (m !== null && Number.isFinite(m)) t.prime_margin = m;
    }
    for (const k of TRACK_NUM) {
      if (k === 'prime_margin') continue;
      const v = num(src[k]);
      if (v !== undefined) t[k] = v;
    }
    const reset = text(src.reset_date, 20);
    if (reset) t.reset_date = reset;
    // מסלול מסוג צמוד — מסמנים גם אם המשתמש לא סימן את ה-checkbox
    if (LINKED_TYPES.has(t.type)) t.cpi_linked = 1;
    return t;
  });
}

/* ---------- הסרת פרטים מזהים ---------- */
// שכבה נוספת מעל stripPii של התלוש (ת"ז, חשבון בנק, כתובת, טלפון), לפרטים
// שמופיעים דווקא במסמכי משכנתא. חשוב: ההסרה בקוד, לא בהוראה ל-LLM.
const MORTGAGE_PII_RULES = [
  // מספר חשבון ההלוואה בפורמט הבנקאי. מופיע בדוחות לאומי
  // בשורה נפרדת בלי שום מילת הקשר, ולכן חייב להיות anyLine ולא תלוי-שורה.
  // דורש שלושה מקפים לפחות — כך תאריכים (2026-07-30) וטלפונים (054-1234567)
  // לא נפגעים.
  { anyLine: true, digits: /\b\d{2,3}-\d{5,9}-\d{2,3}-\d{2,3}\b/g, mask: '[מספר חשבון הוסר]' },
  // זיהוי הנכס — שורה שלמה מוסרת (גוש/חלקה מזהים כתובת באופן חד-חד-ערכי)
  { line: /גוש|חלקה|תת ?חלקה|כתובת הנכס|הנכס הממושכן|נסח טאבו/, replace: '[פרטי הנכס הוסרו]' },
  // שם רחוב מסוג "שדרות/שדרת/שד'" — stripPii של התלוש מכסה רק רחוב/רח'.
  // הסרה עודפת עדיפה כאן על דליפת כתובת.
  { line: /שדרות |שדרת |שד['׳] /, replace: '[כתובת הוסרה]' },
  // מספרי הלוואה/עסקה/משכנתא — מיסוך רצפי ספרות ארוכים בשורות הרלוונטיות
  { line: /הלוואה|הלואה|עסקה|משכנתא|מס['׳"]? ?הלוואה|מספר הלוואה/, digits: /\b\d{5,}\b/g, mask: '[מספר הוסר]' },
  // שמות לווים
  { line: /שם הלווה|הלווים|לווה ראשי|ע["׳']ש/, replace: '[שם הלווה הוסר]' },
];

/**
 * הסרת פרטים מזהים מטקסט מסמך משכנתא. מריץ קודם את stripPii של התלוש
 * (משותף — ת"ז, בנק, כתובת, טלפון) ואחריו את הכללים הייחודיים למשכנתא.
 * סכומים לא נפגעים. מחזיר { text, removed }.
 */
export function stripMortgagePii(input) {
  const base = stripPii(input);
  let removed = base.removed;
  const out = base.text.split('\n').map((line) => {
    let cur = line;
    for (const rule of MORTGAGE_PII_RULES) {
      if (!rule.anyLine && !rule.line.test(cur)) continue;
      if (rule.replace) { removed++; return rule.replace; }
      cur = cur.replace(rule.digits, (m) => {
        if (/[.,]\d/.test(m)) return m;   // חלק מסכום — לא נוגעים
        removed++;
        return rule.mask;
      });
    }
    return cur;
  }).join('\n');
  return { text: out, removed };
}

/* ---------- בדיקות מקומיות ---------- */
const has = (v) => typeof v === 'number' && Number.isFinite(v);
const fmt = (n) => new Intl.NumberFormat('he-IL', { maximumFractionDigits: 2 }).format(n);
const pctFmt = (n) => `${n.toFixed(1)}%`;

// ספי הרגולציה של בנק ישראל על תמהיל המשכנתא
const PRIME_MAX_SHARE = 66.7;   // עד שני שלישים פריים
const FIXED_MIN_SHARE = 33.3;   // לפחות שליש בריבית קבועה

/** סכום שדה מסוים על פני כל המסלולים שיש בהם את השדה (או null אם באף אחד אין) */
function sumTracks(tracks, key) {
  const vals = tracks.filter((t) => has(t[key])).map((t) => t[key]);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
}

/** סטטוס לפי פער באחוזים בין שני סכומים */
function diffStatus(diffPct) {
  return diffPct <= 1 ? 'ok' : diffPct <= 5 ? 'warn' : 'fail';
}

/**
 * בדיקות דטרמיניסטיות על נתוני המשכנתא — בלי LLM.
 * כל בדיקה: { id, label, status: 'ok'|'warn'|'fail', detail }.
 * בדיקה שחסרים לה נתונים לא מוחזרת (לא מדווחים כשל על מידע חסר).
 * market = נתוני בנק ישראל שנשלפו אוטומטית (server/lib/marketRates.js), אופציונלי.
 */
export function runMortgageChecks(data = {}, tracks = [], market = null) {
  const checks = [];
  const d = data || {};
  const ts = Array.isArray(tracks) ? tracks : [];

  // 1) יחס החזר להכנסה — ההחזר החודשי + התחייבויות נוספות מול ההכנסה נטו
  if (has(d.monthly_payment) && has(d.net_income) && d.net_income > 0) {
    const load = d.monthly_payment + (has(d.other_obligations) ? d.other_obligations : 0);
    const ratio = (load / d.net_income) * 100;
    checks.push({
      id: 'dti',
      label: 'יחס ההחזר להכנסה נטו',
      status: ratio < 30 ? 'ok' : ratio <= 40 ? 'warn' : 'fail',
      detail: `${pctFmt(ratio)} מההכנסה (${fmt(load)} ₪ מתוך ${fmt(d.net_income)} ₪)`
        + ` — הבנקים מגבילים ל-40%, והמומלץ עד 30%`,
    });
  }

  // 2) סכום יתרות המסלולים מול היתרה הכוללת
  const balSum = sumTracks(ts, 'balance');
  if (has(d.balance_total) && d.balance_total > 0 && balSum !== null) {
    const diff = Math.abs(balSum - d.balance_total);
    const diffPct = (diff / d.balance_total) * 100;
    checks.push({
      id: 'tracks_balance_sum',
      label: 'סכום יתרות המסלולים מול היתרה הכוללת',
      status: diffStatus(diffPct),
      detail: diffPct <= 1
        ? `מסתדר (${fmt(balSum)} ₪)`
        : `פער של ${fmt(diff)} ₪ (מסלולים: ${fmt(balSum)} ₪ · הוצהר: ${fmt(d.balance_total)} ₪) — ייתכן שמסלול חסר`,
    });
  }

  // 3) סכום ההחזרים במסלולים מול ההחזר החודשי
  const paySum = sumTracks(ts, 'monthly_payment');
  if (has(d.monthly_payment) && d.monthly_payment > 0 && paySum !== null) {
    const diff = Math.abs(paySum - d.monthly_payment);
    const diffPct = (diff / d.monthly_payment) * 100;
    checks.push({
      id: 'tracks_payment_sum',
      label: 'סכום ההחזרים במסלולים מול ההחזר החודשי',
      status: diffStatus(diffPct),
      detail: diffPct <= 1
        ? `מסתדר (${fmt(paySum)} ₪)`
        : `פער של ${fmt(diff)} ₪ (מסלולים: ${fmt(paySum)} ₪ · הוצהר: ${fmt(d.monthly_payment)} ₪)`,
    });
  }

  // 4) LTV — יתרת המשכנתא מול שווי הנכס. השווי מגיע מהזנה ידנית או מעוגן
  // מוצמד למדד מחירי הדירות של הלמ"ס (מתעדכן לבד — ראו estimatePropertyValue).
  const propValue = estimatePropertyValue(d, market);
  if (has(d.balance_total) && has(propValue.value) && propValue.value > 0) {
    const ltv = (d.balance_total / propValue.value) * 100;
    checks.push({
      id: 'ltv',
      label: 'יחס מימון (LTV)',
      status: ltv < 60 ? 'ok' : ltv <= 75 ? 'warn' : 'fail',
      detail: `${pctFmt(ltv)} משווי הנכס (${fmt(propValue.value)} ₪ — ${propValue.detail})`
        + ` — LTV נמוך מ-60% משפר את הריבית בהצעות מיחזור (התקרה לדירה יחידה: 75%)`,
    });
  }
  if (propValue.source === 'index') {
    checks.push({
      id: 'property_value',
      label: 'שווי הנכס',
      status: 'ok',
      detail: `${fmt(propValue.value)} ₪ — ${propValue.detail}. הערכה בלבד; שמאות רשמית תיתן מספר מדויק.`,
    });
  } else if (propValue.value === null) {
    checks.push({
      id: 'no_property_value',
      label: 'שווי הנכס לא הוזן',
      status: 'warn',
      detail: 'בלי שווי נכס אי אפשר לחשב LTV — והוא קובע את מדרגת הריבית בהצעות מיחזור',
    });
  }

  // 5) תמהיל — חלק הפריים וחלק הקבועה מסך היתרות
  if (balSum !== null && balSum > 0) {
    const share = (pred) => (sumTracks(ts.filter(pred), 'balance') ?? 0) / balSum * 100;
    const prime = share((t) => t.type === 'prime');
    const fixed = share((t) => FIXED_TYPES.has(t.type));
    const linked = share((t) => t.cpi_linked === 1);

    checks.push({
      id: 'prime_share',
      label: 'חלק הפריים בתמהיל',
      status: prime > PRIME_MAX_SHARE ? 'warn' : 'ok',
      detail: `${pctFmt(prime)} — מגבלת בנק ישראל: עד שני שלישים (66.7%)`,
    });
    checks.push({
      id: 'fixed_share',
      label: 'חלק הריבית הקבועה בתמהיל',
      status: fixed < FIXED_MIN_SHARE ? 'warn' : 'ok',
      detail: `${pctFmt(fixed)} — מגבלת בנק ישראל: לפחות שליש (33.3%) בריבית קבועה`,
    });
    checks.push({
      id: 'cpi_share',
      label: 'חלק צמוד המדד',
      status: linked > 50 ? 'warn' : 'ok',
      detail: `${pctFmt(linked)} מהיתרה צמוד למדד — חשיפה לעליית הקרן באינפלציה`,
    });
  }

  // 6) מסלולים שחסרים בהם נתוני יסוד — בלעדיהם הניתוח חלקי
  if (ts.length) {
    const incomplete = ts.filter((t) => !has(t.balance) || !has(t.rate) || !has(t.remaining_months));
    if (incomplete.length) {
      checks.push({
        id: 'track_missing_data',
        label: 'נתונים חסרים במסלולים',
        status: 'warn',
        detail: `חסרים יתרה/ריבית/תקופה ב: ${incomplete.map((t) => t.name).join(', ')}`
          + ' — השלם אותם מדוח היתרות של הבנק כדי לקבל ניתוח מדויק',
      });
    }
  } else {
    checks.push({
      id: 'no_tracks',
      label: 'לא הוזנו מסלולים',
      status: 'warn',
      detail: 'בלי פירוט המסלולים אי אפשר לנתח את התמהיל או לחשב כדאיות מיחזור',
    });
  }

  // 7) ריבית הפריים — נתון שוק שהמודל לא יכול לדעת. נשלף אוטומטית מבנק ישראל,
  // וידני גובר עליו.
  const prime = effectivePrime(d, market);
  if (prime.value === null) {
    checks.push({
      id: 'no_prime_rate',
      label: 'ריבית הפריים לא זמינה',
      status: 'warn',
      detail: 'שליפת ריבית בנק ישראל נכשלה ולא הוזנה ריבית ידנית — בלעדיה לא ניתן לחשב את הריבית בפועל במסלולי הפריים',
    });
  } else {
    checks.push({
      id: 'prime_rate',
      label: 'ריבית הפריים',
      status: 'ok',
      detail: prime.source === 'user'
        ? `${prime.value}% (הוזנה ידנית)`
        : `${prime.value}% — נשלף אוטומטית מבנק ישראל (ריבית בנק ישראל ${market.boi.rate}% + 1.5%)`,
    });
  }

  // 8) השוואת ריבית המסלולים הקבועים לריבית הממוצעת בשוק על הלוואות דיור חדשות.
  // רק מסלולים בריבית קבועה — במשתנה/פריים הריבית מורכבת מעוגן + מרווח.
  const avg = new Map((market?.averages ?? []).map((a) => [a.key, a]));
  for (const t of ts) {
    const marketKey = MARKET_KEY_BY_TRACK[t.type];
    const ref = marketKey ? avg.get(marketKey) : null;
    // ref.stale — סדרה שבנק ישראל הפסיק לעדכן; השוואה אליה תטעה
    if (!ref || ref.stale || !has(t.rate)) continue;
    const gap = t.rate - ref.value;
    const verdict = gap > 0.5 ? `יקר ב-${gap.toFixed(2)} נקודות אחוז — כדאי לבדוק מיחזור`
      : gap > 0.05 ? `יקר ב-${gap.toFixed(2)} נקודות אחוז — פער קטן, הכדאיות תלויה בעמלת ההיוון ובתקופה שנותרה`
        : gap < -0.05 ? `זול ב-${Math.abs(gap).toFixed(2)} נקודות אחוז מהשוק — אין יתרון במיחזור המסלול הזה`
          : 'בדיוק בממוצע השוק';
    checks.push({
      id: `track_vs_market_${ts.indexOf(t)}`,
      label: `ריבית "${t.name}" מול השוק`,
      status: gap > 0.5 ? 'warn' : 'ok',
      detail: `${t.rate}% מול ממוצע של ${ref.value}% בהלוואות דיור חדשות (${ref.label}${ref.period ? `, ${ref.period}` : ''})`
        + ` — ${verdict}`,
    });
  }

  return checks;
}

/* ---------- פרומפט ---------- */
// שווי הנכס לא נמצא כאן — הוא מחושב (הזנה ידנית או עוגן מוצמד למדד) ומוצג
// בנפרד בראש dataSummary.
const DATA_NAMES_HE = {
  balance_total: 'יתרת המשכנתא',
  origination_date: 'תאריך לקיחת המשכנתא', remaining_months: 'חודשים שנותרו',
  monthly_payment: 'ההחזר החודשי הנוכחי', net_income: 'הכנסה משפחתית נטו לחודש',
  other_obligations: 'הוצאות קבועות והתחייבויות נוספות',
  extra_monthly: 'סכום פנוי להוספה להחזר החודשי',
  lump_sum: 'סכום זמין לפירעון מוקדם', prime_rate: 'ריבית הפריים הנוכחית (%)',
  borrower_ages: 'גיל הלווים', expected_changes: 'שינויים צפויים בהכנסה/הוצאות',
  market_rates: 'הצעות ריבית שהמשתמש קיבל מבנקים', notes: 'הערות נוספות',
};
// שדות שמוצגים כאחוז ולא כסכום בשקלים
const PCT_FIELDS = new Set(['prime_rate']);
const PLAIN_FIELDS = new Set(['remaining_months', 'origination_date', 'borrower_ages', 'expected_changes', 'market_rates', 'notes']);

function dataValue(key, v) {
  if (typeof v !== 'number') return String(v);
  if (PCT_FIELDS.has(key)) return `${v}%`;
  if (key === 'remaining_months') return `${v} חודשים (${(v / 12).toFixed(1)} שנים)`;
  return `${fmt(v)} ₪`;
}

// שדות טקסט חופשי — המשתמש עלול להקליד בהם כתובת או שם. הם עוברים
// stripMortgagePii לפני שהם נכנסים לפרומפט, בדיוק כמו טקסט המסמכים.
const FREE_TEXT_FIELDS = ['expected_changes', 'market_rates', 'notes', 'property_value_source', 'borrower_ages'];

/** עותק של הנתונים שבו שדות הטקסט החופשי נוקו מפרטים מזהים */
export function scrubData(data = {}) {
  const out = { ...data };
  for (const k of FREE_TEXT_FIELDS) {
    if (typeof out[k] === 'string' && out[k]) out[k] = stripMortgagePii(out[k]).text;
  }
  return out;
}

/** טבלת הפרטים הכלליים לפרומפט (רק שדות שהוזנו) */
export function dataSummary(rawData = {}, market = null) {
  const data = scrubData(rawData);
  const rows = [];
  const prop = estimatePropertyValue(data, market);
  if (prop.value !== null) {
    rows.push(`- שווי הנכס המשוער: ${fmt(prop.value)} ₪ (${prop.detail}${
      data.property_value_source ? `; מקור העוגן: ${data.property_value_source}` : ''})`);
  }
  for (const [k, he] of Object.entries(DATA_NAMES_HE)) {
    const v = data[k];
    if (v === undefined || v === null || v === '') continue;
    rows.push(`- ${he}: ${dataValue(k, v)}`);
  }
  if (data.risk_level) rows.push(`- רמת הסיכון הרצויה: ${RISK_LEVELS[data.risk_level]}`);
  // שדות שלא הוזנו — מפורטים במפורש כדי שהמודל לא ינחש אותם
  const missing = Object.entries(DATA_NAMES_HE)
    .filter(([k]) => data[k] === undefined || data[k] === null || data[k] === '')
    .map(([, he]) => he);
  if (!data.risk_level) missing.push('רמת הסיכון הרצויה');
  if (prop.value === null) missing.push('שווי הנכס');
  const out = rows.length ? rows.join('\n') : '(לא הוזנו פרטים כלליים)';
  return missing.length ? `${out}\n\nנתונים שלא הוזנו: ${missing.join(', ')}.` : out;
}

/** טבלת המסלולים לפרומפט */
export function tracksSummary(tracks = []) {
  if (!tracks.length) return '(לא הוזנו מסלולים)';
  const cell = (v, suffix = '') => (v === undefined || v === null ? '—' : `${fmt(v)}${suffix}`);
  const head = '| מסלול | סוג | יתרת קרן | ריבית | מרווח פריים | צמוד מדד | שינוי ריבית הבא | חודשים נותרו | החזר חודשי | עמלת פירעון | יתרת סילוק |';
  const sep  = '|---|---|---|---|---|---|---|---|---|---|---|';
  const rows = tracks.map((t) => [
    t.name,
    TRACK_TYPE_HE[t.type] ?? t.type,
    cell(t.balance, ' ₪'),
    cell(t.rate, '%'),
    t.prime_margin === undefined ? '—' : `${t.prime_margin > 0 ? '+' : ''}${t.prime_margin}%`,
    t.cpi_linked ? 'כן' : 'לא',
    t.reset_date || '—',
    cell(t.remaining_months),
    cell(t.monthly_payment, ' ₪'),
    cell(t.prepay_fee, ' ₪'),
    cell(t.payoff_amount, ' ₪'),
  ].join(' | '));
  return [head, sep, ...rows.map((r) => `| ${r} |`)].join('\n');
}

/** תוצאות הבדיקות המקומיות לפרומפט */
export function checksSummary(checks = []) {
  if (!checks.length) return '(לא בוצעו בדיקות — חסרים נתונים)';
  const icon = { ok: '✅', warn: '🟡', fail: '🔴' };
  return checks.map((c) => `- ${icon[c.status] ?? ''} ${c.label}: ${c.detail}`).join('\n');
}

// כללי עיצוב הפלט — זהים לאלה של התלוש (server/lib/payslip.js), כי אותו רינדור
// ב-web מציג את שתי התשובות (renderMarkdown + stripLatex).
const OUTPUT_RULES = `## כללי עיצוב הפלט (חובה)
- **אסור להשתמש בסימון LaTeX או מתמטי כלשהו**: בלי \\text, \\mathbf, \\frac, \\times, \\approx, ובלי סימני $ או \\( \\). כתוב נוסחאות כטקסט רגיל: "1,250,000 × 4.5% ÷ 12 = 4,687.50 ש"ח".
- סכומים בפורמט ישראלי עם פסיק אלפים וסימן ש"ח: 1,250,000.00 ש"ח. ריביות באחוזים עם שתי ספרות: 4.35%.
- השתמש בטבלאות Markdown להשוואות, לפירוט מסלולים ולחלופות — הן מוצגות יפה בממשק.
- הדגש מספרי מפתח ב-**מודגש**. אל תשתמש בכותרות מעבר לרמות ## ו-###.
- מין המשתמש אינו ידוע — נסח בלשון ניטרלית ("כדאי לבדוק", "מומלץ לפנות") ולא בזכר או בנקבה.`;

// הקשר רגולטורי ומקצועי שהמודל חייב לעבוד לפיו — נוסף מעל הפרומפט המקורי
const CONTEXT_RULES = `## כללי עבודה
- אתה יועץ משכנתאות מומחה בישראל, בעל ניסיון בניתוח משכנתאות קיימות, מיחזור, בניית תמהיל, הפחתת ריביות וניהול סיכונים.
- בצע ניתוח מקצועי, ביקורתי ומבוסס מספרים. **אל תניח שחייבים למחזר את כל המשכנתא**, ואל תמליץ על שינוי לפני שבדקת את העלות הכוללת, העמלות והסיכונים.
- אל תסתפק באמירות כלליות כמו "כדאי לבדוק מיחזור" — בצע חישובים מפורטים והסבר כיצד הגעת לכל מסקנה.
- **אל תמציא נתוני שוק**. אינך יודע מזיכרונך מה ריבית הפריים או הריביות המוצעות בבנקים כיום. השתמש אך ורק בנתוני השוק שמופיעים בסעיף "נתוני שוק עדכניים" למטה (נשלפו אוטומטית מבנק ישראל בזמן הניתוח) ובנתונים שהמשתמש הזין. אם נתון שוק דרוש לחישוב ואינו קיים — כתוב זאת במפורש, הצג את החישוב כפונקציה של הריבית ("בריבית 4% החיסכון הוא X; בריבית 4.5% הוא Y"), ורשום את החסר בסעיף הנתונים החסרים.
- הריביות הממוצעות של בנק ישראל הן על הלוואות דיור **חדשות** — בדיוק הבסיס להשוואה לצורך מיחזור. שים לב לתקופת הדיווח של כל שורה: הנתון מתפרסם בפיגור, ולכן הוא אינדיקציה ולא הצעת ריבית. ריבית הפריים, לעומת זאת, מדויקת ועדכנית לרגע הניתוח.
- אם נתון אחר חסר — ציין אותו במפורש ואל תמציא מספרים. כל הנחה שאתה מניח — הצג אותה בנפרד בסעיף "הנחות שהנחתי".
- הפרד בבירור בין: נתונים שהמשתמש מסר, חישובים שביצעת בעצמך, והערכות שדורשות אימות מול הבנק.

## הקשר רגולטורי ומקצועי (ישראל)
- מגבלות בנק ישראל על תמהיל משכנתא חדשה או ממוחזרת: **לפחות שליש** מהמשכנתא בריבית קבועה (צמודה או לא צמודה), **עד שני שלישים** במסלול פריים, ומסלול בריבית משתנה חייב תחנות יציאה מוגדרות.
- מדרגות LTV: עד 75% לדירה יחידה, עד 70% לדירה משפרי דיור, עד 50% לדירה להשקעה. LTV נמוך יותר משפר את הריבית המוצעת.
- **עמלת פירעון מוקדם** מורכבת מכמה רכיבים; המשמעותי הוא **עמלת היוון** — היא נגבית רק כשריבית המסלול גבוהה מהריבית הממוצעת שמפרסם בנק ישראל למסלול דומה, וגדלה עם התקופה שנותרה. כשריבית המסלול נמוכה מהריבית הממוצעת בשוק — אין עמלת היוון, והפירעון זול. יש גם עמלה תפעולית קטנה, עמלת אי-הודעה מוקדמת (נמנעת בהודעה מראש) ועמלת הפרשי הצמדה. הסבר את זה למשתמש בשפה פשוטה והבהר שהמספר המדויק מתקבל רק ב"אישור יתרה לסילוק" מהבנק.
- הבחן בין **מיחזור פנימי** (באותו בנק — מהיר, בלי עלויות פתיחת תיק ורישום מחדש, אבל כוח מיקוח נמוך) לבין **מיחזור חיצוני** (בנק אחר — ריבית טובה יותר בדרך כלל, אך עלויות: פתיחת תיק, שמאות, רישום הערת אזהרה/משכון, ביטול משכון בבנק היוצא, וזמן טיפול). חשב את שתי החלופות בנפרד.
- זכור שביטוח חיים וביטוח מבנה של המשכנתא ניתנים להעברה לחברה חיצונית וזה חוסך לרוב מאות שקלים בחודש — בדוק זאת.
- אתה לא יועץ משכנתאות מוסמך של המשתמש ואינך רואה את המסמכים המקוריים. סיים בהסתייגות קצרה והמלצה לאמת מול הבנק או יועץ משכנתאות מורשה לפני החלטה.`;

// מבנה הפלט — שמונה השלבים מהפרומפט המקורי של המשתמש, בלי לגרוע מהם
const OUTPUT_STRUCTURE = `## מבנה הפלט (Markdown, עברית, בסדר הזה בדיוק)
## תמונת מצב
סכם את המשכנתא בצורה פשוטה וברורה: יתרה כוללת, החזר חודשי, יחס ההחזר להכנסה נטו, מספר השנים שנותרו, אומדן עלות הריבית וההצמדה עד סוף התקופה, והמסלולים היקרים והמסוכנים ביותר.
## ניתוח מסלול-מסלול
טבלה ובה לכל מסלול: האם הריבית טובה, בינונית או יקרה ביחס לתנאים המקובלים (לפי נתוני השוק שהוזנו בלבד), הסיכון לעליית ההחזר, הסיכון להגדלת הקרן בשל הצמדה למדד, אומדן הסכום שישולם במסלול עד סיומו, והמלצה: להשאיר / למחזר / לקצר / לפרוע.
## אפשרויות חיסכון
עבור אחת-אחת: מיחזור מלא, מיחזור חלקי של המסלולים היקרים בלבד, קיצור תקופה, הגדלת ההחזר החודשי, פירעון מוקדם חד-פעמי, מעבר מצמוד מדד ללא צמוד, שיפור מרווח הפריים, משא ומתן מול הבנק הקיים, הצעות מתחרות מבנקים אחרים, ובדיקת ביטוח החיים והמבנה.
## פירוט כל אפשרות
לכל אפשרות: החזר חודשי חדש, תקופה חדשה, ריבית ממוצעת משוערת, עלות כוללת עד הסוף, חיסכון ברוטו, כל העמלות (פירעון מוקדם, פתיחת תיק, שמאות, רישומים), חיסכון נטו לאחר העלויות, נקודת האיזון (אחרי כמה חודשים המיחזור מתחיל להשתלם), והסיכונים והחסרונות.
## שלוש חלופות
חלופה שמרנית (יציבות גבוהה והחזר צפוי), חלופה מאוזנת (שילוב יציבות וחיסכון), וחלופה אגרסיבית (קיצור משמעותי וחיסכון מרבי בריבית — רק אם ההחזר החודשי מאפשר זאת). הצג אותן בטבלה משווה.
## תרחישי לחץ
עלייה של 1% ושל 2% בריבית הפריים; אינפלציה שנתית של 2%, 3% ו-4%; ירידה זמנית של 20% בהכנסה המשפחתית; הוצאה בלתי צפויה של 50,000 ש"ח. לכל תרחיש — ההחזר החדש ויחס ההחזר להכנסה.
## פירעון מוקדם
באיזה מסלול עדיף להשתמש בכסף, האם עדיף להקטין את ההחזר החודשי או לקצר את התקופה, מה החיסכון בכל אפשרות, והאם יש עמלה שמקטינה את הכדאיות.
## הנחות שהנחתי
כל הנחה שהשתמשת בה, בנפרד ובמפורש. אם הנחת ריבית או מדד — אמור זאת כאן.
## דירוג ממצאים
רשימה שבה כל ממצא מדורג: ✅ תקין / 🟡 דורש בירור / 🔴 בעייתי — יש לטפל.
## מסקנה
חד-משמעית: מה להשאיר ללא שינוי, מה לשנות, איזה מסלול למחזר ראשון, מהו החיסכון האפשרי בשקלים, מהו החיסכון החודשי, ובכמה שנים אפשר לקצר את המשכנתא.
## רשימת פעולות
1. אילו מסמכים לבקש מהבנק. 2. אילו מסלולים לבדוק למיחזור. 3. מה לבקש בהצעות המחיר מהבנקים. 4. אילו עמלות לבדוק. 5. מה לומר לבנק במסגרת המשא ומתן. 6. איזה טווח ריביות לדרוש בכל מסלול — אם אין נתוני שוק שהוזנו, כתוב במקום זאת איך לברר את הטווח (אתר בנק ישראל, ריביות ממוצעות למשכנתאות).
## נתונים חסרים
אילו נתונים חסרים כדי לקבל החלטה סופית, ואיפה להשיג כל אחד מהם.`;

/**
 * בניית הפרומפט לניתוח המשכנתא.
 * docs = [{ kind, filename, text }] — טקסט המסמכים לאחר הסרת פרטים מזהים.
 */
export function buildMortgageAnalysisPrompt(data = {}, tracks = [], checks = [], docs = [], market = null, history = []) {
  const today = new Date().toISOString().slice(0, 10);
  const historyText = historySummary(history);
  const historyBlock = historyText
    ? `\n## היסטוריית תשלומים שנתית (מדוחות הבנק)\n${historyText}\n\n`
      + 'השתמש בטבלה הזו כדי לנתח את המגמה בפועל: קצב פירעון הקרן, השפעת ההצמדה על היתרה,'
      + ' והשינוי בעלות הריבית לאורך השנים. אל תסתפק בתמונת הרגע הנוכחית.\n'
    : '';
  const marketText = marketRatesSummary(market);
  const marketBlock = marketText
    ? `\n## נתוני שוק עדכניים (נשלפו אוטומטית מבנק ישראל — השתמש רק בהם)\n${marketText}\n`
    : '\n## נתוני שוק עדכניים\nשליפת נתוני השוק מבנק ישראל נכשלה ואין נתוני שוק זמינים. אל תנקוב בריביות שוק מהזיכרון — הצג חישובים כפונקציה של הריבית ורשום את החסר.\n';
  const docsBlock = docs.length
    ? '\n## מסמכים שצורפו (טקסט מ-PDF, אחרי הסרת פרטים מזהים)\n'
      + docs.map((doc) => `### ${DOC_KIND_HE[doc.kind] ?? 'מסמך'}${doc.filename ? ` — ${doc.filename}` : ''}\n${doc.text}`).join('\n\n')
      + '\n'
    : '';
  return `נתח את המשכנתא הבאה. תאריך הניתוח: ${today}.

${CONTEXT_RULES}

${OUTPUT_RULES}

- הטקסט של המסמכים המצורפים עבר עיבוד אוטומטי מ-PDF וייתכנו בו שיבושי סדר מילים בעברית. פרש בהיגיון; אם ערך נראה בלתי סביר, ציין שייתכן שיבוש קריאה במקום להסיק טעות במסמך.
- פרטים מזהים (ת"ז, חשבון בנק, כתובת הנכס, מספרי הלוואה) הוסרו מראש — התעלם מהסימונים במקומם.

${OUTPUT_STRUCTURE}

${marketBlock}
## פרטי המשכנתא שהזין המשתמש
${dataSummary(data, market)}

## המסלולים
${tracksSummary(tracks)}
${historyBlock}
## בדיקות אוטומטיות שהאפליקציה ביצעה על הנתונים
${checksSummary(checks)}
${docsBlock}`;
}

/**
 * פרומפט לשאלת המשך חופשית על המשכנתא. מקבל את הניתוח הקודם ואת היסטוריית
 * השאלות, כדי שהמודל יענה בהקשר ולא יחזור על עצמו.
 */
export function buildMortgageQuestionPrompt({
  question, data = {}, tracks = [], analysisMd, history = [], market = null, yearly = [],
}) {
  const marketText = marketRatesSummary(market);
  const marketBlock = marketText ? `\n## נתוני שוק עדכניים (מבנק ישראל)\n${marketText}\n` : '';
  const yearlyText = historySummary(yearly);
  const yearlyBlock = yearlyText ? `\n## היסטוריית תשלומים שנתית (מדוחות הבנק)\n${yearlyText}\n` : '';
  const prior = history.length
    ? '\n## שאלות קודמות בשיחה הזו\n' + history.map((h, i) => `${i + 1}. ש: ${h.q}\n   ת: ${h.a}`).join('\n') + '\n'
    : '';
  const analysis = analysisMd ? `\n## הניתוח שכבר ניתן על המשכנתא\n${analysisMd}\n` : '';
  return `אתה יועץ משכנתאות מומחה בישראל. המשתמש שואל שאלת המשך על המשכנתא שלו.

## כללי מענה
- ענה ישירות ולעניין על השאלה שנשאלה בלבד. אל תחזור על הניתוח המלא.
- **אל תמציא נתוני שוק** (ריבית פריים, ריביות מוצעות בבנקים). השתמש רק בנתוני השוק שמופיעים למטה ובנתונים שהמשתמש הזין; אם חסר נתון — אמור זאת והצג את החישוב כפונקציה שלו.
- כשהתשובה דורשת נתון שאינו קיים — אמור זאת במפורש וציין מה נדרש כדי לענות.
- הפרד בין נתון שהמשתמש מסר, חישוב שביצעת, והערכה שדורשת אימות מול הבנק.
- **אסור סימון LaTeX או מתמטי**: בלי \\text, \\mathbf, \\frac, \\times, וללא $. נוסחאות כטקסט רגיל.
- מין המשתמש אינו ידוע — נסח בלשון ניטרלית ("כדאי לבדוק", "מומלץ לפנות") ולא בזכר או בנקבה.
- סכומים בפורמט ישראלי (1,250,000.00 ש"ח). Markdown, עברית. תשובה תמציתית — עד כמה פסקאות או טבלה קצרה.

${marketBlock}
## פרטי המשכנתא
${dataSummary(data, market)}

## המסלולים
${tracksSummary(tracks)}
${yearlyBlock}${analysis}${prior}
## השאלה
${question}`;
}

/* ---------- אחסון ---------- */
export const DOC_KINDS = ['balance', 'schedule', 'other'];
export const DOC_KIND_HE = { balance: 'דוח יתרות', schedule: 'לוח סילוקין', other: 'מסמך נוסף' };

const EMPTY = { data: {}, tracks: [], checks: [], analysis_md: null, analysis_at: null, analysis_model: null, qa: [], updated_at: null };

function parseJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

/** השורה הגולמית (בלי BLOBs) או null */
function mortgageRow() {
  return db.prepare(`
    SELECT data_json, tracks_json, checks_json, analysis_md, analysis_at, analysis_model, qa_json, updated_at
    FROM mortgage WHERE id = 1
  `).get() ?? null;
}

/** רשימת המסמכים בלי ה-BLOB */
export function mortgageDocs() {
  return db.prepare('SELECT id, kind, filename, uploaded_at, length(extracted_text) AS text_len FROM mortgage_docs ORDER BY id').all();
}

/**
 * טקסט המסמכים לפרומפט — **אחרי קיצוץ עמודי ההסבר הגנריים** (`stripBoilerplate`).
 * הקיצוץ נעשה כאן ולא בשמירה: ה-DB שומר את הטקסט המלא וה-PDF המקורי, ורק
 * הדרך לפרומפט מתקצרת. הסיבה — בדוחות לאומי רוב העמודים הם הסבר זהה לכל
 * לקוח, והפרומפט תפח עד שה-Codex עבר את מגבלת הזמן ונפל ל-Gemini.
 */
function docTexts() {
  return db.prepare('SELECT kind, filename, extracted_text FROM mortgage_docs ORDER BY id').all()
    .map((r) => {
      const trimmed = stripBoilerplate(r.extracted_text ?? '');
      return { kind: r.kind, filename: r.filename, text: trimmed.text, trimmed };
    })
    .filter((d) => d.text);
}

/**
 * שמירת הטופס. מחשב מחדש את הבדיקות המקומיות.
 * לא מוחק את הניתוח הקיים — ה-UI משווה analysis_at ל-updated_at ומסמן התיישנות.
 */
export function saveMortgage(dataInput, tracksInput, market = null) {
  const data = normalizeMortgageData(dataInput);
  const tracks = normalizeTracks(tracksInput);
  const checks = runMortgageChecks(data, tracks, market);
  db.prepare(`
    INSERT INTO mortgage (id, data_json, tracks_json, checks_json)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      data_json = excluded.data_json,
      tracks_json = excluded.tracks_json,
      checks_json = excluded.checks_json,
      updated_at = datetime('now','localtime')
  `).run(JSON.stringify(data), JSON.stringify(tracks), JSON.stringify(checks));
  const row = mortgageRow();
  return {
    data, tracks, checks,
    property_value_estimate: estimatePropertyValue(data, market),
    updated_at: row?.updated_at ?? null,
  };
}

/**
 * פירוט מלא (בלי BLOBs) + הפרומפט המוכן להעתקה ידנית.
 * הבדיקות מחושבות מחדש כאן ולא נקראות מה-DB — כך שינוי בנתוני השוק
 * (ריבית פריים חדשה) משתקף מיד, בלי שהמשתמש ישמור את הטופס שוב.
 */
export function mortgageDetail(market = null) {
  const row = mortgageRow();
  const docs = mortgageDocs();
  const history = mortgageHistory();
  if (!row) {
    return {
      ...EMPTY, docs, market, history,
      property_value_estimate: estimatePropertyValue({}, market),
      prompt: buildMortgageAnalysisPrompt({}, [], [], docTexts(), market, history),
    };
  }
  const data = parseJson(row.data_json, {});
  const tracks = parseJson(row.tracks_json, []);
  const checks = runMortgageChecks(data, tracks, market);
  return {
    data,
    tracks,
    checks,
    market,
    history,
    property_value_estimate: estimatePropertyValue(data, market),
    docs,
    analysis_md: row.analysis_md,
    analysis_at: row.analysis_at,
    analysis_model: row.analysis_model,
    qa: parseJson(row.qa_json, []),
    updated_at: row.updated_at,
    prompt: buildMortgageAnalysisPrompt(data, tracks, checks, docTexts(), market, history),
  };
}

/** הנתונים הדרושים לניתוח (data, tracks, checks, docs) */
export function mortgageForAnalysis(market = null) {
  const row = mortgageRow();
  const data = parseJson(row?.data_json ?? '{}', {});
  const tracks = parseJson(row?.tracks_json ?? '[]', []);
  return {
    data,
    tracks,
    checks: runMortgageChecks(data, tracks, market),
    docs: docTexts(),
    history: mortgageHistory(),
    analysis_md: row?.analysis_md ?? null,
    qa: parseJson(row?.qa_json ?? '[]', []),
  };
}

/** שמירת מסמך PDF. הטקסט כבר עבר stripMortgagePii אצל הקורא. */
export function storeMortgageDoc({ buf, filename, kind, text: docText }) {
  const k = DOC_KINDS.includes(kind) ? kind : 'other';
  const info = db.prepare(`
    INSERT INTO mortgage_docs (kind, filename, pdf, extracted_text) VALUES (?, ?, ?, ?)
  `).run(k, filename || '', buf, docText || '');
  return { id: Number(info.lastInsertRowid), kind: k, filename: filename || '' };
}

/** מספר המסמכים הקיימים — לאכיפת MAX_DOCS */
export function docCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM mortgage_docs').get().n;
}

/** שמירת תוצאת ניתוח. מאפסת את שאלות ההמשך — הן התייחסו לניתוח הקודם. */
export function saveAnalysis(md, model) {
  db.prepare(`
    INSERT INTO mortgage (id, analysis_md, analysis_at, analysis_model, qa_json)
    VALUES (1, ?, datetime('now','localtime'), ?, '[]')
    ON CONFLICT(id) DO UPDATE SET
      analysis_md = excluded.analysis_md,
      analysis_at = excluded.analysis_at,
      analysis_model = excluded.analysis_model,
      qa_json = '[]'
  `).run(md, model);
  return db.prepare('SELECT analysis_at FROM mortgage WHERE id = 1').get()?.analysis_at ?? null;
}

/** שמירת היסטוריית שאלות (20 אחרונות) */
export function saveQa(entries) {
  db.prepare("UPDATE mortgage SET qa_json = ? WHERE id = 1").run(JSON.stringify(entries));
}
