#!/usr/bin/env node
/**
 * 边缘中继连接生命周期自检 —— 纯 Node，不联网、不装依赖、不访问外网。
 *
 * 运行：node src/edge-relay-selftest.mjs
 *
 * 覆盖：
 *   正常双向转发；上下游都开 10 秒保活 + noDelay；
 *   客户端在上游连上前离开时不再挨个拨目标、在途上游被销毁；
 *   stop() 之后在途拨号不再继续、不产生新上游连接；
 *   客户端先发数据再等上游，连上后数据完整且按顺序到达；
 *   客户端等待期间半关闭（end），数据仍完整转发且上游收到 end；
 *   暂存超过 1MB 时客户端被销毁；监听运行期出错不崩且记日志。
 *
 * 副作用隔离：所有假服务器都只监听 127.0.0.1，不连任何外部地址。
 */

import net from "node:net";

import { EdgeRelay } from "./core/edge-relay.js";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —— ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 2000, stepMs = 10) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

function listenOn(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(server.address().port); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
  });
}

/** 假「Cloudflare 边缘」：收到什么原样加 echo: 前缀回去 */
function makeEchoEdge() {
  const all = [];
  const server = net.createServer((socket) => {
    all.push(socket);
    socket.on("error", () => {});
    socket.on("data", (chunk) => socket.write(Buffer.concat([Buffer.from("echo:"), chunk])));
  });
  return { server, all };
}

/** 假边缘：只记录收到的字节和 end，方便确认顺序与半关闭 */
function makeRecordingEdge() {
  const all = [];
  let endCount = 0;
  const server = net.createServer((socket) => {
    all.push(socket);
    socket.chunks = [];
    socket.on("error", () => {});
    socket.on("data", (chunk) => socket.chunks.push(chunk));
    socket.on("end", () => { endCount++; socket.end(); });
  });
  return {
    server,
    all,
    get endCount() { return endCount; },
    dataOf: (socket) => Buffer.concat(socket.chunks).toString(),
  };
}

/**
 * 假 HTTP 代理：只认 CONNECT。mode="reject" 回 502，否则延迟 delayMs 后接上真边缘。
 * requests 记录每次 CONNECT，用来数中继到底拨了几个目标。
 */
function makeHttpProxy({ edgePort, delayMs = 0, mode = "ok" }) {
  const requests = [];
  const sockets = new Set();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("error", () => {});
    client.on("close", () => sockets.delete(client));
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.off("data", onData);
      const head = buffer.subarray(0, end).toString("latin1");
      const target = /^CONNECT\s+(\S+)/.exec(head)?.[1] || "";
      const record = { host: target.split(":")[0], connected: false, closed: false };
      requests.push(record);
      client.on("close", () => { record.closed = true; });
      setTimeout(() => {
        if (client.destroyed) return;
        if (mode === "reject") {
          client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          return;
        }
        const edge = net.connect(edgePort, "127.0.0.1");
        sockets.add(edge);
        edge.on("error", () => {});
        edge.on("close", () => sockets.delete(edge));
        edge.once("connect", () => {
          if (client.destroyed) { edge.destroy(); return; }
          record.connected = true;
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          client.pipe(edge);
          edge.pipe(client);
        });
      }, delayMs);
    };
    client.on("data", onData);
  });
  return { server, requests, sockets };
}

