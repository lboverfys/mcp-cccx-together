#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { executableCommand, loadConfig, projectRoot } from './config.mjs';
import { codexConfigPath, inspectCodexServer, updateCodexServer } from './codex-config.mjs';
import { providerSourceVariables } from './providers.mjs';

const execute = promisify(execFile);
const DEFAULT_WAIT_MS = 50000;
// setup 默认让 team_wait 单次最多等 9.5 分钟，Codex 工具超时同步设为 10 分钟。
const LONG_WAIT_MS = 570000;
const cliPath = fileURLToPath(import.meta.url);
const help = `CC Team MCP — Codex 协调本机 Claude Code

用法：cc-team-mcp [serve|doctor|print-config|setup|stats|prune|recover] [选项]

  serve         启动标准输入/输出 MCP 服务（默认命令）
  doctor        检查客户端、运行时及目录权限；不调用模型、不创建目录
  print-config  输出通用 MCP JSON 配置
  setup         使用 codex mcp add 注册服务，并设置长等待和工具超时；保留已有同名配置
  stats         汇总团队耗时：主控（Codex）在调用之间的时间、CC 运行、验证与合并时间
  prune         预览已关闭团队的历史结果清理，保护仍被引用的版本
  recover       预览异常退出团队的锁及日志尾行恢复，拒绝未完成收尾的任务
  --team ID     stats/prune/recover 的团队 ID
  --keep-results N  prune 每名工作者至少保留最近 N 份结果（必填）
  --apply       prune/recover 实际执行；省略时仅预览
  --config PATH 指定 JSON 配置文件
  --name NAME   MCP 注册名称（默认 cc_team；setup/print-config/doctor）
  --help        显示帮助
  --version     显示版本

环境变量：CC_TEAM_CONFIG、CC_TEAM_CLAUDE_EXECUTABLE、CC_TEAM_CODEX_EXECUTABLE、
CC_TEAM_STATE_DIR、CC_TEAM_TEMP_DIR、CC_TEAM_NOTIFICATION_MODE、
CC_TEAM_PERMISSION_MODE、CC_TEAM_WAIT_TIMEOUT_MS、CC_TEAM_DEFAULT_PROVIDER。
`;

