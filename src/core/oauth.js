/**
 * 隧道 OAuth（默认关闭）—— 一个只服务本 Bridge 的极简授权服务器。
 *
 * 为什么自己带一个 AS，而不是接 Keycloak / Auth0 / Hydra：
 *   1. 这是单用户单机桌面应用，受保护的资源只有本 Bridge 自己的 /mcp，没有多租户、没有上游 IdP；
 *   2. 「同意」这一步必须发生在**这台电脑上**（远程浏览器看不到口令，也不该看到），
 *      外置 AS 做不到本机配对确认，只能再搭一套回调通道；
 *   3. 隧道地址经常变（快速隧道），外置 AS 的 issuer / 回调配置跟着变，普通用户配不动；
 *   4. 内置 AS 不引入外部服务依赖，离线也能完成授权。
 * 代价是安全边界要自己守住。这里只实现 MCP 客户端真正需要的最小集合：
 *   authorization_code + refresh_token、public client（无 client_secret）、PKCE S256、
 *   精确 redirect_uri、短期 access token、轮换 refresh token、audience 绑定、哈希存储、可吊销。
 * 不实现 implicit / password / client_credentials / CIMD / OIDC / 用户体系。
 *
 * 设计文档：docs/oauth-design.md
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isTunnelRequest } from "./bearer-auth.js";
import { TOOL_GROUPS, normalizeScope } from "./tool-policy.js";

/** OAuth 作用域直接复用 tool-policy 的工具分组名，不做第二套命名。 */
export const OAUTH_GROUPS = TOOL_GROUPS;
/** 新授权默认给的分组：只读 + 导航。写和管理必须由本机的人明确勾选。 */
export const DEFAULT_OAUTH_GROUPS = Object.freeze(["read", "navigate"]);

const ACCESS_PREFIX = "wro_";
const REFRESH_PREFIX = "wrr_";
const CODE_PREFIX = "wra_";
const ACCESS_TOKEN_RE = new RegExp(`^${ACCESS_PREFIX}[A-Za-z0-9_-]{43}$`);
const REFRESH_TOKEN_RE = new RegExp(`^${REFRESH_PREFIX}[A-Za-z0-9_-]{43}$`);
const CODE_RE = new RegExp(`^${CODE_PREFIX}[A-Za-z0-9_-]{43}$`);
const HASH_RE = /^[a-f0-9]{64}$/;
const CLIENT_ID_RE = /^wrc_[A-Za-z0-9_-]{10,64}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const MAX_REVOKED = 500;

