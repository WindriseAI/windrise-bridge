/**
 * 侧边栏 / 新标签页用的只读状态。
 *
 * 这里只做两件事：
 *   1. 把主进程里的真实状态收成一份「能直接塞进 chrome.storage.session」的小对象；
 *   2. 保证这份对象里**永远没有**口令明文、带令牌的地址、调用参数内容。
 *
 * 所以 buildPanelState 是「只认识白名单字段」的构造器：输入里多出来的 token / key / args
 * 一概不会被复制到输出。即使上游以后接错了数据，插件网页也读不到秘密。
 *
 * 不 require electron，纯 Node 自测可以直接跑。
 */

const fs = require("node:fs");
const path = require("node:path");

/** chrome.storage.session 里的键：侧边栏和新标签页都读它 */
const PANEL_STATE_KEY = "panelState";
/** 状态形状版本：以后字段不兼容地改了就 +1，插件那边可以按版本兼容 */
const PANEL_STATE_VERSION = 1;
/** 最近操作最多给几条（需求：10 条） */
const RECENT_ACTION_LIMIT = 10;
/** 调用日志文件名：和 src/core/call-log.js 保持一致 */
const CALL_LOG_PATTERN = /^mcp-calls-\d{4}-\d{2}-\d{2}\.jsonl$/;
/** 只读日志尾巴，避免一个很大的 jsonl 把主进程内存顶爆 */
const TAIL_BYTES = 256 * 1024;

function textOf(value, limit) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function positiveSlot(value) {
  const slot = Number(value);
  return Number.isInteger(slot) && slot > 0 ? slot : null;
}

/**
 * 公网 MCP 地址 → 不带令牌的 /mcp 形式。
 *
 * 主程序内部记的地址可能是 https://xxx/mcp/<路由令牌>。这个函数把 /mcp 后面的东西
 * （令牌、查询串、锚点）全部扔掉，只留 origin + 到 /mcp 为止的路径。
 * 认不出来的地址返回 null，绝不把原文透出去。
 */
function tokenFreeMcpUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  const pathname = url.pathname.replace(/\/+$/, "");
  const at = pathname.search(/\/mcp(?:\/|$)/i);
  const base = at >= 0 ? pathname.slice(0, at) : pathname;
  url.pathname = `${base}/mcp`.replace(/\/{2,}/g, "/");
  return url.toString().replace(/\/$/, "");
}

/** 推荐位链接：只放行 http(s)，去掉账号密码；保留查询串（以后可能带渠道参数） */
function safeHttpUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeSelf(self) {
  const input = self && typeof self === "object" ? self : {};
  return {
    slot: positiveSlot(input.slot),
    name: textOf(input.name, 120),
    hidden: input.hidden === true,
  };
}

function normalizeGrids(grids) {
  const list = Array.isArray(grids) ? grids : [];
  return list
    .slice(0, 40)
    .map((item) => {
      const slot = positiveSlot(item?.slot);
      return {
        slot,
        name: textOf(item?.name, 120) || (slot ? `格子 ${slot}` : "未命名账号"),
        hidden: item?.hidden === true,
      };
    })
    .sort((a, b) => {
      const left = a.slot ?? Number.MAX_SAFE_INTEGER;
      const right = b.slot ?? Number.MAX_SAFE_INTEGER;
      if (left !== right) return left - right;
      return a.name.localeCompare(b.name);
    });
}

function normalizeAt(value) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const time = Date.parse(text);
    return Number.isFinite(time) ? new Date(time).toISOString() : text.slice(0, 40);
  }
  const time = Number(value);
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null;
}

/**
 * 本格子的空间列表（产品计划「空间第一阶段」）：只给 id、名字、owner、标签页数、groupId。
 * groupId 是空间对应的浏览器标签组编号（「我的」没有标签组，是 null）；
 * 侧边栏拿它判断「当前活动标签页属于哪个 AI 空间」。
 * 空间 id / 名字是 AI 起的，照普通文本裁切；owner 只认 human / ai，别的按 human。
 */
function normalizeSpaces(spaces) {
  const list = Array.isArray(spaces) ? spaces : [];
  return list
    .slice(0, 40)
    .map((item) => {
      const id = textOf(item?.id, 40);
      const tabCount = Number(item?.tabCount);
      const groupId = item?.groupId === undefined || item?.groupId === null ? null : Number(item.groupId);
      return {
        id,
        name: textOf(item?.name, 40) || id || "未命名空间",
        owner: item?.owner === "ai" ? "ai" : "human",
        tabCount: Number.isInteger(tabCount) && tabCount >= 0 ? Math.min(tabCount, 99) : 0,
        groupId: Number.isInteger(groupId) && groupId >= 0 ? groupId : null,
      };
    })
    .filter((item) => item.id);
}

