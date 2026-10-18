// mortgageSim.js — סימולציית "מה יקרה אם" על המשכנתא: תוספת להחזר החודשי,
// פירעון חד-פעמי, וסיכון עליית ריבית. כל הפונקציות טהורות (בלי DB ובלי רשת),
// בדיוק כמו שאר הלוגיקה ב-server/lib/mortgage.js.
//
// המודל עובד ב**ערכים נומינליים** עם הנחת מדד מפורשת, ולא ב"שקלים של היום":
// המשתמש חושב במונחים של "אוסיף עוד 500 ש"ח בחודש" — סכום נומינלי קבוע —
// ובמסלול צמוד גם היתרה וגם ההחזר עולים עם המדד. חישוב ריאלי היה מסתיר בדיוק
// את האפקט שההיסטוריה השנתית מראה: הקרן כמעט לא יורדת כי ההצמדה רצה במקביל.

const MAX_MONTHS = 720;            // 60 שנה — גדר ביטחון מפני לולאה אינסופית
const EPS = 0.005;                 // חצי אגורה — מתחת לזה המסלול נחשב סגור

const has = (v) => typeof v === 'number' && Number.isFinite(v);

/** ריבית חודשית מתוך ריבית שנתית באחוזים */
const monthlyRate = (annualPct) => (annualPct ?? 0) / 100 / 12;

/** שיעור ההצמדה החודשי מתוך אינפלציה שנתית באחוזים (ריבית דריבית, לא חלוקה ב-12) */
export function monthlyCpi(annualPct) {
  const a = has(annualPct) ? annualPct : 0;
  return (1 + a / 100) ** (1 / 12) - 1;
}

/**
 * תשלום שפיצר (annuity) — ההחזר החודשי הקבוע שסוגר את היתרה בדיוק בתום התקופה.
 * זו הנוסחה שהבנק מפעיל כשריבית משתנה מתעדכנת: התקופה נשמרת וההחזר משתנה.
 */
export function annuityPayment(balance, annualPct, months) {
  if (!has(balance) || balance <= 0 || !has(months) || months <= 0) return null;
  const i = monthlyRate(annualPct);
  if (i <= 0) return balance / months;
  const f = (1 + i) ** months;
  return (balance * i * f) / (f - 1);
}

/**
 * מספר החודשים עד לסגירת יתרה בתשלום חודשי קבוע (נוסחה סגורה, בלי הצמדה).
 * מחזיר null כשהתשלום אינו מכסה אפילו את הריבית החודשית — אז החוב רק גדל.
 */
export function monthsToPayoff(balance, annualPct, payment) {
  if (!has(balance) || balance <= 0 || !has(payment) || payment <= 0) return null;
  const i = monthlyRate(annualPct);
  if (i <= 0) return Math.ceil(balance / payment);
  if (payment <= balance * i) return null;      // ריבית בלבד — לעולם לא ייסגר
  return Math.ceil(-Math.log(1 - (balance * i) / payment) / Math.log(1 + i));
}

/**
 * ההחזר החודשי של מסלול לצורך הסימולציה.
 * מעדיפים את ההחזר שהמשתמש הזין מדוח הבנק (זה מה שיורד בפועל מהחשבון);
 * בהיעדרו מחשבים שפיצר מהיתרה, הריבית והתקופה.
 */
export function trackPayment(t = {}) {
  if (has(t.monthly_payment) && t.monthly_payment > 0) return t.monthly_payment;
  return annuityPayment(t.balance, t.rate, t.remaining_months);
}

/** מסלול שאפשר לסמלץ — חייב יתרה, ריבית והחזר חודשי כלשהו */
export function simulatableTracks(tracks = []) {
  const usable = [];
  const skipped = [];
  for (const t of Array.isArray(tracks) ? tracks : []) {
    const payment = trackPayment(t);
    if (has(t.balance) && t.balance > 0 && has(t.rate) && has(payment) && payment > 0) {
      usable.push({ ...t, payment });
    } else {
      skipped.push(t?.name ?? 'מסלול ללא שם');
    }
  }
  return { usable, skipped };
}

