import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { TeamManager } from '../src/manager.mjs';

const tempRoot = realpathSync(process.env.TEMP || process.env.TMP || tmpdir());

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
  const dir = mkdtempSync(path.join(tempRoot, 'manager-test-'));
  const cwd = path.join(dir, 'workspace');
  mkdirSync(cwd);
  mkdirSync(path.join(cwd, 'front'));
  mkdirSync(path.join(cwd, 'back'));
  const controllers = [];
  const managers = [];
  const config = {
    stateDir: path.join(dir, 'state'), tempDir: path.join(dir, 'runtime'),
    claudeExecutable: process.execPath,
  };
  const factory = options => {
    const finished = deferred();
    const controller = {
      options, finished, done: finished.promise, pid: 4321, sent: [], closeCalls: 0, interruptCalls: 0,
      send(text, messageId) { this.sent.push({ text, messageId }); },
      interrupt() { this.interruptCalls += 1; return Promise.resolve({ interrupted: true }); },
      async close() {
        this.closeCalls += 1;
        if (this.closeGate) await this.closeGate.promise;
        finished.resolve();
      },
      emit: options.emit,
      request: options.request,
    };
    controllers.push(controller);
    return controller;
  };
  const create = async (overrides = {}) => {
    const manager = await new TeamManager({ config, teamId: 'test-team', factory, ...overrides }).init();
    managers.push(manager);
    return manager;
  };
  t.after(async () => {
    for (const controller of controllers) controller.closeGate?.resolve();
    for (const manager of managers) await manager.close();
    const relative = path.relative(path.resolve(tempRoot), path.resolve(dir));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    rmSync(dir, { recursive: true, force: true });
  });
  const spec = (name, extra = {}) => ({ name, cwd, access: 'read', scope: ['.'], prompt: `执行 ${name}`, allowedTools: [], ...extra });
  return { dir, cwd, config, controllers, create, spec };
}

test('批量派发先验证全部范围，冲突错误不产生部分工作者', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  assert.throws(() => manager.dispatch([
    f.spec('前端', { access: 'write', scope: ['front'] }),
    f.spec('重叠', { access: 'write', scope: ['front/components'] }),
  ]), /冲突/);
  assert.equal(f.controllers.length, 0);
  assert.deepEqual(manager.status().workers, []);
  assert.deepEqual(manager.store.listWorkers(), []);
  const result = manager.dispatch([
    f.spec('前端', { access: 'write', scope: ['front'] }),
    f.spec('后端', { access: 'write', scope: ['back'] }),
  ]);
  assert.equal(result.length, 2);
});

test('范围索引允许同一工作者的嵌套范围，仍阻止祖先写入及共享读目录写入', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const readers = manager.dispatch(Array.from({ length: 24 }, (_, i) => f.spec(`只读${i}`, { scope: ['front'] })));
  assert.equal(readers.length, 24);
  assert.throws(() => manager.dispatch([f.spec('写入根', { access: 'write', scope: ['.'] })]), /冲突/);
  assert.throws(() => manager.dispatch([f.spec('写入子', { access: 'write', scope: ['front/new.js'] })]), /冲突/);
  const [writer] = manager.dispatch([f.spec('后端写入', { access: 'write', scope: ['back', 'back/nested', 'back'] })]);
  assert.ok(writer.id);
  assert.throws(() => manager.dispatch([f.spec('读取后端', { scope: ['back/nested/file.js'] })]), /冲突/);
  const [sibling] = manager.dispatch([f.spec('相邻目录', { access: 'write', scope: ['back-other'] })]);
  assert.ok(sibling.id);
});

test('Windows和macOS对未创建范围保守忽略大小写，原始路径不变且显式依赖可串行', async t => {
  for (const platform of ['win32', 'darwin']) {
    const f = await fixture(t);
    const manager = await f.create({ platform });
    assert.throws(() => manager.dispatch([
      f.spec('写入甲', { access: 'write', scope: ['front/NewFeature'] }),
      f.spec('写入乙', { access: 'write', scope: ['front/newfeature/component.js'] }),
    ]), /冲突/);
    assert.equal(f.controllers.length, 0);
    const [a, b] = manager.dispatch([
      f.spec('写入甲', { access: 'write', scope: ['front/NewFeature'] }),
      f.spec('写入乙', { access: 'write', scope: ['front/newfeature/component.js'], dependsOn: ['写入甲'] }),
    ]);
    assert.deepEqual(manager.get(a.id).data.scope, ['front/NewFeature']);
    assert.equal(path.basename(manager.get(a.id).data.scopes[0]), 'NewFeature');
    assert.equal(manager.scopesOverlap(manager.get(a.id).data, manager.get(b.id).data), true);
    f.controllers[0].emit('result', { success: true, text: '完成' });
    manager.review(a.id, true, '通过');
    await tick();
    assert.equal(f.controllers[0].closeCalls, 1);
    assert.equal(manager.get(b.id).data.status, 'running');
  }
});

test('macOS追加任务也检查大小写重叠，同时保留只读共享范围', async t => {
  const f = await fixture(t);
  const manager = await f.create({ platform: 'darwin' });
  const [a, b] = manager.dispatch([
    f.spec('写入甲', { access: 'write', scope: ['front/NewFile.js'] }),
    f.spec('写入乙', { access: 'write', scope: ['front/OtherFile.js'] }),
  ]);
  manager.get(b.id).data.scope = ['front/newfile.js'];
  assert.throws(() => manager.send(b.id, '继续'), /工作范围.*冲突/);
  assert.equal(f.controllers[1].sent.length, 1);
  assert.equal(manager.scopesOverlap(
    { ...manager.get(a.id).data, access: 'read' },
    { ...manager.get(b.id).data, access: 'read', scopes: [path.join(f.cwd, 'front/newfile.js')] },
  ), false);
  assert.equal(manager.scopeKey(path.join(f.cwd, 'front/NewFile.js')), manager.scopeKey(path.join(f.cwd, 'front/newfile.js')));
  const linux = new TeamManager({ config: f.config, teamId: 'case-sensitive', platform: 'linux' });
  assert.notEqual(linux.scopeKey('/project/NewFile.js'), linux.scopeKey('/project/newfile.js'));
});

