import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTeamServer } from '../src/server.mjs';
import { TeamManager } from '../src/manager.mjs';

const tempRoot = tmpdir();
const tick = () => new Promise(resolve => setImmediate(resolve));

test('客户端在团队初始化期间关闭时等待初始化并释放锁', async t => {
  const f = await fixture(t);
  const endpoint = await f.connect();
  const original = TeamManager.prototype.init;
  let proceed;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { proceed = resolve; });
  t.mock.method(TeamManager.prototype, 'init', async function () {
    entered();
    await gate;
    return original.call(this);
  });
  const opening = endpoint.call('team_open', { teamId: 'close-during-open', notifications: false });
  await started;
  let closed = false;
  const closing = endpoint.app.close().then(() => { closed = true; });
  await tick();
  assert.equal(closed, false);
  proceed();
  await Promise.all([opening, closing]);
  assert.equal(existsSync(path.join(f.config.stateDir, 'close-during-open', 'store.lock')), false);
  assert.equal((await endpoint.raw('team_open', { teamId: 'late' })).isError, true);
});

test('默认轮询不启用专属通知，历史团队列表分页且无需先打开团队', async t => {
  const f = await fixture(t);
  delete f.config.notificationMode;
  const endpoint = await f.connect();
  assert.deepEqual((await endpoint.call('team_list')).teams, []);
  const opened = await endpoint.call('team_open', { teamId: 'alpha', parentThreadId: randomUUID() });
  assert.equal(opened.notifications, false);
  assert.equal(f.notifiers[0].threadId, undefined);
  await endpoint.call('team_shutdown');
  await endpoint.call('team_open', { teamId: 'beta' });
  const first = await endpoint.call('team_list', { limit: 1 });
  assert.deepEqual(first, { teams: [{ teamId: 'alpha', current: false }], nextOffset: 1, hasMore: true, total: 2 });
  const second = await endpoint.call('team_list', { offset: first.nextOffset, limit: 1 });
  assert.deepEqual(second.teams, [{ teamId: 'beta', current: true }]);
  assert.equal(second.hasMore, false);
});

test('团队约束跨 shutdown/open 保留，显式空串允许清空', async t => {
  const f = await fixture(t);
  const endpoint = await f.connect();
  await endpoint.call('team_open', { teamId: 'constraints', constraints: '只在授权路径工作', notifications: false });
  await endpoint.call('team_shutdown');
  const restored = await endpoint.call('team_open', { teamId: 'constraints', notifications: false });
  assert.equal(restored.constraints, '只在授权路径工作');
  await endpoint.call('team_dispatch', { workers: [f.spec('审查')] });
  assert.match(f.controllers[0].options.worker.instructions, /只在授权路径工作/);
  const listed = (await endpoint.call('team_list')).teams[0];
  assert.equal(listed.workerCount, 1);
  assert.deepEqual(listed.workerNames, ['审查cc']);
  assert.deepEqual(listed.projects, [f.controllers[0].options.worker.cwd]);
  await endpoint.call('team_open', { teamId: 'constraints', constraints: '', notifications: false });
  await endpoint.call('team_dispatch', { workers: [f.spec('验证')] });
  assert.doesNotMatch(f.controllers[1].options.worker.instructions, /只在授权路径工作/);
});

test('事件窗口滚动后完整交付仍可按历史ID读取，旧结果ID无法验收新轮次', async t => {
  const f = await fixture(t);
  const endpoint = await f.connect();
  await endpoint.call('team_open', { teamId: 'durable-results', notifications: false });
  await endpoint.call('team_dispatch', { workers: [f.spec('长交付')] });
  const text = '完整接口约定𠮷'.repeat(2000);
  f.controllers[0].emit('result', { success: true, text });
  const resultId = (await endpoint.call('team_status')).workers[0].lastResult.resultId;
  for (let i = 0; i < 2005; i++) f.controllers[0].emit('progress', { summary: `后续事件 ${i}` });
  const events = await endpoint.call('team_events');
  assert.equal(events.gap, true);
  const readAll = async id => {
    let offset = 0, joined = '';
    for (;;) {
      const page = await endpoint.call('team_result', { workerId: '长交付cc', resultId: id, offset, limit: 4096 });
      joined += page.text;
      if (!page.hasMore) return JSON.parse(joined);
      offset = page.nextOffset;
    }
  };
  assert.equal((await readAll(resultId)).text, text);
  await endpoint.call('team_send', { workerId: '长交付cc', message: '新一轮' });
  f.controllers[0].emit('result', { success: true, text: '新版交付' });
  const stale = await endpoint.raw('team_review', { workerId: '长交付cc', resultId, accepted: true, note: '旧验收' });
  assert.equal(stale.isError, true);
  await endpoint.call('team_shutdown');
  await endpoint.call('team_open', { teamId: 'durable-results', notifications: false });
  assert.equal((await readAll(resultId)).text, text);
});

