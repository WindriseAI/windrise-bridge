/**
 * 管理员代理（elevated broker）的 Bridge 侧客户端。
 *
 * 设计见 docs/research/admin-broker-review-2026-10-25.md（v2）。Bridge 普通权限运行，需要提权时：
 *   1. 从 %ProgramData%\WindriseBroker\handle\broker-handle.json 读回环地址、端口和会话密钥
 *      （每次启动随机；目录由安装脚本加固，只有 Administrators / SYSTEM 可写）；
 *   2. 连 127.0.0.1 的 TCP 端口，先发 hello 验密钥；
 *   3. 发 exec 等结果 / 待确认 / 拒绝。
 *
 * 纪律：
 *   · broker 没在跑 / 连不上时**明确报「管理员代理未运行」**，绝不偷偷降级成普通权限执行；
 *   · 会话密钥只用于握手，不进日志、不进错误信息、不返回给模型；
 *   · 每次调用单独连一次（broker 重启后自动用新句柄，不用重连 Bridge）。
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const CONNECT_TIMEOUT_MS = 5_000;
const HELLO_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 130_000;
const MAX_LINE_BYTES = 2 * 1024 * 1024;

export class BrokerUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "BrokerUnavailableError";
    this.code = "BROKER_NOT_RUNNING";
  }
}

export class BrokerProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "BrokerProtocolError";
    this.code = "BROKER_PROTOCOL_ERROR";
  }
}

/**
 * Broker 和 Bridge 都认 WINDRISE_BROKER_HANDLE（自测用），否则就是安装脚本加固过的
 * %ProgramData%\WindriseBroker\handle\broker-handle.json。
 */
export function defaultBrokerHandleFile(env = process.env) {
  const explicit = env.WINDRISE_BROKER_HANDLE?.trim();
  if (explicit) return path.resolve(explicit);
  const programData = env.ProgramData?.trim() || "C:\\ProgramData";
  return path.join(programData, "WindriseBroker", "handle", "broker-handle.json");
}

function notRunningMessage(detail = "") {
  const suffix = detail ? `（${detail}）` : "";
  return `管理员代理未运行${suffix}。提权命令不会降级成普通权限执行。`
    + " 请先以管理员身份重新运行安装目录里的 install-broker.ps1（注册计划任务 WindriseElevatedBroker），"
    + "再运行 Start-ScheduledTask -TaskName WindriseElevatedBroker；启动后重试。";
}

function mapSocketError(error) {
  const code = error?.code ?? "";
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE" || code === "ENOTFOUND") {
    return new BrokerUnavailableError(notRunningMessage(`回环端口连不上${code ? `：${code}` : ""}`));
  }
  if (code === "EACCES" || code === "EPERM") {
    return new BrokerUnavailableError(`没有权限连接管理员代理（${code}）。请确认 broker 和 Bridge 是同一个用户启动的；不会降级为普通权限执行。`);
  }
  return new BrokerUnavailableError(notRunningMessage(`连接失败${code ? `：${code}` : ""}`));
}

/** 只接受回环地址：防止被篡改的句柄文件把提权命令引到别的机器。 */
function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "::1";
}

