/**
 * Cloudflare 边缘中继 —— 让 cloudflared 在「只有 HTTP/SOCKS 代理、没有 TUN」的机器上也能打通。
 *
 * 为什么需要：cloudflared 连边缘（*.argotunnel.com:7844）是裸 TCP/UDP 直拨，
 * 既不读系统代理，也不认 HTTPS_PROXY。开了 TUN 的机器流量被虚拟网卡兜住所以能通；
 * 只开系统代理的机器（测试机常见）直拨被墙，隧道一直 connecting。
 *
 * 做法（对应学习软件的 cloudflare-edge-relay.ts）：
 *   本地起一个 127.0.0.1:<随机端口> 的 TCP 中继 → 每条连接经代理 CONNECT 到边缘 7844
 *   → cloudflared 用 `--edge 127.0.0.1:<端口> --protocol http2` 连中继。
 *   TLS 的 SNI 是 cloudflared 自己定的（h2.cftunnel.com），中继只搬字节，不碰证书。
 *
 * 只读代理配置，从不修改系统代理或代理软件。
 */

import net from "node:net";
import { execFile } from "node:child_process";

export const EDGE_HOSTS = ["region1.v2.argotunnel.com", "region2.v2.argotunnel.com"];
export const EDGE_PORT = 7844;
/** Cloudflare 隧道服务器的真实 IP（region1 / region2 各 10 个，实测都能握手）。开了「假 IP」时域名解析不出真地址，只能用它们 */
export const EDGE_IPS = [
  ...[7, 27, 37, 47, 57, 67, 77, 107, 167, 227].map((n) => `198.41.192.${n}`),
  ...[13, 23, 33, 43, 53, 63, 73, 113, 193, 233].map((n) => `198.41.200.${n}`),
];
/** 中继的目标：两个域名 + 两个固定 IP（域名被代理规则分错线路、或解析被干扰时还能用 IP） */
export const EDGE_TARGETS = [...EDGE_HOSTS, EDGE_IPS[0], EDGE_IPS[14]];

/** 解析 "http://h:p" / "socks5://h:p" / "h:p" / Windows 的 "http=h:p;https=h:p;socks=h:p" */
export function parseProxy(value) {
  if (!value) return null;
  let text = String(value).trim();
  if (!text) return null;
  if (text.includes("=")) {
    const parts = Object.fromEntries(text.split(";").map(p => p.split("=").map(s => s.trim())).filter(p => p.length === 2));
    if (parts.https) text = `http://${parts.https}`;
    else if (parts.http) text = `http://${parts.http}`;
    else if (parts.socks) text = `socks5://${parts.socks}`;
    else return null;
  }
  if (!/^[a-z0-9]+:\/\//i.test(text)) text = `http://${text}`;
  try {
    const url = new URL(text);
    const scheme = url.protocol.replace(":", "").toLowerCase();
    const type = scheme.startsWith("socks") ? "socks5" : scheme === "http" || scheme === "https" ? "http" : null;
    if (!type || !url.hostname || !url.port) return null;
    return { type, host: url.hostname, port: Number(url.port), url: `${type === "socks5" ? "socks5" : "http"}://${url.hostname}:${url.port}` };
  } catch { return null; }
}

const INET_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

/** 读 Windows 系统代理。reg.exe 在有的电脑上被安全策略禁用，所以失败时改用 PowerShell 读同一个位置。 */
function readWindowsSystemProxy() {
  if (process.platform !== "win32") return Promise.resolve(null);
  const viaReg = () => new Promise(resolve => {
    execFile("reg", ["query", INET_KEY], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error || !stdout) return resolve(undefined);
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x0*1\b/i.test(stdout);
      const server = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(stdout)?.[1];
      resolve(enabled && server ? server : null);
    });
  });
  const viaPowerShell = () => new Promise(resolve => {
    const script = "$p = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue; if ($p.ProxyEnable -eq 1 -and $p.ProxyServer) { $p.ProxyServer }";
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 8000 }, (error, stdout) => {
      const server = String(stdout || "").trim();
      resolve(!error && server ? server : null);
    });
  });
  return viaReg().then(value => (value === undefined ? viaPowerShell() : value)).catch(() => null);
}

/** 读 macOS 系统代理（scutil --proxy），优先 HTTPS，其次 HTTP、SOCKS。 */
function readMacSystemProxy() {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise(resolve => {
    execFile("scutil", ["--proxy"], { timeout: 5000 }, (error, stdout) => {
      if (error || !stdout) return resolve(null);
      const get = (k) => new RegExp(`\\b${k}\\s*:\\s*(\\S+)`).exec(stdout)?.[1];
      for (const [kind, scheme] of [["HTTPS", "http"], ["HTTP", "http"], ["SOCKS", "socks5"]]) {
        if (get(`${kind}Enable`) === "1" && get(`${kind}Proxy`) && get(`${kind}Port`)) return resolve(`${scheme}://${get(`${kind}Proxy`)}:${get(`${kind}Port`)}`);
      }
      resolve(null);
    });
  });
}

