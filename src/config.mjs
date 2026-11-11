import { readFileSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(path = resolve(projectRoot, 'team.config.json')) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  for (const key of ['claudeExecutable', 'codexExecutable', 'stateDir', 'tempDir']) {
    if (typeof config[key] !== 'string' || !isAbsolute(config[key])) {
      throw new Error(`配置 ${key} 必须是绝对路径`);
    }
  }
  for (const key of ['claudeExecutable', 'codexExecutable']) {
    if (!statSync(config[key]).isFile()) throw new Error(`${key} 不是可执行入口文件`);
  }
  mkdirSync(config.stateDir, { recursive: true });
  mkdirSync(config.tempDir, { recursive: true });
  config.stateDir = realpathSync(config.stateDir);
  config.tempDir = realpathSync(config.tempDir);
  return config;
}
