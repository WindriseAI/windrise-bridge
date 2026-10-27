#!/usr/bin/env node
/**
 * 管理员代理 · 端到端自检（真的起 src/broker/broker.mjs，真的走 127.0.0.1 回环 TCP）。
 *
 * 运行：node src/broker-e2e-selftest.mjs
 *
 * 覆盖设计 docs/research/admin-broker-review-2026-10-25.md 的 8 条攻击场景：
 *   第 1 条 伪装绕过分级        —— 编码命令 / cmd 包装 / 全盘删除由 broker 真实拒绝；
 *   第 2 条 同机别的进程连代理  —— 不知道端点 / 不握手 / 密钥错 / HTTP 探测；
 *   第 3 条 确认复用            —— 同一 pendingId 换命令、同 id 覆盖；
 *   第 4 条 确认重放            —— 同一 pendingId 第二次确认不执行；
 *   第 5 条 超时后执行          —— 过期 pendingId 无效；
 *   第 6 条 cwd / 环境变量注入  —— 客户端 env 不生效、cwd 越界 / 联接点逃逸被拒；
 *   第 7 条 日志泄露            —— 密钥不出现，Bearer / 口令被打码；
 *   第 8 条 broker 没在跑       —— Bridge 明确报「管理员代理未运行」，不降级。
 *
 * 另加：
 *   · 握手前 HTTP 探测 / 非法 JSON → 立即断开且没有任何回复；
 *   · 联接点（mklink /J）指向 allowedCwdRoots 之外 → cwd 被拒；
 *   · 命令文件在「broker 写完」到「PowerShell 读取」之间被测试进程改写 → SHA-256 不符，
 *     命令不执行、返回 exit 3；
 *   · runDir 权限核对函数的单测（正确 / 错误 icacls 输出分别通过 / 拒绝）；
 *   · 句柄文件默认位置、WINDRISE_BROKER_HANDLE 覆盖、句柄目录缺失时生产路径拒绝启动，
 *     以及 SELFTEST 下仍允许自动 mkdir（不破坏现有自测）。
 *
 * 副作用隔离：句柄、日志、命令文件、测试文件都在仓库下的临时目录，跑完删除。不碰真实 data/。
 */

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBrokerClient, defaultBrokerHandleFile } from "./core/broker-client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const tempDir = await mkdtemp(path.join(repo, ".broker-e2e-"));
const allowedDir = path.join(tempDir, "allowed");
const outsideDir = path.join(tempDir, "outside");
const runDir = path.join(tempDir, "run");
// 父目录故意不存在：SELFTEST 下 broker 仍应允许自己 mkdir。
const handleFile = path.join(tempDir, "handle", "broker-handle.json");
const logFile = path.join(tempDir, "broker.log");
const configFile = path.join(tempDir, "config.json");
const PENDING_TTL_MS = 1_500;
const IS_WINDOWS = process.platform === "win32";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —— ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 10_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate().catch(() => null);
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 测试文件 / 环境
 * ------------------------------------------------------------------ */

await mkdir(allowedDir, { recursive: true });
await mkdir(outsideDir, { recursive: true });
await mkdir(runDir, { recursive: true });
await writeFile(path.join(allowedDir, "inside.txt"), "x", "utf8");
await writeFile(path.join(outsideDir, "outside.txt"), "x", "utf8");
await writeFile(configFile, JSON.stringify({
  allowedCwdRoots: [allowedDir],
  handleFile,
  runDir,
  logFile,
}, null, 2), "utf8");

/** 一条一定能被分到 confirm 的命令（新旧两版分级器都如此）：Stop-Process 不在白名单。 */
const confirmCommand = (file, marker, verb = "Set-Content") => IS_WINDOWS
  ? `Stop-Process -Name windrise-no-such-proc -ErrorAction SilentlyContinue; ${verb} -LiteralPath '${file}' -Value '${marker}'`
  : `true; printf '%s' '${marker}' > '${file}'`;

/** 写文件的命令在旧分级器下可能因为「在仓库内」被判 auto；这里统一走 execOrConfirm。 */
async function execOrConfirm(channel, command, extra = {}) {
  const first = await execOn(channel, command, extra);
  if (first.reply?.type !== "needs_confirm") return first;
  const confirmed = await confirmOn(channel, first.id);
  return { id: first.id, reply: confirmed, pending: first.reply };
}

const fileExists = (file) => stat(file).then(() => true, () => false);

/* ------------------------------------------------------------------ *
 * 测试用的 NDJSON 客户端
 * ------------------------------------------------------------------ */

