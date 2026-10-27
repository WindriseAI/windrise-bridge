/**
 * 连接器 —— 给每个 AI 客户端一把自己的钥匙。
 *
 * 背景：所有客户端共用主路由令牌时，谁连进来都能操作全部多开窗口。
 * 连接器把「一把令牌」和「几个窗口」绑在一起：
 *   · 新建的连接器默认什么窗口都碰不到；
 *   · 只能在设置页把窗口分给它（一个窗口同一时间只归一个连接器）；
 *   · 越权时先排进待批准列表，人批准后才真正可用。
 *
 * 数据文件是 <dataHome>/connectors.json，格式固定为：
 *   { version: 1, connectors: [{ id, name, token, profiles: [...], createdAt, authMode?, bearerHash? }] }
 *
 * authMode 缺省 "path"（走 /mcp/<令牌>）；"bearer" 时只认口令入口，它的路径令牌不再生效（2026-10-25）。
 * bearerHash 是口令的 SHA-256，口令明文只在 setBearer 的返回值里出现一次。
 * scope 是可选的工具作用域（见 tool-policy.js）：{ groups, profiles, domains }；
 * 没有 scope 的连接器完全按老规则（只给分给它的窗口工具），有 scope 才按分组放行。
 *
 * 落盘用「临时文件 + rename」，写一半断电不会留下坏文件；
 * 文件读坏了当成空表（只 warn 一句），绝不因为一个配置文件让整个桥起不来。
 */

import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { hashBearerKey, hashesEqual, isBearerHash, isWellFormedBearerKey, newBearerKey } from "./bearer-auth.js";
import { cloneScope, normalizeScope } from "./tool-policy.js";

/** 被拒之后多久内不再重新排队（毫秒） */
const DENY_COOLDOWN_MS = 10 * 60 * 1000;
/** 每个连接器最多排几条待批准：远端 AI 能决定申请什么，不设上限就能刷爆通知和界面 */
const MAX_PENDING_PER_CONNECTOR = 5;
/** 窗口 id 正常是 8 位十六进制；超长的申请直接不收 */
const MAX_PROFILE_ID_LENGTH = 64;
/** 令牌只认 base64url、至少 32 位（create 生成的就是 32 位），手改出来的短令牌、怪字符一律不认 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/;

/** 连接器数据文件的位置（和 settings.json、route-token.json 放在同一个数据目录）。 */
export function connectorsFile(dataHome) {
  return path.join(dataHome, "connectors.json");
}

/** 从磁盘读到的单条记录做一次净化；缺关键字段的整条丢掉，不让坏数据扩散。 */
function normalizeConnector(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" && raw.id && raw.id.length <= 64 ? raw.id : null;
  const token = typeof raw.token === "string" && TOKEN_PATTERN.test(raw.token) ? raw.token : null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!id || !token || !name) return null;
  const bearerHash = isBearerHash(raw.bearerHash) ? raw.bearerHash : null;
  return {
    id,
    name,
    token,
    // 写着 bearer 但哈希坏了：退回 path 不合适（会让作废的路径令牌复活），整条按「口令模式、口令无效」处理
    authMode: raw.authMode === "bearer" ? "bearer" : "path",
    bearerHash: raw.authMode === "bearer" ? bearerHash : null,
    profiles: Array.isArray(raw.profiles) ? [...new Set(raw.profiles.filter((value) => typeof value === "string" && value))] : [],
    // 没有 scope 的老记录保持 null：桥按原来的「只能碰分给它的窗口」规则处理
    scope: normalizeScope(raw.scope),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
  };
}

/** 对外只给拷贝，避免调用方顺手改掉内部状态（令牌、窗口归属都以内存里这份为准）。 */
function cloneConnector(connector) {
  return connector ? { ...connector, profiles: [...connector.profiles], scope: cloneScope(connector.scope) } : null;
}

/** 给外面看的样子：不带口令哈希（哈希只在本模块里比对用）。 */
function publicConnector(connector) {
  if (!connector) return null;
  const { bearerHash, ...rest } = cloneConnector(connector);
  return { ...rest, authMode: connector.authMode ?? "path", bearerEnabled: Boolean(bearerHash) };
}

function deniedKey(connectorId, profileId) {
  return `${connectorId}\u0000${profileId}`;
}

