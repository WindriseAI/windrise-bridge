#!/usr/bin/env node
/**
 * windrise —— Windrise Bridge 的命令行。
 *
 * 运行方式：用本软件的可执行文件当 Node 跑（ELECTRON_RUN_AS_NODE=1），
 * 界面「安装命令行」会写好 windrise 启动脚本，直接敲 windrise 即可。
 *
 * 原理：读软件写在数据目录里的发现文件（browser-control*.json），
 * 通过本机 HTTP 调用正在运行的软件。所以命令行能做的事，和界面上点按钮完全一样。
 *
 * windrise mcp：标准输入输出的 MCP 服务，转发到本机 MCP 服务，
 * 给 Claude 桌面版、Cursor 等只支持本地命令的 AI 客户端用。
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const APP_NAME = "Windrise Bridge";
const HOME = os.homedir();
const PACKAGED = /^resources$/i.test(path.basename(path.dirname(path.dirname(__dirname))));

/* ---------------- 找到正在运行的软件 ---------------- */

function dataDirs() {
  const dirs = [];
  const add = (d) => { if (d && !dirs.includes(path.resolve(d))) dirs.push(path.resolve(d)); };
  add(process.env.BRIDGE_DATA_HOME?.trim());
  add(process.env.WINDRISE_DATA_HOME?.trim());
  if (PACKAGED && process.platform === "win32") add(path.join(path.dirname(process.execPath), "data"));
  if (!PACKAGED) add(path.join(__dirname, "..", "data"));
  const appData = process.platform === "win32" ? (process.env.APPDATA || path.join(HOME, "AppData", "Roaming"))
    : process.platform === "darwin" ? path.join(HOME, "Library", "Application Support")
    : (process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"));
  add(path.join(appData, APP_NAME));
  add(path.join(HOME, ".bridge-replica"));
  return dirs;
}

function candidates() {
  const out = [];
  for (const dir of dataDirs()) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => /^browser-control(-\d+)?\.json$/.test(n)); } catch { continue; }
    for (const name of names) {
      try {
        const info = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
        if (info?.url && !out.some((c) => c.url === info.url)) out.push(info);
      } catch { /* 坏文件跳过 */ }
    }
  }
  return out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

async function post(url, body, timeoutMs) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 404) throw Object.assign(new Error("令牌不匹配"), { code: "STALE" });
  return response.json();
}

let live = null;
async function findLive() {
  if (live) return live;
  for (const c of candidates()) {
    try { const r = await post(`${c.url}/status`, {}, 2000); if (r?.ok) return (live = c); } catch { /* 下一个 */ }
  }
  return null;
}

function launchApp() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = PACKAGED ? [] : [path.join(__dirname, "..")];
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", env, windowsHide: false });
  child.unref();
}

async function connect({ launch = false, quiet = false } = {}) {
  let found = await findLive();
  if (found || !launch) return found;
  if (!quiet) process.stderr.write(`${APP_NAME} 没在运行，正在启动…\n`);
  launchApp();
  for (let i = 0; i < 60 && !found; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    found = await findLive();
  }
  return found;
}

class CliError extends Error {}

async function call(name, params = {}, { launch = false, timeoutMs = 120_000, quiet = false } = {}) {
  const found = await connect({ launch, quiet });
  if (!found) throw new CliError(`${APP_NAME} 没在运行。先打开软件，或去掉 --no-launch 让命令行自动启动它。`);
  let r;
  try { r = await post(`${found.url}/app/${name}`, params, timeoutMs); }
  catch (error) {
    if (error.name === "TimeoutError") throw new CliError(`软件超过 ${Math.round(timeoutMs / 1000)} 秒没有回应`);
    throw new CliError(`连不上软件：${error.message}`);
  }
  if (!r.ok) throw new CliError(r.error || "操作失败");
  return r.result;
}

/* ---------------- 参数 ---------------- */

