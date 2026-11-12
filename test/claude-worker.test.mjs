import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createClaudeWorker } from '../src/claude-worker.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function outputQueue() {
  const messages = [];
  let ended = false;
  let failure;
  let wake;
  return {
    push(message) { messages.push(message); wake?.(); },
    end(error) { ended = true; failure = error; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (messages.length || !ended) {
        if (messages.length) yield messages.shift();
        else await new Promise((resolve) => { wake = resolve; });
      }
      if (failure) throw failure;
    },
  };
}

function harness({ workerOverrides = {}, request, readDependency, autoExit = true, streamError, endError, stopTask, spawnCommand, stderrError } = {}) {
  const events = [];
  const messages = [];
  const waiters = [];
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 32123,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  let queryOptions;
  let spawnOptions;
  let closeCount = 0;
  let interruptCount = 0;
  const output = outputQueue();
  const stoppedTasks = [];
  const exit = () => {
    child.exitCode = 0;
    child.stderr.end();
    child.emit('exit', 0, null);
  };
  const instance = createClaudeWorker({
    worker: {
      id: 'worker-1', name: '接口开发cc', cwd: process.cwd(), instructions: '完成指定任务', allowedTools: [],
      ...workerOverrides,
    },
    config: { claudeExecutable: 'D:/tools/claude.exe', tempDir: 'D:/task/temp' },
    request: request ?? (async () => ({ allow: false, reason: '未授权' })),
    readDependency,
    emit(type, data) {
      if (type === 'stderr' && stderrError) throw stderrError;
      events.push({ type, data });
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].predicate(events)) waiters.splice(i, 1)[0].resolve();
      }
    },
    spawnImpl(command, args, options) {
      spawnOptions = { command, args, ...options };
      return child;
    },
    queryImpl({ prompt, options }) {
      queryOptions = options;
      options.abortController?.signal.addEventListener('abort', () => output.end(options.abortController.signal.reason), { once: true });
      options.spawnClaudeCodeProcess({
        command: spawnCommand ?? options.pathToClaudeCodeExecutable,
        args: ['--input-format', 'stream-json'],
        cwd: options.cwd,
        env: options.env,
        signal: new AbortController().signal,
      });
      output.push({ type: 'system', subtype: 'init', session_id: 'session-123' });
      (async () => {
        try {
          for await (const message of prompt) {
            messages.push(message);
            if (streamError) throw streamError;
            output.push({
            type: 'assistant', session_id: 'session-123',
            message: { content: [
              { type: 'thinking', thinking: '不应转发的隐藏思考' },
              { type: 'text', text: `执行 ${message.message.content}` },
              { type: 'tool_use', id: 'tool-1', name: 'Read' },
            ] },
            });
            output.push({
            type: 'result', subtype: 'success', is_error: false,
            result: `完成 ${message.message.content}`, session_id: 'session-123',
            user_message_uuid: message.uuid, user_message_uuids: [message.uuid],
            });
          }
          output.end(endError);
        } catch (error) {
          output.end(error);
        }
      })();
      const stream = output[Symbol.asyncIterator]();
      stream.interrupt = async () => {
        interruptCount++;
        return { still_queued: [] };
      };
      stream.close = () => {
        closeCount++;
        output.end(endError);
        if (autoExit) exit();
      };
      stream.stopTask = async (id) => {
        stoppedTasks.push(id);
        await stopTask?.(id, output);
      };
      return stream;
    },
  });
  return {
    instance, events, messages, child, exit, stoppedTasks, pushOutput: output.push,
    get options() { return queryOptions; },
    get spawnOptions() { return spawnOptions; },
    get closeCount() { return closeCount; },
    get interruptCount() { return interruptCount; },
    until(predicate) {
      if (predicate(events)) return Promise.resolve();
      return new Promise((resolve) => { waiters.push({ predicate, resolve }); });
    },
  };
}

test('输入队列保持多轮会话，不隐式首发，也不转发思考内容', async () => {
  const h = harness();
  await h.until((events) => events.some((event) => event.type === 'session'));
  assert.equal(h.messages.length, 0);
  h.instance.send('第一步', 'message-1');
  await h.until((events) => events.filter((event) => event.type === 'result').length === 1);
  let ended = false;
  h.instance.done.then(() => { ended = true; });
  await Promise.resolve();
  assert.equal(ended, false);
  h.instance.send('第二步', 'message-2');
  await h.until((events) => events.filter((event) => event.type === 'result').length === 2);
  assert.deepEqual(h.messages.map((message) => message.uuid), ['message-1', 'message-2']);
  assert.ok(h.messages.every((message) => message.isSynthetic && message.client_composed));
  assert.equal(JSON.stringify(h.events).includes('隐藏思考'), false);
  assert.deepEqual(h.events.filter((event) => event.type === 'result').map((event) => event.data.messageIds), [
    ['message-1'], ['message-2'],
  ]);
  await h.instance.close();
  assert.throws(() => h.instance.send('迟到消息', 'message-3'), /已停止/);
});

