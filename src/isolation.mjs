import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { inside, physicalPath, toPosix } from './paths.mjs';
import { DEFAULT_LINKS, createWorktree, integrateWorktree, removeWorktree, repoRoot, worktreeChanges, worktreeDiff } from './worktree.mjs';

const clip = (text, max) => String(text ?? '').slice(0, max);
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 团队的写入隔离：决定任务是否使用 worktree，创建和清理 worktree，
 * 验收时合并范围内改动，并把消息里的主工作区路径映射到隔离工作区。
 * 工作者状态的保存和事件记录仍由 TeamManager 负责。
 */
export class WorktreeIsolation {
  constructor(manager) {
    this.manager = manager;
  }

  get tempDir() {
    return resolve(this.manager.config.tempDir, this.manager.teamId, 'git');
  }

  /** 派发时决定隔离方式：git 仓库中的写入任务默认 worktree，否则退回共享工作区并警告。 */
  resolve(spec, warnings) {
    const label = spec.name;
    let isolation = spec.isolation;
    if (isolation === 'worktree' && spec.access !== 'write') throw new Error(`${label}：只有 write 任务支持 worktree 隔离`);
    if (spec.access === 'write' && isolation !== 'shared') {
      const repository = repoRoot(spec.cwd);
      if (repository && inside(repository, physicalPath(resolve(this.manager.config.stateDir)))) {
        throw new Error(`${label}：stateDir 位于该 git 仓库内，隔离工作区会被主工作区快照收录；请把 stateDir 移到仓库外，或使用 isolation "shared"`);
      }
      if (repository) isolation = 'worktree';
      else if (isolation === 'worktree') throw new Error(`${label}：cwd 不在 git 仓库中或未安装 git，不能使用 worktree 隔离`);
      else {
        isolation = 'shared';
        warnings.push(`${label}：cwd 不是 git 仓库，写入任务直接修改主工作区，并行写入和 verify 不能互相隔离`);
      }
    }
    isolation ??= 'shared';
    for (const link of spec.links ?? []) {
      const full = resolve(spec.cwd, link);
      if (isAbsolute(link) || full === spec.cwd || !inside(spec.cwd, full)) throw new Error(`${label}：links 必须是 cwd 内的相对路径：${link}`);
    }
    if (spec.links?.length && isolation !== 'worktree') warnings.push(`${label}：links 只在 worktree 隔离时生效，已忽略`);
    return { isolation, ...(isolation === 'worktree' ? { links: spec.links ?? DEFAULT_LINKS } : {}) };
  }

  /** 首次启动时创建 worktree；已登记但目录已清理时在原路径重建，CC 会话按路径恢复。 */
  ensure(worker, warnings = []) {
    const { data } = worker;
    if (data.worktree && existsSync(data.worktree.root)) return;
    const { config, teamId } = this.manager;
    const root = data.worktree?.root ?? resolve(config.stateDir, teamId, 'worktrees', data.id);
    const recreated = Boolean(data.worktree);
    data.worktree = createWorktree({ cwd: data.cwd, root, tempDir: this.tempDir, links: data.links ?? [] });
    this.manager.save(worker);
    try { this.manager.event(data.id, 'worktree', { root: data.worktree.root, cwd: data.worktree.cwd, links: data.worktree.links, recreated }); }
    catch (error) { warnings.push(`${data.name} 的隔离工作区已创建，但事件记录失败：${error.message}`); }
  }

  /** 写入任务的文件工具允许修改的位置：分配范围（隔离时映射到 worktree）和自身临时目录。 */
  writeRoots(worker) {
    const { data } = worker;
    if (data.access !== 'write') return undefined;
    const scopes = data.worktree
      ? data.scopes.map(scope => resolve(data.worktree.root, relative(data.worktree.repoRoot, scope)))
      : data.scopes;
    return [...scopes, resolve(this.manager.config.tempDir, this.manager.teamId, data.id)];
  }

  /** 判断仓库相对路径是否在分配范围内。 */
  scopeFilter(data) {
    const key = path => this.manager.scopeKey(path);
    const scopes = data.scopes.map(scope => key(toPosix(relative(data.worktree.repoRoot, scope))));
    return file => scopes.some(scope => scope === '' || key(file) === scope || key(file).startsWith(`${scope}/`));
  }

  /** 合并隔离工作区的改动；返回结果而不抛错，由调用方决定发回修复、拒绝或报错。 */
  merge(worker) {
    const { data } = worker;
    try {
      if (!existsSync(data.worktree.root)) return { ok: true, files: [], worktree: data.worktree };
      const merged = integrateWorktree(data.worktree, { allowed: this.scopeFilter(data), tempDir: this.tempDir });
      return { ok: true, files: merged.files,
        worktree: merged.files.length ? { ...data.worktree, baseTree: merged.tree, integratedAt: new Date().toISOString() } : data.worktree };
    } catch (error) {
      return { ok: false, kind: error.code === 'SCOPE' ? 'scope' : error.code === 'CONFLICT' ? 'conflict' : 'error',
        files: error.files ?? [], error: clip(error.message, 4000) };
    }
  }

  /** 关闭后清理没有未合并改动的 worktree；有改动时保留并报告，不影响关闭结果。 */
  release(worker) {
    const { worktree } = worker.data;
    if (!worktree || !existsSync(worktree.root)) return undefined;
    try {
      const { files } = worktreeChanges(worktree, { tempDir: this.tempDir });
      if (files.length) return { root: worktree.root, removed: false, pendingFiles: files.length };
      removeWorktree(worktree);
      return { root: worktree.root, removed: true };
    } catch (error) {
      return { root: worktree.root, removed: false, error: clip(error.message, 1000) };
    }
  }

  diff(worker, { offset = 0, limit = 50000 } = {}) {
    const { data } = worker;
    if (!data.worktree) throw new Error('只有 worktree 隔离的写入任务可单独查看改动；共享工作区无法区分各工作者的修改');
    if (!existsSync(data.worktree.root)) throw new Error('隔离工作区已清理，没有未合并的改动');
    const diff = worktreeDiff(data.worktree, { tempDir: this.tempDir });
    const allowed = this.scopeFilter(data);
    return { workerId: data.id, name: data.name, worktree: data.worktree.root, baseTree: data.worktree.baseTree, tree: diff.tree,
      files: diff.files, outsideScope: diff.files.map(file => file.path).filter(file => !allowed(file)),
      stat: clip(diff.stat, 20000), offset, text: diff.patch.slice(offset, offset + limit),
      nextOffset: Math.min(diff.patch.length, offset + limit), totalLength: diff.patch.length,
      hasMore: offset + limit < diff.patch.length, offsetUnit: 'chars' };
  }

  /** 把消息中的主工作区路径换成隔离工作区路径，避免工作者按绝对路径改到主工作区。 */
  mapPaths(data, text) {
    const { platform } = this.manager;
    const target = data.worktree.cwd;
    const sources = [...new Set([data.cwd, data.requestedCwd].filter(Boolean)
      .flatMap(source => platform === 'win32' ? [source, source.replaceAll('\\', '/')] : [source]))]
      .sort((a, b) => b.length - a.length);
    const flags = platform === 'win32' || platform === 'darwin' ? 'gi' : 'g';
    const pattern = new RegExp(`(?:${sources.map(escapeRegExp).join('|')})(?![\\w.-])`, flags);
    return text.replace(pattern, match => match.includes('\\') || !target.includes('\\') ? target : target.replaceAll('\\', '/'));
  }
}
