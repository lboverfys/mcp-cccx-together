import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_LINKS, createWorktree, integrateWorktree, removeWorktree, repoRoot, snapshotTree, worktreeChanges, worktreeDiff } from '../src/worktree.mjs';
import { gitRepository } from './fixtures/git.mjs';

const lines = count => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n') + '\n';

const inWorktree = (worktree, file, content) => {
  mkdirSync(path.dirname(path.join(worktree.root, file)), { recursive: true });
  writeFileSync(path.join(worktree.root, file), content);
};

test('worktree 以主工作区当前内容为基线，含未提交和未跟踪文件，并链接被忽略的依赖目录', async t => {
  const r = gitRepository(t, { 'a.txt': 'committed\n', '.gitignore': 'node_modules/\n.env\n' });
  r.write('a.txt', 'uncommitted\n');
  r.write('new.txt', 'untracked\n');
  r.write('node_modules/pkg/index.js', 'module.exports = 1;\n');
  r.write('.env', 'LOCAL_ONLY=1\n');
  const before = r.git('status', '--porcelain');
  const worktree = createWorktree({ cwd: r.root, root: r.worktreeRoot, tempDir: r.tempDir, links: [...DEFAULT_LINKS, '.env'] });
  assert.equal(repoRoot(r.root), r.root);
  assert.equal(worktree.cwd, worktree.root);
  assert.equal(readFileSync(path.join(worktree.root, 'a.txt'), 'utf8'), 'uncommitted\n');
  assert.equal(readFileSync(path.join(worktree.root, 'new.txt'), 'utf8'), 'untracked\n');
  assert.equal(readFileSync(path.join(worktree.root, 'node_modules/pkg/index.js'), 'utf8'), 'module.exports = 1;\n');
  assert.equal(readFileSync(path.join(worktree.root, '.env'), 'utf8'), 'LOCAL_ONLY=1\n');
  assert.deepEqual(worktree.links, ['node_modules', '.env']);
  // 主仓库的 HEAD、索引和工作区状态都不变。
  assert.equal(r.git('status', '--porcelain'), before);
  assert.deepEqual(worktreeChanges(worktree, { tempDir: r.tempDir }).files, []);
  inWorktree(worktree, 'a.txt', 'worker change\n');
  assert.deepEqual(worktreeDiff(worktree, { tempDir: r.tempDir }).files, [{ status: 'M', path: 'a.txt' }]);
  const merged = integrateWorktree(worktree, { allowed: file => file === 'a.txt', tempDir: r.tempDir });
  assert.equal(r.read('a.txt'), 'worker change\n');
  assert.deepEqual(worktreeChanges({ ...worktree, baseTree: merged.tree }, { tempDir: r.tempDir }).files, []);
  removeWorktree(worktree);
  assert.equal(r.read('node_modules/pkg/index.js'), 'module.exports = 1;\n');
  assert.equal(r.read('.env'), 'LOCAL_ONLY=1\n');
});

test('子目录 cwd 映射到 worktree 内的同一子目录', async t => {
  const r = gitRepository(t, { 'pkg/app/index.js': 'x\n' });
  const worktree = createWorktree({ cwd: path.join(r.root, 'pkg'), root: r.worktreeRoot, tempDir: r.tempDir });
  assert.equal(worktree.cwd, path.join(worktree.root, 'pkg'));
  assert(existsSync(path.join(worktree.cwd, 'app/index.js')));
});

test('快照重读同尺寸且时间戳未变的文件，同时保留暂存的忽略文件', async t => {
  const r = gitRepository(t, { 'f.txt': 'line 10\n', '.gitignore': 'private.txt\n' });
  r.git('config', 'core.trustctime', 'false');
  const file = path.join(r.root, 'f.txt');
  const timestamp = new Date('2020-01-01T00:00:00Z');
  utimesSync(file, timestamp, timestamp);
  r.git('add', '-A');
  r.write('private.txt', 'staged\n');
  r.git('add', '-f', 'private.txt');
  const before = snapshotTree(r.root, { tempDir: r.tempDir });

  r.write('f.txt', 'main 10\n');
  utimesSync(file, timestamp, timestamp);
  const after = snapshotTree(r.root, { tempDir: r.tempDir });
  assert.notEqual(after, before);
  assert.equal(r.git('show', `${after}:f.txt`), 'main 10\n');
  assert.equal(r.git('show', `${after}:private.txt`), 'staged\n');
});

test('合并只写回范围内改动并保留主工作区的并行修改，越界改动整体拒绝', async t => {
  const r = gitRepository(t, { 'src/a.txt': 'a\n', 'src/c.txt': 'c\n', 'other.txt': 'base\n', 'docs/x.txt': 'x\n' });
  const worktree = createWorktree({ cwd: r.root, root: r.worktreeRoot, tempDir: r.tempDir });
  inWorktree(worktree, 'src/a.txt', 'a changed\n');
  inWorktree(worktree, 'src/b.txt', 'b new\n');
  rmSync(path.join(worktree.root, 'src/c.txt'));
  r.write('other.txt', 'main edit\n');
  const allowed = file => file.startsWith('src/');
  const merged = integrateWorktree(worktree, { allowed, tempDir: r.tempDir });
  assert.deepEqual(merged.files.map(file => `${file.status} ${file.path}`).sort(), ['A src/b.txt', 'D src/c.txt', 'M src/a.txt']);
  assert.equal(r.read('src/a.txt'), 'a changed\n');
  assert.equal(r.read('src/b.txt'), 'b new\n');
  assert.equal(existsSync(path.join(r.root, 'src/c.txt')), false);
  assert.equal(r.read('other.txt'), 'main edit\n');

  // 新基线之后只合并增量；越界时主工作区不受任何影响。
  const next = { ...worktree, baseTree: merged.tree };
  assert.deepEqual(worktreeChanges(next, { tempDir: r.tempDir }).files, []);
  inWorktree(next, 'src/a.txt', 'a again\n');
  inWorktree(next, 'docs/x.txt', 'outside\n');
  assert.throws(() => integrateWorktree(next, { allowed, tempDir: r.tempDir }),
    error => error.code === 'SCOPE' && error.files.join() === 'docs/x.txt' && /超出分配范围/.test(error.message));
  assert.equal(r.read('src/a.txt'), 'a changed\n');
  assert.equal(r.read('docs/x.txt'), 'x\n');
});