class TestChannel {
  #socket;
  #buffer = "";
  #queue = [];
  #waiters = [];
  #closed = false;
  #closedPromise;
  #resolveClosed;

  constructor(socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    this.#closedPromise = new Promise((resolve) => { this.#resolveClosed = resolve; });
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("error", () => this.#onClose());
    socket.on("close", () => this.#onClose());
  }

  get closed() { return this.#closedPromise; }

  #onData(chunk) {
    this.#buffer += chunk;
    let index;
    while ((index = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, index).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      let delivered = false;
      for (let i = 0; i < this.#waiters.length; i += 1) {
        const waiter = this.#waiters[i];
        if (!waiter.predicate(message)) continue;
        this.#waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
        delivered = true;
        break;
      }
      if (!delivered) this.#queue.push(message);
    }
  }

  #onClose() {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("broker 连接已关闭"));
    }
    this.#resolveClosed();
  }

  send(payload) {
    this.#socket.write(`${JSON.stringify(payload)}\n`);
  }

  next(predicate, timeoutMs = 20_000) {
    for (let i = 0; i < this.#queue.length; i += 1) {
      if (!predicate(this.#queue[i])) continue;
      return Promise.resolve(this.#queue.splice(i, 1)[0]);
    }
    if (this.#closed) return Promise.reject(new Error("broker 连接已关闭"));
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error("等待 broker 回应超时"));
      }, timeoutMs);
      waiter.timer.unref?.();
      this.#waiters.push(waiter);
    });
  }

  close() {
    try { this.#socket.destroy(); } catch { /* 已经关闭 */ }
  }
}

function connectEndpoint(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("连接回环端口超时")); }, 5_000);
    timer.unref?.();
    socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

async function openChannel(handle, key = handle.key) {
  const socket = await connectEndpoint(handle.host, handle.port);
  const channel = new TestChannel(socket);
  channel.send({ type: "hello", key });
  const hello = await channel.next((message) => message?.type === "hello_ok" || message?.type === "denied", 5_000)
    .catch((error) => ({ error }));
  return { channel, hello };
}

/** 发送一段原始字节，最多等 timeoutMs；返回收到内容和是否在超时前被断开。 */
function rawProbe(handle, payload, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: handle.host, port: handle.port });
    let data = "";
    let done = false;
    const finish = (closed) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* 已经关闭 */ }
      resolve({ data, closed });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("error", () => finish(true));
    socket.on("close", () => finish(true));
    socket.once("connect", () => { socket.write(payload); });
  });
}

let idCounter = 0;
function nextId(prefix = "e2e") {
  idCounter += 1;
  return `${prefix}_${idCounter}_${Date.now()}`;
}

async function execOn(channel, command, extra = {}, id = nextId("exec")) {
  channel.send({ type: "exec", id, command, ...extra });
  const reply = await channel.next((message) => message && message.id === id, 20_000);
  return { id, reply };
}

async function confirmOn(channel, id, command) {
  channel.send({ type: "confirm", id, ...(command === undefined ? {} : { command }) });
  return channel.next((message) => message && message.id === id, 20_000);
}

/* ------------------------------------------------------------------ *
 * runDir 权限核对函数：单测（子进程从 stdin 读 icacls 文本）
 * ------------------------------------------------------------------ */

