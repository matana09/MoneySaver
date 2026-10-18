// הפלט מציג רק נתיב וסוג ממצא, לעולם לא את הסוד עצמו.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { approvedAssets, inspectFile, root } from './publicationPolicy.mjs';

const git = (args, opts = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...opts });
const assets = approvedAssets();
const errors = new Set();
const inspect = (file, bytes) => inspectFile(file, bytes, assets).forEach((reason) => errors.add(`${file}: ${reason}`));
if (process.argv.includes('--history')) {
  const entries = git(['rev-list', '--objects', '--all']).trim().split('\n').filter(Boolean).map((line) => {
    const i = line.indexOf(' ');
    return { hash: i < 0 ? line : line.slice(0, i), file: i < 0 ? '' : line.slice(i + 1) };
  });
  if (entries.length) {
    const bytes = git(['cat-file', '--batch'], { encoding: null, input: entries.map((e) => e.hash).join('\n') + '\n' });
    let cursor = 0;
    for (const entry of entries) {
      const end = bytes.indexOf(10, cursor);
      const [, type, size] = bytes.subarray(cursor, end).toString().split(' ');
      cursor = end + 1;
      const content = bytes.subarray(cursor, cursor + Number(size));
      cursor += Number(size) + 1;
      if (type === 'blob') inspect(entry.file, content);
    }
  }
  const identities = git(['log', '--all', '--format=%ae%n%ce']).trim().split('\n').filter(Boolean);
  if (identities.some((email) => !email.endsWith('@users.noreply.github.com'))) errors.add('Git history: personal author/committer email');
  const messages = git(['log', '--all', '--format=%B']);
  inspect('scripts/commit-messages.txt', Buffer.from(messages));
} else if (process.argv.includes('--staged')) {
  const files = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean);
  for (const file of files) inspect(file, git(['show', `:${file}`], { encoding: null }));
} else {
  const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
  for (const file of files) inspect(file, readFileSync(new URL(`../${file}`, import.meta.url)));
}
if (errors.size) {
  console.error('Publication blocked. Use npm run export:github for a clean copy; do not push private history.');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else console.log('Publication checks passed (allowlist, fixture hashes, targeted credentials and identity patterns).');