test('close 等待实际子进程退出，重复关闭复用同一 Promise', async () => {
  const h = harness({ autoExit: false });
  const closing = h.instance.close();
  assert.equal(h.instance.close(), closing);
  let closed = false;
  closing.then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(h.instance.pid, 32123);
  await new Promise(setImmediate);
  assert.equal(h.closeCount, 1);
  h.exit();
  await closing;
  await h.instance.done;
  assert.equal(closed, true);
});

test('复用现有 exe、配置与环境，read 工作者移除写入和再委派工具', async () => {
  const h = harness({ workerOverrides: { access: 'read', model: 'custom-model', sessionId: 'saved-session' } });
  assert.equal(h.spawnOptions.command, 'D:/tools/claude.exe');
  assert.equal(h.spawnOptions.windowsHide, true);
  assert.equal(h.options.env.DISABLE_AUTOUPDATER, '1');
  assert.equal(h.options.env.TEMP, 'D:/task/temp');
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path');
  assert.equal(h.options.env[pathKey], process.env[pathKey]);
  assert.deepEqual(h.options.settingSources, ['user', 'project', 'local']);
  assert.deepEqual(h.options.tools, ['Read', 'Glob', 'Grep', 'AskUserQuestion']);
  assert.ok(h.options.disallowedTools.includes('Agent'));
  assert.equal(h.options.resume, 'saved-session');
  assert.deepEqual(h.options.extraArgs, { name: '接口开发cc' });
  assert.equal(h.options.model, 'custom-model');
  assert.equal(h.options.permissionMode, 'default');
  assert.equal(h.options.persistSession, true);
  assert.equal(h.options.strictMcpConfig, true);
  assert.equal(h.options.systemPrompt.snapshot, false);
  assert.deepEqual(Object.keys(h.options.mcpServers), ['team']);
  assert.deepEqual(h.options.allowedTools, []);
  assert.deepEqual(h.options.settings, { disableAllHooks: true, disableSkillShellExecution: true });
  await h.instance.close();
});

test('SDK 请求 node 启动 JS 入口时复用 MCP 当前解释器', async () => {
  const h = harness({ spawnCommand: 'node' });
  assert.equal(h.spawnOptions.command, process.execPath);
  assert.deepEqual(h.spawnOptions.args, ['--input-format', 'stream-json']);
  await h.instance.close();
});

test('结果保留 SDK 用量、费用和耗时，失败轮次也可检查消耗', async () => {
  const h = harness();
  const usage = { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 };
  h.pushOutput({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['已达轮次限制'],
    usage, total_cost_usd: 0.004, duration_ms: 2450, num_turns: 3 });
  await h.until(events => events.some(event => event.type === 'result'));
  const result = h.events.find(event => event.type === 'result').data;
  assert.equal(result.success, false);
  assert.deepEqual(result.usage, usage);
  assert.equal(result.costUsd, 0.004);
  assert.equal(result.durationMs, 2450);
  assert.equal(result.numTurns, 3);
  await h.instance.close();
});

test('轮次和预算限制仅在主控指定时传给 SDK，恢复时保持配置', async () => {
  const plain = harness();
  assert.equal(Object.hasOwn(plain.options, 'maxTurns'), false);
  assert.equal(Object.hasOwn(plain.options, 'maxBudgetUsd'), false);
  await plain.instance.close();
  const limited = harness({ workerOverrides: { maxTurns: 8, maxBudgetUsd: 0.25, sessionId: 'saved-session' } });
  assert.equal(limited.options.maxTurns, 8);
  assert.equal(limited.options.maxBudgetUsd, 0.25);
  assert.equal(limited.options.resume, 'saved-session');
  await limited.instance.close();
});

