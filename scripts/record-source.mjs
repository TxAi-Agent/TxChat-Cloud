import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const names = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(name => name && name !== 'public-source.json').sort();
const files = {};
for (const name of names) {
  const file = new URL(`../${name}`, import.meta.url);
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('Only regular files may be reviewed');
  files[name] = createHash('sha256').update(readFileSync(file)).digest('hex');
}
writeFileSync(new URL('../public-source.json', import.meta.url), JSON.stringify({ version: 1, files }, null, 2) + '\n');
console.log('Updated source inventory. Run verification and review all changes before sharing.');
