/**
 * 许可与授权 —— 参照学习软件的授权体系（依据它的 bridge-license-config.ts /
 * bridge-license-claims.js / bridge-license-service.ts / bridge-payment-network.mts）。
 *
 * 真实结构（逆向所得）：
 *   - 许可证服务器：Cloudflare Worker（学习软件那份，地址已隐去）
 *   - 签名算法：Ed25519，**公钥内置在客户端**，私钥只在 Worker 的 secret 里
 *   - 令牌是 JWT：{ iss, aud:"<产品>-desktop", sub, exp, nbf?, iat?, kind:"license",
 *                  features:[...], installation_id, entitlement_exp }
 *   - 登录身份：GitHub OAuth（vscode 的 authentication API）或 Gitee OAuth
 *   - 付费：/v1/payments/plans 取套餐、/v1/payments/orders 下单（默认支付宝）、
 *           下单成功后本地起一个轮询器盯着订单状态，paid 就刷新授权
 *
 * 本文件把「服务端怎么签、客户端怎么验」两侧都实现出来，方便自建：
 *   verifyLicenseToken()  —— 客户端侧：验签 + 严格校验 claims（与学习软件同规则）
 *   issueLicenseToken()   —— 服务端侧：用你的私钥签一个（放你自己的 Worker / VPS 上）
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, timingSafeEqual, verify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/* ------------------------------------------------------------------ *
 * JWT 基础
 * ------------------------------------------------------------------ */

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (text) => Buffer.from(text, "base64url");

export function decodeJwt(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) throw new Error("令牌格式不合法（不是三段式 JWT）");
  const [headerPart, payloadPart, signaturePart] = parts;
  return {
    header: JSON.parse(fromB64u(headerPart).toString("utf8")),
    payload: JSON.parse(fromB64u(payloadPart).toString("utf8")),
    signature: fromB64u(signaturePart),
    signingInput: `${headerPart}.${payloadPart}`,
  };
}

/** 允许的时钟偏移（秒）：签发方和本机时间差这么多以内，不算「来自未来」。 */
const CLOCK_SKEW_SECONDS = 300;

const nonEmptyText = (value) => typeof value === "string" && value.trim() !== "";
const unixSeconds = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * 验签通过之后，再逐条核对令牌内容。规则写成一张表：每条是「说明 + 判定」，
 * 第一条不满足就拒绝，错误信息里带上说明，方便排查。
 *
 * 规则的取舍：
 *   - 签发方、用途（kind）、受众（aud，可以是字符串或数组）必须对得上，防止拿别的系统签的令牌来用；
 *   - 必须有主体（sub）和过期时间（exp），且还没过期；
 *   - 生效时间（nbf）和签发时间（iat）可省略，写了就不能晚于「现在 + 偏移」，也不能晚于过期时间；
 *   - 许可证（kind=license）还必须带功能清单和安装标识；权益截止时间若写了，必须还没到、且不早于令牌过期时间。
 */
export function validateLicenseClaims(claims, { now = Math.floor(Date.now() / 1000), issuer, audience, kind = "license" } = {}) {
  const isObject = claims !== null && typeof claims === "object" && !Array.isArray(claims);
  if (!isObject) throw new Error("令牌校验失败：内容不是一个对象");

  const audList = [].concat(claims.aud);
  const notInFuture = (value) => value === undefined || (unixSeconds(value) && value <= now + CLOCK_SKEW_SECONDS && value < claims.exp);

  const rules = [
    ["签发方或用途不符", () => claims.iss === issuer && claims.kind === kind],
    ["受众不符", () => audList.length > 0 && audList.every(nonEmptyText) && audList.includes(audience)],
    ["缺少主体", () => nonEmptyText(claims.sub)],
    ["缺少过期时间或已过期", () => unixSeconds(claims.exp) && claims.exp > now],
    ["生效时间不合法", () => notInFuture(claims.nbf)],
    ["签发时间不合法", () => notInFuture(claims.iat)],
  ];
  if (kind === "license") {
    const until = claims.entitlement_exp;
    rules.push(
      ["功能清单为空", () => Array.isArray(claims.features) && claims.features.length > 0 && claims.features.every(nonEmptyText)],
      ["缺少安装标识", () => nonEmptyText(claims.installation_id)],
      ["权益截止时间不合法", () => until === undefined || until === null || (unixSeconds(until) && until > now && claims.exp <= until)],
    );
  }

  const broken = rules.find(([, holds]) => !holds());
  if (broken) throw new Error(`令牌校验失败：${broken[0]}`);
  return true;
}

