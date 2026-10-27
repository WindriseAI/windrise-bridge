#!/usr/bin/env node
/**
 * Windrise 管理员代理（elevated broker）—— 独立可执行进程。
 *
 * 设计见 docs/research/admin-broker-review-2026-10-25.md（v2 规格）。这个进程**只**监听
 * 本机回环 TCP（127.0.0.1，端口由系统分配）：
 *   · 不监听 0.0.0.0，不开局域网端口；
 *   · 句柄文件里只有 host / port / 会话密钥 / pid，别的进程不知道密钥就连不上。
 *
 * 配置只来自安装目录里的 config.json（broker.mjs 的上一级目录）：
 *   { "allowedCwdRoots": ["<仓库>"], "handleFile": "C:\\ProgramData\\WindriseBroker\\handle\\broker-handle.json",
 *     "runDir": "C:\\ProgramData\\WindriseBroker\\run",
 *     "logFile": "C:\\ProgramData\\WindriseBroker\\broker.log" }
 * WINDRISE_BROKER_* 环境变量覆盖**只在 WINDRISE_BROKER_SELFTEST=1 时生效**；正常运行时
 * 忽略，免得环境变量被用来改路径。broker 不读仓库里的任何代码 / 配置。
 *
 * 句柄目录由 install-broker.ps1 创建并加固（Administrators / SYSTEM 完全控制，安装用户只读），
 * broker 自己绝不创建生产句柄目录，也不接受联接点 / 符号链接。
 *
 * 启动后会写句柄文件（0600）：
 *   { version: 2, host: "127.0.0.1", port, key, pid, createdAt }
 *
 * 协议（NDJSON，一行一条 JSON）：
 *   客户端：{type:"hello", key}
 *   broker：{type:"hello_ok", version:2}         密钥不对回 denied 后断开
 *   客户端：{type:"exec", id, command, cwd?}      cwd 可省略；给了就必须在 allowedCwdRoots 内
 *   broker：{type:"result", id, code, stdout, stderr, timed_out, duration_ms}
 *           {type:"needs_confirm", id, reason, command, expires_at}
 *           {type:"denied", id, reason}           明确毁灭性命令，连确认都不给
 *   客户端：{type:"confirm", id, command?}        command 只用来核对，不会替换 pending 里的命令
 *           {type:"cancel", id}
 *   broker：{type:"result"...} / {type:"expired"...} / {type:"cancelled"...} / {type:"error"...}
 *
 * 安全要点：
 *   · 握手：第一行必须是合法 JSON 的 hello；第一行不是 JSON、或以 HTTP 动词开头 →
 *     立即断开，**不回复任何内容**（防 HTTP 探测）。握手完成前不处理别的消息类型。
 *   · 确认绑定 id + 命令原文 + 时间戳；id 复用会被拒，命令不一致会被拒；确认一次即焚。
 *   · 执行用固定、干净的环境（不读客户端传来的 PATH / env）；cwd 用 realpath 解析后
 *     必须仍在 allowedCwdRoots 内（挡住联接点 / 符号链接指到外面）。
 *   · 命令文件写进受保护的 runDir（wx 创建，随机名），broker 把命令文本的 SHA-256 传给
 *     PowerShell 引导脚本；引导脚本只读一次文件、在内存里算哈希，不一致 exit 3。
 *   · 启动时用 icacls 核对 runDir 权限：只有 Administrators / SYSTEM 可写，否则拒绝启动。
 *   · 日志用内置脱敏规则；会话密钥既不打日志，也额外作为秘密值兜底。
 */

import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { appendFile, chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyForBroker } from "../core/broker-policy.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const IS_WINDOWS = process.platform === "win32";
/** 只有自测进程会设置它；生产运行时所有 WINDRISE_BROKER_* 覆盖一律忽略。 */
const SELFTEST = process.env.WINDRISE_BROKER_SELFTEST === "1";
/** 仅自测：连「自测时允许 mkdir 句柄目录」也关掉，用来验证生产路径下目录不存在会拒绝启动。 */
const SELFTEST_NO_HANDLE_MKDIR = SELFTEST && process.env.WINDRISE_BROKER_SELFTEST_NO_HANDLE_MKDIR === "1";

/* ------------------------------------------------------------------ *
 * runDir 权限核对（纯函数；也用于自测子进程）
 * ------------------------------------------------------------------ */

/**
 * icacls 输出里「写」相关权限位的数值掩码：
 *   FileSystemRights: Write=278, DeleteSubdirectoriesAndFiles=64, Delete=65536,
 *   ChangePermissions=262144, TakeOwnership=524288
 * 这些任意一位出现，就等于该主体能改目录内容 / 改 ACL。
 */
const WRITE_RIGHTS_MASK = 278 + 64 + 65536 + 262144 + 524288;

