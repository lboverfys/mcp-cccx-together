import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultDirectories, executableCommand, findExecutable, loadConfig } from '../src/config.mjs';

function fixture(t) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'cc-team-config-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const write = (relative, text = '') => {
    const file = path.join(directory, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    return file;
  };
  const options = { env: {}, home: directory, temporaryRoot: directory,
    platform: process.platform === 'win32' ? 'win32' : 'linux',
    legacyConfigPath: path.join(directory, 'absent.json') };
  return { directory, write, options };
}

test('平台默认目录使用用户标准位置，临时数据分开保存', () => {
  assert.deepEqual(defaultDirectories({ platform: 'win32', env: {}, home: 'C:\\Users\\example', temporaryRoot: 'D:\\Temp' }), {
    stateDir: 'C:\\Users\\example\\AppData\\Local\\cc-team-mcp', tempDir: 'D:\\Temp\\cc-team-mcp',
  });
  assert.deepEqual(defaultDirectories({ platform: 'darwin', env: {}, home: '/Users/example', temporaryRoot: '/private/tmp' }), {
    stateDir: '/Users/example/Library/Application Support/cc-team-mcp', tempDir: '/private/tmp/cc-team-mcp',
  });
  assert.equal(defaultDirectories({ platform: 'linux', env: { XDG_STATE_HOME: '/var/user-state' }, home: '/home/example', temporaryRoot: '/tmp' }).stateDir,
    '/var/user-state/cc-team-mcp');
});

test('配置缺省时发现 PATH 客户端，不要求 Codex，也不创建状态目录', t => {
  const f = fixture(t);
  const claude = f.write(process.platform === 'win32' ? 'bin/claude.exe' : 'bin/claude');
  chmodSync(claude, 0o755);
  const config = loadConfig(undefined, { ...f.options, env: { PATH: path.dirname(claude) } });
  assert.equal(config.claudeExecutable, realpathSync(claude));
  assert.equal(config.codexExecutable, undefined);
  assert.equal(config.notificationMode, 'poll');
  assert.equal(existsSync(config.stateDir), false);
  assert.equal(existsSync(config.tempDir), false);
});

test('显式配置优先于环境配置，环境字段可覆盖路径，保留根目录旧配置兼容', t => {
  const f = fixture(t);
  const legacy = f.write('legacy.json', JSON.stringify({ stateDir: path.join(f.directory, 'legacy-state'), claudeExecutable: process.execPath }));
  const other = f.write('other.json', JSON.stringify({ stateDir: path.join(f.directory, 'other-state'), claudeExecutable: process.execPath }));
  const envConfig = f.write('env.json', JSON.stringify({ stateDir: path.join(f.directory, 'env-state'), claudeExecutable: process.execPath }));
  const options = { ...f.options, legacyConfigPath: legacy };
  assert.equal(loadConfig(undefined, options).stateDir, path.join(f.directory, 'legacy-state'));
  assert.equal(loadConfig(undefined, { ...options, env: { CC_TEAM_CONFIG: envConfig } }).stateDir, path.join(f.directory, 'env-state'));
  const config = loadConfig(other, { ...options, env: { CC_TEAM_CONFIG: envConfig, CC_TEAM_TEMP_DIR: path.join(f.directory, 'env-temp') } });
  assert.equal(config.stateDir, path.join(f.directory, 'other-state'));
  assert.equal(config.tempDir, path.join(f.directory, 'env-temp'));
  assert.equal(config.configPath, other);
});

test('缺少 Claude 的诊断可继续，正常启动给出可执行的修复提示', t => {
  const f = fixture(t);
  assert.throws(() => loadConfig(undefined, f.options), /未找到 Claude Code/);
  assert.equal(loadConfig(undefined, { ...f.options, requireClaude: false }).claudeExecutable, undefined);
  assert.throws(() => loadConfig(f.write('bad.json', '[]'), f.options), /JSON 对象/);
  assert.throws(() => loadConfig(f.write('relative.json', '{"stateDir":"relative"}'), f.options), /stateDir 必须是绝对路径/);
  assert.throws(() => loadConfig(f.write('invalid-mode.json', '{"notificationMode":"guess"}'), f.options), /notificationMode/);
  assert.throws(() => loadConfig(f.write('queue.json', JSON.stringify({ claudeExecutable: process.execPath, notificationMode: 'codex-queue' })), f.options), /Codex 可执行入口/);
});