function normalizeRecentActions(actions) {
  const list = Array.isArray(actions) ? actions : [];
  return list
    .slice(0, RECENT_ACTION_LIMIT)
    .map((item) => ({
      tool: textOf(item?.tool, 80),
      at: normalizeAt(item?.at),
      // 成功与否只给布尔值：不把错误信息带出去（里面可能带路径或参数）
      ok: item?.ok === true,
    }))
    .filter((item) => item.tool);
}

/**
 * 插件区（产品计划 2026-10-26「插件装到所有格子」）：
 * 共享库清单只给 id / name / version / enabled，**不给路径**；autoSync 默认开；
 * restartNeeded 只给布尔值（运行中装卸不可用的格子提示「重开后生效」，不给原因细节）。
 */
function normalizeExtensions(extensions) {
  const source = extensions && typeof extensions === "object" ? extensions : {};
  const list = Array.isArray(source.shared) ? source.shared : [];
  return {
    autoSync: source.autoSync !== false,
    restartNeeded: source.restartNeeded === true,
    shared: list
      .slice(0, 100)
      .map((item) => ({
        id: /^[a-p]{32}$/.test(String(item?.id ?? "")) ? String(item.id) : "",
        name: textOf(item?.name, 120),
        version: textOf(item?.version, 40),
        enabled: item?.enabled !== false,
      }))
      .filter((item) => item.id),
  };
}

function normalizeRecommendation(input) {
  const item = input && typeof input === "object" ? input : {};
  return {
    title: textOf(item.title, 80),
    description: textOf(item.description, 200),
    url: safeHttpUrl(item.url),
  };
}

/**
 * 工具清单（引导页第 4 步用）：从主进程的工具注册表（src/core/registry.js listTools()）取，
 * 只透 name / title / description / capability / source 五样。别的字段（handler / inputSchema / args）一概不带。
 */
function normalizeTools(input) {
  const list = Array.isArray(input) ? input : [];
  return list
    .slice(0, 150)
    .map((item) => ({
      name: textOf(item?.name, 64),
      title: textOf(item?.title, 80),
      description: textOf(item?.description, 200),
      capability: textOf(item?.capability, 16),
      source: textOf(item?.source, 40),
    }))
    .filter((item) => item.name);
}

/**
 * 按客户端的填法（引导页第 3 步用）：数据在 electron/ai-clients.cjs 的 clientGuides()。
 * 只透 id / name / kind（remote 远程 / local 本机）/ hint 四样；提示里不含口令，地址由页面自己拼。
 * 注意字段名改成 id（上游叫 key）：面板状态里不出现任何叫「key」的字段，免得起疑。
 */
function normalizeAiClients(input) {
  const list = Array.isArray(input) ? input : [];
  return list
    .slice(0, 20)
    .map((item) => ({
      // 上游（ai-clients.cjs）字段叫 key；已构造过的状态字段叫 id——两个都认，保证再洗一遍幂等
      id: textOf(item?.id ?? item?.key, 32),
      name: textOf(item?.name, 60),
      kind: item?.kind === "local" ? "local" : "remote",
      hint: textOf(item?.hint, 300),
    }))
    .filter((item) => item.id && item.name);
}

/**
 * 授权状态：只给「已激活 / 未激活 + 到期日期 + 剩余天数 + 原因」。
 * 主进程传上来的 license 里绝不会有激活码 / 设备密钥 / 许可证，但这里仍只挑白名单字段：
 * 万一上游接错了数据（code / token / secret / deviceId…），一律不会出现在输出里。
 */
function normalizeLicense(input) {
  const source = input && typeof input === "object" ? input : {};
  const expiresAt = normalizeAt(source.expiresAt);
  const rawDays = source.daysLeft;
  const daysLeft = rawDays === null || rawDays === undefined || rawDays === "" ? null : Number(rawDays);
  return {
    activated: source.activated === true,
    expiresAt,
    daysLeft: Number.isInteger(daysLeft) && daysLeft >= 0 ? Math.min(daysLeft, 9999) : null,
    reason: textOf(source.reason, 120) || null,
  };
}

/**
 * 购买价目：只透 kind / name / days / price(分) / available。
 * 价格和开放状态由主程序从服务器拉；这里再洗一遍，防止上游误塞密钥或任意字段。
 */
function normalizePayPlans(input) {
  const list = Array.isArray(input) ? input : [];
  const order = { D: 0, M: 1, Y: 2 };
  return list
    .map((item) => {
      const kind = item?.kind === "D" || item?.kind === "M" || item?.kind === "Y" ? item.kind : "";
      const days = Math.floor(Number(item?.days));
      const price = Math.floor(Number(item?.price));
      return {
        kind,
        name: textOf(item?.name, 40),
        days: Number.isInteger(days) && days > 0 ? Math.min(days, 9999) : 0,
        price: Number.isInteger(price) && price >= 0 ? Math.min(price, 100_000_000) : 0,
        available: item?.available === true,
      };
    })
    .filter((item) => item.kind)
    .sort((a, b) => order[a.kind] - order[b.kind]);
}

