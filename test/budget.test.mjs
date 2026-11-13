import test from 'node:test';
import assert from 'node:assert/strict';
import { fitResponse } from '../src/budget.mjs';

const size = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const evidence = count => Array.from({ length: count }, (_, i) => ({ ref: `src/a.js:${i + 1}`, file: 'src/a.js', ok: true, lines: `${i + 1}-${i + 3}`, text: 'x'.repeat(600) }));

test('未超预算时原样返回，不加标记', () => {
  const response = { next: '全部完成', done: true, workers: [{ id: '1', summary: '结论' }] };
  assert.equal(fitResponse(response, 10000), response);
});

test('按重要性逐级压缩：先去掉靠后的证据原文，再截短补丁，最后才截短报告', () => {
  const response = { next: 'x', done: true, workers: [
    { id: '1', summary: '结论一', evidence: evidence(8) },
    { id: '2', summary: '结论二', diff: { files: ['M src/a.js'], patch: 'p'.repeat(9000) } },
  ] };
  const light = fitResponse(response, size(response) - 2000);
  assert.equal(light.compacted, true);
  assert.equal(light.workers[0].evidence.filter(item => item.text).length, 3);
  assert.equal(light.workers[1].diff.patch.length, 9000, '证据压缩已足够时不动补丁');
  assert.equal(response.workers[0].evidence[7].text.length, 600, '不修改原对象');
  const heavy = fitResponse(response, 3000);
  assert.ok(size(heavy) <= 3000);
  assert.equal(heavy.workers[1].diff.patch, undefined);
  assert.equal(heavy.workers[1].diff.patchTruncated, true);
  assert.equal(heavy.workers[1].diff.totalLength, 9000);
  assert.deepEqual(heavy.workers.map(worker => worker.summary), ['结论一', '结论二'], '短报告不截断');
});

test('报告按份平均截短并保留开头，工作者一个不少', () => {
  const response = { next: 'x', done: true, workers: Array.from({ length: 4 }, (_, i) => ({ id: String(i), summary: `结论${i}：${'说'.repeat(5000)}`, review: { accepted: true, note: 'n'.repeat(3000) } })) };
  const fitted = fitResponse(response, 12000);
  assert.ok(size(fitted) <= 12000, String(size(fitted)));
  assert.equal(fitted.workers.length, 4);
  fitted.workers.forEach((worker, i) => {
    assert.ok(worker.summary.startsWith(`结论${i}：`));
    assert.equal(worker.summaryTruncated, true);
    assert.equal(worker.review.note.length, 500);
  });
  assert.equal(response.workers[0].review.note.length, 3000);
});
