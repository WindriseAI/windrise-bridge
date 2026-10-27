/**
 * 激活（客户端）：输入激活码 → 服务器核销并绑定本机 → 拿到「Ed25519 签名、绑定本机设备 ID」的短期许可证。
 *
 * 判定只信签名：许可证由服务器私钥签发，这里用内置公钥验签，设备 ID 对不上、过期、被改过一个字节都无效。
 * 许可证最长 7 天（不超过激活到期时间），在线时自动续；断网最多用到许可证过期。
 * 防改时间：记下见过的最晚时间，判断过期时用「现在」和它中较晚的那个，把系统时间往回调没有用。
 *
 * 这是第 1 道检查。另外几道（main.cjs 隧道连上后 / 定时巡检、bridge.js 处理每个远程请求前、tunnel.js 启动前）
 * 各自独立读文件、独立验签，不调用这里的函数 —— 改掉其中一处，其它几处照样拦。
 *
 * 2026-10-26（任务 4a）从原软件 <本地路径> 原样移植，只加了一个开发开关 devLicenseBypass()。
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const AUDIENCE = "bridge-replica-desktop";
const RENEW_EVERY_MS = 12 * 3600_000;      // 在线时至少每 12 小时核对一次（能及时发现被停用的机器）
const RENEW_BEFORE_MS = 3 * 86_400_000;    // 许可证剩不到 3 天就续
const CLOCK_SLACK_MS = 10 * 60_000;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const KIND_NAME = { D: "天卡", M: "月卡", Y: "年卡" };

/* 公钥（SPKI DER，十六进制）。服务器 keys/license-private.pem 对应的那一把（老版本原样） */
const SPKI = "302a300506032b6570032100" + "fd00f2e4f064bdf619688d405bee6b7a" + "5e0346a113f46e71e072e1912b63fa58";
const PUBLIC_KEY = createPublicKey({ key: Buffer.from(SPKI, "hex"), format: "der", type: "spki" });

/** 开发开关的环境变量名（只给开发用，打包版本不读它） */
export const DEV_NO_LICENSE_ENV = "WINDRISE_DEV_NO_LICENSE";

/**
 * 开发开关：WINDRISE_DEV_NO_LICENSE=1 时跳过付费门槛（打通隧道前 / 隧道连上后 / 定时巡检 /
 * bridge 远程请求前、tunnel.js 启动前这几道检查全部放行）。打包版本（isPackaged=true）一律不认，
 * 防止把这个开关带进用户手里的安装包。
 */
export function devLicenseBypass({ env = process.env, isPackaged = false } = {}) {
  return isPackaged !== true && String(env?.[DEV_NO_LICENSE_ENV] ?? "") === "1";
}

export class ActivationError extends Error {
  constructor(message, code = "NOT_ACTIVATED", extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

/** 用户输入 → 规范形式；同时做格式和校验位检查（只为提前发现输错，真伪看服务器） */
export function parseActivationCode(input) {
  const code = String(input ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (!/^WR[DMY][0-9A-HJKMNP-TV-Z]{16}$/.test(code)) return null;
  const check = ALPHABET[createHash("sha256").update(`wr-check:${code.slice(0, 18)}`).digest()[0] & 31];
  if (check !== code[18]) return null;
  return { code, kind: code[2], kindName: KIND_NAME[code[2]], pretty: `${code.slice(0, 3)}-${code.slice(3, 7)}-${code.slice(7, 11)}-${code.slice(11, 15)}-${code.slice(15)}` };
}

function machineGuid() {
  return new Promise((resolve) => {
    if (process.platform === "darwin") {
      execFile("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeout: 5000 }, (error, stdout) => {
        const m = /"IOPlatformUUID"\s*=\s*"([0-9a-fA-F-]{36})"/.exec(String(stdout ?? ""));
        resolve(!error && m ? m[1].toLowerCase() : null);
      });
    } else if (process.platform === "win32") {
      execFile("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
        const m = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/.exec(String(stdout ?? ""));
        resolve(!error && m ? m[1].toLowerCase() : null);
      });
    } else {
      readFile("/etc/machine-id", "utf8").then((t) => resolve(t.trim() || null), () => resolve(null));
    }
  });
}

function decodeToken(token, key = PUBLIC_KEY) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  try {
    const ok = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"));
    if (!ok) return null;
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (header.alg !== "Ed25519") return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch { return null; }
}

export class ActivationClient {
  /**
   * @param {object} o
   * @param {string} o.apiBase   授权服务器
   * @param {string} o.dataHome  数据目录（activation.json 放这里）
   * @param {{encrypt:(s:string)=>string, decrypt:(s:string)=>string}} [o.protect]  设备密钥用系统钥匙串加密
   * @param {string} [o.publicKeyPem] 验签公钥（PEM）。自检注入口：不传就用内置的正式公钥，正常运行绝不传。
   */
  constructor({ apiBase, dataHome, protect, fetchImpl = fetch, publicKeyPem = null } = {}) {
    this.apiBase = String(apiBase || "").replace(/\/+$/, "");
    this.dataHome = dataHome;
    this.file = path.join(dataHome, "activation.json");
    this.protect = protect ?? { encrypt: (s) => s, decrypt: (s) => s };
    this.fetch = fetchImpl;
    /** 验签公钥：默认内置正式公钥；自检可以换自己的密钥对（模拟服务器也要用同一对签） */
    this.publicKey = publicKeyPem ? createPublicKey(publicKeyPem) : PUBLIC_KEY;
    this.state = null;
    this.devicePromise = null;
    this.renewing = null;
    this.lastOnline = null;
  }

