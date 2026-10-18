// MoneySaver — SPA: דשבורד, עסקאות, ייבוא, קטגוריות, הכנסות, חיזוי, הגדרות
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const fmtILS = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });
const fmtMonth = new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric' });

function localMonth(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function localDate(d = new Date()) {
  return `${localMonth(d)}-${String(d.getDate()).padStart(2, '0')}`;
}

// מחזור תזרים 10→10 (מקביל ל-server/lib/dates.js). ברירת מחדל יום עוגן 10.
const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const CYCLE_DAY = 10;
function cycleLabel(anchorMonth, cycleDay = CYCLE_DAY) {
  const [y, m] = anchorMonth.split('-').map(Number);
  const start = new Date(y, m - 1, cycleDay + 1);
  const end = new Date(y, m, cycleDay);
  return `${start.getDate()} ${HE_MONTHS[start.getMonth()]} – ${end.getDate()} ${HE_MONTHS[end.getMonth()]}`;
}
// הזזת חודש־עוגן ב-±k (מחזור שלם). YYYY-MM → YYYY-MM.
function shiftMonthStr(anchorMonth, k) {
  const [y, m] = anchorMonth.split('-').map(Number);
  return localMonth(new Date(y, m - 1 + k, 1));
}
// יום גרייס נוסף (D+1): ביום שאחרי סגירת המחזור עדיין לא הגיעו נתוני המחזור החדש,
// לכן ברירת המחדל נשארת על המחזור שזה עתה נסגר עוד יום אחד.
function cycleAnchorForToday(cycleDay = CYCLE_DAY, now = new Date()) {
  const a = now.getDate() > cycleDay + 1
    ? new Date(now.getFullYear(), now.getMonth(), 1)
    : new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return localMonth(a);
}

// המחזור שמוצג. ערך התחלה זמני בלבד — ב-boot() נשאב העוגן האמיתי מהשרת
// (`GET /api/flow/current`), כי הלקוח לא מכיר את `cycle_days` ולכן לא יכול
// לחשב לבד מתי המחזור נסגר. cycleAnchorForToday() המקומית היא רק fallback.
let currentMonth = cycleAnchorForToday();
let categories = [];
let charts = [];

// הודעת סטטוס מתחת לטופס. חייבת להיכתב **אחרי** render() — render מחליף את כל
// תוכן #view, וכל הודעה שנכתבה לפניו נמחקת מיד ולא נראית למשתמש.
function flashMsg(sel, text, cls) {
  const el = $(sel);
  if (!el) return;
  el.className = 'form-msg ' + cls;
  el.textContent = text;
}

/* ---------- API ---------- */
async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || (data.errors || []).join(', ') || 'שגיאת שרת');
  return data;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// צבע בטוח להזרקה ל-style: רק hex תקין, אחרת ברירת מחדל (מונע CSS-injection)
function safeColor(c) {
  return /^#[0-9a-fA-F]{3,8}$/.test(String(c ?? '')) ? c : '#8896a6';
}

function catOptions(selected = null, placeholder = 'ללא קטגוריה') {
  return `<option value="">${escapeHtml(placeholder)}</option>` + categories.map((c) =>
    `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${escapeHtml(c.icon)} ${escapeHtml(c.name)}</option>`).join('');
}

// הודעת אישור צפה קצרה. יושבת על document.body (ולא בתוך #view) כדי לשרוד
// render() מלא — למשל אחרי שיוך קטגוריה גורף שמרנדר את הטאב מחדש.
let toastTimer = null;
function toast(text) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

function destroyCharts() {
  charts.forEach((c) => c.destroy());
  charts = [];
}

function newChart(ctx, config) {
  const chart = new Chart(ctx, config);
  charts.push(chart);
  return chart;
}

Chart.defaults.font.family = "'Heebo', sans-serif";
Chart.defaults.color = '#8896a6';

/* ================= דשבורד ================= */
function arcPath(ratio) {
  const start = Math.PI, end = Math.PI * (1 - Math.max(0, Math.min(1, ratio)));
  const r = 82, cx = 100, cy = 104;
  const x1 = cx + r * Math.cos(start), y1 = cy - r * Math.sin(start);
  const x2 = cx + r * Math.cos(end), y2 = cy - r * Math.sin(end);
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${ratio > 0.5 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

async function viewDashboard(el) {
  el.innerHTML = `
    <div class="cycle-nav">
      <button class="btn-secondary" id="dashPrev">▶ מחזור קודם</button>
      <span class="cycle-total" id="dashCycleLabel"></span>
      <button class="btn-secondary" id="dashNext">מחזור הבא ◀</button>
    </div>
    <section class="gauge-card card">
      <svg id="gauge" viewBox="0 0 200 120">
        <path id="gaugeTrack" fill="none" stroke="var(--track)" stroke-width="14" stroke-linecap="round"/>
        <path id="gaugeFill" fill="none" stroke="var(--ok)" stroke-width="14" stroke-linecap="round"/>
      </svg>
      <div class="gauge-center">
        <div class="gauge-title">נשאר להוציא במחזור</div>
        <div id="remaining" class="gauge-amount">—</div>
        <div id="dailyBudget" class="gauge-sub"></div>
      </div>
    </section>

    <section class="cards-row">
      <div class="card stat"><div class="stat-label">הכנסות</div><div id="statIncome" class="stat-value plus">—</div><div id="statIncomeSub" class="stat-sub"></div></div>
      <div class="card stat"><div class="stat-label">הוצאות</div><div id="statExpenses" class="stat-value minus">—</div><div id="statExpensesSub" class="stat-sub"></div></div>
      <!-- חיזוי סוף מחזור — מוסתר כרגע לבקשת המשתמש (זמין בטאב "חיזוי"). להחזרה: בטל את ההערה כאן ואת בלוק העדכון + קו החיזוי בגרף.
      <div class="card stat"><div class="stat-label">🔮 חיזוי סוף מחזור</div><div id="statForecast" class="stat-value warn">—</div><div id="statForecastSub" class="stat-sub"></div></div>
      -->
    </section>

    <section class="cards-row-2">
      <div class="card"><h2>קו תזרים המחזור</h2><div class="chart-box"><canvas id="lineChart"></canvas></div></div>
      <div class="card"><h2>פילוח קטגוריות</h2><div class="chart-box"><canvas id="pieChart"></canvas></div></div>
    </section>

    <section class="card">
      <h2>עסקאות המחזור</h2>
      <ul id="txList" class="tx-list"></ul>
      <div id="txEmpty" class="empty-state" hidden>אין עסקאות במחזור</div>
    </section>
  `;

  // תזרים המחזור (10→10) — כולל חלון, מצטבר יומי, וחיזוי פרופורציונלי.
  const flow = await api(`/api/flow/cycle/${currentMonth}`);
  const txData = await api(`/api/transactions?from=${flow.start}&to=${flow.end}&limit=15`);
  $('#monthLabel').textContent = flow.label; // תווית מדויקת מהשרת (מתחשב ב-cycle_day)
  $('#dashCycleLabel').textContent = flow.label;
  $('#dashPrev').addEventListener('click', () => shiftMonth(-1));
  $('#dashNext').addEventListener('click', () => shiftMonth(1));

  // מחוון
  const ratio = flow.total_income > 0 ? flow.remaining / flow.total_income : 0;
  $('#gaugeTrack').setAttribute('d', arcPath(1));
  $('#gaugeFill').setAttribute('d', ratio > 0 ? arcPath(ratio) : '');
  $('#gaugeFill').setAttribute('stroke', ratio > 0.25 ? 'var(--ok)' : ratio > 0.1 ? 'var(--warn)' : 'var(--danger)');
  $('#remaining').textContent = fmtILS.format(flow.remaining);
  $('#remaining').classList.toggle('negative', flow.remaining < 0);
  $('#dailyBudget').textContent = flow.days_left > 0 && flow.daily_budget > 0
    ? `${fmtILS.format(flow.daily_budget)} ליום · נשארו ${flow.days_left} ימים` : '';

  // כרטיסים
  $('#statIncome').textContent = fmtILS.format(flow.total_income);
  $('#statIncomeSub').textContent = `קבועות: ${fmtILS.format(flow.expected_income)} · נוספות: ${fmtILS.format(flow.actual_income)}`;
  $('#statExpenses').textContent = fmtILS.format(flow.actual_expenses);
  $('#statExpensesSub').textContent = flow.by_category.length ? `${flow.by_category.length} קטגוריות` : '';
  // כרטיס החיזוי מוסתר כרגע (ראו ה-HTML למעלה) — אין עדכון ל-#statForecast.

  renderLineChart(flow);
  renderPieChart(flow);
  renderTxList($('#txList'), $('#txEmpty'), txData.transactions);
}

function renderLineChart(flow) {
  // ימי המחזור מ-start עד end (כולל), עם תוויות dd/mm החוצות את גבול החודש
  const len = flow.cycle_length;
  const startD = new Date(flow.start + 'T12:00:00');
  const dates = Array.from({ length: len }, (_, i) => {
    const d = new Date(startD); d.setDate(startD.getDate() + i); return d;
  });
  const labels = dates.map((d) => `${d.getDate()}/${d.getMonth() + 1}`);

  // מיפוי הוצאה יומית לפי תאריך ISO
  const byDate = new Map((flow.daily ?? []).map((r) => [r.d, r.total]));
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // האינדקס של "היום" בתוך המחזור (1-based days_elapsed); אחרי סוף המחזור = len
  const dayNow = Math.min(flow.days_elapsed, len);

  let cum = 0;
  const actual = labels.map((_, i) => {
    if (i + 1 > dayNow) return null;
    cum += byDate.get(iso(dates[i])) || 0;
    return Math.round(cum);
  });

  // קו חיזוי — מוסתר כרגע לבקשת המשתמש (יחד עם כרטיס החיזוי בדשבורד).
  // להחזרה: בטל את ההערה כאן, את הכרטיס ב-HTML, ואת בלוק העדכון של #statForecast.
  let forecastLine = null;
  // if (flow.predicted_expenses && dayNow < len) {
  //   const spentNow = cum;
  //   forecastLine = labels.map((_, i) => {
  //     const d = i + 1;
  //     if (d < dayNow) return null;
  //     if (d === dayNow) return Math.round(spentNow);
  //     return Math.round(spentNow + (flow.predicted_expenses - spentNow) * ((d - dayNow) / (len - dayNow)));
  //   });
  // }

  const datasets = [{
    label: 'הוצאות בפועל (מצטבר)',
    data: actual,
    borderColor: '#2fae74',
    backgroundColor: 'rgba(47,174,116,0.08)',
    fill: true, tension: 0.25, pointRadius: 0, borderWidth: 2.5,
  }];
  if (forecastLine) {
    datasets.push({
      label: 'חיזוי',
      data: forecastLine,
      borderColor: '#f0a640',
      borderDash: [6, 5], fill: false, tension: 0, pointRadius: 0, borderWidth: 2,
    });
  }
  if (flow.total_income > 0) {
    datasets.push({
      label: 'תקרת הכנסות',
      data: labels.map(() => flow.total_income),
      borderColor: '#e05a63',
      borderDash: [2, 4], fill: false, pointRadius: 0, borderWidth: 1.5,
    });
  }

  newChart($('#lineChart'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { rtl: true, labels: { boxWidth: 18, font: { size: 11 } } } },
      scales: {
        y: { ticks: { callback: (v) => '₪' + Number(v).toLocaleString('he-IL') } },
        x: { ticks: { maxTicksLimit: 10 } },
      },
    },
  });
}

function renderPieChart(flow) {
  if (!flow.by_category.length) return;
  newChart($('#pieChart'), {
    type: 'doughnut',
    data: {
      labels: flow.by_category.map((c) => `${c.icon} ${c.name}`),
      datasets: [{
        data: flow.by_category.map((c) => c.total),
        backgroundColor: flow.by_category.map((c) => c.color),
        borderWidth: 2, borderColor: '#fff',
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '62%',
      plugins: {
        legend: { position: 'left', rtl: true, labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: (c) => ` ${fmtILS.format(c.raw)}` } },
      },
    },
  });
}

// עריכת שם בית עסק inline — לחיצה על השם הופכת אותו לשדה קלט; Enter/יציאה שומרים.
function startMerchantEdit(el) {
  const id = el.closest('.tx-item').dataset.id;
  const current = el.dataset.merchant || '';
  el.innerHTML = `<input type="text" style="width:100%;font:inherit;padding:2px 4px" value="${escapeHtml(current)}">`;
  const inp = el.querySelector('input');
  inp.focus();
  inp.select();
  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;
    const val = inp.value.trim();
    if (save && val && val !== current) {
      await api(`/api/transactions/${id}`, { method: 'PUT', body: JSON.stringify({ merchant: val }) });
      await render();
    } else {
      el.textContent = current || el.textContent;
      el.dataset.merchant = current;
    }
  };
  inp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
  });
  inp.addEventListener('blur', () => commit(true));
}

// עריכת שם הכנסה inline — לחיצה על השם הופכת אותו לשדה טקסט.
function startIncomeNameEdit(el) {
  const id = el.closest('.tx-item').dataset.id;
  const current = el.dataset.name || '';
  el.innerHTML = `<input type="text" maxlength="60" style="width:150px;font:inherit;padding:2px 4px" value="${escapeHtml(current)}">`;
  const inp = el.querySelector('input');
  inp.focus();
  inp.select();
  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;
    const val = inp.value.trim();
    if (save && val && val !== current) {
      await api(`/api/income/${id}`, { method: 'PUT', body: JSON.stringify({ name: val }) });
      await render();
    } else {
      el.textContent = current;
    }
  };
  inp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
  });
  inp.addEventListener('blur', () => commit(true));
}

// עריכת סכום הכנסה קבועה inline — משכורת ודומיה משתנות מדי חודש.
function startIncomeAmountEdit(el) {
  const id = el.closest('.tx-item').dataset.id;
  const current = Number(el.dataset.amount) || 0;
  el.innerHTML = `<input type="number" min="1" step="0.01" style="width:90px;font:inherit;padding:2px 4px" value="${current}">`;
  const inp = el.querySelector('input');
  inp.focus();
  inp.select();
  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;
    const val = Number(inp.value);
    if (save && Number.isFinite(val) && val > 0 && val !== current) {
      await api(`/api/income/${id}`, { method: 'PUT', body: JSON.stringify({ amount: val }) });
      await render();
    } else {
      el.textContent = `+${fmtILS.format(current)}`;
    }
  };
  inp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
  });
  inp.addEventListener('blur', () => commit(true));
}

// עריכת תאריך הכנסה inline — ריק = "ללא תאריך" (נספרת בכל חודש)
function startIncomeDateEdit(el) {
  const id = el.closest('.tx-item').dataset.id;
  const current = el.dataset.date || '';
  el.innerHTML = `<input type="date" style="font:inherit;padding:2px 4px" value="${current}">`;
  const inp = el.querySelector('input');
  inp.focus();
  let done = false;
  const restore = () => { el.textContent = current || 'ללא תאריך — נספרת בכל חודש'; };
  const commit = async (save) => {
    if (done) return;
    done = true;
    const val = inp.value; // '' אם נמחק
    if (save && val !== current) {
      await api(`/api/income/${id}`, { method: 'PUT', body: JSON.stringify({ date: val || null }) });
      await render();
    } else {
      restore();
    }
  };
  inp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
  });
  inp.addEventListener('blur', () => commit(true));
}

// עריכת שם קטגוריה inline (האייקון נשאר, רק השם משתנה) — מקביל ל-cat:rename בבוט
function startCategoryNameEdit(el) {
  const id = el.closest('.cat-bar-row').dataset.id;
  const current = el.dataset.name || '';
  const icon = el.dataset.icon || '';
  el.innerHTML = `<input type="text" style="width:100%;font:inherit;padding:2px 4px" value="${escapeHtml(current)}">`;
  const inp = el.querySelector('input');
  inp.focus();
  inp.select();
  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;
    const val = inp.value.trim();
    if (save && val && val !== current) {
      await api(`/api/categories/${id}`, { method: 'PUT', body: JSON.stringify({ name: val }) });
      await render();
    } else {
      el.innerHTML = `${icon} ${escapeHtml(current)}`;
    }
  };
  inp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
  });
  inp.addEventListener('blur', () => commit(true));
}

// שורת סיכום בתחתית רשימת העסקאות: כמות + סה"כ הוצאות/הכנסות
function renderTxSummary(el, data) {
  if (!el) return;
  const rows = data.transactions;
  if (!data.total) { el.hidden = true; el.innerHTML = ''; return; }
  const sum = (type) => rows.filter((t) => t.type === type).reduce((s, t) => s + t.amount, 0);
  const expense = sum('expense'), income = sum('income');
  const partial = data.total > rows.length ? ` (מציג ${rows.length} אחרונות)` : '';
  el.hidden = false;
  el.innerHTML =
    `<span>סה"כ <strong>${data.total}</strong> עסקאות${partial}</span>` +
    (expense ? `<span class="minus">הוצאות ${fmtILS.format(expense)}</span>` : '') +
    (income ? `<span class="plus">הכנסות ${fmtILS.format(income)}</span>` : '');
}