async function connectClient(port) {
  const socket = net.connect(port, "127.0.0.1");
  socket.on("error", () => {});
  await new Promise((resolve, reject) => {
    const onConnect = () => { socket.off("error", onError); resolve(); };
    const onError = (error) => { socket.off("connect", onConnect); reject(error); };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
  return socket;
}

async function startRelay(options) {
  const relay = new EdgeRelay(options);
  const address = await relay.start();
  return { relay, port: Number(address.split(":")[1]) };
}

async function cleanup({ relay, servers = [], sockets = [] } = {}) {
  for (const socket of sockets) socket.destroy();
  for (const server of servers) {
    if (!server) continue;
    server.close?.();
    for (const socket of server.sockets || []) socket.destroy();
  }
  await relay?.stop().catch(() => {});
  for (const server of servers) await closeServer(server).catch(() => {});
}

/* ======================================================================
 * 用例
 * ==================================================================== */
async function main() {
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

  try {
    /* ---- 正常双向转发 + 两侧保活 / noDelay ---- */
    {
      const edge = makeEchoEdge();
      const edgePort = await listenOn(edge.server);
      const { relay, port: relayPort } = await startRelay({
        bind: { localAddress: "127.0.0.1" }, hosts: ["127.0.0.1"], port: edgePort, onLog: () => {},
      });
      const client = await connectClient(relayPort);
      const received = [];
      client.on("data", (chunk) => received.push(chunk.toString()));
      try {
        await waitFor(() => edge.all.length === 1);
        client.write("hello");
        const forwarded = await waitFor(() => received.join("").includes("echo:hello"));
        edge.all[0]?.write("world");
        const back = await waitFor(() => received.join("").includes("world"));
        check("中继：正常双向转发", forwarded && back, "hello / world");

        await sleep(30);
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
      } finally {
        client.destroy();
        await cleanup({ relay, servers: [edge.server] });
      }
    }

    /* ---- 客户端先发数据再等上游：数据完整且按顺序 ---- */
    {
      const edge = makeRecordingEdge();
      const edgePort = await listenOn(edge.server);
      const proxy = makeHttpProxy({ edgePort, delayMs: 120 });
      const proxyPort = await listenOn(proxy.server);
      const { relay, port: relayPort } = await startRelay({
        proxy: { type: "http", host: "127.0.0.1", port: proxyPort },
        hosts: ["edge-a", "edge-b"],
        port: 7844,
        onLog: () => {},
      });
      const pieces = Array.from({ length: 30 }, (_, i) => `#${i};`);
      const client = await connectClient(relayPort);
      try {
        for (const piece of pieces) client.write(piece);
        const expected = pieces.join("");
        const arrived = await waitFor(() => edge.all.length === 1 && edge.dataOf(edge.all[0]) === expected);
        check("中继：等待上游期间的数据连上后完整、按顺序到达", arrived, `期望 ${expected.length} 字节`);
      } finally {
        client.destroy();
        await cleanup({ relay, servers: [proxy.server, edge.server] });
      }
    }

    /* ---- 客户端等待期间半关闭：数据完整转发，上游收到 end ---- */
    {
      const edge = makeRecordingEdge();
      const edgePort = await listenOn(edge.server);
      const proxy = makeHttpProxy({ edgePort, delayMs: 120 });
      const proxyPort = await listenOn(proxy.server);
      const { relay, port: relayPort } = await startRelay({
        proxy: { type: "http", host: "127.0.0.1", port: proxyPort },
        hosts: ["edge-a", "edge-b"],
        port: 7844,
        onLog: () => {},
      });
      const pieces = Array.from({ length: 12 }, (_, i) => `half-${i};`);
      const expected = pieces.join("");
      const client = await connectClient(relayPort);
      try {
        for (const piece of pieces) client.write(piece);
        client.end(); // 半关闭：等待上游时就把写方向关了
        const arrived = await waitFor(() => edge.all.length === 1
          && edge.dataOf(edge.all[0]) === expected
          && edge.endCount === 1);
        check(
          "中继：客户端等待期间半关闭，数据仍完整转发且上游收到 end",
          arrived,
          `收到 ${edge.all.length ? edge.dataOf(edge.all[0]) : "(无)"}，end ${edge.endCount} 次`,
        );
      } finally {
        client.destroy();
        await cleanup({ relay, servers: [proxy.server, edge.server] });
      }
    }

    /* ---- 连上并转发之后客户端发 FIN：中继马上把两头都拆掉 ---- */
    {
      // 假边缘故意半开：收到 FIN 也不关，用来模拟「上游不主动关」的情况
      const received = [];
      const edgeSockets = [];
      let edgeEnded = false;
      const edge = net.createServer({ allowHalfOpen: true }, (socket) => {
        edgeSockets.push(socket);
        socket.on("error", () => {});
        socket.on("data", (chunk) => received.push(chunk.toString()));
        socket.on("end", () => { edgeEnded = true; });
      });
      const edgePort = await listenOn(edge);
      const { relay, port: relayPort } = await startRelay({
        bind: { localAddress: "127.0.0.1" }, hosts: ["127.0.0.1"], port: edgePort, onLog: () => {},
      });
      const client = await connectClient(relayPort);
      let clientClosed = false;
      client.on("close", () => { clientClosed = true; });
      const socketsAtPeak = [];
      try {
        await waitFor(() => edgeSockets.length === 1);
        client.write("hello");
        const forwarded = await waitFor(() => received.join("").includes("hello"));
        socketsAtPeak.push(relay.sockets.size);
        client.end(); // 发 FIN：cloudflared 先关连接
        const tornDown = await waitFor(
          () => relay.sockets.size === 0 && edgeEnded && clientClosed,
          1500,
        );
        check(
          "中继：客户端发 FIN 后马上拆掉客户端和上游，sockets 清空",
          forwarded && socketsAtPeak[0] === 2 && tornDown && relay.sockets.size === 0,
          `转发=${forwarded} 当时 sockets=${socketsAtPeak[0]} 现在=${relay.sockets.size} 上游${edgeEnded ? "收到 FIN" : "还开着"}`,
        );
      } finally {
        client.destroy();
        await cleanup({ relay, servers: [edge] });
      }
    }

    /* ---- 上游连上之前客户端半关闭，且第一次拨号失败：不再拨后面的目标 ---- */
    {
      const edge = makeRecordingEdge();
      const edgePort = await listenOn(edge.server);
      const proxy = makeHttpProxy({ edgePort, delayMs: 200, mode: "reject" });
      const proxyPort = await listenOn(proxy.server);
      const { relay, port: relayPort } = await startRelay({
        proxy: { type: "http", host: "127.0.0.1", port: proxyPort },
        hosts: ["edge-a", "edge-b", "edge-c"],
        port: 7844,
        onLog: () => {},
      });
      const client = await connectClient(relayPort);
      try {
        await waitFor(() => proxy.requests.length === 1);
        client.end();
        await sleep(450);
        check(
          "中继：客户端离开后不再把剩下的目标挨个拨完",
          proxy.requests.length === 1,
          `拨号 ${proxy.requests.length} 次：${proxy.requests.map((r) => r.host).join(",")}`,
        );
      } finally {
        client.destroy();
        await cleanup({ relay, servers: [proxy.server, edge.server] });
      }
    }

    /* ---- 客户端在上游连上之前销毁：在途的上游被销毁 ---- */
    {
      const edge = makeRecordingEdge();
      const edgePort = await listenOn(edge.server);
      const proxy = makeHttpProxy({ edgePort, delayMs: 200 });
      const proxyPort = await listenOn(proxy.server);
      const { relay, port: relayPort } = await startRelay({
        proxy: { type: "http", host: "127.0.0.1", port: proxyPort },
        hosts: ["edge-a", "edge-b", "edge-c"],
        port: 7844,
        onLog: () => {},
      });
      const client = await connectClient(relayPort);
      try {
        await waitFor(() => proxy.requests.length === 1);
        client.destroy();
        const connectedThenClosed = await waitFor(() => proxy.requests[0]?.connected && proxy.requests[0]?.closed);
        await sleep(150);
        check(
          "中继：客户端在拨号途中离开，拨到一半的上游被销毁",
          connectedThenClosed && proxy.requests.length === 1,
          `拨号 ${proxy.requests.length} 次，在途上游 ${proxy.requests[0]?.connected ? "已连上" : "未连上"}${proxy.requests[0]?.closed ? "、已销毁" : "、未销毁"}`,
        );
      } finally {
        client.destroy();
        await cleanup({ relay, servers: [proxy.server, edge.server] });
      }
    }

    /* ---- stop() 之后在途拨号不再继续、不产生新上游连接 ---- */
    {
      const edge = makeRecordingEdge();
      const edgePort = await listenOn(edge.server);
      const proxy = makeHttpProxy({ edgePort, delayMs: 200 });
      const proxyPort = await listenOn(proxy.server);
      const { relay, port: relayPort } = await startRelay({
        proxy: { type: "http", host: "127.0.0.1", port: proxyPort },
        hosts: ["edge-a", "edge-b", "edge-c"],
        port: 7844,
        onLog: () => {},
      });
      const client = await connectClient(relayPort);
      try {
        await waitFor(() => proxy.requests.length === 1);
        await relay.stop();
        const inFlightGone = await waitFor(() => proxy.requests[0]?.closed);
        await sleep(200);
        check(
          "中继：stop() 之后在途拨号不再继续、不再产生新上游连接",
          proxy.requests.length === 1 && inFlightGone,
          `拨号 ${proxy.requests.length} 次，在途上游${inFlightGone ? "已销毁" : "未销毁"}`,
        );
      } finally {
        client.destroy();
        await cleanup({ relay, servers: [proxy.server, edge.server] });
      }
    }

    /* ---- 暂存超过 1MB：客户端被销毁 ---- */
    {
      const edge = makeRecordingEdge();
      const edgePort = await listenOn(edge.server);
      const proxy = makeHttpProxy({ edgePort, delayMs: 300 });
      const proxyPort = await listenOn(proxy.server);
      const { relay, port: relayPort } = await startRelay({
        proxy: { type: "http", host: "127.0.0.1", port: proxyPort },
        hosts: ["edge-a", "edge-b"],
        port: 7844,
        onLog: () => {},
      });
      const client = await connectClient(relayPort);
      let closed = false;
      client.on("close", () => { closed = true; });
      try {
        await waitFor(() => proxy.requests.length === 1);
        client.write(Buffer.alloc(1300 * 1024, 0x61));
        const killed = await waitFor(() => closed);
        check("中继：暂存超过 1MB 时客户端被销毁", killed);
        await sleep(400); // 让在途拨号走完并自行销毁
      } finally {
        client.destroy();
        await cleanup({ relay, servers: [proxy.server, edge.server] });
      }
    }

    /* ---- listen 之后连续两次监听错误：不崩、都记日志 ---- */
    {
      const logs = [];
      const { relay } = await startRelay({
        bind: { localAddress: "127.0.0.1" }, hosts: ["127.0.0.1"], port: 7844,
        onLog: (message) => logs.push(message),
      });
      try {
        relay.server.emit("error", Object.assign(new Error("第一次监听错误"), { code: "EBOOM1" }));
        relay.server.emit("error", Object.assign(new Error("第二次监听错误"), { code: "EBOOM2" }));
        const logged = await waitFor(
          () => logs.filter((m) => m.startsWith("边缘中继监听出错：")).length === 2,
        );
        check(
          "中继：listen 后连续两次监听错误都不崩，且两次都记了日志",
          logged,
          logs.join(" / ") || "没有日志",
        );
      } finally {
        await cleanup({ relay });
      }
    }
  } finally {
    net.Socket.prototype.setKeepAlive = realSetKeepAlive;
    net.Socket.prototype.setNoDelay = realSetNoDelay;
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n结果：通过 ${passed}/${results.length}`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
