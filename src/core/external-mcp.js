/**
 * 外部 MCP 服务器转发：把用户配置的第三方 MCP 服务器的工具，带前缀挂进本地工具注册表，并把调用转发过去。
 *
 * 设计要点：
 *   1. 对外工具名：`ext__<serverId>__<净化工具名>`（净化规则见 registry.js 的 safeToolName / externalToolName）。
 *   2. 本地工具名是保留字：外部工具不许占用（reserved 集合）。
 *   3. 同一个服务器内部净化后撞名 → **两个都丢弃**并记日志（不是后者覆盖前者）；跨服务器撞名同样两边都丢。
 *   4. 绑定关系存 Map<暴露名, {serverId, upstreamName, tool}>，调用时查表拿上游原名，**绝不从暴露名反推**。
 *   5. 默认超时 连接 5s / 列工具 3s / 调用 20s；配置文件里的 timeout 单位是**秒**。
 *   6. HTTP 传输 auto 模式：先 streamable-http，只在「传输方式不匹配」的状态码上回退到 sse，
 *      绝不在鉴权失败 / 限流 / 服务端错误 / 网络错误上回退。
 *   7. HTTP 传输带 origin 守卫（不许跳 origin、不许带 username/password/hash）+ fetch redirect:'error'。
 *   8. stdio 的 stderr 只排空、不记录（怕漏出凭据）；子进程只拿到白名单环境变量。
 *   9. 工具清单带 TTL 缓存（30s）+ 配置指纹；上游断线 / 工具变更通过回调触发回收或刷新。
 *  10. dispose() 必须把所有子进程杀掉，不能留残留。
 *  11. 卡死回收：调用超时、或调用方在 stallAfter 秒后才取消，就判定上游卡死，
 *      只回收这一个上游（按进程树杀干净 + 立刻后台重连），绑定原样保留，调用方不用重新 tools/list。
 *      起因是 windows-mcp：它所有 UI Automation 调用排在同一条线程上，前台应用一卡，这条线程就卡到应用恢复为止；
 *      调用方取消只放掉了 asyncio 那一侧，下一个调用照样排在卡住的那个后面。重启进程是唯一解。
 *      配套的按工具超时（toolTimeouts）、单上游并发与排队（maxConcurrent / queueTimeout）、
 *      「某种错误持续 N 秒就回收」（restartOn）都写在配置里，见下面的配置文件说明。
 *
 * 本模块的边界：
 *   - 不存密钥：配置文件里的 env / headers 是明文，只在「展示」时打码；值可以写成 `${VAR}` 从宿主环境取，避免明文落盘。
 *   - 不做 OAuth，也不注入宿主代理设置（http.proxy / PAC）；需要鉴权的上游请在 headers 里配令牌。
 *   - 本注册表的工具名上限是 64 字符，所以 ext__<id>__<名> 超长时会再截断并加短指纹，见 registry.js。
 */

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  Capability,
  externalToolName,
  registerTool,
  reservedToolNames,
  unregisterTool,
} from "./registry.js";

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

export const MAX_EXTERNAL_MCP_SERVERS = 100;
const MAX_TOOLS_PER_SERVER = 100;
const MAX_TOOL_BYTES = 100_000;
const MAX_RESULT_BYTES = 5_000_000;
/** 单个上游同时最多 2 路调用；配置里的 maxConcurrent 可以改小。 */
const MAX_ACTIVE_CALLS = 2;
/** 同一上游两次回收至少隔这么久才立刻重连，防止起不来的服务器被反复拉起。 */
const RECYCLE_EAGER_GAP_MS = 10_000;
/** 关 stdio 上游时先给它这么久自己收尾（windows-mcp 要释放按住的键），再按进程树强杀。 */
const STDIO_GRACE_MS = 1_500;
/** 工具清单缓存 30s，过期后下一次 tools/list 重新拉取。 */
const BINDING_TTL_MS = 30_000;
const CLOSE_DEADLINE_MS = 1_500;
/** 默认超时（毫秒）。配置里的 timeout 是秒，见 externalMcpTimeoutMs()。 */
export const DEFAULT_TIMEOUTS = Object.freeze({ connect: 5_000, list: 3_000, call: 20_000 });
/** 只有这些状态码算「传输方式不匹配」，才允许从 streamable-http 回退到 sse。 */
const TRANSPORT_MISMATCH_STATUS = new Set([400, 404, 405, 406, 415]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SERVER_NAME = "bridge-replica-upstream";
const SERVER_VERSION = "0.1.0";

/* ------------------------------------------------------------------ *
 * 上游错误归类
 *
 * 上游的原始报错里可能夹着 capability URL、请求头甚至令牌，所以对外只给「类别 + 我们自己写的一句话」。
 * 原始 message 只在本函数内部用来做关键字匹配，不会离开这里。
 * ------------------------------------------------------------------ */

/** origin 守卫抛错时打的标记码，归类时据此识别为 origin。 */
const ORIGIN_VIOLATION = "EXTMCP_ORIGIN_VIOLATION";
/** 沿 cause 链最多往下看几层。 */
const CAUSE_DEPTH = 4;

/** 按类别分好的错误码（统一大写比较）。 */
const CODE_GROUPS = Object.freeze({
  proxyProtocol: new Set([
    "EPROTO", "ERR_SSL_WRONG_VERSION_NUMBER", "ERR_SSL_PACKET_LENGTH_TOO_LONG", "ERR_SSL_HTTP_REQUEST",
    "HPE_INVALID_CONSTANT", "HPE_INVALID_HEADER_TOKEN", "HPE_INVALID_STATUS", "HPE_INVALID_VERSION",
    "HPE_UNEXPECTED_CONTENT_LENGTH", "ERR_TUNNEL_CONNECTION_FAILED", "ERR_PROXY_CONNECTION_FAILED",
    "ERR_PROXY_TUNNEL", "UND_ERR_PROXY",
  ]),
  auth: new Set(["UNAUTHORIZED", "FORBIDDEN", "ERR_UNAUTHORIZED", "ERR_FORBIDDEN", "INVALID_TOKEN", "INSUFFICIENT_SCOPE"]),
  certificate: new Set([
    "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "CERT_REVOKED", "CERT_UNTRUSTED", "CERT_REJECTED",
    "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
    "CERT_SIGNATURE_FAILURE", "ERR_TLS_CERT_ALTNAME_INVALID", "HOSTNAME_MISMATCH",
  ]),
  dns: new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "EAI_FAIL", "EAI_NODATA", "ENODATA", "ESERVFAIL"]),
  timeout: new Set([
    "ETIMEDOUT", "ESOCKETTIMEDOUT", "ABORT_ERR", "ERR_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "-32001",
  ]),
  connect: new Set([
    "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "EHOSTUNREACH", "EHOSTDOWN", "ENETUNREACH", "ENETDOWN",
    "EPIPE", "ERR_STREAM_PREMATURE_CLOSE", "UND_ERR_SOCKET", "UND_ERR_CLOSED", "-32000",
  ]),
  protocol: new Set([
    "UNEXPECTED_CONTENT_TYPE", "ERR_UNEXPECTED_CONTENT_TYPE", "INVALID_RESULT", "ERR_INVALID_RESULT",
    "NOT_INITIALIZED", "ERR_NOT_INITIALIZED", "NOT_CONNECTED", "-32700", "-32600",
  ]),
});

