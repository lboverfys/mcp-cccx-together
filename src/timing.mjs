import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readWorkers } from './store.mjs';

// 两次调用之间超过此间隔多半包含用户思考或与本 MCP 无关的对话，不计入主控耗时，只计数。
export const IDLE_CAP_MS = 5 * 60 * 1000;
const EMPTY = { calls: 0, toolMs: 0, waitMs: 0, codexTurns: 0, codexMs: 0, longGaps: 0 };

/**
 * 主控调用本 MCP 的节奏：没有调用在执行时，从上次返回到下次调用的空档近似为主控（Codex）自身的耗时，
 * 包括它的推理、自己运行的工具和回复。首次调用之前的规划时间无法观测，不计入。
 */
export class CallClock {
  constructor(now = Date.now) {
    this.now = now;
    this.inFlight = 0;
    this.idleSince = undefined;
  }

  begin() {
    const at = this.now();
    const gap = this.inFlight === 0 && this.idleSince !== undefined ? at - this.idleSince : undefined;
    this.inFlight += 1;
    return { at, gap };
  }

  end() {
    const at = this.now();
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (!this.inFlight) this.idleSince = at;
    return at;
  }
}

/** 把一次调用累加进团队计时；返回新对象。 */
export function addCall(timing, { tool, ms, gap, at, end }) {
  const next = { ...EMPTY, ...timing, byTool: { ...timing?.byTool } };
  next.calls += 1;
  next.toolMs += ms;
  if (tool === 'team_dispatch' || tool === 'team_wait') next.waitMs += ms;
  if (gap !== undefined) {
    if (gap <= IDLE_CAP_MS) { next.codexMs += gap; next.codexTurns += 1; }
    else next.longGaps += 1;
  }
  next.firstAt ??= new Date(at).toISOString();
  next.lastAt = new Date(end).toISOString();
  const entry = next.byTool[tool] ?? { calls: 0, ms: 0 };
  next.byTool[tool] = { calls: entry.calls + 1, ms: entry.ms + ms };
  return next;
}

/** 汇总团队耗时：主控在调用之间的时间、阻塞等待的时间、CC 运行时间和 MCP 自身的验证/合并/建工作区时间。 */
export function summarizeTiming(timing, workers = []) {
  const t = { ...EMPTY, ...timing };
  const sum = key => workers.reduce((total, data) => total + (data.timing?.[key] ?? 0), 0);
  return {
    ...(t.firstAt ? { firstCallAt: t.firstAt, lastReturnAt: t.lastAt, spanMs: Date.parse(t.lastAt) - Date.parse(t.firstAt) } : {}),
    codex: { turns: t.codexTurns, ms: t.codexMs, ...(t.longGaps ? { longGapsExcluded: t.longGaps } : {}) },
    mcpCalls: { count: t.calls, ms: t.toolMs, blockedWaitingMs: t.waitMs },
    workerRunMs: sum('runMs'),
    verifyMs: sum('verifyMs'),
    mergeMs: sum('mergeMs'),
    worktreeMs: sum('worktreeMs'),
  };
}

/** cc-team-mcp stats：不加锁读取团队记录，团队运行中也可查看。 */
export function teamStats(config, teamId) {
  const dir = resolve(config.stateDir, teamId);
  let team = {};
  try { team = JSON.parse(readFileSync(resolve(dir, 'team.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { workers } = readWorkers(dir);
  if (!workers.length && !team.timing) throw new Error(`未找到团队 ${teamId} 的记录：${dir}`);
  return {
    teamId, summary: summarizeTiming(team.timing, workers), byTool: team.timing?.byTool ?? {},
    workers: workers.map(data => ({ name: data.name, access: data.access, ...(data.command ? { command: data.command } : {}),
      status: data.status, ...data.timing, ...(data.lastResult?.numTurns !== undefined ? { turns: data.lastResult.numTurns } : {}) })),
    note: 'codex.ms 是主控在两次调用本 MCP 之间的耗时（推理、自行运行的工具和回复），首次调用前的规划时间不在其中；超过 5 分钟的间隔不计入',
  };
}
