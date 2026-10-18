// תלוש משכורת — העלאת PDF חודשי, חילוץ שדות, בדיקות וניתוח
import { Router } from 'express';
import multer from 'multer';
import { db, getSetting } from '../db.js';
import { extractPdfText } from '../lib/importer.js';
import {
  MONTH_RE, detectMonth, storePayslip, payslipDetail, payslipFields, prevMonth,
  buildAnalysisPrompt, buildQuestionPrompt,
} from '../lib/payslip.js';
import { llmAnalyze, llmReady, ANALYSIS_TIMEOUT_MS } from '../lib/llm.js';
import { usageSummary } from '../lib/llmUsage.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ולידציית פרמטר חודש — כל נתיב עם :month עובר דרכה
function validMonth(req, res) {
  if (MONTH_RE.test(req.params.month)) return true;
  res.status(400).json({ error: 'חודש לא תקין (צפוי YYYY-MM)' });
  return false;
}

// המנוע הפעיל מוכן לניתוח, או תשובת 400 מוכנה — משותף ל-analyze ול-ask.
// הבחירה בין Gemini ל-ChatGPT (דרך Codex) נעשית ב-server/lib/llm.js.
function requireEngine(res) {
  const ready = llmReady();
  if (ready.ok) return true;
  res.status(400).json({ error: ready.error, noKey: true });
  return false;
}

// POST /api/payslip/upload — קובץ PDF (+ month אופציונלי לעקיפת הזיהוי האוטומטי)
router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא צורף קובץ' });
  if (!req.file.originalname.toLowerCase().endsWith('.pdf')) {
    return res.status(400).json({ error: 'תלוש משכורת חייב להיות קובץ PDF' });
  }
  const override = req.body?.month;
  if (override && !MONTH_RE.test(override)) return res.status(400).json({ error: 'חודש לא תקין (צפוי YYYY-MM)' });

  let text;
  try {
    text = await extractPdfText(req.file.buffer);
  } catch (err) {
    // כולל PDF מוגן בסיסמה ותלוש סרוק כתמונה — ההודעות כבר בעברית
    return res.status(422).json({ error: err.message });
  }

  const month = override || detectMonth(text);
  if (!month) {
    return res.status(422).json({ error: 'לא זוהה חודש בתלוש — בחר חודש ידנית', needMonth: true });
  }

  try {
    const result = storePayslip({ buf: req.file.buffer, filename: req.file.originalname, month, text });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: `שמירת התלוש נכשלה: ${err.message}` });
  }
});

// GET /api/payslip — רשימת החודשים (בלי ה-BLOB ובלי הטקסט)
router.get('/', (_req, res) => {
  const rows = db.prepare(`
    SELECT month, filename, uploaded_at, analysis_at, fields_json, checks_json
    FROM payslips ORDER BY month DESC
  `).all();
  res.json(rows.map((r) => ({
    month: r.month,
    filename: r.filename,
    uploaded_at: r.uploaded_at,
    analyzed: Boolean(r.analysis_at),
    fields: JSON.parse(r.fields_json),
    checks: JSON.parse(r.checks_json),
  })));
});

// GET /api/payslip/:month — פירוט מלא + הפרומפט המוכן להעתקה ידנית
router.get('/:month', (req, res) => {
  if (!validMonth(req, res)) return;
  const detail = payslipDetail(req.params.month);
  if (!detail) return res.status(404).json({ error: 'לא נמצא תלוש לחודש הזה' });
  res.json(detail);
});

