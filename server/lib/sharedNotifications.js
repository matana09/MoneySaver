// הודעות משותפות: אותה רשימת נמענים לכל סוג הכנסה, הוצאה וייבוא.
const fmtILS = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });

export function activityMessage(row, { income = false, action = 'added', count = 1 } = {}) {
  const label = income ? 'הכנסה' : 'עסקה';
  const verb = { added: 'חדשה', updated: 'עודכנה', deleted: 'נמחקה' }[action];
  return [
    `${income || row.type === 'income' ? '💵' : '💳'} ${label} ${verb}: ${row.name || row.merchant || '—'} — ${fmtILS.format(row.amount)}`,
    row.date ? `תאריך: ${row.date}` : null,
    row.charge_date ? `תאריך חיוב: ${row.charge_date}` : null,
    row.category_name ? `קטגוריה: ${row.category_name}` : null,
    income ? `מצב: ${row.active === 0 ? 'מושבתת' : 'פעילה'}${row.recurring ? ' · קבועה' : ''}` : null,
    count > 1 ? `עסקאות שהושפעו: ${count}` : null,
  ].filter(Boolean).join('\n');
}

export function importMessage(result) {
  if (!result.inserted && !result.updated) return null;
  return `📥 הייבוא נשמר: נוספו ${result.inserted} עסקאות` +
    (result.updated ? ` · עודכנו ${result.updated} תוכניות תשלומים` : '') +
    (result.skippedDup ? ` · דולגו ${result.skippedDup} כפילויות` : '');
}

// כשל אצל נמען אחד לא מונע שליחה לשני. הצלחה רק אם נשלח בפועל.
export async function deliverNotification(sendMessage, chatIds, text, opts = {}, { excludeChatId, onError = () => {} } = {}) {
  const recipients = [...new Set(chatIds.filter(Boolean).map(String))]
    .filter((id) => id !== String(excludeChatId ?? ''));
  let sent = false;
  for (const chatId of recipients) {
    try { await sendMessage(chatId, text, opts); sent = true; }
    catch (err) { onError(chatId, err); }
  }
  return sent;
}