/** 每一类对外说的话：发生了什么，用户接下来做什么。 */
const HINTS = Object.freeze({
  "proxy-auth": "代理服务器要求先验证身份（407），请求没能发出去。请检查系统或环境变量里的代理账号，或换一个不需要代理认证的网络再试。",
  "proxy-protocol": "经过代理或做 TLS 握手时双方协议对不上（常见于 https 地址走了只认 http 的代理，或者反过来）。请核对地址的 http/https 前缀和本机代理设置。",
  origin: "请求必须停留在配置的 origin 上：地址里不能带用户名、密码或 # 锚点，也不会跟随重定向。请改成直连的最终地址，凭据放进 headers（可写成 ${VAR}）。",
  auth: "上游拒绝了访问（401/403）：凭据缺失、过期或权限不够。请在 headers 里配上有效令牌（可写成 ${VAR} 从环境变量读取），再执行 configure_mcp reload。",
  certificate: "上游的 TLS 证书没有通过校验（过期、自签名、证书链不完整或域名不符）。请修好服务器证书，或改用证书有效的地址。",
  dns: "上游的域名解析不出来。请检查地址里的主机名有没有写错，以及本机网络和 DNS 是否正常。",
  timeout: "上游在规定时间内没有回应。请确认服务器已经起来且不在忙，需要时把配置里的 timeout（秒）调大。",
  connect: "连不上上游：连接被拒绝、被重置或网络不可达。请确认服务器在运行、地址和端口无误、没有被防火墙拦住。",
  protocol: "地址能连通，但对方讲的不是 MCP（返回的内容类型或结果格式不对）。请确认地址指向 MCP 端点（常见是 /mcp 或 /sse），并核对 httpTransport。",
  unknown: "上游出错了，原因归不了类（为免泄露凭据，原始报错不回显）。stdio 服务器请先在终端里单独跑一遍命令；HTTP 服务器请确认地址能访问。",
});

const STATUS_OF_CATEGORY = Object.freeze({
  "proxy-auth": "proxy-error",
  "proxy-protocol": "proxy-error",
  auth: "needs-auth",
});

const isHttpStatus = (value) => Number.isInteger(value) && value >= 100 && value <= 599;

/** 把一个抛出值连同它的 cause 链摊平成可匹配的线索。 */
function collectClues(thrown) {
  const clues = { codes: new Set(), statuses: [], proxyStatuses: [], names: new Set(), texts: [] };
  let node = thrown;
  for (let depth = 0; depth < CAUSE_DEPTH && node !== undefined && node !== null; depth++) {
    if (typeof node === "object" || typeof node === "function") {
      const { code, name, message } = node;
      if (typeof code === "string" && code) clues.codes.add(code.toUpperCase());
      if (typeof code === "number") {
        clues.codes.add(String(code));
        // SDK 的 StreamableHTTPError / SseError 把 HTTP 状态放在 code 里
        if (isHttpStatus(code)) clues.statuses.push(code);
      }
      for (const candidate of [node.status, node.statusCode, node.data?.status, node.response?.status, node.cause?.status]) {
        const numeric = Number(candidate);
        if (candidate !== undefined && isHttpStatus(numeric)) clues.statuses.push(numeric);
      }
      for (const candidate of [node.proxyStatus, node.proxyStatusCode]) {
        const numeric = Number(candidate);
        if (candidate !== undefined && isHttpStatus(numeric)) clues.proxyStatuses.push(numeric);
      }
      if (typeof name === "string" && name) clues.names.add(name);
      if (typeof message === "string" && message) clues.texts.push(message);
      node = node.cause;
    } else {
      clues.texts.push(String(node));
      break;
    }
  }
  return clues;
}

/** 按优先级判定类别。 */
function pickCategory(clues) {
  const has = (group) => [...clues.codes].some(code => CODE_GROUPS[group].has(code));
  const text = clues.texts.join("\n");
  const proxyReply = /proxy[^\n]{0,40}?\b(?:responded|returned|status)\D{0,12}(\d{3})/i.exec(text);
  const proxyCodes = [...clues.proxyStatuses, ...(proxyReply ? [Number(proxyReply[1])] : [])];

  if (clues.statuses.includes(407) || proxyCodes.includes(407)) return "proxy-auth";
  if (proxyCodes.some(code => code !== 200) || has("proxyProtocol") || /wrong version number/i.test(text)) return "proxy-protocol";
  if (clues.codes.has(ORIGIN_VIOLATION)) return "origin";
  if (clues.statuses.includes(401) || clues.statuses.includes(403) || has("auth") || clues.names.has("UnauthorizedError")) return "auth";
  if (has("certificate")) return "certificate";
  if (has("dns")) return "dns";
  if (has("timeout") || clues.names.has("TimeoutError") || clues.names.has("AbortError")) return "timeout";
  if (has("connect")) return "connect";
  if (has("protocol") || /unexpected content type/i.test(text)) return "protocol";
  if (clues.statuses.length) return "http";
  return "unknown";
}

/** 抛出值里第一个像 HTTP 状态的数字（auto 回退判断也用它）。 */
function httpStatusIn(thrown) {
  return collectClues(thrown).statuses[0] ?? null;
}

/**
 * 归类任意抛出值 → { category, status, httpStatus, message }。
 * message 是我们自己写的提示，永远不含上游原文。
 */
export function classifyExternalMcpError(error) {
  const clues = collectClues(error);
  const category = pickCategory(clues);
  const httpStatus = clues.statuses[0] ?? null;
  const message = category === "http"
    ? `上游回了 HTTP ${httpStatus}，请求没有成功。请看一下上游服务自己的日志，确认地址和参数无误后再试。`
    : HINTS[category];
  return { category, status: STATUS_OF_CATEGORY[category] ?? "failed", httpStatus, message };
}

/** 日志行只写服务器、阶段和类别，不写原文。 */
export function externalMcpErrorLogLine(serverId, phase, error) {
  const { category } = classifyExternalMcpError(error);
  return `[external-mcp] ${serverId}: ${phase} 失败（${category}）`;
}

/* ------------------------------------------------------------------ *
 * 超时工具
 * ------------------------------------------------------------------ */

export function externalMcpTimeoutMs(config, phase) {
  const seconds = config?.timeout;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
  return DEFAULT_TIMEOUTS[phase];
}

/**
 * 单次调用的超时：toolTimeouts[上游原名] > timeout > 默认 20s。
 * 参数里自带 duration / timeout（秒）的工具（Wait、WaitFor、PowerShell 之类）至少给到「它自己的时长 + 5 秒」，
 * 否则 Bridge 会在它正常等待时把它判成卡死。
 */
export function externalMcpCallTimeoutMs(config, upstreamName, args) {
  const own = config?.toolTimeouts?.[upstreamName];
  let ms = typeof own === "number" ? Math.round(own * 1000) : externalMcpTimeoutMs(config, "call");
  for (const key of ["duration", "timeout"]) {
    const value = Number(args?.[key]);
    if (Number.isFinite(value) && value > 0) ms = Math.max(ms, Math.round((value + 5) * 1000));
  }
  return ms;
}

/** 卡死时回给调用方的话：发生了什么、Bridge 已经做了什么、下一步怎么做。 */
function stallMessage(config, upstreamName, callMs) {
  return `${config.label} 的 ${upstreamName} 超过 ${Math.round(callMs / 1000)} 秒没有返回，已判定上游卡死；`
    + `Bridge 已杀掉并在后台重启 ${config.id}，不用重新 tools/list，几秒后可直接再调。`
    + (config.stallHint ? config.stallHint : "这次调用可能已执行了一部分，继续前先确认当前状态。");
}

/** Windows 上按进程树强杀（taskkill /T 只能顺着还活着的父进程往下找，所以要在启动器还活着时调用）。 */
function killProcessTree(pid) {
  return new Promise(resolve => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => { child.kill(); resolve(); }, 3_000);
    child.on("exit", () => { clearTimeout(timer); resolve(); });
    child.on("error", () => { clearTimeout(timer); resolve(); });
  });
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function timeoutSignal(parent, duration) {
  const timeout = AbortSignal.timeout(duration);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

async function deadline(work, duration) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("upstream deadline exceeded"), { name: "TimeoutError" })), duration);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeWithin(work, duration = CLOSE_DEADLINE_MS) {
  return deadline(work, duration).catch(() => undefined);
}

