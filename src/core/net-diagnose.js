/**
 * 网络诊断 —— 判断「隧道为什么连不上 Cloudflare」，全部只读，从不修改代理或系统设置。
 *
 * 为什么不用 TCP 探测：开了 TUN（虚拟网卡）的电脑上，任何 TCP 连接都会先被代理软件在本机接住，
 * 端口探测永远「通」。所以这里一律做**真实 TLS 握手**：拿到 Cloudflare 隧道服务器的证书才算通。
 *
 * 判断项：
 *   - fakeIp：隧道域名被解析成 198.18.0.0/15（代理软件的「假 IP」模式）
 *   - tun：有代理软件的虚拟网卡
 *   - software：正在运行的代理软件（Clash Verge / Mihomo / v2rayN / sing-box …）
 *   - proxy：可用的 HTTP/SOCKS 代理（设置 → 环境变量 → 系统代理 → 常见本机端口）
 *   - direct：不经中继，直接和 Cloudflare 隧道服务器握手是否成功
 *   - viaProxy：经代理 CONNECT 后再握手是否成功（中继能不能用）
 */

import dns from "node:dns";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { execFile } from "node:child_process";
import { EDGE_HOSTS, EDGE_IPS, EDGE_PORT, connectViaProxy, detectProxy } from "./edge-relay.js";

/** cloudflared 走 http2 时用的 SNI；边缘证书也是签给它的 */
export const EDGE_SNI = "h2.cftunnel.com";
/** 常见代理软件默认的本机端口（mixed / http / socks） */
const LOCAL_PROXY_PORTS = [7897, 7890, 7891, 10809, 10808, 2080, 1080, 20171, 20170, 8889];
const SOFTWARE = [
  [/^(clash-verge|clash verge|verge-mihomo)/i, "Clash Verge"],
  [/^mihomo-party|^mihomo party/i, "Mihomo Party"],
  [/^(mihomo|clash-meta|clash)(\.exe)?$/i, "Clash"],
  [/^clash for windows/i, "Clash for Windows"],
  [/^v2rayn/i, "v2rayN"],
  [/^(xray|v2ray)(\.exe)?$/i, "v2ray/xray"],
  [/^sing-box/i, "sing-box"],
  [/^nekoray|^nekobox/i, "NekoRay"],
  [/^hiddify/i, "Hiddify"],
  [/^flclash/i, "FlClash"],
  [/^shadowsocks/i, "Shadowsocks"],
  // macOS
  [/^clashx/i, "ClashX"],
  [/^surge/i, "Surge"],
  [/^stash/i, "Stash"],
  [/^quantumult/i, "Quantumult X"],
  [/^shadowrocket/i, "Shadowrocket"],
  [/^v2rayu/i, "V2rayU"],
  [/^loon/i, "Loon"],
];
/** 代理软件的虚拟网卡名 */
const TUN_NAME_RE = /mihomo|clash|meta|wintun|sing-?box|v2ray|nekoray|hiddify|flclash/i;
/** 虚拟机 / 容器 / 组网软件的网卡：绕开 TUN 时排到最后试 */
const VIRTUAL_RE = /vEthernet|VMware|VirtualBox|vboxnet|Hyper-V|WSL|docker|^br-|^veth|ZeroTier|Tailscale|^utun|^awdl|^llw|^bridge|Npcap|Loopback|isatap|Teredo/i;

export function isFakeIp(ip) {
  const m = /^(\d+)\.(\d+)\./.exec(String(ip || ""));
  return Boolean(m && Number(m[1]) === 198 && (Number(m[2]) === 18 || Number(m[2]) === 19));
}

export async function resolveEdge(host = EDGE_HOSTS[0]) {
  try {
    const list = await dns.promises.lookup(host, { all: true, family: 4 });
    const ips = list.map((x) => x.address);
    return { host, ips, fakeIp: ips.some(isFakeIp) };
  } catch (error) {
    return { host, ips: [], fakeIp: false, error: error.code || error.message };
  }
}

export function tunAdapter() {
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const addr of list || []) {
      if (addr.family !== "IPv4" && addr.family !== 4) continue;
      if (isFakeIp(addr.address) || TUN_NAME_RE.test(name)) return { name, address: addr.address };
    }
  }
  return null;
}

/** 真实网卡的 IPv4（排除回环、假 IP、自动分配地址、代理软件的虚拟网卡），虚拟机网卡排后面 */
export function physicalAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const addr of list || []) {
      if ((addr.family !== "IPv4" && addr.family !== 4) || addr.internal) continue;
      if (isFakeIp(addr.address) || addr.address.startsWith("169.254.") || TUN_NAME_RE.test(name)) continue;
      out.push({ name, address: addr.address, virtual: VIRTUAL_RE.test(name) });
    }
  }
  return out.sort((a, b) => Number(a.virtual) - Number(b.virtual));
}