async function fixture(t) {
  const dir = mkdtempSync(path.join(tempRoot, 'server-test-'));
  const cwd = path.join(dir, 'workspace');
  mkdirSync(cwd);
  const config = {
    stateDir: path.join(dir, 'state'), tempDir: path.join(dir, 'runtime'),
    claudeExecutable: process.execPath, codexExecutable: process.execPath, notificationMode: 'codex-queue',
  };
  const endpoints = [];
  const controllers = [];
  const notifiers = [];
  const factory = options => {
    let finish;
    const controller = {
      options, done: new Promise(resolve => { finish = resolve; }),
      sent: [], closeCalls: 0, interruptCalls: 0,
      send(text, messageId) { this.sent.push({ text, messageId }); },
      async interrupt() { this.interruptCalls++; return { interrupted: true }; },
      async close() { this.closeCalls++; finish(); },
      emit: options.emit, request: options.request,
    };
    controllers.push(controller);
    return controller;
  };
  const notifierFactory = options => {
    const notifier = {
      options, threadId: options.threadId, events: [], closed: false, lastDelivery: null,
      setThread(value) { this.threadId = value; },
      notify(event) { this.events.push(event); },
      async close() { this.closed = true; },
    };
    notifiers.push(notifier);
    return notifier;
  };
  const connect = async () => {
    const app = createTeamServer(config, { factory, notifierFactory });
    const client = new Client({ name: 'cc-team-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const endpoint = {
      app, client,
      raw(name, args = {}) {
        return client.callTool({ name, arguments: args }, undefined, { timeout: 2500 });
      },
      async call(name, args = {}) {
        const result = await this.raw(name, args);
        assert.notEqual(result.isError, true, result.content?.[0]?.text);
        return JSON.parse(result.content[0].text);
      },
    };
    endpoints.push(endpoint);
    await app.server.connect(serverTransport);
    await client.connect(clientTransport);
    return endpoint;
  };
  t.after(async () => {
    for (const { app, client } of endpoints.reverse()) {
      await app.close();
      await client.close();
      await app.server.close();
    }
    const relative = path.relative(path.resolve(tempRoot), path.resolve(dir));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    rmSync(dir, { recursive: true, force: true });
  });
  const spec = (name, extra = {}) => ({ name, cwd, prompt: `执行 ${name}`, ...extra });
  return { dir, cwd, config, controllers, notifiers, connect, spec };
}

test('MCP 传递 mct/ctm 委派说明并暴露全部 14 个工具，未打开团队时返回工具错误', async t => {
  const f = await fixture(t);
  const endpoint = await f.connect();
  const { tools } = await endpoint.client.listTools();
  const instructions = endpoint.client.getInstructions();
  for (const alias of ['mct', 'ctm']) {
    assert.ok(instructions.includes(`使用 ${alias}`));
    for (const name of ['team_open', 'team_dispatch']) {
      assert.ok(tools.find(tool => tool.name === name).description.includes(alias));
    }
  }
  assert.match(instructions, /不区分大小写/);
  assert.match(instructions, /通过本 MCP 委派 Claude Code（CC）子 agent/);
  assert.match(instructions, /team_open.*team_dispatch/);
  assert.match(instructions, /无需再次确认是否启用/);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'team_open', 'team_dispatch', 'team_status', 'team_events', 'team_send', 'team_reply',
    'team_request', 'team_interrupt', 'team_resume', 'team_review', 'team_close', 'team_shutdown', 'team_list', 'team_result',
  ].sort());
  for (const name of ['team_status', 'team_events', 'team_request']) {
    assert.equal(tools.find(tool => tool.name === name).annotations.readOnlyHint, true);
  }
  const result = await endpoint.raw('team_status');
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /先调用 team_open/);
  assert.equal(f.controllers.length, 0);
  const malformed = await endpoint.raw('team_open', { parentThreadId: 'a-name-instead-of-uuid' });
  assert.equal(malformed.isError, true);
  assert.equal(f.notifiers.length, 0);
});