// הריבית האפקטיבית לצורך סדר העדיפויות של הכסף הנוסף. במסלול צמוד העלות
// האמיתית היא הריבית + קצב המדד — אחרת מסלול צמוד 3.25% היה נראה זול ממסלול
// פריים 4.6% גם כשהוא יקר ממנו בפועל.
const effectiveRate = (t, cpiAnnual) => t.rate + (t.cpi_linked ? (cpiAnnual ?? 0) : 0);

/**
 * הפחתת פירעון חד-פעמי מהמסלולים, לפי אותו סדר עדיפויות של הכסף החודשי
 * (היקר ביותר קודם). מוצא כמימוש יחיד כדי ששני הצרכנים ישתמשו באותה חלוקה:
 * `simulatePlan` (ההרצה עצמה) ו-`buildSimulation` (תמחור מחדש לתרחיש ריבית —
 * הבנק מחשב את ההחזר על היתרה **שאחרי** הפירעון).
 */
export function applyLumpSum(tracks = [], lumpSum = 0, cpiAnnual = 0) {
  const out = tracks.map((t) => ({ ...t }));
  let left = has(lumpSum) && lumpSum > 0 ? lumpSum : 0;
  if (!left) return { tracks: out, applied: new Map(), total: 0 };
  const applied = new Map();
  const byPrice = out.slice().sort((a, b) => effectiveRate(b, cpiAnnual) - effectiveRate(a, cpiAnnual));
  let total = 0;
  for (const t of byPrice) {
    if (left <= EPS) break;
    const take = Math.min(left, t.balance);
    if (take <= EPS) continue;
    t.balance -= take;
    left -= take;
    total += take;
    applied.set(t.name ?? 'מסלול', take);
  }
  return { tracks: out, applied, total };
}

/**
 * הרצת התוכנית חודש-אחר-חודש על כל המסלולים במקביל.
 *
 * opts:
 *   extraMonthly — תוספת קבועה (נומינלית) להחזר, מנותבת למסלול היקר ביותר
 *   lumpSum      — סכום חד-פעמי בחודש הראשון, לאותו מסלול
 *   cpiAnnual    — הנחת אינפלציה שנתית באחוזים (משפיעה רק על מסלולים צמודים)
 *   rollover     — כשמסלול נסגר, ההחזר שהתפנה ממשיך למסלול הבא (ברירת מחדל: כן)
 *
 * תרחיש עליית ריבית אינו פרמטר כאן — הוא נבנה ב-buildSimulation כמסלולים
 * מתומחרים מחדש (`repriceForShock`), כי עליית ריבית משנה גם את הריבית וגם את
 * ההחזר, ושתי ההשפעות חייבות להיכנס לאותה הרצה.
 */