test('结果保留完整长交付、全部错误、多个关联消息和累计计量', async () => {
  const h = harness();
  const report = '完整交付'.repeat(12000);
  const errors = Array.from({ length: 12 }, (_, index) => `${index}:` + '错误细节'.repeat(800));
  const modelUsage = { 'example-model': { inputTokens: 50, outputTokens: 20, costUSD: 0.1 } };
  h.pushOutput({ type: 'result', subtype: 'error_during_execution', is_error: true,
    result: report, errors, modelUsage, total_cost_usd: 0.1,
    user_message_uuid: 'last-message', user_message_uuids: ['first-message', 'last-message'],
    queued_turn_count: 2, result_index: 4, startup_failure_reason: 'config_file_invalid' });
  await h.until(events => events.some(event => event.type === 'result'));
  const result = h.events.find(event => event.type === 'result').data;
  assert.equal(result.text, report);
  assert.deepEqual(result.errors, errors);
  assert.deepEqual(result.messageIds, ['first-message', 'last-message']);
  assert.deepEqual(result.modelUsage, modelUsage);
  assert.equal(result.costUsd, 0.1);
  assert.equal(result.queuedTurnCount, 2);
  assert.equal(result.resultIndex, 4);
  assert.equal(result.startupFailureReason, 'config_file_invalid');
  await h.instance.close();
});

test('success 信封中的中断、后台、额度阻塞按实际终止原因区分', async () => {
  const h = harness();
  const reasons = [undefined, 'completed', 'aborted_streaming', 'aborted_tools', 'background_requested', 'blocking_limit'];
  for (const reason of reasons) h.pushOutput({ type: 'result', subtype: 'success', is_error: false, terminal_reason: reason });
  await h.until(events => events.filter(event => event.type === 'result').length === reasons.length);
  const results = h.events.filter(event => event.type === 'result').map(event => event.data);
  assert.deepEqual(results.map(result => result.success), [true, true, false, false, false, false]);
  assert.deepEqual(results.map(result => result.interrupted), [false, false, true, true, false, false]);
  assert.deepEqual(results.map(result => result.background), [false, false, false, false, true, false]);
  await h.instance.close();
});

test('记录后台快照、重试等待、限额与规则拒绝，主控可判断等待原因', async () => {
  const h = harness();
  h.pushOutput({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'job', task_type: 'local_bash', description: '构建' }] });
  h.pushOutput({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 4, retry_delay_ms: 1000, error_status: 429, error: 'rate_limit' });
  h.pushOutput({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1234, rateLimitType: 'five_hour', utilization: 1 } });
  h.pushOutput({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'denied-tool', decision_reason: '规则拒绝', message: '当前命令不允许' });
  h.pushOutput({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  await h.until(events => events.filter(event => event.type === 'background_tasks').length === 2);
  assert.deepEqual(h.events.find(event => event.type === 'api_retry').data,
    { attempt: 2, maxRetries: 4, retryDelayMs: 1000, errorStatus: 429, error: 'rate_limit' });
  assert.equal(h.events.find(event => event.type === 'rate_limit').data.resetsAt, 1234);
  assert.equal(h.events.find(event => event.type === 'permission_denied').data.reason, '规则拒绝');
  assert.equal(h.events.filter(event => event.type === 'background_tasks').at(-1).data.tasks.length, 0);
  await h.instance.close();
});

test('同名外部 MCP 工具仍须审批，并向主控保留权限来源和原因', async () => {
  const calls = [];
  const h = harness({ request: async (kind, payload) => {
    calls.push({ kind, payload });
    return { allow: false, reason: '非内嵌协调工具' };
  } });
  const context = { signal: new AbortController().signal, requestId: 'permission-1', toolUseID: 'tool-1',
    mcpServer: { name: 'team', source: 'plugin' }, decisionReason: '需要读取外部数据',
    title: '读取数据', description: '可访问外部资源', defaultToNo: true,
    matchedAskRule: { source: 'userSettings', toolName: 'mcp__team__read_dependency' } };
  const decision = await h.options.canUseTool('mcp__team__read_dependency', { workerId: '设计cc' }, context);
  assert.equal(decision.behavior, 'deny');
  assert.equal(calls[0].kind, 'permission');
  assert.deepEqual(calls[0].payload.mcpServer, context.mcpServer);
  assert.equal(calls[0].payload.decisionReason, context.decisionReason);
  assert.equal(calls[0].payload.defaultToNo, true);
  assert.deepEqual(calls[0].payload.matchedAskRule, context.matchedAskRule);
  await h.instance.close();
});

