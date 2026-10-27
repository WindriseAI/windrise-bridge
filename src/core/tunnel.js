/**
 * 隧道管理 —— 参照学习软件的「三种连接设置」，依据见 docs/how-it-works.md。
 *
 * 三种模式的真实差别：
 *   1. cloudflare（快速隧道）：跑 cloudflared tunnel --url http://127.0.0.1:<port>，
 *      从输出里抓 https://xxx.trycloudflare.com。零配置、临时地址、重启就变。
 *   2. cloudflare-named（命名隧道）：自带 cloudflared 令牌 + 固定域名，
 *      地址长期不变，代价是要有 Cloudflare 账号与域名，且在控制台把域名指到隧道。
 *   3. ngrok：ngrok http <port> --domain=...，同样是固定域名，需要自己的 ngrok 账号。
 *
 * 学习软件的额外工程细节，这里也照搬：
 *   - 快速隧道**必须**用自己写的 cloudflared 配置文件（不继承 ~/.cloudflared/config.yml），
 *     否则用户给别的服务配的 ingress 会把 Bridge 地址劫持成 404。
 *   - 隧道是子进程，退出时要确保被回收，避免孤儿进程占着端口。
 *   - 固定地址的隧道在多个窗口之间要互斥（这里用锁文件实现租约）。
 */

import { createHash as sealSha, createPublicKey as sealPub, randomUUID, verify as sealVerify } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EdgeRelay } from "./edge-relay.js";
import { diagnose, findBypass, findProxy, isFakeIp, probeEdgeTls, probeEdgeViaProxy, quickFingerprint, resolveEdge } from "./net-diagnose.js";

/** 每种连接方式最多等多久注册上（只认 cloudflared 的「Registered tunnel connection」，不信端口探测） */
const GATE_MS = 45_000;
/** 进程意外退出后的重连间隔 */
const RESTART_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
/** 所有方式都失败后，多久复查一次网络（用户关了代理 / 加了规则就自动恢复） */
const RECHECK_MS = 30_000;
/** 睡眠唤醒可能在几秒内收到好几次系统事件，只重建一次线路 */
const WAKE_DEBOUNCE_MS = 5_000;
/** 电脑时间不准：cloudflared 校验证书失败，换方式也没用 */
const CLOCK_RE = /certificate has expired or is not yet valid|x509: certificate.*(expired|not yet valid)/i;
/** 这些错误重试也没用，直接停下报错 */
const FATAL_RE = /credentials file|Unauthorized|Invalid tunnel secret|tunnel not found|Cannot determine default origin certificate|failed to unmarshal|unknown tunnel|You did not specify any valid additional argument/i;
const ROUTE_LABEL = { direct: "直连", bypass: "绕开代理直连", "direct-tcp": "直连（只走 TCP）", relay: "经代理中继", ngrok: "ngrok" };

/** 代理软件 / VPN 的虚拟网卡名（和 net-diagnose 的 TUN_NAME_RE 同思路，这里只用于「有没有 TUN」这一个信号） */
const TUN_IFACE_RE = /mihomo|clash|meta|wintun|sing-?box|v2ray|nekoray|hiddify|flclash|wireguard|(?:^|[^a-z])tun\d*(?:[^a-z]|$)/i;
/** 算物理网卡指纹时要排除的虚拟网卡：虚拟机 / 容器 / 组网 / 回环 */
const VIRTUAL_IFACE_RE = /vEthernet|WSL|Hyper-V|docker|^br-|^veth|VMware|VirtualBox|vboxnet|ZeroTier|Tailscale|^utun|^awdl|^llw|^bridge|Npcap|Loopback|isatap|Teredo/i;

/**
 * 写日志用的地址打码：内网 / 保留网段照写，其余只留前两段。
 * 网卡变化日志会被存下来，别把用户的公网 IP 历史写进去。
 */
export function maskAddress(address) {
  const text = String(address ?? "");
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return text;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const privateNet = a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 198 && (b === 18 || b === 19));
  return privateNet ? text : `${m[1]}.${m[2]}.*.*`;
}

const QUICK_TUNNEL_CONFIG = `# 由 bridge-replica 写入：快速隧道专用，故意不读用户的 ~/.cloudflared/config.yml\nno-autoupdate: true\n`;

export function quickTunnelArgs({ localPort, configFile, protocol = "auto", edge }) {
  // 走中继时 edgeArgs 自带 --protocol http2，这里就不再给 auto，免得两个 --protocol 打架
  const proto = edge ? [] : ["--protocol", protocol];
  return ["tunnel", "--config", configFile, "--no-autoupdate", ...proto, ...edgeArgs(edge), "--url", `http://127.0.0.1:${localPort}`];
}

export function namedTunnelArgs({ configFile, edge }) {
  return ["tunnel", "--config", configFile, "--no-autoupdate", ...edgeArgs(edge), "run"];
}

/** 走边缘中继时：cloudflared 连本地中继，且只能用 http2（TCP），QUIC 没法经 HTTP 代理 */
function edgeArgs(edge) {
  // --edge 要给两次：cloudflared 按顺序把静态地址分给两个区域，只给一次就只有一个区域有地址，连接数填不满
  return edge ? ["--protocol", "http2", "--edge", edge, "--edge", edge] : [];
}

/** 从 cloudflared 的输出里捞公网地址。 */
export function extractPublicUrl(text) {
  const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text);
  return match ? match[0] : null;
}

export function extractNgrokUrl(text) {
  const match = /https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.app/i.exec(text);
  return match ? match[0] : null;
}


/* ------------------------------------------------------------------ *
 * ⑤ 起隧道进程前的激活检查（独立实现：自己的公钥写法、自己算设备 ID；
 *    老版本这里还核对程序文件清单签名，开源版已拆掉封印，只保留许可证核对）
 * ------------------------------------------------------------------ */
const SEAL_PEM = ["-----BEGIN PUBLIC KEY-----", "MCowBQYDK2VwAyEA/QDy5PBkvfYZaI1AW+5rel4DRqET9G5x4HLhkStj+lg=", "-----END PUBLIC KEY-----", ""].join("\n");
function sealMachine() {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
        resolve(error ? null : (String(stdout).match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/) || [])[1] || null);
      });
    } else if (process.platform === "darwin") {
      execFile("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeout: 5000 }, (error, stdout) => {
        resolve(error ? null : (String(stdout).match(/"IOPlatformUUID"\s*=\s*"([0-9a-fA-F-]{36})"/) || [])[1] || null);
      });
    } else {
      readFile("/etc/machine-id", "utf8").then((t) => resolve(t.trim() || null), () => resolve(null));
    }
  });
}
/**
 * 隧道启动前的激活检查：许可证签名、设备绑定、到期时间。没激活返回中文原因，通过返回 null。
 * 隧道进程自己不带这道门（standalone --tunnel / 自测可以裸起），由 Electron 主进程用 seal 选项打开。
 * keyPem 是自检用的注入口：不传就用内置的正式公钥。
 */
export async function tunnelSeal(dataHome, { keyPem = SEAL_PEM } = {}) {
  const key = sealPub(keyPem);
  let saved;
  try { saved = JSON.parse(await readFile(path.join(dataHome, "activation.json"), "utf8")); } catch { return "还没有激活"; }
  const pieces = String(saved.token || "").split(".");
  if (pieces.length !== 3) return "还没有激活";
  let body;
  try {
    if (!sealVerify(null, Buffer.from(pieces[0] + "." + pieces[1]), key, Buffer.from(pieces[2], "base64url"))) return "激活信息无效";
    body = JSON.parse(Buffer.from(pieces[1], "base64url").toString("utf8"));
  } catch { return "激活信息无效"; }
  const guid = (await sealMachine())?.toLowerCase() || saved.fallbackId;
  const me = guid ? sealSha("sha256").update("bridge-replica:" + guid).digest("hex").slice(0, 32) : "";
  if (body.installation_id !== me) return "激活信息不是这台电脑的";
  const nowSec = Math.max(Date.now(), Number(saved.seen) || 0) / 1000;
  if (!(body.exp > nowSec) || (body.entitlement_exp && !(body.entitlement_exp > nowSec))) return "激活已到期";
  return null;
}


