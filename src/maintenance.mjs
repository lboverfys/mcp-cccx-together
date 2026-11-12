import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Store, processIsAlive, readWorkers } from './store.mjs';
import { ResultStore } from './results.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function teamDirectory(config, teamId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(teamId)) throw new Error('无效团队 ID');
  const root = realpathSync(config.stateDir);
  const directory = realpathSync(path.join(root, teamId));
  if (path.dirname(directory) !== root || !statSync(directory).isDirectory()) throw new Error('团队目录必须直接位于状态目录内，不能经链接越界');
  return directory;
}

function assertStopped(workers) {
  for (const worker of workers) {
    if (worker.status === 'closed' || worker.processExited) continue;
    if (worker.lastPid && processIsAlive(worker.lastPid)) throw new Error(`工作者 ${worker.name ?? worker.id} 的 PID ${worker.lastPid} 仍存活，未执行维护`);
    if (worker.startedAt && !worker.lastPid) throw new Error(`工作者 ${worker.name ?? worker.id} 缺少退出确认及 PID，请先核实并关闭原进程`);
  }
}

function filesIn(directory) {
  try {
    if (lstatSync(directory).isSymbolicLink()) throw new Error(`维护目录不能是链接：${directory}`);
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export async function pruneTeam(config, teamId, { keepResults, apply = false }) {
  if (!Number.isSafeInteger(keepResults) || keepResults < 1) throw new Error('keep-results 必须是正整数');
  const directory = teamDirectory(config, teamId);
  const store = await new Store(directory).init({ compactEvents: false });
  try {
    const workers = store.listWorkers();
    assertStopped(workers);
    const resultsDir = path.join(directory, 'results');
    const resultStore = new ResultStore(resultsDir);
    const candidates = new Map();
    const keep = new Set();
    const pin = (workerId, resultId) => { if (resultId) keep.add(`${workerId}/${resultId}`); };
    for (const worker of workers) {
      pin(worker.id, worker.lastResult?.resultId);
      pin(worker.id, worker.lastReview?.resultId);
      for (const [id, snapshot] of Object.entries(worker.dependencyResults ?? {})) pin(id, snapshot.resultId);
      for (const [id, resultId] of Object.entries(worker.lastResult?.dependencyResultIds ?? {})) pin(id, resultId);
    }
    for (const workerDir of filesIn(resultsDir)) {
      if (!workerDir.isDirectory() || !uuid.test(workerDir.name)) continue;
      const entries = [];
      for (const entry of filesIn(path.join(resultsDir, workerDir.name))) {
        const resultId = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : '';
        if (!entry.isFile() || !uuid.test(resultId)) continue;
        const file = path.join(resultsDir, workerDir.name, entry.name);
        const info = statSync(file);
        const item = { key: `${workerDir.name}/${resultId}`, file, bytes: info.size, modifiedAt: info.mtimeMs };
        candidates.set(item.key, item);
        entries.push(item);
      }
      entries.sort((a, b) => b.modifiedAt - a.modifiedAt || a.key.localeCompare(b.key));
      for (const item of entries.slice(0, keepResults)) keep.add(item.key);
    }
    // 保留结果本身引用的旧版依赖也要保留，按引用闭包读取，每份最多读取一次。
    for (const key of keep) {
      if (!candidates.has(key)) throw new Error(`被引用的交付缺失，停止清理：${key}`);
      const [workerId, resultId] = key.split('/');
      const result = resultStore.get(workerId, resultId);
      if (result.workerId !== workerId || result.resultId !== resultId) throw new Error(`交付标识与文件不一致：${key}`);
      for (const [id, version] of Object.entries(result.dependencyResultIds ?? {})) pin(id, version);
    }
    const removableResults = [...candidates.values()].filter(item => !keep.has(item.key));
    const referenced = store.recordFiles();
    const orphanRecords = filesIn(path.join(directory, 'workers')).filter(entry => entry.isFile()
      && entry.name.endsWith('.json') && uuid.test(entry.name.slice(0, -5)) && !referenced.has(entry.name)).map(entry => {
      const file = path.join(directory, 'workers', entry.name);
      return { file, bytes: statSync(file).size };
    });
    const removable = [...removableResults, ...orphanRecords];
    let removed = 0;
    if (apply) {
      try { for (const item of removable) { unlinkSync(item.file); removed++; } }
      catch (error) { throw new Error(`清理中止，已删除 ${removed}/${removable.length} 个文件：${error.message}`, { cause: error }); }
    }
    return { teamId, applied: apply, keepResults, retainedResults: keep.size,
      removableResults: removableResults.length, orphanRecords: orphanRecords.length,
      bytes: removable.reduce((sum, item) => sum + item.bytes, 0), removed,
      files: removable.slice(0, 100).map(item => path.relative(directory, item.file)), omittedFiles: Math.max(0, removable.length - 100) };
  } finally { store.close(); }
}

function staleLock(directory) {
  const file = path.join(directory, 'store.lock');
  if (!existsSync(file)) return null;
  if (lstatSync(file).isSymbolicLink() || statSync(file).size > 4096) throw new Error('锁文件异常，未修改');
  const owner = JSON.parse(readFileSync(file, 'utf8'));
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string' || !owner.token) throw new Error('锁文件格式异常，未修改');
  if (processIsAlive(owner.pid)) throw new Error(`团队持有进程 ${owner.pid} 仍存活，不能恢复锁`);
  assertStopped(readWorkers(directory).workers);
  return owner;
}

export function recoverTeam(config, teamId, { apply = false } = {}) {
  const directory = teamDirectory(config, teamId);
  const gate = path.join(directory, 'recovery.lock');
  if (!apply) {
    if (existsSync(gate)) throw new Error('已有恢复操作或未完成的恢复锁，请先核实 recovery.lock');
    const owner = staleLock(directory);
    return { teamId, applied: false, recoverable: Boolean(owner), owner };
  }
  // 恢复操作互斥；普通打开也检查此锁，避免移走另一个恢复者刚创建的正常锁。
  const handle = openSync(gate, 'wx', 0o600);
  try {
    writeFileSync(handle, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    const owner = staleLock(directory);
    if (!owner) return { teamId, applied: false, recoverable: false, owner: null };
    const backup = `store.lock.recovered-${randomUUID()}.json`;
    renameSync(path.join(directory, 'store.lock'), path.join(directory, backup));
    return { teamId, applied: true, recovered: true, owner, backup: path.join(directory, backup) };
  } finally { closeSync(handle); unlinkSync(gate); }
}
