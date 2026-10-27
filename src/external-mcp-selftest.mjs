/**
 * 外部 MCP 转发 —— 端到端自检（真的起进程、真的连、真的调用、真的检查残留）。
 *
 * 运行：node src/external-mcp-selftest.mjs
 *
 * 覆盖：
 *   1. stdio 外部服务器：配置 → boot → tools/list 里出现带前缀的外部工具
 *   2. 真的调用一次外部工具（echo / add / now），确认返回值原样透传
 *   3. 前缀生效、与内置 18 个工具不撞名
 *   4. 同服务器内净化后撞名的工具被双双丢弃；与内置同名的上游工具靠前缀安全挂载
 *   5. stop() 之后假服务器的子进程真的没了（PID 级验证 + tasklist 证据）
 *   6. 容错：配置损坏 / 服务器起不来 / 条目非法，Bridge 照样能启动
 *   7. configure_mcp：list / test / disable / enable / add / reload / remove 全流程
 *   8. HTTP 传输（Streamable HTTP）连得上、调得通
 *
 * 纪律：这里所有结论都来自实际运行输出，跑不通就如实打 FAIL，不粉饰。
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { boot } from "./standalone.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const fakeServer = path.join(repo, "_probe", "fake-mcp-server.mjs");

const tmpRoot = path.join(os.tmpdir(), `bridge-replica-external-mcp-${Date.now()}`);
const dataHome = path.join(tmpRoot, "data");
const configPath = path.join(dataHome, "external-mcp.json");
const pidFile = path.join(tmpRoot, "fake-stdio.pid");
const logFile = path.join(tmpRoot, "bridge-log.txt");
mkdirSync(dataHome, { recursive: true });
// 别把测试写进真实用户的 ~/.bridge-replica-shared
process.env.BRIDGE_SHARED_DATA_HOME = path.join(tmpRoot, "shared");

const BUILTIN_18 = [
  "read_files", "read_image", "find_files", "search_files", "apply_patch", "batch_file_tools",
  "list_directory", "run_command", "get_command_output", "send_command_input", "cancel_command",
  "get_diagnostics", "lsp", "set_todos", "update_plan", "report_progress", "list_skills", "configure_mcp",
];

const results = [];
const logLines = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —— ${detail}` : ""}`);
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
};
function writeConfig(value) {
  writeFileSync(configPath, typeof value === "string" ? value : JSON.stringify(value, null, 2), "utf8");
}
function readConfig() {
  return JSON.parse(readFileSync(configPath, "utf8"));
}
function bridgeLog(event) {
  const line = JSON.stringify(event);
  logLines.push(line);
  if (event?.text) console.log(`     [bridge] ${event.text}`);
}

/** 最小 MCP 客户端（走 Bridge 的 HTTP 端点，和真实外部客户端同一条路）。 */
function mcpClient(url) {
  let sessionId = null;
  let id = 0;
  const post = async (method, params) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (!sessionId) sessionId = response.headers.get("mcp-session-id");
    const body = await response.json();
    if (body.error) throw new Error(`${method} 失败：${JSON.stringify(body.error)}`);
    return body.result;
  };
  return {
    initialize: () => post("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "external-mcp-selftest", version: "1" } }),
    listTools: async () => (await post("tools/list", {}))?.tools ?? [],
    call: (name, args) => post("tools/call", { name, arguments: args ?? {} }),
    text: (result) => result?.content?.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "",
  };
}

/** 起一个假 HTTP MCP 服务器子进程，返回 { port, kill }。 */
async function startFakeHttpServer() {
  const child = spawn(process.execPath, [fakeServer, "--http", "0"], {
    cwd: repo,
    env: { ...process.env, FAKE_MCP_LINGER: "1" },
    windowsHide: true,
  });
  const port = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("假 HTTP 服务器 5 秒内没报端口")), 5_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const match = /"port":(\d+)/.exec(buffer);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.on("error", reject);
  });
  return { port, pid: child.pid, kill: () => child.kill() };
}