export class TunnelManager {
  /**
   * @param {object}  options
   * @param {string}  options.localUrl   本地桥地址（决定转发目标端口）
   * @param {string} [options.dataHome]  数据目录
   * @param {Function} [options.onLog]   日志回调
   * @param {string} [options.provider]  隧道服务商
   * @param {object} [options.env]       配置来源。默认 process.env。
   *   界面填的命名隧道参数是通过这里传进来的 —— 之前直接读 process.env，
   *   结果界面上的设置被静默忽略，隧道静默退化成快速隧道（公网地址每次变）。
   * @param {Function} [options.networkInterfaces] 取网卡的函数。默认 os.networkInterfaces，自检里可注入。
   * @param {number} [options.lostTimeoutMs] 边缘连接全掉后等多久重连。默认 60 秒。
   * 下面几个参数只为自检能把等待 / 探测缩短或替换掉，默认值都和线上一致。
   * @param {number} [options.recheckMs] blocked 后多久复查一次网络。默认 30 秒。
   * @param {number} [options.nextDelayMs] 还没连上就退出后多久换下一种方式。默认 2 秒。
   * @param {number} [options.planDelayMs] 排线路时的额外延迟（模拟探测很慢）。默认 0。
   * @param {Function} [options.diagnoseFn] 完整诊断函数。默认 net-diagnose 的 diagnose。
   * @param {Function} [options.fingerprintFn] 网络指纹函数。默认 net-diagnose 的 quickFingerprint。
   * @param {number} [options.readyPollMs] 多久查一次 cloudflared 的 /ready。默认 10 秒。
   * @param {number} [options.readyMissLimit] /ready 连续几次报 0 条才重建线路。默认 2 次（躲开一次抖动）。
   * @param {Function} [options.readyFetchFn] 查 /ready 的函数。默认 fetch + 3 秒超时（只连本机 metrics 端口，不走代理）。
   * @param {boolean} [options.seal] 起隧道进程前先过 tunnelSeal 激活检查（Electron 主进程开；standalone / 自测不开）。
   */
  constructor({ localUrl, dataHome = (process.env.BRIDGE_DATA_HOME?.trim() || path.join(os.homedir(), ".bridge-replica")), onLog = () => {}, provider = "cloudflare", env, binPaths, onRoute = () => {}, onBlocked = () => {}, onRecovered = () => {}, networkInterfaces = () => os.networkInterfaces(), lostTimeoutMs = 60_000, ifacePollMs = 10_000, ifaceDebounceMs = 3_000, ifaceCooldownMs = 60_000, preferredRetryMs = 20_000, recheckMs = RECHECK_MS, nextDelayMs = 2000, planDelayMs = 0, diagnoseFn = diagnose, fingerprintFn = quickFingerprint, findBypassFn = findBypass, tunAdapterFn = null, resolveEdgeFn = resolveEdge, readyPollMs = 10_000, readyMissLimit = 2, readyFetchFn = null, seal = false } = {}) {
    if (!localUrl) throw new Error("TunnelManager 需要 localUrl");
    this.localUrl = localUrl;
    this.dataHome = dataHome;
    this.onLog = onLog;
    this.provider = provider;
    this.env = env ?? process.env;
    /** 起隧道进程前先过 tunnelSeal 激活检查（Electron 主进程开；standalone / 自测不开） */
    this.seal = seal === true;
    /** 客户端可执行文件的路径。没给就用 PATH 里的名字。 */
    this.binPaths = binPaths ?? {};
    this.child = null;
    this.publicUrl = null;
    /** 真正打通（cloudflared 报 Registered tunnel connection / ngrok 拿到地址）才算 true */
    this.connected = false;
    this.startedAt = null;
    this.lastError = null;
    this.config = {
      // 命名隧道：二选一（仪表板令牌 / 本地凭据）
      namedToken: this.env.BRIDGE_NAMED_TUNNEL_TOKEN ?? null,
      namedTunnelId: this.env.BRIDGE_NAMED_TUNNEL_ID ?? null,
      namedCredentials: this.env.BRIDGE_NAMED_CREDENTIALS ?? null,
      namedHostname: this.env.BRIDGE_NAMED_HOSTNAME ?? null,
      ngrokDomain: this.env.BRIDGE_NGROK_DOMAIN ?? null,
      /** ngrok 的 authtoken。ngrok v3 不给令牌基本用不了，所以这个是必填。 */
      ngrokAuthtoken: this.env.BRIDGE_NGROK_AUTHTOKEN ?? null,
      edgeRoute: this.env.BRIDGE_EDGE_ROUTE || "auto", // auto | direct | proxy
      /** 中继用的代理；不填就按 HTTPS_PROXY / ALL_PROXY / 系统代理 自动找（只读，不改任何代理设置） */
      edgeProxy: this.env.BRIDGE_EDGE_PROXY || null,
    };
    /** 上次成功的方式（direct / direct-tcp / relay），下次优先用 */
    this.config.preferredRoute = this.env.BRIDGE_EDGE_PREFERRED || null;
    this.relay = null;
    /** 本次实际走的方式：direct / direct-tcp / relay / ngrok */
    this.route = null;
    this.onRoute = onRoute;
    this.onBlocked = onBlocked;
    this.onRecovered = onRecovered;
    /* 自动纠错用的状态 */
    this.plan = [];
    this.attemptIndex = 0;
    this.restarts = 0;
    this.stopping = false;
    /*
     * 代次：每次 stop / 重连都换一代。
     * start、换方式、复查这些操作里有好几处 await（杀旧进程、排线路、拉起进程），
     * 光看 this.child 管不住它们 —— 停掉之后它们醒来照样会再拉一个进程。
     * 所以每个入口记下自己那一代，await 回来发现代次变了就立刻收手。
     */
    this.gen = 0;
    this.blocked = null;
    this.proxy = null;
    this.timers = { gate: null, restart: null, recheck: null, lost: null, next: null, preferred: null, ready: null };
    this.liveConnections = new Set();
    /**
     * 日志说边缘连接全掉了、/ready 却说还有：这次否决要记住，否则下一块重复的掉线日志
     * 又会把 lost 定时器装回来（任何一行无关日志都会触发）。注册 / 掉线日志或 /ready 报 0 时清掉。
     */
    this.logLostVetoed = false;
    /** cloudflared 自己开的 metrics 地址（从日志里的 Starting metrics server 行取），用来查 /ready */
    this.metricsAddress = null;
    /** 最近一次 /ready 的结果：{ connections: 数字或 null, at, ok, error? } */
    this.ready = null;
    /** /ready 连续报 0 条的次数：连续几次才重建线路，防一次抖动就断 */
    this.readyMisses = 0;
    this.readyPollMs = readyPollMs;
    this.readyMissLimit = readyMissLimit;
    /** null 时用全局 fetch；自检里换成假的，避免真的连本机端口 */
    this.readyFetchFn = readyFetchFn;
    /** 每个流还没等到换行的尾巴：一行可能被拆进两个 chunk，凑齐一整行再解析 */
    this.streamTails = { stdout: "", stderr: "" };
    /** 正在跑的重连（并发调用共用同一个 Promise，避免同时杀两次进程） */
    this.reconnecting = null;
    /** 正在跑的启动（stop 要等它收手，reconnect 看到它就别再抢着拉起） */
    this.starting = null;
    /**
     * 正在换线路（#next 杀掉旧进程到新进程挂上之间）。
     * 这段时间 child 是空的、reconnecting 也是 false，界面光看那几个标志会闪「仅本机」。
     */
    this.switching = false;
    this.recheckMs = recheckMs;
    this.nextDelayMs = nextDelayMs;
    this.planDelayMs = planDelayMs;
    this.preferredRetryMs = preferredRetryMs;
    this.diagnoseFn = diagnoseFn;
    this.fingerprintFn = fingerprintFn;
    this.findBypassFn = findBypassFn;
    this.resolveEdgeFn = resolveEdgeFn;
    /** 这次计划里缺了上次成功的偏好线路（比如网卡还没回来，bypass 没排进去） */
    this.planMissingPreferred = false;
    /**
     * 这次计划本来能排 bypass，却因为「有 TUN / 假 IP 但找不到能用网卡」去掉了。
     * 只有这种「临时缺网卡」才值得过一会儿补试；没开 TUN、或者模式直接排除了 bypass 时
     * 补试永远不会成功，排了就是每 20 秒把好好的隧道拆一次。
     */
    this.bypassSkippedForNic = false;
    /**
     * 已经因为「诊断有路、计划没排」自救过，防止诊断 / 重连死循环。
     * 不能按代次记：自救本身的重连就会换后代次，按代次记等于每轮都能再自救。
     * 只在真正连上（#markConnected）或重新 start（#doStart）时清零。
     */
    this.selfHealPending = false;
    /* 网卡地址监视：单独放，不进 timers —— 重连会清 timers，但监视要一直跑到 stop() */
    this.networkInterfaces = networkInterfaces;
    this.lostTimeoutMs = lostTimeoutMs;
    this.ifacePollMs = ifacePollMs;
    this.ifaceDebounceMs = ifaceDebounceMs;
    /** 网卡触发的重连冷却：60 秒内最多重建一次线路，期间的变化等冷却结束再比 */
    this.ifaceCooldownMs = ifaceCooldownMs;
    this.tunAdapterFn = tunAdapterFn;
    this.ifaceTimer = null;
    this.ifacePending = null;
    this.ifaceBaseline = new Map();
    /** 和基线一起记的「有没有 TUN」；TUN 出现 / 消失对 direct / relay 有影响 */
    this.ifaceBaselineTun = "-";
    /** bypass 地址连续缺了几次（连续两次才重建，防一闪） */
    this.bypassMissingPolls = 0;
    this.ifaceCooldownUntil = 0;
    this.ifaceCooldownDirty = false;
    this.ifaceCooldownTimer = null;
    this.lastWakeAt = 0;
  }