/**
 * 开了 TUN 时，试着从真实网卡直接连隧道服务器（不经代理软件）。
 * 代理节点掐断 7844 端口、而本地网络本身能连 Cloudflare 时，这条路能自动打通，用户什么都不用改。
 * 返回第一个握手成功的网卡；都不行返回 null。
 */
export async function findBypass({ timeoutMs = 5000 } = {}) {
  const candidates = physicalAddresses();
  if (!candidates.length) return null;
  const tries = candidates.map(async (c) => {
    for (const host of [EDGE_IPS[0], EDGE_IPS[10]]) {
      const r = await probeEdgeTls({ host, localAddress: c.address, timeoutMs });
      if (r.ok) return { localAddress: c.address, iface: c.name, ms: r.ms };
    }
    throw new Error("不通");
  });
  try { return await Promise.any(tries); } catch { return null; }
}

function listProcesses() {
  if (process.platform !== "win32") {
    // macOS / Linux：进程名（comm）一行一个
    return new Promise((resolve) => {
      execFile("ps", ["-axo", "comm="], { timeout: 6000, maxBuffer: 4 << 20 }, (error, stdout) => {
        resolve(error ? [] : String(stdout || "").split(/\r?\n/).map((l) => path.basename(l.trim())).filter(Boolean));
      });
    });
  }
  const parse = (out) => String(out || "").split(/\r?\n/).map((l) => l.trim().replace(/^"|"$/g, "").split('","')[0]).filter(Boolean);
  return new Promise((resolve) => {
    execFile("tasklist", ["/fo", "csv", "/nh"], { windowsHide: true, timeout: 6000, maxBuffer: 4 << 20 }, (error, stdout) => {
      if (!error && stdout) return resolve(parse(stdout));
      // tasklist 被禁用时退到 PowerShell
      execFile("powershell", ["-NoProfile", "-Command", "Get-Process | ForEach-Object { $_.ProcessName + '.exe' }"], { windowsHide: true, timeout: 8000, maxBuffer: 4 << 20 }, (e2, out2) => resolve(e2 ? [] : parse(out2)));
    });
  });
}

export async function proxySoftware() {
  const names = await listProcesses();
  const found = new Set();
  for (const n of names) for (const [re, label] of SOFTWARE) if (re.test(n)) found.add(label);
  if (found.has("Clash Verge") || found.has("Mihomo Party")) found.delete("Clash");
  return [...found];
}

/**
 * 和 Cloudflare 隧道服务器真正握一次 TLS。
 * cloudflared 自带 Cloudflare 的根证书，系统里不一定有，所以这里不校验证书链，
 * 而是检查对方给的证书确实是签给 cftunnel.com 的 —— 代理软件的假握手过不了这一关。
 */
export function probeEdgeTls({ host = EDGE_HOSTS[0], port = EDGE_PORT, socket = null, localAddress, timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const conn = tls.connect({ ...(socket ? { socket } : { host, port, ...(localAddress ? { localAddress } : {}) }), servername: EDGE_SNI, ALPNProtocols: ["h2"], rejectUnauthorized: false });
    const done = (ok, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      socket?.destroy?.();
      resolve({ ok, detail, ms: Date.now() - startedAt });
    };
    const timer = setTimeout(() => done(false, "超时（握手没有回应）"), timeoutMs);
    conn.once("secureConnect", () => {
      const cert = conn.getPeerCertificate() || {};
      const names = `${cert.subject?.CN ?? ""} ${cert.subjectaltname ?? ""}`;
      // 电脑时间比证书签发时间还早：cloudflared 自己校验证书时会失败，提前点出来
      if (/cftunnel\.com|argotunnel\.com/i.test(names) && cert.valid_from && Date.now() < Date.parse(cert.valid_from)) done(false, "电脑时间不对（比实际时间早），请把系统时间改成自动同步");
      else if (/cftunnel\.com|argotunnel\.com/i.test(names)) done(true, "握手成功");
      else done(false, `对方不是 Cloudflare 隧道服务器（证书：${(cert.subject?.CN || "无").slice(0, 60)}）`);
    });
    conn.once("error", (error) => done(false, /ECONNRESET|socket hang up|EOF|disconnected/i.test(error.message) ? "握手被中途掐断" : error.code || error.message));
    conn.once("close", () => done(false, "握手被中途掐断"));
  });
}

