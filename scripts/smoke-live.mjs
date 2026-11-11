import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../src/config.mjs';

// 显式运行才会调用真实模型；--notify 额外授权向当前 Codex 会话投递一次提示。
const args = process.argv.slice(2);
assert(args.every(arg => arg === '--notify') && args.length <= 1, '用法：node scripts/smoke-live.mjs [--notify]');
const notify = args.includes('--notify');
const parentThreadId = process.env.CODEX_THREAD_ID;
if (notify) assert(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(parentThreadId ?? ''), '--notify 需要当前环境的完整 CODEX_THREAD_ID');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseConfig = loadConfig();
const tempBase = path.join(tmpdir(), 'cc-team-mcp');
mkdirSync(tempBase, { recursive: true });
const temp = mkdtempSync(path.join(tempBase, 'smoke-'));
const configPath = path.join(temp, 'config.json');
const tempDir = path.join(temp, 'tmp');
mkdirSync(tempDir);
writeFileSync(configPath, JSON.stringify({ ...baseConfig, stateDir: path.join(temp, 'state'), tempDir,
  notificationMode: notify ? 'codex-queue' : 'poll' }, null, 2), { flag: 'wx' });

const log = (stage, data = {}) => process.stdout.write(`${JSON.stringify({ stage, ...data })}\n`);
const deadline = Date.now() + 180_000;
const mainDeadline = deadline - 25_000; // 给正常关闭和实际进程退出检查预留时间。
const teamId = `smoke-${randomUUID()}`;
const client = new Client({ name: 'cc-team-live-smoke', version: '0.2.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'src/cli.mjs'), '--config', configPath],
  cwd: root,
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
    TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir, CC_TEAM_STATE_DIR: path.join(temp, 'state'),
    CC_TEAM_TEMP_DIR: tempDir, CC_TEAM_NOTIFICATION_MODE: notify ? 'codex-queue' : 'poll' },
  stderr: 'pipe',
});
let stderrTail = '';
transport.stderr?.on('data', chunk => { stderrTail = (stderrTail + chunk.toString()).slice(-4000); });
let cursor = 0;
const events = [];
const workerPids = new Set();
let serverPid;
let opened = false;
let failure;

