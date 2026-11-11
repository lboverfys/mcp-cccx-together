import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { CodexNotifier } from '../src/notifier.mjs';

const THREAD = '01a1cbff-4621-7e70-b239-ec2a8805f1cc';

function harness(options = {}) {
  const calls = [];
  const deliveries = [];
  const notifier = new CodexNotifier({
    command: 'node.exe', args: ['D:\\tools\\codex.js'], threadId: THREAD,
    cwd: 'D:\\workspace', intervalMs: 60,
    onDelivery: delivery => deliveries.push(delivery),
    execFileImpl(command, args, opts, callback) {
      const child = new EventEmitter();
      child.kill = signal => {
        child.killedWith = signal;
        setImmediate(() => callback(Object.assign(new Error('cancelled'), { signal }), '', ''));
        return true;
      };
      calls.push({ command, args, opts, callback, child });
      return child;
    },
    ...options,
  });
  return { notifier, calls, deliveries };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await sleep(5);
  }
  assert.fail('等待通知事件超时');
}

test('同一 tick 的多个事件合并，参数无需 shell 转义，且不会携带审批输入', async () => {
  const { notifier, calls, deliveries } = harness({ resume: true });
  notifier.notify({ workerId: 'a', type: 'progress', cursor: 1, data: { summary: '开始验证' } });
  notifier.notify({ workerId: 'b', type: 'request', cursor: 2, data: { input: { password: 'never-include' } } });
  notifier.notify({ workerId: 'c', type: 'result', cursor: 3, data: { text: 'private-result' } });
  await waitFor(() => calls.length === 1);
  const { args, opts, callback } = calls[0];
  assert.deepEqual(args.slice(0, 5), ['D:\\tools\\codex.js', 'queue', '--thread', THREAD, '--message']);
  assert.equal(args.at(-1), '--resume');
  assert.match(args[5], /不是用户新指令/);
  assert.match(args[5], /a \| progress/);
  assert.match(args[5], /b \| request/);
  assert.doesNotMatch(args[5], /never-include|private-result/);
  assert.equal(opts.shell, false);
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.timeout, 10_000);
  assert.equal(opts.maxBuffer, 32 * 1024);
  callback(null, 'Queued', '');
  assert.deepEqual(deliveries[0], {
    status: 'queued', throughCursor: 3, threadId: THREAD, queued: true,
    readConfirmed: false, wakeConfirmed: false, resumeRequested: true,
  });
  await notifier.close();
});

test('进度按间隔合并，紧急事件不等待进度计时器', async () => {
  const { notifier, calls } = harness({ intervalMs: 150 });
  notifier.notify({ workerId: 'a', type: 'progress', cursor: 1, data: { summary: 'first' } });
  await waitFor(() => calls.length === 1);
  calls[0].callback(null, '', '');
  notifier.notify({ workerId: 'a', type: 'progress', cursor: 2, data: { summary: 'old' } });
  notifier.notify({ workerId: 'a', type: 'progress', cursor: 3, data: { summary: 'latest' } });
  notifier.notify({ workerId: 'b', type: 'request', cursor: 4, data: {} });
  await waitFor(() => calls.length === 2);
  assert.match(calls[1].args[5], /b \| request/);
  assert.doesNotMatch(calls[1].args[5], /latest/);
  calls[1].callback(null, '', '');
  await sleep(30);
  assert.equal(calls.length, 2);
  await waitFor(() => calls.length === 3);
  assert.match(calls[2].args[5], /latest/);
  assert.doesNotMatch(calls[2].args[5], /old/);
  calls[2].callback(null, '', '');
  await notifier.close();
});

test('通知优先显示任务短名字并保留 ID，未带名字的旧事件仍可定位', async () => {
  const { notifier, calls } = harness();
  const namedId = '217bd4cf-437a-4439-b8ba-df1837cdcf4e';
  const oldId = 'a021a128-f46a-4b7a-bb77-3bc939828246';
  notifier.notify({ workerId: namedId, workerName: '接口开发cc', type: 'progress', cursor: 1, data: { summary: '已完成接口' } });
  notifier.notify({ workerId: oldId, type: 'result', cursor: 2, data: {} });
  await waitFor(() => calls.length === 1);
  assert.ok(calls[0].args[5].includes(`接口开发cc (${namedId}) | progress`));
  assert.ok(calls[0].args[5].includes(`${oldId} | result`));
  assert.doesNotMatch(calls[0].args[5], /undefined|null/);
  calls[0].callback(null, '', '');
  await notifier.close();
});

