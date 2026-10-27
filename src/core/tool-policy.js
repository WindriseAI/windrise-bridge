/**
 * 每个客户端一份工具权限（口令作用域）。
 *
 * 借鉴 Pomerium 的 per-tool 策略和 ToolHive 的工具分组 / 参数谓词：
 *   · 工具分四组：read（只读）/ navigate（导航）/ write（写操作）/ admin（命令与配置）；
 *   · 口令可以带作用域：允许的分组、允许的格子 id、允许导航的域名；
 *   · 老口令没有作用域（scope 为 null）—— 调用方按原来的规则走，行为不变；
 *   · 作用域只做「缩小」：全局档位（basic / full）和连接器的窗口归属仍然先判。
 *
 * 本模块只放纯函数，不碰文件、不碰网络，方便单测；口令存储（connectors.js /
 * bearer-auth.js）和网关（bridge.js）各自引用这里的判定。
 */

import path from "node:path";

import { resolveInside } from "./guard.js";

/** 工具分组。组名会写进作用域和审计日志，改名字要同时改老数据，别随便动。 */
export const ToolGroup = Object.freeze({
  READ: "read",
  NAVIGATE: "navigate",
  WRITE: "write",
  ADMIN: "admin",
});

export const TOOL_GROUPS = Object.freeze(Object.values(ToolGroup));

const GROUP_SET = new Set(TOOL_GROUPS);

/**
 * 已有 Capability（read / write / execute / control）到分组的默认映射。
 * control 是桥自己的任务卡 / 进度，不碰系统，按只读处理；
 * execute 默认最危险（admin），浏览器里真正「写页面」的工具在下面显式改成 write。
 */
const CAPABILITY_GROUP = Object.freeze({
  read: ToolGroup.READ,
  write: ToolGroup.WRITE,
  execute: ToolGroup.ADMIN,
  control: ToolGroup.READ,
});

/**
 * 按工具名显式覆盖默认映射。
 * 为什么需要：Capability 只分「会不会改东西」，不够表达「导航」；
 * 而 EXECUTE 里既有 page_act（写页面）也有 run_command（本机命令），风险差一个等级。
 */
export const TOOL_GROUP_OVERRIDES = Object.freeze({
  // 导航：只改变浏览器当前地址 / 打开窗口，不算写页面
  browser_navigate: ToolGroup.NAVIGATE,
  browser_nav: ToolGroup.NAVIGATE,
  browser_open: ToolGroup.NAVIGATE,
  space_open: ToolGroup.NAVIGATE,
  pin_open: ToolGroup.NAVIGATE,

  // 写：会改页面、改窗口状态或改文件
  page_act: ToolGroup.WRITE,
  browser_click: ToolGroup.WRITE,
  browser_type: ToolGroup.WRITE,
  browser_close: ToolGroup.WRITE,
  space_close: ToolGroup.WRITE,
  space_handoff: ToolGroup.WRITE,
  pin_add: ToolGroup.WRITE,
  pin_remove: ToolGroup.WRITE,
  extension_sync: ToolGroup.WRITE,
  windrise_show: ToolGroup.WRITE,

  // 管理：本机命令、提权、配置、可执行的自定义工具
  run_command: ToolGroup.ADMIN,
  admin_run: ToolGroup.ADMIN,
  admin_confirm: ToolGroup.ADMIN,
  send_command_input: ToolGroup.ADMIN,
  cancel_command: ToolGroup.ADMIN,
  configure_mcp: ToolGroup.ADMIN,
  custom_tool_save: ToolGroup.ADMIN,
  custom_tool_remove: ToolGroup.ADMIN,
  windrise_tunnel: ToolGroup.ADMIN,
  windrise_profiles: ToolGroup.ADMIN,
  windrise_folders: ToolGroup.ADMIN,

  // 只读的批量文件操作：子操作只允许 READ，本身不会写文件
  batch_file_tools: ToolGroup.READ,
});

/** 外部 MCP 转发来的工具无法判断它到底做什么，一律按 admin；要放开必须显式给 scope。 */
export function isExternalTool(tool) {
  return String(tool?.source ?? "").startsWith("external:");
}

