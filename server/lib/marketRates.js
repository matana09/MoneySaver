// marketRates.js — שליפה אוטומטית של נתוני שוק מבנק ישראל.
// שני מקורות, שניהם ציבוריים ובלי מפתח:
//   1. ריבית בנק ישראל — https://boi.org.il/PublicApi/GetInterest (JSON, מתעדכן ביום ההחלטה).
//      ריבית הפריים = ריבית בנק ישראל + 1.5% (מרווח קבוע בכל הבנקים).
//   2. ריביות ממוצעות על הלוואות לדיור — מאגר הסדרות של בנק ישראל (SDMX),
//      dataflow BIR_MRTG_99. מתפרסם חודשית **בפיגור של כמה חודשים**, ולכן לכל
//      סדרה נשמרת תקופת הדיווח שלה (`period`) והיא מוצגת למשתמש ולמודל.
// התוצאה נשמרת ב-settings (`market_rates_json`) ומרוענת אוטומטית (ראו marketRates).
//
// אתר בנק ישראל עצמו (boi.org.il/information/...) חסום ע"י Radware לבוטים —
// שתי הכתובות כאן הן API-ים שמחזירים נתונים ועוברות בלי בעיה.
import { getSetting, setSetting } from '../db.js';

const SETTING_KEY = 'market_rates_json';

export const BOI_RATE_URL = 'https://boi.org.il/PublicApi/GetInterest';
// כל הדאטה-פלו (התצפית האחרונה בכל סדרה, ~17KB) והסינון נעשה בקוד.
// **בכוונה בלי פילטרי c[DIM]=** של SDMX: ה-URL-parser של Node מקודד את הסוגריים
// המרובעים ל-%5B/%5D והשרת של בנק ישראל מחזיר אז 404 (עובד רק בכלים ששולחים
// אותם raw). סינון בקוד עובד תמיד וגם חוסך תלות בתחביר הפילטרים.
export const BOI_MORTGAGE_URL = 'https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/'
  + 'BOI.STATISTICS/BIR_MRTG_99/?lastNObservations=1&format=csv';

// הסינון שהיה קודם ב-URL: הלוואות לדיור (A2C ולא A2B2 = הלוואה לכל מטרה
// בביטחון דירה), בלי פילוח לפי אחוז מימון/יחס החזר, ובאחוזים בלבד.
const ROW_FILTER = { BS_ITEM: 'A2C', BIR_COVERAGE: 'N', LTV: 'L0', PTI: 'P01', UNIT_MEASURE: 'PT' };

/** המרווח הקבוע בין ריבית בנק ישראל לריבית הפריים */
export const PRIME_SPREAD = 1.5;

// מדד מחירי הדירות של הלמ"ס — API ציבורי בלי מפתח. משמש להצמדת שווי הנכס:
// המשתמש מזין שווי ידוע בחודש מסוים, והאפליקציה מכפילה ביחס המדדים.
// אתר nadlan.gov.il (עסקאות בפועל) חסום מאחורי reCAPTCHA והתחברות ולכן
// לא ניתן לשליפה אוטומטית — המדד הרשמי הוא החלופה הלגיטימית.
export const CBS_INDEX_URL = (id, last) =>
  `https://api.cbs.gov.il/index/data/price?id=${id}&format=json&download=false&last=${last}`;

// ארצי מ-1994; המחוזות מ-2017-10 בלבד (בסיס אוקטובר 2017 = 100).
export const HOUSING_INDEX_SERIES = [
  { key: 'national',  id: 40010, last: 400, label: 'ארצי' },
  { key: 'jerusalem', id: 60000, last: 150, label: 'מחוז ירושלים' },
  { key: 'north',     id: 60100, last: 150, label: 'מחוז הצפון' },
  { key: 'haifa',     id: 60200, last: 150, label: 'מחוז חיפה' },
  { key: 'center',    id: 60300, last: 150, label: 'מחוז המרכז' },
  { key: 'telaviv',   id: 60400, last: 150, label: 'מחוז תל אביב' },
  { key: 'south',     id: 60500, last: 150, label: 'מחוז הדרום' },
];
export const HOUSING_REGION_KEYS = HOUSING_INDEX_SERIES.map((s) => s.key);