/* ================================================================== *
 * 阶段 0：配置
 * ================================================================== */
console.log("\n=== 阶段 0：写配置（1 个能用的 stdio 服务器 + 1 个起不来的 + 2 个非法条目）===");
writeConfig({
  version: 1,
  mcpServers: {
    test: {
      label: "测试服务器",
      transport: "stdio",
      command: process.execPath,
      args: [fakeServer],
      env: { FAKE_MCP_PID_FILE: pidFile, FAKE_MCP_LINGER: "1" },
      enabled: true,
    },
    broken: {
      label: "起不来的服务器",
      transport: "stdio",
      command: "definitely-not-a-real-command-bridge-replica",
      enabled: true,
    },
    nourl: { label: "缺 url 的 http 服务器", transport: "http", enabled: true },
    "Bad Id!": { label: "非法 id", command: process.execPath, enabled: true },
  },
});
console.log(`  配置文件：${configPath}`);

/* ================================================================== *
 * 阶段 1：启动 Bridge
 * ================================================================== */
console.log("\n=== 阶段 1：boot() 连接外部 MCP ===");
// 这个自检的 MCP 客户端按 JSON 读响应体，测的不是传输方式；默认已改成 SSE，所以下面每处 boot() 都显式要 JSON
const app = await boot({ toolTier: "full", roots: [repo], dataHome, browser: false, options: { jsonResponse: true }, onLog: bridgeLog });
const client = mcpClient(app.server.localUrl);
const init = await client.initialize();
check("Bridge 起来了（坏服务器没拖死启动）", Boolean(app.server.localUrl) && Boolean(init?.protocolVersion), `协议 ${init?.protocolVersion}`);
check("假 stdio 服务器真的被拉起来了（PID 文件已写）", existsSync(pidFile), existsSync(pidFile) ? `pid=${readFileSync(pidFile, "utf8")}` : "没有 PID 文件");
const stdioPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : null;

/* ================================================================== *
 * 阶段 2：tools/list
 * ================================================================== */
console.log("\n=== 阶段 2：tools/list ===");
const tools = await client.listTools();
const names = tools.map(tool => tool.name);
const externalNames = names.filter(name => name.startsWith("ext__"));
console.log(`  工具总数 ${names.length}：${names.join(", ")}`);

const missingBuiltin = BUILTIN_18.filter(name => !names.includes(name));
check("内置 18 个工具齐全", missingBuiltin.length === 0, missingBuiltin.length ? `缺：${missingBuiltin.join(", ")}` : "18/18");

const expectedExternal = ["ext__test__echo", "ext__test__add", "ext__test__now", "ext__test__read_files"];
const missingExternal = expectedExternal.filter(name => !names.includes(name));
check("外部工具已带前缀挂载", missingExternal.length === 0, missingExternal.length ? `缺：${missingExternal.join(", ")}` : expectedExternal.join(", "));

check("同服务器内净化撞名的工具被双双丢弃", !names.includes("ext__test__collide_a") && !names.includes("ext__test__collide_a_"), "ext__test__collide_a 未出现");
check("起不来的服务器没有产出任何工具", !names.some(name => name.startsWith("ext__broken__")), "");
check("外部工具名不与任何内置工具重名", externalNames.every(name => !BUILTIN_18.includes(name)), "");

// 注意：不要硬编码本地工具总数。
// 除了内置 18 个，桥还可能挂上浏览器工具（界面开着时）和共享上下文工具（总是挂载），
// 数量会随功能增减而变化。这里改成动态算：本地工具 = 总数 - 外部工具。
const localNames = names.filter(name => !name.startsWith("ext__"));
check(
  "工具总数 = 本地工具 + 5 个外部工具",
  externalNames.length === 5 && names.length === localNames.length + 5,
  `总数 ${names.length} = 本地 ${localNames.length} + 外部 ${externalNames.length}`
);
check(
  "本地工具里包含内置 18 个（说明没被外部工具挤掉）",
  BUILTIN_18.every(name => localNames.includes(name)),
  `本地工具：${localNames.length} 个`
);

