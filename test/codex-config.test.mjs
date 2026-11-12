import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codexConfigPath, updateCodexServer } from '../src/codex-config.mjs';

function file(t, text) {
  const directory = mkdtempSync(path.join(tmpdir(), 'cc-team-codex-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'config.toml');
  writeFileSync(target, text, { mode: 0o600 });
  return target;
}

test('Codex 配置路径遵循 CODEX_HOME', () => {
  assert.equal(codexConfigPath({ CODEX_HOME: '/custom' }, '/home/user'), path.join('/custom', 'config.toml'));
  assert.equal(codexConfigPath({}, '/home/user'), path.join('/home/user', '.codex', 'config.toml'));
});

test('只改目标服务表：替换已有超时、合并单行 env_vars，保留 CRLF 和文件权限', t => {
  const target = file(t, '[mcp_servers.other]\r\ntool_timeout_sec = 5\r\n\r\n[mcp_servers."cc_team"]\r\ncommand = "node"\r\ntool_timeout_sec = 60\r\nenv_vars = ["HTTPS_PROXY"]\r\n\r\n[mcp_servers.cc_team.env]\r\nA = "1"\r\n');
  const result = updateCodexServer(target, 'cc_team', { toolTimeoutSec: 600, envVars: ['DEEPSEEK_API_KEY', 'HTTPS_PROXY'] });
  assert.deepEqual(result.forwarded, ['HTTPS_PROXY', 'DEEPSEEK_API_KEY']);
  assert.equal(readFileSync(target, 'utf8'), '[mcp_servers.other]\r\ntool_timeout_sec = 5\r\n\r\n[mcp_servers."cc_team"]\r\ncommand = "node"\r\ntool_timeout_sec = 600\r\nenv_vars = ["HTTPS_PROXY", "DEEPSEEK_API_KEY"]\r\n\r\n[mcp_servers.cc_team.env]\r\nA = "1"\r\n');
  if (process.platform !== 'win32') assert.equal(statSync(target).mode & 0o777, 0o600);
});

test('多行 env_vars 不自动改写，找不到服务表时报错且不改文件', t => {
  const target = file(t, '[mcp_servers.cc_team]\nenv_vars = [\n  "A",\n]\n');
  const result = updateCodexServer(target, 'cc_team', { toolTimeoutSec: 600, envVars: ['B'] });
  assert.equal(result.unmanagedEnvVars, true);
  assert.equal(readFileSync(target, 'utf8'), '[mcp_servers.cc_team]\ntool_timeout_sec = 600\nenv_vars = [\n  "A",\n]\n');
  const other = file(t, '[mcp_servers.cc_team_extra]\ncommand = "x"\n');
  assert.throws(() => updateCodexServer(other, 'cc_team', { toolTimeoutSec: 600 }), /未找到 \[mcp_servers\.cc_team\]/);
  assert.equal(readFileSync(other, 'utf8'), '[mcp_servers.cc_team_extra]\ncommand = "x"\n');
});
