import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mcpConfiguration, runCli } from '../src/cli.mjs';
import { loadConfig } from '../src/config.mjs';

function harness(overrides = {}) {
  let stdout = '', stderr = '';
  const config = { claudeExecutable: process.execPath, codexExecutable: process.execPath,
    stateDir: path.join(tmpdir(), 'state'), tempDir: path.join(tmpdir(), 'runtime'), notificationMode: 'poll', ...overrides };
  const options = { stdout: { write(text) { stdout += text; } }, stderr: { write(text) { stderr += text; } },
    loadConfigImpl: () => config };
  return { config, options, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

test('帮助和版本无需载入配置或启动客户端，未知参数返回明确错误', async () => {
  for (const flag of ['--help', '--version']) {
    const h = harness();
    assert.equal(await runCli([flag], { ...h.options, loadConfigImpl() { assert.fail('应跳过配置加载'); } }), 0);
    assert(h.stdout.length > 0);
    assert.equal(h.stderr, '');
  }
  for (const args of [['--config'], ['other'], ['setup', '--name', 'bad name']]) {
    const h = harness();
    assert.equal(await runCli(args, h.options), 1);
    assert.match(h.stderr, /CC Team MCP/);
  }
});

test('默认启动 MCP，不向标准输出混入日志', async () => {
  const h = harness();
  let called;
  assert.equal(await runCli([], { ...h.options, runServerImpl: async config => { called = config; } }), 0);
  assert.equal(called, h.config);
  assert.equal(h.stdout, '');
  assert.equal(h.stderr, '');
});

test('print-config 输出可复制 JSON，固定绝对入口并保留路径中的空格', async () => {
  const h = harness({ configPath: path.join(tmpdir(), 'my config.json') });
  const entryPath = path.join(tmpdir(), 'package with spaces', 'src', 'cli.mjs');
  assert.equal(await runCli(['print-config', '--name', 'cc_custom'], { ...h.options, entryPath }), 0);
  const actual = JSON.parse(h.stdout).mcpServers.cc_custom;
  assert.equal(actual.command, process.execPath);
  assert.deepEqual(actual.args, [entryPath, 'serve', '--config', h.config.configPath]);
  assert.deepEqual(actual.env, {});
  assert.equal(h.stderr, '');
});

test('无配置文件时固定已发现入口，避免 MCP 客户端精简 PATH 造成启动失败', async () => {
  const h = harness();
  assert.equal(await runCli(['print-config'], h.options), 0);
  const actual = JSON.parse(h.stdout).mcpServers.cc_team;
  assert.equal(actual.env.CC_TEAM_TEMP_DIR, h.config.tempDir);
  assert.equal(actual.env.CC_TEAM_CLAUDE_EXECUTABLE, process.execPath);
});

test('配置文件注册后保留显式环境目录覆盖，同时继续读取配置文件更新', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cc-team-registration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  const stored = { claudeExecutable: process.execPath, stateDir: path.join(directory, 'state'),
    tempDir: path.join(directory, 'old-temp'), notificationMode: 'poll' };
  writeFileSync(file, JSON.stringify(stored));
  const tempDir = path.join(directory, 'environment-temp');
  const options = { env: { CC_TEAM_TEMP_DIR: tempDir }, home: directory, temporaryRoot: directory };
  const config = loadConfig(file, options);
  const registration = mcpConfiguration(config).mcpServers.cc_team;
  assert.deepEqual(registration.env, { CC_TEAM_TEMP_DIR: tempDir });
  const newState = path.join(directory, 'updated-state');
  writeFileSync(file, JSON.stringify({ ...stored, stateDir: newState }));
  const restarted = loadConfig(file, { ...options, env: registration.env });
  assert.equal(restarted.tempDir, tempDir);
  assert.equal(restarted.stateDir, newState);
});

test('doctor 只调用 --version，Codex 是可选客户端，Claude 缺失返回失败', async () => {
  const h = harness({ codexExecutable: undefined });
  const calls = [];
  const executeImpl = async (command, args, options) => { calls.push({ command, args, options }); return { stdout: 'Claude Code 1.2.3\n', stderr: '' }; };
  assert.equal(await runCli(['doctor'], { ...h.options, executeImpl }), 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['--version']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.DISABLE_AUTOUPDATER, '1');
  assert.equal(JSON.parse(h.stdout).checks.claude.ok, true);
  assert.equal(JSON.parse(h.stdout).checks.codex.optional, true);
  const absent = harness({ claudeExecutable: undefined, codexExecutable: undefined });
  assert.equal(await runCli(['doctor'], absent.options), 1);
  assert.equal(JSON.parse(absent.stdout).checks.claude.ok, false);
});

test('doctor 找到 Codex 但版本命令失败时不能报告环境检查通过', async () => {
  const h = harness({ codexExecutable: path.join(tmpdir(), 'broken-codex') });
  const calls = [];
  assert.equal(await runCli(['doctor'], { ...h.options, executeImpl: async (command, args) => {
    calls.push({ command, args });
    if (command === h.config.codexExecutable) throw new Error('模拟 Codex 无法执行');
    return { stdout: 'Claude Code test version', stderr: '' };
  } }), 1);
  assert.equal(calls.length, 2);
  const { checks } = JSON.parse(h.stdout);
  assert.equal(checks.claude.ok, true);
  assert.equal(checks.codex.ok, false);
  assert.equal(checks.codex.optional, false);
  assert.match(checks.codex.error, /Codex 无法执行/);
  assert.equal(checks.stateDir.ok, true);
  assert.equal(checks.tempDir.ok, true);
});

test('doctor 明确检查可选 queue 通知能力，失败可定位到通知设置', async () => {
  const h = harness({ notificationMode: 'codex-queue' });
  const calls = [];
  assert.equal(await runCli(['doctor'], { ...h.options, executeImpl: async (_command, args) => {
    calls.push(args);
    if (args[0] === 'queue') throw new Error('unknown subcommand');
    return { stdout: '1.2.3', stderr: '' };
  } }), 1);
  assert.deepEqual(calls.at(-1), ['queue', '--help']);
  assert.equal(JSON.parse(h.stdout).checks.notifications.ok, false);
});

test('doctor 汇总错误入口与目录检查，不启动错误客户端或创建目录', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cc-team-doctor-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  const stateDir = path.join(directory, 'missing-state');
  const tempDir = path.join(directory, 'file-instead-of-directory');
  writeFileSync(tempDir, 'keep');
  writeFileSync(file, JSON.stringify({ claudeExecutable: path.join(directory, 'missing-claude'),
    codexExecutable: path.join(directory, 'missing-codex'), stateDir, tempDir, notificationMode: 'codex-queue' }));
  const h = harness();
  assert.equal(await runCli(['doctor', '--config', file], { ...h.options,
    loadConfigImpl: (configPath, options) => loadConfig(configPath, { ...options, env: {}, home: directory, temporaryRoot: directory }),
    executeImpl() { assert.fail('错误的入口不应执行'); },
  }), 1);
  const { checks } = JSON.parse(h.stdout);
  assert.equal(checks.node.ok, true);
  assert.equal(checks.claude.ok, false);
  assert.match(checks.claude.error, /missing-claude/);
  assert.equal(checks.codex.ok, false);
  assert.equal(checks.notifications.ok, false);
  assert.deepEqual(checks.stateDir, { ok: true, path: stateDir, exists: false, checkedPath: directory });
  assert.equal(checks.tempDir.ok, false);
  assert.match(checks.tempDir.error, /不是目录/);
  assert.equal(existsSync(stateDir), false);
  assert.equal(readFileSync(tempDir, 'utf8'), 'keep');

  writeFileSync(file, JSON.stringify({ claudeExecutable: process.execPath,
    codexExecutable: path.join(directory, 'missing-codex'), stateDir, tempDir: path.join(directory, 'missing-temp') }));
  const optional = harness();
  assert.equal(await runCli(['doctor', '--config', file], { ...optional.options,
    loadConfigImpl: (configPath, options) => loadConfig(configPath, { ...options, env: {}, home: directory, temporaryRoot: directory }),
    executeImpl: async () => ({ stdout: 'test version' }),
  }), 1);
  const optionalChecks = JSON.parse(optional.stdout).checks;
  assert.equal(optionalChecks.claude.ok, true);
  assert.equal(optionalChecks.codex.optional, false);
  assert.equal(optionalChecks.stateDir.ok, true);
  assert.equal(optionalChecks.tempDir.ok, true);
});