test('多个工作者分别跟踪消息，完成报告进入待验收且同会话可继续', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const [a, b] = manager.dispatch([f.spec('A'), f.spec('B')]);
  const [ca, cb] = f.controllers;
  ca.emit('session', { sessionId: 'session-a' });
  cb.emit('session', { sessionId: 'session-b' });
  const followup = manager.send(a.id, '补充要求');
  assert.equal(followup.processed, false);
  assert.equal(manager.get(a.id).data.pendingMessages.length, 2);
  ca.emit('result', { success: true, messageIds: [ca.sent[0].messageId], text: '首轮完成' });
  assert.equal(manager.get(a.id).data.status, 'running');
  assert.deepEqual(manager.get(a.id).data.pendingMessages, [followup.messageId]);
  cb.emit('result', { success: true, messageIds: [cb.sent[0].messageId], text: 'B 完成' });
  assert.equal(manager.get(b.id).data.status, 'awaiting_review');
  ca.emit('result', { success: true, messageIds: [followup.messageId], text: 'A 完成' });
  assert.equal(manager.review(a.id, true, '通过').status, 'idle');
  manager.send(a.id, '下一项任务');
  assert.equal(f.controllers.length, 2);
  assert.equal(manager.get(a.id).data.status, 'running');
  assert.equal(manager.get(a.id).data.sessionId, 'session-a');
  assert.equal(manager.get(b.id).data.sessionId, 'session-b');
});

test('旧记录的重名不猜测目标，长历史名字仍可准确定位且事件可补上名字', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const [a, b, c] = manager.dispatch([f.spec('旧任务甲'), f.spec('旧任务乙'), f.spec('旧任务丙')]);
  manager.get(a.id).data.name = '历史同名';
  manager.get(b.id).data.name = '历史同名';
  const oldName = '旧版本保存的超过十字的任务名';
  manager.get(c.id).data.name = oldName;
  for (const id of [a.id, b.id, c.id]) manager.save(manager.get(id));
  manager.store.append(c.id, 'progress', { summary: '旧版未带名字的事件' });
  await manager.close();

  const reopened = await f.create();
  assert.throws(() => reopened.get('历史同名'), /多个历史工作者.*ID/);
  assert.equal(reopened.get(a.id).data.id, a.id);
  assert.equal(reopened.get(oldName).data.id, c.id);
  assert.throws(() => reopened.dispatch([f.spec('历史同名')]), /已存在/);
  const history = await reopened.events({ workerIds: [oldName] });
  assert.equal(history.events.find(event => event.data.summary === '旧版未带名字的事件').workerName, oldName);
});

test('问题与权限答复分别验证，迟到答复不影响后来的请求', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const [a] = manager.dispatch([f.spec('A')]);
  const controller = f.controllers[0];
  const question = controller.request('question', { question: '选择方案？' });
  const requestId = manager.status().workers[0].requests[0].id;
  assert.equal(manager.get(a.id).data.status, 'needs_input');
  assert.throws(() => manager.reply(requestId, {}), /text 或 answers/);
  manager.reply(requestId, { text: '方案一' });
  assert.deepEqual(await question, { text: '方案一' });
  assert.equal(manager.get(a.id).data.status, 'running');
  const permission = controller.request('permission', { toolName: 'Edit', input: {} });
  const nextId = manager.status().workers[0].requests[0].id;
  assert.notEqual(nextId, requestId);
  assert.throws(() => manager.reply(requestId, { text: '迟到答复' }), /不存在或已取消/);
  assert.throws(() => manager.reply(nextId, { allow: 'yes' }), /布尔值/);
  manager.reply(nextId, { allow: false, reason: '超出当前授权' });
  assert.deepEqual(await permission, { allow: false, reason: '超出当前授权' });
});

test('取消最后一个澄清请求后恢复运行状态，迟到答复被拒绝', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const [a] = manager.dispatch([f.spec('A')]);
  const abort = new AbortController();
  const question = f.controllers[0].request('question', { question: '继续吗？' }, abort.signal);
  const rejected = assert.rejects(question, /取消/);
  const requestId = manager.status().workers[0].requests[0].id;
  abort.abort();
  await rejected;
  assert.equal(manager.status().workers[0].requests.length, 0);
  assert.equal(manager.get(a.id).data.status, 'running');
  assert.throws(() => manager.reply(requestId, { text: '继续' }), /不存在或已取消/);
});

test('答复写盘失败保留原请求，恢复后可以重试且只答复一次', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  manager.dispatch([f.spec('A')]);
  let resolved = false;
  const waiting = f.controllers[0].request('permission', { toolName: 'Write', input: {} })
    .then(answer => { resolved = true; return answer; });
  const requestId = manager.status().workers[0].requests[0].id;
  const saveWorker = manager.store.saveWorker;
  manager.store.saveWorker = () => { throw new Error('模拟磁盘写入失败'); };
  try {
    assert.throws(() => manager.reply(requestId, { allow: false }), /模拟磁盘写入失败/);
    await tick();
    assert.equal(resolved, false);
    assert.equal(manager.status().workers[0].status, 'needs_input');
    assert.equal(manager.status().workers[0].requests[0].id, requestId);
    assert.equal(manager.requestDetails(requestId).kind, 'permission');
  } finally {
    manager.store.saveWorker = saveWorker;
  }
  manager.reply(requestId, { allow: false });
  assert.deepEqual(await waiting, { allow: false });
  assert.equal(manager.status().workers[0].status, 'running');
  assert.throws(() => manager.reply(requestId, { allow: true }), /不存在或已取消/);
});

test('取消请求时写盘或事件失败仍结束等待并传播原始错误', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  manager.dispatch([f.spec('A')]);
  for (const method of ['saveWorker', 'append']) {
    const abort = new AbortController();
    const waiting = f.controllers[0].request('question', { question: '继续吗？' }, abort.signal);
    const rejected = assert.rejects(waiting, /模拟取消写入失败/);
    const original = manager.store[method];
    manager.store[method] = () => { throw new Error('模拟取消写入失败'); };
    try {
      assert.doesNotThrow(() => abort.abort());
      await rejected;
      assert.equal(manager.requests.size, 0);
      assert.equal(manager.status().workers[0].status, 'running');
    } finally {
      manager.store[method] = original;
    }
  }
});

test('多选问题接受非空字符串数组，空数组或空项不会消费请求', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  manager.dispatch([f.spec('A')]);
  const waiting = f.controllers[0].request('question', { questions: [
    { question: '验证哪些平台？', multiSelect: true }, { question: '如何验证？', multiSelect: false },
  ] });
  const requestId = manager.status().workers[0].requests[0].id;
  for (const invalid of [[], [''], ['Windows', ' '], [42]]) {
    assert.throws(() => manager.reply(requestId, { answers: { '验证哪些平台？': invalid, '如何验证？': '自动测试' } }), /非空回答/);
    assert.equal(manager.requests.has(requestId), true);
  }
  const answer = { answers: { '验证哪些平台？': ['Windows', 'macOS'], '如何验证？': '自动测试' } };
  manager.reply(requestId, answer);
  assert.deepEqual(await waiting, answer);
});