// `reload` — טעינה מחדש של הרשימה הנוכחית בלבד (שומרת על הפילטרים הפעילים).
// ברירת המחדל `render` מרנדרת את כל הטאב ומאפסת אותם, ולכן כל קורא שיש לו
// טעינה ממוקדת חייב להעביר אותה.
function renderTxList(listEl, emptyEl, rows, { withCategory = false, reload = render } = {}) {
  emptyEl.hidden = rows.length > 0;
  listEl.innerHTML = rows.map((t) => {
    const isIncome = t.type === 'income';
    return `
    <li class="tx-item" data-id="${t.id}">
      <div class="tx-icon" style="background:${safeColor(t.category_color)}22">${isIncome ? '💵' : escapeHtml(t.category_icon || '💳')}</div>
      <div class="tx-info">
        <div class="tx-merchant editable" data-merchant="${escapeHtml(t.merchant || '')}" title="לחץ לעריכת שם בית העסק">${escapeHtml(t.merchant) || (isIncome ? 'הכנסה' : 'הוצאה')}</div>
        <div class="tx-meta">${t.date}${t.installment_group ? ' · ' + escapeHtml(t.description) : ''}${t.category_name && !withCategory ? ' · ' + escapeHtml(t.category_name) : ''}${t.source !== 'manual' ? ' · ' + t.source : ''}${t.charge_date ? ' · 📅 מחזור הבא' : ''}${t.recurring_id ? ' · 🔁 קבועה' : ''}</div>
      </div>
      ${withCategory && !isIncome ? `<select class="tx-cat-select" data-id="${t.id}">${catOptions(t.category_id)}</select>` : ''}
      <span class="tx-amount ${isIncome ? 'plus' : 'minus'}">${isIncome ? '+' : '−'}${fmtILS.format(t.amount)}</span>
      <button class="tx-edit" title="ערוך שם בית עסק">✎</button>
      ${!isIncome ? `<button class="tx-chargedate" title="${t.charge_date ? 'בטל העברה למחזור הבא' : 'העבר למחזור הבא'}">📅</button>` : ''}
      ${!isIncome ? '<button class="tx-installment" title="תייג כתשלום מתוך סדרה">🔢</button>' : ''}
      <button class="tx-delete" title="מחק">✕</button>
    </li>`;
  }).join('');

  listEl.onclick = async (e) => {
    const btn = e.target.closest('.tx-delete');
    if (btn) {
      // אישור לפני מחיקה — parity מול הבוט (`tx:delask`). מחיקת עסקה סופית.
      const id = btn.closest('.tx-item').dataset.id;
      const t = rows.find((r) => String(r.id) === id);
      const what = t ? `${t.merchant || '—'} · ${fmtILS.format(t.amount)} · ${t.date}` : 'העסקה';
      if (!confirm(`למחוק את העסקה?\n\n${what}\n\nהמחיקה סופית.`)) return;
      await api(`/api/transactions/${id}`, { method: 'DELETE' });
      await render();
      return;
    }
    const editBtn = e.target.closest('.tx-edit');
    if (editBtn) {
      const nameEl = editBtn.closest('.tx-item').querySelector('.tx-merchant.editable');
      if (nameEl && !nameEl.querySelector('input')) startMerchantEdit(nameEl);
      return;
    }
    const chgBtn = e.target.closest('.tx-chargedate');
    if (chgBtn) {
      const id = chgBtn.closest('.tx-item').dataset.id;
      const isSet = chgBtn.title.startsWith('בטל');
      await api(`/api/transactions/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ charge_date: isSet ? null : 'next' }),
      });
      await render();
      return;
    }
    const instBtn = e.target.closest('.tx-installment');
    if (instBtn) {
      const input = prompt('מספר תשלום מתוך סה"כ, למשל 1/3:');
      if (!input) return;
      const m = input.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
      if (!m) { alert('פורמט לא תקין. הקלד למשל: 1/3'); return; }
      const id = instBtn.closest('.tx-item').dataset.id;
      const res = await api(`/api/transactions/${id}/installment`, {
        method: 'PUT',
        body: JSON.stringify({ index: Number(m[1]), count: Number(m[2]) }),
      }).catch((err) => { alert(err.message); return null; });
      if (res) await render();
      return;
    }
    const nameEl = e.target.closest('.tx-merchant.editable');
    if (nameEl && !nameEl.querySelector('input')) startMerchantEdit(nameEl);
  };
  if (withCategory) {
    listEl.onchange = async (e) => {
      const sel = e.target.closest('.tx-cat-select');
      if (!sel) return;
      await assignTxCategory(sel.dataset.id, sel.value ? Number(sel.value) : null,
        sel.options[sel.selectedIndex].textContent.trim(), reload);
    };
  }
}

// שיוך קטגוריה לעסקה + הצעה להחיל על כל העסקאות של אותו בית עסק.
// ההצעה עולה רק כשיש עסקאות אחרות של אותו בית עסק שעדיין לא בקטגוריה הזו —
// אחרת אין מה לעדכן והשאלה סתם מפריעה.
async function assignTxCategory(id, categoryId, catLabel, reload = render) {
  await api(`/api/transactions/${id}/category`, {
    method: 'PUT',
    body: JSON.stringify({ category_id: categoryId }),
  });
  const target = categoryId ? `לקטגוריה ${catLabel}` : 'ל"ללא קטגוריה"';
  const peers = await api(
    `/api/transactions/${id}/merchant-peers?category_id=${categoryId ?? ''}`
  ).catch(() => ({ differing: 0 }));

  if (peers.differing) {
    const ok = confirm(
      `לשייך ${target} גם את ${peers.differing} העסקאות האחרות של "${peers.merchant}"?\n\n` +
      'כך גם עסקאות עתידיות של בית העסק ייקלטו לקטגוריה הזו.'
    );
    if (ok) {
      const res = await api(`/api/transactions/${id}/category`, {
        method: 'PUT',
        body: JSON.stringify({ category_id: categoryId, apply_all: true }),
      });
      toast(`✅ ${res.updated} עסקאות של "${res.merchant}" שויכו ${target}`);
      await reload();
      return;
    }
  }

  // גם שיוך בודד מקבל משוב וטעינה מחדש: בלעדיהם השורה נשארת על המסך גם כשהפילטר
  // הפעיל הוא "ללא קטגוריה", ונראה כאילו השיוך לא נשמר.
  toast(`✅ העסקה שויכה ${target}`);
  await reload();
}

/* ================= עסקאות ================= */
async function viewTransactions(el) {
  el.innerHTML = `
    <section class="card">
      <h2 id="txTitle">עסקאות — ${fmtMonth.format(new Date(currentMonth + '-01T12:00:00'))}</h2>
      <div class="filters">
        <input type="text" id="fQ" placeholder="חיפוש בית עסק… (מחפש בכל התאריכים)">
        <select id="fCat">${catOptions(null, 'כל הקטגוריות')}<option value="none">❔ ללא קטגוריה</option></select>
        <select id="fType"><option value="">הכול</option><option value="expense">הוצאות</option><option value="income">הכנסות</option></select>
        <select id="fSort" title="מיון">
          <option value="date_desc">תאריך: חדש→ישן</option>
          <option value="date_asc">תאריך: ישן→חדש</option>
          <option value="amount_desc">סכום: גבוה→נמוך</option>
          <option value="amount_asc">סכום: נמוך→גבוה</option>
          <option value="category">לפי קטגוריה</option>
        </select>
      </div>
      <ul id="txList" class="tx-list"></ul>
      <div id="txEmpty" class="empty-state" hidden>אין עסקאות תואמות</div>
      <div id="txSummary" class="tx-summary" hidden></div>
    </section>

    <section class="card" id="dupCard"></section>
  `;

  async function load() {
    const q = $('#fQ').value.trim();
    const params = new URLSearchParams({ limit: 200 });
    if (q) params.set('q', q); else params.set('month', currentMonth);
    if ($('#fCat').value) params.set('category_id', $('#fCat').value);
    if ($('#fType').value) params.set('type', $('#fType').value);
    if ($('#fSort').value) params.set('sort', $('#fSort').value);
    const data = await api(`/api/transactions?${params}`);
    renderTxList($('#txList'), $('#txEmpty'), data.transactions, {
      withCategory: true,
      reload: () => load(),
    });
    renderTxSummary($('#txSummary'), data);
    $('#txTitle').textContent = q
      ? `עסקאות — תוצאות חיפוש "${q}"`
      : `עסקאות — ${fmtMonth.format(new Date(currentMonth + '-01T12:00:00'))}`;
  }
  ['fQ', 'fCat', 'fType', 'fSort'].forEach((id) => $(`#${id}`).addEventListener('input', () => load().catch(console.error)));
  await load();
  await renderDuplicates();
}

// פאנל הכפילויות — נטען בכל כניסה לטאב העסקאות, כדי שהבדיקה תהיה שוטפת ולא
// פעולה שצריך לזכור להריץ. מציג גם כשאין כפילויות (אישור שה-DB נקי).
// "✔️ לא כפילות" מרענן את הפאנל בלבד (`renderDuplicates`) — הוא לא משנה
// עסקאות, ולכן אין סיבה לרנדר מחדש את כל הטאב ולאבד את הפילטרים.
async function renderDuplicates() {
  const box = $('#dupCard');
  if (!box) return;
  const data = await api('/api/transactions/duplicates').catch(() => null);
  if (!data) { box.hidden = true; return; }

  // סימוני "לא כפילות" — תמיד מוצגים עם דרך חזרה, גם כשהפאנל נקי
  const restore = data.ignored_pairs
    ? `<div class="stat-sub">✔️ ${data.ignored_pairs} ${data.ignored_pairs === 1 ? 'זוג מסומן' : 'זוגות מסומנים'} כ"לא כפילות".
         <button class="link-btn" id="dupRestore">שחזר את כולם</button></div>`
    : '';

  if (!data.total_groups) {
    box.innerHTML = `<h2>🔁 כפילויות</h2><div class="dup-clean">✅ לא נמצאו עסקאות כפולות.</div>${restore}`;
    bindRestore();
    return;
  }

  box.innerHTML = `
    <h2>🔁 כפילויות — ${data.total_groups} ${data.total_groups === 1 ? 'קבוצה' : 'קבוצות'}</h2>
    <div class="stat-sub">אותו תאריך, אותו סכום ושם בית עסק תואם — בדרך כלל אותה עסקה שנקלטה
      גם מ-SMS וגם מדוח האשראי, פעם בשם מקוצר ופעם בשם המלא.
      בחר איזו שורה למחוק (${data.total_extra} שורות עודפות).<br>
      לא כל כפילות היא טעות: אם השורה כבר חויבה במחזור הקודם והדוח מציג אותה
      כחיוב קרוב, לחץ 📅 כדי להעביר אותה למחזור החיוב הבא במקום למחוק —
      השורות ייפרדו למחזורים שונים והקבוצה תרד מהרשימה.<br>
      ואם אלו באמת חיובים נפרדים (למשל שלוש כרטיסיות רכבת באותו יום, כל אחת עם
      מספר עסקה משלה בדוח) — לחץ "✔️ לא כפילות" והקבוצה תרד מהרשימה בלי לגעת
      בנתונים.</div>
    ${restore}
    ${data.groups.map((g) => `
      <div class="dup-group">
        <div class="dup-head">
          <span>${g.date} · ${fmtILS.format(g.amount)}${g.type === 'income' ? ' · הכנסה' : ''}</span>
          <button class="dup-ok" data-id="${g.rows[0].id}" title="אלו חיובים נפרדים — הסר את הקבוצה מהרשימה בלי לשנות נתונים">✔️ לא כפילות</button>
        </div>
        <ul class="tx-list">
          ${g.rows.map((r) => `
            <li class="tx-item" data-id="${r.id}">
              <div class="tx-icon" style="background:${safeColor(r.category_color)}22">${escapeHtml(r.category_icon || '💳')}</div>
              <div class="tx-info">
                <div class="tx-merchant">${escapeHtml(r.merchant || '—')}</div>
                <div class="tx-meta">מקור: ${escapeHtml(r.source)} · ${r.category_name ? escapeHtml(r.category_name) : 'ללא קטגוריה'}${r.charge_date ? ' · 📅 מחזור הבא' : ''}</div>
              </div>
              ${g.type === 'income' ? '' : `<button class="dup-chg" data-set="${r.charge_date ? '1' : ''}" title="${r.charge_date ? 'בטל את ההעברה — חזרה למחזור של תאריך הרכישה' : 'לא כפילות — העבר את השורה הזו למחזור החיוב הבא'}">📅</button>`}
              <button class="tx-delete dup-del" title="מחק את השורה הזו">✕</button>
            </li>`).join('')}
        </ul>
      </div>`).join('')}`;

  bindRestore();

  box.onclick = async (e) => {
    // ✔️ "לא כפילות" — שלוש כרטיסיות רכבת באותו יום ובאותו סכום הן שלושה
    // חיובים אמיתיים (מספר עסקה שונה לכל אחת בדוח). שומר את הזוגות של הקבוצה
    // ב-duplicate_ignores; העסקאות עצמן לא נוגעות. הפיך דרך "שחזר את כולם".
    const okBtn = e.target.closest('.dup-ok');
    if (okBtn) {
      const res = await api('/api/transactions/duplicates/ignore', {
        method: 'POST',
        body: JSON.stringify({ id: Number(okBtn.dataset.id) }),
      }).catch((err) => { alert(err.message); return null; });
      if (!res) return;
      toast(`✔️ ${res.rows} השורות סומנו כחיובים נפרדים — הקבוצה הוסרה מהרשימה`);
      await renderDuplicates();
      return;
    }
    // 📅 — "זו לא כפילות, זה החיוב של המחזור הבא". מסמן charge_date ובכך
    // מפריד את השורה מהשורה שכבר נספרה במחזור הקודם; `scanDuplicates` מפסיקה
    // לקבץ אותן והקבוצה יורדת מהרשימה (ראו server/lib/duplicates.js).
    const chgBtn = e.target.closest('.dup-chg');
    if (chgBtn) {
      const li = chgBtn.closest('.tx-item');
      const isSet = chgBtn.dataset.set === '1';
      await api(`/api/transactions/${li.dataset.id}`, {
        method: 'PUT',
        body: JSON.stringify({ charge_date: isSet ? null : 'next' }),
      });
      toast(isSet ? '↩️ ההעברה בוטלה — השורה חזרה למחזור של תאריך הרכישה'
                  : '📅 השורה הועברה למחזור החיוב הבא');
      await render();
      return;
    }
    const btn = e.target.closest('.dup-del');
    if (!btn) return;
    const li = btn.closest('.tx-item');
    const name = li.querySelector('.tx-merchant').textContent;
    const meta = li.querySelector('.tx-meta').textContent;
    if (!confirm(`למחוק את העסקה הכפולה?\n\n${name}\n${meta}\n\nהמחיקה סופית.`)) return;
    await api(`/api/transactions/${li.dataset.id}`, { method: 'DELETE' });
    toast('✅ הכפילות נמחקה');
    await render();
  };
}

// "שחזר את כולם" — מוחק את כל סימוני "לא כפילות" ומחזיר את הקבוצות לפאנל.
function bindRestore() {
  const btn = document.getElementById('dupRestore');
  if (!btn) return;
  btn.onclick = async () => {
    await api('/api/transactions/duplicates/ignore', { method: 'DELETE' });
    toast('↩️ הסימונים בוטלו — הקבוצות חזרו לרשימה');
    await renderDuplicates();
  };
}

/* ================= ייבוא ================= */
let importState = null;

async function viewImport(el) {
  el.innerHTML = `
    <section class="card">
      <h2>ייבוא מקובץ בנק / אשראי</h2>
      <div class="dropzone" id="dropzone">
        📥 גרור לכאן קובץ CSV, PDF או תמונה (JPG/PNG), או לחץ לבחירה<br>
        <span style="font-size:0.8rem">Isracard · Cal · Max · לאומי · הפועלים ועוד — זיהוי עמודות אוטומטי</span><br>
        <span style="font-size:0.8rem">תמונה (למשל צילום מסך של הדוח) עוברת OCR — לוקח כמה שניות, אימות בתצוגה המקדימה לפני שמירה</span>
        <input type="file" id="fileInput" accept=".csv,.pdf,.jpg,.jpeg,.png" hidden>
      </div>
      <div id="importMsg" class="form-msg"></div>
    </section>

    <section class="card">
      <h2>הדבקת SMS בנקאי</h2>
      <textarea id="smsText" rows="3" style="width:100%" placeholder='הדבק כאן SMS מהבנק, למשל: אושרה עסקה בסך 89.90 ש"ח ב-קפה גרג בתאריך 05/07'></textarea>
      <div class="row-flex mt">
        <button id="smsParse" class="btn-primary">קלוט SMS</button>
        <span id="smsMsg" class="form-msg grow"></span>
      </div>
    </section>

    <section class="card" id="previewCard" hidden>
      <div class="row-flex spread">
        <h2 id="previewTitle">תצוגה מקדימה</h2>
        <div class="row-flex">
          <button id="commitBtn" class="btn-primary">אשר ייבוא</button>
          <button id="cancelBtn" class="btn-secondary">בטל</button>
        </div>
      </div>
      <div class="table-wrap">
        <table class="import-table">
          <thead><tr><th></th><th>תאריך</th><th>בית עסק</th><th>סכום</th><th>קטגוריה</th><th>מחזור חיוב</th><th>סטטוס</th></tr></thead>
          <tbody id="previewRows"></tbody>
        </table>
      </div>
    </section>
  `;

  const dropzone = $('#dropzone');
  const fileInput = $('#fileInput');
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => fileInput.files[0] && uploadFile(fileInput.files[0]));

  async function uploadFile(file) {
    const msg = $('#importMsg');
    msg.className = 'form-msg';
    msg.textContent = /\.(jpe?g|png)$/i.test(file.name)
      ? 'קורא את התמונה (OCR)… ⏳ זה עשוי לקחת כמה שניות' : 'מעבד… ⏳';
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/import/preview', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      importState = data;
      msg.textContent = '';
      renderPreview();
    } catch (err) {
      msg.textContent = err.message;
      msg.classList.add('error');
    }
  }

  // תא "מחזור" בתצוגה המקדימה: לאיזה מחזור השורה תיפול + כפתור החלטה.
  // `cycle_closed` = לפי תאריך הרכישה היא נופלת למחזור שכבר נסגר — הדפוס של
  // דוח "חיובים קרובים" שכולל את יום סגירת המחזור. סימון בלבד, בלי החלטה.
  function cycleCell(r, i) {
    const moved = Boolean(r.next_cycle);
    const label = moved
      ? `<span class="badge new">📅 ${escapeHtml(r.next_cycle_date || '')} — מחזור הבא</span>`
      : `<span class="${r.cycle_closed ? 'badge dup' : ''}">${r.cycle_closed ? '⚠️ ' : ''}${escapeHtml(r.cycle_label || '')}</span>`;
    const title = moved ? 'בטל — החזר לשיוך לפי תאריך הרכישה' : 'העבר את השורה למחזור החיוב הבא';
    return `${label} <button type="button" class="cycle-toggle" data-i="${i}" title="${title}">${moved ? '↩︎' : '📅'}</button>`;
  }

  function renderPreview() {
    $('#previewCard').hidden = false;
    $('#previewTitle').innerHTML =
      `${escapeHtml(importState.filename)} — זוהו ${importState.parsed} עסקאות` +
      (importState.duplicates ? ` (${importState.duplicates} כפילויות)` : '') +
      (importState.skipped ? ` · ${importState.skipped} שורות מטא לא זוהו` : '') +
      `<br><span class="badge dup">⚠️ טרם יובאו — לחץ "אשר ייבוא" כדי להוסיף ל-DB</span>`;
    $('#previewRows').innerHTML = importState.rows.map((r, i) => `
      <tr class="${r.duplicate ? 'dup-row' : ''}">
        <td><input type="checkbox" data-i="${i}" ${r.duplicate ? '' : 'checked'}></td>
        <td>${r.date}</td>
        <td><input type="text" class="merchant-edit" data-i="${i}" value="${escapeHtml(r.merchant)}" style="width:100%;font:inherit;padding:2px 4px" title="ניתן לתקן שם בית עסק לפני הייבוא"></td>
        <td style="color:${r.type === 'income' ? 'var(--ok)' : 'var(--danger)'}">${r.type === 'income' ? '+' : '−'}${fmtILS.format(r.amount)}</td>
        <td><select data-i="${i}" class="tx-cat-select">${catOptions(r.category_id)}</select></td>
        <td class="cycle-cell">${cycleCell(r, i)}</td>
        <td>${r.duplicate ? '<span class="badge dup">כפילות</span>' : '<span class="badge new">חדש</span>'}${r.category_source ? ` <span class="badge">${r.category_source}</span>` : ''}</td>
      </tr>
    `).join('');
    $('#previewRows').onchange = (e) => {
      const sel = e.target.closest('select');
      if (sel) importState.rows[Number(sel.dataset.i)].category_id = sel.value ? Number(sel.value) : null;
    };
    // 📅 — המשתמש מחליט, לכל שורה בנפרד, אם החיוב שייך למחזור הבא.
    // ברירת המחדל תמיד "לא" — הכלי מסמן מה נופל למחזור שכבר נסגר, ולא מחליט.
    $('#previewRows').onclick = (e) => {
      const btn = e.target.closest('.cycle-toggle');
      if (!btn) return;
      const i = Number(btn.dataset.i);
      const row = importState.rows[i];
      row.next_cycle = !row.next_cycle;
      btn.closest('.cycle-cell').innerHTML = cycleCell(row, i);
    };
    $('#previewRows').oninput = (e) => {
      const inp = e.target.closest('.merchant-edit');
      if (inp) importState.rows[Number(inp.dataset.i)].merchant = inp.value;
    };
    $('#previewCard').scrollIntoView({ behavior: 'smooth' });
  }

  let savingImport = false;
  const commitBtn = $('#commitBtn');
  const cancelBtn = $('#cancelBtn');
  commitBtn.addEventListener('click', async () => {
    if (!importState || savingImport) return;
    const checkboxes = $$('#previewRows input[type=checkbox]');
    const rows = checkboxes.filter((c) => c.checked).map((c) => ({ ...importState.rows[Number(c.dataset.i)], force: true }));
    const msg = $('#importMsg');
    if (!rows.length) {
      msg.textContent = 'לא סומנה אף עסקה לייבוא.';
      msg.className = 'form-msg error';
      return;
    }
    // ספירה מלאה: כמה בקובץ, כמה סומנו, כמה כפילויות — כדי לא לפספס
    const inFile = importState.parsed;
    const unchecked = checkboxes.length - rows.length;
    savingImport = true;
    commitBtn.disabled = true;
    cancelBtn.disabled = true;
    try {
      const result = await api('/api/import/commit', {
        method: 'POST',
        body: JSON.stringify({ source: importState.source, rows }),
      });
      $('#previewCard').hidden = true;
      importState = null;
      const parts = [`✅ נוספו ${result.inserted} מתוך ${inFile} עסקאות שבקובץ`];
      if (result.updated) parts.push(`עודכנו ${result.updated} תוכניות תשלומים`);
      if (result.skippedDup) parts.push(`דולגו ${result.skippedDup} כפילויות`);
      if (unchecked) parts.push(`${unchecked} לא סומנו`);
      msg.textContent = parts.join(' · ');
      msg.className = 'form-msg ok';
    } catch (err) {
      $('#importMsg').textContent = err.message;
      $('#importMsg').className = 'form-msg error';
    } finally {
      savingImport = false;
      commitBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  });
  $('#cancelBtn').addEventListener('click', () => { $('#previewCard').hidden = true; importState = null; });

  // SMS — אחרי קליטה, ניתן לשנות קטגוריה מיד (select) בלי לעבור לטאב עסקאות
  $('#smsParse').addEventListener('click', async () => {
    const msg = $('#smsMsg');
    msg.className = 'form-msg grow';
    try {
      const text = $('#smsText').value.trim();
      if (!text) return;
      const result = await api('/api/import/sms', { method: 'POST', body: JSON.stringify({ text }) });
      msg.className = 'form-msg grow ok';
      msg.innerHTML = `✅ נקלט: ${escapeHtml(result.merchant)} — ${fmtILS.format(result.amount)}
        <select id="smsCatSelect" style="margin-inline-start:6px">${catOptions(result.category_id)}</select>`;
      $('#smsCatSelect').addEventListener('change', async (e) => {
        await api(`/api/transactions/${result.id}`, {
          method: 'PUT',
          body: JSON.stringify({ category_id: e.target.value ? Number(e.target.value) : null }),
        });
      });
      $('#smsText').value = '';
    } catch (err) {
      msg.textContent = err.message;
      msg.classList.add('error');
    }
  });
}

/* ================= קטגוריות + חוקים ================= */
// הקטגוריה הפתוחה בטאב "קטגוריות" ({id, anchor}) — שורדת render() מלא (מחיקת
// עסקה, שינוי קטגוריה) ומאופסת ביציאה מהטאב (ראו render()).
let openCat = null;

async function viewCategories(el) {
  // חלון המחזור מהשרת (מקור אמת יחיד) — זהה לחלון הדשבורד. הקטגוריות נספרות בתוכו.
  const flow = await api(`/api/flow/cycle/${currentMonth}`);
  const [cats, rules] = await Promise.all([
    api(`/api/categories?from=${flow.start}&to=${flow.end}`),
    api('/api/rules'),
  ]);

  el.innerHTML = `
    <section class="card">
      <h2>קטגוריות <span class="stat-sub">· ${escapeHtml(flow.label)}</span></h2>
      <div class="category-bars" id="catList">
        ${cats.map((c) => {
          const max = Math.max(...cats.map((x) => x.month_total), 1);
          return `
          <div class="cat-bar-row clickable" data-id="${c.id}" title="לחץ לצפייה בעסקאות" style="padding:4px 0">
            <span class="cat-bar-name cat-name-edit" data-name="${escapeHtml(c.name)}" data-icon="${escapeHtml(c.icon)}" style="min-width:120px">${escapeHtml(c.icon)} ${escapeHtml(c.name)}</span>
            <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${(c.month_total / max) * 100}%;background:${safeColor(c.color)}"></div></div>
            <span class="cat-bar-amount">${fmtILS.format(c.month_total)}</span>
            <button class="icon-btn cat-edit" title="שנה שם">✏️</button>
            <button class="tx-delete cat-delete" title="מחק קטגוריה">✕</button>
          </div>`;
        }).join('')}
      </div>
      <form id="catAddForm" class="form-grid mt">
        <input type="text" id="catIcon" placeholder="אימוג'י (רשות)" maxlength="4" style="max-width:110px">
        <input type="text" id="catName" placeholder="שם קטגוריה חדשה" required>
        <button type="submit" class="btn-primary">➕ הוסף קטגוריה</button>
      </form>
      <div id="catAddMsg" class="form-msg"></div>
      <div id="catDetail"></div>
    </section>

    <section class="card">
      <h2>חוקי סיווג אוטומטי (regex → קטגוריה)</h2>
      <ul class="tx-list" id="ruleList">
        ${rules.map((r) => `
          <li class="tx-item" data-id="${r.id}">
            <div class="tx-info">
              <div class="tx-merchant"><code>${escapeHtml(r.pattern)}</code></div>
              <div class="tx-meta">→ ${escapeHtml(r.category_icon)} ${escapeHtml(r.category_name)}</div>
            </div>
            <button class="tx-delete">✕</button>
          </li>`).join('') || '<div class="empty-state">אין חוקים עדיין — הוסף למטה. חוקים מנצחים תמיד את ה-ML.</div>'}
      </ul>
      <form id="ruleForm" class="form-grid mt">
        <input type="text" id="rulePattern" placeholder="ביטוי (למשל: שופרסל|רמי לוי)" required>
        <select id="ruleCat">${catOptions(null, 'בחר קטגוריה…')}</select>
        <button type="submit" class="btn-primary">הוסף חוק</button>
      </form>
      <div id="ruleMsg" class="form-msg"></div>
    </section>

    <section class="card">
      <h2>מודל למידה (scikit-learn)</h2>
      <div class="row-flex">
        <button id="trainBtn" class="btn-secondary">אמן מחדש עכשיו</button>
        <span id="trainMsg" class="form-msg grow"></span>
      </div>
      <div class="stat-sub mt">המודל לומד מהעסקאות המתויגות שלך ומתאמן אוטומטית אחרי כל ייבוא.</div>
    </section>
  `;

  // לחיצה על קטגוריה → הצגת כל העסקאות המשויכות (מכל החודשים), חדש→ישן
  // קטגוריית "תשלומים" — במקום רשימת עסקאות רגילה, מציגה את כל תוכניות התשלומים עם התקדמות k/n
  // הקטגוריה הפתוחה נשמרת ב-openCat (מודול) ולא רק כאן, כי מחיקת עסקה קוראת
  // ל-render() מלא — בלי זה המשתמש נזרק מהקטגוריה שהיה בה (ראו השחזור בסוף).
  let openCatId = openCat ? String(openCat.id) : null;
  $('#catList').addEventListener('click', async (e) => {
    const row = e.target.closest('.cat-bar-row');
    if (!row || !row.dataset.id) return;

    if (e.target.closest('.cat-delete')) {
      const c = cats.find((x) => String(x.id) === row.dataset.id);
      if (!confirm(`למחוק את הקטגוריה "${c.name}"? העסקאות ישויכו ל"ללא קטגוריה".`)) return;
      await api(`/api/categories/${row.dataset.id}`, { method: 'DELETE' });
      await render();
      return;
    }
    if (e.target.closest('.cat-edit')) {
      startCategoryNameEdit(row.querySelector('.cat-name-edit'));
      return;
    }

    const detail = $('#catDetail');
    if (openCatId === row.dataset.id) { // לחיצה חוזרת = סגירה
      openCatId = null; openCat = null; detail.innerHTML = '';
      $$('.cat-bar-row').forEach((r) => r.classList.remove('active'));
      return;
    }
    openCatId = row.dataset.id;
    $$('.cat-bar-row').forEach((r) => r.classList.toggle('active', r === row));
    const c = cats.find((x) => String(x.id) === openCatId);

    if (c.name === 'תשלומים') {
      await renderInstallmentsDetail(c, currentMonth);
      return;
    }

    // פירוט לפי חלון המחזור, עם ניווט ◀▶ בין מחזורים (עוגן מקומי, לא משנה את הגלובלי)
    await renderCatDetail(c, currentMonth);
  });

  // מרנדר את פירוט הקטגוריה למחזור לפי anchor; ◀▶ מזיזים מחזור ומרעננים רק את ה-detail
  async function renderCatDetail(c, anchor) {
    openCat = { id: c.id, anchor };
    const detail = $('#catDetail');
    const w = await api(`/api/flow/cycle/${anchor}`);
    const data = await api(`/api/transactions?category_id=${c.id}&from=${w.start}&to=${w.end}&limit=200`);
    const sum = data.transactions.reduce((s, t) => s + (t.type === 'income' ? 0 : t.amount), 0);
    // עסקה עם תשלומים (installment_group משותף) נספרת פעם אחת, לא לפי מספר התשלומים
    const count = new Set(data.transactions.map((t) => t.installment_group || `tx_${t.id}`)).size;
    detail.innerHTML = `
      <div class="cat-detail-head">
        <button class="icon-btn cat-nav" data-anchor="${shiftMonthStr(anchor, -1)}" title="מחזור קודם">▶</button>
        <span>${escapeHtml(c.icon)} ${escapeHtml(c.name)} · ${escapeHtml(w.label)} — ${count} עסקאות · ${fmtILS.format(sum)}</span>
        <button class="icon-btn cat-nav" data-anchor="${shiftMonthStr(anchor, 1)}" title="מחזור הבא">◀</button>
      </div>
      ${data.transactions.length ? '<ul class="tx-list" id="catTxList"></ul>' : `<div class="empty-state">אין עסקאות ב${escapeHtml(c.name)} במחזור זה</div>`}`;
    if (data.transactions.length) {
      renderTxList($('#catTxList'), document.createElement('div'), data.transactions, {
        withCategory: true,
        reload: () => renderCatDetail(c, anchor),
      });
    }
    detail.querySelectorAll('.cat-nav').forEach((b) => b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      renderCatDetail(c, b.dataset.anchor);
    }));
  }

  // "תשלומים" — חיובי התוכניות במחזור הנבחר לפי מועדם האפקטיבי ומספר התשלום.
  // העברה יכולה להציג שני חיובים לאותה תוכנית; תשלום צפוי מסומן בטקסט.
  async function renderInstallmentsDetail(c, anchor) {
    openCat = { id: c.id, anchor };
    const detail = $('#catDetail');
    const w = await api(`/api/flow/cycle/${anchor}`);
    const groups = await api(`/api/transactions/installments?from=${w.start}&to=${w.end}`);
    const sum = groups.reduce((s, g) => s + g.amount, 0);
    const programCount = new Set(groups.map((g) => g.group)).size;
    detail.innerHTML = `
      <div class="cat-detail-head">
        <button class="icon-btn ins-nav" data-anchor="${shiftMonthStr(anchor, -1)}" title="מחזור קודם">▶</button>
        <span>תשלומים · ${escapeHtml(w.label)} — ${programCount} תוכניות · ${fmtILS.format(sum)}</span>
        <button class="icon-btn ins-nav" data-anchor="${shiftMonthStr(anchor, 1)}" title="מחזור הבא">◀</button>
      </div>
      ${groups.length ? `
        <ul class="tx-list">
          ${groups.map((g) => `
            <li class="tx-item">
              <div class="tx-info">
                <div class="tx-merchant">${escapeHtml(g.merchant || '—')}</div>
                <div class="tx-meta">תשלום ${g.index} מתוך ${g.total_count} · ${escapeHtml(g.due_date)}${g.projected ? ' · טרם יובא' : ''}</div>
              </div>
              <span class="tx-amount minus">${fmtILS.format(g.amount)}</span>
            </li>`).join('')}
        </ul>
        <div class="stat-sub">תוכנית שהגיעה לתשלום האחרון לא מוצגת במחזור הבא. "טרם יובא" = התשלום צפוי לפי לוח התשלומים, אבל הדוח שלו עדיין לא יובא.</div>`
        : '<div class="empty-state">אין תוכנית תשלומים פעילה במחזור זה</div>'}`;
    detail.querySelectorAll('.ins-nav').forEach((b) => b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      renderInstallmentsDetail(c, b.dataset.anchor);
    }));
  }

  // שחזור הקטגוריה שהייתה פתוחה לפני ה-render (מחיקת עסקה מרנדרת את הטאב מחדש)
  if (openCat) {
    const c = cats.find((x) => x.id === openCat.id);
    if (!c) openCat = null;
    else {
      const anchor = openCat.anchor;
      $$('.cat-bar-row').forEach((r) => r.classList.toggle('active', r.dataset.id === String(c.id)));
      if (c.name === 'תשלומים') await renderInstallmentsDetail(c, anchor);
      else await renderCatDetail(c, anchor);
    }
  }

  $('#catAddForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#catAddMsg');
    msg.className = 'form-msg';
    try {
      await api('/api/categories', {
        method: 'POST',
        body: JSON.stringify({ name: $('#catName').value.trim(), icon: $('#catIcon').value.trim() || undefined }),
      });
      $('#catName').value = ''; $('#catIcon').value = '';
      await render();
    } catch (err) { msg.textContent = err.message; msg.classList.add('error'); }
  });

  $('#ruleList').addEventListener('click', async (e) => {
    const btn = e.target.closest('.tx-delete');
    if (!btn) return;
    await api(`/api/rules/${btn.closest('.tx-item').dataset.id}`, { method: 'DELETE' });
    await render();
  });

  $('#ruleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#ruleMsg');
    msg.className = 'form-msg';
    try {
      if (!$('#ruleCat').value) throw new Error('בחר קטגוריה');
      await api('/api/rules', {
        method: 'POST',
        body: JSON.stringify({ pattern: $('#rulePattern').value, category_id: Number($('#ruleCat').value) }),
      });
      await render();
    } catch (err) { msg.textContent = err.message; msg.classList.add('error'); }
  });

  $('#trainBtn').addEventListener('click', async () => {
    const msg = $('#trainMsg');
    msg.textContent = 'מאמן… ⏳';
    msg.className = 'form-msg grow';
    const result = await api('/api/settings/train', { method: 'POST' });
    if (result.trained) {
      msg.textContent = `✅ אומן על ${result.samples} עסקאות (${result.classes} קטגוריות)`;
      msg.classList.add('ok');
    } else {
      msg.textContent = result.reason === 'not_enough_data'
        ? `אין מספיק נתונים מתויגים (${result.samples ?? 0}) — צריך לפחות 8 עסקאות ב-2 קטגוריות`
        : 'מנוע ה-ML לא זמין (בדוק ש-Python + scikit-learn מותקנים)';
      msg.classList.add('error');
    }
  });
}