function parseArgs(args) {
  const options = { command: 'serve', name: 'cc_team' };
  let commandSeen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--help', '-h', '--version', '-v'].includes(arg)) return { command: arg.includes('version') || arg === '-v' ? 'version' : 'help' };
    if (['--config', '--name', '--team', '--keep-results'].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} 缺少参数`);
      options[arg.slice(2)] = args[++i];
      continue;
    }
    if (arg === '--apply') { options.apply = true; continue; }
    if (['serve', 'doctor', 'print-config', 'setup', 'stats', 'prune', 'recover'].includes(arg) && !commandSeen) {
      options.command = arg;
      commandSeen = true;
      continue;
    }
    throw new Error(`未知参数：${arg}；使用 --help 查看用法`);
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,79}$/.test(options.name)) throw new Error('--name 只能包含字母、数字、下划线和连字符，最多 80 字符');
  if (options.name !== 'cc_team' && !['setup', 'print-config', 'doctor'].includes(options.command)) throw new Error('--name 仅适用于 setup、print-config 或 doctor');
  const maintenance = ['prune', 'recover'].includes(options.command);
  const teamCommand = maintenance || options.command === 'stats';
  if (teamCommand && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(options.team ?? '')) throw new Error(`${options.command} 需要有效的 --team ID`);
  if (!teamCommand && options.team !== undefined) throw new Error('--team 仅适用于 stats、prune 或 recover');
  if (!maintenance && options.apply) throw new Error('--apply 仅适用于 prune 或 recover');
  if (options.command === 'prune') {
    if (!/^[1-9][0-9]*$/.test(options['keep-results'] ?? '') || !Number.isSafeInteger(Number(options['keep-results']))) throw new Error('prune 需要正整数 --keep-results N');
  } else if (options['keep-results'] !== undefined) throw new Error('--keep-results 仅适用于 prune');
  return options;
}

export function mcpConfiguration(config, name = 'cc_team', entryPath = cliPath) {
  const args = [entryPath, 'serve'];
  if (config.configPath) args.push('--config', config.configPath);
  const env = config.configPath ? { ...config.registrationEnv } : {
    CC_TEAM_STATE_DIR: config.stateDir,
    CC_TEAM_TEMP_DIR: config.tempDir,
    CC_TEAM_NOTIFICATION_MODE: config.notificationMode,
    CC_TEAM_PERMISSION_MODE: config.permissionMode,
    CC_TEAM_WAIT_TIMEOUT_MS: String(config.waitTimeoutMs),
    ...(config.claudeExecutable ? { CC_TEAM_CLAUDE_EXECUTABLE: config.claudeExecutable } : {}),
    ...(config.codexExecutable ? { CC_TEAM_CODEX_EXECUTABLE: config.codexExecutable } : {}),
  };
  return { mcpServers: { [name]: { command: process.execPath, args, env } } };
}

function inspectDirectory(directory) {
  let current = directory;
  for (;;) {
    try {
      if (!statSync(current).isDirectory()) throw new Error(`路径不是目录：${current}`);
      accessSync(current, constants.W_OK | constants.X_OK);
      return { ok: true, path: directory, exists: current === directory, checkedPath: current };
    } catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(current) === current) {
        return { ok: false, path: directory, checkedPath: current, error: error.message };
      }
      current = path.dirname(current);
    }
  }
}

/**
 * Codex 侧等待设置：team_wait 单次等待太短时，CC 运行期间主控要反复调用，每次都是一轮慢的主控回合。
 * 只影响速度，不影响可用性，因此标为可选检查。
 */
function codexWaitCheck(file, name) {
  let found;
  try { found = inspectCodexServer(file, name); }
  catch (error) { return { ok: false, optional: true, file, error: error.message }; }
  if (!found.found) return { ok: false, optional: true, file, hint: `未在 Codex 配置中找到 [mcp_servers.${name}]；运行 cc-team-mcp setup 注册` };
  const waitTimeoutMs = found.waitTimeoutMs ?? DEFAULT_WAIT_MS;
  const toolTimeoutSec = found.toolTimeoutSec ?? 60;
  const ok = waitTimeoutMs >= 120000 && toolTimeoutSec * 1000 > waitTimeoutMs;
  return { ok, optional: true, file, toolTimeoutSec, waitTimeoutMs,
    ...(ok ? {} : { hint: `team_wait 单次只等 ${Math.round(Math.min(waitTimeoutMs, toolTimeoutSec * 1000) / 1000)} 秒，CC 运行期间主控要多轮调用。` +
      `在 [mcp_servers.${name}] 设置 tool_timeout_sec = 600，并把 env 中的 CC_TEAM_WAIT_TIMEOUT_MS 设为 "570000"` }) };
}

export async function runCli(args = process.argv.slice(2), {
  stdout = process.stdout, stderr = process.stderr, executeImpl = execute,
  loadConfigImpl = loadConfig, runServerImpl, entryPath = cliPath, env = process.env, home = homedir(),
} = {}) {
  try {
    const options = parseArgs(args);
    if (options.command === 'help') { stdout.write(help); return 0; }
    if (options.command === 'version') {
      stdout.write(`${JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version}\n`);
      return 0;
    }
    const maintenance = ['prune', 'recover'].includes(options.command);
    const offline = maintenance || options.command === 'stats';
    const config = loadConfigImpl(options.config, { requireClaude: !offline && options.command !== 'doctor', diagnostic: offline || options.command === 'doctor' });
    if (options.command === 'stats') {
      const { teamStats } = await import('./timing.mjs');
      stdout.write(`${JSON.stringify(teamStats(config, options.team), null, 2)}\n`);
      return 0;
    }
    if (maintenance) {
      const { pruneTeam, recoverTeam } = await import('./maintenance.mjs');
      const result = options.command === 'prune'
        ? await pruneTeam(config, options.team, { keepResults: Number(options['keep-results']), apply: options.apply })
        : await recoverTeam(config, options.team, { apply: options.apply });
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    const call = async (executable, commandArgs) => {
      const invocation = executableCommand(executable);
      return executeImpl(invocation.command, [...invocation.args, ...commandArgs], {
        windowsHide: true, shell: false, timeout: 10000, maxBuffer: 64 * 1024, encoding: 'utf8',
        env: { ...env, DISABLE_AUTOUPDATER: '1' },
      });
    };
    if (options.command === 'doctor') {
      const checks = { node: { version: process.version, path: process.execPath, ok: Number(process.versions.node.split('.')[0]) >= 22 } };
      for (const name of ['claude', 'codex']) {
        const executable = config[`${name}Executable`];
        if (!executable) { checks[name] = { ok: false, optional: name === 'codex' && !config.executableErrors?.[name] && config.notificationMode !== 'codex-queue',
          error: config.executableErrors?.[name] ?? `未找到 ${name} 可执行入口` }; continue; }
        try {
          const result = await call(executable, ['--version']);
          checks[name] = { ok: true, path: executable, version: result.stdout.trim() };
        } catch (error) {
          checks[name] = { ok: false, path: executable, optional: false, error: error.message };
        }
      }
      if (config.notificationMode === 'codex-queue') {
        try {
          if (!config.codexExecutable) throw new Error('未找到 Codex 可执行入口');
          await call(config.codexExecutable, ['queue', '--help']);
          checks.notifications = { ok: true, mode: 'codex-queue' };
        } catch (error) {
          checks.notifications = { ok: false, mode: 'codex-queue', error: `当前 Codex 不支持 queue 通知：${error.message}；可将 notificationMode 设置为 poll` };
        }
      }
      checks.codexWait = codexWaitCheck(codexConfigPath(env, home), options.name);
      checks.stateDir = inspectDirectory(config.stateDir);
      checks.tempDir = inspectDirectory(config.tempDir);
      stdout.write(`${JSON.stringify({ checks, stateDir: config.stateDir, tempDir: config.tempDir,
        configPath: config.configPath ?? null, notificationMode: config.notificationMode,
        permissionMode: config.permissionMode, waitTimeoutMs: config.waitTimeoutMs }, null, 2)}\n`);
      return Object.values(checks).every(check => check.ok || check.optional === true) ? 0 : 1;
    }
    if (options.command === 'print-config') {
      stdout.write(`${JSON.stringify(mcpConfiguration(config, options.name, entryPath), null, 2)}\n`);
      return 0;
    }
    if (options.command === 'setup') {
      if (!config.codexExecutable) throw new Error('未找到 Codex。请安装 Codex CLI，或用 print-config 手动配置 MCP 客户端。');
      let existing;
      try { existing = await call(config.codexExecutable, ['mcp', 'get', options.name, '--json']); }
      catch (error) {
        if (!/No MCP server named .+ found\./i.test(`${error.stderr ?? ''}\n${error.stdout ?? ''}`)) throw error;
      }
      if (existing) throw new Error(`MCP 配置 ${options.name} 已存在。请使用 --name 选择其他名称，或先用 codex mcp remove ${options.name} 移除旧配置。`);
      const register = async waitMs => {
        const registration = mcpConfiguration(config, options.name, entryPath).mcpServers[options.name];
        const envArgs = Object.entries({ ...registration.env, CC_TEAM_WAIT_TIMEOUT_MS: String(waitMs) })
          .flatMap(([key, value]) => ['--env', `${key}=${value}`]);
        await call(config.codexExecutable, ['mcp', 'add', options.name, ...envArgs, '--', registration.command, ...registration.args]);
      };
      // 等待上限必须低于 Codex 的工具超时：两者一起写入，写不进工具超时就退回默认等待。
      const waitMs = config.waitTimeoutExplicit ? config.waitTimeoutMs : LONG_WAIT_MS;
      const toolTimeoutSec = Math.ceil(waitMs / 1000) + 30;
      const forward = providerSourceVariables(config.providers);
      const configFile = codexConfigPath(env, home);
      await register(waitMs);
      let tuned;
      try { tuned = updateCodexServer(configFile, options.name, { toolTimeoutSec, envVars: forward }); }
      catch (error) {
        let effectiveWait = waitMs;
        if (waitMs > DEFAULT_WAIT_MS) {
          await call(config.codexExecutable, ['mcp', 'remove', options.name]);
          await register(DEFAULT_WAIT_MS);
          effectiveWait = DEFAULT_WAIT_MS;
        }
        stdout.write(`已注册 MCP：${options.name}，但未能写入 ${configFile}：${error.message}\n` +
          `team_wait 单次最多等待 ${effectiveWait} 毫秒。需要更长等待时，在 [mcp_servers.${options.name}] 中手动设置 tool_timeout_sec = 600 并把 CC_TEAM_WAIT_TIMEOUT_MS 改为 570000` +
          `${forward.length ? `；并添加 env_vars = [${forward.map(name => JSON.stringify(name)).join(', ')}] 转发 provider 凭据` : ''}。\n`);
        return 0;
      }
      stdout.write(`已注册 MCP：${options.name}。请重新打开 Codex 会话后使用；可用 codex mcp get ${options.name} 查看配置。\n` +
        `已在 ${configFile} 设置 tool_timeout_sec = ${toolTimeoutSec}，team_wait 单次最多等待 ${waitMs} 毫秒。\n` +
        (tuned.forwarded.length ? `已转发 provider 所需环境变量：${tuned.forwarded.join(', ')}。\n` : '') +
        (tuned.unmanagedEnvVars ? `现有 env_vars 是多行数组，未自动修改；请手动加入：${forward.join(', ')}。\n` : ''));
      return 0;
    }
    const runServer = runServerImpl ?? (await import('./server.mjs')).runServer;
    await runServer(config);
    return 0;
  } catch (error) {
    stderr.write(`CC Team MCP：${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runCli();
}
