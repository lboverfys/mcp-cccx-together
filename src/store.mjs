import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, renameSync, unlinkSync, statSync, appendFileSync, existsSync, fsyncSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

const RETAINED_EVENTS = 2000;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_WORKERS_BYTES = 8 * 1024 * 1024;
const MAX_TEAM_BYTES = 128 * 1024;
const COMPACT_EXTRA_BYTES = 4 * 1024 * 1024;
const RECORD_FILE = /^[0-9a-f-]{36}\.json$/;

export function workerCatalog(value) {
  if (Array.isArray(value)) return { legacy: true, records: value };
  if (value?.format !== 'cc-team-workers-v2' || !Array.isArray(value.records)) throw new Error('workers.json 必须是工作者数组或受支持的索引');
  const ids = new Set(), files = new Set();
  for (const record of value.records) {
    if (!record || typeof record.id !== 'string' || !record.id || !RECORD_FILE.test(record.file)
      || !Number.isSafeInteger(record.bytes) || record.bytes < 1 || record.bytes > MAX_WORKERS_BYTES
      || ids.has(record.id) || files.has(record.file)) throw new Error('工作者索引记录无效或重复');
    ids.add(record.id); files.add(record.file);
  }
  return { legacy: false, records: value.records };
}

export function readWorkers(directory) {
  let value;
  try { value = readBoundedJson(path.join(directory, 'workers.json'), MAX_WORKERS_BYTES); }
  catch (error) { if (isMissing(error)) return { legacy: true, records: [], workers: [] }; throw error; }
  const catalog = workerCatalog(value);
  const workers = catalog.legacy ? catalog.records : catalog.records.map(record => {
    const file = path.join(directory, 'workers', record.file);
    if (statSync(file).size !== record.bytes) throw new Error(`工作者记录长度与索引不一致：${record.id}`);
    const worker = readBoundedJson(file, MAX_WORKERS_BYTES);
    if (worker.id !== record.id) throw new Error(`工作者记录 ID 与索引不一致：${record.id}`);
    return worker;
  });
  const ids = new Set();
  for (const worker of workers) {
    if (!worker || typeof worker.id !== 'string' || !worker.id) throw new Error('工作者记录缺少有效 id');
    if (ids.has(worker.id)) throw new Error(`工作者记录 id 重复：${worker.id}`);
    ids.add(worker.id);
  }
  return { ...catalog, workers };
}

function jsonCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

