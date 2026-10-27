/**
 * Bridge 主体 —— 作业要求实现的对外服务面（参照老师留的学习软件）。
 *
 * 对外形状（与学习软件一致）：
 *   POST /mcp/<routeToken>       JSON-RPC：initialize / tools/list / tools/call
 *   GET  /mcp/<routeToken>       SSE 流（服务端推送）
 *   DELETE /mcp/<routeToken>     结束会话
 *   GET  /sse/<口令>             旧式 SSE：建立事件流（只支持 SSE 的客户端用这个，见 handleLegacySse）
 *   POST /messages/<口令>?sessionId=…  旧式 SSE 的收消息端点
 *   GET  /healthz/<routeToken>   健康检查：本机与公网探针都用它
 *   POST/GET/DELETE /mcp         口令入口：请求头 Authorization: Bearer <口令>（2026-10-25，见 bearer-auth.js）
 *   GET  /                      极简状态页（不含任何令牌）
 *
 * 关键设计：
 *   - 令牌错 → 404（连存在性都不暴露），与学习软件同策略；
 *   - 每个客户端会话一个 transport，支持多客户端并发；
 *   - tools/list 每次实时计算并集，所以挂载外部工具后数量立刻变。
 */

import http from "node:http";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { isRemoteRequest, isTunnelRequest, isWellFormedBearerKey } from "./bearer-auth.js";
import { createCallLog, summarizeArgs } from "./call-log.js";
import { actionAudit } from "./action-policy.js";
import { attachToolMeta, countImages, createSessionMetrics, isMetaTool } from "./session-metrics.js";
import { OAuthStore, readAuthorizationBearer } from "./oauth.js";
import { getTool, listTools } from "./registry.js";
import { isWriteLike, isStrictCompatClient, stripUnsupportedKeywords, withWriteSerialNote } from "./mcp-compat.js";
import {
  ToolGroup,
  checkToolArguments,
  describeScope,
  scopeAllowsGroup,
  scopeAllowsProfile,
  scopeAllowsTool,
} from "./tool-policy.js";

/**
 * 对外报的服务器身份：MCP 的 initialize 会把它放进 serverInfo。
 *
 * name 必须是 windrise —— Notion 这类客户端在列表里显示的就是 serverInfo.name，
 * 以前是 "bridge-replica"，连接列表里显示成产品不认识的名字（实测显示成「1」）。
 * title 是给人看的长名字（MCP 2025-06-18 起 Implementation 支持 title），两处一起给。
 */
const SERVER_NAME = "windrise";
const SERVER_TITLE = "Windrise";
const SERVER_VERSION = "0.1.0";
/**
 * initialize 里返回的 serverInfo。本机路径（/mcp/<令牌>）和公网路径（隧道 / 口令入口）走的是同一个
 * createMcpServer，所以两处天然一致；测试直接断言这个常量，别再各写一份。
 */
export const SERVER_INFO = Object.freeze({ name: SERVER_NAME, title: SERVER_TITLE, version: SERVER_VERSION });
const MAX_SESSIONS = 32;
const SESSION_IDLE_MS = 30 * 60 * 1000;
/** 定期回收空闲会话的间隔（unref 定时器，60 秒扫一次就够） */
const PRUNE_INTERVAL_MS = 60 * 1000;
/** 单次工具结果默认上限：超过就落盘换句柄，避免一条几 MB 的返回把客户端 / 隧道拖死 */
const DEFAULT_RESULT_LIMIT_BYTES = 512 * 1024;
/** 结果落盘后先回给客户端的前缀字数（只取 text 部分） */
const RESULT_PREVIEW_CHARS = 4000;
/** 落盘结果保留 1 小时，过了 read_result 就明确报过期 */
const RESULT_TTL_MS = 60 * 60 * 1000;
const READ_RESULT_DEFAULT_LENGTH = 20000;
const READ_RESULT_MAX_LENGTH = 100000;
/** 健康探针单项上限：挂住的外部服务不能把 /healthz 一起拖住 */
const PROBE_TIMEOUT_MS = 3000;
/** stop() 等单个会话收尾 / 关闭 HTTP 服务的上限：超时就继续停，不能把退出流程吊死 */
const STOP_REQUEST_TIMEOUT_MS = 2000;
/** 一个受限连接器最多同时开几个会话；满了只挤掉它自己最老的那个，挤不到主令牌和别的连接器 */
const CONNECTOR_MAX_SESSIONS = 8;

/*
 * 受限连接器（不是主令牌）能看见、能调用哪些工具：默认一个都不给，只放行
 *   - scope 为 "profile" 的窗口工具（再逐次判这个窗口是不是分给它的）；
 *   - browser_profiles（输出按连接器裁剪，见 src/tools/browser.js）；
 *   - read_result（只能读它自己存下的大结果，见 readStoredResult）。
 * 软件控制 windrise_*（状态里带主令牌地址）、run_command、文件、共享上下文、外部 MCP、自定义工具一律不给，
 * 等规划 7.1 的「能否执行命令、读写文件」权限做好再按连接器放开。
 * 2026-10-24 审查：原来只判窗口工具，连接器调一次 windrise_status 就拿到主令牌地址，等于全权。
 */
const CONNECTOR_EXTRA_TOOLS = new Set(["browser_profiles"]);
export function connectorMayUse(tool) {
  return Boolean(tool) && (tool.scope === "profile" || CONNECTOR_EXTRA_TOOLS.has(tool.name));
}

/**
 * 工具档位过滤（只影响 tools/list 和 tools/call 的放行，不影响注册表本身）。
 *   - full：全部放行，和以前一样；
 *   - basic：自带工具 + 自定义工具 + 浏览器适配（BrowserOS）+ 鼠标兜底（Windows MCP）。
 *            其余外接（用户私人接的，比如剪辑、记忆）都不放出来。
 *
 * 严格档：不管外接连没连上，basic 清单都由下面这张名单决定，不会因为某个外接掉线就变样。
 * server id 用关键字匹配，因为不同机器上配置的 id 可能不叫 windows_mcp / browseros_neo。
 */
export const BASIC_TIER_EXTERNAL_KEYS = ["windows", "browseros"];

export function toolVisibleInTier(tool, tier) {
  if (tier !== "basic") return true;
  const source = String(tool?.source ?? "");
  if (!source.startsWith("external:")) return true; // builtin / custom 等自带的
  const serverId = source.slice("external:".length).toLowerCase();
  return BASIC_TIER_EXTERNAL_KEYS.some(key => serverId.includes(key));
}

export const SERVER_INSTRUCTIONS = `You are connected to a local Bridge on this machine. Tool activity is visible to the local user.
- Tools run on the local host. The folders currently open are the default target, not a hard ban.
- Prefer apply_patch over rewriting whole files; serialize edits to the same file.
- File tools (read_files, list_directory, find_files, search_files, apply_patch) only reach the workspace folders the user allowed in Windrise Bridge. For a path outside them, inspect it with run_command (cwd can be an absolute path) before saying it does not exist; if the user needs file edits there, ask them to add that folder in Windrise Bridge → 设置 → 工作区 (takes effect immediately, no reconnect).
- run_command waits for the command by default (timeout_ms, default 120s) and returns status=running with a command_id if still going; use background=true for servers/watchers, then get_command_output with command_id and next_offset.
- Keep the task card updated with set_todos when you take on multi-step work.`;

/**
 * DeepSeek Harness 在 initialize 阶段对 instructions 有硬上限（32,768 字节），
 * 超了整个连接直接失败。这个预留出口（目前全仓库无调用点）一旦有人往 extra 里拼
 * 工具清单就可能超限，所以这里留一道守门：超限就报错，绝不静默发出去。
 */
export const MAX_INSTRUCTIONS_BYTES = 32768;

export function createServerInstructions(extra) {
  const text = extra ? `${SERVER_INSTRUCTIONS}\n\n${extra}` : SERVER_INSTRUCTIONS;
  assertInstructionsWithinLimit(text);
  return text;
}

/** instructions 字节数守门：超限直接抛错（带上字节数），绝不静默发出去。 */
export function assertInstructionsWithinLimit(text) {
  const bytes = Buffer.byteLength(String(text ?? ""), "utf8");
  if (bytes >= MAX_INSTRUCTIONS_BYTES) {
    throw new Error(`instructions 超过客户端硬上限：${bytes} / ${MAX_INSTRUCTIONS_BYTES} 字节（DeepSeek Harness 会连接失败）`);
  }
  return text;
}

/**
 * 旧式 SSE 的路径识别：/sse/<口令> 建流、/messages/<口令> 收消息。
 * 只认出「形如 SSE 端点」的路径，口令是否有效由 matchRoute 用现有规则再判（错口令照样 404）。
 * 返回 null 表示不是这两个端点。
 */
const LEGACY_SSE_PREFIXES = [["/sse/", "sse"], ["/messages/", "sse-messages"]];
function matchLegacySsePath(clean) {
  for (const [prefix, kind] of LEGACY_SSE_PREFIXES) {
    if (!clean.startsWith(prefix)) continue;
    const token = clean.slice(prefix.length);
    // 令牌里不允许再出现分段，避免 /sse/a/b 这类路径被当成合法端点
    if (!token || token.includes("/")) return null;
    return { kind, token };
  }
  return null;
}

/** 会话登记表：/mcp 和旧式 SSE 共用。导出给测试（会话上限 / 定时回收是产品规则，要能单独验证） */
export class SessionRegistry {
  constructor({ maxSessions = MAX_SESSIONS, idleMs = SESSION_IDLE_MS, now = Date.now } = {}) {
    this.sessions = new Map();
    this.max = maxSessions;
    this.idleMs = idleMs;
    /** 当前时间（测试注入假时钟用；生产就是 Date.now） */
    this.now = now;
    /** 定期 prune 的定时器（unref：不拖住进程退出） */
    this.timer = null;
  }
  /**
   * 起一个每 60 秒一次的 prune。
   * 为什么需要：prune 原来只挂在 add() 上，没有新会话进来就永远不回收，
   * 断网 / 睡眠留下的死会话会一直占着上限（SSE 又把这个问题放大了）。
   */
  start(intervalMs = PRUNE_INTERVAL_MS) {
    if (this.timer) return this.timer;
    const ms = Number(intervalMs) > 0 ? Number(intervalMs) : PRUNE_INTERVAL_MS;
    this.timer = setInterval(() => this.prune(), ms);
    this.timer.unref?.();
    return this.timer;
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  add(id, entry) {
    this.prune();
    const byAge = (filter) => [...this.sessions.entries()].filter(([, value]) => filter(value)).sort((a, b) => a[1].lastActivity - b[1].lastActivity);
    const connectorId = entry.connectorId ?? null;
    if (connectorId) {
      // 受限连接器：先按它自己的配额挤，再在总数满时只挤连接器的会话，主令牌的会话一个都不动
      const own = byAge(value => value.connectorId === connectorId);
      if (own.length >= CONNECTOR_MAX_SESSIONS) this.#close(own[0][0]);
      if (this.sessions.size >= this.max) {
        const victim = byAge(value => value.connectorId === connectorId)[0] ?? byAge(value => value.connectorId)[0];
        if (victim) this.#close(victim[0]);
      }
    } else if (this.sessions.size >= this.max) {
      // 主令牌：总数满了先挤连接器的会话，没有再挤主令牌自己最老的
      const victim = byAge(value => value.connectorId)[0] ?? byAge(() => true)[0];
      if (victim) this.#close(victim[0]);
    }
    this.sessions.set(id, entry);
    return entry;
  }
  /** 修复：原来淘汰/过期只是从 Map 里删掉，transport 和 server 没关，长时间运行会泄漏 */
  #close(id) {
    const entry = this.sessions.get(id);
    this.sessions.delete(id);
    /*
     * 旧式 SSE 的 transport 在 connect()（内部才调 start()）之前 _sseResponse 还是空的，
     * 那时 transport.close() 什么也关不掉，会话却已经从表里消失了 —— 这就是「流能收事件、
     * 但每个 POST 都 404」的僵尸会话。这里打上 closed 标记，等它在 connect() 之后自己看到并收摊。
     */
    if (entry) entry.closed = true;
    entry?.transport?.close?.().catch?.(() => {});
    entry?.server?.close?.().catch?.(() => {});
  }
  get(id) { return this.sessions.get(id); }
  touch(id) { const entry = this.sessions.get(id); if (entry) entry.lastActivity = this.now(); }
  /**
   * 「这条会话还活着」的证据只认**写成功**的发消息 / 心跳：连着但已断开（手机休眠、断网但 TCP 没 FIN）
   * 的会话写失败，就不再续命，交给空闲回收。
   */
  touchIfOpen(id) {
    const entry = this.sessions.get(id);
    if (!entry || entry.closed) return false;
    entry.lastActivity = this.now();
    return true;
  }
  delete(id) { this.sessions.delete(id); }
  /** 连接器被删除时用：关掉它名下的会话（transport + server 一起收） */
  close(id) { this.#close(id); }
  prune() {
    const now = this.now();
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastActivity > this.idleMs) this.#close(id);
    }
  }
  get size() { return this.sessions.size; }
}