test('主工作区改过同一文件时做三方合并，冲突时拒绝且不改主工作区', async t => {
  const r = gitRepository(t, { 'f.txt': lines(10) });
  r.git('config', 'core.trustctime', 'false');
  const file = path.join(r.root, 'f.txt');
  const timestamp = new Date('2020-01-01T00:00:00Z');
  utimesSync(file, timestamp, timestamp);
  r.git('add', '-A');
  const worktree = createWorktree({ cwd: r.root, root: r.worktreeRoot, tempDir: r.tempDir });
  inWorktree(worktree, 'f.txt', lines(10).replace('line 1\n', 'worker 1\n'));
  r.write('f.txt', lines(10).replace('line 10\n', 'main 10\n'));
  utimesSync(file, timestamp, timestamp);
  const merged = integrateWorktree(worktree, { allowed: () => true, tempDir: r.tempDir });
  assert.equal(r.read('f.txt'), lines(10).replace('line 1\n', 'worker 1\n').replace('line 10\n', 'main 10\n'));

  const next = { ...worktree, baseTree: merged.tree };
  inWorktree(next, 'f.txt', readFileSync(path.join(worktree.root, 'f.txt'), 'utf8').replace('line 5\n', 'worker 5\n'));
  const mainVersion = r.read('f.txt').replace('line 5\n', 'main 5\n');
  r.write('f.txt', mainVersion);
  assert.throws(() => integrateWorktree(next, { allowed: () => true, tempDir: r.tempDir }),
    error => error.code === 'CONFLICT' && error.files.join() === 'f.txt');
  assert.equal(r.read('f.txt'), mainVersion);
});

test('diff 返回相对基线的文件、统计和补丁', async t => {
  const r = gitRepository(t, { 'src/a.txt': 'a\n' });
  const worktree = createWorktree({ cwd: r.root, root: r.worktreeRoot, tempDir: r.tempDir });
  assert.equal(worktreeDiff(worktree, { tempDir: r.tempDir }).patch, '');
  inWorktree(worktree, 'src/a.txt', 'a\nmore\n');
  const diff = worktreeDiff(worktree, { tempDir: r.tempDir });
  assert.deepEqual(diff.files, [{ status: 'M', path: 'src/a.txt' }]);
  assert.match(diff.stat, /src\/a\.txt/);
  assert.match(diff.patch, /\+more/);
});

test('主工作区把文件移出 scope 后拒绝整批合并，不漏掉重命名目标的范围检查', async t => {
  const r = gitRepository(t, { 'src/a.txt': lines(20), 'src/b.txt': 'b\n' });
  const worktree = createWorktree({ cwd: r.root, root: r.worktreeRoot, tempDir: r.tempDir });
  inWorktree(worktree, 'src/a.txt', lines(20).replace('line 1\n', 'worker 1\n'));
  inWorktree(worktree, 'src/b.txt', 'worker b\n');
  mkdirSync(path.join(r.root, 'docs'));
  renameSync(path.join(r.root, 'src/a.txt'), path.join(r.root, 'docs/renamed.txt'));
  const before = r.git('status', '--porcelain');
  assert.throws(() => integrateWorktree(worktree, { allowed: file => file.startsWith('src/'), tempDir: r.tempDir }),
    error => error.code === 'SCOPE' && error.files.join() === 'docs/renamed.txt');
  assert.equal(r.read('docs/renamed.txt'), lines(20));
  assert.equal(r.read('src/b.txt'), 'b\n');
  assert.equal(r.git('status', '--porcelain'), before);
});

test('删除 worktree 先拆除链接，不删除主工作区的依赖目录', async t => {
  const r = gitRepository(t, { '.gitignore': 'node_modules/\n' });
  r.write('node_modules/pkg/index.js', 'keep\n');
  const worktree = createWorktree({ cwd: r.root, root: r.worktreeRoot, tempDir: r.tempDir, links: ['node_modules'] });
  removeWorktree(worktree);
  assert.equal(existsSync(worktree.root), false);
  assert.equal(r.read('node_modules/pkg/index.js'), 'keep\n');
  assert.equal(r.git('worktree', 'list', '--porcelain').includes(worktree.root), false);
});

test('非 git 目录不能创建 worktree，链接路径不能越出 cwd', async t => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'cc-team-plain-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(repoRoot(dir), undefined);
  assert.throws(() => createWorktree({ cwd: dir, root: path.join(dir, 'wt'), tempDir: path.join(dir, 'tmp') }), /不在 git 仓库中/);
  const r = gitRepository(t, { 'a.txt': 'a\n' });
  assert.throws(() => createWorktree({ cwd: r.root, root: r.worktreeRoot, tempDir: r.tempDir, links: ['../outside'] }), /links 必须是 cwd 内/);
});