/* ------------------------------------------------------------------ *
 * 客户端侧：验签
 * ------------------------------------------------------------------ */

export class LicenseVerifier {
  /**
   * @param {object} options
   * @param {string} options.publicKeyPem Ed25519 公钥（内置在客户端，和学习软件一样）
   * @param {string} options.issuer        许可证服务器地址
   * @param {string} options.audience      固定值（学习软件用 "<产品>-desktop"，本作业用 bridge-replica-desktop）
   */
  constructor({ publicKeyPem, issuer, audience = "bridge-replica-desktop" } = {}) {
    this.publicKeyPem = publicKeyPem;
    this.issuer = issuer;
    this.audience = audience;
    this.publicKey = publicKeyPem ? createPublicKey(publicKeyPem) : null;
  }

  verify(token, { now, kind = "license" } = {}) {
    const decoded = decodeJwt(token);
    if (decoded.header.alg !== "Ed25519") throw new Error(`签名算法不受支持：${decoded.header.alg}（只接受 Ed25519）`);
    if (!this.publicKey) throw new Error("未配置许可证公钥，无法验签");
    const ok = verify(null, Buffer.from(decoded.signingInput), this.publicKey, decoded.signature);
    if (!ok) throw new Error("签名不通过：令牌可能被篡改，或并非本服务签发");
    // 修复：原来 kind 取的是令牌自己声明的 kind，等于没校验 —— 别的用途的令牌也能冒充许可证。
    validateLicenseClaims(decoded.payload, { now, issuer: this.issuer, audience: this.audience, kind });
    return { claims: decoded.payload, header: decoded.header };
  }

  /** 功能位检查：license 里的 features 数组就是「你能用哪些能力」的白名单。 */
  hasFeature(claims, feature) {
    return Array.isArray(claims?.features) && claims.features.includes(feature);
  }
}

/* ------------------------------------------------------------------ *
 * 服务端侧：签发（自建许可证服务器时用）
 * ------------------------------------------------------------------ */

export function generateLicenseKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/**
 * 签一个许可证令牌。
 * 注意：真实系统里这一步只在 Cloudflare Worker 的 secret 环境里做，私钥永不下发客户端。
 */
export function issueLicenseToken({ privateKeyPem, issuer, audience = "bridge-replica-desktop", subject, installationId, features = ["bridge"], ttlSeconds = 24 * 3600, entitlementExpiresAt = null }) {
  const key = createPrivateKey(privateKeyPem);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer,
    aud: audience,
    sub: subject,
    kind: "license",
    features,
    installation_id: installationId ?? randomUUID(),
    iat: now,
    nbf: now,
    exp: now + ttlSeconds,
    ...(entitlementExpiresAt ? { entitlement_exp: Math.floor(new Date(entitlementExpiresAt).getTime() / 1000) } : {}),
  };
  const header = { alg: "Ed25519", typ: "JWT" };
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const signature = sign(null, Buffer.from(signingInput), key);
  return `${signingInput}.${b64u(signature)}`;
}

/* ------------------------------------------------------------------ *
 * GitHub 授权：设备码流程（OAuth Device Flow）
 * ------------------------------------------------------------------ */

/**
 * 为什么需要 GitHub 账号：它是「你是谁」的唯一凭据来源。
 * 许可证服务器拿 GitHub 的 access_token 去调 GitHub API 确认身份，
 * 再把身份绑到一份签名的许可证上。客户端只验签名，不信任客户端自称的身份。
 */
export class GitHubDeviceFlow {
  constructor({ clientId, scopes = ["read:user"], onPrompt = () => {}, fetchImpl = fetch } = {}) {
    if (!clientId) throw new Error("需要 GitHub OAuth App 的 client_id（在 GitHub → Settings → Developer settings → OAuth Apps 创建）");
    this.clientId = clientId;
    this.scopes = scopes;
    this.onPrompt = onPrompt;
    this.fetch = fetchImpl;
  }