/* ================= הכנסות ================= */
// תווית תדירות של הוצאה קבועה: "כל יום שלישי" / "כל 1 בחודש" (+ "ב-07:00" אם נקבעה שעה)
const REC_DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
function recFreqLabel(r) {
  const base = r.freq === 'weekly' ? `כל יום ${REC_DAY_NAMES[r.day]}` : `כל ${r.day} בחודש`;
  return r.hour != null ? `${base} ב-${String(r.hour).padStart(2, '0')}:00` : base;
}

async function viewIncome(el) {
  const [incData, subs, recs] = await Promise.all([
    api(`/api/income?month=${currentMonth}`), api('/api/subscriptions'), api('/api/recurring'),
  ]);
  const { cycle, total, incomes } = incData;
  el.innerHTML = `
    <section class="card">
      <h2>הכנסות · ${escapeHtml(cycle.label)}</h2>
      <div class="cycle-nav">
        <button class="btn-secondary" id="incPrev">▶ מחזור קודם</button>
        <span class="cycle-total">סה"כ: <strong class="plus">${fmtILS.format(total)}</strong></span>
        <button class="btn-secondary" id="incNext">מחזור הבא ◀</button>
      </div>
      <ul class="tx-list" id="incomeList">
        ${incomes.map((i) => `
          <li class="tx-item" data-id="${i.id}">
            <div class="tx-icon" style="background:#e6f6ee">💵</div>
            <div class="tx-info">
              <div class="tx-merchant"><span class="income-name-edit" data-name="${escapeHtml(i.name)}" title="לחץ לעריכת השם">${escapeHtml(i.name)}</span> ${i.recurring ? `<span class="badge on">🔁 קבועה${i.day_of_month ? ` · ${i.day_of_month} בחודש` : ''}</span>` : ''}${i.recurring_parent_id ? `<span class="badge on">🔁 קבועה${i.date ? ` · ${Number(i.date.slice(8, 10))} בחודש` : ''}</span>` : ''} ${i.active ? '' : '<span class="badge off">כבוי</span>'}</div>
              <div class="tx-meta income-date-edit" data-date="${i.date || ''}" title="לחץ לעריכת התאריך">${i.date ? i.date : 'ללא תאריך — נספרת בכל מחזור'}</div>
            </div>
            <span class="tx-amount plus income-amount-edit" data-amount="${i.amount}" title="לחץ לעריכת הסכום">+${fmtILS.format(i.amount)}</span>
            ${i.recurring_parent_id ? '' : `<button class="icon-btn inc-recur" title="${i.recurring ? 'בטל הכנסה קבועה' : 'סמן כהכנסה קבועה (מופע חדש נוסף אוטומטית כל חודש)'}">${i.recurring ? '🔁' : '↻'}</button>`}
            <button class="icon-btn toggle" title="הפעל/כבה">${i.active ? '⏸' : '▶'}</button>
            <button class="tx-delete">✕</button>
          </li>`).join('') || '<div class="empty-state">אין הכנסות במחזור הזה — הוסף למטה</div>'}
      </ul>
      <form id="incomeForm" class="form-row-income mt">
        <input type="text" id="incName" placeholder="שם (משכורת, מתנה…)" required>
        <input type="number" id="incAmount" placeholder="סכום ₪" min="1" required>
        <input type="date" id="incDate" value="${cycle.end}" title="תאריך ההכנסה">
        <button type="submit" class="btn-primary">הוסף</button>
        <label class="inline-check" title="הכנסה שחוזרת כל חודש — מופע חדש נוסף אוטומטית ביום שנקבע, בסכום הקבוע"><input type="checkbox" id="incRecurring"> 🔁 קבועה</label>
        <input type="number" id="incDay" placeholder="יום 1-31" min="1" max="31" title="היום בחודש שההכנסה הקבועה נוספת אוטומטית. ריק = לפי היום בתאריך.">
      </form>
      <div id="incMsg" class="form-msg"></div>
      <div class="stat-sub mt">המחזור נספר מ-${cycle.start} עד ${cycle.end} — בדיוק כמו ההוצאות בדשבורד<br>"🔁 קבועה" — הכנסה שחוזרת כל חודש (קצבה וכו'): מופע חדש נוסף אוטומטית ביום שנקבע, בסכום הקבוע. אפשר גם לסמן ↻ ליד הכנסה קיימת ברשימה.</div>
    </section>

    <section class="card">
      <h2>📄 מנויים והתחייבויות (תזכורת חידוש בטלגרם)</h2>
      <ul class="tx-list" id="subList">
        ${subs.map((s) => {
          const badge = !s.active ? '<span class="badge off">מושבת</span>'
            : s.days_left < 0 ? '<span class="badge dup">פג!</span>'
            : s.days_left <= s.remind_days ? `<span class="badge dup">${s.days_left} ימים</span>`
            : `<span class="badge on">${s.days_left} ימים</span>`;
          return `
          <li class="tx-item" data-id="${s.id}">
            <div class="tx-icon" style="background:#eef2f8">📄</div>
            <div class="tx-info">
              <div class="tx-merchant">${escapeHtml(s.name)} ${badge}</div>
              <div class="tx-meta">${s.start_date} → ${s.end_date}${s.amount ? ' · ' + fmtILS.format(s.amount) : ''}</div>
            </div>
            <button class="btn-secondary sub-renew" title="חידוש לתקופה נוספת">🔄 חידשתי</button>
            <button class="tx-delete">✕</button>
          </li>`;
        }).join('') || '<div class="empty-state">אין מנויים — הוסף למטה ותקבל תזכורת חידוש בטלגרם</div>'}
      </ul>
      <form id="subForm" class="form-grid mt">
        <input type="text" id="subName" placeholder="שם (אינטרנט…)" required>
        <input type="number" id="subAmount" placeholder="עלות ₪ (רשות)" min="0" step="0.01">
        <input type="date" id="subStart" required value="${localDate()}" title="תחילת התקופה">
        <input type="date" id="subEnd" required title="תאריך סיום/חידוש">
        <button type="submit" class="btn-primary">הוסף מנוי</button>
      </form>
      <div id="subMsg" class="form-msg"></div>
      <div class="stat-sub mt">תזכורת נשלחת בטלגרם 14 יום לפני הסיום. "חידשתי" מאריך את המנוי באותו אורך תקופה.</div>
    </section>

    <section class="card">
      <h2>הוספת עסקה</h2>
      <form id="txForm" class="form-grid">
        <input type="date" id="txDate" required value="${localDate()}">
        <input type="number" id="txAmount" placeholder="סכום ₪" min="0.01" step="0.01" required>
        <input type="text" id="txMerchant" placeholder="בית עסק">
        <select id="txCategory">${catOptions(null, 'קטגוריה (אוטומטי)')}</select>
        <select id="txType"><option value="expense">הוצאה</option><option value="income">הכנסה</option></select>
        <input type="number" id="txInstallments" placeholder="תשלומים (1)" min="1" max="36" title="פיצול לתשלומים חודשיים">
        <button type="submit" class="btn-primary">הוסף</button>
      </form>
      <div id="formMsg" class="form-msg"></div>
    </section>

    <section class="card">
      <h2>🔁 הוצאות קבועות (נוספות אוטומטית)</h2>
      <ul class="tx-list" id="recList">
        ${recs.map((r) => `
          <li class="tx-item" data-id="${r.id}">
            <div class="tx-icon" style="background:#fdf3e6">🔁</div>
            <div class="tx-info">
              <div class="tx-merchant">${escapeHtml(r.merchant)} ${r.active ? '' : '<span class="badge off">מושבתת</span>'}</div>
              <div class="tx-meta">${recFreqLabel(r)}${r.category_name ? ' · ' + escapeHtml(r.category_icon) + ' ' + escapeHtml(r.category_name) : ' · קטגוריה אוטומטית'}${r.last_added ? ' · נוספה לאחרונה: ' + r.last_added : ''}</div>
            </div>
            <select class="tx-cat-select rec-cat-select" title="קטגוריה של המופעים. 'קטגוריה (אוטומטי)' = סיווג לפי חוקים/ML בכל מופע">${catOptions(r.category_id, 'קטגוריה (אוטומטי)')}</select>
            <span class="tx-amount minus">−${fmtILS.format(r.amount)}</span>
            <button class="icon-btn rec-hour" title="קבע שעה — המופע של היום נוסף רק החל משעה זו">🕐</button>
            <button class="icon-btn toggle" title="הפעל/השבת">${r.active ? '⏸' : '▶'}</button>
            <button class="tx-delete" title="מחק הגדרה (עסקאות שכבר נוספו נשארות)">✕</button>
          </li>`).join('') || '<div class="empty-state">אין הוצאות קבועות — הוסף למטה (חוג שבועי, שכר דירה…)</div>'}
      </ul>
      <form id="recForm" class="form-grid mt">
        <input type="text" id="recName" placeholder="שם (חוג, שכר דירה…)" required>
        <input type="number" id="recAmount" placeholder="סכום ₪" min="0.01" step="0.01" required>
        <select id="recFreq">
          <option value="weekly">כל שבוע</option>
          <option value="monthly">כל חודש</option>
        </select>
        <select id="recDay"></select>
        <select id="recCat">${catOptions(null, 'קטגוריה (אוטומטי)')}</select>
        <select id="recHour" title="המופע של היום נוסף רק החל משעה זו. בלי שעה = בטיק הראשון של היום.">
          <option value="">בלי שעה</option>
          ${Array.from({ length: 24 }, (_, h) => `<option value="${h}">${String(h).padStart(2, '0')}:00</option>`).join('')}
        </select>
        <button type="submit" class="btn-primary">➕ הוסף</button>
      </form>
      <div id="recMsg" class="form-msg"></div>
      <div class="stat-sub mt">העסקה נוספת אוטומטית בכל מופע. אם המחשב כבוי ביום המופע — היא תתווסף כשידלק. ⏸ משבית בלי למחוק. 🕐 קובע שעה ביום המופע שממנה העסקה נוספת.</div>
    </section>
  `;

  // בורר היום משתנה לפי התדירות: ימי שבוע (שבועי) או 1–31 (חודשי).
  // 29–31 לא קיימים בכל חודש — בחודש קצר המופע נדחק ליום האחרון בו.
  function fillRecDays() {
    const weekly = $('#recFreq').value === 'weekly';
    $('#recDay').innerHTML = weekly
      ? REC_DAY_NAMES.map((n, i) => `<option value="${i}">יום ${n}</option>`).join('')
      : Array.from({ length: 31 }, (_, i) => {
          const d = i + 1;
          const note = d >= 29 ? ' (בחודש קצר — היום האחרון)' : '';
          return `<option value="${d}">${d} בחודש${note}</option>`;
        }).join('');
  }
  fillRecDays();
  $('#recFreq').addEventListener('change', fillRecDays);

  $('#recList').addEventListener('click', async (e) => {
    const item = e.target.closest('.tx-item');
    if (!item) return;
    if (e.target.closest('.tx-delete')) {
      const r = recs.find((x) => x.id === Number(item.dataset.id));
      if (!confirm(`למחוק את ההוצאה הקבועה "${r.merchant}"? עסקאות שכבר נוספו יישארו.`)) return;
      await api(`/api/recurring/${item.dataset.id}`, { method: 'DELETE' });
      await render();
    } else if (e.target.closest('.toggle')) {
      const r = recs.find((x) => x.id === Number(item.dataset.id));
      await api(`/api/recurring/${item.dataset.id}`, { method: 'PUT', body: JSON.stringify({ active: !r.active }) });
      await render();
    } else if (e.target.closest('.rec-hour')) {
      const r = recs.find((x) => x.id === Number(item.dataset.id));
      const v = prompt('שעה ביום המופע שממנה העסקה נוספת (0-23), ריק = בלי שעה:', r.hour != null ? String(r.hour) : '');
      if (v === null) return; // ביטול
      const hour = v.trim() === '' ? null : Number(v.trim());
      if (hour !== null && (!Number.isInteger(hour) || hour < 0 || hour > 23)) { alert('שעה לא תקינה — מספר בין 0 ל-23.'); return; }
      await api(`/api/recurring/${item.dataset.id}`, { method: 'PUT', body: JSON.stringify({ hour }) });
      await render();
    }
  });

  // שינוי קטגוריה להוצאה קבועה קיימת (משפיע על מופעים עתידיים בלבד; עסקאות
  // שכבר נוספו נשארות בקטגוריה שלהן). ריק = אוטומטי לפי חוקים/ML.
  $('#recList').addEventListener('change', async (e) => {
    const sel = e.target.closest('.rec-cat-select');
    if (!sel) return;
    await api(`/api/recurring/${sel.closest('.tx-item').dataset.id}`, {
      method: 'PUT',
      body: JSON.stringify({ category_id: sel.value ? Number(sel.value) : null }),
    });
    await render();
  });

  $('#recForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#recMsg');
    msg.className = 'form-msg';
    try {
      await api('/api/recurring', {
        method: 'POST',
        body: JSON.stringify({
          merchant: $('#recName').value.trim(),
          amount: Number($('#recAmount').value),
          freq: $('#recFreq').value,
          day: Number($('#recDay').value),
          category_id: $('#recCat').value ? Number($('#recCat').value) : null,
          hour: $('#recHour').value === '' ? null : Number($('#recHour').value),
        }),
      });
      await render();
    } catch (err) { msg.textContent = err.message; msg.classList.add('error'); }
  });

  $('#subList').addEventListener('click', async (e) => {
    const item = e.target.closest('.tx-item');
    if (!item) return;
    if (e.target.closest('.tx-delete')) {
      await api(`/api/subscriptions/${item.dataset.id}`, { method: 'DELETE' });
      await render();
    } else if (e.target.closest('.sub-renew')) {
      await api(`/api/subscriptions/${item.dataset.id}/renew`, { method: 'POST' });
      await render();
    }
  });

  $('#subForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#subMsg');
    msg.className = 'form-msg';
    try {
      await api('/api/subscriptions', {
        method: 'POST',
        body: JSON.stringify({
          name: $('#subName').value,
          amount: $('#subAmount').value ? Number($('#subAmount').value) : null,
          start_date: $('#subStart').value,
          end_date: $('#subEnd').value,
        }),
      });
      await render();
    } catch (err) { msg.textContent = err.message; msg.classList.add('error'); }
  });

  $('#incomeList').addEventListener('click', async (e) => {
    const item = e.target.closest('.tx-item');
    if (!item) return;
    if (e.target.closest('.tx-delete')) {
      await api(`/api/income/${item.dataset.id}`, { method: 'DELETE' });
      await render();
    } else if (e.target.closest('.toggle')) {
      const inc = incomes.find((i) => i.id === Number(item.dataset.id));
      await api(`/api/income/${item.dataset.id}`, { method: 'PUT', body: JSON.stringify({ active: !inc.active }) });
      await render();
    } else if (e.target.closest('.inc-recur')) {
      const inc = incomes.find((i) => i.id === Number(item.dataset.id));
      await api(`/api/income/${item.dataset.id}`, { method: 'PUT', body: JSON.stringify({ recurring: !inc.recurring }) });
      await render();
    } else if (e.target.closest('.income-name-edit')) {
      startIncomeNameEdit(e.target.closest('.income-name-edit'));
    } else if (e.target.closest('.income-amount-edit')) {
      startIncomeAmountEdit(e.target.closest('.income-amount-edit'));
    } else if (e.target.closest('.income-date-edit')) {
      startIncomeDateEdit(e.target.closest('.income-date-edit'));
    }
  });

  // ניווט בין מחזורי תזרים — משתמש באותו currentMonth הגלובלי כמו הדשבורד
  $('#incPrev').addEventListener('click', () => { currentMonth = shiftMonthStr(currentMonth, -1); render(); });
  $('#incNext').addEventListener('click', () => { currentMonth = shiftMonthStr(currentMonth, 1); render(); });

  $('#incomeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#incMsg');
    msg.className = 'form-msg';
    try {
      await api('/api/income', {
        method: 'POST',
        body: JSON.stringify({
          name: $('#incName').value,
          amount: Number($('#incAmount').value),
          date: $('#incDate').value || null,
          recurring: $('#incRecurring').checked,
          day_of_month: $('#incDay').value || undefined,
        }),
      });
      await render();
    } catch (err) { msg.textContent = err.message; msg.classList.add('error'); }
  });

  $('#txForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    flashMsg('#formMsg', '', ''); // ניקוי הודעה קודמת
    let tx;
    try {
      const inst = Number($('#txInstallments').value) || 1;
      tx = await api('/api/transactions', {
        method: 'POST',
        body: JSON.stringify({
          date: $('#txDate').value,
          amount: Number($('#txAmount').value),
          merchant: $('#txMerchant').value,
          category_id: $('#txCategory').value ? Number($('#txCategory').value) : null,
          type: $('#txType').value,
          installments: inst > 1 ? inst : undefined,
        }),
      });
    } catch (err) {
      // כישלון בשמירה עצמה — רק כאן מותר לומר שהעסקה לא נוספה
      flashMsg('#formMsg', `❌ העסקה לא נוספה — ${err.message}`, 'error');
      return;
    }
    const detail = tx.installments
      ? ` — פוצלה ל-${tx.installments.count} תשלומים של ${fmtILS.format(tx.installments.per_amount)}`
      : tx.category_name && !$('#txCategory').value
        ? ` — סווגה אוטומטית: ${tx.category_icon} ${tx.category_name}` : '';
    $('#txAmount').value = ''; $('#txMerchant').value = ''; $('#txInstallments').value = '';
    await render(); // רענון מלא
    // ההודעה נכתבת אחרי ה-render — לפניו היא נמחקת יחד עם התצוגה הישנה
    flashMsg('#formMsg', `✅ העסקה נוספה בהצלחה${detail}`, 'ok');
  });
}

