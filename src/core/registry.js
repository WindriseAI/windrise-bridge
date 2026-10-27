/**
 * 工具注册表 —— 参照学习软件的「一次注册、到处出现」机制。
 *
 * 关键点（与学习软件一致）：
 *   工具不是写死在某个列表里对外广播，而是**运行时集合**：
 *     内置工具 (BUILTIN) ∪ 用户自定义工具 (.bridge/mcp-tools/*) ∪ 外部 MCP 转发的工具
 *   服务器每次收到 tools/list 都重新计算这个并集，所以数量会随挂载情况变化。
 *   这也是「同一个 MCP 地址能有十几、二十几种工具」的根因。
 */

import { createHash } from "node:crypto";
import { readdir, readFile, access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { groupForTool } from "./tool-policy.js";

/** 工具类别：read 只读 / write 写入 / execute 执行 / control 控制面 */
export const Capability = Object.freeze({
  READ: "read",
  WRITE: "write",
  EXECUTE: "execute",
  CONTROL: "control",
});

/**
 * 工具名硬上限 —— 来自本注册表 registerTool 的校验 /^[a-z][a-z0-9_]{2,63}$/。
 * 注意：学习软件没有这个限制（它只把上游工具名截断到 70 字符），
 * 所以「ext__<id>__<工具名>」在长 id / 长工具名时必须再截断一次，见 externalToolName()。
 */
export const TOOL_NAME_LIMIT = 64;
/** 前缀格式与学习软件完全一致：ext__<serverId>__<工具名> */
export const EXTERNAL_TOOL_PREFIX = "ext__";

/** 工具名净化：与学习软件的 safeTool 同规则（小写、非 [a-z0-9_] 换下划线、截断 70）。 */
export function safeToolName(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 70);
}

/**
 * 外部工具对外名：ext__<serverId>__<净化后的上游工具名>（对齐学习软件的 external-mcp-registry.ts）。
 *
 * 与学习软件的唯一偏差：本注册表限制工具名总长 64，学习软件无限制。超出时保留可读前缀并追加
 * 上游名的短指纹，避免截断后两个不同工具变成同一个名字。
 */
export function externalToolName(serverId, upstreamName) {
  let id = safeToolName(serverId) || "server";
  // id 也要挤进 64 字符预算里，过长时同样截断加指纹
  const idBudget = 24;
  if (id.length > idBudget) {
    const digest = createHash("sha1").update(String(serverId)).digest("hex").slice(0, 6);
    id = `${id.slice(0, idBudget - 7)}_${digest}`;
  }
  const budget = TOOL_NAME_LIMIT - EXTERNAL_TOOL_PREFIX.length - id.length - 2;
  let clean = safeToolName(upstreamName) || "tool";
  if (clean.length > budget) {
    const digest = createHash("sha1").update(String(upstreamName)).digest("hex").slice(0, 6);
    clean = `${clean.slice(0, Math.max(1, budget - 7))}_${digest}`;
  }
  return `${EXTERNAL_TOOL_PREFIX}${id}__${clean}`;
}

/**
 * 保留名集合：已经注册在案的本地工具（内置 + 浏览器 + 用户自定义）。
 * 外部 MCP 转发的工具不允许占用这些名字（对齐学习软件的 reserved 集合）。
 */
export function reservedToolNames() {
  const reserved = new Set();
  for (const [name, entry] of registry) {
    if (!String(entry.source ?? "").startsWith("external:")) reserved.add(name);
  }
  return reserved;
}

const registry = new Map();
let watchers = [];