  async start() {
    const response = await this.fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: this.clientId, scope: this.scopes.join(" ") }),
    });
    if (!response.ok) throw new Error(`申请设备码失败：HTTP ${response.status}`);
    const data = await response.json();
    this.onPrompt({
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      expiresIn: data.expires_in,
      interval: data.interval ?? 5,
    });
    return data;
  }

  /** 轮询直到用户完成授权或超时。 */
  async waitForToken({ interval = 5, expiresIn = 900 } = {}) {
    const deadline = Date.now() + expiresIn * 1000;
    let waitMs = Math.max(interval, 1) * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, waitMs));
      const response = await this.fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ client_id: this.clientId, device_code: this.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
      });
      const data = await response.json().catch(() => ({}));
      if (data.access_token) return data.access_token;
      if (data.error === "authorization_pending") continue;
      if (data.error === "slow_down") { waitMs += 5000; continue; }
      if (data.error === "expired_token") throw new Error("设备码已过期，请重新开始授权");
      if (data.error === "access_denied") throw new Error("用户拒绝了授权");
      throw new Error(`授权失败：${data.error ?? "未知错误"} ${data.error_description ?? ""}`);
    }
    throw new Error("等待授权超时");
  }

  async authorize() {
    const start = await this.start();
    this.deviceCode = start.device_code;
    return this.waitForToken({ interval: start.interval, expiresIn: start.expires_in });
  }
}

/** 用 access_token 取身份；许可证服务器也用这一步核对「你确实是你」。 */
export async function fetchGitHubUser(accessToken, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl("https://api.github.com/user", {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": "bridge-replica" },
  });
  if (!response.ok) throw new Error(`读取 GitHub 身份失败：HTTP ${response.status}`);
  const user = await response.json();
  return { id: String(user.id), login: user.login, name: user.name ?? null, avatar: user.avatar_url ?? null };
}

/* ------------------------------------------------------------------ *
 * 本地授权状态持久化
 * ------------------------------------------------------------------ */

export class LicenseStore {
  constructor({ dataHome = path.join(os.homedir(), ".bridge-replica") } = {}) {
    this.file = path.join(dataHome, "license.json");
  }

  async read() {
    const raw = await readFile(this.file, "utf8").catch(() => null);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  async write(value) {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(value, null, 2), { mode: 0o600 });
    return value;
  }

  async clear() {
    await this.write({});
  }

  /** 把「身份 + 令牌 + 是否有效」汇总成 UI 要的一块状态。 */
  async status(verifier) {
    const stored = await this.read();
    if (!stored?.token) return { signedIn: false, licensed: false, reason: "未登录" };
    try {
      const { claims } = verifier.verify(stored.token);
      return {
        signedIn: true,
        licensed: true,
        account: stored.account ?? { login: claims.sub },
        features: claims.features,
        expiresAt: new Date(claims.exp * 1000).toISOString(),
        entitlementExpiresAt: claims.entitlement_exp ? new Date(claims.entitlement_exp * 1000).toISOString() : null,
        installationId: claims.installation_id,
      };
    } catch (error) {
      return { signedIn: true, licensed: false, account: stored.account ?? null, reason: error.message };
    }
  }
}

/** 常量时间比较，避免时序侧信道（授权判定用得上）。 */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/* ------------------------------------------------------------------ *
 * 付费骨架
 * ------------------------------------------------------------------ */

/** 对应学习软件的 /v1/payments/plans 返回结构。 */
export const DEFAULT_PLANS = [
  { planId: "monthly", name: "按月", amount: 15, currency: "CNY", days: 30 },
  { planId: "quarterly", name: "按季", amount: 40, currency: "CNY", days: 90 },
  { planId: "yearly", name: "按年", amount: 128, currency: "CNY", days: 365 },
];

export const PAYMENT_TYPES = ["alipay", "wechat"];

/**
 * 下单轮询器：参照学习软件的支付监视逻辑 —— 下单后本地起轮询，
 * 直到订单 paid / expired / failed；paid 就立刻刷新许可证。
 * 注意它的「不确定态」处理：POST 订单若超时，不能自动重发，只能让用户去查订单。
 */
export class PaymentMonitor {
  constructor({ poll, onPaid, onFailed = () => {}, intervalMs = 3000, maxAttempts = 200 } = {}) {
    this.poll = poll;
    this.onPaid = onPaid;
    this.onFailed = onFailed;
    this.intervalMs = intervalMs;
    this.maxAttempts = maxAttempts;
    this.timer = null;
    this.attempts = 0;
  }

  start(orderId) {
    this.stop();
    const tick = async () => {
      this.attempts++;
      try {
        const order = await this.poll(orderId);
        if (order.status === "paid") { this.stop(); await this.onPaid(order); return; }
        if (["expired", "failed", "refunded"].includes(order.status)) { this.stop(); this.onFailed(order); return; }
      } catch (error) {
        this.onFailed({ error: error.message, status: "unknown" });
      }
      if (this.attempts >= this.maxAttempts) { this.stop(); return; }
      this.timer = setTimeout(tick, this.intervalMs);
      this.timer.unref?.();
    };
    this.timer = setTimeout(tick, this.intervalMs);
    this.timer.unref?.();
    return { orderId, intervalMs: this.intervalMs };
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
