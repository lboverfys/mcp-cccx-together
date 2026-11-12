import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, readSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const MAX_BYTES = 8 * 1024 * 1024;
const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 完整交付独立保存，不随有界事件日志滚动丢失。 */
export class ResultStore {
  constructor(directory) { this.directory = resolve(directory); }

  file(workerId, resultId) {
    if (!identifier.test(workerId) || !identifier.test(resultId)) throw new Error('无效的工作者或结果 ID');
    return resolve(this.directory, workerId, `${resultId}.json`);
  }

  save(workerId, data) {
    const resultId = randomUUID();
    const destination = this.file(workerId, resultId);
    const encoded = JSON.stringify({ ...data, workerId, resultId, createdAt: new Date().toISOString() });
    const bytes = Buffer.byteLength(encoded);
    if (bytes > MAX_BYTES) throw new Error('完整交付超过 8 MiB，请将大型产物写入项目文件后汇报路径');
    mkdirSync(resolve(this.directory, workerId), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.tmp`;
    const handle = openSync(temporary, 'wx', 0o600);
    try {
      try { writeFileSync(handle, encoded); } finally { closeSync(handle); }
      renameSync(temporary, destination);
    } catch (error) {
      try { unlinkSync(temporary); } catch (cleanup) { if (cleanup.code !== 'ENOENT') throw new AggregateError([error, cleanup], '保存交付及清理临时文件失败'); }
      throw error;
    }
    return { resultId, length: bytes, bytes };
  }

  get(workerId, resultId) {
    const file = this.file(workerId, resultId);
    if (statSync(file).size > MAX_BYTES) throw new Error('完整交付文件超过 8 MiB');
    return JSON.parse(readFileSync(file, 'utf8'));
  }

  read(workerId, resultId, { offset = 0, limit = 12000 } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 4 || limit > 100000) {
      throw new Error('结果分页需要非负整数 offset 和 4 至 100000 的 limit');
    }
    const file = this.file(workerId, resultId);
    const totalLength = statSync(file).size;
    if (totalLength > MAX_BYTES) throw new Error('完整交付文件超过 8 MiB');
    if (offset > totalLength) throw new Error('offset 超出完整交付长度');
    const handle = openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(limit, totalLength - offset));
      const count = readSync(handle, buffer, 0, buffer.length, offset);
      if (count && (buffer[0] & 0xc0) === 0x80) throw new Error('offset 不是 UTF-8 字符边界，请使用上次返回的 nextOffset');
      const decoder = new StringDecoder('utf8');
      const text = decoder.write(buffer.subarray(0, count)) + (offset + count === totalLength ? decoder.end() : '');
      const nextOffset = offset + Buffer.byteLength(text);
      return { workerId, resultId, offset, text, nextOffset, totalLength,
        hasMore: nextOffset < totalLength, offsetUnit: 'utf8-bytes' };
    } finally { closeSync(handle); }
  }
}