/** read_result 只读、无副作用，客户端可以自动批准 */
const READ_RESULT_TOOL = {
  name: "read_result",
  title: "读取大结果",
  group: ToolGroup.READ,
  capability: "read",
  description: "分页读取因超出上限而存成句柄的工具结果。参数 handle 来自上一个工具的返回。",
  inputSchema: {
    type: "object",
    properties: {
      handle: { type: "string", description: "结果句柄（工具返回里给出）" },
      offset: { type: "number", description: "从第几个字符开始读，默认 0" },
      length: { type: "number", description: "最多读多少个字符，默认 20000，最大 100000" },
    },
    required: ["handle"],
    additionalProperties: false,
  },
  annotations: { title: "读取大结果", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

/**
 * session_stats 只读、无副作用：按当前 MCP 会话返回调用次数 / 总耗时 / 估算输出 token，
 * 以及输出最多的 5 个工具。它和 read_result 一样由桥自己处理，不进全局注册表。
 */
const SESSION_STATS_TOOL = {
  name: "session_stats",
  title: "会话统计",
  group: ToolGroup.READ,
  description: "查看当前 MCP 会话累计的工具调用次数、总耗时和估算输出 token，以及输出最多的 5 个工具。只读，不含网页内容。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { title: "会话统计", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

/** 环境变量只能在没显式传参时生效；显式参数（测试、调用方）优先。 */
function resolveResultLimit(value) {
  const explicit = Number(value);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const fromEnv = Number(process.env.WINDRISE_RESULT_LIMIT_BYTES);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return DEFAULT_RESULT_LIMIT_BYTES;
}

/** 结果字节数：text 按 UTF-8 算，image 按 base64 字符串长度算（和需求里的口径一致）。 */
function measureContentBytes(content) {
  let total = 0;
  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type === "text") total += Buffer.byteLength(String(part.text ?? ""), "utf8");
    else if (part?.type === "image") total += String(part.data ?? "").length;
  }
  return total;
}

/** 把 content 里所有 text 拼起来；落盘和预览都只认文本部分，图片不参与截断预览。 */
function joinTextParts(content) {
  return (Array.isArray(content) ? content : [])
    .filter(part => part?.type === "text")
    .map(part => String(part.text ?? ""))
    .join("\n");
}

/**
 * 把完整结果写进 <dataHome>/results/<id>.json。
 * 随机 id 只含字母数字和 -，read_result 那边再按同一规则校验，双保险防路径穿越。
 */
async function writeStoredResult(dir, content, structuredContent, owner = "owner") {
  const id = randomUUID();
  await mkdir(dir, { recursive: true });
  // owner：是主令牌还是哪个连接器存的；read_result 只给同一个人读，连接器读不到主令牌的大结果
  await writeFile(path.join(dir, `${id}.json`), JSON.stringify({ owner, content, structuredContent }, null, 2), "utf8");
  // 每次写新文件顺手清掉 1 小时前的旧结果；清不掉不影响这次调用
  await pruneStoredResults(dir);
  return id;
}

/** 只删结果目录里的普通文件，且只删超过 1 小时的；出错静默（下一次写还会再试） */
async function pruneStoredResults(dir) {
  try {
    const names = await readdir(dir);
    const cutoff = Date.now() - RESULT_TTL_MS;
    for (const name of names) {
      const file = path.join(dir, name);
      const info = await stat(file).catch(() => null);
      if (info?.isFile() && info.mtimeMs < cutoff) await unlink(file).catch(() => {});
    }
  } catch {
    // 目录不存在 / 正被占用都无所谓
  }
}

/* ------------------------------------------------------------------ *
 * ④ 远程请求放行检查：每个「不像本机直连」的 MCP 请求进来前，核对
 *    「本机已激活（独立读文件、独立验签，不复用 activation.js / main.cjs 的写法）
 *     且我们的隧道真的通着（tunnelUp 钩子由主进程给）」。
 *    结果缓存 remoteGateTtlMs（默认 90 秒），对请求速度没有影响。
 *    启动期（ready 钩子说「还没就绪」）不缓存、也不判 403，直接回 503 + Retry-After：那时隧道
 *    多半已经起来了、只是还没登记，按「没开隧道」拦会误伤（2026-10-27 的启动期 403）。
 * 这也正是本机 MCP 防绕过（减速带）的落点：带转发痕迹头 / 非本机 Host 的请求，
 * 只有走「已激活的隧道」这条路才放行，其余一律 403 + 中文说明。
 * ------------------------------------------------------------------ */
const GATE_KEY = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: "_QDy5PBkvfYZaI1AW-5rel4DRqET9G5x4HLhkStj-lg" }, format: "jwk" });
let gateMachine = null;
function gateMachineId(dataHome) {
  gateMachine ??= new Promise((resolve) => {
    const done = (guid) => {
      if (guid) return resolve(createHash("sha256").update(`bridge-replica:${guid.toLowerCase()}`).digest("hex").slice(0, 32));
      readFile(path.join(dataHome, "activation.json"), "utf8").then((t) => JSON.parse(t).fallbackId, () => null)
        .then((f) => resolve(f ? createHash("sha256").update(`bridge-replica:${f}`).digest("hex").slice(0, 32) : null), () => resolve(null));
    };
    if (process.platform === "win32") {
      execFile("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { windowsHide: true, timeout: 5000 }, (error, stdout) => done(error ? null : (/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/.exec(String(stdout)) || [])[1]));
    } else if (process.platform === "darwin") {
      execFile("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeout: 5000 }, (error, stdout) => done(error ? null : (/"IOPlatformUUID"\s*=\s*"([0-9a-fA-F-]{36})"/.exec(String(stdout)) || [])[1]));
    } else {
      readFile("/etc/machine-id", "utf8").then((t) => done(t.trim() || null), () => done(null));
    }
  });
  return gateMachine;
}
async function gateCheck(dataHome, { key = GATE_KEY } = {}) {
  let file;
  try { file = JSON.parse(await readFile(path.join(dataHome, "activation.json"), "utf8")); } catch { file = null; }
  const seg = String(file?.token ?? "").split(".");
  if (seg.length !== 3) return "Windrise Bridge 还没有激活，请在软件的「激活」页输入激活码";
  let claims = null;
  try {
    if (verify(null, Buffer.from(`${seg[0]}.${seg[1]}`), key, Buffer.from(seg[2], "base64url"))) claims = JSON.parse(Buffer.from(seg[1], "base64url").toString("utf8"));
  } catch { claims = null; }
  if (!claims || claims.kind !== "license") return "Windrise Bridge 的激活信息无效，请重新输入激活码";
  if (claims.installation_id !== await gateMachineId(dataHome)) return "Windrise Bridge 的激活信息不是这台电脑的";
  const now = Math.max(Date.now(), Number(file.seen) || 0);
  if (claims.exp * 1000 <= now || (claims.entitlement_exp && claims.entitlement_exp * 1000 <= now)) return "Windrise Bridge 激活已到期，请在软件里输入新的激活码";
  return null;
}

/** 导出给自检：bridge ④ 的独立验签（自检可以注入自己的测试公钥；生产路径用内置正式公钥） */
export { gateCheck };

/** 远程请求被拒时的话术（不进任何秘密，也不背激活原因） */
export const LOCAL_ONLY_MESSAGE = "本机 MCP 只给本机程序用。要远程连接请先在 Windrise Bridge 里开通隧道（需要先激活）。";

/**
 * 启动期的话术：桥已经在接请求，但「激活 + 隧道」的状态还没定下来（隧道刚拉起 / 正在注册 / 正在重连）。
 * 这时远程请求是真的从我们的隧道进来的，不能按「没开隧道」拦 403，回 503 + Retry-After 让客户端重试。
 */
export const GATE_STARTING_MESSAGE = "Windrise 正在启动，请 5 秒后重试";
/** 启动期 503 让客户端等几秒（写进 Retry-After） */
export const GATE_STARTING_RETRY_AFTER = "5";

export function createMcpServer({ instructions, forward, beforeListTools, onToolResult, dataHome, resultLimitBytes, connector = null, connectors = null, profileExists = null, toolTier = "basic", ownerAuth = null, keyId = null, oauth = null, workspaceRoots = [], currentCwd = null, sessionMetrics = null } = {}) {
  /** 存下来的大结果归谁：主令牌写 owner，连接器写自己的 id */
  const owner = connector ? connector.id : "owner";
  /** 按会话累计的调用统计；单独建 createMcpServer 时也能自己兜底 */
  const metrics = sessionMetrics ?? createSessionMetrics();
  // 真正的生产出口：不管是 boot 传进来的还是默认常量，超上限都在这里直接失败，
  // 不留一条没人看管的拼接点（DeepSeek Harness 会在 initialize 阶段直接连接失败）。
  const serverInstructions = instructions ?? SERVER_INSTRUCTIONS;
  assertInstructionsWithinLimit(serverInstructions);
  const server = new Server(
    { name: SERVER_NAME, title: SERVER_TITLE, version: SERVER_VERSION },
    {
      capabilities: { tools: { listChanged: true }, logging: {} },
      instructions: serverInstructions,
    },
  );

  const resultsDir = path.join(dataHome || process.env.BRIDGE_DATA_HOME?.trim() || path.join(os.homedir(), ".bridge-replica"), "results");
  const resultLimit = resolveResultLimit(resultLimitBytes);
  const tier = toolTier === "full" ? "full" : "basic";

  /**
   * 当前口令的作用域（每次调用都重新读，设置页改完立即生效）：
   *   · 连接器：连接器记录上的 scope；
   *   · 主口令（Bearer）：那把口令自己的 scope；
   *   · 主路径令牌 / 老口令：null = 没有作用域，完全按原来的规则。
   * 主路径令牌不能带作用域（地址本身就是钥匙），保持老行为。
   */
  const currentScope = () => {
    // OAuth 客户端按授权时选的分组走，和带作用域的口令同一套 tool-policy 判定
    if (oauth) return oauth.scope ?? null;
    if (connector) return connector.scope ?? null;
    if (keyId && typeof ownerAuth?.scopeOf === "function") return ownerAuth.scopeOf(keyId) ?? null;
    return null;
  };

  /** 审计用的口令身份：名字 / 指纹，绝不是口令原文。 */
  const tokenIdentity = () => {
    if (oauth) return { kind: "oauth", name: oauth.clientName, id: oauth.clientId };
    if (connector) return { kind: "connector", name: connector.name, id: connector.id };
    if (keyId) {
      const label = typeof ownerAuth?.labelOf === "function" ? ownerAuth.labelOf(keyId) : null;
      return { kind: "owner-key", name: label || "主口令", id: keyId };
    }
    return { kind: "owner-path", name: "主人（路径令牌）", id: "owner" };
  };

  /**
   * 只判断档位的函数；连接器权限仍在外面单独判（两道过滤取交集）。
   * 档位只看工具自己的来源，和外接是否在线无关。
   */
  const tierGate = () => (tool) => toolVisibleInTier(tool, tier);

  /** 客户端在 initialize 时报的名字和版本；没握手（理论上不会）就是 null */
  const clientInfo = () => {
    try {
      const client = server.getClientVersion?.();
      return client ? { name: client.name, version: client.version ?? null } : null;
    } catch {
      return null;
    }
  };

  /** client 字段：保留 MCP 客户端自报的 name / version，另加口令名字和指纹。 */
  const auditClient = () => ({
    ...(clientInfo() ?? {}),
    tokenKind: tokenIdentity().kind,
    tokenName: tokenIdentity().name,
    tokenId: tokenIdentity().id,
    // OAuth 客户端：审计要求同时记 client_id 和客户端名字（tokenId / tokenName 也各有一份）
    ...(oauth ? { oauthClientId: oauth.clientId, oauthClientName: oauth.clientName } : {}),
  });

  const missingHandle = () => ({
    content: [{ type: "text", text: "句柄不存在或已过期（只保留 1 小时）" }],
    isError: true,
  });

  /** read_result：从落盘结果里按字符偏移取一段，返回总长和下一段 offset */
  const readStoredResult = async (args) => {
    const handle = String(args?.handle ?? "").trim();
    // 只允许字母数字和 -，挡掉 ../ 之类的路径穿越
    if (!/^[A-Za-z0-9-]+$/.test(handle)) return missingHandle();
    const file = path.join(resultsDir, `${handle}.json`);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return missingHandle();
    if (Date.now() - info.mtimeMs > RESULT_TTL_MS) {
      await unlink(file).catch(() => {});
      return missingHandle();
    }
    let stored;
    try { stored = JSON.parse(await readFile(file, "utf8")); }
    catch { return missingHandle(); }
    // 别人存的结果（主令牌的、别的连接器的）一律当成不存在；老文件没有 owner 字段，只给主令牌读
    if ((stored?.owner ?? "owner") !== owner) return missingHandle();

    const text = joinTextParts(stored?.content);
    const askedOffset = Number(args?.offset);
    const offset = Number.isFinite(askedOffset) ? Math.min(Math.max(0, Math.floor(askedOffset)), text.length) : 0;
    const askedLength = Number(args?.length);
    let length = Number.isFinite(askedLength) ? Math.floor(askedLength) : READ_RESULT_DEFAULT_LENGTH;
    if (!Number.isFinite(length) || length <= 0) length = READ_RESULT_DEFAULT_LENGTH;
    length = Math.min(length, READ_RESULT_MAX_LENGTH);

    const chunk = text.slice(offset, offset + length);
    const nextOffset = offset + chunk.length;
    const done = nextOffset >= text.length;
    const hint = done
      ? `（总长 ${text.length} 字；已到末尾）`
      : `（总长 ${text.length} 字；下一段 offset: ${nextOffset}）`;
    return {
      content: [{ type: "text", text: `${chunk}\n\n${hint}` }],
      structuredContent: { handle, offset, length: chunk.length, totalLength: text.length, nextOffset, done },
    };
  };

  /** session_stats：当前 MCP 会话的累计调用统计（不读网页内容） */
  const readSessionStats = (sessionId) => {
    const stats = metrics.stats(sessionId);
    const lines = [`本会话工具调用 ${stats.calls} 次，总耗时 ${stats.total_ms} ms，输出约 ${stats.approx_tokens} tokens（${stats.out_chars} 字）。`];
    if (stats.top_tools.length) {
      lines.push("输出最多的工具：");
      for (const row of stats.top_tools) {
        lines.push(`- ${row.tool}：${row.calls} 次，约 ${row.approx_tokens} tokens，${row.ms} ms`);
      }
    } else {
      lines.push("还没有工具调用。");
    }
    return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: stats };
  };

  // 每次 tools/list 都重新算：内置 ∪ 自定义 ∪ 外部转发。
  // beforeListTools 是「懒刷新」钩子：外部 MCP 的工具清单有 TTL 缓存，平时不花代价，
  // 断线/配置变更后下一次列清单就能自动校正（对齐学习软件的 cachedUntil 语义）。
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (typeof beforeListTools === "function") await beforeListTools().catch(() => {});
    const tierAllows = tierGate();
    const scope = currentScope();
    const allowed = (tool) => {
      if (!tierAllows(tool)) return false;
      // 带作用域的口令：按分组过滤（连接器的窗口归属在调用时另判）
      if (scope) return scopeAllowsTool(scope, tool);
      // 老口令：完全保持原来的连接器 / 档位规则
      return !connector || connectorMayUse(tool);
    };
    /*
     * DeepSeek strict / Kimi / 智谱不认部分 JSON Schema 关键字：只在 tools/list
     * 给它们「兼容视图」，注册表和服务端调用校验仍用原 schema（见 mcp-compat.js）。
     * 写操作类工具统一追加「不要和其他写操作并行调用」，只追加一次。
     * compatSchema 只用于这里的展示视图，绝不参与 tools/call 的校验 / 放行 / 闸门。
     */
    const compatSchema = isStrictCompatClient(clientInfo()?.name);
    const tools = listTools().filter(allowed).map(tool => ({
      name: tool.name,
      title: tool.title,
      description: isWriteLike(tool) ? withWriteSerialNote(tool.description) : tool.description,
      inputSchema: compatSchema ? stripUnsupportedKeywords(tool.inputSchema) : tool.inputSchema,
      annotations: { ...tool.annotations, title: tool.title },
    }));
    // read_result / session_stats 是桥自己的工具，不进全局注册表（避免和用户自定义工具撞名）
    const readResultAllowed = scope ? scopeAllowsGroup(scope, ToolGroup.READ) : true;
    if (readResultAllowed && !tools.some(tool => tool.name === READ_RESULT_TOOL.name)) {
      // read_result 只是读分页结果，不碰磁盘本身的可写状态：不加写操作并行提示（group 显式给 READ）。
      tools.push({
        ...READ_RESULT_TOOL,
        description: isWriteLike(READ_RESULT_TOOL) ? withWriteSerialNote(READ_RESULT_TOOL.description) : READ_RESULT_TOOL.description,
        inputSchema: compatSchema ? stripUnsupportedKeywords(READ_RESULT_TOOL.inputSchema) : READ_RESULT_TOOL.inputSchema,
        annotations: { ...READ_RESULT_TOOL.annotations },
      });
    }
    if (readResultAllowed && !tools.some(tool => tool.name === SESSION_STATS_TOOL.name)) {
      tools.push({ ...SESSION_STATS_TOOL, annotations: { ...SESSION_STATS_TOOL.annotations } });
    }
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, requestExtra) => {
    const name = request.params?.name;
    const args = request.params?.arguments ?? {};
    const startedAt = Date.now();
    const sessionId = requestExtra?.sessionId ?? null;
    const client = auditClient();
    const entry = listTools().find(t => t.name === name);
    const isBridgeTool = name === READ_RESULT_TOOL.name || name === SESSION_STATS_TOOL.name;
    const group = entry?.group ?? (isBridgeTool ? ToolGroup.READ : null);

    /**
     * 统一出口：所有返回都走这里，保证 onToolResult（异步统计 + 调用日志）只记一次。
     * 回调抛错只吞掉，绝不影响工具本身的返回。
     * decision / reason 是这次调用的授权结论：allow 或 deny（带中文原因）。
     *
     * meta 也只在这里加一次：page_* / browser_* 的返回带 action_id / 耗时 / 输出估算；
     * 结构化结果放 structuredContent.meta，只有文本时在末尾补一行 [meta …]。
     */
    const finish = (response, { resultBytes, stored, code, decision = "allow", reason = null } = {}) => {
      let meta = null;
      try {
        // 桥自带工具（read_result / session_stats）不占会话统计：它们不是页面动作，
        // 统计它们只会让 calls / action_id 和真实自动化对不上账。
        if (!isBridgeTool) {
          // 未知工具 / 被拒绝：只记一次调用（错误返回里带着整张工具清单，不能算成「输出」，
          // 更不能拿任意长的假工具名去建明细，否则远端能靠随机名字把内存撑大）
          const detail = decision !== "deny" && Boolean(entry);
          meta = metrics.record({
            sessionId,
            tool: name,
            ms: Date.now() - startedAt,
            text: detail ? joinTextParts(response?.content) : "",
            imageCount: detail ? countImages(response?.content) : 0,
            cached: response?.structuredContent?.cached,
            detail,
          });
          if (isMetaTool(name)) attachToolMeta(response, meta);
        }
      } catch {}
      try {
        onToolResult?.({
          name,
          args,
          result: response,
          failed: Boolean(response?.isError),
          durationMs: Date.now() - startedAt,
          sessionId,
          client,
          // 调用日志里区分「主钥匙」和哪个连接器；主令牌固定写 owner
          connector: connector ? connector.id : "owner",
          group,
          decision,
          reason,
          resultBytes: resultBytes ?? measureContentBytes(response?.content),
          stored: stored ?? null,
          code: code ?? response?.structuredContent?.code ?? null,
          // 只有 page_* / browser_* 的 meta 进调用日志（其他工具照旧，不多写字段）
          meta: isMetaTool(name) ? meta : null,
        });
      } catch {}
      return response;
    };

    /** NOT_ALLOWED 的统一出口：远程 AI 能看到「为什么不行」，审计里也留同样的原因。 */
    const deny = (reason, { code = "NOT_ALLOWED", nextStep = null } = {}) => finish({
      content: [{ type: "text", text: `${code}：${reason}${nextStep ? `\n下一步：${nextStep}` : ""}` }],
      structuredContent: { code, reason, retryable: false, ...(group ? { group } : {}), ...(nextStep ? { next_step: nextStep } : {}) },
      isError: true,
    }, { code, decision: "deny", reason });

    const tierAllows = tierGate();
    const scope = currentScope();
    const allowed = (tool) => {
      if (!tierAllows(tool)) return false;
      if (scope) return scopeAllowsTool(scope, tool);
      return !connector || connectorMayUse(tool);
    };
    const visible = () => listTools().filter(allowed).map(tool => tool.name)
      .concat(scope && !scopeAllowsGroup(scope, ToolGroup.READ) ? [] : [READ_RESULT_TOOL.name, SESSION_STATS_TOOL.name]);
    // 基础档藏起来的工具和「不存在」一样处理：不能靠猜名字绕过 tools/list
    const allowedByTier = entry ? tierAllows(entry) : false;

    // 带作用域的口令：先按分组判；不允许的工具直接 NOT_ALLOWED（带原因）
    if (scope && !isBridgeTool) {
      if (!entry || !allowedByTier) {
        return finish({
          content: [{ type: "text", text: `未知工具：${name}。可用工具：${visible().join(", ")}` }],
          isError: true,
        }, { decision: "deny", reason: "未知工具" });
      }
      if (!scopeAllowsTool(scope, entry)) {
        const reason = `这个口令（${tokenIdentity().name}）没有 ${group ?? "该"} 分组的权限，不能用 ${name}。口令作用域：${describeScope(scope)}`;
        return deny(reason, { nextStep: "需要这个能力请在 Windrise 设置里给口令增加分组，或换一个有权限的口令" });
      }
    } else if (connector && !isBridgeTool && (!allowedByTier || !connectorMayUse(entry))) {
      // 老连接器（没有作用域）：不在放行清单里的工具和不存在的工具一样处理，连「有这个工具」都不告诉它
      const nextStep = "这把钥匙只能操作分给它的浏览器窗口；需要别的能力请用户在 Windrise 设置里处理";
      return finish({
        content: [{ type: "text", text: `NOT_ALLOWED：这个连接器（${connector.name}）不能用 ${name}。${nextStep}。能用的工具：${visible().join(", ")}` }],
        structuredContent: {
          code: "NOT_ALLOWED",
          reason: `连接器（${connector.name}）只能使用分给它的窗口工具，不能用 ${name}`,
          retryable: false,
          next_step: nextStep,
        },
        isError: true,
      }, { code: "NOT_ALLOWED", decision: "deny", reason: `连接器（${connector.name}）没有 ${name} 的窗口权限` });
    }
    if ((!entry || !allowedByTier) && !isBridgeTool) {
      return finish({
        content: [{ type: "text", text: `未知工具：${name}。可用工具：${visible().join(", ")}` }],
        isError: true,
      }, { decision: "deny", reason: "未知工具" });
    }

    // read_result 由桥自己处理：不走注册表，也不做「结果太大再落盘」，否则会句柄套句柄
    if (name === READ_RESULT_TOOL.name) {
      if (scope && !scopeAllowsGroup(scope, ToolGroup.READ)) {
        return deny(`这个口令（${tokenIdentity().name}）没有 read 分组的权限，不能读大结果。口令作用域：${describeScope(scope)}`);
      }
      return finish(await readStoredResult(args));
    }

    // session_stats 同样由桥自己处理：统计的是当前 MCP 会话，不读页面内容
    if (name === SESSION_STATS_TOOL.name) {
      if (scope && !scopeAllowsGroup(scope, ToolGroup.READ)) {
        return deny(`这个口令（${tokenIdentity().name}）没有 read 分组的权限，不能看会话统计。口令作用域：${describeScope(scope)}`);
      }
      return finish(readSessionStats(sessionId));
    }

    try {
      const tool = getTool(name);

      /*
       * 连接器越权：工具声明了 scope: "profile" 时，args 里的窗口 id 必须在它的 profiles 里。
       * 带作用域的口令还要再受 scope.profiles 限制（连接器要两边都允许，直接拒绝，不再排队等批准）；
       * 老连接器保持原样：先排进待批准列表，人批准后才可用。
       * 窗口 id 缺失时交给工具自己报错（照常调 handler）。
       */
      if (tool.scope === "profile") {
        const scopeArg = tool.scopeArg ?? "id";
        const profileId = String(args?.[scopeArg] ?? "").trim();
        if (profileId && scope) {
          if (!scopeAllowsProfile(scope, profileId)) {
            return deny(`窗口 ${profileId.slice(0, 64)} 不在这个口令允许的格子里。口令作用域：${describeScope(scope)}`, {
              nextStep: "用 browser_profiles 看有哪些格子；要换格子请在 Windrise 设置里改口令作用域",
            });
          }
          if (connector && !connectors?.canUse?.(connector, profileId)) {
            return deny(`窗口 ${profileId.slice(0, 64)} 没分给这个连接器（${connector.name}），不能操作。`, {
              nextStep: "用 browser_profiles 看分给你的窗口，或请人在 Windrise 设置里把格子分给这个连接器",
            });
          }
        } else if (profileId && connector) {
          // 老连接器：保持原来的「越权先申请、人批准」流程
          if (!connectors?.canUse?.(connector, profileId)) {
            const yours = (connector.profiles ?? []).length ? connector.profiles.join("、") : "目前没有";
            // 窗口 id 是远端 AI 填的：先确认这台电脑上真有这个窗口再排队，不然随便编一串就能刷待批准和系统通知。
            // 查不了（没接浏览器）就按不存在处理，不排队。
            const exists = typeof profileExists === "function" ? await Promise.resolve(profileExists(profileId)).catch(() => false) : false;
            if (!exists) {
              const nextStep = "用 browser_profiles 看有哪些窗口、哪些分给了你";
              return finish({
                content: [{ type: "text", text: `INVALID_ARGUMENT：没有 id 为 ${profileId.slice(0, 64)} 的浏览器窗口。${nextStep}。分给你的窗口：${yours}` }],
                structuredContent: { code: "INVALID_ARGUMENT", retryable: false, next_step: nextStep },
                isError: true,
              }, { code: "INVALID_ARGUMENT", decision: "deny", reason: `窗口 ${profileId.slice(0, 64)} 不存在` });
            }
            const requested = connectors?.requestApproval?.({ connectorId: connector.id, profileId, tool: name });
            if (requested?.limited) {
              const nextStep = `待批准已经排了 ${requested.max} 条，先等人处理完再申请`;
              return finish({
                content: [{ type: "text", text: `NEEDS_APPROVAL：窗口 ${profileId} 没分给这个连接器（${connector.name}）。${nextStep}。分给你的窗口：${yours}` }],
                structuredContent: { code: "NEEDS_APPROVAL", reason: "queue_full", retryable: false, next_step: nextStep, approvalId: null, profile: profileId },
                isError: true,
              }, { code: "NEEDS_APPROVAL", decision: "deny", reason: "待批准队列已满" });
            }
            if (requested?.denied) {
              const nextStep = "人拒绝了，换一个分给你的窗口，或者请人在 Windrise 设置里把窗口分给你";
              return finish({
                content: [{ type: "text", text: `NEEDS_APPROVAL：窗口 ${profileId} 没分给这个连接器（${connector.name}）。${nextStep}。分给你的窗口：${yours}` }],
                structuredContent: { code: "NEEDS_APPROVAL", reason: "denied", retryable: false, next_step: nextStep, approvalId: null, profile: profileId },
                isError: true,
              }, { code: "NEEDS_APPROVAL", decision: "deny", reason: "用户拒绝过这个窗口" });
            }
            const nextStep = "已经请人在 Windrise 里批准；批准后用同样的参数再调一次";
            return finish({
              content: [{ type: "text", text: `NEEDS_APPROVAL：窗口 ${profileId} 没分给这个连接器（${connector.name}）。${nextStep}。分给你的窗口：${yours}` }],
              structuredContent: { code: "NEEDS_APPROVAL", reason: "space", retryable: true, next_step: nextStep, approvalId: requested?.id ?? null, profile: profileId },
              isError: true,
            }, { code: "NEEDS_APPROVAL", decision: "deny", reason: `窗口 ${profileId.slice(0, 64)} 还没分给这个连接器` });
          }
        }
      }

      /*
       * 参数谓词（只对带作用域的口令生效，老口令完全跳过）：
       *   · browser_navigate / browser_open / space_open / pin_add 的 url 域名；
       *   · run_command 的 cwd 必须在授权工作区内。
       */
      const argsCheck = checkToolArguments({ tool: name, args, scope, workspaceRoots, currentCwd });
      if (!argsCheck.ok) {
        return deny(argsCheck.reason, { nextStep: "换一个允许的地址或工作目录再试；需要放开请让用户改口令作用域" });
      }

      // forward 是外部 MCP 转发通道：外部工具拿到它就能把调用送到真正的上游服务器，
      // 这样「本地工具」和「转发的工具」在协议层是同一类东西。
      const connectorContext = connector
        ? { id: connector.id, name: connector.name, profiles: [...(connector.profiles ?? [])] }
        : null;
      const result = await tool.handler(args, { signal: requestExtra?.signal, sessionId: requestExtra?.sessionId, forward: forward ?? null, connector: connectorContext });
      const content = result.content ?? [{ type: "text", text: String(result.text ?? "") }];
      const resultBytes = measureContentBytes(content);
      const code = result.structuredContent?.code ?? null;

      // 正常结果：原样返回
      if (resultBytes <= resultLimit) {
        return finish({
          content,
          structuredContent: result.structuredContent,
          isError: Boolean(result.isError),
        }, { resultBytes, code });
      }

      /*
       * 超限：完整结果落盘，客户端只拿句柄 + 前 4000 字。
       * 落盘失败就按原样返回 —— 宁可回一个大结果，也不能让工具调用失败。
       */
      const text = joinTextParts(content);
      const imageCount = content.filter(part => part?.type === "image").length;
      let handle;
      try {
        handle = await writeStoredResult(resultsDir, content, result.structuredContent, owner);
      } catch (error) {
        console.warn(`[bridge] 结果过大但存文件失败，按原样返回：${error.message}`);
        return finish({
          content,
          structuredContent: result.structuredContent,
          isError: Boolean(result.isError),
        }, { resultBytes, code });
      }

      const notice = `结果太大（约 ${Math.max(1, Math.round(resultBytes / 1024))} KB），已存成句柄 ${handle}。前 4000 字如下；要看后面用 read_result 分段读。`;
      const imageNote = imageCount ? `\n\n（${imageCount} 张图片未返回，完整内容已存成句柄 ${handle}。）` : "";
      return finish({
        content: [{ type: "text", text: `${notice}\n\n${text.slice(0, RESULT_PREVIEW_CHARS)}${imageNote}` }],
        structuredContent: { truncated: true, handle, totalBytes: resultBytes, textLength: text.length },
        isError: Boolean(result.isError),
      }, { resultBytes, stored: handle, code });
    } catch (error) {
      return finish({
        content: [{ type: "text", text: `工具 ${name} 执行失败：${error.message}` }],
        isError: true,
      });
    }
  });

  return server;
}


