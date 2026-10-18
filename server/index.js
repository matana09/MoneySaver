// MoneySaver — שרת לוקאלי
import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { webAccess } from './lib/webAccess.js';

import transactionsRouter from './routes/transactions.js';
import categoriesRouter from './routes/categories.js';
import incomeRouter from './routes/income.js';
import flowRouter from './routes/flow.js';
import importRouter from './routes/import.js';
import rulesRouter from './routes/rules.js';
import settingsRouter from './routes/settings.js';
import forecastRouter from './routes/forecast.js';
import subscriptionsRouter from './routes/subscriptions.js';
import recurringRouter from './routes/recurring.js';
import payslipRouter from './routes/payslip.js';
import mortgageRouter from './routes/mortgage.js';
import chatRouter from './routes/chat.js';

import { startMlService, stopMlService, mlTrain } from './lib/ml.js';
import { labeledData } from './lib/categorize.js';
import { runRecurring } from './lib/recurring.js';
import { runRecurringIncome } from './lib/recurringIncome.js';
import { marketRates } from './lib/marketRates.js';
import { startBot, notifyAllUsers } from './bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try { loadEnvFile(path.join(__dirname, '..', '.env')); }
catch (err) { if (err.code !== 'ENOENT') throw err; }
const app = express();
const PORT = process.env.PORT || 3000;
app.disable('x-powered-by'); // לא לחשוף Express/גרסה
app.use(webAccess({
  password: process.env.MONEYSAVER_WEB_PASSWORD || '',
  publicOrigin: process.env.MONEYSAVER_PUBLIC_ORIGIN || '',
  trustLocalProxy: process.env.MONEYSAVER_TRUST_LOCAL_PROXY === '1',
}));

// כותרות אבטחה + CSP. script-src בלי 'unsafe-inline' → inline event handlers
// (onerror וכו') ו-<script> מוזרקים לא רצים — חוסם XSS גם אם escape התפספס.
// style-src מתיר 'unsafe-inline' כי ה-UI משתמש ב-style attributes; זה מתיר לכל היותר
// CSS-injection (מנוטרל בנפרד ע"י safeColor), לא הרצת JS.
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.json({ limit: '256kb' })); // גבול גודל body — מונע abuse
app.use(express.static(path.join(__dirname, '..', 'public')));

// טיפול בשגיאת JSON שבור / body גדול מדי — מענה מסודר במקום קריסה
app.use((err, _req, res, next) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'הבקשה גדולה מדי' });
  if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ error: 'JSON לא תקין' });
  next(err);
});

app.use('/api/transactions', transactionsRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/income', incomeRouter);
app.use('/api/flow', flowRouter);
app.use('/api/import', importRouter);
app.use('/api/rules', rulesRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/forecast', forecastRouter);
app.use('/api/subscriptions', subscriptionsRouter);
app.use('/api/recurring', recurringRouter);
app.use('/api/payslip', payslipRouter);
app.use('/api/mortgage', mortgageRouter);
app.use('/api/chat', chatRouter);

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'MoneySaver', version: '1.0.0' }));

// '::' — dual-stack. ה-middleware מגביל גישה לפני הגשת קבצים או API.
app.listen(PORT, '::', async () => {
  console.log('MoneySaver רץ:');
  console.log(`  מקומי:    http://localhost:${PORT}`);
  console.log('  גישה מרחוק: רק דרך HTTPS proxy מקומי שהוגדר במפורש וסיסמה.');

  startMlService();
  await startBot();

  // אימון ראשוני ברקע אם יש נתונים מתויגים
  setTimeout(() => mlTrain(labeledData()).catch(() => {}), 5000);

  // הוצאות קבועות: ריצה בעלייה (catch-up אם המחשב היה כבוי ביום המופע) + כל שעה.
  // על כל עסקה שנוספה — התראת טלגרם לשני המשתמשים עם כפתור ביטול.
  const DAY_NAMES_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  const fmtILS = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });
  async function recurringTick() {
    try {
      const added = await runRecurring();
      for (const tx of added) {
        const when = tx.freq === 'weekly' ? `יום ${DAY_NAMES_HE[tx.day]}` : `${tx.day} בחודש`;
        await notifyAllUsers(
          `🔁 נוספה הוצאה קבועה: ${tx.merchant} — ${fmtILS.format(tx.amount)} (${when}, ${tx.date})` +
          (tx.category_name ? `\nקטגוריה: ${tx.category_icon} ${tx.category_name}` : ''),
          [[{ text: '🗑 ביטול', callback_data: `tx:del:${tx.id}` }]]
        );
      }
      // הכנסות קבועות (קצבה וכו') — מופע חדש ביום ה-day_of_month בכל חודש
      const addedIncome = runRecurringIncome();
      for (const inc of addedIncome) {
        await notifyAllUsers(
          `🔁 נוספה הכנסה קבועה: ${inc.name} — ${fmtILS.format(inc.amount)} (${inc.date})`,
          [[{ text: '🗑 ביטול', callback_data: `inc:del:${inc.id}` }]]
        );
      }
    } catch (err) {
      console.error('recurring tick נכשל:', err.message);
    }
    // נתוני שוק לטאב המשכנתא (ריבית בנק ישראל + ריביות ממוצעות). הפונקציה
    // מרעננת רק אם הנתון מיושן מ-12 שעות, ולכן הטיק השעתי לא מציף את בנק ישראל.
    try {
      await marketRates();
    } catch (err) {
      console.error('שליפת נתוני שוק נכשלה:', err.message);
    }
  }
  recurringTick();
  // הטיקים מיושרים לתחילת שעה עגולה (07:00, 08:00…) — כדי שהוצאה קבועה עם שעה
  // (hour) תיווסף בדיוק בשעה שנקבעה, לא עד 59 דקות אחריה. +5s ביטחון אחרי ה-:00.
  function scheduleAlignedTick() {
    const msToNextHour = 3600000 - (Date.now() % 3600000);
    setTimeout(() => { recurringTick(); scheduleAlignedTick(); }, msToNextHour + 5000).unref();
  }
  scheduleAlignedTick();
});

process.on('exit', stopMlService);
process.on('SIGINT', () => { stopMlService(); process.exit(0); });