/** 按优先级找代理：显式配置 → 环境变量 → 系统代理（Windows / macOS，已启用的）。 */
export async function detectProxy(env = process.env, explicit) {
  const sources = [
    ["设置", explicit],
    ["HTTPS_PROXY", env.HTTPS_PROXY ?? env.https_proxy],
    ["ALL_PROXY", env.ALL_PROXY ?? env.all_proxy],
    ["HTTP_PROXY", env.HTTP_PROXY ?? env.http_proxy],
  ];
  for (const [source, value] of sources) {
    const parsed = parseProxy(value);
    if (parsed) return { ...parsed, source };
  }
  const system = parseProxy(process.platform === "darwin" ? await readMacSystemProxy() : await readWindowsSystemProxy());
  return system ? { ...system, source: "系统代理" } : null;
}

/** 能不能在 timeoutMs 内和 host:port 建 TCP。TUN 机器上直连会成功。 */
export function probeTcp(host, port, timeoutMs = 4000) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** 经代理开一条到 host:port 的隧道 socket。 */
export function connectViaProxy(proxy, host, port, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let buffer = Buffer.alloc(0);
    let stage = 0;
    const fail = (message) => { socket.destroy(); reject(new Error(message)); };
    socket.setTimeout(timeoutMs, () => fail(`代理 ${proxy.host}:${proxy.port} 超时`));
    socket.once("error", error => fail(`代理 ${proxy.host}:${proxy.port} 连不上：${error.message}`));
    const finish = () => {
      socket.removeAllListeners("data");
      socket.removeAllListeners("timeout");
      socket.removeAllListeners("error");
      socket.setTimeout(0);
      // 握手后多读到的字节（极少见）推回去，别丢
      if (buffer.length) socket.unshift(buffer);
      resolve(socket);
    };

    socket.once("connect", () => {
      if (proxy.type === "http") {
        socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
      } else {
        socket.write(Buffer.from([0x05, 0x01, 0x00]));
      }
    });
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (proxy.type === "http") {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const status = /^HTTP\/1\.[01] (\d{3})/.exec(buffer.subarray(0, end).toString("latin1"))?.[1];
        if (status !== "200") return fail(`代理拒绝 CONNECT ${host}:${port}（HTTP ${status ?? "?"}）`);
        buffer = buffer.subarray(end + 4);
        return finish();
      }
      // SOCKS5：问候 → 连接请求 → 应答
      if (stage === 0) {
        if (buffer.length < 2) return;
        if (buffer[0] !== 0x05 || buffer[1] !== 0x00) return fail("SOCKS5 代理要求认证，暂不支持");
        buffer = buffer.subarray(2);
        stage = 1;
        const name = Buffer.from(host);
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, Buffer.from([port >> 8, port & 0xff])]));
      }
      if (stage === 1) {
        if (buffer.length < 5) return;
        if (buffer[1] !== 0x00) return fail(`SOCKS5 代理拒绝连接 ${host}:${port}（code ${buffer[1]}）`);
        const len = buffer[3] === 0x01 ? 10 : buffer[3] === 0x04 ? 22 : 7 + buffer[4];
        if (buffer.length < len) return;
        buffer = buffer.subarray(len);
        finish();
      }
    });
  });
}

/** 不经代理、从指定网卡（真实网卡的 IP）直接连隧道服务器 —— 开了 TUN 时用它绕开虚拟网卡 */
export function connectBound(localAddress, host, port, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, localAddress });
    socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(new Error(`直连 ${host} 超时`)); });
    socket.once("error", error => reject(new Error(`直连 ${host} 失败：${error.code || error.message}`)));
    socket.once("connect", () => { socket.setTimeout(0); socket.removeAllListeners("error"); resolve(socket); });
  });
}

export class EdgeRelay {
  /**
   * proxy：经 HTTP/SOCKS 代理中继；bind：{ localAddress } 从真实网卡直连（绕开 TUN）。二选一。
   */
  constructor({ proxy = null, bind = null, hosts, port = EDGE_PORT, onLog = () => {} }) {
    this.proxy = proxy;
    this.bind = bind;
    // 绕开 TUN 时域名会被解析成假 IP，只能用真实 IP；起点随机，把连接摊到不同服务器上
    const list = hosts ?? (bind ? EDGE_IPS : EDGE_TARGETS);
    const offset = Math.floor(Math.random() * list.length);
    this.hosts = bind ? [...list.slice(offset), ...list.slice(0, offset)] : list;
    this.edgePort = port;
    this.onLog = onLog;
    this.server = null;
    this.sockets = new Set();
    this.next = 0;
    this.failures = 0;
    this.stopped = false;
  }

