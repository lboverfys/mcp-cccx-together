/**
 * 依赖图：records 为 id → { id, dependsOn } 的 Map。
 * rank 是拓扑序（同层按提交顺序）；before(a, b) 表示 a 是 b 的传递前置。
 */
export function dependencyGraph(records) {
  const remaining = new Map();
  const dependents = new Map();
  for (const record of records.values()) {
    remaining.set(record.id, record.dependsOn?.length ?? 0);
    for (const id of record.dependsOn ?? []) {
      if (!records.has(id)) throw new Error(`依赖工作者不存在：${id}`);
      if (!dependents.has(id)) dependents.set(id, []);
      dependents.get(id).push(record.id);
    }
  }
  const ready = [...records.keys()].filter(id => remaining.get(id) === 0);
  const rank = new Map();
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index];
    rank.set(id, index);
    for (const next of dependents.get(id) ?? []) {
      remaining.set(next, remaining.get(next) - 1);
      if (remaining.get(next) === 0) ready.push(next);
    }
  }
  if (rank.size !== records.size) throw new Error('任务依赖存在循环，请检查 dependsOn');
  const before = (first, second) => {
    if (first === second || rank.get(first) >= rank.get(second)) return false;
    const stack = [...(records.get(second).dependsOn ?? [])];
    const visited = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (id === first) return true;
      if (visited.has(id) || rank.get(id) <= rank.get(first)) continue;
      visited.add(id);
      stack.push(...(records.get(id).dependsOn ?? []));
    }
    return false;
  };
  return { rank, before };
}