// 超长工具名：上游名 66 字符，加前缀后超过注册表 64 字符上限，必须截断且仍可用
const longName = names.find(name => name.startsWith("ext__test__") && name.includes("get_issue_or_pull"));
check("超长工具名被截断到 64 字符以内且仍挂载", Boolean(longName) && longName.length <= 64, `${longName}（${longName?.length ?? "?"} 字符）`);
const longCall = await client.call(longName, { owner: "bridge" });
check("超长名工具仍能正常调用", client.text(longCall) === "long-name-ok:bridge", JSON.stringify(client.text(longCall)));

const echoTool = tools.find(tool => tool.name === "ext__test__echo");
check("外部工具的 title 带服务器标签", /测试服务器/.test(echoTool?.title ?? ""), echoTool?.title ?? "(无)");
check("外部工具的 inputSchema 原样带过来", echoTool?.inputSchema?.properties?.text?.type === "string", JSON.stringify(echoTool?.inputSchema?.properties ?? {}));
check("外部工具标注为破坏性/开放世界（能力等级无从得知）", echoTool?.annotations?.destructiveHint === true && echoTool?.annotations?.openWorldHint === true, JSON.stringify(echoTool?.annotations ?? {}));

/* ================================================================== *
 * 阶段 3：真的调用外部工具
 * ================================================================== */
console.log("\n=== 阶段 3：真的调用外部工具 ===");
const echoResult = await client.call("ext__test__echo", { text: "hello-from-selftest" });
const echoText = client.text(echoResult);
check("ext__test__echo 返回值正确透传", echoText === "echo:hello-from-selftest", JSON.stringify(echoText));

const echoPrefixed = await client.call("ext__test__echo", { text: "abc", prefix: "SELFTEST" });
check("外部工具收到的是调用方参数（prefix 生效）", client.text(echoPrefixed) === "SELFTEST:abc", JSON.stringify(client.text(echoPrefixed)));

const addResult = await client.call("ext__test__add", { a: 2, b: 40 });
check("ext__test__add 数值参数与结果正确", client.text(addResult) === "42", JSON.stringify(client.text(addResult)));
check("ext__test__add 的 structuredContent 也透传", addResult?.structuredContent?.sum === 42, JSON.stringify(addResult?.structuredContent ?? {}));

const nowResult = await client.call("ext__test__now", {});
check("ext__test__now 返回可解析的 ISO 时间", !Number.isNaN(Date.parse(client.text(nowResult))), JSON.stringify(client.text(nowResult)));

const fakeRead = await client.call("ext__test__read_files", { path: "abc.txt" });
check("与内置同名的上游工具走的是外部转发（不是内置实现）", client.text(fakeRead) === "fake-read:abc.txt", JSON.stringify(client.text(fakeRead)));

const builtinCall = await client.call("list_directory", { path: ".", depth: 1 });
check("内置工具仍然正常（外部挂载没破坏本地工具）", !builtinCall?.isError && client.text(builtinCall).length > 0, client.text(builtinCall).split("\n")[0]);

const unknown = await client.call("ext__test__nope", {});
check("调用不存在的工具被明确拒绝", unknown?.isError === true, client.text(unknown).slice(0, 80));

/* ================================================================== *
 * 阶段 4：stop() 之后子进程必须消失
 * ================================================================== */
console.log("\n=== 阶段 4：stop() 与进程清理 ===");
await app.stop();
let gone = false;
for (let attempt = 0; attempt < 40; attempt++) {
  if (stdioPid && !alive(stdioPid)) { gone = true; break; }
  await sleep(100);
}
check("stop() 之后假 stdio 服务器进程已消失", gone, stdioPid ? `pid=${stdioPid} 存活检查=${alive(stdioPid) ? "仍存活" : "已退出"}` : "无 PID 可查");