test('问答保留原问题并返回答案，权限拒绝不伪装成功', async () => {
  const calls = [];
  const h = harness({ request: async (kind, payload) => {
    calls.push({ kind, payload });
    return kind === 'question' ? { answers: { '选择方案': 'A' } } : { allow: false, reason: '未获授权' };
  } });
  const context = { signal: new AbortController().signal, requestId: 'request-1', toolUseID: 'tool-1' };
  assert.equal(h.options.strictMcpConfig, true);
  assert.deepEqual(h.options.settings, { disableAllHooks: true, disableSkillShellExecution: true });
  for (const toolName of ['mcp__team__report_progress', 'mcp__team__ask_parent', 'mcp__team__read_dependency']) {
    const input = { summary: '协调消息' };
    assert.deepEqual(await h.options.canUseTool(toolName, input, { ...context, mcpServer: { name: 'team', source: 'sdk' } }), { behavior: 'allow', updatedInput: input });
  }
  const questions = [{ question: '选择方案', options: [{ label: 'A', description: '' }], multiSelect: false }];
  const answer = await h.options.canUseTool('AskUserQuestion', { questions }, context);
  assert.deepEqual(answer, { behavior: 'allow', updatedInput: { questions, answers: { '选择方案': 'A' } } });
  const denied = await h.options.canUseTool('Bash', { command: 'git push' }, context);
  assert.deepEqual(denied, { behavior: 'deny', message: '未获授权' });
  assert.deepEqual(calls.map((call) => call.kind), ['question', 'permission']);
  assert.equal(calls[1].payload.toolName, 'Bash');
  await h.instance.close();
});

test('中断取消待回答请求，并保持会话可继续接受新消息', async () => {
  const asked = deferred();
  const h = harness({ request: (_kind, _payload, signal) => {
    asked.resolve();
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  } });
  const pending = h.options.canUseTool('Edit', { file_path: 'file.txt' }, {
    signal: new AbortController().signal, requestId: 'pending-1', toolUseID: 'tool-2',
  });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await asked.promise;
  assert.deepEqual(await h.instance.interrupt(), { still_queued: [] });
  await rejected;
  h.instance.send('继续检查', 'message-after-interrupt');
  await h.until((events) => events.some((event) => event.type === 'result'));
  assert.equal(h.interruptCount, 1);
  await h.instance.close();
});

test('stderr 按 UTF-8 解码且限制单个事件长度', async () => {
  const h = harness();
  const encoded = Buffer.from('中文');
  h.child.stderr.write(encoded.subarray(0, 2));
  h.child.stderr.write(encoded.subarray(2));
  h.child.stderr.write('x'.repeat(5000));
  const stderr = h.events.filter((event) => event.type === 'stderr');
  assert.equal(stderr[0].data.text, '中文');
  assert.equal(stderr[1].data.text.length, 4000);
  await h.instance.close();
});

test('stderr 事件保存失败进入工作者收尾，不从流回调抛出且保留原始错误', async () => {
  const failure = new Error('模拟 stderr 写盘失败');
  const h = harness({ stderrError: failure });
  const stopped = assert.rejects(h.instance.done, error => error === failure);
  assert.doesNotThrow(() => h.child.stderr.write('诊断输出'));
  await stopped;
  assert.equal(h.child.exitCode, 0);
  assert.equal(h.closeCount, 1);
  await assert.rejects(h.instance.close(), error => error === failure);
});

test('关闭时 stderr 尾部解码的保存失败仍传播，不误报关闭成功', async () => {
  const failure = new Error('模拟 stderr 尾部写盘失败');
  const h = harness({ stderrError: failure });
  h.child.stderr.write(Buffer.from('中').subarray(0, 2));
  const stopped = assert.rejects(h.instance.done, error => error === failure);
  await assert.rejects(h.instance.close(), error => error === failure);
  await stopped;
  assert.equal(h.child.exitCode, 0);
  assert.equal(h.closeCount, 1);
});

