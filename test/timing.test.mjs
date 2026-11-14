import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CallClock, IDLE_CAP_MS, addCall, summarizeTiming } from '../src/timing.mjs';
import { runCli } from '../src/cli.mjs';
import { TeamManager } from '../src/manager.mjs';

test('调用之间的空档计为主控耗时：并发调用期间不计，首个调用和超长间隔不计', () => {
  let now = 1000;
  const clock = new CallClock(() => now);
  const first = clock.begin();
  assert.equal(first.gap, undefined);
  now = 6000;
  clock.end();
  now = 9000;
  const second = clock.begin();
  assert.equal(second.gap, 3000);
  const parallel = clock.begin();
  assert.equal(parallel.gap, undefined, '已有调用在执行时主控不在思考');
  now = 9500;
  clock.end();
  clock.end();
  let timing = addCall(undefined, { tool: 'team_dispatch', ms: 5000, waitedMs: 4500, gap: first.gap, at: 1000, end: 6000 });
  timing = addCall(timing, { tool: 'team_wait', ms: 500, waitedMs: 400, gap: second.gap, at: 9000, end: 9500 });
  timing = addCall(timing, { tool: 'team_status', ms: 5, gap: IDLE_CAP_MS + 1, at: 9_000_000, end: 9_000_005 });
  const summary = summarizeTiming(timing, [{ timing: { runMs: 4000, verifyMs: 300 } }, { timing: { runMs: 1000, mergeMs: 20 } }, {}]);
  assert.deepEqual(summary.codex, { turns: 1, ms: 3000, longGapsExcluded: 1 });
  assert.deepEqual(summary.mcpCalls, { count: 3, ms: 5505, blockedWaitingMs: 4900 });
  assert.deepEqual([summary.workerRunMs, summary.verifyMs, summary.mergeMs, summary.worktreeMs], [5000, 300, 20, 0]);
  assert.equal(summary.spanMs, 9_000_005 - 1000);
  assert.deepEqual(timing.byTool.team_wait, { calls: 1, ms: 500 });
});

test('所有等待入口累计实际等待，wait:false 调用和接口处理时间不计入等待', () => {
  let timing;
  const tools = ['team_dispatch', 'team_wait', 'team_send', 'team_reply', 'team_resume', 'team_review'];
  for (const tool of tools) {
    timing = addCall(timing, { tool, ms: 100, waitedMs: 40, at: 0, end: 100 });
    timing = addCall(timing, { tool, ms: 20, at: 100, end: 120 });
  }
  const summary = summarizeTiming(timing, [{ timing: { runMs: 1000 } }, { timing: { runMs: 1000 } }]);
  assert.equal(summary.mcpCalls.blockedWaitingMs, tools.length * 40);
  assert.equal(summary.mcpCalls.ms, tools.length * 120);
  assert.equal(summary.spanMs, 120);
  assert.equal(summary.workerRunMs, 2000, '并行工作者累计时间独立于实际经过时间');
});

test('stats 命令离线读取团队耗时，缺少团队时报错', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cc-team-stats-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = { stateDir: path.join(dir, 'state'), tempDir: path.join(dir, 'runtime'), claudeExecutable: process.execPath };
  const manager = await new TeamManager({ config, teamId: 'stats-team', factory: () => ({ done: new Promise(() => {}), send() {}, async close() {} }) }).init();
  manager.dispatch([{ name: '读取cc', cwd: dir, prompt: '查', access: 'read', scope: ['.'], allowedTools: [] }]);
  manager.recordCall({ tool: 'team_dispatch', ms: 100, at: 0, end: 100 });
  let stdout = '';
  const options = { stdout: { write(text) { stdout += text; } }, stderr: { write() {} }, loadConfigImpl: () => config };
  assert.equal(await runCli(['stats', '--team', 'stats-team'], options), 0);
  const stats = JSON.parse(stdout);
  assert.equal(stats.summary.mcpCalls.count, 1);
  assert.deepEqual(stats.workers.map(worker => worker.name), ['读取cc']);
  assert.equal(await runCli(['stats', '--team', 'missing-team'], options), 1);
  assert.equal(await runCli(['stats'], options), 1);
  await manager.close();
});