if (stdioPid) {
  const tasklist = await new Promise((resolve) => {
    const child = spawn("tasklist", ["/FI", `PID eq ${stdioPid}`], { windowsHide: true });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk.toString("utf8"); });
    child.on("close", () => resolve(out.trim()));
    child.on("error", () => resolve("(tasklist 不可用)"));
  });
  console.log(`     tasklist /FI "PID eq ${stdioPid}" 输出：${tasklist.split("\n").map(line => line.trim()).filter(Boolean).join(" | ")}`);
  check("tasklist 也查不到该 PID", !new RegExp(`\\b${stdioPid}\\b`).test(tasklist) || /没有运行的任务|No tasks are running/i.test(tasklist), "");
}

/* ================================================================== *
 * 阶段 5：配置损坏也能启动
 * ================================================================== */
console.log("\n=== 阶段 5：容错（配置损坏 / 非法条目）===");
writeConfig("{ 这不是 JSON ][");
const logs2 = [];
const app2 = await boot({ toolTier: "full", roots: [repo], dataHome, browser: false, options: { jsonResponse: true }, onLog: (event) => { logs2.push(JSON.stringify(event)); if (event?.text) console.log(`     [bridge] ${event.text}`); } });
check("配置文件损坏时 Bridge 仍能启动", Boolean(app2.server.localUrl), app2.server.localUrl ? "已启动" : "未启动");
const client2 = mcpClient(app2.server.localUrl);
await client2.initialize();
const names2 = (await client2.listTools()).map(tool => tool.name);
// 同样不硬编码：配置坏掉后应该是「本地工具都在、外部工具一个不剩」。
// 本地工具数量随功能变化（内置 + 浏览器 + 上下文），所以只断言「外部被摘干净」和「内置还在」。
const names2Local = names2.filter(name => !name.startsWith("ext__"));
check(
  "配置损坏时外部工具全部摘掉（本地工具不受影响）",
  !names2.some(name => name.startsWith("ext__")) && BUILTIN_18.every(name => names2Local.includes(name)),
  `总数 ${names2.length} = 本地 ${names2Local.length} + 外部 0`
);
check("配置损坏被记录到日志", logs2.some(line => line.includes("JSON 解析失败")), "");
const configureList2 = await client2.call("configure_mcp", { action: "list" });
check("配置损坏时 configure_mcp list 可用（报出问题条目）", !configureList2?.isError && /JSON 解析失败/.test(client2.text(configureList2)), client2.text(configureList2).split("\n").slice(-1)[0]);
await app2.stop();

/* ================================================================== *
 * 阶段 6：configure_mcp 全流程 + HTTP 传输
 * ================================================================== */
console.log("\n=== 阶段 6：configure_mcp 全流程 ===");
writeConfig({
  version: 1,
  mcpServers: {
    test: { label: "测试服务器", transport: "stdio", command: process.execPath, args: [fakeServer], env: { FAKE_MCP_PID_FILE: pidFile, FAKE_MCP_LINGER: "1" }, enabled: true },
  },
});
const app3 = await boot({ toolTier: "full", roots: [repo], dataHome, browser: false, options: { jsonResponse: true }, onLog: bridgeLog });
const client3 = mcpClient(app3.server.localUrl);
await client3.initialize();

const listResult = await client3.call("configure_mcp", { action: "list" });
const listText = client3.text(listResult);
check("configure_mcp list 报出服务器与运行状态", /test/.test(listText) && /running/.test(listText), listText.split("\n")[0]);

const testResult = await client3.call("configure_mcp", { action: "test", name: "test" });
check("configure_mcp test 真连一次并报工具数", testResult?.structuredContent?.reachable === true && testResult?.structuredContent?.toolCount === 7, client3.text(testResult));

