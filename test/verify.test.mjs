import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commandMissing, detectVerify, runVerify } from '../src/verify.mjs';

function directory(t, files = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cc-team-verify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

test('verify auto 按项目文件推断测试命令，忽略 npm 默认占位脚本', t => {
  const npm = directory(t, { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) });
  assert.equal(detectVerify(npm).command, 'npm test');
  const pnpm = directory(t, { 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }), 'pnpm-lock.yaml': '' });
  assert.equal(detectVerify(pnpm).command, 'pnpm test');
  const placeholder = directory(t, { 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
  assert.equal(detectVerify(placeholder), undefined);
  assert.equal(detectVerify(directory(t, { 'go.mod': 'module x\n' })).command, 'go test ./...');
  assert.equal(detectVerify(directory(t, { 'Cargo.toml': '[package]\n' })).command, 'cargo test');
  assert.equal(detectVerify(directory(t, { 'pyproject.toml': '[tool.pytest.ini_options]\n' })).command, 'python -m pytest -q');
  assert.equal(detectVerify(directory(t, { gradlew: '' }), { platform: 'win32' }).command, 'gradlew.bat test');
  assert.equal(detectVerify(directory(t, { 'App.sln': '' })).command, 'dotnet test');
  assert.equal(detectVerify(directory(t, { Makefile: 'build:\n\ttrue\ntest:\n\ttrue\n' })).command, 'make test');
});

test('verify auto 在 git 仓库内向上查找项目目录，仓库外只看 cwd', t => {
  const repo = directory(t, { '.git/HEAD': '', 'go.mod': 'module x\n', 'svc/api/main.go': '' });
  const nested = path.join(repo, 'svc', 'api');
  assert.deepEqual(detectVerify(nested), { command: `cd "${path.join('..', '..')}" && go test ./...`, dir: repo });
  const outside = directory(t, { 'go.mod': 'module x\n', 'sub/readme.txt': '' });
  assert.equal(detectVerify(path.join(outside, 'sub')), undefined);
});

test('runVerify 返回退出码和耗时，找不到命令单独标记', async () => {
  const signal = new AbortController().signal;
  for (const code of [0, 1, 4]) {
    const result = await runVerify(`"${process.execPath}" -e "process.exit(${code})"`, process.cwd(), signal, tmpdir());
    assert.deepEqual([result.ok, result.code, result.missing], [code === 0, code, undefined]);
    assert.ok(result.ms >= 0);
  }
  const missing = await runVerify('cc-team-no-such-command-xyz', process.cwd(), signal, tmpdir());
  assert.equal(missing.ok, false);
  assert.equal(missing.missing, true);
  assert.equal(missing.code, process.platform === 'win32' ? 9009 : 127);
  assert.equal(commandMissing(9009, 'win32'), true);
  assert.equal(commandMissing(9009, 'linux'), false);
  assert.equal(commandMissing(1), false);
});

test('runVerify 保留组合命令的失败、短路和恢复结果', async () => {
  const signal = new AbortController().signal;
  const success = `"${process.execPath}" -e "process.exit(0)"`;
  const failure = `"${process.execPath}" -e "process.exit(1)"`;
  const missing = 'cc-team-no-such-command-xyz';
  const cases = [
    [`${success} && ${missing}`, false, process.platform === 'win32' ? 9009 : 127, true],
    [`${failure} && ${missing}`, false, 1, undefined],
    [`${missing} || ${success}`, true, 0, undefined],
  ];
  for (const [command, ok, code, isMissing] of cases) {
    const result = await runVerify(command, process.cwd(), signal, tmpdir());
    assert.deepEqual([result.ok, result.code, result.missing], [ok, code, isMissing], command);
  }
});

test('runVerify 支持带空格的脚本路径，保留引号内的 shell 特殊字符', async t => {
  const cwd = directory(t, { 'path with spaces/check.mjs': "console.log('quoted (a&b)'); process.exit(4);\n" });
  const script = path.join(cwd, 'path with spaces', 'check.mjs');
  const result = await runVerify(`"${process.execPath}" "${script}"`, cwd, new AbortController().signal, tmpdir());
  assert.deepEqual([result.ok, result.code, result.missing], [false, 4, undefined]);
  assert.match(result.output, /quoted \(a&b\)/);
});
