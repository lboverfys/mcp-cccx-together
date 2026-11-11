import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ResultStore } from '../src/results.mjs';

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'cc-team-results-'));
  t.after(() => {
    assert(path.dirname(directory) === tmpdir());
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store: new ResultStore(directory), workerId: randomUUID() };
}

test('完整结果跨重开保留，多个结果互不覆盖，包含Unicode与完整错误', t => {
  const { directory, store, workerId } = fixture(t);
  const data = { success: true, text: '接口完整交付𠮷'.repeat(5000), errors: Array.from({ length: 20 }, (_, i) => `详情${i}`) };
  const first = store.save(workerId, data);
  const second = store.save(workerId, { success: false, text: '第二轮' });
  assert.notEqual(first.resultId, second.resultId);
  const reopened = new ResultStore(directory);
  assert.equal(reopened.get(workerId, first.resultId).text, data.text);
  let offset = 0;
  const pieces = [];
  do {
    const page = reopened.read(workerId, first.resultId, { offset, limit: 113 });
    assert(page.nextOffset > offset);
    pieces.push(page.text);
    offset = page.nextOffset;
    if (!page.hasMore) break;
  } while (true);
  const restored = JSON.parse(pieces.join(''));
  assert.equal(restored.text, data.text);
  assert.deepEqual(restored.errors, data.errors);
  assert.equal(offset, first.bytes);
  assert.deepEqual(store.read(workerId, first.resultId, { offset }).text, '');
});

test('结果路径隔离、分页边界和大小限制明确报错', t => {
  const { directory, store, workerId } = fixture(t);
  const saved = store.save(workerId, { text: '中文' });
  assert.throws(() => store.file('../escape', saved.resultId), /无效/);
  assert.throws(() => store.read(workerId, saved.resultId, { limit: 1 }), /分页/);
  assert.throws(() => store.read(workerId, saved.resultId, { offset: saved.bytes + 1 }), /长度/);
  const full = store.read(workerId, saved.resultId).text;
  const invalidOffset = Buffer.byteLength(full.slice(0, full.indexOf('中文'))) + 1;
  assert.throws(() => store.read(workerId, saved.resultId, { offset: invalidOffset }), /字符边界/);
  assert.throws(() => store.save(workerId, { text: 'x'.repeat(8 * 1024 * 1024) }), /8 MiB/);
  assert.equal(readdirSync(path.join(directory, workerId)).length, 1);
});