/**
 * 一个工具属于哪一组。优先级：定义里显式写的 group → 按名字的覆盖表 → 外部工具 → Capability → admin。
 * 永远返回一个合法的组名（未知数据按最危险的 admin 处理）。
 */
export function groupForTool(tool) {
  const definition = typeof tool === "string" ? { name: tool } : (tool ?? {});
  const explicit = String(definition.group ?? "").toLowerCase();
  if (GROUP_SET.has(explicit)) return explicit;
  const name = String(definition.name ?? "");
  if (TOOL_GROUP_OVERRIDES[name]) return TOOL_GROUP_OVERRIDES[name];
  if (isExternalTool(definition)) return ToolGroup.ADMIN;
  const capability = String(definition.capability ?? "").toLowerCase();
  return CAPABILITY_GROUP[capability] ?? ToolGroup.ADMIN;
}

/** 规范化一个域名条目：接受 example.com / *.example.com / https://example.com/path。 */
function normalizeDomain(value) {
  let text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  let wildcard = false;
  if (text.includes("://")) {
    try {
      text = new URL(text).hostname.toLowerCase();
    } catch {
      return null;
    }
  } else {
    text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  }
  text = text.split(/[/?#]/, 1)[0].replace(/:\d+$/, "");
  if (text.startsWith("*.")) {
    wildcard = true;
    text = text.slice(2);
  }
  text = text.replace(/^\.+/, "").replace(/\.+$/, "");
  if (!text || text.length > 253) return null;
  // 只收 ASCII 主机名；IDN 请先转 punycode，避免「看上去像」的域名绕过
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(text)) return null;
  if (text.includes("..")) return null;
  return wildcard ? `*.${text}` : text;
}

function normalizeStringList(value, { max = 64, limit = 64 } = {}) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (!text || text.length > max) continue;
    if (!out.includes(text) && out.length < limit) out.push(text);
  }
  return out;
}

/**
 * 规范化口令作用域。返回 null 表示「没有作用域，按老行为」。
 *
 * 字段语义：
 *   groups   允许的工具分组。数组里没写（字段缺失）＝不限制；写了空数组＝一组都不给。
 *   profiles 允许操作哪些格子（窗口 id）。字段缺失＝不额外限制（连接器仍受窗口归属约束）。
 *   domains  允许导航到的域名。字段缺失＝不检查；给了数组就按数组放行
 *            （空数组表示一个域名都不允许，宁可拦错也不静默放开）。
 */
export function normalizeScope(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const groups = Array.isArray(raw.groups)
    ? [...new Set(raw.groups.map((value) => String(value ?? "").trim().toLowerCase()).filter((value) => GROUP_SET.has(value)))]
    : null;
  const profiles = normalizeStringList(raw.profiles);
  const domains = Array.isArray(raw.domains)
    ? [...new Set(raw.domains.map(normalizeDomain).filter(Boolean))]
    : null;
  const scope = { groups, profiles, domains };
  // 三个字段都缺失 = 空对象，按「没有作用域」处理，免得以后序列化出一堆 null
  if (!scope.groups && !scope.profiles && !scope.domains) return null;
  return scope;
}

/** 深拷贝作用域，避免调用方顺手改到存储里的数组。 */
export function cloneScope(scope) {
  if (!scope) return null;
  return {
    groups: scope.groups ? [...scope.groups] : null,
    profiles: scope.profiles ? [...scope.profiles] : null,
    domains: scope.domains ? [...scope.domains] : null,
  };
}

/** 这个分组在作用域里允许吗。scope 为 null 表示不做分组限制（老口令）。 */
export function scopeAllowsGroup(scope, group) {
  if (!scope) return true;
  if (!scope.groups) return true;
  return scope.groups.includes(group);
}

/** 工具本身在作用域里允许吗（只看分组）。 */
export function scopeAllowsTool(scope, tool) {
  return scopeAllowsGroup(scope, groupForTool(tool));
}

/** 这个格子 id 在作用域里允许吗。scope.profiles 没配置就不额外限制。 */
export function scopeAllowsProfile(scope, profileId) {
  if (!scope || !scope.profiles) return true;
  return scope.profiles.includes(String(profileId ?? "").trim());
}

