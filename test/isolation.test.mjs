import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TeamManager } from '../src/manager.mjs';
import { gitRepository } from './fixtures/git.mjs';
import { removeWorktree } from '../src/worktree.mjs';

const readWorktree = (controller, file) => readFileSync(path.join(controller.options.worker.worktree.root, file), 'utf8');

async function until(predicate, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`${label}超时`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function fixture(t, files = { 'src/a.txt': 'a\n', 'docs/x.txt': 'x\n' }) {
  const managers = [];
  const controllers = [];
  // after 钩子按注册顺序执行：先关闭团队，再删除仓库。
  t.after(async () => { for (const manager of managers) await manager.close(); });
  const repo = gitRepository(t, files);
  const config = { stateDir: path.join(repo.dir, 'state'), tempDir: path.join(repo.dir, 'runtime'), claudeExecutable: process.execPath };
  const factory = options => {
    let finish;
    const controller = {
      options, done: new Promise(resolve => { finish = resolve; }), sent: [],
      send(text, messageId) { this.sent.push({ text, messageId }); },
      async interrupt() { return {}; },
      async close() { finish(); },
      emit: options.emit,
    };
    controllers.push(controller);
    return controller;
  };
  const create = async (overrides = {}) => {
    const manager = await new TeamManager({ config, teamId: 'iso-team', factory, ...overrides }).init();
    managers.push(manager);
    return manager;
  };
  const spec = (name, extra = {}) => ({ name, cwd: repo.root, access: 'write', scope: ['src'],
    prompt: `修改 ${repo.root}/src/a.txt`, allowedTools: [], ...extra });
  const edit = (controller, file, content) => {
    const target = path.join(controller.options.worker.worktree.root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  return { repo, config, controllers, create, spec, edit };
}

test('git 仓库中的写入任务在独立 worktree 执行，主控验收时合并范围内改动，关闭后可按原路径恢复', async t => {
  const f = fixture(t);
  const manager = await f.create();
  const warnings = [];
  const [worker] = manager.dispatch([f.spec('实现')], warnings);
  assert.deepEqual(warnings, []);
  const data = manager.get(worker.id).data;
  assert.equal(data.isolation, 'worktree');
  assert.equal(data.review, 'codex');
  const controller = f.controllers[0];
  const { worktree, writeRoots } = controller.options.worker;
  assert.equal(path.dirname(worktree.root), path.join(f.config.stateDir, 'iso-team', 'worktrees'));
  assert.deepEqual(writeRoots, [path.join(worktree.root, 'src'), path.resolve(f.config.tempDir, 'iso-team', worker.id)]);
  // 主工作区路径换成隔离工作区路径，工作者不会按绝对路径改到主工作区。
  assert.equal(controller.sent[0].text, `修改 ${worktree.cwd}/src/a.txt`);
  assert.match(data.instructions, /隔离工作区/);

  f.edit(controller, 'src/a.txt', 'changed\n');
  controller.emit('result', { success: true, text: '完成' });
  const waited = await manager.wait({ timeoutMs: 1000 });
  assert.equal(waited.workers[0].attention, true);
  const diff = manager.diff('实现');
  assert.deepEqual(diff.files, [{ status: 'M', path: 'src/a.txt' }]);
  assert.deepEqual(diff.outsideScope, []);
  assert.match(diff.text, /\+changed/);
  assert.equal(f.repo.read('src/a.txt'), 'a\n', '验收前主工作区不变');

  manager.review(worker.id, true, '核对了 diff');
  assert.equal(f.repo.read('src/a.txt'), 'changed\n');
  assert.equal(manager.get(worker.id).data.lastReview.mergedFiles, 1);
  assert.deepEqual(manager.diff(worker.id).files, []);

  const closed = await manager.closeWorker(worker.id);
  assert.equal(closed.worktree.removed, true);
  assert.equal(existsSync(worktree.root), false);
  assert.equal(manager.status().workers[0].worktree.exists, false);

  manager.get(worker.id).data.sessionId = 'saved-session';
  manager.resume(worker.id, '继续');
  assert.equal(f.controllers.length, 2);
  assert.equal(f.controllers[1].options.worker.worktree.root, worktree.root);
  assert.equal(existsSync(worktree.root), true);
  assert.equal(readWorktree(f.controllers[1], 'src/a.txt'), 'changed\n', '重建的基线包含已合并内容');
});

test('主控验收时越界改动不合并且验收不生效，关闭保留有改动的 worktree', async t => {
  const f = fixture(t);
  const manager = await f.create();
  const [worker] = manager.dispatch([f.spec('实现')]);
  const controller = f.controllers[0];
  f.edit(controller, 'src/a.txt', 'changed\n');
  f.edit(controller, 'docs/x.txt', 'outside\n');
  controller.emit('result', { success: true, text: '完成' });
  assert.deepEqual(manager.diff(worker.id).outsideScope, ['docs/x.txt']);
  assert.throws(() => manager.review(worker.id, true, '通过'), /验收未生效.*超出分配范围.*docs\/x\.txt/);
  assert.equal(manager.get(worker.id).data.status, 'awaiting_review');
  assert.equal(manager.get(worker.id).data.lastReview, undefined);
  assert.equal(f.repo.read('src/a.txt'), 'a\n');
  assert.equal(f.repo.read('docs/x.txt'), 'x\n');
  manager.review(worker.id, false, '越界修改');
  const closed = await manager.closeWorker(worker.id);
  assert.deepEqual(closed.worktree, { root: controller.options.worker.worktree.root, removed: false, pendingFiles: 2 });
  assert.equal(existsSync(controller.options.worker.worktree.root), true);
});

test('主工作区重命名后验收把改动合并到新路径，保留并行修改并可清理 worktree', async t => {
  const original = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
  const changed = original.replace('line 1\n', 'worker 1\n');
  const f = fixture(t, { 'src/a.txt': original, 'docs/x.txt': 'original\n' });
  const manager = await f.create();
  const [worker] = manager.dispatch([f.spec('实现')]);
  const controller = f.controllers[0];
  f.edit(controller, 'src/a.txt', changed);
  controller.emit('result', { success: true, text: '完成' });
  renameSync(path.join(f.repo.root, 'src/a.txt'), path.join(f.repo.root, 'src/renamed.txt'));
  f.repo.write('docs/x.txt', 'main change\n');
  manager.review(worker.id, true, '核对改名后的内容');
  assert.equal(f.repo.read('src/renamed.txt'), changed);
  assert.equal(existsSync(path.join(f.repo.root, 'src/a.txt')), false);
  assert.equal(f.repo.read('docs/x.txt'), 'main change\n');
  assert.equal(manager.get(worker.id).data.lastReview.mergedFiles, 1);
  assert.deepEqual(manager.diff(worker.id).files, []);
  const closed = await manager.closeWorker(worker.id);
  assert.equal(closed.worktree.removed, true);
});

test('主工作区已包含同样改动时推进验收基线，不保留虚假的未合并改动', async t => {
  const f = fixture(t);
  const manager = await f.create();
  const [worker] = manager.dispatch([f.spec('实现')]);
  f.edit(f.controllers[0], 'src/a.txt', 'same change\n');
  f.repo.write('src/a.txt', 'same change\n');
  f.controllers[0].emit('result', { success: true, text: '完成' });
  manager.review(worker.id, true, '主工作区已包含该改动');
  assert.equal(manager.get(worker.id).data.lastReview.mergedFiles, 0);
  assert.deepEqual(manager.diff(worker.id).files, []);
  assert.equal((await manager.closeWorker(worker.id)).worktree.removed, true);
});

test('隔离目录丢失时拒绝验收且不启动下游，主工作区保持原样', async t => {
  const f = fixture(t);
  const manager = await f.create();
  const [worker, downstream] = manager.dispatch([f.spec('实现'), f.spec('下游', { dependsOn: ['实现'] })]);
  const controller = f.controllers[0];
  f.edit(controller, 'src/a.txt', 'pending change\n');
  controller.emit('result', { success: true, text: '完成' });
  const worktree = controller.options.worker.worktree;
  assert.equal(path.dirname(worktree.root), path.join(f.config.stateDir, 'iso-team', 'worktrees'));
  removeWorktree(worktree);
  assert.throws(() => manager.review(worker.id, true, '验收'), /隔离工作区.*不存在/);
  assert.equal(manager.get(worker.id).data.lastReview, undefined);
  assert.equal(manager.get(worker.id).data.status, 'awaiting_review');
  assert.equal(manager.get(downstream.id).data.status, 'queued');
  assert.equal(f.controllers.length, 1);
  assert.equal(f.repo.read('src/a.txt'), 'a\n');
});

test('自动验收在 worktree 中运行 verify，越界改动发回修复，超过轮次后拒绝且不合并', async t => {
  const f = fixture(t);
  const manager = await f.create();
  // 标记文件只存在于隔离工作区：verify 在主工作区运行就会失败。
  const verify = `"${process.execPath}" -e "process.exit(require('fs').existsSync('src/marker.txt') ? 0 : 1)"`;
  const [worker] = manager.dispatch([f.spec('实现', { verify, maxFixRounds: 1 })]);
  assert.equal(manager.get(worker.id).data.review, 'auto');
  const controller = f.controllers[0];
  f.edit(controller, 'src/marker.txt', 'only in worktree\n');
  f.edit(controller, 'docs/x.txt', 'outside\n');
  controller.emit('result', { success: true, text: '第一轮' });
  await until(() => controller.sent.length === 2, '越界修复消息');
  assert.match(controller.sent[1].text, /超出分配范围.*docs\/x\.txt.*自动修复 1\/1/s);

  controller.emit('result', { success: true, text: '第二轮' });
  await until(() => manager.get(worker.id).data.lastReview, '自动拒绝');
  assert.equal(manager.get(worker.id).data.lastReview.accepted, false);
  assert.match(manager.get(worker.id).data.lastReview.note, /超出分配范围/);
  assert.equal(existsSync(path.join(f.repo.root, 'src/marker.txt')), false);

  f.edit(controller, 'docs/x.txt', 'x\n');
  manager.send(worker.id, '已撤销 docs 改动，请重新报告');
  controller.emit('result', { success: true, text: '第三轮' });
  await until(() => manager.get(worker.id).data.lastReview?.accepted, '自动验收');
  assert.match(manager.get(worker.id).data.lastReview.note, /通过；已把 1 个文件合并回主工作区/);
  assert.equal(f.repo.read('src/marker.txt'), 'only in worktree\n');
});

test('下游任务的 worktree 基线包含上游已合并的改动', async t => {
  const f = fixture(t);
  const manager = await f.create();
  const [upstream] = manager.dispatch([f.spec('上游'), f.spec('下游', { dependsOn: ['上游'], scope: ['src'] })]);
  f.edit(f.controllers[0], 'src/a.txt', 'from upstream\n');
  f.controllers[0].emit('result', { success: true, text: '上游完成' });
  manager.review(upstream.id, true, '通过');
  await until(() => f.controllers.length === 2, '下游启动');
  assert.equal(readWorktree(f.controllers[1], 'src/a.txt'), 'from upstream\n');
});

test('stateDir 位于仓库内时拒绝 worktree 隔离，可显式改用共享工作区', async t => {
  const f = fixture(t);
  const manager = await f.create({ config: { ...f.config, stateDir: path.join(f.repo.root, '.team-state') } });
  assert.throws(() => manager.dispatch([f.spec('实现')]), /stateDir 位于该 git 仓库内/);
  const [worker] = manager.dispatch([f.spec('实现', { isolation: 'shared' })]);
  assert.equal(manager.get(worker.id).data.isolation, 'shared');
  assert.equal(f.controllers[0].options.worker.worktree, undefined);
  assert.throws(() => manager.diff(worker.id), /只有 worktree 隔离/);
});

test('隔离写入与只读任务并行，verify 仍排队；待主控验收时 team_wait 直接附带改动和越界文件', async t => {
  const f = fixture(t);
  const manager = await f.create();
  const [whole, reader, checker] = manager.dispatch([
    f.spec('全量修改', { scope: ['.'] }),
    f.spec('读取', { access: 'read', scope: ['.'] }),
    f.spec('检查', { access: 'verify', scope: ['.'] }),
  ]);
  assert.equal(manager.get(whole.id).data.isolation, 'worktree');
  assert.equal(manager.get(whole.id).data.status, 'running');
  assert.equal(manager.get(reader.id).data.status, 'running', '隔离写入合并前不改主工作区，只读任务不必排队');
  assert.equal(manager.get(checker.id).data.queueReason, 'waiting_scope', 'verify 在主工作区运行命令，仍等隔离写入完成');
  await manager.closeWorker(checker.id);
  await manager.closeWorker(whole.id);

  const [scoped] = manager.dispatch([f.spec('范围修改')]);
  const controller = f.controllers.at(-1);
  f.edit(controller, 'src/a.txt', 'changed\n');
  f.edit(controller, 'docs/x.txt', 'outside\n');
  controller.emit('result', { success: true, text: '已修改 src/a.txt:1' });
  const waited = await manager.wait({ workerIds: [scoped.id], timeoutMs: 1000 });
  const [worker] = waited.workers;
  assert.equal(worker.attention, true);
  assert.deepEqual(worker.diff.files, ['M docs/x.txt', 'M src/a.txt']);
  assert.deepEqual(worker.diff.outsideScope, ['docs/x.txt']);
  assert.match(worker.diff.patch, /\+changed/);
  assert.equal(worker.diff.patchTruncated, undefined);
  // 证据优先读隔离工作区里尚未合并的内容。
  assert.deepEqual(worker.evidence.map(item => [item.ok, item.text]), [[true, '1| changed']]);
  assert.equal(f.repo.read('src/a.txt'), 'a\n');
});

test('范围重叠的隔离写任务并行并共用基线快照；合并冲突时并入主工作区最新内容发回原工作者，解决后自动验收', async t => {
  const f = fixture(t, { 'src/a.txt': 'one\ntwo\nthree\n', 'src/b.txt': 'b\n' });
  const manager = await f.create();
  // 冲突标记未解决时验证失败；只有工作者真正解决冲突后才会合并。
  const verify = `"${process.execPath}" -e "process.exit(require('fs').readFileSync('src/a.txt', 'utf8').includes('<<<<<<<') ? 1 : 0)"`;
  const [first, second] = manager.dispatch([
    f.spec('甲', { scope: ['.'], verify, maxFixRounds: 2 }), f.spec('乙', { scope: ['.'], verify, maxFixRounds: 2 }),
  ]);
  assert.deepEqual([first, second].map(item => manager.get(item.id).data.status), ['running', 'running']);
  assert.equal(manager.get(first.id).data.worktree.base, manager.get(second.id).data.worktree.base, '同一轮调度只做一次主工作区快照');
  const [one, two] = f.controllers;

  f.edit(one, 'src/a.txt', 'ONE\ntwo\nthree\n');
  one.emit('result', { success: true, text: '甲完成' });
  await until(() => manager.get(first.id).data.lastReview?.accepted, '甲自动验收');
  assert.equal(f.repo.read('src/a.txt'), 'ONE\ntwo\nthree\n');

  f.edit(two, 'src/a.txt', 'uno\ntwo\nthree\n');
  f.edit(two, 'src/b.txt', 'B\n');
  two.emit('result', { success: true, text: '乙完成' });
  await until(() => two.sent.length === 2, '冲突发回乙');
  assert.match(two.sent[1].text, /合并回主工作区时冲突.*src\/a\.txt.*冲突标记.*自动修复 1\/2/s);
  assert.match(readWorktree(two, 'src/a.txt'), /<<<<<<<[^\n]*\nONE\n=======\nuno\n>>>>>>>/);
  assert.equal(readWorktree(two, 'src/b.txt'), 'B\n', '工作者的其他改动保留');
  assert.equal(f.repo.read('src/b.txt'), 'b\n', '冲突解决前不合并任何文件');
  assert.equal(manager.get(second.id).data.lastReview, undefined, '冲突不交主控');
  assert.deepEqual(manager.diff(second.id).files.map(file => file.path).sort(), ['src/a.txt', 'src/b.txt'], '基线已推进到主工作区最新内容');

  f.edit(two, 'src/a.txt', 'ONE uno\ntwo\nthree\n');
  two.emit('result', { success: true, text: '已解决冲突' });
  await until(() => manager.get(second.id).data.lastReview?.accepted, '乙自动验收');
  assert.equal(f.repo.read('src/a.txt'), 'ONE uno\ntwo\nthree\n');
  assert.equal(f.repo.read('src/b.txt'), 'B\n');
  const timing = manager.get(second.id).data.timing;
  assert.ok(timing.verifyMs >= 0 && timing.mergeMs >= 0 && timing.worktreeMs >= 0);
});

test('主控验收遇到合并冲突时发回原工作者解决，不报错也不合并', async t => {
  const f = fixture(t, { 'src/a.txt': 'one\n' });
  const manager = await f.create();
  const [first, second] = manager.dispatch([f.spec('甲'), f.spec('乙')]);
  const [one, two] = f.controllers;
  f.edit(one, 'src/a.txt', 'first\n');
  one.emit('result', { success: true, text: '甲完成' });
  manager.review(first.id, true, '核对 diff');
  f.edit(two, 'src/a.txt', 'second\n');
  two.emit('result', { success: true, text: '乙完成' });
  const outcome = manager.review(second.id, true, '核对 diff', undefined, manager.get(second.id).data.lastResult.resultId);
  assert.equal(outcome.sentBack, true);
  assert.equal(outcome.accepted, false);
  assert.equal(manager.get(second.id).data.status, 'running');
  assert.match(two.sent.at(-1).text, /冲突/);
  assert.match(readWorktree(two, 'src/a.txt'), /<<<<<<<[^\n]*\nfirst\n=======\nsecond\n>>>>>>>/);
  assert.equal(f.repo.read('src/a.txt'), 'first\n');
});