const MEMOS_STATUSES = new Set(["running", "connecting", "error", "stopped", "disabled", "not-configured"]);

/** MemOS 只放行固定的连接状态词；没配置时一般是 not-configured，配置读坏了保留 error。 */
function normalizeMemosStatus(value, configured) {
  const text = textOf(value, 20);
  if (!configured) return text === "error" ? "error" : "not-configured";
  return MEMOS_STATUSES.has(text) ? text : "stopped";
}

/**
 * 把主进程状态收成插件可用的只读形状。
 *
 * 只读取下面这些字段，别的（token / password / routeToken / args …）一律不碰。
 *
 * @param {{
 *   self?: {slot?: number|null, name?: string, hidden?: boolean},
 *   grids?: Array<{slot?: number|null, name?: string, hidden?: boolean}>,
 *   spaces?: Array<{id?: string, name?: string, owner?: "human"|"ai", tabCount?: number, groupId?: number|null}>,
 *   connection?: {connected?: boolean, level?: string, label?: string, publicMcpUrl?: string|null,
 *     tokenCount?: number, pathEnabled?: boolean, provider?: string|null},
 *   license?: {activated?: boolean, expiresAt?: string|number|null, daysLeft?: number|null, reason?: string|null},
 *   payPlans?: Array<{kind?: "D"|"M"|"Y", name?: string, days?: number, price?: number, available?: boolean}>,
 *   tunnelProvider?: string|null,
 *   toolTier?: "basic"|"full",
 *   brokerRunning?: boolean,
 *   sharedContext?: boolean,
 *   sharedContextDir?: string,
 *   memosConfigured?: boolean,
 *   memosStatus?: "running"|"connecting"|"error"|"stopped"|"disabled"|"not-configured",
 *   tools?: Array<{name?: string, title?: string, description?: string, capability?: string, source?: string}>,
 *   aiClients?: Array<{key?: string, name?: string, kind?: "remote"|"local", hint?: string}>,
 *   extensions?: {autoSync?: boolean, restartNeeded?: boolean, shared?: Array<{id?: string, name?: string, version?: string, enabled?: boolean}>},
 *   recentActions?: Array<{tool: string, at?: string|number, ok?: boolean}>,
 *   recommendation?: {title?: string, description?: string, url?: string},
 *   updatedAt?: number,
 * }} input
 */
function buildPanelState(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const connection = source.connection && typeof source.connection === "object" ? source.connection : {};
  const tokenCount = Number(connection.tokenCount ?? source.tokenCount);
  const level = textOf(connection.level, 20)
    || textOf(source.level, 20)
    || (connection.connected === true || source.connected === true ? "connected" : "stopped");
  // 同时接受主进程的原始字段（publicMcpUrl / brokerRunning / 布尔 sharedContext）
  // 和已经构造过的字段（publicUrl / adminBroker.running / 对象 sharedContext）——push 前会再洗一遍。
  const sharedContext = typeof source.sharedContext === "object"
    ? source.sharedContext?.enabled !== false
    : source.sharedContext !== false;
  const sharedContextDir = textOf(
    typeof source.sharedContext === "object" ? source.sharedContext?.dir : source.sharedContextDir,
    400,
  ) || null;
  const memosConfigured = source.memosConfigured === true || source.memos?.configured === true;
  return {
    version: PANEL_STATE_VERSION,
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : Date.now(),
    self: normalizeSelf(source.self),
    grids: normalizeGrids(source.grids),
    spaces: normalizeSpaces(source.spaces),
    connection: {
      connected: connection.connected === true || source.connected === true || level === "connected",
      level,
      label: textOf(connection.label, 40) || textOf(source.label, 40) || (level === "connected" ? "已连接" : "未连接"),
      publicUrl: tokenFreeMcpUrl(connection.publicMcpUrl ?? connection.publicUrl ?? source.publicMcpUrl ?? source.publicUrl),
      tokenCount: Number.isInteger(tokenCount) && tokenCount > 0 ? Math.min(tokenCount, 99) : 0,
      pathEnabled: connection.pathEnabled !== false,
      provider: textOf(connection.provider, 40) || null,
    },
    tunnel: {
      provider: textOf(source.tunnelProvider, 40)
        || textOf(source.tunnel?.provider, 40)
        || textOf(connection.provider, 40)
        || null,
    },
    // 授权状态（已激活 / 未激活 + 到期）：激活码、设备密钥、许可证一律不进面板
    license: normalizeLicense(source.license),
    // 购买价目：只给档位 / 名字 / 天数 / 价格 / 是否开放，二维码和订单号也不进面板
    payPlans: normalizePayPlans(source.payPlans),
    toolTier: source.toolTier === "full" ? "full" : "basic",
    adminBroker: { running: source.brokerRunning === true || source.adminBroker?.running === true },
    sharedContext: { enabled: sharedContext, dir: sharedContextDir },
    // MemOS 只给「配没配 + 连接状态」，API Key / headers / env 一律不出主进程
    memos: {
      configured: memosConfigured,
      status: normalizeMemosStatus(source.memosStatus ?? source.memos?.status, memosConfigured),
    },
    extensions: normalizeExtensions(source.extensions),
    recentActions: normalizeRecentActions(source.recentActions),
    recommendation: normalizeRecommendation(source.recommendation),
    // 引导页用：工具清单（注册表）和按客户端填法（ai-clients.cjs），都不含口令
    tools: normalizeTools(source.tools),
    aiClients: normalizeAiClients(source.aiClients),
  };
}

