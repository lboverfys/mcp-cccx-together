import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const codexConfigPath = (env, home) => path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');

/**
 * 在 `codex mcp add` 写出的 [mcp_servers.<name>] 表中设置 tool_timeout_sec，并补充 env_vars 转发。
 * 只做行级编辑，不重排用户的其他配置；找不到该表时抛错，由调用方回退。
 */
export function updateCodexServer(file, name, { toolTimeoutSec, envVars = [] }) {
  const text = readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const header = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:"${name}"|'${name}'|${name})\\s*\\]\\s*(?:#.*)?$`);
  const start = lines.findIndex(line => header.test(line));
  if (start < 0) throw new Error(`${file} 中未找到 [mcp_servers.${name}]`);
  let end = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  if (end < 0) end = lines.length;
  const keyLine = key => {
    const index = lines.slice(start + 1, end).findIndex(line => new RegExp(`^\\s*${key}\\s*=`).test(line));
    return index < 0 ? -1 : start + 1 + index;
  };
  const inserted = [];
  const timeout = keyLine('tool_timeout_sec');
  if (timeout >= 0) lines[timeout] = `tool_timeout_sec = ${toolTimeoutSec}`;
  else inserted.push(`tool_timeout_sec = ${toolTimeoutSec}`);
  let forwarded = [];
  let unmanagedEnvVars = false;
  if (envVars.length) {
    const existing = keyLine('env_vars');
    if (existing < 0) {
      forwarded = [...envVars];
      inserted.push(`env_vars = [${forwarded.map(item => JSON.stringify(item)).join(', ')}]`);
    } else if (/\[.*\]/.test(lines[existing])) {
      const current = [...lines[existing].matchAll(/"([^"]+)"|'([^']+)'/g)].map(match => match[1] ?? match[2]);
      forwarded = [...new Set([...current, ...envVars])];
      lines[existing] = `env_vars = [${forwarded.map(item => JSON.stringify(item)).join(', ')}]`;
    } else unmanagedEnvVars = true; // 多行数组不自动改写，提示用户手动补充。
  }
  lines.splice(start + 1, 0, ...inserted);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    // 保留原文件权限：配置里可能有凭据。
    writeFileSync(temporary, lines.join(eol), { flag: 'wx', mode: statSync(file).mode & 0o777 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
  return { file, toolTimeoutSec, forwarded, unmanagedEnvVars };
}

/**
 * 读取 Codex 配置中本服务的等待设置：tool_timeout_sec 与 env 中的 CC_TEAM_WAIT_TIMEOUT_MS。
 * 只做行级解析；找不到配置文件或服务表时 found 为 false。
 */
export function inspectCodexServer(file, name) {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { file, found: false }; throw error; }
  const table = suffix => new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:"${name}"|'${name}'|${name})${suffix}\\s*\\]\\s*(?:#.*)?$`);
  let section;
  let found = false;
  const result = { file };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      section = table('').test(line) ? 'server' : table('\\s*\\.\\s*env').test(line) ? 'env' : undefined;
      if (section === 'server') found = true;
      continue;
    }
    const timeout = section === 'server' && line.match(/^\s*tool_timeout_sec\s*=\s*([\d.]+)/);
    if (timeout) result.toolTimeoutSec = Number(timeout[1]);
    const wait = (section === 'env' && line.match(/^\s*CC_TEAM_WAIT_TIMEOUT_MS\s*=\s*["']?(\d+)/))
      || (section === 'server' && line.match(/CC_TEAM_WAIT_TIMEOUT_MS\s*=\s*["']?(\d+)/));
    if (wait) result.waitTimeoutMs = Number(wait[1]);
  }
  return { ...result, found };
}
