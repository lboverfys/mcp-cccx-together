import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
export const VERIFY_OUTPUT_CHARS = 6000;

/** 在 cwd 用系统 shell 执行验证命令；中止或超时会结束整个进程树。 */
export function runVerify(command, cwd, signal, tempDir) {
  return new Promise(resolveRun => {
    let output = '';
    let timedOut = false;
    const child = spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir } });
    const collect = data => { output = (output + data).slice(-VERIFY_OUTPUT_CHARS); };
    child.stdout.setEncoding('utf8').on('data', collect);
    child.stderr.setEncoding('utf8').on('data', collect);
    const kill = () => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        else process.kill(-child.pid, 'SIGKILL');
      } catch { /* 进程已退出 */ }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, VERIFY_TIMEOUT_MS);
    signal.addEventListener('abort', kill, { once: true });
    const started = Date.now();
    const finish = (ok, detail, extra = {}) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
      resolveRun({ ok, output: `${output}${detail ? `\n${detail}` : ''}`.trim().slice(-VERIFY_OUTPUT_CHARS), ms: Date.now() - started, ...extra });
    };
    child.once('error', error => finish(false, error.message, { missing: true }));
    child.once('close', (code, exitSignal) => finish(code === 0,
      code === 0 ? '' : timedOut ? `验证命令超过 ${VERIFY_TIMEOUT_MS / 60000} 分钟被终止` : `退出码 ${code ?? exitSignal}`,
      { code, ...(commandMissing(code) ? { missing: true } : {}), ...(timedOut ? { timedOut } : {}) }));
  });
}

/** shell 找不到命令时的退出码：POSIX sh 为 127，Windows cmd 为 9009。这类失败改代码修不好，不应发回工作者。 */
export const commandMissing = (code, platform = process.platform) => code === 127 || (platform === 'win32' && code === 9009);

const NPM_DEFAULT_TEST = /no test specified/i;
const read = file => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };

/** 按目录中的项目文件推断测试命令；识别不了返回 undefined。 */
function detectIn(dir, platform) {
  const has = name => existsSync(path.join(dir, name));
  if (has('package.json')) {
    let test;
    try { test = JSON.parse(read(path.join(dir, 'package.json'))).scripts?.test; } catch { /* 无效 JSON 当作没有测试脚本 */ }
    if (typeof test === 'string' && test.trim() && !NPM_DEFAULT_TEST.test(test)) {
      return has('pnpm-lock.yaml') ? 'pnpm test' : has('yarn.lock') ? 'yarn test'
        : has('bun.lock') || has('bun.lockb') ? 'bun run test' : 'npm test';
    }
  }
  if (has('go.mod')) return 'go test ./...';
  if (has('Cargo.toml')) return 'cargo test';
  if (has('pytest.ini') || has('conftest.py') || /\[tool\.pytest/.test(read(path.join(dir, 'pyproject.toml')))
    || /\[tool:pytest\]/.test(read(path.join(dir, 'setup.cfg'))) || /\[pytest\]/.test(read(path.join(dir, 'tox.ini')))) return 'python -m pytest -q';
  if (has('gradlew')) return platform === 'win32' ? 'gradlew.bat test' : './gradlew test';
  if (has('pom.xml')) return 'mvn -q test';
  let entries = [];
  try { entries = readdirSync(dir); } catch { /* 不可读目录跳过 */ }
  if (entries.some(name => /\.(?:sln|csproj|fsproj)$/i.test(name))) return 'dotnet test';
  if (/^test\s*:/m.test(read(path.join(dir, 'Makefile')))) return 'make test';
  return undefined;
}

/**
 * verify: "auto" 时推断测试命令：在 git 仓库中从 cwd 逐级向上找到第一个能识别的项目目录（止于仓库根目录），
 * 不在仓库中时只看 cwd。项目文件在上级目录时先 cd 过去再运行；隔离工作区的目录结构相同，同一命令也适用。
 */
export function detectVerify(cwd, { platform = process.platform } = {}) {
  const dirs = [cwd];
  for (let dir = cwd; !existsSync(path.join(dir, '.git')); dir = path.dirname(dir)) {
    if (path.dirname(dir) === dir) { dirs.length = 1; break; }
    dirs.push(path.dirname(dir));
  }
  for (const dir of dirs) {
    const command = detectIn(dir, platform);
    if (!command) continue;
    const relative = path.relative(cwd, dir);
    return { command: relative ? `cd "${relative}" && ${command}` : command, dir };
  }
  return undefined;
}
