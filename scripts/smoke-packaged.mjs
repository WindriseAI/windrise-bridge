#!/usr/bin/env node
/**
 * 打包产物冒烟验证 —— 对着「装好的 / 解包的」桌面程序做一次真实点击。
 *
 * 它做的事：
 *   1) 启动（或连上已启动的）打包后的 exe，带 --remote-debugging-port
 *   2) 用 CDP 连上窗口里的页面，点「启动 Bridge」
 *   3) 等 #mcp-url 里出现真实地址，顺手读一遍界面上的状态
 *   4) 直接 HTTP 打一次 /healthz 和 MCP 的 initialize + tools/list（证明桥真的在服务）
 *   5) 截一张窗口截图（CDP Page.captureScreenshot）
 *   6) 默认把进程树杀掉，不留残留
 *
 * 用法：
 *   node scripts/smoke-packaged.mjs                          # 用 dist/win-unpacked 里的 exe
 *   node scripts/smoke-packaged.mjs --exe "C:\\...\\Windrise Bridge.exe"
 *   node scripts/smoke-packaged.mjs --attach                 # 连已在跑的实例（不启动、不杀）
 *   node scripts/smoke-packaged.mjs --no-kill                # 启动但不杀，方便再手工看
 *   node scripts/smoke-packaged.mjs --shot out.png
 *
 * 只依赖 Node 内置能力（fetch + 全局 WebSocket），不需要装任何东西。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/* ---------------- 参数 ---------------- */
