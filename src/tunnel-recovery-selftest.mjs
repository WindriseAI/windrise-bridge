#!/usr/bin/env node
/**
 * 隧道断线自恢复自检 —— 纯 Node，不联网、不起 cloudflared、不访问外网。
 *
 * 运行：node src/tunnel-recovery-selftest.mjs
 *
 * 覆盖（对应 docs/research/bridge-disconnect-2026-10-24.md 的修法 2、3）：
 *   EdgeRelay：双向转发、上下游都开 10 秒保活 + noDelay、dropAll 只断连接不停端口、
 *              边缘主动断开时客户端被关、客户端断开 / 出错时上游被销毁。
 *   TunnelManager：reconnect 重新选线路再拉起、并发只跑一次、边缘全掉走统一重连、
 *              网卡指纹变化经防抖后重连、指纹不变 / blocked / 已 stop 时不重连、
 *              noteWake 5 秒内只算一次、bypass 绑定地址消失立刻重连。
 *
 * 副作用隔离：数据写在系统临时目录；TunnelManager 的 spawnCloudflared 被替换成假子进程，
 * 不会真的执行任何外部程序。
 */

import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { EdgeRelay } from "./core/edge-relay.js";
import { TunnelManager, maskAddress, namedTunnelArgs } from "./core/tunnel.js";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —— ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 1500, stepMs = 10) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

const v4 = (address, extra = {}) => ({ address, family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", ...extra });

/* ======================================================================
 * EdgeRelay
 * ==================================================================== */
async function runRelayChecks() {
  const edgeSockets = [];
  // 假的「Cloudflare 边缘服务器」：收到什么都原样前缀回去，便于确认双向通了
  const edge = net.createServer((socket) => {
    edgeSockets.push(socket);
    socket.on("data", (chunk) => socket.write(Buffer.concat([Buffer.from("echo:"), chunk])));
  });
  await new Promise((resolve, reject) => {
    edge.once("error", reject);
    edge.listen(0, "127.0.0.1", resolve);
  });
  const edgePort = edge.address().port;
  const relay = new EdgeRelay({ bind: { localAddress: "127.0.0.1" }, hosts: ["127.0.0.1"], port: edgePort, onLog: () => {} });

  const keepAliveCalls = [];
  const noDelayCalls = [];
  const realSetKeepAlive = net.Socket.prototype.setKeepAlive;
  const realSetNoDelay = net.Socket.prototype.setNoDelay;
  net.Socket.prototype.setKeepAlive = function patchedSetKeepAlive(enable, delay) {
    keepAliveCalls.push({ socket: this, enable, delay });
    return realSetKeepAlive.call(this, enable, delay);
  };
  net.Socket.prototype.setNoDelay = function patchedSetNoDelay(enable) {
    noDelayCalls.push({ socket: this, enable });
    return realSetNoDelay.call(this, enable);
  };

  const clients = [];
  const wasClosed = new WeakMap();
  const connectClient = async (relayPort) => {
    const socket = net.connect(relayPort, "127.0.0.1");
    clients.push(socket);
    wasClosed.set(socket, false);
    socket.on("close", () => wasClosed.set(socket, true));
    socket.on("data", () => {});
    await new Promise((resolve, reject) => {
      const onError = (error) => { socket.removeListener("connect", onConnect); reject(error); };
      const onConnect = () => { socket.removeListener("error", onError); resolve(); };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
    socket.on("error", () => {}); // 后面主动制造错误，别让测试进程崩
    return socket;
  };

  try {
    const address = await relay.start();
    const relayPort = Number(address.split(":")[1]);

    /* ---- 双向转发 + 保活 ---- */
    const first = await connectClient(relayPort);
    const received = [];
    first.on("data", (chunk) => received.push(chunk.toString()));
    await waitFor(() => edgeSockets.length === 1);
    first.write("hello");
    const forwarded = await waitFor(() => received.join("").includes("echo:hello"));
    edgeSockets[0]?.write("world");
    const back = await waitFor(() => received.join("").includes("world"));
    check("中继：客户端→边缘、边缘→客户端都能转发", forwarded && back, "hello / world");

    await sleep(50);
    const upstreamKeepAlive = keepAliveCalls.filter((c) => c.socket.remotePort === edgePort);
    const clientKeepAlive = keepAliveCalls.filter((c) => c.socket.localPort === relayPort);
    check(
      "中继：上游和客户端两侧都开了 10 秒 TCP 保活",
      upstreamKeepAlive.some((c) => c.enable === true && c.delay === 10_000)
        && clientKeepAlive.some((c) => c.enable === true && c.delay === 10_000),
      `上游 ${upstreamKeepAlive.length} 次，客户端 ${clientKeepAlive.length} 次`,
    );
    const upstreamNoDelay = noDelayCalls.filter((c) => c.socket.remotePort === edgePort);
    const clientNoDelay = noDelayCalls.filter((c) => c.socket.localPort === relayPort);
    check(
      "中继：两侧都设置了 noDelay",
      upstreamNoDelay.some((c) => c.enable === true) && clientNoDelay.some((c) => c.enable === true),
      `上游 ${upstreamNoDelay.length} 次，客户端 ${clientNoDelay.length} 次`,
    );

    /* ---- dropAll：断连接、端口还活着 ---- */
    relay.dropAll();
    const dropped = await waitFor(() => wasClosed.get(first) && (edgeSockets[0]?.destroyed || edgeSockets[0]?.readableEnded));
    check("中继：dropAll 后客户端和假边缘两头都断开", dropped);

    const second = await connectClient(relayPort);
    const secondReceived = [];
    second.on("data", (chunk) => secondReceived.push(chunk.toString()));
    await waitFor(() => edgeSockets.length === 2);
    second.write("again");
    const secondForwarded = await waitFor(() => secondReceived.join("").includes("echo:again"));
    check("中继：dropAll 之后仍能接受新连接并转发", secondForwarded && edgeSockets.length === 2);

    /* ---- 边缘主动断开 → 客户端被关 ---- */
    edgeSockets[1]?.destroy();
    const edgeClosedClient = await waitFor(() => wasClosed.get(second));
    check("中继：假边缘主动断开时客户端也被关", edgeClosedClient);

    /* ---- 客户端断开 → 上游被销毁 ---- */
    const third = await connectClient(relayPort);
    await waitFor(() => edgeSockets.length === 3);
    third.destroy();
    const upstreamGone = await waitFor(() => edgeSockets[2]?.destroyed || edgeSockets[2]?.readableEnded);
    check("中继：客户端断开时上游被销毁", upstreamGone);

    /* ---- 客户端出错 → 上游被销毁 ---- */
    const fourth = await connectClient(relayPort);
    await waitFor(() => edgeSockets.length === 4);
    const relaySideClient = [...relay.sockets].find((s) => s.localPort === relayPort);
    relaySideClient?.emit("error", new Error("自检：客户端出错"));
    const upstreamGoneOnError = await waitFor(() => edgeSockets[3]?.destroyed || edgeSockets[3]?.readableEnded);
    check("中继：客户端出错时上游被销毁", Boolean(relaySideClient) && upstreamGoneOnError);
    fourth.destroy();
  } finally {
    net.Socket.prototype.setKeepAlive = realSetKeepAlive;
    net.Socket.prototype.setNoDelay = realSetNoDelay;
    for (const socket of clients) socket.destroy();
    for (const socket of edgeSockets) socket.destroy();
    await relay.stop().catch(() => {});
    await new Promise((resolve) => edge.close(() => resolve()));
  }
}

/* ======================================================================
 * TunnelManager（假子进程，不执行 cloudflared）
 * ==================================================================== */
class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.timer = null;
  }

  /** 模拟 cloudflared 注册成功：一行注册 + 一行公网地址 */
  emitRegistered(index) {
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.exitCode !== null) return;
      this.stderr.write(`Registered tunnel connection connIndex=0\nhttps://fake-${index}.trycloudflare.com\n`);
    }, 10);
  }

  kill() {
    if (this.exitCode !== null) return true;
    this.exitCode = 0;
    clearTimeout(this.timer);
    this.timer = null;
    setImmediate(() => this.emit("exit", 0, "SIGTERM"));
    return true;
  }
}

let tempRoot = null;
let dataHome = null;