// הסדרות הרלוונטיות למשכנתא. DATA_TYPE: R = ריבית ממוצעת, RM = מרווח ממוצע,
// RB = ריבית העוגן. IR_FV_TYPE: F = קבועה, V = משתנה, A = כל הסוגים.
// מסלולי מטבע חוץ (IFC_DFC) לא נכללים — לא רלוונטיים למשכנתא ישראלית רגילה.
const SERIES = [
  { key: 'fixed_unlinked',     indexation: 'NI',  fv: 'F', type: 'R',  label: 'קבועה לא צמודה (קל"צ)' },
  { key: 'fixed_linked',       indexation: 'CPI', fv: 'F', type: 'R',  label: 'קבועה צמודה (ק"צ)' },
  { key: 'unlinked_all',       indexation: 'NI',  fv: 'A', type: 'R',  label: 'לא צמודה — כל סוגי הריבית' },
  { key: 'linked_all',         indexation: 'CPI', fv: 'A', type: 'R',  label: 'צמודה — כל סוגי הריבית' },
  { key: 'var_linked_base',    indexation: 'CPI', fv: 'V', type: 'RB', label: 'משתנה צמודה — ריבית העוגן' },
  { key: 'var_linked_margin',  indexation: 'CPI', fv: 'V', type: 'RM', label: 'משתנה צמודה — מרווח ממוצע מעל העוגן' },
  { key: 'var_unlinked_base',  indexation: 'NI',  fv: 'V', type: 'RB', label: 'משתנה לא צמודה — ריבית הבסיס' },
  { key: 'var_unlinked_margin', indexation: 'NI', fv: 'V', type: 'RM', label: 'משתנה לא צמודה — מרווח ממוצע' },
];

// מפתח הסדרה שמשמש להשוואת ריבית של מסלול קיים מול השוק (runMortgageChecks).
// רק מסלולים בריבית קבועה — במסלול משתנה/פריים הריבית מורכבת מעוגן + מרווח,
// והשוואה לממוצע בודד תהיה מטעה.
export const MARKET_KEY_BY_TRACK = {
  fixed_unlinked: 'fixed_unlinked',
  fixed_linked: 'fixed_linked',
};

/* ---------- פענוח (פונקציות טהורות) ---------- */

/**
 * פרסור CSV פשוט עם תמיכה בשדות בגרשיים (עמודת DATA_SOURCE מכילה פסיקים
 * בתוך גרשיים). מחזיר מערך אובייקטים לפי שורת הכותרות.
 */
export function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const split = (line) => {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted;
      } else if (ch === ',' && !quoted) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const head = split(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = split(line);
    return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? '']));
  });
}

/** ריבית בנק ישראל + פריים מתוך תשובת ה-JSON של PublicApi/GetInterest */
export function parseBoiRate(json) {
  const rate = Number(json?.currentInterest);
  if (!Number.isFinite(rate)) return null;
  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    rate: round2(rate),
    prime: round2(rate + PRIME_SPREAD),
    published_at: json?.lastPublishedDate ?? null,
    next_decision: json?.nextInterestDate ?? null,
  };
}

// סדרה שתקופת הדיווח שלה מעבר לזה מסומנת `stale` — בנק ישראל הפסיק לעדכן
// חלק מהסדרות (למשל "לא צמודה — כל סוגי הריבית" עצר ב-2024-01), וריבית שוק
// מלפני שנתיים מטעה יותר משהיא עוזרת. הסדרה לא נזרקת — רק מסומנת בבירור.
const STALE_MONTHS = 12;

