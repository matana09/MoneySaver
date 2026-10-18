// payslip.js — תלוש משכורת: חילוץ שדות, הסרת פרטים מזהים, בדיקות שפיות, בניית פרומפט
// כל הפונקציות טהורות (למעט storePayslip/getPayslip שנוגעות ב-DB), כדי שיהיו
// ניתנות לבדיקה בלי שרת ושיוכלו לשמש גם את ה-web route וגם את הבוט.
import { db } from '../db.js';
import { fixHebrew, parseAmount } from './importer.js';

/* ---------- זיהוי חודש ---------- */
const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

function plausibleYear(y) {
  const now = new Date().getFullYear();
  return y >= 2000 && y <= now + 1;
}

/**
 * זיהוי חודש התלוש מתוך הטקסט. מחזיר 'YYYY-MM' או null.
 * סדר הניסיונות: MM/YYYY ליד מילת הקשר ("חודש", "תקופה") → שם חודש עברי + שנה
 * → MM/YYYY בודד כלשהו בטקסט (מוצא אחרון).
 */
export function detectMonth(text) {
  if (!text) return null;
  const lines = String(text).split('\n').flatMap((l) => [l, fixHebrew(l)]);
  const CONTEXT = /חודש|תקופה|לחודש|שכר|משכורת|עבור/;
  const MM_YYYY = /(?:^|[^\d])(0?[1-9]|1[0-2])[\/.\-](20\d{2})(?![\d])/;

  // 1) MM/YYYY בשורה שיש בה מילת הקשר
  for (const line of lines) {
    if (!CONTEXT.test(line)) continue;
    const m = line.match(MM_YYYY);
    if (m && plausibleYear(Number(m[2]))) return `${m[2]}-${String(m[1]).padStart(2, '0')}`;
  }
  // 2) שם חודש עברי + שנה
  for (const line of lines) {
    for (let i = 0; i < HE_MONTHS.length; i++) {
      if (!line.includes(HE_MONTHS[i])) continue;
      const y = line.match(/(20\d{2})/);
      if (y && plausibleYear(Number(y[1]))) return `${y[1]}-${String(i + 1).padStart(2, '0')}`;
    }
  }
  // 3) MM/YYYY כלשהו
  for (const line of lines) {
    const m = line.match(MM_YYYY);
    if (m && plausibleYear(Number(m[2]))) return `${m[2]}-${String(m[1]).padStart(2, '0')}`;
  }
  return null;
}

/* ---------- חילוץ שדות ---------- */
// לכל שדה: תוויות אפשריות בתלוש. ההתאמה נעשית מול השורה כפי שהיא *וגם* אחרי
// fixHebrew, כי טקסט עברי מ-PDF יוצא לעתים בסדר ויזואלי (הפוך).
// חלק מהתוויות בצורתן ה"ויזואלית" (מיכפל: "תשלומים כ"סה" = סה"כ תשלומים) —
// היפוך סדר-מילים משחזר מילים שלמות, אבל לא תווית שיש בה גרשיים/נקודות באמצע.
const FIELD_LABELS = {
  gross:               ['שכר ברוטו', 'סה"כ ברוטו', 'סהכ ברוטו', 'סה"כ תשלומים', 'תשלומים כ"סה', 'ברוטו לגמל', 'ברוטו'],
  net:                 ['נטו לתשלום', 'שכר נטו', 'סה"כ נטו', 'סהכ נטו', 'נטו'],
  deductions_total:    ['ניכויי חובה', 'חובה ניכויי', 'סה"כ ניכויים'],
  insured_salary:      ['שכר מבוטח', 'מבוטח שכר'],
  base_salary:         ['שכר יסוד', 'שכר בסיס', 'משכורת יסוד', 'משכורת'],
  income_tax:          ['מס הכנסה', 'מ.הכנסה', 'מס הכנסה לתשלום'],
  national_insurance:  ['ביטוח לאומי', 'ב.לאומי', 'לאומי.ב', 'בטוח לאומי'],
  health_tax:          ['דמי בריאות', 'מס בריאות', 'ביטוח בריאות'],
  // בתלושי מיכפל שורת הפנסיה של העובד היא שם הקרן בלבד (בתוך בלוק ניכויי החובה)
  pension_employee:    ['תגמולי עובד', 'פנסיה עובד', 'גמל עובד', 'הפרשת עובד',
                        'הראל', 'מגדל', 'מנורה', 'פניקס', 'אלטשולר', 'מבטחים', 'מיטב', 'כלל פנסיה'],
  pension_employer:    ['תגמולי מעביד', 'פנסיה מעביד', 'גמל מעביד', 'מעסיק גמל', 'הפרשת מעביד', 'תגמולי מעסיק'],
  severance:           ['פיצויים'],
  study_fund_employee: ['קרן השתלמות עובד', 'השתלמות עובד', 'השתלמות'],
  study_fund_employer: ['קרן השתלמות מעביד', 'השתלמות מעביד', 'קרן השתלמות מעסיק', 'מעסיק ש"קרה'],
  credit_points:       ['נקודות זיכוי', 'נק. זיכוי', 'נקודות זכוי'],
  hours:               ['שעות עבודה', 'סה"כ שעות', 'סהכ שעות', 'ימי עבודה'],
};