export function simulatePlan(tracks = [], opts = {}) {
  const {
    extraMonthly = 0, lumpSum = 0, cpiAnnual = 0, rollover = true,
  } = opts;

  const cpiM = monthlyCpi(cpiAnnual);
  // הפירעון החד-פעמי יורד מהיתרות לפני התשלום הראשון, ונספר כסכום ששולם
  const lump = applyLumpSum(tracks, lumpSum, cpiAnnual);
  const state = lump.tracks.map((t) => ({
    name: t.name ?? 'מסלול',
    linked: t.cpi_linked === 1,
    rate: t.rate,
    balance: t.balance,
    payment: t.payment,
    order: effectiveRate(t, cpiAnnual),
    months: 0, interest: 0, indexation: 0,
    paid: lump.applied.get(t.name ?? 'מסלול') ?? 0,
  }));

  // סדר העדיפויות של הכסף הנוסף — היקר ביותר ראשון (שיטת ה"מפולת")
  const priority = state.slice().sort((a, b) => b.order - a.order);
  const open = () => priority.find((s) => s.balance > EPS);

  let month = 0;
  let freed = 0;                  // החזרים של מסלולים שנסגרו (rollover)
  let firstMonthOutlay = 0;
  let capped = false;

  while (state.some((s) => s.balance > EPS)) {
    if (++month > MAX_MONTHS) { capped = true; break; }

    // 1) הצמדה: במסלול צמוד גם הקרן וגם ההחזר עולים עם המדד
    for (const s of state) {
      if (!s.linked || s.balance <= EPS) continue;
      const add = s.balance * cpiM;
      s.balance += add;
      s.indexation += add;
      s.payment *= 1 + cpiM;
    }

    // 2) ההחזר השוטף של כל מסלול
    let outlay = 0;
    for (const s of state) {
      if (s.balance <= EPS) continue;
      const interest = s.balance * monthlyRate(s.rate);
      const due = s.balance + interest;
      const pay = Math.min(s.payment, due);
      s.balance = due - pay;
      s.interest += interest;
      s.paid += pay;
      s.months = month;
      outlay += pay;
      if (s.balance <= EPS && rollover) freed += s.payment;
    }

    // 3) הכסף הנוסף — לכיוון המסלול היקר ביותר שעדיין פתוח
    let pool = (has(extraMonthly) && extraMonthly > 0 ? extraMonthly : 0) + (rollover ? freed : 0);
    while (pool > EPS) {
      const target = open();
      if (!target) break;
      const applied = Math.min(pool, target.balance);
      target.balance -= applied;
      target.paid += applied;
      target.months = month;
      outlay += applied;
      pool -= applied;
      if (target.balance <= EPS && rollover) freed += target.payment;
    }

    if (month === 1) firstMonthOutlay = outlay;
  }

  const sum = (k) => state.reduce((a, s) => a + s[k], 0);
  return {
    months: capped ? null : month,
    capped,
    firstMonthOutlay,
    totalPaid: sum('paid'),
    totalInterest: sum('interest'),
    totalIndexation: sum('indexation'),
    perTrack: state.map((s) => ({
      name: s.name, months: s.months, paid: s.paid,
      interest: s.interest, indexation: s.indexation,
    })),
  };
}

/** חודשים → "X שנים ו-Y חודשים" (יחיד/רבים תקין: "שנה", "חודש") */
export function monthsHe(m) {
  if (!has(m)) return 'לא נסגר';
  const y = Math.floor(m / 12);
  const r = m % 12;
  const ys = y === 1 ? 'שנה' : `${y} שנים`;
  const rs = r === 1 ? 'חודש' : `${r} חודשים`;
  if (!y) return rs;
  if (!r) return ys;
  // מקף אחרי ו' רק לפני ספרה ("ו-8 חודשים"); לפני מילה הוא"ו נצמדת ("וחודש")
  return `${ys} ${/^\d/.test(rs) ? 'ו-' : 'ו'}${rs}`;
}

