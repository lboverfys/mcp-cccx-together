const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
// 由工作者自身设置，provider 不能覆盖。
const RESERVED = new Set(['TEMP', 'TMP', 'TMPDIR', 'DISABLE_AUTOUPDATER', 'PATH']);
const FIELDS = new Set(['env', 'envFrom', 'model', 'description']);

function envMap(value, label, { references = false } = {}) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!ENV_KEY.test(key) || RESERVED.has(key.toUpperCase())) throw new Error(`${label} 含无效或保留的环境变量名：${key}`);
    if (typeof item !== 'string' || (references ? !ENV_KEY.test(item) : item.length > 4000)) {
      throw new Error(references ? `${label}.${key} 必须是来源环境变量名` : `${label}.${key} 必须是字符串`);
    }
    result[key] = item;
  }
  return result;
}

/**
 * 校验 provider 配置。env 写入非机密值（如 ANTHROPIC_BASE_URL）；
 * envFrom 把目标变量映射到 MCP 进程中的来源变量，凭据不必写进配置文件。
 */
export function normalizeProviders(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('providers 必须是对象');
  const providers = {};
  for (const [name, spec] of Object.entries(value)) {
    if (!NAME.test(name)) throw new Error(`provider 名称无效：${name}（字母、数字、下划线和连字符，最多 40 字符）`);
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`provider ${name} 必须是对象`);
    const unknown = Object.keys(spec).filter(key => !FIELDS.has(key));
    if (unknown.length) throw new Error(`provider ${name} 含未知字段：${unknown.join(', ')}`);
    const env = envMap(spec.env, `providers.${name}.env`);
    const envFrom = envMap(spec.envFrom, `providers.${name}.envFrom`, { references: true });
    const duplicated = Object.keys(env).filter(key => Object.hasOwn(envFrom, key));
    if (duplicated.length) throw new Error(`provider ${name} 的 env 与 envFrom 重复设置：${duplicated.join(', ')}`);
    for (const field of ['model', 'description']) {
      if (spec[field] !== undefined && (typeof spec[field] !== 'string' || !spec[field].trim() || spec[field].length > 500)) {
        throw new Error(`provider ${name} 的 ${field} 必须是非空字符串`);
      }
    }
    providers[name] = { env, envFrom, ...(spec.model ? { model: spec.model } : {}),
      ...(spec.description ? { description: spec.description } : {}) };
  }
  return providers;
}

/** 生成工作者进程的 provider 环境变量；来源变量缺失时明确失败，避免静默用错账号或端点。 */
export function providerEnvironment(providers, name, source = process.env) {
  if (!name) return {};
  const provider = providers?.[name];
  if (!provider) throw new Error(`未配置 provider：${name}`);
  const missing = Object.values(provider.envFrom).filter(from => !source[from]);
  if (missing.length) {
    throw new Error(`provider ${name} 需要环境变量 ${[...new Set(missing)].join(', ')}，当前 MCP 进程未设置；请在 MCP 客户端配置中转发（Codex 用 env_vars）`);
  }
  return { ...provider.env, ...Object.fromEntries(Object.entries(provider.envFrom).map(([key, from]) => [key, source[from]])) };
}

/** 给主控看的 provider 列表，不含任何环境变量值。 */
export const providerSummary = providers => Object.entries(providers ?? {}).map(([name, provider]) => ({
  name, ...(provider.model ? { model: provider.model } : {}), ...(provider.description ? { description: provider.description } : {}),
}));

/** 需要由 MCP 客户端转发进来的来源变量名。 */
export const providerSourceVariables = providers => [...new Set(Object.values(providers ?? {})
  .flatMap(provider => Object.values(provider.envFrom)))].sort();