const disableResult = await client3.call("configure_mcp", { action: "disable", name: "test" });
const afterDisable = (await client3.listTools()).map(tool => tool.name);
check("disable 之后外部工具立刻消失", !afterDisable.some(name => name.startsWith("ext__test__")), `${afterDisable.length} 个工具`);
check("disable 写进了配置文件", readConfig().mcpServers.test.enabled === false, JSON.stringify(readConfig().mcpServers.test.enabled));
check("disable 回报里说明已重连", /已停用/.test(client3.text(disableResult)), client3.text(disableResult).split("\n")[0]);

await client3.call("configure_mcp", { action: "enable", name: "test" });
const afterEnable = (await client3.listTools()).map(tool => tool.name);
check("enable 之后外部工具回来了", afterEnable.includes("ext__test__echo"), `${afterEnable.length} 个工具`);

const reloadResult = await client3.call("configure_mcp", { action: "reload" });
check("reload 重新读配置并重连", /已重新读取配置/.test(client3.text(reloadResult)) && /test：running/.test(client3.text(reloadResult)), client3.text(reloadResult).split("\n").slice(0, 2).join(" / "));

// —— HTTP 传输 ——
console.log("\n=== 阶段 6b：HTTP（Streamable HTTP）传输 ===");
const httpServer = await startFakeHttpServer();
console.log(`     假 HTTP MCP 服务器：http://127.0.0.1:${httpServer.port}/mcp（pid=${httpServer.pid}）`);
const addResult2 = await client3.call("configure_mcp", {
  action: "add",
  name: "httpfake",
  label: "假 HTTP 服务器",
  url: `http://127.0.0.1:${httpServer.port}/mcp`,
  httpTransport: "streamable-http",
});
const httpAdopted = addResult2?.structuredContent?.adopted ?? [];
check("add 一个 HTTP 服务器后工具被挂上", httpAdopted.includes("ext__httpfake__echo"), client3.text(addResult2).split("\n")[0]);

const httpEcho = await client3.call("ext__httpfake__echo", { text: "over-http", prefix: "HTTP" });
check("HTTP 转发的调用真的到达上游并透传返回值", client3.text(httpEcho) === "HTTP:over-http", JSON.stringify(client3.text(httpEcho)));

const removeResult = await client3.call("configure_mcp", { action: "remove", name: "httpfake" });
check("remove 之后配置里没有该条目", !("httpfake" in (readConfig().mcpServers ?? {})), JSON.stringify(Object.keys(readConfig().mcpServers ?? {})));
const afterRemove = (await client3.listTools()).map(tool => tool.name);
check("remove 之后外部工具被摘掉", !afterRemove.some(name => name.startsWith("ext__httpfake__")), `${afterRemove.length} 个工具`);
check("remove 的写操作是原子写（文件仍是合法 JSON）", (() => { try { readConfig(); return true; } catch { return false; } })(), "");

httpServer.kill();
await app3.stop();
let httpGone = false;
for (let attempt = 0; attempt < 30; attempt++) {
  if (!alive(httpServer.pid)) { httpGone = true; break; }
  await sleep(100);
}
check("测试脚本自己起的 HTTP 子进程也已回收", httpGone, `pid=${httpServer.pid}`);

/* ================================================================== *
 * 阶段 7：断线 → 优雅报错 → 自动重连
 * ================================================================== */
console.log("\n=== 阶段 7：上游崩溃后的优雅报错与自动重连 ===");
const pidFile2 = path.join(tmpRoot, "fake-stdio-2.pid");
writeConfig({
  version: 1,
  mcpServers: {
    test: { label: "测试服务器", transport: "stdio", command: process.execPath, args: [fakeServer], env: { FAKE_MCP_PID_FILE: pidFile2, FAKE_MCP_LINGER: "1" }, enabled: true },
  },
});
const app4 = await boot({ toolTier: "full", roots: [repo], dataHome, browser: false, options: { jsonResponse: true }, onLog: bridgeLog });
const client4 = mcpClient(app4.server.localUrl);
await client4.initialize();
check("重连测试：初始调用正常", client4.text(await client4.call("ext__test__echo", { text: "before-kill" })) === "echo:before-kill", "");