export class ConnectorStore extends EventEmitter {
  #file;
  #connectors = [];
  /** 待批准：只在内存里，重启就清空（人没批准的事不该隔夜自动生效）。 */
  #pending = new Map();
  /** 被拒记录：connectorId + 窗口 id → 到期时间 */
  #denied = new Map();

  constructor({ file } = {}) {
    super();
    if (!file) throw new Error("ConnectorStore 需要 file");
    this.#file = file;
    this.#load();
  }

  get file() {
    return this.#file;
  }

  #load() {
    let raw = null;
    let lastError = null;
    // 被杀毒软件、同步盘短暂占着（EBUSY / EPERM）时重试几次，读不到也绝不当成空表再写回去盖掉
    for (let attempt = 0; attempt < 3 && raw === null; attempt++) {
      try {
        raw = readFileSync(this.#file, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") { this.#connectors = []; return; }   // 第一次运行，正常
        lastError = error;
        const until = Date.now() + 50;
        while (Date.now() < until) { /* 只在启动时跑一次，忙等 50ms 可以接受 */ }
      }
    }
    if (raw === null) {
      console.warn(`[connectors] 连接器文件读不了（${lastError?.message}），这次先不改它，免得把原来的钥匙盖掉`);
      this.#readOnly = true;
      this.#connectors = [];
      return;
    }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* 下面按坏文件处理 */ }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.connectors)) {
      // 坏文件先另存一份再当空表：之后写入不会把它唯一的副本盖掉，人还能找回来
      const backup = `${this.#file}.broken-${Date.now()}`;
      try { renameSync(this.#file, backup); } catch { /* 改名失败就只能不写 */ this.#readOnly = true; }
      console.warn(`[connectors] 连接器文件坏了，已另存为 ${backup}，当成空表`);
      this.#connectors = [];
      return;
    }
    // 去重：同一个 id、同一把令牌只留第一条；一个窗口也只归第一个连接器
    const seenIds = new Set();
    const seenTokens = new Set();
    const owned = new Set();
    this.#connectors = [];
    for (const connector of parsed.connectors.map(normalizeConnector).filter(Boolean)) {
      if (seenIds.has(connector.id) || seenTokens.has(connector.token)) continue;
      seenIds.add(connector.id);
      seenTokens.add(connector.token);
      connector.profiles = connector.profiles.filter((profile) => !owned.has(profile));
      connector.profiles.forEach((profile) => owned.add(profile));
      this.#connectors.push(connector);
    }
  }

  /** 读失败时置上：这次运行里不写连接器文件（改动会失败并说明原因） */
  #readOnly = false;

  /** 原子写：先写临时文件再 rename，避免读到半个 json。 */
  #persist(connectors) {
    if (this.#readOnly) throw new Error("连接器文件启动时读不了，为了不盖掉原来的钥匙，这次先不保存；重启软件后再试");
    const dir = path.dirname(this.#file);
    mkdirSync(dir, { recursive: true });
    const temp = `${this.#file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, connectors }, null, 2), "utf8");
      renameSync(temp, this.#file);
    } catch (error) {
      try { unlinkSync(temp); } catch { /* 临时文件清不掉也不影响主流程 */ }
      throw error;
    }
  }

  #snapshot() {
    return this.#connectors.map(cloneConnector);
  }

  #find(connectorId) {
    return this.#connectors.find((connector) => connector.id === connectorId) ?? null;
  }

  list() {
    return this.#connectors.map(publicConnector);
  }

  get(id) {
    return publicConnector(this.#find(id));
  }

  /**
   * 按令牌找连接器。注意：这里返回的是内存里那一份（不是拷贝）——
   * 桥给每个会话记的就是它，grant / revoke 原地改 profiles，已建立的会话不用重连就生效。调用方只读不改。
   */
  findByToken(token) {
    if (!token) return null;
    // 切到口令模式的连接器，路径令牌不再生效
    return this.#connectors.find((connector) => connector.authMode !== "bearer" && connector.token === token) ?? null;
  }

  /** 按口令找连接器（同 findByToken，返回内存里那一份，调用方只读不改）。 */
  findByBearer(key) {
    if (!isWellFormedBearerKey(key)) return null;
    const hash = hashBearerKey(key);
    let found = null;
    // 全部比一遍再返回，比对次数不随命中位置变
    for (const connector of this.#connectors) {
      if (connector.authMode === "bearer" && hashesEqual(hash, connector.bearerHash) && !found) found = connector;
    }
    return found;
  }

  /**
   * 切到口令模式（或换口令）：生成新口令，只存哈希；路径令牌同时换掉，
   * 以后就算切回路径模式，泄露过的旧地址也不会复活。已建立的会话全部断开，客户端要用新口令重连。
   * 返回 { key, connector }，key 只在这里出现一次。
   */
  setBearer(id) {
    const connector = this.#find(id);
    if (!connector) throw new Error("没有这个连接器");
    const key = newBearerKey();
    const patch = { authMode: "bearer", bearerHash: hashBearerKey(key), token: randomBytes(24).toString("base64url") };
    const next = this.#snapshot();
    Object.assign(next.find((item) => item.id === id), patch);
    this.#persist(next);
    Object.assign(connector, patch);
    this.emit("auth-changed", id);
    this.emit("change");
    return { key, connector: publicConnector(connector) };
  }

  /** 切回路径模式：口令作废，发一把新的路径令牌（旧的不复活）。已建立的会话全部断开。 */
  setPathMode(id) {
    const connector = this.#find(id);
    if (!connector) throw new Error("没有这个连接器");
    const patch = { authMode: "path", bearerHash: null, token: randomBytes(24).toString("base64url") };
    const next = this.#snapshot();
    Object.assign(next.find((item) => item.id === id), patch);
    this.#persist(next);
    Object.assign(connector, patch);
    this.emit("auth-changed", id);
    this.emit("change");
    return publicConnector(connector);
  }

  create(name, { scope } = {}) {
    const clean = String(name ?? "").trim();
    if (!clean) throw new Error("连接器名字不能为空");
    let id;
    do { id = `c-${randomBytes(6).toString("hex")}`; } while (this.#find(id));
    const connector = {
      id,
      name: clean,
      token: randomBytes(24).toString("base64url"),
      authMode: "path",
      bearerHash: null,
      // 新连接器默认什么窗口都碰不到，必须在设置页里逐个勾选
      profiles: [],
      // 作用域是可选的；不传就是老行为（只给分给它的窗口工具）
      scope: normalizeScope(scope),
      createdAt: new Date().toISOString(),
    };
    this.#persist([...this.#snapshot(), connector]);
    this.#connectors.push(connector);
    this.emit("change");
    return publicConnector(connector);
  }

  /**
   * 改工具作用域。传 null = 回到老行为。
   * 不换口令、不断会话：桥每次调用都重新读 scope，改完立刻生效（和窗口归属一样）。
   */
  setScope(id, scope) {
    const connector = this.#find(id);
    if (!connector) throw new Error("没有这个连接器");
    const normalized = normalizeScope(scope);
    const next = this.#snapshot();
    next.find((item) => item.id === id).scope = normalized;
    this.#persist(next);
    connector.scope = cloneScope(normalized);
    this.emit("change");
    return publicConnector(connector);
  }

  rename(id, name) {
    const clean = String(name ?? "").trim();
    if (!clean) throw new Error("连接器名字不能为空");
    const connector = this.#find(id);
    if (!connector) throw new Error("没有这个连接器");
    const next = this.#snapshot();
    const target = next.find((item) => item.id === id);
    target.name = clean;
    this.#persist(next);
    // 保持对象身份不变：已经建立的会话手里拿的就是这个对象
    connector.name = clean;
    this.emit("change");
    return publicConnector(connector);
  }

  remove(id) {
    const connector = this.#find(id);
    if (!connector) return false;
    const next = this.#snapshot().filter((item) => item.id !== id);
    this.#persist(next);
    this.#connectors = this.#connectors.filter((item) => item.id !== id);
    for (const [requestId, request] of [...this.#pending]) {
      if (request.connectorId === id) this.#pending.delete(requestId);
    }
    for (const key of [...this.#denied.keys()]) {
      if (key.startsWith(`${id}\u0000`)) this.#denied.delete(key);
    }
    this.emit("removed", id);
    this.emit("change");
    return true;
  }

  /** 把窗口分给连接器。一个窗口同一时间只归一个连接器，分给 B 时会从别人那里移走。 */
  grant(connectorId, profileId) {
    const connector = this.#find(connectorId);
    if (!connector) throw new Error("没有这个连接器");
    const profile = String(profileId ?? "").trim();
    if (!profile) throw new Error("窗口 id 不能为空");

    const next = this.#snapshot();
    for (const item of next) {
      if (item.id === connectorId) {
        if (!item.profiles.includes(profile)) item.profiles.push(profile);
      } else if (item.profiles.includes(profile)) {
        item.profiles = item.profiles.filter((value) => value !== profile);
      }
    }
    this.#persist(next);
    // 原地更新 profiles，已建立的会话不用重连也能看到新归属
    for (const item of this.#connectors) {
      const updated = next.find((entry) => entry.id === item.id);
      item.profiles = updated ? [...updated.profiles] : [];
    }
    // 人已经把窗口给了它，之前拒绝过的记录立刻作废；在设置页直接勾选时，对应的待批准也一并清掉（不然红点一直亮着）
    this.#denied.delete(deniedKey(connectorId, profile));
    for (const [requestId, request] of [...this.#pending]) {
      if (request.connectorId === connectorId && request.profileId === profile) this.#pending.delete(requestId);
    }
    this.emit("change");
    return publicConnector(connector);
  }

  revoke(connectorId, profileId) {
    const connector = this.#find(connectorId);
    if (!connector) throw new Error("没有这个连接器");
    const profile = String(profileId ?? "").trim();
    if (!profile) throw new Error("窗口 id 不能为空");
    if (!connector.profiles.includes(profile)) return publicConnector(connector);

    const next = this.#snapshot();
    const target = next.find((item) => item.id === connectorId);
    target.profiles = target.profiles.filter((value) => value !== profile);
    this.#persist(next);
    connector.profiles = [...target.profiles];
    this.emit("change");
    return publicConnector(connector);
  }

  canUse(connector, profileId) {
    if (!connector || !Array.isArray(connector.profiles)) return false;
    return connector.profiles.includes(String(profileId ?? ""));
  }

  /**
   * 排一条待批准。同一连接器同一窗口只排一条；
   * 刚被人拒绝过的，10 分钟内再请求直接返回 { denied: true }，不重新排队。
   */
  requestApproval({ connectorId, profileId, tool } = {}) {
    const profile = String(profileId ?? "").trim();
    if (!profile || profile.length > MAX_PROFILE_ID_LENGTH) return null;
    const key = deniedKey(connectorId, profile);
    const deniedUntil = this.#denied.get(key);
    if (deniedUntil) {
      if (Date.now() < deniedUntil) return { denied: true };
      this.#denied.delete(key);
    }

    const existing = [...this.#pending.values()].find(
      (request) => request.connectorId === connectorId && request.profileId === profile,
    );
    if (existing) return { ...existing };

    const connector = this.#find(connectorId);
    if (!connector) return null;
    const queued = [...this.#pending.values()].filter((request) => request.connectorId === connectorId).length;
    if (queued >= MAX_PENDING_PER_CONNECTOR) return { limited: true, max: MAX_PENDING_PER_CONNECTOR };
    const request = {
      id: `a-${randomBytes(4).toString("hex")}`,
      connectorId,
      connectorName: connector.name,
      profileId: profile,
      tool: String(tool ?? ""),
      at: Date.now(),
    };
    this.#pending.set(request.id, request);
    this.emit("approval-request", { ...request });
    this.emit("change");
    return { ...request };
  }

  pending() {
    return [...this.#pending.values()].map((request) => ({ ...request }));
  }

  /** 批准 = 把窗口分给它，再删掉这条待批准。 */
  approve(requestId) {
    const request = this.#pending.get(requestId);
    if (!request) return null;
    this.grant(request.connectorId, request.profileId);
    this.#pending.delete(requestId);
    this.emit("change");
    return { ...request };
  }

  /** 拒绝：删掉这条，并记住这个连接器这个窗口 10 分钟内别再排队。 */
  deny(requestId) {
    const request = this.#pending.get(requestId);
    if (!request) return null;
    this.#pending.delete(requestId);
    this.#denied.set(deniedKey(request.connectorId, request.profileId), Date.now() + DENY_COOLDOWN_MS);
    this.emit("change");
    return { ...request };
  }
}