/* ================= חיזוי ================= */
async function viewForecast(el) {
  const [forecast, history] = await Promise.all([
    api(`/api/forecast/${currentMonth}`),
    api('/api/flow/history/list'),
  ]);

  const hasForecast = forecast.predicted_expenses > 0;
  el.innerHTML = `
    <section class="cards-row">
      <div class="card stat"><div class="stat-label">🔮 הוצאות חזויות סוף חודש</div>
        <div class="stat-value warn">${hasForecast ? fmtILS.format(forecast.predicted_expenses) : '—'}</div>
        <div class="stat-sub">שיטה: ${forecast.method ?? '—'}${forecast.months_used ? ` · ${forecast.months_used} חודשי היסטוריה` : ''}</div></div>
      <div class="card stat"><div class="stat-label">יתרה צפויה</div>
        <div class="stat-value ${forecast.predicted_remaining >= 0 ? 'plus' : 'minus'}">${hasForecast ? fmtILS.format(forecast.predicted_remaining) : '—'}</div>
        <div class="stat-sub">מתוך הכנסות של ${fmtILS.format(forecast.total_income)}</div></div>
      <div class="card stat"><div class="stat-label">הוצא עד כה</div>
        <div class="stat-value minus">${fmtILS.format(forecast.actual_expenses)}</div></div>
    </section>

    <section class="card"><h2>חיזוי לפי קטגוריה (לפי התפלגות היסטורית)</h2>
      <div class="category-bars" id="fcCats"></div>
    </section>

    <section class="card"><h2>השוואת חודשים</h2>
      <div class="chart-box tall"><canvas id="historyChart"></canvas></div>
    </section>
  `;

  const cats = forecast.by_category_predicted;
  const maxCat = Math.max(...cats.map((c) => c.predicted), 1);
  $('#fcCats').innerHTML = cats.map((c) => `
    <div class="cat-bar-row" style="padding:4px 0">
      <span class="cat-bar-name" style="min-width:120px">${escapeHtml(c.name)}</span>
      <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${(c.predicted / maxCat) * 100}%;background:${safeColor(c.color)}"></div></div>
      <span class="cat-bar-amount">${fmtILS.format(c.predicted)}</span>
    </div>`).join('') || '<div class="empty-state">אין מספיק היסטוריה לפירוק לפי קטגוריות</div>';

  const months = history.slice(0, 12).reverse();
  if (months.length) {
    newChart($('#historyChart'), {
      type: 'bar',
      data: {
        labels: months.map((m) => m.month),
        datasets: [
          { label: 'הכנסות', data: months.map((m) => m.expected_income + m.actual_income), backgroundColor: '#2fae74' },
          { label: 'הוצאות', data: months.map((m) => m.actual_expenses), backgroundColor: '#e05a63' },
          { label: 'חיזוי', data: months.map((m) => m.expected_expenses || null), backgroundColor: '#f0a640' },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { rtl: true } },
        scales: { y: { ticks: { callback: (v) => '₪' + Number(v).toLocaleString('he-IL') } } },
      },
    });
  }
}

/* ================= הגדרות ================= */
async function viewSettings(el) {
  const s = await api('/api/settings');
  // ריק = כל הימים כבויים (המשתמש ביטל את סיכום התזרים). אסור ליפול כאן ל-'0,2,4' —
  // ברירת המחדל כבר מוחלת בשרת (DEFAULTS ב-routes/settings.js) כשהמפתח לא קיים,
  // ופולבק בלקוח היה מציג 3 ימים מסומנים למרות שההתראות כבויות — ושמירה היתה מדליקה אותן מחדש.
  const days = (s.notify_days ?? '').split(',').filter(Boolean).map(Number);
  const dayNames = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  // היום שחל על המחזור הנוכחי (אחרון ב-history, אחרת ערך הבסיס)
  const cycleDayNow = (s.cycle_day_history || []).at(-1)?.day ?? Number(s.cycle_day || 10);

  el.innerHTML = `
    <section class="card">
      <h2>בוט טלגרם
        ${s.bot?.active ? `<span class="badge on">פעיל @${s.bot.username}</span>` : '<span class="badge off">כבוי</span>'}
      </h2>
      <div class="settings-grid">
        <label>Bot Token</label>
        <input type="text" id="tgToken" value="${escapeHtml(s.telegram_token)}" placeholder="קבל token מ-@BotFather בטלגרם">
        <label>Chat ID (את/ה)</label>
        <input type="text" id="tgChat" value="${escapeHtml(s.telegram_chat_id)}" placeholder="נקבע אוטומטית כששולחים /start לבוט">
        <label>Chat ID (בן/בת זוג)</label>
        <input type="text" id="tgChat2" value="${escapeHtml(s.telegram_chat_id_2)}" placeholder="נקבע אוטומטית כששולחים /start מהמכשיר השני">
      </div>
      <div class="stat-sub">הרשאות זהות לשני ה-Chat ID — אחרי שהראשון מחובר, שליחת /start ממכשיר נוסף מחברת אותו אוטומטית. אפשר לרוקן שדה ולשמור כדי לנתק.</div>
      ${s.bot?.error ? `<div class="form-msg error">שגיאת בוט: ${escapeHtml(s.bot.error)}</div>` : ''}
      <h3>התראות תזרים</h3>
      <div class="row-flex" id="notifyDays">
        ${dayNames.map((name, i) => `
          <label style="display:flex;align-items:center;gap:4px;font-size:0.85rem">
            <input type="checkbox" value="${i}" ${days.includes(i) ? 'checked' : ''}> ${name}
          </label>`).join('')}
        <span style="color:var(--muted);font-size:0.85rem">בשעה</span>
        <input type="number" id="notifyHour" value="${escapeHtml(s.notify_hour)}" min="0" max="23" style="width:70px">
      </div>
      <h3>מחזור תזרים</h3>
      <div class="row-flex">
        <span style="color:var(--muted);font-size:0.85rem">יום תחילת מחזור (יום המשכורת/חיוב)</span>
        <input type="number" id="cycleDay" value="${escapeHtml(String(cycleDayNow))}" min="1" max="28" style="width:70px">
      </div>
      <label style="display:flex;align-items:center;gap:6px;font-size:0.85rem;margin-top:6px">
        <input type="checkbox" id="cycleDayFromNow" checked>
        החל מהמחזור הנוכחי ואילך בלבד (${escapeHtml(s.cycle_current?.label || '')}) — לא לחתוך מחדש חודשים קודמים
      </label>
      <div class="stat-sub">כשמסומן, כל מחזור שכבר נסגר נשאר בדיוק כפי שהוא, ורק הגבול
        בין המחזור הקודם לנוכחי זז. כשלא מסומן — היום החדש חל על כל ההיסטוריה
        וכל החודשים נחתכים מחדש.</div>
      ${(s.cycle_day_history || []).length ? `<div class="stat-sub">שינויים קיימים: יום ${escapeHtml(s.cycle_day || '10')} עד
        ${escapeHtml(s.cycle_day_history[0].effective_month)}, ואז
        ${s.cycle_day_history.map((h) => `יום ${h.day} מ-${escapeHtml(h.effective_month)}`).join(' · ')}.</div>` : ''}
      <h3>מקלדת הבוט</h3>
      <div class="row-flex">
        <label style="display:flex;align-items:center;gap:6px;font-size:0.85rem">
          <input type="checkbox" id="menuPersistent" ${s.menu_persistent === '1' ? 'checked' : ''}>
          📌 קיבוע מקלדת התפריט בטלגרם (ניסיוני)
        </label>
      </div>
      <div class="stat-sub">כשהקיבוע פעיל, התפריט נפתח אוטומטית בכניסה לצ'אט. לחיצת "חזרה" בטלפון תמיד סוגרת את הפאנל (התנהגות של טלגרם — אין דרך למנוע), אבל הוא חוזר בכניסה הבאה. אם "חזרה" נתקע בצ'אט — בטל כאן או שלח /settings לבוט.</div>
      <div class="row-flex mt">
        <button id="saveSettings" class="btn-primary">שמור</button>
        <span id="settingsMsg" class="form-msg grow"></span>
      </div>
    </section>

    <section class="card">
      <h2>🤖 מנוע הניתוח</h2>
      <div class="stat-sub">המנוע שמריץ את ניתוחי התלוש והמשכנתא ואת שאלות ההמשך — ב-web ובבוט.</div>
      <div id="engineChoice" class="mt">
        <label class="engine-opt">
          <input type="radio" name="llmEngine" value="gemini" ${s.llm_engine !== 'chatgpt' ? 'checked' : ''}>
          <span><strong>Gemini</strong> — מפתח חינמי מ-Google. ${s.gemini_api_key_set ? '<span class="badge on">מפתח מוגדר</span>' : '<span class="badge off">אין מפתח</span>'}</span>
        </label>
        <label class="engine-opt">
          <input type="radio" name="llmEngine" value="chatgpt" ${s.llm_engine === 'chatgpt' ? 'checked' : ''}>
          <span><strong>ChatGPT</strong> — דרך המנוי הקיים שלך ($20), בלי API בתשלום. ${
            s.codex?.installed && s.codex?.loggedIn ? '<span class="badge on">מחובר</span>' : '<span class="badge off">לא מחובר</span>'}</span>
        </label>
      </div>
      ${s.codex?.installed && s.codex?.loggedIn ? '' : `
        <div class="form-msg warn-msg">⚠️ ${escapeHtml(s.codex?.reason ?? 'הגשר ל-ChatGPT לא זמין')}</div>
        <div class="stat-sub">שני צעדים חד-פעמיים בטרמינל: <code>npm i -g @openai/codex</code> ואז <code>codex login</code> (נפתח דפדפן — הסיסמה לא נשמרת כאן). אחר כך לחץ "בדוק חיבור".</div>`}
      ${s.codex?.apiKeyInEnv ? '<div class="form-msg error">🔴 קיים OPENAI_API_KEY בסביבה — הסר אותו, אחרת השימוש עלול להתחייב לפי token במקום להיזקף למנוי</div>' : ''}
      <div class="row-flex mt">
        <button id="saveEngine" class="btn-primary">💾 שמור מנוע</button>
        <button id="checkCodex" class="btn-secondary">🔄 בדוק חיבור ל-ChatGPT</button>
        <span id="engineMsg" class="form-msg grow"></span>
      </div>

      <div class="ps-section-title"><h3>📊 שימוש במכסה</h3>
        <span class="stat-sub">ספירה מקומית — אף מנוע לא מדווח "כמה נשאר"</span></div>
      <div id="usageBox"></div>
    </section>

    <section class="card">
      <h2>מפתח Gemini
        ${s.gemini_api_key_set ? '<span class="badge on">מפתח מוגדר</span>' : '<span class="badge off">לא מוגדר</span>'}
      </h2>
      <div class="settings-grid">
        <label>Gemini API Key</label>
        <input type="text" id="geminiKey" value="${escapeHtml(s.gemini_api_key)}" placeholder="מפתח חינמי מ-aistudio.google.com">
      </div>
      <div class="stat-sub">
        מפתח חינמי: נכנסים ל-<code>aistudio.google.com</code> עם חשבון Google → "Get API key" → מדביקים כאן. בלי כרטיס אשראי.
        בלי מפתח, טאב התלוש עדיין מריץ בדיקות מקומיות ומאפשר להעתיק את הפרומפט להדבקה ידנית בצ׳אטבוט.
        <br><strong>פרטיות:</strong> ת"ז, חשבון בנק, כתובת וטלפון מוסרים אוטומטית לפני השליחה. במסלול החינמי Google עשויה להשתמש בנתונים לשיפור המודלים.
      </div>
      <div class="row-flex mt">
        <button id="saveGemini" class="btn-primary">שמור</button>
        <span id="geminiMsg" class="form-msg grow"></span>
      </div>
    </section>

    <section class="card">
      <h2>סטטוס מערכת</h2>
      <div class="settings-grid">
        <label>מנוע ML (Python)</label>
        <div>${s.ml?.available ? '<span class="badge on">פעיל</span>' : '<span class="badge off">לא זמין — עובדים עם חוקים בלבד</span>'}</div>
        <label>מסד נתונים</label>
        <div><code>data/moneysaver.db</code> — גבה את הקובץ הזה כדי לשמור על הנתונים</div>
      </div>
    </section>

    <section class="card">
      <h2>איך מתחברים לבוט?</h2>
      <ol style="padding-right:20px;font-size:0.9rem;line-height:1.9">
        <li>פתח את <strong>@BotFather</strong> בטלגרם ושלח <code>/newbot</code></li>
        <li>העתק את ה-token שקיבלת לשדה למעלה ולחץ שמור</li>
        <li>פתח את הבוט שיצרת ושלח לו <code>/start</code> — ה-Chat ID יישמר אוטומטית</li>
        <li>מעכשיו: שלח "קפה גרג 25", העבר SMS מהבנק, או שלח קובץ CSV/PDF</li>
        <li>בן/בת זוג: פותחים את אותו בוט מהטלפון שלהם ושולחים <code>/start</code> — מתחברים אוטומטית עם הרשאות זהות</li>
      </ol>
    </section>
  `;

  $('#saveSettings').addEventListener('click', async () => {
    const msg = $('#settingsMsg');
    msg.className = 'form-msg grow';
    try {
      const checkedDays = $$('#notifyDays input[type=checkbox]:checked').map((c) => c.value).join(',');
      const result = await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          telegram_token: $('#tgToken').value.trim(),
          telegram_chat_id: $('#tgChat').value.trim(),
          telegram_chat_id_2: $('#tgChat2').value.trim(),
          notify_days: checkedDays,
          notify_hour: $('#notifyHour').value,
          cycle_day: $('#cycleDay').value,
          // ריק = היום חל על כל ההיסטוריה (ההתנהגות הישנה)
          cycle_day_from: $('#cycleDayFromNow').checked ? 'current' : '',
          menu_persistent: $('#menuPersistent').checked ? '1' : '0',
        }),
      });
      msg.textContent = result.bot?.active ? `✅ נשמר — הבוט פעיל (@${result.bot.username})`
        : result.bot?.error ? `נשמר, אבל הבוט לא עלה: ${result.bot.error}` : '✅ נשמר';
      msg.classList.add(result.bot?.error ? 'error' : 'ok');
    } catch (err) { msg.textContent = err.message; msg.classList.add('error'); }
  });

  // מפתח Gemini נשמר בנפרד — אינו קשור לבוט ולא מצריך restart שלו
  $('#saveGemini').addEventListener('click', async () => {
    const msg = $('#geminiMsg');
    msg.className = 'form-msg grow';
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ gemini_api_key: $('#geminiKey').value.trim() }),
      });
      msg.textContent = '✅ נשמר';
      msg.classList.add('ok');
    } catch (err) { msg.textContent = err.message; msg.classList.add('error'); }
  });

  /* ---------- מנוע הניתוח ומד המכסה ---------- */
  const ENGINE_HE = { gemini: 'Gemini', chatgpt: 'ChatGPT (מנוי)' };

  function renderUsage(usage) {
    if (!usage) { $('#usageBox').innerHTML = ''; return; }
    const reset = usage.reset_at ? new Date(usage.reset_at).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '';
    const rows = Object.entries(usage.engines ?? {}).map(([k, u]) => `
      <tr>
        <td>${ENGINE_HE[k] ?? k}</td>
        <td>${u.count_today}</td>
        <td>${u.total}</td>
        <td>${u.last_at ? new Date(u.last_at).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '—'}</td>
        <td>${u.exhausted ? '<span class="badge dup">מוצתה</span>' : '<span class="badge new">פנויה</span>'}</td>
      </tr>`).join('');
    $('#usageBox').innerHTML = `
      <div class="table-wrap">
        <table class="import-table">
          <thead><tr><th>מנוע</th><th>היום</th><th>סה"כ</th><th>אחרון</th><th>מצב</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="stat-sub">מכסת Gemini היומית מתאפסת בחצות שעון קליפורניה — כ-${reset}. מכסת ChatGPT היא חלון מתגלגל של המנוי ומשותפת עם השימוש האישי שלך ב-ChatGPT.</div>`;
  }
  renderUsage(s.usage);

  $('#saveEngine').addEventListener('click', async () => {
    const msg = $('#engineMsg');
    msg.className = 'form-msg grow';
    const engine = $('input[name="llmEngine"]:checked')?.value ?? 'gemini';
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify({ llm_engine: engine }) });
      msg.textContent = `✅ המנוע הפעיל: ${ENGINE_HE[engine]}`;
      msg.classList.add('ok');
    } catch (err) { msg.textContent = err.message; msg.classList.add('error'); }
  });

  $('#checkCodex').addEventListener('click', async () => {
    const btn = $('#checkCodex');
    const msg = $('#engineMsg');
    btn.disabled = true;
    msg.className = 'form-msg grow';
    msg.textContent = 'בודק…';
    try {
      const { codex } = await api('/api/settings/codex/recheck', { method: 'POST' });
      msg.classList.add(codex.installed && codex.loggedIn ? 'ok' : 'error');
      msg.textContent = codex.installed && codex.loggedIn
        ? `✅ מחובר ל-ChatGPT (${codex.version ?? 'codex'}) — אפשר לבחור את המנוע ולשמור`
        : `❌ ${codex.reason}`;
    } catch (err) { msg.textContent = err.message; msg.classList.add('error'); }
    finally { btn.disabled = false; }
  });
}