/** 从文件尾部读最后几行（大文件不整份读） */
function readTailLines(file, maxLines) {
  const info = fs.statSync(file);
  const start = Math.max(0, info.size - TAIL_BYTES);
  const length = info.size - start;
  if (length <= 0) return [];
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  let text = buffer.toString("utf8");
  // 从中间截断时，第一行可能是半行：只要前面还有内容就丢掉
  if (start > 0) {
    const newline = text.indexOf("\n");
    text = newline >= 0 ? text.slice(newline + 1) : "";
  }
  return text.split(/\r?\n/).filter((line) => line.trim()).slice(-maxLines);
}

/**
 * 读现有调用日志（<dataHome>/logs/mcp-calls-YYYY-MM-DD.jsonl）里最近的几条。
 * 只取工具名、时间、成功与否，**不读 args**，所以参数内容不可能出现在输出里。
 * 返回最新在前。
 */
function readRecentActions(logsDir, limit = RECENT_ACTION_LIMIT) {
  const max = Math.min(Math.max(Number(limit) || RECENT_ACTION_LIMIT, 1), 50);
  let names = [];
  try {
    names = fs.readdirSync(logsDir).filter((name) => CALL_LOG_PATTERN.test(name)).sort().reverse();
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    let lines = [];
    try {
      lines = readTailLines(path.join(logsDir, name), max);
    } catch {
      continue;
    }
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      let parsed;
      try {
        parsed = JSON.parse(lines[index]);
      } catch {
        continue;
      }
      const tool = textOf(parsed?.tool, 80);
      if (!tool) continue;
      rows.push({ tool, at: normalizeAt(parsed?.at), ok: parsed?.ok === true });
      if (rows.length >= max) return rows;
    }
  }
  return rows;
}

/** 管理员代理的握手文件（和 src/core/broker-client.js 的默认路径一致） */
function defaultBrokerHandleFile(env = process.env) {
  const explicit = typeof env?.WINDRISE_BROKER_HANDLE === "string" ? env.WINDRISE_BROKER_HANDLE.trim() : "";
  if (explicit) return path.resolve(explicit);
  const programData = [env?.ProgramData, env?.PROGRAMDATA]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find(Boolean) || "C:\\ProgramData";
  return path.join(programData, "WindriseBroker", "handle", "broker-handle.json");
}

/**
 * 管理员代理是否在运行：读握手文件里的 pid，再问系统这个进程还在不在。
 * 只读文件 + 查进程，不连 broker（避免每 5 秒在 broker 日志里留连接记录）。
 */
function brokerStatus({ handleFile = null, env = process.env } = {}) {
  const file = handleFile || defaultBrokerHandleFile(env);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { running: false, detail: "没有管理员代理的握手文件" };
  }
  const pid = Number(parsed?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { running: false, detail: "管理员代理的握手文件不完整" };
  }
  try {
    process.kill(pid, 0);
    return { running: true, detail: `管理员代理进程 ${pid} 在运行` };
  } catch (error) {
    // EPERM：进程存在但当前用户没权限向它发信号，也算在运行
    if (error?.code === "EPERM") return { running: true, detail: `管理员代理进程 ${pid} 在运行` };
    return { running: false, detail: "管理员代理没有在运行" };
  }
}

module.exports = {
  PANEL_STATE_KEY,
  PANEL_STATE_VERSION,
  RECENT_ACTION_LIMIT,
  buildPanelState,
  normalizeExtensions,
  tokenFreeMcpUrl,
  readRecentActions,
  brokerStatus,
  defaultBrokerHandleFile,
};