function makeManager({
  interfaces = { "以太网": [v4("192.168.1.20")] },
  planDelayMs = 0,
  spawnDelayMs = 0,
  register = true,
  nextDelayMs,
  recheckMs,
  diagnoseFn,
  fingerprintFn,
  env,
  tunAdapterFn,
  findBypassFn,
  resolveEdgeFn,
  ifacePollMs,
  ifaceDebounceMs,
  ifaceCooldownMs,
  preferredRetryMs,
  lostTimeoutMs,
  provider = "cloudflare",
  readyPollMs,
  readyMissLimit,
  readyFetchFn,
  onRoute,
} = {}) {
  let state = interfaces;
  const logs = [];
  const children = [];
  const routeCalls = [];
  let spawns = 0;
  const manager = new TunnelManager({
    localUrl: "http://127.0.0.1:9",
    dataHome,
    provider,
    // 默认 proxy 模式让 #buildPlan 不碰 DNS / TLS，也永远不排 bypass
    env: env ?? { BRIDGE_EDGE_ROUTE: "proxy", BRIDGE_EDGE_PROXY: "http://127.0.0.1:9" },
    networkInterfaces: () => state,
    ifacePollMs: ifacePollMs ?? 20,
    ifaceDebounceMs: ifaceDebounceMs ?? 40,
    lostTimeoutMs: lostTimeoutMs ?? 60,
    ...(planDelayMs ? { planDelayMs } : {}),
    ...(nextDelayMs ? { nextDelayMs } : {}),
    ...(recheckMs ? { recheckMs } : {}),
    ...(ifaceCooldownMs ? { ifaceCooldownMs } : {}),
    ...(preferredRetryMs ? { preferredRetryMs } : {}),
    ...(diagnoseFn ? { diagnoseFn } : {}),
    ...(fingerprintFn ? { fingerprintFn } : {}),
    ...(tunAdapterFn ? { tunAdapterFn } : {}),
    ...(findBypassFn ? { findBypassFn } : {}),
    ...(resolveEdgeFn ? { resolveEdgeFn } : {}),
    ...(readyPollMs ? { readyPollMs } : {}),
    ...(readyMissLimit ? { readyMissLimit } : {}),
    ...(readyFetchFn ? { readyFetchFn } : {}),
    onRoute: (route) => { routeCalls.push(route); onRoute?.(route); },
    onLog: (line) => logs.push(line),
  });
  manager.spawnCloudflared = async () => {
    if (spawnDelayMs) await sleep(spawnDelayMs);
    spawns++;
    const child = new FakeChild(30000 + spawns);
    children.push(child);
    if (register) child.emitRegistered(spawns);
    return { child, args: [] };
  };
  manager.spawnNgrok = () => {
    spawns++;
    const index = spawns;
    const child = new FakeChild(30000 + index);
    children.push(child);
    // ngrok 拿到公网地址就算打通；这里只写地址，不写 cloudflared 的 Registered 行
    setTimeout(() => {
      if (child.exitCode === null) child.stdout.write(`https://fake-${index}.ngrok-free.app\n`);
    }, 10);
    return { child, args: [] };
  };
  return {
    manager,
    logs,
    children,
    routeCalls,
    spawns: () => spawns,
    setInterfaces: (next) => { state = next; },
  };
}

async function startManager(options) {
  const ctx = makeManager(options);
  await ctx.manager.start();
  const connected = await waitFor(() => ctx.manager.connected, 1000);
  return { ...ctx, connected };
}