// שדות שהם ספירה ולא סכום כספי (טווח סביר שונה)
const COUNT_FIELDS = new Set(['credit_points', 'hours']);

const NUMBER_TOKEN = /-?\d[\d,]*\.?\d*/g;

/** כל המספרים בשורה, לפי סדר הופעתם. אחוזים (מספר שצמוד אליו %) מדולגים —
 *  הם שיעור, לא סכום, ובחירת "המספר אחרי התווית" נתקעת עליהם. */
function numbersIn(line) {
  const out = [];
  for (const m of line.matchAll(NUMBER_TOKEN)) {
    if (line[m.index + m[0].length] === '%') continue;
    const n = parseAmount(m[0]);
    if (n !== null) out.push({ value: n, index: m.index, raw: m[0] });
  }
  return out;
}

/**
 * חילוץ שדות מטקסט התלוש.
 * מחזיר { fields, confidence } — רק שדות שנמצאו בפועל, בלי ניחושים.
 */
export function parsePayslipText(text) {
  const fields = {};
  const rawLines = String(text || '').split('\n');
  // כל שורה נבדקת בשלוש צורות: כפי שהיא; אחרי היפוך סדר-מילים בלבד (מיכפל —
  // כל מילה יוצאת נכון אבל סדר המילים בשורה הפוך: "נטו שכר 16799"); ואחרי
  // fixHebrew מלא (היפוך גם של האותיות — פורמטים אחרים). סדר המסמך נשמר —
  // חשוב כדי שהסעיף החודשי (שמופיע ראשון) ינצח את סעיף הסכומים המצטברים.
  const lines = [];
  for (const raw of rawLines) {
    const line = raw.trim();
    if (!line) continue;
    const variants = [line, line.split(/\s+/).reverse().join(' '), fixHebrew(line)];
    for (const v of variants) if (!lines.includes(v)) lines.push(v);
  }

  for (const [field, labels] of Object.entries(FIELD_LABELS)) {
    if (fields[field] !== undefined) continue;
    outer:
    for (const line of lines) {
      for (const label of labels) {
        const at = line.indexOf(label);
        if (at === -1) continue;
        const nums = numbersIn(line);
        if (!nums.length) continue;
        let picked;
        if (COUNT_FIELDS.has(field)) {
          // ספירה (נקודות זיכוי, שעות) — המספר הראשון בטווח סביר
          picked = nums.find((n) => n.value >= 0 && n.value <= 400)?.value;
        } else if (field === 'gross') {
          // שורת סה"כ תשלומים מכילה גם סכומי-ביניים (שווי למס) — הברוטו הוא הגדול
          picked = nums.reduce((a, b) => (Math.abs(b.value) > Math.abs(a.value) ? b : a)).value;
        } else {
          // בטבלת תלוש הערך צמוד אחרי התווית; אם אין (התווית בסוף השורה
          // בווריאנט ההפוך) — המספר הקרוב ביותר לפניה
          const after = nums.find((n) => n.index >= at + label.length);
          const before = nums.filter((n) => n.index < at).pop();
          picked = (after ?? before)?.value;
        }
        if (picked === undefined || picked === 0) continue;
        fields[field] = Math.abs(picked);
        break outer;
      }
    }
  }

  const expected = Object.keys(FIELD_LABELS).length;
  const confidence = Math.round((Object.keys(fields).length / expected) * 100);
  return { fields, confidence };
}

