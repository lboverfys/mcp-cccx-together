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
  const failed = await runVerify(`"${process.execPath}" -e "process.exit(4)"`, process.cwd(), signal, tmpdir());
  assert.deepEqual([failed.ok, failed.code, failed.missing], [false, 4, undefined]);
  assert.ok(failed.ms >= 0);
  const missing = await runVerify('cc-team-no-such-command-xyz', process.cwd(), signal, tmpdir());
  assert.equal(missing.ok, false);
  assert.equal(missing.missing, true);
  assert.equal(commandMissing(9009, 'win32'), true);
  assert.equal(commandMissing(9009, 'linux'), false);
  assert.equal(commandMissing(1), false);
});