test('关闭等待实际 close 完成，关闭期间不能恢复启动另一个进程', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const [a] = manager.dispatch([f.spec('A')]);
  const controller = f.controllers[0];
  controller.emit('session', { sessionId: 'session-a' });
  controller.closeGate = deferred();
  let closed = false;
  const closing = manager.closeWorker(a.id).then(result => { closed = true; return result; });
  await tick();
  assert.equal(closed, false);
  assert.equal(manager.get(a.id).data.status, 'closing');
  controller.finished.resolve();
  await tick();
  assert.throws(() => manager.resume(a.id, '不应启动'), /关闭|closing/);
  controller.closeGate.resolve();
  const result = await closing;
  assert.equal(result.status, 'closed');
  assert.equal(result.retained, true);
  assert.equal(f.controllers.length, 1);
});

test('工作者关闭后可恢复，团队重开保留 session ID 和事件', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const [a] = manager.dispatch([f.spec('A')]);
  f.controllers[0].emit('session', { sessionId: 'session-a' });
  await manager.closeWorker(a.id);
  const followup = manager.resume(a.id, '继续任务');
  assert.equal(followup.status, 'queued');
  assert.equal(f.controllers[1].options.worker.sessionId, 'session-a');
  assert.equal(f.controllers[1].sent[0].text, '继续任务');
  await manager.close();
  const restored = await f.create();
  assert.equal(restored.status().workers[0].sessionId, 'session-a');
  assert.equal(restored.status().workers[0].status, 'closed');
  assert.ok((await restored.events()).events.length > 0);
  restored.resume(a.id, '重开后继续');
  assert.equal(f.controllers.at(-1).options.worker.sessionId, 'session-a');
});

test('全队关闭会等待已经开始关闭的工作者，即使输出流先退出', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const [a] = manager.dispatch([f.spec('A')]);
  const controller = f.controllers[0];
  controller.closeGate = deferred();
  const workerClosing = manager.closeWorker(a.id);
  const workerSettled = workerClosing.then(value => ({ value }), error => ({ error }));
  controller.finished.resolve();
  await tick();
  let teamClosed = false;
  const teamClosing = manager.close().then(() => { teamClosed = true; });
  await tick();
  try {
    assert.equal(teamClosed, false);
  } finally {
    controller.closeGate.resolve();
    await teamClosing;
    const result = await workerSettled;
    if (teamClosed && result.error) throw result.error;
  }
});

test('多个澄清问题必须逐项答复，取消部分请求不解除其他等待', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const [a] = manager.dispatch([f.spec('A')]);
  const controller = f.controllers[0];
  const multi = controller.request('question', { questions: [{ question: '端口？' }, { question: '目录？' }] });
  const multiId = manager.status().workers[0].requests[0].id;
  const abort = new AbortController();
  const extra = controller.request('question', { question: '额外问题？' }, abort.signal);
  const rejected = assert.rejects(extra, /取消/);
  abort.abort();
  await rejected;
  assert.equal(manager.get(a.id).data.status, 'needs_input');
  assert.throws(() => manager.reply(multiId, { text: '不能只回答一个' }), /逐项/);
  assert.throws(() => manager.reply(multiId, { answers: { '端口？': '1234' } }), /每个问题/);
  const answers = { '端口？': '1234', '目录？': 'D:\\example' };
  manager.reply(multiId, { answers });
  assert.deepEqual(await multi, { answers });
});

test('事件等待按 worker 过滤，读取后用游标不会重复交付', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const [a, b] = manager.dispatch([f.spec('A'), f.spec('B')]);
  const initial = await manager.events();
  let returned = false;
  const pending = manager.events({ after: initial.nextCursor, workerIds: [a.id], waitMs: 1000 }).then(value => { returned = true; return value; });
  f.controllers[1].emit('progress', { summary: 'B 的进展' });
  await tick();
  assert.equal(returned, false);
  f.controllers[0].emit('progress', { summary: 'A 的进展' });
  const result = await pending;
  assert.deepEqual(result.events.map(event => event.workerId), [a.id]);
  assert.equal(result.events[0].data.summary, 'A 的进展');
  const next = await manager.events({ after: result.nextCursor });
  assert.deepEqual(next.events, []);
  assert.equal(manager.get(b.id).data.status, 'running');
});

test('团队关闭及时唤醒空团队的事件等待，不遗留等待定时器', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const pending = manager.events({ waitMs: 150 }).then(value => ({ value }), error => ({ error }));
  await manager.close();
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 40); });
  const result = await Promise.race([pending, timeout]);
  clearTimeout(timer);
  assert.notEqual(result, 'timeout');
});

test('目录联接按真实路径检测重叠和越界，包含尚未创建的子路径', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const front = path.join(f.cwd, 'front');
  const outside = path.join(f.dir, 'outside');
  mkdirSync(outside);
  const links = [
    { link: path.join(f.cwd, 'front-alias'), target: front },
    { link: path.join(f.cwd, 'outside-link'), target: outside },
  ];
  const created = [];
  try {
    for (const { link, target } of links) {
      for (const candidate of [link, target]) {
        const relative = path.relative(path.resolve(f.dir), path.resolve(candidate));
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      }
      symlinkSync(target, link, 'junction');
      created.push(link);
      assert.equal(realpathSync(link), realpathSync(target));
    }
    assert.throws(() => manager.dispatch([
      f.spec('实际目录', { access: 'write', scope: ['front'] }),
      f.spec('联接目录', { access: 'write', scope: ['front-alias/new-folder/file.js'] }),
    ]), /冲突/);
    assert.equal(f.controllers.length, 0);
    assert.throws(() => manager.dispatch([
      f.spec('越界联接', { access: 'write', scope: ['outside-link/new-folder/file.js'] }),
    ]), /超出 cwd/);
    assert.equal(f.controllers.length, 0);
  } finally {
    for (const link of created) {
      assert.ok(lstatSync(link).isSymbolicLink());
      unlinkSync(link);
    }
  }
  assert.equal(realpathSync(front), front);
  assert.equal(realpathSync(outside), outside);
});

test('大于 64 KiB 的权限输入保存摘要，详情分页可完整重组并正常答复', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const [a] = manager.dispatch([f.spec('A')]);
  const payload = { toolName: 'Write', input: { file_path: path.join(f.cwd, 'large.txt'), content: '内容\n'.repeat(14000) } };
  const encoded = JSON.stringify(payload);
  let serializations = 0;
  Object.defineProperty(payload, 'toJSON', { value() { serializations++; return { ...this }; } });
  assert.ok(Buffer.byteLength(encoded) > 64 * 1024);
  const waiting = f.controllers[0].request('permission', payload);
  const request = manager.status().workers[0].requests[0];
  assert.equal(manager.get(a.id).data.status, 'needs_input');
  assert.ok(request.preview.length <= 2000);
  const event = (await manager.events()).events.find(event => event.type === 'request');
  assert.equal(event.data.truncated, true);
  assert.equal('payload' in event.data, false);
  assert.ok(Buffer.byteLength(JSON.stringify(event)) < 64 * 1024);
  let reconstructed = '';
  let offset = 0;
  for (;;) {
    const page = manager.requestDetails(request.id, offset, 4096);
    assert.equal(page.offset, offset);
    assert.equal(page.totalLength, encoded.length);
    assert.ok(page.text.length <= 4096);
    reconstructed += page.text;
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
    if (!page.hasMore) break;
  }
  assert.equal(reconstructed, encoded);
  assert.deepEqual(JSON.parse(reconstructed), payload);
  assert.equal(serializations, 1);
  manager.reply(request.id, { allow: false, reason: '测试不写入文件' });
  assert.deepEqual(await waiting, { allow: false, reason: '测试不写入文件' });
  assert.equal(manager.status().workers[0].requests.length, 0);
  assert.equal(manager.get(a.id).data.status, 'running');
  assert.throws(() => manager.requestDetails(request.id), /不存在或已取消/);
});