export class BridgeServer {
  constructor({ routeToken, host = "127.0.0.1", port = 0, onActivity = () => {}, instructions, jsonResponse = true, sseKeepAliveMs, forward, beforeListTools, onPortFallback, dataHome, healthProbes, startupGraceMs = 30000, resultLimitBytes, connectors = null, profileExists = null, ownerAuth = null, toolTier = "basic", oauth = null, remoteGate = null, remoteGateTtlMs = 90_000, workspaceRoots = [], currentCwd = null } = {}) {
    if (!routeToken) throw new Error("BridgeServer 需要 routeToken");
    // 启动前就把超长 instructions 挡掉：宁可起不来，也不要让客户端在 initialize 阶段连接失败。
    if (instructions !== undefined && instructions !== null) assertInstructionsWithinLimit(instructions);
    this.routeToken = routeToken;
    /**
     * 本机 MCP 防绕过 + 远程请求放行（④）。不传 = 纯本机桥（standalone / 自测），行为与从前完全一样。
     * 传入时：
     *   ready    由调用方（Electron 主进程）给出「激活 + 隧道的状态已经定下来了吗」。未就绪时远程请求回
     *            503 + Retry-After，不判 403（启动初期隧道还没登记，这时 403 是误判）。
     *   tunnelUp 由调用方给出「我们的隧道现在通着吗」。
     * 「不像本机直连」的请求（isRemoteRequest）进来时：
     *   0. 未就绪 → 503 + Retry-After（不缓存）；
     *   1. 独立验 activation.json：没激活 / 到期 / 被改 / 不是本机 → 403 + 中文原因（带购买与激活指引）；
     *   2. 激活有效但我们的隧道没通（别人自己起的转发）→ 403 LOCAL_ONLY_MESSAGE。
     */
    this.remoteGate = remoteGate && typeof remoteGate === "object" ? { ...remoteGate } : null;
    this.remoteGateTtlMs = Number.isFinite(Number(remoteGateTtlMs)) ? Math.max(0, Number(remoteGateTtlMs)) : 90_000;
    /** ④ 的缓存：检查本身出异常按「不放行」处理 */
    this.gate = { at: 0, error: null, pending: null };
    /** 连接器存储。不传时和以前完全一样：只有主令牌。 */
    this.connectors = connectors;
    /** 「这个窗口 id 在这台电脑上存在吗」：连接器越权申请排队前用，防止随便编 id 刷待批准（主进程传进来） */
    this.profileExists = profileExists;
    this.connectorRemovalHandler = (id) => {
      for (const [sessionId, entry] of [...this.sessions.sessions]) {
        if (entry.connectorId === id) this.sessions.close(sessionId);
      }
    };
    this.connectors?.on?.("removed", this.connectorRemovalHandler);
    // 连接器切了鉴权方式（换口令 / 切回路径）：旧会话一律断开，客户端用新凭据重连
    this.connectors?.on?.("auth-changed", this.connectorRemovalHandler);
    /** 主身份的口令和路径开关（OwnerAuthStore）。不传时没有主口令入口，主路径令牌照旧。 */
    this.ownerAuth = ownerAuth;
    this.host = host;
    this.port = port;
    this.onActivity = onActivity;
    this.instructions = instructions;
    /** 工具档位：basic（默认，只放自带 / 自定义 / 鼠标兜底）| full（全部） */
    this.toolTier = toolTier === "full" ? "full" : "basic";
    /**
     * 授权工作区（文件工具 / run_command cwd 的边界）。
     * 传进来的是 guard.roots 这个活数组：设置页改工作区时原地更新，这里不用重启。
     */
    this.workspaceRoots = Array.isArray(workspaceRoots) ? workspaceRoots : [];
    /** ???????run_command ?? cwd ????scoped ???????? */
    this.currentCwd = typeof currentCwd === "function" ? currentCwd : null;
    this.jsonResponse = jsonResponse;
    /** SSE 心跳间隔；不传 / 非正数就用 SDK 默认的 15 秒（自测会调小，不然等不起） */
    this.sseKeepAliveMs = sseKeepAliveMs;
    this.forward = forward;
    this.beforeListTools = beforeListTools;
    this.onPortFallback = onPortFallback;
    this.sessions = new SessionRegistry();
    /** 按 MCP 会话累计的工具调用统计（耗时 / 输出 token），session_stats 与日志摘要共用 */
    this.sessionMetrics = createSessionMetrics();
    this.startedAt = null;
    this.stats = { calls: 0, failures: 0, durations: [], staleSessions: 0, lastRequestAt: 0, lastTunnelRequestAt: 0 };
    this.httpServer = null;
    /** 配置的端口被占用时记下原值，界面据此提示「你想用的端口没抢到」 */
    this.portWasTaken = null;
    this.dataHome = dataHome || process.env.BRIDGE_DATA_HOME?.trim() || path.join(os.homedir(), ".bridge-replica");
    /** 外部依赖的探针（隧道 / 外部 MCP / 浏览器控制），健康检查时逐个跑，单个挂住最多等 3 秒 */
    this.healthProbes = Array.isArray(healthProbes) ? healthProbes : [];
    this.startupGraceMs = Number.isFinite(Number(startupGraceMs)) ? Number(startupGraceMs) : 30000;
    this.resultLimitBytes = resultLimitBytes;
    this.callLog = createCallLog({ dir: path.join(this.dataHome, "logs") });
    /*
     * 隧道 OAuth（默认关闭）：只有调用方明确 enabled 才建状态、挂端点。
     * 状态文件 <dataHome>/oauth.json 只存客户端元数据和令牌哈希。
     */
    this.oauth = oauth?.enabled === true
      ? new OAuthStore({ file: oauth.file || path.join(this.dataHome, "oauth.json"), ...oauth })
      : null;
  }