/* ================= תלוש משכורת ================= */
// שמות השדות בעברית — חייב להתאים ל-FIELD_NAMES_HE ב-server/lib/payslip.js
const PAYSLIP_FIELDS = {
  gross: 'שכר ברוטו', net: 'שכר נטו', deductions_total: 'סה"כ ניכויי חובה',
  insured_salary: 'שכר מבוטח', base_salary: 'שכר יסוד',
  income_tax: 'מס הכנסה', national_insurance: 'ביטוח לאומי', health_tax: 'דמי בריאות',
  pension_employee: 'פנסיה — עובד', pension_employer: 'פנסיה — מעביד',
  severance: 'פיצויים', study_fund_employee: 'קרן השתלמות — עובד',
  study_fund_employer: 'קרן השתלמות — מעביד', credit_points: 'נקודות זיכוי', hours: 'שעות/ימי עבודה',
};
// קיבוץ השדות לתצוגה — כל קבוצה בכרטיס משלה, בסדר הזה
const PAYSLIP_GROUPS = [
  { title: '💰 תשלומים', keys: ['gross', 'base_salary', 'insured_salary', 'hours'] },
  { title: '➖ ניכויים מהעובד', keys: ['deductions_total', 'income_tax', 'national_insurance', 'health_tax', 'pension_employee', 'study_fund_employee'] },
  { title: '🏦 הפרשות המעסיק', keys: ['pension_employer', 'study_fund_employer', 'severance'] },
  { title: '📌 נתונים נוספים', keys: ['credit_points'] },
];
const COUNT_FIELDS = ['credit_points', 'hours'];
const CHECK_ICON = { ok: '✅', warn: '🟡', fail: '🔴' };
const CHECK_TITLE = { ok: 'תקין', warn: 'לבדיקה', fail: 'חשד לטעות' };

// החודש המוצג בטאב התלוש — נשמר בין רינדורים כדי שניווט יישאר יציב
let payslipMonth = null;

function monthLabelHe(month) {
  return fmtMonth.format(new Date(month + '-01T12:00:00'));
}

// מודלים נוטים להחליק לסימון LaTeX ("\text{ברוטו} \times 6\%") למרות ההוראה
// בפרומפט. מנקים אותו לפני הרינדור כדי שהמשתמש יראה נוסחה קריאה.
// חייב להישאר זהה ל-stripLatexPlain ב-server/lib/payslip.js (הבוט משתמש בה).
const LATEX_CMD = /\\(?:text|mathbf|mathrm|textbf|mathit|textit|operatorname)\s*\{([^{}]*)\}/g;
const LATEX_FRAC = /\\(?:d)?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g;

function stripLatex(s) {
  let out = String(s ?? '')
    .replace(/\$\$([\s\S]*?)\$\$/g, '$1')          // בלוק מתמטי
    .replace(/\\\[([\s\S]*?)\\\]/g, '$1')
    .replace(/\\\(([\s\S]*?)\\\)/g, '$1')
    .replace(/\$([^$\n]+)\$/g, '$1');              // מתמטיקה בשורה
  // בלולאה — הפקודות מקוננות: \mathbf{23,356.43 \text{ש"ח}}
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
    .replace(/\\rightarrow|\\to\b/g, '←')          // RTL: חץ "לכיוון" מצביע שמאלה
    .replace(/\\%/g, '%').replace(/\\\$/g, '₪')
    .replace(/\\[,;:!]/g, ' ')                     // רווחים דקים של LaTeX
    .replace(/\\\\/g, '\n')
    .replace(/\{|\}/g, '')                         // סוגריים מסולסלים שנותרו
    .replace(/[ \t]{2,}/g, ' ');                   // רווחים כפולים שנוצרו מההסרה
}

// ממיר Markdown מינימלי. escapeHtml על הכל קודם — אין מעבר של HTML גולמי,
// ולכן פלט ה-LLM לא יכול להזריק תגיות (בנוסף ל-CSP שחוסם script).
function renderMarkdown(md) {
  const lines = stripLatex(escapeHtml(md)).split('\n');
  const out = [];
  let inList = false;
  const inline = (s) => s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    // סטטוסים בטקסט → תגית צבעונית
    .replace(/✅/g, '<span class="md-ok">✅</span>')
    .replace(/🟡/g, '<span class="md-warn">🟡</span>')
    .replace(/🔴/g, '<span class="md-bad">🔴</span>');
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  // שורת טבלה: | תא | תא |  ; שורת המפריד: |---|---|  (חייב להתיר | פנימי)
  const isRow = (l) => /^\|.*\|$/.test(l);
  const isSep = (l) => /^\|[\s:|-]+\|$/.test(l) && l.includes('-');
  const cells = (l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // טבלת Markdown — נאספת כבלוק שלם
    if (isRow(line) && isRow((lines[i + 1] ?? '').trim()) && isSep((lines[i + 1] ?? '').trim())) {
      closeList();
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && isRow(lines[i].trim())) body.push(cells(lines[i++].trim()));
      i--;
      out.push('<div class="md-table-wrap"><table class="md-table"><thead><tr>'
        + head.map((c) => `<th>${inline(c)}</th>`).join('')
        + '</tr></thead><tbody>'
        + body.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('')
        + '</tbody></table></div>');
      continue;
    }

    const li = line.match(/^[-*+]\s+(.*)$/) || line.match(/^\d+[.)]\s+(.*)$/);
    if (li) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    closeList();
    if (!line || /^[-—_*]{3,}$/.test(line)) continue;   // מפריד אופקי — מדולג
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      // ## (סעיף ראשי בפרומפט) → h3 המעוצב; כל רמה עמוקה יותר → h4/h5
      const lvl = Math.min(Math.max(h[1].length + 1, 3), 5);
      out.push(`<h${lvl}>${inline(h[2].replace(/^#+\s*/, ''))}</h${lvl}>`);
      continue;
    }
    // ציטוט/הבהרה
    const q = line.match(/^&gt;\s*(.*)$/);
    if (q) { out.push(`<p class="md-note">${inline(q[1])}</p>`); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('');
}

