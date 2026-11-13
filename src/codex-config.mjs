import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const codexConfigPath = (env, home) => path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 表头里的键允许空格和引号：[mcp_servers."cc_team".tools.team_wait]。
const tableHeader = parts => new RegExp(`^\\s*\\[\\s*${parts.map(part => `(?:"${escapeRegExp(part)}"|'${escapeRegExp(part)}'|${escapeRegExp(part)})`)
  .join('\\s*\\.\\s*')}\\s*\\]\\s*(?:#.*)?$`);
const dottedKey = parts => new RegExp(`^\\s*${parts.map(part => `["']?${escapeRegExp(part)}["']?`).join('\\s*\\.\\s*')}\\s*=`);
// 表头的键路径（不含引号）；不是普通表头时返回 undefined。
const tablePath = line => line.match(/^\s*\[\s*([^[\]]+?)\s*\]\s*(?:#.*)?$/)?.[1].split('.').map(part => part.trim().replace(/^["']|["']$/g, ''));
const arrayValues = line => [...line.matchAll(/"([^"]+)"|'([^']+)'/g)].map(match => match[1] ?? match[2]);

/**
 * 在 `codex mcp add` 写出的 [mcp_servers.<name>] 表中设置 tool_timeout_sec，补充 env_vars 转发，
 * 并可设置 omit_tools_from 包含 "deferred"（工具直接进初始工具列表，省掉一轮 tool_search）
 * 和各工具的 output_token_limit（等待类返回不被 Codex 截断）。
 * 只做行级编辑，不重排用户的其他配置；找不到该表时抛错，由调用方回退。返回值的 restore() 可写回原文件。
 */
export function updateCodexServer(file, name, { toolTimeoutSec, envVars = [], omitDeferred = false, outputTokenLimits = {} }) {
  const text = readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const header = tableHeader(['mcp_servers', name]);
  const start = lines.findIndex(line => header.test(line));
  if (start < 0) throw new Error(`${file} 中未找到 [mcp_servers.${name}]`);
  let end = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  if (end < 0) end = lines.length;
  const keyLine = pattern => {
    const index = lines.slice(start + 1, end).findIndex(line => pattern.test(line));
    return index < 0 ? -1 : start + 1 + index;
  };
  const inserted = [];
  const timeout = keyLine(dottedKey(['tool_timeout_sec']));
  if (timeout >= 0) lines[timeout] = `tool_timeout_sec = ${toolTimeoutSec}`;
  else inserted.push(`tool_timeout_sec = ${toolTimeoutSec}`);
  let forwarded = [];
  let unmanagedEnvVars = false;
  if (envVars.length) {
    const existing = keyLine(dottedKey(['env_vars']));
    if (existing < 0) {
      forwarded = [...envVars];
      inserted.push(`env_vars = [${forwarded.map(item => JSON.stringify(item)).join(', ')}]`);
    } else if (/\[.*\]/.test(lines[existing])) {
      forwarded = [...new Set([...arrayValues(lines[existing]), ...envVars])];
      lines[existing] = `env_vars = [${forwarded.map(item => JSON.stringify(item)).join(', ')}]`;
    } else unmanagedEnvVars = true; // 多行数组不自动改写，提示用户手动补充。
  }
  let omitToolsFrom;
  if (omitDeferred) {
    const existing = keyLine(dottedKey(['omit_tools_from']));
    if (existing < 0) { inserted.push('omit_tools_from = ["deferred"]'); omitToolsFrom = 'set'; }
    else if (/\[.*\]/.test(lines[existing])) {
      const values = arrayValues(lines[existing]);
      if (!values.includes('deferred')) lines[existing] = `omit_tools_from = [${[...values, 'deferred'].map(item => JSON.stringify(item)).join(', ')}]`;
      omitToolsFrom = 'set';
    } else omitToolsFrom = 'unmanaged';
  }
  let outputLimits;
  const tools = Object.entries(outputTokenLimits);
  if (tools.length) {
    // 用户已用表头或内联表写过 tools 时，再写点分键会重复定义表，交给用户手动处理。
    const toolTables = lines.some(line => {
      const path = tablePath(line);
      return path?.[0] === 'mcp_servers' && path[1] === name && path[2] === 'tools';
    });
    if (toolTables || keyLine(/^\s*["']?tools["']?\s*=/) >= 0) outputLimits = 'unmanaged';
    else {
      for (const [tool, limit] of tools) {
        const existing = keyLine(dottedKey(['tools', tool, 'output_token_limit']));
        if (existing >= 0) lines[existing] = `tools.${tool}.output_token_limit = ${limit}`;
        else inserted.push(`tools.${tool}.output_token_limit = ${limit}`);
      }
      outputLimits = 'set';
    }
  }
  lines.splice(start + 1, 0, ...inserted);
  const mode = statSync(file).mode & 0o777;
  const write = content => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      // 保留原文件权限：配置里可能有凭据。
      writeFileSync(temporary, content, { flag: 'wx', mode });
      renameSync(temporary, file);
    } finally { rmSync(temporary, { force: true }); }
  };
  write(lines.join(eol));
  return { file, toolTimeoutSec, forwarded, unmanagedEnvVars,
    ...(omitToolsFrom ? { omitToolsFrom } : {}), ...(outputLimits ? { outputLimits } : {}), restore: () => write(text) };
}

/**
 * 读取 Codex 配置中本服务的设置：tool_timeout_sec、env 中的 CC_TEAM_WAIT_TIMEOUT_MS 和 CC_TEAM_RESPONSE_BYTES、
 * omit_tools_from 以及各工具的 output_token_limit（点分键或 [mcp_servers.<name>.tools.<tool>] 表）。
 * 只做行级解析；找不到配置文件或服务表时 found 为 false。
 */
export function inspectCodexServer(file, name) {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { file, found: false }; throw error; }
  let section;
  let tool;
  let found = false;
  const result = { file, outputTokenLimits: {} };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      const path = tablePath(line);
      const own = path?.[0] === 'mcp_servers' && path[1] === name;
      section = !own ? undefined : path.length === 2 ? 'server' : path.length === 3 && path[2] === 'env' ? 'env'
        : path.length === 4 && path[2] === 'tools' ? 'tool' : undefined;
      tool = section === 'tool' ? path[3] : undefined;
      if (section === 'server') found = true;
      continue;
    }
    const timeout = section === 'server' && line.match(/^\s*tool_timeout_sec\s*=\s*([\d.]+)/);
    if (timeout) result.toolTimeoutSec = Number(timeout[1]);
    const wait = (section === 'env' && line.match(/^\s*CC_TEAM_WAIT_TIMEOUT_MS\s*=\s*["']?(\d+)/))
      || (section === 'server' && line.match(/CC_TEAM_WAIT_TIMEOUT_MS\s*=\s*["']?(\d+)/));
    if (wait) result.waitTimeoutMs = Number(wait[1]);
    const bytes = (section === 'env' && line.match(/^\s*CC_TEAM_RESPONSE_BYTES\s*=\s*["']?(\d+)/))
      || (section === 'server' && line.match(/CC_TEAM_RESPONSE_BYTES\s*=\s*["']?(\d+)/));
    if (bytes) result.responseBytes = Number(bytes[1]);
    if (section === 'server' && /^\s*omit_tools_from\s*=/.test(line)) result.omitToolsFrom = arrayValues(line);
    const limit = section === 'server' ? line.match(/^\s*["']?tools["']?\s*\.\s*["']?([\w-]+)["']?\s*\.\s*output_token_limit\s*=\s*(\d+)/)
      : section === 'tool' ? line.match(/^\s*()output_token_limit\s*=\s*(\d+)/) : null;
    if (limit) result.outputTokenLimits[limit[1] || tool] = Number(limit[2]);
  }
  return { ...result, found };
}