test('真实 SDK 在初始化期间遇到 stderr 保存失败会退出自有子进程并报告原始错误', { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-team-stderr-'));
  const cli = join(dir, 'cli.mjs');
  writeFileSync(cli, "process.stderr.write('诊断输出\\n');\nsetInterval(() => {}, 1000);\n", { flag: 'wx' });
  const failure = new Error('模拟 stderr 存储故障');
  let child;
  const worker = createClaudeWorker({
    worker: { id: 'stderr-worker', name: '故障验证cc', cwd: dir, instructions: '验证进程收尾', access: 'read', allowedTools: [] },
    config: { claudeExecutable: cli, tempDir: dir },
    emit(type) { if (type === 'stderr') throw failure; },
    request() { assert.fail('初始化故障不应触发工具请求'); },
    spawnImpl(command, args, options) { child = spawn(command, args, options); return child; },
  });
  t.after(async () => {
    const [closed] = await Promise.allSettled([worker.close()]);
    if (child?.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
    if (child?.pid) assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    unlinkSync(cli);
    rmdirSync(dir);
    if (closed.status === 'rejected' && closed.reason !== failure) throw closed.reason;
  });
  await assert.rejects(worker.done, error => error === failure);
  assert(child?.pid);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  await assert.rejects(worker.close(), error => error === failure);
});

test('单题自由文本转换为 answers，多题拒绝不完整回答', async () => {
  let response = { text: '自由文本回答' };
  const h = harness({ request: async () => response });
  const context = { signal: new AbortController().signal, requestId: 'question-1', toolUseID: 'tool-1' };
  const questions = [{ question: '第一个问题' }];
  const answer = await h.options.canUseTool('AskUserQuestion', { questions }, context);
  assert.deepEqual(answer.updatedInput, { questions, answers: { 第一个问题: '自由文本回答' } });
  const multiple = { questions: [...questions, { question: '第二个问题' }] };
  await assert.rejects(h.options.canUseTool('AskUserQuestion', multiple, context), /每个问题/);
  response = { answers: { 第一个问题: '回答一' } };
  await assert.rejects(h.options.canUseTool('AskUserQuestion', multiple, context), /每个问题/);
  response = { answers: { 第一个问题: '回答一', 第二个问题: '回答二' } };
  assert.deepEqual((await h.options.canUseTool('AskUserQuestion', multiple, context)).updatedInput.answers, response.answers);
  await h.instance.close();
});

test('流异常先关闭并确认工作者进程退出，再拒绝 done', async () => {
  const failure = new Error('模拟传输失败');
  const h = harness({ streamError: failure });
  const rejected = assert.rejects(h.instance.done, (error) => error === failure);
  h.instance.send('触发错误', 'error-message');
  await rejected;
  assert.equal(h.child.exitCode, 0);
  assert.equal(h.closeCount, 1);
  await assert.rejects(h.instance.close(), (error) => error === failure);
});

test('无法确认进程退出时 close 明确超时失败', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness({ autoExit: false });
  const closing = assert.rejects(h.instance.close(), /关闭工作者超时/);
  const stopped = assert.rejects(h.instance.done, /关闭工作者超时/);
  await new Promise(setImmediate);
  t.mock.timers.tick(10000);
  await closing;
  await stopped;
  assert.equal(h.child.exitCode, null);
  h.exit();
  await h.instance.close();
  assert.equal(h.child.exitCode, 0);
});

test('主动关闭可处理预期 AbortError，仍传播其他流异常', async () => {
  const aborted = harness({ endError: new DOMException('主动关闭', 'AbortError') });
  await aborted.instance.close();
  assert.equal(aborted.child.exitCode, 0);
  const failure = new Error('异常解码失败');
  const failed = harness({ endError: failure });
  await assert.rejects(failed.instance.close(), (error) => error === failure);
  assert.equal(failed.child.exitCode, 0);
});

test('关闭只停止本 query 当前后台快照中的任务，等待空快照再关闭进程', async () => {
  const stopRequested = deferred();
  const h = harness({ stopTask: async (id) => { stopRequested.resolve(id); } });
  const other = harness();
  const snapshot = (tasks) => ({ type: 'system', subtype: 'background_tasks_changed', tasks });
  h.pushOutput(snapshot([
    { task_id: 'already-completed', task_type: 'local_bash' },
    { task_id: 'owned-running', task_type: 'local_bash', run_id: 'run-1' },
  ]));
  h.pushOutput(snapshot([{ task_id: 'owned-running', task_type: 'local_bash', run_id: 'run-1' }]));
  h.pushOutput({ type: 'tool_use_summary', summary: '后台快照已同步' });
  await h.until((events) => events.some((event) => event.data.summary === '后台快照已同步'));
  const closing = h.instance.close();
  assert.equal(await stopRequested.promise, 'owned-running');
  assert.deepEqual(h.stoppedTasks, ['owned-running']);
  assert.deepEqual(other.stoppedTasks, []);
  assert.equal(h.closeCount, 0);
  h.pushOutput({ type: 'system', subtype: 'task_notification', task_id: 'owned-running', status: 'stopped' });
  await new Promise(setImmediate);
  assert.equal(h.closeCount, 0);
  h.pushOutput(snapshot([]));
  await closing;
  assert.equal(h.closeCount, 1);
  assert.equal(h.child.exitCode, 0);
  await other.instance.close();
});