/* ------------------------------------------------------------------ *
 * stdio 子进程的环境变量
 *
 * 第三方 MCP 子进程只拿到「跑一个普通命令行程序必需的」宿主变量，宿主里的其它变量（各种密钥）一律不传。
 * 服务器自己在配置里写的 env 覆盖宿主值，值里的 ${NAME} 从宿主环境展开。
 * ------------------------------------------------------------------ */

/** Windows：可执行文件查找、系统目录、用户目录、临时目录、处理器信息。 */
export const MANAGED_STDIO_WINDOWS_ENV = Object.freeze([
  // 找得到程序
  "PATH", "PATHEXT", "COMSPEC",
  // 系统目录
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "PROGRAMDATA",
  "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432",
  // 用户与用户目录
  "USERNAME", "USERDOMAIN", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PUBLIC",
  // 临时目录
  "TEMP", "TMP",
  // 平台信息（不少运行时据此选二进制）
  "OS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "NUMBER_OF_PROCESSORS",
]);

/** POSIX：可执行文件查找、用户、用户目录、临时目录、终端与语言区域。 */
export const MANAGED_STDIO_POSIX_ENV = Object.freeze([
  "PATH", "SHELL",
  "HOME", "USER", "LOGNAME",
  "TMPDIR", "TEMP", "TMP",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
  "TERM", "TZ",
]);

const isWindowsPlatform = (platform) => platform === "win32";
/** Windows 上变量名大小写不敏感：统一用大写作为键。 */
const envKey = (name, platform) => (isWindowsPlatform(platform) ? String(name).toUpperCase() : String(name));

/** 从宿主环境里挑出白名单变量。 */
export function managedStdioBaseEnvironment(host = process.env, platform = process.platform) {
  const allowed = new Set(isWindowsPlatform(platform) ? MANAGED_STDIO_WINDOWS_ENV : MANAGED_STDIO_POSIX_ENV);
  const picked = {};
  for (const [name, value] of Object.entries(host ?? {})) {
    if (value === undefined || value === null) continue;
    const key = envKey(name, platform);
    if (allowed.has(key)) picked[key] = String(value);
  }
  return picked;
}

/** 在宿主环境里查一个变量；Windows 上查不到原样大小写时再忽略大小写找一次。 */
function lookupHostVariable(host, name) {
  if (!host) return undefined;
  if (host[name] !== undefined) return host[name];
  if (!isWindowsPlatform(process.platform)) return undefined;
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(host)) {
    if (key.toUpperCase() === wanted) return value;
  }
  return undefined;
}

/** 把值里的 `${NAME}` 换成宿主环境的值；宿主里没有这个变量就原样保留占位符。 */
export function expandEnvValue(value, host = process.env) {
  return String(value ?? "").replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (placeholder, name) => {
    const found = lookupHostVariable(host, name);
    return found === undefined ? placeholder : String(found);
  });
}

