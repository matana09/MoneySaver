// משכנתא — טופס נתונים, מסמכי PDF, בדיקות מקומיות וניתוח דרך Gemini.
// רשומה אחת (singleton) — אין פרמטר חודש כמו בתלוש.
import { Router } from 'express';
import multer from 'multer';
import { db } from '../db.js';
import { extractPdfText } from '../lib/importer.js';
import {
  saveMortgage, mortgageDetail, mortgageForAnalysis, mortgageDocs,
  storeMortgageDoc, docCount, saveAnalysis, saveQa, stripMortgagePii,
  buildMortgageAnalysisPrompt, buildMortgageQuestionPrompt, normalizeTracks,
  DOC_KINDS, MAX_DOCS,
} from '../lib/mortgage.js';
import { buildSimulation, DEFAULT_CPI } from '../lib/mortgageSim.js';
import {
  parseAnnualStatements, mortgageHistory, saveHistory,
  deleteHistoryYear, clearHistory, historyDerived,
} from '../lib/mortgageHistory.js';
import { llmAnalyze, llmReady, ANALYSIS_TIMEOUT_MS } from '../lib/llm.js';
import { usageSummary } from '../lib/llmUsage.js';
import { marketRates, refreshMarketRates } from '../lib/marketRates.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// המנוע הפעיל מוכן לניתוח, או תשובת 400 מוכנה — זהה לתלוש
// (server/routes/payslip.js). הבחירה בין Gemini ל-ChatGPT ב-server/lib/llm.js.
function requireEngine(res) {
  const ready = llmReady();
  if (ready.ok) return true;
  res.status(400).json({ error: ready.error, noKey: true });
  return false;
}

// GET /api/mortgage — פירוט מלא + נתוני שוק + הפרומפט המוכן להעתקה.
// נתוני השוק מרוענים אוטומטית אם עברו יותר מ-12 שעות מהשליפה האחרונה.
router.get('/', async (_req, res) => {
  res.json(mortgageDetail(await marketRates()));
});

// GET /api/mortgage/market — נתוני השוק בלבד
router.get('/market', async (_req, res) => {
  res.json(await marketRates());
});

// POST /api/mortgage/market/refresh — שליפה מחדש מיידית (כפתור "רענן")
router.post('/market/refresh', async (_req, res) => {
  try {
    res.json(await refreshMarketRates());
  } catch (err) {
    res.status(502).json({ error: `שליפת נתוני השוק נכשלה: ${err.message}` });
  }
});

// PUT /api/mortgage — שמירת הטופס (פרטים כלליים + מסלולים)
router.put('/', async (req, res) => {
  try {
    const saved = saveMortgage(req.body?.data, req.body?.tracks, await marketRates());
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: `שמירת נתוני המשכנתא נכשלה: ${err.message}` });
  }
});

// POST /api/mortgage/docs — העלאת מסמך PDF (דוח יתרות / לוח סילוקין / אחר)
router.post('/docs', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא צורף קובץ' });
  if (!req.file.originalname.toLowerCase().endsWith('.pdf')) {
    return res.status(400).json({ error: 'המסמך חייב להיות קובץ PDF' });
  }
  const kind = DOC_KINDS.includes(req.body?.kind) ? req.body.kind : 'other';
  if (docCount() >= MAX_DOCS) {
    return res.status(400).json({ error: `אפשר לשמור עד ${MAX_DOCS} מסמכים — מחק מסמך קיים כדי להוסיף חדש` });
  }

  let text;
  try {
    text = await extractPdfText(req.file.buffer);
  } catch (err) {
    // כולל PDF מוגן בסיסמה ומסמך סרוק כתמונה — ההודעות כבר בעברית
    return res.status(422).json({ error: err.message });
  }

  const { text: clean, removed } = stripMortgagePii(text);
  try {
    const stored = storeMortgageDoc({ buf: req.file.buffer, filename: req.file.originalname, kind, text: clean });
    res.json({ ...stored, piiRemoved: removed, docs: mortgageDocs() });
  } catch (err) {
    res.status(500).json({ error: `שמירת המסמך נכשלה: ${err.message}` });
  }
});