  async start() {
    this.stopped = false;
    // allowHalfOpen：客户端发来 FIN 后写方向还要留着，才能把等待期间攒下的数据补写给上游
    this.server = net.createServer({ allowHalfOpen: true }, client => this.#handle(client));
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(0, "127.0.0.1", () => {
        // listen 成功后要把这个一次性监听摘掉，否则第一次运行期错误会被它吞掉，
        // 第二次错误没人接，整个进程直接抛未处理异常
        this.server.off("error", onError);
        resolve();
      });
    });
    // 常驻兜底：运行期监听出错只记日志，不让进程崩
    this.server.on("error", (error) => this.onLog(`边缘中继监听出错：${error.code || error.message}`));
    this.address = `127.0.0.1:${this.server.address().port}`;
    return this.address;
  }

  async #handle(client) {
    this.sockets.add(client);
    /** 上游还没连上时是 null；一侧出错 / 关闭都要把另一侧拆掉，别留半死连接 */
    let upstream = null;
    /** 上游连上之前客户端发来的数据先攒着，连上后按原顺序补写，别丢也别乱 */
    const pending = [];
    let pendingBytes = 0;
    let clientEnded = false;
    // 暂存上限 1MB：对端一直灌数据说明不正常，直接断开，免得内存被吃光
    const PENDING_LIMIT = 1024 * 1024;
    const onClientData = (chunk) => {
      pending.push(chunk);
      pendingBytes += chunk.length;
      if (pendingBytes > PENDING_LIMIT) client.destroy();
    };
    // 不能 pause：暂停的 socket 收不到对端 FIN，客户端已经走了中继也察觉不到，还会把目标挨个拨完
    client.on("data", onClientData);
    client.on("end", () => { clientEnded = true; });
    let clientClosed = false;
    /** 客户端已经走了，或者中继已停 —— 就别再往下拨了 */
    const abandoned = () => this.stopped || clientClosed || client.destroyed;
    client.on("close", () => { clientClosed = true; this.sockets.delete(client); upstream?.destroy(); });
    client.on("error", () => upstream?.destroy());
    // 轮流用域名 / 固定 IP，失败就换下一个
    for (let attempt = 0; attempt < this.hosts.length; attempt++) {
      // 客户端已经半关闭就不再另拨目标（在途那一下如果连上，还要用来把暂存数据发完）
      if (abandoned() || clientEnded) { client.destroy(); return; }
      const host = this.hosts[(this.next++) % this.hosts.length];
      try {
        const socket = this.bind ? await connectBound(this.bind.localAddress, host, this.edgePort) : await connectViaProxy(this.proxy, host, this.edgePort);
        // 拨号期间客户端可能走了、中继可能停了：刚连上的上游也要拆掉
        if (abandoned()) { socket.destroy(); client.destroy(); return; }
        upstream = socket;
        this.sockets.add(upstream);
        upstream.on("close", () => { this.sockets.delete(upstream); client.destroy(); });
        upstream.on("error", () => client.destroy());
        /*
         * 保活只对 bypass（绑真实网卡直连 Cloudflare）有效。中继到 Cloudflare 这一段
         * 原来是裸 TCP，网卡闪断后两条连接都是「半死」的，谁都收不到断开信号，
         * 隧道就一直显示已连接却没人能进来；两侧都开 10 秒保活并关掉 Nagle 能让
         * 死连接尽快暴露，cloudflared 马上重连。relay（经代理中继）时上游连的是
         * 本机代理，保活探不到外网，只能靠代理软件自己关连接、加上层的公网实测兜底。
         */
        for (const side of [upstream, client]) {
          side.setKeepAlive(true, 10_000);
          side.setNoDelay(true);
        }
        // 先按原顺序把暂存数据写给上游，再摘掉暂存监听交给 pipe，数据顺序才不乱
        for (const chunk of pending) upstream.write(chunk);
        pending.length = 0;
        client.off("data", onClientData);
        client.pipe(upstream);
        upstream.pipe(client);
        /*
         * allowHalfOpen 只在「拨号期间」需要（上面靠它收 FIN、把攒下的数据补写完）。
         * 管道接好后要恢复成不允许半开：cloudflared 先发 FIN 时，中继的客户端侧跟着关掉写方向，
         * client 彻底 close 才会触发 close 回调去销毁上游。否则上游不主动关就一条连接挂到天荒地老。
         * 等待期间已经半关闭的不受影响：那时 end 已经触发，写方向由下面显式的 upstream.end() 收尾。
         */
        client.allowHalfOpen = false;
        // 客户端在等待期间已经半关闭：暂存写完后再把 FIN 传给上游
        if (clientEnded) upstream.end();
        return;
      } catch (error) {
        this.failures++;
        if (this.failures <= 5) this.onLog(`边缘中继：${error.message}`);
      }
    }
    client.destroy();
  }

  /** 销毁当前所有中继连接，但监听端口继续开着 —— cloudflared 会立刻重连 */
  dropAll() {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  async stop() {
    // 先标记已停，正在拨号的 #handle 下一轮检查就会停下，不再产生新的上游连接
    this.stopped = true;
    this.dropAll();
    if (this.server) await new Promise(resolve => this.server.close(() => resolve()));
    this.server = null;
  }
}