/** 域名有没有命中允许列表。裸域名默认包含子域名；*.example.com 只匹配子域名。 */
export function domainAllowed(hostname, domains) {
  const host = String(hostname ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  for (const entry of Array.isArray(domains) ? domains : []) {
    if (entry.startsWith("*.")) {
      const base = entry.slice(2);
      if (host.length > base.length + 1 && host.endsWith(`.${base}`)) return true;
    } else if (host === entry || host.endsWith(`.${entry}`)) {
      return true;
    }
  }
  return false;
}

/**
 * 哪些工具的参数里带「要去哪」的地址。域名谓词只查这些工具；
 * page_act 这类按编号操作的工具没有 url 参数，导航结果由页面自己决定。
 */
export const URL_ARG_TOOLS = Object.freeze({
  browser_navigate: "url",
  browser_open: "url",
  space_open: "url",
  pin_add: "url",
});

/** URL 谓词：配置了 domains 才检查；相对地址在没有配置时不管。 */
export function checkUrlAllowed(toolName, args, scope) {
  const argName = URL_ARG_TOOLS[toolName];
  if (!argName || !scope || scope.domains === null) return { ok: true };
  const raw = args?.[argName];
  if (raw === undefined || raw === null || raw === "") return { ok: true };
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return { ok: false, reason: `地址不是合法的绝对 URL：${String(raw).slice(0, 120)}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `只允许 http / https 地址（收到 ${url.protocol}）` };
  }
  if (!scope.domains.length) {
    return { ok: false, reason: "这个口令没有配置任何允许导航的域名" };
  }
  if (!domainAllowed(url.hostname, scope.domains)) {
    return { ok: false, reason: `域名 ${url.hostname} 不在这个口令允许的列表里（${scope.domains.join("、")}）` };
  }
  return { ok: true };
}

/**
 * cwd 谓词：工作目录必须在授权工作区内。
 * 相对路径按第一个工作区解析（和 run_command 的现有语义一致）。
 */
export function checkCwdAllowed(cwd, workspaceRoots) {
  if (cwd === undefined || cwd === null || String(cwd).trim() === "") return { ok: true };
  const roots = (Array.isArray(workspaceRoots) ? workspaceRoots : [])
    .map((root) => String(root ?? "").trim())
    .filter(Boolean);
  if (!roots.length) return { ok: false, reason: "这台机器没有授权任何工作区，不能指定工作目录" };
  const candidate = path.isAbsolute(String(cwd)) ? String(cwd) : path.resolve(roots[0], String(cwd));
  for (const root of roots) {
    if (resolveInside(root, candidate).inside) return { ok: true };
  }
  return { ok: false, reason: `工作目录 ${candidate} 不在授权工作区内（${roots.join("、")}）` };
}

/**
 * 一次调用的参数谓词。只对带作用域的口令生效；老口令完全跳过（向后兼容）。
 * 返回 { ok: true } 或 { ok: false, reason }。
 */
export function checkToolArguments({ tool, args, scope, workspaceRoots, currentCwd = null } = {}) {
  if (!scope) return { ok: true };
  const name = typeof tool === "string" ? tool : String(tool?.name ?? "");
  const urlCheck = checkUrlAllowed(name, args ?? {}, scope);
  if (!urlCheck.ok) return urlCheck;
  if (name === "run_command") {
    // 没写 cwd 时命令会落在终端「上一次的目录」：scoped 口令也要按那个目录判，
    // 否则先在本机 cd 到工作区外，再让远程不带 cwd 调一次就绕过去了。
    const effective = args?.cwd ?? (typeof currentCwd === "function" ? currentCwd() : null);
    return checkCwdAllowed(effective, workspaceRoots);
  }
  return { ok: true };
}

/** 给人看的作用域摘要（拒绝原因、设置页以后都能用）。绝不包含口令。 */
export function describeScope(scope) {
  if (!scope) return "不限制";
  const parts = [];
  parts.push(`分组：${scope.groups ? (scope.groups.length ? scope.groups.join("/") : "无") : "全部"}`);
  if (scope.profiles) parts.push(`格子：${scope.profiles.length ? scope.profiles.join("、") : "无"}`);
  if (scope.domains) parts.push(`域名：${scope.domains.length ? scope.domains.join("、") : "无"}`);
  return parts.join("；");
}