// GET /api/mortgage/docs/:id/pdf — הקובץ המקורי (נפתח בטאב חדש; CSP חוסם הטמעה)
router.get('/docs/:id/pdf', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'מזהה לא תקין' });
  const row = db.prepare('SELECT pdf, filename FROM mortgage_docs WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'לא נמצא מסמך' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="mortgage-${id}.pdf"`);
  res.send(Buffer.from(row.pdf));
});

// DELETE /api/mortgage/docs/:id
router.delete('/docs/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'מזהה לא תקין' });
  const result = db.prepare('DELETE FROM mortgage_docs WHERE id = ?').run(id);
  if (!result.changes) return res.status(404).json({ error: 'לא נמצא מסמך' });
  res.json({ deleted: true, docs: mortgageDocs() });
});

// POST /api/mortgage/simulate — סימולציית "מה יקרה אם": תוספת להחזר החודשי,
// פירעון חד-פעמי, וסיכון עליית ריבית. חישוב טהור בלבד — **לא נוגע ב-DB ולא
// ב-LLM**, ולכן אפשר לקרוא לו בכל הקלדה בטופס בלי לשמור ובלי לשרוף מכסה.
// המסלולים נלקחים מהשמור ב-DB, אלא אם נשלחו במפורש (טופס שטרם נשמר).
router.post('/simulate', (req, res) => {
  const b = req.body ?? {};
  const tracks = Array.isArray(b.tracks) && b.tracks.length
    ? normalizeTracks(b.tracks)
    : mortgageDetail(null).tracks;
  const n = (v, dflt = 0) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= 0 ? x : dflt;
  };
  try {
    res.json(buildSimulation({
      tracks,
      extraMonthly: n(b.extra_monthly),
      lumpSum: n(b.lump_sum),
      // הנחת אינפלציה — מוגבלת לטווח שפוי כדי שלא תיווצר סימולציה חסרת משמעות
      cpiAnnual: Math.min(n(b.cpi_annual, DEFAULT_CPI), 15),
      rollover: b.rollover !== false,
    }));
  } catch (err) {
    res.status(500).json({ error: `חישוב הסימולציה נכשל: ${err.message}` });
  }
});

/* ---------- היסטוריית תשלומים שנתית ---------- */

// POST /api/mortgage/history/parse — חילוץ דוחות שנתיים מ-PDF. **לא שומר**:
// הפרסר עלול לטעות בגלל שיבושי חילוץ, ולכן המשתמש מאשר את השורות ב-UI קודם.
router.post('/history/parse', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא צורף קובץ' });
  if (!req.file.originalname.toLowerCase().endsWith('.pdf')) {
    return res.status(400).json({ error: 'המסמך חייב להיות קובץ PDF' });
  }
  let text;
  try {
    text = await extractPdfText(req.file.buffer);
  } catch (err) {
    return res.status(422).json({ error: err.message });
  }
  // **בכוונה בלי stripMortgagePii** — בשונה מ-/docs, שמאחסן את הטקסט עצמו.
  // שני טעמים: (1) הפלט של הפרסר הוא סכמה מספרית סגורה (שנה + סכומים), ואף
  // טקסט חופשי לא עובר ממנו ל-DB או לפרומפט, ולכן אין מה לדלוף. (2) המיסוך
  // דווקא הורס את הנתון: הכלל שממסך מספרי חשבון בנק (`stripPii` ב-payslip.js)
  // חל על כל שורה שמכילה "חשבון" — והכותרת היא "מצב חשבון מתומצת לשנת 2019",
  // כך שהשנה עצמה הייתה מומסכת ואף דוח לא זוהה.
  const { rows, warnings } = parseAnnualStatements(text);
  res.json({ rows, warnings, existing: mortgageHistory() });
});

// GET /api/mortgage/history
router.get('/history', (_req, res) => {
  const rows = mortgageHistory();
  res.json({ rows, derived: historyDerived(rows) });
});

// PUT /api/mortgage/history — שמירת השורות שהמשתמש אישר (upsert לפי שנה)
router.put('/history', (req, res) => {
  try {
    const rows = saveHistory(req.body?.rows);
    res.json({ rows, derived: historyDerived(rows) });
  } catch (err) {
    res.status(500).json({ error: `שמירת ההיסטוריה נכשלה: ${err.message}` });
  }
});