  get localUrl() {
    const port = this.address()?.port ?? this.port;
    return port ? `http://127.0.0.1:${port}/mcp/${this.routeToken}` : null;
  }

  /**
   * ④ 的「就绪」判定：调用方（主进程）给 ready 钩子，回答「隧道 + 激活的状态已经定下来了吗」。
   * 不给钩子（命令行 / 自测）= 一直就绪，行为和从前一样。
   * 钩子自己抛错时按就绪处理：那是调用方的 bug，不能把远程访问永久卡在 503 上。
   */
  remoteGateReady() {
    const ready = this.remoteGate?.ready;
    if (typeof ready !== "function") return true;
    try { return Boolean(ready()); } catch { return true; }
  }

  /**
   * 隧道 / 激活状态变了之后调用：丢掉缓存，下一个远程请求重新判。
   * 不丢的话，启动期算出来的结论会一直挂到 remoteGateTtlMs（默认 90 秒）过期 ——
   * 2026-10-27 的 bug 就是「隧道已经通了，远程请求还在吃启动那一刻的 403」。
   */
  resetRemoteGate() {
    Object.assign(this.gate, { at: 0, error: null, pending: null });
  }

  /**
   * ④ 远程请求放行检查。
   *   未就绪（启动 / 隧道正在注册 / 正在重连）→ 503 + Retry-After，不缓存，客户端 5 秒后重试；
   *   已就绪 → 独立验激活 + 问隧道通没通：拦下时 403 + 中文原因（结果缓存 remoteGateTtlMs）。
   */
  async remoteGateError() {
    if (!this.remoteGate) return null;
    if (!this.remoteGateReady()) return { status: 503, message: GATE_STARTING_MESSAGE, retryAfter: GATE_STARTING_RETRY_AFTER };
    const ttl = this.remoteGateTtlMs;
    if (ttl > 0 && Date.now() - this.gate.at < ttl) return this.gate.error;
    const dataHome = this.dataHome;
    const tunnelUp = this.remoteGate.tunnelUp;
    // check 是自检用的注入口：不传就用桥自己内置公钥的 gateCheck（生产路径）
    const check = typeof this.remoteGate.check === "function" ? this.remoteGate.check : (home) => gateCheck(home);
    this.gate.pending ??= (async () => {
      const sealed = await check(dataHome).catch(() => "Windrise Bridge 激活检查失败");
      if (sealed) return `${sealed}。隧道需要激活：在软件的「激活」页输入激活码；购买入口（支付宝下单）即将在软件内上线。`;
      let up = false;
      try { up = typeof tunnelUp === "function" ? Boolean(await tunnelUp()) : false; } catch { up = false; }
      if (!up) return LOCAL_ONLY_MESSAGE;
      return null;
    })().then((message) => {
      const error = message ? { status: 403, message } : null;
      Object.assign(this.gate, { at: Date.now(), error, pending: null });
      if (error) this.onActivity({ kind: "license-blocked", reason: error.message, at: Date.now() });
      return error;
    });
    return this.gate.pending;
  }