const pid2 = Number(readFileSync(pidFile2, "utf8"));
process.kill(pid2, "SIGKILL"); // 模拟上游进程崩溃（不带任何清理机会）
let killed = false;
for (let attempt = 0; attempt < 40; attempt++) {
  if (!alive(pid2)) { killed = true; break; }
  await sleep(100);
}
check("上游进程已被强制杀掉", killed, `pid=${pid2}`);
await sleep(500); // 等传输层的 onclose 回调落地

const afterKill = await client4.call("ext__test__echo", { text: "after-kill" });
// 上游崩溃后 Bridge 只回收它自己并后台重连（见 external-mcp.js 设计要点 11）：赶上了就直接成功，没赶上就优雅报错
const afterKillText = client4.text(afterKill);
check(
  "上游断开后调用不崩溃/不挂死（已自动重连则直接成功，否则优雅报错）",
  afterKillText === "echo:after-kill" || afterKill?.isError === true,
  `${afterKill?.isError ? "优雅报错" : "已自动重连"}：${afterKillText.slice(0, 80)}`,
);

// 下一次 tools/list 会触发懒刷新 → 自动重连（新子进程）
const reconnected = (await client4.listTools()).map(tool => tool.name);
check("断线后自动重连，工具重新挂上", reconnected.includes("ext__test__echo"), `${reconnected.length} 个工具`);
const pidAfterReconnect = existsSync(pidFile2) ? Number(readFileSync(pidFile2, "utf8")) : null;
check("重连确实拉起了新的子进程", pidAfterReconnect !== null && pidAfterReconnect !== pid2, `旧 pid=${pid2}，新 pid=${pidAfterReconnect}`);
const afterReconnect = await client4.call("ext__test__echo", { text: "after-reconnect" });
check("重连后调用恢复正常", client4.text(afterReconnect) === "echo:after-reconnect", JSON.stringify(client4.text(afterReconnect)));
await app4.stop();

/* ================================================================== *
 * 阶段 8：白名单/黑名单、${VAR} 环境变量、http auto 模式、写入规范化
 * ================================================================== */
console.log("\n=== 阶段 8：工具名单 / ${VAR} 环境变量 / http auto / 写入规范化 ===");
process.env.SELFTEST_FAKE_PID_FILE = path.join(tmpRoot, "fake-stdio-3.pid");
const app5 = await boot({ toolTier: "full", roots: [repo], dataHome, browser: false, options: { jsonResponse: true }, onLog: bridgeLog });
const client5 = mcpClient(app5.server.localUrl);
await client5.initialize();

// ${VAR} 展开：配置里只写占位符，实际值来自宿主环境
const addVar = await client5.call("configure_mcp", {
  action: "add", name: "envvar", label: "环境变量展开",
  command: process.execPath, args: [fakeServer],
  env: { FAKE_MCP_PID_FILE: "${SELFTEST_FAKE_PID_FILE}", FAKE_MCP_LINGER: "1" },
  tool_deny: ["now", "read_files"],
});
check("add 时 env 支持 ${VAR} 占位符（子进程真的拿到了展开后的值）", existsSync(path.join(tmpRoot, "fake-stdio-3.pid")), addVar?.structuredContent?.adopted?.length ? `挂载 ${addVar.structuredContent.adopted.join(", ")}` : client5.text(addVar));

const varTools = (await client5.listTools()).map(tool => tool.name);
check("tool_deny 黑名单生效（now / read_files 被过滤）", !varTools.includes("ext__envvar__now") && !varTools.includes("ext__envvar__read_files") && varTools.includes("ext__envvar__echo"), varTools.filter(n => n.startsWith("ext__envvar__")).join(", "));