function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const PORT = Number(arg("port", "9223"));
const EXE = arg("exe", path.join(ROOT, "dist", "win-unpacked", "Windrise Bridge.exe"));
const ATTACH = flag("attach");
const KILL = !flag("no-kill") && !ATTACH;
const SHOT = arg("shot", path.join(ROOT, "dist", "smoke-ui.png"));
const TIMEOUT_MS = Number(arg("timeout", "60000"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- CDP 极简客户端 ---------------- */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error)})`));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}, timeout = 20000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时（${timeout}ms）`));
      }, timeout);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression, timeout = 20000) {
    const res = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeout);
    if (res.exceptionDetails) {
      throw new Error(`页面里执行出错：${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    }
    return res.result?.value;
  }
}

async function findPageTarget() {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError = "（还没连上）";
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && /index\.html/.test(t.url)) ?? list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return { page, all: list };
      lastError = `有 ${list.length} 个目标，但没有 page：${list.map((t) => t.type).join(",")}`;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(500);
  }
  throw new Error(`等不到 CDP 页面目标（${TIMEOUT_MS}ms）：${lastError}`);
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket 连接超时")), 15000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); });
    ws.addEventListener("error", (e) => { clearTimeout(timer); reject(new Error(`WebSocket 出错：${e.message ?? e.type}`)); });
  });
  return new Cdp(ws);
}

/* ---------------- 主流程 ---------------- */
const report = { ok: false, steps: [] };
const step = (name, detail) => {
  report.steps.push({ name, ...detail });
  console.log(`[smoke] ${name}：${JSON.stringify(detail)}`);
};

let child = null;

try {
  if (!ATTACH) {
    if (!existsSync(EXE)) throw new Error(`找不到可执行文件：${EXE}`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; // 关键：别让 Electron 退化成纯 Node
    console.log(`[smoke] 启动：${EXE} --remote-debugging-port=${PORT}`);
    child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
      cwd: ROOT,
      env,
      stdio: "ignore",
      detached: false,
    });
    child.on("exit", (code) => console.log(`[smoke] 子进程退出 code=${code}`));
    step("launch", { pid: child.pid, exe: EXE, cwd: ROOT });
  } else {
    step("attach", { port: PORT });
  }

  const { page, all } = await findPageTarget();
  step("cdp-target", { url: page.url, title: page.title, type: page.type, targets: all.length });

  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable").catch(() => {});
  await cdp.send("Page.enable").catch(() => {});

  // 调试用：--eval "<表达式>" 直接在页面里跑一段，打完结果就退出
  const EVAL = arg("eval", null);
  if (EVAL) {
    const value = await cdp.eval(EVAL, 60000);
    step("eval", { expression: EVAL, value });
    report.ok = true;
    throw { done: true };
  }

  // 等界面就绪
  const readyDeadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < readyDeadline) {
    ready = await cdp.eval(`document.readyState === "complete" && !!document.getElementById("btn-toggle")`);
    if (ready) break;
    await sleep(300);
  }
  if (!ready) throw new Error("界面没就绪：找不到 #btn-toggle");
  step("ui-ready", { title: await cdp.eval("document.title") });

  const before = await cdp.eval(`document.getElementById("mcp-url").value`);
  step("mcp-url-before", { value: before });

  // 已经跑起来的话就别再点（那个按钮是「启动/停止」两态开关，再点会把 Bridge 停掉）
  if (typeof before === "string" && before.startsWith("http")) {
    step("already-running", { note: "MCP 地址已经在，跳过点击" });
  } else {
    const clicked = await cdp.eval(`(() => { const b = document.getElementById("btn-toggle"); b.click(); return b.textContent; })()`);
    step("clicked", { button: clicked });
  }

  const urlDeadline = Date.now() + 45000;
  let mcpUrl = before;
  while (Date.now() < urlDeadline) {
    mcpUrl = await cdp.eval(`document.getElementById("mcp-url").value`);
    if (typeof mcpUrl === "string" && mcpUrl.startsWith("http")) break;
    await sleep(500);
  }
  step("mcp-url-after", { value: mcpUrl, looksValid: typeof mcpUrl === "string" && mcpUrl.startsWith("http") });
  if (!(typeof mcpUrl === "string" && mcpUrl.startsWith("http"))) {
    throw new Error(`点了启动但没拿到 MCP 地址，当前值：${mcpUrl}`);
  }

  const uiState = await cdp.eval(`JSON.stringify({
    chip: document.getElementById("chip-state")?.textContent,
    health: document.getElementById("health-text")?.textContent,
    healthUrl: document.getElementById("health-url")?.value,
    dataHome: document.getElementById("data-home")?.textContent,
    tokenFile: document.getElementById("token-file")?.textContent,
    hubRoot: document.getElementById("hub-root")?.textContent,
    roots: document.getElementById("roots")?.value,
    button: document.getElementById("btn-toggle")?.textContent,
    bodyText: document.body.innerText.length
  })`);
  const ui = JSON.parse(uiState);
  step("ui-state", ui);

  // 健康检查 + MCP 握手（从 Node 侧直连，证明服务真的在跑）
  const health = await (await fetch(ui.healthUrl)).json();
  step("healthz", health);

  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const init = await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke-packaged", version: "0" } } }),
  });
  const sessionId = init.headers.get("mcp-session-id");
  const initBody = await init.json();
  const listRes = await fetch(mcpUrl, {
    method: "POST",
    headers: sessionId ? { ...headers, "mcp-session-id": sessionId } : headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const listBody = await listRes.json();
  const tools = listBody?.result?.tools ?? [];
  step("mcp-handshake", {
    protocolVersion: initBody?.result?.protocolVersion,
    serverName: initBody?.result?.serverInfo?.name,
    sessionIssued: Boolean(sessionId),
    toolCount: tools.length,
    sampleTools: tools.slice(0, 6).map((t) => t.name),
  });

  // 可选：真调一个工具，把结果打出来（--call <工具名> --args '<json>'）
  const CALL = arg("call", null);
  if (CALL) {
    const callArgs = JSON.parse(arg("args", "{}"));
    const callRes = await fetch(mcpUrl, {
      method: "POST",
      headers: sessionId ? { ...headers, "mcp-session-id": sessionId } : headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: CALL, arguments: callArgs } }),
    });
    const callBody = await callRes.json();
    const text = callBody?.result?.content?.map((c) => c.text).join("\n");
    step("tool-call", {
      tool: CALL,
      args: callArgs,
      isError: callBody?.result?.isError ?? null,
      error: callBody?.error ?? null,
      structured: callBody?.result?.structuredContent ?? null,
      text: typeof text === "string" ? text.slice(0, 1200) : null,
    });
  }

  // 截图
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }, 30000);
  mkdirSync(path.dirname(SHOT), { recursive: true });
  writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
  step("screenshot", { path: SHOT, bytes: Buffer.from(shot.data, "base64").length });

  report.ok = true;
  report.mcpUrl = mcpUrl;
} catch (error) {
  if (error && error.done) {
    // --eval 模式：正常提前收尾
  } else {
    report.error = error.message;
    console.error(`[smoke] 失败：${error.message}`);
  }
} finally {
  if (KILL && child?.pid) {
    console.log(`[smoke] 收尾：杀掉进程树 ${child.pid}`);
    const killed = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "inherit" });
    await new Promise((r) => killed.on("exit", r));
    await sleep(1500);
  }
  console.log("\n===== 冒烟结果 =====");
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
