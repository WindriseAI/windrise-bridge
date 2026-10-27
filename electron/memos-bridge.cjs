/**
 * MemOS 接入适配层（纯 Node，不依赖 Electron）。
 *
 * Key 只存一处：<数据目录>/external-mcp.json 里 id 为 memos 的条目。
 *   - http 条目：写在 headers（优先沿用已有 key 头，缺省用 Authorization: Bearer）；
 *   - stdio 条目：写在 env（优先沿用已有 key 变量，缺省用 MEMOS_API_KEY）。
 * 理由：外部 MCP 管理器连接时只读这份文件；再在 settings 里存一份会两边漂移，
 * 而且 settings 会整份回给渲染层。这里只对外给 configured / status，不回头显 headers / env。
 *
 * 不内置 MemOS 官方 MCP 地址：仓库里没有可核对的地址就不能猜。没有现成 memos 条目时，
 * 首次保存必须由调用方提供 url（或在 configure_mcp 里先建好 memos 条目）。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MEMOS_SERVER_ID = "memos";
const MEMOS_ID_PATTERN = /^memos(?:[-_]|$)/i;
const SECRET_NAME_PATTERN = /auth|api[-_]?key|token|secret|password|cookie/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function memosConfigFile(dataHome) {
  if (!dataHome) throw new Error("缺少数据目录，无法定位外部 MCP 配置");
  return path.join(dataHome, "external-mcp.json");
}

function readDoc(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { doc: { version: 1, mcpServers: {} }, exists: false };
    throw error;
  }
  if (!raw.trim()) return { doc: { version: 1, mcpServers: {} }, exists: true };
  let doc;
  try {
    doc = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("外部 MCP 配置文件不是合法 JSON，先修好再保存 MemOS Key");
  }
  if (!isPlainObject(doc)) throw new Error("外部 MCP 配置文件的顶层不是对象");
  return { doc, exists: true };
}

function findMemosEntry(doc) {
  const map = isPlainObject(doc.mcpServers) ? doc.mcpServers : null;
  if (map) {
    if (Object.prototype.hasOwnProperty.call(map, MEMOS_SERVER_ID)) {
      return { id: MEMOS_SERVER_ID, entry: map[MEMOS_SERVER_ID], where: "mcpServers" };
    }
    const id = Object.keys(map).find((name) => MEMOS_ID_PATTERN.test(name));
    if (id) return { id, entry: map[id], where: "mcpServers" };
  }
  if (Array.isArray(doc.servers)) {
    const index = doc.servers.findIndex((item) => isPlainObject(item) && MEMOS_ID_PATTERN.test(String(item.id ?? "")));
    if (index >= 0) return { id: String(doc.servers[index].id), entry: doc.servers[index], where: "servers", index };
  }
  return null;
}

/** 判断条目里有没有像 Key 的凭据；只看 headers / env，不碰 url 查询串。 */
function entryHasKey(entry) {
  if (!isPlainObject(entry)) return false;
  for (const [name, value] of Object.entries(isPlainObject(entry.headers) ? entry.headers : {})) {
    if (!SECRET_NAME_PATTERN.test(name)) continue;
    const text = String(value ?? "").trim();
    if (text && text !== "Bearer" && text !== "***") return true;
  }
  for (const [name, value] of Object.entries(isPlainObject(entry.env) ? entry.env : {})) {
    if (!SECRET_NAME_PATTERN.test(name)) continue;
    if (String(value ?? "").trim()) return true;
  }
  return false;
}

function normalizeUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    throw new Error("MemOS MCP 地址不是合法 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("MemOS MCP 地址只支持 http/https");
  if (url.username || url.password) throw new Error("MemOS MCP 地址不能带用户名或密码（凭据请放在 Key 里）");
  if (url.hash) throw new Error("MemOS MCP 地址不能带 # 锚点");
  return url.toString();
}

/** 把 Key 写进 map：有多条像凭据的字段只改第一条，其余原样保留。 */
function withSecret(map, key, fallbackName, scheme) {
  const source = isPlainObject(map) ? map : {};
  const next = { ...source };
  const found = Object.keys(source).find((name) => SECRET_NAME_PATTERN.test(name));
  if (found) {
    const old = String(source[found] ?? "");
    const prefix = scheme ? /^(\s*Bearer\s+)/i.exec(old) : null;
    next[found] = prefix ? `${prefix[1]}${key}` : key;
  } else {
    next[fallbackName] = scheme ? `${scheme}${key}` : key;
  }
  return next;
}

function withKey(entry, key) {
  const next = { ...entry };
  const transport = entry.transport ?? (entry.url ? "http" : "stdio");
  if (transport === "stdio") {
    next.env = withSecret(entry.env, key, "MEMOS_API_KEY");
  } else {
    next.headers = withSecret(entry.headers, key, "Authorization", "Bearer ");
  }
  return next;
}

function newEntry({ key, url, command, args }) {
  if (url) {
    return {
      label: "MemOS",
      transport: "http",
      httpTransport: "auto",
      url: normalizeUrl(url),
      headers: { Authorization: `Bearer ${key}` },
      enabled: true,
    };
  }
  if (command) {
    return {
      label: "MemOS",
      transport: "stdio",
      command: String(command),
      args: Array.isArray(args) ? args.map(String) : [],
      env: { MEMOS_API_KEY: key },
      enabled: true,
    };
  }
  throw new Error(
    "还没有 MemOS MCP 地址：仓库里没有内置官方地址，请在「MCP 地址」里填写 MemOS 官方 MCP 地址"
    + "（或先用 configure_mcp 建好 memos 条目）再保存 Key",
  );
}

