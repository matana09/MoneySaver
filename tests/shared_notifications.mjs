// בדיקות מול Telegram מדומה בלבד ו-DB הבדיקות של npm test.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import express from 'express';
import * as grammy from 'grammy';
import { db, getSetting, setSetting } from '../server/db.js';
import { deliverNotification } from '../server/lib/sharedNotifications.js';

assert.ok(process.env.MONEYSAVER_DATA_DIR?.includes('.tmp'), 'temporary DB required');
const sent = [], replies = [], handlers = new Map();
let failRecipient = null;
// מחליפים ישירות את פעולות הרשת של הספרייה המותקנת; ללא getMe/getUpdates.
mock.method(grammy.Bot.prototype, 'init', async function () {
  this.botInfo = { username: 'test_bot' };
});
mock.method(grammy.Bot.prototype, 'start', () => {});
mock.method(grammy.Bot.prototype, 'stop', async () => {});
mock.method(grammy.Bot.prototype, 'on', function (event, handler) {
  handlers.set(event, handler);
  return this;
});
mock.method(grammy.Api.prototype, 'deleteMyCommands', async () => {});
mock.method(grammy.Api.prototype, 'sendMessage', async (id, text, opts) => {
  if (String(id) === failRecipient) throw new Error('blocked test recipient');
  sent.push({ id: String(id), text, opts });
});
const bot = await import('../server/bot.js');
const { default: incomeRouter } = await import('../server/routes/income.js');
const { default: importRouter } = await import('../server/routes/import.js');
const { default: transactionsRouter } = await import('../server/routes/transactions.js');