/** 注册一个工具。重复注册同名工具覆盖旧的（热更新友好）。 */
export function registerTool(definition) {
  if (!definition?.name || typeof definition.name !== "string") throw new Error("工具必须有 name");
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(definition.name)) throw new Error(`工具名不合法: ${definition.name}`);
  if (typeof definition.handler !== "function") throw new Error(`${definition.name} 缺少 handler`);
  const inputSchema = definition.inputSchema ?? { type: "object", properties: {}, additionalProperties: true };
  const capability = definition.capability ?? Capability.READ;
  const rawHandler = definition.handler;
  // 只对「严格 schema」（additionalProperties: false）的本地工具在进 handler 前做基础校验。
  // 宽松 schema 的内置文件工具会自己兜底别名（如 find_files 接受 glob 代替 patterns），不能按 required 硬拦；
  // 外部转发的工具由上游自己校验。
  const isExternal = String(definition.source ?? "").startsWith("external:");
  const strict = inputSchema?.additionalProperties === false;
  const handler = isExternal || !strict ? rawHandler : (args, ctx) => {
    const problems = validateArgs(inputSchema, args ?? {});
    if (problems.length) throw new Error(`参数不合法（${definition.name}）：${problems.join("；")}`);
    return rawHandler(args, ctx);
  };
  registry.set(definition.name, {
    title: definition.title ?? definition.name,
    description: definition.description ?? "",
    capability,
    // 工具分组：read / navigate / write / admin。定义里可以显式写，没写就按能力 + 名字推导。
    group: groupForTool({ ...definition, capability }),
    inputSchema,
    annotations: definition.annotations ?? defaultAnnotations(capability),
    // scope: "profile" 表示这个工具的第一个窗口参数要受连接器窗口归属限制；
    // scopeArg 是参数名，默认 id。不带的工具就是全局工具，连接器照常能调。
    scope: definition.scope ?? null,
    scopeArg: definition.scopeArg ?? "id",
    handler,
    source: definition.source ?? "builtin",
  });
  return registry.get(definition.name);
}

/**
 * 按 inputSchema 做顶层参数的基础校验：required 必填、声明了 type 的字段类型、enum 取值。
 * 只校验顶层，不做完整 JSON Schema；返回问题列表，空数组表示通过。
 */
export function validateArgs(schema, args) {
  const problems = [];
  if (!schema || typeof schema !== "object") return problems;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return ["参数必须是对象"];
  for (const key of Array.isArray(schema.required) ? schema.required : []) {
    if (args[key] === undefined || args[key] === null) problems.push(`缺少必填参数 ${key}`);
  }
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const value = args[key];
    if (value === undefined || value === null || !prop || typeof prop !== "object") continue;
    const types = [prop.type].flat().filter(Boolean);
    if (types.length && !types.some((t) => matchesType(t, value))) {
      problems.push(`${key} 应为 ${types.join("/")}`);
      continue;
    }
    if (Array.isArray(prop.enum) && !prop.enum.includes(value)) {
      problems.push(`${key} 只能是 ${prop.enum.join(" / ")}`);
    }
  }
  return problems;
}

function matchesType(type, value) {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return typeof value === "object" && !Array.isArray(value);
    case "null": return value === null;
    default: return true;
  }
}

export function registerTools(definitions) {
  return definitions.map(registerTool);
}

export function unregisterTool(name) {
  return registry.delete(name);
}

export function getTool(name) {
  return registry.get(name);
}

export function listTools() {
  return [...registry.entries()].map(([name, entry]) => {
    const { handler, ...meta } = entry;
    return { name, ...meta };
  });
}

export function toolCount() {
  return registry.size;
}

/**
 * 学习软件用 annotations 告诉客户端「这个工具安全吗」：
 * 只读工具可以被客户端自动批准，写入/执行类必须人工确认。
 * 本作业里保持同一套语义。
 */
function defaultAnnotations(capability) {
  const readOnly = capability === Capability.READ;
  return {
    title: "",
    readOnlyHint: readOnly,
    destructiveHint: capability === Capability.WRITE || capability === Capability.EXECUTE,
    idempotentHint: readOnly,
    openWorldHint: false,
  };
}