test('请求事件写入失败时清理请求和取消监听，恢复原状态', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const [a] = manager.dispatch([f.spec('A')]);
  const originalAppend = manager.store.append;
  const abort = new AbortController();
  const lastCursor = (await manager.events()).nextCursor;
  manager.store.append = function (workerId, type, data) {
    if (type === 'request') throw new Error('模拟磁盘写入失败');
    return originalAppend.call(this, workerId, type, data);
  };
  try {
    await assert.rejects(f.controllers[0].request('question', { question: '能继续吗？' }, abort.signal), /模拟磁盘写入失败/);
    assert.equal(manager.requests.size, 0);
    assert.equal(manager.get(a.id).data.status, 'running');
    assert.equal(manager.store.listWorkers()[0].status, 'running');
  } finally {
    manager.store.append = originalAppend;
  }
  abort.abort();
  assert.deepEqual((await manager.events({ after: lastCursor })).events, []);
  assert.equal(manager.status().workers[0].requests.length, 0);
});

test('通知关闭失败仍会关闭工作者，保留锁直到全部收尾成功', async t => {
  const f = await fixture(t);
  let notificationFailure = true;
  const manager = await f.create({ notifier: {
    notify() {},
    close() { if (notificationFailure) throw new Error('模拟通知关闭失败'); },
  } });
  manager.dispatch([f.spec('A'), f.spec('B')]);
  await assert.rejects(manager.close(), /通知进程未能关闭/);
  assert.ok(f.controllers.every(controller => controller.closeCalls === 1));
  assert.ok(manager.status().workers.every(worker => worker.status === 'closed'));
  await assert.rejects(new TeamManager({ config: f.config, teamId: 'test-team' }).init(), /正被进程/);
  notificationFailure = false;
  await manager.close();
  await f.create();
});

test('问题空白答复保持请求有效，主控可以重新回答', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  manager.dispatch([f.spec('A')]);
  const waiting = f.controllers[0].request('question', { questions: [{ question: '目标目录？' }] });
  const requestId = manager.status().workers[0].requests[0].id;
  for (const answer of [{ text: '   ' }, { answers: {} }, { answers: { '目标目录？': ' \n' } }]) {
    assert.throws(() => manager.reply(requestId, answer), /非空/);
    assert.equal(manager.status().workers[0].requests[0].id, requestId);
  }
  manager.reply(requestId, { text: 'workspace' });
  assert.deepEqual(await waiting, { text: 'workspace' });
});

test('进程退出时清空待处理消息，保留会话以便恢复', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const [worker] = manager.dispatch([f.spec('A')]);
  f.controllers[0].emit('session', { sessionId: 'session-a' });
  manager.send(worker.id, '后续任务');
  f.controllers[0].finished.resolve();
  await tick();
  const status = manager.status().workers[0];
  assert.equal(status.status, 'stopped');
  assert.equal(status.pendingMessages, 0);
  assert.equal(status.sessionId, 'session-a');
});

test('团队约束持久保存，更新约束后恢复工作者使用当前约束和原补充要求', async t => {
  const f = await fixture(t);
  const manager = await f.create({ constraints: '只读检查，不安装依赖' });
  const [worker] = manager.dispatch([f.spec('A', { instructions: '优先检查服务入口' })]);
  f.controllers[0].emit('session', { sessionId: 'session-a' });
  await manager.close();
  const reopened = await f.create();
  assert.equal(reopened.constraints, '只读检查，不安装依赖');
  reopened.updateConstraints('允许修改入口，不安装依赖');
  reopened.resume(worker.id, '继续');
  const prompt = f.controllers[1].options.worker.instructions;
  assert.match(prompt, /允许修改入口，不安装依赖/);
  assert.match(prompt, /优先检查服务入口/);
  assert.doesNotMatch(prompt, /只读检查，不安装依赖/);
  assert.doesNotMatch(prompt, /D 盘/);
  await reopened.close();
  const cleared = await f.create({ constraints: '' });
  assert.equal(cleared.constraints, '');
});

test('恢复时重新解析范围，目录联接改变后的重叠会被拒绝', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const link = path.join(f.cwd, 'current');
  symlinkSync(path.join(f.cwd, 'front'), link, 'junction');
  try {
    const [first] = manager.dispatch([f.spec('A', { access: 'write', scope: ['current'] })]);
    f.controllers[0].emit('session', { sessionId: 'session-a' });
    await manager.closeWorker(first.id);
    unlinkSync(link);
    symlinkSync(path.join(f.cwd, 'back'), link, 'junction');
    manager.dispatch([f.spec('B', { access: 'write', scope: ['back'] })]);
    assert.throws(() => manager.resume(first.id, '继续'), /冲突/);
    assert.equal(f.controllers.length, 2);
  } finally {
    assert.ok(lstatSync(link).isSymbolicLink());
    unlinkSync(link);
  }
});

test('异常停止记录的 PID 仍存活时阻止重复启动', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const [worker] = manager.dispatch([f.spec('A', { access: 'write', scope: ['front'] })]);
  f.controllers[0].emit('session', { sessionId: 'session-a' });
  f.controllers[0].finished.resolve();
  await tick();
  manager.get(worker.id).data.lastPid = process.pid;
  assert.throws(() => manager.resume(worker.id, '继续'), /PID.*仍存活/);
  assert.throws(() => manager.dispatch([f.spec('B', { access: 'write', scope: ['front'] })]), /冲突/);
  await assert.rejects(manager.closeWorker(worker.id), /PID.*仍存活/);
  await assert.rejects(manager.close(), /未能关闭/);
  assert.equal(manager.get(worker.id).data.status, 'stopped');
  assert.equal(f.controllers.length, 1);
  manager.get(worker.id).data.lastPid = undefined;
});