test('派发经 MCP 立即返回，schema 默认只读，批量任务保留各自消息', async t => {
  const f = await fixture(t);
  const endpoint = await f.connect();
  const parentThreadId = randomUUID();
  const opened = await endpoint.call('team_open', { teamId: 'dispatch-team', parentThreadId, constraints: '仅做本任务，不提交' });
  assert.equal(opened.notifications, true);
  assert.equal(f.controllers.length, 0);
  const dispatched = await endpoint.call('team_dispatch', { workers: [f.spec('A'), f.spec('B')] });
  assert.equal(dispatched.workers.length, 2);
  assert.equal(f.controllers.length, 2);
  assert.deepEqual(f.controllers.map(item => item.options.worker.access), ['read', 'read']);
  assert.deepEqual(f.controllers.map(item => item.options.worker.scope), [['.'], ['.']]);
  assert.deepEqual(f.controllers.map(item => item.options.worker.allowedTools), [[], []]);
  assert.match(f.controllers[0].options.worker.instructions, /仅做本任务，不提交/);
  assert.deepEqual(f.controllers.map(item => item.sent[0].text), ['执行 A', '执行 B']);
  assert.ok(f.controllers.every(item => item.closeCalls === 0));
  const status = await endpoint.call('team_status');
  assert.deepEqual(status.workers.map(worker => worker.status), ['running', 'running']);
  assert.equal(f.notifiers[0].threadId, parentThreadId);
  assert.equal(status.workers[0].pendingMessages, 1);
});

test('写任务缺少显式 scope 时整批拒绝，明确范围后才能启动', async t => {
  const f = await fixture(t);
  const endpoint = await f.connect();
  await endpoint.call('team_open', { notifications: false });
  const invalid = await endpoint.raw('team_dispatch', { workers: [f.spec('读取'), f.spec('修改', { access: 'write' })] });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /scope/);
  assert.equal(f.controllers.length, 0);
  assert.deepEqual((await endpoint.call('team_status')).workers, []);
  await endpoint.call('team_dispatch', { workers: [f.spec('修改', { access: 'write', scope: ['src'] })] });
  assert.equal(f.controllers.length, 1);
  assert.deepEqual(f.controllers[0].options.worker.scope, ['src']);
});

test('完整结果续页和验收必须绑定结果版本，缺失参数不放行下游', async t => {
  const f = await fixture(t);
  const endpoint = await f.connect();
  await endpoint.call('team_open', { notifications: false });
  await endpoint.call('team_dispatch', { workers: [f.spec('实现'), f.spec('验证', { dependsOn: ['实现cc'] })] });
  f.controllers[0].emit('result', { success: true, text: '已完成实现'.repeat(50) });
  const first = await endpoint.call('team_result', { workerId: '实现cc', limit: 80 });
  assert.equal(first.hasMore, true);
  const unpinnedPage = await endpoint.raw('team_result', { workerId: '实现cc', offset: first.nextOffset });
  assert.equal(unpinnedPage.isError, true);
  assert.match(unpinnedPage.content[0].text, /resultId/);
  const unpinnedReview = await endpoint.raw('team_review', { workerId: '实现cc', accepted: true, note: '未指定版本' });
  assert.equal(unpinnedReview.isError, true);
  assert.equal(f.controllers.length, 1);
  await endpoint.call('team_send', { workerId: '实现cc', message: '更新实现' });
  f.controllers[0].emit('result', { success: true, text: '新一轮结果' });
  const oldPage = await endpoint.call('team_result', { workerId: '实现cc', resultId: first.resultId, offset: first.nextOffset });
  assert.equal(JSON.parse(first.text + oldPage.text).text, '已完成实现'.repeat(50));
  const stale = await endpoint.raw('team_review', { workerId: '实现cc', resultId: first.resultId, accepted: true, note: '旧版本' });
  assert.equal(stale.isError, true);
  assert.equal(f.controllers.length, 1);
  const current = await endpoint.call('team_result', { workerId: '实现cc' });
  await endpoint.call('team_review', { workerId: '实现cc', resultId: current.resultId, accepted: true, note: '已核对新版结果' });
  assert.equal(f.controllers.length, 2);
});