function writeDoc(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(handle, JSON.stringify(doc, null, 2), "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    let lastError = error;
    for (let attempt = 0; attempt < 10; attempt++) {
      const until = Date.now() + 5 * (attempt + 1);
      while (Date.now() < until) { /* Windows 上目标文件可能被短暂占用，重试几次 */ }
      try {
        fs.renameSync(temp, file);
        lastError = null;
        break;
      } catch (retryError) {
        lastError = retryError;
      }
    }
    if (lastError) {
      try { fs.unlinkSync(temp); } catch { /* 清理失败无所谓 */ }
      throw lastError;
    }
  }
}

/**
 * 保存 Key（key 为空表示沿用已保存的 Key，只重新启用 / 重连）。
 * 已有条目只改凭据与 enabled，保留 command / url / timeout / tools 等所有字段。
 */
async function saveMemosKey({ dataHome, key, url, command, args, log = () => {} } = {}) {
  // 用户可能把整行 "Bearer xxx" 粘进来；只保留令牌本身，避免存成 "Bearer Bearer xxx"
  const secret = String(key ?? "").trim().replace(/^Bearer\s+/i, "").trim();
  const file = memosConfigFile(dataHome);
  const { doc } = readDoc(file);
  const found = findMemosEntry(doc);
  let nextDoc;
  let id = found?.id ?? MEMOS_SERVER_ID;
  let created = false;

  if (found) {
    if (!isPlainObject(found.entry)) throw new Error(`外部 MCP 配置里的 ${found.id} 不是一个对象，先修好再保存`);
    if (!secret && !entryHasKey(found.entry)) throw new Error("没有已保存的 MemOS API Key，请先填写 Key");
    const updated = secret ? withKey(found.entry, secret) : { ...found.entry };
    updated.enabled = true;
    if (found.where === "mcpServers") {
      nextDoc = {
        ...doc,
        version: doc.version ?? 1,
        mcpServers: { ...doc.mcpServers, [found.id]: updated },
      };
    } else {
      nextDoc = {
        ...doc,
        version: doc.version ?? 1,
        servers: doc.servers.map((item, index) => (index === found.index ? updated : item)),
      };
    }
  } else {
    if (!secret) throw new Error("请先填写 MemOS API Key");
    const entry = newEntry({ key: secret, url, command, args });
    const useArray = !isPlainObject(doc.mcpServers) && Array.isArray(doc.servers);
    nextDoc = useArray
      ? { ...doc, version: doc.version ?? 1, servers: [...doc.servers, { id, ...entry }] }
      : { ...doc, version: doc.version ?? 1, mcpServers: { ...(isPlainObject(doc.mcpServers) ? doc.mcpServers : {}), [id]: entry } };
    created = true;
  }

  writeDoc(file, nextDoc);
  log(created
    ? "[memos] 已创建 memos 外部 MCP 条目"
    : secret
      ? "[memos] 已更新 memos 外部 MCP 条目的 API Key"
      : "[memos] 已重新启用 memos 外部 MCP 条目");
  return { id, created, updatedKey: Boolean(secret), configured: true, enabled: true };
}

/** 断开 = 禁用条目，Key 留在配置里，下一次保存可以只重连、不用重填。 */
async function setMemosEnabled({ dataHome, enabled, log = () => {} } = {}) {
  const file = memosConfigFile(dataHome);
  const { doc } = readDoc(file);
  const found = findMemosEntry(doc);
  if (!found) throw new Error("还没有 memos 外部 MCP 条目");
  if (!isPlainObject(found.entry)) throw new Error(`外部 MCP 配置里的 ${found.id} 不是一个对象，先修好再断开`);
  const updated = { ...found.entry, enabled: Boolean(enabled) };
  const nextDoc = found.where === "mcpServers"
    ? { ...doc, version: doc.version ?? 1, mcpServers: { ...doc.mcpServers, [found.id]: updated } }
    : { ...doc, version: doc.version ?? 1, servers: doc.servers.map((item, index) => (index === found.index ? updated : item)) };
  writeDoc(file, nextDoc);
  log(enabled ? "[memos] 已启用 memos 外部 MCP 条目" : "[memos] 已断开（禁用 memos 外部 MCP 条目）");
  return { id: found.id, enabled: Boolean(enabled) };
}

/**
 * 面板 / 设置页只读状态。health 传 ExternalMcpManager.snapshot() 的结果。
 * 返回值永远只有 configured / status（以及设置页用的 enabled），绝不带 Key 或 headers / env 原文。
 */
function memosStatus({ dataHome, health = [] } = {}) {
  let doc;
  try {
    ({ doc } = readDoc(memosConfigFile(dataHome)));
  } catch {
    return { configured: false, status: "error" };
  }
  const found = findMemosEntry(doc);
  if (!found) return { configured: false, status: "not-configured" };
  const configured = entryHasKey(found.entry);
  const enabled = found.entry?.enabled !== false;
  let status;
  if (!enabled) {
    status = "disabled";
  } else if (!configured) {
    status = "not-configured";
  } else {
    const row = Array.isArray(health) ? health.find((item) => item?.id === found.id) : null;
    status = !row ? "stopped"
      : row.state === "ready" ? "running"
        : row.state === "connecting" ? "connecting"
          : row.state === "error" ? "error"
            : "stopped";
  }
  return { configured, status, enabled };
}

/** 旧版 4b 把 Key 写在 settings.json 的 context.memosApiKey 里；只读出来做一次性迁移。 */
function readLegacyMemosKey(dataHome) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataHome, "settings.json"), "utf8").replace(/^\uFEFF/, ""));
    const value = raw?.context?.memosApiKey;
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

module.exports = {
  MEMOS_SERVER_ID,
  memosConfigFile,
  memosStatus,
  readLegacyMemosKey,
  saveMemosKey,
  setMemosEnabled,
};