/**
 * 重新扫描用户自定义工具目录，把每个 .mjs / .cjs / .js 文件当插件加载。
 * 与学习软件的 `<数据目录>/mcp-tools` 同一个思路：用户往目录里丢文件就多出工具。
 */
export async function reloadCustomTools(dir) {
  const removed = [];
  for (const name of [...registry.keys()]) {
    const entry = registry.get(name);
    if (entry.source === "custom" && !watchers.some(w => w.name === name)) {
      registry.delete(name);
      removed.push(name);
    }
  }
  if (!dir) return { loaded: [], removed };
  await access(dir).catch(() => null);
  const files = await readdir(dir).catch(() => []);
  const loaded = [];
  const fresh = [];
  for (const file of files) {
    if (!/\.(mjs|cjs|js)$/i.test(file)) continue;
    const full = path.join(dir, file);
    try {
      const mod = await import(`${pathToFileURL(full).href}?t=${Date.now()}`);
      const defs = typeof mod.tools === "function" ? await mod.tools() : mod.tools;
      for (const def of Array.isArray(defs) ? defs : [defs]) {
        if (!def) continue;
        const entry = registerTool({ ...def, source: "custom" });
        fresh.push({ name: entry.name });
        loaded.push(entry.name);
      }
    } catch (error) {
      loaded.push(`${file} 加载失败: ${error.message}`);
    }
  }
  watchers = fresh;
  return { loaded, removed };
}

/**
 * 把外部 MCP 服务器上报的工具「挂」到本地表面（代理式转发）。
 *
 * 命名与学习软件一致：ext__<serverId>__<净化工具名>。
 * handler 走 ctx.forward(serverId, upstreamName, args) —— 由宿主注入真正的转发实现；
 * 调用时用的是上游原始工具名，**不从暴露名反推**（学习软件注释：bindings are never guesses from tool names）。
 *
 * 这是给「一次性挂载」用的薄封装；需要连接管理 / 健康状态 / 撞名抑制时用 ExternalMcpManager。
 */
export function adoptExternalTools(serverId, tools, { forward, reserved } = {}) {
  const adopted = [];
  const blocked = [];
  for (const tool of tools) {
    if (!tool?.name) continue;
    const name = externalToolName(serverId, tool.name);
    if (reserved?.has?.(name)) { blocked.push(name); continue; }
    registerTool({
      name,
      title: tool.title ?? tool.name,
      description: `[转发自 ${serverId}] ${tool.description ?? ""}`.trim(),
      capability: Capability.READ,
      inputSchema: tool.inputSchema ?? { type: "object", additionalProperties: true },
      source: `external:${serverId}`,
      handler: async (args, ctx) => {
        const send = ctx?.forward ?? forward;
        if (typeof send !== "function") throw new Error(`外部 MCP 转发通道不可用（${serverId}/${tool.name}）`);
        return send(serverId, tool.name, args, { signal: ctx?.signal });
      },
    });
    adopted.push(name);
  }
  return { adopted, blocked };
}

/** 摘掉某个外部服务器挂上来的全部工具（重连 / 停用 / 卸载时用）。 */
export function unadoptExternalTools(serverId) {
  const removed = [];
  for (const [name, entry] of [...registry]) {
    if (entry.source === `external:${serverId}`) { registry.delete(name); removed.push(name); }
  }
  return removed;
}

/** 当前挂载的外部工具（按来源分组），用于状态展示。 */
export function listExternalTools() {
  const out = [];
  for (const [name, entry] of registry) {
    const source = String(entry.source ?? "");
    if (source.startsWith("external:")) out.push({ name, serverId: source.slice("external:".length), title: entry.title });
  }
  return out;
}

/** 从 `.bridge/mcp-tools` 之外的 json 配置读取工具清单（用于展示，不做执行）。 */
export async function readCustomToolManifest(dir) {
  const manifestPath = path.join(dir, "tools.json");
  const raw = await readFile(manifestPath, "utf8").catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : (parsed.tools ?? []);
  } catch {
    return [];
  }
}
