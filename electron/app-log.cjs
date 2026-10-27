/**
 * 应用日志落盘 —— 把 main.cjs 的 pushLog 追加到 <DATA_HOME>/logs/app-YYYY-MM-DD.log。
 *
 * 为什么要单独一个模块：
 *   · pushLog 还要喂界面（内存里最近 500 条），落盘失败绝不能影响它；
 *   · 脱敏只在这一路做，界面里的内存日志保持原样，现场排查时看的是同一份内容；
 *   · 纯 Node，不依赖 Electron，electron/app-log-selftest.cjs 可以直接跑。
 *
 * 脱敏分两层：
 *   1. 已知的秘密值（路由令牌、隧道令牌 / ngrok / Cloudflare、所有连接器令牌）逐个替换；
 *      这些值会随换令牌、新建连接器变化，所以每次写盘前现取，不做长期缓存；
 *   2. 通用模式：/mcp/ 和 /healthz/ 后面的路径段、eyJ 开头的 base64url 串、
 *      TUNNEL_TOKEN= 和 --token 后面的值，一律换成 <令牌>。
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

/** 单个日志文件的上限；超过就停写当天，避免日志把磁盘慢慢吃满 */
const MAX_BYTES = 5 * 1024 * 1024;
/** 启动时清掉多少天以前的日志 */
const RETENTION_DAYS = 14;
/** 太短的值不参与替换，避免把正常单词误伤 */
const MIN_SECRET_LENGTH = 16;

const pad = (value, width = 2) => String(value).padStart(width, "0");