test('旧版工作者恢复时保留历史补充要求并附加当前团队约束', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const [worker] = manager.dispatch([f.spec('A')]);
  const data = manager.get(worker.id).data;
  delete data.taskInstructions;
  data.instructions = '旧版通用指令\n主控提供的任务约束：\n旧的团队要求\n保留自定义检查点';
  f.controllers[0].emit('session', { sessionId: 'session-a' });
  await manager.closeWorker(worker.id);
  manager.updateConstraints('新的团队要求');
  manager.resume(worker.id, '继续');
  const prompt = f.controllers[1].options.worker.instructions;
  assert.match(prompt, /保留自定义检查点/);
  assert.match(prompt, /当前约束为准）：\n新的团队要求/);
  assert.doesNotMatch(prompt, /旧版通用指令/);
});

test('其他轮次结果到达时仍保留未回答请求的阻塞状态', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const [worker] = manager.dispatch([f.spec('A')]);
  manager.send(worker.id, '后续消息');
  const controller = f.controllers[0];
  const waiting = controller.request('question', { questions: [{ question: '继续吗？' }] });
  controller.emit('result', { success: true, messageIds: [controller.sent[0].messageId], text: '首轮完成' });
  assert.equal(manager.status().workers[0].status, 'needs_input');
  const requestId = manager.status().workers[0].requests[0].id;
  manager.reply(requestId, { text: '继续' });
  await waiting;
  assert.equal(manager.status().workers[0].status, 'running');
});

test('初始化期间写入失败会释放状态锁，可重试打开', async t => {
  const f = await fixture(t);
  const manager = new TeamManager({ config: f.config, teamId: 'test-team', constraints: '约束' });
  manager.store.saveTeam = () => { throw new Error('模拟写入失败'); };
  await assert.rejects(manager.init(), /模拟写入失败/);
  await f.create();
});

test('默认最多四个真实工作进程，验收后按需关闭待命进程并自动启动队列', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const workers = manager.dispatch(Array.from({ length: 6 }, (_, i) => f.spec(`任务${i}`)));
  assert.equal(manager.maxConcurrent, 4);
  assert.equal(f.controllers.length, 4);
  assert.deepEqual(workers.map(worker => worker.status), ['running', 'running', 'running', 'running', 'queued', 'queued']);
  assert.equal(manager.status().queuedCount, 2);
  assert.equal(manager.status().workers[4].queueReason, 'waiting_capacity');
  const first = f.controllers[0];
  first.emit('result', { success: true, text: '完成', sessionId: 'session-first' });
  assert.equal(f.controllers.length, 4);
  manager.review(workers[0].id, true, '检查通过');
  await tick();
  assert.equal(first.closeCalls, 1);
  assert.equal(f.controllers.length, 5);
  assert.equal(manager.status().runningCount, 4);
  assert.equal(manager.status().queuedCount, 1);
  assert.equal(manager.get(workers[0].id).data.status, 'closed');
  assert.equal(manager.get(workers[0].id).data.sessionId, 'session-first');
});

test('并发上限持久化，可提高容量；降低容量等待现有工作退出', async t => {
  const f = await fixture(t);
  const manager = await f.create({ maxConcurrent: 1 });
  manager.dispatch([f.spec('A'), f.spec('B'), f.spec('C')]);
  assert.equal(f.controllers.length, 1);
  manager.updateMaxConcurrent(2);
  assert.equal(f.controllers.length, 2);
  manager.updateMaxConcurrent(1);
  assert.equal(manager.status().runningCount, 2);
  assert.equal(manager.status().queuedCount, 1);
  assert.throws(() => manager.updateMaxConcurrent(0), /正整数/);
  await manager.close();
  const restored = await f.create();
  assert.equal(restored.maxConcurrent, 1);
  assert.equal(f.controllers.length, 2);
  assert.ok(restored.status().workers.every(worker => worker.status === 'closed'));
});

test('同批前置任务验收后自动串行启动重叠范围，并交接完整结果', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const [design, implement, verify] = manager.dispatch([
    f.spec('设计', { access: 'write', scope: ['front'] }),
    f.spec('实现', { access: 'write', scope: ['front'], dependsOn: ['设计'] }),
    f.spec('验证', { scope: ['front'], dependsOn: ['实现'] }),
  ]);
  assert.equal(f.controllers.length, 1);
  assert.equal(manager.get(implement.id).data.queueReason, 'waiting_dependencies');
  const completeText = '设计详细说明'.repeat(2000);
  f.controllers[0].emit('result', { success: true, text: completeText, sessionId: 'design-session' });
  assert.equal(f.controllers.length, 1);
  manager.review(design.id, true, '接口设计已核对', '保持错误码 E_AUTH');
  await tick();
  assert.equal(f.controllers.length, 2);
  const developer = f.controllers[1];
  assert.match(developer.options.worker.instructions, /保持错误码 E_AUTH/);
  assert.match(developer.options.worker.instructions, /接口设计已核对/);
  let text = '', offset = 0;
  for (;;) {
    const page = developer.options.readDependency('设计', offset, 4000);
    text += page.text;
    offset = page.nextOffset;
    if (!page.hasMore) break;
  }
  assert.equal(JSON.parse(text).text, completeText);
  assert.throws(() => developer.options.readDependency('验证'), /声明的前置依赖/);
  const event = (await manager.events()).events.find(event => event.type === 'result');
  assert.ok(event.data.text.length <= 2000);
  assert.equal(event.data.resultId, manager.get(design.id).data.lastResult.resultId);
  developer.emit('result', { success: true, text: '实现完成', sessionId: 'implement-session' });
  manager.review(implement.id, true, '实现通过');
  await tick();
  assert.equal(f.controllers.length, 3);
  assert.equal(manager.get(verify.id).data.status, 'running');
  assert.ok(f.controllers.slice(0, 2).every(controller => controller.closeCalls === 1));
});

test('依赖可前向引用且循环、缺失依赖和无序写冲突整批拒绝', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  for (const specs of [
    [f.spec('A', { dependsOn: ['A'] })],
    [f.spec('A', { dependsOn: ['B'] }), f.spec('B', { dependsOn: ['A'] })],
    [f.spec('A', { dependsOn: ['不存在'] })],
    [f.spec('A', { access: 'write' }), f.spec('B', { access: 'write' })],
  ]) {
    assert.throws(() => manager.dispatch(specs), /循环|未找到|冲突/);
    assert.equal(manager.workers.size, 0);
    assert.equal(manager.store.listWorkers().length, 0);
    assert.equal(f.controllers.length, 0);
  }
  const [second, first] = manager.dispatch([
    f.spec('后执行', { access: 'write', dependsOn: ['先执行'] }),
    f.spec('先执行', { access: 'write' }),
  ]);
  assert.equal(manager.get(second.id).data.status, 'queued');
  assert.equal(manager.get(first.id).data.status, 'running');
});