  healthUrl(port = this.address()?.port ?? this.port) {
    return `http://127.0.0.1:${port}/healthz/${this.routeToken}`;
  }

  address() {
    const address = this.httpServer?.address();
    return typeof address === "object" && address ? address : null;
  }

  async start() {
    this.httpServer = http.createServer((req, res) => { void this.handle(req, res); });
    /*
     * cloudflared 对源站的空闲连接最多留 90 秒，Node 默认 5 秒就关；
     * 隧道复用到刚被关掉的连接会偶发 502。headersTimeout 必须比 keepAliveTimeout 大。
     */
    this.httpServer.keepAliveTimeout = 120_000;
    this.httpServer.headersTimeout = 125_000;

    const listen = (port) => new Promise((resolve, reject) => {
      const onError = (error) => { this.httpServer.off("listening", onListening); reject(error); };
      const onListening = () => { this.httpServer.off("error", onError); resolve(); };
      this.httpServer.once("error", onError);
      this.httpServer.once("listening", onListening);
      this.httpServer.listen(port, this.host);
    });

    try {
      await listen(this.port);
    } catch (error) {
      /*
       * 固定端口被占用时**退回随机端口**，而不是让整个桥起不来。
       *
       * 为什么：固定端口只是「方便接命名隧道」的手段，不是目的。
       * 用户开两个实例、或者别的程序占了 48272，都不该导致应用直接不可用。
       * 退回随机端口后功能全在，只是隧道指不到 —— 这个由日志明确告知。
       */
      if (error.code !== "EADDRINUSE" || this.port === 0) throw error;
      const taken = this.port;
      await listen(0);
      const actual = this.address()?.port ?? 0;
      this.portWasTaken = taken;
      this.port = actual; // 后续 localUrl / healthUrl 都用实际端口，别再用那个没抢到的
      if (typeof this.onPortFallback === "function") this.onPortFallback(taken, actual);
    }

    this.startedAt = Date.now();
    /*
     * 空闲会话回收不能再只靠「有新会话进来」：客户端断网 / 睡眠时 TCP 不会立刻断（没有 FIN），
     * 会话和那条 res 就一直挂着；没有新会话就永远不回收，攒到上限后会把还在用的挤掉。
     * 这里起一个 unref 的定时器定期 prune（不拖住进程退出），stop() 里清掉。
     */
    this.sessions?.start?.();
    return this.address();
  }