test('诊断模式汇总失效客户端入口，正常运行仍拒绝错误配置', t => {
  const f = fixture(t);
  const file = f.write('broken-clients.json', JSON.stringify({
    claudeExecutable: path.join(f.directory, 'missing-claude'),
    codexExecutable: path.join(f.directory, 'missing-codex'), notificationMode: 'codex-queue',
  }));
  assert.throws(() => loadConfig(file, f.options), /claudeExecutable 不是可运行的入口/);
  const config = loadConfig(file, { ...f.options, diagnostic: true });
  assert.equal(config.claudeExecutable, undefined);
  assert.equal(config.codexExecutable, undefined);
  assert.match(config.executableErrors.claude, /missing-claude/);
  assert.match(config.executableErrors.codex, /missing-codex/);
  assert.equal(existsSync(config.stateDir), false);
});

test('注册环境只保留显式 MCP 覆盖和自动发现所需 PATH，不复制模型密钥', t => {
  const f = fixture(t);
  const executable = f.write(process.platform === 'win32' ? 'bin/claude.exe' : 'bin/claude');
  chmodSync(executable, 0o755);
  const file = f.write('config.json', '{}');
  const env = { PATH: path.dirname(executable), CC_TEAM_TEMP_DIR: path.join(f.directory, 'custom-temp'),
    ANTHROPIC_API_KEY: 'test-key-must-not-be-copied' };
  const discovered = loadConfig(file, { ...f.options, env });
  assert.deepEqual(discovered.registrationEnv, { CC_TEAM_TEMP_DIR: env.CC_TEAM_TEMP_DIR, PATH: env.PATH });
  f.write('config.json', JSON.stringify({ claudeExecutable: executable }));
  const explicit = loadConfig(file, { ...f.options, env });
  assert.deepEqual(explicit.registrationEnv, { CC_TEAM_TEMP_DIR: env.CC_TEAM_TEMP_DIR });
});

test('Windows npm shim 通过已安装包的 bin 映射解析，不执行 shell 内容', t => {
  const f = fixture(t);
  const shim = f.write('bin/claude.cmd', '@echo malicious shim must never execute');
  f.write('bin/node_modules/@anthropic-ai/claude-code/package.json', '{"bin":{"claude":"cli.js"}}');
  const actual = f.write('bin/node_modules/@anthropic-ai/claude-code/cli.js');
  const found = findExecutable('claude', { platform: 'win32', home: f.directory, env: { Path: path.dirname(shim) } });
  assert.equal(found, actual);
  assert.equal(findExecutable('claude', { platform: 'win32', configured: shim }), actual);
  assert.deepEqual(executableCommand(actual), { command: process.execPath, args: [actual] });
  f.write('bin/node_modules/@anthropic-ai/claude-code/package.json', '{"bin":{"claude":"../../../outside.exe"}}');
  assert.throws(() => findExecutable('claude', { platform: 'win32', configured: shim }), /超出包目录/);
});

test('Windows 原生路径优先且不接受来源未知的命令包装文件', t => {
  const f = fixture(t);
  const executable = f.write('bin/claude.exe');
  const shim = f.write('other/claude.cmd');
  assert.equal(findExecutable('claude', { platform: 'win32', env: { PATH: `${path.dirname(shim)};${path.dirname(executable)}` }, home: f.directory }), executable);
  assert.throws(() => findExecutable('claude', { platform: 'win32', configured: shim }), /不是可运行的入口/);
  assert.deepEqual(executableCommand(executable), { command: executable, args: [] });
});

test('本机标准 .local/bin 可在精简 PATH 下发现客户端', t => {
  const f = fixture(t);
  const executable = f.write(process.platform === 'win32' ? '.local/bin/claude.exe' : '.local/bin/claude');
  chmodSync(executable, 0o755);
  assert.equal(findExecutable('claude', { env: {}, home: f.directory }), executable);
});