test('多选问题通过 MCP 传递数组，空数组被拒绝且请求仍可回答', async t => {
  const f = await fixture(t);
  const endpoint = await f.connect();
  await endpoint.call('team_open', { notifications: false });
  await endpoint.call('team_dispatch', { workers: [f.spec('提问')] });
  const pending = f.controllers[0].request('question', { questions: [{ question: '选择验证平台', multiSelect: true }] });
  const requestId = (await endpoint.call('team_status')).workers[0].requests[0].id;
  const invalid = await endpoint.raw('team_reply', { requestId, answers: { '选择验证平台': [] } });
  assert.equal(invalid.isError, true);
  assert.equal((await endpoint.call('team_status')).workers[0].requests.length, 1);
  const answers = { '选择验证平台': ['Windows', 'macOS'] };
  await endpoint.call('team_reply', { requestId, answers });
  assert.deepEqual(await pending, { answers });
});

test('超过旧批次上限后仍可按需追加、恢复及批量筛选关闭工作者', async t => {
  const f = await fixture(t);
  const endpoint = await f.connect();
  await endpoint.call('team_open', { teamId: 'unlimited-team', notifications: false, maxConcurrent: 40 });
  const first = await endpoint.call('team_dispatch', {
    workers: Array.from({ length: 24 }, (_, i) => f.spec(`协作${i}`)),
  });
  const second = await endpoint.call('team_dispatch', {
    workers: Array.from({ length: 8 }, (_, i) => f.spec(`协作${i + 24}`)),
  });
  const workers = [...first.workers, ...second.workers];
  const names = workers.map(worker => worker.name);
  assert.equal(workers.length, 32);
  assert.equal(f.controllers.length, 32);
  assert.equal((await endpoint.call('team_status', { workerIds: names })).workers.length, 32);
  const events = await endpoint.call('team_events', { workerIds: names });
  assert.equal(new Set(events.events.map(event => event.workerId)).size, 32);
  const sessionId = randomUUID();
  f.controllers[0].emit('session', { sessionId });
  await endpoint.call('team_close', { workerIds: [names[0]] });
  await endpoint.call('team_resume', { workerId: names[0], message: '继续原任务' });
  assert.equal(f.controllers.length, 33);
  assert.equal(f.controllers.at(-1).options.worker.sessionId, sessionId);
  assert.equal((await endpoint.call('team_status')).workers.filter(worker => worker.status === 'running').length, 32);
  const closed = await endpoint.call('team_close', { workerIds: names });
  assert.equal(closed.workers.length, 32);
  assert.ok(closed.workers.every(worker => worker.status === 'closed'));
  assert.ok(f.controllers.every(controller => controller.closeCalls === 1));
});

test('等待事件时 MCP 仍能接收 send，游标不会重复交付', async t => {
  const f = await fixture(t);
  const endpoint = await f.connect();
  await endpoint.call('team_open', { teamId: 'events-team', notifications: false });
  const { workers: [worker] } = await endpoint.call('team_dispatch', { workers: [f.spec('A')] });
  const initial = await endpoint.call('team_events');
  const pending = endpoint.call('team_events', { after: initial.nextCursor, workerIds: [worker.id], waitMs: 1000 });
  await tick();
  const sent = await endpoint.call('team_send', { workerId: worker.id, message: '补充要求' });
  assert.equal(sent.status, 'queued');
  assert.equal(sent.processed, false);
  const events = await pending;
  assert.equal(events.events.length, 1);
  assert.equal(events.events[0].type, 'message_queued');
  assert.equal(events.events[0].data.messageId, sent.messageId);
  assert.deepEqual((await endpoint.call('team_events', { after: events.nextCursor })).events, []);
});