/** האם תקופת הדיווח ('YYYY-MM') מיושנת ביחס ל-now */
export function isStalePeriod(period, now = new Date()) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period ?? ''));
  if (!m) return false;
  const months = (now.getFullYear() - Number(m[1])) * 12 + (now.getMonth() + 1 - Number(m[2]));
  return months > STALE_MONTHS;
}

/** הריביות הממוצעות מתוך ה-CSV של מאגר הסדרות */
export function parseMortgageAverages(csvText, now = new Date()) {
  const rows = parseCsv(csvText)
    .filter((r) => Object.entries(ROW_FILTER).every(([k, v]) => r[k] === v));
  const out = [];
  for (const s of SERIES) {
    const row = rows.find((r) => r.INDEXATION_TYPE === s.indexation
      && r.IR_FV_TYPE === s.fv && r.DATA_TYPE === s.type);
    const value = row ? Number(row.OBS_VALUE) : NaN;
    if (!Number.isFinite(value)) continue;
    const period = row.TIME_PERIOD || null;
    out.push({ key: s.key, label: s.label, value, period, stale: isStalePeriod(period, now) });
  }
  return out;
}

/**
 * סדרת מדד מחירי דירות מתשובת ה-JSON של הלמ"ס.
 * מחזיר { points: [{ period: 'YYYY-MM', value }] } בסדר עולה.
 */
export function parseCbsIndex(json) {
  const dates = json?.month?.[0]?.date;
  if (!Array.isArray(dates)) return null;
  const points = [];
  for (const d of dates) {
    const value = Number(d?.currBase?.value);
    const y = Number(d?.year);
    const mo = Number(d?.month);
    if (!Number.isFinite(value) || !Number.isFinite(y) || !Number.isFinite(mo)) continue;
    points.push({ period: `${y}-${String(mo).padStart(2, '0')}`, value });
  }
  points.sort((a, b) => (a.period < b.period ? -1 : 1));
  return points.length ? { points, base: json?.month?.[0]?.date?.[0]?.currBase?.baseDesc ?? null } : null;
}

/** ערך המדד בחודש נתון — הנקודה האחרונה שאינה מאוחרת ממנו (המדד מתפרסם בפיגור) */
export function indexValueAt(series, period) {
  if (!series?.points?.length || !period) return null;
  let found = null;
  for (const p of series.points) {
    if (p.period <= period) found = p; else break;
  }
  return found;
}

/** הנקודה האחרונה בסדרה */
export function latestIndex(series) {
  return series?.points?.length ? series.points[series.points.length - 1] : null;
}

/* ---------- שליפה ואחסון ---------- */

/** MONEYSAVER_NO_NET=1 — הבדיקות לא יוצאות לאינטרנט (ראו tests/run-tests.mjs) */
const NO_NET = process.env.MONEYSAVER_NO_NET === '1';

/** קריאה אחת עם timeout; מחזירה { __error } במקום לזרוק (הקורא ממזג עם המצב הקודם) */
async function fetchOne(url, kind, timeoutMs) {
  if (NO_NET) return { __error: 'שליפה מושבתת (MONEYSAVER_NO_NET)' };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return kind === 'json' ? await res.json() : await res.text();
  } catch (err) {
    return { __error: err?.name === 'TimeoutError' ? 'timeout' : (err?.message ?? 'שגיאת רשת') };
  }
}

