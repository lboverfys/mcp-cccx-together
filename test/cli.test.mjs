import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli.mjs';

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
  const absent = harness({ claudeExecutable: undefined, codexExecutable: undefined });
  assert.equal(await runCli(['doctor'], absent.options), 1);
  assert.equal(JSON.parse(absent.stdout).checks.claude.ok, false);
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

test('setup 用实际子进程验证参数边界、Node 包装入口和注册调用，不修改真实 Codex', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cc-team-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fakeCodex = path.join(directory, 'fake codex.mjs');
  const log = path.join(directory, 'arguments.json');
  writeFileSync(fakeCodex, `import {writeFileSync} from 'node:fs';
const args = process.argv.slice(2);
if(args[0] === 'mcp' && args[1] === 'get') { process.stderr.write("Error: No MCP server named 'cc_custom' found.\\n"); process.exit(1); }
writeFileSync(${JSON.stringify(log)}, JSON.stringify(args));
`);
  const h = harness({ codexExecutable: fakeCodex, configPath: path.join(directory, 'config with spaces.json') });
  const entryPath = path.join(directory, 'package ; literal', 'cli.mjs');
  assert.equal(await runCli(['setup', '--name', 'cc_custom'], { ...h.options, entryPath }), 0, h.stderr);
  assert(existsSync(log));
  const args = JSON.parse(readFileSync(log, 'utf8'));
  assert.deepEqual(args.slice(0, 3), ['mcp', 'add', 'cc_custom']);
  assert.deepEqual(args.slice(args.indexOf('--') + 1), [process.execPath, entryPath, 'serve', '--config', h.config.configPath]);
  assert.equal(args.includes('--env'), false);
  assert.match(h.stdout, /已注册 MCP/);
});
