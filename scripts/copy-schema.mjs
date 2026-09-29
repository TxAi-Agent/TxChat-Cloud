import { cpSync, mkdirSync } from 'node:fs';
mkdirSync(new URL('../dist/bootstrap/', import.meta.url), { recursive: true });
for (const name of ['core.sql', 'content.sql']) {
  cpSync(new URL(`../src/bootstrap/${name}`, import.meta.url), new URL(`../dist/bootstrap/${name}`, import.meta.url));
}
