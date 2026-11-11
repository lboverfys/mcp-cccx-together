import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const option = name => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
};
const name = option('name');
const resumedSession = option('resume');
const sessionId = resumedSession || randomUUID();
const logPath = path.join(process.env.CC_TEAM_WORKFLOW_LOG_DIR, `${process.pid}.jsonl`);
const log = value => appendFileSync(logPath, `${JSON.stringify(value)}\n`);
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const pending = new Map();
let mcpReady = false;
let rpcId = 0;

log({ type: 'start', pid: process.pid, name, sessionId, resumedSession, cwd: process.cwd() });

function control(request) {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    send({ type: 'control_request', request_id: requestId, request });
  });
}

async function mcpMessage(message) {
  const response = await control({ subtype: 'mcp_message', server_name: 'team', message });
  if (response.mcp_response.error) throw new Error(response.mcp_response.error.message);
  return response.mcp_response.result;
}

async function readDependency(workerId) {
  if (!mcpReady) {
    await mcpMessage({ jsonrpc: '2.0', id: ++rpcId, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'workflow-fixture', version: '1.0.0' },
    } });
    await mcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
    mcpReady = true;
  }
  let text = '', offset = 0, pages = 0;
  for (;;) {
    const result = await mcpMessage({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: {
      name: 'read_dependency', arguments: { workerId, offset, limit: 4096 },
    } });
    if (result.isError) throw new Error(result.content[0].text);
    const chunk = JSON.parse(result.content[0].text);
    text += chunk.text;
    pages++;
    if (!chunk.hasMore) break;
    if (!(chunk.nextOffset > offset)) throw new Error('依赖分页游标未前进');
    offset = chunk.nextOffset;
  }
  log({ type: 'dependency', name, workerId, pages, textLength: text.length });
  return JSON.parse(text);
}

async function writeImplementation(content) {
  const file = path.join(process.cwd(), 'implementation.txt');
  const input = { file_path: file, content };
  const response = await control({ subtype: 'can_use_tool', tool_name: 'Write', input,
    tool_use_id: randomUUID(), permission_suggestions: [] });
  log({ type: 'permission', name, behavior: response.behavior, content });
  if (response.behavior !== 'allow') throw new Error('实现文件写入被拒绝');
  writeFileSync(response.updatedInput.file_path, response.updatedInput.content);
}

function result(message, text, errors = []) {
  send({ type: 'result', subtype: errors.length ? 'error_during_execution' : 'success',
    is_error: errors.length > 0, uuid: randomUUID(), session_id: sessionId,
    result: text, errors, terminal_reason: 'completed', user_message_uuid: message.uuid,
    user_message_uuids: [message.uuid], duration_ms: 1, duration_api_ms: 0,
    total_cost_usd: 0, num_turns: 1, usage: { input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {}, permission_denials: [] });
}

async function user(message) {
  const text = typeof message.message.content === 'string' ? message.message.content : JSON.stringify(message.message.content);
  log({ type: 'input', name, text });
  send({ type: 'system', subtype: 'init', session_id: sessionId, uuid: randomUUID(),
    tools: ['Read', 'Write'], mcp_servers: [{ name: 'team', status: 'connected' }],
    model: 'local-workflow-fixture', cwd: process.cwd(), permissionMode: 'default' });
  send({ type: 'assistant', session_id: sessionId, uuid: randomUUID(), message: {
    role: 'assistant', content: [{ type: 'text', text: `${name} 正在处理本地测试任务` }],
  } });
  if (name === '设计cc') {
    result(message, `DESIGN-CONTRACT\n${'接口字段与验收标准。'.repeat(6000)}\nDESIGN-END`);
    // A completed query can exit before its parent has reviewed the result.
    process.stdout.end(() => process.exit(0));
  } else if (name === '实现cc') {
    const design = await readDependency('设计cc');
    if (!design.text.includes('DESIGN-CONTRACT') || !design.text.endsWith('DESIGN-END')) throw new Error('设计交付不完整');
    if (text.includes('RECHECK_IMPLEMENT')) {
      result(message, 'IMPLEMENTATION-DRAFT-RECHECKED');
      return;
    }
    const fixed = text.includes('FIX_IMPLEMENT');
    await writeImplementation(fixed ? 'ready-v2' : 'draft-v1');
    result(message, fixed ? 'IMPLEMENTATION-FIXED' : 'IMPLEMENTATION-DRAFT');
  } else if (name === '验证cc') {
    const implementation = await readDependency('实现cc');
    log({ type: 'implementation-result', text: implementation.text });
    const content = readFileSync(path.join(process.cwd(), 'implementation.txt'), 'utf8');
    result(message, content === 'ready-v2' ? 'VERIFIED-READY-V2' : '', content === 'ready-v2' ? [] : ['验证发现 draft-v1，需 FIX_IMPLEMENT']);
  } else {
    throw new Error(`未知夹具工作者：${name}`);
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'control_response') {
    const handler = pending.get(message.response.request_id);
    if (!handler) return;
    pending.delete(message.response.request_id);
    if (message.response.subtype === 'error') handler.reject(new Error(message.response.error));
    else handler.resolve(message.response.response);
  } else if (message.type === 'control_request') {
    if (message.request.subtype === 'initialize') {
      log({ type: 'initialize', name, resumedSession, appendSystemPrompt: message.request.appendSystemPrompt,
        systemPromptSnapshot: message.request.systemPromptSnapshot });
    }
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
      response: message.request.subtype === 'initialize'
        ? { commands: [], models: [], account: {}, output_style: 'default', available_output_styles: [] } : {} } });
  } else if (message.type === 'user') {
    user(message).catch(error => {
      log({ type: 'fixture-error', message: error.message });
      result(message, '', [error.message]);
    });
  }
});
lines.on('close', () => process.exit(0));
