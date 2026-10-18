// צ'אט חופשי — שאלה על נתוני האפליקציה מכל טאב. הלוגיקה ב-server/lib/assistant.js.
import { Router } from 'express';
import {
  askAssistant, chatHistory, clearChatHistory, buildSnapshot, buildChatPrompt,
  VIEW_LABELS, VIEWS, MAX_QUESTION, safeView, safeMonth,
} from '../lib/assistant.js';
import { llmReady, currentEngine } from '../lib/llm.js';
import { usageSummary } from '../lib/llmUsage.js';

const router = Router();

// GET /api/chat — היסטוריה + מצב המנוע (הפאנל נטען פעם אחת ונשאר בכל הטאבים)
router.get('/', (_req, res) => {
  const ready = llmReady();
  res.json({
    history: chatHistory(),
    engine: currentEngine(),
    ready: ready.ok,
    error: ready.ok ? null : ready.error,
    views: VIEW_LABELS,
    usage: usageSummary(),
  });
});

// GET /api/chat/context?view=&month= — ההקשר שנשלח למודל, לתצוגה למשתמש
// ("מה בעצם נשלח החוצה?"). כולל את הפרומפט המלא להעתקה ידנית כשאין מנוע.
router.get('/context', (req, res) => {
  const view = safeView(req.query.view);
  const month = safeMonth(req.query.month);
  const question = String(req.query.question ?? '').slice(0, MAX_QUESTION);
  res.json({
    view,
    month,
    label: VIEW_LABELS[view],
    snapshot: buildSnapshot(view, month),
    prompt: question ? buildChatPrompt({ question, view, month, history: chatHistory().slice(-8) }) : null,
  });
});

// POST /api/chat — { question, view, month }
router.post('/', async (req, res) => {
  const question = String(req.body?.question ?? '').trim();
  if (!question) return res.status(400).json({ error: 'לא נשלחה שאלה' });
  if (question.length > MAX_QUESTION) {
    return res.status(400).json({ error: `השאלה ארוכה מדי (עד ${MAX_QUESTION} תווים)` });
  }
  if (req.body?.view !== undefined && !VIEWS.includes(String(req.body.view))) {
    return res.status(400).json({ error: 'טאב לא מוכר' });
  }
  const ready = llmReady();
  if (!ready.ok) return res.status(400).json({ error: ready.error, noKey: true });

  try {
    const result = await askAssistant({
      question,
      view: req.body?.view,
      month: req.body?.month,
      source: 'web',
    });
    res.json({ ...result, usage: usageSummary() });
  } catch (err) {
    res.status(502).json({ error: err.message, usage: usageSummary() });
  }
});

// DELETE /api/chat — ניקוי היסטוריית השיחה
router.delete('/', (_req, res) => {
  clearChatHistory();
  res.json({ cleared: true });
});

export default router;
