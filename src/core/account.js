/**
 * 账号 + 设备绑定 + 通道授权（客户端）。
 *
 * 三个通道开通前都要过这里：
 *   provider "cloudflare"        → 需要 tunnel:cloudflare-quick
 *   provider "cloudflare-named"  → 需要 tunnel:cloudflare-named
 *   provider "ngrok"             → 需要 tunnel:ngrok
 * 本地 MCP 桥本身（127.0.0.1）不收费，方便客户先试用。
 *
 * 授权判定只信「服务端用私钥签发、本地用内置公钥验过签、installation_id 等于本机设备 ID」的许可证。
 * 许可证默认 7 天有效，在线时自动续；断网也能用到许可证过期为止。
 */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LicenseVerifier } from "./license.js";

export const CHANNEL_FEATURES = {
  "cloudflare": "tunnel:cloudflare-quick",
  "cloudflare-named": "tunnel:cloudflare-named",
  "ngrok": "tunnel:ngrok",
};

export const CHANNEL_LABELS = {
  "tunnel:cloudflare-quick": "Cloudflare 快速隧道",
  "tunnel:cloudflare-named": "Cloudflare 命名隧道",
  "tunnel:ngrok": "ngrok 隧道",
};

const RENEW_BEFORE_MS = 3 * 86_400_000;   // 剩不到 3 天就在线续期

export class ChannelLockedError extends Error {
  constructor(feature, reason) {
    super(`「${CHANNEL_LABELS[feature] ?? feature}」还没有开通：${reason}。请到「账号与开通」页登录并开通。`);
    this.code = "CHANNEL_LOCKED";
    this.feature = feature;
  }
}

/** 读 Windows 的 MachineGuid / Mac 的 IOPlatformUUID（重装系统才会变）；读不到就用持久化的随机 ID */
function readMachineGuid() {
  if (process.platform === "darwin") {
    return new Promise((resolve) => {
      execFile("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeout: 5000 }, (error, stdout) => {
        const match = /"IOPlatformUUID"\s*=\s*"([0-9a-fA-F-]{36})"/.exec(String(stdout ?? ""));
        resolve(!error && match ? match[1].toLowerCase() : null);
      });
    });
  }
  if (process.platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error) return resolve(null);   // 报错文字是 GBK，别解析，直接走兜底
      const match = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/.exec(String(stdout));
      resolve(match ? match[1].toLowerCase() : null);
    });
  });
}

export class AccountClient {
  /**
   * @param {object} options
   * @param {string} options.apiBase       例如 https://api.example.com
   * @param {string} options.publicKeyPem  许可证公钥（server 的 npm run keygen 生成）
   * @param {string} options.issuer
   * @param {string} [options.audience]
   * @param {string} options.dataHome
   * @param {{encrypt:(s:string)=>string, decrypt:(s:string)=>string}} [options.protect]  主进程传 safeStorage 加密
   */
  constructor({ apiBase, publicKeyPem, issuer, audience = "bridge-replica-desktop", dataHome, protect, fetchImpl = fetch, machineId } = {}) {
    this.apiBase = String(apiBase || "").replace(/\/+$/, "");
    this.verifier = publicKeyPem ? new LicenseVerifier({ publicKeyPem, issuer: issuer || this.apiBase, audience }) : null;
    this.file = path.join(dataHome ?? (process.env.BRIDGE_DATA_HOME?.trim() || path.join(os.homedir(), ".bridge-replica")), "account.json");
    this.protect = protect ?? { encrypt: s => s, decrypt: s => s };
    this.fetch = fetchImpl;
    this.machineIdOverride = machineId;
    this.state = null;
  }

  get configured() { return Boolean(this.apiBase && this.verifier); }

  /* ---------------- 本地存储 ---------------- */