async function runTunnelChecks() {
  const defaults = new TunnelManager({ localUrl: "http://127.0.0.1:9", dataHome });
  check(
    "TunnelManager 时间参数默认值没变（60 秒 / 10 秒 / 3 秒）",
    defaults.lostTimeoutMs === 60_000 && defaults.ifacePollMs === 10_000 && defaults.ifaceDebounceMs === 3_000,
    `${defaults.lostTimeoutMs}/${defaults.ifacePollMs}/${defaults.ifaceDebounceMs}`,
  );
  check(
    "TunnelManager 新增时间参数默认值（偏好线路补试 20 秒 / 网卡重连冷却 60 秒）",
    defaults.preferredRetryMs === 20_000 && defaults.ifaceCooldownMs === 60_000,
    `${defaults.preferredRetryMs}/${defaults.ifaceCooldownMs}`,
  );
  check(
    "TunnelManager /ready 参数默认值（10 秒轮询 / 连续 2 次 0 才重连）",
    defaults.readyPollMs === 10_000 && defaults.readyMissLimit === 2 && defaults.readyFetchFn === null,
    `${defaults.readyPollMs}/${defaults.readyMissLimit}`,
  );

  /* ---- reconnect：重新选线路 + 重新拉起 ---- */
  await (async () => {
    const ctx = await startManager();
    try {
      check("起始状态：假进程拉起一次并注册成功", ctx.spawns() === 1 && ctx.connected, `spawn=${ctx.spawns()} connected=${ctx.connected}`);
      const urlBefore = ctx.manager.status().publicUrl;
      ctx.manager.plan = ["sentinel"];
      ctx.logs.length = 0;
      await ctx.manager.reconnect("自检：重建线路");
      // 快速隧道每次拉起都是新地址：重连后必须换成这一次的（2026-10-24 实测发现一直用旧地址，公网一直 530）
      await waitFor(() => ctx.manager.status().connected, 1500);
      const urlAfter = ctx.manager.status().publicUrl;
      check(
        "快速隧道重连后公网地址换成新的那个，不沿用旧地址",
        urlBefore === "https://fake-1.trycloudflare.com" && urlAfter === "https://fake-2.trycloudflare.com",
        `${urlBefore} → ${urlAfter}`,
      );
      check(
        "reconnect 重新 buildPlan（哨兵 plan 被重排回 relay）",
        JSON.stringify(ctx.manager.plan) === JSON.stringify(["relay"]),
        JSON.stringify(ctx.manager.plan),
      );
      check("reconnect 记了「隧道重连：<reason>」", ctx.logs.some((line) => line.includes("隧道重连：自检：重建线路")), ctx.logs.join(" / ").slice(0, 160));
      check("reconnect 重新拉起假进程", ctx.spawns() === 2, `spawn=${ctx.spawns()}`);
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- 并发 reconnect 只跑一次 ---- */
  await (async () => {
    const ctx = await startManager();
    try {
      ctx.logs.length = 0;
      const first = ctx.manager.reconnect("并发 1");
      const second = ctx.manager.reconnect("并发 2");
      check("并发 reconnect 返回同一个 Promise", first === second);
      await first;
      check("并发 reconnect 只拉起一次假进程", ctx.spawns() === 2, `spawn=${ctx.spawns()}`);
      check(
        "并发 reconnect 只记一条重连日志",
        ctx.logs.filter((line) => line.includes("隧道重连：")).length === 1,
        ctx.logs.filter((line) => line.includes("隧道重连：")).join(" / "),
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- 边缘连接全掉：走统一 reconnect ---- */
  await (async () => {
    const ctx = await startManager();
    try {
      await waitFor(() => ctx.manager.liveConnections.size > 0, 1000);
      ctx.logs.length = 0;
      const before = ctx.spawns();
      ctx.children.at(-1).stderr.write("Unregistered tunnel connection connIndex=0\n");
      const reconnected = await waitFor(() => ctx.spawns() === before + 1, 1500);
      check(
        "边缘连接全部掉线后走 reconnect（不再 attemptIndex=-1 + #next）",
        reconnected && ctx.logs.some((line) => line.includes("隧道重连：边缘连接全部掉线 60 秒没恢复")),
        `spawn ${before}→${ctx.spawns()}`,
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- 同一块里「掉线 → 重新注册」：后发生的事件生效 ---- */
  await (async () => {
    const ctx = await startManager();
    try {
      await waitFor(() => ctx.manager.liveConnections.has("0"), 1000);
      ctx.logs.length = 0;
      const before = ctx.spawns();
      ctx.children.at(-1).stderr.write(
        "Unregistered tunnel connection connIndex=0\nRegistered tunnel connection connIndex=0\n",
      );
      const processed = await waitFor(() => ctx.logs.some((line) => line.includes("Registered tunnel connection")), 500);
      check(
        "同一块里掉线后重新注册：后到的注册生效，不误装 lost 定时器",
        processed && ctx.manager.liveConnections.has("0") && ctx.manager.timers.lost === null && ctx.spawns() === before,
        `connections=${[...ctx.manager.liveConnections].join(",") || "(空)"} lost=${ctx.manager.timers.lost ? "排上" : "null"}`,
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- 网卡指纹变化：防抖后重连 ---- */
  await (async () => {
    const ctx = await startManager();
    try {
      ctx.logs.length = 0;
      const before = ctx.spawns();
      ctx.setInterfaces({ WLAN: [v4("192.168.2.50")] });
      const changed = await waitFor(() => ctx.spawns() === before + 1, 2000);
      check("网卡指纹变化经防抖后触发 reconnect", changed, `spawn ${before}→${ctx.spawns()}`);
      check(
        "重连原因写明哪块网卡的哪个地址没了 / 新增了",
        ctx.logs.some((line) => /网卡地址变了：.*以太网 192\.168\.1\.20 没了.*WLAN 192\.168\.2\.50 新增/.test(line)),
        ctx.logs.find((line) => line.includes("网卡地址变了")) ?? "(没有)",
      );
      const after = ctx.spawns();
      await sleep(120);
      check("重连后基线已更新，不会反复重连", ctx.spawns() === after, `spawn=${ctx.spawns()}`);
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- 指纹不变：不重连 ---- */
  await (async () => {
    const ctx = await startManager();
    try {
      const before = ctx.spawns();
      await sleep(150);
      check("网卡指纹不变时不触发 reconnect", ctx.spawns() === before, `spawn=${ctx.spawns()}`);
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- blocked：交给 30 秒复查，不抢 ---- */
  await (async () => {
    const ctx = await startManager();
    try {
      const before = ctx.spawns();
      ctx.manager.blocked = { at: Date.now(), diagnosis: { verdict: { code: "test" } }, fingerprint: "test", rechecks: 0 };
      ctx.setInterfaces({ WLAN: [v4("10.0.0.2")] });
      await sleep(180);
      check("blocked 状态下网卡变化不触发 reconnect", ctx.spawns() === before, `spawn=${ctx.spawns()}`);
    } finally {
      ctx.manager.blocked = null;
      await ctx.manager.stop();
    }
  })();

  /* ---- noteWake：5 秒内只一次 ---- */
  await (async () => {
    const ctx = await startManager();
    try {
      const before = ctx.spawns();
      ctx.manager.noteWake();
      ctx.manager.noteWake();
      await waitFor(() => ctx.spawns() === before + 1, 1000);
      await sleep(120);
      check("noteWake 5 秒内重复调用只重连一次", ctx.spawns() === before + 1, `spawn ${before}→${ctx.spawns()}`);
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- start 排线路期间 stop()：在途的启动必须收手 ---- */
  await (async () => {
    const ctx = makeManager({ planDelayMs: 120 });
    const starting = ctx.manager.start();
    check("start() 执行过程记在 this.starting 上，stop 能等它", ctx.manager.starting === starting);
    await sleep(30); // 这时 start 正卡在 #buildPlan 的探测里
    const stopped = ctx.manager.stop();
    await Promise.all([starting, stopped]);
    await sleep(220);
    check("start 排线路期间 stop() 之后不再拉起子进程", ctx.spawns() === 0, `spawn=${ctx.spawns()}`);
    check(
      "start 排线路期间 stop() 之后没有残留假子进程",
      ctx.manager.child === null && ctx.children.every((child) => child.exitCode !== null),
      `child=${ctx.manager.child ? ctx.manager.child.pid : "null"} 记录=${ctx.children.length}`,
    );
    check("start 排线路期间 stop() 之后网卡监视没有被重新启动", ctx.manager.ifaceTimer === null, `timer=${ctx.manager.ifaceTimer}`);
  })();

  /* ---- blocked 复查排线路期间 stop()：在途的复查必须收手 ---- */
  await (async () => {
    let fpCalls = 0;
    const ctx = makeManager({
      register: false,
      nextDelayMs: 20,
      recheckMs: 30,
      planDelayMs: 80,
      diagnoseFn: async () => ({ verdict: { code: "test", text: "自检：连不上" } }),
      fingerprintFn: async () => ({ key: `fp-${++fpCalls}`, direct: false, tun: false, fakeIp: false }),
    });
    await ctx.manager.start();
    ctx.children.at(-1).kill(); // 还没连上就退出 → 20 毫秒后 #next → #block
    const blocked = await waitFor(() => ctx.manager.blocked, 1000);
    // 复查会先把 blocked 置空，再进 #buildPlan（被 planDelayMs 拖慢）
    const inRecheck = await waitFor(() => ctx.manager.blocked === null, 1000);
    const before = ctx.spawns();
    await ctx.manager.stop();
    await sleep(180);
    check(
      "blocked 复查排线路期间 stop() 之后不再拉起子进程",
      blocked && inRecheck && ctx.spawns() === before,
      `spawn ${before}→${ctx.spawns()}`,
    );
    check(
      "blocked 复查排线路期间 stop() 之后没有残留假子进程",
      ctx.manager.child === null && ctx.children.every((child) => child.exitCode !== null),
      `child=${ctx.manager.child ? ctx.manager.child.pid : "null"}`,
    );
  })();

  /* ---- reconnect 期间又 start：同一时刻只留一个子进程 ---- */
  await (async () => {
    const ctx = await startManager({ spawnDelayMs: 80 });
    try {
      const rec = ctx.manager.reconnect("自检：慢重连");
      await sleep(20); // 重连正卡在拉起进程的 await 里
      const starting = ctx.manager.start();
      await Promise.all([rec, starting]);
      await sleep(60);
      const alive = ctx.children.filter((child) => child.exitCode === null);
      check(
        "reconnect 期间又 start：同一时刻只有一个子进程",
        alive.length === 1 && ctx.manager.child === alive[0],
        `存活=${alive.length} 共拉起=${ctx.children.length}`,
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- start 期间 reconnect：直接等这次启动，不再叠一次 ---- */
  await (async () => {
    const ctx = makeManager({ planDelayMs: 100 });
    try {
      const starting = ctx.manager.start();
      await sleep(20); // start 还在排线路的 await 里
      const rec = ctx.manager.reconnect("自检：启动中重连");
      check("start 期间 reconnect 返回同一个启动 Promise", rec === starting);
      await Promise.all([starting, rec]);
      await sleep(40);
      check("start 期间 reconnect 不额外拉起子进程", ctx.spawns() === 1, `spawn=${ctx.spawns()}`);
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- stop 要等在途的重连收手 ---- */
  await (async () => {
    const ctx = await startManager({ spawnDelayMs: 100 });
    const rec = ctx.manager.reconnect("自检：stop 等重连");
    await ctx.manager.stop();
    await rec;
    await sleep(180);
    check(
      "stop() 会等重连收手，之后没有残留假子进程",
      ctx.manager.child === null && ctx.children.every((child) => child.exitCode !== null),
      `child=${ctx.manager.child ? ctx.manager.child.pid : "null"} 共拉起=${ctx.children.length}`,
    );
  })();

  /* ---- 重连卡在慢探测里：stop() 最多等 2 秒就返回 ---- */
  await (async () => {
    let slow = false;
    const ctx = makeManager({
      interfaces: { "以太网": [v4("192.168.1.20")], "Mihomo": [v4("198.18.0.1")] },
      env: { BRIDGE_EDGE_ROUTE: "direct" },
      findBypassFn: async () => {
        if (slow) await sleep(3000);
        return { localAddress: "192.168.1.20", iface: "以太网" };
      },
    });
    let rec = null;
    try {
      await ctx.manager.start();
      await waitFor(() => ctx.manager.connected, 1000);
      const before = ctx.spawns();
      slow = true;
      rec = ctx.manager.reconnect("自检：慢补网卡").catch(() => {});
      await sleep(50); // 重连正卡在 3 秒的 findBypass 里
      const started = Date.now();
      await ctx.manager.stop();
      const elapsed = Date.now() - started;
      check(
        "重连卡在慢探测里时 stop() 约 2 秒内返回",
        elapsed < 2600,
        `耗时 ${elapsed}ms`,
      );
      check(
        "慢探测期间的 stop() 之后 spawn 不再增加、child 为空",
        ctx.spawns() === before && ctx.manager.child === null,
        `spawn ${before}→${ctx.spawns()} child=${ctx.manager.child ? ctx.manager.child.pid : "null"}`,
      );
    } finally {
      await rec;
      await ctx.manager.stop();
    }
  })();

  /* ---- 2 秒换方式定时器：reconnect / stop 都要清掉 ---- */
  await (async () => {
    const ctx = makeManager({ register: false, nextDelayMs: 2000 });
    try {
      await ctx.manager.start();
      ctx.children.at(-1).kill(); // 还没连上就退出 → 排一个 2 秒后的 #next
      const scheduled = await waitFor(() => Boolean(ctx.manager.timers.next), 500);
      const rec = ctx.manager.reconnect("自检：清掉换方式定时器");
      check("reconnect 清掉 2 秒的 #next 定时器", scheduled && ctx.manager.timers.next === null, `timers.next=${ctx.manager.timers.next}`);
      await rec;
      ctx.children.at(-1).kill();
      const scheduledAgain = await waitFor(() => Boolean(ctx.manager.timers.next), 500);
      const stopping = ctx.manager.stop();
      check("stop 清掉 2 秒的 #next 定时器", scheduledAgain && ctx.manager.timers.next === null, `timers.next=${ctx.manager.timers.next}`);
      await stopping;
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- 旧子进程被替换后的输出不影响当前状态 ---- */
  await (async () => {
    const ctx = makeManager({ register: false });
    try {
      await ctx.manager.start();
      const oldChild = ctx.children.at(-1);
      await ctx.manager.reconnect("自检：换新进程");
      const newChild = ctx.children.at(-1);
      // 当前进程还没注册；假设它已经有一条连接，只是公网地址还没取到
      ctx.manager.publicUrl = null;
      ctx.manager.liveConnections.add("0");
      oldChild.stderr.write("Unregistered tunnel connection connIndex=0\nhttps://fake-old.trycloudflare.com\n");
      await sleep(30);
      check("旧子进程被替换后再写输出，不改当前 publicUrl", ctx.manager.publicUrl === null, `publicUrl=${ctx.manager.publicUrl}`);
      check(
        "旧子进程被替换后再写输出，不删当前 liveConnections",
        ctx.manager.liveConnections.has("0"),
        `connections=${[...ctx.manager.liveConnections].join(",") || "(空)"}`,
      );
      check("当前子进程仍是重连后那个", ctx.manager.child === newChild && oldChild !== newChild);
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- 子进程退出时补尾巴只补诊断：半截 Registered 不能把死进程当成已连上 ---- */
  await (async () => {
    let recovered = 0;
    const ctx = makeManager({ register: false });
    ctx.manager.onRecovered = () => { recovered++; };
    try {
      await ctx.manager.start();
      const child = ctx.children.at(-1);
      ctx.logs.length = 0;
      const restarts = ctx.manager.restarts;
      // 不写换行：这一行留在 stderr 的尾巴里，等进程退出时才被补处理
      child.stderr.write("Registered tunnel connection connIndex=0");
      await sleep(10);
      check(
        "退出前的半截 Registered：还没等到换行时不判打通",
        !ctx.manager.connected && ctx.manager.liveConnections.size === 0,
        `connected=${ctx.manager.connected} connections=${ctx.manager.liveConnections.size}`,
      );
      child.kill();
      const flushed = await waitFor(() => ctx.logs.some((line) => line.includes("Registered tunnel connection connIndex=0")), 500);
      await sleep(30);
      check(
        "子进程退出时补尾巴只补诊断：不调 #markConnected、不算已连上",
        flushed && !ctx.manager.connected && !ctx.manager.status().connected && ctx.manager.restarts === restarts && recovered === 0 && ctx.manager.liveConnections.size === 0,
        `connected=${ctx.manager.connected} status.connected=${ctx.manager.status().connected} restarts=${ctx.manager.restarts} onRecovered=${recovered} connections=${ctx.manager.liveConnections.size}`,
      );
      check(
        "子进程退出时补尾巴仍会把这行写进 onLog",
        flushed,
        ctx.logs.find((line) => line.includes("Registered tunnel connection")) ?? "(没有)",
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- 日志按整行解析：一行被拆进两个 chunk 也要拼起来 ---- */
  await (async () => {
    const ctx = makeManager({ register: false });
    try {
      await ctx.manager.start();
      const child = ctx.children.at(-1);
      ctx.logs.length = 0;
      // 模拟 Registered tunnel connection 被拆开：前半截不能拿去判定，也不能当日志打出来
      child.stderr.write("Registered tunnel conn");
      await sleep(10);
      check(
        "日志拆行：Registered 只收到前半截时不判打通、不记半截日志",
        !ctx.manager.connected && !ctx.logs.some((line) => line.includes("Registered tunnel conn")),
        `connected=${ctx.manager.connected} logs=${JSON.stringify(ctx.logs)}`,
      );
      child.stderr.write("ection connIndex=0\n");
      const connected = await waitFor(() => ctx.manager.connected, 500);
      const lineLogs = ctx.logs.filter((line) => line.includes("Registered tunnel connection"));
      check(
        "日志拆行：Registered 拼成完整一行后只判打通一次，onLog 收到的是整行",
        connected
          && ctx.manager.liveConnections.has("0")
          && lineLogs.length === 1
          && lineLogs[0] === "[stderr] Registered tunnel connection connIndex=0",
        `connected=${ctx.manager.connected} logs=${JSON.stringify(lineLogs)}`,
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  await (async () => {
    const ctx = makeManager({ register: false });
    try {
      await ctx.manager.start();
      const child = ctx.children.at(-1);
      ctx.logs.length = 0;
      // 快速隧道地址也被拆成两块：前半截不能当成完整地址
      child.stdout.write("https://fake-split.try");
      await sleep(10);
      check(
        "日志拆行：公网地址只收到前半截时不设 publicUrl",
        ctx.manager.publicUrl === null,
        `publicUrl=${ctx.manager.publicUrl}`,
      );
      child.stdout.write("cloudflare.com\n");
      const found = await waitFor(() => ctx.manager.publicUrl === "https://fake-split.trycloudflare.com", 500);
      check("日志拆行：快速隧道地址拆在两块里也能取到", found, `publicUrl=${ctx.manager.publicUrl}`);
    } finally {
      await ctx.manager.stop();
    }
  })();

  await (async () => {
    const ctx = makeManager({ register: false });
    try {
      await ctx.manager.start();
      const child = ctx.children.at(-1);
      ctx.logs.length = 0;
      // 最后一行没有换行：退出前不该当完整行处理，退出时补一次
      child.stderr.write("2026-10-24 ERR 自检：最后一行没有换行");
      await sleep(10);
      check(
        "日志拆行：没有换行的最后一行在退出前不处理",
        ctx.manager.lastErrLine === null && !ctx.logs.some((line) => line.includes("最后一行")),
        `lastErrLine=${ctx.manager.lastErrLine} logs=${JSON.stringify(ctx.logs)}`,
      );
      child.kill();
      const flushed = await waitFor(() => ctx.manager.lastErrLine !== null, 500);
      check(
        "日志拆行：子进程退出时把没有换行的最后一行补上（ERR 记进 lastErrLine）",
        flushed && ctx.manager.lastErrLine === "自检：最后一行没有换行",
        `lastErrLine=${ctx.manager.lastErrLine}`,
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- #block 诊断期间 reconnect 抢先连上：诊断回来不能写 blocked ---- */
  await (async () => {
    let diagnoseStarted = false;
    const ctx = makeManager({
      register: false,
      nextDelayMs: 20,
      diagnoseFn: async () => {
        diagnoseStarted = true;
        await sleep(150);
        return { verdict: { code: "test", text: "自检：诊断结论" } };
      },
      fingerprintFn: async () => ({ key: "fp", direct: true, tun: false, fakeIp: false }),
    });
    try {
      await ctx.manager.start();
      ctx.children.at(-1).kill(); // → 20 毫秒后 #next → #block 开始诊断
      const inDiagnose = await waitFor(() => diagnoseStarted, 1000);
      const rec = ctx.manager.reconnect("自检：诊断期间抢先连上");
      await rec;
      await sleep(250); // 等那次诊断回来
      check(
        "诊断期间 reconnect 抢先连上后，诊断回来不写 blocked",
        inDiagnose && ctx.manager.blocked === null,
        `blocked=${ctx.manager.blocked ? "有" : "null"}`,
      );
      check("诊断期间 reconnect 后仍保留当前子进程", Boolean(ctx.manager.child) && ctx.manager.child.exitCode === null);
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- status().reconnecting：重连期间为 true，结束后为 false ---- */
  await (async () => {
    const ctx = await startManager({ spawnDelayMs: 80 });
    try {
      const rec = ctx.manager.reconnect("自检：重连状态");
      await sleep(20); // 重连还在跑
      const during = ctx.manager.status();
      check("重连期间 status().reconnecting 为 true", during.reconnecting === true, `reconnecting=${during.reconnecting}`);
      check("重连期间 status().phase 是 connecting", during.phase === "connecting", `phase=${during.phase}`);
      await rec;
      await sleep(40);
      const after = ctx.manager.status();
      check("重连结束后 status().reconnecting 为 false", after.reconnecting === false, `reconnecting=${after.reconnecting}`);
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- #next 换线路的空窗：restarting 为 true、phase 是 connecting（界面别闪「仅本机」） ---- */
  await (async () => {
    const ctx = makeManager({
      register: false,
      nextDelayMs: 20,
      spawnDelayMs: 150,
      env: { BRIDGE_EDGE_ROUTE: "direct" },
      resolveEdgeFn: async () => ({ fakeIp: false }),
    });
    try {
      await ctx.manager.start();
      // 计划有两条线路：杀掉当前进程后 #next 会换下一条，拉起期间 child 为空
      ctx.children.at(-1).kill();
      const inSwitch = await waitFor(() => ctx.manager.switching === true, 1000);
      const during = ctx.manager.status();
      check(
        "#next 换线路期间 status().restarting 为 true",
        inSwitch && during.restarting === true,
        `switching=${ctx.manager.switching} restarting=${during.restarting} child=${ctx.manager.child ? "有" : "null"}`,
      );
      check(
        "#next 换线路期间 status().phase 是 connecting",
        inSwitch && during.phase === "connecting",
        `phase=${during.phase}`,
      );
      await waitFor(() => ctx.manager.child !== null, 1000);
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- stop() 之后监视停掉 ---- */
  await (async () => {
    const ctx = await startManager();
    try {
      await ctx.manager.stop();
      const before = ctx.spawns();
      ctx.setInterfaces({ WLAN: [v4("172.16.0.2")] });
      await sleep(180);
      check(
        "stop() 后网卡监视停止，不再触发重连",
        ctx.spawns() === before && ctx.manager.ifaceTimer === null,
        `spawn=${ctx.spawns()} timer=${ctx.manager.ifaceTimer}`,
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- bypass 绑定地址消失：连续两次轮询不在才重连 ---- */
  await (async () => {
    const ctx = await startManager();
    try {
      ctx.logs.length = 0;
      const before = ctx.spawns();
      ctx.manager.route = "bypass";
      ctx.manager.bypass = { localAddress: "10.9.9.9", iface: "旧网卡" };
      const reconnected = await waitFor(() => ctx.spawns() === before + 1, 1500);
      check("bypass 绑定的网卡地址消失时 reconnect", reconnected, `spawn ${before}→${ctx.spawns()}`);
      check(
        "bypass 地址消失的原因写明绑定的网卡",
        ctx.logs.some((line) => line.includes("网卡地址变了：线路绑定的 10.9.9.9（旧网卡）已不在本机")),
        ctx.logs.find((line) => line.includes("网卡地址变了")) ?? "(没有)",
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- 重连前刷新网卡基线：网卡以原地址回来也要能发现 ---- */
  await (async () => {
    const ctx = await startManager();
    try {
      const before = ctx.spawns();
      // 醒来时网卡还没好：重连看到的是「空的网卡列表」，基线要按这个记
      ctx.setInterfaces({});
      await ctx.manager.reconnect("自检：醒来时网卡还没回来");
      await waitFor(() => ctx.spawns() === before + 1, 1000);
      await sleep(80); // 让重连彻底走完，别把后面的变化算进这次重连
      // 网卡以原来的地址回来：和睡前基线一模一样，只有重连时刷新过基线才能发现
      ctx.setInterfaces({ "以太网": [v4("192.168.1.20")] });
      const changed = await waitFor(() => ctx.spawns() === before + 2, 2000);
      check(
        "重连前刷新网卡基线：网卡以同一地址回来后仍会触发重连",
        changed,
        `spawn ${before}→${ctx.spawns()}`,
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- #block：诊断给出模式排除的线路 → 直接 blocked，不自救 ---- */
  await (async () => {
    const ctx = makeManager({
      register: false,
      nextDelayMs: 20,
      env: { BRIDGE_EDGE_ROUTE: "direct" },
      // 直连模式下中继本来就不会排进计划，诊断说 relay 能通也不能照它自救
      diagnoseFn: async () => ({ verdict: { code: "relay", text: "自检：经代理中继能通" } }),
      fingerprintFn: async () => ({ key: "fp", direct: false, tun: false, fakeIp: false }),
    });
    try {
      await ctx.manager.start();
      const before = ctx.spawns();
      ctx.manager.plan = ["direct"]; // 让下一次 #next 直接耗尽计划进 #block
      ctx.children.at(-1).kill();
      const blocked = await waitFor(() => ctx.manager.blocked, 1000);
      check(
        "直连模式 + 诊断 relay：直接 blocked，不再重连",
        blocked && ctx.spawns() === before,
        `spawn ${before}→${ctx.spawns()}`,
      );
      check(
        "直连模式 + 诊断 relay：结论说清是边缘路线设置的问题",
        blocked && ctx.manager.blocked?.diagnosis?.verdict?.text === "经代理中继能通，但边缘路线设成了直连，改回自动即可"
          && ctx.manager.blocked?.diagnosis?.verdict?.code !== "tunnel-error",
        ctx.manager.blocked?.diagnosis?.verdict?.text ?? "(无)",
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- #block：代理模式 + 诊断 bypass → blocked 之后复查不反复重连 ---- */
  await (async () => {
    const ctx = makeManager({
      register: false,
      nextDelayMs: 20,
      recheckMs: 60,
      // 默认 proxy 模式：计划里只有 relay；诊断说能从网卡绕开，复查时网卡也一直找得到
      diagnoseFn: async () => ({ verdict: { code: "bypass", text: "自检：能从网卡绕开" } }),
      fingerprintFn: async () => ({ key: "fp", direct: false, tun: true, fakeIp: false }),
      findBypassFn: async () => ({ iface: "以太网", localAddress: "192.168.1.20" }),
    });
    try {
      await ctx.manager.start();
      ctx.children.at(-1).kill();
      const blocked = await waitFor(() => ctx.manager.blocked, 1000);
      const before = ctx.spawns();
      // 6 个复查周期（不到第 10 轮的定期重试）：不该再拉起进程
      await sleep(400);
      check(
        "代理模式 + 诊断 bypass：blocked 后复查不反复重连",
        Boolean(blocked) && ctx.spawns() === before && Boolean(ctx.manager.blocked),
        `spawn ${before}→${ctx.spawns()} blocked=${ctx.manager.blocked ? "在" : "没了"}`,
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- #block 诊断期间状态保持「连接中」，不落到 stopped（界面会显示仅本机） ---- */
  await (async () => {
    const ctx = makeManager({
      register: false,
      nextDelayMs: 20,
      env: { BRIDGE_EDGE_ROUTE: "direct" },
      diagnoseFn: async () => { await sleep(300); return { verdict: { code: "test", text: "自检：连不上" } }; },
      fingerprintFn: async () => ({ key: "fp", direct: false, tun: false, fakeIp: false }),
    });
    try {
      await ctx.manager.start();
      ctx.manager.plan = ["direct"]; // 下一次 #next 直接耗尽计划进 #block
      const killedAt = Date.now();
      ctx.children.at(-1).kill();
      // 假进程的 exit 事件在下一轮事件循环才发：等它被处理完再采样（那一瞬间不是这条要测的诊断空窗）
      await new Promise((resolve) => setImmediate(resolve));
      const seen = [];
      let restartingAll = true;
      const end = Date.now() + 1500;
      while (Date.now() < end && !ctx.manager.blocked) {
        const s = ctx.manager.status();
        if (seen.at(-1)?.phase !== s.phase) seen.push({ phase: s.phase, at: Date.now() - killedAt });
        if (s.phase !== "blocked" && !s.restarting && !s.reconnecting) restartingAll = false;
        await sleep(15);
      }
      const final = ctx.manager.status();
      check(
        "#block 诊断期间 phase 一直不是 stopped、restarting 为真，最后是 blocked",
        !seen.some((x) => x.phase === "stopped") && restartingAll && final.phase === "blocked" && final.restarting === false,
        `${seen.map((x) => `${x.phase}@${x.at}ms`).join(" → ")}，最后 ${final.phase} restarting=${final.restarting}`,
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- #block：auto 模式自救一次，再失败就 blocked（不按代次反复自救） ---- */
  await (async () => {
    const ctx = makeManager({
      register: false,
      nextDelayMs: 20,
      // auto + 偏好 direct：不会去做真实 TLS 预检，但 bypass 缺席时仍允许自救。
      // 显式给一个本机代理，让 findProxy 直接返回，不去扫系统代理 / 本机端口
      env: { BRIDGE_EDGE_ROUTE: "auto", BRIDGE_EDGE_PREFERRED: "direct", BRIDGE_EDGE_PROXY: "http://127.0.0.1:9" },
      diagnoseFn: async () => ({ verdict: { code: "bypass", text: "自检：能从网卡绕开" } }),
      fingerprintFn: async () => ({ key: "fp", direct: false, tun: false, fakeIp: false }),
    });
    try {
      await ctx.manager.start();
      const before = ctx.spawns();
      ctx.manager.plan = ["direct"];
      ctx.children.at(-1).kill(); // → 20 毫秒后 #next → #block → 自救一次
      const reconnected = await waitFor(() => ctx.spawns() === before + 1, 2000);
      check(
        "auto 模式：#block 发现诊断能 bypass 但计划里没有时自救重连一次",
        reconnected && ctx.manager.blocked === null && ctx.manager.selfHealPending === true,
        `spawn ${before}→${ctx.spawns()} blocked=${ctx.manager.blocked ? "有" : "null"} pending=${ctx.manager.selfHealPending}`,
      );
      // 自救的重连换了新代次；再失败一次不能又自救（这就是按代次记会失效的地方）
      ctx.manager.attemptIndex = ctx.manager.plan.length - 1;
      const afterHeal = ctx.spawns();
      ctx.children.at(-1).kill();
      const blocked = await waitFor(() => ctx.manager.blocked, 1000);
      check(
        "auto 模式自救一次后再失败：进 blocked，不再重连",
        blocked && ctx.spawns() === afterHeal,
        `spawn=${ctx.spawns()} blocked=${ctx.manager.blocked?.diagnosis?.verdict?.code ?? "(无)"}`,
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- 偏好线路（bypass）暂时缺失：20 秒后补试找到就换回来，且不记错 lastRoute ---- */
  await (async () => {
    let bypassAvailable = false;
    const ctx = makeManager({
      interfaces: { "以太网": [v4("192.168.1.20")], "Mihomo": [v4("198.18.0.1")] },
      env: { BRIDGE_EDGE_ROUTE: "direct", BRIDGE_EDGE_PREFERRED: "bypass" },
      findBypassFn: async () => (bypassAvailable ? { localAddress: "192.168.1.20", iface: "以太网" } : null),
      preferredRetryMs: 60,
    });
    try {
      await ctx.manager.start();
      const connected = await waitFor(() => ctx.manager.connected, 1000);
      const firstSpawns = ctx.spawns();
      check(
        "偏好线路缺失那一轮照常连上",
        connected && firstSpawns === 1 && JSON.stringify(ctx.manager.plan) === JSON.stringify(["direct", "direct-tcp"]),
        `spawn=${firstSpawns} plan=${JSON.stringify(ctx.manager.plan)}`,
      );
      check(
        "偏好线路缺失那一轮连上不改写 lastRoute（onRoute 没被调用）",
        ctx.routeCalls.length === 0 && ctx.manager.config.preferredRoute === "bypass",
        `onRoute=${JSON.stringify(ctx.routeCalls)} preferred=${ctx.manager.config.preferredRoute}`,
      );
      // 网卡回来了：补试应当找到 bypass 并重建线路
      bypassAvailable = true;
      const back = await waitFor(() => ctx.spawns() === firstSpawns + 1, 1500);
      check(
        "偏好线路缺失时稍后补试找到 bypass 会重连换回",
        back && ctx.manager.plan.includes("bypass") && ctx.manager.plan[0] === "bypass",
        `spawn=${ctx.spawns()} plan=${JSON.stringify(ctx.manager.plan)}`,
      );
      check(
        "补试换回时记了「网卡恢复了，换回上次成功的线路」",
        ctx.logs.some((line) => line.includes("网卡恢复了，换回上次成功的线路")),
        ctx.logs.find((line) => line.includes("网卡恢复了")) ?? "(没有)",
      );
      check("偏好线路恢复后 planMissingPreferred 已清掉", ctx.manager.planMissingPreferred === false, `planMissingPreferred=${ctx.manager.planMissingPreferred}`);
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- 偏好线路是 bypass、但没开 TUN：补试永远不该排，否则每 20 秒拆一次隧道 ---- */
  await (async () => {
    let bypassCalls = 0;
    const ctx = makeManager({
      // 只有物理网卡，没有 TUN / 假 IP
      interfaces: { "以太网": [v4("192.168.1.20")] },
      env: { BRIDGE_EDGE_ROUTE: "direct", BRIDGE_EDGE_PREFERRED: "bypass" },
      // 物理网卡一直能握手：老代码会拿这个当「网卡恢复了」，无限重连
      findBypassFn: async () => { bypassCalls++; return { localAddress: "192.168.1.20", iface: "以太网" }; },
      resolveEdgeFn: async () => ({ fakeIp: false }),
      preferredRetryMs: 40,
    });
    try {
      await ctx.manager.start();
      const connected = await waitFor(() => ctx.manager.connected, 1000);
      await sleep(200); // 等过好几个补试周期
      check(
        "没开 TUN、偏好线路是 bypass：不会被补试反复拆隧道",
        connected && ctx.spawns() === 1,
        `spawn=${ctx.spawns()} 补试周期≈${Math.round(200 / 40)}`,
      );
      check(
        "没开 TUN、偏好线路是 bypass：实际线路照常写回 lastRoute",
        ctx.routeCalls.length === 1 && ctx.routeCalls[0] === "direct" && ctx.manager.config.preferredRoute === "direct",
        `onRoute=${JSON.stringify(ctx.routeCalls)} preferred=${ctx.manager.config.preferredRoute}`,
      );
      check("没开 TUN 时不排补试，也不去调 findBypass", bypassCalls === 0 && ctx.manager.timers.preferred === null, `findBypass=${bypassCalls} timer=${ctx.manager.timers.preferred}`);
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- 边缘路线设成 proxy：偏好 bypass 同样不能补试循环 ---- */
  await (async () => {
    const ctx = makeManager({
      interfaces: { "以太网": [v4("192.168.1.20")], "Mihomo": [v4("198.18.0.1")] },
      env: { BRIDGE_EDGE_ROUTE: "proxy", BRIDGE_EDGE_PROXY: "http://127.0.0.1:9", BRIDGE_EDGE_PREFERRED: "bypass" },
      findBypassFn: async () => ({ localAddress: "192.168.1.20", iface: "以太网" }),
      preferredRetryMs: 40,
    });
    try {
      await ctx.manager.start();
      const connected = await waitFor(() => ctx.manager.connected, 1000);
      await sleep(200);
      check(
        "边缘路线设成 proxy、偏好 bypass：不会被补试反复拆隧道",
        connected && ctx.spawns() === 1 && ctx.manager.timers.preferred === null,
        `spawn=${ctx.spawns()} timer=${ctx.manager.timers.preferred}`,
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- 走 bypass 时只看绑定地址：TUN / 虚拟网卡起停不该断隧道 ---- */
  await (async () => {
    const ctx = await startManager();
    try {
      ctx.manager.route = "bypass";
      ctx.manager.bypass = { localAddress: "192.168.1.20", iface: "以太网" };
      const before = ctx.spawns();
      ctx.setInterfaces({ "以太网": [v4("192.168.1.20")], "Mihomo": [v4("198.18.0.1")] });
      await sleep(140);
      ctx.setInterfaces({ "以太网": [v4("192.168.1.20")] });
      await sleep(140);
      check(
        "走 bypass 时 TUN 关开不触发重连",
        ctx.spawns() === before,
        `spawn ${before}→${ctx.spawns()}`,
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- 走 direct / relay 时虚拟网卡（WSL / Hyper-V / Docker）变化不触发 ---- */
  await (async () => {
    const ctx = await startManager();
    try {
      const before = ctx.spawns();
      ctx.setInterfaces({
        "以太网": [v4("192.168.1.20")],
        "vEthernet (WSL)": [v4("172.20.0.1")],
        "vEthernet (Default Switch)": [v4("192.168.100.1")],
        "Docker": [v4("172.17.0.1")],
      });
      await sleep(140);
      ctx.setInterfaces({ "以太网": [v4("192.168.1.20")] });
      await sleep(140);
      check(
        "走 relay 时 vEthernet / WSL / Docker 网卡变化不触发重连",
        ctx.spawns() === before,
        `spawn ${before}→${ctx.spawns()}`,
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- bypass 地址只缺一次（闪一下）不触发，连续两次才触发 ---- */
  await (async () => {
    const ctx = await startManager();
    try {
      ctx.manager.route = "bypass";
      ctx.manager.bypass = { localAddress: "192.168.1.20", iface: "以太网" };
      const present = { "以太网": [v4("192.168.1.20")] };
      const missing = { "WLAN": [v4("192.168.2.50")] };
      let droppedOnce = false;
      // 只在第一次轮询时「消失」，下一次就回来
      ctx.manager.networkInterfaces = () => {
        if (!droppedOnce) { droppedOnce = true; return missing; }
        return present;
      };
      const before = ctx.spawns();
      await sleep(160);
      check(
        "bypass 地址只缺一次（闪一下）不触发重连",
        droppedOnce && ctx.spawns() === before,
        `spawn ${before}→${ctx.spawns()}`,
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  await (async () => {
    const ctx = await startManager();
    try {
      ctx.manager.route = "bypass";
      ctx.manager.bypass = { localAddress: "192.168.1.20", iface: "以太网" };
      const before = ctx.spawns();
      ctx.setInterfaces({ "WLAN": [v4("192.168.2.50")] });
      const reconnected = await waitFor(() => ctx.spawns() === before + 1, 1500);
      check(
        "bypass 地址连续两次轮询都不在才触发重连",
        reconnected,
        `spawn ${before}→${ctx.spawns()}`,
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- 走 direct：TUN 出现 / 消失、物理网卡变化都要触发 ---- */
  await (async () => {
    const ctx = await startManager({
      env: { BRIDGE_EDGE_ROUTE: "direct" },
      findBypassFn: async () => null,
      resolveEdgeFn: async () => ({ fakeIp: false }),
    });
    try {
      const before = ctx.spawns();
      ctx.logs.length = 0;
      ctx.setInterfaces({ "以太网": [v4("192.168.1.20")], "Mihomo": [v4("198.18.0.1")] });
      const triggered = await waitFor(() => ctx.spawns() === before + 1, 2000);
      check(
        "走 direct 时 TUN 出现会触发重连",
        triggered && ctx.logs.some((line) => line.includes("TUN 网卡「Mihomo」出现")),
        ctx.logs.find((line) => line.includes("TUN 网卡")) ?? "(没有)",
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  await (async () => {
    const ctx = await startManager({
      interfaces: { "以太网": [v4("192.168.1.20")], "Mihomo": [v4("198.18.0.1")] },
      env: { BRIDGE_EDGE_ROUTE: "direct" },
      findBypassFn: async () => null,
      resolveEdgeFn: async () => ({ fakeIp: false }),
    });
    try {
      const before = ctx.spawns();
      ctx.logs.length = 0;
      ctx.setInterfaces({ "以太网": [v4("192.168.1.20")] });
      const triggered = await waitFor(() => ctx.spawns() === before + 1, 2000);
      check(
        "走 direct 时 TUN 消失会触发重连",
        triggered && ctx.logs.some((line) => line.includes("TUN 网卡消失")),
        ctx.logs.find((line) => line.includes("TUN 网卡")) ?? "(没有)",
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  await (async () => {
    const ctx = await startManager({
      env: { BRIDGE_EDGE_ROUTE: "direct" },
      findBypassFn: async () => null,
      resolveEdgeFn: async () => ({ fakeIp: false }),
    });
    try {
      const before = ctx.spawns();
      ctx.setInterfaces({ "以太网": [v4("192.168.2.50")] });
      const triggered = await waitFor(() => ctx.spawns() === before + 1, 2000);
      check("走 direct 时物理网卡地址变化会触发重连", triggered, `spawn ${before}→${ctx.spawns()}`);
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- 网卡重连冷却：冷却期内不立即重连，冷却结束后仍不同才重连 ---- */
  await (async () => {
    const ctx = await startManager({ ifaceCooldownMs: 300 });
    try {
      const first = ctx.spawns();
      ctx.setInterfaces({ "WLAN": [v4("192.168.2.50")] });
      const firstTriggered = await waitFor(() => ctx.spawns() === first + 1, 1500);
      await sleep(60); // 让这次重连（含基线刷新）走完
      const during = ctx.spawns();
      ctx.setInterfaces({ "WLAN": [v4("192.168.3.60")] });
      await sleep(120);
      check(
        "网卡重连冷却期内第二次变化不立即触发",
        firstTriggered && ctx.spawns() === during,
        `spawn ${during}→${ctx.spawns()}`,
      );
      const later = await waitFor(() => ctx.spawns() === during + 1, 2000);
      check("冷却结束后网卡仍不同才触发重连", later, `spawn=${ctx.spawns()}`);
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- 令牌模式：自己的配置文件 + 纯函数拼参数 ---- */
  check(
    "令牌模式命令行（namedTunnelArgs）：不给 edge 时只带 --config 和 --no-autoupdate",
    JSON.stringify(namedTunnelArgs({ configFile: "/tmp/cloudflared-named-token-9.yml" }))
      === JSON.stringify(["tunnel", "--config", "/tmp/cloudflared-named-token-9.yml", "--no-autoupdate", "run"]),
    JSON.stringify(namedTunnelArgs({ configFile: "/tmp/cloudflared-named-token-9.yml" })),
  );
  check(
    "令牌模式命令行（namedTunnelArgs）：给 edge 时带 --protocol http2 和两次 --edge",
    JSON.stringify(namedTunnelArgs({ configFile: "/tmp/x.yml", edge: "127.0.0.1:7844" }))
      === JSON.stringify(["tunnel", "--config", "/tmp/x.yml", "--no-autoupdate", "--protocol", "http2", "--edge", "127.0.0.1:7844", "--edge", "127.0.0.1:7844", "run"]),
    JSON.stringify(namedTunnelArgs({ configFile: "/tmp/x.yml", edge: "127.0.0.1:7844" })),
  );
  check(
    "令牌模式命令行（namedTunnelArgs）：令牌不进命令行",
    namedTunnelArgs({ configFile: "/tmp/x.yml" }).every((arg) => !arg.includes("TUNNEL_TOKEN")),
    JSON.stringify(namedTunnelArgs({ configFile: "/tmp/x.yml" })),
  );

  /* ---- 日志里的本机地址：公网打码、私有照写 ---- */
  check(
    "maskAddress：公网只留前两段，私有 / 保留网段照写",
    maskAddress("8.8.8.8") === "8.8.*.*"
      && maskAddress("203.0.113.5") === "203.0.*.*"
      && maskAddress("172.32.1.5") === "172.32.*.*"
      && maskAddress("10.1.2.3") === "10.1.2.3"
      && maskAddress("172.20.1.5") === "172.20.1.5"
      && maskAddress("192.168.1.20") === "192.168.1.20"
      && maskAddress("100.64.0.1") === "100.64.0.1"
      && maskAddress("169.254.1.2") === "169.254.1.2"
      && maskAddress("198.18.0.1") === "198.18.0.1",
    [maskAddress("8.8.8.8"), maskAddress("10.1.2.3"), maskAddress("198.18.0.1")].join(" / "),
  );

  await (async () => {
    const ctx = await startManager({ interfaces: { "以太网": [v4("8.8.8.8")] } });
    try {
      ctx.logs.length = 0;
      ctx.setInterfaces({ "以太网": [v4("10.0.0.2")] });
      const changed = await waitFor(() => ctx.logs.some((line) => line.includes("网卡地址变了")), 1500);
      const line = ctx.logs.find((item) => item.includes("网卡地址变了")) ?? "";
      check(
        "网卡变化日志里公网地址被打码、私有地址照写",
        changed && line.includes("以太网 8.8.*.* 没了") && line.includes("以太网 10.0.0.2 新增"),
        line || "(没有)",
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- /ready：只在本机 metrics 端口上查，地址从日志里取 ---- */
  const metricsLine = "Starting metrics server on 127.0.0.1:20242/metrics\n";
  const readyJson = (connections) => ({ status: 200, json: async () => ({ status: 200, readyConnections: connections, connectorId: "自检" }) });
  const ready503 = (connections = 0) => ({ status: 503, json: async () => ({ status: 503, readyConnections: connections }) });

  await (async () => {
    const urls = [];
    const ctx = await startManager({
      readyPollMs: 20,
      readyFetchFn: async (url) => { urls.push(url); return readyJson(1); },
    });
    try {
      ctx.children.at(-1).stderr.write(metricsLine);
      const polled = await waitFor(() => urls.length > 0, 1000);
      check(
        "metrics：处理完整行时记下 metricsAddress",
        ctx.manager.metricsAddress === "127.0.0.1:20242",
        `metricsAddress=${ctx.manager.metricsAddress}`,
      );
      check(
        "metrics：/ready 请求的是 http://<地址>/ready",
        polled && urls[0] === "http://127.0.0.1:20242/ready",
        urls[0] ?? "(没请求)",
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- /ready 连续两次 0：重建线路，只重连一次 ---- */
  await (async () => {
    let calls = 0;
    const ctx = await startManager({
      readyPollMs: 20,
      readyFetchFn: async () => { calls++; return ready503(0); },
    });
    try {
      const before = ctx.spawns();
      ctx.children.at(-1).stderr.write(metricsLine);
      const reconnected = await waitFor(() => ctx.spawns() === before + 1, 1500);
      await sleep(120); // 再等几个轮询周期，确认没有第二次重连
      check(
        "连续两次 0：reconnect 只调一次",
        reconnected && ctx.spawns() === before + 1,
        `spawn ${before}→${ctx.spawns()}，/ready 调用 ${calls} 次`,
      );
      check(
        "连续两次 0：日志里有 /ready 重建线路那句",
        ctx.logs.some((line) => line.includes("已连续 2 次（/ready），重建线路")),
        ctx.logs.find((line) => line.includes("/ready")) ?? "(没有)",
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- /ready 一次 0 再一次 2：不重连，计数归零 ---- */
  await (async () => {
    let calls = 0;
    const ctx = await startManager({
      readyPollMs: 20,
      readyFetchFn: async () => (++calls === 1 ? ready503(0) : readyJson(2)),
    });
    try {
      const before = ctx.spawns();
      ctx.children.at(-1).stderr.write(metricsLine);
      const polled = await waitFor(() => calls >= 2, 1000);
      await sleep(40); // 让第二次结果落进状态
      check(
        "一次 0 再一次 2：不重连、readyMisses 归零",
        polled && ctx.spawns() === before && ctx.manager.readyMisses === 0,
        `spawn ${before}→${ctx.spawns()} readyMisses=${ctx.manager.readyMisses}`,
      );
      check(
        "一次 0 再一次 2：status().readyConnections 报 2",
        ctx.manager.status().readyConnections === 2,
        `readyConnections=${ctx.manager.status().readyConnections}`,
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- /ready 未连上时的 0 不计数：连上后连续两次 0 才重建线路 ---- */
  await (async () => {
    let calls = 0;
    let releaseFirst = null;
    let releaseThird = null;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const thirdGate = new Promise((resolve) => { releaseThird = resolve; });
    const ctx = await startManager({
      readyPollMs: 100,
      readyFetchFn: async () => {
        calls++;
        // 第一次故意卡住，让「未连上」的采样落在请求飞行中；第三次卡住，好在重连前看计数
        if (calls === 1) await firstGate;
        if (calls === 3) await thirdGate;
        return ready503(0);
      },
    });
    try {
      const before = ctx.spawns();
      // 模拟旧定时器落进新进程「已打出 metrics、还没 Registered」的窗口：此刻还没连上
      ctx.children.at(-1).stderr.write(metricsLine);
      ctx.manager.connected = false;
      const firstInFlight = await waitFor(() => calls === 1, 1000);
      ctx.manager.connected = true;
      releaseFirst();
      const thirdInFlight = await waitFor(() => calls === 3, 1500);
      check(
        "未连上时的 0 不计数：连上后再 0 只记 1 次，不重连",
        firstInFlight && thirdInFlight && ctx.manager.readyMisses === 1 && ctx.spawns() === before,
        `首次在飞=${firstInFlight} 第三次在飞=${thirdInFlight} readyMisses=${ctx.manager.readyMisses} spawn ${before}→${ctx.spawns()}`,
      );
      releaseThird();
      const reconnected = await waitFor(() => ctx.spawns() === before + 1, 1500);
      check(
        "连上后连续两次 0 仍然重建线路",
        reconnected,
        `spawn ${before}→${ctx.spawns()}`,
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- 日志说全掉了、/ready 说还有 1 条：清掉 lost 定时器，不重连 ---- */
  await (async () => {
    const ctx = await startManager({
      readyPollMs: 60,
      lostTimeoutMs: 1000,
      readyFetchFn: async () => readyJson(1),
    });
    try {
      const before = ctx.spawns();
      ctx.logs.length = 0;
      ctx.children.at(-1).stderr.write(`${metricsLine}Unregistered tunnel connection connIndex=0\n`);
      const lostScheduled = await waitFor(() => Boolean(ctx.manager.timers.lost), 500);
      const lostCleared = await waitFor(() => ctx.manager.timers.lost === null, 1000);
      check(
        "日志全掉但 /ready 报 1：清掉 lost 定时器、不重连",
        lostScheduled && lostCleared && ctx.spawns() === before,
        `lost 排上=${lostScheduled} 清掉=${lostCleared} spawn ${before}→${ctx.spawns()}`,
      );
      check(
        "日志全掉但 /ready 报 1：日志写明以 /ready 为准",
        ctx.logs.some((line) => line.includes("日志里边缘连接全掉了，但 cloudflared 自己报还有 1 条（/ready），以它为准、不重连")),
        ctx.logs.find((line) => line.includes("以它为准")) ?? "(没有)",
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- /ready 否决后要记住：重复的掉线日志不能把 lost 定时器再装回来 ---- */
  await (async () => {
    let calls = 0;
    const ctx = await startManager({
      readyPollMs: 30,
      lostTimeoutMs: 1000,
      readyFetchFn: async () => {
        calls++;
        // 只让第一次 /ready 成功否决；后面的查询故意失败，避免它再清一遍 lost，好验证重复日志确实被挡住
        if (calls === 1) return readyJson(1);
        throw new Error("自检：后面的 /ready 不再参与");
      },
    });
    try {
      await waitFor(() => ctx.manager.liveConnections.has("0"), 1000);
      ctx.logs.length = 0;
      const before = ctx.spawns();
      ctx.children.at(-1).stderr.write(`${metricsLine}Unregistered tunnel connection connIndex=0\n`);
      const vetoed = await waitFor(() => ctx.manager.logLostVetoed && ctx.manager.timers.lost === null, 1000);
      check(
        "日志全掉但 /ready 报 1：清掉 lost 定时器并记下否决",
        vetoed && ctx.manager.liveConnections.size === 0 && ctx.spawns() === before,
        `lost 清掉=${ctx.manager.timers.lost === null} 否决=${ctx.manager.logLostVetoed}`,
      );
      ctx.children.at(-1).stderr.write("Unrelated cloudflared log line\n");
      await sleep(60); // 等过几个日志处理周期
      const stayedQuiet = ctx.manager.timers.lost === null;
      ctx.children.at(-1).stderr.write("Unregistered tunnel connection connIndex=0\n");
      const rescheduled = await waitFor(() => Boolean(ctx.manager.timers.lost), 500);
      check(
        "否决之后重复掉线日志不再装 lost 定时器，但新的掉线日志会重置否决并重装",
        stayedQuiet && rescheduled && ctx.spawns() === before,
        `无关日志后 lost=${stayedQuiet ? "null" : "排上"} 新掉线后 lost=${rescheduled ? "排上" : "null"} spawn ${before}→${ctx.spawns()}`,
      );
      check(
        "「以它为准、不重连」只在第一次否决时打一次",
        ctx.logs.filter((line) => line.includes("以它为准")).length === 1,
        `出现 ${ctx.logs.filter((line) => line.includes("以它为准")).length} 次`,
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- /ready 请求失败：不计数、不重连，status 报 null ---- */
  await (async () => {
    const ctx = await startManager({
      readyPollMs: 20,
      readyFetchFn: async () => { throw new Error("自检：/ready 连不上"); },
    });
    try {
      const before = ctx.spawns();
      ctx.children.at(-1).stderr.write(metricsLine);
      const failed = await waitFor(() => ctx.manager.ready && !ctx.manager.ready.ok, 1000);
      await sleep(60); // 多失败几次，确认失败不计入 readyMisses
      const status = ctx.manager.status();
      check(
        "请求失败：不计入 readyMisses、不重连",
        failed && ctx.manager.readyMisses === 0 && ctx.spawns() === before,
        `readyMisses=${ctx.manager.readyMisses} spawn ${before}→${ctx.spawns()}`,
      );
      check(
        "请求失败：status().readyConnections 为 null，ready 里记了错误",
        status.readyConnections === null && Boolean(ctx.manager.ready?.error),
        `readyConnections=${status.readyConnections} error=${ctx.manager.ready?.error ?? "(无)"}`,
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- 子进程退出后不报旧的边缘连接数 ---- */
  await (async () => {
    const ctx = await startManager({
      readyPollMs: 20,
      readyFetchFn: async () => readyJson(4),
    });
    try {
      ctx.children.at(-1).stderr.write(metricsLine);
      const seen = await waitFor(() => ctx.manager.status().readyConnections === 4, 1000);
      ctx.children.at(-1).kill();
      const exited = await waitFor(() => ctx.manager.child === null, 1000);
      const status = ctx.manager.status();
      check(
        "子进程退出后 status().readyConnections / readyAt 不再报旧值",
        seen && exited && status.readyConnections === null && status.readyAt === null,
        `查到 4 条=${seen} 已退出=${exited} readyConnections=${status.readyConnections} readyAt=${status.readyAt}`,
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- stop() 之后不再轮询 ---- */
  await (async () => {
    let calls = 0;
    const ctx = await startManager({
      readyPollMs: 20,
      readyFetchFn: async () => { calls++; return readyJson(1); },
    });
    try {
      ctx.children.at(-1).stderr.write(metricsLine);
      await waitFor(() => calls > 0, 1000);
      await ctx.manager.stop();
      const atStop = calls;
      await sleep(150); // 等过好几个轮询周期
      check(
        "stop() 之后 readyFetchFn 不再被调用",
        atStop > 0 && calls === atStop,
        `stop 时 ${atStop} 次，150ms 后 ${calls} 次`,
      );
      check(
        "stop() 之后 status() 不再报 /ready 的旧结果",
        ctx.manager.status().readyConnections === null && ctx.manager.status().readyAt === null,
        `readyConnections=${ctx.manager.status().readyConnections} readyAt=${ctx.manager.status().readyAt}`,
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

  /* ---- provider 是 ngrok：没有 /ready 可查 ---- */
  await (async () => {
    let calls = 0;
    const ctx = await startManager({
      provider: "ngrok",
      readyPollMs: 20,
      readyFetchFn: async () => { calls++; return readyJson(1); },
    });
    try {
      ctx.children.at(-1).stdout.write(metricsLine);
      await sleep(120); // 等过好几个轮询周期
      check(
        "provider 为 ngrok 时从不调用 readyFetchFn",
        ctx.connected && calls === 0,
        `connected=${ctx.connected} calls=${calls}`,
      );
    } finally {
      await ctx.manager.stop();
    }
  })();

}

/* ======================================================================
 * 入口
 * ==================================================================== */
tempRoot = mkdtempSync(path.join(os.tmpdir(), "tunnel-recovery-selftest-"));
dataHome = path.join(tempRoot, "data");

try {
  console.log("EdgeRelay");
  await runRelayChecks().catch((error) => check("EdgeRelay 自检跑完没有异常", false, error?.stack || String(error)));

  console.log("TunnelManager");
  await runTunnelChecks().catch((error) => check("TunnelManager 自检跑完没有异常", false, error?.stack || String(error)));
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n结果：通过 ${results.length - failed.length}/${results.length}`);
process.exit(failed.length ? 1 : 0);