test('后台任务停止失败仍关闭自有 CC 进程并报告未确认停止', async () => {
  const failure = new Error('模拟 stopTask 拒绝');
  const h = harness({ stopTask: async () => { throw failure; } });
  h.pushOutput({ type: 'system', subtype: 'background_tasks_changed', tasks: [
    { task_id: 'owned-failed', task_type: 'local_bash' },
  ] });
  h.pushOutput({ type: 'tool_use_summary', summary: '失败快照已同步' });
  await h.until((events) => events.some((event) => event.data.summary === '失败快照已同步'));
  await assert.rejects(h.instance.close(), (error) => error instanceof AggregateError
    && error.errors.includes(failure)
    && error.errors.some((item) => /未能确认后台任务停止/.test(item.message)));
  assert.equal(h.child.exitCode, 0);
  await assert.rejects(h.instance.done, /未能确认后台任务停止/);
});

test('后台任务没有停止快照时 close 有限超时且仍清理自有 CC 进程', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stopRequested = deferred();
  const h = harness({ stopTask: async () => { stopRequested.resolve(); } });
  h.pushOutput({ type: 'system', subtype: 'background_tasks_changed', tasks: [
    { task_id: 'owned-timeout', task_type: 'local_bash' },
  ] });
  h.pushOutput({ type: 'tool_use_summary', summary: '超时快照已同步' });
  await h.until((events) => events.some((event) => event.data.summary === '超时快照已同步'));
  const closing = assert.rejects(h.instance.close(), (error) => error instanceof AggregateError
    && error.errors.some((item) => /尚未确认后台任务停止/.test(item.message)));
  const stopped = assert.rejects(h.instance.done, /未能确认后台任务停止/);
  await stopRequested.promise;
  t.mock.timers.tick(10000);
  await closing;
  await stopped;
  assert.equal(h.child.exitCode, 0);
});

