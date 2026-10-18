import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { allowedFile, inspectFile, approvedAssets, root } from '../scripts/publicationPolicy.mjs';
import { inspectPrivateValues } from '../scripts/private-data-check.mjs';

for (const file of ['data/moneysaver.db', 'backups/copy.db', '.env', '.env.local', 'HANDOFF.md',
  'CLAUDE.md', 'AGENTS.md', 'PRD_MoneySaver.docx', '.codex-remote-attachments/file.png', 'tmp/debug.log',
  'output/reconciliation/report.md', 'scripts/moneysaver-backup-task.xml', 'tests/.tmp/data/db.json',
  'server/../../private.txt', 'server\\file.js', 'tests/fixtures/private.docx']) assert.equal(allowedFile(file), false, file);
assert(allowedFile('.env.example'));
assert(allowedFile('server/lib/webAccess.js'));
const token = '123456789:' + 'a'.repeat(35);
assert(inspectFile('server/example.js', Buffer.from(token)).includes('Telegram credential'));
assert(inspectFile('README.md', Buffer.from('someone' + '@' + 'private.test')).includes('non-example email address'));
assert.deepEqual(inspectFile('README.md', Buffer.from('team@example.com')), []);
assert(inspectFile('tests/example.mjs', Buffer.from('משכורת ' + 'אדם' + ' 12.3.24 13500')).includes('named salary example'));
assert.deepEqual(inspectFile('tests/example.mjs', Buffer.from('משכורת לדוגמה 12.3.24 13500')), []);
assert(inspectFile('tests/fixtures/new.png', Buffer.from('not-approved')).length > 0);
const privateInputs = { settings: [{ key: 'telegram_chat_id', value: '900000123' }],
  income: [{ name: 'Salary fixture person', amount: 13579.31 }], mortgage: [{ field: 'paid_interest', value: 12345.67 }] };
const privacyFindings = inspectPrivateValues([
  { file: 'tests/example.mjs', bytes: Buffer.from('owner=900000123; Salary fixture person 13579.31; 67 . 12,345') },
], privateInputs);
assert.deepEqual(new Set(privacyFindings.map((f) => f.kind)), new Set(['private-setting', 'private-income-example', 'private-mortgage-figure']));
assert(!JSON.stringify(privacyFindings).includes('900000123') && !JSON.stringify(privacyFindings).includes('13579.31'));
assert.deepEqual(inspectPrivateValues([{ file: 'tests/example.mjs', bytes: Buffer.from('Invented fixture only') }], privateInputs), []);
const assets = approvedAssets();
assert.equal(Object.keys(assets).length, 5);
for (const [file] of Object.entries(assets)) {
  const bytes = readFileSync(path.join(root, file));
  assert.deepEqual(inspectFile(file, bytes, assets), [], file);
  assert(inspectFile(file, Buffer.concat([bytes, Buffer.from('changed')]), assets).length > 0, file);
}
console.log('Publication policy passed: private paths, staged secret detection, and binary integrity.');