async function viewPayslip(el) {
  const list = await api('/api/payslip');
  // ברירת מחדל: התלוש האחרון שהועלה; אם אין — החודש הנוכחי
  if (!payslipMonth) payslipMonth = list[0]?.month ?? currentMonth;

  el.innerHTML = `
    <div class="cycle-nav">
      <button class="btn-secondary" id="psPrev">▶ חודש קודם</button>
      <span class="cycle-total" id="psNavLabel"></span>
      <button class="btn-secondary" id="psNext">חודש הבא ◀</button>
    </div>

    <section class="card" id="psDetailCard">
      <div id="psDetail"></div>
    </section>

    <section class="card">
      <h2>העלאת תלוש משכורת</h2>
      <div class="dropzone" id="psDrop">
        🧾 גרור לכאן את תלוש המשכורת (PDF), או לחץ לבחירה<br>
        <span style="font-size:0.8rem">חודש התלוש מזוהה אוטומטית · תלוש אחד לכל חודש (העלאה חוזרת מחליפה)</span><br>
        <span style="font-size:0.8rem">תלוש סרוק כתמונה לא נתמך — צריך PDF עם טקסט (כפי שמתקבל במייל מהמעסיק)</span>
        <input type="file" id="psFile" accept=".pdf" hidden>
      </div>
      <div class="row-flex mt" id="psMonthRow" hidden>
        <span style="color:var(--muted);font-size:0.85rem">לא זוהה חודש בתלוש — בחר ידנית:</span>
        <input type="month" id="psMonth">
        <button id="psMonthGo" class="btn-primary">העלה</button>
      </div>
      <div id="psMsg" class="form-msg"></div>
    </section>

    <section class="card">
      <h2>תלושים שנשמרו</h2>
      <div id="psList">${list.length ? '' : '<div class="empty-state">עדיין לא הועלה אף תלוש</div>'}</div>
    </section>
  `;

  $('#psNavLabel').textContent = monthLabelHe(payslipMonth);
  $('#psPrev').addEventListener('click', () => goMonth(-1));
  $('#psNext').addEventListener('click', () => goMonth(1));

  async function goMonth(delta) {
    payslipMonth = shiftMonthStr(payslipMonth, delta);
    $('#psNavLabel').textContent = monthLabelHe(payslipMonth);
    await openDetail(payslipMonth, { scroll: false });
  }

  function renderList() {
    if (!list.length) return;
    $('#psList').innerHTML = `
      <div class="table-wrap">
        <table class="import-table">
          <thead><tr><th>חודש</th><th>ברוטו</th><th>נטו</th><th>בדיקות</th><th>ניתוח</th><th></th></tr></thead>
          <tbody>
            ${list.map((p) => {
              const bad = p.checks.filter((c) => c.status !== 'ok').length;
              return `<tr${p.month === payslipMonth ? ' class="ps-row-active"' : ''}>
                <td>${monthLabelHe(p.month)}</td>
                <td>${p.fields.gross ? fmtILS.format(p.fields.gross) : '—'}</td>
                <td>${p.fields.net ? fmtILS.format(p.fields.net) : '—'}</td>
                <td>${bad ? `<span class="badge dup">${bad} לבדיקה</span>` : '<span class="badge new">תקין</span>'}</td>
                <td>${p.analyzed ? '<span class="badge on">נותח</span>' : '<span class="badge off">טרם</span>'}</td>
                <td><button class="btn-secondary ps-open" data-month="${p.month}">פתח</button></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
    $$('.ps-open').forEach((b) => b.addEventListener('click', () => {
      payslipMonth = b.dataset.month;
      $('#psNavLabel').textContent = monthLabelHe(payslipMonth);
      renderList();
      openDetail(payslipMonth);
    }));
  }
  renderList();
  await openDetail(payslipMonth, { scroll: false });

  /* ---------- העלאה ---------- */
  const drop = $('#psDrop');
  const fileInput = $('#psFile');
  let pendingFile = null; // הקובץ ממתין לבחירת חודש ידנית

  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragover');
    if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => fileInput.files[0] && upload(fileInput.files[0]));
  $('#psMonthGo').addEventListener('click', () => {
    if (pendingFile && $('#psMonth').value) upload(pendingFile, $('#psMonth').value);
  });

  async function upload(file, month = null) {
    const msg = $('#psMsg');
    msg.className = 'form-msg';
    msg.textContent = 'קורא את התלוש… ⏳';
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (month) fd.append('month', month);
      // לא דרך api() — הוא כופה Content-Type: application/json
      const res = await fetch('/api/payslip/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) {
        if (data.needMonth) {
          pendingFile = file;
          $('#psMonthRow').hidden = false;
          $('#psMonth').value = currentMonth;
        }
        throw new Error(data.error);
      }
      pendingFile = null;
      $('#psMonthRow').hidden = true;
      msg.className = 'form-msg ok';
      msg.textContent = `✅ ${data.replaced ? 'הוחלף' : 'נשמר'} תלוש ${monthLabelHe(data.month)} · זוהו ${Object.keys(data.fields).length} שדות`
        + (data.piiRemoved ? ` · הוסרו ${data.piiRemoved} פרטים מזהים` : '')
        + (data.replaced ? ' · הניתוח הקודם נמחק' : '');
      await openDetail(data.month);
      const fresh = await api('/api/payslip');
      list.length = 0;
      list.push(...fresh);
      renderList();
    } catch (err) {
      msg.className = 'form-msg error';
      msg.textContent = err.message;
    }
  }

  /* ---------- פירוט ---------- */
  // כותרת הניתוח + התוכן — משותף לטעינה ולהרצה חדשה
  function analysisBlock(res) {
    if (!res?.analysis_md) return '';
    return `<div class="ps-section-title"><h3>🔍 ניתוח מקצועי</h3>
        <span class="stat-sub">${escapeHtml(res.analysis_at || '')} · ${escapeHtml(res.analysis_model || '')}</span></div>
      <div class="analysis-md">${renderMarkdown(res.analysis_md)}</div>`;
  }

  function qaBlock(qa = []) {
    if (!qa.length) return '';
    return qa.map((h, i) => `
      <div class="qa-item">
        <div class="qa-q">❓ ${escapeHtml(h.q)}</div>
        <div class="qa-a analysis-md">${renderMarkdown(h.a)}</div>
        <div class="stat-sub">${escapeHtml(h.at || '')}${i === qa.length - 1 ? '' : ''}</div>
      </div>`).join('');
  }

  async function openDetail(month, { scroll = true } = {}) {
    let d;
    try {
      d = await api(`/api/payslip/${month}`);
    } catch {
      // אין תלוש לחודש הזה — מציגים מצב ריק במקום שגיאה
      $('#psDetail').innerHTML = `
        <div class="row-flex spread"><h2>תלוש ${monthLabelHe(month)}</h2></div>
        <div class="empty-state">אין תלוש שמור לחודש הזה — העלה אותו למטה, או נווט לחודש אחר</div>`;
      return;
    }

    // כרטיסי סיכום עליונים
    const tile = (label, value, cls = '') => value === undefined ? ''
      : `<div class="ps-tile"><div class="stat-label">${label}</div><div class="stat-value ${cls}">${fmtILS.format(value)}</div></div>`;
    const tiles = tile('שכר ברוטו', d.fields.gross)
      + tile('סה"כ ניכויים', d.fields.deductions_total, 'minus')
      + tile('שכר נטו', d.fields.net, 'plus');

    // קבוצות שדות — רק קבוצות שיש בהן ערכים
    const groups = PAYSLIP_GROUPS.map((g) => {
      const rows = g.keys.filter((k) => typeof d.fields[k] === 'number')
        .map((k) => `<label>${PAYSLIP_FIELDS[k]}</label><div class="ps-val">${COUNT_FIELDS.includes(k) ? d.fields[k] : fmtILS.format(d.fields[k])}</div>`)
        .join('');
      return rows ? `<div class="ps-group"><h4>${g.title}</h4><div class="settings-grid">${rows}</div></div>` : '';
    }).join('');

    const badCount = d.checks.filter((c) => c.status !== 'ok').length;

    $('#psDetail').innerHTML = `
      <div class="row-flex spread">
        <h2>תלוש ${monthLabelHe(d.month)}</h2>
        <span class="badge ${badCount ? 'dup' : 'new'}">${badCount ? `${badCount} ממצאים לבדיקה` : 'כל הבדיקות תקינות'}</span>
      </div>

      ${tiles ? `<div class="ps-tiles">${tiles}</div>` : ''}

      ${groups || '<div class="empty-state">לא זוהו שדות אוטומטית — הניתוח עדיין יעבוד על טקסט התלוש המלא</div>'}

      <div class="ps-section-title"><h3>✔️ בדיקות אוטומטיות</h3><span class="stat-sub">מחושבות מקומית, בלי מודל AI</span></div>
      ${d.checks.length ? `<ul class="ps-checks">${d.checks.map((c) =>
        `<li class="ps-${c.status}">
          <div class="ps-check-head">${CHECK_ICON[c.status]} <strong>${escapeHtml(c.label)}</strong>
            <span class="badge ps-badge-${c.status}">${CHECK_TITLE[c.status]}</span></div>
          <div class="ps-check-detail">${escapeHtml(c.detail)}</div>
        </li>`).join('')}</ul>`
        : '<div class="empty-state">אין מספיק נתונים שחולצו כדי להריץ בדיקות</div>'}

      <div class="row-flex mt">
        <button id="psAnalyze" class="btn-primary">🔍 ${d.analysis_md ? 'נתח מחדש' : 'נתח עם Gemini'}</button>
        <button id="psPdf" class="btn-secondary" title="פתח את קובץ התלוש המקורי בטאב חדש">📄 פתח PDF</button>
        <button id="psCopy" class="btn-secondary">📋 העתק פרומפט</button>
        <button id="psDelete" class="btn-danger-outline">🗑 מחק</button>
      </div>
      <div class="stat-sub">הניתוח נשלח ל-Google Gemini לאחר הסרה אוטומטית של ת"ז, חשבון בנק, כתובת וטלפון. הסכומים והרכיבים כן נשלחים (בלעדיהם אין מה לנתח); שם העובד לא תמיד ניתן להסרה אוטומטית.</div>
      <div id="psAnalyzeMsg" class="form-msg"></div>

      <div id="psAnalysis">${analysisBlock(d)}</div>

      <div id="psQaWrap" ${d.analysis_md ? '' : 'hidden'}>
        <div class="ps-section-title"><h3>💬 שאלות על התלוש</h3>
          <button id="psQaClear" class="btn-link" ${d.qa?.length ? '' : 'hidden'}>נקה שיחה</button></div>
        <div id="psQaList">${qaBlock(d.qa)}</div>
        <div class="qa-ask">
          <input type="text" id="psQaInput" maxlength="1000" placeholder="לדוגמה: כמה מס הכנסה הייתי אמור לשלם? מגיע לי החזר?">
          <button id="psQaSend" class="btn-primary">שאל</button>
        </div>
        <div id="psQaMsg" class="form-msg"></div>
      </div>
    `;

    $('#psPdf').addEventListener('click', () => window.open(`/api/payslip/${month}/pdf`, '_blank'));
    $('#psCopy').addEventListener('click', async () => {
      const msg = $('#psAnalyzeMsg');
      try {
        await navigator.clipboard.writeText(d.prompt);
        msg.className = 'form-msg ok';
        msg.textContent = '✅ הפרומפט + טקסט התלוש הועתקו — הדבק בכל צ׳אטבוט (ChatGPT / Gemini / Claude)';
      } catch {
        msg.className = 'form-msg error';
        msg.textContent = 'ההעתקה נכשלה — הדפדפן חסם גישה ללוח';
      }
    });
    $('#psDelete').addEventListener('click', async () => {
      if (!confirm(`למחוק את תלוש ${monthLabelHe(month)}? הפעולה בלתי הפיכה.`)) return;
      await api(`/api/payslip/${month}`, { method: 'DELETE' });
      render();
    });
    $('#psAnalyze').addEventListener('click', async () => {
      const btn = $('#psAnalyze');
      const msg = $('#psAnalyzeMsg');
      btn.disabled = true;
      msg.className = 'form-msg';
      // נמדד: ניתוח מלא ~330 שניות מול Codex (ChatGPT), ~60 מול Gemini
    msg.textContent = 'מנתח… ⏳ Gemini כדקה, ChatGPT עד כ-6 דקות — אל תסגור את הדף';
      try {
        const result = await api(`/api/payslip/${month}/analyze`, { method: 'POST' });
        msg.className = 'form-msg ok';
        msg.textContent = '✅ הניתוח הושלם';
        d.analysis_md = result.analysis_md;
        $('#psAnalysis').innerHTML = analysisBlock(result);
        // ניתוח חדש מאפס את שאלות ההמשך (הן התייחסו לניתוח הקודם)
        $('#psQaWrap').hidden = false;
        $('#psQaList').innerHTML = '';
        $('#psQaClear').hidden = true;
        btn.textContent = '🔍 נתח מחדש';
        $('#psAnalysis').scrollIntoView({ behavior: 'smooth' });
      } catch (err) {
        msg.className = 'form-msg error';
        msg.textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    });

    /* ---------- שאלות המשך ---------- */
    const qaInput = $('#psQaInput');
    async function askQuestion() {
      const question = qaInput.value.trim();
      const msg = $('#psQaMsg');
      if (!question) return;
      const btn = $('#psQaSend');
      btn.disabled = true;
      qaInput.disabled = true;
      msg.className = 'form-msg';
      msg.textContent = 'חושב… ⏳';
      try {
        const result = await api(`/api/payslip/${month}/ask`, {
          method: 'POST',
          body: JSON.stringify({ question }),
        });
        qaInput.value = '';
        msg.className = 'form-msg';
        msg.textContent = '';
        $('#psQaList').innerHTML = qaBlock(result.qa);
        $('#psQaClear').hidden = false;
        $('#psQaList').lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (err) {
        msg.className = 'form-msg error';
        msg.textContent = err.message;
      } finally {
        btn.disabled = false;
        qaInput.disabled = false;
        qaInput.focus();
      }
    }
    $('#psQaSend').addEventListener('click', askQuestion);
    qaInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') askQuestion(); });
    $('#psQaClear').addEventListener('click', async () => {
      await api(`/api/payslip/${month}/qa`, { method: 'DELETE' });
      $('#psQaList').innerHTML = '';
      $('#psQaClear').hidden = true;
    });

    if (scroll) $('#psDetailCard').scrollIntoView({ behavior: 'smooth' });
  }
}

/* ================= משכנתא ================= */
// שדות הטופס — חייבים להתאים ל-DATA_NUM/DATA_TEXT ב-server/lib/mortgage.js
const MG_DATA_FIELDS = [
  { key: 'balance_total',     label: 'יתרת המשכנתא (₪)',              type: 'number' },
  { key: 'origination_date',  label: 'תאריך לקיחת המשכנתא',           type: 'month' },
  { key: 'remaining_months',  label: 'חודשים שנותרו',                 type: 'number', step: '1' },
  { key: 'monthly_payment',   label: 'ההחזר החודשי הנוכחי (₪)',       type: 'number' },
  { key: 'net_income',        label: 'הכנסה משפחתית נטו לחודש (₪)',   type: 'number' },
  { key: 'other_obligations', label: 'התחייבויות נוספות לחודש (₪)',   type: 'number' },
  { key: 'extra_monthly',     label: 'סכום פנוי להוספה להחזר (₪)',    type: 'number' },
  { key: 'lump_sum',          label: 'סכום זמין לפירעון מוקדם (₪)',   type: 'number' },
  // נשלף אוטומטית מבנק ישראל — הזנה ידנית גוברת (ראו server/lib/marketRates.js)
  { key: 'prime_rate',        label: 'ריבית פריים (אופציונלי)',       type: 'number', step: '0.01' },
  { key: 'borrower_ages',     label: 'גיל הלווים',                    type: 'text' },
];
// rows = גובה פתיחה מינימלי; מעבר לזה השדות גדלים לבד לפי התוכן (autoGrow),
// כי "הערות נוספות" מחזיק בפועל אלף תווים ואי אפשר לקרוא אותו בשתי שורות.
const MG_TEXTAREAS = [
  { key: 'expected_changes', label: 'שינויים צפויים בהכנסה או בהוצאות', rows: 2,
    placeholder: 'לדוגמה: העלאת שכר צפויה בשנה הבאה, ילד נוסף בגן, סיום תשלומי רכב' },
  { key: 'market_rates', label: 'הצעות ריבית שקיבלת מבנקים (אופציונלי)', rows: 3,
    placeholder: 'הריביות הממוצעות של בנק ישראל נשלפות אוטומטית. כאן אפשר להוסיף הצעות קונקרטיות שקיבלת — למשל: לאומי הציעו קל"צ 4.4% ל-20 שנה' },
  { key: 'notes', label: 'הערות נוספות', rows: 6, placeholder: 'כל דבר שחשוב שהיועץ יידע' },
];
// שדות מסלול — הסדר כאן הוא סדר התצוגה בכרטיס
const MG_TRACK_FIELDS = [
  { key: 'balance',          label: 'יתרת קרן (₪)',       type: 'number' },
  { key: 'rate',             label: 'ריבית (%)',           type: 'number', step: '0.01' },
  { key: 'prime_margin',     label: 'מרווח פריים (%)',     type: 'number', step: '0.01', hint: 'P-0.5% → הזן 0.5-' },
  { key: 'reset_date',       label: 'שינוי הריבית הבא',    type: 'month' },
  { key: 'remaining_months', label: 'חודשים שנותרו',       type: 'number', step: '1' },
  { key: 'monthly_payment',  label: 'החזר חודשי (₪)',      type: 'number' },
  { key: 'prepay_fee',       label: 'עמלת פירעון (₪)',     type: 'number' },
  { key: 'payoff_amount',    label: 'יתרת סילוק (₪)',      type: 'number' },
];
const MG_TRACK_TYPES = {
  prime: 'פריים',
  fixed_unlinked: 'קבועה לא צמודה',
  fixed_linked: 'קבועה צמודה',
  variable_linked: 'משתנה צמודה',
  variable_unlinked: 'משתנה לא צמודה',
  other: 'אחר',
};
// שווי הנכס — עוגן + מדד מחירי הדירות של הלמ"ס, כדי שההערכה תתעדכן לבד.
// חייב להתאים ל-estimatePropertyValue ב-server/lib/marketRates.js.
const MG_PROPERTY_FIELDS = [
  { key: 'property_value_base',       label: 'שווי ידוע (עוגן, ₪)',  type: 'number' },
  { key: 'property_value_base_month', label: 'החודש שאליו השווי מתייחס', type: 'month' },
  { key: 'property_value',            label: 'שווי מדויק (גובר, ₪)', type: 'number' },
  { key: 'property_value_source',     label: 'מקור העוגן',            type: 'text' },
];
const MG_REGIONS = {
  national: 'ארצי', jerusalem: 'מחוז ירושלים', north: 'מחוז הצפון', haifa: 'מחוז חיפה',
  center: 'מחוז המרכז', telaviv: 'מחוז תל אביב', south: 'מחוז הדרום',
};
const MG_DOC_KINDS = { balance: 'דוח יתרות', schedule: 'לוח סילוקין', other: 'מסמך נוסף' };
const MG_MAX_TRACKS = 15;

// שדות סימולציית "מה יקרה אם" — נשלחים ל-POST /api/mortgage/simulate.
// ערכי הפתיחה נלקחים מהטופס השמור (extra_monthly / lump_sum) כדי שלא יוזנו פעמיים.
const MG_SIM_FIELDS = [
  { key: 'extra_monthly', label: 'תוספת להחזר החודשי (₪)', step: '50',
    hint: 'כמה עוד אפשר לשלם כל חודש', value: (data) => data.extra_monthly },
  { key: 'lump_sum', label: 'פירעון חד-פעמי עכשיו (₪)', step: '1000',
    hint: 'סכום נזיל שנכנס מיד', value: (data) => data.lump_sum },
  { key: 'cpi_annual', label: 'הנחת אינפלציה שנתית (%)', step: '0.1',
    hint: 'משפיע רק על המסלולים הצמודים', value: () => 2 },
];

// ערך לשדה input (undefined → ריק, לא "undefined")
const mgVal = (v) => (v === undefined || v === null ? '' : escapeHtml(String(v)));

async function viewMortgage(el) {
  let d = await api('/api/mortgage');
  let tracks = d.tracks.slice();

  el.innerHTML = `
    <div class="mg-actions" id="mgActions">
      <button id="mgSave" class="btn-primary">💾 שמור נתונים</button>
      <button id="mgAnalyze" class="btn-primary">🔍 ${d.analysis_md ? 'נתח מחדש' : 'נתח עם Gemini'}</button>
      <span class="stat-sub" id="mgSavedAt">${d.updated_at ? `נשמר: ${escapeHtml(d.updated_at)}` : 'טרם נשמר'}</span>
      <span id="mgActionMsg" class="form-msg"></span>
    </div>

    <section class="card">
      <h2>🏡 פרטי המשכנתא</h2>
      <div class="stat-sub">הנתונים נשמרים מקומית. מלא כמה שיותר — כל שדה חסר מצוין במפורש בניתוח ולא מנוחש.</div>
      <div class="settings-grid mt" id="mgForm">
        ${MG_DATA_FIELDS.map((f) => `
          <label for="mg-${f.key}">${f.label}</label>
          <input id="mg-${f.key}" data-key="${f.key}" type="${f.type}"
                 ${f.type === 'number' ? `step="${f.step ?? '0.01'}" min="0"` : ''}
                 value="${mgVal(d.data[f.key])}">`).join('')}
        <label for="mg-risk_level">רמת הסיכון הרצויה</label>
        <select id="mg-risk_level" data-key="risk_level">
          <option value="">לא נבחר</option>
          ${Object.entries({ low: 'נמוכה', med: 'בינונית', high: 'גבוהה' }).map(([k, he]) =>
            `<option value="${k}"${d.data.risk_level === k ? ' selected' : ''}>${he}</option>`).join('')}
        </select>
      </div>
      ${MG_TEXTAREAS.map((f) => `
        <div class="mg-textarea">
          <label for="mg-${f.key}">${f.label}</label>
          <textarea id="mg-${f.key}" data-key="${f.key}" rows="${f.rows ?? 2}" maxlength="2000"
                    placeholder="${escapeHtml(f.placeholder)}">${mgVal(d.data[f.key])}</textarea>
        </div>`).join('')}
    </section>

    <section class="card">
      <h2>🧮 מה יקרה אם אוסיף להחזר?</h2>
      <div class="stat-sub">חישוב מקומי מלא, בלי AI ובלי לשמור — אפשר לשחק עם המספרים חופשי. הכסף הנוסף מנותב תמיד למסלול היקר ביותר (ריבית + הצמדה), כי שם הוא חוסך הכי הרבה.</div>
      <div class="mg-track-grid mt" id="mgSimForm">
        ${MG_SIM_FIELDS.map((f) => `
          <div class="mg-field">
            <label for="mg-sim-${f.key}">${f.label}</label>
            <input id="mg-sim-${f.key}" data-simkey="${f.key}" type="number"
                   step="${f.step}" min="0" value="${mgVal(f.value(d.data))}">
            <div class="mg-sim-hint">${f.hint}</div>
          </div>`).join('')}
      </div>
      <label class="mg-check mt"><input type="checkbox" id="mgSimRollover" checked>
        כשמסלול נסגר — להמשיך לשלם את אותו סכום למסלול הבא</label>
      <div id="mgSimResult"></div>
    </section>

    <section class="card">
      <div class="ps-section-title">
        <h3>🏠 שווי הנכס</h3>
        <span class="stat-sub" id="mgPropIndexAt"></span>
      </div>
      <div class="row-flex mt">
        <button id="mgPropRefresh" class="btn-primary">🔄 חפש מדד חדש</button>
        <strong class="mg-hint">הלמ"ס מפרסמת מדד חדש בערך באמצע כל חודש, והנתון מתייחס לחודשיים-שלושה אחורה</strong>
      </div>
      <div class="stat-sub">הזן שווי ידוע (מחיר רכישה, שמאות, או מחירי מכירה דומים באזור) ואת החודש שאליו הוא מתייחס. האפליקציה מצמידה אותו קדימה לפי המדד הרשמי, שמתפרסם כל חודש. אתר עסקאות הנדל"ן הממשלתי חסום לשליפה אוטומטית (reCAPTCHA), ולכן זו הדרך האמינה לשווי מתעדכן.</div>
      <div class="settings-grid mt" id="mgPropForm">
        ${MG_PROPERTY_FIELDS.map((f) => `
          <label for="mg-${f.key}">${f.label}</label>
          <input id="mg-${f.key}" data-key="${f.key}" type="${f.type}"
                 ${f.type === 'number' ? 'step="1000" min="0"' : ''}
                 value="${mgVal(d.data[f.key])}">`).join('')}
        <label for="mg-property_region">מחוז (לבחירת המדד)</label>
        <select id="mg-property_region" data-key="property_region">
          ${Object.entries(MG_REGIONS).map(([k, he]) =>
            `<option value="${k}"${(d.data.property_region ?? 'national') === k ? ' selected' : ''}>${he}</option>`).join('')}
        </select>
      </div>
      <div id="mgPropEstimate"></div>

      <div class="ps-section-title">
        <h3>📈 נתוני שוק מבנק ישראל</h3>
        <span class="stat-sub" id="mgMarketAt"></span>
      </div>
      <div class="row-flex mt">
        <button id="mgMarketRefresh" class="btn-primary">🔄 רענן עכשיו</button>
        <span class="stat-sub">ריבית הפריים מתעדכנת ביום החלטת הריבית; הריביות הממוצעות — חודשית</span>
      </div>
      <div id="mgMarket"></div>
    </section>

    <section class="card">
      <div class="row-flex spread">
        <h2>📊 מסלולים</h2>
        <button id="mgAddTrack" class="btn-secondary">➕ הוסף מסלול</button>
      </div>
      <div class="stat-sub">הנתונים מופיעים בדוח היתרות של הבנק. מסלול = שורה נפרדת בהלוואה.</div>
      <div id="mgTracks"></div>
    </section>

    <section class="card">
      <div class="row-flex spread">
        <h2>📅 היסטוריית תשלומים שנתית</h2>
        <button id="mgHistClear" class="btn-danger-outline" ${d.history?.length ? '' : 'hidden'}>🗑 מחק הכל</button>
      </div>
      <div class="stat-sub">מתוך דוחות "מצב חשבון מתומצת לשנת ..." שהבנק שולח פעם בשנה. אפשר להעלות קובץ אחד שמכיל כמה שנים. הנתונים מראים כמה קרן נפרעה בפועל מול כמה הצמדה נצברה במקביל — ההסבר לכך שהיתרה כמעט לא זזה.</div>
      <div class="dropzone mt" id="mgHistDrop">
        📅 גרור לכאן דוחות שנתיים (PDF), או לחץ לבחירה<br>
        <span style="font-size:0.8rem">הנתונים מוצגים לאישורך לפני השמירה — חילוץ מ-PDF עלול לשבש מספרים</span>
        <input type="file" id="mgHistFile" accept=".pdf" hidden>
      </div>
      <div id="mgHistMsg" class="form-msg"></div>
      <div id="mgHistPreview"></div>
      <div id="mgHistSummary"></div>
      <div id="mgHistChartWrap" hidden><div class="chart-box"><canvas id="mgHistChart"></canvas></div></div>
      <div id="mgHistTable"></div>
    </section>

    <section class="card">
      <h2>📎 מסמכים מהבנק</h2>
      <div class="row-flex">
        <label for="mgDocKind" class="stat-sub">סוג המסמך</label>
        <select id="mgDocKind">
          ${Object.entries(MG_DOC_KINDS).map(([k, he]) => `<option value="${k}">${he}</option>`).join('')}
        </select>
      </div>
      <div class="dropzone mt" id="mgDrop">
        📄 גרור לכאן דוח יתרות או לוח סילוקין (PDF), או לחץ לבחירה<br>
        <span style="font-size:0.8rem">עד 5 מסמכים · הטקסט מצורף לניתוח לאחר הסרת פרטים מזהים</span><br>
        <span style="font-size:0.8rem">מסמך סרוק כתמונה לא נתמך — צריך PDF עם טקסט</span>
        <input type="file" id="mgFile" accept=".pdf" hidden>
      </div>
      <div id="mgDocs"></div>
      <div id="mgDocMsg" class="form-msg"></div>
    </section>

    <section class="card" id="mgAnalysisCard">
      <h2>✔️ בדיקות וניתוח</h2>
      <div id="mgChecks"></div>

      <div class="row-flex mt">
        <button id="mgCopy" class="btn-secondary">📋 העתק פרומפט</button>
        <button id="mgDelete" class="btn-danger-outline">🗑 מחק הכל</button>
      </div>
      <div class="stat-sub">הניתוח נשלח ל-Google Gemini לאחר הסרה אוטומטית של ת"ז, חשבון בנק, כתובת הנכס, גוש/חלקה ומספרי הלוואה. הסכומים והריביות כן נשלחים — בלעדיהם אין מה לנתח. אין כאן ייעוץ פיננסי מוסמך; אמת כל מסקנה מול הבנק או יועץ משכנתאות מורשה.</div>
      <div id="mgAnalyzeMsg" class="form-msg"></div>

      <div id="mgAnalysis"></div>

      <div id="mgQaWrap" ${d.analysis_md ? '' : 'hidden'}>
        <div class="ps-section-title"><h3>💬 שאלות על המשכנתא</h3>
          <button id="mgQaClear" class="btn-link" ${d.qa?.length ? '' : 'hidden'}>נקה שיחה</button></div>
        <div id="mgQaList"></div>
        <div class="qa-ask">
          <input type="text" id="mgQaInput" maxlength="1000" placeholder="לדוגמה: כמה אחסוך אם אקצר את התקופה בחמש שנים?">
          <button id="mgQaSend" class="btn-primary">שאל</button>
        </div>
        <div id="mgQaMsg" class="form-msg"></div>
      </div>
    </section>
  `;

  /* ---------- מסלולים ---------- */
  function renderTracks() {
    if (!tracks.length) {
      $('#mgTracks').innerHTML = '<div class="empty-state">לא הוזנו מסלולים — לחץ "הוסף מסלול"</div>';
      return;
    }
    $('#mgTracks').innerHTML = tracks.map((t, i) => `
      <div class="mg-track" data-idx="${i}">
        <div class="mg-track-head">
          <input type="text" data-tkey="name" maxlength="60" placeholder="שם המסלול" value="${mgVal(t.name)}">
          <select data-tkey="type">
            ${Object.entries(MG_TRACK_TYPES).map(([k, he]) =>
              `<option value="${k}"${(t.type ?? 'other') === k ? ' selected' : ''}>${he}</option>`).join('')}
          </select>
          <label class="mg-check"><input type="checkbox" data-tkey="cpi_linked"${t.cpi_linked ? ' checked' : ''}> צמוד מדד</label>
          <button class="btn-danger-outline mg-del-track" title="מחק מסלול">🗑</button>
        </div>
        <div class="mg-track-grid">
          ${MG_TRACK_FIELDS.map((f) => `
            <div class="mg-field">
              <label>${f.label}</label>
              <input data-tkey="${f.key}" type="${f.type}"
                     ${f.type === 'number' ? `step="${f.step ?? '0.01'}"` : ''}
                     ${f.type === 'number' && f.key !== 'prime_margin' ? 'min="0"' : ''}
                     ${f.hint ? `title="${escapeHtml(f.hint)}"` : ''}
                     value="${mgVal(t[f.key])}">
            </div>`).join('')}
        </div>
      </div>`).join('');

    $$('.mg-del-track').forEach((b) => b.addEventListener('click', () => {
      const idx = Number(b.closest('.mg-track').dataset.idx);
      syncTracks();
      tracks.splice(idx, 1);
      renderTracks();
    }));
  }

  // קריאת ה-DOM אל תוך tracks — נקראת לפני כל רינדור מחדש ולפני שמירה
  function syncTracks() {
    tracks = $$('.mg-track').map((box) => {
      const t = {};
      $$('[data-tkey]', box).forEach((inp) => {
        const k = inp.dataset.tkey;
        t[k] = inp.type === 'checkbox' ? (inp.checked ? 1 : 0) : inp.value.trim();
      });
      return t;
    });
  }

  function collectData() {
    const data = {};
    $$('#mgForm [data-key], #mgPropForm [data-key]').forEach((inp) => { data[inp.dataset.key] = inp.value.trim(); });
    MG_TEXTAREAS.forEach((f) => { data[f.key] = $(`#mg-${f.key}`).value.trim(); });
    return data;
  }

  // הערכת שווי הנכס — מחושבת בשרת (עוגן × יחס מדדים) ומוצגת כאן
  function renderEstimate(est) {
    const el = $('#mgPropEstimate');
    // תקופת המדד האחרונה שנשלפה — כדי שיהיה ברור מה "רענון" יביא
    const region = $('#mg-property_region')?.value || 'national';
    const series = d.market?.housing?.[region];
    const last = series?.points?.length ? series.points[series.points.length - 1] : null;
    $('#mgPropIndexAt').textContent = last
      ? `מדד אחרון שפורסם: ${last.period} (${series.label})`
      : 'מדד מחירי הדירות טרם נשלף';
    if (!est || est.value === null) {
      el.innerHTML = '<div class="stat-sub">לא הוזן שווי — בלעדיו אין חישוב LTV</div>';
      return;
    }
    el.innerHTML = `
      <div class="ps-tiles">
        <div class="ps-tile">
          <div class="stat-label">שווי הנכס המשוער</div>
          <div class="stat-value plus">${fmtILS.format(est.value)}</div>
          <div class="stat-sub">${escapeHtml(est.detail)}</div>
        </div>
      </div>`;
  }
  renderEstimate(d.property_value_estimate);

  // רענון ידני של מדד מחירי הדירות — שולף מחדש מהלמ"ס ומחשב את השווי מחדש.
  // הרענון האוטומטי הוא כל 12 שעות; הכפתור נועד לרגע שבו התפרסם מדד חדש.
  $('#mgPropRefresh').addEventListener('click', async () => {
    const btn = $('#mgPropRefresh');
    const before = $('#mgPropIndexAt').textContent;
    btn.disabled = true;
    btn.textContent = 'מחפש…';
    try {
      d.market = await api('/api/mortgage/market/refresh', { method: 'POST' });
      const fresh = await api('/api/mortgage');
      d.checks = fresh.checks;
      d.prompt = fresh.prompt;
      renderEstimate(fresh.property_value_estimate);
      renderMarket(d.market);
      renderChecks(d.checks, d.analysis_at, d.updated_at);
      const after = $('#mgPropIndexAt').textContent;
      $('#mgActionMsg').className = 'form-msg ok';
      $('#mgActionMsg').textContent = after === before
        ? 'ℹ️ אין עדיין מדד חדש — הנתון האחרון נשאר בתוקף'
        : '✅ נמצא מדד חדש — שווי הנכס עודכן';
    } catch (err) {
      $('#mgActionMsg').className = 'form-msg error';
      $('#mgActionMsg').textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = '🔄 חפש מדד חדש';
    }
  });

  // החלפת מחוז משנה את סדרת המדד — התווית מתעדכנת מיד, לפני שמירה
  $('#mg-property_region').addEventListener('change', () => renderEstimate(d.property_value_estimate));

  renderTracks();

  /* ---------- נתוני שוק (בנק ישראל) ---------- */
  function renderMarket(m) {
    const el = $('#mgMarket');
    const at = $('#mgMarketAt');
    const fmtStamp = (iso) => {
      if (!iso) return '';
      const dt = new Date(iso);
      return Number.isNaN(dt.getTime()) ? '' : dt.toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
    };
    at.textContent = m?.fetched_at ? `עודכן: ${fmtStamp(m.fetched_at)}` : 'טרם נשלף';
    if (!m || (!m.boi && !m.averages?.length)) {
      el.innerHTML = `<div class="form-msg warn-msg">⚠️ נתוני השוק מבנק ישראל לא נשלפו${
        m?.errors?.length ? ` — ${escapeHtml(m.errors.join(' · '))}` : ''}</div>`;
      return;
    }
    const pct = (n) => `${Number(n).toFixed(2)}%`;
    const rows = [];
    if (m.boi) {
      rows.push(['ריבית בנק ישראל', pct(m.boi.rate), fmtStamp(m.boi.published_at)]);
      rows.push(['<strong>ריבית הפריים</strong>', `<strong>${pct(m.boi.prime)}</strong>`, 'ריבית בנק ישראל + 1.5%']);
      if (m.boi.next_decision) rows.push(['החלטת הריבית הבאה', fmtStamp(m.boi.next_decision), '']);
    }
    for (const a of m.averages ?? []) {
      rows.push([
        escapeHtml(a.label),
        a.stale ? `<span style="opacity:0.55">${pct(a.value)}</span>` : pct(a.value),
        (a.period ? `תקופת דיווח ${escapeHtml(a.period)}` : '')
          + (a.stale ? ' · <span class="md-warn">מיושן — הסדרה הופסקה, לא בשימוש בהשוואות</span>' : ''),
      ]);
    }
    el.innerHTML = `
      <div class="stat-sub">הריביות הממוצעות הן על הלוואות דיור <strong>חדשות</strong> ומתפרסמות בפיגור של כמה חודשים — אינדיקציה להשוואה, לא הצעת ריבית. ריבית הפריים עדכנית לרגע זה.</div>
      <div class="table-wrap mt">
        <table class="import-table">
          <thead><tr><th>נתון</th><th>ערך</th><th>הערה</th></tr></thead>
          <tbody>${rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td class="stat-sub">${r[2]}</td></tr>`).join('')}</tbody>
        </table>
      </div>
      ${m.errors?.length ? `<div class="form-msg warn-msg">⚠️ ${escapeHtml(m.errors.join(' · '))} — מוצגים הנתונים מהשליפה הקודמת</div>` : ''}`;
    // ריבית הפריים שנשלפה היא ברירת המחדל — השדה הידני נשאר ריק ומציג אותה
    const primeInput = $('#mg-prime_rate');
    if (m.boi?.prime && primeInput) {
      primeInput.placeholder = `${m.boi.prime} (אוטומטי — השאר ריק)`;
    }
  }
  renderMarket(d.market);

  $('#mgMarketRefresh').addEventListener('click', async () => {
    const btn = $('#mgMarketRefresh');
    btn.disabled = true;
    btn.textContent = 'מרענן…';
    try {
      renderMarket(await api('/api/mortgage/market/refresh', { method: 'POST' }));
      // הבדיקות והפרומפט מחושבים מנתוני השוק — נטענים מחדש
      const fresh = await api('/api/mortgage');
      d.checks = fresh.checks;
      d.prompt = fresh.prompt;
      renderChecks(d.checks, d.analysis_at, d.updated_at);
      renderEstimate(fresh.property_value_estimate);
    } catch (err) {
      $('#mgMarket').innerHTML = `<div class="form-msg error">${escapeHtml(err.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = '🔄 רענן עכשיו';
    }
  });

  $('#mgAddTrack').addEventListener('click', () => {
    if (tracks.length >= MG_MAX_TRACKS) return;
    syncTracks();
    tracks.push({ name: `מסלול ${tracks.length + 1}`, type: 'prime' });
    renderTracks();
  });

  /* ---------- שדות טקסט חופשי שגדלים לפי התוכן ---------- */
  // בלי זה "הערות נוספות" (יותר מאלף תווים) מוצג בחלון של שתי שורות עם גלילה
  // פנימית, והמשתמש לא רואה מה כתוב שם. גדילה עד תקרה, ומעליה גלילה — כדי
  // ששדה ענק לא ידחוף את שאר הטופס אל מחוץ למסך.
  const MG_TEXTAREA_MAX = 640;
  function autoGrow(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, MG_TEXTAREA_MAX)}px`;
    el.style.overflowY = el.scrollHeight + 2 > MG_TEXTAREA_MAX ? 'auto' : 'hidden';
  }
  $$('.mg-textarea textarea').forEach((ta) => ta.addEventListener('input', () => autoGrow(ta)));
  // המדידה הראשונית חייבת לחכות ל-frame הבא: מיד אחרי הצבת ה-innerHTML הפריסה
  // עוד לא הסתיימה, ו-scrollHeight מחזיר ערך מנופח — כל השדות יצאו בגובה
  // התקרה (נמדד בפועל: 420px גם לשדות ריקים).
  requestAnimationFrame(() => $$('.mg-textarea textarea').forEach(autoGrow));

  /* ---------- סימולציית "מה יקרה אם" ---------- */
  // מספרים בלי אגורות — בסימולציה הדיוק הוא ממילא ברמת ההנחות, לא ברמת השקל
  const simILS = (n) => (typeof n === 'number' && Number.isFinite(n)
    ? Math.round(n).toLocaleString('he-IL') + ' ₪' : '—');
  // חייב להישאר זהה ל-monthsHe ב-server/lib/mortgageSim.js
  const simMonths = (m) => {
    if (typeof m !== 'number') return 'לא נסגר';
    const y = Math.floor(m / 12), r = m % 12;
    const ys = y === 1 ? 'שנה' : `${y} שנים`;
    const rs = r === 1 ? 'חודש' : `${r} חודשים`;
    return !y ? rs : !r ? ys : `${ys} ${/^\d/.test(rs) ? 'ו-' : 'ו'}${rs}`;
  };
  const simEnd = (m) => {
    if (typeof m !== 'number') return '—';
    const now = new Date();
    const dt = new Date(now.getFullYear(), now.getMonth() + m, 1);
    return `${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
  };

  function renderSim(sim) {
    const el = $('#mgSimResult');
    if (!sim?.ok) {
      el.innerHTML = `<div class="empty-state">${escapeHtml(sim?.error ?? 'אין מספיק נתונים לחישוב — צריך יתרה, ריבית והחזר חודשי לפחות במסלול אחד')}</div>`;
      return;
    }
    const { baseline, withExtra, diff, rateRisk } = sim;
    const saved = diff.monthsSaved;
    const nothing = !sim.extraMonthly && !sim.lumpSum;

    el.innerHTML = `
      <div class="ps-tiles">
        <div class="ps-tile">
          <div class="stat-label">ההחזר החודשי החדש</div>
          <div class="stat-value">${simILS(sim.currentPayment + sim.extraMonthly)}</div>
          <div class="stat-sub">${simILS(sim.currentPayment)} היום${sim.extraMonthly ? ` + ${simILS(sim.extraMonthly)}` : ''}</div>
        </div>
        <div class="ps-tile">
          <div class="stat-label">זמן שנותר לשלם</div>
          <div class="stat-value ${saved > 0 ? 'plus' : ''}">${simMonths(withExtra.months)}</div>
          <div class="stat-sub">היום: ${simMonths(baseline.months)}</div>
        </div>
        <div class="ps-tile">
          <div class="stat-label">קיצור התקופה</div>
          <div class="stat-value ${saved > 0 ? 'plus' : ''}">${saved > 0 ? simMonths(saved) : '—'}</div>
          <div class="stat-sub">סיום: ${simEnd(withExtra.months)} במקום ${simEnd(baseline.months)}</div>
        </div>
        <div class="ps-tile">
          <div class="stat-label">סה"כ חיסכון</div>
          <div class="stat-value ${diff.totalSaved > 0 ? 'plus' : ''}">${diff.totalSaved > 0 ? simILS(diff.totalSaved) : '—'}</div>
          <div class="stat-sub">פחות כסף שיוצא מהכיס עד הסוף</div>
        </div>
      </div>

      ${nothing ? `<div class="stat-sub">${saved > 0
        ? 'לא הוזנה תוספת — הקיצור שמוצג למעלה נובע כולו מהסימון "להמשיך לשלם את אותו סכום למסלול הבא": כשמסלול נסגר, ההחזר שהתפנה ממשיך לעבוד במקום להישאר בחשבון. הזן תוספת להחזר או סכום לפירעון כדי לראות השוואה מלאה.'
        : 'הזן תוספת להחזר או סכום לפירעון כדי לראות את ההשוואה.'}</div>` : `
      <div class="md-table-wrap"><table class="md-table">
        <thead><tr><th>מה בודקים</th><th>מצב קיים</th><th>עם התוספת</th><th>ההפרש</th></tr></thead>
        <tbody>
          <tr><td>תשלום חודשי בהתחלה</td><td>${simILS(baseline.firstMonthOutlay)}</td><td>${simILS(withExtra.firstMonthOutlay)}</td>
              <td class="mg-sim-delta up">+${simILS(withExtra.firstMonthOutlay - baseline.firstMonthOutlay)}</td></tr>
          <tr><td>זמן עד סיום</td><td>${simMonths(baseline.months)}</td><td>${simMonths(withExtra.months)}</td>
              <td class="mg-sim-delta down">${saved > 0 ? '−' + simMonths(saved) : '—'}</td></tr>
          <tr><td>ריבית והצמדה עד הסוף</td><td>${simILS(baseline.totalInterest + baseline.totalIndexation)}</td>
              <td>${simILS(withExtra.totalInterest + withExtra.totalIndexation)}</td>
              <td class="mg-sim-delta down">${diff.interestSaved > 0 ? '−' + simILS(diff.interestSaved) : '—'}</td></tr>
          <tr><td>סה"כ שישולם לבנק</td><td>${simILS(baseline.totalPaid)}</td><td>${simILS(withExtra.totalPaid)}</td>
              <td class="mg-sim-delta down">${diff.totalSaved > 0 ? '−' + simILS(diff.totalSaved) : '—'}</td></tr>
        </tbody>
      </table></div>`}

      <div class="ps-section-title"><h3>⚠️ מה קורה אם הריבית תעלה?</h3></div>
      <div class="stat-sub">התרחישים מחושבים <strong>על התוכנית שלמעלה</strong> — כולל התוספת והפירעון שהזנת, ולכן הם משתנים יחד איתם. מושפעים רק המסלולים שהריבית בהם לא נעולה (פריים ומשתנה) — ${simILS(rateRisk[0]?.affectedBalance)} מתוך היתרה. הבנק לא מאריך את התקופה, הוא מעלה את ההחזר.</div>
      <div class="md-table-wrap"><table class="md-table">
        <thead><tr><th>תרחיש</th><th>ההחזר לבנק</th><th>תוספת לחודש</th><th>סה"כ מהכיס</th><th>זמן עד סיום</th><th>עלות נוספת עד הסוף</th></tr></thead>
        <tbody>
          <tr><td>היום (בלי שינוי)</td>
              <td>${simILS(sim.currentPayment)}</td>
              <td>—</td>
              <td>${simILS(sim.currentPayment + sim.extraMonthly)}</td>
              <td>${simMonths(withExtra.months)}</td>
              <td>—</td></tr>
          ${rateRisk.map((r) => `
          <tr><td>עלייה של ${r.shock}%</td>
              <td>${simILS(r.monthlyPayment)}</td>
              <td class="mg-sim-delta up">+${simILS(r.monthlyDelta)}</td>
              <td>${simILS(r.totalMonthly)}</td>
              <td>${simMonths(r.months)}${r.monthsDelta > 0 ? ` <span class="mg-sim-delta up">(+${simMonths(r.monthsDelta)})</span>` : ''}</td>
              <td class="mg-sim-delta up">+${simILS(r.extraCost)}</td></tr>`).join('')}
        </tbody>
      </table></div>

      <div class="stat-sub">${sim.skipped.length ? `⚠️ לא נכללו בחישוב (חסרים יתרה/ריבית/החזר): ${escapeHtml(sim.skipped.join(', '))}. ` : ''}הסימולציה מניחה אינפלציה קבועה של ${sim.cpiAnnual}% בשנה ואת הריביות הנוכחיות. הסכומים נומינליים (שקלים עתידיים), ולכן החיסכון בפועל מרגיש קטן יותר בכוח קנייה. אומדן בלבד — הבנק קובע לפי לוח הסילוקין שלו, ולפירעון מוקדם עשויות להתלוות עמלות.</div>`;
  }

  let simTimer = null;
  async function runSim() {
    syncTracks();
    const body = { tracks, rollover: $('#mgSimRollover').checked };
    $$('#mgSimForm [data-simkey]').forEach((inp) => { body[inp.dataset.simkey] = inp.value.trim(); });
    try {
      renderSim(await api('/api/mortgage/simulate', { method: 'POST', body: JSON.stringify(body) }));
    } catch (err) {
      $('#mgSimResult').innerHTML = `<div class="form-msg error">${escapeHtml(err.message)}</div>`;
    }
  }
  // חישוב מיידי בטעינה, ואחרי כל הקלדה בהשהיה קצרה (החישוב מקומי וזול)
  const simDebounced = () => { clearTimeout(simTimer); simTimer = setTimeout(runSim, 250); };
  $$('#mgSimForm [data-simkey]').forEach((inp) => inp.addEventListener('input', simDebounced));
  $('#mgSimRollover').addEventListener('change', runSim);
  // עריכת מסלול משנה את הסימולציה גם לפני שמירה. המאזין על המכל ולא על השדות
  // עצמם — renderTracks מחליף את ה-HTML הפנימי בכל הוספה או מחיקה.
  $('#mgTracks').addEventListener('input', simDebounced);
  runSim();

  /* ---------- בדיקות ---------- */
  function renderChecks(checks = [], analysisAt = null, updatedAt = null) {
    // הניתוח שמור מלפני השמירה האחרונה → מסמנים שהוא מיושן
    const stale = analysisAt && updatedAt && analysisAt < updatedAt;
    const badCount = checks.filter((c) => c.status !== 'ok').length;
    $('#mgChecks').innerHTML = `
      ${stale ? '<div class="form-msg warn-msg">⚠️ הנתונים עודכנו אחרי הניתוח — מומלץ לנתח מחדש</div>' : ''}
      ${checks.length ? `
        <div class="row-flex spread">
          <span class="stat-sub">מחושבות מקומית, בלי מודל AI</span>
          <span class="badge ${badCount ? 'dup' : 'new'}">${badCount ? `${badCount} ממצאים לבדיקה` : 'כל הבדיקות תקינות'}</span>
        </div>
        <ul class="ps-checks">${checks.map((c) => `
          <li class="ps-${c.status}">
            <div class="ps-check-head">${CHECK_ICON[c.status]} <strong>${escapeHtml(c.label)}</strong>
              <span class="badge ps-badge-${c.status}">${CHECK_TITLE[c.status]}</span></div>
            <div class="ps-check-detail">${escapeHtml(c.detail)}</div>
          </li>`).join('')}</ul>`
        : '<div class="empty-state">מלא את הטופס ושמור כדי לקבל בדיקות אוטומטיות</div>'}`;
  }
  renderChecks(d.checks, d.analysis_at, d.updated_at);

  /* ---------- שמירה ---------- */
  // שורת הפעולות דביקה מתחת ל-header — הגובה נמדד בזמן ריצה כדי שלא תיחתך
  const stickyTop = () => { $('#mgActions').style.top = `${$('header').offsetHeight}px`; };
  stickyTop();
  window.addEventListener('resize', stickyTop);

  $('#mgSave').addEventListener('click', async () => {
    const btn = $('#mgSave');
    const msg = $('#mgActionMsg');
    syncTracks();
    btn.disabled = true;
    msg.className = 'form-msg';
    msg.textContent = 'שומר…';
    try {
      const saved = await api('/api/mortgage', {
        method: 'PUT',
        body: JSON.stringify({ data: collectData(), tracks }),
      });
      d.data = saved.data;
      d.checks = saved.checks;
      d.updated_at = saved.updated_at;
      tracks = saved.tracks;
      renderTracks();
      renderEstimate(saved.property_value_estimate);
      renderChecks(d.checks, d.analysis_at, d.updated_at);
      $('#mgSavedAt').textContent = `נשמר: ${saved.updated_at}`;
      msg.className = 'form-msg ok';
      msg.textContent = '✅ הנתונים נשמרו';
      // הפרומפט להעתקה נבנה בשרת — מרעננים אותו כדי שההעתקה תהיה מעודכנת
      d.prompt = (await api('/api/mortgage')).prompt;
    } catch (err) {
      msg.className = 'form-msg error';
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------- היסטוריית תשלומים שנתית ---------- */
  let history = (d.history ?? []).slice();
  let histPending = null;              // שורות שנותחו מ-PDF וממתינות לאישור

  const HIST_COLS = [
    { key: 'paid_principal', label: 'שולם קרן' },
    { key: 'paid_interest', label: 'שולם ריבית' },
    { key: 'paid_cpi_principal', label: 'הצמדת קרן' },
    { key: 'paid_cpi_interest', label: 'הצמדת ריבית' },
    { key: 'paid_total', label: 'סה"כ שולם' },
    { key: 'bal_principal', label: 'יתרת קרן' },
    { key: 'bal_cpi', label: 'הפרשי הצמדה' },
    { key: 'bal_total', label: 'יתרה כוללת' },
  ];
  const histNum = (v) => (typeof v === 'number' ? v.toLocaleString('he-IL', { maximumFractionDigits: 0 }) : '—');

  function renderHistPreview() {
    const box = $('#mgHistPreview');
    if (!histPending) { box.innerHTML = ''; return; }
    const { rows, warnings } = histPending;
    box.innerHTML = `
      <div class="ps-section-title"><h3>🔎 נמצאו ${rows.length} שנים — בדוק ואשר</h3></div>
      ${warnings.length ? `<div class="form-msg error">${warnings.map(escapeHtml).join('<br>')}</div>` : ''}
      <div class="stat-sub">שדה שהושלם מתוך הסכום הכולל (כי החילוץ מה-PDF שיבש אותו) מסומן ב-🔧. השווה מול הדוח המקורי לפני שמירה.</div>
      <div class="table-wrap mt">
        <table class="import-table">
          <thead><tr><th>שנה</th>${HIST_COLS.map((c) => `<th>${c.label}</th>`).join('')}</tr></thead>
          <tbody>
            ${rows.map((r) => `<tr>
              <td><strong>${r.year}</strong></td>
              ${HIST_COLS.map((c) => `<td>${histNum(r[c.key])}${
                (r.derived ?? []).includes(c.key) ? ' 🔧' : ''}</td>`).join('')}
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="row-flex mt">
        <button id="mgHistConfirm" class="btn-primary">💾 שמור ${rows.length} שנים</button>
        <button id="mgHistCancel" class="btn-secondary">ביטול</button>
      </div>`;

    $('#mgHistCancel').addEventListener('click', () => { histPending = null; renderHistPreview(); });
    $('#mgHistConfirm').addEventListener('click', async (e) => {
      const msg = $('#mgHistMsg');
      e.target.disabled = true;
      try {
        const res = await api('/api/mortgage/history', {
          method: 'PUT', body: JSON.stringify({ rows }),
        });
        history = res.rows;
        histPending = null;
        renderHistPreview();
        renderHistory();
        msg.className = 'form-msg ok';
        msg.textContent = `✅ נשמרו ${res.rows.length} שנים`;
        d.prompt = (await api('/api/mortgage')).prompt;
      } catch (err) {
        msg.className = 'form-msg error';
        msg.textContent = err.message;
        e.target.disabled = false;
      }
    });
  }

  function renderHistory() {
    $('#mgHistClear').hidden = !history.length;
    const table = $('#mgHistTable');
    const summary = $('#mgHistSummary');
    const chartWrap = $('#mgHistChartWrap');
    if (!history.length) {
      table.innerHTML = '<div class="empty-state">טרם נטענה היסטוריה</div>';
      summary.innerHTML = '';
      chartWrap.hidden = true;
      return;
    }

    const totalPaid = history.reduce((a, r) => a + (r.paid_total ?? 0), 0);
    const totalPrincipal = history.reduce((a, r) => a + (r.paid_principal ?? 0), 0);
    const first = history[0];
    const last = history[history.length - 1];
    const cpiAdded = (last.bal_cpi ?? 0) - (first.bal_cpi ?? 0);
    const balDrop = (first.bal_total ?? 0) - (last.bal_total ?? 0);
    const share = totalPaid > 0 ? (totalPrincipal / totalPaid) * 100 : 0;

    summary.innerHTML = `
      <div class="ps-tiles">
        <div class="ps-tile"><div class="stat-label">שולם סה"כ ${first.year}–${last.year}</div>
          <div class="stat-value">${histNum(totalPaid)} ₪</div></div>
        <div class="ps-tile"><div class="stat-label">מזה לקרן</div>
          <div class="stat-value plus">${histNum(totalPrincipal)} ₪</div>
          <div class="stat-sub">${share.toFixed(1)}% מכל שקל ששולם</div></div>
        <div class="ps-tile"><div class="stat-label">הצמדה שנוספה לקרן</div>
          <div class="stat-value minus">${histNum(cpiAdded)} ₪</div></div>
        <div class="ps-tile"><div class="stat-label">ירידת היתרה בפועל</div>
          <div class="stat-value">${histNum(balDrop)} ₪</div>
          <div class="stat-sub">הקרן ירדה ${histNum((first.bal_principal ?? 0) - (last.bal_principal ?? 0))} ₪</div></div>
      </div>`;

    table.innerHTML = `
      <div class="table-wrap mt">
        <table class="import-table">
          <thead><tr><th>שנה</th>${HIST_COLS.map((c) => `<th>${c.label}</th>`).join('')}<th></th></tr></thead>
          <tbody>
            ${history.map((r) => `<tr>
              <td><strong>${r.year}</strong></td>
              ${HIST_COLS.map((c) => `<td>${histNum(r[c.key])}</td>`).join('')}
              <td><button class="btn-danger-outline mg-hist-del" data-year="${r.year}">🗑</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    $$('.mg-hist-del').forEach((b) => b.addEventListener('click', async () => {
      const msg = $('#mgHistMsg');
      try {
        const res = await api(`/api/mortgage/history/${b.dataset.year}`, { method: 'DELETE' });
        history = res.rows;
        renderHistory();
        msg.className = 'form-msg ok';
        msg.textContent = `✅ שנת ${b.dataset.year} נמחקה`;
      } catch (err) {
        msg.className = 'form-msg error';
        msg.textContent = err.message;
      }
    }));

    chartWrap.hidden = false;
    newChart($('#mgHistChart'), {
      type: 'bar',
      data: {
        labels: history.map((r) => r.year),
        datasets: [
          { label: 'יתרת קרן', data: history.map((r) => r.bal_principal ?? 0), backgroundColor: '#4a90d9', stack: 'b' },
          { label: 'הפרשי הצמדה', data: history.map((r) => r.bal_cpi ?? 0), backgroundColor: '#d95f5f', stack: 'b' },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${Math.round(c.raw).toLocaleString('he-IL')} ₪` } },
        },
        scales: {
          x: { stacked: true },
          y: { stacked: true, ticks: { callback: (v) => `${Math.round(v / 1000)}K` } },
        },
      },
    });
  }
  renderHistory();

  const histDrop = $('#mgHistDrop');
  const histFile = $('#mgHistFile');
  histDrop.addEventListener('click', () => histFile.click());
  histDrop.addEventListener('dragover', (e) => { e.preventDefault(); histDrop.classList.add('dragover'); });
  histDrop.addEventListener('dragleave', () => histDrop.classList.remove('dragover'));
  histDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    histDrop.classList.remove('dragover');
    if (e.dataTransfer.files[0]) parseHistory(e.dataTransfer.files[0]);
  });
  histFile.addEventListener('change', () => histFile.files[0] && parseHistory(histFile.files[0]));

  async function parseHistory(file) {
    const msg = $('#mgHistMsg');
    msg.className = 'form-msg';
    msg.textContent = 'קורא את הדוחות… ⏳';
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/mortgage/history/parse', { method: 'POST', body: fd });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      if (!body.rows.length) throw new Error(body.warnings[0] ?? 'לא נמצאו דוחות שנתיים בקובץ');
      histPending = body;
      msg.textContent = '';
      renderHistPreview();
    } catch (err) {
      msg.className = 'form-msg error';
      msg.textContent = err.message;
    }
  }

  $('#mgHistClear').addEventListener('click', async () => {
    if (!confirm('למחוק את כל היסטוריית התשלומים?')) return;
    const msg = $('#mgHistMsg');
    try {
      await api('/api/mortgage/history', { method: 'DELETE' });
      history = [];
      renderHistory();
      msg.className = 'form-msg ok';
      msg.textContent = '✅ ההיסטוריה נמחקה';
    } catch (err) {
      msg.className = 'form-msg error';
      msg.textContent = err.message;
    }
  });

  /* ---------- מסמכים ---------- */
  function renderDocs(docs = []) {
    if (!docs.length) {
      $('#mgDocs').innerHTML = '';
      return;
    }
    $('#mgDocs').innerHTML = `
      <div class="table-wrap mt">
        <table class="import-table">
          <thead><tr><th>סוג</th><th>קובץ</th><th>הועלה</th><th></th></tr></thead>
          <tbody>
            ${docs.map((doc) => `<tr>
              <td>${MG_DOC_KINDS[doc.kind] ?? 'מסמך'}</td>
              <td>${escapeHtml(doc.filename || '—')}</td>
              <td>${escapeHtml(doc.uploaded_at || '')}</td>
              <td>
                <button class="btn-secondary mg-doc-open" data-id="${doc.id}">📄 פתח</button>
                <button class="btn-danger-outline mg-doc-del" data-id="${doc.id}">🗑</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    $$('.mg-doc-open').forEach((b) => b.addEventListener('click', () =>
      window.open(`/api/mortgage/docs/${b.dataset.id}/pdf`, '_blank')));
    $$('.mg-doc-del').forEach((b) => b.addEventListener('click', async () => {
      const msg = $('#mgDocMsg');
      try {
        const res = await api(`/api/mortgage/docs/${b.dataset.id}`, { method: 'DELETE' });
        renderDocs(res.docs);
        msg.className = 'form-msg ok';
        msg.textContent = '✅ המסמך נמחק';
        d.prompt = (await api('/api/mortgage')).prompt;
      } catch (err) {
        msg.className = 'form-msg error';
        msg.textContent = err.message;
      }
    }));
  }
  renderDocs(d.docs);

  const drop = $('#mgDrop');
  const fileInput = $('#mgFile');
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragover');
    if (e.dataTransfer.files[0]) uploadDoc(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => fileInput.files[0] && uploadDoc(fileInput.files[0]));

  async function uploadDoc(file) {
    const msg = $('#mgDocMsg');
    msg.className = 'form-msg';
    msg.textContent = 'קורא את המסמך… ⏳';
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('kind', $('#mgDocKind').value);
      // לא דרך api() — הוא כופה Content-Type: application/json
      const res = await fetch('/api/mortgage/docs', { method: 'POST', body: fd });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      renderDocs(body.docs);
      msg.className = 'form-msg ok';
      msg.textContent = `✅ ${MG_DOC_KINDS[body.kind]} נשמר`
        + (body.piiRemoved ? ` · הוסרו ${body.piiRemoved} פרטים מזהים` : '');
      d.prompt = (await api('/api/mortgage')).prompt;
    } catch (err) {
      msg.className = 'form-msg error';
      msg.textContent = err.message;
    }
  }

  /* ---------- ניתוח ---------- */
  function analysisBlock(res) {
    if (!res?.analysis_md) return '';
    return `<div class="ps-section-title"><h3>🔍 ניתוח המשכנתא</h3>
        <span class="stat-sub">${escapeHtml(res.analysis_at || '')} · ${escapeHtml(res.analysis_model || '')}</span></div>
      <div class="analysis-md">${renderMarkdown(res.analysis_md)}</div>`;
  }
  function qaBlock(qa = []) {
    return qa.map((h) => `
      <div class="qa-item">
        <div class="qa-q">❓ ${escapeHtml(h.q)}</div>
        <div class="qa-a analysis-md">${renderMarkdown(h.a)}</div>
        <div class="stat-sub">${escapeHtml(h.at || '')}</div>
      </div>`).join('');
  }
  $('#mgAnalysis').innerHTML = analysisBlock(d);
  $('#mgQaList').innerHTML = qaBlock(d.qa);

  $('#mgCopy').addEventListener('click', async () => {
    const msg = $('#mgAnalyzeMsg');
    try {
      await navigator.clipboard.writeText(d.prompt);
      msg.className = 'form-msg ok';
      msg.textContent = '✅ הפרומפט + כל נתוני המשכנתא הועתקו — הדבק בכל צ׳אטבוט (ChatGPT / Gemini / Claude)';
    } catch {
      msg.className = 'form-msg error';
      msg.textContent = 'ההעתקה נכשלה — הדפדפן חסם גישה ללוח';
    }
  });

  $('#mgDelete').addEventListener('click', async () => {
    if (!confirm('למחוק את כל נתוני המשכנתא, המסמכים והניתוח? הפעולה בלתי הפיכה.')) return;
    await api('/api/mortgage', { method: 'DELETE' });
    render();
  });

  $('#mgAnalyze').addEventListener('click', async () => {
    const btn = $('#mgAnalyze');
    const msg = $('#mgActionMsg');
    btn.disabled = true;
    msg.className = 'form-msg';
    // נמדד: ניתוח מלא ~330 שניות מול Codex (ChatGPT), ~60 מול Gemini
    msg.textContent = 'מנתח… ⏳ Gemini כדקה, ChatGPT עד כ-6 דקות — אל תסגור את הדף';
    try {
      const result = await api('/api/mortgage/analyze', { method: 'POST' });
      msg.className = 'form-msg ok';
      msg.textContent = '✅ הניתוח הושלם';
      d.analysis_md = result.analysis_md;
      d.analysis_at = result.analysis_at;
      $('#mgAnalysis').innerHTML = analysisBlock(result);
      // ניתוח חדש מאפס את שאלות ההמשך (הן התייחסו לניתוח הקודם)
      $('#mgQaWrap').hidden = false;
      $('#mgQaList').innerHTML = '';
      $('#mgQaClear').hidden = true;
      btn.textContent = '🔍 נתח מחדש';
      renderChecks(d.checks, d.analysis_at, d.updated_at);
      $('#mgAnalysis').scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      msg.className = 'form-msg error';
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------- שאלות המשך ---------- */
  const qaInput = $('#mgQaInput');
  async function askQuestion() {
    const question = qaInput.value.trim();
    const msg = $('#mgQaMsg');
    if (!question) return;
    const btn = $('#mgQaSend');
    btn.disabled = true;
    qaInput.disabled = true;
    msg.className = 'form-msg';
    msg.textContent = 'חושב… ⏳';
    try {
      const result = await api('/api/mortgage/ask', { method: 'POST', body: JSON.stringify({ question }) });
      qaInput.value = '';
      msg.textContent = '';
      $('#mgQaList').innerHTML = qaBlock(result.qa);
      $('#mgQaClear').hidden = false;
      $('#mgQaList').lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      msg.className = 'form-msg error';
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
      qaInput.disabled = false;
      qaInput.focus();
    }
  }
  $('#mgQaSend').addEventListener('click', askQuestion);
  qaInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') askQuestion(); });
  $('#mgQaClear').addEventListener('click', async () => {
    await api('/api/mortgage/qa', { method: 'DELETE' });
    $('#mgQaList').innerHTML = '';
    $('#mgQaClear').hidden = true;
  });
}

/* ================= צ'אט חופשי (קבוע בכל הטאבים) ================= */
// הפאנל חי מחוץ ל-#view ולכן שורד ניווט בין טאבים; ההקשר שנשלח למודל נקבע
// לפי document.body.dataset.view והחודש הנבחר — הבנייה עצמה בשרת
// (server/lib/assistant.js), כדי לא לשלוח את כל ה-DB לדפדפן ומשם למודל.
const CHAT_SAMPLES = {
  dashboard: ['על מה הוצאתי הכי הרבה במחזור הזה?', 'איך אני עומד מול המחזור הקודם?'],
  transactions: ['יש עסקאות חריגות במחזור?', 'כמה הוצאתי החודש על אוכל בחוץ?'],
  import: ['אילו עסקאות נשארו בלי קטגוריה?', 'מה מצב תוכניות התשלומים שלי?'],
  categories: ['איזו קטגוריה גדלה הכי הרבה בשנה האחרונה?', 'אילו כללי קטגוריזציה כדאי להוסיף?'],
  income: ['כמה עולות לי ההוצאות הקבועות בחודש?', 'אילו מנויים כדאי לבטל?'],
  payslip: ['למה הנטו השתנה בין החודשים?', 'מגיע לי החזר מס?'],
  mortgage: ['כמה אחסוך אם אקצר את המשכנתא בשנתיים?', 'איזה מסלול הכי כדאי למחזר ראשון?'],
  settings: ['כמה שאילתות AI ניצלתי היום?', 'מה ההגדרות שמשפיעות על חישוב המחזור?'],
};

// hiddenBefore = ה-id האחרון שהיה בהיסטוריה בטעינת העמוד. שיחות ישנות לא מוצגות
// בפאנל (הוא נפתח נקי בכל טעינה), אבל נשארות ב-DB ומשמשות את המודל כהקשר.
// showAll — המשתמש ביקש במפורש לראות אותן (כפתור "שיחות קודמות").
let chatState = {
  open: false, history: [], ready: true, engine: 'gemini', error: null, loading: false,
  hiddenBefore: 0, showAll: false,
};
// שמות הטאבים בעברית — מגיעים מהשרת (VIEW_LABELS ב-server/lib/assistant.js),
// כדי שלא תהיה רשימה כפולה שמתפצלת עם הזמן
let CHAT_VIEW_LABELS = {};

function chatViewName() {
  return document.body.dataset.view || 'dashboard';
}

function chatMsgHtml(entry) {
  return `
    <div class="chat-msg q">${escapeHtml(entry.q)}</div>
    <div class="chat-msg a">
      <div class="analysis-md">${renderMarkdown(entry.a)}</div>
      <div class="chat-meta">${escapeHtml(entry.at ?? '')}${entry.model ? ` · ${escapeHtml(entry.model)}` : ''}${
        entry.view ? ` · ${escapeHtml(CHAT_VIEW_LABELS[entry.view] ?? entry.view)}` : ''}</div>
    </div>`;
}

// מה שמוצג בפאנל: רק חילופים מהטעינה הנוכחית, אלא אם המשתמש ביקש את הישנים
function visibleChat() {
  if (chatState.showAll) return chatState.history;
  return chatState.history.filter((e) => (e.id ?? 0) > chatState.hiddenBefore);
}

// כפתור חשיפת השיחות הישנות — מוצג רק כשיש כאלה והן מוסתרות
function olderChatHtml() {
  if (chatState.showAll) return '';
  const n = chatState.history.length - visibleChat().length;
  return n ? `<button id="chatShowOlder" class="btn-link" type="button">📜 הצג ${n} שיחות קודמות</button>` : '';
}

function bindShowOlder() {
  $('#chatShowOlder')?.addEventListener('click', () => {
    chatState.showAll = true;
    renderChatLog();
  });
}

function renderChatLog() {
  const log = $('#chatLog');
  const shown = visibleChat();
  if (!shown.length) {
    const samples = CHAT_SAMPLES[chatViewName()] ?? CHAT_SAMPLES.dashboard;
    log.innerHTML = `
      <div class="chat-empty">
        שאל כל שאלה על הנתונים שלך. התשובה מבוססת על מה שקיים באפליקציה בלבד —
        המודל שולף בעצמו נתונים נוספים כשהוא צריך אותם.
        ${samples.map((s) => `<button class="chat-sample" type="button">${escapeHtml(s)}</button>`).join('')}
        ${olderChatHtml()}
      </div>`;
    $$('.chat-sample', log).forEach((b) => b.addEventListener('click', () => {
      $('#chatInput').value = b.textContent;
      sendChat();
    }));
    bindShowOlder();
    return;
  }
  const older = olderChatHtml();
  log.innerHTML = (older ? `<div class="chat-older">${older}</div>` : '') + shown.map(chatMsgHtml).join('');
  bindShowOlder();
  log.scrollTop = log.scrollHeight;
}

function renderChatFoot() {
  const foot = $('#chatFoot');
  if (!chatState.ready) {
    foot.innerHTML = `<span class="form-msg error">${escapeHtml(chatState.error ?? 'אין מנוע AI פעיל')}</span>`
      + ' <button id="chatCopyPrompt" class="btn-link" type="button">📋 העתק את הפרומפט</button>';
    $('#chatCopyPrompt')?.addEventListener('click', copyChatPrompt);
    return;
  }
  const engineLabel = chatState.engine === 'chatgpt' ? 'ChatGPT (דרך המנוי)' : 'Gemini';
  foot.innerHTML = `מנוע: ${escapeHtml(engineLabel)} · הנתונים הרלוונטיים לטאב נשלחים למנוע.`
    + ' <button id="chatShowContext" class="btn-link" type="button">מה נשלח?</button>';
  $('#chatShowContext')?.addEventListener('click', showChatContext);
}

async function showChatContext() {
  try {
    const ctx = await api(`/api/chat/context?view=${encodeURIComponent(chatViewName())}&month=${currentMonth}`);
    const log = $('#chatLog');
    const box = document.createElement('div');
    box.className = 'chat-msg a';
    box.innerHTML = `<strong>ההקשר שנשלח (טאב ${escapeHtml(ctx.label)}):</strong>`
      + `<div class="analysis-md">${renderMarkdown(ctx.snapshot)}</div>`;
    log.appendChild(box);
    log.scrollTop = log.scrollHeight;
  } catch (err) {
    alert(err.message);
  }
}

async function copyChatPrompt() {
  const question = $('#chatInput').value.trim();
  if (!question) { $('#chatInput').focus(); return; }
  try {
    const ctx = await api(`/api/chat/context?view=${encodeURIComponent(chatViewName())}`
      + `&month=${currentMonth}&question=${encodeURIComponent(question)}`);
    await navigator.clipboard.writeText(ctx.prompt);
    $('#chatFoot').insertAdjacentHTML('beforeend', ' <span class="form-msg">הפרומפט הועתק ✅</span>');
  } catch (err) {
    alert(err.message);
  }
}

async function sendChat() {
  if (chatState.loading) return;
  const input = $('#chatInput');
  const question = input.value.trim();
  if (!question) return;

  chatState.loading = true;
  $('#chatSend').disabled = true;
  input.disabled = true;
  const log = $('#chatLog');
  // תצוגה אופטימית — השאלה נראית מיד, לפני שהמודל עונה
  if (!visibleChat().length) log.innerHTML = '';
  log.insertAdjacentHTML('beforeend',
    `<div class="chat-msg q">${escapeHtml(question)}</div><div class="chat-msg a" id="chatPending">💭 חושב…</div>`);
  log.scrollTop = log.scrollHeight;
  // מונה שניות — תשובה דרך Codex/Gemini עשויה לקחת דקה ויותר, ובלי סימן חיים
  // נראה שהפאנל נתקע. אחרי 15 שניות גם מוסבר למה זה לוקח זמן.
  const t0 = Date.now();
  const ticker = setInterval(() => {
    const s = Math.round((Date.now() - t0) / 1000);
    const el = $('#chatPending');
    if (el) el.textContent = `💭 חושב… ${s}s${s > 15 ? ' (שולף נתונים נוספים לפי הצורך)' : ''}`;
  }, 1000);

  try {
    const result = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ question, view: chatViewName(), month: currentMonth }),
    });
    chatState.history = result.history;
    input.value = '';
    renderChatLog();
    if (result.queries?.length) {
      $('#chatLog').lastElementChild?.insertAdjacentHTML('beforeend',
        `<div class="chat-meta">נתונים שנשלפו: ${escapeHtml(result.queries.join(' · '))}</div>`);
    }
  } catch (err) {
    $('#chatPending')?.remove();
    log.insertAdjacentHTML('beforeend', `<div class="chat-msg err">${escapeHtml(err.message)}</div>`);
    log.scrollTop = log.scrollHeight;
  } finally {
    clearInterval(ticker);
    chatState.loading = false;
    $('#chatSend').disabled = false;
    input.disabled = false;
    input.focus();
  }
}

