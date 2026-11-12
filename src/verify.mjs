import { spawn } from 'node:child_process';

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
    const finish = (ok, detail) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
      resolveRun({ ok, output: `${output}${detail ? `\n${detail}` : ''}`.trim().slice(-VERIFY_OUTPUT_CHARS) });
    };
    child.once('error', error => finish(false, error.message));
    child.once('close', (code, exitSignal) => finish(code === 0,
      code === 0 ? '' : timedOut ? `验证命令超过 ${VERIFY_TIMEOUT_MS / 60000} 分钟被终止` : `退出码 ${code ?? exitSignal}`));
  });
}
