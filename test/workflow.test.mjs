import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

test('真实 MCP 与 SDK 完成依赖交接、权限、长结果、失败修复及跨进程恢复的完整工作流', { timeout: 45000 }, async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cc-team-workflow-')));
  const workspace = path.join(root, 'workspace');
  const logs = path.join(root, 'logs');
  mkdirSync(workspace);
  mkdirSync(logs);
  const configPath = path.join(root, 'config.json');
  const stateDir = path.join(root, 'state');
  const tempDir = path.join(root, 'runtime');
  const fixturePath = fileURLToPath(new URL('./fixtures/workflow-claude.mjs', import.meta.url));
  writeFileSync(configPath, JSON.stringify({ claudeExecutable: fixturePath, stateDir, tempDir, notificationMode: 'poll' }));
  let client, transport, stderr = '', activeTeam = false;
  const serverPids = [];
  const events = [];
  let cursor = 0;
  const observed = () => readdirSync(logs).flatMap(file => readFileSync(path.join(logs, file), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, `${name}: ${response.content?.[0]?.text}\n${stderr}`);
    return response.structuredContent ?? JSON.parse(response.content[0].text);
  };
  async function connect() {
    const env = { ...process.env, CC_TEAM_CONFIG: configPath, CC_TEAM_STATE_DIR: stateDir, CC_TEAM_TEMP_DIR: tempDir,
      CC_TEAM_CLAUDE_EXECUTABLE: fixturePath, CC_TEAM_NOTIFICATION_MODE: 'poll', CC_TEAM_WORKFLOW_LOG_DIR: logs,
      CC_TEAM_PERMISSION_MODE: 'default' };
    transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), '--config', configPath], cwd: workspace, stderr: 'pipe', env });
    transport.stderr.on('data', chunk => { stderr += chunk.toString(); });
    client = new Client({ name: 'workflow-integration', version: '1.0.0' });
    await client.connect(transport);
    serverPids.push(transport.pid);
  }
  async function waitFor(predicate, description, { allowWrites = false } = {}) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const state = await call('team_status');
      if (predicate(state)) return state;
      if (allowWrites) {
        for (const worker of state.workers) {
          for (const request of worker.requests) {
            const detail = await call('team_request', { requestId: request.id });
            const payload = JSON.parse(detail.text);
            assert.equal(payload.toolName, 'Write');
            assert.equal(payload.input.file_path, path.join(workspace, 'implementation.txt'));
            assert(['draft-v1', 'ready-v2'].includes(payload.input.content));
            // The fake CLI only writes after the real SDK routes this approval back.
            if (payload.input.content === 'draft-v1') assert.equal(existsSync(payload.input.file_path), false);
            await call('team_reply', { requestId: request.id, allow: true });
          }
        }
      }
      const batch = await call('team_events', { after: cursor, limit: 100, waitMs: 100 });
      cursor = batch.nextCursor;
      events.push(...batch.events);
    }
    assert.fail(`${description}超时\n${JSON.stringify(await call('team_status'))}\n${JSON.stringify(observed())}\n${stderr}`);
  }
  async function fullResult(workerId, resultId) {
    let offset = 0, text = '', pages = 0;
    for (;;) {
      const part = await call('team_result', { workerId, ...(resultId ? { resultId } : {}), offset, limit: 4096 });
      resultId ??= part.resultId;
      assert.equal(part.offsetUnit, 'utf8-bytes');
      text += part.text;
      pages++;
      if (!part.hasMore) return { result: JSON.parse(text), pages };
      assert(part.nextOffset > offset);
      offset = part.nextOffset;
    }
  }
  try {
    await connect();
    await call('team_open', { teamId: 'workflow', constraints: 'CURRENT-CONSTRAINT-A', maxConcurrent: 2 });
    activeTeam = true;
    const dispatched = await call('team_dispatch', { workers: [
      { name: '设计', cwd: workspace, prompt: 'TASK_DESIGN', scope: ['.'], review: 'codex' },
      { name: '实现', cwd: workspace, prompt: 'TASK_IMPLEMENT', access: 'write', scope: ['.'], dependsOn: ['设计cc'], review: 'codex' },
      { name: '验证', cwd: workspace, prompt: 'TASK_VERIFY', scope: ['.'], dependsOn: ['实现cc'], review: 'codex' },
    ] });
    assert.deepEqual(dispatched.workers.map(worker => worker.name), ['设计cc', '实现cc', '验证cc']);
    await waitFor(state => {
      const worker = state.workers.find(item => item.name === '设计cc');
      return worker.status === 'awaiting_review' && worker.pid === null;
    }, '设计完成并自然退出后仍可验收');
    assert.deepEqual(observed().filter(item => item.type === 'start').map(item => item.name), ['设计cc']);
    const design = await fullResult('设计cc');
    assert(design.pages > 10);
    assert(design.result.text.startsWith('DESIGN-CONTRACT'));
    assert(design.result.text.endsWith('DESIGN-END'));
    const designResultId = design.result.resultId;
    assert(designResultId);
    await call('team_review', { workerId: '设计cc', resultId: designResultId, accepted: true, note: '已读取完整设计', handoff: '设计接口已确认，请实现后交验证。' });
    await waitFor(state => state.workers.find(worker => worker.name === '实现cc').status === 'awaiting_review', '实现完成', { allowWrites: true });
    assert.equal(readFileSync(path.join(workspace, 'implementation.txt'), 'utf8'), 'draft-v1');
    assert(observed().some(item => item.type === 'dependency' && item.name === '实现cc' && item.pages > 10));
    assert.equal(observed().filter(item => item.type === 'start' && item.name === '验证cc').length, 0);
    const earlierImplementation = (await fullResult('实现cc')).result;
    await call('team_send', { workerId: '实现cc', message: 'RECHECK_IMPLEMENT：更新交付说明。' });
    await waitFor(state => {
      const worker = state.workers.find(item => item.name === '实现cc');
      return worker.status === 'awaiting_review' && worker.lastResult.resultId !== earlierImplementation.resultId;
    }, '更新实现交付');
    const staleReview = await client.callTool({ name: 'team_review', arguments: {
      workerId: '实现cc', resultId: earlierImplementation.resultId, accepted: true, note: '对上一轮结果的迟到验收',
    } });
    assert.equal(staleReview.isError, true);
    const afterStaleReview = await call('team_status');
    assert.equal(afterStaleReview.workers.find(worker => worker.name === '实现cc').lastReview, undefined);
    assert.equal(afterStaleReview.workers.find(worker => worker.name === '验证cc').pid, null);
    assert.equal(observed().filter(item => item.type === 'start' && item.name === '验证cc').length, 0);
    const implementation = (await fullResult('实现cc')).result;
    await call('team_review', { workerId: '实现cc', resultId: implementation.resultId, accepted: true, note: '实现已交付，进入独立验证', handoff: '独立检查 implementation.txt 的最终内容。' });
    await waitFor(state => state.workers.find(worker => worker.name === '验证cc').status === 'failed', '验证故障发现');
    const failed = await fullResult('验证cc');
    assert.equal(failed.result.success, false);
    assert.match(failed.result.errors.join('\n'), /draft-v1/);
    await call('team_close', { workerIds: ['验证cc'] });
    await call('team_open', { teamId: 'workflow', constraints: 'CURRENT-CONSTRAINT-B' });
    await call('team_resume', { workerId: '实现cc', message: 'FIX_IMPLEMENT：修复验证发现的问题。' });
    await waitFor(state => state.workers.find(worker => worker.name === '实现cc').status === 'awaiting_review', '实现修复', { allowWrites: true });
    assert.equal(readFileSync(path.join(workspace, 'implementation.txt'), 'utf8'), 'ready-v2');
    assert(observed().some(item => item.type === 'initialize' && item.name === '实现cc' && item.resumedSession && item.appendSystemPrompt.includes('CURRENT-CONSTRAINT-B')));
    const fixedImplementation = (await fullResult('实现cc')).result;
    await call('team_review', { workerId: '实现cc', resultId: fixedImplementation.resultId, accepted: true, note: '修复文件内容已检查' });
    await call('team_close', { workerIds: ['实现cc'] });
    await call('team_resume', { workerId: '验证cc', message: 'RETRY_VERIFY' });
    const verified = await waitFor(state => state.workers.find(worker => worker.name === '验证cc').status === 'awaiting_review', '修复后验证');
    const verificationSessionId = verified.workers.find(worker => worker.name === '验证cc').sessionId;
    const verification = (await fullResult('验证cc')).result;
    assert.equal(verification.text, 'VERIFIED-READY-V2');
    assert(observed().some(item => item.type === 'implementation-result' && item.text === 'IMPLEMENTATION-FIXED'));
    await call('team_review', { workerId: '验证cc', resultId: verification.resultId, accepted: true, note: '独立验证通过' });
    await call('team_shutdown');
    activeTeam = false;
    await client.close();
    assert.equal(existsSync(path.join(stateDir, 'workflow', 'store.lock')), false);
    await connect();
    const restored = await call('team_open', { teamId: 'workflow' });
    activeTeam = true;
    assert.equal(restored.constraints, 'CURRENT-CONSTRAINT-B');
    assert.equal(restored.workers.find(worker => worker.name === '验证cc').sessionId, verificationSessionId);
    assert.equal((await fullResult('设计cc', designResultId)).result.text, design.result.text);
    await call('team_resume', { workerId: '验证cc', message: '恢复会话，再次确认最终结果。' });
    const resumed = await waitFor(state => state.workers.find(worker => worker.name === '验证cc').status === 'awaiting_review', '跨进程恢复');
    assert.equal(resumed.workers.find(worker => worker.name === '验证cc').sessionId, verificationSessionId);
    assert(observed().some(item => item.type === 'start' && item.name === '验证cc' && item.resumedSession === verificationSessionId));
    const resumedResult = (await fullResult('验证cc')).result;
    await call('team_review', { workerId: '验证cc', resultId: resumedResult.resultId, accepted: true, note: '恢复后验证通过' });
    assert.equal(observed().filter(item => item.type === 'permission').length, 2);
    assert(observed().filter(item => item.type === 'initialize').every(item => item.systemPromptSnapshot === false));
    assert.equal(observed().filter(item => item.type === 'fixture-error').length, 0);
    assert.equal(stderr, '');
  } finally {
    let shutdownError;
    if (activeTeam) {
      try { await call('team_shutdown'); }
      catch (error) { shutdownError = error; }
      finally { activeTeam = false; }
    }
    try { await client?.close(); }
    catch (error) { shutdownError ??= error; }
    const pids = [...serverPids, ...observed().filter(item => item.type === 'start').map(item => item.pid)];
    for (let i = 0; i < 100 && pids.some(alive); i++) await delay(20);
    const live = pids.filter(alive);
    for (const pid of live) process.kill(pid, 'SIGKILL');
    for (let i = 0; i < 100 && live.some(alive); i++) await delay(20);
    const remaining = pids.filter(alive);
    const relative = path.relative(realpathSync(tmpdir()), root);
    assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    if (remaining.length === 0) rmSync(root, { recursive: true, force: true });
    assert.deepEqual(remaining, [], '本次测试进程必须全部退出');
    assert.deepEqual(live, [], '正常收尾应关闭全部测试进程');
    if (shutdownError) throw shutdownError;
  }
});
