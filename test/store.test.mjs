import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';

const tempRoot = process.env.TEMP || process.env.TMP || tmpdir();

async function fixture(t) {
  const dir = mkdtempSync(path.join(tempRoot, 'store-test-'));
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    const relative = path.relative(path.resolve(tempRoot), path.resolve(dir));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, create: async () => {
    const store = new Store(dir);
    await store.init();
    stores.push(store);
    return store;
  } };
}

test('保存元数据和事件，重启后游标连续，排除 runtime 且返回副本', async t => {
  const f = await fixture(t);
  const store = await f.create();
  const runtime = {};
  runtime.self = runtime;
  store.saveWorker({ id: 'a', sessionId: 'saved-session', state: 'idle', runtime });
  const copy = store.listWorkers();
  copy[0].state = 'changed';
  assert.equal(store.listWorkers()[0].state, 'idle');
  assert.equal('runtime' in store.listWorkers()[0], false);
  const received = [];
  store.on('appended', event => received.push(event));
  store.append('a', 'progress', { summary: '已读取代码' });
  store.append('a', 'result', { text: '待验收' });
  assert.equal(received.length, 2);
  store.close();
  assert.equal(existsSync(path.join(f.dir, 'store.lock')), false);
  const reopened = await f.create();
  assert.equal(reopened.listWorkers()[0].sessionId, 'saved-session');
  assert.equal(reopened.events().events.length, 2);
  assert.equal(reopened.append('a', 'resumed', {}).cursor, 3);
  reopened.close();
  await reopened.init();
  assert.equal(reopened.listWorkers().length, 1);
  assert.equal(reopened.events().events.length, 3);
});

test('游标分页和工作者过滤不漏事件，空过滤也能前进', async t => {
  const store = await (await fixture(t)).create();
  for (const id of ['a', 'b', 'a', 'b', 'a']) store.append(id, 'progress', {});
  const first = store.events({ workerIds: ['a'], limit: 1 });
  assert.deepEqual(first.events.map(event => event.cursor), [1]);
  assert.equal(first.nextCursor, 2);
  assert.equal(first.hasMore, true);
  const second = store.events({ after: first.nextCursor, workerIds: ['a'], limit: 1 });
  assert.deepEqual(second.events.map(event => event.cursor), [3]);
  const third = store.events({ after: second.nextCursor, workerIds: ['a'], limit: 1 });
  assert.deepEqual(third.events.map(event => event.cursor), [5]);
  assert.equal(third.hasMore, false);
  assert.equal(store.events({ workerIds: ['missing'] }).nextCursor, 5);
  assert.equal(store.events({ workerIds: [] }).nextCursor, 5);
});

test('日志保留最近 2000 条，截断可见且重启后保持', async t => {
  const f = await fixture(t);
  const store = await f.create();
  for (let i = 0; i < 4100; i++) store.append('a', 'progress', { index: i });
  const page = store.events({ limit: 500 });
  assert.equal(page.gap, true);
  assert.equal(page.oldestCursor, 2101);
  assert.equal(page.events[0].cursor, 2101);
  assert.equal(store.events({ after: 2100 }).gap, false);
  assert.ok(readFileSync(store.eventsPath, 'utf8').trimEnd().split('\n').length < 4000);
  store.close();
  const reopened = await f.create();
  assert.equal(reopened.events().oldestCursor, 2101);
  assert.equal(reopened.append('a', 'progress', {}).cursor, 4101);
});

test('活动锁禁止第二实例进入且不破坏第一实例锁', async t => {
  const f = await fixture(t);
  const store = await f.create();
  const before = readFileSync(store.lockPath, 'utf8');
  const other = new Store(f.dir);
  await assert.rejects(other.init(), /正被进程/);
  other.close();
  assert.equal(readFileSync(store.lockPath, 'utf8'), before);
  store.append('a', 'progress', {});
  store.close();
  await f.create();
});

test('损坏锁保留原样，不能假定可以删除', async t => {
  const f = await fixture(t);
  const lock = path.join(f.dir, 'store.lock');
  writeFileSync(lock, 'not-json');
  await assert.rejects(new Store(f.dir).init(), /无法核实已有状态锁/);
  assert.equal(readFileSync(lock, 'utf8'), 'not-json');
});

test('死亡 PID 的锁明确报告且保留，避免竞争清理误删他人锁', async t => {
  const f = await fixture(t);
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0);
  const owner = JSON.stringify({ pid: Number(child.stdout), token: 'old-token' });
  const lock = path.join(f.dir, 'store.lock');
  writeFileSync(lock, owner);
  await assert.rejects(new Store(f.dir).init(), /已退出的状态锁/);
  assert.equal(readFileSync(lock, 'utf8'), owner);
});

test('事件写入失败传播，内存游标不前进', async t => {
  const store = await (await fixture(t)).create();
  mkdirSync(store.eventsPath);
  assert.throws(() => store.append('a', 'progress', {}));
  assert.deepEqual(store.events().events, []);
  assert.equal(store.events().nextCursor, 0);
});

test('超大事件拒绝写入，不消耗游标；损坏尾行不静默丢弃', async t => {
  const f = await fixture(t);
  const store = await f.create();
  store.append('a', 'progress', {});
  const size = statSync(store.eventsPath).size;
  assert.throws(() => store.append('a', 'progress', { text: '字'.repeat(24000) }), /64 KiB/);
  assert.equal(statSync(store.eventsPath).size, size);
  assert.equal(store.append('a', 'result', {}).cursor, 2);
  store.close();
  writeFileSync(store.eventsPath, '{"cursor":3', { flag: 'a' });
  await assert.rejects(new Store(f.dir).init(), /尾行不完整/);
  assert.equal(existsSync(store.lockPath), false);
});

test('团队元数据原子保存并跨重启保留，读取返回副本', async t => {
  const f = await fixture(t);
  const store = await f.create();
  assert.deepEqual(store.loadTeam(), {});
  store.saveTeam({ constraints: '保留用户已有修改', updatedAt: '2026-11-12' });
  const copy = store.loadTeam();
  copy.constraints = '被调用者更改';
  assert.equal(store.loadTeam().constraints, '保留用户已有修改');
  assert.throws(() => store.saveTeam({ constraints: '字'.repeat(50000) }), /128 KiB/);
  assert.equal(store.loadTeam().constraints, '保留用户已有修改');
  store.close();
  const restored = await f.create();
  assert.equal(restored.loadTeam().constraints, '保留用户已有修改');
});