async function runAclCase(text) {
  const brokerPath = path.join(here, "broker", "broker.mjs");
  const child = spawn(process.execPath, [brokerPath], {
    cwd: repo,
    env: {
      ...process.env,
      WINDRISE_BROKER_SELFTEST: "1",
      WINDRISE_BROKER_SELFTEST_ACL: "1",
      WINDRISE_BROKER_SELFTEST_ACL_PATH: runDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdin.end(text, "utf8");
  const [code] = await once(child, "exit");
  let parsed = null;
  try { parsed = JSON.parse(stdout.trim()); } catch { /* 下面按失败处理 */ }
  return { code, parsed, stdout, stderr };
}

const aclGood = [
  `${runDir} BUILTIN\\Administrators:(OI)(CI)(F)`,
  "                              NT AUTHORITY\\SYSTEM:(OI)(CI)(F)",
  "",
  "Successfully processed 1 files; Failed processing 0 files",
  "",
].join("\n");
const aclBad = [
  `${runDir} BUILTIN\\Administrators:(OI)(CI)(F)`,
  "                              NT AUTHORITY\\SYSTEM:(OI)(CI)(F)",
  "                              BUILTIN\\Users:(OI)(CI)(M)",
  "",
  "Successfully processed 1 files; Failed processing 0 files",
  "",
].join("\n");

/* ------------------------------------------------------------------ *
 * 启动 broker
 * ------------------------------------------------------------------ */

let broker = null;
let brokerOut = "";
let brokerErr = "";

async function stopBroker() {
  if (!broker || broker.exitCode !== null) return;
  try { broker.kill("SIGTERM"); } catch { /* 已经退出 */ }
  await Promise.race([once(broker, "exit").catch(() => {}), sleep(3_000)]);
  if (broker.exitCode === null) {
    try { broker.kill("SIGKILL"); } catch { /* 已经退出 */ }
    await Promise.race([once(broker, "exit").catch(() => {}), sleep(1_000)]);
  }
}

process.on("exit", () => {
  try { broker?.kill(); } catch { /* 已经退出 */ }
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

try {
  /* ---------------- runDir ACL 核对函数（不依赖正在跑的 broker） ---------------- */
  console.log("=== runDir 权限核对函数 ===");
  const aclPass = await runAclCase(aclGood);
  check(
    "ACL 核对：正确的 icacls 输出 → 通过",
    aclPass.code === 0 && aclPass.parsed?.ok === true,
    `exit=${aclPass.code} ${aclPass.stdout.trim()}${aclPass.stderr.trim() ? ` stderr=${aclPass.stderr.trim()}` : ""}`
  );
  const aclReject = await runAclCase(aclBad);
  check(
    "ACL 核对：非管理员主体可写 → 拒绝",
    aclReject.code !== 0 && aclReject.parsed?.ok === false && /Users|非管理员/.test(aclReject.parsed?.reason ?? ""),
    `exit=${aclReject.code} ${aclReject.stdout.trim()}`
  );

  /* ---------------- 句柄文件位置 ---------------- */
  console.log("\n=== 句柄文件位置 ===");
  const expectedDefault = path.join("D:\\ProgramData-Test", "WindriseBroker", "handle", "broker-handle.json");
  check(
    "默认句柄路径是 %ProgramData%\\WindriseBroker\\handle\\broker-handle.json",
    defaultBrokerHandleFile({ ProgramData: "D:\\ProgramData-Test" }) === expectedDefault,
    defaultBrokerHandleFile({ ProgramData: "D:\\ProgramData-Test" })
  );
  const overrideTarget = path.resolve(path.join(tempDir, "override-handle.json"));
  check(
    "WINDRISE_BROKER_HANDLE 覆盖仍然优先",
    defaultBrokerHandleFile({
      ProgramData: "D:\\ProgramData-Test",
      WINDRISE_BROKER_HANDLE: overrideTarget,
    }) === overrideTarget,
    overrideTarget
  );

  // 生产路径：句柄目录由安装脚本创建，broker 自己绝不能 mkdir。
  // SELFTEST 用专用环境变量关掉 mkdir 来验证这条分支。
  const missingHandleDir = path.join(tempDir, "missing-handle-dir");
  const missingHandleFile = path.join(missingHandleDir, "broker-handle.json");
  const missingConfigFile = path.join(tempDir, "config-missing-handle.json");
  await writeFile(missingConfigFile, JSON.stringify({
    allowedCwdRoots: [allowedDir],
    handleFile: missingHandleFile,
    runDir,
    logFile: path.join(tempDir, "missing-handle.log"),
  }, null, 2), "utf8");
  const missingRun = spawnSync(process.execPath, [path.join(here, "broker", "broker.mjs")], {
    cwd: repo,
    env: {
      ...process.env,
      WINDRISE_BROKER_SELFTEST: "1",
      WINDRISE_BROKER_SELFTEST_NO_HANDLE_MKDIR: "1",
      WINDRISE_BROKER_CONFIG: missingConfigFile,
      WINDRISE_BROKER_HANDLE: missingHandleFile,
    },
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  const missingText = `${missingRun.stdout ?? ""}${missingRun.stderr ?? ""}`;
  check(
    "句柄目录不存在 → 拒绝启动并提示重新运行 install-broker.ps1",
    missingRun.status !== 0
      && /句柄目录不存在/.test(missingText)
      && /请重新运行 install-broker\.ps1/.test(missingText),
    `exit=${missingRun.status} ${missingText.trim().slice(0, 400)}`
  );
  check(
    "拒绝启动时没有偷偷创建句柄目录",
    !existsSync(missingHandleDir),
    missingHandleDir
  );

  broker = spawn(process.execPath, [path.join(here, "broker", "broker.mjs")], {
    cwd: repo,
    env: {
      ...process.env,
      WINDRISE_BROKER_SELFTEST: "1",
      WINDRISE_BROKER_CONFIG: configFile,
      WINDRISE_BROKER_PENDING_TTL_MS: String(PENDING_TTL_MS),
      WINDRISE_BROKER_EXEC_TIMEOUT_MS: "30000",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  broker.stdout.on("data", (chunk) => { brokerOut += chunk.toString(); });
  broker.stderr.on("data", (chunk) => { brokerErr += chunk.toString(); });

  const handle = await waitFor(async () => JSON.parse(await readFile(handleFile, "utf8")), 10_000);
  if (!handle) throw new Error(`broker 没有写出句柄文件。stdout=${brokerOut} stderr=${brokerErr}`);

  console.log(`broker 已启动（pid ${handle.pid}）`);
  console.log(`临时目录：${tempDir}\n`);

  const handleStat = await stat(handleFile);
  check(
    "SELFTEST 下句柄目录不存在时仍会自动创建（生产路径才拒绝）",
    existsSync(path.dirname(handleFile)),
    path.dirname(handleFile)
  );
  check("broker 写出句柄文件（version 2）", handle.version === 2 && Boolean(handle.key), `pid=${handle.pid}`);
  check(
    "句柄是回环 TCP 端点（127.0.0.1 + 合法端口）",
    handle.host === "127.0.0.1" && Number.isInteger(handle.port) && handle.port > 0 && handle.port < 65536,
    `${handle.host}:${handle.port}`
  );
  check("会话密钥足够长（32 字节随机）", typeof handle.key === "string" && handle.key.length >= 43, `${handle.key.length} 字符`);
  if (!IS_WINDOWS) {
    check("句柄文件权限 0600", (handleStat.mode & 0o777) === 0o600, `mode=${(handleStat.mode & 0o777).toString(8)}`);
  }
  check(
    "启动输出不含会话密钥",
    !brokerOut.includes(handle.key) && !brokerErr.includes(handle.key),
    `stdout=${JSON.stringify(brokerOut.trim())}`
  );

  /* ================================================================ *
   * 攻击场景 2：同机别的进程连代理
   * ================================================================ */
  console.log("\n=== 攻击场景 2：同机别的进程连代理 ===");

  const wrongKey = await openChannel(handle, "definitely-not-the-key");
  check(
    "设计第 2 条：知道端点但密钥错 → denied",
    wrongKey.hello?.type === "denied",
    JSON.stringify(wrongKey.hello)
  );
  const wrongClosed = await Promise.race([wrongKey.channel.closed.then(() => true), sleep(2_000).then(() => false)]);
  check("设计第 2 条：密钥错之后立即断开", wrongClosed, wrongClosed ? "已断开" : "2 秒内没有断开");
  wrongKey.channel.close();

  const noHello = new TestChannel(await connectEndpoint(handle.host, handle.port));
  noHello.send({ type: "exec", id: nextId("nohello"), command: "Write-Output should-not-run" });
  const noHelloReply = await noHello.next((message) => message?.type === "denied" || message?.type === "error", 3_000)
    .catch((error) => ({ error }));
  check(
    "设计第 2 条：不握手直接 exec → 拒绝",
    noHelloReply?.type === "denied" || noHelloReply?.type === "error",
    JSON.stringify(noHelloReply)
  );
  noHello.close();

  const httpProbe = await rawProbe(handle, "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
  check(
    "设计第 2 条 / 握手：HTTP 探测式连接 → 立即断开且没有任何回复",
    httpProbe.closed && httpProbe.data === "",
    httpProbe.closed ? `收到 ${httpProbe.data.length} 字节` : "2 秒内没有断开"
  );

  const junkProbe = await rawProbe(handle, "this is not json\n");
  check(
    "握手：第一行不是合法 JSON → 立即断开且没有任何回复",
    junkProbe.closed && junkProbe.data === "",
    junkProbe.closed ? `收到 ${junkProbe.data.length} 字节` : "2 秒内没有断开"
  );

  // 正确密钥：后面所有测试都走这条
  const main = await openChannel(handle);
  check("设计第 2 条：会话密钥正确 → hello_ok", main.hello?.type === "hello_ok" && main.hello?.version === 2, JSON.stringify(main.hello));

  /* ================================================================ *
   * 攻击场景 1：伪装绕过分级（broker 真的按分级拒绝）
   * ================================================================ */
  console.log("\n=== 攻击场景 1：伪装绕过分级 ===");

  const encodedDelete = Buffer.from("Remove-Item C:\\ -Recurse -Force", "utf16le").toString("base64");
  const encoded = await execOn(main.channel, `powershell -enc ${encodedDelete}`);
  check("设计第 1 条：base64 / -enc 藏全盘删除 → denied", encoded.reply.type === "denied", JSON.stringify(encoded.reply));

  const cmdWrapped = await execOn(main.channel, "cmd /c \"format C:\"");
  check("设计第 1 条：cmd /c 包一层 format C: → denied", cmdWrapped.reply.type === "denied", JSON.stringify(cmdWrapped.reply));

  const neverRoot = await execOn(main.channel, "Remove-Item C:\\ -Recurse -Force");
  check("设计第 1 条 / never 档：Remove-Item C:\\ 递归 → denied", neverRoot.reply.type === "denied", JSON.stringify(neverRoot.reply));

  const neverFormat = await execOn(main.channel, "format C: /q");
  check("设计第 1 条 / never 档：format C: /q → denied", neverFormat.reply.type === "denied", JSON.stringify(neverFormat.reply));

  /* ================================================================ *
   * auto：只读查询直接执行
   * ================================================================ */
  console.log("\n=== auto 执行 ===");

  const auto = await execOn(main.channel, "Get-Process -Name node");
  check(
    "auto：只读查询直接执行并回传输出",
    auto.reply.type === "result" && auto.reply.code === 0 && String(auto.reply.stdout).toLowerCase().includes("node"),
    JSON.stringify(auto.reply).slice(0, 300)
  );
  check(
    "cwd：allowedCwdRoots 内的目录可以执行",
    await execOn(main.channel, "Get-Process -Name node", { cwd: allowedDir })
      .then((item) => item.reply.type === "result" && item.reply.code === 0, () => false),
    allowedDir
  );

  /* ================================================================ *
   * 防替换：写完命令文件后、PowerShell 读取前被改写 → 哈希不符
   * ================================================================ */
  console.log("\n=== 防替换：命令文件被改写 ===");

  if (IS_WINDOWS) {
    const pauseFile = path.join(runDir, "selftest-pause-ms");
    await writeFile(pauseFile, "3000", "utf8");
    const raceCommand = "Get-Process -Name node";
    const racePromise = execOn(main.channel, raceCommand);
    const writtenFile = await waitFor(async () => {
      for (const name of await readdir(runDir).catch(() => [])) {
        if (!name.endsWith(".ps1")) continue;
        const full = path.join(runDir, name);
        const content = await readFile(full, "utf8").catch(() => null);
        if (content === raceCommand) return full;
      }
      return null;
    }, 5_000, 20);
    let replaced = false;
    if (writtenFile) {
      await writeFile(writtenFile, "Write-Output windrise-hash-race-hacked", "utf8");
      replaced = true;
    }
    const race = await racePromise;
    await rm(pauseFile, { force: true }).catch(() => {});
    const raceText = `${race.reply.stdout ?? ""}${race.reply.stderr ?? ""}`;
    check(
      "防替换：命令文件被改写 → SHA-256 不符，命令不执行（exit 3）",
      replaced
        && race.reply.type === "result"
        && race.reply.code === 3
        && /哈希不符/.test(raceText)
        && !raceText.includes("windrise-hash-race-hacked"),
      JSON.stringify(race.reply).slice(0, 400)
    );
    check(
      "防替换：命令文件执行完即被清理",
      writtenFile ? !(await fileExists(writtenFile)) : false,
      writtenFile ?? "没有找到 broker 写的命令文件"
    );
  } else {
    check("防替换：命令文件被改写 → SHA-256 不符（Windows 专用链路）", false, "当前不是 Windows，跳过该链路");
  }

  await Promise.all((await readdir(runDir).catch(() => []))
    .filter((name) => name.endsWith(".ps1") || name.endsWith(".sh"))
    .map((name) => rm(path.join(runDir, name), { force: true }).catch(() => {})));

  /* ================================================================ *
   * 确认流程（含攻击场景 3：确认复用）
   * ================================================================ */
  console.log("\n=== 确认流程 / 攻击场景 3：确认复用 ===");

  const fileA = path.join(allowedDir, "confirm-a.txt");
  const fileB = path.join(allowedDir, "confirm-b.txt");
  const confirmA = confirmCommand(fileA, "windrise-A");
  const confirmB = confirmCommand(fileB, "windrise-B");

  const pendingA = await execOn(main.channel, confirmA);
  check("confirm：非白名单命令不直接执行，返回 needs_confirm", pendingA.reply.type === "needs_confirm", JSON.stringify(pendingA.reply).slice(0, 300));
  check("confirm：待确认期间没有任何副作用", !(await fileExists(fileA)), fileA);

  // 3a：同一个 id 再用一次 exec 覆盖 B → 必须被拒
  const overwrite = await execOn(main.channel, confirmB, {}, pendingA.id);
  check("设计第 3 条：pending id 不能被另一条 exec 覆盖", overwrite.reply.type === "error", JSON.stringify(overwrite.reply));
  check("设计第 3 条：覆盖失败后 B 没有执行", !(await fileExists(fileB)), fileB);

  // 3b：拿 A 的 pendingId 去确认 B → 必须拒绝，且 A 仍在等待
  const mismatch = await confirmOn(main.channel, pendingA.id, confirmB).catch((error) => ({ error }));
  check("设计第 3 条：用 A 的 pendingId 确认 B → 拒绝", mismatch?.type === "error", JSON.stringify(mismatch));
  check(
    "设计第 3 条：拒绝后 A 仍在等待、A/B 都没有执行",
    !(await fileExists(fileA)) && !(await fileExists(fileB)),
    ""
  );

  // 换一条新连接确认正确的 A（模拟 Bridge 重连后继续确认）
  const second = await openChannel(handle);
  check("confirm：第二条连接也能握手", second.hello?.type === "hello_ok", JSON.stringify(second.hello));
  const confirmedA = await confirmOn(second.channel, pendingA.id, confirmA);
  check(
    "confirm：命令一致才执行，且执行结果是原命令 A",
    confirmedA.type === "result" && confirmedA.code === 0,
    JSON.stringify(confirmedA).slice(0, 300)
  );
  check("confirm：A 被执行（文件出现）", await fileExists(fileA), fileA);
  check("confirm：B 没有被误执行", !(await fileExists(fileB)), fileB);
  second.channel.close();

  /* ================================================================ *
   * 攻击场景 4：确认重放
   * ================================================================ */
  console.log("\n=== 攻击场景 4：确认重放 ===");

  const fileReplay = path.join(allowedDir, "replay.txt");
  const replay = await execOn(main.channel, confirmCommand(fileReplay, "windrise-replay"));
  check("replay：先拿到 pending", replay.reply.type === "needs_confirm", JSON.stringify(replay.reply).slice(0, 200));
  const firstConfirm = await confirmOn(main.channel, replay.id);
  check("replay：第一次确认执行成功", firstConfirm.type === "result" && firstConfirm.code === 0, JSON.stringify(firstConfirm).slice(0, 200));
  check("replay：第一次确认后文件已写入", await fileExists(fileReplay), fileReplay);

  await rm(fileReplay, { force: true });
  const secondConfirm = await confirmOn(main.channel, replay.id);
  check(
    "设计第 4 条：同一个 pendingId 第二次确认 → 拒绝/过期，不执行",
    secondConfirm.type === "error" || secondConfirm.type === "expired",
    JSON.stringify(secondConfirm)
  );
  check("设计第 4 条：重放没有重新写入文件", !(await fileExists(fileReplay)), fileReplay);

  /* ================================================================ *
   * 攻击场景 5：超时后执行
   * ================================================================ */
  console.log("\n=== 攻击场景 5：超时后执行 ===");

  const fileLate = path.join(allowedDir, "late.txt");
  const late = await execOn(main.channel, confirmCommand(fileLate, "windrise-late"));
  check("timeout：先拿到 pending", late.reply.type === "needs_confirm", JSON.stringify(late.reply).slice(0, 200));
  await sleep(PENDING_TTL_MS + 500);
  const lateConfirm = await confirmOn(main.channel, late.id).catch((error) => ({ error }));
  check(
    "设计第 5 条：过期 pendingId 无效",
    lateConfirm?.type === "expired" || (lateConfirm?.type === "error" && /过期|没有待确认/.test(lateConfirm.reason ?? "")),
    JSON.stringify(lateConfirm)
  );
  check("设计第 5 条：过期后没有执行", !(await fileExists(fileLate)), fileLate);

  /* ================================================================ *
   * cancel（协议要求，顺手验）
   * ================================================================ */
  console.log("\n=== cancel ===");
  const fileCancel = path.join(allowedDir, "cancel.txt");
  const cancelPending = await execOn(main.channel, confirmCommand(fileCancel, "windrise-cancel"));
  main.channel.send({ type: "cancel", id: cancelPending.id });
  const cancelled = await main.channel.next((message) => message && message.id === cancelPending.id, 5_000);
  check("cancel：丢弃 pending", cancelled.type === "cancelled", JSON.stringify(cancelled));
  const afterCancel = await confirmOn(main.channel, cancelPending.id).catch((error) => ({ error }));
  check("cancel：取消后确认无效", afterCancel?.type === "error", JSON.stringify(afterCancel));
  check("cancel：没有执行", !(await fileExists(fileCancel)), fileCancel);

  /* ================================================================ *
   * 攻击场景 6：cwd / 环境变量注入
   * ================================================================ */
  console.log("\n=== 攻击场景 6：cwd / 环境变量注入 ===");

  const envProbeCommand = IS_WINDOWS
    ? "Write-Output (\"WINDRISE_INJECTED=[\" + $env:WINDRISE_INJECTED + \"] PATH=\" + $env:PATH)"
    : "echo \"WINDRISE_INJECTED=[$WINDRISE_INJECTED] PATH=$PATH\"";
  const envProbe = await execOrConfirm(
    main.channel,
    envProbeCommand,
    { env: { WINDRISE_INJECTED: "injected-by-client", PATH: "C:\\evil" } }
  );
  const envText = envProbe.reply.type === "result" ? String(envProbe.reply.stdout) : "";
  check(
    "设计第 6 条：客户端传的 env 不生效",
    envProbe.reply.type === "result" && envText.includes("WINDRISE_INJECTED=[]") && !envText.includes("C:\\evil"),
    envText.trim().slice(0, 300)
  );

  const outsideCwd = IS_WINDOWS ? "C:\\Windows" : "/etc";
  const escapeCwd = await execOn(main.channel, "Write-Output cwd-escape", { cwd: outsideCwd });
  check(
    "设计第 6 条：cwd 越界被拒（命令没执行）",
    escapeCwd.reply.type === "error" && /cwd 越界/.test(escapeCwd.reply.reason ?? ""),
    JSON.stringify(escapeCwd.reply)
  );

  const relativeEscape = await execOn(
    main.channel,
    "Write-Output relative-escape",
    { cwd: IS_WINDOWS ? "..\\outside" : "../outside" }
  );
  check(
    "设计第 6 条：.. 逃逸 cwd 也被拒",
    relativeEscape.reply.type === "error" && /cwd 越界/.test(relativeEscape.reply.reason ?? ""),
    JSON.stringify(relativeEscape.reply)
  );

  // 联接点 / 符号链接：allowedDir\link-out → outsideDir（allowedCwdRoots 之外）
  const linkPath = path.join(allowedDir, "link-out");
  let linkMade = false;
  if (IS_WINDOWS) {
    const result = spawnSync(process.env.ComSpec || "cmd.exe", [
      "/d", "/c", "mklink", "/J", linkPath, outsideDir,
    ], { encoding: "utf8", windowsHide: true });
    linkMade = result.status === 0 && existsSync(linkPath);
  } else {
    try {
      const { symlink } = await import("node:fs/promises");
      await symlink(outsideDir, linkPath, "dir");
      linkMade = true;
    } catch { linkMade = false; }
  }
  const junctionCwd = await execOn(main.channel, "Write-Output junction-should-not-run", { cwd: linkPath });
  check(
    "设计第 6 条 / 联接点：真实路径跑到 allowedCwdRoots 之外 → cwd 被拒",
    linkMade && junctionCwd.reply.type === "error" && /cwd 越界/.test(junctionCwd.reply.reason ?? ""),
    linkMade ? JSON.stringify(junctionCwd.reply) : "联接点创建失败，无法验证"
  );
  if (linkMade) await rmdir(linkPath).catch(() => {});

  /* ================================================================ *
   * 攻击场景 7：日志泄露
   * ================================================================ */
  console.log("\n=== 攻击场景 7：日志泄露 ===");

  const secretCommand = 'Write-Output "Bearer sk-live-SECRET-1234567890 password=hunter2"';
  const secretResult = await execOrConfirm(main.channel, secretCommand);
  check("日志测试命令已执行", secretResult.reply.type === "result", JSON.stringify(secretResult.reply).slice(0, 200));

  const logText = await waitFor(async () => {
    const text = await readFile(logFile, "utf8").catch(() => "");
    return text.includes(`result id=${secretResult.id}`) ? text : null;
  }, 5_000) ?? await readFile(logFile, "utf8").catch(() => "");
  check("设计第 7 条：日志里没有会话密钥", !logText.includes(handle.key), `日志 ${logText.length} 字符`);
  check("设计第 7 条：日志里没有回环端点", !logText.includes(`${handle.host}:${handle.port}`), "");
  check("设计第 7 条：Bearer 令牌被打码", !logText.includes("sk-live-SECRET-1234567890") && logText.includes("<令牌>"), "");
  check("设计第 7 条：password 被打码", !logText.includes("hunter2") && logText.includes("<已打码>"), "");

  main.channel.close();
  const secondHandleStat = await stat(handleFile);

  /* ================================================================ *
   * 攻击场景 8：broker 没在跑
   * ================================================================ */
  console.log("\n=== 攻击场景 8：broker 没在跑 ===");

  const missingHandle = path.join(tempDir, "missing-handle.json");
  const notRunning = createBrokerClient({ handleFile: missingHandle });
  const notRunningError = await notRunning.runElevated("Write-Output never").then(() => null, (error) => error);
  check(
    "设计第 8 条：没有句柄文件 → 明确报「管理员代理未运行」",
    notRunningError?.code === "BROKER_NOT_RUNNING" && /管理员代理未运行/.test(notRunningError.message),
    notRunningError?.message ?? "没有报错"
  );
  check(
    "设计第 8 条：明确说明不会降级",
    /不会降级/.test(notRunningError?.message ?? ""),
    notRunningError?.message ?? "没有报错"
  );

  // 找一个刚释放的回环端口，确保连接一定被拒
  const closedPort = await new Promise((resolve) => {
    const server = net.createServer();
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
  const fakeHandle = path.join(tempDir, "fake-handle.json");
  await writeFile(fakeHandle, JSON.stringify({
    version: 2,
    host: "127.0.0.1",
    port: closedPort,
    key: "x".repeat(43),
    pid: 1,
    createdAt: new Date().toISOString(),
  }), "utf8");
  const fakeClient = createBrokerClient({ handleFile: fakeHandle });
  const fakeError = await fakeClient.runElevated("Write-Output never").then(() => null, (error) => error);
  check(
    "设计第 8 条：知道端点但 broker 没跑 → 明确报未运行，不偷偷执行",
    fakeError?.code === "BROKER_NOT_RUNNING" && /管理员代理未运行/.test(fakeError.message),
    fakeError?.message ?? "没有报错"
  );

  const remoteHandle = path.join(tempDir, "remote-handle.json");
  await writeFile(remoteHandle, JSON.stringify({
    version: 2,
    host: "192.0.2.1",
    port: 9,
    key: "x".repeat(43),
    pid: 1,
    createdAt: new Date().toISOString(),
  }), "utf8");
  const remoteError = await createBrokerClient({ handleFile: remoteHandle })
    .runElevated("Write-Output never").then(() => null, (error) => error);
  check(
    "句柄里的非回环地址被客户端拒绝",
    remoteError?.code === "BROKER_PROTOCOL_ERROR" && /回环/.test(remoteError.message),
    remoteError?.message ?? "没有报错"
  );

  // 句柄文件在 broker 运行期间不能被别人随便改（Windows 上 mode 是 no-op，至少确认文件还在）
  check("句柄文件仍然存在（未被测试误删）", Boolean(secondHandleStat.size), `${secondHandleStat.size} 字节`);

  console.log("\n=== 收尾 ===");
  await stopBroker();
  console.log("broker 已停止");
} catch (error) {
  console.error("\n自检过程中出现异常：");
  console.error(error?.stack ?? error?.message ?? error);
  if (brokerOut.trim()) console.error(`broker stdout:\n${brokerOut}`);
  if (brokerErr.trim()) console.error(`broker stderr:\n${brokerErr}`);
  results.push({ name: "自检过程异常", ok: false, detail: String(error?.message ?? error) });
} finally {
  await stopBroker();
  // 联接点先删，避免递归删除临时目录时跟进去
  await rmdir(path.join(allowedDir, "link-out")).catch(() => {});
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
}

const passed = results.filter(row => row.ok).length;
const failed = results.filter(row => !row.ok);
console.log(`\n通过 ${passed}/${results.length}`);
console.log(`失败：${failed.length} 个${failed.length ? `（${failed.map(row => row.name).join("、")}）` : ""}`);
for (const row of failed) console.log(`  ✗ ${row.name}：${row.detail}`);
process.exit(failed.length ? 1 : 0);
