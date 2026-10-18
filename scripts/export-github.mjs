import { execFileSync } from 'node:child_process';
import { readdirSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { allowedFile, approvedAssets, inspectFile, root } from './publicationPolicy.mjs';
import { checkPrivateDatabase } from './private-data-check.mjs';

const outputName = process.argv[2] || 'github-ready';
if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(outputName)) throw new Error('Export name must be a simple lowercase folder name.');
const destination = path.join(root, 'output', outputName);
if (existsSync(destination)) throw new Error(`output/${outputName} already exists. Existing exports are never overwritten.`);
const assets = approvedAssets();
const files = [];
function visit(directory, prefix = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symlink refused: ${file}`);
    if (entry.isDirectory()) {
      if (!prefix && !['server', 'public', 'ml', 'scripts', 'tests', 'deploy', '.github', '.githooks'].includes(entry.name)) continue;
      if (['.tmp', '__pycache__', 'node_modules', 'data', 'backups', 'logs', 'tmp', 'output'].includes(entry.name)) continue;
      visit(path.join(directory, entry.name), file + '/');
    } else if (allowedFile(file)) {
      const bytes = readFileSync(path.join(root, file));
      const errors = inspectFile(file, bytes, assets);
      if (errors.length) throw new Error(`${file}: ${errors.join(', ')}`);
      files.push({ file, bytes });
    } else if (prefix && !/^scripts\/moneysaver-.*-task\.xml$/.test(file)) {
      throw new Error(`Unreviewed source file: ${file}`);
    }
  }
}
visit(root);
const privacy = checkPrivateDatabase(files, process.env.MONEYSAVER_PRIVATE_DB || path.join(root, 'data', 'moneysaver.db'));
if (privacy.findings.length) {
  throw new Error('Private data matches block export: ' + privacy.findings.map((f) => `${f.file} (${f.kind})`).join(', '));
}
console.log(privacy.checked ? 'Local private-data comparison passed (read-only DB).' : 'No local private DB available; human privacy review is still required.');
mkdirSync(destination, { recursive: true });
for (const { file, bytes } of files) {
  const target = path.join(destination, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}
const git = (...args) => execFileSync('git', args, { cwd: destination, stdio: 'inherit' });
git('init', '-b', 'main');
git('config', 'user.name', 'MoneySaver');
git('config', 'user.email', 'moneysaver@users.noreply.github.com');
git('config', 'core.hooksPath', '.githooks');
git('add', '--', '.'); // היעד נוצר כעת ורק הקבצים שאושרו נכתבו אליו.
git('update-index', '--chmod=+x', '.githooks/pre-commit', '.githooks/pre-push');
execFileSync(process.execPath, ['scripts/check-publication.mjs', '--staged'], { cwd: destination, stdio: 'inherit' });
git('commit', '-m', 'Initial sanitized source release');
execFileSync(process.execPath, ['scripts/check-publication.mjs', '--history'], { cwd: destination, stdio: 'inherit' });
console.log(`Created ${files.length} approved files with fresh Git history in output/${outputName}. No remote was configured or contacted.`);