test('内嵌 MCP 记录进度并等待主控问答，不虚报主控已读', async () => {
  const asked = deferred();
  const response = deferred();
  const dependencies = [];
  const h = harness({ request: async (kind, payload) => {
    asked.resolve({ kind, payload });
    return await response.promise;
  }, readDependency: async (workerId, offset, limit) => {
    dependencies.push({ workerId, offset, limit });
    return { text: '{"text":"设计交付"}', nextOffset: null, offsetUnit: 'utf8-bytes' };
  } });
  const client = new Client({ name: 'worker-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = h.options.mcpServers.team.instance;
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const progress = await client.callTool({ name: 'report_progress', arguments: { summary: '已完成分析' } });
    assert.equal(progress.content[0].text, '进度已记录，等待主控读取。');
    assert.ok(h.events.some(({ type, data }) => type === 'progress' && data.summary === '已完成分析'));
    const waiting = client.callTool({ name: 'ask_parent', arguments: { question: '继续哪一步', options: ['检查', '修改'] } });
    const pending = await asked.promise;
    assert.equal(pending.kind, 'question');
    assert.equal(pending.payload.questions[0].question, '继续哪一步');
    response.resolve({ text: '继续检查' });
    const answer = await waiting;
    assert.equal(answer.content[0].text, '继续检查');
    const dependency = await client.callTool({ name: 'read_dependency', arguments: { workerId: '设计cc' } });
    assert.equal(JSON.parse(dependency.content[0].text).text, '{"text":"设计交付"}');
    assert.deepEqual(dependencies, [{ workerId: '设计cc', offset: 0, limit: 12000 }]);
    const invalid = await client.callTool({ name: 'read_dependency', arguments: { workerId: '设计cc', limit: 1 } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await server.close();
    await h.instance.close();
  }
});

test('真实 SDK 验证多轮合并、权限问答、失败后追加、后台关闭、预算参数和恢复', { timeout: 30000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-team-sdk-'));
  const cli = join(dir, 'cli.mjs');
  writeFileSync(cli, `
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
const resumedSession = process.argv.find(arg => arg.startsWith('--resume='))?.slice('--resume='.length);
const sessionId = resumedSession ?? randomUUID();
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const batch = [];
const permissions = new Map();
let initialization;
const result = (messages, data, extra = {}) => send({
  type: 'result', subtype: 'success', is_error: false, uuid: randomUUID(), session_id: sessionId,
  result: JSON.stringify(data), user_message_uuid: messages.at(-1).uuid, user_message_uuids: messages.map(item => item.uuid),
  duration_ms: 1, duration_api_ms: 0, total_cost_usd: 0, num_turns: 1,
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  modelUsage: {}, permission_denials: [], ...extra,
});
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    if (message.request.subtype === 'initialize') initialization = message.request;
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
      response: message.request.subtype === 'initialize'
        ? { commands: [], models: [], account: {}, output_style: 'default', available_output_styles: [] }
        : message.request.subtype === 'interrupt' ? { still_queued: batch.map(item => item.uuid) } : {} } });
    if (message.request.subtype === 'stop_task') {
      send({ type: 'system', subtype: 'background_tasks_changed', tasks: [], uuid: randomUUID(), session_id: sessionId });
    }
  } else if (message.type === 'control_response') {
    const waiting = permissions.get(message.response.request_id);
    if (waiting) {
      permissions.delete(message.response.request_id);
      result([waiting], message.response);
    }
  } else if (message.type === 'user') {
    send({ type: 'system', subtype: 'init', session_id: sessionId, uuid: randomUUID(),
      capabilities: ['interrupt_receipt_v1'], tools: [], mcp_servers: [], model: 'local-fixture', cwd: process.cwd(), permissionMode: 'default' });
    const task = message.message.content.startsWith('{') ? JSON.parse(message.message.content) : { action: 'echo' };
    if (task.action === 'permission' || task.action === 'question') {
      const requestId = randomUUID();
      permissions.set(requestId, message);
      send({ type: 'control_request', request_id: requestId, request: {
        subtype: 'can_use_tool', tool_name: task.action === 'question' ? 'AskUserQuestion' : 'Bash',
        input: task.action === 'question' ? { questions: [{ question: '请选择执行方案', options: [{ label: 'A', description: '方案A' }], multiSelect: false }] }
          : { command: task.command }, tool_use_id: randomUUID(), decision_reason: '需要主控决定',
      } });
    } else if (task.action === 'batch') {
      batch.push(message);
      if (batch.length === 2) result(batch.splice(0), { merged: true });
    } else if (task.action === 'failure') {
      result([message], {}, { subtype: 'error_max_turns', is_error: true, errors: ['已达到模型轮次上限'], terminal_reason: 'max_turns' });
    } else if (task.action === 'background') {
      send({ type: 'system', subtype: 'background_tasks_changed', uuid: randomUUID(), session_id: sessionId,
        tasks: [{ task_id: 'local-build', task_type: 'local_bash', description: '模拟后台构建', run_id: 'first-run' }] });
      result([message], {}, { terminal_reason: 'background_requested' });
    } else if (task.action === 'options') {
      result([message], { maxTurns: process.argv.find(arg => arg.startsWith('--max-turns=')),
        maxBudgetUsd: process.argv.find(arg => arg.startsWith('--max-budget-usd=')),
        snapshot: initialization.systemPromptSnapshot, append: initialization.appendSystemPrompt });
    } else {
      result([message], { text: message.message.content, resumed: Boolean(resumedSession) });
    }
  }
});
lines.on('close', () => process.exit(0));
`, { flag: 'wx' });
  const workers = [];
  const children = [];
  t.after(async () => {
    const results = await Promise.allSettled(workers.map(worker => worker.close()));
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGKILL');
        await exited;
      }
      assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    }
    unlinkSync(cli);
    rmdirSync(dir);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  });
  function start(sessionId, { request, workerOverrides = {} } = {}) {
    const events = [];
    let failure;
    const worker = createClaudeWorker({
      worker: { id: 'sdk-worker', name: '协议验证cc', cwd: dir, instructions: '仅处理模拟协议', access: 'read', allowedTools: [], sessionId, ...workerOverrides },
      config: { claudeExecutable: cli, tempDir: dir },
      emit: (type, data) => events.push({ type, data }),
      request: request ?? (async () => { throw new Error('当前模拟轮次不应请求工具审批'); }),
      spawnImpl(command, args, options) {
        const child = spawn(command, args, options);
        children.push(child);
        return child;
      },
    });
    worker.done.catch(error => { failure = error; });
    workers.push(worker);
    return { worker, events, async result(count) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (failure) throw failure;
        const result = events.filter(event => event.type === 'result')[count - 1];
        if (result) return result.data;
        await delay(10);
      }
      assert.fail(`模拟 CLI 结果超时：${JSON.stringify(events)}`);
    } };
  }
  const first = start();
  first.worker.send('第一轮', 'a3da1b73-4f86-43c0-b91f-baa439a2fd10');
  const firstResult = await first.result(1);
  assert.deepEqual(JSON.parse(firstResult.text), { text: '第一轮', resumed: false });
  assert.equal(firstResult.costUsd, 0);
  await first.worker.interrupt();
  first.worker.send('第二轮', 'e089f75b-d79e-4093-a76d-31e6c06556df');
  assert.deepEqual(JSON.parse((await first.result(2)).text), { text: '第二轮', resumed: false });
  await first.worker.close();
  assert.equal(children[0].exitCode, 0);
  const resumed = start(firstResult.sessionId, { workerOverrides: { instructions: '恢复后当前任务的新约束' } });
  resumed.worker.send('恢复轮次', '8aa3c05e-41c6-44d1-950c-ea74701c301c');
  const resumedResult = await resumed.result(1);
  assert.equal(resumedResult.sessionId, firstResult.sessionId);
  assert.deepEqual(JSON.parse(resumedResult.text), { text: '恢复轮次', resumed: true });
  resumed.worker.send(JSON.stringify({ action: 'options' }), 'a9beb50f-ea6c-4056-bcd5-c035bf5fb80b');
  const resumedOptions = JSON.parse((await resumed.result(2)).text);
  assert.equal(resumedOptions.snapshot, false);
  assert.match(resumedOptions.append, /恢复后当前任务的新约束/);
  await resumed.worker.close();
  assert.equal(children[1].exitCode, 0);

  const questions = [];
  const controlled = start(undefined, { workerOverrides: { maxTurns: 7, maxBudgetUsd: 0.25 }, request: async (kind, payload) => {
    questions.push({ kind, payload });
    return kind === 'question' ? { text: 'A' }
      : payload.input.command === 'allowed-command' ? { allow: true } : { allow: false, reason: '命令未授权' };
  } });
  controlled.worker.send(JSON.stringify({ action: 'permission', command: 'allowed-command' }), 'b71c505a-d54c-4b97-9e83-678585d9ba86');
  assert.equal(JSON.parse((await controlled.result(1)).text).response.behavior, 'allow');
  assert.equal(questions[0].payload.decisionReason, '需要主控决定');
  controlled.worker.send(JSON.stringify({ action: 'permission', command: 'denied-command' }), '4188dcba-1dbb-4426-94bf-bf88d8a5978b');
  assert.equal(JSON.parse((await controlled.result(2)).text).response.behavior, 'deny');
  controlled.worker.send(JSON.stringify({ action: 'question' }), 'f7796ab1-fdd4-4b03-8b35-9a718f43edcf');
  assert.deepEqual(JSON.parse((await controlled.result(3)).text).response.updatedInput.answers, { 请选择执行方案: 'A' });
  controlled.worker.send(JSON.stringify({ action: 'batch' }), '2711c3e4-68f5-4779-b9f8-6b2d3e6e8884');
  controlled.worker.send(JSON.stringify({ action: 'batch' }), 'cb2f73ec-afd2-4028-8f64-209b750ab9b6');
  assert.deepEqual((await controlled.result(4)).messageIds, ['2711c3e4-68f5-4779-b9f8-6b2d3e6e8884', 'cb2f73ec-afd2-4028-8f64-209b750ab9b6']);
  controlled.worker.send(JSON.stringify({ action: 'failure' }), 'ce574c1d-e4ef-47bb-9b0f-fbfced823975');
  assert.equal((await controlled.result(5)).success, false);
  controlled.worker.send('失败后新任务', '738f2b72-aeae-4c37-beed-608c00295f06');
  assert.equal((await controlled.result(6)).success, true);
  controlled.worker.send(JSON.stringify({ action: 'options' }), 'b12838ac-9752-4f54-a811-78b27852d634');
  const options = JSON.parse((await controlled.result(7)).text);
  assert.equal(options.maxTurns, '--max-turns=7');
  assert.equal(options.maxBudgetUsd, '--max-budget-usd=0.25');
  assert.equal(options.snapshot, false);
  controlled.worker.send(JSON.stringify({ action: 'background' }), '7d287742-1818-4bc6-a4f7-4726277b3311');
  const backgroundResult = await controlled.result(8);
  assert.equal(backgroundResult.success, false);
  assert.equal(backgroundResult.background, true);
  await controlled.worker.close();
  assert.deepEqual(controlled.events.filter(event => event.type === 'background_tasks').at(-1).data.tasks, []);
  assert.equal(children[2].exitCode, 0);
});
