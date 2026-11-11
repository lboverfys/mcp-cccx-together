import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageNames = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' };

export function defaultDirectories({ platform = process.platform, env = process.env, home = homedir(), temporaryRoot = tmpdir() } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  let base;
  if (platform === 'win32') base = env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local');
  else if (platform === 'darwin') base = paths.join(home, 'Library', 'Application Support');
  else base = env.XDG_STATE_HOME || paths.join(home, '.local', 'state');
  return { stateDir: paths.join(base, 'cc-team-mcp'), tempDir: paths.join(temporaryRoot, 'cc-team-mcp') };
}

function fileExists(file) {
  try { return statSync(file).isFile(); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
}

function npmEntry(directory, name) {
  const root = path.join(directory, 'node_modules', packageNames[name]);
  const manifest = path.join(root, 'package.json');
  if (!fileExists(manifest)) return undefined;
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[name];
  if (typeof bin !== 'string') return undefined;
  const entry = path.resolve(root, bin);
  const relative = path.relative(root, entry);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`${name} 的 npm bin 路径超出包目录：${manifest}`);
  }
  return fileExists(entry) ? realpathSync(entry) : undefined;
}

function resolveEntry(candidate, name, platform) {
  if (!fileExists(candidate)) return undefined;
  let entry = realpathSync(candidate);
  if (/\.(?:cmd|bat|ps1)$/i.test(entry)) {
    entry = npmEntry(path.dirname(candidate), name);
    if (!entry) return undefined;
  }
  if (/\.(?:cmd|bat|ps1)$/i.test(entry)) return undefined;
  if (name === 'claude' && /\.cjs$/i.test(entry)) return undefined;
  if (platform !== 'win32' && !/\.[cm]?js$/i.test(entry)) {
    try { accessSync(entry, constants.X_OK); }
    catch (error) { if (error.code === 'EACCES') return undefined; throw error; }
  }
  return entry;
}

export function findExecutable(name, { configured, env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (!packageNames[name]) throw new Error(`未知客户端：${name}`);
  if (configured !== undefined) {
    if (typeof configured !== 'string' || !path.isAbsolute(configured)) throw new Error(`配置 ${name}Executable 必须是绝对路径`);
    const entry = resolveEntry(configured, name, platform);
    if (!entry) throw new Error(`${name}Executable 不是可运行的入口：${configured}；请选择原生可执行文件或 npm 包的 JavaScript 入口`);
    return entry;
  }
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  const directories = pathValue.split(platform === 'win32' ? ';' : ':').filter(Boolean).map(item => item.replace(/^"(.*)"$/, '$1'));
  directories.push(path.join(home, '.local', 'bin'));
  if (platform === 'darwin') directories.push('/opt/homebrew/bin', '/usr/local/bin');
  if (platform === 'win32' && env.APPDATA) directories.push(path.join(env.APPDATA, 'npm'));
  for (const directory of new Set(directories)) {
    if (!path.isAbsolute(directory)) continue;
    const suffixes = platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1', ''] : [''];
    for (const suffix of suffixes) {
      const entry = resolveEntry(path.join(directory, `${name}${suffix}`), name, platform);
      if (entry) return entry;
    }
  }
  return undefined;
}

export function executableCommand(executable) {
  return /\.[cm]?js$/i.test(executable)
    ? { command: process.execPath, args: [executable] }
    : { command: executable, args: [] };
}

// Configuration reads are side-effect free; the team creates state only when opened.
export function loadConfig(configPath, {
  env = process.env, platform = process.platform, home = homedir(), temporaryRoot = tmpdir(),
  legacyConfigPath = path.join(projectRoot, 'team.config.json'), requireClaude = true,
} = {}) {
  const selectedPath = configPath ?? env.CC_TEAM_CONFIG ?? (existsSync(legacyConfigPath) ? legacyConfigPath : undefined);
  const resolvedPath = selectedPath === undefined ? undefined : path.resolve(selectedPath);
  const stored = resolvedPath ? JSON.parse(readFileSync(resolvedPath, 'utf8')) : {};
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('配置文件必须是 JSON 对象');
  const config = { ...defaultDirectories({ platform, env, home, temporaryRoot }), ...stored };
  for (const [key, variable] of Object.entries({
    stateDir: 'CC_TEAM_STATE_DIR', tempDir: 'CC_TEAM_TEMP_DIR',
    claudeExecutable: 'CC_TEAM_CLAUDE_EXECUTABLE', codexExecutable: 'CC_TEAM_CODEX_EXECUTABLE',
    notificationMode: 'CC_TEAM_NOTIFICATION_MODE',
  })) {
    if (env[variable] !== undefined) config[key] = env[variable];
  }
  for (const key of ['stateDir', 'tempDir']) {
    if (typeof config[key] !== 'string' || !path.isAbsolute(config[key])) throw new Error(`配置 ${key} 必须是绝对路径`);
    config[key] = path.resolve(config[key]);
  }
  config.notificationMode ??= 'poll';
  if (!['poll', 'codex-queue'].includes(config.notificationMode)) throw new Error('notificationMode 必须为 poll 或 codex-queue');
  config.claudeExecutable = findExecutable('claude', { configured: config.claudeExecutable, env, platform, home });
  config.codexExecutable = findExecutable('codex', { configured: config.codexExecutable, env, platform, home });
  if (requireClaude && !config.claudeExecutable) throw new Error('未找到 Claude Code。请先安装并登录 Claude Code，或设置 CC_TEAM_CLAUDE_EXECUTABLE 为其绝对路径；运行 cc-team-mcp doctor 查看环境。');
  if (config.notificationMode === 'codex-queue' && !config.codexExecutable) throw new Error('codex-queue 通知需要 Codex 可执行入口，请设置 codexExecutable 或使用 poll');
  return { ...config, ...(resolvedPath ? { configPath: resolvedPath } : {}) };
}
