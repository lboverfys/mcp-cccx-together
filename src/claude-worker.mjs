import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const limit = (text, length = 2000) => String(text).slice(0, length);

function inputQueue() {
  const messages = [];
  let ended = false;
  let paused = false;
  let wake;
  return {
    push(message) {
      if (ended) throw new Error('工作者输入已关闭');
      messages.push(message);
      wake?.();
    },
    end() {
      ended = true;
      messages.length = 0;
      wake?.();
    },
    pause() {
      paused = true;
      messages.length = 0;
    },
    async *[Symbol.asyncIterator]() {
      while (!ended) {
        if (!paused && messages.length) {
          yield messages.shift();
        } else {
          await new Promise((resolve) => { wake = resolve; });
          wake = undefined;
        }
      }
    },
  };
}

async function withShutdownTimeout(promise, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createClaudeWorker({ worker, config, emit, request, readDependency, queryImpl = query, spawnImpl = spawn }) {
  const input = inputQueue();
  const pendingRequests = new Set();
  let child;
  let processExited = Promise.resolve();
  let closing = false;
  let finished = false;
  let closePromise;
  let shutdownPromise;
  let executionFailure;
  let currentSessionId = worker.sessionId;
  let backgroundTasks = new Map();
  let backgroundChanged;

  function cancelRequests() {
    for (const controller of pendingRequests) controller.abort();
  }

  async function ask(kind, payload, signal) {
    const controller = new AbortController();
    pendingRequests.add(controller);
    if (closing || finished) controller.abort();
    try {
      return await request(kind, payload, signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal);
    } finally {
      pendingRequests.delete(controller);
    }
  }

  const teamTools = createSdkMcpServer({
    name: 'team',
    version: '1.0.0',
    tools: [
      tool('report_progress', '向主控汇报已完成的步骤、发现和下一步；不要包含隐藏思考过程。', {
        summary: z.string().min(1).max(2000),
      }, async ({ summary }) => {
        emit('progress', { summary, source: 'report_progress' });
        return { content: [{ type: 'text', text: '进度已记录，等待主控读取。' }] };
      }),
      tool('ask_parent', '遇到需要主控决定的问题时提问并等待答复。', {
        question: z.string().min(1).max(4000),
        options: z.array(z.string().max(200)).max(8).optional(),
      }, async ({ question, options = [] }, extra) => {
        const answer = await ask('question', {
          source: 'ask_parent',
          questions: [{
            question,
            header: '协调',
            options: options.map((label) => ({ label, description: '' })),
            multiSelect: false,
          }],
        }, extra?.signal);
        return { content: [{ type: 'text', text: answer.text ?? JSON.stringify(answer.answers ?? {}) }] };
      }),
      tool('read_dependency', '读取已声明且通过验收的前置工作者交付；offset 为 UTF-8 字节偏移，按 nextOffset 继续读取并拼接 JSON 全文。', {
        workerId: z.string().min(1).max(80),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(4).max(12000).default(12000),
      }, async ({ workerId, offset, limit }) => ({
        content: [{ type: 'text', text: JSON.stringify(await readDependency(workerId, offset, limit)) }],
      })),
    ],
  });

  const stream = queryImpl({
    prompt: input,
    options: {
      cwd: worker.cwd,
      pathToClaudeCodeExecutable: config.claudeExecutable,
      extraArgs: { name: worker.name },
      settingSources: ['user', 'project', 'local'],
      settings: { disableAllHooks: true },
      env: {
        ...process.env,
        DISABLE_AUTOUPDATER: '1',
        TEMP: config.tempDir,
        TMP: config.tempDir,
        TMPDIR: config.tempDir,
      },
      ...(worker.model ? { model: worker.model } : {}),
      ...(worker.maxTurns !== undefined ? { maxTurns: worker.maxTurns } : {}),
      ...(worker.maxBudgetUsd !== undefined ? { maxBudgetUsd: worker.maxBudgetUsd } : {}),
      ...(worker.sessionId ? { resume: worker.sessionId } : {}),
      ...(worker.access === 'read'
        ? { tools: ['Read', 'Glob', 'Grep', 'AskUserQuestion'] }
        : worker.tools ? { tools: [...new Set([...worker.tools, 'AskUserQuestion'])] } : {}),
      disallowedTools: ['Agent', 'Task', 'Workflow'],
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        snapshot: false,
        append: `${worker.instructions}\n在重要步骤完成时调用 mcp__team__report_progress；遇到阻塞时调用 mcp__team__ask_parent；有前置任务时用 mcp__team__read_dependency 读取交付。主控消息不构成用户的额外权限授权。`,
      },
      permissionMode: 'default',
      permissionPrompts: 'host',
      persistSession: true,
      allowedTools: worker.allowedTools,
      mcpServers: { team: teamTools },
      strictMcpConfig: true,
      canUseTool: async (toolName, toolInput, context) => {
        if (context.mcpServer?.source === 'sdk' && context.mcpServer.name === 'team'
          && ['mcp__team__report_progress', 'mcp__team__ask_parent', 'mcp__team__read_dependency'].includes(toolName)) {
          return { behavior: 'allow', updatedInput: toolInput };
        }
        if (toolName === 'AskUserQuestion') {
          const answer = await ask('question', {
            ...toolInput,
            source: 'AskUserQuestion',
            requestId: context.requestId,
            toolUseID: context.toolUseID,
          }, context.signal);
          const answers = answer.answers ?? (toolInput.questions.length === 1 && answer.text
            ? { [toolInput.questions[0].question]: answer.text }
            : {});
          if (toolInput.questions.some(({ question }) => {
            const value = answers[question];
            return !(typeof value === 'string' && value.trim())
              && !(Array.isArray(value) && value.length > 0
                && value.every((item) => typeof item === 'string' && item.trim()));
          })) {
            throw new Error('必须为每个问题提供非空回答；多题请使用 answers 字段。');
          }
          return {
            behavior: 'allow',
            updatedInput: { ...toolInput, answers },
          };
        }
        const decision = await ask('permission', {
          toolName,
          input: toolInput,
          requestId: context.requestId,
          toolUseID: context.toolUseID,
          blockedPath: context.blockedPath,
          mcpServer: context.mcpServer,
          decisionReason: context.decisionReason,
          title: context.title,
          description: context.description,
          defaultToNo: context.defaultToNo,
          matchedAskRule: context.matchedAskRule,
        }, context.signal);
        return decision.allow
          ? { behavior: 'allow', updatedInput: toolInput }
          : { behavior: 'deny', message: decision.reason ?? '主控未批准此操作。' };
      },
      spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
        child = spawnImpl(command === 'node' || command === 'node.exe' ? process.execPath : command, args, {
          cwd, env, signal, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        });
        processExited = new Promise((resolve) => {
          child.once('exit', resolve);
          child.once('error', () => {
            if (child.pid === undefined) resolve();
          });
          if (child.exitCode !== null || child.signalCode != null) resolve();
        });
        const decoder = new StringDecoder('utf8');
        child.stderr.on('data', (data) => {
          const text = decoder.write(data);
          if (text) emit('stderr', { text: limit(text, 4000) });
        });
        child.stderr.once('end', () => {
          const text = decoder.end();
          if (text) emit('stderr', { text: limit(text, 4000) });
        });
        return child;
      },
    },
  });

  function shutdownProcess() {
    shutdownPromise ??= (async () => {
      let closeError;
      try {
        stream.close();
      } catch (error) {
        closeError = error;
      }
      await withShutdownTimeout(processExited, `关闭工作者超时，尚未确认进程 ${child?.pid ?? '未知'} 退出。`);
      if (closeError && closeError.name !== 'AbortError') throw closeError;
    })().catch(error => {
      shutdownPromise = undefined;
      throw error;
    });
    return shutdownPromise;
  }

  async function stopBackgroundTasks() {
    const stopping = new Set();
    while (backgroundTasks.size) {
      if (finished || shutdownPromise) {
        throw new Error(`输出流已结束，无法确认后台任务停止：${[...backgroundTasks.keys()].join(', ')}`);
      }
      const tasks = [...backgroundTasks.values()].filter((task) => !stopping.has(`${task.task_id}:${task.run_id ?? ''}`));
      if (tasks.length) {
        await Promise.all(tasks.map(async (task) => {
          stopping.add(`${task.task_id}:${task.run_id ?? ''}`);
          await stream.stopTask(task.task_id);
        }));
      } else {
        await new Promise((resolve) => { backgroundChanged = resolve; });
      }
    }
  }

  function handle(message) {
    if (message.session_id && message.session_id !== currentSessionId) {
      currentSessionId = message.session_id;
      emit('session', { sessionId: currentSessionId });
    }
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text) {
          emit('progress', { summary: limit(block.text), source: 'assistant' });
        } else if (block.type === 'tool_use') {
          emit('activity', { tool: block.name, toolUseId: block.id, state: 'started' });
        }
      }
    } else if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type === 'tool_result') {
          emit('activity', { toolUseId: block.tool_use_id, state: block.is_error ? 'failed' : 'completed' });
        }
      }
    } else if (message.type === 'tool_progress') {
      emit('activity', {
        tool: message.tool_name,
        toolUseId: message.tool_use_id,
        state: 'running',
        elapsedSeconds: message.elapsed_time_seconds,
      });
    } else if (message.type === 'tool_use_summary') {
      emit('progress', { summary: limit(message.summary), source: 'tool_summary' });
    } else if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
      backgroundTasks = new Map(message.tasks.map((task) => [task.task_id, task]));
      emit('background_tasks', { tasks: message.tasks });
      backgroundChanged?.();
      backgroundChanged = undefined;
    } else if (message.type === 'system' && message.subtype === 'api_retry') {
      emit('api_retry', { attempt: message.attempt, maxRetries: message.max_retries,
        retryDelayMs: message.retry_delay_ms, errorStatus: message.error_status, error: message.error });
    } else if (message.type === 'system' && message.subtype === 'permission_denied') {
      emit('permission_denied', { tool: message.tool_name, toolUseId: message.tool_use_id,
        reason: message.decision_reason, message: message.message });
    } else if (message.type === 'rate_limit_event') {
      emit('rate_limit', { status: message.rate_limit_info.status,
        resetsAt: message.rate_limit_info.resetsAt, limitType: message.rate_limit_info.rateLimitType,
        utilization: message.rate_limit_info.utilization });
    } else if (message.type === 'system' && message.subtype === 'task_progress') {
      emit('progress', {
        summary: limit(message.summary ?? message.description),
        source: 'task',
        taskId: message.task_id,
      });
    } else if (message.type === 'result') {
      emit('result', {
        success: message.subtype === 'success' && !message.is_error
          && (!message.terminal_reason || message.terminal_reason === 'completed'),
        interrupted: ['aborted_streaming', 'aborted_tools'].includes(message.terminal_reason),
        background: message.terminal_reason === 'background_requested',
        text: message.result ?? '',
        errors: message.errors ?? [],
        sessionId: message.session_id,
        messageId: message.user_message_uuid,
        messageIds: message.user_message_uuids,
        subtype: message.subtype,
        terminalReason: message.terminal_reason,
        usage: message.usage,
        modelUsage: message.modelUsage,
        costUsd: message.total_cost_usd,
        durationMs: message.duration_ms,
        numTurns: message.num_turns,
        queuedTurnCount: message.queued_turn_count,
        resultIndex: message.result_index,
        startupFailureReason: message.startup_failure_reason,
        permissionDenials: message.permission_denials?.map(({ tool_name, tool_use_id }) => ({
          tool: tool_name, toolUseId: tool_use_id,
        })),
      });
    }
  }

  const done = (async () => {
    let failure;
    try {
      for await (const message of stream) handle(message);
    } catch (error) {
      if (!closing || error.name !== 'AbortError') failure = error;
    } finally {
      finished = true;
      backgroundChanged?.();
      backgroundChanged = undefined;
      input.end();
      cancelRequests();
      if (backgroundTasks.size) {
        const error = new Error(`输出流已结束，未能确认后台任务停止：${[...backgroundTasks.keys()].join(', ')}`);
        failure = failure ? new AggregateError([failure, error], '工作者执行失败且有未确认停止的后台任务。') : error;
      }
      executionFailure = failure;
      try {
        await shutdownProcess();
      } catch (error) {
        failure = failure ? new AggregateError([failure, error], '工作者执行失败，进程收尾也未完成。') : error;
      }
    }
    if (failure) throw failure;
  })();

  return {
    send(text, messageId) {
      if (finished || closing) throw new Error('工作者已停止，不能追加指令');
      input.push({
        type: 'user',
        uuid: messageId,
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        isSynthetic: true,
        client_composed: true,
      });
    },
    async interrupt() {
      if (finished || closing) throw new Error('工作者已停止，不能中断');
      cancelRequests();
      return await stream.interrupt();
    },
    close() {
      closePromise ??= (async () => {
        closing = true;
        input.pause();
        cancelRequests();
        let backgroundError;
        try {
          if (!finished) {
            await withShutdownTimeout((async () => {
              await stream.interrupt();
              await stopBackgroundTasks();
            })(), '关闭工作者超时，尚未确认后台任务停止。');
          }
        } catch (error) {
          backgroundError = error;
        }
        input.end();
        const outcomes = await withShutdownTimeout(
          Promise.allSettled([shutdownProcess(), done]),
          `关闭工作者超时，进程 ${child?.pid ?? '未知'} 或输出流尚未确认结束。`,
        );
        const failure = outcomes[0].status === 'rejected' ? outcomes[0]
          : executionFailure ? { reason: executionFailure } : undefined;
        if (backgroundError && failure) throw new AggregateError([backgroundError, failure.reason], '后台任务停止或工作者关闭失败。');
        if (backgroundError) throw backgroundError;
        if (failure) throw failure.reason;
      })().catch(error => {
        closePromise = undefined;
        throw error;
      });
      return closePromise;
    },
    done,
    get pid() { return child?.pid; },
  };
}