const keys = ['telegram_token', 'telegram_chat_id', 'telegram_chat_id_2'];
const old = keys.map((key) => getSetting(key, ''));
keys.forEach((key, i) => setSetting(key, ['fake', '111', '222'][i]));
await bot.startBot();
assert.equal(bot.botStatus().active, true);
const app = express();
app.use(express.json());
app.use('/api/income', incomeRouter);
app.use('/api/import', importRouter);
app.use('/api/transactions', transactionsRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let checks = 0;
function expectRecipients(ids) {
  assert.deepEqual(sent.map((s) => s.id).sort(), ids.sort());
  checks++;
}
async function request(method, path, body) {
  sent.length = 0;
  const res = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { status: res.status, data: await res.json() };
}
function ctx(id, text, data) {
  return {
    chat: { id }, from: { id },
    message: { text }, callbackQuery: { data },
    reply: async (text) => { replies.push({ id: String(id), text }); },
    editMessageText: async (text) => { replies.push({ id: String(id), text }); },
    answerCallbackQuery: async () => {},
  };
}
async function callback(id, data) {
  sent.length = 0;
  await handlers.get('callback_query:data')(ctx(id, '', data));
}
try {
  // הבאג המקורי: זרימת הכנסות בבוט, תאריך לפני סכום.
  await callback(111, 'inc:add');
  sent.length = 0; replies.length = 0;
  await handlers.get('message:text')(ctx(111, 'משכורת לדוגמה 12.3.24 13500'));
  expectRecipients(['222']);
  assert.ok(replies.some((r) => r.id === '111' && r.text.includes('13,500')));
  assert.ok(sent[0].text.includes('משכורת לדוגמה') && sent[0].text.includes('2024-03-12'));
  const salary = db.prepare('SELECT * FROM income WHERE name = ? AND amount = ? AND date = ?')
    .get('משכורת לדוגמה', 13500, '2024-03-12');
  assert.ok(salary);
  checks++;

  // הכיוון ההפוך: משתמש נוסף מוסיף הכנסה ושאר המשתמשים מקבלים התראה.
  await callback(222, 'inc:add');
  sent.length = 0;
  await handlers.get('message:text')(ctx(222, 'מתנה 500 10/10/26'));
  expectRecipients(['111']);
  await callback(111, `inc:editamt:${salary.id}`);
  sent.length = 0;
  await handlers.get('message:text')(ctx(111, '17000'));
  expectRecipients(['222']);
  assert.ok(sent[0].text.includes('17,000'));
  await callback(111, `inc:tgl:${salary.id}`);
  expectRecipients(['222']);
  assert.ok(sent[0].text.includes('מושבתת'));
  await callback(111, `inc:del:${salary.id}`);
  expectRecipients(['222']);
  assert.ok(sent[0].text.includes('נמחקה'));

  const created = await request('POST', '/api/income', { name: 'Web income', amount: 100, date: '2024-03-12' });
  assert.equal(created.status, 201);
  expectRecipients(['111', '222']);
  await request('PUT', `/api/income/${created.data.id}`, { amount: 200 });
  expectRecipients(['111', '222']);
  await request('PUT', `/api/income/${created.data.id}`, { amount: 200 });
  expectRecipients([]);
  await request('DELETE', `/api/income/${created.data.id}`);
  expectRecipients(['111', '222']);
  assert.equal((await request('POST', '/api/income', { name: 'Invalid', amount: -1 })).status, 400);
  expectRecipients([]);
  await request('DELETE', '/api/income/999999');
  expectRecipients([]);

  const rows = [{ date: '2024-03-12', merchant: 'Import test', amount: 123, type: 'expense',
    external_id: 'shared-notify-test', duplicate: false }];
  await request('POST', '/api/import/commit', { source: 'csv', rows });
  expectRecipients(['111', '222']);
  await request('POST', '/api/import/commit', { source: 'csv', rows });
  expectRecipients([]);
  // אותו דוח עם תוכנית תשלומים: שינוי אמיתי מודיע פעם אחת; חמש חזרות שקטות.
  const planId = Number(db.prepare(`INSERT INTO transactions
    (date, merchant, amount, type, description, source)
    VALUES (?, ?, ?, ?, ?, ?)`).run('2024-03-12', 'Import installment test', 75,
    'expense', 'תשלום 1/12', 'pdf').lastInsertRowid);
  const installmentRows = [...rows, { installment_update: { id: planId, description: 'תשלום 2/12' } }];
  const changedImport = await request('POST', '/api/import/commit', { source: 'csv', rows: installmentRows });
  assert.deepEqual(changedImport.data, { inserted: 0, skippedDup: 1, updated: 1 });
  expectRecipients(['111', '222']);
  for (let i = 0; i < 5; i++) {
    const repeatedImport = await request('POST', '/api/import/commit', { source: 'csv', rows: installmentRows });
    assert.deepEqual(repeatedImport.data, { inserted: 0, skippedDup: 1, updated: 0 });
    expectRecipients([]);
  }
  assert.equal(db.prepare('SELECT description FROM transactions WHERE id = ?').get(planId).description, 'תשלום 2/12');
  await bot.notifyImportCommitted({ inserted: 0, updated: 1, skippedDup: 0 }, { excludeChatId: 222 });
  expectRecipients(['111']);

  const tx = await request('POST', '/api/transactions', { date: '2024-03-12', merchant: 'Notify expense', amount: 50 });
  assert.equal(tx.status, 201);
  expectRecipients(['111', '222']);
  await request('PUT', `/api/transactions/${tx.data.id}`, { amount: 55 });
  expectRecipients(['111', '222']);
  await request('DELETE', `/api/transactions/${tx.data.id}`);
  expectRecipients(['111', '222']);
  await callback(222, 'noop');
  sent.length = 0;
  await handlers.get('message:text')(ctx(222, 'קפה 25'));
  expectRecipients(['111']);

  sent.length = 0; failRecipient = '111';
  assert.equal(await bot.notifyIncomeChanged({ name: 'Delivery test', amount: 1 }), true);
  expectRecipients(['222']);
  sent.length = 0; failRecipient = null;
  const keyboard = [[{ text: 'Undo', callback_data: 'inc:del:1' }]];
  await bot.notifyAllUsers('Recurring/reminder test', keyboard);
  expectRecipients(['111', '222']);
  assert.deepEqual(sent[0].opts.reply_markup.inline_keyboard, keyboard);
  sent.length = 0;
  await deliverNotification(async (id) => sent.push({ id }), ['111', 111, '222'], 'test', {}, { excludeChatId: 222 });
  expectRecipients(['111']);
  assert.equal(await deliverNotification(async () => { throw new Error('unavailable'); }, ['111', '222'], 'test'), false);
  checks++;
  console.log(`Shared notifications: ${checks} checks passed (no live Telegram calls).`);
} finally {
  keys.forEach((key, i) => setSetting(key, old[i]));
  await bot.restartBot().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  mock.restoreAll();
}
