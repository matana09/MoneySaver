// ייבוא CSV/PDF/תמונה (JPG/PNG, OCR) — תצוגה מקדימה ואישור
import { Router } from 'express';
import multer from 'multer';
import { parseCsv, parsePdf, enrichRows, commitRows } from '../lib/importer.js';
import { parseImage } from '../lib/ocr.js';
import { labeledData } from '../lib/categorize.js';
import { mlTrain } from '../lib/ml.js';
import { parseSms } from '../lib/smsParser.js';
import { addTransaction, findDuplicate } from '../lib/addTransaction.js';
import { cycleDayFn } from './flow.js';
import { notifyTransactionAdded, notifyImportCommitted } from '../bot.js';

const router = Router();
// 20MB — תמונות מהטלפון (צילום מסך/דוח) גדולות יותר מ-CSV/PDF טיפוסי
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const IMAGE_EXT = /\.(jpe?g|png)$/i;

// POST /api/import/preview — קובץ → שורות מפורסרות עם דגלי כפילות והצעות קטגוריה
router.post('/preview', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא צורף קובץ' });
  const name = req.file.originalname.toLowerCase();
  try {
    const parsed = name.endsWith('.pdf') ? await parsePdf(req.file.buffer)
      : IMAGE_EXT.test(name) ? await parseImage(req.file.buffer)
      : parseCsv(req.file.buffer);
    // תמונה מתויגת כ-'pdf' ב-source (אותה סמנטיקת ייבוא/dedup — דוח מפוענח, לא
    // ידני) — אין ערך CHECK נפרד ב-DB לתמונות (ראו server/lib/ocr.js).
    const source = parsed.format === 'csv' ? 'csv' : 'pdf';
    // תמונה: גם כפילות "רכה" (תאריך+סכום) — שם בית עסק מ-OCR עלול לצאת שונה
    const rows = enrichRows(parsed.rows, source, { fuzzyDup: parsed.format === 'jpg', cycleDay: cycleDayFn });
    res.json({
      filename: req.file.originalname,
      format: parsed.format,
      source,
      parsed: rows.length,
      skipped: parsed.skipped,
      duplicates: rows.filter((r) => r.duplicate).length,
      rows,
    });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// POST /api/import/commit — { source, rows } → הוספה בפועל
router.post('/commit', async (req, res) => {
  const { source, rows } = req.body;
  if (!['csv', 'pdf', 'telegram', 'sms'].includes(source) || !Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: 'source או rows חסרים' });
  }
  const result = commitRows(rows, source, { cycleDay: cycleDayFn });
  notifyImportCommitted(result).catch(() => {});
  // אימון מחדש ברקע אחרי ייבוא (fire-and-forget)
  if (result.inserted > 0) mlTrain(labeledData()).catch(() => {});
  res.json(result);
});

// POST /api/import/sms — הדבקת טקסט SMS מהדפדפן
router.post('/sms', async (req, res) => {
  const parsed = parseSms(req.body.text);
  if (!parsed) {
    return res.status(422).json({ error: 'לא זוהתה עסקה בטקסט. ודא שה-SMS כולל סכום עם ₪/ש"ח ושם בית עסק' });
  }
  if (findDuplicate({ ...parsed, type: 'expense' })) {
    return res.status(409).json({
      error: `SMS זה כבר נקלט: ${parsed.merchant} — ${parsed.amount} ₪ בתאריך ${parsed.date}. לא נוסף שוב.`,
      duplicate: true,
    });
  }
  const tx = await addTransaction({ ...parsed, source: 'sms' });
  notifyTransactionAdded(tx).catch(() => {});
  res.status(201).json(tx);
});

export default router;
