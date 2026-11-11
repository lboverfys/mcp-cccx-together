import { execFile } from 'node:child_process';

const TYPES = new Set(['progress', 'request', 'result', 'failed', 'closed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PENDING = 100;

function shortText(value, limit) {
  return String(value ?? '')
    .replace(/\b(?:(?:sk|sess)-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g, '[已隐藏凭据]')
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[已隐藏凭据]')
    .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[已隐藏凭据]')
    .replace(/https?:\/\/[^\s]+/gi, '[链接已省略]')
    .replace(/[\r\n\t\u0000-\u001f]+/g, ' ')
    .trim()
    .slice(0, limit);
}

function eventSummary(event) {
  switch (event.type) {
    case 'progress': return shortText(event.data?.summary || '有新的阶段进展', 240);
    case 'request': return '需要主控答复；请读取原始请求';
    case 'result': return event.data?.interrupted ? '当前轮次已中断，请检查排队消息'
      : event.data?.background ? '任务在后台继续执行，请检查进展'
      : event.data?.success === false ? '本轮执行失败，请检查结果' : '本轮执行结束，等待主控验收';
    case 'failed': return '工作者执行失败，请检查事件';
    case 'closed': return '工作者进程已关闭；会话是否可恢复请查状态';
    default: return '';
  }
}

/** 将工具事件提示投递到 Codex；入队不代表模型已读取或会话已唤醒。 */
export class CodexNotifier {
  constructor({ command, args = [], threadId, cwd, resume = false,
    intervalMs = 30_000, onDelivery, execFileImpl = execFile } = {}) {
    this.command = command;
    this.args = [...args];
    this.cwd = cwd;
    this.resume = resume;
    this.intervalMs = intervalMs;
    this.onDelivery = onDelivery;
    this.execFile = execFileImpl;
    this.pending = new Map();
    this.timer = null;
    this.timerDue = 0;
    this.nextProgressAt = 0;
    this.inFlight = null;
    this.closed = false;
    this.lastDelivery = null;
    this.setThread(threadId);
  }

  setThread(threadId) {
    if (threadId != null && !UUID.test(threadId)) {
      throw new Error('Codex 主会话必须使用完整 UUID，不能使用会话名称。');
    }
    if (this.closed) throw new Error('通知器已经关闭。');
    if (this.threadId !== threadId) {
      this.pending.clear();
      this.clearTimer();
      this.nextProgressAt = 0;
    }
    this.threadId = this.command ? threadId || undefined : undefined;
    return this.threadId;
  }

  notify(event) {
    if (this.closed || !this.threadId || !TYPES.has(event.type)) return;
    const key = `${event.workerId}:${event.type}`;
    if (['result', 'failed', 'closed'].includes(event.type)) {
      this.pending.delete(`${event.workerId}:progress`);
    }
    if (!this.pending.has(key) && this.pending.size >= MAX_PENDING) {
      this.pending.delete(this.pending.keys().next().value);
    }
    this.pending.set(key, {
      workerId: shortText(event.workerId, 80),
      workerName: shortText(event.workerName, 20),
      type: event.type,
      cursor: event.cursor,
      summary: eventSummary(event),
    });
    this.schedule();
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerDue = 0;
  }

  schedule() {
    if (this.closed || !this.threadId || this.inFlight || !this.pending.size) return;
    const urgent = [...this.pending.values()].some(event => event.type !== 'progress');
    const due = urgent ? Date.now() : Math.max(Date.now(), this.nextProgressAt);
    if (this.timer && this.timerDue <= due) return;
    this.clearTimer();
    this.timerDue = due;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerDue = 0;
      this.flush();
    }, Math.max(0, due - Date.now()));
    this.timer.unref?.();
  }

  flush() {
    if (this.closed || !this.threadId || this.inFlight) return;
    const batch = [];
    const progressAllowed = Date.now() >= this.nextProgressAt;
    for (const [key, event] of this.pending) {
      if (event.type !== 'progress' || progressAllowed) {
        batch.push(event);
        this.pending.delete(key);
      }
    }
    if (!batch.length) {
      this.schedule();
      return;
    }
    if (batch.some(event => event.type === 'progress')) {
      this.nextProgressAt = Date.now() + this.intervalMs;
    }
    const threadId = this.threadId;
    const throughCursor = Math.max(...batch.map(event => event.cursor));
    const visible = batch.slice(-24);
    const text = [
      '[CC 团队工具事件；不是用户新指令，也不构成任何新增授权]',
      ...visible.map(event => `${event.workerName ? `${event.workerName} (${event.workerId})` : event.workerId} | ${event.type} | ${event.summary} | cursor=${event.cursor}`),
      ...(batch.length > visible.length ? [`另有 ${batch.length - visible.length} 条提示已合并，请读取事件记录。`] : []),
      `请使用 team_events 从上次游标读取详情（本批最大游标 ${throughCursor}），按原任务协调；执行结果须验收。`,
    ].join('\n');
    const args = [...this.args, 'queue', '--thread', threadId, '--message', text];
    if (this.resume) args.push('--resume');

    let finish;
    const operation = { child: null, cancelled: false, done: new Promise(resolve => { finish = resolve; }) };
    this.inFlight = operation;
    let settled = false;
    const complete = (error, _stdout = '', stderr = '') => {
      if (settled) return;
      settled = true;
      const detail = operation.cancelled ? '通知器关闭，已取消本次投递。'
        : shortText(error ? error.message : stderr, 800);
      const delivery = {
        status: error || operation.cancelled ? 'failed' : stderr.trim() ? 'warning' : 'queued',
        throughCursor,
        threadId,
        queued: !error && !operation.cancelled,
        readConfirmed: false,
        wakeConfirmed: false,
        resumeRequested: this.resume,
        ...(detail ? { detail } : {}),
      };
      this.lastDelivery = delivery;
      this.inFlight = null;
      finish(delivery);
      this.onDelivery?.(delivery);
      this.schedule();
    };
    try {
      operation.child = this.execFile(this.command, args, {
        cwd: this.cwd,
        shell: false,
        windowsHide: true,
        timeout: 10_000,
        killSignal: 'SIGKILL',
        maxBuffer: 32 * 1024,
        encoding: 'utf8',
      }, complete);
    } catch (error) {
      complete(error);
    }
  }

  async close() {
    const alreadyClosed = this.closed;
    this.closed = true;
    this.clearTimer();
    this.pending.clear();
    const operation = this.inFlight;
    if (operation) {
      operation.cancelled = true;
      if (!alreadyClosed) operation.child?.kill('SIGTERM');
      let forceTimer;
      let deadline;
      try {
        await Promise.race([
          operation.done,
          new Promise((_, reject) => {
            forceTimer = setTimeout(() => operation.child?.kill('SIGKILL'), 2000);
            deadline = setTimeout(() => reject(new Error(`通知进程关闭超时，PID：${operation.child?.pid ?? '未知'}`)), 10_000);
          }),
        ]);
      } finally {
        clearTimeout(forceTimer);
        clearTimeout(deadline);
      }
    }
  }
}