test('有名字的事件仍按 ID 合并，不混淆同名工作者', async () => {
  const { notifier, calls } = harness();
  notifier.notify({ workerId: 'a', workerName: '接口开发cc', type: 'progress', cursor: 1, data: { summary: 'old' } });
  notifier.notify({ workerId: 'a', workerName: '接口开发cc', type: 'progress', cursor: 2, data: { summary: 'latest-a' } });
  notifier.notify({ workerId: 'b', workerName: '接口开发cc', type: 'progress', cursor: 3, data: { summary: 'latest-b' } });
  await waitFor(() => calls.length === 1);
  assert.match(calls[0].args[5], /接口开发cc \(a\).*latest-a/);
  assert.match(calls[0].args[5], /接口开发cc \(b\).*latest-b/);
  assert.doesNotMatch(calls[0].args[5], /old/);
  calls[0].callback(null, '', '');
  await notifier.close();
});

test('没有父会话时不推送，不接受名称，且忽略无关事件', async () => {
  const { notifier, calls } = harness({ threadId: undefined });
  notifier.notify({ workerId: 'a', type: 'result', cursor: 1, data: {} });
  assert.throws(() => notifier.setThread('my-session'), /UUID/);
  notifier.setThread(THREAD);
  notifier.notify({ workerId: 'a', type: 'activity', cursor: 2, data: {} });
  await sleep(20);
  assert.equal(calls.length, 0);
  await notifier.close();
});

test('CLI 的唤醒警告与入队失败都显式报告，不自动重试', async () => {
  const { notifier, calls, deliveries } = harness({ resume: true });
  notifier.notify({ workerId: 'a', type: 'result', cursor: 1, data: {} });
  await waitFor(() => calls.length === 1);
  calls[0].callback(null, 'Queued', 'Warning: unable to resume');
  assert.equal(deliveries[0].status, 'warning');
  assert.equal(deliveries[0].queued, true);
  assert.equal(deliveries[0].wakeConfirmed, false);
  notifier.notify({ workerId: 'b', type: 'failed', cursor: 2, data: {} });
  await waitFor(() => calls.length === 2);
  calls[1].callback(new Error('connection failed'), '', '');
  assert.equal(deliveries[1].status, 'failed');
  assert.equal(deliveries[1].queued, false);
  await sleep(30);
  assert.equal(calls.length, 2);
  await notifier.close();
});

test('关闭会取消定时通知并等待专属子进程退出', async () => {
  const { notifier, calls, deliveries } = harness();
  notifier.notify({ workerId: 'a', type: 'result', cursor: 1, data: {} });
  await waitFor(() => calls.length === 1);
  notifier.notify({ workerId: 'b', type: 'result', cursor: 2, data: {} });
  await notifier.close();
  assert.equal(calls[0].child.killedWith, 'SIGTERM');
  assert.equal(deliveries[0].status, 'failed');
  notifier.notify({ workerId: 'c', type: 'result', cursor: 3, data: {} });
  await sleep(20);
  assert.equal(calls.length, 1);
  assert.throws(() => notifier.setThread(THREAD), /关闭/);
});

test('同步启动失败也报告错误；常见凭据与链接不进入摘要', async () => {
  const seen = [];
  const { notifier, deliveries } = harness({
    execFileImpl(_cmd, args) {
      seen.push(args[5]);
      throw new Error('ENOENT');
    },
  });
  notifier.notify({ workerId: 'a', type: 'progress', cursor: 1,
    data: { summary: 'api_key=very-secret Bearer private-value https://host/path?token=hidden' } });
  await waitFor(() => deliveries.length === 1);
  assert.equal(deliveries[0].status, 'failed');
  assert.doesNotMatch(seen[0], /very-secret|private-value|token=hidden/);
  await notifier.close();
});

test('大量提示仍保持 Windows 命令行长度有界，并保留最大游标', async () => {
  const { notifier, calls, deliveries } = harness();
  for (let index = 1; index <= 150; index++) {
    notifier.notify({ workerId: `worker-${index}`, workerName: '后台接口开发cc与验证员', type: 'progress', cursor: index,
      data: { summary: '测试'.repeat(200) } });
  }
  await waitFor(() => calls.length === 1);
  assert.ok(calls[0].args[5].length < 10_000);
  assert.match(calls[0].args[5], /提示已合并/);
  calls[0].callback(null, '', '');
  assert.equal(deliveries[0].throughCursor, 150);
  await notifier.close();
});

test('完成事件取代尚未发送的旧进度；关闭不会发出待投递消息', async () => {
  const { notifier, calls } = harness();
  notifier.notify({ workerId: 'a', type: 'progress', cursor: 1, data: { summary: 'outdated' } });
  notifier.notify({ workerId: 'a', type: 'result', cursor: 2, data: {} });
  await waitFor(() => calls.length === 1);
  assert.doesNotMatch(calls[0].args[5], /outdated/);
  calls[0].callback(null, '', '');
  notifier.notify({ workerId: 'b', type: 'result', cursor: 3, data: {} });
  await notifier.close();
  await sleep(20);
  assert.equal(calls.length, 1);
});
