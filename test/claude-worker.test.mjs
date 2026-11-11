import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
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

function harness({ workerOverrides = {}, request, autoExit = true, streamError, endError, stopTask } = {}) {
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
    emit(type, data) {
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
      options.spawnClaudeCodeProcess({
        command: options.pathToClaudeCodeExecutable,
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
  assert.deepEqual(Object.keys(h.options.mcpServers), ['team']);
  assert.deepEqual(h.options.settings, { disableAllHooks: true });
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
  assert.deepEqual(h.options.settings, { disableAllHooks: true });
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
  const h = harness({ request: async (kind, payload) => {
    asked.resolve({ kind, payload });
    return await response.promise;
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
  } finally {
    await client.close();
    await server.close();
    await h.instance.close();
  }
});