  async stop() {
    this.sessions?.stop?.();
    this.connectors?.off?.("removed", this.connectorRemovalHandler);
    this.connectors?.off?.("auth-changed", this.connectorRemovalHandler);
    const TIMED_OUT = Symbol("stop-timeout");
    /** 等 promise 结束，但最多等 timeoutMs；超时返回 TIMED_OUT，调用方继续往下走 */
    const waitAtMost = (promise, timeoutMs) => new Promise((resolve) => {
      const timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      timer.unref?.();
      const settle = () => { clearTimeout(timer); resolve(null); };
      Promise.resolve(promise).then(settle, settle);
    });
    const closed = [];
    for (const [sessionId, entry] of this.sessions.sessions) {
      // transport.close() 只是把 SSE 流标记关闭；真正把响应 / 句柄收掉要等对应的 handleRequest 返回，
      // 所以这里把它等出来（transport 自己也会在收尾时再调一次 close，重复调用是幂等的）。
      // 但不能无限等：隧道半开、客户端不读 body 时这个 promise 可能一直不 resolve，
      // 托盘「停止 Bridge」和退出流程就会卡死。每个会话最多等 STOP_REQUEST_TIMEOUT_MS。
      const done = Promise.resolve(entry.transport.close()).catch(() => {});
      const waited = entry.requestDone ? done.then(() => entry.requestDone.catch(() => {})) : done;
      closed.push(waitAtMost(waited, STOP_REQUEST_TIMEOUT_MS).then((outcome) => {
        if (outcome === TIMED_OUT) console.warn(`[bridge] 会话 ${String(sessionId).slice(0, 8)} 收尾超时，继续停止`);
      }));
    }
    this.sessions.sessions.clear();
    await Promise.all(closed);
    /*
     * 幂等：httpServer 已经关掉之后再停一次，close() 的回调不会触发（Node 会直接报 ERR_SERVER_NOT_RUNNING），
     * 原来那个 Promise 就永远不 resolve。裸路径（命令行 / 测试收尾）可能被调两次，这里必须自己处理好。
     */
    const httpServer = this.httpServer;
    this.httpServer = null;
    if (!httpServer) return;
    // closeAllConnections 先断掉残留连接；close() 也要收尾上限，超时再强制断开一次，别把退出流程吊死
    if (typeof httpServer.closeAllConnections === "function") httpServer.closeAllConnections();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        console.warn("[bridge] 关闭 HTTP 服务超时，强制断开残留连接");
        httpServer.closeAllConnections?.();
        resolve();
      }, STOP_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      httpServer.close(() => { clearTimeout(timer); resolve(); });
    });
  }

  /**
   * 令牌核对：直接比较完整路径，错误令牌一律 404。
   * 连接器令牌含 base64url 字符（- _），不能拼进 RegExp；这里全用字符串比较。
   */
  matchRoute(pathname, headers = {}, req = null) {
    const clean = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
    /*
     * 口令入口：路径就是 /mcp，身份全看 Authorization 头。
     *   · 老口令（wrb_）：主口令 / 连接器口令，和以前完全一样；错口令仍然 404；
     *   · OAuth 令牌（wro_）：校验哈希、过期、吊销和 audience；
     *   · 什么都没带且开了 OAuth：回 401 + WWW-Authenticate，让客户端去发现 PRM。
     * 老路径（/mcp/<令牌>）不经过这里，行为不变。
     */
    if (clean === "/mcp") {
      const raw = readAuthorizationBearer(headers);
      if (raw !== null) {
        const key = isWellFormedBearerKey(raw) ? raw : null;
        if (key) {
          // 主口令可以有多把：记下对上的是哪一把，会话绑定它，作废时只断这一把的会话
          const keyId = this.ownerAuth?.matches(key) ?? null;
          if (keyId) return { kind: "mcp", connector: null, via: "bearer", keyId };
          const connector = this.connectors?.findByBearer?.(key) ?? null;
          if (connector) return { kind: "mcp", connector, via: "bearer" };
          return null;
        }
        if (this.oauth?.isAccessToken(raw)) {
          const checked = this.oauth.authenticate(raw, this.oauth.audienceFor(req));
          if (checked.ok) return { kind: "mcp", connector: null, via: "oauth", oauth: checked.token };
          return { kind: "oauth-error", error: checked.error, description: checked.description };
        }
        // 不像任何一种已知凭据：保持老行为，当没这条路
        return null;
      }
      return this.oauth ? { kind: "oauth-challenge" } : null;
    }
    if (clean === `/mcp/${this.routeToken}`) {
      // 主路径令牌可以对公网关掉（本机直连照常，见 bearer-auth.js 开头的说明）
      if (this.ownerAuth && !this.ownerAuth.pathEnabled() && isTunnelRequest(headers)) return null;
      return { kind: "mcp", connector: null, via: "path", token: this.routeToken };
    }
    /*
     * 旧式 SSE 的两个端点。口令规则和 /mcp/<口令> 完全一致：
     *   · /sse/<主路径令牌>            → 主身份（via: path）
     *   · /sse/<连接器令牌>            → 该连接器（via: path）
     *   · 错口令 / 开关关掉的主路径令牌 → null，落到上面的 404（不暴露端点存在）
     * /messages/<口令> 用同一套口令，sessionId 在查询串里。
     *
     * 命中的口令要带回 route（route.token）：SSE 的 endpoint 事件必须让它 POST 回**自己那把**口令的
     * /messages 地址。写死主路径令牌会让连接器场景 404，还把主口令明文交给受限客户端。
     */
    const legacy = matchLegacySsePath(clean);
    if (legacy) {
      const token = legacy.token;
      if (token === this.routeToken) {
        if (this.ownerAuth && !this.ownerAuth.pathEnabled() && isTunnelRequest(headers)) return null;
        return { kind: legacy.kind, connector: null, via: "path", token };
      }
      if (this.connectors && token && !token.includes("/")) {
        const connector = this.connectors.findByToken(token);
        if (connector && connector.token !== this.routeToken) return { kind: legacy.kind, connector, via: "path", token };
      }
      return null;
    }
    // /healthz 只认主令牌：连接器的钥匙能开窗，但不该能探整个桥的状态
    if (clean === `/healthz/${this.routeToken}`) return { kind: "health", connector: null };
    if (this.connectors) {
      const prefix = "/mcp/";
      if (clean.startsWith(prefix)) {
        const token = clean.slice(prefix.length);
        if (token && !token.includes("/")) {
          // findByToken 已经跳过切到口令模式的连接器
          const connector = this.connectors.findByToken(token);
          // 和主令牌一样的连接器令牌（手改文件改出来的）一律不认
          if (connector && connector.token !== this.routeToken) return { kind: "mcp", connector, via: "path", token };
        }
      }
    }
    return null;
  }

  /**
   * 主口令或主路径开关变了之后调用：断开已经失效的主身份会话。
   *   · 口令入口开的主会话：它用的那把口令已经不在（被换 / 被撤）就断开，别的口令的会话不动；
   *   · 路径入口对公网关掉时，经隧道开的主路径会话也断开。
   * 每个请求进来本来就会重新核对凭据，这里只是让旧会话立刻收尾，不等 30 分钟空闲回收。
   */
  ownerAuthChanged() {
    const pathOpen = !this.ownerAuth || this.ownerAuth.pathEnabled();
    for (const [sessionId, entry] of [...this.sessions.sessions]) {
      if ((entry.connectorId ?? null) !== null) continue;
      const keyGone = entry.via === "bearer" && !(entry.keyId && this.ownerAuth?.hasKey?.(entry.keyId));
      if (keyGone || (entry.via === "path" && entry.tunnel && !pathOpen)) this.sessions.close(sessionId);
    }
  }

  async handle(req, res) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

    // 跨源处理必须排在所有分支之前
    const corsOk = this.applyCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(corsOk ? 204 : 403);
      return res.end();
    }
    if (!corsOk) {
      return this.respondJson(res, 403, { error: "origin_not_allowed", message: "只接受本机来源的跨域请求。" });
    }

    /*
     * 本机 MCP 防绕过（减速带，不是绝对安全）：带转发痕迹头（cf-* / x-forwarded-* / forwarded）
     * 或 Host 不是本机名的请求，只放行「已激活且我们隧道通着」这条路，其余 403。
     * 判定函数 isRemoteRequest 在 src/core/bearer-auth.js；这里这一行是桥上的执行点。
     * 启动期（隧道还没登记 / 正在重连、状态没定下来）不判 403，回 503 + Retry-After：
     * 那时请求其实是从我们的隧道进来的，拦成 403 客户端会当成永久失败，也会把公网自检带成「隧道故障」。
     */
    if (this.remoteGate && isRemoteRequest(req.headers)) {
      const blocked = await this.remoteGateError();
      if (blocked?.status === 503) {
        return this.respondJson(res, 503, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32002, message: blocked.message },
          message: blocked.message,
        }, { "retry-after": blocked.retryAfter });
      }
      if (blocked) {
        return this.respondJson(res, 403, { error: "tunnel_required", message: blocked.message });
      }
    }

    /*
     * 隧道 OAuth 的协议端点（PRM / AS metadata / DCR / authorize / token / revoke）
     * 和本机确认入口。OAuth 关闭时这段整体不存在，这些路径照旧落到下面的 404。
     */
    if (this.oauth && await this.handleOAuth(req, res, url)) return;

    const route = this.matchRoute(url.pathname, req.headers, req);
    const connector = route?.connector ?? null;
    const via = route?.via ?? "path";
    const keyId = route?.keyId ?? null;
    const oauthToken = route?.oauth ?? null;

    if (route?.kind === "health" && req.method === "GET") {
      return this.respondJson(res, 200, await this.health());
    }
    // 未授权 / 令牌失效：按 MCP 规范回 401，并带 WWW-Authenticate 指向 PRM
    if (route?.kind === "oauth-challenge" || route?.kind === "oauth-error") {
      return this.respondOAuthChallenge(req, res, route);
    }
    // 旧式 SSE（只有 SSE 才连得上的客户端，例如通义灵码 IDE、ChatWise 旧服务器）：
    // 口令校验、来源判断、503 门禁、会话上限都复用上面这套，不另写一份
    if (route?.kind === "sse" || route?.kind === "sse-messages") {
      // 统计和活动流要在分派之前记：否则只用 SSE 的客户端在界面上永远显示「上次请求：无」
      this.noteRequest(req);
      return this.handleLegacySse(req, res, url, route);
    }
    // 修复：根路径原来不带令牌就返回服务名和工具数，和「错令牌一律 404、不让扫描器知道这里有服务」的设计矛盾
    if (route?.kind !== "mcp") {
      return this.respondJson(res, 404, { error: "not_found" });
    }

    /*
     * 只有走到这里才是真正的 MCP 请求（health 和错令牌 404 都在上面返回了）。
     */
    this.noteRequest(req);

    // 已有会话：把请求交给对应 transport。会话所属连接器必须和这次 URL 一致，
    // 不一致就当会话不存在（和找不到会话的返回一样，不暴露别人会话是否存在）。
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId) {
      const entry = this.sessions.get(String(sessionId));
      // 同一个身份还要同一条入口：口令入口开的会话不能拿到路径入口用，反过来也不行。
      // OAuth 会话再绑定令牌 id：同一客户端换了一把令牌，旧会话不能继续用。
      if (entry && (entry.connectorId ?? null) === (connector?.id ?? null) && (entry.via ?? "path") === via && (entry.keyId ?? null) === keyId && (entry.oauthTokenId ?? null) === (oauthToken?.id ?? null)) {
        this.sessions.touch(String(sessionId));
        return entry.transport.handleRequest(req, res).catch(() => this.respondJson(res, 500, { error: "transport_failure" }));
      }
    }

    if (req.method === "POST") {
      // 新会话：先读 body（SDK 需要已解析的 JSON 或原始流），再建 transport
      const body = await readJsonBody(req);
      if (!body) return this.respondJson(res, 400, { error: "invalid_json" });
      // 带了会话号却找不到（桥重启过、会话被清掉、或者不是这个连接器的）：回 404。
      // 回 404 是 MCP 规范要求的信号，符合规范的客户端会重新 initialize；官方 TS / Python SDK
      // 收到 404 只抛错，要由上层应用自己重连，Muse 那边具体怎么处理还要实际观察。
      // 只有这次本身就是 initialize 时，才丢掉旧会话号、开新会话。
      if (sessionId && !isInitializeBody(body)) return this.rejectStaleSession(res, req.method, body);
      const keepAliveMs = Number(this.sseKeepAliveMs);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: this.jsonResponse,
        // 只有配了正的有限数才覆盖；否则不传，用 SDK 默认的 15 秒心跳
        ...(Number.isFinite(keepAliveMs) && keepAliveMs > 0 ? { keepAliveMs } : {}),
        onsessioninitialized: (sid) => {
          // initialize 半路连接器被删了：不给它留会话（removed 事件那时还没有这个会话可关）
          if (connector && !this.connectors?.get(connector.id)) { transport.close?.().catch?.(() => {}); return; }
          // 记下会话是谁建的：主令牌为 null，连接器为它的 id。之后换 URL 拿同一个会话 id 来用会被拒。
          this.sessions.add(sid, {
            transport,
            server,
            lastActivity: Date.now(),
            connectorId: connector?.id ?? null,
            via,
            keyId,
            oauthTokenId: oauthToken?.id ?? null,
            oauthClientId: oauthToken?.clientId ?? null,
            tunnel: isTunnelRequest(req.headers),
            // 这次 initialize 对应的请求处理何时真正收尾（stop() 会等它，见 stop()）
            requestDone: null,
          });
          // via：从哪条入口进来的（path / bearer / oauth），换凭据后看日志就能确认客户端真的换了入口
          // keyId 是口令的编号（不是口令本身），日志里能看出是哪个客户端的那把
          this.onActivity({
            kind: "session-open",
            sessionId: sid,
            via,
            ...(keyId ? { keyId } : {}),
            ...(oauthToken ? { oauthClientId: oauthToken.clientId, oauthTokenId: oauthToken.id } : {}),
            at: Date.now(),
          });
        },
      });
      const server = createMcpServer(this.mcpServerOptions({ connector, keyId, oauthToken }));
      await server.connect(transport);
      // server.connect 给 transport 挂了 SDK 自己的 onclose（中止进行中的调用、通知 server）；这里接在它后面，不能直接盖掉
      const sdkOnClose = transport.onclose;
      transport.onclose = () => {
        try { sdkOnClose?.(); } catch { /* SDK 收尾出错不影响登记表清理 */ }
        const sid = transport.sessionId;
        if (sid) { this.sessions.delete(sid); this.sessionMetrics.drop(sid); this.onActivity({ kind: "session-close", sessionId: sid, at: Date.now() }); }
      };
      // 这次 initialize 的请求处理什么时候真正收尾：登记到会话上，stop() 要等它，
      // 否则 SSE 流的响应句柄还在，进程退出时会碰到 libuv 断言（见 standalone 自检）。
      const handled = transport.handleRequest(req, res, body).catch(() => this.respondJson(res, 500, { error: "transport_failure" }));
      const registered = transport.sessionId ? this.sessions.get(transport.sessionId) : null;
      if (registered) registered.requestDone = handled;
      return handled;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      // 带了会话号但已失效：同上回 404；根本没带会话号：明确拒绝，避免客户端误以为接通
      if (sessionId) return this.rejectStaleSession(res, req.method, null);
      /*
       * 旧客户端把 /mcp 当 SSE 端点用：GET + Accept: text/event-stream、又没有会话头。
       * 回 405 并在 body 里用中文告诉它换 /sse/<口令>，否则它只会停在超时或看不懂的 400 上。
       *
       * sse_endpoint 只给「主路径令牌」这一个身份：连接器 / 主口令 / OAuth 那几种入口
       * 本来就没有可用的 SSE 地址，硬给一个只会把主路径令牌泄露给受限客户端。
       */
      const accept = String(req.headers.accept ?? "");
      if (req.method === "GET" && accept.includes("text/event-stream")) {
        const ownToken = route.via === "path" && !connector ? (route.token ?? null) : null;
        return this.respondJson(res, 405, {
          error: "method_not_allowed",
          message: ownToken
            ? "这个客户端只支持 SSE，请改用 /sse/<口令>"
            : "这个客户端只支持 SSE；这个入口没有可用的 SSE 地址，请在本机界面的「客户端接入」里拿主路径地址，或用支持 /mcp 的客户端",
          ...(ownToken ? { sse_endpoint: `/sse/${ownToken}` } : {}),
        });
      }
      return this.respondJson(res, 400, { error: "missing_session", message: "请先用 POST 完成 initialize。" });
    }

    return this.respondJson(res, 405, { error: "method_not_allowed" });
  }

  /**
   * 造一个 MCP server 的全部参数（/mcp 和 /sse 共用）。
   *
   * 旧式 SSE 端点必须和 /mcp 走同一套工具分组权限、调用日志、结果落盘规则，
   * 所以这里只写一份；改这里就是两条入口一起改，避免以后一边改了一边忘。
   */
  mcpServerOptions({ connector = null, keyId = null, oauthToken = null } = {}) {
    return {
      instructions: this.instructions,
      forward: this.forward,
      beforeListTools: this.beforeListTools,
      dataHome: this.dataHome,
      resultLimitBytes: this.resultLimitBytes,
      connector,
      connectors: this.connectors,
      profileExists: this.profileExists,
      toolTier: this.toolTier,
      // 口令作用域：连接器看自己的 scope，主口令看 keyId 那把的 scope；主路径令牌没有作用域
      ownerAuth: this.ownerAuth,
      keyId,
      // OAuth：作用域来自授权时本机选的分组，审计里带 client_id / 客户端名字
      oauth: oauthToken,
      workspaceRoots: this.workspaceRoots,
      currentCwd: this.currentCwd,
      sessionMetrics: this.sessionMetrics,
      // 修复：stats 原来从没被累加过，界面上「工具调用 / 成功率」永远是 0
      onToolResult: ({ name, args, result, failed, durationMs, sessionId, client, connector: connectorId, group, decision, reason, resultBytes, stored, code, meta }) => {
        this.stats.calls++;
        if (failed) this.stats.failures++;
        this.stats.durations.push(durationMs);
        if (this.stats.durations.length > 200) this.stats.durations.splice(0, this.stats.durations.length - 200);
        // 日志写失败只在 call-log 里记一句，不影响这次工具调用
        void this.callLog.record({
          sessionId,
          client,
          connector: connectorId,
          tool: name,
          // 远程调用的权限审计：口令身份（名字 / 指纹）、分组、放行结论和原因
          group: group ?? null,
          decision,
          reason,
          args: summarizeArgs(args),
          ok: !failed,
          code: code ?? null,
          durationMs,
          resultBytes,
          stored: stored ?? null,
          // 耗时 / 输出估算的摘要（不记录网页内容本身）
          meta: meta ?? null,
          // 写操作闸门的审计：只有 MUTATING 调用才有（只读动作不写这些字段）
          action: actionAudit({ tool: name, args, structured: result?.structuredContent ?? null, failed }),
        });
        /*
         * 界面 / windrise_logs 的摘要走一条独立事件（只有数字和工具名，不含网页内容）。
         * 这里不受 500 条日志环影响：主进程按会话每 30 秒才把它变成一行日志，
         * 否则一轮长浏览器自动化就能把真正要看的日志挤掉。明细在调用日志的 meta 里。
         */
        if (meta && isMetaTool(name)) {
          try {
            this.onActivity({
              kind: "tool-meta",
              sessionId,
              sessionTag: sessionId ? `会话 ${String(sessionId).slice(0, 8)} ` : "",
              meta: { tool: name, ...meta },
              at: Date.now(),
            });
          } catch { /* 日志事件失败不影响工具返回 */ }
        }
      },
    };
  }

  /**
   * 旧式 SSE（MCP 2024-11-05 的 HTTP+SSE 传输）：GET /sse/<口令> 建流，POST /messages/<口令>?sessionId=… 收消息。
   *
   * 为什么还要它：通义灵码 IDE、ChatWise 旧服务器这类客户端只会发 GET + Accept: text/event-stream，
   * 见到 /mcp 只会 405。它们要的方案就是这一对端点，SDK 里叫 SSEServerTransport。
   *
   * 和 /mcp 共用、不另写一份的东西：
   *   · 口令 / 来源：matchRoute 已经用同一套规则认出口令（错口令在上面就 404 了）；
   *   · 工具权限 / 调用日志：mcpServerOptions 里的 createMcpServer 参数完全一样；
   *   · 会话表：同一个 SessionRegistry，同一口令的 SSE 会话计入同一个上限、同一套空闲超时；
   *   · 启动期 503 门禁：handle 开头那段 remoteGate 检查对 /sse 一样生效。
   * 唯一的区别在 MCP 协议层的消息走向：服务端所有消息都从这条 SSE 流发出去。
   */
  async handleLegacySse(req, res, url, route) {
    const connector = route?.connector ?? null;
    const via = route?.via ?? "path";
    const keyId = route?.keyId ?? null;
    const oauthToken = route?.oauth ?? null;

    if (route.kind === "sse") {
      if (req.method !== "GET") {
        return this.respondJson(res, 405, { error: "method_not_allowed", message: "SSE 端点只接受 GET；消息请 POST 到 /messages/<口令>?sessionId=…" });
      }
      /*
       * MCP 的 SSE 传输是「一条长连接 + 每个请求对应一次 POST」：
       * 会话号只活在这条连接上。这条流本身才是「客户端还活着」的证据，
       * 所以只要心跳写成功，就在心跳里把 lastActivity 推后（见下面 heartbeat），
       * 不能只看 POST：用户连上后去吃饭 30 分钟、一条消息都没发，不该被空闲回收掐掉。
       * 写失败（连接其实已经断了）就不续命，交给空闲回收 / res close 收尾。
       */
      // endpoint 事件里的收消息地址必须用**这次请求自己那把口令**，不能写死主路径令牌：
      // 否则连接器客户端 POST 回来时身份对不上（404），而且主口令被明文交了出去
      const token = route.token ?? this.routeToken;
      const transport = new SSEServerTransport(`/messages/${token}`, res);
      const sid = transport.sessionId;
      const server = createMcpServer(this.mcpServerOptions({ connector, keyId, oauthToken }));
      // 先登记再开流：会话总数已满时 SessionRegistry 会按同一套规则挤掉一个，绝不无限增长
      this.sessions.add(sid, {
        transport,
        server,
        lastActivity: this.sessions.now(),
        connectorId: connector?.id ?? null,
        via,
        keyId,
        oauthTokenId: oauthToken?.id ?? null,
        oauthClientId: oauthToken?.clientId ?? null,
        tunnel: isTunnelRequest(req.headers),
        legacySse: true,
      });
      this.onActivity({
        kind: "session-open",
        sessionId: sid,
        via,
        endpoint: "sse",
        ...(keyId ? { keyId } : {}),
        ...(oauthToken ? { oauthClientId: oauthToken.clientId, oauthTokenId: oauthToken.id } : {}),
        at: Date.now(),
      });
      /*
       * 心跳：经隧道（cloudflared / Cloudflare 边缘）空闲 90 秒量级就断连，旧式 SSE 这条流
       * 平时一个字节都不写，客户端「挂一会儿就掉线」。每 sseKeepAliveMs（默认 15 秒，和 /mcp 一致）
       * 写一条 SSE 注释行 `: ping` 续命；客户端会按规范忽略注释行。
       * unref：心跳不能拖住进程退出（测试和命令行自检跑完就该能自然结束）。
       *
       * 写成功本身就是「客户端还活着」的证据，所以顺手 touch 会话：只连不发消息的客户端
       * 不会被 30 分钟空闲回收掐掉（和「心跳续命」的目的保持一致）。写失败不 touch。
       * headersSent 判断不能省：connect() 内部才 writeHead，心跳一旦抢在它前面 write，
       * 会隐式发出一个不带 text/event-stream 头的 200，随后 start() 的 writeHead 直接抛错。
       */
      const configuredMs = Number(this.sseKeepAliveMs);
      const pingMs = configuredMs > 0 ? Math.min(configuredMs, 2 ** 31 - 1) : 15000;
      const heartbeat = setInterval(() => {
        if (!res.headersSent || res.writableEnded || res.destroyed) return;
        try {
          res.write(": ping\n\n");
          this.sessions.touchIfOpen(sid);
        } catch { /* 写失败交给 close 事件收尾，也不续命 */ }
      }, pingMs);
      heartbeat.unref?.();
      /*
       * 断开清理：连接关了 / 出错 / 会话被淘汰都要把 server 和会话记录一起收掉。
       * transport 自己在 res 的 close 事件里会调 onclose，这里挂的 onclose 是同一个入口，
       * 用一个标记保证只清一次（close() 里也会同步触发 onclose）。
       *
       * 注意顺序：SDK 的 Protocol.connect() 会把 transport.onclose 换成「先调原来的、再调自己的
       * _onclose()（中止进行中的调用、拒掉挂起的响应、清超时定时器）」的包装函数。
       * 所以必须在 connect() **之后**取它再接一层；在 connect() 之前取必然是 undefined，
       * 之后又把整个 onclose 覆盖成 cleanup 的话，_onclose() 就永远不会执行，
       * 客户端在工具调用中途断开时服务端还会继续跑完、再往已经关掉的流里写。
       */
      let cleaned = false;
      let sdkOnClose = null;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeat);
        try { sdkOnClose?.(); } catch { /* SDK 收尾出错不影响登记表清理 */ }
        this.sessions.delete(sid);
        this.onActivity({ kind: "session-close", sessionId: sid, endpoint: "sse", at: Date.now() });
        try { server.close?.().catch?.(() => {}); } catch { /* 收尾失败不影响登记表 */ }
      };
      res.on("close", cleanup);
      res.on("error", cleanup);
      try {
        // connect() 内部会调 start()，所以这里不再单独调 start（重复调会抛 already started）
        await server.connect(transport);
        // connect() 之后才取，才拿得到 SDK 那层包装函数
        sdkOnClose = transport.onclose;
        transport.onclose = cleanup;
        /*
         * 先登记、后开流的竞态：登记时可能已经被会话上限挤掉（那时 transport 还没 start，
         * close() 关不掉任何东西）。现在流已经开了，看到 closed 标记就自己收摊，
         * 不给客户端留一条「能收事件、但每个 POST 都 404」的僵尸会话。
         */
        if (!this.sessions.get(sid)) {
          cleanup();
          try { res.end(); } catch { /* 已经断了就算了 */ }
        }
        return;
      } catch (error) {
        cleanup();
        if (!res.headersSent) this.respondJson(res, 500, { error: "transport_failure" });
        return;
      }
    }

    // POST /messages/<口令>?sessionId=…：把消息送进对应会话的 transport
    if (req.method !== "POST") {
      return this.respondJson(res, 405, { error: "method_not_allowed", message: "消息端点只接受 POST" });
    }
    const sid = url.searchParams.get("sessionId");
    const entry = sid ? this.sessions.get(String(sid)) : null;
    /*
     * 会话不存在 / 不是 SSE 会话 / 属于另一个口令身份 / 已被淘汰：一律 404（和 /mcp 的失效会话同策略，
     * 不暴露「有没有这个会话」，也不给跨身份串号的机会）。
     */
    if (!sid || !entry || !entry.legacySse || entry.closed
      || (entry.connectorId ?? null) !== (connector?.id ?? null)
      || (entry.via ?? "path") !== via
      || (entry.keyId ?? null) !== keyId
      || (entry.oauthTokenId ?? null) !== (oauthToken?.id ?? null)) {
      this.stats.staleSessions++;
      this.onActivity({ kind: "session-stale", method: req.method, endpoint: "sse", at: Date.now() });
      return this.respondJson(res, 404, { error: "session_not_found", message: "会话不存在或已断开，请重新连接 /sse/<口令>" });
    }
    this.sessions.touch(String(sid));
    const body = await readJsonBody(req);
    if (!body) return this.respondJson(res, 400, { error: "invalid_json" });
    try {
      await entry.transport.handlePostMessage(req, res, body);
    } catch {
      if (!res.headersSent) this.respondJson(res, 500, { error: "transport_failure" });
    }
  }

  /**
   * 记一笔「有真实请求进来了」：health 的「上次请求 / 隧道最近流量」和活动流都靠它。
   *
   * /mcp 和 /sse 两条入口都要调（调用点在分派之前），否则只用 SSE 的客户端在界面上看不出桥在用。
   * /healthz 和错口令 404 不调：前者是主程序每 30 秒的公网实测，会把时间刷成刚刚。
   */
  noteRequest(req) {
    const requestAt = Date.now();
    this.stats.lastRequestAt = requestAt;
    /*
     * 两种隧道加的头不一样，任一存在即算「经公网」：
     *   - cloudflared：Cloudflare 边缘给进来的请求加 cf-ray；
     *   - ngrok：不加 cf-ray，转发时加 x-forwarded-for。
     * 主程序自己每 30 秒的公网实测只打 /healthz，在那之前就返回了，所以不会把这两个时间刷成刚刚。
     */
    if (req.headers["cf-ray"] || req.headers["x-forwarded-for"]) this.stats.lastTunnelRequestAt = requestAt;
    this.onActivity({ kind: "request", method: req.method, at: requestAt });
  }

  /** 失效会话一律 404（不区分「从没有过」和「别的连接器的」，不暴露会话是否存在），并记一笔给界面和日志 */
  rejectStaleSession(res, method, body) {
    this.stats.staleSessions++;
    this.onActivity({ kind: "session-stale", method, at: Date.now() });
    const id = body && !Array.isArray(body) && body.id !== undefined ? body.id : null;
    return this.respondJson(res, 404, { jsonrpc: "2.0", id, error: { code: -32001, message: "Session not found" } });
  }

  /** 同步的轻量状态：不含探针，给界面高频轮询用（避免每 700ms 打一轮外部探针） */
  healthSummary() {
    const durations = [...this.stats.durations].slice(-50);
    const average = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
    return {
      ok: true,
      service: SERVER_NAME,
      version: SERVER_VERSION,
      state: this.httpServer ? "running" : "stopped",
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      tools: listTools().length,
      sessions: this.sessions.size,
      calls: this.stats.calls,
      failures: this.stats.failures,
      staleSessions: this.stats.staleSessions,
      lastRequestAt: this.stats.lastRequestAt || null,
      lastTunnelRequestAt: this.stats.lastTunnelRequestAt || null,
      averageDurationMs: average === null ? null : Math.round(average),
      successRate: this.stats.calls ? Math.round(((this.stats.calls - this.stats.failures) / this.stats.calls) * 1000) / 10 : null,
    };
  }

  /**
   * 健康检查（异步）：原有字段全保留，另加三态 readiness 和每个探针的 components。
   *
   * 三态是给「本机起来了、但隧道 / 外部依赖还没就绪」这种常见情况用的：
   *   ready     全部探针通过（或根本没配探针）
   *   starting  有探针失败，但启动还不到 startupGraceMs —— 大概率是还没连上
   *   degraded  有探针失败且已过宽限期 —— 需要人看一眼
   * /healthz 依然返回 200：HTTP 200 只代表「桥进程活着」，细节看 readiness。
   */
  async health() {
    const probes = (Array.isArray(this.healthProbes) ? this.healthProbes : []).filter(probe => probe && typeof probe.run === "function" && probe.name);
    const components = {};

    await Promise.all(probes.map(async (probe) => {
      let timer;
      try {
        // 单项超时：外部服务卡死时只算它失败，不拖住整个健康检查
        const result = await Promise.race([
          Promise.resolve().then(() => probe.run()),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`探针超时（超过 ${PROBE_TIMEOUT_MS / 1000} 秒没返回）`)), PROBE_TIMEOUT_MS);
          }),
        ]);
        components[probe.name] = { ok: Boolean(result?.ok), detail: result?.detail ?? "" };
      } catch (error) {
        components[probe.name] = { ok: false, detail: error?.message ?? String(error) };
      } finally {
        clearTimeout(timer);
      }
    }));

    const failing = probes.filter(probe => !components[probe.name]?.ok);
    let readiness;
    if (!failing.length) readiness = "ready";
    else if (this.startedAt && Date.now() - this.startedAt < this.startupGraceMs) readiness = "starting";
    else readiness = "degraded";

    return { ...this.healthSummary(), readiness, components };
  }

  /**
   * 未授权访问 /mcp：回 401 + WWW-Authenticate。MCP 客户端靠这个头找到 PRM，
   * 再按 PRM 的 authorization_servers 走 OAuth。老口令错仍然是 404，不走这里。
   */
  respondOAuthChallenge(req, res, route) {
    const base = this.oauth.resolveBase(req);
    const metadataUrl = base ? `${base}/.well-known/oauth-protected-resource` : null;
    const parts = [];
    if (metadataUrl) parts.push(`resource_metadata="${metadataUrl}"`);
    if (route?.error) parts.push(`error="${route.error}"`);
    // 头里不放中文 error_description（Node 只接受 latin-1）；说明放在 JSON body 里
    const challenge = `Bearer${parts.length ? ` ${parts.join(", ")}` : ""}`;
    const message = route?.description || "需要 OAuth 授权才能访问这个 MCP 地址";
    this.onActivity({ kind: "oauth-challenge", reason: route?.description ?? "missing_token", at: Date.now() });
    return this.respondJson(res, 401, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message },
      error: "unauthorized",
      message,
      ...(metadataUrl ? { resource_metadata: metadataUrl } : {}),
    }, { "www-authenticate": challenge, "cache-control": "no-store" });
  }

  /** 本机调试入口只认本机直连：经隧道转发的请求一律当不存在（404，不暴露端点）。 */
  oauthLocalOnly(req) {
    if (isRemoteRequest(req.headers)) return false;
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(origin))) return false;
    return true;
  }

  /**
   * 处理 OAuth 协议端点。返回 true = 这个请求已经处理完（包括 404 / 405），
   * false = 不是 OAuth 路径，交回给 MCP 路由。
   * OAuth 关闭时这个方法根本不会被调用，这些路径照旧 404。
   */
  async handleOAuth(req, res, url) {
    const pathname = url.pathname.length > 1 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
    const method = req.method;
    const readBase = () => this.oauth.resolveBase(req);

    if (pathname === "/.well-known/oauth-protected-resource" || pathname === "/.well-known/oauth-protected-resource/mcp") {
      if (method !== "GET") { this.respondJson(res, 405, { error: "method_not_allowed" }); return true; }
      const base = readBase();
      if (!base) { this.respondJson(res, 503, { error: "temporarily_unavailable" }); return true; }
      this.respondJson(res, 200, this.oauth.protectedResourceMetadata(base), { "cache-control": "public, max-age=60" });
      return true;
    }

    if (pathname === "/.well-known/oauth-authorization-server" || pathname === "/.well-known/oauth-authorization-server/mcp") {
      if (method !== "GET") { this.respondJson(res, 405, { error: "method_not_allowed" }); return true; }
      const base = readBase();
      if (!base) { this.respondJson(res, 503, { error: "temporarily_unavailable" }); return true; }
      this.respondJson(res, 200, this.oauth.authorizationServerMetadata(base), { "cache-control": "public, max-age=60" });
      return true;
    }

    if (pathname === "/register") {
      if (method !== "POST") { this.respondJson(res, 405, { error: "method_not_allowed" }); return true; }
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        this.respondJson(res, 400, { error: "invalid_client_metadata", error_description: "请求体必须是 JSON 对象" });
        return true;
      }
      const result = this.oauth.register(body, { ip: oauthClientIp(req) });
      if (result.status === 201) {
        this.onActivity({
          kind: "oauth-register",
          clientId: result.body.client_id,
          clientName: result.body.client_name,
          at: Date.now(),
        });
      }
      this.respondJson(res, result.status, result.body, result.headers ?? null);
      return true;
    }

    if (pathname === "/authorize") {
      if (method !== "GET") { this.respondJson(res, 405, { error: "method_not_allowed" }); return true; }
      const requestId = url.searchParams.get("request");
      if (!requestId) {
        const started = this.oauth.beginAuthorization(url.searchParams, { base: readBase() });
        if (!started.ok) {
          this.respondOAuthErrorPage(res, started.status, started.error, started.description);
          return true;
        }
        this.onActivity({
          kind: "oauth-authorize",
          requestId: started.pending.requestId,
          clientId: started.pending.clientId,
          clientName: started.pending.clientName,
          at: Date.now(),
        });
        res.writeHead(303, {
          location: `/authorize?request=${encodeURIComponent(started.pending.requestId)}`,
          ...OAUTH_PAGE_HEADERS,
        });
        res.end();
        return true;
      }

      const state = this.oauth.pendingState(requestId);
      if (state.status === "approved") {
        const code = this.oauth.takeCode(requestId);
        if (code) {
          let target = null;
          try { target = new URL(state.pending.redirectUri); } catch { target = null; }
          if (target) {
            target.searchParams.set("code", code);
            if (state.pending.state) target.searchParams.set("state", state.pending.state);
            target.searchParams.set("iss", state.pending.issuer);
            this.onActivity({
              kind: "oauth-code",
              requestId,
              clientId: state.pending.clientId,
              clientName: state.pending.clientName,
              at: Date.now(),
            });
            res.writeHead(302, {
              location: target.toString(),
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
              pragma: "no-cache",
            });
            res.end();
            return true;
          }
        }
      }
      this.respondHtml(res, 200, renderAuthorizePage(state), OAUTH_PAGE_HEADERS);
      return true;
    }

    if (pathname === "/token") {
      if (method !== "POST") { this.respondJson(res, 405, { error: "method_not_allowed" }); return true; }
      const body = await readOAuthBody(req);
      if (!body) {
        this.respondJson(res, 400, { error: "invalid_request", error_description: "请求体不是合法的表单 / JSON" });
        return true;
      }
      const result = this.oauth.exchange(body, { expectedAudience: this.oauth.audienceFor(req) });
      this.onActivity({
        kind: "oauth-token",
        grant: body.get("grant_type") ?? null,
        ok: result.status === 200,
        at: Date.now(),
      });
      this.respondJson(res, result.status, result.body, { "cache-control": "no-store", pragma: "no-cache" });
      return true;
    }

    if (pathname === "/revoke") {
      if (method !== "POST") { this.respondJson(res, 405, { error: "method_not_allowed" }); return true; }
      const body = await readOAuthBody(req);
      const token = body?.get("token");
      if (!token) {
        this.respondJson(res, 400, { error: "invalid_request", error_description: "缺少 token" });
        return true;
      }
      let revoked = false;
      try {
        revoked = this.oauth.revoke(token);
      } catch (error) {
        this.respondJson(res, 503, { error: "temporarily_unavailable", error_description: error.message });
        return true;
      }
      this.onActivity({ kind: "oauth-revoke", ok: revoked, at: Date.now() });
      // RFC 7009：不认识的令牌也回 200
      this.respondJson(res, 200, {}, { "cache-control": "no-store", pragma: "no-cache" });
      return true;
    }

    /* ---------------- 本机确认 / 调试入口（不做 UI） ---------------- */

    if (pathname === "/oauth/local/pending") {
      if (!this.oauthLocalOnly(req)) { this.respondJson(res, 404, { error: "not_found" }); return true; }
      if (method !== "GET") { this.respondJson(res, 405, { error: "method_not_allowed" }); return true; }
      this.respondJson(res, 200, { pending: this.oauth.pendingList() }, { "cache-control": "no-store" });
      return true;
    }

    if (pathname === "/oauth/local/approve" || pathname === "/oauth/local/deny" || pathname === "/oauth/local/revoke") {
      if (!this.oauthLocalOnly(req)) { this.respondJson(res, 404, { error: "not_found" }); return true; }
      if (method !== "POST") { this.respondJson(res, 405, { error: "method_not_allowed" }); return true; }
      // 必须是 JSON：跨域表单是简单请求，application/json 才会触发预检，减少本机 CSRF 面
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        this.respondJson(res, 415, { error: "unsupported_media_type", error_description: "本机确认入口只收 application/json" });
        return true;
      }
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        this.respondJson(res, 400, { error: "invalid_request" });
        return true;
      }

      if (pathname === "/oauth/local/approve") {
        const reference = body.requestId ?? body.pairingCode;
        if (!reference) { this.respondJson(res, 400, { error: "invalid_request", error_description: "缺少 requestId / pairingCode" }); return true; }
        const groups = Array.isArray(body.groups) ? body.groups : undefined;
        const result = this.oauth.approve(reference, { groups });
        if (!result.ok) {
          this.respondJson(res, result.status ?? 400, { error: result.error, error_description: result.description });
          return true;
        }
        this.onActivity({
          kind: "oauth-approve",
          requestId: result.pending.requestId,
          clientId: result.pending.clientId,
          clientName: result.pending.clientName,
          groups: result.pending.requestedGroups,
          at: Date.now(),
        });
        this.respondJson(res, 200, { ok: true, pending: result.pending }, { "cache-control": "no-store" });
        return true;
      }

      if (pathname === "/oauth/local/deny") {
        const reference = body.requestId ?? body.pairingCode;
        if (!reference) { this.respondJson(res, 400, { error: "invalid_request", error_description: "缺少 requestId / pairingCode" }); return true; }
        const result = this.oauth.deny(reference);
        if (!result.ok) {
          this.respondJson(res, result.status ?? 400, { error: result.error, error_description: result.description });
          return true;
        }
        this.onActivity({ kind: "oauth-deny", requestId: result.pending.requestId, at: Date.now() });
        this.respondJson(res, 200, { ok: true, pending: result.pending }, { "cache-control": "no-store" });
        return true;
      }

      // /oauth/local/revoke：按 client_id 吊销全部令牌，或按 token 吊销一把
      let revoked = 0;
      try {
        if (body.clientId) {
          const clientId = String(body.clientId);
          revoked = this.oauth.revokeClient(clientId);
          this.oauthChanged(clientId);
        } else if (body.token) {
          revoked = this.oauth.revoke(String(body.token)) ? 1 : 0;
        } else {
          this.respondJson(res, 400, { error: "invalid_request", error_description: "缺少 clientId / token" });
          return true;
        }
      } catch (error) {
        this.respondJson(res, 503, { error: "temporarily_unavailable", error_description: error.message });
        return true;
      }
      this.onActivity({ kind: "oauth-local-revoke", revoked, at: Date.now() });
      this.respondJson(res, 200, { ok: true, revoked }, { "cache-control": "no-store" });
      return true;
    }

    return false;
  }

  respondHtml(res, status, html, headers = null) {
    if (res.headersSent) {
      try { res.end(); } catch { /* 已经关了 */ }
      return;
    }
    const body = String(html ?? "");
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      ...(headers ?? {}),
    });
    res.end(body);
  }

  respondOAuthErrorPage(res, status, error, description) {
    this.respondHtml(res, status || 400, renderOAuthErrorPage(error, description), OAUTH_PAGE_HEADERS);
  }

  /** 某个 OAuth 客户端的令牌全被吊销 / 客户端被移除后，关掉它名下的会话。 */
  oauthChanged(clientId = null) {
    for (const [sessionId, entry] of [...this.sessions.sessions]) {
      if (entry.via !== "oauth") continue;
      if (!clientId || entry.oauthClientId === clientId) this.sessions.close(sessionId);
    }
  }

  respondJson(res, status, payload, headers = null) {
    // SSE 已经开始写了再出错时不能再写响应头，否则抛 ERR_HTTP_HEADERS_SENT 成了未处理的异常
    if (res.headersSent) {
      try { res.end(); } catch { /* 已经关了 */ }
      return;
    }
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), ...(headers ?? {}) });
    res.end(body);
  }

  /**
   * CORS：只放行本机来源（控制面板自己、本地网页、以及 file:// 页面发出的 null origin）。
   * 不写通配符 —— 否则任意网页都能读这个桥的状态。
   */
  applyCors(req, res) {
    const origin = req.headers.origin;
    const allowed = !origin || origin === "null" || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
    if (origin && allowed) res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, accept, mcp-session-id, mcp-protocol-version, authorization, last-event-id");
    res.setHeader("access-control-expose-headers", "mcp-session-id");
    res.setHeader("vary", "origin");
    return allowed;
  }

  get sessionCount() { return this.sessions.size; }

  /**
   * 告诉所有在线会话「工具清单变了」。
   * 外部 MCP 连上/断开、configure_mcp 改了配置之后调用，客户端才会重新拉 tools/list。
   * 单个会话推送失败不影响其它会话（老客户端可能不支持 notifications）。
   */
  notifyToolListChanged() {
    let notified = 0;
    for (const [, entry] of this.sessions.sessions) {
      try {
        entry.server?.sendToolListChanged?.();
        notified++;
      } catch { /* 推送失败忽略：下一次 tools/list 依然是最新的 */ }
    }
    return notified;
  }
}