async function bounded(promise, until, label) {
  const remaining = until - Date.now();
  assert(remaining > 0, `${label} 超过测试期限`);
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超过测试期限`)), remaining);
    })]);
  } finally { clearTimeout(timer); }
}

async function call(name, input = {}, cleanup = false) {
  const until = cleanup ? deadline - 5000 : mainDeadline;
  const remaining = until - Date.now();
  assert(remaining > 0, `${name} 超过测试期限`);
  const response = await client.callTool({ name, arguments: input }, undefined, { timeout: Math.min(remaining, 25_000) });
  const text = response.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
  assert(!response.isError, `${name} 失败：${text}`);
  return JSON.parse(text);
}

async function status(cleanup = false) {
  const value = await call('team_status', {}, cleanup);
  for (const worker of value.workers) if (worker.pid) workerPids.add(worker.pid);
  return value;
}

async function pollUntil(predicate, label) {
  while (!predicate(events)) {
    const result = await call('team_events', { after: cursor, waitMs: Math.max(0, Math.min(10_000, mainDeadline - Date.now() - 1000)), limit: 200 });
    assert(!result.gap, '测试期间事件被截断');
    cursor = result.nextCursor;
    events.push(...result.events);
    for (const event of result.events) {
      assert(event.type !== 'failed', `工作者失败：${JSON.stringify(event.data)}`);
      assert(event.type !== 'result' || event.data.success, `本轮失败：${JSON.stringify(event.data)}`);
      assert(event.type !== 'request' || event.data.kind === 'question', '只读冒烟任务出现了非预期权限请求');
      if (event.type === 'activity' && event.data.tool) {
        assert(['mcp__team__report_progress', 'mcp__team__ask_parent'].includes(event.data.tool), `非预期工具：${event.data.tool}`);
      }
    }
    assert(Date.now() < mainDeadline, `${label} 超过测试期限`);
  }
}

const find = (workerId, type, after = 0) => events.find(event => event.workerId === workerId && event.type === type && event.cursor > after);
const progress = (workerId, marker, after = 0) => events.find(event => event.workerId === workerId && event.type === 'progress' && event.cursor > after && event.data.source === 'report_progress' && event.data.summary.includes(marker));
const resultFor = (workerId, messageId, after) => events.find(event => event.workerId === workerId && event.type === 'result' && event.cursor > after && (!messageId || event.data.messageId === messageId || event.data.messageIds?.includes(messageId)));
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function verifyExited(pids, until) {
  const unique = [...new Set(pids.filter(Boolean))];
  while (unique.some(alive) && Date.now() < until) await delay(100);
  const remaining = unique.filter(alive);
  assert.equal(remaining.length, 0, `进程仍存活，未按名称批量终止：${remaining.join(', ')}`);
}
const constraints = '这是协作接口的只读冒烟测试。禁止读取、创建、修改文件，禁止执行命令、网络请求、委派任务。只能调用 mcp__team__report_progress 和 mcp__team__ask_parent；不要调用其他工具。';

try {
  log('starting', { temp, notifications: notify, deadlineSeconds: 180 });
  await bounded(client.connect(transport), mainDeadline, 'MCP 连接');
  serverPid = transport.pid;
  assert(serverPid, '未记录 MCP 进程 PID');
  log('connected', { serverPid });
  const team = await call('team_open', { teamId, constraints, notifications: false });
  opened = true;
  assert.equal(team.notifications, false);
  const dispatched = await call('team_dispatch', { workers: ['A', 'B'].map(label => ({
    name: `smoke-${label}cc`, cwd: root, access: 'read', scope: ['.'],
    prompt: `${constraints}\n按顺序操作：1. 调用 mcp__team__report_progress，summary 为 SMOKE_${label}_PROGRESS。2. 调用 mcp__team__ask_parent，question 为 SMOKE_${label}_QUESTION，不设置选项，等待主控回复。3. 最终回答 SMOKE_${label}_DONE，并原样附上主控刚回复的令牌。不要在得到回复前结束。`,
  })) });
  assert.equal(dispatched.workers.length, 2);
  for (const worker of dispatched.workers) assert(!worker.error, worker.error);
  const [a, b] = dispatched.workers;
  log('dispatched', { workerIds: [a.id, b.id] });
  const tokens = new Map([[a.id, `ACK_A_${randomUUID()}`], [b.id, `ACK_B_${randomUUID()}`]]);
  await pollUntil(() => [a, b].every((worker, index) => progress(worker.id, `SMOKE_${['A', 'B'][index]}_PROGRESS`) && find(worker.id, 'request')), '两名工作者进展和提问');
  const waiting = await status();
  assert(waiting.workers.every(worker => worker.status === 'needs_input' && worker.pid), '工作者未保持运行并等待主控');
  for (const [index, worker] of [a, b].entries()) {
    const request = find(worker.id, 'request').data;
    assert.equal(request.payload?.source, 'ask_parent');
    assert.equal(request.payload.questions.length, 1);
    assert.equal(request.payload.questions[0].question, `SMOKE_${['A', 'B'][index]}_QUESTION`);
    await call('team_reply', { requestId: request.requestId, text: tokens.get(worker.id) });
  }
  log('replied', { workers: 2 });
  await pollUntil(() => [a, b].every(worker => resultFor(worker.id, undefined, 0)), '第一轮结果');
  for (const worker of [a, b]) {
    assert(resultFor(worker.id, undefined, 0).data.text.includes(tokens.get(worker.id)), '结果未包含主控回复令牌');
    await call('team_review', { workerId: worker.id, accepted: true, note: '核对了进度、阻塞提问、主控回复和结果令牌；未调用文件或命令工具。' });
  }
  log('first_round_verified', { workers: 2 });

  let after = cursor;
  const second = await call('team_send', { workerId: a.id, message: `${constraints}\n这是第二轮。先 report_progress 汇报 SMOKE_A_SECOND，然后最终回答 SECOND_DONE，并原样复述第一轮主控回复的令牌。不要再提问。` });
  await pollUntil(() => progress(a.id, 'SMOKE_A_SECOND', after) && resultFor(a.id, second.messageId, after), '追加指令');
  assert(resultFor(a.id, second.messageId, after).data.text.includes(tokens.get(a.id)), '第二轮未保留第一轮上下文');
  await call('team_review', { workerId: a.id, accepted: true, note: '追加指令的 messageId 和上下文令牌均符合预期。' });
  const beforeClose = (await status()).workers.find(worker => worker.id === a.id);
  assert(beforeClose.sessionId && beforeClose.pid, '缺少可恢复 sessionId 或实际 PID');
  const closed = await call('team_close', { workerIds: [a.id] });
  assert.equal(closed.workers[0].status, 'closed');
  assert.equal(closed.workers[0].sessionId, beforeClose.sessionId);
  await verifyExited([beforeClose.pid], Math.min(mainDeadline, Date.now() + 2000));
  log('closed_retained', { workerId: a.id, sessionId: beforeClose.sessionId });

  after = cursor;
  const resumed = await call('team_resume', { workerId: a.id, message: `${constraints}\n这是关闭进程后的恢复测试。先 report_progress 汇报 SMOKE_A_RESUMED，然后最终回答 RESUMED_DONE，并原样复述最初主控回复的令牌。不要再提问。` });
  await pollUntil(() => progress(a.id, 'SMOKE_A_RESUMED', after) && resultFor(a.id, resumed.messageId, after), '会话恢复');
  assert(resultFor(a.id, resumed.messageId, after).data.text.includes(tokens.get(a.id)), '恢复后未保留会话上下文');
  const resumedState = (await status()).workers.find(worker => worker.id === a.id);
  assert.equal(resumedState.sessionId, beforeClose.sessionId);
  await call('team_review', { workerId: a.id, accepted: true, note: '已核对恢复的 sessionId 和最初回复令牌。' });
  log('resumed_verified', { workerId: a.id, sessionId: resumedState.sessionId });

  if (notify) {
    // 两名工作者均已完成；只对一次显式关闭开启通知，避免并行事件导致多次投递。
    await call('team_open', { teamId, parentThreadId, notifications: true });
    const closedB = await call('team_close', { workerIds: [b.id] });
    assert.equal(closedB.workers[0].status, 'closed');
    await pollUntil(() => events.some(event => event.type === 'notification_delivery'), '单次 Codex 入队通知');
    await call('team_open', { teamId, notifications: false });
    const deliveries = events.filter(event => event.type === 'notification_delivery');
    assert.equal(deliveries.length, 1, '通知投递次数不为 1');
    assert.equal(deliveries[0].data.queued, true, JSON.stringify(deliveries[0].data));
    log('notification_queued', { count: 1, readConfirmed: false, wakeConfirmed: false });
  }
  log('workflow_verified', { events: events.length });
} catch (error) {
  failure = error;
  log('failed', { error: error.message });
} finally {
  serverPid ??= transport.pid;
  const cleanupErrors = [];
  if (opened) {
    try {
      await call('team_open', { teamId, notifications: false }, true);
      await status(true);
      const shutdown = await call('team_shutdown', {}, true);
      assert.equal(shutdown.closed, true);
      log('team_shutdown', { retained: shutdown.retained });
    } catch (error) { cleanupErrors.push(error); }
  }
  try { await bounded(client.close(), deadline - 1000, 'MCP 关闭'); }
  catch (error) { cleanupErrors.push(error); }
  try {
    await verifyExited([serverPid, ...workerPids], deadline);
    log('processes_exited', { serverPid, workerProcesses: workerPids.size });
  } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) {
    log('cleanup_failed', { errors: cleanupErrors.map(error => error.message) });
    failure ??= new AggregateError(cleanupErrors, '测试资源未能完整收尾');
  }
  log('finished', { success: !failure, temp, retainedState: true, ...(failure ? { stderrTail } : {}) });
  if (failure) process.exitCode = 1;
}