test('共同前置任务不允许两个同范围后继并发写，显式传递链可以串行', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  assert.throws(() => manager.dispatch([
    f.spec('A', { access: 'write', scope: ['front'] }),
    f.spec('B', { access: 'write', scope: ['front'], dependsOn: ['A'] }),
    f.spec('C', { access: 'write', scope: ['front'], dependsOn: ['A'] }),
  ]), /冲突/);
  const workers = manager.dispatch([
    f.spec('A', { access: 'write', scope: ['front'] }),
    f.spec('B', { scope: ['back'], dependsOn: ['A'] }),
    f.spec('C', { access: 'write', scope: ['front/nested'], dependsOn: ['B'] }),
  ]);
  assert.equal(workers.length, 3);
  assert.equal(f.controllers.length, 1);
});

test('依赖失败与拒绝验收显示阻塞，修复通过后下游自动继续', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const [a, b] = manager.dispatch([f.spec('A'), f.spec('B', { dependsOn: ['A'] })]);
  f.controllers[0].emit('result', { success: false, text: '测试失败' });
  assert.equal(manager.get(b.id).data.status, 'blocked');
  assert.equal(manager.get(b.id).data.blockedBy[0].error, '测试失败');
  manager.send(a.id, '修复测试');
  assert.equal(manager.get(b.id).data.status, 'queued');
  f.controllers[0].emit('result', { success: true, text: '修复完成' });
  manager.review(a.id, false, '遗漏边界');
  assert.equal(manager.get(b.id).data.status, 'blocked');
  manager.send(a.id, '补充边界');
  f.controllers[0].emit('result', { success: true, text: '所有检查通过' });
  manager.review(a.id, true, '通过');
  assert.equal(manager.get(b.id).data.status, 'running');
  assert.equal(f.controllers.length, 2);
});

test('取消尚未启动任务不会创建进程，原名resume保留原任务和追加要求再排队', async t => {
  const f = await fixture(t);
  const manager = await f.create({ maxConcurrent: 1 });
  const [a, b, c] = manager.dispatch([f.spec('A'), f.spec('B'), f.spec('C', { dependsOn: ['B'] })]);
  manager.send(b.id, '保留这条补充要求');
  await manager.closeWorker(b.id);
  assert.equal(f.controllers.length, 1);
  assert.equal(manager.get(c.id).data.status, 'blocked');
  manager.resume(b.id, '请继续');
  assert.equal(manager.get(b.id).data.status, 'queued');
  assert.equal(manager.get(c.id).data.status, 'queued');
  await manager.closeWorker(a.id);
  assert.equal(f.controllers.length, 2);
  assert.deepEqual(f.controllers[1].sent.map(message => message.text), ['执行 B', '保留这条补充要求', '请继续']);
});

test('正常shutdown后重开保留未投递要求，显式resume前不启动任务', async t => {
  const f = await fixture(t);
  const manager = await f.create({ maxConcurrent: 1 });
  const [, b] = manager.dispatch([f.spec('A'), f.spec('B')]);
  manager.send(b.id, '关机前追加要求');
  await manager.close();
  const restored = await f.create();
  assert.equal(restored.get(b.id).data.status, 'closed');
  assert.equal(restored.get(b.id).data.queuedMessages.length, 2);
  assert.equal(restored.status().runningCount, 0);
  assert.equal(f.controllers.length, 1);
  restored.resume(b.id, '请恢复');
  assert.deepEqual(f.controllers.at(-1).sent.map(message => message.text), ['执行 B', '关机前追加要求', '请恢复']);
});

test('满32条队列仍能恢复，补充并入末条未投递消息且返回对应ID', async t => {
  const f = await fixture(t);
  const manager = await f.create({ maxConcurrent: 1 });
  const [a, b] = manager.dispatch([f.spec('A'), f.spec('B')]);
  for (let index = 1; index <= 31; index++) manager.send(b.id, `追加要求${index}`);
  await manager.closeWorker(b.id);
  const queued = manager.get(b.id).data.queuedMessages.map(message => ({ ...message }));
  const resumed = manager.resume(b.id, '恢复时务必检查所有要求');
  assert.equal(resumed.messageId, queued.at(-1).messageId);
  assert.equal(manager.get(b.id).data.queuedMessages.length, 32);
  assert.equal(f.controllers.length, 1);
  await manager.closeWorker(a.id);
  assert.equal(f.controllers.length, 2);
  assert.equal(f.controllers[1].sent.length, 32);
  assert.deepEqual(f.controllers[1].sent.slice(0, -1), queued.slice(0, -1));
  assert.deepEqual(f.controllers[1].sent.at(-1), {
    messageId: resumed.messageId,
    text: '追加要求31\n\n主控恢复补充指令：\n恢复时务必检查所有要求',
  });
});

test('恢复写盘或记录事件失败保留closed和完整队列，其他调度不会偷偷启动', async t => {
  const f = await fixture(t);
  const manager = await f.create({ maxConcurrent: 1 });
  const [a, b] = manager.dispatch([f.spec('A'), f.spec('B')]);
  for (let index = 1; index <= 31; index++) manager.send(b.id, `追加要求${index}`);
  await manager.closeWorker(b.id);
  const previous = JSON.parse(JSON.stringify(manager.get(b.id).data));
  for (const method of ['saveWorker', 'append']) {
    const original = manager.store[method];
    manager.store[method] = () => { throw new Error('模拟恢复写入失败'); };
    try {
      assert.throws(() => manager.resume(b.id, '未成功恢复的补充'), /模拟恢复写入失败/);
    } finally {
      manager.store[method] = original;
    }
    assert.deepEqual(JSON.parse(JSON.stringify(manager.get(b.id).data)), previous);
    assert.deepEqual(manager.store.listWorkers().find(worker => worker.id === b.id), previous);
  }
  await manager.closeWorker(a.id);
  assert.equal(f.controllers.length, 1);
  assert.equal(manager.get(b.id).data.status, 'closed');
  manager.resume(b.id, '重试恢复');
  assert.equal(f.controllers.length, 2);
  assert.match(f.controllers[1].sent.at(-1).text, /重试恢复/);
  assert.doesNotMatch(f.controllers[1].sent.at(-1).text, /未成功恢复的补充/);
});

test('显式send传入更新后的团队约束，不另开模型轮次并使旧验收失效', async t => {
  const f = await fixture(t);
  const manager = await f.create({ constraints: '初始约束' });
  const [a] = manager.dispatch([f.spec('A')]);
  const controller = f.controllers[0];
  controller.emit('result', { success: true, text: '完成' });
  manager.review(a.id, true, '通过');
  manager.updateConstraints('禁止写入配置');
  assert.equal(controller.sent.length, 1);
  manager.send(a.id, '检查下一项');
  assert.equal(controller.sent.length, 2);
  assert.match(controller.sent[1].text, /禁止写入配置/);
  assert.equal(manager.get(a.id).data.lastReview, undefined);
  manager.send(a.id, '再补充');
  assert.equal(controller.sent[2].text, '再补充');
});