/* ------------------------------------------------------------------ *
 * OAuth 授权页 / 本机调试入口用的小工具
 * ------------------------------------------------------------------ */

const OAUTH_PAGE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
});

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function oauthPageShell(title, body, extraHead = "") {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${extraHead}
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111; color: #f4f4f4;
         font: 16px/1.7 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  main { width: min(520px, calc(100vw - 48px)); padding: 32px; border: 1px solid #333; border-radius: 18px; background: #1a1a1a; }
  h1 { margin: 0 0 12px; font-size: 22px; }
  p { margin: 10px 0; color: #c9c9c9; }
  .code { margin: 22px 0; padding: 18px 12px; text-align: center; letter-spacing: .22em;
          font: 700 30px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace; color: #fff;
          background: #0b0b0b; border: 1px dashed #555; border-radius: 12px; }
  .hint { font-size: 13px; color: #8f8f8f; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function renderAuthorizePage(state) {
  const pending = state?.pending ?? null;
  if (!pending) {
    return oauthPageShell("连接请求不存在", `
      <h1>找不到这个连接请求</h1>
      <p>配对请求可能已经过期，或者 Bridge 重启过。请回到客户端重新发起连接。</p>`);
  }
  /*
   * 远程页面只显示「请到电脑上确认」+ 配对码：不显示客户端名、请求分组，也不显示任何口令。
   * 客户端名和分组在本机 pendingList / 调试 CLI 里看，确认动作也只在本机做。
   */
  if (state.status === "denied") {
    return oauthPageShell("连接已拒绝", `
      <h1>已在电脑上拒绝这次连接</h1>
      <p>这个客户端没有拿到任何权限。可以关闭此页面。</p>`);
  }
  if (state.status === "expired" || state.status === "code_expired") {
    return oauthPageShell("配对已过期", `
      <h1>配对已过期</h1>
      <p>请回到客户端重新发起连接，再在电脑上的 Windrise Bridge 里确认。</p>`);
  }
  if (state.status === "used" || state.status === "delivered") {
    return oauthPageShell("连接已完成", `
      <h1>连接已完成</h1>
      <p>授权码已经发给客户端，可以关闭这个页面。</p>`);
  }
  if (state.status === "approved") {
    return oauthPageShell("正在返回客户端", `
      <h1>已在电脑上确认</h1>
      <p>正在把授权码发回客户端。如果页面没有跳转，请回到客户端重试。</p>`);
  }
  return oauthPageShell("请在电脑上确认", `
    <h1>请在电脑上的 Windrise Bridge 确认</h1>
    <p>这个页面不会显示、也不会索取你的口令。只有在那台电脑上确认后，授权码才会发给客户端。</p>
    <div class="code">${escapeHtml(pending.pairingCode)}</div>
    <p class="hint">配对码必须和 Windrise Bridge 里显示的一致。此页每 2 秒自动刷新。</p>`, `<meta http-equiv="refresh" content="2">`);
}

function renderOAuthErrorPage(error, description) {
  return oauthPageShell("授权请求无法继续", `
    <h1>授权请求无法继续</h1>
    <p>${escapeHtml(description || error || "请求不合法")}</p>
    <p class="hint">错误码：${escapeHtml(error || "invalid_request")}</p>
    <p class="hint">请回到发起连接的客户端重新添加这个 MCP 地址。</p>`);
}

/** OAuth 端点允许 JSON 或 form-urlencoded；统一成 URLSearchParams 再交给 store。 */
async function readOAuthBody(req) {
  const type = String(req.headers["content-type"] ?? "").toLowerCase();
  if (type.includes("application/json")) {
    const body = await readJsonBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return new URLSearchParams(Object.entries(body).filter(([, value]) => typeof value === "string"));
  }
  return readFormBody(req);
}

function readFormBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > 64 * 1024) {
        done = true;
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      try { resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))); }
      catch { resolve(null); }
    });
    req.on("error", () => {
      if (done) return;
      done = true;
      resolve(null);
    });
  });
}

function oauthClientIp(req) {
  const cf = String(req.headers["cf-connecting-ip"] ?? "").trim();
  if (cf) return cf;
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  if (forwarded) return forwarded;
  return req.socket?.remoteAddress ?? "unknown";
}

/** 这次请求是不是 initialize（单条或批量里有一条就算） */
function isInitializeBody(body) {
  return (Array.isArray(body) ? body : [body]).some((message) => message?.method === "initialize");
}

function readJsonBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) { req.destroy(); resolve(null); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) { resolve(undefined); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { resolve(null); }
    });
    req.on("error", () => resolve(null));
  });
}