test('setup 先检查同名配置，已有注册或查询错误时保持原配置', async () => {
  for (const failure of [false, true]) {
    const h = harness();
    const calls = [];
    const executeImpl = async (_command, args) => {
      calls.push(args);
      if (failure) throw new Error('configuration parse error');
      return { stdout: '{}', stderr: '' };
    };
    assert.equal(await runCli(['setup'], { ...h.options, executeImpl }), 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ['mcp', 'get', 'cc_team', '--json']);
    assert.match(h.stderr, failure ? /configuration parse error/ : /已存在/);
  }
});

function fakeCodex(directory) {
  const script = path.join(directory, 'fake codex.mjs');
  const log = path.join(directory, 'calls.jsonl');
  const codexHome = path.join(directory, 'codex home');
  mkdirSync(codexHome);
  // 模拟 codex mcp add 写出的表结构；FAKE_CODEX_SKIP_CONFIG 模拟无法定位配置表。
  writeFileSync(script, `import {appendFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === 'mcp' && args[1] === 'get') { process.stderr.write("Error: No MCP server named '" + args[2] + "' found.\\n"); process.exit(1); }
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'mcp' && args[1] === 'add' && !process.env.FAKE_CODEX_SKIP_CONFIG) {
  writeFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'model = "gpt"\\n\\n[mcp_servers.' + args[2] + ']\\ncommand = "node"\\nargs = ["cli.mjs"]\\n\\n[mcp_servers.' + args[2] + '.env]\\nA = "1"\\n');
}
`);
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { script, codexHome, calls, configFile: path.join(codexHome, 'config.toml') };
}

