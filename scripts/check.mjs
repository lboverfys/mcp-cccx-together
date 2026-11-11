import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
for (const dir of ['src', 'scripts', 'test']) {
  for (const file of readdirSync(dir).filter(name => name.endsWith('.mjs'))) {
    const result = spawnSync(process.execPath, ['--check', `${dir}/${file}`], { stdio: 'inherit', windowsHide: true });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