/** icacls 会把内置组显示成本地化名字；这里认常见写法 + 明确 SID 写法。 */
function isTrustedPrincipal(name) {
  const raw = String(name ?? "").trim().replace(/^["']|["']$/g, "").toUpperCase();
  if (!raw) return false;
  if (raw === "BUILTIN\\ADMINISTRATORS" || raw === "ADMINISTRATORS") return true;
  if (raw === "NT AUTHORITY\\SYSTEM" || raw === "SYSTEM") return true;
  if (/^\*?S-1-5-32-544$/.test(raw) || /^\*?S-1-5-18$/.test(raw)) return true;
  const last = raw.split("\\").pop();
  if (["ADMINISTRATORS", "ADMINISTRATOREN", "ADMINISTRATEURS", "ADMINISTRADORES",
    "AMMINISTRATORI", "ADMINISTRATORZY"].includes(last)) return true;
  if (["SYSTEM", "SISTEMA", "SYSTÈME", "СИСТЕМА", "系统"].includes(last)) return true;
  return false;
}

/**
 * 解析 icacls 输出并判断 runDir 是否「只有 Administrators / SYSTEM 可写」。
 * 纯函数，方便单测：正确输出 → {ok:true}；任何非管理员主体有写权限 → {ok:false, reason}。
 *
 * @param {string} icaclsText icacls 的原始输出
 * @param {string} runDir 被检查的目录（用来剥掉第一行前面的路径）
 * @returns {{ok: boolean, reason: string}}
 */
function evaluateRunDirAcl(icaclsText, runDir) {
  const text = String(icaclsText ?? "");
  const runKey = String(runDir ?? "").trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  const aces = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // 成功 / 失败统计行、提示行
    if (/^(?:Successfully processed|Failed processing|已成功处理|处理失败|processed file)/i.test(line)) continue;
    // ACE：principal:(FLAGS)(RIGHTS)...；路径里的 C: 后面是 \，不会被误当 ACE
    const match = /^(.*?):((?:\([^)]*\))+)/.exec(line);
    if (!match) continue;

    let principal = match[1].trim();
    if (runKey && principal.replace(/\//g, "\\").toLowerCase().startsWith(runKey)) {
      principal = principal.slice(runKey.length).trim();
    }
    principal = principal.replace(/^["']|["']$/g, "").trim();
    if (!principal) continue;

    const tokens = [...match[2].matchAll(/\(([^)]*)\)/g)].map((item) => item[1].trim().toUpperCase());
    // 拒绝 ACE 只会减少权限，不构成「可写」
    if (tokens.includes("DENY") || tokens.includes("拒绝")) continue;

    let rights = 0;
    for (const token of tokens) {
      switch (token) {
        case "F":
        case "FULLCONTROL":
          rights |= 278 + 64 + 65536 + 262144 + 524288;
          break;
        case "M":
        case "MODIFY":
          rights |= 278 + 65536;
          break;
        case "W":
        case "WRITE":
          rights |= 278;
          break;
        case "WD":
        case "WRITEDATA":
        case "CREATEFILES":
          rights |= 2;
          break;
        case "AD":
        case "APPENDDATA":
        case "CREATEDIRECTORIES":
          rights |= 4;
          break;
        case "WA":
        case "WRITEATTRIBUTES":
          rights |= 256;
          break;
        case "D":
        case "DELETE":
          rights |= 65536;
          break;
        case "DC":
        case "DELETECHILD":
        case "DELETESUBDIRECTORIESANDFILES":
          rights |= 64;
          break;
        case "WDAC":
        case "CHANGEPERMISSIONS":
          rights |= 262144;
          break;
        case "WO":
        case "TAKEOWNERSHIP":
          rights |= 524288;
          break;
        default:
          break;
      }
    }

    aces.push({ principal, trusted: isTrustedPrincipal(principal), writable: (rights & WRITE_RIGHTS_MASK) !== 0 });
  }

  if (!aces.length) {
    return { ok: false, reason: "读不到任何 ACE（icacls 输出为空或格式不认识），按不安全处理" };
  }
  if (!aces.some((ace) => ace.trusted)) {
    return { ok: false, reason: "没有 Administrators / SYSTEM 的 ACE，按不安全处理" };
  }
  for (const ace of aces) {
    if (!ace.trusted && ace.writable) {
      return { ok: false, reason: `非管理员主体 ${ace.principal} 对 runDir 有写权限` };
    }
  }
  return { ok: true, reason: "只有 Administrators / SYSTEM 可写" };
}

/**
 * 自测专用的「核对函数」入口：
 *   WINDRISE_BROKER_SELFTEST=1 WINDRISE_BROKER_SELFTEST_ACL=1 node broker.mjs
 * 从 stdin 读 icacls 文本，打印 JSON，ok=true 退出 0，否则退出 4。
 */
if (SELFTEST && process.env.WINDRISE_BROKER_SELFTEST_ACL === "1") {
  const icaclsText = readFileSync(0, "utf8");
  const target = process.env.WINDRISE_BROKER_SELFTEST_ACL_PATH?.trim() || "C:\\ProgramData\\WindriseBroker\\run";
  const verdict = evaluateRunDirAcl(icaclsText, target);
  console.log(JSON.stringify(verdict));
  process.exit(verdict.ok ? 0 : 4);
}

/* ------------------------------------------------------------------ *
 * 配置（安装目录 config.json；环境变量只给自测）
 * ------------------------------------------------------------------ */

function configError(message) {
  const error = new Error(message);
  error.code = "BROKER_CONFIG";
  return error;
}

function loadConfig() {
  const envConfig = SELFTEST ? process.env.WINDRISE_BROKER_CONFIG?.trim() : "";
  const configFile = envConfig
    ? path.resolve(envConfig)
    : path.resolve(MODULE_DIR, "..", "config.json");

  let raw;
  try {
    raw = readFileSync(configFile, "utf8");
  } catch (error) {
    throw configError(`读不到配置文件 ${configFile}（${error.code ?? error.message}）。请重新运行 install-broker.ps1。`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configError(`配置文件 ${configFile} 不是合法 JSON。请重新运行 install-broker.ps1。`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw configError(`配置文件 ${configFile} 必须是 JSON 对象。`);
  }

  const pickEnv = (name, fallback) => {
    const value = SELFTEST ? process.env[name] : undefined;
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  };

  const roots = parsed.allowedCwdRoots;
  if (!Array.isArray(roots) || roots.length === 0) {
    throw configError("config.json 的 allowedCwdRoots 必须是非空数组。");
  }
  for (const root of roots) {
    if (typeof root !== "string" || !root.trim() || !path.isAbsolute(root.trim())) {
      throw configError(`config.json 的 allowedCwdRoots 里有不合法的路径：${String(root)}`);
    }
  }

  const requireField = (name) => {
    const value = parsed[name];
    if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value.trim())) {
      throw configError(`config.json 的 ${name} 必须是绝对路径。`);
    }
    return path.resolve(value.trim());
  };

  return {
    allowedCwdRoots: roots.map((root) => path.resolve(root.trim())),
    handleFile: path.resolve(pickEnv("WINDRISE_BROKER_HANDLE", requireField("handleFile"))),
    runDir: path.resolve(pickEnv("WINDRISE_BROKER_RUN_DIR", requireField("runDir"))),
    logFile: path.resolve(pickEnv("WINDRISE_BROKER_LOG", requireField("logFile"))),
  };
}

const CONFIG = (() => {
  try {
    return loadConfig();
  } catch (error) {
    console.error(`windrise broker 启动失败：${error?.message ?? error}`);
    process.exit(1);
  }
})();

const HANDLE_FILE = CONFIG.handleFile;
const LOG_FILE = CONFIG.logFile;
const RUN_DIR = CONFIG.runDir;
const HOST = "127.0.0.1";

/** 待确认命令默认 5 分钟过期。 */
const PENDING_TTL_MS = clamp(
  Number(SELFTEST ? process.env.WINDRISE_BROKER_PENDING_TTL_MS : "") || 5 * 60 * 1000,
  500,
  24 * 60 * 60 * 1000
);
/** 单条命令最长执行时间。 */
const EXEC_TIMEOUT_MS = clamp(
  Number(SELFTEST ? process.env.WINDRISE_BROKER_EXEC_TIMEOUT_MS : "") || 120_000,
  1_000,
  600_000
);
const HELLO_TIMEOUT_MS = 5_000;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_COMMAND_CHARS = 100_000;
const MAX_OUTPUT_BYTES = 1_000_000;
const MAX_PENDING = 100;
const LOG_TEXT_CHARS = 4_000;
/** 握手第一行以这些 HTTP 动词开头 → 立即断开（防 HTTP 探测）。 */
const HTTP_VERB_LINE = /^\s*(?:GET|POST|PUT|HEAD|OPTIONS|CONNECT|TRACE|PATCH|DELETE)\s/i;

const SESSION_KEY = randomBytes(32).toString("base64url");

const STARTED_AT = Date.now();
const pending = new Map(); // id -> { id, command, cwd, reason, createdAt, expiresAt }
const sockets = new Set();
const children = new Set();
const allowedRoots = CONFIG.allowedCwdRoots.map((dir) => {
  let real = dir;
  try { real = realpathSync(dir); } catch { /* 不存在就先用原路径；cwd 检查时目标也一定不存在 */ }
  return { dir, key: compareKey(real) };
});

/* ------------------------------------------------------------------ *
 * 脱敏日志（不依赖仓库里的任何文件）
 * ------------------------------------------------------------------ */

function fallbackRedact(text) {
  return String(text)
    .replace(/\b(https?:\/\/[^\s<>"'`]+)[?#][^\s<>"'`]*/gi, "$1?<已省略>")
    .replace(/(\/(?:mcp|healthz)\/)[^\s/?#"'<>，。；、（）()[\]{}]+/gi, "$1<令牌>")
    .replace(/\beyJ[A-Za-z0-9_-]{17,}/g, "<令牌>")
    .replace(/(TUNNEL_TOKEN\s*=\s*)(["']?)[^\s"'&]+\2/gi, "$1<令牌>")
    .replace(/(--token(?:\s+|=))(["']?)[^\s"']+\2/gi, "$1<令牌>")
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1<令牌>");
}

function sanitizeLogText(text) {
  let out = fallbackRedact(String(text ?? ""));
  // 会话密钥绝不能落盘
  out = out.split(SESSION_KEY).join("<令牌>");
  // 补上最常见的口令写法（命令原文本身也会进日志）
  out = out.replace(/(["']?\b(?:password|passwd|pwd|secret|(?:access|refresh|auth|id)?[_-]?token|api[_-]?key)["']?\s*[:=]\s*)(["']?)[^\s"',;}]+\2/gi, "$1<已打码>");
  out = out.replace(/(--?(?:password|passwd|pwd|secret|(?:access|refresh|auth|id)?[_-]?token|api[_-]?key)\s+)(["']?)[^\s"',;}]+\2/gi, "$1<已打码>");
  return out.replace(/\r?\n/g, " ⏎ ");
}

let logChain = Promise.resolve();
function log(line) {
  const text = sanitizeLogText(line).slice(0, LOG_TEXT_CHARS);
  const entry = `${new Date().toISOString()} ${text}\n`;
  logChain = logChain.then(async () => {
    try {
      await mkdir(path.dirname(LOG_FILE), { recursive: true, mode: 0o700 });
      await appendFile(LOG_FILE, entry, { encoding: "utf8", mode: 0o600 });
    } catch { /* 日志写不进去不能影响代理 */ }
  }).catch(() => {});
  return logChain;
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}

function requestError(message, code = "BROKER_BAD_REQUEST") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}

function send(socket, payload) {
  if (!socket || socket.destroyed || !socket.writable) return false;
  try {
    socket.write(`${JSON.stringify(payload)}\n`);
    return true;
  } catch {
    return false;
  }
}

function sendThenClose(socket, payload) {
  if (!socket || socket.destroyed) return;
  try {
    socket.end(`${JSON.stringify(payload)}\n`, () => {
      setTimeout(() => { try { socket.destroy(); } catch { /* 已经关了 */ } }, 150).unref?.();
    });
  } catch {
    try { socket.destroy(); } catch { /* 已经关了 */ }
  }
}

function checkSessionKey(candidate) {
  if (typeof candidate !== "string" || !candidate) return false;
  const left = createHash("sha256").update(candidate, "utf8").digest();
  const right = createHash("sha256").update(SESSION_KEY, "utf8").digest();
  return timingSafeEqual(left, right);
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 路径比较键：Windows 下统一反斜杠、去掉 \\?\ 前缀、去尾部斜杠、小写；
 * POSIX 下保持大小写、只去尾部斜杠。两边都用 path.resolve/realpath 的结果。
 */
function compareKey(value) {
  let out = String(value ?? "");
  if (IS_WINDOWS) {
    out = out.replace(/\//g, "\\");
    out = out.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
    out = out.replace(/\\+$/, "");
    return out.toLowerCase();
  }
  out = out.replace(/\/+$/, "");
  return out || "/";
}

function isInsideKey(targetKey, rootKey) {
  if (!targetKey || !rootKey) return false;
  if (targetKey === rootKey) return true;
  const separator = IS_WINDOWS ? "\\" : "/";
  if (rootKey === separator) return targetKey.startsWith(separator);
  return targetKey.startsWith(`${rootKey}${separator}`);
}

async function defaultCwd() {
  for (const root of allowedRoots) {
    const info = await stat(root.dir).catch(() => null);
    if (info?.isDirectory()) return root.dir;
  }
  throw requestError("allowedCwdRoots 里没有可用的工作目录");
}

/**
 * cwd 校验：路径解析 + realpath（挡联接点 / 符号链接）+ 必须在 allowedCwdRoots 内。
 * 防 `..` 由 path.resolve + realpath 共同完成。
 */
async function resolveCwd(input) {
  const base = await defaultCwd();
  let raw = input === undefined || input === null || input === "" ? base : String(input).trim();
  if (!raw || raw.includes("\u0000")) throw requestError("cwd 不合法");
  // 和 run_command 的习惯一致：/d/work → D:\work（Git Bash 写法）
  if (IS_WINDOWS) {
    const drive = /^\/([A-Za-z])(\/|$)/.exec(raw);
    if (drive) raw = `${drive[1]}:\\${raw.slice(3)}`;
  }
  const abs = path.resolve(base, raw);
  let real;
  try {
    real = await realpath(abs);
  } catch {
    throw requestError(`cwd 不存在或无法解析：${abs}`);
  }
  const info = await stat(real).catch(() => null);
  if (!info?.isDirectory()) throw requestError(`cwd 不存在或不是目录：${abs}`);

  const key = compareKey(real);
  if (!allowedRoots.some((root) => isInsideKey(key, root.key))) {
    throw requestError(`cwd 越界：${abs}（真实路径 ${real}）。管理员代理只允许在配置的 allowedCwdRoots 内执行。`);
  }
  return real;
}

/** 固定、干净的环境：只从 broker 自己的受信环境取少量系统变量，客户端传什么都不看。 */
function cleanEnv(extra = {}) {
  if (IS_WINDOWS) {
    const root = process.env.SystemRoot || "C:\\Windows";
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const dirs = [
      path.dirname(process.execPath),
      path.join(root, "System32"),
      root,
      path.join(root, "System32", "Wbem"),
      path.join(root, "System32", "WindowsPowerShell", "v1.0"),
      path.join(root, "System32", "OpenSSH"),
    ].filter(Boolean);
    return {
      SystemRoot: root,
      windir: root,
      SystemDrive: process.env.SystemDrive || "C:",
      ComSpec: path.join(root, "System32", "cmd.exe"),
      PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC",
      PATH: [...new Set(dirs)].join(";"),
      TEMP: process.env.TEMP || os.tmpdir(),
      TMP: process.env.TMP || os.tmpdir(),
      USERPROFILE: process.env.USERPROFILE || os.homedir(),
      APPDATA: process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      LOCALAPPDATA: process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      HOMEDRIVE: process.env.HOMEDRIVE || "",
      HOMEPATH: process.env.HOMEPATH || "",
      USERNAME: process.env.USERNAME || "",
      USERDOMAIN: process.env.USERDOMAIN || "",
      COMPUTERNAME: process.env.COMPUTERNAME || "",
      ProgramData: process.env.ProgramData || path.join(root, "ProgramData"),
      ProgramFiles: programFiles,
      "ProgramFiles(x86)": programFilesX86,
      PSModulePath: process.env.PSModulePath || "",
      ...extra,
    };
  }
  return {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: os.homedir(),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TMPDIR: os.tmpdir(),
    ...extra,
  };
}

/**
 * PowerShell 引导：只读一次命令文件（ReadAllBytes），在内存里算 SHA-256，
 * 和 broker 传入的哈希比对；不一致直接 exit 3，绝不执行文件里的内容。
 */
const PS_BOOTSTRAP = [
  "$ProgressPreference = 'SilentlyContinue'",
  "$ErrorActionPreference = 'Continue'",
  "try { [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8 } catch {}",
  "$global:LASTEXITCODE = 0",
  "$__text = $null; $__sb = $null",
  "try { $__bytes = [IO.File]::ReadAllBytes($env:WINDRISE_BROKER_CMD_FILE) } catch { [Console]::Error.WriteLine('读取命令文件失败：' + $_.Exception.Message); exit 4 }",
  "try {",
  "  $__sha = [Security.Cryptography.SHA256]::Create()",
  "  try { $__hash = -join ($__sha.ComputeHash($__bytes) | ForEach-Object { $_.ToString('x2') }) } finally { $__sha.Dispose() }",
  "  if ($__hash -ne $env:WINDRISE_BROKER_CMD_SHA256) { [Console]::Error.WriteLine('命令文件哈希不符（文件可能在写入后被替换），拒绝执行'); exit 3 }",
  "  $__text = [Text.Encoding]::UTF8.GetString($__bytes)",
  "  $__sb = [ScriptBlock]::Create($__text)",
  "} catch {",
  "  $__e = if ($_.Exception.InnerException) { $_.Exception.InnerException } else { $_.Exception }",
  "  [Console]::Error.WriteLine('命令语法错误：' + $__e.Message)",
  "  exit 2",
  "}",
  "$__ok = $true",
  "try { . $__sb; $__ok = $? } catch { [Console]::Error.WriteLine(($_ | Out-String).Trim()); $__ok = $false }",
  "if ($LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $__ok) { exit 1 } else { exit 0 }",
].join("\n");
const PS_ENCODED = Buffer.from(PS_BOOTSTRAP, "utf16le").toString("base64");

function brokerShell() {
  if (!IS_WINDOWS) {
    // POSIX 自测路径把命令从 stdin 交给 sh（不落盘，也没有替换窗口）。
    return { file: existsSync("/bin/sh") ? "/bin/sh" : "/bin/bash", args: ["-s"], viaStdin: true };
  }
  const pwsh = process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe") : null;
  const systemPowerShell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const file = (pwsh && existsSync(pwsh)) ? pwsh : (existsSync(systemPowerShell) ? systemPowerShell : "powershell.exe");
  return {
    file,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-OutputFormat", "Text", "-EncodedCommand", PS_ENCODED],
    viaStdin: false,
  };
}

/** 按行解码：UTF-8 不行再试 GBK（Windows 上老程序常输出 GBK）。 */
let gbkDecoder = null;
function decodeOutput(buf) {
  if (!buf.length) return "";
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  try { return utf8.decode(buf); } catch { /* 有非 UTF-8 的行 */ }
  if (!gbkDecoder) {
    try { gbkDecoder = new TextDecoder("gbk"); } catch { gbkDecoder = new TextDecoder("utf-8"); }
  }
  const parts = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i += 1) {
    if (i !== buf.length && buf[i] !== 0x0a) continue;
    const line = buf.subarray(start, Math.min(i + 1, buf.length));
    try { parts.push(utf8.decode(line)); } catch { parts.push(gbkDecoder.decode(line)); }
    start = i + 1;
  }
  return parts.join("");
}

/** 只留最后 MAX_OUTPUT_BYTES 字节（错误信息通常在尾部）。 */
function tailCollector(limit) {
  const chunks = [];
  let bytes = 0;
  return {
    push(chunk) {
      if (!chunk?.length) return;
      chunks.push(chunk);
      bytes += chunk.length;
      while (bytes > limit && chunks.length > 1) bytes -= chunks.shift().length;
      if (bytes > limit && chunks.length === 1) {
        const only = chunks[0];
        chunks[0] = only.subarray(only.length - limit);
        bytes = limit;
      }
    },
    text() {
      return decodeOutput(Buffer.concat(chunks));
    },
    get bytes() { return bytes; },
  };
}

function killTree(child) {
  if (!child?.pid) return;
  try { child.kill("SIGKILL"); } catch { /* 已经退出 */ }
  if (IS_WINDOWS) {
    execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* 已经退出 */ }
  }
}

/**
 * 在受保护的 runDir 里用 wx（必须新建）创建随机名的命令文件。
 * 返回 { file, sha256 }；sha256 是 broker 内存里命令文本的哈希，用来防「写完被替换」。
 */
async function writeCommandFile(command) {
  const extension = IS_WINDOWS ? ".ps1" : ".sh";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const file = path.join(RUN_DIR, `cmd-${randomBytes(16).toString("hex")}${extension}`);
    let handle;
    try {
      handle = await open(file, "wx", 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw error;
    }
    try {
      await handle.writeFile(Buffer.from(command, "utf8"));
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { file, sha256: sha256Hex(command) };
  }
  throw new Error("无法在 runDir 创建命令文件（连续随机名冲突或目录不可写）");
}

/** 仅自测：读 runDir 里的暂停标记，在「写完命令文件」和「启动 PowerShell」之间留出竞态窗口。 */
async function selftestCommandPause() {
  if (!SELFTEST) return;
  try {
    const raw = await readFile(path.join(RUN_DIR, "selftest-pause-ms"), "utf8");
    const ms = Number(raw.trim());
    if (Number.isFinite(ms) && ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 15_000)));
    }
  } catch { /* 没有标记文件就是不停顿 */ }
}

async function executeCommand(command, cwd) {
  const started = Date.now();
  const shell = brokerShell();
  const stdout = tailCollector(MAX_OUTPUT_BYTES);
  const stderr = tailCollector(MAX_OUTPUT_BYTES);

  let scriptFile = null;
  const env = cleanEnv();
  if (IS_WINDOWS) {
    const written = await writeCommandFile(command);
    scriptFile = written.file;
    env.WINDRISE_BROKER_CMD_FILE = written.file;
    env.WINDRISE_BROKER_CMD_SHA256 = written.sha256;
    await selftestCommandPause();
  }

  return new Promise((resolve) => {
    let finished = false;
    let timedOut = false;
    let killFallback = null;
    let child;
    try {
      child = spawn(shell.file, shell.args, {
        cwd,
        env,
        windowsHide: true,
        detached: !IS_WINDOWS,
        stdio: [shell.viaStdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (error) {
      if (scriptFile) rm(scriptFile, { force: true }).catch(() => {});
      resolve({ code: null, stdout: "", stderr: `启动终端失败：${error.message}`, timedOut: false, durationMs: Date.now() - started });
      return;
    }

    if (shell.viaStdin) {
      try { child.stdin.end(command, "utf8"); } catch { /* 子进程已经退出 */ }
    }

    children.add(child);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // taskkill 之后 close 迟迟不来时，最多再等 5 秒就返回（不让调用方一直挂着）
      killFallback = setTimeout(() => finish(null, null), 5_000);
      killFallback.unref?.();
    }, EXEC_TIMEOUT_MS);
    timer.unref?.();

    const finish = (code, error) => {
      if (finished) return;
      finished = true;
      children.delete(child);
      clearTimeout(timer);
      if (killFallback) clearTimeout(killFallback);
      if (error) stderr.push(Buffer.from(`\n[执行失败] ${error.message}\n`, "utf8"));
      const result = {
        code: typeof code === "number" ? code : null,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        durationMs: Date.now() - started,
      };
      if (scriptFile) rm(scriptFile, { force: true }).catch(() => {});
      resolve(result);
    };

    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code, null));
  });
}

async function runInCwd(command, cwd) {
  return executeCommand(command, cwd);
}

/* ------------------------------------------------------------------ *
 * 握手 / 协议
 * ------------------------------------------------------------------ */

function handleConnection(socket) {
  sockets.add(socket);
  socket.setEncoding("utf8");
  socket.setNoDelay?.(true);

  let buffer = "";
  let authed = false;
  const helloTimer = setTimeout(() => {
    if (authed) return;
    sendThenClose(socket, { type: "denied", reason: "没有在时限内完成握手" });
  }, HELLO_TIMEOUT_MS);
  helloTimer.unref?.();

  const closeSilently = () => {
    clearTimeout(helloTimer);
    try { socket.destroy(); } catch { /* 已经关闭 */ }
  };

  socket.on("data", (chunk) => {
    if (socket.destroyed) return;
    buffer += chunk;

    // 握手前看到 HTTP 动词 → 立刻断开，一个字节都不回。
    if (!authed && HTTP_VERB_LINE.test(buffer)) {
      void log("握手前收到 HTTP 探测，已立即断开");
      closeSilently();
      return;
    }

    if (buffer.length > MAX_LINE_BYTES) {
      if (!authed) closeSilently();
      else sendThenClose(socket, { type: "error", reason: "消息太长" });
      return;
    }

    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const rawLine = buffer.slice(0, index);
      const line = rawLine.replace(/\r$/, "");
      buffer = buffer.slice(index + 1);

      if (!authed) {
        if (!line.trim()) continue;
        // 第一行不是合法 JSON（含 HTTP 请求行）→ 立即断开，不回任何内容。
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          void log("握手第一行不是合法 JSON，已立即断开");
          closeSilently();
          return;
        }
        if (message?.type !== "hello" || !checkSessionKey(message.key)) {
          void log("hello 被拒（密钥不符或格式不对）");
          sendThenClose(socket, { type: "denied", reason: "密钥不符" });
          return;
        }
        authed = true;
        clearTimeout(helloTimer);
        send(socket, { type: "hello_ok", version: 2 });
        void log("客户端已通过握手");
        continue;
      }

      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        send(socket, { type: "error", reason: "不是合法的 JSON" });
        continue;
      }
      Promise.resolve()
        .then(() => handleMessage(message, socket))
        .catch((error) => {
          send(socket, { type: "error", id: validId(message?.id) ? message.id : null, reason: error.message });
        });
    }
  });

  socket.on("error", () => { /* 客户端断开很常见，不当异常 */ });
  socket.on("close", () => {
    clearTimeout(helloTimer);
    sockets.delete(socket);
  });
}

async function handleMessage(message, socket) {
  if (!message || typeof message !== "object") throw requestError("消息必须是 JSON 对象");
  switch (message.type) {
    case "exec": return onExec(message, socket);
    case "confirm": return onConfirm(message, socket);
    case "cancel": return onCancel(message, socket);
    case "ping": return send(socket, { type: "pong" });
    case "hello": return send(socket, { type: "error", reason: "已经握手过了" });
    default: return send(socket, { type: "error", id: validId(message.id) ? message.id : null, reason: `未知消息类型：${String(message.type)}` });
  }
}

async function onExec(message, socket) {
  if (!validId(message.id)) throw requestError("exec 需要 id（1~200 字符）");
  const id = message.id;
  if (typeof message.command !== "string" || !message.command.trim()) throw requestError("command 不能为空");
  if (message.command.length > MAX_COMMAND_CHARS) throw requestError(`command 太长（上限 ${MAX_COMMAND_CHARS} 字符）`);

  const command = message.command.replace(/\r\n?/g, "\n");
  const verdict = classifyForBroker(command);
  // 分级器出了意外（返回值不对）时按失败处理，绝不默认 auto。
  if (verdict?.tier !== "auto" && verdict?.tier !== "confirm" && verdict?.tier !== "never") {
    throw requestError(`分级器返回了未知档位：${String(verdict?.tier)}`, "BROKER_POLICY_ERROR");
  }
  await log(`exec id=${id} tier=${verdict.tier} base=${verdict.baseLevel} command=${command}`);

  if (verdict.tier === "never") {
    send(socket, { type: "denied", id, reason: verdict.reason });
    return;
  }

  const cwd = await resolveCwd(message.cwd);

  if (verdict.tier === "confirm") {
    if (pending.has(id)) {
      throw requestError("该 id 已经有一条待确认命令，先确认或取消，不能复用 id");
    }
    if (pending.size >= MAX_PENDING) {
      throw requestError("待确认命令太多，先处理或等它过期");
    }
    const now = Date.now();
    const entry = {
      id,
      command,
      cwd,
      reason: verdict.reason,
      createdAt: now,
      expiresAt: now + PENDING_TTL_MS,
    };
    pending.set(id, entry);
    await log(`needs_confirm id=${id} reason=${verdict.reason} expires=${new Date(entry.expiresAt).toISOString()}`);
    send(socket, {
      type: "needs_confirm",
      id,
      reason: verdict.reason,
      command,
      expires_at: new Date(entry.expiresAt).toISOString(),
    });
    return;
  }

  await log(`auto id=${id} reason=${verdict.reason}`);
  const result = await runInCwd(command, cwd);
  await log(`result id=${id} code=${result.code} timed_out=${result.timedOut} stdout=${result.stdout} stderr=${result.stderr}`);
  send(socket, { type: "result", id, ...result });
}

async function onConfirm(message, socket) {
  if (!validId(message.id)) throw requestError("confirm 需要 id（1..200 字符）");
  const id = message.id;
  const entry = pending.get(id);
  if (!entry) {
    throw requestError("没有待确认的命令（可能已经执行、取消或过期）；请重新用 admin_run 发起");
  }
  if (entry.expiresAt <= Date.now()) {
    pending.delete(id);
    await log(`expired id=${id}`);
    send(socket, { type: "expired", id, reason: "待确认命令已过期，请重新发起" });
    return;
  }
  if (message.command !== undefined) {
    if (typeof message.command !== "string" || message.command.replace(/\r\n?/g, "\n") !== entry.command) {
      await log(`confirm 命令不一致，拒绝 id=${id}`);
      throw requestError("pending_id 绑定的命令与提交的命令不一致，拒绝执行（原命令还在等待确认）");
    }
  }

  // 先删再执行：无论执行成功、失败还是进程崩了，这个 id 都不能再用第二次
  pending.delete(id);
  await log(`confirm id=${id} command=${entry.command}`);

  try {
    const cwd = await resolveCwd(entry.cwd);
    const result = await runInCwd(entry.command, cwd);
    await log(`result id=${id} code=${result.code} timed_out=${result.timedOut} stdout=${result.stdout} stderr=${result.stderr}`);
    send(socket, { type: "result", id, ...result });
  } catch (error) {
    await log(`confirm 执行失败 id=${id} reason=${error.message}`);
    send(socket, { type: "error", id, reason: error.message });
  }
}

async function onCancel(message, socket) {
  if (!validId(message.id)) throw requestError("cancel 需要 id（1..200 字符）");
  const id = message.id;
  if (!pending.delete(id)) throw requestError("没有这条待确认命令（可能已经执行、取消或过期）");
  await log(`cancelled id=${id}`);
  send(socket, { type: "cancelled", id });
}

function sweepPending() {
  const now = Date.now();
  for (const [id, entry] of pending) {
    if (entry.expiresAt <= now) {
      pending.delete(id);
      void log(`pending 过期丢弃 id=${id}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * runDir 权限自检（只用 icacls 读出来核对，不自我修复、不降级）
 * ------------------------------------------------------------------ */

function runIcacls(target) {
  return new Promise((resolve, reject) => {
    // 直接跑 icacls（不经过 cmd，避免 Windows 命令行引号把路径弄坏）。
    // icacls 的输出用控制台代码页；decodeOutput 先按 UTF-8、失败再按 GBK 解码。
    execFile("icacls.exe", [String(target)], {
      windowsHide: true,
      timeout: 15_000,
      encoding: "buffer",
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr?.length ? ` ${decodeOutput(Buffer.from(stderr)).trim()}` : "";
        reject(new Error(`icacls 执行失败：${error.message}${detail}`));
        return;
      }
      resolve(decodeOutput(Buffer.from(stdout ?? Buffer.alloc(0))));
    });
  });
}

async function verifyRunDirAcl() {
  const output = await runIcacls(RUN_DIR);
  return evaluateRunDirAcl(output, RUN_DIR);
}

/* ------------------------------------------------------------------ *
 * 句柄文件 / 生命周期
 * ------------------------------------------------------------------ */

function handlePayload(port) {
  return {
    version: 2,
    host: HOST,
    port,
    key: SESSION_KEY,
    pid: process.pid,
    createdAt: new Date(STARTED_AT).toISOString(),
  };
}

/**
 * 句柄目录由 install-broker.ps1 创建并加固，broker 不负责创建（免得普通用户预先
 * 把目录换成联接点，提权进程的写入 / 重命名被重定向到别处）。
 * 仅 SELFTEST 允许 mkdir，避免现有 e2e 依赖安装脚本。
 */
async function prepareHandleDir() {
  const dir = path.dirname(HANDLE_FILE);
  if (SELFTEST && !SELFTEST_NO_HANDLE_MKDIR) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  let info;
  try {
    info = await lstat(dir);
  } catch (error) {
    throw configError(`句柄目录不存在或无法访问：${dir}（${error.code ?? error.message}）。请重新运行 install-broker.ps1。`);
  }
  if (IS_WINDOWS && !SELFTEST && info.isSymbolicLink()) {
    throw configError(`句柄目录是符号链接 / 联接点：${dir}。管理员代理拒绝在可重定向的目录上启动，请删掉它并重新运行 install-broker.ps1。`);
  }
  if (!info.isDirectory()) {
    throw configError(`句柄路径不是目录：${dir}。请重新运行 install-broker.ps1。`);
  }
  if (IS_WINDOWS && !SELFTEST) {
    let real;
    try {
      real = await realpath(dir);
    } catch (error) {
      throw configError(`句柄目录无法解析真实路径：${dir}（${error.code ?? error.message}）。请重新运行 install-broker.ps1。`);
    }
    if (compareKey(real) !== compareKey(path.resolve(dir))) {
      throw configError(`句柄目录的真实路径不是它自己：${dir} → ${real}。管理员代理拒绝在可重定向的目录上启动，请重新运行 install-broker.ps1。`);
    }
  }
  return dir;
}

async function writeHandleFile(port) {
  const dir = path.dirname(HANDLE_FILE);
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) {
    throw configError(`句柄目录不存在或不是目录：${dir}。请重新运行 install-broker.ps1。`);
  }
  const temp = `${HANDLE_FILE}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(handlePayload(port), null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, HANDLE_FILE);
  await chmod(HANDLE_FILE, 0o600).catch(() => {});
}

async function removeOwnHandleFile() {
  try {
    const parsed = JSON.parse(await readFile(HANDLE_FILE, "utf8"));
    if (parsed?.version === 2 && parsed?.pid === process.pid && parsed?.key === SESSION_KEY
      && parsed?.host === HOST && parsed?.port === PORT) {
      await rm(HANDLE_FILE, { force: true });
    }
  } catch { /* 没有 / 坏了 / 被别人覆盖：都不动 */ }
}

async function shutdown(code = 0) {
  clearInterval(sweeper);
  for (const socket of sockets) {
    try { socket.destroy(); } catch { /* 已经关闭 */ }
  }
  for (const child of children) {
    try { killTree(child); } catch { /* 已经退出 */ }
  }
  await new Promise((resolve) => {
    try { server.close(() => resolve()); } catch { resolve(); }
  });
  await removeOwnHandleFile();
  await logChain;
  process.exit(code);
}

const server = net.createServer(handleConnection);
server.maxConnections = 32;
const sweeper = setInterval(sweepPending, Math.max(500, Math.min(30_000, Math.floor(PENDING_TTL_MS / 2))));
sweeper.unref?.();
let PORT = null;

process.on("SIGINT", () => { void shutdown(0); });
process.on("SIGTERM", () => { void shutdown(0); });
process.on("uncaughtException", (error) => {
  void log(`未捕获异常：${error?.stack ?? error?.message ?? error}`);
  void shutdown(1);
});
process.on("unhandledRejection", (error) => {
  void log(`未处理的 Promise 拒绝：${error?.stack ?? error?.message ?? error}`);
});

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

async function main() {
  await mkdir(path.dirname(LOG_FILE), { recursive: true, mode: 0o700 });
  await chmod(LOG_FILE, 0o600).catch(() => {});
  await mkdir(RUN_DIR, { recursive: true, mode: 0o700 });
  await prepareHandleDir();

  if (IS_WINDOWS && !SELFTEST) {
    const verdict = await verifyRunDirAcl();
    if (!verdict.ok) {
      const message = `runDir 权限核对失败：${verdict.reason}。为了避免命令文件被同机普通用户替换，管理员代理拒绝启动。请以管理员身份重新运行 install-broker.ps1。`;
      await log(message);
      console.error(message);
      process.exit(1);
    }
    await log(`runDir 权限核对通过：${verdict.reason}`);
  }

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen({ host: HOST, port: 0, exclusive: true }, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string" || address.address !== HOST) {
    throw new Error(`broker 没有监听在 ${HOST}（实际：${JSON.stringify(address)}）`);
  }
  PORT = address.port;

  await writeHandleFile(PORT);
  server.on("error", (error) => {
    void log(`server 错误：${error.message}`);
    void shutdown(1);
  });
  await log(`broker started pid=${process.pid} shell=${path.basename(brokerShell().file)} pending_ttl_ms=${PENDING_TTL_MS} run_dir=${RUN_DIR}`);
  // 只报 pid，不报端口 / 密钥
  console.log(`windrise broker ready (pid ${process.pid})`);
}

main().catch(async (error) => {
  try { await log(`broker 启动失败：${error?.stack ?? error?.message ?? error}`); } catch { /* 日志不可用 */ }
  try { await removeOwnHandleFile(); } catch { /* 忽略 */ }
  console.error(`windrise broker 启动失败：${error?.message ?? error}`);
  process.exit(1);
});