function setChatOpen(open) {
  chatState.open = open;
  $('#chatPanel').hidden = !open;
  $('#chatBackdrop').hidden = !open;
  document.body.classList.toggle('chat-open', open);
  $('#chatToggle').setAttribute('aria-expanded', String(open));
  localStorage.setItem('ms_chat_open', open ? '1' : '0');
  if (open) {
    updateChatContext();
    renderChatLog();
    $('#chatInput').focus();
  }
}

// תווית ההקשר בראש הפאנל — מתעדכנת בכל ניווט בין טאבים
function updateChatContext() {
  const el = $('#chatContext');
  if (!el) return;
  const name = chatViewName();
  el.textContent = `הקשר: ${CHAT_VIEW_LABELS[name] ?? name} · ${currentMonth}`;
}

async function initChat() {
  try {
    const data = await api('/api/chat');
    chatState = {
      ...chatState, history: data.history, ready: data.ready, engine: data.engine, error: data.error,
      // כל מה שכבר היה בהיסטוריה בטעינה — מוסתר עד לחיצה על "שיחות קודמות"
      hiddenBefore: data.history.length ? data.history[data.history.length - 1].id ?? 0 : 0,
    };
    CHAT_VIEW_LABELS = data.views ?? {};
  } catch {
    chatState.ready = false;
    chatState.error = 'טעינת הצ׳אט נכשלה';
  }
  renderChatFoot();
  renderChatLog();
  updateChatContext();

  $('#chatToggle').addEventListener('click', () => setChatOpen(!chatState.open));
  $('#chatClose').addEventListener('click', () => setChatOpen(false));
  $('#chatBackdrop').addEventListener('click', () => setChatOpen(false));
  $('#chatSend').addEventListener('click', sendChat);
  $('#chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  $('#chatClear').addEventListener('click', async () => {
    if (!chatState.history.length) return;
    if (!confirm('לנקות את היסטוריית השיחה?')) return;
    await api('/api/chat', { method: 'DELETE' });
    chatState.history = [];
    chatState.hiddenBefore = 0;
    chatState.showAll = false;
    renderChatLog();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && chatState.open) setChatOpen(false);
    // Alt+ש / Alt+A — פתיחה וסגירה מהמקלדת
    if (e.altKey && (e.key === 'ש' || e.key.toLowerCase() === 'a')) { e.preventDefault(); setChatOpen(!chatState.open); }
  });

  if (localStorage.getItem('ms_chat_open') === '1') setChatOpen(true);
}

