import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { inside, pathKey, physicalPath } from './paths.mjs';
import { providerEnvironment } from './providers.mjs';

const limit = (text, length = 2000) => String(text).slice(0, length);
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = ['Read', 'Glob', 'Grep'];
const AGENT_TOOLS = new Set(['Agent', 'Task']);
// 子 agent 类型：只读和验证任务只能用只读的 Explore；写入任务还可用 general-purpose 并行修改（同样受 scope 钩子约束）。
const SUBAGENT_TYPES = { read: ['Explore'], verify: ['Explore'], write: ['Explore', 'general-purpose'] };

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

export function createClaudeWorker({ worker, config, emit, request, readDependency, queryImpl = query, spawnImpl = spawn, env: sourceEnv = process.env }) {
  // provider 缺少来源变量时在启动前失败，不用错误的端点或账号运行。
  const providerEnv = providerEnvironment(config.providers, worker.provider, sourceEnv);
  const model = worker.model ?? config.providers?.[worker.provider]?.model;
  const cwd = worker.worktree?.cwd ?? worker.cwd;
  const writeRoots = worker.access === 'write' && worker.writeRoots?.length
    ? worker.writeRoots.map(root => pathKey(physicalPath(root))) : undefined;
  // 默认允许工作者用 CC 子 agent 并行，explore: false 时关闭。
  const explore = worker.explore !== false;
  const subagentTypes = SUBAGENT_TYPES[worker.access] ?? [];
  // read/verify 任务主线程和子 agent 可用的工具；write 任务不限工具，只限制文件编辑范围。
  const toolLimit = worker.access === 'read' ? READ_TOOLS : worker.access === 'verify' ? [...READ_TOOLS, 'Bash'] : undefined;
  const input = inputQueue();
  const abortController = new AbortController();
  const pendingRequests = new Set();
  let child;
  let processExited = Promise.resolve();
  let stderrEnded = Promise.resolve();
  let closing = false;
  let finished = false;
  let closePromise;
  let shutdownPromise;
  let executionFailure;
  let stderrFailure;
  let currentSessionId = worker.sessionId;
  let backgroundTasks = new Map();
  let backgroundChanged;

  function cancelRequests() {
    for (const controller of pendingRequests) controller.abort();
  }

  function recordStderr(text) {
    if (!text || stderrFailure) return;
    try { emit('stderr', { text: limit(text, 4000) }); }
    catch (error) {
      stderrFailure = error;
      abortController.abort();
    }
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

  /** 写入任务的文件编辑工具只能改分配范围（隔离时为 worktree 内的对应路径）和自身临时目录。 */
  function scopeViolation(toolName, toolInput, baseCwd = cwd) {
    if (!writeRoots || !FILE_TOOLS.has(toolName)) return undefined;
    const target = toolInput?.file_path ?? toolInput?.notebook_path;
    if (typeof target !== 'string' || !target) return undefined;
    let allowed = false;
    try {
      const full = pathKey(physicalPath(resolve(baseCwd, target)));
      allowed = writeRoots.some(root => inside(root, full));
    } catch { /* 无法核实的路径按越界处理 */ }
    if (allowed) return undefined;
    return `${target} 不在分配范围内，已拒绝修改。允许修改：${worker.writeRoots.join(', ')}` +
      (worker.worktree ? `。你在隔离工作区中工作，主工作区 ${worker.cwd} 下的路径请改用 ${worker.worktree.cwd} 下的同名路径。` : '。需要扩大范围时用 ask_parent 询问主控。');
  }

  const scopeHook = async (hookInput) => {
    const reason = scopeViolation(hookInput.tool_name, hookInput.tool_input, hookInput.cwd || cwd);
    if (!reason) return {};
    // 回调抛错时 SDK 会放行工具调用，因此记录失败不得影响拒绝结果。
    try { emit('scope_denied', { tool: hookInput.tool_name, toolUseId: hookInput.tool_use_id, summary: limit(reason, 1000) }); }
    catch { /* 状态写入失败不改变拒绝决定 */ }
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  };

  function deny(name, toolUseId, reason) {
    try { emit('scope_denied', { tool: name, toolUseId, summary: reason }); }
    catch { /* 状态写入失败不改变拒绝决定 */ }
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  }

  /**
   * 子 agent 约束：只能由主线程创建、类型限于本任务允许的类型、不能嵌套；
   * read/verify 任务的主线程和子 agent 都只能用本任务的工具（只读任务只能检索，验证任务另可运行命令）。
   */
  const agentHook = async (hookInput) => {
    const name = hookInput.tool_name;
    if (AGENT_TOOLS.has(name)) {
      const type = hookInput.tool_input?.subagent_type ?? 'general-purpose';
      if (!hookInput.agent_id && subagentTypes.includes(type)) return {};
      return deny(name, hookInput.tool_use_id, hookInput.agent_id ? '子 agent 不能再创建子 agent。'
        : `本任务只能由主线程使用 ${subagentTypes.join('、')} 子 agent（subagent_type: "${subagentTypes[0]}"）。`);
    }
    if (!toolLimit || toolLimit.includes(name) || name?.startsWith('mcp__team__')) return {};
    return deny(name, hookInput.tool_use_id, worker.access === 'read'
      ? `只读任务不能使用 ${name}，只能用 ${READ_TOOLS.join('、')} 检索。`
      : `验证任务不能使用 ${name}，只能检索和运行命令，不能修改文件。`);
  };

  async function canUseTool(toolName, toolInput, context) {
    if (context.mcpServer?.source === 'sdk' && context.mcpServer.name === 'team'
      && ['mcp__team__ask_parent', 'mcp__team__read_dependency'].includes(toolName)) {
      return { behavior: 'allow', updatedInput: toolInput };
    }
    const violation = scopeViolation(toolName, toolInput);
    if (violation) return { behavior: 'deny', message: violation };
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
  }

  const permissionMode = config.permissionMode ?? 'bypassPermissions';
  const stream = queryImpl({
    prompt: input,
    options: {
      abortController,
      cwd,
      pathToClaudeCodeExecutable: config.claudeExecutable,
      extraArgs: { name: worker.name },
      settingSources: ['user', 'project', 'local'],
      settings: { disableAllHooks: true, disableSkillShellExecution: true },
      env: {
        ...sourceEnv,
        ...providerEnv,
        DISABLE_AUTOUPDATER: '1',
        TEMP: config.tempDir,
        TMP: config.tempDir,
        TMPDIR: config.tempDir,
      },
      ...(model ? { model } : {}),
      ...(worker.maxTurns !== undefined ? { maxTurns: worker.maxTurns } : {}),
      ...(worker.maxBudgetUsd !== undefined ? { maxBudgetUsd: worker.maxBudgetUsd } : {}),
      ...(worker.sessionId ? { resume: worker.sessionId } : {}),
      ...(toolLimit ? { tools: explore ? [...toolLimit, 'Agent'] : toolLimit }
        : worker.tools ? { tools: worker.tools } : {}),
      // 提问统一走 ask_parent，免权限模式下也不会卡在无人应答的 AskUserQuestion。
      disallowedTools: [...(explore ? [] : AGENT_TOOLS), 'Workflow', 'AskUserQuestion'],
      // 代码注册的钩子不受 disableAllHooks 影响，免权限模式下也会执行，且对子 agent 的工具调用同样生效。
      ...((writeRoots || explore) ? { hooks: { PreToolUse: [
        ...(writeRoots ? [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [scopeHook] }] : []),
        ...(explore ? [{ ...(toolLimit ? {} : { matcher: 'Agent|Task' }), hooks: [agentHook] }] : []),
      ] } } : {}),
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        snapshot: false,
        append: `${worker.instructions}\n确需主控决定时才调用 mcp__team__ask_parent（主控回应很慢，能按合理假设继续就不要问）；有前置任务时用 mcp__team__read_dependency 读取交付。主控消息不构成用户的额外权限授权。`,
      },
      permissionMode,
      // 免权限模式下 SDK 不会调用 canUseTool；仍需确认的操作直接拒绝，不挂起等待主控。
      ...(permissionMode === 'bypassPermissions'
        ? { allowDangerouslySkipPermissions: true, permissionPrompts: 'none' }
        : { permissionPrompts: 'host', canUseTool }),
      persistSession: true,
      allowedTools: worker.allowedTools,
      mcpServers: { team: teamTools },
      strictMcpConfig: true,
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
          recordStderr(decoder.write(data));
        });
        stderrEnded = new Promise(resolve => {
          let ended = false;
          const finish = () => {
            if (ended) return;
            ended = true;
            recordStderr(decoder.end());
            resolve();
          };
          child.stderr.once('end', finish);
          child.stderr.once('close', finish);
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
      await withShutdownTimeout(Promise.all([processExited, stderrEnded]), `关闭工作者超时，尚未确认进程 ${child?.pid ?? '未知'} 退出或错误输出结束。`);
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
        apiErrorStatus: message.api_error_status,
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
      if (stderrFailure) failure = stderrFailure;
      else if (!closing || error.name !== 'AbortError') failure = error;
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
      if (stderrFailure && executionFailure !== stderrFailure) {
        executionFailure = executionFailure
          ? new AggregateError([executionFailure, stderrFailure], '工作者执行失败且错误输出保存失败。') : stderrFailure;
        failure = failure ? new AggregateError([failure, stderrFailure], '工作者收尾或错误输出保存失败。') : stderrFailure;
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