test('setup 用实际子进程注册并同步长等待与工具超时，不修改真实 Codex', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cc-team-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const codex = fakeCodex(directory);
  const h = harness({ codexExecutable: codex.script, configPath: path.join(directory, 'config with spaces.json'), waitTimeoutMs: 50000 });
  const entryPath = path.join(directory, 'package ; literal', 'cli.mjs');
  const env = { ...process.env, CODEX_HOME: codex.codexHome };
  assert.equal(await runCli(['setup', '--name', 'cc_custom'], { ...h.options, entryPath, env, home: directory }), 0, h.stderr);
  const [args] = codex.calls();
  assert.equal(codex.calls().length, 1);
  assert.deepEqual(args.slice(0, 3), ['mcp', 'add', 'cc_custom']);
  assert.deepEqual(args.slice(args.indexOf('--') + 1), [process.execPath, entryPath, 'serve', '--config', h.config.configPath]);
  assert.deepEqual(args.slice(3, args.indexOf('--')), ['--env', 'CC_TEAM_WAIT_TIMEOUT_MS=570000']);
  const toml = readFileSync(codex.configFile, 'utf8');
  assert.match(toml, /\[mcp_servers\.cc_custom\]\ntool_timeout_sec = 600\ncommand = "node"/);
  assert.match(toml, /\[mcp_servers\.cc_custom\.env\]\nA = "1"/);
  assert.doesNotMatch(toml, /env_vars/);
  assert.match(h.stdout, /已注册 MCP/);
  assert.match(h.stdout, /tool_timeout_sec = 600/);
});

test('setup 保留显式等待并转发 provider 凭据变量', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cc-team-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const codex = fakeCodex(directory);
  const h = harness({ codexExecutable: codex.script, configPath: path.join(directory, 'config.json'),
    waitTimeoutMs: 120000, waitTimeoutExplicit: true,
    providers: { deepseek: { env: { ANTHROPIC_BASE_URL: 'https://example.invalid' }, envFrom: { ANTHROPIC_AUTH_TOKEN: 'DEEPSEEK_API_KEY' } } } });
  const env = { ...process.env, CODEX_HOME: codex.codexHome };
  assert.equal(await runCli(['setup'], { ...h.options, env, home: directory }), 0, h.stderr);
  const [args] = codex.calls();
  assert(args.includes('CC_TEAM_WAIT_TIMEOUT_MS=120000'));
  const toml = readFileSync(codex.configFile, 'utf8');
  assert.match(toml, /tool_timeout_sec = 150\n/);
  assert.match(toml, /env_vars = \["DEEPSEEK_API_KEY"\]/);
  assert.match(h.stdout, /DEEPSEEK_API_KEY/);
});

test('setup 无法写入工具超时时退回默认等待，避免 team_wait 超过 Codex 超时', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cc-team-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const codex = fakeCodex(directory);
  const h = harness({ codexExecutable: codex.script, configPath: path.join(directory, 'config.json'), waitTimeoutMs: 50000 });
  const env = { ...process.env, CODEX_HOME: codex.codexHome, FAKE_CODEX_SKIP_CONFIG: '1' };
  assert.equal(await runCli(['setup'], { ...h.options, env, home: directory }), 0, h.stderr);
  const calls = codex.calls();
  assert.deepEqual(calls.map(call => call.slice(0, 3)), [['mcp', 'add', 'cc_team'], ['mcp', 'remove', 'cc_team'], ['mcp', 'add', 'cc_team']]);
  assert(calls[0].includes('CC_TEAM_WAIT_TIMEOUT_MS=570000'));
  assert(calls[2].includes('CC_TEAM_WAIT_TIMEOUT_MS=50000'));
  assert.equal(existsSync(codex.configFile), false);
  assert.match(h.stdout, /未能写入/);
  assert.match(h.stdout, /50000 毫秒/);
});
