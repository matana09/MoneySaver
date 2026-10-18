// Local-only comparison against a read-only private DB. Findings never include matched values.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const containsNumber = (text, value) => {
  const forms = [String(value), Number(value).toLocaleString('en-US'), Number(value).toFixed(2),
    Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })];
  return forms.some((form) => new RegExp(`(?<![\\d.])${escape(form)}(?![\\d.])`).test(text));
};

export function inspectPrivateValues(entries, { settings = [], income = [], mortgage = [] } = {}) {
  const findings = [];
  for (const { file, bytes } of entries) {
    if (bytes.includes(0) || /\.(png|jpg|pdf)$/.test(file)) continue;
    const text = bytes.toString('utf8');
    for (const { key, value } of settings) {
      if (value && value.length >= 5 && new RegExp(`(?<![A-Za-z0-9])${escape(value)}(?![A-Za-z0-9])`).test(text)) {
        findings.push({ file, kind: 'private-setting', field: key });
      }
    }
    for (const { name, amount } of income) {
      if (!name || name.length < 4 || amount <= 0) continue;
      let at = text.indexOf(name);
      while (at >= 0) {
        if (containsNumber(text.slice(Math.max(0, at - 90), at + name.length + 90), amount)) {
          findings.push({ file, kind: 'private-income-example' }); break;
        }
        at = text.indexOf(name, at + name.length);
      }
    }
    for (const { field, value } of mortgage) {
      if (typeof value !== 'number' || value < 50 || Number.isInteger(value)) continue;
      const [whole, cents] = value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).split('.');
      if (containsNumber(text, value) || new RegExp(`(?<!\\d)${cents}\\s*\\.\\s*${escape(whole)}(?!\\d)`).test(text)) {
        findings.push({ file, kind: 'private-mortgage-figure', field });
      }
    }
  }
  return [...new Map(findings.map((f) => [JSON.stringify(f), f])).values()];
}

export function checkPrivateDatabase(entries, databasePath) {
  if (!existsSync(databasePath)) return { checked: false, findings: [] };
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    const settings = tables.has('settings') ? db.prepare("SELECT key,value FROM settings WHERE key IN ('telegram_token','gemini_api_key','telegram_chat_id','telegram_chat_id_2')").all() : [];
    const income = tables.has('income') ? db.prepare('SELECT name,amount FROM income').all() : [];
    const mortgage = [];
    if (tables.has('mortgage_history')) {
      for (const row of db.prepare('SELECT paid_principal,paid_cpi_principal,paid_interest,paid_cpi_interest,paid_other,paid_total,bal_principal,bal_cpi,bal_accrued,bal_total FROM mortgage_history').all()) {
        for (const [field, value] of Object.entries(row)) mortgage.push({ field, value });
      }
    }
    return { checked: true, findings: inspectPrivateValues(entries, { settings, income, mortgage }) };
  } finally { db.close(); }
}
