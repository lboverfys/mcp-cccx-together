import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { ResultStore } from '../src/results.mjs';
import { pruneTeam, recoverTeam } from '../src/maintenance.mjs';
import { runCli } from '../src/cli.mjs';

async function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'cc-team-maintenance-'));
  const config = { stateDir: root };
  const teamId = 'history';
  const directory = path.join(root, teamId);
  const store = await new Store(directory).init();
  const results = new ResultStore(path.join(directory, 'results'));
  t.after(() => {
    store.close();
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, config, teamId, directory, store, results };
}

test('清理先预览，保护当前、快照及历史结果间的传递引用，只删除无引用旧版本和孤立状态', async t => {
  const f = await fixture(t);
  const a = randomUUID(), b = randomUUID();
  const old = f.results.save(a, { text: '被历史结果引用的设计' }).resultId;
  const discard = f.results.save(a, { text: '无引用的中间设计' }).resultId;
  const newest = f.results.save(a, { text: '最新设计' }).resultId;
  const linked = f.results.save(b, { text: '保留的实现', dependencyResultIds: { [a]: old } }).resultId;
  for (const [index, id] of [old, discard, newest].entries()) utimesSync(f.results.file(a, id), 100 + index, 100 + index);
  f.store.saveWorkers([
    { id: a, status: 'closed', lastResult: { resultId: newest } },
    { id: b, status: 'closed', lastResult: { resultId: linked }, dependencyResults: { [a]: { resultId: newest } } },
  ]);
  const orphan = path.join(f.store.recordsDir, `${randomUUID()}.json`);
  writeFileSync(orphan, '{}');
  const unrelated = path.join(f.store.recordsDir, 'keep-user-note.txt');
  writeFileSync(unrelated, '保留');
  f.store.close();
  const preview = await pruneTeam(f.config, f.teamId, { keepResults: 1 });
  assert.equal(preview.removableResults, 1);
  assert.equal(preview.orphanRecords, 1);
  assert.equal(preview.removed, 0);
  assert(existsSync(f.results.file(a, discard)));
  assert(existsSync(orphan));
  const applied = await pruneTeam(f.config, f.teamId, { keepResults: 1, apply: true });
  assert.equal(applied.removed, 2);
  assert(!existsSync(f.results.file(a, discard)));
  assert(!existsSync(orphan));
  for (const id of [old, newest]) assert(existsSync(f.results.file(a, id)));
  assert(existsSync(f.results.file(b, linked)));
  assert.equal(readFileSync(unrelated, 'utf8'), '保留');
});

test('清理拒绝活动团队、无法确认退出的工作者和断裂引用，不删除其他结果', async t => {
  const f = await fixture(t);
  const id = randomUUID();
  const resultId = f.results.save(id, { text: '必须保留' }).resultId;
  await assert.rejects(pruneTeam(f.config, f.teamId, { keepResults: 1, apply: true }), /正被进程/);
  f.store.saveWorker({ id, status: 'stopped', lastPid: process.pid });
  f.store.close();
  await assert.rejects(pruneTeam(f.config, f.teamId, { keepResults: 1, apply: true }), /仍存活/);
  await f.store.init();
  f.store.saveWorker({ id, status: 'closed', lastResult: { resultId: randomUUID() } });
  f.store.close();
  await assert.rejects(pruneTeam(f.config, f.teamId, { keepResults: 1, apply: true }), /交付缺失/);
  assert(existsSync(f.results.file(id, resultId)));
  assert(!existsSync(f.store.lockPath));
});

test('恢复仅处理已死亡持有者，预览保留原锁，执行后备份原锁且允许重开', async t => {
  const f = await fixture(t);
  assert.throws(() => recoverTeam(f.config, f.teamId, { apply: true }), /仍存活/);
  f.store.saveWorker({ id: randomUUID(), status: 'closed' });
  f.store.close();
  const exited = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { Store } = await import(process.argv[1]);
    const store = await new Store(process.argv[2]).init();
    store.saveWorker({ ...store.listWorkers()[0], prompt: '退出前已提交' });
    process.exit(0);
  `, new URL('../src/store.mjs', import.meta.url).href, f.directory], { encoding: 'utf8', windowsHide: true });
  assert.equal(exited.status, 0);
  const owner = JSON.parse(readFileSync(f.store.lockPath, 'utf8'));
  const preview = recoverTeam(f.config, f.teamId);
  assert.equal(preview.recoverable, true);
  assert(existsSync(f.store.lockPath));
  const recovered = recoverTeam(f.config, f.teamId, { apply: true });
  assert.equal(recovered.recovered, true);
  assert.deepEqual(JSON.parse(readFileSync(recovered.backup, 'utf8')), owner);
  assert(!existsSync(f.store.lockPath));
  assert(!existsSync(path.join(f.directory, 'recovery.lock')));
  await f.store.init();
  assert.equal(f.store.listWorkers().length, 1);
  assert.equal(f.store.listWorkers()[0].prompt, '退出前已提交');
});

test('恢复互斥及损坏锁失败不会删除现有锁，普通打开也遵守恢复锁', async t => {
  const f = await fixture(t);
  f.store.close();
  const gate = path.join(f.directory, 'recovery.lock');
  writeFileSync(gate, '已有恢复者');
  assert.throws(() => recoverTeam(f.config, f.teamId), /恢复锁/);
  assert.throws(() => recoverTeam(f.config, f.teamId, { apply: true }), /EEXIST/);
  await assert.rejects(new Store(f.directory).init(), /恢复/);
  assert.equal(readFileSync(gate, 'utf8'), '已有恢复者');
  rmSync(gate);
  writeFileSync(f.store.lockPath, 'broken');
  assert.throws(() => recoverTeam(f.config, f.teamId, { apply: true }));
  assert.equal(readFileSync(f.store.lockPath, 'utf8'), 'broken');
  assert(!existsSync(gate));
});

test('维护 CLI 默认预览、无需 Claude，参数错误不启动任何服务', async t => {
  const f = await fixture(t);
  f.store.close();
  const configFile = path.join(f.root, 'config.json');
  writeFileSync(configFile, JSON.stringify({ ...f.config, tempDir: path.join(f.root, 'temp') }));
  let stdout = '', stderr = '';
  const options = { stdout: { write(text) { stdout += text; } }, stderr: { write(text) { stderr += text; } },
    runServerImpl() { assert.fail('维护不应启动服务'); } };
  assert.equal(await runCli(['prune', '--config', configFile, '--team', f.teamId, '--keep-results', '2'], options), 0, stderr);
  assert.equal(JSON.parse(stdout).applied, false);
  for (const args of [['prune', '--team', 'history'], ['recover', '--team', '../escape'], ['serve', '--apply'], ['doctor', '--keep-results', '1']]) {
    assert.equal(await runCli(args, options), 1);
  }
  await assert.rejects(pruneTeam(f.config, 'missing-team', { keepResults: 1 }), /ENOENT/);
  assert(!existsSync(path.join(f.root, 'missing-team')));
});
