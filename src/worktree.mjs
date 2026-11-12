import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { inside, toPosix } from './paths.mjs';

// 写入任务的 git worktree 隔离：基线是主工作区当前内容（含未提交和未跟踪文件）的快照提交，
// 验收时只把工作者自基线以来、位于分配范围内的改动写回主工作区；全程不改主仓库的 HEAD、索引和分支。

const GIT_TIMEOUT_MS = 120_000;
const IDENTITY = { GIT_AUTHOR_NAME: 'cc-team-mcp', GIT_AUTHOR_EMAIL: 'cc-team-mcp@localhost',
  GIT_COMMITTER_NAME: 'cc-team-mcp', GIT_COMMITTER_EMAIL: 'cc-team-mcp@localhost' };
const INHERITED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX'];
const DIFF_OPTIONS = ['--no-renames', '--no-ext-diff', '--no-textconv', '--no-color'];

/** 被忽略、但运行测试通常需要的目录；存在时从主工作区链接进隔离工作区。 */
export const DEFAULT_LINKS = ['node_modules', '.venv', 'venv'];

const failure = (code, message, files = []) => Object.assign(new Error(message), { code, files });
const list = files => `${files.slice(0, 20).join(', ')}${files.length > 20 ? ` 等 ${files.length} 个文件` : ''}`;

export function git(cwd, args, { env = {}, input, hooksPath } = {}) {
  const environment = { ...process.env };
  for (const key of INHERITED) delete environment[key];
  try {
    return execFileSync('git', [...(hooksPath ? ['-c', `core.hooksPath=${hooksPath}`] : []), ...args], {
      cwd, input, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...environment, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...env },
    });
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim().split('\n').slice(-5).join(' ');
    throw Object.assign(new Error(`git ${args[0]} 失败：${detail}`), { status: error.status, stdout: error.stdout ?? '' });
  }
}

/** cwd 所在仓库的物理根目录；不在仓库中或未安装 git 时返回 undefined。 */
export function repoRoot(cwd) {
  try { return realpathSync(git(cwd, ['rev-parse', '--show-toplevel']).trim()); }
  catch { return undefined; }
}

function temporaryIndex(tempDir) {
  mkdirSync(tempDir, { recursive: true });
  return path.join(tempDir, `index-${randomUUID()}`);
}

function removeIndex(index) {
  rmSync(index, { force: true });
  rmSync(`${index}.lock`, { force: true });
}

/** 用临时索引把工作区当前内容（遵循 .gitignore）写成树对象，不触碰真实索引。 */
export function snapshotTree(root, { tempDir, excludes = [] }) {
  const index = temporaryIndex(tempDir);
  try {
    // 复制现有索引可复用文件状态缓存，大仓库只需重新哈希变化的文件。
    const current = path.resolve(root, git(root, ['rev-parse', '--git-path', 'index']).trim());
    if (existsSync(current)) copyFileSync(current, index);
    const env = { GIT_INDEX_FILE: index };
    git(root, ['add', '-A', '--', '.', ...excludes.map(item => `:(exclude,literal)${item}`)], { env });
    return git(root, ['write-tree'], { env }).trim();
  } finally { removeIndex(index); }
}

function head(repo) {
  try { return git(repo, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).trim() || undefined; }
  catch { return undefined; }
}

// 快照提交不挂在任何分支上，只由 worktree 的 HEAD 引用。
const commitTree = (repo, tree, parent, message) => git(repo,
  ['commit-tree', '--no-gpg-sign', tree, ...(parent ? ['-p', parent] : []), '-m', message], { env: IDENTITY }).trim();

function emptyHooks(tempDir) {
  const directory = path.join(tempDir, 'no-hooks');
  mkdirSync(directory, { recursive: true });
  return directory;
}

function linkPaths(source, target, links) {
  const linked = [];
  for (const item of links) {
    const from = path.resolve(source, item);
    const to = path.resolve(target, item);
    if (from === source || !inside(source, from)) throw new Error(`links 必须是 cwd 内的相对路径：${item}`);
    if (!existsSync(from)) continue;
    try { lstatSync(to); continue; } // 已被版本库跟踪或已存在，不覆盖。
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    mkdirSync(path.dirname(to), { recursive: true });
    const directory = statSync(from).isDirectory();
    try { symlinkSync(from, to, directory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file'); }
    catch (error) {
      // Windows 没有符号链接权限时，单个文件退回复制；目录使用 junction，无需该权限。
      if (directory || !['EPERM', 'EACCES'].includes(error.code)) throw error;
      copyFileSync(from, to);
    }
    linked.push(path.relative(target, to));
  }
  return linked;
}

/** 以主工作区当前内容为基线创建分离 HEAD 的 worktree，返回需持久化的记录。 */
export function createWorktree({ cwd, root, tempDir, links = [] }) {
  const repo = repoRoot(cwd);
  if (!repo) throw new Error('cwd 不在 git 仓库中或未安装 git，无法创建隔离工作区');
  const relativeCwd = path.relative(repo, cwd);
  if (existsSync(root)) throw new Error(`隔离工作区路径已存在但未登记：${root}；请核实其中内容后删除再重试`);
  const tree = snapshotTree(repo, { tempDir });
  const base = commitTree(repo, tree, head(repo), 'cc-team-mcp worktree base');
  mkdirSync(path.dirname(root), { recursive: true });
  git(repo, ['worktree', 'add', '--detach', root, base], { hooksPath: emptyHooks(tempDir) });
  const physicalRoot = realpathSync(root);
  const worktreeCwd = path.join(physicalRoot, relativeCwd);
  const linked = linkPaths(cwd, worktreeCwd, links).map(item => toPosix(path.join(relativeCwd, item)));
  return { repoRoot: repo, root: physicalRoot, cwd: worktreeCwd, base, baseTree: tree, links: linked,
    createdAt: new Date().toISOString() };
}

function nameStatus(repo, from, to) {
  const parts = git(repo, ['diff', '--name-status', '-z', ...DIFF_OPTIONS, from, to]).split('\0');
  const files = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i]) files.push({ status: parts[i][0], path: parts[i + 1] });
  }
  return files;
}