function readBoundedJson(file, maximum) {
  if (statSync(file).size > maximum) throw new Error(`状态文件超过允许大小：${file}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

function isMissing(error) {
  return error.code === 'ENOENT';
}

export function processIsAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

export class Store extends EventEmitter {
  #workers = new Map();
  #team = {};
  #events = [];
  #lastCursor = 0;
  #eventBytes = 0;
  #logBytes = 0;
  #logCount = 0;
  #token;
  #active = false;
  #files = new Map();
  #sizes = new Map();
  #cleanupWarnings = [];

  constructor(dir) {
    super();
    this.dir = path.resolve(dir);
    this.lockPath = path.join(this.dir, 'store.lock');
    this.workersPath = path.join(this.dir, 'workers.json');
    this.recordsDir = path.join(this.dir, 'workers');
    this.teamPath = path.join(this.dir, 'team.json');
    this.eventsPath = path.join(this.dir, 'events.jsonl');
  }

  async init({ compactEvents = true } = {}) {
    if (this.#active) throw new Error('状态存储已初始化');
    mkdirSync(this.dir, { recursive: true });
    this.#acquireLock();
    try {
      this.#workers.clear();
      this.#files.clear();
      this.#sizes.clear();
      this.#cleanupWarnings = [];
      this.#team = {};
      this.#events = [];
      this.#lastCursor = 0;
      this.#eventBytes = 0;
      this.#logBytes = 0;
      this.#logCount = 0;
      try {
        this.#team = readBoundedJson(this.teamPath, MAX_TEAM_BYTES);
        if (!this.#team || Array.isArray(this.#team) || typeof this.#team !== 'object') throw new Error('team.json 必须是团队元数据对象');
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      const { workers, records, legacy } = readWorkers(this.dir);
      if (!legacy) for (const record of records) this.#files.set(record.id, record);
      for (const worker of workers) {
        this.#workers.set(worker.id, worker);
        this.#sizes.set(worker.id, Buffer.byteLength(JSON.stringify(worker)));
      }
      await this.#loadEvents();
      this.#active = true;
      if (compactEvents) this.#compactIfNeeded();
      return this;
    } catch (error) {
      this.#active = false;
      this.#releaseLock();
      throw error;
    }
  }

  #acquireLock() {
    if (existsSync(path.join(this.dir, 'recovery.lock'))) throw new Error('状态目录正在执行锁恢复，请等待恢复结束');
    const token = randomUUID();
    let fd;
    try {
      fd = openSync(this.lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try {
        owner = readBoundedJson(this.lockPath, 4096);
      } catch (cause) {
        throw new Error(`无法核实已有状态锁，未修改该文件：${this.lockPath}`, { cause });
      }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') {
        throw new Error(`状态锁格式异常，未修改该文件：${this.lockPath}`);
      }
      if (processIsAlive(owner.pid)) {
        throw new Error(`状态目录正被进程 ${owner.pid} 使用：${this.dir}`);
      }
      throw new Error(`检测到原进程 ${owner.pid} 已退出的状态锁；请核实后移除 ${this.lockPath} 再重试，未自动删除`);
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), 'utf8');
      this.#token = token;
    } catch (error) {
      closeSync(fd);
      unlinkSync(this.lockPath);
      throw error;
    }
    closeSync(fd);
  }

  #releaseLock() {
    if (!this.#token) return;
    const owner = readBoundedJson(this.lockPath, 4096);
    if (owner.token !== this.#token || owner.pid !== process.pid) {
      throw new Error(`状态锁归属已改变，未删除：${this.lockPath}`);
    }
    unlinkSync(this.lockPath);
    this.#token = undefined;
  }

  #assertActive() {
    if (!this.#active) throw new Error('状态存储未初始化或已关闭');
  }

  #writeAtomic(file, text) {
    const temporary = `${file}.${this.#token}.tmp`;
    let created = false;
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      created = true;
      try { writeFileSync(fd, text, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, file);
    } catch (error) {
      if (created) {
        try { unlinkSync(temporary); } catch (cleanupError) {
          if (!isMissing(cleanupError)) throw new AggregateError([error, cleanupError], '写入状态失败，临时文件清理也失败');
        }
      }
      throw error;
    }
  }

  saveWorker(worker) {
    return this.saveWorkers([worker])[0];
  }

  saveWorkers(workers) {
    this.#assertActive();
    const next = new Map(this.#workers);
    const records = workers.map(worker => {
      if (!worker || typeof worker.id !== 'string' || !worker.id) throw new Error('工作者必须有非空 id');
      const { runtime, ...metadata } = worker;
      const record = jsonCopy(metadata);
      next.set(record.id, record);
      return record;
    });
    const changed = new Map(records.map(record => [record.id, record]));
    // 旧数组格式只在第一次写入时迁移；索引原子替换是整个批次的提交点。
    for (const [id, record] of next) if (!this.#files.has(id)) changed.set(id, record);
    const encoded = [...changed.values()].map(record => {
      const text = JSON.stringify(record);
      const bytes = Buffer.byteLength(text);
      if (bytes > MAX_WORKERS_BYTES) throw new Error(`工作者 ${record.id} 元数据超过 8 MiB 上限，请拆分任务或缩小交接内容`);
      return { text, entry: { id: record.id, file: `${randomUUID()}.json`, bytes, name: record.name, cwd: record.cwd } };
    });
    const files = new Map(this.#files);
    for (const { entry } of encoded) files.set(entry.id, entry);
    const index = JSON.stringify({ format: 'cc-team-workers-v2', records: [...files.values()] });
    if (Buffer.byteLength(index) > MAX_WORKERS_BYTES) throw new Error('团队索引超过 8 MiB，请关闭当前团队并创建新团队');
    mkdirSync(this.recordsDir, { recursive: true, mode: 0o700 });
    const created = [];
    try {
      for (const { text, entry } of encoded) {
        const file = path.join(this.recordsDir, entry.file);
        this.#writeAtomic(file, text);
        created.push(file);
      }
      this.#writeAtomic(this.workersPath, index);
    } catch (error) {
      const failures = [];
      for (const file of created) {
        try { unlinkSync(file); } catch (cleanup) { if (!isMissing(cleanup)) failures.push(cleanup); }
      }
      if (failures.length) throw new AggregateError([error, ...failures], '保存工作者失败，部分未提交记录需通过 prune 清理');
      throw error;
    }
    const obsolete = encoded.map(({ entry }) => this.#files.get(entry.id)?.file).filter(Boolean);
    this.#files = files;
    this.#workers = next;
    for (const { entry } of encoded) this.#sizes.set(entry.id, entry.bytes);
    for (const file of obsolete) {
      try { unlinkSync(path.join(this.recordsDir, file)); }
      catch (error) {
        if (!isMissing(error)) this.#cleanupWarnings = [...this.#cleanupWarnings.slice(-9), `状态已保存，旧记录 ${file} 未能清理：${error.message}`];
      }
    }
    return jsonCopy(records);
  }

  storageInfo() {
    this.#assertActive();
    return { format: this.#files.size ? 'cc-team-workers-v2' : 'legacy', workerCount: this.#workers.size,
      workerBytes: [...this.#sizes.values()].reduce((total, bytes) => total + bytes, 0),
      maxWorkerBytes: MAX_WORKERS_BYTES, warnings: [...this.#cleanupWarnings] };
  }

  recordFiles() {
    this.#assertActive();
    return new Set([...this.#files.values()].map(record => record.file));
  }

  loadTeam() {
    this.#assertActive();
    return jsonCopy(this.#team);
  }

  saveTeam(metadata) {
    this.#assertActive();
    const encoded = JSON.stringify(metadata);
    if (Buffer.byteLength(encoded) > MAX_TEAM_BYTES) throw new Error('团队元数据超过 128 KiB 上限');
    const record = JSON.parse(encoded);
    this.#writeAtomic(this.teamPath, encoded);
    this.#team = record;
    return jsonCopy(record);
  }

  listWorkers() {
    this.#assertActive();
    return jsonCopy([...this.#workers.values()]);
  }

  #remember(event, bytes) {
    this.#events.push({ event, bytes });
    this.#eventBytes += bytes;
    this.#lastCursor = event.cursor;
    if (this.#events.length > RETAINED_EVENTS) {
      this.#eventBytes -= this.#events.shift().bytes;
    }
  }

  async #loadEvents() {
    let file;
    try { file = await open(this.eventsPath, 'r'); } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    const chunk = Buffer.allocUnsafe(MAX_EVENT_BYTES);
    let pending = Buffer.alloc(0);
    try {
      for (;;) {
        const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        this.#logBytes += bytesRead;
        const data = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
        let start = 0;
        for (;;) {
          const end = data.indexOf(10, start);
          if (end === -1) break;
          const line = data.subarray(start, end);
          if (line.length + 1 > MAX_EVENT_BYTES) throw new Error('事件日志含超过 64 KiB 的记录');
          const event = JSON.parse(line.toString('utf8'));
          if (!Number.isSafeInteger(event.cursor) || event.cursor <= this.#lastCursor || typeof event.type !== 'string') {
            throw new Error('事件日志的游标或类型无效');
          }
          this.#remember(event, line.length + 1);
          this.#logCount += 1;
          start = end + 1;
        }
        pending = Buffer.from(data.subarray(start));
        if (pending.length >= MAX_EVENT_BYTES) throw new Error('事件日志含超过 64 KiB 的记录');
      }
      if (pending.length) throw new Error('事件日志尾行不完整，请保留文件并检查异常退出原因');
    } finally {
      await file.close();
    }
  }

  #compactIfNeeded() {
    if (this.#logCount <= RETAINED_EVENTS * 2 && this.#logBytes <= this.#eventBytes + COMPACT_EXTRA_BYTES) return;
    const encoded = this.#events.map(({ event }) => `${JSON.stringify(event)}\n`).join('');
    this.#writeAtomic(this.eventsPath, encoded);
    this.#logCount = this.#events.length;
    this.#logBytes = Buffer.byteLength(encoded);
    this.#eventBytes = this.#logBytes;
  }

  append(workerId, type, data) {
    this.#assertActive();
    if (typeof type !== 'string' || !type) throw new Error('事件类型不能为空');
    if (!Number.isSafeInteger(this.#lastCursor + 1)) throw new Error('事件游标达到安全整数上限');
    const event = { cursor: this.#lastCursor + 1, workerId, type, data, at: new Date().toISOString() };
    const encoded = `${JSON.stringify(event)}\n`;
    const bytes = Buffer.byteLength(encoded);
    if (bytes > MAX_EVENT_BYTES) throw new Error('单条事件超过 64 KiB 上限');
    const record = JSON.parse(encoded);
    appendFileSync(this.eventsPath, encoded, { encoding: 'utf8', mode: 0o600 });
    this.#remember(record, bytes);
    this.#logBytes += bytes;
    this.#logCount += 1;
    this.#compactIfNeeded();
    this.emit('appended', jsonCopy(record));
    return jsonCopy(record);
  }

  events({ after = 0, workerIds, limit = 100 } = {}) {
    this.#assertActive();
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('after 必须是非负整数');
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('limit 必须在 1 到 500 之间');
    if (workerIds !== undefined && (!Array.isArray(workerIds) || workerIds.some(id => typeof id !== 'string'))) {
      throw new Error('workerIds 必须是字符串数组');
    }
    const filter = workerIds === undefined ? null : new Set(workerIds);
    const oldestCursor = this.#events[0]?.event.cursor ?? this.#lastCursor + 1;
    const records = [];
    let nextCursor = after;
    let hasMore = false;
    for (const { event } of this.#events) {
      if (event.cursor <= after) continue;
      if (filter && !filter.has(event.workerId)) {
        nextCursor = event.cursor;
        continue;
      }
      if (records.length === limit) {
        hasMore = true;
        break;
      }
      records.push(event);
      nextCursor = event.cursor;
    }
    return {
      events: jsonCopy(records),
      nextCursor,
      hasMore,
      gap: after < oldestCursor - 1,
      oldestCursor,
    };
  }

  close() {
    this.#releaseLock();
    this.#active = false;
    this.removeAllListeners();
  }
}