async function readHandle(handleFile) {
  let raw;
  try {
    raw = await readFile(handleFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new BrokerUnavailableError(notRunningMessage("找不到 %ProgramData%\\WindriseBroker\\handle\\broker-handle.json"));
    throw new BrokerUnavailableError(notRunningMessage(`句柄文件读不了：${error.code ?? error.message}`));
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 不回显文件内容（里面可能有密钥）
    throw new BrokerProtocolError("管理员代理句柄文件不是合法 JSON。请删除 %ProgramData%\\WindriseBroker\\handle\\broker-handle.json 后重启管理员代理。");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new BrokerProtocolError("管理员代理句柄文件格式不对。请删除它后重启管理员代理。");
  }
  if (parsed.version !== 2) {
    throw new BrokerProtocolError("管理员代理句柄文件版本不受支持（旧版命名管道句柄？）。请重启管理员代理，或重新运行 install-broker.ps1。");
  }
  if (typeof parsed.host !== "string" || !isLoopbackHost(parsed.host)) {
    throw new BrokerProtocolError("管理员代理句柄文件里的地址不是本机回环地址（只接受 127.0.0.1 / ::1）。请重启管理员代理。");
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BrokerProtocolError("管理员代理句柄文件里的端口不合法。请重启管理员代理。");
  }
  if (typeof parsed.key !== "string" || !parsed.key) {
    throw new BrokerProtocolError("管理员代理句柄文件里的会话密钥为空。请重启管理员代理。");
  }
  return { host: parsed.host, port, key: parsed.key };
}

function connectBroker(host, port) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new BrokerUnavailableError(notRunningMessage("连接超时")));
    }, CONNECT_TIMEOUT_MS);
    timer.unref?.();

    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(mapSocketError(error));
    });
  });
}

/** NDJSON 通道：按 id 等自己那条回应，别的消息留在队列里。 */
class LineChannel {
  #socket;
  #buffer = "";
  #queue = [];
  #waiters = [];
  #closed = false;
  #failure = null;

  constructor(socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("error", (error) => this.#fail(mapSocketError(error)));
    socket.on("close", () => this.#fail(new BrokerUnavailableError(notRunningMessage("连接中途断开"))));
  }

  #onData(chunk) {
    if (this.#closed) return;
    this.#buffer += chunk;
    if (this.#buffer.length > MAX_LINE_BYTES) {
      this.#fail(new BrokerProtocolError("管理员代理回的消息太长"));
      return;
    }
    let index;
    while ((index = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, index).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.#fail(new BrokerProtocolError("管理员代理回了不是 JSON 的消息"));
        return;
      }
      this.#deliver(message);
    }
  }

  #deliver(message) {
    for (let i = 0; i < this.#waiters.length; i += 1) {
      const waiter = this.#waiters[i];
      let matched = false;
      try { matched = waiter.predicate(message); } catch { matched = false; }
      if (!matched) continue;
      this.#waiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    this.#queue.push(message);
  }

  #fail(error) {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    try { this.#socket.destroy(); } catch { /* 已经关闭 */ }
  }

