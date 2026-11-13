// 等待类返回的总篇幅预算。Codex 对单个工具输出有截断预算，被截掉的部分它不会翻页去读，
// 等于没看到；所以由服务按重要性先压缩，保证每个工作者的结论开头都能送到主控。

export const DEFAULT_RESPONSE_BYTES = 40000;
// 平均截短后每份报告至少保留的字符数：结论在报告开头。
const MIN_SHARE_CHARS = 300;

const size = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

function withoutText(item) {
  if (item.text === undefined) return item;
  const { text, ...rest } = item;
  return rest;
}

function shortenPatch(worker, max) {
  const diff = worker.diff;
  if (!diff?.patch || diff.patch.length <= max) return;
  const { patch, ...rest } = diff;
  worker.diff = { ...rest, ...(max ? { patch: patch.slice(0, max) } : {}), patchTruncated: true,
    totalLength: diff.totalLength ?? patch.length };
}

function clipField(worker, key, max, flag) {
  if (typeof worker[key] !== 'string' || worker[key].length <= max) return;
  worker[key] = worker[key].slice(0, max);
  if (flag) worker[flag] = true;
}

/**
 * 把一次等待类返回压到 limit 字节以内，依次：靠后的证据原文 → 补丁截短 → 全部证据原文 → 补丁正文 →
 * 报告、验收说明和错误按份平均截短。只截内容不删工作者；截过的字段带标记，完整内容用 team_result / team_diff 读取。
 */
export function fitResponse(response, limit) {
  if (!response.workers?.length || size(response) <= limit) return response;
  const result = { ...response, workers: response.workers.map(worker => ({ ...worker,
    ...(worker.review ? { review: { ...worker.review } } : {}) })) };
  const fits = () => size(result) <= limit;
  const each = change => { for (const worker of result.workers) change(worker); return fits(); };
  const share = () => {
    const texts = result.workers.filter(worker => worker.summary).length || 1;
    const fixed = size({ ...result, workers: result.workers.map(({ summary, ...rest }) => rest) });
    // 按最坏情况每字符 3 字节（中文）估算。
    return Math.max(MIN_SHARE_CHARS, Math.floor((limit - fixed - 200) / texts / 3));
  };
  const steps = [
    () => each(worker => { if (worker.evidence?.length > 3) worker.evidence = worker.evidence.map((item, i) => i < 3 ? item : withoutText(item)); }),
    () => each(worker => shortenPatch(worker, 4000)),
    () => each(worker => { if (worker.evidence) worker.evidence = worker.evidence.map(withoutText); }),
    () => each(worker => shortenPatch(worker, 0)),
    () => each(worker => {
      if (worker.review?.note?.length > 500) worker.review.note = worker.review.note.slice(0, 500);
      clipField(worker, 'error', 500);
    }),
    () => { const max = share(); return each(worker => clipField(worker, 'summary', max, 'summaryTruncated')); },
    () => each(worker => { delete worker.evidence; clipField(worker, 'summary', MIN_SHARE_CHARS, 'summaryTruncated'); }),
  ];
  for (const step of steps) if (step()) break;
  return { ...result, compacted: true };
}
