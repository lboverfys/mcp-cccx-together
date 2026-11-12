import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TeamManager } from '../src/manager.mjs';
import { gitRepository } from './fixtures/git.mjs';

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
