import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
const directories = ['src', 'scripts', 'test'];
for (const dir of directories) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) { directories.push(file); continue; }
    if (!entry.name.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