test('MCP 问题答复与权限答复正确路由，完整请求可以分页读取', async t => {
  const f = await fixture(t);
  const endpoint = await f.connect();
  await endpoint.call('team_open', { teamId: 'requests-team', notifications: false });
  const { workers: [worker] } = await endpoint.call('team_dispatch', { workers: [f.spec('A')] });
  const controller = f.controllers[0];
  const question = controller.request('question', { questions: [{ question: '选择哪个方案？' }] });
  const state = await endpoint.call('team_status');
  assert.equal(state.workers[0].status, 'needs_input');
  const questionId = state.workers[0].requests[0].id;
  const answered = await endpoint.call('team_reply', { requestId: questionId, text: '方案 A' });
  assert.equal(answered.answered, true);
  assert.deepEqual(await question, { text: '方案 A' });
  const late = await endpoint.raw('team_reply', { requestId: questionId, text: '过期答复' });
  assert.equal(late.isError, true);
  assert.match(late.content[0].text, /不存在或已取消/);

  const payload = { toolName: 'Write', input: { file_path: path.join(f.cwd, 'example.txt'), content: '只是测试输入'.repeat(7000) } };
  const permission = controller.request('permission', payload);
  const permissionId = (await endpoint.call('team_status')).workers[0].requests[0].id;
  const missingAllow = await endpoint.raw('team_reply', { requestId: permissionId, reason: '缺少显式决策' });
  assert.equal(missingAllow.isError, true);
  assert.match(missingAllow.content[0].text, /allow/);
  const requestEvent = (await endpoint.call('team_events')).events.find(event => event.data.requestId === permissionId);
  assert.equal(requestEvent.data.truncated, true);
  let offset = 0;
  let reconstructed = '';
  for (;;) {
    const page = await endpoint.call('team_request', { requestId: permissionId, offset, limit: 4096 });
    assert.equal(page.workerId, worker.id);
    assert.equal(page.offset, offset);
    assert.ok(page.text.length <= 4096);
    reconstructed += page.text;
    offset = page.nextOffset;
    if (!page.hasMore) break;
  }
  assert.deepEqual(JSON.parse(reconstructed), payload);
  await endpoint.call('team_reply', { requestId: permissionId, allow: false, reason: '仅测试，不执行文件写入' });
  assert.deepEqual(await permission, { allow: false, reason: '仅测试，不执行文件写入' });
  const stale = await endpoint.raw('team_request', { requestId: permissionId });
  assert.equal(stale.isError, true);
  assert.equal((await endpoint.call('team_status')).workers[0].status, 'running');
});

test('验收、关闭和 shutdown 保留会话，重开后可以恢复同一个工作者', async t => {
  const f = await fixture(t);
  const endpoint = await f.connect();
  const teamId = 'retained-team';
  await endpoint.call('team_open', { teamId, notifications: false });
  const { workers: [worker] } = await endpoint.call('team_dispatch', { workers: [f.spec('A')] });
  const controller = f.controllers[0];
  const sessionId = randomUUID();
  controller.emit('session', { sessionId });
  controller.emit('result', { success: true, text: '完成', messageIds: [controller.sent[0].messageId] });
  assert.equal((await endpoint.call('team_status')).workers[0].status, 'awaiting_review');
  const { resultId } = await endpoint.call('team_result', { workerId: worker.id });
  const reviewed = await endpoint.call('team_review', { workerId: worker.id, resultId, accepted: true, note: '核对验证通过' });
  assert.equal(reviewed.status, 'idle');
  const closed = await endpoint.call('team_close', { workerIds: [worker.id] });
  assert.equal(closed.workers[0].retained, true);
  assert.equal(closed.workers[0].sessionId, sessionId);
  assert.equal(controller.closeCalls, 1);
  const stopped = await endpoint.call('team_shutdown');
  assert.deepEqual(stopped, { teamId, closed: true, retained: true });
  assert.equal(f.notifiers[0].closed, true);
  assert.equal(existsSync(path.join(f.config.stateDir, teamId, 'store.lock')), false);
  assert.equal(existsSync(path.join(f.config.stateDir, teamId, 'workers.json')), true);
  assert.equal((await endpoint.raw('team_status')).isError, true);
  const restored = await endpoint.call('team_open', { teamId, notifications: false });
  assert.equal(restored.workers[0].sessionId, sessionId);
  assert.equal(restored.workers[0].status, 'closed');
  assert.equal(f.controllers.length, 1);
  const resumed = await endpoint.call('team_resume', { workerId: worker.id, message: '继续原任务' });
  assert.equal(resumed.status, 'queued');
  assert.equal(f.controllers.length, 2);
  assert.equal(f.controllers[1].options.worker.sessionId, sessionId);
  assert.equal(f.controllers[1].sent[0].text, '继续原任务');
  await endpoint.call('team_interrupt', { workerId: worker.id });
  assert.equal(f.controllers[1].interruptCalls, 1);
});