/** נתוני השוק השמורים (או null אם טרם נשלפו) */
export function getMarketRates() {
  const raw = getSetting(SETTING_KEY, '');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * שליפה מחדש משני המקורות ושמירה. כשמקור אחד נכשל — הערך הקודם שלו נשמר
 * (עדיף נתון מלפני יום על כלום), והשגיאה מדווחת ב-`errors`.
 */
export async function refreshMarketRates({ timeoutMs = 15000 } = {}) {
  const prev = getMarketRates();
  const [boiRaw, csvRaw, ...cbsRaw] = await Promise.all([
    fetchOne(BOI_RATE_URL, 'json', timeoutMs),
    fetchOne(BOI_MORTGAGE_URL, 'text', timeoutMs),
    ...HOUSING_INDEX_SERIES.map((s) => fetchOne(CBS_INDEX_URL(s.id, s.last), 'json', timeoutMs)),
  ]);

  const errors = [];
  let boi = prev?.boi ?? null;
  if (boiRaw?.__error) {
    errors.push(`ריבית בנק ישראל: ${boiRaw.__error}`);
  } else {
    const parsed = parseBoiRate(boiRaw);
    if (parsed) boi = parsed; else errors.push('ריבית בנק ישראל: תשובה לא מזוהה');
  }

  let averages = prev?.averages ?? [];
  if (csvRaw?.__error) {
    errors.push(`ריביות ממוצעות: ${csvRaw.__error}`);
  } else {
    const parsed = parseMortgageAverages(csvRaw);
    if (parsed.length) averages = parsed; else errors.push('ריביות ממוצעות: לא נמצאו סדרות');
  }

  // מדד מחירי הדירות — כל סדרה בנפרד; כישלון בסדרה אחת לא פוגע באחרות
  const housing = { ...(prev?.housing ?? {}) };
  let housingOk = 0;
  HOUSING_INDEX_SERIES.forEach((s, i) => {
    const raw = cbsRaw[i];
    if (raw?.__error) { errors.push(`מדד מחירי דירות (${s.label}): ${raw.__error}`); return; }
    const parsed = parseCbsIndex(raw);
    if (!parsed) { errors.push(`מדד מחירי דירות (${s.label}): תשובה לא מזוהה`); return; }
    housing[s.key] = { label: s.label, ...parsed };
    housingOk++;
  });

  const anyOk = !boiRaw?.__error || !csvRaw?.__error || housingOk > 0;
  const data = {
    boi,
    averages,
    housing,
    errors,
    // נשמר רק כשמשהו נשלף בהצלחה — אחרת התאריך היה מסתיר כישלון מתמשך
    fetched_at: anyOk ? new Date().toISOString() : (prev?.fetched_at ?? null),
  };
  setSetting(SETTING_KEY, JSON.stringify(data));
  return data;
}

/**
 * נתוני השוק, עם רענון אוטומטי כשהם מיושנים (ברירת מחדל: 12 שעות).
 * כישלון רשת לא מפיל את הקורא — מוחזר המצב השמור.
 */
export async function marketRates({ maxAgeHours = 12 } = {}) {
  const cur = getMarketRates();
  const ageMs = cur?.fetched_at ? Date.now() - new Date(cur.fetched_at).getTime() : Infinity;
  if (cur && ageMs < maxAgeHours * 3600000) return cur;
  try {
    return await refreshMarketRates();
  } catch {
    return cur;
  }
}

/* ---------- תצוגה ---------- */
const pct = (n) => `${Number(n).toFixed(2)}%`;

/** התאריך העברי הקצר של חותמת ISO (לתצוגה ולפרומפט) */
function fmtStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * בלוק נתוני השוק לפרומפט. מוחזר '' כשאין נתונים — אז הפרומפט ממשיך לדרוש
 * מהמודל לא להמציא ריביות.
 */
export function marketRatesSummary(m) {
  if (!m || (!m.boi && !m.averages?.length)) return '';
  const lines = [];
  if (m.boi) {
    lines.push(`- ריבית בנק ישראל: **${pct(m.boi.rate)}**`
      + (m.boi.published_at ? ` (עדכון אחרון: ${fmtStamp(m.boi.published_at)})` : ''));
    lines.push(`- **ריבית הפריים: ${pct(m.boi.prime)}** (ריבית בנק ישראל + ${PRIME_SPREAD}%)`);
    if (m.boi.next_decision) lines.push(`- החלטת הריבית הבאה: ${fmtStamp(m.boi.next_decision)}`);
  }
  if (m.averages?.length) {
    lines.push('- ריביות ממוצעות על הלוואות לדיור **חדשות** (בנק ישראל; לכל שורה תקופת הדיווח שלה — הנתון מתפרסם בפיגור של כמה חודשים):');
    for (const a of m.averages) {
      lines.push(`  - ${a.label}: ${pct(a.value)}${a.period ? ` (תקופת דיווח ${a.period}` : ''}`
        + `${a.stale ? ' — **נתון מיושן, בנק ישראל הפסיק לעדכן את הסדרה; אל תסתמך עליו כריבית שוק נוכחית**' : ''}${a.period ? ')' : ''}`);
    }
  }
  return lines.join('\n');
}

/**
 * שווי הנכס בפועל. שלוש דרגות, בסדר עדיפות יורד:
 *   1. `property_value` — הזנה ידנית מפורשת (שמאות למשל). גוברת על הכל.
 *   2. עוגן + מדד — `property_value_base` בחודש `property_value_base_month`,
 *      מוצמד קדימה לפי מדד מחירי הדירות של הלמ"ס למחוז שנבחר. **זה המנגנון
 *      שמתעדכן לבד**: הלמ"ס מפרסמת מדד חדש כל חודש והשווי זז איתו.
 *   3. אין נתון → null.
 * מחזיר { value, source, detail } כאשר detail הוא הסבר קריא לתצוגה ולפרומפט.
 */
export function estimatePropertyValue(data = {}, m = null) {
  if (typeof data?.property_value === 'number' && Number.isFinite(data.property_value)) {
    return { value: data.property_value, source: 'user', detail: 'הוזן ידנית' };
  }
  const base = data?.property_value_base;
  const baseMonth = data?.property_value_base_month;
  if (typeof base !== 'number' || !Number.isFinite(base) || !baseMonth) return { value: null, source: null, detail: '' };

  const regionKey = HOUSING_REGION_KEYS.includes(data?.property_region) ? data.property_region : 'national';
  const series = m?.housing?.[regionKey] ?? m?.housing?.national;
  if (!series) return { value: base, source: 'base', detail: `שווי שהוזן לחודש ${baseMonth} (מדד מחירי הדירות לא זמין — לא בוצעה הצמדה)` };

  const from = indexValueAt(series, baseMonth);
  const to = latestIndex(series);
  if (!from || !to || !from.value) {
    return { value: base, source: 'base', detail: `שווי שהוזן לחודש ${baseMonth} (אין נקודת מדד מתאימה — לא בוצעה הצמדה)` };
  }
  const factor = to.value / from.value;
  const value = Math.round((base * factor) / 1000) * 1000;   // עיגול לאלף — זו הערכה
  const changePct = (factor - 1) * 100;
  const baseFmt = new Intl.NumberFormat('he-IL').format(base);
  // המדד מתפרסם בפיגור; כשחודש העוגן מאוחר מהפרסום האחרון אין עדיין מה להצמיד
  const detail = from.period === to.period
    ? `${baseFmt} ש"ח לחודש ${baseMonth} — טרם פורסם מדד חדש מאז (מדד מחירי הדירות של הלמ"ס, ${series.label}, אחרון: ${to.period})`
    : `${baseFmt} ש"ח לחודש ${baseMonth}, מוצמד לפי מדד מחירי הדירות של הלמ"ס`
      + ` (${series.label}) מ-${from.period} עד ${to.period}: ${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}%`;
  return {
    value,
    source: 'index',
    detail,
    factor,
    from,
    to,
    regionLabel: series.label,
  };
}

/** ריבית הפריים בפועל: מה שהמשתמש הזין, ואם לא — הנתון שנשלף אוטומטית */
export function effectivePrime(data = {}, m = null) {
  if (typeof data?.prime_rate === 'number' && Number.isFinite(data.prime_rate)) {
    return { value: data.prime_rate, source: 'user' };
  }
  if (typeof m?.boi?.prime === 'number') return { value: m.boi.prime, source: 'boi' };
  return { value: null, source: null };
}