  /**
   * 客户端可执行文件。优先用调用方指定的路径 ——
   * 那是「程序自己装的那个」（~/.bridge-replica/bin/），
   * 没有才退回 PATH 里的名字。
   */
  #bin(name) {
    return this.binPaths[name] ?? name;
  }

  get localPort() {
    const url = new URL(this.localUrl);
    return Number(url.port);
  }

  /**
   * 给子进程用的环境变量：始终以 process.env 打底，再盖上调用方传的。
   * 不能直接用 this.env —— 万一调用方只传了 BRIDGE_NAMED_* 几个变量，
   * 子进程就丢了 PATH，cloudflared 会找不到。
   */
  childEnv() {
    return { ...process.env, ...this.env };
  }

  status() {
    const alive = Boolean(this.child && this.child.exitCode === null);
    return {
      provider: this.provider,
      state: alive ? "running" : "stopped",
      /** connecting：进程在跑但还没打通；connected：外部已经能连进来 */
      phase: this.reconnecting ? "connecting"
        : this.blocked ? "blocked"
        : !alive ? (this.timers.restart || this.timers.next || this.switching ? "connecting" : "stopped")
        : this.connected && this.publicUrl ? "connected"
        : this.attemptIndex > 0 || this.restarts > 0 ? "optimizing" : "connecting",
      connected: alive && this.connected && Boolean(this.publicUrl),
      publicUrl: this.publicUrl,
      startedAt: this.startedAt,
      lastError: this.lastError,
      /** cloudflared /ready 报的边缘连接数；进程没在跑 / 查询失败 / 还没查过时为 null */
      readyConnections: alive && this.ready?.ok ? this.ready.connections : null,
      readyAt: alive ? this.ready?.at ?? null : null,
      route: this.route,
      routeLabel: ROUTE_LABEL[this.route] ?? null,
      attempt: this.plan.length ? { index: this.attemptIndex + 1, total: this.plan.length, plan: this.plan } : null,
      restarting: Boolean(this.timers.restart || this.timers.next || this.switching),
      /** 正在重建线路（electron/main.cjs 用它显示「正在重新连接…」） */
      reconnecting: Boolean(this.reconnecting),
      blocked: this.blocked ? { at: this.blocked.at, verdict: this.blocked.diagnosis?.verdict ?? null } : null,
      client: this.clientInfo(),
    };
  }

  /**
   * 是否在用命名隧道。
   *
   * 不能只看 provider 字符串 —— 应用传的是 "cloudflare"，
   * 光看它会把命名隧道误判成快速隧道（界面显示、状态上报全错）。
   * 所以判据和 spawnCloudflared 保持一致：配了域名 + 凭据就是命名隧道。
   */
  get isNamed() {
    if (this.provider === "cloudflare-named") return true;
    return Boolean(this.config.namedHostname && (this.config.namedToken || this.config.namedTunnelId));
  }

  clientInfo() {
    if (this.provider === "ngrok") return { name: "ngrok", args: this.config.ngrokDomain ? `--domain=${this.config.ngrokDomain}` : "(默认)" };
    if (this.isNamed) {
      return {
        name: "cloudflared",
        mode: "named",
        // 两种命名隧道要分清楚：令牌模式在后台配路由，凭据模式在本地配
        management: this.config.namedToken && !this.config.namedTunnelId ? "仪表板管理（令牌）" : "本地管理（凭据文件）",
        tunnelId: this.config.namedTunnelId ?? null,
        hostname: this.config.namedHostname ?? "(未配置)",
      };
    }
    return { name: "cloudflared", mode: "quick", edgeRoute: this.config.edgeRoute, route: this.route };
  }

  /** 只做「是否装了」的检查，对应界面上那个「安装客户端」按钮的判定。 */
  async probeClient() {
    const name = this.provider === "ngrok" ? "ngrok" : "cloudflared";
    // 用 #bin：程序自己装的那个也算数（用户没配 PATH 也能用）
    const bin = this.#bin(name);
    return new Promise(resolve => {
      const child = spawn(bin, ["--version"], { windowsHide: true });
      let out = "";
      child.stdout.on("data", chunk => out += chunk.toString());
      child.stderr.on("data", chunk => out += chunk.toString());
      child.on("error", error => resolve({ installed: false, binary: bin, name, error: error.message }));
      child.on("close", () => resolve({ installed: true, binary: bin, name, version: out.trim().split("\n")[0] || "unknown" }));
    });
  }

  /**
   * 启动隧道（带自动纠错）。
   *
   * 不信端口探测，只信结果：每种方式最多等 GATE_MS，cloudflared 打出「Registered tunnel connection」才算通；
   * 没通就自动换下一种（直连 → 只走 TCP → 经代理中继），成功的方式记下来下次优先用。
   * 全都不行才进入 blocked：附上诊断结论，之后每 RECHECK_MS 复查一次网络，环境一变（关了代理 / 加了规则）就自动重连。
   */
  start(provider = this.provider) {
    // 把整次启动的 Promise 留给 stop()：stop 要等它真的收手，不能只是把 gen 一加就返回
    const run = this.#doStart(provider);
    this.starting = run;
    const clear = () => { if (this.starting === run) this.starting = null; };
    run.then(clear, clear);
    return run;
  }

  async #doStart(provider) {
    if (this.child && this.child.exitCode === null) return this.status();
    const gen = this.gen;
    this.provider = provider;
    this.stopping = false;
    this.lastError = null;
    this.connected = false;
    this.blocked = null;
    this.lastFatal = null;
    this.lastErrLine = null;
    this.restarts = 0;
    // 重新启动算一次全新的尝试：之前的自救防循环标记不再适用
    this.selfHealPending = false;
    this.#clearTimers();
    // ⑤ 起隧道进程前的激活检查：没激活 / 到期直接抛错，界面据 code 引导去「激活」页
    if (this.seal) {
      const sealed = await tunnelSeal(this.dataHome);
      if (sealed) throw Object.assign(new Error(`${sealed}。请到「激活」页处理`), { code: "NOT_ACTIVATED" });
    }
    await this.#killStale();
    if (this.stopping || gen !== this.gen) return this.status();
    await this.#buildPlan(gen);
    if (this.stopping || gen !== this.gen) return this.status();
    this.attemptIndex = 0;
    const spawned = await this.#launch(gen);
    if (this.stopping || gen !== this.gen) return this.status();
    this.startedAt = Date.now();
    this.#startIfaceWatch(gen);
    return { ...this.status(), args: spawned?.args };
  }

  /**
   * 「重建线路再重连」的统一入口。
   *
   * 为什么不能只重启子进程：网卡闪断 / 睡眠唤醒后，原来绑定的网卡地址可能已经不在了，
   * 沿用旧线路只会一直失败。这里先杀掉进程和中继，清掉所有待触发的定时器，
   * 丢掉旧的 bypass 绑定，重新选一次线路再拉起。
   *
   * 同一时间只允许一个重连在跑：重复调用直接拿到同一个 Promise。
   * 故意不用 async —— async 会把返回的 Promise 再包一层，两次调用就不是同一个对象了。
   */
  reconnect(reason) {
    if (this.stopping) return Promise.resolve(this.status());
    // 启动还没走完：直接等它（它也记着代次，stop 了就会自己收手），别再叠一次拉起
    if (this.starting) return this.starting;
    if (this.reconnecting) return this.reconnecting;
    this.reconnecting = this.#doReconnect(reason).finally(() => { this.reconnecting = null; });
    return this.reconnecting;
  }

  async #doReconnect(reason) {
    // 重连本身要作废旧的在途操作：它们醒来后看到代次变了就会放弃
    this.gen++;
    const gen = this.gen;
    this.onLog(`隧道重连：${reason}`);
    this.hadTrouble = true;
    this.connected = false;
    // 先清定时器：等着被杀的这几秒里，gate / restart / lost / next 不能自己又拉起一个进程
    this.#clearTimers();
    this.blocked = null;
    try {
      await this.#killChild();
      if (this.stopping || gen !== this.gen) return this.status();
      /*
       * 重连前重新拍一份网卡基线：醒来 / 掉线时网卡往往还没好，旧基线是睡前的。
       * 不刷新的话，网卡以后来的原地址回来和旧基线完全一样，监视永远发现不了。
       */
      this.#refreshIfaceBaseline();
      // 网卡地址可能变了，旧的绑定不能再用，必须重新选线路
      this.bypass = null;
      await this.#buildPlan(gen);
      if (this.stopping || gen !== this.gen) return this.status();
      this.attemptIndex = 0;
      await this.#launch(gen);
      return this.status();
    } catch (error) {
      this.lastError = error.message;
      this.onLog(`隧道重连失败：${error.message}`);
      return this.status();
    }
  }

  /**
   * 电脑从睡眠中醒来时由上层调用：醒来后网卡 / 代理往往要缓几秒才恢复，
   * 但旧连接已经半死，直接重建一次最快。5 秒内的重复事件只算一次。
   */
  noteWake() {
    const now = Date.now();
    if (now - this.lastWakeAt < WAKE_DEBOUNCE_MS) return this.reconnecting ?? Promise.resolve(this.status());
    this.lastWakeAt = now;
    this.onLog("电脑刚从睡眠中醒来，检查隧道线路");
    return this.reconnect("电脑刚从睡眠中醒来");
  }

  get #named() {
    return this.provider === "cloudflare-named" || Boolean(this.config.namedHostname && (this.config.namedToken || this.config.namedTunnelId));
  }

  /** 排出这次要依次尝试的方式。 */
  async #buildPlan(gen = this.gen) {
    // 自检里模拟「探测很慢」，好让 stop / 重连恰好落在排线路的 await 里；线上默认 0
    if (this.planDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.planDelayMs));
    if (this.#staleGen(gen)) return;
    if (this.provider === "ngrok") {
      this.plan = ["ngrok"];
      this.planMissingPreferred = false;
      this.bypassSkippedForNic = false;
      clearTimeout(this.timers.preferred); this.timers.preferred = null;
      return;
    }
    const mode = this.config.edgeRoute;
    let plan = this.#named ? ["direct", "bypass", "relay"] : ["direct", "bypass", "direct-tcp", "relay"];
    if (mode === "direct") plan = plan.filter((r) => r !== "relay");
    if (mode === "proxy") plan = ["relay"];

    // 开着 TUN / 假 IP 时才需要「绕开代理直连」：先找一块能直连隧道服务器的真实网卡，找不到就不排这一项
    this.bypass = null;
    this.bypassSkippedForNic = false;
    if (plan.includes("bypass")) {
      // 先看本机有没有 TUN 网卡（不花时间）；没有才去解析边缘域名看是不是假 IP —— 这次 DNS 查询没有超时，能省就省
      let tunnelled = this.#tunAdapter();
      if (!tunnelled) {
        const resolved = await this.resolveEdgeFn().catch(() => ({}));
        if (this.#staleGen(gen)) return;
        tunnelled = resolved.fakeIp;
      }
      if (tunnelled) {
        this.bypass = await this.findBypassFn().catch(() => null);
        if (this.#staleGen(gen)) return;
      }
      if (!this.bypass) {
        plan = plan.filter((r) => r !== "bypass");
        // 有 TUN / 假 IP 却没找到网卡：这只是「暂时没网卡」，过一会儿可以补试
        this.bypassSkippedForNic = Boolean(tunnelled);
      }
    }

    // 有没有能用的代理（中继要用）：设置 → 环境变量 → 系统代理 → 常见本机端口
    if (plan.includes("relay")) {
      this.proxy = await findProxy(this.childEnv(), this.config.edgeProxy).catch(() => null);
      if (this.#staleGen(gen)) return;
      if (!this.proxy) {
        plan = plan.filter((r) => r !== "relay");
        if (mode === "proxy") { this.onLog("边缘路线设为「代理」，但没找到可用代理，改为直连"); plan = ["direct"]; }
      }
    }

    const preferred = this.config.preferredRoute;
    if (preferred && plan.includes(preferred)) {
      plan = [preferred, ...plan.filter((r) => r !== preferred)];
      this.onLog(`优先使用上次成功的方式：${ROUTE_LABEL[preferred]}`);
    } else if (mode === "auto" && (this.bypass || (this.proxy && plan.includes("relay")))) {
      // 先花几秒真实握手一次：直连明显不通，就直接从能通的方式开始，省掉 45 秒白等
      const direct = await probeEdgeTls({ timeoutMs: 5000 });
      if (this.#staleGen(gen)) return;
      if (!direct.ok) {
        if (this.bypass) {
          this.onLog(`预检：直连 ${direct.detail}；从「${this.bypass.iface}」绕开代理握手成功`);
          plan = ["bypass", ...plan.filter((r) => r !== "bypass")];
        } else {
          const via = await probeEdgeViaProxy(this.proxy, { timeoutMs: 6000 });
          if (this.#staleGen(gen)) return;
          this.onLog(`预检：直连 ${direct.detail}；经${this.proxy.source} ${this.proxy.host}:${this.proxy.port} ${via.ok ? "握手成功" : via.detail}`);
          if (via.ok) plan = ["relay", ...plan.filter((r) => r !== "relay")];
        }
      }
    }
    this.plan = plan.length ? plan : ["direct"];
    /*
     * 偏好线路这次没排进来，只在「本来该有 bypass、只是暂时找不到网卡」时才算临时缺失。
     * 模式排除（proxy 只排 relay）、没开 TUN、没代理这些情况下 bypass 缺席是正常结果，
     * 补试永远不会成功；再当成缺失去补试，就会每 20 秒把好好的隧道拆了重连。
     *
     * 临时缺失时先不改写偏好线路 —— 否则下次启动会优先用一条其实只是「这次暂时走通」的
     * 线路；下一次正常建计划时会重新算。
     */
    this.planMissingPreferred = preferred === "bypass" && this.bypassSkippedForNic;
    if (this.planMissingPreferred) this.#schedulePreferredRetry();
    else { clearTimeout(this.timers.preferred); this.timers.preferred = null; }
  }

  /**
   * 偏好线路是 bypass、但这次计划里没有它：过一会儿再找一次网卡。
   * 只补试一次（20 秒后），找到就重建线路换回去；stop / 新代次会自动作废。
   */
  #schedulePreferredRetry() {
    clearTimeout(this.timers.preferred);
    const gen = this.gen;
    this.timers.preferred = setTimeout(async () => {
      this.timers.preferred = null;
      if (this.stopping || gen !== this.gen) return;
      if (this.plan.includes("bypass")) return; // 这期间已经换回去了
      /*
       * 补试前再确认一次真的还有 TUN / 假 IP：这段时间里用户可能关了代理软件。
       * 没有 TUN 时 bypass 本来就不该存在，findBypass 却只要物理网卡能握手就成功，
       * 再拿它去重连就会陷入「每 20 秒拆一次隧道」的死循环。
       */
      const tunnelled = this.#tunAdapter() || (await this.resolveEdgeFn().catch(() => ({}))).fakeIp;
      if (!tunnelled || this.stopping || gen !== this.gen) return;
      let bind;
      try { bind = await this.findBypassFn(); } catch { bind = null; }
      if (this.stopping || gen !== this.gen || !bind) return;
      this.onLog("网卡恢复了，换回上次成功的线路");
      this.reconnect("网卡恢复了，换回上次成功的线路").catch(() => {});
    }, this.preferredRetryMs);
    this.timers.preferred.unref?.();
  }

  async #launch(gen = this.gen) {
    if (this.stopping || gen !== this.gen) return null;
    const route = this.plan[this.attemptIndex] ?? "direct";
    this.route = route;
    this.connected = false;
    this.liveConnections.clear();
    // 换进程就是换了一套连接：上一轮「/ready 否决过日志掉线」的结论不能带过去
    this.logLostVetoed = false;
    // 换进程就是换了一个 metrics 端口：上一轮的地址 / 查询结果 / 连续 0 计数都不能留到新进程
    this.metricsAddress = null;
    this.ready = null;
    this.readyMisses = 0;
    /*
     * 旧进程排下的 /ready 轮询也要清掉：它可能正好落在新进程「已打出 metrics、还没 Registered」
     * 的窗口里，把「还没连上」的 503 当成边缘掉了记进 readyMisses（#pollReady 里也有兜底判断）。
     */
    clearTimeout(this.timers.ready);
    this.timers.ready = null;
    // 换进程就是换了一套输出：上一轮的半截行不能拼到新进程的第一行上
    this.streamTails = { stdout: "", stderr: "" };
    this.edgeHinted = false;
    /*
     * 快速隧道 / ngrok 每拉起一次就是新地址，要从这次的输出里重新取；不清掉的话 consume() 只认第一次的地址，
     * 重连、换方式之后界面和公网实测一直用早就作废的旧域名（2026-10-24 实测：重连后公网一直 530）。
     * 命名隧道的地址固定，由 spawnCloudflaredNamed 自己写，这里不动。
     */
    if (!this.#named) this.publicUrl = null;
    if (this.relay) { await this.relay.stop().catch(() => {}); this.relay = null; }
    if (this.stopping || gen !== this.gen) return null;
    const workspaceDir = path.join(this.dataHome, "tunnel");
    await mkdir(workspaceDir, { recursive: true });
    if (this.stopping || gen !== this.gen) return null;

    let spawned;
    try {
      spawned = route === "ngrok" ? this.spawnNgrok(workspaceDir) : await this.spawnCloudflared(workspaceDir, this.provider, route, gen);
    } catch (error) {
      // 配置类错误（缺凭据、缺令牌）：换方式也没用，直接报
      this.lastError = error.message;
      throw error;
    }
    const child = spawned.child;
    /*
     * 拉起进程这段时间里可能已经被 stop / 别的重连接管：刚起的子进程不能留成孤儿，
     * 也不能赋给 this.child（否则 stop 早就返回了，没人再管它）。
     */
    if (this.stopping || gen !== this.gen) {
      try { child.kill(); } catch { /* 已经退了 */ }
      await this.#stopRelayFor(gen);
      return null;
    }
    if (this.plan.length > 1 || this.attemptIndex > 0) this.onLog(`隧道连接方式：${ROUTE_LABEL[route]}（${this.attemptIndex + 1}/${this.plan.length}）`);
    /*
     * 同一时刻只留一个子进程：换方式 / 重连时先把还活着的旧进程收掉再挂新的。
     * 不能用 #killChild —— 它会连 this.relay 一起停，而这时 this.relay 已经是刚为这次启动建的中继，
     * 停了 cloudflared 就连不上。旧进程自己的中继在本次 #launch 开头已经停过了，这里只杀进程；
     * 它的 exit 回调看到 this.child 已经换人，会直接返回，不会误伤新中继。
     */
    if (this.child && this.child !== child && this.child.exitCode === null) {
      const old = this.child;
      this.child = null;
      try { old.kill(); } catch { /* 已经退了 */ }
    }
    if (this.stopping || gen !== this.gen) {
      try { child.kill(); } catch { /* 已经退了 */ }
      await this.#stopRelayFor(gen);
      return null;
    }
    this.#rememberPid(child);
    const relay = this.relay;
    this.child = child;
    // 从一个 chunk 拉起到挂上之间旧进程可能还吐过半截行，挂新进程前再清一次尾巴
    this.streamTails = { stdout: "", stderr: "" };
    // 新进程已经挂上，换线路的空窗结束
    this.switching = false;
    // 旧进程被换掉之后还可能再吐几行：只认当前这个进程的输出，免得它改掉新地址 / 删掉新连接
    child.stdout.on("data", (chunk) => { if (this.child === child) this.consume(chunk, "stdout"); });
    child.stderr.on("data", (chunk) => { if (this.child === child) this.consume(chunk, "stderr"); });
    child.on("exit", (code) => {
      this.#forgetPid(child);
      if (relay && this.relay === relay) { relay.stop().catch(() => {}); this.relay = null; }
      if (this.child !== child) return; // 我们自己换方式时杀掉的旧进程
      // 先读「退出前连上没有」：下面补尾巴只补诊断信息，不能再把它改成已连上
      const wasConnected = this.connected;
      // 最后一行常常没有换行：退出时先把它当完整行处理掉，否则 lastErrLine / lastFatal 这些诊断会丢
      this.#flushStreamTails();
      this.child = null;
      /*
       * 进程都没了，上一轮的 /ready 结果不能再留在 status() 里冒充「边缘还有 N 条连接」；
       * 新进程起来后会重新查，连续 0 计数也从零开始。
       */
      this.ready = null;
      this.readyMisses = 0;
      this.connected = false;
      this.onLog(`隧道进程退出 code=${code}`);
      if (this.stopping || this.blocked) return;
      this.#onUnexpectedExit(code, wasConnected);
    });
    child.on("error", (error) => {
      this.lastError = error.message;
      this.onLog(`隧道启动失败：${error.message}`);
    });
    this.#armGate();
    return spawned;
  }

  #armGate() {
    clearTimeout(this.timers.gate);
    if (this.route === "ngrok") return;
    const child = this.child;
    this.timers.gate = setTimeout(() => {
      this.timers.gate = null;
      if (this.stopping || this.connected || this.child !== child) return;
      this.onLog(`「${ROUTE_LABEL[this.route]}」${GATE_MS / 1000} 秒内没注册上 Cloudflare，自动换下一种方式`);
      this.#next().catch((error) => this.onLog(`换方式失败：${error.message}`));
    }, GATE_MS);
    this.timers.gate.unref?.();
  }

  /** 这一代已经作废（stop 过、或者被新的重连接管）。gen 没传时不判（老调用方式） */
  #staleGen(gen) {
    return gen !== undefined && (this.stopping || gen !== this.gen);
  }

  /** 只停属于这一代的中继：并发启动时 this.relay 可能已经被新代次换掉了 */
  async #stopRelayFor(gen) {
    const relay = this.relay;
    if (!relay) return;
    if (relay.ownerGen !== undefined && relay.ownerGen !== gen) return;
    await relay.stop().catch(() => {});
    if (this.relay === relay) this.relay = null;
  }

  async #killChild() {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => {
        const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, 3000);
        child.on("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    if (this.relay) { await this.relay.stop().catch(() => {}); this.relay = null; }
  }

  async #next() {
    const gen = this.gen;
    if (this.stopping) return;
    // 从杀掉旧进程到新进程挂上之间 child 是空的：标成「正在换线路」，界面别闪「仅本机」
    this.switching = true;
    try {
      await this.#killChild();
      if (this.stopping || gen !== this.gen) return;
      if (this.attemptIndex + 1 < this.plan.length) {
        this.attemptIndex++;
        await this.#launch(gen);
        return;
      }
      await this.#block(gen);
    } finally {
      // 不管是换成了、进了 blocked、被新代次接管，还是 #launch 抛错（比如缺令牌），空窗都到此为止；
      // 不清掉的话 status() 会一直报「正在重新连接」
      this.switching = false;
    }
  }

  #onUnexpectedExit(code, wasConnected) {
    if (this.lastFatal) { this.#blockFatal(); return; }
    if (!wasConnected && this.route !== "ngrok") {
      // 还没打通就退出：多半是这种方式走不通，换下一种
      // 存进 timers：stop / reconnect / #clearTimers 都要能把它清掉，否则停了之后它还会去换方式拉进程
      clearTimeout(this.timers.next);
      this.timers.next = setTimeout(() => {
        this.timers.next = null;
        if (this.stopping) return;
        this.#next().catch(() => {});
      }, this.nextDelayMs);
      this.timers.next.unref?.();
      return;
    }
    const delay = RESTART_BACKOFF_MS[Math.min(this.restarts, RESTART_BACKOFF_MS.length - 1)];
    this.restarts++;
    this.onLog(`隧道意外断开（code=${code}），${delay / 1000} 秒后自动重连`);
    this.timers.restart = setTimeout(async () => {
      this.timers.restart = null;
      const gen = this.gen;
      if (this.stopping || this.child) return;
      try {
        // 已经连上过再退出：网卡 / 代理可能变了，退避到点后重新选一次线路再拉起
        this.#refreshIfaceBaseline();
        this.bypass = null;
        await this.#buildPlan(gen);
        if (this.stopping || gen !== this.gen) return;
        // 重建线路期间可能已经有人发起重连 / 拉起了进程，别再起一个
        if (this.child || this.reconnecting) return;
        this.attemptIndex = 0;
        await this.#launch(gen);
      } catch (error) {
        this.lastError = error.message;
        this.onLog(`隧道重连失败：${error.message}`);
      }
    }, delay);
    this.timers.restart.unref?.();
  }

  /** 所有方式都试过了：做一次完整诊断，告诉上层（AI 助手）需要用户决定；之后在后台持续复查。 */
  async #block(gen = this.gen) {
    clearTimeout(this.timers.gate);
    /*
     * 这里不清 switching：诊断加指纹要几秒到十几秒，这段时间没有子进程、blocked 也还没写，
     * 清早了界面就会落到「仅本机」。由 #next 的 finally 统一清——写了 blocked 时 status() 先看 blocked，
     * 自救时 reconnect() 已经同步挂上 reconnecting，两种出口都不会闪。
     */
    const diagnosis = await this.diagnoseFn({ env: this.childEnv(), explicitProxy: this.config.edgeProxy }).catch((error) => ({ verdict: { code: "unknown", text: error.message } }));
    // 诊断期间 stop / reconnect 可能已经接管：别再写 blocked，也别排复查
    if (this.stopping || gen !== this.gen || this.child) return;
    /*
     * 诊断说能从网卡绕开（bypass）或经代理中继（relay），可这次线路里偏偏没有它
     * （典型：重连时网卡还没回来，bypass 被排除出计划）。这时不该把它改写成
     * 「网络没问题、隧道程序的错」—— 那会让复查每 5 分钟才试一次。马上重建线路再试。
     * 但自救的重连本身会换代次，按代次记等于每轮都能再自救；所以只认一个待决标记，
     * 真连上（#markConnected）或重新 start（#doStart）才清零，失败一次后就按普通 blocked 处理。
     */
    const diagCode = diagnosis.verdict?.code;
    let routeRejected = false;
    if (diagCode === "bypass" || diagCode === "relay") {
      const mode = this.config.edgeRoute;
      const how = diagCode === "bypass" ? "从网卡绕开" : "经代理中继";
      if ((mode === "direct" && diagCode === "relay") || (mode === "proxy" && diagCode === "bypass")) {
        /*
         * 诊断出来的线路被当前边缘路线模式明确排除了：这不是「这次计划漏排」，
         * 自救只会按同一套模式再排一次，永远还是连不上。直接说清怎么改，别落进
         * 「网络能连上、是隧道程序的错」那段误导文案。
         */
        routeRejected = true;
        // networkOk 为真：网络本身没问题，是设置挡住了。复查只在网络环境变了或每 10 轮（约 5 分钟）才重试，
        // 否则 proxy 模式下复查每轮都能「从网卡绕开」判成能连，按同一套设置又排不出这条线路，白白反复重连
        diagnosis.verdict = { code: diagCode, networkOk: true, text: `${how}能通，但边缘路线设成了${mode === "direct" ? "直连" : "代理"}，改回自动即可` };
      } else if (!this.plan.includes(diagCode) && !this.selfHealPending) {
        this.selfHealPending = true;
        this.onLog(`诊断发现能${how}，但这次线路里没有它，马上重建线路再试`);
        this.reconnect(`诊断发现能${how}，但这次线路里没有它`).catch(() => {});
        return;
      }
    }
    const fp = await this.fingerprintFn().catch(() => ({ key: "?" }));
    if (this.stopping || gen !== this.gen || this.child) return;
    // 网络本身是通的（直连或中继能握手）却还是注册不上：不是网络问题，别误导用户去动代理
    const code = diagnosis.verdict?.code;
    if (!routeRejected && (code === "ok" || code === "relay" || code === "bypass")) {
      const why = this.lastFatal || this.lastErrLine;
      diagnosis.verdict = { code: "tunnel-error", networkOk: true, text: `网络能连上 Cloudflare，但隧道程序没注册成功${why ? "：" + why : ""}。可以让 AI 助手看一下日志` };
    }
    this.blocked = { at: Date.now(), diagnosis, fingerprint: fp.key, rechecks: 0 };
    this.lastError = diagnosis.verdict?.text || "隧道连不上 Cloudflare";
    this.onLog(`自动方式都没连上：${this.lastError}`);
    try { this.onBlocked({ diagnosis, provider: this.provider }); } catch { /* 上层出错不影响隧道 */ }
    this.#scheduleRecheck();
  }

  /** 换方式也没用的错误（时间不准、凭据不对）：直接告诉上层，之后每 5 分钟重试一次（用户改好了就能自己恢复） */
  #blockFatal() {
    clearTimeout(this.timers.gate);
    const text = this.lastFatal;
    this.lastError = text;
    this.blocked = { at: Date.now(), diagnosis: { verdict: { code: /电脑时间/.test(text) ? "clock" : "config", networkOk: true, text } }, fingerprint: "fatal", rechecks: 0 };
    this.onLog(`隧道停下：${text}`);
    try { this.onBlocked({ diagnosis: this.blocked.diagnosis, provider: this.provider }); } catch { /* 忽略 */ }
    this.#scheduleRecheck();
  }

  #scheduleRecheck() {
    clearTimeout(this.timers.recheck);
    this.timers.recheck = setTimeout(async () => {
      this.timers.recheck = null;
      const gen = this.gen;
      if (this.stopping || !this.blocked) return;
      try {
        const fp = await this.fingerprintFn();
        if (this.stopping || gen !== this.gen) return;
        let ready = fp.direct;
        if (!ready && (fp.tun || fp.fakeIp)) ready = Boolean(await this.findBypassFn().catch(() => null));
        if (this.stopping || gen !== this.gen) return;
        if (!ready && this.proxy) ready = (await probeEdgeViaProxy(this.proxy, { timeoutMs: 6000 })).ok;
        if (this.stopping || gen !== this.gen) return;
        // 不是网络问题时，网络「能连上」不算新情况：只在环境变化或每 5 分钟重试一次
        if (this.blocked.diagnosis?.verdict?.networkOk) ready = ++this.blocked.rechecks % 10 === 0;
        const changed = this.blocked.fingerprint !== "fatal" && fp.key !== this.blocked.fingerprint;
        if (ready || changed) {
          this.onLog(ready ? "复查：现在能连上 Cloudflare 了，自动重连" : "复查：网络环境有变化，自动重连");
          this.blocked = null;
          this.lastError = null;
          this.lastFatal = null;
          // 复查也相当于一次重连：重新拍基线，免得网卡在这期间恢复又被当成「没变化」
          this.#refreshIfaceBaseline();
          await this.#buildPlan(gen);
          if (this.stopping || gen !== this.gen) return;
          this.attemptIndex = 0;
          await this.#launch(gen);
          return;
        }
      } catch { /* 下一轮再查 */ }
      if (this.stopping || gen !== this.gen) return;
      this.#scheduleRecheck();
    }, this.recheckMs);
    this.timers.recheck.unref?.();
  }

  /**
   * 定时查一次 cloudflared 的 /ready。
   *
   * 用 setTimeout 链而不是 setInterval：上一次请求可能还没回来（默认有 3 秒超时），
   * setInterval 会让请求叠着发；链式排下一次才能保证一次只有一个在飞。
   * 代次和 stopping 的检查放在回调里，stop / reconnect 清掉 timers.ready 之后不会自己又装回来。
   */
  #scheduleReady(gen = this.gen) {
    clearTimeout(this.timers.ready);
    this.timers.ready = setTimeout(() => {
      this.timers.ready = null;
      if (this.stopping || gen !== this.gen) return;
      this.#pollReady(gen).catch(() => {});
    }, this.readyPollMs);
    this.timers.ready.unref?.();
  }

  /**
   * 查一次 cloudflared 的 /ready，作为日志之外的第二个「边缘还在不在」信号。
   *
   * 日志会漏行，漏一行就可能把还在的连接判成全掉；/ready 是 cloudflared 自己的状态接口，更直接。
   * 只在本机 metrics 地址上查，不走代理。
   */
  async #pollReady(gen) {
    const address = this.metricsAddress;
    // 这轮日志还没打出 metrics 地址：只排下一次，等地址出现
    if (!address) {
      if (this.stopping || gen !== this.gen || !this.connected) return;
      this.#scheduleReady(gen);
      return;
    }
    const child = this.child;
    /*
     * 先记下发起时到底连上没有：#readyFetch 可能等一会儿才回来，
     * 而未连上时（旧定时器落进新进程还没 Registered 的窗口）/ready 也会报 503，
     * 那不是边缘掉了。只有发起和返回时都连着，这个 0 才算一次 miss。
     */
    const wasConnected = this.connected;
    let response = null;
    let error = null;
    try {
      response = await this.#readyFetch(`http://${address}/ready`);
    } catch (e) {
      error = e;
    }
    // await 回来先确认这次轮询还属于当前这一代、没在停、子进程没被换掉；不对就直接收手，不再排下一次
    if (this.stopping || gen !== this.gen || this.child !== child) return;

    let connections = null;
    let ok = false;
    if (response) {
      if (response.status === 200) {
        try {
          const body = await response.json();
          // JSON 也是 await：回来再确认一次，别拿旧进程的响应去改新进程的状态
          if (this.stopping || gen !== this.gen || this.child !== child) return;
          connections = Number(body?.readyConnections);
          if (Number.isFinite(connections)) ok = true;
          else { connections = null; error = new Error("/ready 响应里没有 readyConnections"); }
        } catch (e) {
          error = e;
        }
      } else if (response.status === 503) {
        // 503 就是「一条边缘连接都没有」；body 解析不了也按 0 算，不能当成查询失败
        connections = 0;
        try {
          const body = await response.json();
          if (this.stopping || gen !== this.gen || this.child !== child) return;
          const parsed = Number(body?.readyConnections);
          if (Number.isFinite(parsed)) connections = parsed;
        } catch { /* 解析不了就保持 0 */ }
        ok = true;
      } else {
        error = new Error(`/ready 返回 HTTP ${response.status}`);
      }
    }
    // 请求失败 / 超时只记下来，不碰 readyMisses：进程卡住由主程序的公网实测兜底
    const failure = ok ? undefined : error?.message ?? String(error ?? "/ready 查询失败");
    this.ready = { connections, at: Date.now(), ok, ...(failure ? { error: failure } : {}) };

    if (ok && connections > 0) {
      this.readyMisses = 0;
      // 日志说全掉了、但 cloudflared 自己还有连接：以它为准，别白等 60 秒再拆线路
      if (this.timers.lost) {
        clearTimeout(this.timers.lost);
        this.timers.lost = null;
        /*
         * 光清定时器不够：liveConnections 还是空的，cloudflared 随便再打一行日志，
         * #processLines 就会把 lost 装回来。日志说全掉、这里却查到连接时记下这次否决，直到出现新的注册 / 掉线行；
         * 只在这次从「没否决」变成「否决」时打日志，避免每次轮询刷一句。
         */
        if (this.liveConnections.size === 0) {
          const firstVeto = !this.logLostVetoed;
          this.logLostVetoed = true;
          if (firstVeto) this.onLog(`日志里边缘连接全掉了，但 cloudflared 自己报还有 ${connections} 条（/ready），以它为准、不重连`);
        }
      }
    } else if (ok && connections === 0) {
      // /ready 也确认一条都没有：之前的否决作废，以后掉线该装 lost 定时器就装
      this.logLostVetoed = false;
      if (wasConnected && this.connected) {
        this.readyMisses += 1;
        if (this.readyMisses >= this.readyMissLimit && this.connected && !this.reconnecting) {
          this.onLog(`cloudflared 自己报边缘连接 0 条，已连续 ${this.readyMisses} 次（/ready），重建线路`);
          this.readyMisses = 0;
          // 重连会换子进程、重新打通、重新开始轮询，所以这里不再排下一次
          this.reconnect("cloudflared /ready 报 0 条边缘连接").catch(() => {});
          return;
        }
      }
    }

    // 还在当前代次且仍连着才排下一次；重连 / stop 之后由新一轮接管
    if (this.stopping || gen !== this.gen || !this.connected) return;
    this.#scheduleReady(gen);
  }

  /** 查 /ready 的默认实现：只连本机 metrics 端口，3 秒超时，不走代理（Node fetch 默认不读代理环境变量） */
  #readyFetch(url) {
    if (this.readyFetchFn) return this.readyFetchFn(url);
    return fetch(url, { signal: AbortSignal.timeout(3000) });
  }

  #clearTimers() {
    for (const key of Object.keys(this.timers)) { clearTimeout(this.timers[key]); this.timers[key] = null; }
  }

  /*
   * 网卡地址监视。
   *
   * 为什么不用 net-diagnose 的 quickFingerprint：那个会真的发 DNS 查询和 TLS 握手，
   * 每 10 秒做一次太贵。这里只读本机网卡列表。
   *
   * 但指纹必须按当前线路区分：
   *   - 走 bypass：线路绑死在一块网卡的地址上，只关心那个地址还在不在。TUN 关开、
   *     虚拟网卡起停都和我们无关，不能因此把好好的隧道断掉。
   *   - 走 direct / direct-tcp / relay：只算物理网卡（排除 TUN / 虚拟机 / 容器网卡），
   *     TUN 的「有 / 无」单独当信号 —— 它上下线会改变直连和代理的行为。
   */
  #startIfaceWatch(gen = this.gen) {
    // stop 之后 / 旧代次的启动不能把监视又装回来
    if (this.stopping || gen !== this.gen) return;
    this.#stopIfaceWatch();
    this.#refreshIfaceBaseline();
    this.ifaceTimer = setInterval(() => this.#checkInterfaces(), this.ifacePollMs);
    this.ifaceTimer.unref?.();
  }

  #stopIfaceWatch() {
    clearInterval(this.ifaceTimer);
    this.ifaceTimer = null;
    clearTimeout(this.ifacePending);
    this.ifacePending = null;
    clearTimeout(this.ifaceCooldownTimer);
    this.ifaceCooldownTimer = null;
    this.ifaceCooldownUntil = 0;
    this.ifaceCooldownDirty = false;
  }

  /** 重新拍一份网卡基线（重连 / 复查前调用）。只记物理网卡 + TUN 信号。 */
  #refreshIfaceBaseline() {
    const list = this.#rawInterfaces();
    this.ifaceBaseline = this.#physicalSnapshot(list);
    this.ifaceBaselineTun = this.#tunName(list);
    this.bypassMissingPolls = 0;
  }

  #rawInterfaces() {
    try { return this.networkInterfaces() ?? {}; } catch { return {}; }
  }

  /** 有没有 TUN 网卡。默认按注入的网卡列表判断，自检里换掉 networkInterfaces 就能控制。 */
  #tunAdapter(list = this.#rawInterfaces()) {
    if (this.tunAdapterFn) return this.tunAdapterFn(list) ?? null;
    for (const [name, items] of Object.entries(list)) {
      for (const item of items ?? []) {
        if (item.family !== "IPv4" && item.family !== 4) continue;
        if (isFakeIp(item.address) || TUN_IFACE_RE.test(name)) return { name, address: item.address };
      }
    }
    return null;
  }

  #tunName(list) {
    return this.#tunAdapter(list)?.name ?? "-";
  }

  /** 所有非 internal 的 IPv4，key 是「网卡名=地址」。bypass 判断地址还在不在时用这个。 */
  #ifaceSnapshot(list = this.#rawInterfaces()) {
    const snapshot = new Map();
    for (const [name, items] of Object.entries(list)) {
      for (const item of items ?? []) {
        if (item.internal) continue;
        if (item.family !== "IPv4" && item.family !== 4) continue;
        snapshot.set(`${name}=${item.address}`, { name, address: item.address });
      }
    }
    return snapshot;
  }

  /** 只算物理网卡：排除 TUN、虚拟机 / 容器 / 组网网卡、自动分配地址和假 IP。 */
  #physicalSnapshot(list = this.#rawInterfaces()) {
    const snapshot = new Map();
    for (const [name, items] of Object.entries(list)) {
      if (TUN_IFACE_RE.test(name) || VIRTUAL_IFACE_RE.test(name)) continue;
      for (const item of items ?? []) {
        if (item.internal) continue;
        if (item.family !== "IPv4" && item.family !== 4) continue;
        if (isFakeIp(item.address) || item.address.startsWith("169.254.")) continue;
        snapshot.set(`${name}=${item.address}`, { name, address: item.address });
      }
    }
    return snapshot;
  }

  #ifaceKey(snapshot) {
    return [...snapshot.keys()].sort().join("|");
  }

  /** 写清楚哪块网卡的哪个地址没了 / 新增了（公网地址打码，内网照写） */
  #ifaceChangeText(before, after) {
    const parts = [];
    for (const [key, item] of before) if (!after.has(key)) parts.push(`${item.name} ${maskAddress(item.address)} 没了`);
    for (const [key, item] of after) if (!before.has(key)) parts.push(`${item.name} ${maskAddress(item.address)} 新增`);
    return parts.length ? parts.join("；") : "网卡地址有变化";
  }

  #ifaceCoolingDown() {
    return this.ifaceCooldownUntil > Date.now();
  }

  #markIfaceCooldown() {
    this.ifaceCooldownUntil = Date.now() + this.ifaceCooldownMs;
    this.ifaceCooldownDirty = false;
  }

  /** 冷却期里发现的变化先记下，等冷却结束再重新比一次 */
  #noteIfaceChangeWhileCooling() {
    this.ifaceCooldownDirty = true;
    if (this.ifaceCooldownTimer) return;
    const wait = Math.max(0, this.ifaceCooldownUntil - Date.now());
    this.ifaceCooldownTimer = setTimeout(() => {
      this.ifaceCooldownTimer = null;
      if (this.stopping || this.blocked) return;
      this.ifaceCooldownUntil = 0;
      if (!this.ifaceCooldownDirty) return;
      this.ifaceCooldownDirty = false;
      this.#checkInterfaces();
    }, wait);
    this.ifaceCooldownTimer.unref?.();
  }

  #checkInterfaces() {
    if (this.stopping || this.blocked) return; // blocked 有自己的 30 秒复查，别抢
    if (!this.child && !this.timers.restart) return; // 没在跑就没什么可救的
    const list = this.#rawInterfaces();

    // 走 bypass 时线路绑死了某块网卡的地址：只盯着这个地址，连续两次轮询都不在才重连
    if (this.route === "bypass" && this.bypass?.localAddress) {
      const present = [...this.#ifaceSnapshot(list).values()].some((item) => item.address === this.bypass.localAddress);
      if (present) { this.bypassMissingPolls = 0; return; }
      if (++this.bypassMissingPolls < 2) return; // 一闪而过不算，避免 TUN / VPN 抖动就重建
      this.bypassMissingPolls = 0;
      if (this.#ifaceCoolingDown()) { this.#noteIfaceChangeWhileCooling(); return; }
      const detail = `线路绑定的 ${maskAddress(this.bypass.localAddress)}（${this.bypass.iface ?? "?"}）已不在本机`;
      this.#refreshIfaceBaseline();
      this.#markIfaceCooldown();
      this.reconnect(`网卡地址变了：${detail}`).catch(() => {});
      return;
    }
    this.bypassMissingPolls = 0;

    const current = this.#physicalSnapshot(list);
    const tun = this.#tunName(list);
    if (this.#ifaceKey(current) === this.#ifaceKey(this.ifaceBaseline) && tun === this.ifaceBaselineTun) return;
    if (this.ifacePending) return; // 已经在防抖等待里
    if (this.#ifaceCoolingDown()) { this.#noteIfaceChangeWhileCooling(); return; }
    // 换网卡 / 重连 Wi-Fi 时地址常先消失再出现，等 3 秒再算一次，避免刚断就抢着重连
    this.ifacePending = setTimeout(() => {
      this.ifacePending = null;
      if (this.stopping || this.blocked) return;
      if (!this.child && !this.timers.restart) return;
      const latestList = this.#rawInterfaces();
      const latest = this.#physicalSnapshot(latestList);
      const latestTun = this.#tunName(latestList);
      if (this.#ifaceKey(latest) === this.#ifaceKey(this.ifaceBaseline) && latestTun === this.ifaceBaselineTun) return; // 又变回去了
      if (this.#ifaceCoolingDown()) { this.#noteIfaceChangeWhileCooling(); return; }
      const parts = [];
      const text = this.#ifaceChangeText(this.ifaceBaseline, latest);
      if (text !== "网卡地址有变化") parts.push(text);
      if (latestTun !== this.ifaceBaselineTun) {
        parts.push(latestTun === "-" ? "TUN 网卡消失" : `TUN 网卡「${latestTun}」${this.ifaceBaselineTun === "-" ? "出现" : "换了"}`);
      }
      const reason = `网卡地址变了：${parts.join("；") || "网卡地址有变化"}`;
      this.ifaceBaseline = latest;
      this.ifaceBaselineTun = latestTun;
      this.#markIfaceCooldown();
      this.reconnect(reason).catch(() => {});
    }, this.ifaceDebounceMs);
    this.ifacePending.unref?.();
  }

  #markConnected() {
    if (this.connected) return;
    this.connected = true;
    clearTimeout(this.timers.gate); this.timers.gate = null;
    clearTimeout(this.timers.lost); this.timers.lost = null;
    // 真注册上了：上一次「日志全掉但 /ready 说还有」的否决到此为止
    this.logLostVetoed = false;
    // 刚连上：连上之前那些「还没 Registered」的 0 不能带进来，否则再碰一次 0 就会白拆线路
    this.readyMisses = 0;
    this.restarts = 0;
    // 真连上了才算自救成功；之后再失败可以按新的现场重新判断
    this.selfHealPending = false;
    this.lastError = null;
    this.lastFatal = null;
    const recovered = Boolean(this.hadTrouble);
    this.hadTrouble = false;
    if (this.publicUrl) this.onLog(`隧道已打通：${this.publicUrl}（${ROUTE_LABEL[this.route] ?? this.route}）`);
    // 这一轮计划里缺了偏好线路（比如 bypass 暂时没进计划）：别把「临时改走的路」记成新偏好
    if (!this.planMissingPreferred && this.route && this.route !== "ngrok" && this.route !== this.config.preferredRoute) {
      this.config.preferredRoute = this.route;
      try { this.onRoute(this.route); } catch { /* 忽略 */ }
    }
    if (recovered) { try { this.onRecovered({ route: this.route }); } catch { /* 忽略 */ } }
    // 日志只是第一个信号：连上后再定期问 cloudflared 自己的 /ready（ngrok 没有这个接口）
    if (this.provider !== "ngrok") this.#scheduleReady(this.gen);
  }

  spawnNgrok(workspaceDir) {
    /*
     * ngrok v3 基本功能都要 authtoken —— 不给的话 agent 起不来，
     * 报的是「authentication failed」，用户看不出该去做什么。
     * 所以这里明确检查，报错里直接给获取地址。
     */
    if (!this.config.ngrokAuthtoken) {
      throw new Error(
        "ngrok 需要 authtoken。去 https://dashboard.ngrok.com/get-started/your-authtoken 复制一个，" +
        "填到设置的「ngrok 令牌」里再试。"
      );
    }
    // 修复：令牌不再放命令行（任务管理器/进程列表里谁都看得见，还会随 args 回传到界面日志），改走环境变量
    const args = [
      "http", String(this.localPort),
      "--log", "stdout", "--log-format", "json",
    ];
    if (this.config.ngrokDomain) args.push(`--domain=${this.config.ngrokDomain}`);
    // 参照学习软件验证过的结论：ngrok 免费版不接受 HTTP 代理，默认走直连，并把代理变量摘掉。
    const env = this.childEnv();
    for (const key of Object.keys(env)) if (/^(https?|all)_proxy$/i.test(key)) delete env[key];
    env.NGROK_AUTHTOKEN = this.config.ngrokAuthtoken;
    this.onLog("ngrok 以直连模式启动（已移除继承的代理变量）");
    return { child: spawn(this.#bin("ngrok"), args, { env, windowsHide: true }), args };
  }

  /**
   * 起命名隧道。
   *
   * Cloudflare 的命名隧道有三种形态，**配置在哪决定了改了有没有用**：
   *
   *   ① 仪表板管理（remotely-managed）
   *      后台建隧道 → 拿一长串令牌 → 本地只给令牌。
   *      公网域名和转发目标都在后台配。
   *      用法：cloudflared tunnel run --token <令牌>
   *
   *   ② 本地管理（locally-managed）
   *      用 `cloudflared tunnel create` 建 → 生成凭据 JSON。
   *      公网域名和转发目标写在本地 config.yml 里。
   *      用法：cloudflared tunnel --config <文件> run
   *
   *   ③ **混合（最容易踩坑的一种）**
   *      有凭据文件、本地也有一份 config.yml，
   *      但隧道在 Cloudflare 那边的 `config_src` 是 `cloudflare` ——
   *      **云端配置覆盖本地**，改本地文件完全没用。
   *      怎么认出来：看 cloudflared 日志里有没有
   *        `Updated to new configuration ... version=N`
   *      有 version 号 = 用的是云端配置；本地配置不会有版本号。
   *      改法只能走 API 或后台：
   *        PUT /accounts/{账号}/cfd_tunnel/{隧道}/configurations
   *
   * 实测踩过的完整链路（2026-10 真实案例）：
   *   本地 config.yml 加了规则 → 不生效 → 发现是形态③
   *   → 改云端配置 → 还是不生效 → 发现 DNS 的 CNAME 指向的是**另一条隧道**
   *   → 改 DNS 指向 → 通了
   * 所以排查顺序应该是：**先确认 DNS 指向哪条隧道，再确认配置在哪，最后才是改**。
   */
  async spawnCloudflaredNamed(workspaceDir, edge) {
    const hostname = this.config.namedHostname;
    if (!hostname) {
      throw new Error(
        "命名隧道需要 BRIDGE_NAMED_HOSTNAME（例如 bridge.example.com）。"
      );
    }

    /*
     * 命名隧道的公网地址是**已知的**，直接就是 https://<域名>。
     *
     * 快速隧道得从 cloudflared 日志里抓 URL，命名隧道不会打印那一行，
     * 所以不在这里设的话 publicUrl 永远是 null —— 界面上显示「未启动」，
     * 但实际隧道是通的，会让人以为没配好。
     */
    this.publicUrl = `https://${hostname}`;

    const { namedToken, namedTunnelId, namedCredentials } = this.config;

    /* ---------- 模式①：仪表板管理（只有令牌）---------- */
    if (namedToken && !namedTunnelId) {
      /*
       * 这种模式下 ingress 在 Cloudflare 后台配，本地不写规则；但**必须给 --config**：
       * 不给的话 cloudflared 会去读用户的 ~/.cloudflared/config.yml，
       * 里面有给别的隧道写的规则和 protocol: http2，会把这次启动带偏。
       * 令牌照旧只放环境变量 TUNNEL_TOKEN，文件里绝不写。
       */
      const configFile = path.join(workspaceDir, `cloudflared-named-token-${this.localPort}.yml`);
      await writeFile(configFile, [
        "# 由 bridge-replica 写入：令牌模式（仪表板管理）专用，故意不读用户的 ~/.cloudflared/config.yml",
        "no-autoupdate: true",
        "# 以前继承用户配置里的 protocol: http2，这里显式写上保持行为不变；走中继时命令行的 --protocol http2 也一样",
        "protocol: http2",
        "",
      ].join("\n"), "utf8");
      // 命令行和本地管理模式一样（tunnel --config <文件> run），区别只在令牌走 TUNNEL_TOKEN
      const args = namedTunnelArgs({ configFile, edge: edge?.address });
      this.onLog(`命名隧道（仪表板管理）启动：公网域名 ${hostname} 需已在 Cloudflare 后台配好指向本机端口 ${this.localPort}`);
      return { child: spawn(this.#bin("cloudflared"), args, { env: { ...this.edgeEnv(edge), TUNNEL_TOKEN: namedToken }, windowsHide: true }), args, mode: "token" };
    }

    /* ---------- 模式②：本地管理（隧道 ID + 凭据文件）---------- */
    if (namedTunnelId) {
      const credentialsFile = await this.resolveCredentials(namedTunnelId, namedCredentials);
      if (!credentialsFile) {
        throw new Error(
          `找不到隧道 ${namedTunnelId} 的凭据文件。\n` +
          ` 找过这些地方：\n` +
          `   · 环境变量 BRIDGE_NAMED_CREDENTIALS 指定的路径\n` +
          `   · 你现有 ~/.cloudflared/config.yml 里 credentials-file 指的位置\n` +
          `   · ~/.cloudflared/ 下所有 .json 里 TunnelID 匹配的\n` +
          ` 如果凭据丢了，重新建一条：cloudflared tunnel create <名字>`
        );
      }

      const configFile = path.join(workspaceDir, `cloudflared-named-${this.localPort}.yml`);
      await writeFile(configFile, [
        "# 由 bridge-replica 写入：本地管理（locally-managed）命名隧道",
        "# 注意：这类隧道的路由只认本文件，Cloudflare 仪表板改不了。",
        `tunnel: ${namedTunnelId}`,
        `credentials-file: ${credentialsFile}`,
        "",
        "# 强制 HTTP/2 over TCP：走代理更稳，避开 QUIC/UDP 会话老化导致的掉线",
        "protocol: http2",
        "",
        "ingress:",
        `  - hostname: ${hostname}`,
        `    service: http://127.0.0.1:${this.localPort}`,
        "  # 兜底规则，必须放最后",
        "  - service: http_status:404",
        "",
      ].join("\n"), "utf8");

      this.onLog(`命名隧道（本地管理）启动：${hostname} → 127.0.0.1:${this.localPort}，隧道 ${namedTunnelId}`);
      this.onLog(`凭据文件：${credentialsFile}`);
      const args = namedTunnelArgs({ configFile, edge: edge?.address });
      return { child: spawn(this.#bin("cloudflared"), args, { env: this.edgeEnv(edge), windowsHide: true }), args, mode: "credentials" };
    }

    throw new Error(
      "命名隧道需要凭据，二选一：\n" +
      "  ① 仪表板管理：BRIDGE_NAMED_TUNNEL_TOKEN=<Cloudflare 后台的隧道令牌>\n" +
      "  ② 本地管理：BRIDGE_NAMED_TUNNEL_ID=<隧道 ID 或名字>\n" +
      "     （凭据文件会自动找，也可用 BRIDGE_NAMED_CREDENTIALS 指定）\n" +
      "  两种都需要 BRIDGE_NAMED_HOSTNAME=<公网域名>"
    );
  }

  /**
   * 找到本地管理隧道的凭据文件。
   *
   * 为什么不能直接拼 `<隧道id>.json`：凭据文件是按**隧道 UUID** 命名的，
   * 但用户 config 里常写**隧道名字**（比如 c2c-458730eb78e3），两者对不上。
   * 所以按可靠性从高到低试四层：
   *   ① 显式指定
   *   ② 用户现有 ~/.cloudflared/config.yml 里写的那个（最可信 —— 他已经在用了）
   *   ③ ~/.cloudflared/<id>.json（id 本来就是 UUID 的情况）
   *   ④ 扫 ~/.cloudflared/*.json，按里面的 TunnelID 字段匹配
   */
  async resolveCredentials(tunnelId, explicitPath) {
    const cfDir = path.join(os.homedir(), ".cloudflared");
    const candidates = [];

    if (explicitPath) candidates.push(explicitPath);
    candidates.push(path.join(cfDir, `${tunnelId}.json`));

    // ② 读用户现有配置里指定的凭据
    try {
      const existing = await readFile(path.join(cfDir, "config.yml"), "utf8");
      const declared = /^\s*credentials-file:\s*(.+)$/m.exec(existing)?.[1]?.trim();
      const declaredTunnel = /^\s*tunnel:\s*(.+)$/m.exec(existing)?.[1]?.trim();
      // 只有隧道对得上才复用，别拿错人的凭据
      if (declared && (!declaredTunnel || declaredTunnel === tunnelId)) {
        candidates.unshift(declared.replace(/^["']|["']$/g, ""));
      }
    } catch { /* 没有就算了 */ }

    for (const candidate of candidates) {
      try {
        const raw = await readFile(candidate, "utf8");
        JSON.parse(raw); // 确认是合法 JSON，别把半截文件当凭据
        return candidate;
      } catch { /* 换下一个 */ }
    }

    // ④ 扫目录，按 TunnelID 字段匹配（能处理「名字 vs UUID」对不上的情况）
    try {
      const entries = await readdir(cfDir);
      for (const name of entries) {
        if (!name.endsWith(".json")) continue;
        const full = path.join(cfDir, name);
        try {
          const parsed = JSON.parse(await readFile(full, "utf8"));
          if (parsed?.TunnelID && (parsed.TunnelID === tunnelId || name.startsWith(parsed.TunnelID))) {
            // 只有名字对得上、或者目录里就这一个凭据时才算
            if (parsed.TunnelID === tunnelId || tunnelId === parsed.TunnelID) return full;
          }
        } catch { /* 跳过坏文件 */ }
      }
    } catch { /* 目录读不了就算了 */ }

    return null;
  }

  async spawnCloudflared(workspaceDir, provider, route = "direct", gen) {
    /*
     * 配了命名隧道就用命名隧道 —— 不能只认 provider 字符串。
     *
     * 踩过的坑：界面上填好了域名和隧道 ID，但应用传的 provider 是 "cloudflare"，
     * 于是静默走了快速隧道。表现是「配的固定域名白填，公网地址每次启动都变」，
     * 而且日志里看不出哪里不对（快速隧道也是正常的 running 状态）。
     *
     * 判据：有域名 + 有凭据（令牌或隧道 ID），就认为是想用固定地址。
     */
    const configuredForNamed = Boolean(
      this.config.namedHostname && (this.config.namedToken || this.config.namedTunnelId)
    );
    if (provider === "cloudflare-named" || configuredForNamed) {
      if (configuredForNamed && provider !== "cloudflare-named") {
        this.onLog("检测到已配置命名隧道（域名 + 凭据），自动使用固定地址模式");
      }
      return this.spawnCloudflaredNamed(workspaceDir, await this.#edgeFor(route, gen));
    }

    /*
     * 文件名带上端口：两个实例（开发版 + 打包版）会共用同一个数据目录，
     * 用固定文件名的话后启动的会把先启动的配置覆盖掉 —— 表现是
     * 「隧道指向的端口莫名其妙变成了别的数」。
     */
    const configFile = path.join(workspaceDir, `cloudflared-quick-tunnel-${this.localPort}.yml`);
    await writeFile(configFile, QUICK_TUNNEL_CONFIG, "utf8");
    const edge = await this.#edgeFor(route, gen);
    const args = quickTunnelArgs({ localPort: this.localPort, configFile, edge: edge?.address, protocol: route === "direct-tcp" ? "http2" : "auto" });
    this.onLog(`快速隧道启动：使用独立配置文件 ${configFile}（不继承用户 cloudflared 配置）`);
    this.onLog("提示：快速隧道的公网地址每次启动都会变。要固定地址请在设置里填公网域名和隧道 ID。");
    return { child: spawn(this.#bin("cloudflared"), args, { env: this.edgeEnv(edge), windowsHide: true }), args };
  }

  /** 按方式准备边缘地址：直连返回 null；中继先在本机起一个中继端口，cloudflared 连它。 */
  async #edgeFor(route, gen) {
    if (route === "bypass") {
      const bind = this.bypass || (await this.findBypassFn().catch(() => null));
      if (!bind) return null;
      this.bypass = bind;
      const relay = new EdgeRelay({ bind, onLog: this.onLog });
      const address = await relay.start();
      relay.ownerGen = gen; // 只停这次启动建的中继，别误停并发新代次的
      // 中继起来的这段时间里已经被 stop / 新一代接管：自己停掉，别把它挂到 this.relay 上，也别留着空监听
      if (this.#staleGen(gen)) { await relay.stop().catch(() => {}); return null; }
      this.relay = relay;
      this.onLog(`绕开代理：cloudflared → ${address} → 网卡「${bind.iface}」(${maskAddress(bind.localAddress)}) → Cloudflare（http2，不经代理软件）`);
      return { address, bind };
    }
    if (route !== "relay") return null;
    const proxy = this.proxy || (await findProxy(this.childEnv(), this.config.edgeProxy).catch(() => null));
    if (!proxy) return null;
    this.proxy = proxy;
    const relay = new EdgeRelay({ proxy, onLog: this.onLog });
    const address = await relay.start();
    relay.ownerGen = gen; // 只停这次启动建的中继，别误停并发新代次的
    if (this.#staleGen(gen)) { await relay.stop().catch(() => {}); return null; }
    this.relay = relay;
    this.onLog(`边缘中继已启动：cloudflared → ${address} → ${proxy.type} 代理 ${proxy.host}:${proxy.port}（${proxy.source}）→ Cloudflare（http2）`);
    return { address, proxy };
  }

  /** 走中继时顺便给 cloudflared 设 HTTPS_PROXY：快速隧道要先请求 api.trycloudflare.com，那一步认这个变量 */
  edgeEnv(edge) {
    const env = this.childEnv();
    if (edge?.proxy) env.HTTPS_PROXY = edge.proxy.url;
    return env;
  }

  /**
   * 只解析这次凑齐的完整行。一行可能被拆进两个 chunk（比如 Registered 被拆开），
   * 半截行不能拿去跑正则 —— 会对不上，日志里也会多出两个半截行。
   */
  #processLines(lines, stream, { diagnosticOnly = false } = {}) {
    if (!lines.length) return;
    for (const line of lines) {
      if (!line.trim()) continue;
      this.onLog(`[${stream}] ${line.slice(0, 300)}`);
    }
    const text = lines.join("\n");
    /*
     * 退出时补处理的半截行只用来补诊断信息：进程已经没了，
     * metrics 地址 / 公网地址 / 连接状态都不该再由这段尾巴改写。
     */
    if (!diagnosticOnly) {
      // cloudflared 的 metrics 端口不固定，只在启动日志里打一次；记下来后面用它查 /ready
      const metrics = /Starting metrics server on ([^\s/]+)\/metrics/.exec(text);
      if (metrics) this.metricsAddress = metrics[1];
    }
    const errLine = [...lines].reverse().find((l) => /\bERR\b/.test(l) && !/context canceled|failed to serve incoming request/i.test(l));
    if (errLine) this.lastErrLine = errLine.replace(/^.*?\bERR\b\s*/, "").slice(0, 160);
    if (CLOCK_RE.test(text)) this.lastFatal = "电脑时间不准，Cloudflare 的证书校验不过。请打开系统设置把时间改成「自动同步」，Bridge 会自动重连";
    else if (FATAL_RE.test(text)) this.lastFatal = `隧道配置有问题：${(FATAL_RE.exec(text)?.[0] ?? "").slice(0, 80)}（检查固定地址的隧道 ID / 凭据 / 令牌）`;
    if (/failed to dial to edge|Unable to establish connection|edge discovery|DialEdge|i\/o timeout|TLS handshake|connection reset/i.test(text)) this.hadTrouble = true;
    // 诊断信息补完就收手：不取 publicUrl、不碰 liveConnections / lost 定时器、不调 #markConnected
    if (diagnosticOnly) return;
    if (!this.publicUrl) {
      const found = this.provider === "ngrok" ? extractNgrokUrl(text) : extractPublicUrl(text);
      if (found) {
        this.publicUrl = found;
        this.onLog(`公网地址已就绪：${found}`);
      }
    }
    // 打通判定：cloudflared 每条边缘连接注册成功都会打这一行；ngrok 拿到公网地址即已建立会话
    if (this.provider !== "ngrok") {
      /*
       * 记录每条边缘连接的注册 / 掉线，全部掉光且 60 秒没恢复就当断线处理（换方式重连）。
       * 必须按行顺序处理：同一块里「掉线 → 重新注册」如果先做完全部 add 再做 delete，
       * 后到的注册会被前面的掉线抹掉，liveConnections 变成空集，误装 60 秒的 lost 定时器。
       */
      for (const line of lines) {
        for (const m of line.matchAll(/Registered tunnel connection[^\n]*?connIndex=(\d+)/gi)) {
          this.liveConnections.add(m[1]);
          this.logLostVetoed = false;
        }
        for (const m of line.matchAll(/(?:Unregistered tunnel connection|Connection terminated|Serve tunnel error|Lost connection)[^\n]*?connIndex=(\d+)/gi)) {
          this.liveConnections.delete(m[1]);
          this.logLostVetoed = false;
        }
      }
      if (this.connected && this.liveConnections.size === 0 && !this.timers.lost && !this.logLostVetoed) {
        this.timers.lost = setTimeout(() => {
          this.timers.lost = null;
          if (this.stopping || this.liveConnections.size > 0 || !this.child) return;
          this.connected = false;
          this.hadTrouble = true;
          // 走统一入口：边缘全掉多半是线路 / 网卡变了，要重新选线路，不能只从头再试
          this.reconnect("边缘连接全部掉线 60 秒没恢复").catch(() => {});
        }, this.lostTimeoutMs);
        this.timers.lost.unref?.();
      } else if (this.liveConnections.size > 0 && this.timers.lost) { clearTimeout(this.timers.lost); this.timers.lost = null; }
    }
    if (!this.connected && (this.provider === "ngrok" ? Boolean(this.publicUrl) : /Registered tunnel connection|Connection [0-9a-f-]+ registered/i.test(text))) {
      this.#markConnected();
    }
  }

  consume(chunk, stream) {
    // 先拼上这个流上次剩下的尾巴，再按换行切；最后一段没等到换行就留到下一次
    const text = (this.streamTails[stream] ?? "") + chunk.toString("utf8");
    const lines = text.split(/\r?\n/);
    let tail = lines.pop() ?? "";
    // 尾巴超过 64KB 说明对方根本不打换行：当一整行处理掉，别让它无限涨
    if (tail.length > 64 * 1024) { lines.push(tail); tail = ""; }
    this.streamTails[stream] = tail;
    this.#processLines(lines, stream);
  }

  /** 子进程退出时把两个流剩下的尾巴各补成一行（最后一行常常没有换行），只用来补诊断信息 */
  #flushStreamTails() {
    for (const stream of Object.keys(this.streamTails)) {
      const tail = this.streamTails[stream];
      if (!tail) continue;
      this.streamTails[stream] = "";
      this.#processLines([tail], stream, { diagnosticOnly: true });
    }
  }

  /* ---- 孤儿进程清理：上次程序被强退时留下的 cloudflared（只认我们自己记下的 PID，绝不碰用户自己开的 cloudflared） ---- */
  // 每个程序实例一份记录（文件名带程序自己的 PID）：开发版和安装版可能共用数据目录，不能互相误杀
  get #pidDir() { return path.join(this.dataHome, "tunnel"); }
  get #pidFile() { return path.join(this.#pidDir, `cloudflared-${process.pid}.pid`); }

  #rememberPid(child) {
    if (!child?.pid || this.provider === "ngrok") return;
    mkdir(this.#pidDir, { recursive: true }).then(() => writeFile(this.#pidFile, String(child.pid))).catch(() => {});
  }

  #forgetPid(child) {
    readFile(this.#pidFile, "utf8").then((t) => { if (Number(t) === child.pid) return rm(this.#pidFile, { force: true }); }).catch(() => {});
  }

  async #killStale() {
    let names = [];
    try { names = await readdir(this.#pidDir); } catch { return; }
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; } };
    const weekAgo = Date.now() - 7 * 86400_000;
    for (const name of names) {
      const file = path.join(this.#pidDir, name);
      // 顺手清掉一周前的临时配置文件（每次启动端口不同，会越攒越多）
      if (/^cloudflared-(named|named-token|quick-tunnel)-\d+\.yml$/.test(name)) {
        stat(file).then((st) => { if (st.mtimeMs < weekAgo) return rm(file, { force: true }); }).catch(() => {});
        continue;
      }
      const match = /^cloudflared(?:-(\d+))?\.pid$/.exec(name);
      if (!match) continue;
      const owner = Number(match[1] || 0);
      if (owner === process.pid || (owner && alive(owner))) continue;   // 别的实例还活着，不碰
      const pid = Number(await readFile(file, "utf8").catch(() => 0));
      await rm(file, { force: true }).catch(() => {});
      if (!pid || pid === this.child?.pid || !alive(pid)) continue;
      // PID 可能已被别的程序复用：确认进程名是 cloudflared 才动手
      const proc = await new Promise((resolve) => {
        const cmd = process.platform === "win32" ? ["tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]] : ["ps", ["-p", String(pid), "-o", "comm="]];
        execFile(cmd[0], cmd[1], { windowsHide: true, timeout: 5000 }, (error, stdout) => resolve(error ? "" : String(stdout)));
      });
      if (!/cloudflared/i.test(proc)) continue;
      try { process.kill(pid); this.onLog(`清理了上次残留的隧道进程（PID ${pid}）`); } catch { /* 没权限就算了 */ }
    }
  }

  async stop() {
    // 换一代：所有还在 await 里的 start / 重连 / 换方式 / 复查醒来后都会看到代次变了
    this.gen++;
    this.stopping = true;
    this.#stopIfaceWatch();
    this.#clearTimers();
    this.blocked = null;
    this.switching = false;
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000);
        child.on("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    if (this.relay) { await this.relay.stop().catch(() => {}); this.relay = null; }
    /*
     * 光把 this.child 置空不够：启动 / 重连可能正卡在 #buildPlan、#launch 的 await 里，
     * 等它们醒过来还是会把进程拉起来。这里等它们真的看到新代次退出，再兜底确认一次。
     */
    const pending = [];
    if (this.starting) pending.push(Promise.resolve(this.starting).catch(() => {}));
    if (this.reconnecting) pending.push(Promise.resolve(this.reconnecting).catch(() => {}));
    if (pending.length) {
      /*
       * 等待必须有上限：在途的 start / reconnect 可能正卡在慢探测里（最坏 20–30 秒），
       * 断开和退出不能陪着它一起卡住。正确性靠代次检查兜底（它们醒来会看到新代次），
       * 这里的等待只是保险；超时后下面还会再兜底确认一次 child。
       */
      let timer = null;
      await Promise.race([
        Promise.all(pending),
        new Promise((resolve) => { timer = setTimeout(resolve, 2000); }),
      ]);
      clearTimeout(timer);
    }
    if (this.child) await this.#killChild();
    this.route = null;
    this.publicUrl = null;
    this.connected = false;
    // 进程都停了，/ready 的旧结果和连续 0 计数没有意义，不能留给下一次启动
    this.ready = null;
    this.readyMisses = 0;
    this.startedAt = null;
    return this.status();
  }
}

/** 固定地址隧道的跨窗口互斥：同一域名/令牌只允许一个实例占用。 */
export class TunnelLease {
  constructor(resources, { dataHome = path.join(os.homedir(), ".bridge-replica") } = {}) {
    this.resources = [...resources];
    this.file = path.join(dataHome, "tunnel", `lease-${hash(resources.join("|")).slice(0, 16)}.json`);
  }
  async acquire() {
    await mkdir(path.dirname(this.file), { recursive: true });
    const existing = await readFile(this.file, "utf8").then(JSON.parse).catch(() => null);
    if (existing && Date.now() - existing.at < 30_000 && existing.pid !== process.pid) {
      const alive = await isProcessAlive(existing.pid);
      if (alive) throw new Error(`固定地址已被另一个实例占用（pid ${existing.pid}）。请换一个域名，或先停掉那个实例。`);
    }
    await writeFile(this.file, JSON.stringify({ resources: this.resources, pid: process.pid, at: Date.now() }), "utf8");
    return async () => { await rm(this.file, { force: true }).catch(() => {}); };
  }
}

function hash(value) {
  return Buffer.from(value).toString("base64url").replace(/[^a-z0-9]/gi, "").slice(0, 16) || randomUUID().slice(0, 16);
}

async function isProcessAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