/** 本地日期 YYYY-MM-DD（按天切文件用本地时间，和用户看到的日志时间一致） */
function localDay(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 本地时间 YYYY-MM-DD HH:mm:ss.SSS */
function localStamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return `${localDay(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** 一条记录 = 本地时间 + [kind] + level + text；文本里的换行换成 ⏎，保证一条一行 */
function formatLine(record = {}) {
  const at = Number(record.at);
  const date = Number.isFinite(at) ? new Date(at) : new Date();
  const kind = String(record.kind ?? "app").replace(/[\r\n]+/g, " ").trim() || "app";
  const level = String(record.level ?? "info").replace(/[\r\n]+/g, " ").trim() || "info";
  const text = String(record.text ?? "").replace(/\r\n?|\n/g, "⏎");
  return `${localStamp(date)} [${kind}] ${level} ${text}`;
}

/** 通用模式脱敏：不依赖任何调用方上下文，兜住「日志里顺手带了地址」的情况 */
function redactPatterns(text) {
  let out = String(text);
  /*
   * 先处理完整网址：浏览器格子的地址可能被原样打进日志，查询串里常有令牌 / 邮箱，
   * # 片段也可能带一次性凭据。只保留协议 / 域名 / 路径，查询串和片段整体省略。
   * 主机 + 路径沿用原来的字符集（ASCII 括号 / 方括号到这里就停）；
   * 从第一个 ? 或 # 开始单独扫，ASCII 括号和方括号不当作结束符（__cft__[0]、user[email] 这类要整段吃掉），
   * 遇到空白、引号、尖括号、反引号或中文标点才停，避免把「网址后面的话」一起吃进来。
   * 放在 /mcp/ 替换之前：替换出来的 <令牌> 含尖括号，会截断后面的网址匹配。
   */
  out = out.replace(/\b(https?:\/\/(?:<令牌>|[^\s<>"'`，。；、（）()\[\]{}?#])+)([?#][^\s<>"'`，。；、：！？（）「」]*)?/gi, (_match, url, tail) => {
    if (!tail) return url;
    const hasQuery = tail.includes("?");
    const hasFragment = tail.includes("#");
    if (hasQuery && hasFragment) return `${url}?<已省略>#<已省略>`;
    return `${url}${hasQuery ? "?<已省略>" : "#<已省略>"}`;
  });
  // /mcp/<令牌> 与 /healthz/<令牌>：令牌段一直取到空白、斜杠或常见标点为止
  out = out.replace(/(\/(?:mcp|healthz)\/)[^\s/?#"'<>，。；、（）()[\]{}]+/gi, "$1<令牌>");
  // JWT / 长 base64url：eyJ 开头且总长至少 20
  out = out.replace(/eyJ[A-Za-z0-9_-]{17,}/g, "<令牌>");
  // 环境变量与命令行参数
  out = out.replace(/(TUNNEL_TOKEN\s*=\s*)(["']?)[^\s"'&]+\2/gi, "$1<令牌>");
  out = out.replace(/(--token(?:\s+|=))(["']?)[^\s"']+\2/gi, "$1<令牌>");
  // HTTP 授权头（转发外部 MCP、调 Cloudflare API 时可能被顺手打进日志）
  out = out.replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1<令牌>");
  return out;
}

/** 已知秘密值替换（按长度从长到短，避免一个值是另一个值的前缀时替换不干净） */
function redactSecrets(text, secrets) {
  let out = String(text);
  const values = [...new Set((Array.isArray(secrets) ? secrets : [])
    .filter((value) => typeof value === "string" && value.length >= MIN_SECRET_LENGTH))]
    .sort((a, b) => b.length - a.length);
  for (const value of values) out = out.split(value).join("<令牌>");
  return out;
}

/** 落盘前统一走这里：先替换已知值，再兜通用模式 */
function redact(text, secrets) {
  return redactPatterns(redactSecrets(text, secrets));
}

/**
 * 现取所有已知秘密值（只读）。
 * 连接器优先走 state.connectors.list()（内存里是最新的），没有这个实例时退回去读 connectors.json；
 * 路由令牌读 <DATA_HOME>/route-token.json，同时带上 state.app 正在用的那把（刚生成还没落盘时也能兜住）。
 */
function collectSecrets({ dataHome, currentToken, settings, connectors } = {}) {
  const found = new Set();
  const add = (value) => {
    if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH) found.add(value);
  };

  if (dataHome) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dataHome, "route-token.json"), "utf8"));
      add(raw?.token);
    } catch { /* 还没生成 / 读坏了：这轮就没有这个值，不打扰调用方 */ }
  }
  add(currentToken);

  let saved = settings;
  try { if (settings && typeof settings.all === "function") saved = settings.all(); } catch { saved = null; }
  add(saved?.tunnel?.token);
  add(saved?.tunnel?.ngrokAuthtoken);
  add(saved?.cloudflare?.apiToken);

  let listed = false;
  if (connectors && typeof connectors.list === "function") {
    try {
      const rows = connectors.list();
      if (Array.isArray(rows)) {
        listed = true;
        for (const row of rows) add(row?.token);
      }
    } catch { /* 连接器存储读不了：下面还能从文件兜一层 */ }
  }
  if (!listed && dataHome) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dataHome, "connectors.json"), "utf8"));
      for (const row of Array.isArray(raw?.connectors) ? raw.connectors : []) add(row?.token);
    } catch { /* 没有这个文件是正常的 */ }
  }

  // 外部 MCP 配置里的凭据（例如 MemOS 的 Authorization / MEMOS_API_KEY）也参与脱敏：
  // 万一某条日志把请求头或环境变量带出来，落盘时也会被换成 <令牌>。
  if (dataHome) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dataHome, "external-mcp.json"), "utf8").replace(/^\uFEFF/, ""));
      const servers = [
        ...Object.values(raw?.mcpServers && typeof raw.mcpServers === "object" ? raw.mcpServers : {}),
        ...(Array.isArray(raw?.servers) ? raw.servers : []),
      ];
      for (const server of servers) {
        if (!server || typeof server !== "object") continue;
        for (const [name, value] of Object.entries(server.headers ?? {})) {
          if (!/auth|api[-_]?key|token|secret|password|cookie/i.test(name)) continue;
          add(String(value ?? ""));
          const match = /^\s*(?:Bearer|Basic)\s+(.+?)\s*$/i.exec(String(value ?? ""));
          if (match) add(match[1]);
        }
        for (const [name, value] of Object.entries(server.env ?? {})) {
          if (!/auth|api[-_]?key|token|secret|password|cookie/i.test(name)) continue;
          add(String(value ?? ""));
        }
      }
    } catch { /* 没有外部 MCP 配置 / 读坏了：不影响日志写入 */ }
  }

  return [...found];
}

/**
 * 启动时清理：只认 app-YYYY-MM-DD.log，早于「今天往前 14 天」的删掉。
 * 返回删掉的文件名，方便自测核对。
 */
async function cleanupOldLogs(dir, nowMs = Date.now(), retentionDays = RETENTION_DAYS) {
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  const cutoff = today.getTime() - retentionDays * 86_400_000;
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return []; }
  const removed = [];
  for (const name of names) {
    const match = /^app-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(name);
    if (!match) continue;
    const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
    if (day < cutoff) {
      try { await fsp.rm(path.join(dir, name), { force: true }); removed.push(name); } catch { /* 删不掉就下次再试 */ }
    }
  }
  return removed;
}