// GET /api/payslip/:month/pdf — הקובץ המקורי (נפתח בטאב חדש; CSP חוסם הטמעה)
router.get('/:month/pdf', (req, res) => {
  if (!validMonth(req, res)) return;
  const row = db.prepare('SELECT pdf FROM payslips WHERE month = ?').get(req.params.month);
  if (!row) return res.status(404).json({ error: 'לא נמצא תלוש לחודש הזה' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="payslip-${req.params.month}.pdf"`);
  res.send(Buffer.from(row.pdf));
});

// POST /api/payslip/:month/analyze — ניתוח דרך Gemini
router.post('/:month/analyze', async (req, res) => {
  if (!validMonth(req, res)) return;
  const month = req.params.month;
  if (!requireEngine(res)) return;
  const row = db.prepare('SELECT extracted_text, fields_json FROM payslips WHERE month = ?').get(month);
  if (!row) return res.status(404).json({ error: 'לא נמצא תלוש לחודש הזה' });

  const fields = JSON.parse(row.fields_json);
  const prompt = buildAnalysisPrompt(fields, row.extracted_text, month, payslipFields(prevMonth(month)));
  try {
    // ניתוח מלא — תקרת זמן מוגדלת; ראו ANALYSIS_TIMEOUT_MS ב-lib/llm.js
    const { text, model, engine, fellBack, fallbackReason } = await llmAnalyze(prompt, { timeoutMs: ANALYSIS_TIMEOUT_MS });
    // ניתוח חדש מאפס את שאלות ההמשך — הן התייחסו לניתוח הקודם
    db.prepare(`
      UPDATE payslips SET analysis_md = ?, analysis_at = datetime('now','localtime'),
                          analysis_model = ?, qa_json = '[]'
      WHERE month = ?
    `).run(text, model, month);
    const saved = db.prepare('SELECT analysis_at FROM payslips WHERE month = ?').get(month);
    res.json({
      analysis_md: text, analysis_model: model, analysis_at: saved.analysis_at, qa: [],
      engine, fellBack, fallbackReason, usage: usageSummary(),
    });
  } catch (err) {
    res.status(502).json({ error: err.message, usage: usageSummary() });
  }
});

// POST /api/payslip/:month/ask — שאלת המשך חופשית על התלוש
const MAX_QUESTION = 1000;
router.post('/:month/ask', async (req, res) => {
  if (!validMonth(req, res)) return;
  const month = req.params.month;
  const question = String(req.body?.question ?? '').trim();
  if (!question) return res.status(400).json({ error: 'לא נשלחה שאלה' });
  if (question.length > MAX_QUESTION) return res.status(400).json({ error: `השאלה ארוכה מדי (עד ${MAX_QUESTION} תווים)` });

  if (!requireEngine(res)) return;
  const row = db.prepare('SELECT extracted_text, fields_json, analysis_md, qa_json FROM payslips WHERE month = ?').get(month);
  if (!row) return res.status(404).json({ error: 'לא נמצא תלוש לחודש הזה' });

  const history = JSON.parse(row.qa_json || '[]');
  const prompt = buildQuestionPrompt({
    question,
    fields: JSON.parse(row.fields_json),
    strippedText: row.extracted_text,
    month,
    analysisMd: row.analysis_md,
    history,
  });
  try {
    const { text, model, engine, fellBack } = await llmAnalyze(prompt);
    const entry = { q: question, a: text, at: new Date().toISOString().slice(0, 19).replace('T', ' '), model };
    // שומרים 20 אחרונות — מספיק להקשר, ומונע ניפוח הפרומפט והשורה ב-DB
    const updated = [...history, entry].slice(-20);
    db.prepare('UPDATE payslips SET qa_json = ? WHERE month = ?').run(JSON.stringify(updated), month);
    res.json({ entry, qa: updated, engine, fellBack, usage: usageSummary() });
  } catch (err) {
    res.status(502).json({ error: err.message, usage: usageSummary() });
  }
});

// DELETE /api/payslip/:month/qa — ניקוי היסטוריית השאלות
router.delete('/:month/qa', (req, res) => {
  if (!validMonth(req, res)) return;
  const result = db.prepare("UPDATE payslips SET qa_json = '[]' WHERE month = ?").run(req.params.month);
  if (!result.changes) return res.status(404).json({ error: 'לא נמצא תלוש לחודש הזה' });
  res.json({ cleared: true });
});

// DELETE /api/payslip/:month
router.delete('/:month', (req, res) => {
  if (!validMonth(req, res)) return;
  const result = db.prepare('DELETE FROM payslips WHERE month = ?').run(req.params.month);
  if (!result.changes) return res.status(404).json({ error: 'לא נמצא תלוש לחודש הזה' });
  res.json({ deleted: true });
});

export default router;
