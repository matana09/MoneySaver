import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { root } from './publicationPolicy.mjs';

const local = path.join(root, 'tmp', 'tools', process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks');
const binary = process.env.GITLEAKS_BIN || (existsSync(local) ? local : 'gitleaks');
const args = process.argv.includes('--files') ? ['dir', '--redact', '--no-banner', '.'] : ['git', '--redact', '--no-banner', '--log-opts=--all', '.'];
const result = spawnSync(binary, args, { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) console.error('Gitleaks is required. Install it from the official release, or set GITLEAKS_BIN to its absolute path. Push remains blocked.');
process.exitCode = result.status ?? 1;