test('错误 teamId 不切换已打开团队，独立团队锁互不干扰', async t => {
  const f = await fixture(t);
  const first = await f.connect();
  const second = await f.connect();
  const parentThreadId = randomUUID();
  await first.call('team_open', { teamId: 'alpha', parentThreadId });
  const wrong = await first.raw('team_open', { teamId: 'beta', parentThreadId: randomUUID() });
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0].text, /另一个团队/);
  assert.equal((await first.call('team_status')).teamId, 'alpha');
  assert.equal(f.notifiers[0].threadId, parentThreadId);
  const locked = await second.raw('team_open', { teamId: 'alpha', notifications: false });
  assert.equal(locked.isError, true);
  assert.match(locked.content[0].text, /正被进程/);
  assert.equal(f.notifiers[1].closed, true);
  const independent = await second.call('team_open', { teamId: 'beta', notifications: false });
  assert.equal(independent.teamId, 'beta');
  const { workers: [worker] } = await first.call('team_dispatch', { workers: [f.spec('Alpha A')] });
  assert.deepEqual((await second.call('team_status')).workers, []);
  await first.call('team_shutdown');
  assert.equal((await second.call('team_status')).teamId, 'beta');
  await second.call('team_shutdown');
  const restored = await second.call('team_open', { teamId: 'alpha', notifications: false });
  assert.equal(restored.workers[0].id, worker.id);
  assert.equal(restored.workers[0].status, 'closed');
});

test('含cc尾缀的完整名字限制十字符，规范化后的重名在启动前整批拒绝', async t => {
  const f = await fixture(t);
  const endpoint = await f.connect();
  await endpoint.call('team_open', { teamId: 'named-team', notifications: false });
  for (const name of ['一二三四五六七八九', '  ', 'cc', 'CC', '接口\n开发']) {
    assert.equal((await endpoint.raw('team_dispatch', { workers: [f.spec(name)] })).isError, true);
  }
  const duplicated = await endpoint.raw('team_dispatch', { workers: [f.spec('接口开发cc'), f.spec(' 接口开发 ')] });
  assert.equal(duplicated.isError, true);
  assert.match(duplicated.content[0].text, /名字.*已存在/);
  assert.equal(f.controllers.length, 0);
  assert.deepEqual((await endpoint.call('team_status')).workers, []);

  const { workers: [worker] } = await endpoint.call('team_dispatch', { workers: [f.spec(' 接口开发 ')] });
  assert.equal(worker.name, '接口开发cc');
  await endpoint.call('team_close', { workerIds: ['接口开发cc'] });
  const reused = await endpoint.raw('team_dispatch', { workers: [f.spec('页面布局'), f.spec('接口开发cc')] });
  assert.equal(reused.isError, true);
  assert.equal(f.controllers.length, 1);
  assert.equal((await endpoint.call('team_status')).workers.length, 1);

  const tenCharacters = '𠮷'.repeat(8) + 'cc';
  assert.equal((await endpoint.call('team_dispatch', { workers: [f.spec(tenCharacters)] })).workers[0].name, tenCharacters);
  assert.equal((await endpoint.raw('team_dispatch', { workers: [f.spec(`${tenCharacters}一`)] })).isError, true);
});