test('中断和后台任务结果不能验收，后台结束后可继续发送任务', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const [a, b] = manager.dispatch([f.spec('A'), f.spec('B', { dependsOn: ['A'] })]);
  const controller = f.controllers[0];
  controller.emit('result', { success: false, interrupted: true, text: '已中断' });
  assert.equal(manager.get(a.id).data.status, 'idle');
  assert.throws(() => manager.review(a.id, true, '不应通过'), /待验收/);
  assert.equal(manager.get(b.id).data.status, 'queued');
  manager.send(a.id, '继续');
  controller.emit('background_tasks', { tasks: [{ task_id: 'task-1' }] });
  controller.emit('result', { success: false, background: true, text: '后台继续' });
  assert.equal(manager.get(a.id).data.status, 'running');
  assert.throws(() => manager.review(a.id, true, '不应通过'), /待验收/);
  controller.emit('background_tasks', { tasks: [] });
  assert.equal(manager.get(a.id).data.status, 'idle');
});

test('新会话打开保存的队列只恢复记录，需显式resume再运行', async t => {
  const f = await fixture(t);
  const manager = await f.create({ maxConcurrent: 1 });
  const [a, b] = manager.dispatch([f.spec('A'), f.spec('B')]);
  const saved = manager.get(b.id).data;
  manager.store.saveWorker({ ...saved, status: 'queued' });
  await manager.closeWorker(a.id);
  await manager.close();
  // 模拟异常退出前持久化了未启动记录。
  const reopened = await f.create();
  reopened.store.saveWorker({ ...saved, status: 'queued', startedAt: undefined, sessionId: null, lastPid: undefined });
  await reopened.close();
  const restored = await f.create();
  assert.equal(restored.get(b.id).data.status, 'stopped');
  const count = f.controllers.length;
  assert.equal(restored.status().runningCount, 0);
  restored.resume(b.id, '恢复排队任务');
  assert.equal(f.controllers.length, count + 1);
});

test('成功结果之后进程自然退出仍可验收并释放依赖', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const [a, b] = manager.dispatch([f.spec('A', { access: 'write' }), f.spec('B', { access: 'write', dependsOn: ['A'] })]);
  f.controllers[0].emit('result', { success: true, text: '已完成完整交付', sessionId: 'session-a' });
  f.controllers[0].finished.resolve();
  await tick();
  assert.equal(manager.get(a.id).controller, null);
  assert.equal(manager.get(a.id).data.status, 'awaiting_review');
  manager.review(a.id, true, '检查通过');
  assert.equal(manager.get(b.id).data.status, 'running');
});

test('恢复未启动队列保留断连前已接受的所有追加要求', async t => {
  const f = await fixture(t);
  const manager = await f.create({ maxConcurrent: 1 });
  const [, b] = manager.dispatch([f.spec('A'), f.spec('B')]);
  manager.send(b.id, 'IMPORTANT-QUEUED-CHANGE');
  const saved = JSON.parse(JSON.stringify(manager.get(b.id).data));
  await manager.close();
  const writer = await f.create();
  writer.store.saveWorker(saved);
  await writer.close();
  const restored = await f.create();
  assert.equal(restored.get(b.id).data.queuedMessages.length, 2);
  restored.resume(b.id, 'CONTINUE');
  assert.deepEqual(f.controllers.at(-1).sent.map(message => message.text), ['执行 B', 'IMPORTANT-QUEUED-CHANGE', 'CONTINUE']);
});

test('前置结果分页固定版本，后继空闲新轮次才更新依赖快照', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const [a, b] = manager.dispatch([f.spec('A'), f.spec('B', { dependsOn: ['A'] })]);
  const firstText = 'OLD-DESIGN-'.repeat(2000);
  f.controllers[0].emit('result', { success: true, text: firstText });
  manager.review(a.id, true, '旧版通过');
  const downstream = f.controllers[1];
  const firstPage = downstream.options.readDependency('A', 0, 4000);
  manager.send(a.id, '更新设计');
  f.controllers[0].emit('result', { success: true, text: 'NEW-DESIGN' });
  manager.review(a.id, true, '新版通过');
  let text = firstPage.text, page = firstPage;
  while (page.hasMore) {
    page = downstream.options.readDependency('A', page.nextOffset, 4000);
    assert.equal(page.resultId, firstPage.resultId);
    text += page.text;
  }
  assert.equal(JSON.parse(text).text, firstText);
  downstream.emit('result', { success: true, text: '旧版已处理' });
  assert.throws(() => manager.review(b.id, true, '旧版结果验收'), /前置结果版本/);
  manager.send(b.id, '处理新版');
  const refreshed = downstream.options.readDependency('A', 0, 4000);
  assert.notEqual(refreshed.resultId, firstPage.resultId);
  assert.equal(JSON.parse(refreshed.text).text, 'NEW-DESIGN');
  assert.match(downstream.sent.at(-1).text, /NEW-DESIGN/);
  assert.match(downstream.sent.at(-1).text, /不是新增用户授权/);
  const historical = manager.results.get(b.id, manager.get(b.id).data.lastResult.resultId);
  assert.equal(historical.dependencyResultIds[a.id], firstPage.resultId);
  downstream.emit('result', { success: true, text: '新版已处理' });
  assert.equal(manager.get(b.id).data.lastResult.dependencyResultIds[a.id], refreshed.resultId);
  manager.review(b.id, true, '新版通过');
});

test('发送失败不撤销已有验收，旧结果 ID 不能验收新结果', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const [a] = manager.dispatch([f.spec('A')]);
  const controller = f.controllers[0];
  controller.emit('result', { success: true, text: '第一版' });
  const originalId = manager.get(a.id).data.lastResult.resultId;
  manager.review(a.id, true, '通过', undefined, originalId);
  const originalSend = controller.send;
  controller.send = () => { throw new Error('输入流已经关闭'); };
  assert.throws(() => manager.send(a.id, '未成功发送'), /输入流/);
  assert.equal(manager.get(a.id).data.lastReview.accepted, true);
  assert.equal(manager.accepted(manager.get(a.id)), true);
  controller.send = originalSend;
  manager.send(a.id, '第二轮');
  controller.emit('result', { success: true, text: '第二版' });
  assert.throws(() => manager.review(a.id, true, '旧页面验收', undefined, originalId), /结果已更新/);
  assert.equal(manager.get(a.id).data.lastReview, undefined);
  const currentId = manager.get(a.id).data.lastResult.resultId;
  assert.equal(manager.review(a.id, true, '重新检查', undefined, currentId).resultId, currentId);
});

