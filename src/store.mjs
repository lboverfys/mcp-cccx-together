import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, renameSync, unlinkSync, statSync, appendFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

const RETAINED_EVENTS = 2000;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_WORKERS_BYTES = 8 * 1024 * 1024;
const MAX_TEAM_BYTES = 128 * 1024;
const COMPACT_EXTRA_BYTES = 4 * 1024 * 1024;

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

function processIsAlive(pid) {
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

  constructor(dir) {
    super();
    this.dir = path.resolve(dir);
    this.lockPath = path.join(this.dir, 'store.lock');
    this.workersPath = path.join(this.dir, 'workers.json');
    this.teamPath = path.join(this.dir, 'team.json');
    this.eventsPath = path.join(this.dir, 'events.jsonl');
  }

  async init() {
    if (this.#active) throw new Error('状态存储已初始化');
    mkdirSync(this.dir, { recursive: true });
    this.#acquireLock();
    try {
      this.#workers.clear();
      this.#team = {};
      this.#events = [];
      this.#lastCursor = 0;
      this.#eventBytes = 0;
      this.#logBytes = 0;
      this.#logCount = 0;
      let workers = [];
      try {
        this.#team = readBoundedJson(this.teamPath, MAX_TEAM_BYTES);
        if (!this.#team || Array.isArray(this.#team) || typeof this.#team !== 'object') throw new Error('team.json 必须是团队元数据对象');
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      try {
        workers = readBoundedJson(this.workersPath, MAX_WORKERS_BYTES);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      if (!Array.isArray(workers)) throw new Error('workers.json 必须是工作者数组');
      for (const worker of workers) {
        if (!worker || typeof worker.id !== 'string' || !worker.id) throw new Error('工作者记录缺少有效 id');
        if (this.#workers.has(worker.id)) throw new Error(`工作者记录 id 重复：${worker.id}`);
        this.#workers.set(worker.id, worker);
      }
      await this.#loadEvents();
      this.#active = true;
      this.#compactIfNeeded();
      return this;
    } catch (error) {
      this.#active = false;
      this.#releaseLock();
      throw error;
    }
  }

  #acquireLock() {
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
      try { writeFileSync(fd, text, 'utf8'); } finally { closeSync(fd); }
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
    const encoded = JSON.stringify([...next.values()]);
    if (Buffer.byteLength(encoded) > MAX_WORKERS_BYTES) throw new Error('工作者元数据超过 8 MiB 上限');
    this.#writeAtomic(this.workersPath, encoded);
    this.#workers = next;
    return jsonCopy(records);
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
