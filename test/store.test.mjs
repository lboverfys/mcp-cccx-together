import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store, scanEventLog } from '../src/store.mjs';

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

test('事件部分写入失败回退残片，重试及重开后日志和游标保持一致', async t => {
  const f = await fixture(t);
  const store = await f.create();
  store.append('a', 'progress', { text: '已保存' });
  const before = readFileSync(store.eventsPath, 'utf8');
  const failure = Object.assign(new Error('模拟磁盘写满'), { code: 'ENOSPC' });
  const append = fs.appendFileSync;
  const fault = t.mock.method(fs, 'appendFileSync', (file, data, options) => {
    append(file, Buffer.from(data).subarray(0, 24), options);
    throw failure;
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => store.append('a', 'progress', { text: '写入失败' }), error => error === failure);
  } finally { fault.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(readFileSync(store.eventsPath, 'utf8'), before);
  assert.equal(store.events().nextCursor, 1);
  assert.equal(store.append('a', 'result', { text: '恢复可写' }).cursor, 2);
  store.close();
  const reopened = await f.create();
  assert.deepEqual(reopened.events().events.map(event => event.data.text), ['已保存', '恢复可写']);
  assert.equal(reopened.append('a', 'progress', {}).cursor, 3);
});

test('首次事件未能创建文件时保留原始写入错误，恢复后从首个游标开始', async t => {
  const f = await fixture(t);
  const store = await f.create();
  const failure = Object.assign(new Error('模拟日志文件创建失败'), { code: 'ENOSPC' });
  const fault = t.mock.method(fs, 'appendFileSync', () => { throw failure; });
  syncBuiltinESMExports();
  try {
    assert.throws(() => store.append('a', 'progress', {}), error => error === failure);
    assert.equal(existsSync(store.eventsPath), false);
  } finally { fault.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(store.append('a', 'result', {}).cursor, 1);
  store.close();
  assert.equal((await f.create()).events().nextCursor, 1);
});

test('日志残片回退失败时拒绝继续追加，恢复可写后先修复再写入', async t => {
  const f = await fixture(t);
  const store = await f.create();
  store.append('a', 'progress', { text: '已保存' });
  const failure = Object.assign(new Error('模拟部分写入失败'), { code: 'ENOSPC' });
  const rollbackFailure = Object.assign(new Error('模拟无法回退残片'), { code: 'EACCES' });
  const append = fs.appendFileSync;
  const appendFault = t.mock.method(fs, 'appendFileSync', (file, data, options) => {
    append(file, Buffer.from(data).subarray(0, 24), options);
    throw failure;
  });
  const rollbackFault = t.mock.method(fs, 'truncateSync', () => { throw rollbackFailure; });
  syncBuiltinESMExports();
  try {
    const check = error => error instanceof AggregateError && error.errors.includes(failure) && error.errors.includes(rollbackFailure);
    assert.throws(() => store.append('a', 'progress', {}), check);
    const partial = readFileSync(store.eventsPath, 'utf8');
    assert.throws(() => store.append('a', 'result', {}), check);
    assert.equal(appendFault.mock.callCount(), 1);
    assert.equal(readFileSync(store.eventsPath, 'utf8'), partial);
    assert.equal(store.events().nextCursor, 1);
    assert.equal((await scanEventLog(store.eventsPath, { allowIncompleteTail: true })).tailAction, 'truncate');
  } finally {
    appendFault.mock.restore();
    rollbackFault.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(store.append('a', 'result', { text: '恢复可写' }).cursor, 2);
  store.close();
  assert.deepEqual((await f.create()).events().events.map(event => event.data.text), ['已保存', '恢复可写']);
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

test('旧数组格式迁移为索引，单个工作者更新不重写其他记录', async t => {
  const f = await fixture(t);
  writeFileSync(path.join(f.dir, 'workers.json'), JSON.stringify([{ id: 'a', prompt: '旧任务' }, { id: 'b', prompt: '保留' }]));
  const store = await f.create();
  store.saveWorker({ id: 'a', prompt: '新版' });
  const first = JSON.parse(readFileSync(store.workersPath, 'utf8'));
  const b = first.records.find(r => r.id === 'b');
  store.saveWorker({ id: 'a', prompt: '再次更新' });
  const next = JSON.parse(readFileSync(store.workersPath, 'utf8'));
  assert.deepEqual(next.records.find(r => r.id === 'b'), b);
  assert.equal(readdirSync(store.recordsDir).length, 2);
  store.close();
  assert.deepEqual((await f.create()).listWorkers(), [{ id: 'a', prompt: '再次更新' }, { id: 'b', prompt: '保留' }]);
});

test('团队记录合计超过 8 MiB 仍可保存恢复，单记录上限继续生效', async t => {
  const f = await fixture(t);
  const store = await f.create();
  const payload = 'x'.repeat(800000);
  store.saveWorkers(Array.from({ length: 12 }, (_, index) => ({ id: `worker-${index}`, prompt: payload })));
  assert(store.storageInfo().workerBytes > 8 * 1024 * 1024);
  assert(statSync(store.workersPath).size < 10000);
  assert.throws(() => store.saveWorker({ id: 'oversize', prompt: 'x'.repeat(8 * 1024 * 1024) }), /8 MiB/);
  assert.equal(store.listWorkers().length, 12);
  store.close();
  const reopened = await f.create();
  assert.equal(reopened.listWorkers().length, 12);
  assert.equal(reopened.listWorkers()[11].prompt, payload);
});

test('批次索引提交失败保留原始数据，不遗留部分提交的新记录', async t => {
  const f = await fixture(t);
  const store = await f.create();
  store.saveWorker({ id: 'a', prompt: '原始' });
  const before = readFileSync(store.workersPath, 'utf8');
  const token = JSON.parse(readFileSync(store.lockPath, 'utf8')).token;
  mkdirSync(`${store.workersPath}.${token}.tmp`);
  assert.throws(() => store.saveWorkers([{ id: 'a', prompt: '改变' }, { id: 'b', prompt: '新增' }]));
  assert.equal(readFileSync(store.workersPath, 'utf8'), before);
  assert.deepEqual(store.listWorkers(), [{ id: 'a', prompt: '原始' }]);
  assert.equal(readdirSync(store.recordsDir).length, 1);
});
