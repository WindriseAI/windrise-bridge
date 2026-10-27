/**
 * 外部 MCP 卡死回收 —— 端到端自检（真的起进程、真的卡住、真的杀进程树、真的重连）。
 *
 * 运行：node src/external-mcp-stall-selftest.mjs
 *
 * 靶子是 _probe/fake-lane-mcp-server.mjs：照 windows-mcp 的并发模型做的单车道服务器
 * （启动器 → 服务进程两层；取消停不下车道上的活；stdin 关了要等车道空了才退出）。
 *
 * 覆盖：
 *   1. 正常调用；带 duration 参数的慢工具不会被按工具超时误判成卡死
 *   2. 卡死：按工具超时准时返回、报错里说清下一步；启动器和服务进程按进程树杀干净；后台立刻重连
 *   3. 回收后不用重新 tools/list，同名工具直接能调；另一个上游的工具不受影响
 *   4. 排队：maxConcurrent=1 时后到的调用在 Bridge 里排队，前一个卡死被回收后改到新进程上跑完
 *   5. 调用方取消：跑过 stallAfter 才取消 → 回收；很快就取消 → 不回收
 *   6. restartOn：CONTROL_UNAVAILABLE 持续超过 after 秒 → 回收
 *   7. dispose() 之后两层进程都没了
 *
 * 纪律：这里所有结论都来自实际运行输出，跑不通就如实打 FAIL，不粉饰。
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ExternalMcpManager } from "./core/external-mcp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const laneServer = path.join(repo, "_probe", "fake-lane-mcp-server.mjs");
const echoServer = path.join(repo, "_probe", "fake-mcp-server.mjs");

const tmpRoot = path.join(os.tmpdir(), `bridge-replica-stall-${Date.now()}`);
const configPath = path.join(tmpRoot, "external-mcp.json");
const pidFile = path.join(tmpRoot, "lane.pids");
mkdirSync(tmpRoot, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —— ${detail}` : ""}`);
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
};
const text = (result) => result?.content?.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";
const pids = () => (existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split(/\r?\n/) : [])
  .filter(Boolean).map(line => { const [role, pid] = line.split(" "); return { role, pid: Number(pid) }; });
async function until(predicate, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await predicate()) return true; await sleep(100); }
  return predicate();
}

writeFileSync(configPath, JSON.stringify({
  version: 1,
  mcpServers: {
    lane: {
      label: "单车道",
      transport: "stdio",
      command: process.execPath,
      args: [laneServer],
      env: { FAKE_LANE_PID_FILE: pidFile },
      toolTimeouts: { stick: 2, click: 3, wait: 1 },
      maxConcurrent: 1,
      queueTimeout: 6,
      stallAfter: 1.5,
      stallHint: "先 Screenshot 看屏幕。",
      restartOn: { pattern: "CONTROL_UNAVAILABLE", after: 1 },
    },
    echo: { label: "回声", transport: "stdio", command: process.execPath, args: [echoServer], env: { FAKE_MCP_LINGER: "0" } },
  },
}, null, 2), "utf8");

const logs = [];
const manager = new ExternalMcpManager({ configPath, log: line => { logs.push(line); console.log(`     [bridge] ${line}`); } });
const call = (server, tool, args, options) => manager.forward(server, tool, args, options);
const serverPid = async () => JSON.parse(text(await call("lane", "status", {}))).pid;

try {
  console.log("\n=== 1. 正常调用 ===");
  const listed = await manager.refresh({ force: true });
  const bindingsBefore = listed.adopted.length;
  check("两个上游的工具都挂上了", listed.adopted.some(n => n.includes("lane")) && listed.adopted.some(n => n.includes("echo")), listed.adopted.join(", "));
  const firstPid = await serverPid();
  let started = Date.now();
  const clicked = await call("lane", "click", {});
  check("click 正常返回", /clicked on/.test(text(clicked)) && Date.now() - started < 1_500, `${text(clicked)} · ${Date.now() - started}ms`);
  started = Date.now();
  const waited = await call("lane", "wait", { duration: 2.5 });
  check("wait(duration=2.5) 超过它的 1 秒工具超时也照常跑完（duration+5 规则）", /waited 2.5s/.test(text(waited)) && !waited.isError, `${text(waited)} · ${Date.now() - started}ms`);
  check("两层进程都在：启动器 + 服务进程", pids().length === 2 && pids().every(p => alive(p.pid)), JSON.stringify(pids()));

  console.log("\n=== 2. 卡死 → 准时返回 + 杀进程树 + 后台重连 ===");
  const before = pids();
  started = Date.now();
  const stuck = await call("lane", "stick", { seconds: 60 });
  const stuckMs = Date.now() - started;
  check("stick(60) 在 2 秒工具超时附近返回", stuck.isError && stuckMs >= 1_900 && stuckMs < 3_500, `${stuckMs}ms`);
  check("报错说清了：卡死、已重启、不用重新 tools/list、下一步建议", /卡死/.test(text(stuck)) && /不用重新 tools\/list/.test(text(stuck)) && /Screenshot/.test(text(stuck)), text(stuck));
  const treeGone = await until(() => before.every(p => !alive(p.pid)), 5_000);
  check("旧的启动器和服务进程都被杀了（不是只杀启动器）", treeGone, before.map(p => `${p.role} ${p.pid} ${alive(p.pid) ? "还活着" : "已退出"}`).join(" / "));
  const respawned = await until(() => pids().length >= 4, 6_000);
  check("没等下一个调用，后台已经重新拉起", respawned, JSON.stringify(pids().slice(2)));

  console.log("\n=== 3. 回收后直接能用，别的上游不受影响 ===");
  started = Date.now();
  const again = await call("lane", "click", {});
  const secondPid = await serverPid();
  check("同名工具不 refresh 直接能调，跑在新进程上", /clicked on/.test(text(again)) && secondPid !== firstPid, `${text(again)} · ${Date.now() - started}ms · ${firstPid} → ${secondPid}`);
  const echoed = await call("echo", "echo", { text: "still-here" });
  check("另一个上游 echo 照常可用（没有被一起摘掉）", text(echoed) === "echo:still-here", text(echoed));
  check("绑定没有被清空", manager.bindings.size === bindingsBefore, `${manager.bindings.size}/${bindingsBefore}`);

  console.log("\n=== 4. 排队：后到的调用不陪着卡死，回收后在新进程上跑完 ===");
  await sleep(10_500); // 过了自动重连的限流间隔，这一轮也走「后台立刻重连」
  const pidBeforeQueue = await serverPid();
  const stuckCall = call("lane", "stick", { seconds: 60 });
  await sleep(200);
  started = Date.now();
  const queued = await call("lane", "click", {});
  const queuedMs = Date.now() - started;
  const stuckResult = await stuckCall;
  const pidAfterQueue = await serverPid();
  check("前一个卡死调用按卡死返回", stuckResult.isError && /卡死/.test(text(stuckResult)), text(stuckResult).slice(0, 60));
  check("排队的 click 在新进程上成功（没有报并发已满，也没有一起超时）", /clicked on/.test(text(queued)) && !queued.isError && pidAfterQueue !== pidBeforeQueue, `${text(queued)} · 排队+执行 ${queuedMs}ms`);

  console.log("\n=== 5. 调用方取消 ===");
  await sleep(10_500);
  let pidBefore = await serverPid();
  const late = new AbortController();
  const lateCall = call("lane", "stick", { seconds: 60 }, { signal: late.signal });
  setTimeout(() => late.abort(), 1_800);
  await lateCall;
  await until(async () => pids().length > 0 && (await serverPid().catch(() => pidBefore)) !== pidBefore, 6_000);
  const pidAfterLate = await serverPid();
  check("跑了 1.8 秒（> stallAfter 1.5）才取消 → 按卡死回收", pidAfterLate !== pidBefore, `${pidBefore} → ${pidAfterLate}`);
  pidBefore = pidAfterLate;
  const early = new AbortController();
  const earlyCall = call("lane", "click", {}, { signal: early.signal });
  early.abort();
  await earlyCall;
  await sleep(500);
  check("很快就取消 → 不回收", (await serverPid()) === pidBefore, `仍是 ${pidBefore}`);

  console.log("\n=== 6. restartOn：CONTROL_UNAVAILABLE 持续 1 秒以上 → 回收 ===");
  await sleep(10_500);
  pidBefore = await serverPid();
  // 中间不调 status：它是正常结果，会把「持续不可用」的计时清零；这里看 PID 文件判断有没有重拉
  const spawnedBefore = pids().length;
  await call("lane", "unavailable", {});
  await sleep(300);
  check("第一次 CONTROL_UNAVAILABLE 不回收", pids().length === spawnedBefore, `进程记录 ${spawnedBefore} → ${pids().length}`);
  await sleep(1_100);
  await call("lane", "unavailable", {});
  const recycledOnResult = await until(() => pids().length >= spawnedBefore + 2, 6_000);
  check("持续超过 1 秒后回收", recycledOnResult && (await serverPid()) !== pidBefore, `${pidBefore} → ${await serverPid()}`);
} finally {
  console.log("\n=== 7. dispose() ===");
  const all = pids();
  await manager.dispose();
  const gone = await until(() => all.every(p => !alive(p.pid)), 6_000);
  check("dispose 后所有启动器与服务进程都没了", gone, all.filter(p => alive(p.pid)).map(p => `${p.role} ${p.pid} 还活着`).join(" / ") || `${all.length} 个进程全部退出`);
}

const failed = results.filter(r => !r.ok);
if (failed.length) console.log(`\n未通过：${failed.map(f => f.name).join("；")}`);
console.log(`通过 ${results.length - failed.length}/${results.length}`);
process.exit(failed.length ? 1 : 0);