export async function probeEdgeViaProxy(proxy, { host = EDGE_HOSTS[0], port = EDGE_PORT, timeoutMs = 8000 } = {}) {
  try {
    const socket = await connectViaProxy(proxy, host, port, timeoutMs);
    return probeEdgeTls({ socket, timeoutMs });
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

function probePort(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** 没开系统代理（只开 TUN）时，从常见本机端口里找一个能用的代理，供中继使用。 */
export async function findLocalProxy() {
  const open = (await Promise.all(LOCAL_PROXY_PORTS.map(async (p) => ((await probePort(p)) ? p : null)))).filter(Boolean);
  for (const port of open) {
    for (const type of ["http", "socks5"]) {
      const proxy = { type, host: "127.0.0.1", port, url: `${type}://127.0.0.1:${port}`, source: "本机代理端口" };
      try { const s = await connectViaProxy(proxy, EDGE_HOSTS[0], EDGE_PORT, 3000); s.destroy(); return proxy; } catch { /* 换下一个 */ }
    }
  }
  return null;
}

export async function findProxy(env = process.env, explicit) {
  return (await detectProxy(env, explicit)) || (await findLocalProxy());
}

/** 完整诊断。耗时通常 1–8 秒。 */
export async function diagnose({ env = process.env, explicitProxy = null } = {}) {
  const [resolved, software, proxy, direct] = await Promise.all([
    resolveEdge(), proxySoftware().catch(() => []), findProxy(env, explicitProxy).catch(() => null), probeEdgeTls(),
  ]);
  const tun = tunAdapter();
  // 直连不通且开着 TUN / 假 IP：试试从真实网卡绕开代理
  const [viaProxy, bypass] = await Promise.all([
    proxy ? probeEdgeViaProxy(proxy) : null,
    !direct.ok && (tun || resolved.fakeIp) ? findBypass() : null,
  ]);
  const result = {
    at: Date.now(),
    fakeIp: resolved.fakeIp, edgeIps: resolved.ips.slice(0, 4), dnsError: resolved.error ?? null,
    tun, software, proxy: proxy ? { type: proxy.type, host: proxy.host, port: proxy.port, source: proxy.source } : null,
    direct, viaProxy, bypass,
    platform: process.platform,
  };
  result.verdict = verdict(result);
  return result;
}

/** 根据诊断结果给出结论和下一步（文字面向普通用户）。 */
export function verdict(d) {
  const app = d.software?.[0] || (d.tun || d.fakeIp ? "代理软件" : null);
  if (d.direct?.ok) return { code: "ok", route: "direct", text: "可以直接连上 Cloudflare" };
  if (/电脑时间/.test(d.direct?.detail ?? "")) return { code: "clock", text: d.direct.detail };
  if (d.bypass) return { code: "bypass", route: "bypass", text: `代理线路挡住了隧道，Bridge 已自动绕开代理、从「${d.bypass.iface}」直连（只影响隧道，不改代理设置）` };
  if (d.viaProxy?.ok) return { code: "relay", route: "relay", text: `直连不通，但通过${d.proxy?.source ?? "代理"}可以连上，已自动改走中继` };
  const usingTun = Boolean(d.tun || d.fakeIp);
  if (app || d.proxy) {
    return {
      code: "proxy-blocked",
      software: app,
      tun: usingTun,
      text: `${app ?? "代理"}${usingTun ? "（TUN / 虚拟网卡模式）" : ""}挡住了隧道：当前线路连不上 Cloudflare 的隧道服务器。`,
      options: [
        "关闭代理（或退出代理软件），Bridge 会自动重连。用 Bridge 不需要开代理。",
        `保留代理：在${app ?? "代理软件"}的规则最前面加直连规则，只让隧道程序不走代理，其他软件不受影响。`,
      ],
      rules: [`PROCESS-NAME,${(d.platform ?? process.platform) === "win32" ? "cloudflared.exe" : "cloudflared"},DIRECT`, "DOMAIN-SUFFIX,argotunnel.com,DIRECT", "DOMAIN-SUFFIX,cftunnel.com,DIRECT", "IP-CIDR,198.41.192.0/24,DIRECT,no-resolve", "IP-CIDR,198.41.200.0/24,DIRECT,no-resolve"],
      fakeIpFilter: usingTun && d.fakeIp ? ["+.argotunnel.com", "+.cftunnel.com"] : [],
    };
  }
  if (d.dnsError) return { code: "dns", text: `解析不了 Cloudflare 的隧道地址（${d.dnsError}），请检查网络是否正常` };
  return { code: "network-blocked", text: "当前网络连不上 Cloudflare 的隧道服务器（7844 端口可能被网络屏蔽），可以换个网络（比如手机热点）再试" };
}

/** 网络环境指纹：变了就值得马上重试（用户关了代理 / 加了规则 / 换了网络） */
export async function quickFingerprint() {
  const [r, direct] = await Promise.all([resolveEdge(), probeEdgeTls({ timeoutMs: 5000 })]);
  const tun = tunAdapter();
  return { key: `${r.fakeIp ? "fake" : "real"}|${tun ? tun.name : "-"}`, direct: direct.ok, fakeIp: r.fakeIp, tun };
}
