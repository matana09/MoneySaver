// בדיקות: שיוך קטגוריה לעסקה — בודדת ו"על כל העסקאות של אותו בית עסק".
// ראו server/lib/categoryAssign.js ואת הנתיבים /:id/category ו-/:id/merchant-peers.
// רץ מול שרת הבדיקות (פורט 3100, DB זמני) — לעולם לא מול 3000.
import { db } from '../server/db.js';
import { assignCategory, merchantPeers, getTransaction } from '../server/lib/categoryAssign.js';
import { historyMatch } from '../server/lib/categorize.js';

const BASE = process.env.MS_BASE || 'http://127.0.0.1:3100';
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
  cond ? pass++ : fail++;
};

console.log('========== שיוך קטגוריה (בודד + גורף) ==========\n');

// שורת קטגוריה מלאה (כולל icon) — כמו זו ש-resolveCategory מחזירה לתצוגות
const catA = db.prepare('SELECT * FROM categories ORDER BY id LIMIT 1').get();
const catB = db.prepare('SELECT * FROM categories ORDER BY id LIMIT 1 OFFSET 1').get();

// תאריכים ב-2018 — חלון שאף מערך אחר לא נוגע בו (דטרמיניסטי)
function insertTx({ date, amount, merchant, type = 'expense', category_id = null }) {
  return db.prepare(
    'INSERT INTO transactions (date, amount, type, merchant, description, category_id, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(date, amount, type, merchant, '', category_id, 'pdf').lastInsertRowid;
}

const t1 = insertTx({ date: '2018-03-01', amount: 50, merchant: 'PAYBOX' });
const t2 = insertTx({ date: '2018-03-02', amount: 60, merchant: 'paybox' });      // רישיות שונה
const t3 = insertTx({ date: '2018-03-03', amount: 70, merchant: '  PAYBOX  ' });  // רווחים
const t4 = insertTx({ date: '2018-03-04', amount: 80, merchant: 'PAYBOX', type: 'income' }); // סוג אחר
const tOther = insertTx({ date: '2018-03-05', amount: 90, merchant: 'MOJO' });

// ---------- שיוך בודד ----------
const single = assignCategory(t1, catA.id);
check('שיוך בודד: העסקה עודכנה', getTransaction(t1).category_id === catA.id, String(getTransaction(t1).category_id));
check('שיוך בודד: updated = 1', single.updated === 1, String(single.updated));
check('שיוך בודד: לא נגע בעסקה אחרת של אותו בית עסק', getTransaction(t2).category_id === null);
check('שיוך בודד: מחזיר את שם בית העסק', single.merchant === 'PAYBOX', single.merchant);

check('שיוך חוזר לאותה קטגוריה: updated = 0', assignCategory(t1, catA.id).updated === 0);

// ---------- merchantPeers ----------
const peers = merchantPeers(getTransaction(t1), catA.id);
check('peers: סופר עסקאות אחרות של אותו בית עסק (TRIM + רישיות)', peers.total === 2, `total=${peers.total}`);
check('peers: differing = כמה עדיין לא בקטגוריה', peers.differing === 2, `differing=${peers.differing}`);
check('peers: לא כולל סוג אחר (income)', peers.total === 2 && getTransaction(t4).category_id === null);

// ---------- שיוך גורף ----------
const all = assignCategory(t1, catA.id, { applyAll: true });
check('גורף: עדכן את שאר העסקאות של אותו בית עסק', all.updated === 2, `updated=${all.updated}`);
check('גורף: רישיות שונה נכללה', getTransaction(t2).category_id === catA.id);
check('גורף: רווחים מסביב לשם נכללו', getTransaction(t3).category_id === catA.id);
check('גורף: עסקת income של אותו שם לא נגעה', getTransaction(t4).category_id === null);
check('גורף: בית עסק אחר לא נגע', getTransaction(tOther).category_id === null);
check('גורף חוזר: updated = 0 (אין מה לעדכן)', assignCategory(t1, catA.id, { applyAll: true }).updated === 0);
check('peers אחרי גורף: differing = 0', merchantPeers(getTransaction(t1), catA.id).differing === 0);

// אחרי שיוך גורף — עסקה עתידית של אותו בית עסק תיקלט לקטגוריה הזו. נבדק ישירות
// מול historyMatch ולא מול suggestCategory, שמריצה קודם חוקים (מערכים אחרים
// עלולים להשאיר חוקים ב-DB המשותף של ריצת הבדיקות).
const suggestion = historyMatch('PAYBOX');
check('אחרי שיוך גורף: עסקה עתידית של אותו בית עסק תסווג לקטגוריה', suggestion?.category_id === catA.id,
  JSON.stringify(suggestion));

// ---------- שיוך ל"ללא קטגוריה" ----------
assignCategory(t1, catB.id);
const clearAll = assignCategory(t1, 0, { applyAll: true });
check('גורף ל-0 (ללא קטגוריה): מנקה את כולן', clearAll.updated === 3, `updated=${clearAll.updated}`);
check('ניקוי גורף: category_id = null', getTransaction(t2).category_id === null && getTransaction(t3).category_id === null);

// ---------- שם בית עסק ריק ----------
const tEmpty1 = insertTx({ date: '2018-04-01', amount: 10, merchant: '' });
const tEmpty2 = insertTx({ date: '2018-04-02', amount: 20, merchant: '   ' });
const emptyRes = assignCategory(tEmpty1, catA.id, { applyAll: true });
check('שם ריק: גורף מתנהג כשיוך בודד', emptyRes.updated === 1, `updated=${emptyRes.updated}`);
check('שם ריק: לא גרר עסקה אחרת חסרת שם', getTransaction(tEmpty2).category_id === null);
check('שם ריק: peers ריק', merchantPeers(getTransaction(tEmpty1), catA.id).total === 0);

// ---------- שגיאות ----------
let threw = null;
try { assignCategory(999999, catA.id); } catch (err) { threw = err.message; }
check('עסקה לא קיימת → זורק', threw === 'עסקה לא נמצאה', String(threw));
threw = null;
try { assignCategory(t1, 999999); } catch (err) { threw = err.message; }
check('קטגוריה לא קיימת → זורק', threw === 'category_id לא קיים', String(threw));

// ---------- API ----------
const J = { 'Content-Type': 'application/json', Connection: 'close' };
const a1 = insertTx({ date: '2018-05-01', amount: 11, merchant: 'TEN BIS' });
const a2 = insertTx({ date: '2018-05-02', amount: 12, merchant: 'TEN BIS' });
const a3 = insertTx({ date: '2018-05-03', amount: 13, merchant: 'TEN BIS' });

const putSingle = await (await fetch(`${BASE}/api/transactions/${a1}/category`, {
  method: 'PUT', headers: J, body: JSON.stringify({ category_id: catB.id }),
})).json();
check('API: PUT /category משייך עסקה בודדת', putSingle.category_id === catB.id && putSingle.updated === 1,
  JSON.stringify({ c: putSingle.category_id, u: putSingle.updated }));

const peersApi = await (await fetch(`${BASE}/api/transactions/${a1}/merchant-peers?category_id=${catB.id}`, {
  headers: J,
})).json();
check('API: merchant-peers מחזיר את המניין', peersApi.differing === 2 && peersApi.merchant === 'TEN BIS',
  JSON.stringify(peersApi));

const putAll = await (await fetch(`${BASE}/api/transactions/${a1}/category`, {
  method: 'PUT', headers: J, body: JSON.stringify({ category_id: catB.id, apply_all: true }),
})).json();
check('API: apply_all משייך את כל העסקאות של בית העסק', putAll.updated === 2, JSON.stringify(putAll));
check('API: אחרי apply_all כל השורות עודכנו',
  getTransaction(a2).category_id === catB.id && getTransaction(a3).category_id === catB.id);

const bad404 = await fetch(`${BASE}/api/transactions/999999/category`, {
  method: 'PUT', headers: J, body: JSON.stringify({ category_id: catB.id }),
});
check('API: עסקה לא קיימת → 404', bad404.status === 404, `status=${bad404.status}`);

const bad400 = await fetch(`${BASE}/api/transactions/${a1}/category`, {
  method: 'PUT', headers: J, body: JSON.stringify({ category_id: 999999 }),
});
check('API: category_id לא קיים → 400', bad400.status === 400, `status=${bad400.status}`);

// ---------- תצוגת הבוט ----------
// (הייבוא בסוף — bot.js לא מפעיל את הבוט בלי טוקן, כמו ב-sec_bot.mjs)
const { txApplyAllView } = await import('../server/bot.js');
const view = txApplyAllView(a1, catB.id, { merchant: 'TEN BIS', total: 2, differing: 2 }, catB);
check('בוט: התצוגה מזכירה את בית העסק', view.text.includes('TEN BIS'), view.text);
check('בוט: התצוגה מזכירה את מספר העסקאות', view.text.includes('2'));
check('בוט: התצוגה מזכירה את שם הקטגוריה', view.text.includes(catB.name));
check('בוט: כוכביות Markdown מאוזנות (לא שוברות את הפרסר של טלגרם)',
  (view.text.match(/(?<!\\)\*/g) || []).length % 2 === 0);
const cbData = view.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
check('בוט: כפתור "כן" נושא tx:catall עם ה-id והקטגוריה',
  cbData.includes(`tx:catall:${a1}:${catB.id}`), cbData.join(' | '));
check('בוט: כפתור "לא" חוזר לפירוט העסקה', cbData.includes(`tx:view:${a1}`), cbData.join(' | '));
check('בוט: callback_data מתחת ל-64 בייט (מגבלת טלגרם)',
  cbData.every((d) => Buffer.byteLength(d) <= 64), cbData.join(' | '));

const viewNone = txApplyAllView(a1, 0, { merchant: 'TEN BIS', total: 2, differing: 2 }, null);
check('בוט: "ללא קטגוריה" מוצג נכון', viewNone.text.includes('ללא קטגוריה'), viewNone.text);

// ---------- מחיקת קטגוריה בבוט דורשת אישור (רגרסיה — אירוע 15.08) ----------
const { categoryDeleteConfirmView } = await import('../server/bot.js');
const delView = categoryDeleteConfirmView(catB.id, '2026-08');
const delCb = delView.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
check('בוט: מסך אישור מחיקת קטגוריה נושא cat:del רק אחרי אישור',
  delCb.includes(`cat:del:${catB.id}`), delCb.join(' | '));
check('בוט: יש כפתור ביטול שחוזר לקטגוריה',
  delCb.some((d) => d.startsWith(`cat:view:${catB.id}`)), delCb.join(' | '));
check('בוט: מסך האישור מציין כמה עסקאות יושפעו', /\d+ עסקאות|אין עסקאות/.test(delView.text), delView.text);
check('בוט: קטגוריה לא קיימת → הודעה במקום קריסה',
  categoryDeleteConfirmView(999999).text.includes('כבר נמחקה'));

// ---------- מחיקת עסקה בבוט דורשת אישור ----------
const { txDeleteConfirmView } = await import('../server/bot.js');
const txDel = txDeleteConfirmView(a2);
const txDelRows = txDel.keyboard.inline_keyboard;
const txDelCb = txDelRows.flat().map((b) => b.callback_data);
check('בוט: מסך אישור מחיקת עסקה נושא tx:del רק אחרי אישור',
  txDelCb.includes(`tx:del:${a2}`), txDelCb.join(' | '));
check('בוט: יש כפתור ביטול שחוזר לעסקה', txDelCb.includes(`tx:view:${a2}`), txDelCb.join(' | '));
check('בוט: מסך האישור מציג את פרטי העסקה', txDel.text.includes('TEN BIS'), txDel.text);
// הגנה מפני double-tap: ב-txDetailView ה-🗑 יושב בשורה 0 עמודה 0, ולכן
// באישור חייב לשבת שם הביטול. אם מישהו יהפוך את הסדר — הבדיקה תיפול.
check('בוט: הכפתור ההרסני אינו במיקום שבו נלחץ 🗑 (שורה 0, עמודה 0)',
  txDelRows[0][0].callback_data === `tx:view:${a2}`, txDelRows[0][0].callback_data);
check('בוט: כוכביות Markdown מאוזנות במסך האישור',
  (txDel.text.match(/(?<!\\)\*/g) || []).length % 2 === 0);
check('בוט: עסקה לא קיימת → הודעה במקום קריסה',
  txDeleteConfirmView(999999).text.includes('כבר נמחקה'));

// אותה הגנה בקטגוריה: ה-🗑 ב-categoryDetailView יושב בשורה 1
check('בוט: אישור מחיקת קטגוריה — הביטול במיקום ה-🗑 (שורה 1)',
  delView.keyboard.inline_keyboard[1][0].callback_data.startsWith(`cat:view:${catB.id}`),
  delView.keyboard.inline_keyboard[1][0].callback_data);

// ניקוי — רק השורות שהמערך הזה יצר (בלי טווח תאריכים, שלא לפגוע במערך אחר)
const created = [t1, t2, t3, t4, tOther, tEmpty1, tEmpty2, a1, a2, a3];
const del = db.prepare('DELETE FROM transactions WHERE id = ?');
for (const id of created) del.run(id);

console.log(`\n========== category-assign: ${pass}/${pass + fail} ==========`);
process.exitCode = fail === 0 ? 0 : 1;
