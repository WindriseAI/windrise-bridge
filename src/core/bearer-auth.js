/**
 * 口令入口（Bearer）—— 2026-10-25 定，方案见 docs/research/bearer-auth-2026-10-25.md。
 *
 * 路径令牌（/mcp/<令牌>）的毛病：地址就是钥匙，截图、聊天记录、别人的 AI 对话里一出现就算泄露。
 * 能带请求头的客户端（Muse、本机智能体）改走：
 *     POST/GET/DELETE /mcp      请求头 Authorization: Bearer <口令>
 *
 * 规矩：
 *   · 口令只在生成时给一次，磁盘上只存 SHA-256 哈希，文件泄露也还原不出口令；
 *   · 比对用 timingSafeEqual；
 *   · 口令错、没带、格式不对，桥一律回 404（和错路径令牌一样，不暴露服务存在）；
 *   · 主身份的「允许路径令牌」开关只管经公网（隧道）进来的请求，本机直连照常——
 *     桥只听 127.0.0.1，攻击者只能从隧道进来；本机的探测、stdio 转发不能被一并锁死。
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { cloneScope, normalizeScope } from "./tool-policy.js";

export const BEARER_PREFIX = "wrb_";
/** 32 字节随机数转 base64url 是 43 位 */
const KEY_PATTERN = /^wrb_[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export function newBearerKey() {
  return BEARER_PREFIX + randomBytes(32).toString("base64url");
}

export function isWellFormedBearerKey(value) {
  return typeof value === "string" && KEY_PATTERN.test(value);
}

export function hashBearerKey(key) {
  return createHash("sha256").update(String(key), "utf8").digest("hex");
}

export function isBearerHash(value) {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

/** 两个哈希等长时用常数时间比较；任何一边不像哈希就当不相等。 */
export function hashesEqual(a, b) {
  if (!isBearerHash(a) || !isBearerHash(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/**
 * 从请求头取口令。只认一个 Authorization 头、Bearer 方案（大小写不敏感）、格式对的口令；
 * 别的样子（Basic、多个头、空格夹杂）一律当没带，由调用方回 404。
 */
export function readBearerKey(headers) {
  const value = headers?.authorization;
  if (typeof value !== "string") return null;
  const match = /^Bearer +(\S+) *$/i.exec(value);
  if (!match) return null;
  return isWellFormedBearerKey(match[1]) ? match[1] : null;
}

/** 这个请求是不是经公网（隧道）进来的：cloudflared 加 cf-ray，ngrok 加 x-forwarded-for。 */
export function isTunnelRequest(headers) {
  return Boolean(headers?.["cf-ray"] || headers?.["x-forwarded-for"]);
}

/**
 * 本机 MCP 防绕过（减速带，不是绝对安全）：哪些请求算「不像本机直连」。
 *
 * 判定写在一个地方（这里），bridge.js 的 handle() 里那一行（见 isRemoteRequest 调用点）据此拦 403：
 *   1. 带转发痕迹的请求头，任一存在即算远程——
 *        Cloudflare：cf-connecting-ip / cf-ray / cf-visitor / cf-ipcountry；
 *        通用代理：x-forwarded-for / x-forwarded-host / forwarded（ngrok 转发会加 x-forwarded-for）。
 *   2. Host 不是 localhost / 127.0.0.1 / [::1]（可带端口）也算远程——
 *        cloudflared / ngrok 转发时 Host 是公网域名，本机直连一定是本机名。
 * 我们的隧道流量就是靠第 1 类头（cloudflared 的 cf-ray、ngrok 的 x-forwarded-for）认出来的，
 * 所以「经隧道」和「不像本机」在这里天然是同一组信号：这类请求只在许可证有效且我们隧道真通着时放行。
 */
export const REMOTE_REQUEST_HEADERS = ["cf-connecting-ip", "cf-ray", "cf-visitor", "cf-ipcountry", "x-forwarded-for", "x-forwarded-host", "forwarded"];

/** Host 去掉端口后是不是本机名。 */
export function isLocalHostHeader(host) {
  const text = String(host ?? "").trim().toLowerCase();
  if (!text) return true; // 没带 Host：按本机处理（HTTP/1.0 老客户端）
  // 先去掉末尾端口，再解掉 IPv6 的方括号：localhost[:port] / 127.0.0.1[:port] / [::1][:port]
  const bare = text.replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1";
}

/** 这个请求是否「不像本机直连」：带任一转发痕迹头，或 Host 不是本机名。 */
export function isRemoteRequest(headers) {
  if (!headers || typeof headers !== "object") return false;
  if (REMOTE_REQUEST_HEADERS.some((name) => headers[name] !== undefined)) return true;
  return !isLocalHostHeader(headers.host);
}

export function ownerAuthFile(dataHome) {
  return path.join(dataHome, "owner-auth.json");
}

const MAX_OWNER_KEYS = 8;
const MAX_LABEL = 32;

function cleanLabel(label) {
  const text = String(label ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_LABEL);
  return text || "未命名";
}

function publicKey(entry) {
  return { id: entry.id, label: entry.label, hint: entry.hint, createdAt: entry.createdAt, scope: cloneScope(entry.scope) };
}

/**
 * 主身份的口令（可以有多把）和路径开关。2026-10-25 下午改成多把：Claude 和酥酥各用一把，
 * 作废其中一把只断用那把的会话。
 *
 * 文件 <dataHome>/owner-auth.json：
 *   v2 { version: 2, keys: [{ id, label, hash, hint, createdAt }], pathEnabled }
 *   v1 { version: 1, bearerHash, bearerHint, bearerCreatedAt, pathEnabled } —— 读到时迁成一把名为「酥酥」的口令
 * hint 是口令末 4 位，只给界面认「是哪一把」。
 *
 * 文件读不了或坏了：按默认（没有口令、路径开）运行——不会多放进任何人，只是口令入口暂时不可用；
 * 坏文件另存一份，读不了时这次运行不写，免得盖掉原来的设置。
 */
export class OwnerAuthStore {
  #file;
  #keys = [];
  #pathEnabled = true;
  #readOnly = false;

  constructor({ file } = {}) {
    if (!file) throw new Error("OwnerAuthStore 需要 file");
    this.#file = file;
    this.#load();
  }

  #load() {
    let raw;
    try {
      raw = readFileSync(this.#file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`[owner-auth] 口令设置读不了（${error.message}），这次按「没有口令」运行且不保存`);
        this.#readOnly = true;
      }
      return;
    }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* 下面按坏文件处理 */ }
    if (!parsed || typeof parsed !== "object") {
      const backup = `${this.#file}.broken-${Date.now()}`;
      try { renameSync(this.#file, backup); } catch { this.#readOnly = true; }
      console.warn(`[owner-auth] 口令设置坏了，已另存为 ${backup}，按「没有口令」运行`);
      return;
    }
    let keys = [];
    if (Array.isArray(parsed.keys)) {
      const seenIds = new Set();
      const seenHashes = new Set();
      for (const item of parsed.keys) {
        if (!item || !isBearerHash(item.hash) || seenHashes.has(item.hash)) continue;
        const id = typeof item.id === "string" && /^k-[a-f0-9]{8,32}$/.test(item.id) && !seenIds.has(item.id) ? item.id : `k-${randomBytes(6).toString("hex")}`;
        seenIds.add(id);
        seenHashes.add(item.hash);
        keys.push({
          id,
          label: cleanLabel(item.label),
          hash: item.hash,
          hint: typeof item.hint === "string" ? item.hint.slice(0, 4) : null,
          createdAt: typeof item.createdAt === "string" ? item.createdAt : null,
          // 老文件没有 scope：这一把保持老行为（全部工具）
          scope: normalizeScope(item.scope),
        });
        if (keys.length >= MAX_OWNER_KEYS) break;
      }
    } else if (isBearerHash(parsed.bearerHash)) {
      // v1 迁移：原来那一把是给酥酥（Muse）生成的
      keys = [{
        id: `k-${randomBytes(6).toString("hex")}`,
        label: "酥酥",
        hash: parsed.bearerHash,
        hint: typeof parsed.bearerHint === "string" ? parsed.bearerHint.slice(0, 4) : null,
        createdAt: typeof parsed.bearerCreatedAt === "string" ? parsed.bearerCreatedAt : null,
        scope: null,
      }];
    }
    this.#keys = keys;
    // 只有明确写 false 且有口令时才算关；没口令时关路径等于把公网入口全锁死，不认
    this.#pathEnabled = !(parsed.pathEnabled === false && keys.length > 0);
  }

  #persist(keys, pathEnabled) {
    if (this.#readOnly) throw new Error("口令设置文件启动时读不了，这次先不保存；重启软件后再试");
    mkdirSync(path.dirname(this.#file), { recursive: true });
    const temp = `${this.#file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ version: 2, keys, pathEnabled }, null, 2), { encoding: "utf8", mode: 0o600 });
      renameSync(temp, this.#file);
    } catch (error) {
      try { unlinkSync(temp); } catch { /* 清不掉临时文件不影响主流程 */ }
      throw error;
    }
    this.#keys = keys;
    this.#pathEnabled = pathEnabled;
  }

  /** 给界面看的状态，不含哈希。bearerHint / bearerCreatedAt 是第一把的，兼容老界面。 */
  status() {
    const first = this.#keys[0] ?? null;
    return {
      bearerEnabled: this.#keys.length > 0,
      bearerHint: first?.hint ?? null,
      bearerCreatedAt: first?.createdAt ?? null,
      keys: this.#keys.map(publicKey),
      pathEnabled: this.#pathEnabled,
    };
  }

  /**
   * 口令对上哪一把：返回那把的 id，对不上返回 null。
   * 每一把都比一遍再返回，比对次数不随命中位置变。
   */
  matches(key) {
    if (!this.#keys.length || !isWellFormedBearerKey(key)) return null;
    const hash = hashBearerKey(key);
    let found = null;
    for (const entry of this.#keys) {
      if (hashesEqual(hash, entry.hash) && !found) found = entry.id;
    }
    return found;
  }

  /** 这把口令现在还有效吗（会话收尾时用）。 */
  hasKey(id) {
    return this.#keys.some((entry) => entry.id === id);
  }

  /** 这把口令的工具作用域；没有作用域（老口令）返回 null，桥按原来的行为放行。 */
  scopeOf(id) {
    const entry = this.#keys.find((item) => item.id === id);
    return entry ? cloneScope(entry.scope) : null;
  }

  /** 口令的名字（审计日志用；不含口令本身）。 */
  labelOf(id) {
    return this.#keys.find((item) => item.id === id)?.label ?? null;
  }

  /** 改某一把口令的作用域（null = 取消限制）。不用换口令，下一次调用立即生效。 */
  setScope(id, scope) {
    const index = this.#keys.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error("没有这把口令");
    const keys = [...this.#keys];
    keys[index] = { ...keys[index], scope: normalizeScope(scope) };
    this.#persist(keys, this.#pathEnabled);
    return this.status();
  }

  /** 经公网时主路径令牌还能不能用。 */
  pathEnabled() {
    return this.#pathEnabled !== false;
  }

  #newEntry(label, { scope } = {}) {
    const key = newBearerKey();
    return {
      key,
      entry: {
        id: `k-${randomBytes(6).toString("hex")}`,
        label: cleanLabel(label),
        hash: hashBearerKey(key),
        hint: key.slice(-4),
        createdAt: new Date().toISOString(),
        scope: normalizeScope(scope),
      },
    };
  }

  /** 新增一把口令：明文只在返回值里出现一次。别的口令不受影响。 */
  addKey(label, options = {}) {
    if (this.#keys.length >= MAX_OWNER_KEYS) throw new Error(`主口令最多 ${MAX_OWNER_KEYS} 把，先撤掉不用的`);
    const { key, entry } = this.#newEntry(label, options);
    this.#persist([...this.#keys, entry], this.#pathEnabled);
    return { key, id: entry.id, ...this.status() };
  }

  /** 换某一把：同名、新口令，旧的立即作废。返回新明文。默认沿用原来的作用域。 */
  rotateKey(id, options = {}) {
    const index = this.#keys.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error("没有这把口令");
    const scope = Object.prototype.hasOwnProperty.call(options, "scope") ? options.scope : this.#keys[index].scope;
    const { key, entry } = this.#newEntry(this.#keys[index].label, { scope });
    const keys = [...this.#keys];
    keys[index] = entry;
    this.#persist(keys, this.#pathEnabled);
    return { key, id: entry.id, ...this.status() };
  }

  /** 撤掉某一把。撤完一把都不剩时，路径入口自动恢复，免得公网入口全锁死。 */
  revokeKey(id) {
    if (!this.hasKey(id)) throw new Error("没有这把口令");
    const keys = this.#keys.filter((entry) => entry.id !== id);
    this.#persist(keys, keys.length ? this.#pathEnabled : true);
    return this.status();
  }

  /** 老接口：清空后生成唯一一把（「换口令」按钮）。 */
  generate(label = "主口令") {
    const { key, entry } = this.#newEntry(label);
    this.#persist([entry], this.#pathEnabled);
    return { key, id: entry.id, ...this.status() };
  }

  /** 老接口：全部撤掉；路径入口同时恢复。 */
  revoke() {
    this.#persist([], true);
    return this.status();
  }

  /** 开关经公网的主路径令牌。没口令时不许关（关了公网就谁都进不来，包括主人自己）。 */
  setPathEnabled(enabled) {
    const want = enabled !== false;
    if (!want && !this.#keys.length) throw new Error("还没有口令，不能关路径令牌：先生成口令、让客户端换过去，再关");
    this.#persist(this.#keys, want);
    return this.status();
  }
}