/* ---------- הסרת פרטים מזהים ---------- */
// חשוב: מוסר בקוד ולא ע"י הוראה ל-LLM. סכומים (עם נקודה עשרונית או פסיק
// אלפים) לא נפגעים — רק רצפי ספרות "יבשים".
const PII_RULES = [
  // שורות שלמות שמכילות כתובת — מוסרות כולן
  { line: /רחוב|רח['׳]\s|ת\.ד|מיקוד|כתובת/, replace: () => '[כתובת הוסרה]' },
  // ת"ז — 9 ספרות רצופות, או שורה עם תווית ת.ז
  { line: /ת\.?\s?ז\.?|תעודת זהות|מספר זהות|ת"ז/, digits: /\b\d{5,9}\b/g, mask: '[ת"ז הוסר]' },
  { anyLine: true, digits: /\b\d{9}\b/g, mask: '[ת"ז הוסר]' },
  // חשבון בנק / סניף
  { line: /בנק|סניף|חשבון|חש-ן|חשבון בנק/, digits: /\b\d{3,}\b/g, mask: '[מספר הוסר]' },
  // מספרי עמית/פוליסה בקופות
  { line: /עמית|פוליסה|קופ["׳']?ג|מס['׳] קופה|קרן פנסיה/, digits: /\b\d{5,}\b/g, mask: '[מספר הוסר]' },
  // טלפון
  { anyLine: true, digits: /\b0\d{1,2}[- ]?\d{7}\b/g, mask: '[טלפון הוסר]' },
];

/**
 * הסרת פרטים מזהים מטקסט התלוש לפני שליחה לשירות חיצוני.
 * מחזיר { text, removed } — removed = כמה החלפות בוצעו.
 */
export function stripPii(text) {
  let removed = 0;
  const out = String(text || '').split('\n').map((line) => {
    let cur = line;
    for (const rule of PII_RULES) {
      const relevant = rule.anyLine || rule.line.test(cur) || (rule.line.test(fixHebrew(cur)));
      if (!relevant) continue;
      if (rule.replace) { removed++; return rule.replace(); }
      cur = cur.replace(rule.digits, (m) => {
        // לא נוגעים במספר שהוא חלק מסכום (יש לידו נקודה עשרונית/פסיק אלפים)
        if (/[.,]\d/.test(m)) return m;
        removed++;
        return rule.mask;
      });
    }
    return cur;
  }).join('\n');
  return { text: out, removed };
}

/**
 * הסרת מזהים חד-משמעיים בלבד (ת"ז בת 9 ספרות, מספר טלפון) — הכללים שאינם
 * תלויים במילת הקשר בשורה. מיועד לטקסט חופשי שהמשתמש כותב בעצמו (שאלה בצ׳אט
 * החופשי, server/lib/assistant.js): שם הרצת stripPii המלאה הייתה הרסנית —
 * הכלל תלוי-ההקשר ("בנק"/"חשבון"/"הלוואה" + רצף ספרות) ממסך גם שנה כמו 2026
 * וגם סכום כמו 850, ושובר את השאלה. הנתונים מה-DB עוברים ניקוי מלא בנפרד.
 */
export function stripIdentifiers(text) {
  let removed = 0;
  let out = String(text ?? '');
  for (const rule of PII_RULES) {
    if (!rule.anyLine || !rule.digits) continue;
    out = out.replace(rule.digits, (m) => {
      if (/[.,]\d/.test(m)) return m;   // חלק מסכום — לא נוגעים
      removed++;
      return rule.mask;
    });
  }
  return { text: out, removed };
}

/* ---------- בדיקות שפיות ---------- */
const has = (v) => typeof v === 'number' && Number.isFinite(v);
const pct = (part, whole) => (whole ? (part / whole) * 100 : null);
const fmt = (n) => new Intl.NumberFormat('he-IL', { maximumFractionDigits: 2 }).format(n);

/**
 * בדיקות דטרמיניסטיות על השדות שחולצו. prevFields = שדות התלוש הקודם (אופציונלי).
 * כל בדיקה: { id, label, status: 'ok'|'warn'|'fail', detail }.
 * בדיקה שחסרים לה נתונים פשוט לא מוחזרת (לא מדווחים "כשל" על מידע חסר).
 */
export function runChecks(fields = {}, prevFields = null) {
  const checks = [];
  const f = fields;

  // 1) ברוטו פחות ניכויים ≈ נטו. אם התלוש מציג "סה"כ ניכויי חובה" — הוא
  // הסמכותי; אחרת סוכמים את הרכיבים שזוהו.
  if (has(f.gross) && has(f.net)) {
    const deductions = has(f.deductions_total)
      ? f.deductions_total
      : ['income_tax', 'national_insurance', 'health_tax', 'pension_employee', 'study_fund_employee']
        .reduce((s, k) => s + (has(f[k]) ? f[k] : 0), 0);
    const diff = f.gross - deductions - f.net;
    const abs = Math.abs(diff);
    checks.push({
      id: 'net_math',
      label: 'ברוטו פחות ניכויים מול נטו',
      status: abs <= 5 ? 'ok' : abs <= 50 ? 'warn' : 'fail',
      detail: abs <= 5
        ? `החישוב מסתדר (${fmt(f.gross)} − ${fmt(deductions)} = ${fmt(f.net)})`
        : `פער של ${fmt(abs)} ₪ בין הנטו המחושב (${fmt(f.gross - deductions)}) לנטו בתלוש (${fmt(f.net)}) — ייתכנו ניכויים נוספים שלא זוהו`,
    });
  }

  // 2) שיעור הפרשת פנסיה — הבסיס: השכר המבוטח אם זוהה, אחרת הברוטו.
  // עובד ~6%; מעביד 6.5% תגמולים, ולעתים הסכום בתלוש כולל גם פיצויים (עד ~8.33%
  // נוספים) — לכן טווח רחב.
  const pensionBase = has(f.insured_salary) ? f.insured_salary : f.gross;
  const baseName = has(f.insured_salary) ? 'מהשכר המבוטח' : 'מהברוטו';
  if (has(pensionBase) && has(f.pension_employee)) {
    const p = pct(f.pension_employee, pensionBase);
    checks.push({
      id: 'pension_employee_rate',
      label: 'שיעור הפרשת עובד לפנסיה',
      status: p >= 5.5 && p <= 7.5 ? 'ok' : 'warn',
      detail: `${p.toFixed(2)}% ${baseName} (הטווח המקובל: 6%–7%)`,
    });
  }
  if (has(pensionBase) && has(f.pension_employer)) {
    const p = pct(f.pension_employer, pensionBase);
    checks.push({
      id: 'pension_employer_rate',
      label: 'שיעור הפרשת מעביד לפנסיה',
      status: p >= 6 && p <= 15.5 ? 'ok' : 'warn',
      detail: `${p.toFixed(2)}% ${baseName} (תגמולים לבדם: 6.5%–8.5%; עם פיצויים: עד ~15%)`,
    });
  }

  // 3) ניכויי חובה קיימים
  if (has(f.gross) && f.gross > 2000) {
    for (const [key, label] of [['national_insurance', 'ביטוח לאומי'], ['health_tax', 'דמי בריאות']]) {
      if (!has(f[key])) {
        checks.push({ id: `missing_${key}`, label, status: 'warn', detail: `לא זוהה ניכוי ${label} בתלוש — ודא שהוא קיים` });
      }
    }
  }

  // 4) שינוי מול החודש הקודם
  if (prevFields) {
    for (const [key, label] of [['gross', 'ברוטו'], ['net', 'נטו']]) {
      if (!has(f[key]) || !has(prevFields[key])) continue;
      const delta = pct(f[key] - prevFields[key], prevFields[key]);
      if (Math.abs(delta) > 10) {
        checks.push({
          id: `mom_${key}`,
          label: `שינוי ב${label} מול החודש הקודם`,
          status: 'warn',
          detail: `${delta > 0 ? '+' : ''}${delta.toFixed(1)}% (${fmt(prevFields[key])} ← ${fmt(f[key])})`,
        });
      }
    }
    if (has(f.credit_points) && has(prevFields.credit_points) && f.credit_points !== prevFields.credit_points) {
      checks.push({
        id: 'credit_points_change',
        label: 'שינוי בנקודות זיכוי',
        status: 'warn',
        detail: `${prevFields.credit_points} ← ${f.credit_points} — ודא שהשינוי מוצדק`,
      });
    }
  }

  return checks;
}

/* ---------- פרומפט לניתוח ---------- */
const FIELD_NAMES_HE = {
  gross: 'שכר ברוטו', net: 'שכר נטו', deductions_total: 'סה"כ ניכויי חובה',
  insured_salary: 'שכר מבוטח', base_salary: 'שכר יסוד',
  income_tax: 'מס הכנסה', national_insurance: 'ביטוח לאומי', health_tax: 'דמי בריאות',
  pension_employee: 'פנסיה — חלק העובד', pension_employer: 'פנסיה — חלק המעביד',
  severance: 'פיצויים', study_fund_employee: 'קרן השתלמות — עובד',
  study_fund_employer: 'קרן השתלמות — מעביד', credit_points: 'נקודות זיכוי', hours: 'שעות/ימי עבודה',
};

export function fieldsSummary(fields = {}) {
  const parts = Object.entries(fields)
    .filter(([, v]) => has(v))
    .map(([k, v]) => `${FIELD_NAMES_HE[k] ?? k}: ${fmt(v)}`);
  return parts.join(' | ') || '(לא חולצו שדות)';
}

/**
 * בניית הפרומפט לניתוח התלוש. מקבל את השדות שחולצו, את הטקסט לאחר הסרת
 * פרטים מזהים, ואת חודש התלוש; prevFields = תלוש קודם להשוואה (אופציונלי).
 */
export function buildAnalysisPrompt(fields, strippedText, month, prevFields = null) {
  const taxYear = month ? month.slice(0, 4) : 'שנת התלוש';
  const prev = prevFields ? `\n## תלוש החודש הקודם (להשוואה)\n${fieldsSummary(prevFields)}\n` : '';
  return `אתה מומחה לחשבות שכר ולדיני עבודה ומיסוי בישראל. נתח את תלוש השכר המצורף באופן מקצועי, יסודי ומדויק.

## כללי עבודה
- הסתמך על דיני העבודה והמיסוי בישראל בלבד, לפי שנת המס ${taxYear} (חודש התלוש: ${month || 'לא ידוע'}).
- אל תניח הנחות. כשפרט חסר או לא ברור — ציין זאת במפורש, וכתוב אילו נתונים או מסמכים נוספים נדרשים.
- הפרד בבירור בין: עובדות שמופיעות בתלוש, חישובים שביצעת בעצמך, והערכות שדורשות אימות.
- אל תציג מסקנה משפטית או חשבונאית ודאית ללא בסיס. כשראוי — המלץ לפנות לחשב שכר, יועץ מס או עורך דין לדיני עבודה.
- הטקסט עבר עיבוד אוטומטי מ-PDF וייתכנו בו שיבושי סדר מילים בעברית. פרש בהיגיון; אם ערך נראה בלתי סביר, ציין שייתכן שיבוש קריאה במקום להסיק טעות בתלוש.
- פרטים מזהים (ת"ז, חשבון בנק, כתובת) הוסרו מראש — התעלם מהסימונים במקומם.

## כללי עיצוב הפלט (חובה)
- **אסור להשתמש בסימון LaTeX או מתמטי כלשהו**: בלי \\text, \\mathbf, \\frac, \\times, \\approx, ובלי סימני $ או \\( \\). כתוב נוסחאות כטקסט רגיל: "22,365.76 − 5,566.76 = 16,799.00 ש"ח".
- סכומים בפורמט ישראלי עם פסיק אלפים וסימן ש"ח: 16,799.00 ש"ח.
- השתמש בטבלאות Markdown להשוואות ולפירוט רכיבים — הן מוצגות יפה בממשק.
- הדגש מספרי מפתח ב-**מודגש**. אל תשתמש בכותרות מעבר לרמות ## ו-###.
- מין המשתמש אינו ידוע — נסח בלשון ניטרלית ("כדאי לבדוק", "מומלץ לפנות") ולא בזכר או בנקבה.

## מבנה הפלט (Markdown, עברית, בסדר הזה בדיוק)
## הסבר רכיבים
הסבר בשפה פשוטה כל רכיב: שכר יסוד, שעות עבודה, שעות נוספות, החזרים, תוספות, בונוסים, ניכויי חובה וניכויי רשות.
## בדיקת חישובים
בדוק את תקינות החישובים: ברוטו, שכר חייב במס, מס הכנסה, ביטוח לאומי, דמי בריאות והנטו. הצג את החישוב עצמו.
## הפרשות פנסיה וקרן השתלמות
פנסיה, פיצויים, קרן השתלמות וכל קופה נוספת — השווה בין חלק העובד, חלק המעביד והשכר המבוטח.
## נקודות זיכוי
האם נקודות הזיכוי מנוצלות כראוי, והאם ייתכן שמגיע החזר מס או תיאום מס.
## זכויות סוציאליות
חופשה, מחלה, הבראה, נסיעות, שעות נוספות, עבודה בחגים/שבתות/לילות — ככל שהן רלוונטיות ומופיעות.
## חריגות
סכומים חריגים, ניכויים לא מוסברים, הפרשות חסרות, פערים בין הברוטו, השכר המבוטח והנטו.
## דירוג ממצאים
רשימה שבה כל ממצא מדורג: ✅ תקין / 🟡 דורש בירור / 🔴 חשד לטעות.
## תוכנית פעולה
למי לפנות, מה לשאול, אילו מסמכים לבקש, ואיך לוודא קבלת מלוא הזכויות.
## טיוטת הודעה למחלקת שכר
הודעה קצרה ומקצועית שאפשר לשלוח כפי שהיא, אם נמצא פער.
## סיכום
מה תקין, מה דורש בדיקה, כמה כסף עשוי להיות מושפע, ומה הפעולות הנדרשות.

## שדות שחולצו אוטומטית מהתלוש
${fieldsSummary(fields)}
${prev}
## טקסט התלוש המלא
${strippedText}`;
}

/**
 * פרומפט לשאלת המשך חופשית על התלוש. מקבל את הניתוח הקודם ואת היסטוריית
 * השאלות, כדי שהמודל יענה בהקשר ולא יחזור על עצמו.
 */
export function buildQuestionPrompt({ question, fields, strippedText, month, analysisMd, history = [] }) {
  const prior = history.length
    ? '\n## שאלות קודמות בשיחה הזו\n' + history.map((h, i) => `${i + 1}. ש: ${h.q}\n   ת: ${h.a}`).join('\n') + '\n'
    : '';
  const analysis = analysisMd ? `\n## הניתוח שכבר ניתן על התלוש\n${analysisMd}\n` : '';
  return `אתה מומחה לחשבות שכר ולדיני עבודה ומיסוי בישראל. המשתמש שואל שאלת המשך על תלוש השכר שלו לחודש ${month}.

## כללי מענה
- ענה ישירות ולעניין על השאלה שנשאלה בלבד. אל תחזור על הניתוח המלא.
- הסתמך על הנתונים בתלוש ועל דיני העבודה והמיסוי בישראל לשנת המס ${month ? month.slice(0, 4) : ''}.
- כשהתשובה דורשת נתון שאינו בתלוש — אמור זאת במפורש וציין מה נדרש כדי לענות.
- הפרד בין עובדה מהתלוש, חישוב שביצעת, והערכה שדורשת אימות.
- **אסור סימון LaTeX או מתמטי**: בלי \\text, \\mathbf, \\frac, \\times, וללא $. נוסחאות כטקסט רגיל.
- מין המשתמש אינו ידוע — נסח בלשון ניטרלית ("כדאי לבדוק", "מומלץ לפנות") ולא בזכר או בנקבה.
- סכומים בפורמט ישראלי (16,799.00 ש"ח). Markdown, עברית. תשובה תמציתית — עד כמה פסקאות או טבלה קצרה.

## שדות שחולצו מהתלוש
${fieldsSummary(fields)}
${analysis}${prior}
## טקסט התלוש המלא
${strippedText}

## השאלה
${question}`;
}

/* ---------- אחסון ---------- */
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** החודש שלפני 'YYYY-MM' */
export function prevMonth(month) {
  const [y, m] = month.split('-').map(Number);
  const d = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  return `${d.y}-${String(d.m).padStart(2, '0')}`;
}

/** שדות התלוש של חודש נתון (או null) — לשימוש בהשוואות */
export function payslipFields(month) {
  const row = db.prepare('SELECT fields_json FROM payslips WHERE month = ?').get(month);
  if (!row) return null;
  try { return JSON.parse(row.fields_json); } catch { return null; }
}

/**
 * הזרימה המלאה של קליטת תלוש: חילוץ טקסט כבר בוצע ע"י הקורא (extractPdfText).
 * שומר/מעדכן את שורת החודש; העלאה חוזרת מאפסת את הניתוח הקודם (הוא כבר לא רלוונטי).
 * מחזיר { month, fields, checks, confidence, piiRemoved, replaced }.
 */
export function storePayslip({ buf, filename, month, text }) {
  const { text: clean, removed } = stripPii(text);
  const { fields, confidence } = parsePayslipText(text);
  const prev = payslipFields(prevMonth(month));
  const checks = runChecks(fields, prev);
  const existing = db.prepare('SELECT id FROM payslips WHERE month = ?').get(month);

  db.prepare(`
    INSERT INTO payslips (month, filename, pdf, extracted_text, fields_json, checks_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(month) DO UPDATE SET
      filename = excluded.filename,
      pdf = excluded.pdf,
      extracted_text = excluded.extracted_text,
      fields_json = excluded.fields_json,
      checks_json = excluded.checks_json,
      analysis_md = NULL,
      analysis_at = NULL,
      analysis_model = NULL,
      uploaded_at = datetime('now','localtime')
  `).run(month, filename || '', buf, clean, JSON.stringify(fields), JSON.stringify(checks));

  return { month, fields, checks, confidence, piiRemoved: removed, replaced: Boolean(existing) };
}

/** פירוט תלוש לחודש (בלי ה-BLOB) + הפרומפט המוכן להעתקה */
export function payslipDetail(month) {
  const row = db.prepare(`
    SELECT month, filename, extracted_text, fields_json, checks_json,
           analysis_md, analysis_at, analysis_model, uploaded_at, qa_json
    FROM payslips WHERE month = ?
  `).get(month);
  if (!row) return null;
  const fields = JSON.parse(row.fields_json);
  const prev = payslipFields(prevMonth(month));
  return {
    month: row.month,
    filename: row.filename,
    fields,
    checks: JSON.parse(row.checks_json),
    analysis_md: row.analysis_md,
    analysis_at: row.analysis_at,
    analysis_model: row.analysis_model,
    uploaded_at: row.uploaded_at,
    qa: JSON.parse(row.qa_json || '[]'),
    prompt: buildAnalysisPrompt(fields, row.extracted_text, row.month, prev),
  };
}

/**
 * ניקוי סימון LaTeX מפלט המודל (הוא מחליק לשם למרות ההוראה בפרומפט).
 * גרסת טקסט-בלבד לטלגרם; ה-web מריץ לוגיקה זהה ברמת הרינדור (stripLatex ב-app.js)
 * — שינוי כאן מחייב שינוי מקביל שם.
 *
 * הפקודות עם סוגריים מוסרות בלולאה כי הן מקוננות בפועל:
 * "\mathbf{23,356.43 \text{ש"ח}}" — regex יחיד עם [^{}] לא תופס את החיצונית.
 */
const LATEX_CMD = /\\(?:text|mathbf|mathrm|textbf|mathit|textit|operatorname)\s*\{([^{}]*)\}/g;
const LATEX_FRAC = /\\(?:d)?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g;

export function stripLatexPlain(s) {
  let out = String(s ?? '')
    .replace(/\$\$([\s\S]*?)\$\$/g, '$1')   // בלוק מתמטי
    .replace(/\\\[([\s\S]*?)\\\]/g, '$1')
    .replace(/\\\(([\s\S]*?)\\\)/g, '$1')
    .replace(/\$([^$\n]+)\$/g, '$1');       // מתמטיקה בשורה
  let prev;
  do {
    prev = out;
    out = out.replace(LATEX_FRAC, '($1 ÷ $2)').replace(LATEX_CMD, '$1');
  } while (out !== prev);
  return out
    // שארית פקודה בלי סוגריים סגורים — קורה כשתשובת המודל נקטעה באמצע token
    .replace(/\\(?:text|mathbf|mathrm|textbf|mathit|textit|operatorname|d?frac)\b\s*/g, '')
    .replace(/\\times/g, '×').replace(/\\div/g, '÷')
    .replace(/\\approx/g, '≈').replace(/\\ne(?:q)?\b/g, '≠')
    .replace(/\\le(?:q)?\b/g, '≤').replace(/\\ge(?:q)?\b/g, '≥')
    .replace(/\\pm/g, '±').replace(/\\cdot/g, '·')
    .replace(/\\rightarrow|\\to\b/g, '←')
    .replace(/\\%/g, '%').replace(/\\\$/g, '₪')
    .replace(/\\[,;:!]/g, ' ')
    .replace(/\\\\/g, '\n')
    .replace(/\{|\}/g, '')                  // סוגריים מסולסלים שנותרו
    .replace(/[ \t]{2,}/g, ' ');            // רווחים כפולים שנוצרו מההסרה
}

/** פיצול טקסט ארוך להודעות טלגרם (מגבלה 4096) — שובר בגבולות פסקה */
export function splitMessage(text, max = 3900) {
  const chunks = [];
  let rest = String(text ?? '');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
