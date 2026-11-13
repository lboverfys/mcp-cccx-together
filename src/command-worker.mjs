import { runVerify } from './verify.mjs';

// 通过时只带回输出末尾，失败时带回全部保留的输出（runVerify 已截到末尾 6000 字符）。
const PASS_OUTPUT_CHARS = 1500;

/**
 * 命令任务：不启动 Claude Code，由 MCP 在工作目录直接运行命令，结果按工作者交付返回。
 * 接口与 Claude 工作者一致：每条投递的消息触发一次运行（运行中收到的消息并入下一次），
 * 进程语义上一直待命到 close，主控 team_send 或 team_resume 即重新运行。
 */
export function createCommandWorker({ worker, config, emit, runImpl = runVerify }) {
  const cwd = worker.worktree?.cwd ?? worker.cwd;
  const pending = [];
  let abort;
  let running;
  let closing = false;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });

  async function runOnce() {
    const messageIds = pending.splice(0);
    abort = new AbortController();
    emit('activity', { tool: 'Bash', state: 'started' });
    let check;
    try { check = await runImpl(worker.command, cwd, abort.signal, config.tempDir); }
    catch (error) { check = { ok: false, output: error.message, ms: 0 }; }
    const interrupted = abort.signal.aborted;
    const output = check.ok ? check.output.slice(-PASS_OUTPUT_CHARS) : check.output;
    const seconds = ((check.ms ?? 0) / 1000).toFixed(1);
    const head = check.ok ? `命令通过：${worker.command}（${seconds} 秒）`
      : `命令未通过：${worker.command}（${seconds} 秒${check.code !== undefined && check.code !== null ? `，退出码 ${check.code}` : ''}` +
        `${check.missing ? '，找不到命令或程序' : ''}）`;
    if (closing) return;
    emit('result', {
      success: check.ok, interrupted, background: false,
      text: `${head}\n${output ? `输出末尾：\n${output}` : '没有输出'}`,
      errors: check.ok ? [] : [head], messageIds, durationMs: check.ms, numTurns: 0, subtype: check.ok ? 'success' : 'error',
    });
  }

  async function drain() {
    try {
      while (pending.length && !closing) await runOnce();
    } finally { running = undefined; }
  }

  return {
    send(text, messageId) {
      if (closing) throw new Error('命令任务已关闭，不能追加指令');
      pending.push(messageId);
      running ??= drain();
    },
    async interrupt() {
      if (closing) throw new Error('命令任务已关闭，不能中断');
      abort?.abort();
      return { interrupted: Boolean(running) };
    },
    async close() {
      closing = true;
      abort?.abort();
      await running;
      finish();
    },
    done,
    pid: undefined,
  };
}