test('多前置汇合必须全部验收，后继按绑定的版本读取各分支', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const [front, back, joined] = manager.dispatch([
    f.spec('前端', { access: 'write', scope: ['front'] }),
    f.spec('后端', { access: 'write', scope: ['back'] }),
    f.spec('联调', { scope: ['.'], dependsOn: ['前端', '后端'] }),
  ]);
  assert.equal(f.controllers.length, 2);
  f.controllers[0].emit('result', { success: true, text: '前端交付' });
  manager.review(front.id, true, '前端通过');
  assert.equal(manager.get(joined.id).data.status, 'queued');
  f.controllers[1].emit('result', { success: true, text: '后端交付' });
  manager.review(back.id, true, '后端通过');
  await tick();
  assert.equal(f.controllers.length, 3);
  assert.equal(manager.get(joined.id).data.status, 'running');
  assert.equal(JSON.parse(f.controllers[2].options.readDependency(front.id, 0, 12000).text).text, '前端交付');
  assert.equal(JSON.parse(f.controllers[2].options.readDependency(back.id, 0, 12000).text).text, '后端交付');
});

test('成功结果仍有后台任务时保持运行，后台清空后进入待验收', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const [a] = manager.dispatch([f.spec('A')]);
  const controller = f.controllers[0];
  controller.emit('background_tasks', { tasks: [{ task_id: 'active-task' }] });
  controller.emit('result', { success: true, text: '主体已完成' });
  assert.equal(manager.status().workers[0].status, 'running');
  assert.equal(manager.status().workers[0].backgroundTasks[0].task_id, 'active-task');
  assert.throws(() => manager.review(a.id, true, '提前验收'), /待验收/);
  controller.emit('background_tasks', { tasks: [] });
  assert.equal(manager.get(a.id).data.status, 'awaiting_review');
  manager.review(a.id, true, '全部结束');
});

test('排队期间联接目标变化显示明确冲突，追加已运行任务也重新检查实际范围', async t => {
  const f = await fixture(t);
  const manager = await f.create({ maxConcurrent: 1 });
  const link = path.join(f.cwd, 'selected');
  symlinkSync(path.join(f.cwd, 'front'), link, 'junction');
  try {
    const [a, b] = manager.dispatch([
      f.spec('A', { access: 'write', scope: ['back'] }),
      f.spec('B', { access: 'write', scope: ['selected'] }),
    ]);
    unlinkSync(link);
    symlinkSync(path.join(f.cwd, 'back'), link, 'junction');
    manager.updateMaxConcurrent(2);
    assert.equal(manager.get(b.id).data.status, 'blocked');
    assert.equal(manager.get(b.id).data.queueReason, 'scope_conflict');
    assert.match(manager.get(b.id).data.error, /冲突/);
    assert.equal(f.controllers.length, 1);
    unlinkSync(link);
    symlinkSync(path.join(f.cwd, 'front'), link, 'junction');
    manager.updateMaxConcurrent(2);
    assert.equal(manager.get(b.id).data.status, 'running');
    unlinkSync(link);
    symlinkSync(path.join(f.cwd, 'back'), link, 'junction');
    assert.throws(() => manager.send(b.id, '继续修改'), /冲突/);
    assert.equal(f.controllers[1].sent.length, 1);
    assert.equal(manager.get(a.id).data.status, 'running');
  } finally {
    assert.ok(lstatSync(link).isSymbolicLink());
    unlinkSync(link);
  }
});

test('迟到进展不会复活待验收或已关闭状态，旧进程事件不能污染恢复后的工作者', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const [a] = manager.dispatch([f.spec('A')]);
  const controller = f.controllers[0];
  controller.emit('result', { success: true, text: '完成', sessionId: 'session-a' });
  controller.emit('progress', { summary: '迟到进度' });
  assert.equal(manager.get(a.id).data.status, 'awaiting_review');
  manager.review(a.id, true, '通过');
  controller.emit('activity', { tool: 'Read' });
  assert.equal(manager.get(a.id).data.status, 'idle');
  controller.closeGate = deferred();
  const closing = manager.closeWorker(a.id);
  await assert.rejects(controller.request('permission', { toolName: 'Write', input: {} }), /请求已取消/);
  assert.equal(manager.get(a.id).data.status, 'closing');
  controller.closeGate.resolve();
  await closing;
  controller.emit('progress', { summary: '关闭后进度' });
  assert.equal(manager.get(a.id).data.status, 'closed');
  manager.resume(a.id, '新一轮');
  controller.emit('result', { success: false, text: '旧进程失败' });
  await assert.rejects(controller.request('permission', { toolName: 'Write', input: {} }), /原工作进程已结束/);
  assert.throws(() => controller.options.readDependency('A'), /原工作进程已结束/);
  assert.equal(manager.status().workers[0].requests.length, 0);
  assert.equal(manager.get(a.id).data.status, 'running');
  assert.equal(manager.get(a.id).data.error, undefined);
});

test('前置版本变化使整条旧交付链失效，重新执行并验收后才启动后继', async t => {
  const f = await fixture(t);
  const manager = await f.create();
  const [a, b] = manager.dispatch([f.spec('A'), f.spec('B', { dependsOn: ['A'] })]);
  const ca = f.controllers[0];
  ca.emit('result', { success: true, text: 'A1', sessionId: 'session-a' });
  manager.review(a.id, true, 'A1通过');
  const cb = f.controllers[1];
  cb.emit('result', { success: true, text: 'B1', sessionId: 'session-b' });
  manager.review(b.id, true, 'B1通过');
  await manager.closeWorker(a.id);
  await manager.closeWorker(b.id);
  manager.resume(a.id, '更新为A2');
  f.controllers[2].emit('result', { success: true, text: 'A2', sessionId: 'session-a' });
  manager.review(a.id, true, 'A2通过');
  const bStatus = manager.status([b.id]).workers[0];
  assert.equal(bStatus.lastReview.accepted, true);
  assert.equal(bStatus.acceptedCurrent, false);
  assert.equal(bStatus.staleDependencies.length, 1);
  assert.notEqual(bStatus.staleDependencies[0].expectedResultId, bStatus.staleDependencies[0].currentResultId);
  const [c, d] = manager.dispatch([f.spec('C', { dependsOn: ['B'] }), f.spec('D', { dependsOn: ['C'] })]);
  assert.equal(manager.get(c.id).data.status, 'blocked');
  assert.equal(manager.get(c.id).data.queueReason, 'dependency_stale');
  assert.equal(manager.get(d.id).data.status, 'blocked');
  assert.equal(f.controllers.length, 3);
  manager.resume(b.id, '基于A2重做');
  f.controllers[3].emit('result', { success: true, text: 'B2', sessionId: 'session-b' });
  manager.review(b.id, true, 'B2通过');
  assert.equal(manager.status([b.id]).workers[0].acceptedCurrent, true);
  assert.equal(manager.get(c.id).data.status, 'running');
  assert.equal(manager.get(d.id).data.status, 'queued');
  assert.equal(f.controllers.length, 5);
});