const stored = readConfig().mcpServers.envvar;
check("写入的是规范化配置（没有 name/id 残留，transport 已推断）", !("name" in stored) && !("id" in stored) && stored.transport === "stdio", JSON.stringify(Object.keys(stored)));

// http auto：先试 streamable-http（假服务器支持），应当直接连上
const httpServer2 = await startFakeHttpServer();
const addAuto = await client5.call("configure_mcp", {
  action: "add", name: "httpauto", label: "auto 模式",
  url: `http://127.0.0.1:${httpServer2.port}/mcp`, httpTransport: "auto",
});
check("httpTransport=auto 能连上（第一跳 streamable-http 成功）", (addAuto?.structuredContent?.adopted ?? []).includes("ext__httpauto__echo"), client5.text(addAuto).split("\n")[0]);
check("auto 模式转发的调用正常", client5.text(await client5.call("ext__httpauto__echo", { text: "auto", prefix: "A" })) === "A:auto", "");
httpServer2.kill();

// 白名单
await client5.call("configure_mcp", { action: "add", name: "allowlist", label: "白名单", command: process.execPath, args: [fakeServer], tool_allow: ["echo", "add"] });
const allowTools = (await client5.listTools()).map(tool => tool.name).filter(name => name.startsWith("ext__allowlist__"));
check("tool_allow 白名单生效（只挂 echo/add）", allowTools.length === 2 && allowTools.includes("ext__allowlist__echo") && allowTools.includes("ext__allowlist__add"), allowTools.join(", "));

// origin 守卫：地址里带 userinfo 必须被拒（防止把凭据写进 URL，也防止被引到别的 origin）
const httpServer3 = await startFakeHttpServer();
const guardResult = await client5.call("configure_mcp", {
  action: "add", name: "guarded", label: "带 userinfo 的地址",
  url: `http://user:secret@127.0.0.1:${httpServer3.port}/mcp`, httpTransport: "streamable-http",
});
const guardTools = (await client5.listTools()).map(tool => tool.name).filter(name => name.startsWith("ext__guarded__"));
check("带 userinfo 的 http 地址被 origin 守卫拒绝（没有挂上任何工具）", guardTools.length === 0, guardTools.join(", ") || "0 个");
const guardList = await client5.call("configure_mcp", { action: "list" });
check("被守卫拒绝的服务器给出可读原因", /origin/.test(client5.text(guardList)) && /必须停留在配置的 origin/.test(client5.text(guardList)), client5.text(guardList).split("\n").find(line => line.includes("guarded")) ?? "");
httpServer3.kill();

await app5.stop();

/* ================================================================== *
 * 阶段 9：全局残留进程清扫（所有连接都应已关闭）
 * ================================================================== */
console.log("\n=== 阶段 9：全局残留进程检查 ===");
await sleep(800);
const orphans = await new Promise((resolve) => {
  const child = spawn("powershell.exe", ["-NoProfile", "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*fake-mcp-server.mjs*' } | Select-Object -ExpandProperty ProcessId"],
    { windowsHide: true });
  let out = "";
  child.stdout.on("data", chunk => { out += chunk.toString("utf8"); });
  child.on("close", () => resolve(out.trim()));
  child.on("error", () => resolve("(powershell 不可用)"));
});
check("没有任何残留的假 MCP 服务器进程", orphans === "", orphans ? `残留 PID：${orphans.replace(/\s+/g, ", ")}` : "0 个");

/* ================================================================== *
 * 汇总
 * ================================================================== */
writeFileSync(logFile, logLines.join("\n"), "utf8");
const failed = results.filter(item => !item.ok);
console.log("\n=== 汇总 ===");
console.log(`通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log("失败项：");
  for (const item of failed) console.log(`  - ${item.name}${item.detail ? `（${item.detail}）` : ""}`);
}
console.log(`Bridge 日志：${logFile}`);
console.log(`临时目录（含配置与 PID 文件，保留供复查）：${tmpRoot}`);
process.exit(failed.length ? 1 : 0);