// DELETE /api/mortgage/history/:year — מחיקת שנה בודדת
router.delete('/history/:year', (req, res) => {
  if (!deleteHistoryYear(req.params.year)) return res.status(404).json({ error: 'לא נמצאה שנה כזו' });
  const rows = mortgageHistory();
  res.json({ deleted: true, rows, derived: historyDerived(rows) });
});

// DELETE /api/mortgage/history — מחיקת כל ההיסטוריה
router.delete('/history', (_req, res) => {
  clearHistory();
  res.json({ deleted: true, rows: [], derived: null });
});

// POST /api/mortgage/analyze — ניתוח דרך Gemini
router.post('/analyze', async (req, res) => {
  if (!requireEngine(res)) return;
  // נתוני השוק נשלפים לפני כל ניתוח — הריביות בפרומפט תמיד עדכניות
  const market = await marketRates();
  const { data, tracks, checks, docs, history } = mortgageForAnalysis(market);
  if (!Object.keys(data).length && !tracks.length && !docs.length) {
    return res.status(400).json({ error: 'אין נתונים לניתוח — מלא את הטופס ושמור אותו קודם' });
  }
  const prompt = buildMortgageAnalysisPrompt(data, tracks, checks, docs, market, history);
  try {
    // ניתוח מלא — תקרת זמן מוגדלת; ראו ANALYSIS_TIMEOUT_MS ב-lib/llm.js
    const { text, model, engine, fellBack, fallbackReason } = await llmAnalyze(prompt, { timeoutMs: ANALYSIS_TIMEOUT_MS });
    const at = saveAnalysis(text, model);
    res.json({
      analysis_md: text, analysis_model: model, analysis_at: at, qa: [],
      engine, fellBack, fallbackReason, usage: usageSummary(),
    });
  } catch (err) {
    res.status(502).json({ error: err.message, usage: usageSummary() });
  }
});

// POST /api/mortgage/ask — שאלת המשך חופשית
const MAX_QUESTION = 1000;
router.post('/ask', async (req, res) => {
  const question = String(req.body?.question ?? '').trim();
  if (!question) return res.status(400).json({ error: 'לא נשלחה שאלה' });
  if (question.length > MAX_QUESTION) return res.status(400).json({ error: `השאלה ארוכה מדי (עד ${MAX_QUESTION} תווים)` });

  if (!requireEngine(res)) return;
  const market = await marketRates();
  const { data, tracks, analysis_md: analysisMd, qa: history, history: yearly } = mortgageForAnalysis(market);
  if (!Object.keys(data).length && !tracks.length) {
    return res.status(400).json({ error: 'אין נתוני משכנתא — מלא את הטופס ושמור אותו קודם' });
  }

  const prompt = buildMortgageQuestionPrompt({ question, data, tracks, analysisMd, history, market, yearly });
  try {
    const { text, model, engine, fellBack } = await llmAnalyze(prompt);
    const entry = { q: question, a: text, at: new Date().toISOString().slice(0, 19).replace('T', ' '), model };
    // שומרים 20 אחרונות — מספיק להקשר, ומונע ניפוח הפרומפט והשורה ב-DB
    const updated = [...history, entry].slice(-20);
    saveQa(updated);
    res.json({ entry, qa: updated, engine, fellBack, usage: usageSummary() });
  } catch (err) {
    res.status(502).json({ error: err.message, usage: usageSummary() });
  }
});

// DELETE /api/mortgage/qa — ניקוי היסטוריית השאלות
router.delete('/qa', (_req, res) => {
  db.prepare("UPDATE mortgage SET qa_json = '[]' WHERE id = 1").run();
  res.json({ cleared: true });
});

// DELETE /api/mortgage — מחיקת הנתונים, המסמכים וההיסטוריה
router.delete('/', (_req, res) => {
  db.prepare('DELETE FROM mortgage_docs').run();
  db.prepare('DELETE FROM mortgage WHERE id = 1').run();
  clearHistory();
  res.json({ deleted: true });
});

export default router;