/** 工作者自基线以来的改动（路径相对仓库根、以 / 分隔）。 */
export function worktreeChanges(worktree, { tempDir }) {
  const tree = snapshotTree(worktree.root, { tempDir, excludes: worktree.links ?? [] });
  return { tree, files: tree === worktree.baseTree ? [] : nameStatus(worktree.repoRoot, worktree.baseTree, tree) };
}

export function worktreeDiff(worktree, { tempDir }) {
  const { tree, files } = worktreeChanges(worktree, { tempDir });
  if (!files.length) return { tree, files, stat: '', patch: '' };
  const range = [worktree.baseTree, tree];
  return { tree, files, stat: git(worktree.repoRoot, ['diff', '--stat=200', ...DIFF_OPTIONS, ...range]),
    patch: git(worktree.repoRoot, ['diff', ...DIFF_OPTIONS, ...range]) };
}

function mergeTrees(repo, base, ours, theirs) {
  // merge-tree 需要提交对象：两侧都以基线为父提交，合并基点即为基线。
  const baseCommit = commitTree(repo, base, undefined, 'cc-team-mcp merge base');
  try {
    return git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages',
      commitTree(repo, ours, baseCommit, 'cc-team-mcp main'), commitTree(repo, theirs, baseCommit, 'cc-team-mcp worker')]).split('\n')[0].trim();
  } catch (error) {
    if (error.status === 1 && error.stdout) {
      const conflicts = error.stdout.split('\n').slice(1).map(line => line.trim()).filter(Boolean);
      throw failure('CONFLICT', `与主工作区的改动冲突：${list(conflicts)}`, conflicts);
    }
    throw failure('MERGE', `主工作区也改动了相同文件，三方合并需要 git 2.38 及以上的 merge-tree：${error.message}`);
  }
}

function pruneEmpty(root, directory) {
  while (directory !== root && inside(root, directory)) {
    try { rmdirSync(directory); } catch { return; } // 非空或已不存在即停止。
    directory = path.dirname(directory);
  }
}

function writeEntries(repo, tree, entries, tempDir) {
  const index = temporaryIndex(tempDir);
  try {
    const env = { GIT_INDEX_FILE: index };
    git(repo, ['read-tree', tree], { env });
    for (const entry of entries.filter(item => item.status === 'D')) {
      const file = path.join(repo, entry.path);
      try { if (!lstatSync(file).isDirectory()) unlinkSync(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      pruneEmpty(repo, path.dirname(file));
    }
    const writes = entries.filter(item => item.status !== 'D').map(item => item.path);
    // checkout-index 按主工作区的属性做换行和过滤转换，二进制、权限位和符号链接也按原样写出。
    if (writes.length) git(repo, ['checkout-index', '-f', '-z', '--stdin'], { env, input: `${writes.join('\0')}\0` });
  } finally { removeIndex(index); }
}

/**
 * 把工作者改动写回主工作区。allowed(path) 判断仓库相对路径是否在分配范围内；
 * 任一改动越界则整体拒绝。主工作区同时改过相同文件时做三方合并，冲突则拒绝。
 * 返回新的基线树（下次只合并之后的增量）和实际写回的文件。
 */
export function integrateWorktree(worktree, { allowed, tempDir }) {
  const { tree: theirs, files } = worktreeChanges(worktree, { tempDir });
  if (!files.length) return { tree: theirs, files: [] };
  const outside = files.map(file => file.path).filter(file => !allowed(file));
  if (outside.length) throw failure('SCOPE', `修改超出分配范围：${list(outside)}`, outside);
  const changed = new Set(files.map(file => file.path));
  const ours = snapshotTree(worktree.repoRoot, { tempDir });
  let target = theirs;
  if (ours !== worktree.baseTree && nameStatus(worktree.repoRoot, worktree.baseTree, ours).some(file => changed.has(file.path))) {
    target = mergeTrees(worktree.repoRoot, worktree.baseTree, ours, theirs);
  }
  const entries = nameStatus(worktree.repoRoot, ours, target).filter(file => changed.has(file.path));
  writeEntries(worktree.repoRoot, target, entries, tempDir);
  return { tree: theirs, files: entries };
}

/** 先拆除链接（不跟随进入主工作区），再删除 worktree 及其登记。 */
export function removeWorktree(worktree) {
  for (const item of worktree.links ?? []) {
    const file = path.join(worktree.root, item);
    let info;
    try { info = lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (info.isSymbolicLink()) {
      try { unlinkSync(file); }
      catch (error) { if (process.platform !== 'win32') throw error; rmdirSync(file); }
    } else if (info.isFile()) rmSync(file, { force: true });
  }
  if (!existsSync(worktree.repoRoot)) { rmSync(worktree.root, { recursive: true, force: true }); return; }
  if (existsSync(worktree.root)) git(worktree.repoRoot, ['worktree', 'remove', '--force', worktree.root]);
  else git(worktree.repoRoot, ['worktree', 'prune']);
}