/** PATH 里一项目录的比较形式：Windows 下去引号、统一反斜杠、忽略大小写和末尾分隔符。 */
function comparablePathEntry(entry, platform) {
  let text = String(entry).trim();
  if (isWindowsPlatform(platform)) {
    text = text.replace(/"/g, "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  } else {
    text = text.replace(/\/+$/, "");
  }
  return text;
}

/** 把随包附带的程序目录接到 PATH 末尾；已经在里面就不动。 */
function withBundledDir(currentPath, bundledBinDir, platform) {
  const separator = isWindowsPlatform(platform) ? ";" : ":";
  const entries = String(currentPath ?? "").split(separator).filter(part => part.trim() !== "");
  const target = comparablePathEntry(bundledBinDir, platform);
  if (entries.some(part => comparablePathEntry(part, platform) === target)) return entries.join(separator);
  return [...entries, bundledBinDir].join(separator);
}

/**
 * 子进程最终拿到的环境：白名单宿主变量 ← 服务器自己的 env（展开 ${NAME}）← 必要时追加附带程序目录到 PATH。
 */
export function managedStdioEnvironment(serverEnv, host = process.env, platform = process.platform, bundledBinDir) {
  const environment = managedStdioBaseEnvironment(host, platform);
  let pathSetByServer = false;
  for (const [name, value] of Object.entries(serverEnv ?? {})) {
    if (value === undefined || value === null) continue;
    const key = envKey(name, platform);
    environment[key] = expandEnvValue(value, host);
    if (key === "PATH") pathSetByServer = true;
  }
  if (bundledBinDir && !pathSetByServer) {
    environment.PATH = withBundledDir(environment.PATH, bundledBinDir, platform);
  }
  return environment;
}

/* ------------------------------------------------------------------ *
 * 配置文件
 *
 * 位置：<dataHome>/external-mcp.json（standalone.js 传进来的 mcpConfigPath）
 * 形状（与旧占位实现保持向后兼容）：
 *   {
 *     "version": 1,
 *     "mcpServers": {
 *       "<id>": {
 *         "label": "显示名",
 *         "transport": "stdio" | "http",        // 省略时按 url/command 推断（兼容旧写法）
 *         "httpTransport": "auto" | "streamable-http" | "sse",
 *         "command": "node", "args": [...], "env": {...}, "cwd": "...",
 *         "url": "https://...", "headers": {...},
 *         "timeout": 20,                         // 秒
 *         "toolTimeouts": { "Snapshot": 15 },    // 秒，按上游原名单独设；参数里带 duration/timeout（秒）的再加 5 秒
 *         "maxConcurrent": 1,                    // 同时在途的调用数，默认 2
 *         "queueTimeout": 10,                    // 秒，并发满时排队等多久，默认 0 = 立刻报忙
 *         "stallAfter": 8,                       // 秒，调用跑了这么久才被调用方取消，也按卡死回收
 *         "stallHint": "...",                    // 卡死时附在报错后面的下一步建议
 *         "restartOn": { "pattern": "CONTROL_UNAVAILABLE", "after": 30 },  // 这种错误持续 after 秒就回收
 *         "enabled": true,
 *         "tools": { "allow": [...], "deny": [...] }
 *       }
 *     }
 *   }
 * 也接受 `servers: [ {id, ...} ]` 数组写法（每项自带 id）。
 * ------------------------------------------------------------------ */

export function defaultConfigPath(home = os.homedir()) {
  return path.join(process.env.BRIDGE_DATA_HOME?.trim() || path.join(home, ".bridge-replica"), "external-mcp.json");
}

function normalizeServer(id, raw) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error(`服务器 id 不合法（只允许字母数字与 . _ -）：${String(id)}`);
  if (!raw || typeof raw !== "object") throw new Error(`${id} 的配置不是对象`);
  const transport = raw.transport ?? (raw.url ? "http" : "stdio");
  if (transport !== "stdio" && transport !== "http") throw new Error(`${id} 的 transport 只能是 stdio 或 http`);
  if (transport === "stdio" && !raw.command) throw new Error(`${id} 是 stdio 服务器但缺少 command`);
  if (transport === "http" && !raw.url) throw new Error(`${id} 是 http 服务器但缺少 url`);
  if (raw.url) {
    let url;
    try { url = new URL(String(raw.url)); } catch { throw new Error(`${id} 的 url 不是合法地址`); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${id} 的 url 只支持 http/https`);
  }
  const httpTransport = raw.httpTransport;
  if (httpTransport !== undefined && !["auto", "streamable-http", "sse"].includes(httpTransport)) {
    throw new Error(`${id} 的 httpTransport 只能是 auto / streamable-http / sse`);
  }
  let timeout;
  if (raw.timeout !== undefined) {
    const seconds = Number(raw.timeout);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`${id} 的 timeout 必须是正数（单位：秒）`);
    timeout = seconds;
  }
  const seconds = (key, value, { zero = false } = {}) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || (!zero && n === 0)) throw new Error(`${id} 的 ${key} 必须是${zero ? "非负数" : "正数"}（单位：秒）`);
    return n;
  };
  let toolTimeouts;
  if (raw.toolTimeouts !== undefined) {
    if (!raw.toolTimeouts || typeof raw.toolTimeouts !== "object" || Array.isArray(raw.toolTimeouts)) throw new Error(`${id} 的 toolTimeouts 必须是 { 工具名: 秒 }`);
    toolTimeouts = Object.fromEntries(Object.entries(raw.toolTimeouts).map(([name, value]) => [name, seconds(`toolTimeouts.${name}`, value)]));
  }
  let maxConcurrent;
  if (raw.maxConcurrent !== undefined) {
    maxConcurrent = Number(raw.maxConcurrent);
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16) throw new Error(`${id} 的 maxConcurrent 必须是 1–16 的整数`);
  }
  const queueTimeout = raw.queueTimeout !== undefined ? seconds("queueTimeout", raw.queueTimeout, { zero: true }) : undefined;
  const stallAfter = raw.stallAfter !== undefined ? seconds("stallAfter", raw.stallAfter) : undefined;
  let restartOn;
  if (raw.restartOn !== undefined) {
    const pattern = String(raw.restartOn?.pattern ?? "");
    if (!pattern) throw new Error(`${id} 的 restartOn.pattern 不能为空`);
    try { new RegExp(pattern); } catch { throw new Error(`${id} 的 restartOn.pattern 不是合法正则`); }
    restartOn = { pattern, after: seconds("restartOn.after", raw.restartOn?.after ?? 0, { zero: true }) };
  }
  const allow = Array.isArray(raw.tools?.allow) ? raw.tools.allow.map(String) : [];
  const deny = Array.isArray(raw.tools?.deny) ? raw.tools.deny.map(String) : [];
  return {
    id,
    label: String(raw.label ?? id),
    transport,
    ...(httpTransport ? { httpTransport } : {}),
    ...(raw.description ? { description: String(raw.description) } : {}),
    ...(transport === "stdio"
      ? {
        command: String(raw.command),
        args: Array.isArray(raw.args) ? raw.args.map(String) : [],
        ...(raw.env && typeof raw.env === "object" ? { env: Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)])) } : {}),
        ...(raw.cwd ? { cwd: String(raw.cwd) } : {}),
      }
      : {
        url: String(raw.url),
        ...(raw.headers && typeof raw.headers === "object" ? { headers: Object.fromEntries(Object.entries(raw.headers).map(([k, v]) => [k, String(v)])) } : {}),
      }),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(toolTimeouts ? { toolTimeouts } : {}),
    ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
    ...(queueTimeout !== undefined ? { queueTimeout } : {}),
    ...(stallAfter !== undefined ? { stallAfter } : {}),
    ...(raw.stallHint ? { stallHint: String(raw.stallHint) } : {}),
    ...(restartOn ? { restartOn } : {}),
    enabled: raw.enabled !== false,
    tools: { allow, deny },
  };
}

/** 原子写：临时文件 + fsync + rename（与 workspace.js 同一套做法，避免读到半个 json）。 */
async function atomicWriteJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file).catch(async (error) => {
    await rm(temp, { force: true });
    throw error;
  });
}

export class ExternalMcpConfigStore {
  constructor({ configPath = defaultConfigPath() } = {}) {
    this.configPath = configPath;
    this.cachedRevision = null;
  }

  /** 读原始文档。坏 JSON **不抛异常**：返回空文档 + errors，保证 Bridge 照样能起来。 */
  async read() {
    const raw = await readFile(this.configPath, "utf8").catch(() => null);
    if (raw === null) return { doc: { version: 1, mcpServers: {} }, errors: [], missing: true, revision: "" };
    const revision = createHash("sha256").update(raw).digest("hex");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { doc: { version: 1, mcpServers: {} }, errors: [{ name: "(文件)", reason: `JSON 解析失败：${error.message}` }], missing: false, revision };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { doc: { version: 1, mcpServers: {} }, errors: [{ name: "(文件)", reason: "顶层不是对象" }], missing: false, revision };
    }
    return { doc: parsed, errors: [], missing: false, revision };
  }

  async revision() {
    const { revision } = await this.read();
    return revision;
  }

  /** 归一化后的服务器列表（含被禁用的）。单条配置坏了只记 errors，不影响其它条目。 */
  async servers() {
    const { doc, errors } = await this.read();
    const out = [];
    const rawMap = doc.mcpServers && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers) ? doc.mcpServers : {};
    for (const [id, raw] of Object.entries(rawMap)) {
      try { out.push(normalizeServer(id, raw)); }
      catch (error) { errors.push({ name: id, reason: error.message }); }
    }
    if (Array.isArray(doc.servers)) {
      for (const raw of doc.servers) {
        try { out.push(normalizeServer(String(raw?.id ?? ""), raw)); }
        catch (error) { errors.push({ name: String(raw?.id ?? "(未命名)"), reason: error.message }); }
      }
    }
    return { servers: out, errors };
  }

  async get(id) {
    const { servers } = await this.servers();
    return servers.find(server => server.id === id) ?? null;
  }

  /** 写回：统一写成 mcpServers 映射（保留文件里其它顶层字段）。 */
  async #writeDoc(doc) {
    await atomicWriteJson(this.configPath, doc);
    this.cachedRevision = null;
  }

  /**
   * 新增/覆盖一条服务器配置。
   * 写入的是**归一化之后**的形态（推断出 transport、丢掉 name/id 之类的临时字段），
   * 这样配置文件不会残留「按 url/command 猜 transport」这类隐式状态。
   */
  async upsert(raw) {
    const { doc } = await this.read();
    const id = String(raw?.name ?? raw?.id ?? "");
    const normalized = normalizeServer(id, raw);
    const { id: _dropId, tools, ...rest } = normalized;
    const stored = { ...rest, ...(tools.allow.length || tools.deny.length ? { tools } : {}) };
    const next = { ...doc, version: doc.version ?? 1, mcpServers: { ...(doc.mcpServers ?? {}), [id]: stored } };
    await this.#writeDoc(next);
    return normalized;
  }

  async remove(id) {
    const { doc } = await this.read();
    const next = { ...doc, version: doc.version ?? 1, mcpServers: { ...(doc.mcpServers ?? {}) } };
    const existed = Object.prototype.hasOwnProperty.call(next.mcpServers, id);
    delete next.mcpServers[id];
    if (Array.isArray(next.servers)) next.servers = next.servers.filter(entry => entry?.id !== id);
    await this.#writeDoc(next);
    return existed;
  }

  async setEnabled(id, enabled) {
    const { doc } = await this.read();
    const entry = doc.mcpServers?.[id];
    const inArray = Array.isArray(doc.servers) ? doc.servers.find(item => item?.id === id) : null;
    if (!entry && !inArray) throw new Error(`没有名为 ${id} 的服务器`);
    const next = { ...doc, version: doc.version ?? 1 };
    if (entry) next.mcpServers = { ...doc.mcpServers, [id]: { ...entry, enabled: Boolean(enabled) } };
    if (inArray) next.servers = doc.servers.map(item => (item?.id === id ? { ...item, enabled: Boolean(enabled) } : item));
    await this.#writeDoc(next);
    return true;
  }
}

/* ------------------------------------------------------------------ *
 * 连接一个外部服务器（本模块唯一创建 SDK Client / Transport 的地方）
 * ------------------------------------------------------------------ */

/** 关闭一条 stdio 连接最多花多久：宽限期 + 进程树强杀 + 收尾。 */
const SHUTDOWN_BUDGET_MS = STDIO_GRACE_MS + 3_000 + CLOSE_DEADLINE_MS;

const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms).unref?.());

function originViolation(detail) {
  return Object.assign(new Error(`origin guard: ${detail}`), { code: ORIGIN_VIOLATION });
}

/** 地址本身就不许带凭据或锚点。 */
function checkConfiguredUrl(url) {
  if (url.username || url.password) throw originViolation("userinfo in configured url");
  if (url.hash) throw originViolation("fragment in configured url");
}

/** 给 SDK 用的 fetch：每个请求都必须落在配置地址的 origin 上，而且不跟随重定向。 */
function fetchPinnedTo(origin) {
  return async (input, init) => {
    const raw = input instanceof URL ? input.href : typeof input === "string" ? input : input?.url;
    let target;
    try { target = new URL(raw); } catch { throw originViolation("unparseable request url"); }
    if (target.origin !== origin) throw originViolation("cross-origin request");
    checkConfiguredUrl(target);
    return fetch(input, { ...init, redirect: "error" });
  };
}

function expandHeaders(headers) {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([name, value]) => [name, expandEnvValue(value)]));
}

/** 按传输方式造一个 transport（还没连）。 */
function buildTransport(kind, config, bundledBinDir) {
  if (kind === "stdio") {
    if (!config.command) throw new Error(`${config.id} 没有配置 command`);
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: managedStdioEnvironment(config.env, process.env, process.platform, bundledBinDir),
      cwd: config.cwd ?? os.homedir(),
      stderr: "pipe",
    });
    // stderr 必须读走，否则管道写满子进程会卡住；内容可能带凭据，直接丢弃
    transport.stderr?.on("data", () => {});
    return transport;
  }
  const url = new URL(config.url);
  checkConfiguredUrl(url);
  const options = { requestInit: { headers: expandHeaders(config.headers) }, fetch: fetchPinnedTo(url.origin) };
  return kind === "sse" ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options);
}

/**
 * 关掉一对 client/transport。stdio 在 Windows 上：先让它自己退，宽限期过了启动器还在就按进程树强杀
 * （uvx / npx 这类启动器下面的真实服务进程，只杀启动器会留下孤儿）。整个过程有上限，不会卡住停机。
 */
function shutdownPair(client, transport, kind) {
  const pid = kind === "stdio" ? transport.pid : undefined;
  const work = (async () => {
    const polite = Promise.resolve()
      .then(() => client.close())
      .catch(() => undefined)
      .then(() => transport.close?.())
      .catch(() => undefined);
    if (pid && process.platform === "win32") {
      await Promise.race([polite, pause(STDIO_GRACE_MS)]);
      if (processAlive(pid)) await killProcessTree(pid);
    }
    await closeWithin(polite);
  })();
  return closeWithin(work, SHUTDOWN_BUDGET_MS);
}

/**
 * 连一个外部 MCP 服务器，返回 { attempt, list(signal), call(name, args, signal, timeoutMs), close() }。
 *
 * httpTransport=auto：先试 Streamable HTTP，只有首个 POST 的状态码表明「传输方式不对」
 * （TRANSPORT_MISMATCH_STATUS）才改试 SSE；鉴权、限流、5xx、网络错误都直接报错。
 * 每次尝试都是新的 Client，失败的那次连 client 带 transport 一起关掉。
 */
export async function connectExternalMcp(config, { onChanged = () => {}, onClosed = () => {}, firstConnectTimeoutMs, bundledBinDir } = {}) {
  const budgetMs = firstConnectTimeoutMs ?? externalMcpTimeoutMs(config, "connect");
  const startedAt = Date.now();
  const kinds = config.transport === "stdio"
    ? ["stdio"]
    : (config.httpTransport ?? "streamable-http") === "auto"
      ? ["streamable-http", "sse"]
      : [config.httpTransport ?? "streamable-http"];

  for (let index = 0; index < kinds.length; index++) {
    const kind = kinds[index];
    const hasFallback = index < kinds.length - 1;
    const transport = buildTransport(kind, config, bundledBinDir);
    const client = new Client({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: {} });

    let live = false;
    let closing = null;
    client.onclose = () => { if (live && !closing) onClosed(); };
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { if (live && !closing) onChanged(); });

    const remainingMs = Math.max(250, budgetMs - (Date.now() - startedAt));
    try {
      await deadline(client.connect(transport, { timeout: remainingMs }), remainingMs + 200);
    } catch (error) {
      closing = shutdownPair(client, transport, kind);
      await closing;
      const mismatch = kind === "streamable-http" && TRANSPORT_MISMATCH_STATUS.has(httpStatusIn(error));
      if (hasFallback && mismatch) continue;
      throw error;
    }
    live = true;

    return {
      attempt: kind,
      async list(signal) {
        const tools = [];
        let cursor;
        // 分页拉全；防止上游无限翻页，最多翻到单服务器上限的两倍
        do {
          const page = await client.listTools(cursor ? { cursor } : {}, { signal });
          if (!page || !Array.isArray(page.tools)) throw Object.assign(new Error("tools/list returned no tool array"), { code: "INVALID_RESULT" });
          tools.push(...page.tools);
          cursor = page.nextCursor;
        } while (cursor && tools.length < MAX_TOOLS_PER_SERVER * 2);
        return tools;
      },
      call(name, args, signal, timeoutMs) {
        return client.callTool({ name, arguments: args ?? {} }, undefined, { signal, timeout: timeoutMs });
      },
      close() {
        closing ??= shutdownPair(client, transport, kind);
        return closing;
      },
    };
  }
  throw new Error("没有可用的 MCP 传输方式");
}

/* ------------------------------------------------------------------ *
 * 管理器：每个上游一份状态，负责连接、刷新、转发与回收
 * ------------------------------------------------------------------ */

export class ExternalMcpManager {
  /**
   * @param {object} options
   * @param {string} options.configPath       配置文件路径
   * @param {(line: string) => void} [options.log]        日志（坏配置 / 撞名 / 连接失败都走这里）
   * @param {() => void} [options.onChanged]  工具清单发生实质变化时回调（宿主据此通知客户端）
   * @param {() => Set<string>} [options.reserved] 保留名集合（默认取注册表里已注册的本地工具）
   */
  constructor({ configPath = defaultConfigPath(), log = () => {}, onChanged = () => {}, reserved = reservedToolNames, bundledBinDir } = {}) {
    this.config = new ExternalMcpConfigStore({ configPath });
    this.configPath = configPath;
    this.log = log;
    this.onChanged = onChanged;
    this.reservedProvider = reserved;
    this.bundledBinDir = bundledBinDir;

    /** Map<暴露名, {serverId, upstreamName, tool}> —— 调用时查表，不从名字反推 */
    this.bindings = new Map();
    /** Map<serverId, UpstreamState> */
    this.states = new Map();
    /** 曾经 ready 过的服务器：再连就是「重连」 */
    this.wasReady = new Set();
    /** 已注册进全局注册表的工具定义 Map<暴露名, definition> */
    this.registered = new Map();

    this.fingerprint = "";
    this.cachedUntil = 0;
    this.sourceRevision = "";
    this.generation = 0;
    /** 已经真正同步进注册表的最大 generation（用于丢弃「迟到的旧一轮」） */
    this.syncedGeneration = 0;
    this.disposed = false;
    this.lastErrors = [];
    /** Map<serverId, 上次回收的时间>，用来给自动重连限流 */
    this.recycledAt = new Map();
  }

  /* ---------------- 对外状态 ---------------- */

  /** 每个服务器的健康状态。 */
  snapshot() {
    return [...this.states.values()].map(state => ({ ...state.health }));
  }

  hasBinding(name) {
    return this.bindings.has(name);
  }

  /** configure_mcp list 用：配置 + 状态合在一行。 */
  async statusRows() {
    const { servers, errors } = await this.config.servers();
    const rows = servers.map(server => {
      const health = this.states.get(server.id)?.health;
      const status = !server.enabled ? "disabled"
        : !health || health.state === "off" ? "stopped"
          : health.state === "connecting" ? (health.reconnecting ? "reconnecting" : "connecting")
            : health.state === "ready" ? "running"
              : (health.status ?? "failed");
      return {
        id: server.id,
        label: server.label,
        transport: server.transport,
        target: server.transport === "http" ? new URL(server.url).origin : `${server.command} ${(server.args ?? []).join(" ")}`.trim(),
        enabled: server.enabled,
        status,
        toolCount: health?.toolCount ?? 0,
        ...(health?.error ? { reason: health.error } : {}),
        ...(server.tools.allow.length || server.tools.deny.length
          ? { tools: { allow: server.tools.allow, deny: server.tools.deny } }
          : {}),
      };
    });
    return { rows, errors };
  }

  /** 展示用：密钥类字段只打码，不回显明文。 */
  static redactValue(key, value) {
    return /authorization|token|key|secret|cookie|password/i.test(key) ? "***" : String(value);
  }

  /* ---------------- 生命周期 ---------------- */

  /** 立刻作废：旧暴露名马上不能再调，缓存清零，通知宿主工具清单变了。 */
  invalidate() {
    this.generation++;
    this.cachedUntil = 0;
    this.bindings.clear();
    this.#syncRegistry(this.bindings);
    this.#notifyHost();
  }

  #notifyHost() {
    try { this.onChanged(); } catch (error) { this.log(`[external-mcp] onChanged 回调异常：${error?.message ?? error}`); }
  }

  /** 新建一份上游状态（还没有连接）。 */
  #blankState(config, key) {
    return {
      config,
      key,
      controller: new AbortController(),
      connection: null,
      pending: null,
      waiters: [],
      active: 0,
      badSince: undefined,
      updated: Date.now(),
      health: {
        id: config.id,
        label: config.label,
        transport: config.transport === "stdio" ? "stdio" : (config.httpTransport ?? "streamable-http"),
        state: "connecting",
        reconnecting: this.wasReady.has(config.id),
        toolCount: 0,
      },
    };
  }

  #setHealth(state, patch) {
    state.health = { ...state.health, ...patch };
    state.updated = Date.now();
  }

  #markFailed(state, error) {
    const { category } = classifyExternalMcpError(error);
    const { error: reason, status } = failureOf(state.config.id, error);
    this.#setHealth(state, { state: "error", category, status, error: reason, toolCount: 0 });
  }

  /**
   * 让一份状态退场（调用前它已经不在 this.states 里）：
   * 进行中的操作中止；排队等名额的调用告诉它「已回收」让它去新连接排队；
   * 已有连接在时限内关掉。还在连接中的那次，由 #ensure 在连上后自己发现被弃用并立刻关掉。
   */
  #retire(state) {
    state.controller.abort();
    for (const waiter of state.waiters.splice(0)) waiter.resolve("recycled");
    const connection = state.connection;
    state.connection = null;
    if (!connection) return Promise.resolve();
    return closeWithin(connection.close(), SHUTDOWN_BUDGET_MS + 500);
  }

  async #discard(id) {
    const state = this.states.get(id);
    if (!state) return;
    this.states.delete(id);
    await this.#retire(state);
  }

  async #stopAll() {
    await Promise.all([...this.states.keys()].map(id => this.#discard(id)));
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.cachedUntil = 0;
    this.bindings.clear();
    this.#syncRegistry(this.bindings);
    await this.#stopAll();
  }

  /**
   * 拿到某个服务器的可用连接，必要时新建。
   * 配置哈希变了先丢旧连接；同一服务器同一时刻只有一个连接过程，后来的调用者共用它的结果。
   */
  async #ensure(config, firstConnectTimeoutMs) {
    if (this.disposed) throw new Error("外部 MCP 管理器已关闭");
    const id = config.id;
    const key = createHash("sha256").update(JSON.stringify(config)).digest("hex");

    const existing = this.states.get(id);
    if (existing && existing.key !== key) await this.#discard(id);

    const current = this.states.get(id);
    if (current && current.key === key) {
      if (current.connection && !current.controller.signal.aborted) return current;
      if (current.pending) return current.pending;
    } else if (current) {
      // 等丢弃期间又有人用另一份配置抢先建了连接：以最新的为准，先把它让掉
      await this.#discard(id);
    }
    if (this.disposed) throw new Error("外部 MCP 管理器已关闭");

    const state = this.#blankState(config, key);
    this.states.set(id, state);
    const stillWanted = () => !this.disposed && this.states.get(id) === state && !state.controller.signal.aborted;

    state.pending = (async () => {
      let connection;
      try {
        connection = await connectExternalMcp(config, {
          bundledBinDir: this.bundledBinDir,
          firstConnectTimeoutMs,
          onChanged: () => this.#upstreamToolsChanged(state),
          onClosed: () => this.#recycle(state, "上游连接已断开"),
        });
      } catch (error) {
        if (this.states.get(id) === state) this.#markFailed(state, error);
        throw error;
      } finally {
        state.pending = null;
      }
      if (!stillWanted()) {
        // 连接途中被停用、替换或停机：连上的这条立刻关掉，不让它留下来
        await closeWithin(connection.close(), SHUTDOWN_BUDGET_MS + 500);
        throw new Error(`${id} 在连接完成前已被停用或替换`);
      }
      state.connection = connection;
      this.#setHealth(state, { state: "ready", attempt: connection.attempt, error: undefined, status: undefined, category: undefined });
      this.wasReady.add(id);
      return state;
    })();
    // 结果由调用者 await；这里只防止没人接的时候冒出未处理的 rejection
    state.pending.catch(() => undefined);
    return state.pending;
  }

  /** 上游说它的工具变了：只让缓存过期，并在后台刷新一次（指纹真变了 refresh 才会通知宿主）。 */
  #upstreamToolsChanged(state) {
    if (this.disposed || this.states.get(state.config.id) !== state) return;
    this.cachedUntil = 0;
    void this.refresh({ force: true }).catch(error => this.log(`[external-mcp] 后台刷新失败：${error?.message ?? error}`));
  }

  /** 连上并列出一个服务器的工具；失败只影响它自己。 */
  async #collectTools(config) {
    let state;
    try {
      state = await this.#ensure(config);
    } catch (error) {
      this.log(externalMcpErrorLogLine(config.id, "connect", error));
      return { config, error };
    }
    const listMs = externalMcpTimeoutMs(config, "list");
    try {
      const tools = await deadline(state.connection.list(timeoutSignal(state.controller.signal, listMs)), listMs + 200);
      if (!Array.isArray(tools)) throw Object.assign(new Error("tool list is not an array"), { code: "INVALID_RESULT" });
      return { config, state, tools };
    } catch (error) {
      this.log(externalMcpErrorLogLine(config.id, "list", error));
      if (this.states.get(config.id) === state) {
        // 列不出工具的连接留着也没用：换成一份只记录失败原因的状态，旧连接后台关掉
        const failed = this.#blankState(config, state.key);
        this.#markFailed(failed, error);
        this.states.set(config.id, failed);
        void this.#retire(state);
      }
      return { config, error };
    }
  }

  /** 把一个服务器的上游工具过滤成候选绑定 Map<暴露名, binding>（同服务器内撞名的两边都丢）。 */
  #candidatesOf(config, tools) {
    const allow = new Set(config.tools?.allow ?? []);
    const deny = new Set(config.tools?.deny ?? []);
    let list = tools;
    if (list.length > MAX_TOOLS_PER_SERVER) {
      this.log(`[external-mcp] ${config.id}: 上游给了 ${list.length} 个工具，只取前 ${MAX_TOOLS_PER_SERVER} 个`);
      list = list.slice(0, MAX_TOOLS_PER_SERVER);
    }
    const grouped = new Map();
    for (const tool of list) {
      const upstreamName = typeof tool?.name === "string" ? tool.name : "";
      if (!upstreamName) { this.log(`[external-mcp] ${config.id}: 跳过一个没有名字的工具`); continue; }
      if (!tool.inputSchema || typeof tool.inputSchema !== "object") { this.log(`[external-mcp] ${config.id}: ${upstreamName} 没有 inputSchema，跳过`); continue; }
      let size;
      try { size = JSON.stringify(tool).length; } catch { size = Infinity; }
      if (size > MAX_TOOL_BYTES) { this.log(`[external-mcp] ${config.id}: ${upstreamName} 的定义过大，跳过`); continue; }
      if (allow.size && !allow.has(upstreamName)) continue;
      if (deny.has(upstreamName)) continue;
      const exposed = externalToolName(config.id, upstreamName);
      const bucket = grouped.get(exposed) ?? [];
      bucket.push(tool);
      grouped.set(exposed, bucket);
    }
    const candidates = new Map();
    for (const [exposed, bucket] of grouped) {
      if (bucket.length > 1) {
        this.log(`[external-mcp] ${config.id}: ${bucket.map(tool => tool.name).join(" / ")} 净化后都叫 ${exposed}，全部不挂载`);
        continue;
      }
      const [tool] = bucket;
      candidates.set(exposed, {
        serverId: config.id,
        upstreamName: tool.name,
        tool: {
          name: exposed,
          title: `${config.label}：${tool.title ?? tool.annotations?.title ?? tool.name}`,
          description: `[${config.label}] ${tool.description ?? ""}`.trim(),
          inputSchema: tool.inputSchema,
          // 外部工具能做什么无从得知，按最保守的口径标注
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        },
      });
    }
    return candidates;
  }

  /**
   * 读配置、连接各服务器、列工具、挂载。
   * 单个服务器出什么问题都只影响它自己，这里不会因为某个上游而抛错。
   * 返回 { tools, adopted, blocked, errors, cached }。
   */
  async refresh({ force = false } = {}) {
    const current = () => ({
      tools: this.#publicTools(),
      adopted: [...this.bindings.keys()],
      blocked: [...(this.lastBlocked ?? [])],
      errors: [...this.lastErrors],
    });
    if (this.disposed) return { tools: [], adopted: [], blocked: [], errors: [], cached: false };

    const revision = await this.config.revision();
    if (!force && revision === this.sourceRevision && Date.now() < this.cachedUntil) return { ...current(), cached: true };
    // 非强制刷新撞上正在跑的一轮，直接搭车
    if (!force && this.inflightRefresh) return this.inflightRefresh;

    const round = ++this.generation;
    const work = this.#runRefresh(round, revision).then(result => result ?? { ...current(), cached: false });
    this.inflightRefresh = work;
    try {
      return await work;
    } finally {
      if (this.inflightRefresh === work) this.inflightRefresh = null;
    }
  }

  async #runRefresh(round, revision) {
    const { servers, errors: configErrors } = await this.config.servers();
    for (const problem of configErrors) this.log(`[external-mcp] 配置条目 ${problem.name} 已跳过：${problem.reason}`);

    let wanted = servers.filter(server => server.enabled);
    if (wanted.length > MAX_EXTERNAL_MCP_SERVERS) {
      this.log(`[external-mcp] 启用了 ${wanted.length} 个服务器，超过上限 ${MAX_EXTERNAL_MCP_SERVERS}，只连前 ${MAX_EXTERNAL_MCP_SERVERS} 个`);
      wanted = wanted.slice(0, MAX_EXTERNAL_MCP_SERVERS);
    }
    const wantedIds = new Set(wanted.map(server => server.id));
    const retiring = Promise.all([...this.states.keys()].filter(id => !wantedIds.has(id)).map(id => this.#discard(id)));

    const outcomes = await Promise.all(wanted.map(config => this.#collectTools(config)));
    await retiring;
    if (this.disposed || round !== this.generation) return null; // 已经有更新的一轮（或失效/停机），这轮结果作废

    const failures = [];
    const perServer = [];
    for (const outcome of outcomes) {
      if (outcome.error) {
        failures.push(`${outcome.config.id}：${classifyExternalMcpError(outcome.error).message}`);
        continue;
      }
      perServer.push({ ...outcome, candidates: this.#candidatesOf(outcome.config, outcome.tools) });
    }

    // 跨服务器撞名：两边都不要
    const owners = new Map();
    for (const { config, candidates } of perServer) {
      for (const exposed of candidates.keys()) owners.set(exposed, [...(owners.get(exposed) ?? []), config.id]);
    }
    const reserved = this.reservedProvider();
    const blocked = [];
    const next = new Map();
    for (const { config, state, candidates } of perServer) {
      let mounted = 0;
      for (const [exposed, binding] of candidates) {
        const holders = owners.get(exposed);
        if (holders.length > 1) {
          if (holders[0] === config.id) this.log(`[external-mcp] ${holders.join(" / ")} 都给出了 ${exposed}，全部不挂载`);
          continue;
        }
        if (reserved.has(exposed)) {
          blocked.push(exposed);
          this.log(`[external-mcp] ${config.id}: ${exposed} 与本地工具重名，不挂载`);
          continue;
        }
        // 定义没变就沿用原来的绑定对象，正在进行的调用结果照常转发
        const previous = this.bindings.get(exposed);
        const same = previous && previous.serverId === binding.serverId && previous.upstreamName === binding.upstreamName
          && JSON.stringify(previous.tool) === JSON.stringify(binding.tool);
        next.set(exposed, same ? previous : binding);
        mounted++;
      }
      if (this.states.get(config.id) === state) this.#setHealth(state, { toolCount: mounted });
    }

    this.bindings.clear();
    for (const [name, binding] of next) this.bindings.set(name, binding);
    this.#syncRegistry(this.bindings);
    this.syncedGeneration = round;
    this.sourceRevision = revision;
    this.cachedUntil = Date.now() + BINDING_TTL_MS;
    this.lastErrors = failures;
    this.lastBlocked = blocked;

    const fingerprint = createHash("sha256")
      .update(JSON.stringify([...next.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, binding]) => [name, binding.serverId, binding.upstreamName, binding.tool])))
      .digest("hex");
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.#notifyHost();
    }
    return { tools: this.#publicTools(), adopted: [...next.keys()], blocked, errors: failures, cached: false };
  }

  /** 把绑定同步进全局注册表：摘掉不再存在的，挂上新的。 */
  #syncRegistry(next) {
    for (const name of [...this.registered.keys()]) {
      if (!next.has(name)) { unregisterTool(name); this.registered.delete(name); }
    }
    for (const [name, binding] of next) {
      const definition = {
        name,
        title: binding.tool.title,
        description: binding.tool.description,
        capability: Capability.EXECUTE,
        inputSchema: binding.tool.inputSchema,
        annotations: binding.tool.annotations,
        source: `external:${binding.serverId}`,
        // handler 里按**暴露名查表**拿上游原名，绝不解析字符串
        handler: async (args, ctx) => this.#invoke(name, args, ctx),
      };
      try {
        registerTool(definition);
        this.registered.set(name, definition);
      } catch (error) {
        this.log(`[external-mcp] 工具 ${name} 注册失败：${error.message}`);
      }
    }
  }

  #publicTools() {
    return [...this.bindings.values()].map(binding => binding.tool);
  }

  /* ---------------- 调用转发 ---------------- */

  async #invoke(name, args, ctx) {
    const binding = this.bindings.get(name);
    if (!binding) {
      return {
        isError: true,
        content: [{ type: "text", text: `外部工具 ${name} 已失效（服务器被停用/移除或连接已断开）。请重新调用 tools/list，或用 configure_mcp reload 重连。` }],
      };
    }
    const send = ctx?.forward;
    if (typeof send === "function") return send(binding.serverId, binding.upstreamName, args, { signal: ctx?.signal });
    return this.forward(binding.serverId, binding.upstreamName, args, { signal: ctx?.signal });
  }

  /** 宿主注入的 forward 通道：按 (serverId, 上游原名) 查绑定，避免调用方猜名字。 */
  async forward(serverId, upstreamName, args, { signal } = {}) {
    const binding = this.#findBinding(serverId, upstreamName);
    if (!binding) {
      return { isError: true, content: [{ type: "text", text: `没有可用的外部工具绑定：${serverId}/${upstreamName}。` }] };
    }
    // 等名额期间上游可能被回收重建：换到新连接上再排一次
    let state;
    for (let round = 0; ; round++) {
      state = await this.#live(binding.serverId);
      if (!state) {
        return { isError: true, content: [{ type: "text", text: "上游连接已断开，请稍后重试（可用 configure_mcp reload 重连）。" }] };
      }
      const slot = await this.#acquire(state, signal);
      if (slot === true) break;
      if (signal?.aborted) return { isError: true, content: [{ type: "text", text: "调用已被取消。" }] };
      if (slot === "recycled" && round === 0) continue;
      const limit = state.config.maxConcurrent ?? MAX_ACTIVE_CALLS;
      return { isError: true, content: [{ type: "text", text: `上游并发已满（最多 ${limit} 路），请稍后重试。` }] };
    }
    const config = state.config;
    const callMs = externalMcpCallTimeoutMs(config, binding.upstreamName, args);
    const startedAt = Date.now();
    try {
      const parent = signal ? AbortSignal.any([signal, state.controller.signal]) : state.controller.signal;
      const result = await deadline(
        state.connection.call(binding.upstreamName, args ?? {}, timeoutSignal(parent, callMs), callMs),
        callMs + 200,
      );
      // 调用期间可能被停用/重连：晚到的结果不转发
      if (this.disposed || this.bindings.get(binding.tool.name) !== binding || state.controller.signal.aborted) {
        return { isError: true, content: [{ type: "text", text: "上游权限已撤销或连接已重建，本次结果未转发。" }] };
      }
      this.#watchResult(state, result);
      const serialized = JSON.stringify(result ?? {});
      if (serialized.length > MAX_RESULT_BYTES) {
        return { isError: true, content: [{ type: "text", text: `上游结果超过 ${Math.round(MAX_RESULT_BYTES / 1000)} KB，未转发。` }] };
      }
      return result;
    } catch (error) {
      const elapsed = Date.now() - startedAt;
      const { category, message } = classifyExternalMcpError(error);
      if (signal?.aborted) {
        // 调用方取消救不了卡住的上游（windows-mcp 的 UIA 线程照样卡着，下一个调用会排在它后面），跑得够久就按卡死回收
        if (config.stallAfter !== undefined && elapsed >= config.stallAfter * 1000) {
          this.#recycle(state, `${binding.upstreamName} 跑了 ${Math.round(elapsed / 1000)} 秒后被调用方取消`);
        }
        return { isError: true, content: [{ type: "text", text: message }] };
      }
      // 按「跑满了超时」判卡死，不按错误类别：先到点的往往是 SDK 自己的请求超时（McpError -32001），归类不出 timeout
      const stalled = elapsed >= callMs - 100;
      this.#recycle(state, stalled ? `${binding.upstreamName} 超过 ${Math.round(callMs / 1000)} 秒未返回` : `${binding.upstreamName} 调用失败（${category}）`);
      // 只回显归类后的说明，不回显上游原始 message（可能含凭据）
      return { isError: true, content: [{ type: "text", text: stalled ? stallMessage(config, binding.upstreamName, callMs) : message }] };
    } finally {
      this.#release(state);
    }
  }

  /** 拿到可用连接；上游刚被回收、正在重连就等它（连接本身有超时兜底），而不是直接报断开。 */
  async #live(id) {
    const current = this.states.get(id);
    if (current?.connection && !current.controller.signal.aborted) return current;
    const config = current?.config ?? await this.config.get(id);
    if (!config?.enabled || this.disposed) return null;
    try { return await this.#ensure(config); } catch { return null; }
  }

  /** 占一个并发名额。满了就按 queueTimeout 排队；返回 true / false（超时或取消）/ "recycled"（排队时上游被回收）。 */
  #acquire(state, signal) {
    if (state.active < (state.config.maxConcurrent ?? MAX_ACTIVE_CALLS)) {
      state.active++;
      return Promise.resolve(true);
    }
    const waitMs = Math.round((state.config.queueTimeout ?? 0) * 1000);
    if (!waitMs || signal?.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
      const waiter = {
        resolve: (outcome) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", drop);
          resolve(outcome);
        },
      };
      const drop = () => {
        const index = state.waiters.indexOf(waiter);
        if (index >= 0) state.waiters.splice(index, 1);
        waiter.resolve(false);
      };
      const timer = setTimeout(drop, waitMs);
      signal?.addEventListener("abort", drop, { once: true });
      state.waiters.push(waiter);
    });
  }

  /** 还名额：有人排队就直接转交给他（active 不变），否则 active--。 */
  #release(state) {
    const next = state.waiters.shift();
    if (next) next.resolve(true);
    else state.active = Math.max(0, state.active - 1);
  }

  /**
   * 只回收这一个上游：按进程树杀掉，马上在后台重连。绑定原样保留，调用方不用重新 tools/list，
   * 其它上游也不受影响（以前这里是 invalidate()，一个上游出错会把所有外部工具一起摘掉）。
   */
  #recycle(state, reason) {
    const id = state.config.id;
    if (this.disposed || this.states.get(id) !== state) return;
    const now = Date.now();
    const eager = now - (this.recycledAt.get(id) ?? 0) >= RECYCLE_EAGER_GAP_MS;
    this.recycledAt.set(id, now);
    this.log(`[external-mcp] ${id}: ${reason}，回收进程${eager ? "并后台重连" : "（刚回收过，等下次调用再连）"}`);
    this.cachedUntil = 0;
    void this.#discard(id).then(async () => {
      if (!eager || this.disposed || this.states.has(id)) return;
      try { await this.#ensure(state.config); }
      catch (error) { this.log(externalMcpErrorLogLine(id, "connect", error)); }
    });
  }

  /**
   * restartOn：上游一直回同一种它自己恢复不了的状态（比如 windows-mcp 的 CONTROL_UNAVAILABLE），持续 after 秒就回收。
   * 不只看 isError：windows-mcp 的 ControlStatus 是正常返回、正文里写着 "state": "unavailable"，它不能把计时清零。
   */
  #watchResult(state, result) {
    const rule = state.config.restartOn;
    if (!rule) return;
    const text = (result?.content ?? []).filter(part => part?.type === "text").map(part => part.text).join("\n");
    if (!text || !new RegExp(rule.pattern).test(text)) { state.badSince = undefined; return; }
    state.badSince ??= Date.now();
    if (Date.now() - state.badSince >= rule.after * 1000) this.#recycle(state, `持续 ${rule.after} 秒返回 ${rule.pattern}`);
  }

  #findBinding(serverId, upstreamName) {
    for (const binding of this.bindings.values()) {
      if (binding.serverId === serverId && binding.upstreamName === upstreamName) return binding;
    }
    return null;
  }

  /* ---------------- 探测（configure_mcp test） ---------------- */

  /** 真的连一次并拉工具清单，用实际结果回答「能不能用」。连完就关，不留连接。 */
  async probe(id) {
    const config = await this.config.get(id);
    if (!config) throw new Error(`没有名为 ${id} 的服务器`);
    const startedAt = Date.now();
    const connection = await connectExternalMcp(config, { firstConnectTimeoutMs: externalMcpTimeoutMs(config, "connect") });
    try {
      const tools = await deadline(connection.list(AbortSignal.timeout(externalMcpTimeoutMs(config, "list"))), externalMcpTimeoutMs(config, "list") + 200);
      return {
        ok: true,
        transport: connection.attempt,
        toolCount: tools.length,
        tools: tools.slice(0, 20).map(tool => tool.name),
        durationMs: Date.now() - startedAt,
      };
    } finally {
      await closeWithin(connection.close());
    }
  }
}

function failureOf(id, error) {
  const { status, message } = classifyExternalMcpError(error);
  return { error: message, status };
}
