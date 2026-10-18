import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootFiles = new Set(['.gitignore', '.gitattributes', '.env.example', '.gitleaks.toml', 'README.md', 'SECURITY.md',
  'package.json', 'package-lock.json', 'run-hidden.vbs']);
const extensions = new Set(['.js', '.mjs', '.py', '.json', '.html', '.css', '.md', '.txt', '.ps1', '.sh', '.yml', '.yaml', '.toml', '.xml', '.vbs']);
export function allowedFile(file) {
  if (file.includes('\\') || file.split('/').some((x) => !x || x === '..' || x === '.')) return false;
  if (rootFiles.has(file)) return true;
  if (file === 'deploy/Caddyfile.example') return true;
  if (/^\.githooks\/(?:pre-commit|pre-push)$/.test(file)) return true;
  if (!/^(?:server|public|ml|scripts|tests|deploy|\.github)\//.test(file)) return false;
  if (/(?:^|\/)(?:node_modules|data|backups|logs|tmp|output|\.tmp|__pycache__|\.env(?:\.[^/]*)?)(?:\/|$)/.test(file)) return false;
  if (/^scripts\/moneysaver-.*-task\.xml$/.test(file)) return false;
  if (/^tests\/fixtures\/.*\.(?:pdf|png|jpg)$/.test(file)) return true;
  return extensions.has(path.posix.extname(file));
}

const secretPatterns = [
  ['Telegram credential', /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/],
  ['Google credential', /\bAIza[A-Za-z0-9_-]{30,}\b/],
  ['GitHub credential', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['personal Windows path', /\b[A-Z]:[\\/]+Users[\\/]+[^\\/\s]+/i],
  ['Windows machine identity', /\bDESKTOP-[A-Z0-9]+\\[A-Za-z0-9]/i],
  ['named salary example', /משכורת\s+(?!לדוגמה|דוגמה|בדיקה|לבדיקה)[א-ת]{2,}\s+(?:\d{1,2}[./-]\d|\d{3,})/],
];
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function inspectFile(file, bytes, approvedAssets = {}) {
  if (!allowedFile(file)) return ['file is outside the publication allowlist'];
  if (/\.(?:png|jpg|pdf)$/.test(file)) {
    return approvedAssets[file] === sha256(bytes) ? [] : ['binary fixture is unreviewed or has changed'];
  }
  if (bytes.includes(0)) return ['unexpected binary file'];
  const text = bytes.toString('utf8');
  const errors = secretPatterns.filter(([, re]) => re.test(text)).map(([name]) => name);
  const emails = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g) || [];
  if (emails.some((email) => !/@(?:users\.noreply\.github\.com|(?:[A-Za-z0-9-]+\.)*example\.(?:com|org|net)|[^@]+\.invalid)$/i.test(email))) errors.push('non-example email address');
  return [...new Set(errors)];
}
export function approvedAssets(directory = root) {
  return JSON.parse(readFileSync(path.join(directory, 'tests/fixtures/approved-assets.json'), 'utf8'));
}