/* ================= Router ================= */
const views = {
  dashboard: viewDashboard,
  transactions: viewTransactions,
  import: viewImport,
  categories: viewCategories,
  income: viewIncome,
  payslip: viewPayslip,
  mortgage: viewMortgage,
  // חיזוי מוסתר כרגע לבקשת המשתמש — ניווט ל-#forecast נופל לדשבורד. להחזרה:
  // בטל את ההערה כאן ואת הטאב ב-index.html. viewForecast עדיין מוגדרת למטה.
  // forecast: viewForecast,
  settings: viewSettings,
};

async function render() {
  const name = location.hash.slice(1) || 'dashboard';
  const view = views[name] ?? viewDashboard;
  $$('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
  // מאפשר CSS ייחודי לטאב (טאב המשכנתא רחב יותר — טבלאות הניתוח)
  document.body.dataset.view = name;
  // יציאה מטאב הקטגוריות סוגרת את הפירוט הפתוח (בתוך הטאב הוא שורד render)
  if (name !== 'categories') openCat = null;
  // דשבורד והכנסות — תווית טווח המחזור (10→10); בשאר הטאבים — חודש קלנדרי
  $('#monthLabel').textContent = ['dashboard', 'income'].includes(name)
    ? cycleLabel(currentMonth)
    : fmtMonth.format(new Date(currentMonth + '-01T12:00:00'));
  destroyCharts();
  // הצ'אט חי מחוץ ל-#view — רק תווית ההקשר והדוגמאות (הריקות) מתעדכנות בניווט
  updateChatContext();
  if (chatState.open && !visibleChat().length) renderChatLog();
  const el = $('#view');
  try {
    categories = await api('/api/categories');
    await view(el);
  } catch (err) {
    el.innerHTML = `<div class="card"><div class="empty-state">שגיאה: ${escapeHtml(err.message)}</div></div>`;
  }
}

function shiftMonth(delta) {
  const [y, m] = currentMonth.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  currentMonth = localMonth(d);
  render();
}

$('#prevMonth').addEventListener('click', () => shiftMonth(-1));
$('#nextMonth').addEventListener('click', () => shiftMonth(1));

// לחיצה על תווית החודש → בורר חודש native (קפיצה מהירה לכל חודש בשנה)
function openMonthPicker() {
  const p = $('#monthPicker');
  p.value = currentMonth;
  if (p.showPicker) { try { p.showPicker(); return; } catch { /* fallback */ } }
  p.focus();
}
$('#monthLabel').addEventListener('click', openMonthPicker);
$('#monthLabel').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMonthPicker(); } });
$('#monthPicker').addEventListener('change', (e) => {
  if (e.target.value) { currentMonth = e.target.value; render(); }
});
window.addEventListener('hashchange', render);

// עלייה: קודם מסנכרנים את עוגן המחזור מול השרת (הוא זה שמכיר את יום העוגן
// ואת `cycle_days`), ורק אז מרנדרים — אחרת הרינדור הראשון היה יכול להיות על
// המחזור הקודם ולקפוץ מיד אחריו.
async function boot() {
  try {
    currentMonth = (await api('/api/flow/current')).anchor_month;
  } catch { /* נשארים על החישוב המקומי */ }
  await render();
  initChat();
}
boot();