/** תאריך הסיום הצפוי (YYYY-MM) בעוד m חודשים מהיום */
export function endMonth(m, from = new Date()) {
  if (!has(m)) return null;
  const d = new Date(from.getFullYear(), from.getMonth() + m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ברירת מחדל להנחת האינפלציה — יעד בנק ישראל הוא 1%-3%, האמצע 2%.
export const DEFAULT_CPI = 2;
// תרחישי עליית הריבית שמוצגים תמיד (נקודות אחוז מעל המצב הנוכחי)
export const RATE_SHOCKS = [1, 2];

// מסלולים שהריבית בהם אינה נעולה — רק הם מושפעים מעליית ריבית
const VARIABLE_TYPES = new Set(['prime', 'variable_linked', 'variable_unlinked']);

/**
 * תמחור מחדש של המסלולים לתרחיש עליית ריבית.
 * כך הבנק פועל בפועל: התקופה נשמרת וההחזר עולה — ולכן חייבים לעדכן גם את
 * הריבית וגם את ההחזר. (בגרסה קודמת רק הריבית עודכנה, וההחזר נשאר כשהיה;
 * התוצאה הייתה הארכת התקופה במקום ייקור ההחזר — סתירה למה שהטבלה מציגה.)
 */
export function repriceForShock(tracks = [], shock = 0) {
  if (!shock) return tracks;
  return tracks.map((t) => {
    if (!VARIABLE_TYPES.has(t.type)) return t;
    const rate = t.rate + shock;
    const months = has(t.remaining_months) && t.remaining_months > 0
      ? t.remaining_months
      : monthsToPayoff(t.balance, t.rate, t.payment);
    return { ...t, rate, payment: annuityPayment(t.balance, rate, months) ?? t.payment };
  });
}

/**
 * הסימולציה המלאה: מצב קיים מול מצב עם התוספת, ההפרש ביניהם, ותרחישי ריבית.
 * זו הפונקציה שה-API קורא לה.
 */
export function buildSimulation({
  tracks = [], extraMonthly = 0, lumpSum = 0,
  cpiAnnual = DEFAULT_CPI, rollover = true,
} = {}) {
  const { usable, skipped } = simulatableTracks(tracks);
  if (!usable.length) {
    return {
      ok: false,
      error: 'אין מסלולים עם יתרה, ריבית והחזר חודשי — אי אפשר לחשב',
      skipped,
    };
  }

  const base = { cpiAnnual, rollover: false };                    // מצב קיים: בלי תוספת ובלי גלגול
  const plan = { extraMonthly, lumpSum, cpiAnnual, rollover };

  const baseline = simulatePlan(usable, base);
  const withExtra = simulatePlan(usable, plan);

  const currentPayment = usable.reduce((a, t) => a + t.payment, 0);

  // תרחישי ריבית — מורצים על **אותה תוכנית** שהמשתמש הזין (תוספת ופירעון
  // כלולים), כדי שהטבלה תגיב לשדות ולא תציג מספרים סטטיים.
  // הבנק מתמחר את ההחזר על היתרה שאחרי הפירעון החד-פעמי — ולכן הפירעון מזיז
  // גם את שורות תרחיש הריבית, לא רק את הכרטיסים למעלה
  const afterLump = applyLumpSum(usable, lumpSum, cpiAnnual).tracks;
  const rateRisk = RATE_SHOCKS.map((shock) => {
    const shockedTracks = repriceForShock(afterLump, shock);
    // ההרצה עצמה מקבלת את המסלולים המקוריים (הפירעון מיושם בתוכה), עם
    // הריבית וההחזר המתומחרים מחדש
    const shocked = simulatePlan(
      repriceForShock(usable, shock).map((t, i) => ({ ...t, payment: shockedTracks[i].payment })),
      plan,
    );
    const newPayment = shockedTracks.reduce((a, t) => a + t.payment, 0);
    return {
      shock,
      affectedBalance: afterLump.filter((t) => VARIABLE_TYPES.has(t.type))
        .reduce((a, t) => a + t.balance, 0),
      monthlyPayment: newPayment,                        // מה שהבנק יגבה
      monthlyDelta: newPayment - currentPayment,
      totalMonthly: newPayment + (extraMonthly || 0),    // כולל התוספת שלך
      months: shocked.months,                            // עם התוספת והפירעון
      monthsDelta: has(shocked.months) && has(withExtra.months)
        ? shocked.months - withExtra.months : null,
      totalPaid: shocked.totalPaid,
      extraCost: shocked.totalPaid - withExtra.totalPaid,
    };
  });

  const monthsSaved = has(baseline.months) && has(withExtra.months)
    ? baseline.months - withExtra.months : null;

  return {
    ok: true,
    skipped,
    cpiAnnual,
    rollover,
    extraMonthly,
    lumpSum,
    currentPayment,
    baseline,
    withExtra,
    diff: {
      monthsSaved,
      // כמה פחות כסף יוצא מהכיס בסך הכול (כולל התוספת ששולמה)
      totalSaved: baseline.totalPaid - withExtra.totalPaid,
      interestSaved: (baseline.totalInterest + baseline.totalIndexation)
        - (withExtra.totalInterest + withExtra.totalIndexation),
    },
    rateRisk,
  };
}