  send(payload) {
    if (this.#closed) throw this.#failure ?? new BrokerUnavailableError(notRunningMessage("连接已关闭"));
    this.#socket.write(`${JSON.stringify(payload)}\n`);
  }

  next(predicate, timeoutMs = REQUEST_TIMEOUT_MS) {
    for (let i = 0; i < this.#queue.length; i += 1) {
      if (!predicate(this.#queue[i])) continue;
      return Promise.resolve(this.#queue.splice(i, 1)[0]);
    }
    if (this.#closed) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new BrokerProtocolError("等待管理员代理回应超时（代理可能卡住或已退出）"));
      }, timeoutMs);
      waiter.timer.unref?.();
      this.#waiters.push(waiter);
    });
  }

  close() {
    this.#fail(new BrokerUnavailableError(notRunningMessage("客户端主动关闭")));
  }
}

async function withBroker(handleFile, fn) {
  const handle = await readHandle(handleFile);
  const socket = await connectBroker(handle.host, handle.port);
  const channel = new LineChannel(socket);
  try {
    channel.send({ type: "hello", key: handle.key });
    let hello;
    try {
      hello = await channel.next((message) => message?.type === "hello_ok" || message?.type === "denied", HELLO_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof BrokerUnavailableError) {
        throw new BrokerProtocolError("管理员代理鉴权失败或握手前退出（会话密钥不符 / broker 已重启）。请重启管理员代理后再试。");
      }
      throw error;
    }
    if (hello.type !== "hello_ok") {
      throw new BrokerProtocolError("管理员代理鉴权失败：会话密钥不符。请重启管理员代理后再试。");
    }
    return await fn(channel);
  } finally {
    channel.close();
  }
}

function normalizeReply(reply, request) {
  switch (reply?.type) {
    case "result":
      return {
        status: "executed",
        id: request.id,
        code: Number.isInteger(reply.code) ? reply.code : null,
        stdout: String(reply.stdout ?? ""),
        stderr: String(reply.stderr ?? ""),
        timedOut: reply.timed_out === true,
        durationMs: Number.isFinite(reply.duration_ms) ? reply.duration_ms : null,
      };
    case "needs_confirm":
      return {
        status: "needs_confirm",
        id: request.id,
        reason: String(reply.reason ?? ""),
        command: String(reply.command ?? request.command ?? ""),
        expiresAt: typeof reply.expires_at === "string" ? reply.expires_at : null,
      };
    case "denied":
      return { status: "denied", id: request.id, reason: String(reply.reason ?? "管理员代理拒绝执行") };
    case "expired":
      return { status: "expired", id: request.id, reason: String(reply.reason ?? "待确认命令已过期") };
    case "cancelled":
      return { status: "cancelled", id: request.id };
    case "error":
      return { status: "error", id: request.id, reason: String(reply.reason ?? "管理员代理报错") };
    default:
      throw new BrokerProtocolError(`管理员代理回了未知消息类型：${String(reply?.type)}`);
  }
}

function newRequestId() {
  return `adm_${randomUUID().replace(/-/g, "")}`;
}

function checkPendingId(value) {
  const id = String(value ?? "").trim();
  if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new BrokerProtocolError("pending_id 不合法。请传 admin_run 返回的 pending_id。");
  }
  return id;
}

/**
 * @param {object} [options]
 * @param {string} [options.handleFile] 默认 %ProgramData%\WindriseBroker\handle\broker-handle.json（可用 WINDRISE_BROKER_HANDLE 覆盖）
 * @param {number} [options.requestTimeoutMs] 单次请求最多等多久（默认 130 秒）
 */
export function createBrokerClient({ handleFile, requestTimeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const file = handleFile ? path.resolve(handleFile) : defaultBrokerHandleFile();

  return {
    handleFile: file,

    /** 提权执行。返回 status: executed / needs_confirm / denied / error。 */
    async runElevated(command, { cwd } = {}) {
      const text = String(command ?? "");
      if (!text.trim()) throw new BrokerProtocolError("command 不能为空");
      const request = {
        type: "exec",
        id: newRequestId(),
        command: text,
        ...(cwd === undefined || cwd === null || cwd === "" ? {} : { cwd: String(cwd) }),
      };
      return withBroker(file, async (channel) => {
        channel.send(request);
        const reply = await channel.next((message) => message?.id === request.id, requestTimeoutMs);
        return normalizeReply(reply, request);
      });
    },

    /**
     * 确认一条 pending。command 可选，只用于核对；
     * 与 pending 绑定的原文不一致时 broker 会拒绝执行。
     */
    async confirmElevated(pendingId, { command } = {}) {
      const request = {
        type: "confirm",
        id: checkPendingId(pendingId),
        ...(command === undefined || command === null ? {} : { command: String(command) }),
      };
      return withBroker(file, async (channel) => {
        channel.send(request);
        const reply = await channel.next((message) => message?.id === request.id, requestTimeoutMs);
        return normalizeReply(reply, request);
      });
    },

    /** 丢弃一条 pending（协议支持；MCP 工具暂未暴露取消按钮）。 */
    async cancelElevated(pendingId) {
      const request = { type: "cancel", id: checkPendingId(pendingId) };
      return withBroker(file, async (channel) => {
        channel.send(request);
        const reply = await channel.next((message) => message?.id === request.id, requestTimeoutMs);
        return normalizeReply(reply, request);
      });
    },
  };
}
