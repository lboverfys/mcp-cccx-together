import { randomUUID } from 'node:crypto';
import { realpathSync, statSync, mkdirSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep, dirname, basename } from 'node:path';
import { Store } from './store.mjs';
import { createClaudeWorker } from './claude-worker.mjs';

const active = new Set(['starting', 'running', 'needs_input', 'awaiting_review', 'interrupting', 'idle']);
const clip = (text, max = 12000) => String(text ?? '').slice(0, max);
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};
function physicalPath(path) {
  try { return realpathSync(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(physicalPath(parent), basename(path));
  }
}
function processAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

export class TeamManager {
  constructor({ config, teamId, constraints = '', factory = createClaudeWorker, notifier }) {
    this.config = config;
    this.teamId = teamId;
    this.constraints = constraints;
    this.factory = factory;
    this.notifier = notifier;
    this.store = new Store(resolve(config.stateDir, teamId));
    this.workers = new Map();
    this.requests = new Map();
    this.waiters = new Set();
    this.closing = false;
  }

  async init() {
    await this.store.init();
    for (const data of this.store.listWorkers()) {
      if (active.has(data.status) || data.status === 'closing') {
        data.status = 'stopped';
        data.pendingMessages = [];
        data.updatedAt = new Date().toISOString();
        this.store.saveWorker(data);
      }
      this.workers.set(data.id, { data, controller: null });
    }
    return this;
  }

  save(worker) {
    if (worker.controller?.pid) worker.data.lastPid = worker.controller.pid;
    worker.data.updatedAt = new Date().toISOString();
    this.store.saveWorker(worker.data);
  }

  event(workerId, type, data) {
    const serialized = JSON.stringify(data);
    if (Buffer.byteLength(serialized, 'utf8') > 48000) {
      data = { truncated: true, summary: '事件正文较长，仅保留摘要', preview: clip(serialized, 10000),
        success: data.success, sessionId: data.sessionId, requestId: data.requestId };
    }
    const workerName = this.workers.get(workerId)?.data.name;
    const event = this.namedEvent(this.store.append(workerId, type, { ...data, ...(workerName ? { workerName } : {}) }));
    this.notifier?.notify(event);
    return event;
  }

  namedEvent(event) {
    const workerName = event.data.workerName ?? this.workers.get(event.workerId)?.data.name;
    return { ...event, ...(workerName ? { workerName } : {}) };
  }

  get(reference) {
    const byId = this.workers.get(reference);
    if (byId) return byId;
    const matches = [...this.workers.values()].filter(worker => worker.data.name === reference);
    if (matches.length > 1) throw new Error(`名字“${reference}”对应多个历史工作者，请使用 ID：${matches.map(worker => worker.data.id).join(', ')}`);
    if (!matches.length) throw new Error(`未找到工作者 ${reference}，请用 team_status 查看完整名字`);
    return matches[0];
  }

  status(references) {
    const selected = references ? [...new Set(references.map(ref => this.get(ref)))] : [...this.workers.values()];
    const requests = new Map();
    for (const request of this.requests.values()) {
      if (!requests.has(request.workerId)) requests.set(request.workerId, []);
      requests.get(request.workerId).push({ id: request.id, kind: request.kind, preview: clip(JSON.stringify(request.payload), 2000) });
    }
    return { teamId: this.teamId, workers: selected.map(({ data, controller }) => ({
      id: data.id, name: data.name, task: clip(data.prompt, 1000), cwd: data.cwd, scope: data.scope, access: data.access,
      model: data.model ?? '继承 CC 配置', status: data.status, sessionId: data.sessionId,
      pid: controller?.pid ?? null, lastPid: data.lastPid, updatedAt: data.updatedAt, error: data.error,
      pendingMessages: data.pendingMessages.length,
      requests: requests.get(data.id) ?? [],
    })) };
  }

  prepare(spec) {
    if (!isAbsolute(spec.cwd)) throw new Error('cwd 必须是已存在的绝对路径');
    const cwd = realpathSync(spec.cwd);
    if (!statSync(cwd).isDirectory()) throw new Error('cwd 必须是目录');
    const scopes = (spec.scope?.length ? spec.scope : ['.']).map(path => {
      if (isAbsolute(path)) throw new Error('scope 必须相对于 cwd');
      const full = physicalPath(resolve(cwd, path));
      if (!inside(cwd, full)) throw new Error('scope 不得超出 cwd');
      return full;
    });
    return { ...spec, cwd, scopes, scope: spec.scope?.length ? spec.scope : ['.'], access: spec.access ?? 'read', allowedTools: spec.allowedTools ?? [] };
  }

  assertScopes(specs, excludeId) {
    const current = [...this.workers.values()].filter(w => w.data.id !== excludeId && w.controller);
    const all = [...current.map(w => w.data), ...specs];
    if (all.every(worker => worker.access === 'read')) return;
    // 短路径先入索引，后续只检查自身和祖先；同一路径保留两位不同所有者即可判断冲突。
    const scopes = all.flatMap(worker => worker.scopes.map(path => ({
      worker, path: process.platform === 'win32' ? path.toLowerCase() : path,
    }))).sort((a, b) => a.path.length - b.path.length);
    const index = new Map();
    for (const { worker, path } of scopes) {
      let ancestor = path;
      for (;;) {
        const entry = index.get(ancestor);
        const conflict = worker.access === 'read' ? entry?.writer : entry?.owners.find(owner => owner !== worker);
        if (conflict && conflict !== worker) {
          throw new Error(`工作范围冲突：${conflict.name} 与 ${worker.name}。请拆分 scope、串行执行或使用独立工作区`);
        }
        const parent = dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
      const entry = index.get(path) ?? { owners: [] };
      if (entry.owners.length < 2 && !entry.owners.includes(worker)) entry.owners.push(worker);
      if (worker.access === 'write') entry.writer = worker;
      index.set(path, entry);
    }
  }

  dispatch(specs) {
    if (this.closing) throw new Error('团队正在关闭');
    const prepared = specs.map(spec => this.prepare(spec));
    const names = new Set([...this.workers.values()].map(worker => worker.data.name));
    for (const spec of prepared) {
      if (names.has(spec.name)) throw new Error(`名字“${spec.name}”已存在，请另起一个以cc结尾且完整名字不超过十个字符的职责名；继续原任务请按原名 send 或 resume`);
      names.add(spec.name);
    }
    this.assertScopes(prepared);
    return prepared.map(spec => {
      const id = randomUUID();
      const worker = { data: {
        ...spec, id, status: 'starting', pendingMessages: [], sessionId: null,
        instructions: this.instructions(spec), createdAt: new Date().toISOString(),
      }, controller: null };
      this.workers.set(id, worker);
      this.save(worker);
      this.event(id, 'created', { name: spec.name, cwd: spec.cwd, scope: spec.scope, access: spec.access });
      this.start(worker);
      if (worker.controller) this.send(id, spec.prompt);
      return { id, name: spec.name, status: worker.data.status, error: worker.data.error };
    });
  }

  instructions(spec) {
    return `你是由 Codex 主控派发的 Claude Code 工作者，使用中文汇报。\n` +
      `你的名字是“${spec.name}”，主控和用户会用这个名字指代你。\n` +
      `工作目录：${spec.cwd}\n分配范围：${spec.scope.join(', ')}\n访问模式：${spec.access}\n` +
      `只执行主控任务，先阅读适用的 AGENTS.md/CLAUDE.md，不扩大修改范围。上下文不自动共享；通过 report_progress 汇报里程碑、通过 ask_parent 请求决策。不要把报告成功视为主控已读。\n` +
      `不要自行再创建 agent。没有明确授权不得提交、推送、创建 PR、删除已有工作、安装或更新工具、操作远程服务器。不要改动共享配置。依赖、下载、临时文件优先放 D 盘；需要超出授权范围时询问。\n` +
      `工具报错必须明确报告，不得虚报验证通过。结束时说明修改文件、验证结果、未完成项；你报告完成后由主控验收。清理本任务启动的服务，不得停止原有服务。\n` +
      (spec.access === 'read' ? '当前为只读任务，不允许修改项目或运行命令。\n' : '') +
      `主控提供的任务约束：\n${this.constraints}\n${spec.instructions ?? ''}`;
  }

  start(worker) {
    const tempDir = resolve(this.config.tempDir, this.teamId, worker.data.id);
    mkdirSync(tempDir, { recursive: true });
    try {
      worker.controller = this.factory({
        worker: worker.data, config: { ...this.config, tempDir },
        emit: (type, data) => this.receive(worker, type, data),
        request: (kind, payload, signal) => this.request(worker, kind, payload, signal),
      });
      const controller = worker.controller;
      controller.done.then(() => {
        if (worker.controller !== controller) return;
        worker.controller = null;
        if (worker.data.status !== 'closed' && worker.data.status !== 'closing') {
          worker.data.status = 'stopped';
          this.save(worker);
          this.event(worker.data.id, 'stopped', { summary: '工作进程已退出，会话记录保留' });
        }
        this.cancelRequests(worker.data.id, '工作进程已退出');
      }).catch(error => {
        if (worker.controller !== controller) return;
        if (!processAlive(controller.pid)) worker.controller = null;
        this.fail(worker, error);
      });
    } catch (error) { this.fail(worker, error); }
  }

  fail(worker, error) {
    worker.data.status = 'failed';
    worker.data.error = clip(error.message, 2000);
    this.save(worker);
    this.cancelRequests(worker.data.id, '工作进程失败');
    this.event(worker.data.id, 'failed', { summary: worker.data.error });
  }

  receive(worker, type, data) {
    const previousStatus = worker.data.status;
    if (type === 'session') worker.data.sessionId = data.sessionId;
    if (type === 'result') {
      const ids = data.messageIds ?? (data.messageId ? [data.messageId] : worker.data.pendingMessages.slice(0, 1));
      worker.data.pendingMessages = worker.data.pendingMessages.filter(id => !ids.includes(id));
      if (worker.data.status !== 'closing') worker.data.status = data.success ? (worker.data.pendingMessages.length ? 'running' : 'awaiting_review') : 'failed';
      worker.data.error = data.success ? undefined : clip(data.errors?.join('; ') || data.text || 'CC 执行失败', 2000);
      if (data.sessionId) worker.data.sessionId = data.sessionId;
    }
    if ((type === 'activity' || type === 'progress') && !['needs_input', 'closing'].includes(worker.data.status)) {
      worker.data.status = 'running';
    }
    if (type === 'session' || type === 'result' || worker.data.status !== previousStatus) this.save(worker);
    else worker.data.updatedAt = new Date().toISOString();
    this.event(worker.data.id, type, data);
  }

  send(id, text) {
    if (this.closing) throw new Error('团队正在关闭');
    const worker = this.get(id);
    id = worker.data.id;
    if (!worker.controller || ['closing', 'closed'].includes(worker.data.status)) throw new Error('工作进程未运行，请先 resume');
    if (worker.data.pendingMessages.length >= 32) throw new Error('该工作者已有32条未完成消息，请先等待处理');
    const messageId = randomUUID();
    worker.controller.send(text, messageId);
    worker.data.pendingMessages.push(messageId);
    if (worker.data.status !== 'needs_input') worker.data.status = 'running';
    this.save(worker);
    this.event(id, 'message_queued', { messageId, summary: clip(text, 1000) });
    return { id, name: worker.data.name, messageId, status: 'queued', processed: false };
  }

  request(worker, kind, payload, signal) {
    if (this.closing || signal?.aborted) return Promise.reject(new Error('请求已取消'));
    const id = randomUUID();
    return new Promise((resolveRequest, reject) => {
      const abort = () => {
        const item = this.requests.get(id);
        if (!item) return;
        this.requests.delete(id);
        signal?.removeEventListener('abort', abort);
        if (worker.data.status === 'needs_input' && ![...this.requests.values()].some(r => r.workerId === worker.data.id)) {
          worker.data.status = 'running';
          this.save(worker);
        }
        reject(new Error('请求已取消'));
        this.event(worker.data.id, 'request_cancelled', { requestId: id });
      };
      this.requests.set(id, { id, workerId: worker.data.id, kind, payload, resolve: resolveRequest, reject, cleanup: () => signal?.removeEventListener('abort', abort) });
      signal?.addEventListener('abort', abort, { once: true });
      const previousStatus = worker.data.status;
      try {
        const encoded = JSON.stringify(payload);
        this.event(worker.data.id, 'request', { requestId: id, kind,
          ...(encoded.length <= 6000 ? { payload } : { preview: encoded.slice(0, 6000), truncated: true }),
          summary: kind === 'permission' ? `工具 ${payload.toolName} 等待授权` : '工作者等待主控回答' });
        worker.data.status = 'needs_input';
        this.save(worker);
      } catch (error) {
        this.requests.delete(id);
        signal?.removeEventListener('abort', abort);
        worker.data.status = previousStatus;
        reject(error);
      }
    });
  }

  requestDetails(requestId, offset = 0, limit = 12000) {
    const item = this.requests.get(requestId);
    if (!item) throw new Error('请求不存在或已取消');
    const json = JSON.stringify(item.payload);
    return { requestId, workerId: item.workerId, kind: item.kind, offset,
      text: json.slice(offset, offset + limit), nextOffset: Math.min(json.length, offset + limit),
      totalLength: json.length, hasMore: offset + limit < json.length };
  }

  reply(requestId, answer) {
    const item = this.requests.get(requestId);
    if (!item) throw new Error('请求不存在或已取消，迟到答复不会提交');
    if (item.kind === 'permission' && typeof answer.allow !== 'boolean') throw new Error('权限答复必须提供 allow 布尔值');
    if (item.kind === 'question' && !answer.text && !answer.answers) throw new Error('问题答复必须提供 text 或 answers');
    if (item.kind === 'question' && item.payload.questions?.length > 1 && !answer.answers) throw new Error('多个问题必须逐项提供 answers');
    if (item.kind === 'question' && answer.answers && item.payload.questions?.some(q => typeof answer.answers[q.question] !== 'string')) throw new Error('answers 必须包含每个问题的回答');
    this.requests.delete(requestId);
    item.cleanup();
    const worker = this.get(item.workerId);
    worker.data.status = [...this.requests.values()].some(r => r.workerId === item.workerId) ? 'needs_input' : 'running';
    this.save(worker);
    item.resolve(answer);
    this.event(item.workerId, 'request_answered', { requestId, kind: item.kind });
    return { requestId, answered: true };
  }

  cancelRequests(workerId, reason) {
    for (const [id, item] of this.requests) {
      if (item.workerId !== workerId) continue;
      this.requests.delete(id);
      item.cleanup();
      item.reject(new Error(reason));
      this.event(workerId, 'request_cancelled', { requestId: id, reason });
    }
  }

  async events(options = {}) {
    const { waitMs = 0, workerIds, ...rest } = options;
    const query = { ...rest, ...(workerIds ? { workerIds: [...new Set(workerIds.map(ref => this.get(ref).data.id))] } : {}) };
    let result = this.store.events(query);
    if (result.events.length || !waitMs || this.closing) return { ...result, events: result.events.map(event => this.namedEvent(event)) };
    await new Promise(resolveWait => {
      const finish = () => {
        result = this.store.events(query);
        clearTimeout(timer);
        this.store.off('appended', check);
        this.waiters.delete(finish);
        resolveWait();
      };
      const check = () => { if (this.store.events(query).events.length) finish(); };
      const timer = setTimeout(finish, Math.min(waitMs, 25000));
      this.store.on('appended', check);
      this.waiters.add(finish);
      check();
    });
    return { ...result, events: result.events.map(event => this.namedEvent(event)), ...(this.closing ? { closing: true } : {}) };
  }

  async interrupt(id) {
    const worker = this.get(id);
    id = worker.data.id;
    if (!worker.controller) throw new Error('工作进程未运行');
    worker.data.status = 'interrupting';
    this.save(worker);
    const result = await worker.controller.interrupt();
    this.event(id, 'interrupted', { summary: '已请求中断当前轮次；已排队消息需查看状态', result });
    return { id, name: worker.data.name, status: worker.data.status };
  }

  resume(id, prompt) {
    if (this.closing) throw new Error('团队正在关闭');
    const worker = this.get(id);
    id = worker.data.id;
    if (worker.data.status === 'closing' || worker.closingPromise) throw new Error('工作者正在关闭');
    if (worker.controller) throw new Error('工作进程仍在运行，请用 send 追加指令');
    if (!worker.data.sessionId) throw new Error('没有可恢复的 CC 会话 ID');
    this.assertScopes([worker.data], id);
    worker.data.status = 'starting';
    worker.data.error = undefined;
    worker.data.pendingMessages = [];
    this.save(worker);
    this.start(worker);
    if (!worker.controller) throw new Error(worker.data.error);
    return this.send(id, prompt);
  }

  review(id, accepted, note) {
    const worker = this.get(id);
    id = worker.data.id;
    if (worker.data.status !== 'awaiting_review') throw new Error('只有待验收的工作者可执行验收');
    worker.data.status = accepted ? 'idle' : 'awaiting_review';
    this.save(worker);
    this.event(id, 'review', { accepted, note });
    return { id, name: worker.data.name, accepted, status: worker.data.status };
  }

  async closeWorker(id) {
    const worker = this.get(id);
    if (worker.closingPromise) return worker.closingPromise;
    worker.closingPromise = this.finishCloseWorker(worker);
    try { return await worker.closingPromise; } finally { worker.closingPromise = null; }
  }

  async finishCloseWorker(worker) {
    const id = worker.data.id;
    worker.data.status = 'closing';
    this.save(worker);
    this.cancelRequests(id, '工作者正在关闭');
    if (worker.controller) {
      const controller = worker.controller;
      await controller.close();
      worker.controller = null;
    }
    worker.data.status = 'closed';
    worker.data.pendingMessages = [];
    this.save(worker);
    this.event(id, 'closed', { summary: '工作进程已关闭，会话记录保留', sessionId: worker.data.sessionId });
    return { id, name: worker.data.name, status: 'closed', sessionId: worker.data.sessionId, retained: true };
  }

  async close() {
    this.closing = true;
    for (const finish of [...this.waiters]) finish();
    await this.notifier?.close();
    const results = await Promise.allSettled([...this.workers.values()].filter(w => w.controller || w.closingPromise).map(w => this.closeWorker(w.data.id)));
    const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
    if (errors.length) throw new AggregateError(errors, '部分工作进程未能关闭，未释放团队锁');
    this.store.close();
  }
}