/**
 * 创建日志写入器。write() 永不抛异常；真正的写盘排队异步做，一次只跑一轮。
 * 选项主要是给自测用的（now / maxBytes / retentionDays），主进程只用 dataHome + getSecrets。
 */
function createAppLog({ dataHome, getSecrets = () => [], now = () => Date.now(), maxBytes = MAX_BYTES, retentionDays = RETENTION_DAYS } = {}) {
  const dir = path.join(dataHome, "logs");
  const queue = [];
  /** 各文件已经写到多少字节：每个文件只 stat 一次，之后按写入量累加 */
  const sizes = new Map();
  /** 超过上限、今天不再写的日期 */
  const stopped = new Set();
  /** 已经记过「超过 5MB」提示的日期 */
  const noticed = new Set();
  let flushing = null;

  const nowMs = () => {
    try {
      const value = now();
      return Number.isFinite(Number(value)) ? Number(value) : Date.now();
    } catch { return Date.now(); }
  };
  /** 上一次清理旧日志的日期：跨天写第一条日志时再清一次（不只是启动时清） */
  let cleanupDay = localDay(nowMs());

  const ready = (async () => {
    try { await fsp.mkdir(dir, { recursive: true }); } catch { /* 建不了目录时下面 append 也会失败，静默跳过 */ }
  })();
  /** 启动清理的完成信号（主进程不等它；自测可以 await） */
  const cleanupReady = ready.then(() => cleanupOldLogs(dir, nowMs(), retentionDays)).catch(() => []);

  /** 每条记录写之前都现取一次：换令牌、新建连接器后立刻生效，不会有一小段时间漏脱敏 */
  const readSecrets = () => {
    try { return getSecrets() || []; } catch { return []; }
  };

  /** 当天文件到上限：停写并补一条提示（同一天只记一次） */
  async function stopDay(day, file, secrets) {
    stopped.add(day);
    if (noticed.has(day)) return;
    noticed.add(day);
    const notice = `${redact(formatLine({ at: nowMs(), kind: "app", level: "warn", text: "日志超过 5MB，今天剩下的不再写盘" }), secrets)}\n`;
    try { await fsp.appendFile(file, notice, "utf8"); } catch { /* 提示也写不进就算了 */ }
  }

  async function writeRecord(record) {
    const at = Number.isFinite(Number(record.at)) ? Number(record.at) : nowMs();
    const day = localDay(at);
    if (stopped.has(day)) return;
    // 跨天写第一条日志时顺手做一次 14 天清理（原来只在启动时清，长期不重启会一直攒着）
    if (day > cleanupDay) {
      cleanupDay = day;
      await cleanupOldLogs(dir, at, retentionDays).catch(() => []);
    }
    const secrets = readSecrets();
    const file = path.join(dir, `app-${day}.log`);

    let size = sizes.get(day);
    if (size === undefined) {
      try { size = (await fsp.stat(file)).size; } catch { size = 0; }
      sizes.set(day, size);
    }

    // 文件在本次运行之前就已经超过上限：不再往里写，只补一次提示
    if (size > maxBytes) {
      await stopDay(day, file, secrets);
      return;
    }

    let line = redact(formatLine({ ...record, at }), secrets);
    if (!line.endsWith("\n")) line += "\n";
    const bytes = Buffer.byteLength(line);
    await fsp.appendFile(file, line, "utf8");
    sizes.set(day, size + bytes);
    // 「超过 5MB 就停写」：允许跨过上限的那一条写进去，之后当天不再写
    if (size + bytes > maxBytes) await stopDay(day, file, secrets);
  }

  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      try {
        await ready;
        while (queue.length) {
          const batch = queue.splice(0, 50);
          for (const record of batch) {
            try { await writeRecord(record); } catch { /* 单条写失败就跳过，下一轮照常 */ }
          }
        }
      } catch { /* 落盘问题一律吞掉 */ }
      finally { flushing = null; }
    })();
    return flushing;
  }

  function write(entry) {
    try {
      const record = entry && typeof entry === "object" ? entry : { text: String(entry ?? "") };
      queue.push({ ...record, at: Number.isFinite(Number(record.at)) ? Number(record.at) : nowMs() });
      void flush();
    } catch { /* 绝不影响 pushLog 和界面 */ }
  }

  return { dir, write, flush, ready: cleanupReady };
}

module.exports = {
  MAX_BYTES,
  RETENTION_DAYS,
  MIN_SECRET_LENGTH,
  localDay,
  localStamp,
  formatLine,
  redact,
  redactPatterns,
  redactSecrets,
  collectSecrets,
  cleanupOldLogs,
  createAppLog,
};