  async #load() {
    if (this.state) return this.state;
    const raw = await readFile(this.file, "utf8").catch(() => null);
    let parsed = {};
    try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }
    let session = null;
    try { session = parsed.session ? await this.protect.decrypt(parsed.session) : null; } catch { session = null; }
    this.state = { ...parsed, session };
    return this.state;
  }

  async #save() {
    const { session, ...rest } = this.state;
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify({ ...rest, session: session ? await this.protect.encrypt(session) : null }, null, 2), { mode: 0o600 });
  }

  async device() {
    const state = await this.#load();
    if (!state.deviceId) {
      const guid = this.machineIdOverride ?? await readMachineGuid() ?? randomUUID();
      state.deviceId = createHash("sha256").update(`bridge-replica:${guid}`).digest("hex").slice(0, 32);
      await this.#save();
    }
    return { id: state.deviceId, name: `${os.hostname()} · ${os.userInfo().username}` };
  }

  /* ---------------- 网络 ---------------- */

  async #api(method, urlPath, body, { auth = true, timeout = 15_000, signal } = {}) {
    if (!this.apiBase) throw new Error("没有配置授权服务器地址（electron/license-config.json 里的 apiBase）");
    const state = await this.#load();
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth && state.session) headers.authorization = `Bearer ${state.session}`;
    let response;
    try {
      response = await this.fetch(this.apiBase + urlPath, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
    } catch (error) {
      if (signal?.aborted) throw error;
      const offline = new Error(`连不上授权服务器：${error.message}`);
      offline.code = "OFFLINE";
      throw offline;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.message || `HTTP ${response.status}`);
      Object.assign(error, data, { code: data.error || `HTTP_${response.status}`, status: response.status });
      if (response.status === 401) { state.session = null; state.license = null; await this.#save(); }
      throw error;
    }
    return data;
  }

  async sendCode(email) {
    return this.#api("POST", "/api/auth/send-code", { email }, { auth: false });
  }

  async login(email, code) {
    const device = await this.device();
    const data = await this.#api("POST", "/api/auth/login", { email, code, device }, { auth: false });
    const state = await this.#load();
    state.session = data.token;
    state.account = data.user;
    state.license = null;
    await this.#save();
    let license = null;
    if (!data.deviceError) license = await this.refreshLicense().catch(error => ({ error: error.message }));
    return { user: data.user, deviceError: data.deviceError, license };
  }

  async logout() {
    await this.#api("POST", "/api/auth/logout", {}).catch(() => {});
    const state = await this.#load();
    state.session = null;
    state.account = null;
    state.license = null;
    await this.#save();
    return { ok: true };
  }

  me() { return this.#api("GET", "/api/me"); }
  /** AI 助手：服务器转发（服务器出 Key，按人按天限额）。返回 { message, cost, usage } */
  aiChat({ messages, tools }, { signal } = {}) { return this.#api("POST", "/api/ai/chat", { messages, tools }, { timeout: 120_000, signal }); }
  /** 今天的 AI 额度：{ usage: { day, budgetMicro, spentMicro, leftMicro, requests, configured } } */
  aiUsage() { return this.#api("GET", "/api/ai/usage"); }
  plans() { return this.#api("GET", "/api/plans", undefined, { auth: false }); }
  createOrder(planId, channel) { return this.#api("POST", "/api/orders", { planId, channel }); }

  async order(orderId) {
    const data = await this.#api("GET", `/api/orders/${encodeURIComponent(orderId)}`);
    if (data.order?.status === "paid") await this.refreshLicense().catch(() => {});  // 付完马上换新许可证
    return data;
  }

  async unbindDevice(deviceId) {
    return this.#api("DELETE", `/api/devices/${encodeURIComponent(deviceId)}`, {});
  }

  async refreshLicense() {
    const device = await this.device();
    const data = await this.#api("POST", "/api/license", { deviceId: device.id, deviceName: device.name });
    const state = await this.#load();
    state.license = data.license ?? null;
    state.licenseCheckedAt = Date.now();
    await this.#save();
    return { features: data.features ?? [], expiresAt: data.expiresAt ?? null };
  }

  /* ---------------- 本地判定 ---------------- */

  /** 只做本地验签，不联网 */
  async localStatus() {
    const state = await this.#load();
    const device = await this.device();
    const base = { configured: this.configured, loggedIn: Boolean(state.session), account: state.account ?? null, deviceId: device.id, deviceName: device.name };
    if (!state.license) return { ...base, licensed: false, features: [], reason: state.session ? "账号下还没有开通通道" : "未登录" };
    if (!this.verifier) return { ...base, licensed: false, features: [], reason: "客户端没有内置许可证公钥" };
    try {
      const { claims } = this.verifier.verify(state.license);
      if (claims.installation_id !== device.id) return { ...base, licensed: false, features: [], reason: "许可证不属于这台设备" };
      return {
        ...base, licensed: true, features: claims.features,
        licenseExpiresAt: claims.exp * 1000,
        entitlementExpiresAt: claims.entitlement_exp ? claims.entitlement_exp * 1000 : null,
      };
    } catch (error) {
      return { ...base, licensed: false, features: [], reason: error.message };
    }
  }

  /** 本地状态 + 需要时在线续期（断网不报错，沿用本地） */
  async status({ renew = true } = {}) {
    let status = await this.localStatus();
    const due = !status.licensed || (status.licenseExpiresAt - Date.now() < RENEW_BEFORE_MS);
    if (renew && status.loggedIn && due && this.apiBase) {
      try { await this.refreshLicense(); status = await this.localStatus(); }
      catch (error) { status = { ...status, renewError: error.message, renewErrorCode: error.code }; }
    }
    return status;
  }

  /** 开隧道前调用：没开通就抛 ChannelLockedError */
  async ensureChannel(provider) {
    const feature = CHANNEL_FEATURES[provider];
    if (!feature) throw new Error(`未知通道：${provider}`);
    let status = await this.localStatus();
    if (status.licensed && status.features.includes(feature)) {
      // 后台续期，不阻塞
      if (status.licenseExpiresAt - Date.now() < RENEW_BEFORE_MS) this.status().catch(() => {});
      return status;
    }
    // 本地没有：可能刚付完款，在线拉一次
    status = await this.status();
    if (status.licensed && status.features.includes(feature)) return status;
    throw new ChannelLockedError(feature, status.renewErrorCode === "DEVICE_LIMIT" ? "设备数已满，请先解绑一台" : status.reason || status.renewError || "未开通");
  }
}