function parseArgs(argv) {
  const pos = [], flags = {};
  const valued = new Set(["url", "provider", "name", "n", "limit", "kind", "level", "tab", "site"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { pos.push(...argv.slice(i + 1)); break; }
    const m = /^--?([a-z][\w-]*)(?:=(.*))?$/i.exec(a);
    if (!m) { pos.push(a); continue; }
    const key = m[1].toLowerCase();
    if (m[2] !== undefined) flags[key] = m[2];
    else if (valued.has(key) && i + 1 < argv.length) flags[key] = argv[++i];
    else flags[key] = true;
  }
  if (flags.y) flags.yes = true;
  if (flags.h) flags.help = true;
  return { pos, flags };
}

/* ---------------- 输出 ---------------- */

const out = (s = "") => process.stdout.write(s + "\n");
const time = (t) => (t ? new Date(t).toLocaleString() : "—");

function printStatus(s) {
  out(`${s.app} ${s.version}`);
  out(`连接：${s.connection.label}${s.connection.detail ? `（${s.connection.detail}）` : ""}${s.connection.error ? ` —— ${s.connection.error}` : ""}`);
  out(`本机 MCP：${s.bridge.localMcpUrl || "（未启动）"}`);
  out(`公开 MCP：${s.connection.publicMcpUrl || "（隧道未打通）"}`);
  if (s.publicCheck) out(`公网实测：${s.publicCheck.summary}`);
  if (s.activity) out(`活动：${s.activity.summary}`);
  if (Number.isFinite(s.edge?.readyConnections)) out(`边缘连接：${s.edge.readyConnections} 条（cloudflared 自报）`);
  out(`账号窗口：${s.profiles.total} 个，打开 ${s.profiles.open} 个`);
  out(`文件夹：${(s.folders || []).join("；") || "—"}`);
}

function printProfiles(list) {
  if (!list.length) return out("还没有账号窗口。用 windrise profiles create <名字> 新建一个。");
  for (const p of list) out(`${p.running ? "●" : "○"} ${p.name}  id=${p.id}${p.site ? `  [${p.site}]` : ""}  ${p.url || ""}`);
}

const HELP = `
windrise —— 用命令操作 Windrise Bridge

  windrise status                       查看状态（隧道、MCP 地址、账号）
  windrise tunnel start [--provider X]  打通隧道
  windrise tunnel restart --yes         重连隧道
  windrise tunnel stop --yes            断开隧道
  windrise profiles                     列出账号窗口
  windrise profiles create <名字> [--url 地址] [--site 站点]
  windrise profiles rename <账号> <新名字>
  windrise profiles delete <账号> --yes [--purge]   --purge 同时清空登录数据
  windrise open <账号> [--url 地址]     打开账号窗口
  windrise close <账号>                 关闭账号窗口（登录态保留）
  windrise folders                      列出 AI 可访问的文件夹
  windrise folders add <路径>           添加（软件会弹窗让你确认）
  windrise folders remove <路径>        移除
  windrise logs [-n 50] [--kind tunnel]
  windrise show                         把主界面叫到前台
  windrise mcp                          以 MCP 服务运行（给 Claude / Cursor 等 AI 客户端）
  windrise config                       打印给 AI 客户端用的 MCP 配置
  windrise install <客户端>             写入配置：claude-desktop / cursor / windsurf / claude-code / codex

  <账号> 可以是名字或 id。加 --json 输出原始数据；加 --no-launch 不自动启动软件。
`;

/* ---------------- MCP 标准输入输出 ↔ 本机 HTTP ---------------- */

async function runMcp() {
  const log = (s) => process.stderr.write(`[windrise mcp] ${s}\n`);
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
  let target = null, session = null, initMsg = null, initDone = null, protocol = null;

  async function resolveTarget() {
    live = null;
    const r = await call("ensure_bridge", {}, { launch: true, quiet: true, timeoutMs: 60_000 });
    target = r.localMcpUrl;
    session = null;
    return target;
  }

  async function rawPost(msg) {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (session) headers["mcp-session-id"] = session;
    if (protocol) headers["mcp-protocol-version"] = protocol;
    const response = await fetch(target, { method: "POST", headers, body: JSON.stringify(msg) });
    const sid = response.headers.get("mcp-session-id");
    if (sid) session = sid;
    if (response.status === 404 || (response.status === 400 && session && msg.method !== "initialize")) {
      throw Object.assign(new Error(`会话失效（${response.status}）`), { code: "RESET" });
    }
    const type = response.headers.get("content-type") || "";
    const replies = [];
    if (response.status === 202 || response.status === 204) return replies;
    if (type.includes("text/event-stream")) {
      const text = await response.text();
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (data) { try { replies.push(JSON.parse(data)); } catch { /* 心跳之类 */ } }
      }
    } else {
      const text = await response.text();
      if (text.trim()) {
        const parsed = JSON.parse(text);
        replies.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      }
    }
    return replies;
  }

  /** 软件重启过（端口 / 令牌变了）或会话丢了：重新找地址、重放握手 */
  async function reconnect() {
    await resolveTarget();
    if (initMsg) {
      await rawPost(initMsg);
      await rawPost({ jsonrpc: "2.0", method: "notifications/initialized" });
    }
  }

  async function forward(msg) {
    if (!target) await resolveTarget();
    try { return await rawPost(msg); }
    catch (error) {
      if (msg.method === "initialize") throw error;
      log(`连接中断，重新连接：${error.message}`);
      await reconnect();
      return rawPost(msg);
    }
  }

  async function handle(msg) {
    try {
      if (msg.method === "initialize") {
        initMsg = msg;
        protocol = msg.params?.protocolVersion || null;
        initDone = forward(msg);
        const replies = await initDone;
        replies.forEach(send);
        return;
      }
      if (initDone) await initDone.catch(() => {});
      (await forward(msg)).forEach(send);
    } catch (error) {
      log(error.message);
      if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `Windrise Bridge 连接失败：${error.message}` } });
    }
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { log("收到的不是 JSON，已忽略"); return; }
    const batch = Array.isArray(msg) ? msg : [msg];
    for (const m of batch) { const p = handle(m); pending.add(p); p.finally(() => pending.delete(p)); }
  });
  rl.on("close", async () => { await Promise.allSettled([...pending]); process.exit(0); });
}