test('自动补小写cc尾缀，已有尾缀不重复追加并传给执行会话', async t => {
  const f = await fixture(t);
  const endpoint = await f.connect();
  await endpoint.call('team_open', { teamId: 'cc-suffix', notifications: false });
  const { workers } = await endpoint.call('team_dispatch', {
    workers: [f.spec('计划功能'), f.spec('验证cc'), f.spec('布局测试CC')],
  });
  const names = ['计划功能cc', '验证cc', '布局测试cc'];
  assert.deepEqual(workers.map(worker => worker.name), names);
  assert.deepEqual(f.controllers.map(controller => controller.options.worker.name), names);
  assert.deepEqual((await endpoint.call('team_status')).workers.map(worker => worker.name), names);
  assert.equal((await endpoint.call('team_send', { workerId: '验证cc', message: '继续验证' })).name, '验证cc');
  assert.equal((await endpoint.raw('team_send', { workerId: '验证', message: '不能猜测目标' })).isError, true);
});

test('按名字完成查看、追加、事件筛选、验收、关闭及重开团队后的恢复', async t => {
  const f = await fixture(t);
  const endpoint = await f.connect();
  const teamId = 'named-lifecycle';
  await endpoint.call('team_open', { teamId, notifications: false });
  const { workers: [worker] } = await endpoint.call('team_dispatch', {
    workers: [f.spec('接口开发cc', { prompt: '实现登录接口' }), f.spec('页面布局')],
  });
  const controller = f.controllers[0];
  const sessionId = randomUUID();
  controller.emit('session', { sessionId });
  const state = await endpoint.call('team_status', { workerIds: ['接口开发cc', worker.id] });
  assert.equal(state.workers.length, 1);
  assert.equal(state.workers[0].task, '实现登录接口');
  assert.equal(state.workers[0].id, worker.id);
  assert.equal((await endpoint.raw('team_send', { workerId: '接口', message: '不应模糊匹配' })).isError, true);

  const sent = await endpoint.call('team_send', { workerId: '接口开发cc', message: '补上验证' });
  assert.equal(sent.id, worker.id);
  assert.equal(sent.name, '接口开发cc');
  controller.emit('progress', { summary: '登录接口已完成' });
  const events = await endpoint.call('team_events', { workerIds: ['接口开发cc'] });
  assert(events.events.every(event => event.workerId === worker.id && event.workerName === '接口开发cc'));
  const notice = f.notifiers[0].events.find(event => event.type === 'progress');
  assert.equal(notice.workerName, '接口开发cc');
  assert.equal(notice.data.workerName, '接口开发cc');
  controller.emit('result', { success: true, text: '验证通过', messageIds: controller.sent.map(message => message.messageId) });
  const { resultId } = await endpoint.call('team_result', { workerId: '接口开发cc' });
  const review = await endpoint.call('team_review', { workerId: '接口开发cc', resultId, accepted: true, note: '已检查' });
  assert.equal(review.id, worker.id);
  const closed = await endpoint.call('team_close', { workerIds: ['接口开发cc', worker.id] });
  assert.equal(closed.workers.length, 1);
  assert.equal(closed.workers[0].name, '接口开发cc');
  assert.equal(controller.closeCalls, 1);
  await endpoint.call('team_shutdown');

  await endpoint.call('team_open', { teamId, notifications: false });
  const history = await endpoint.call('team_events', { workerIds: ['接口开发cc'] });
  assert(history.events.every(event => event.workerName === '接口开发cc'));
  const resumed = await endpoint.call('team_resume', { workerId: '接口开发cc', message: '继续完善接口' });
  assert.equal(resumed.id, worker.id);
  const resumedController = f.controllers.at(-1);
  assert.equal(resumedController.options.worker.sessionId, sessionId);
  assert.equal(resumedController.options.worker.name, '接口开发cc');
  const interrupted = await endpoint.call('team_interrupt', { workerId: '接口开发cc' });
  assert.equal(interrupted.id, worker.id);
  assert.equal(resumedController.interruptCalls, 1);
  assert((await endpoint.call('team_events', { workerIds: ['接口开发cc'] })).events.every(event => event.workerId === worker.id));
});
