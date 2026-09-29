import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../public-source.json', import.meta.url), 'utf8'));
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
const expected = [...Object.keys(manifest.files), 'public-source.json'].sort();
if (manifest.version !== 1 || JSON.stringify(tracked) !== JSON.stringify(expected)) {
  throw new Error('Tracked source differs from the reviewed file list');
}
const notices = new Set(['LICENSE', 'licenses/tabler-core-LICENSE', 'licenses/tabler-icons-LICENSE', 'licenses/bootstrap-LICENSE']);
const restricted = [
  /\/(?:Users|home)\/[^/\s]+\//u,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{20}/u,
  /\b(?:ghp_|github_pat_|AKIA|LTAI)[A-Za-z0-9_]{16,}\b/u,
];
for (const [name, digest] of Object.entries(manifest.files)) {
  if (name.startsWith('/') || name.split('/').includes('..') || /(?:^|\/)(?:\.env(?:\..*)?|node_modules|dist|\.local-data|\.data)(?:\/|$)/u.test(name)) {
    throw new Error('Unexpected source path');
  }
  const file = new URL(`../${name}`, import.meta.url);
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('Source must be a regular file');
  const body = readFileSync(file);
  if (createHash('sha256').update(body).digest('hex') !== digest) throw new Error(`Source review changed: ${name}`);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  if (text.includes('\0')) throw new Error('Binary source is not permitted');
  if (!notices.has(name) && restricted.some((pattern) => pattern.test(text))) {
    throw new Error(`Potential private content: ${name}`);
  }
}
console.log(`Source verification passed: ${expected.length} reviewed files.`);
