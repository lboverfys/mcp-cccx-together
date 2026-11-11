import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { TeamManager } from '../src/manager.mjs';

const tempRoot = process.env.TEMP || process.env.TMP;
if (!tempRoot || !/^D:[\\/]/i.test(path.resolve(tempRoot))) {
  throw new Error('测试要求 TEMP 或 TMP 指向 D 盘任务临时目录');
}

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