  async #load() {
    if (this.state) return this.state;
    let parsed = {};
    try { parsed = JSON.parse(await readFile(this.file, "utf8")); } catch { parsed = {}; }
    this.state = parsed && typeof parsed === "object" ? parsed : {};
    return this.state;
  }

  async #save() {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify({ ...this.state, v: 1 }, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  /** 本机设备 ID：sha256("bridge-replica:" + 系统机器码) 前 32 位；读不到机器码才用存下来的随机 ID */
  device() {
    this.devicePromise ??= (async () => {
      const state = await this.#load();
      let guid = await machineGuid();
      if (!guid) {
        if (!state.fallbackId) { state.fallbackId = createHash("sha256").update(`${Date.now()}:${Math.random()}:${os.hostname()}`).digest("hex"); await this.#save(); }
        guid = state.fallbackId;
      }
      return {
        id: createHash("sha256").update(`bridge-replica:${guid}`).digest("hex").slice(0, 32),
        name: `${os.hostname()} · ${os.userInfo().username}`.slice(0, 80),
      };
    })();
    return this.devicePromise;
  }

  /** 防改时间：取「现在」和见过的最晚时间中较晚的那个 */
  async #now() {
    const state = await this.#load();
    const real = Date.now();
    const seen = Number(state.seen) || 0;
    if (real > seen + 60_000) { state.seen = real; await this.#save().catch(() => {}); }
    return { now: Math.max(real, seen), clockBack: real + CLOCK_SLACK_MS < seen };
  }

  /** 只看本地（不联网）：现在算不算已激活 */
  async status() {
    const state = await this.#load();
    const device = await this.device();
    const { now, clockBack } = await this.#now();
    const base = { deviceId: device.id, deviceName: device.name, clockBack, lastOnline: this.lastOnline, expiresAt: state.expiresAt ?? null };
    if (!state.token) return { ...base, activated: false, reason: state.lastError || "还没有激活", code: state.lastCode || "NOT_ACTIVATED" };
    const claims = decodeToken(state.token, this.publicKey);
    if (!claims) return { ...base, activated: false, reason: "本机的激活信息无效（可能被改动过），请重新输入激活码", code: "LICENSE_INVALID" };
    if (claims.kind !== "license" || claims.aud !== AUDIENCE || !Array.isArray(claims.features) || !claims.features.includes("bridge")) {
      return { ...base, activated: false, reason: "激活信息不完整，请重新输入激活码", code: "LICENSE_INVALID" };
    }
    if (claims.installation_id !== device.id) return { ...base, activated: false, reason: "激活信息不是这台电脑的（一码只能用在一台电脑上）", code: "DEVICE_MISMATCH" };
    if (claims.nbf && claims.nbf * 1000 > now + CLOCK_SLACK_MS) return { ...base, activated: false, reason: "电脑时间不对，请把系统时间调准", code: "CLOCK" };
    const expiresAt = claims.entitlement_exp ? claims.entitlement_exp * 1000 : null;
    const validUntil = claims.exp * 1000;
    const out = { ...base, expiresAt, validUntil, daysLeft: expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 86_400_000)) : null };
    if (expiresAt && expiresAt <= now) return { ...out, activated: false, reason: "激活已到期，请输入新的激活码续期", code: "EXPIRED" };
    if (validUntil <= now) return { ...out, activated: false, reason: "需要联网核对一次激活信息（已离线太久）", code: "NEED_ONLINE" };
    return { ...out, activated: true, needsRenew: validUntil - now < RENEW_BEFORE_MS || !state.renewedAt || now - state.renewedAt > RENEW_EVERY_MS };
  }

  async #request(method, urlPath, body) {
    if (!this.apiBase) throw new ActivationError("没有配置授权服务器地址", "NO_SERVER");
    let response;
    try {
      const init = {
        method,
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      };
      if (body !== undefined) {
        init.headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      response = await this.fetch(this.apiBase + urlPath, init);
    } catch (error) {
      throw new ActivationError(`连不上激活服务器，请检查网络后重试（${error.cause?.code || error.message}）`, "OFFLINE");
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ActivationError(data.message || `激活服务器返回 ${response.status}`, data.error || `HTTP_${response.status}`, { status: response.status, expiresAt: data.expiresAt });
    this.lastOnline = Date.now();
    return data;
  }

  #api(urlPath, body) {
    return this.#request("POST", urlPath, body);
  }

  #accept(data) {
    const claims = decodeToken(data.license, this.publicKey);
    if (!claims) throw new ActivationError("服务器返回的激活信息验签失败（可能连到了假的服务器）", "LICENSE_INVALID");
    const state = this.state;
    state.token = data.license;
    state.expiresAt = data.expiresAt ?? (claims.entitlement_exp ? claims.entitlement_exp * 1000 : null);
    state.renewedAt = Date.now();
    // 服务器时间说了算：本机时间曾经被调快过的，联网一次就恢复正常
    if (Number.isFinite(data.serverTime)) state.seen = Math.max(Date.now(), data.serverTime);
    delete state.lastError; delete state.lastCode;
  }

  /** 输入激活码 */
  async activate(input) {
    const parsed = parseActivationCode(input);
    if (!parsed) throw new ActivationError("激活码格式不对，请检查有没有输错（形如 WRM-XXXX-XXXX-XXXX-XXXX）", "CODE_FORMAT");
    const state = await this.#load();
    const device = await this.device();
    const data = await this.#api("/api/activate", { code: parsed.code, deviceId: device.id, deviceName: device.name, platform: process.platform });
    this.#accept(data);
    if (data.secret) state.secret = this.protect.encrypt(data.secret);
    await this.#save();
    return { status: await this.status(), addedDays: data.addedDays ?? 0, again: Boolean(data.again), kindName: parsed.kindName };
  }

  /** 只读价目：{ plans: [{ kind, name, days, price, available }] } */
  async plans() {
    return this.#request("GET", "/api/pay/plans");
  }

  /**
   * 软件内支付宝下单。kind 只能是 D / M / Y，返回服务器给的订单号和二维码图
   * （data:image/png;base64，客户端不需要二维码库）。
   */
  async createOrder(kind) {
    const normalized = String(kind ?? "").toUpperCase();
    if (!KIND_NAME[normalized]) throw new ActivationError("套餐类型不对（只能是 D / M / Y）", "BAD_KIND");
    const device = await this.device();
    return this.#api("/api/pay/orders", {
      kind: normalized,
      deviceId: device.id,
      deviceName: device.name,
      platform: process.platform,
    });
  }

  /**
   * 查订单。paid 时服务器会带回和 /api/activate 同样的激活结果，
   * 这里走和「输入激活码」完全一样的保存流程（验签、存许可证、加密设备密钥）。
   * 返回值不带许可证 / 设备密钥，避免被界面或日志转发出去。
   */
  async pollOrder(orderId) {
    const id = String(orderId ?? "");
    if (!/^[A-Za-z0-9_-]{6,80}$/.test(id)) throw new ActivationError("订单号不对", "BAD_ORDER_ID");
    const data = await this.#request("GET", `/api/pay/orders/${encodeURIComponent(id)}`);
    const { activation, ...order } = data;
    if (order.status !== "paid" || !activation?.license) return { ...order, activated: false };
    await this.#load();
    this.#accept(activation);
    if (activation.secret) this.state.secret = this.protect.encrypt(activation.secret);
    await this.#save();
    return {
      ...order,
      activated: true,
      activationStatus: await this.status(),
      addedDays: activation.addedDays ?? 0,
      kind: activation.kind ?? order.kind,
    };
  }

  /** 在线续期。离线时不报错，保留本地许可证 */
  async renew({ force = false } = {}) {
    if (this.renewing) return this.renewing;
    this.renewing = (async () => {
      const state = await this.#load();
      if (!state.secret) return this.status();
      if (!force) { const st = await this.status(); if (st.activated && !st.needsRenew) return st; }
      let secret;
      try { secret = this.protect.decrypt(state.secret); } catch { secret = null; }
      if (!secret) { state.token = null; state.lastError = "本机的激活信息读不出来了，请重新输入激活码"; await this.#save(); return this.status(); }
      const device = await this.device();
      try {
        this.#accept(await this.#api("/api/activate/renew", { deviceId: device.id, secret }));
        await this.#save();
      } catch (error) {
        if (error.code === "OFFLINE" || error.code === "RATE_LIMITED" || (error.status ?? 0) >= 500) { if (force) throw error; return this.status(); }
        // 服务器明确说不行（到期 / 被停用 / 密钥不对）：收回本地许可证
        state.token = null;
        state.lastError = error.message;
        state.lastCode = error.code;
        if (error.expiresAt) state.expiresAt = error.expiresAt;
        await this.#save();
      }
      return this.status();
    })().finally(() => { this.renewing = null; });
    return this.renewing;
  }

  /** 打通隧道前调用：没激活直接抛错，界面据 code 跳到激活页 */
  async ensure() {
    let st = await this.status();
    if (st.activated && st.needsRenew) this.renew().catch(() => {});
    if (!st.activated && st.code === "NEED_ONLINE") st = await this.renew({ force: true }).catch(() => st);
    if (!st.activated) throw new ActivationError(`${st.reason}。请到「激活」页输入激活码。`, "NOT_ACTIVATED", { reasonCode: st.code });
    return st;
  }
}
