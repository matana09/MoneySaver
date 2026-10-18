// gemini.js — קריאה ל-Google Gemini API (מסלול חינמי, מפתח מ-aistudio.google.com)
// שימוש יחיד באפליקציה: ניתוח תלוש משכורת. הטקסט נשלח רק אחרי stripPii.

// כינוי 'latest' ולא גרסה נקובה — Google מוציאה גרסאות משירות למשתמשים חדשים
// (gemini-2.5-flash החזיר 404 "no longer available to new users"); הכינוי תמיד תקף.
// רק flash — ל-Pro אין מכסה חינמית בכלל בחלק מהמפתחות (limit: 0, לא זמני),
// ולכן הוא לא מוצע לבחירה (ראו quotaErrorMessage).
export const GEMINI_MODEL = 'gemini-flash-latest';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * הודעת שגיאה בעברית לתשובת 429. "limit: 0" — למפתח הזה אין בכלל מכסה חינמית
 * למודל הזה; לא זמני, המתנה לא תעזור (קרה בפועל עם Pro, ולכן הוא לא מוצע
 * לבחירה — אבל השארנו את הזיהוי כרשת ביטחון גם ל-flash). שונה מ"נסה שוב בעוד
 * X שניות" — מכסת RPM/RPD רגילה שחלפה וכן מתחדשת. מיוצא לבדיקות.
 */
export function quotaErrorMessage(body, model) {
  if (/limit:\s*0\b/.test(body)) {
    return `מודל ${model} לא זמין למכסה החינמית של המפתח הזה (מכסה: 0) — פנה לתמיכת Google או המתן להפעלת חיוב בחשבון`;
  }
  return 'חריגה ממכסת החינם של Gemini — נסה שוב בעוד כמה דקות';
}

/**
 * שולח פרומפט ל-Gemini ומחזיר { text, model }.
 * זורק Error עם הודעה בעברית — הקורא מציג אותה כמו שהיא למשתמש.
 */
export async function geminiAnalyze(promptText, apiKey, { model = GEMINI_MODEL, timeoutMs = 120000 } = {}) {
  if (!apiKey) throw new Error('לא הוגדר מפתח Gemini');

  let res;
  try {
    res = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // המפתח ב-header ולא ב-query string — לא נכנס ללוגים של proxy/שרת
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 16384 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error('הניתוח ארך יותר מדי (timeout) — נסה שוב');
    }
    throw new Error(`החיבור ל-Gemini נכשל: ${err?.message ?? 'שגיאת רשת'}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 429) throw new Error(quotaErrorMessage(body, model));
    if (res.status === 400 || res.status === 403) throw new Error('מפתח Gemini לא תקין או חסום — בדוק אותו בהגדרות');
    throw new Error(`Gemini החזיר שגיאה (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json().catch(() => null);
  const blocked = data?.promptFeedback?.blockReason;
  if (blocked) throw new Error(`Gemini חסם את הבקשה (${blocked})`);
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim();
  if (!text) throw new Error('Gemini החזיר תשובה ריקה — נסה שוב');

  return { text, model };
}