function hashValue(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function randomToken(prefix) {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function sameString(a, b) {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function field(input, name) {
  if (input instanceof URLSearchParams) return input.get(name);
  const value = input?.[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function cleanName(value, fallback) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
  return text || fallback;
}

/** 只保留已知分组，顺序固定为 read / navigate / write / admin，去重。 */
export function normalizeOAuthGroups(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const group = String(item ?? "").trim().toLowerCase();
    if (OAUTH_GROUPS.includes(group) && !out.includes(group)) out.push(group);
  }
  return out;
}

/** 客户端 scope 字符串 -> 分组。一个已知分组都没有时按 invalid_scope 处理。 */
function parseScope(value) {
  const text = String(value ?? "").trim();
  if (!text) return { ok: true, groups: null };
  const parts = text.split(/\s+/).filter(Boolean);
  const groups = OAUTH_GROUPS.filter((group) => parts.includes(group));
  if (!groups.length) return { ok: false, groups: [] };
  // 不认识的 scope 直接忽略（有些客户端会带 openid / profile），已知的照常授权
  return { ok: true, groups };
}

/** AS / PRM 里用的 issuer：只取 origin，去掉末尾斜杠和 /mcp 后缀。 */
export function normalizeOAuthBase(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function firstHeader(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw ?? "").split(",")[0].trim().toLowerCase();
}

/** 请求自己带出来的 base：优先 x-forwarded-host / Host，协议优先 x-forwarded-proto。 */
export function oauthRequestBase(req) {
  const host = firstHeader(req?.headers?.["x-forwarded-host"] ?? req?.headers?.host);
  if (!host || !/^[a-z0-9.\-:\[\]]+$/.test(host)) return null;
  const forwarded = firstHeader(req?.headers?.["x-forwarded-proto"]);
  const proto = forwarded === "https" || forwarded === "http"
    ? forwarded
    : (isTunnelRequest(req?.headers) ? "https" : "http");
  try {
    // 用 URL 再规范化一次：默认端口（https:443 / http:80）会被去掉，audience 不会因为 Host 带不带端口而对不上
    const url = new URL(`${proto}://${host}`);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/** resource 参数规范化：保留 origin + path（去掉末尾斜杠），不接受 query / fragment。 */
export function normalizeOAuthResource(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.search || url.hash) return null;
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

/** 浏览器客户端的回调：HTTPS，或本机回环地址上的 HTTP（RFC 8252）。 */
export function isAllowedRedirectUri(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    const host = url.hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

function newPairingCode() {
  const bytes = randomBytes(8);
  let text = "";
  for (let i = 0; i < 8; i++) text += PAIRING_ALPHABET[bytes[i] % PAIRING_ALPHABET.length];
  return `${text.slice(0, 4)}-${text.slice(4)}`;
}

function normalizePairingCode(value) {
  const text = String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return text.length === 8 ? `${text.slice(0, 4)}-${text.slice(4)}` : text;
}

/**
 * OAuth 配置。默认关闭；只有 enabled === true 时 Bridge 才会挂载端点。
 * 所有时长单位都是秒（测试可以直接传 now 假时钟）。
 */
export function createOAuthConfig(raw = {}) {
  const seconds = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  };
  const defaults = normalizeOAuthGroups(raw.defaultGroups ?? DEFAULT_OAUTH_GROUPS);
  return {
    enabled: raw.enabled === true,
    /** 固定公网 base；不传就从每个请求的 Host / 转发头推。 */
    publicBaseUrl: raw.publicBaseUrl ?? null,
    accessTokenTtlMs: Math.max(1, Math.round(seconds(raw.accessTokenTtlSeconds, 15 * 60) * 1000)),
    refreshTokenTtlMs: Math.max(1, Math.round(seconds(raw.refreshTokenTtlSeconds, 30 * 24 * 60 * 60) * 1000)),
    codeTtlMs: Math.max(1, Math.round(seconds(raw.codeTtlSeconds, 5 * 60) * 1000)),
    pendingTtlMs: Math.max(1, Math.round(seconds(raw.pendingTtlSeconds, 5 * 60) * 1000)),
    maxClients: Math.max(1, Math.floor(Number(raw.maxClients) || 50)),
    registrationLimit: Math.max(1, Math.floor(Number(raw.registrationLimit) || 10)),
    registrationWindowMs: Math.max(1, Math.round(seconds(raw.registrationWindowSeconds, 60 * 60) * 1000)),
    maxPending: Math.max(1, Math.floor(Number(raw.maxPending) || 16)),
    defaultGroups: defaults.length ? defaults : [...DEFAULT_OAUTH_GROUPS],
    now: typeof raw.now === "function" ? raw.now : Date.now,
  };
}

/**
 * OAuth 状态：客户端、访问令牌、刷新令牌、吊销记录、内存里的待确认授权。
 *
 * 磁盘上只有客户端元数据 + **令牌哈希**；授权码 / 配对码只存在于内存，重启即失效。
 * 文件坏了另存一份再当空表，绝不因为一个配置文件让 Bridge 起不来。
 */
export class OAuthStore {
  #file;
  #config;
  #clients = new Map();
  #access = new Map();
  #refresh = new Map();
  #revoked = [];
  /** 待确认 / 已确认但还没换令牌的授权请求，只存在内存里 */
  #pending = new Map();
  /** 授权码哈希 -> pending id；换过令牌就删掉 */
  #codes = new Map();
  /** DCR 限速：ip -> { count, resetAt } */
  #registerHits = new Map();
  #readOnly = false;

  constructor({ file, ...raw } = {}) {
    if (!file) throw new Error("OAuthStore 需要 file");
    this.#file = file;
    this.#config = createOAuthConfig(raw);
    this.#load();
  }

  get file() {
    return this.#file;
  }

  get enabled() {
    return this.#config.enabled === true;
  }

  get config() {
    return this.#config;
  }

  /* ------------------------------------------------------------------ *
   * 地址与元数据
   * ------------------------------------------------------------------ */

  /** 本次请求对应的公网 base：显式配置优先，否则按请求头推。 */
  resolveBase(req = null) {
    const configured = typeof this.#config.publicBaseUrl === "function"
      ? this.#config.publicBaseUrl()
      : this.#config.publicBaseUrl;
    const normalized = normalizeOAuthBase(configured);
    if (normalized) return normalized;
    return oauthRequestBase(req);
  }

  /** access token 的 audience 就是本 Bridge 的公网 MCP 地址。 */
  audienceFor(req = null) {
    const base = this.resolveBase(req);
    return base ? `${base}/mcp` : null;
  }

  protectedResourceMetadata(base) {
    return {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: [...OAUTH_GROUPS],
      bearer_methods_supported: ["header"],
      resource_name: "Windrise Bridge MCP",
    };
  }

  authorizationServerMetadata(base) {
    return {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      revocation_endpoint: `${base}/revoke`,
      scopes_supported: [...OAUTH_GROUPS],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      // 这一版没有实现 CIMD；显式写 false，让支持 CIMD 的客户端回退到 DCR。
      client_id_metadata_document_supported: false,
      authorization_response_iss_parameter_supported: true,
    };
  }

  /* ------------------------------------------------------------------ *
   * 本机确认状态
   * ------------------------------------------------------------------ */

  #now() {
    const value = Number(this.#config.now());
    return Number.isFinite(value) ? value : Date.now();
  }

  #prunePending(now) {
    for (const [id, pending] of [...this.#pending]) {
      if (pending.expiresAt <= now) {
        if (pending.codeHash) this.#codes.delete(pending.codeHash);
        this.#pending.delete(id);
      }
    }
  }

  #findPending(reference, now = this.#now()) {
    const ref = String(reference ?? "").trim();
    if (!ref) return null;
    let pending = this.#pending.get(ref) ?? null;
    if (!pending) {
      const pairing = normalizePairingCode(ref);
      pending = [...this.#pending.values()].find((item) => item.pairingCode === pairing) ?? null;
    }
    if (!pending) return null;
    if (pending.expiresAt <= now) {
      if (pending.codeHash) this.#codes.delete(pending.codeHash);
      this.#pending.delete(pending.id);
      return null;
    }
    return pending;
  }

  #publicPending(pending) {
    return {
      requestId: pending.id,
      pairingCode: pending.pairingCode,
      clientId: pending.clientId,
      clientName: pending.clientName,
      redirectUri: pending.redirectUri,
      state: pending.state,
      issuer: pending.issuer,
      requestedGroups: [...pending.requestedGroups],
      createdAt: pending.createdAt,
      expiresAt: pending.expiresAt,
      approvedAt: pending.approvedAt ?? null,
      deniedAt: pending.deniedAt ?? null,
    };
  }

  /** 本机调试入口 / 以后的确认 UI 用：列出所有等着人确认的请求。 */
  pendingList() {
    const now = this.#now();
    this.#prunePending(now);
    return [...this.#pending.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((pending) => this.#publicPending(pending));
  }

  /** 打开 /authorize?request=... 时看状态。 */
  pendingState(id) {
    const now = this.#now();
    const pending = this.#pending.get(String(id ?? ""));
    if (!pending) return { status: "unknown" };
    if (pending.deniedAt) return { status: "denied", pending: this.#publicPending(pending) };
    if (pending.expiresAt <= now) {
      if (pending.codeHash) this.#codes.delete(pending.codeHash);
      this.#pending.delete(pending.id);
      return { status: "expired" };
    }
    if (pending.usedAt) return { status: "used", pending: this.#publicPending(pending) };
    if (pending.approvedAt) {
      if (pending.deliveredAt) return { status: "delivered", pending: this.#publicPending(pending) };
      if (pending.codeExpiresAt <= now) return { status: "code_expired", pending: this.#publicPending(pending) };
      return { status: "approved", pending: this.#publicPending(pending) };
    }
    return { status: "pending", pending: this.#publicPending(pending) };
  }

  /**
   * 本机确认通过后，浏览器下一次刷新 /authorize 时把授权码取走。
   * 只给一次：取过之后标记 delivered，刷新页面不会再发一遍。
   */
  takeCode(id) {
    const now = this.#now();
    const pending = this.#pending.get(String(id ?? ""));
    if (!pending || !pending.approvedAt || pending.deniedAt) return null;
    if (pending.usedAt || pending.deliveredAt) return null;
    if (pending.expiresAt <= now || pending.codeExpiresAt <= now) return null;
    pending.deliveredAt = now;
    return pending.code ?? null;
  }

  /**
   * 本机确认。first 版没有 UI：内部函数 + 本机调试入口（tools/oauth-debug.mjs）。
   * groups 不传 = 用配置里的默认分组（read+navigate）；显式传空数组 = 一个分组都不给。
   */
  approve(reference, { groups } = {}) {
    const now = this.#now();
    const pending = this.#findPending(reference, now);
    if (!pending) return { ok: false, status: 404, error: "invalid_request", description: "配对请求不存在或已过期" };
    if (pending.deniedAt) return { ok: false, status: 409, error: "access_denied", description: "这个请求已经被拒绝" };
    if (pending.approvedAt) return { ok: true, pending: this.#publicPending(pending) };

    const selection = groups === undefined
      ? [...this.#config.defaultGroups]
      : normalizeOAuthGroups(groups);
    // 授权不能超过客户端请求的 scope：默认 read+navigate，但客户端只要了 write 时要人明确选 write
    const granted = pending.requestedGroups.filter((group) => selection.includes(group));
    if (!granted.length && selection.length) {
      return {
        ok: false,
        status: 400,
        error: "invalid_scope",
        description: `选择的分组不在客户端请求的范围内（客户端要：${pending.requestedGroups.join("/")}）`,
      };
    }

    pending.approvedAt = now;
    pending.grantedGroups = granted;
    pending.code = randomToken(CODE_PREFIX);
    pending.codeHash = hashValue(pending.code);
    pending.codeExpiresAt = now + this.#config.codeTtlMs;
    this.#codes.set(pending.codeHash, pending.id);
    return { ok: true, pending: this.#publicPending(pending) };
  }

  deny(reference) {
    const now = this.#now();
    const pending = this.#findPending(reference, now);
    if (!pending) return { ok: false, status: 404, error: "invalid_request", description: "配对请求不存在或已过期" };
    if (pending.deniedAt) return { ok: true, pending: this.#publicPending(pending) };
    pending.deniedAt = now;
    if (pending.codeHash) this.#codes.delete(pending.codeHash);
    return { ok: true, pending: this.#publicPending(pending) };
  }

  /* ------------------------------------------------------------------ *
   * 动态客户端注册（DCR）
   * ------------------------------------------------------------------ */

  #rateLimit(ip, now) {
    const key = String(ip || "unknown");
    const entry = this.#registerHits.get(key);
    if (!entry || now >= entry.resetAt) {
      this.#registerHits.set(key, { count: 1, resetAt: now + this.#config.registrationWindowMs });
      return null;
    }
    if (entry.count >= this.#config.registrationLimit) {
      return { retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
    }
    entry.count++;
    return null;
  }

  /**
   * POST /register。只发 client_id，不发 client_secret（public client）。
   * 限速按来源 IP，另有全局客户端数量上限；两个都返回 429，让客户端过一会儿再试。
   */
  register(input = {}, { ip = "unknown" } = {}) {
    const now = this.#now();
    const limited = this.#rateLimit(ip, now);
    if (limited) {
      return {
        status: 429,
        headers: { "retry-after": String(limited.retryAfter) },
        body: { error: "temporarily_unavailable", error_description: "注册太频繁，请稍后再试" },
      };
    }
    if (this.#clients.size >= this.#config.maxClients) {
      return {
        status: 429,
        headers: { "retry-after": "3600" },
        body: { error: "temporarily_unavailable", error_description: `客户端数量已达上限（${this.#config.maxClients}）` },
      };
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { status: 400, body: { error: "invalid_client_metadata", error_description: "请求体必须是 JSON 对象" } };
    }

    const method = String(input.token_endpoint_auth_method ?? "none");
    if (method !== "none") {
      return { status: 400, body: { error: "invalid_client_metadata", error_description: "只支持 public client（token_endpoint_auth_method=none）" } };
    }
    const grantTypes = Array.isArray(input.grant_types) ? input.grant_types.map(String) : ["authorization_code", "refresh_token"];
    const allowedGrants = new Set(["authorization_code", "refresh_token"]);
    if (!grantTypes.length || grantTypes.some((type) => !allowedGrants.has(type))) {
      return { status: 400, body: { error: "invalid_client_metadata", error_description: "只支持 authorization_code / refresh_token" } };
    }
    const responseTypes = Array.isArray(input.response_types) ? input.response_types.map(String) : ["code"];
    if (!responseTypes.length || responseTypes.some((type) => type !== "code")) {
      return { status: 400, body: { error: "invalid_client_metadata", error_description: "只支持 response_type=code" } };
    }

    const redirects = [];
    for (const item of Array.isArray(input.redirect_uris) ? input.redirect_uris : []) {
      const value = String(item ?? "").trim();
      if (!value || !isAllowedRedirectUri(value)) {
        return { status: 400, body: { error: "invalid_redirect_uri", error_description: `回调地址不合法：${value.slice(0, 120)}` } };
      }
      if (!redirects.includes(value) && redirects.length < 10) redirects.push(value);
    }
    if (!redirects.length) {
      return { status: 400, body: { error: "invalid_redirect_uri", error_description: "至少需要一个 HTTPS 或本机回环地址的回调" } };
    }

    let fallback = "未命名客户端";
    try { fallback = new URL(redirects[0]).hostname || fallback; } catch { /* 上面已经校验过 */ }
    const clientName = cleanName(input.client_name, fallback);
    let clientId;
    do { clientId = `wrc_${randomBytes(16).toString("base64url")}`; } while (this.#clients.has(clientId));

    const client = {
      clientId,
      clientName,
      redirectUris: redirects,
      createdAt: now,
      lastUsedAt: 0,
    };
    this.#clients.set(clientId, client);
    try {
      this.#persist();
    } catch (error) {
      this.#clients.delete(clientId);
      return { status: 503, body: { error: "temporarily_unavailable", error_description: error.message } };
    }
    return {
      status: 201,
      body: {
        client_id: clientId,
        client_id_issued_at: Math.floor(now / 1000),
        client_name: clientName,
        redirect_uris: [...redirects],
        grant_types: grantTypes,
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * 授权请求与授权码
   * ------------------------------------------------------------------ */

  /**
   * GET /authorize 的第一跳：校验客户端 / 回调 / PKCE / audience，生成一个待确认请求。
   * 真正的发码要等本机 approve()。
   */
  beginAuthorization(params, { base } = {}) {
    const expectedBase = normalizeOAuthBase(base);
    if (!expectedBase) {
      return { ok: false, status: 400, error: "invalid_request", description: "无法确定公网地址，OAuth 授权暂不可用" };
    }
    const audience = `${expectedBase}/mcp`;
    const now = this.#now();

    if (field(params, "response_type") !== "code") {
      return { ok: false, status: 400, error: "unsupported_response_type", description: "只支持 response_type=code" };
    }
    const clientId = String(field(params, "client_id") ?? "");
    const client = this.#clients.get(clientId);
    if (!client) {
      return { ok: false, status: 400, error: "invalid_client", description: "不认识这个 client_id，请先注册客户端" };
    }
    const redirectUri = String(field(params, "redirect_uri") ?? "");
    if (!client.redirectUris.includes(redirectUri)) {
      return { ok: false, status: 400, error: "invalid_request", description: "redirect_uri 与注册时不一致" };
    }
    const method = String(field(params, "code_challenge_method") ?? "");
    if (method !== "S256") {
      return { ok: false, status: 400, error: "invalid_request", description: "只接受 PKCE S256（不支持 plain）" };
    }
    const challenge = String(field(params, "code_challenge") ?? "");
    if (!CHALLENGE_RE.test(challenge)) {
      return { ok: false, status: 400, error: "invalid_request", description: "code_challenge 格式不对" };
    }
    const state = String(field(params, "state") ?? "");
    if (state.length > 1024) {
      return { ok: false, status: 400, error: "invalid_request", description: "state 太长" };
    }
    const resource = field(params, "resource");
    if (resource !== null && resource !== undefined && resource !== "") {
      const normalizedResource = normalizeOAuthResource(resource);
      if (normalizedResource !== audience) {
        return { ok: false, status: 400, error: "invalid_target", description: "resource 不是这个 Bridge 的 MCP 地址" };
      }
    }
    const scoped = parseScope(field(params, "scope"));
    if (!scoped.ok) {
      return { ok: false, status: 400, error: "invalid_scope", description: "没有可识别的 scope" };
    }

    this.#prunePending(now);
    if (this.#pending.size >= this.#config.maxPending) {
      return { ok: false, status: 503, error: "temporarily_unavailable", description: "待确认的授权请求太多，请稍后再试" };
    }

    let id;
    do { id = randomBytes(16).toString("hex"); } while (this.#pending.has(id));
    let pairingCode;
    do { pairingCode = newPairingCode(); } while ([...this.#pending.values()].some((item) => item.pairingCode === pairingCode));

    const pending = {
      id,
      clientId,
      clientName: client.clientName,
      redirectUri,
      state,
      audience,
      issuer: expectedBase,
      challenge,
      // 客户端没写 scope = 四个分组都算「可请求」，但默认只批 read+navigate
      requestedGroups: scoped.groups ?? [...OAUTH_GROUPS],
      pairingCode,
      createdAt: now,
      expiresAt: now + this.#config.pendingTtlMs,
      approvedAt: null,
      deniedAt: null,
      code: null,
      codeHash: null,
      codeExpiresAt: null,
      deliveredAt: null,
      usedAt: null,
    };
    this.#pending.set(id, pending);
    client.lastUsedAt = now;
    return { ok: true, pending: this.#publicPending(pending) };
  }

  /**
   * POST /token。authorization_code 和 refresh_token 两种 grant。
   * 返回 { status, body }，由 Bridge 负责 HTTP 头。
   */
  exchange(input, { expectedAudience = null } = {}) {
    const grantType = String(field(input, "grant_type") ?? "");
    if (grantType === "authorization_code") return this.#exchangeCode(input, expectedAudience);
    if (grantType === "refresh_token") return this.#exchangeRefresh(input, expectedAudience);
    return { status: 400, body: { error: "unsupported_grant_type", error_description: "只支持 authorization_code / refresh_token" } };
  }

  #exchangeCode(input, expectedAudience) {
    const now = this.#now();
    const code = String(field(input, "code") ?? "");
    const clientId = String(field(input, "client_id") ?? "");
    const redirectUri = String(field(input, "redirect_uri") ?? "");
    const verifier = String(field(input, "code_verifier") ?? "");
    const resource = field(input, "resource");

    if (!code || !clientId || !redirectUri || !verifier) {
      return { status: 400, body: { error: "invalid_request", error_description: "缺少 code / client_id / redirect_uri / code_verifier" } };
    }
    if (!CODE_RE.test(code)) {
      return { status: 400, body: { error: "invalid_grant", error_description: "授权码无效" } };
    }
    const codeHash = hashValue(code);
    const pendingId = this.#codes.get(codeHash);
    const pending = pendingId ? this.#pending.get(pendingId) : null;
    if (!pending || pending.usedAt) {
      return { status: 400, body: { error: "invalid_grant", error_description: "授权码无效或已使用" } };
    }
    if (pending.clientId !== clientId) {
      return { status: 400, body: { error: "invalid_grant", error_description: "授权码不是发给这个客户端的" } };
    }
    if (pending.redirectUri !== redirectUri) {
      return { status: 400, body: { error: "invalid_grant", error_description: "redirect_uri 与授权时不一致" } };
    }
    if (pending.expiresAt <= now || pending.codeExpiresAt <= now) {
      this.#codes.delete(codeHash);
      this.#pending.delete(pending.id);
      return { status: 400, body: { error: "invalid_grant", error_description: "授权码已过期" } };
    }
    // PKCE S256：错 verifier 一律拒绝；同一授权码错 5 次就作废，防有限次猜测。
    if (!VERIFIER_RE.test(verifier)) {
      pending.failedVerifier = (pending.failedVerifier ?? 0) + 1;
      if (pending.failedVerifier >= 5) {
        this.#codes.delete(codeHash);
        this.#pending.delete(pending.id);
      }
      return { status: 400, body: { error: "invalid_grant", error_description: "code_verifier 格式不对" } };
    }
    const computed = createHash("sha256").update(verifier, "utf8").digest("base64url");
    if (!sameString(computed, pending.challenge)) {
      pending.failedVerifier = (pending.failedVerifier ?? 0) + 1;
      if (pending.failedVerifier >= 5) {
        this.#codes.delete(codeHash);
        this.#pending.delete(pending.id);
      }
      return { status: 400, body: { error: "invalid_grant", error_description: "PKCE 校验失败" } };
    }
    if (expectedAudience && pending.audience !== expectedAudience) {
      return { status: 400, body: { error: "invalid_grant", error_description: "授权码不是发给当前地址的" } };
    }
    if (resource !== null && resource !== undefined && resource !== "") {
      const normalized = normalizeOAuthResource(resource);
      if (normalized !== pending.audience) {
        return { status: 400, body: { error: "invalid_target", error_description: "resource 与授权时不一致" } };
      }
    }

    const client = this.#clients.get(pending.clientId);
    if (!client) {
      this.#codes.delete(codeHash);
      this.#pending.delete(pending.id);
      return { status: 400, body: { error: "invalid_grant", error_description: "客户端已被移除" } };
    }

    pending.usedAt = now;
    this.#codes.delete(codeHash);
    this.#pending.delete(pending.id);
    try {
      const tokens = this.#issueTokens({
        client,
        groups: pending.grantedGroups ?? [],
        audience: pending.audience,
        now,
      });
      return { status: 200, body: tokens };
    } catch (error) {
      return { status: 503, body: { error: "temporarily_unavailable", error_description: error.message } };
    }
  }

  #exchangeRefresh(input, expectedAudience) {
    const now = this.#now();
    const refreshToken = String(field(input, "refresh_token") ?? "");
    const clientId = String(field(input, "client_id") ?? "");
    if (!refreshToken || !clientId) {
      return { status: 400, body: { error: "invalid_request", error_description: "缺少 refresh_token / client_id" } };
    }
    if (!REFRESH_TOKEN_RE.test(refreshToken)) {
      return { status: 400, body: { error: "invalid_grant", error_description: "refresh_token 无效" } };
    }
    const hash = hashValue(refreshToken);
    const record = this.#refresh.get(hash);
    if (!record) {
      return { status: 400, body: { error: "invalid_grant", error_description: "refresh_token 无效或已被轮换/吊销" } };
    }
    if (record.clientId !== clientId) {
      return { status: 400, body: { error: "invalid_grant", error_description: "refresh_token 不是发给这个客户端的" } };
    }
    if (record.expiresAt <= now) {
      this.#refresh.delete(hash);
      this.#addRevoked(hash, "refresh", record.clientId, now);
      try { this.#persist(); } catch { /* 内存里已经删了，下次请求照样拒绝 */ }
      return { status: 400, body: { error: "invalid_grant", error_description: "refresh_token 已过期" } };
    }
    if (expectedAudience && record.audience !== expectedAudience) {
      return { status: 400, body: { error: "invalid_grant", error_description: "refresh_token 不是发给当前地址的" } };
    }
    const client = this.#clients.get(record.clientId);
    if (!client) {
      this.#refresh.delete(hash);
      return { status: 400, body: { error: "invalid_grant", error_description: "客户端已被移除" } };
    }

    // public client 必须轮换 refresh token：旧的立刻作废，降低泄露后的可用窗口。
    this.#refresh.delete(hash);
    this.#addRevoked(hash, "refresh", record.clientId, now);
    try {
      const tokens = this.#issueTokens({
        client,
        groups: record.groups,
        audience: record.audience,
        now,
      });
      return { status: 200, body: tokens };
    } catch (error) {
      return { status: 503, body: { error: "temporarily_unavailable", error_description: error.message } };
    }
  }

  #issueTokens({ client, groups, audience, now }) {
    const accessToken = randomToken(ACCESS_PREFIX);
    const refreshToken = randomToken(REFRESH_PREFIX);
    const accessHash = hashValue(accessToken);
    const refreshHash = hashValue(refreshToken);
    const accessExpiresAt = now + this.#config.accessTokenTtlMs;
    const refreshExpiresAt = now + this.#config.refreshTokenTtlMs;
    const accessRecord = {
      id: `at-${randomBytes(8).toString("hex")}`,
      hash: accessHash,
      clientId: client.clientId,
      clientName: client.clientName,
      groups: [...groups],
      audience,
      issuedAt: now,
      expiresAt: accessExpiresAt,
      lastUsedAt: 0,
    };
    const refreshRecord = {
      id: `rt-${randomBytes(8).toString("hex")}`,
      hash: refreshHash,
      clientId: client.clientId,
      clientName: client.clientName,
      groups: [...groups],
      audience,
      issuedAt: now,
      expiresAt: refreshExpiresAt,
      lastUsedAt: 0,
    };
    this.#access.set(accessHash, accessRecord);
    this.#refresh.set(refreshHash, refreshRecord);
    this.#pruneTokens(now);
    try {
      this.#persist();
    } catch (error) {
      // 落盘失败就回滚，避免出现「内存能用、重启就没了」的不一致
      this.#access.delete(accessHash);
      this.#refresh.delete(refreshHash);
      throw error;
    }
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.max(1, Math.round((accessExpiresAt - now) / 1000)),
      refresh_token: refreshToken,
      scope: groups.join(" "),
    };
  }

  #pruneTokens(now) {
    for (const [hash, record] of [...this.#access]) if (record.expiresAt <= now) this.#access.delete(hash);
    for (const [hash, record] of [...this.#refresh]) if (record.expiresAt <= now) this.#refresh.delete(hash);
  }

  /* ------------------------------------------------------------------ *
   * 校验与吊销
   * ------------------------------------------------------------------ */

  /** 是不是本 AS 的 access token（只看前缀，不证明有效；格式不对也按 401 invalid_token 处理）。 */
  isAccessToken(value) {
    return typeof value === "string" && value.startsWith(ACCESS_PREFIX);
  }

  isRefreshToken(value) {
    return typeof value === "string" && REFRESH_TOKEN_RE.test(value);
  }

  /**
   * 校验 access token。expectedAudience 必须是本 Bridge 当前公网 MCP 地址；
   * 地址变了（快速隧道换域名）旧令牌一律失效，客户端重新授权。
   */
  authenticate(token, expectedAudience) {
    const now = this.#now();
    if (!this.isAccessToken(token)) return { ok: false, error: "invalid_token", description: "令牌格式不对" };
    const hash = hashValue(token);
    const record = this.#access.get(hash);
    if (!record) {
      const revoked = this.#revoked.some((item) => item.hash === hash);
      return { ok: false, error: "invalid_token", description: revoked ? "令牌已被吊销" : "令牌无效" };
    }
    if (record.expiresAt <= now) {
      this.#access.delete(hash);
      this.#addRevoked(hash, "access", record.clientId, now);
      try { this.#persist(); } catch { /* 内存里已经删了 */ }
      return { ok: false, error: "invalid_token", description: "令牌已过期" };
    }
    if (expectedAudience && record.audience !== expectedAudience) {
      return { ok: false, error: "invalid_token", description: "令牌的 audience 不是这个 MCP 地址" };
    }
    if (!this.#clients.has(record.clientId)) {
      this.#access.delete(hash);
      return { ok: false, error: "invalid_token", description: "客户端已被移除" };
    }
    record.lastUsedAt = now;
    return {
      ok: true,
      token: {
        id: record.id,
        clientId: record.clientId,
        clientName: record.clientName,
        audience: record.audience,
        expiresAt: record.expiresAt,
        // 交给 tool-policy 的作用域：只有分组，不做窗口 / 域名限制
        scope: normalizeScope({ groups: record.groups }),
      },
    };
  }

  #addRevoked(hash, kind, clientId, now) {
    this.#revoked.push({ hash, kind, clientId: clientId ?? null, revokedAt: now });
    if (this.#revoked.length > MAX_REVOKED) this.#revoked.splice(0, this.#revoked.length - MAX_REVOKED);
  }

  /** RFC 7009：不认识 / 已失效的令牌也返回成功，避免探测。 */
  revoke(token) {
    const now = this.#now();
    if (typeof token !== "string" || (!ACCESS_TOKEN_RE.test(token) && !REFRESH_TOKEN_RE.test(token))) return false;
    const hash = hashValue(token);
    let kind = null;
    let clientId = null;
    const access = this.#access.get(hash);
    if (access) {
      kind = "access";
      clientId = access.clientId;
      this.#access.delete(hash);
    } else {
      const refresh = this.#refresh.get(hash);
      if (refresh) {
        kind = "refresh";
        clientId = refresh.clientId;
        this.#refresh.delete(hash);
      }
    }
    if (!kind) return false;
    this.#addRevoked(hash, kind, clientId, now);
    this.#persist();
    return true;
  }

  /** 本机吊销某个客户端的全部令牌（设置页 / 调试入口用）。 */
  revokeClient(clientId) {
    const now = this.#now();
    let count = 0;
    for (const [hash, record] of [...this.#access]) {
      if (record.clientId === clientId) {
        this.#access.delete(hash);
        this.#addRevoked(hash, "access", clientId, now);
        count++;
      }
    }
    for (const [hash, record] of [...this.#refresh]) {
      if (record.clientId === clientId) {
        this.#refresh.delete(hash);
        this.#addRevoked(hash, "refresh", clientId, now);
        count++;
      }
    }
    if (count) this.#persist();
    return count;
  }

  /** 本机移除客户端：令牌一起吊销，之后同一个 client_id 不能再授权。 */
  removeClient(clientId) {
    const count = this.revokeClient(clientId);
    const removed = this.#clients.delete(clientId);
    if (removed) this.#persist();
    return { removed, revoked: count };
  }

  status() {
    return {
      enabled: this.enabled,
      clients: this.#clients.size,
      accessTokens: this.#access.size,
      refreshTokens: this.#refresh.size,
      pending: this.#pending.size,
    };
  }

  /* ------------------------------------------------------------------ *
   * 持久化
   * ------------------------------------------------------------------ */

  #load() {
    let raw;
    try {
      raw = readFileSync(this.#file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`[oauth] OAuth 状态文件读不了（${error.message}），这次按空表运行且不保存`);
        this.#readOnly = true;
      }
      return;
    }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* 下面按坏文件处理 */ }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      const backup = `${this.#file}.broken-${Date.now()}`;
      try { renameSync(this.#file, backup); } catch { this.#readOnly = true; }
      console.warn(`[oauth] OAuth 状态文件坏了，已另存为 ${backup}，当成空表`);
      return;
    }

    for (const item of Array.isArray(parsed.clients) ? parsed.clients : []) {
      const clientId = String(item?.clientId ?? "");
      if (!CLIENT_ID_RE.test(clientId) || this.#clients.has(clientId)) continue;
      const redirectUris = (Array.isArray(item?.redirectUris) ? item.redirectUris : [])
        .map((value) => String(value ?? "").trim())
        .filter((value) => value && isAllowedRedirectUri(value));
      if (!redirectUris.length) continue;
      this.#clients.set(clientId, {
        clientId,
        clientName: cleanName(item?.clientName, "未命名客户端"),
        redirectUris: [...new Set(redirectUris)].slice(0, 10),
        createdAt: Number(item?.createdAt) || 0,
        lastUsedAt: Number(item?.lastUsedAt) || 0,
      });
    }

    const loadTokens = (target, list, kind) => {
      for (const item of Array.isArray(list) ? list : []) {
        if (!HASH_RE.test(item?.hash)) continue;
        const client = this.#clients.get(String(item?.clientId ?? ""));
        if (!client) continue;
        const audience = String(item?.audience ?? "").trim();
        const expiresAt = Number(item?.expiresAt);
        if (!audience || !Number.isFinite(expiresAt)) continue;
        target.set(item.hash, {
          id: String(item?.id ?? `${kind}-${item.hash.slice(0, 12)}`),
          hash: item.hash,
          clientId: client.clientId,
          clientName: cleanName(item?.clientName, client.clientName),
          groups: normalizeOAuthGroups(item?.groups),
          audience,
          issuedAt: Number(item?.issuedAt) || 0,
          expiresAt,
          lastUsedAt: Number(item?.lastUsedAt) || 0,
        });
      }
    };
    loadTokens(this.#access, parsed.accessTokens, "at");
    loadTokens(this.#refresh, parsed.refreshTokens, "rt");

    for (const item of Array.isArray(parsed.revoked) ? parsed.revoked : []) {
      if (!HASH_RE.test(item?.hash)) continue;
      this.#revoked.push({
        hash: item.hash,
        kind: item.kind === "refresh" ? "refresh" : "access",
        clientId: typeof item.clientId === "string" ? item.clientId : null,
        revokedAt: Number(item.revokedAt) || 0,
      });
      if (this.#revoked.length > MAX_REVOKED) this.#revoked.shift();
    }
  }

  #persist() {
    if (this.#readOnly) throw new Error("OAuth 状态文件启动时读不了，这次先不保存；重启软件后再试");
    const data = {
      version: 1,
      clients: [...this.#clients.values()].map((client) => ({ ...client, redirectUris: [...client.redirectUris] })),
      accessTokens: [...this.#access.values()].map((record) => ({ ...record, groups: [...record.groups] })),
      refreshTokens: [...this.#refresh.values()].map((record) => ({ ...record, groups: [...record.groups] })),
      revoked: this.#revoked.map((item) => ({ ...item })),
    };
    mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const temp = `${this.#file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
      renameSync(temp, this.#file);
    } catch (error) {
      try { unlinkSync(temp); } catch { /* 临时文件清不掉不影响主流程 */ }
      throw error;
    }
  }
}

/** 从 Authorization 头取 Bearer 值（不限制前缀；旧口令和 OAuth 令牌都要能读到）。 */
export function readAuthorizationBearer(headers) {
  const value = headers?.authorization;
  if (typeof value !== "string") return null;
  const match = /^Bearer +(\S+) *$/i.exec(value);
  return match ? match[1] : null;
}

export { ACCESS_TOKEN_RE, REFRESH_TOKEN_RE, CODE_RE, HASH_RE };