/* ---------------- 命令 ---------------- */

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const [cmd = "help", sub, ...rest] = pos;
  const json = Boolean(flags.json);
  const launch = !flags["no-launch"];
  const print = (result, human) => (json ? out(JSON.stringify(result, null, 2)) : human(result));
  const confirm = flags.yes ? { confirm: true } : {};

  if (flags.help || cmd === "help") return out(HELP.trim());

  switch (cmd) {
    case "mcp": return runMcp();

    case "status": {
      const found = await connect({ launch: false });
      if (!found) {
        if (json) return out(JSON.stringify({ running: false }));
        out(`${APP_NAME} 没在运行。`);
        process.exitCode = 3;
        return;
      }
      return print(await call("status"), printStatus);
    }

    case "tunnel": {
      const op = sub || "status";
      const r = await call("tunnel", { op, provider: flags.provider, ...confirm }, { launch });
      return print(r, (x) => {
        if (x.message) return out(x.message);
        const c = x.connection;
        out(`连接：${c.label}${c.error ? ` —— ${c.error}` : ""}`);
        if (c.publicMcpUrl) out(`公开 MCP：${c.publicMcpUrl}`);
      });
    }

    case "profiles": case "profile": case "accounts": {
      const op = sub || "list";
      const params = { op, ...confirm };
      if (op === "create") { params.name = rest.join(" ") || flags.name; params.url = flags.url; params.site = flags.site; }
      else if (op === "rename") { params.id = rest[0]; params.newName = rest.slice(1).join(" "); }
      else if (op !== "list") { params.id = rest.join(" ") || flags.name; params.purge = Boolean(flags.purge); params.url = flags.url; }
      const r = await call("profiles", params, { launch });
      return print(r, (x) => {
        if (x.profiles && op === "list") return printProfiles(x.profiles);
        if (x.profile) return out(`已新建「${x.profile.name}」 id=${x.profile.id}`);
        if (x.renamed) return out(`已改名：${x.renamed.from} → ${x.renamed.to}`);
        if (x.deleted) return out(`已删除「${x.deleted.name}」${x.deleted.purged ? "（登录数据已清空）" : "（登录数据保留在磁盘）"}`);
        if (x.opened) return out(`已打开「${x.opened.name}」`);
        if (x.closed) return out(`已关闭「${x.closed.name}」`);
      });
    }

    case "open": case "close": {
      const key = [sub, ...rest].filter(Boolean).join(" ");
      const r = await call("profiles", { op: cmd, id: key, url: flags.url }, { launch });
      return print(r, (x) => out(x.opened ? `已打开「${x.opened.name}」` : `已关闭「${x.closed.name}」`));
    }

    case "folders": case "folder": {
      const op = sub || "list";
      const r = await call("folders", { op, path: rest.join(" ") || undefined }, { launch, timeoutMs: 10 * 60_000 });
      return print(r, (x) => {
        if (x.added) out(`已添加：${x.added}`);
        if (x.removed) out(`已移除：${x.removed}`);
        if (x.unchanged) out("这个文件夹本来就在列表里");
        (x.folders || []).forEach((f) => out(`  ${f}`));
      });
    }

    case "logs": case "log": {
      const r = await call("logs", { limit: flags.n || flags.limit || 50, kind: flags.kind, level: flags.level });
      return print(r, (x) => x.logs.forEach((l) => out(`${time(l.at)}  [${l.kind}]${l.level !== "info" ? ` ${l.level}` : ""}  ${l.text}`)));
    }

    case "show": {
      await call("show", { tab: sub || flags.tab }, { launch });
      return json ? out('{"shown":true}') : out("已把软件主界面叫到前台");
    }

    case "config": {
      const clients = require("./ai-clients.cjs");
      const home = (await findLive()) ? (await call("status")).dataHome : (process.env.BRIDGE_DATA_HOME || dataDirs()[0]);
      return out(clients.genericConfig(home));
    }

    case "install": {
      const clients = require("./ai-clients.cjs");
      if (!sub) {
        out("用法：windrise install <客户端>");
        clients.clientsStatus().forEach((c) => out(`  ${c.key.padEnd(15)}${c.name}${c.detected ? "" : "（没检测到）"}${c.configured ? "  已写入" : ""}`));
        return;
      }
      const home = (await findLive()) ? (await call("status")).dataHome : (process.env.BRIDGE_DATA_HOME || dataDirs()[0]);
      const r = clients.installClient(sub, home);
      return print(r, (x) => out(`已写入 ${x.name}：${x.file}${x.backup ? `\n原文件备份：${x.backup}` : ""}\n下一步：${x.restart}`));
    }

    case "version": case "--version": {
      const found = await findLive();
      if (found) return out((await call("status")).version);
      try { return out(require(path.join(__dirname, "..", "package.json")).version); } catch { return out("未知"); }
    }

    default:
      throw new CliError(`不认识的命令：${cmd}。运行 windrise help 查看用法`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof CliError ? "" : "出错了："}${error.message}\n`);
  process.exitCode = 1;
});
