/**
 * 流程草稿 —— 把一次跑通的 MCP 调用序列抽成可复用的流程描述，给以后的 Skill / flow-pack 攒素材。
 *
 * 数据来源只有调用日志（<数据目录>/logs/mcp-calls-YYYY-MM-DD.jsonl，见 core/call-log.js）：
 * 日志本来就是事后审计用的，这里不再额外记任何东西，也不改日志格式。
 *
 * ── 几条硬规则（都是隐私 / 可重放性要求）──
 *   1. type / fill 的输入值绝不进草稿：日志里已经只剩「[输入内容，N 字]」，
 *      这里再统一换成 {{varN}}，variables 只登记名字和长度；即使旧日志里有原文也不读。
 *   2. URL 去掉 token / code / session 这类 query 参数，也去掉 hash（可能带一次性令牌）。
 *   3. target 只认日志里的 target（可访问名 / 提示名）或 CSS 选择器，绝不把快照编号（e12）写进草稿 ——
 *      编号每次快照都会变，写进去等于写了个必坏的值。
 *   4. 只留成功的步骤：ok 必须是 true，写操作（MUTATING）的 outcome 只能是 confirmed / dispatched；
 *      failed / unknown 的尝试剔除，而且「成功之后又拿着同一步重试并失败」的那次成功也剔除。
 *   5. 连续重复的快照读取合并成一步，不然草稿里全是 page_snapshot。
 *
 * 空间 / 时间范围怎么挑「一次运行」：日志里带 sessionId，一个会话就是 Agent 连着干的一串活。
 * 给定 space 时，先挑「有调用带这个空间」的会话，再取其中最新的一个；给了 since/until 就先按时间裁。
 * 同一个会话里显式写了别的空间的调用会被剔掉；没写 space 的调用（例如 space_open）保留。
 */

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);

/** 日志文件名（与 call-log.js 一致）；保留期 7 天，所以一次最多读 7 个文件。 */
const LOG_FILE = /^mcp-calls-\d{4}-\d{2}-\d{2}\.jsonl$/;
/** 输入内容在日志里的样子：[输入内容，12 字] —— 只取长度，绝不取内容。 */
const INPUT_MARKER = /^\[输入内容，(\d+) 字\]$/;
/** 读快照类工具：连续出现时合并。 */
const SNAPSHOT_TOOLS = new Set(["page_snapshot", "browser_snapshot"]);
/** 写操作只有这两种结果能算「成功」。 */
const SUCCESS_OUTCOMES = new Set(["confirmed", "dispatched"]);
/** 这两种结果说明这一步不可信，前面的成功也要一起撤掉。 */
const BAD_OUTCOMES = new Set(["failed", "unknown"]);

/** 工具名 → 动作名（page_act / browser_nav 这类从参数里的 action 取，见 actionOf）。 */
const TOOL_ACTION = new Map([
  ["browser_click", "click"],
  ["browser_type", "type"],
  ["browser_navigate", "navigate"],
  ["page_snapshot", "snapshot"],
  ["browser_snapshot", "snapshot"],
  ["page_read", "read"],
  ["browser_screenshot", "screenshot"],
  ["browser_wait", "wait"],
  ["space_open", "open"],
  ["space_close", "close"],
  ["pin_add", "pin"],
  ["pin_open", "open"],
]);

/** 这些动作等于「往框里填东西」，值必须换成变量。 */
const TYPED_ACTIONS = new Set(["type", "fill", "set_text"]);

/** URL query 里的敏感参数：命中就整条删掉（连参数名都不留）。 */
function isSensitiveParam(name) {
  const key = String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!key) return false;
  if (/(token|secret|cookie|password|credential|session|auth|signature|apikey|privatekey)/.test(key)) return true;
  return key === "code" || key === "key" || key === "sid" || key === "jwt"
    || key === "ticket" || key === "state" || key === "nonce" || key === "sig";
}

/**
 * URL 脱敏：去掉 hash 与敏感 query 参数，其余原样保留。
 * 日志里的 URL 可能被截断（摘要上限 80 字），先剥掉截断标记，再尽量解析；
 * 解析不了就退化成「去掉 ? 之后的部分」—— 宁可少记参数，也不把令牌写进草稿。
 */
export function redactUrl(raw) {
  let value = String(raw ?? "").trim();
  if (!value) return "";
  value = value.replace(/…（共 \d+ 字）$/, "").replace(/…$/, "");
  let url;
  try {
    url = new URL(value);
  } catch {
    return value.split(/[?#]/)[0];
  }
  const params = new URLSearchParams();
  for (const [name, val] of url.searchParams) {
    if (isSensitiveParam(name)) continue;
    params.append(name, val);
  }
  const search = params.toString();
  return `${url.origin}${url.pathname}${search ? `?${search}` : ""}`;
}

/** 输入值的长度：日志里只剩标记；旧日志/未打码的原值也只取长度，绝不返回内容。 */
function typedLength(args) {
  const raw = args?.text ?? args?.value;
  if (typeof raw !== "string") return null;
  const marked = INPUT_MARKER.exec(raw);
  if (marked) return Number(marked[1]);
  if (raw.startsWith("[输入内容")) return null;
  return [...raw].length;
}

/** 这次调用对应的动作名；未知工具就用工具名本身，至少还能看出调了什么。 */
function actionOf(entry) {
  const declared = entry?.args?.action;
  if (typeof declared === "string" && declared.trim()) return declared.trim().toLowerCase();
  return TOOL_ACTION.get(String(entry?.tool ?? "")) ?? String(entry?.tool ?? "");
}

/** 日志里的 target 才是人看的名字（可访问名 / 提示名）；没有就退回 CSS 选择器。 */
function targetOf(entry) {
  const target = typeof entry?.target === "string" ? entry.target.trim() : "";
  if (target) return target;
  const selector = typeof entry?.args?.selector === "string" ? entry.args.selector.trim() : "";
  return selector;
}

function timeOf(entry) {
  const parsed = Date.parse(entry?.at ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 一次调用算不算成功。
 * 写成「MUTATING 必须带 confirmed/dispatched」是因为旧日志没有 outcome 时不能凭 ok 就当成功；
 * 只读 / 导航 / 无副作用的调用没有 outcome，ok 就是唯一依据。
 */
function isSuccess(entry) {
  if (!entry || entry.ok !== true) return false;
  if (BAD_OUTCOMES.has(entry.outcome)) return false;
  if (entry.actionClass === "MUTATING") return SUCCESS_OUTCOMES.has(entry.outcome);
  return true;
}

/** 同一步的重试：工具、动作、目标都一致。 */
function sameAttempt(a, b) {
  return actionOf(a) === actionOf(b) && targetOf(a) === targetOf(b) && String(a.tool) === String(b.tool);
}

/**
 * 「成功后又重试并失败」的成功要撤掉：这种序列说明第一次其实没做成
 * （中间可能只拍了快照读回，所以允许跳过连续的快照 / 读取步骤再比较）。
 */
function hasFailedRetryAfter(entries, index) {
  const current = entries[index];
  for (let j = index + 1; j < entries.length; j += 1) {
    const next = entries[j];
    if (isSuccess(next)) {
      // 读完 / 拍完快照又重试同一步且成功了：那是重复步骤，不算失败重试
      if (SNAPSHOT_TOOLS.has(String(next.tool)) || next.actionClass === "READ" || next.actionClass === "BENIGN") continue;
      return false; // 成功的别的动作 → 流程已经继续往下走了
    }
    return sameAttempt(current, next) && (BAD_OUTCOMES.has(next.outcome) || next.ok === false);
  }
  return false;
}

/** 空间名归一化：日志里可能是空间 id，也可能是名字，比较时忽略大小写和首尾空白。 */
function sameSpace(value, requested) {
  return String(value ?? "").trim().toLowerCase() === String(requested ?? "").trim().toLowerCase();
}

function normalizeEntry(entry) {
  return entry && typeof entry === "object" ? entry : null;
}

/** 从一批日志行里挑出：时间范围内的、属于指定空间的、最新的那一次会话。 */
function pickSession(entries, { space } = {}) {
  const matched = [];
  for (const entry of entries) {
    if (!normalizeEntry(entry)) continue;
    if (space && typeof entry.args?.space === "string" && !sameSpace(entry.args.space, space)) continue;
    matched.push(entry);
  }
  const groups = new Map();
  for (const entry of matched) {
    const key = String(entry.sessionId ?? "__none__");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  let chosen = null;
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => timeOf(a) - timeOf(b));
    const last = timeOf(sorted[sorted.length - 1]);
    if (space) {
      // 有 space 时，会话里至少要有一次调用真的带了这个空间，否则不算
      const touched = sorted.some((entry) => typeof entry.args?.space === "string" && sameSpace(entry.args.space, space));
      if (!touched) continue;
    }
    if (!chosen || last > chosen.last) chosen = { entries: sorted, last };
  }
  return { entries: chosen?.entries ?? [], sessionCount: groups.size };
}

/** 网址 → 站点目录名：域名（小写）里的非法字符换成下划线；没有域名就是 unknown。 */
function siteOf(urlPattern) {
  if (!urlPattern) return "unknown";
  try {
    const host = new URL(urlPattern).hostname.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
    return host || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * 纯函数：把日志条目抽成草稿。
 * @param {object} options
 * @param {object[]} options.entries   已按会话挑好的日志条目（时间升序）
 * @param {string} [options.space]     空间名（仅用于默认草稿名）
 * @param {string} [options.name]      草稿名
 * @param {string} [options.version]   windrise_version
 * @param {Date}   [options.now]       created_at 用（测试可注入）
 * @returns {object} { name, site, created_at, windrise_version, steps, variables, source }
 */
export function draftFromCalls({ entries = [], space = "", name = "", version = windriseVersion(), now = new Date() } = {}) {
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry && typeof entry === "object")
    .sort((a, b) => timeOf(a.entry) - timeOf(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);

  /** 当前页面地址：只有跳转类调用会更新它，其余步骤沿用最近一次已知地址。 */
  let currentUrl = "";
  const steps = [];
  const variables = [];

  for (let i = 0; i < ordered.length; i += 1) {
    const entry = ordered[i];
    const action = actionOf(entry);
    const tool = String(entry.tool ?? "");
    if (!tool) continue;

    // 跳转成功后先把地址记下来，下面这一条跳转步骤自己也用新地址
    if (!isSuccess(entry)) continue;
    if (hasFailedRetryAfter(ordered, i)) continue;

    const target = targetOf(entry);
    let urlPattern = currentUrl;
    if (tool === "browser_navigate" || action === "navigate") {
      const raw = typeof entry.args?.url === "string" ? entry.args.url : "";
      if (raw) urlPattern = redactUrl(raw);
      currentUrl = urlPattern;
    }
    const step = { tool, action, target, url_pattern: urlPattern };

    if (TYPED_ACTIONS.has(action)) {
      // 输入值只留占位符；长度从日志里的「[输入内容，N 字]」取，没有就 null
      const variable = { name: `var${variables.length + 1}`, length: typedLength(entry.args) };
      variables.push(variable);
      step.value = `{{${variable.name}}}`;
    }

    const expect = typeof entry.args?.expect === "string" && entry.args.expect.trim() && !entry.args.expect.startsWith("[")
      ? entry.args.expect
      : "";
    if (expect) step.expect = expect;

    const wait = Number(entry.args?.waitMs);
    if (Number.isFinite(wait) && wait > 0) step.wait = Math.round(wait);

    steps.push(step);
  }

  // 连续重复的快照读取合并：中间没有别的操作时，只留第一张
  const merged = [];
  for (const step of steps) {
    const previous = merged[merged.length - 1];
    if (previous && SNAPSHOT_TOOLS.has(step.tool) && previous.tool === step.tool) continue;
    merged.push(step);
  }

  if (!merged.length) {
    const error = new Error(space
      ? `空间「${space}」里没有成功的操作记录：先在这个空间里把流程跑一遍，再存草稿。`
      : "这段时间里没有成功的操作记录：给 space，或用 since / until 指定跑过流程的时间。");
    error.code = "NO_CALLS";
    throw error;
  }

  const site = siteOf(merged.find((step) => step.url_pattern)?.url_pattern ?? "");
  return {
    name: String(name || "").trim() || `${String(space || "").trim() || "最近"} 流程`,
    site,
    created_at: (now instanceof Date ? now : new Date()).toISOString(),
    windrise_version: version,
    steps: merged,
    variables,
    source: "auto",
  };
}

/** 边界解析：YYYY-MM-DD 按本地整天算（since 取 00:00，until 取 23:59:59.999），其余交给 Date.parse。 */
export function parseBoundary(value, { endOfDay = false } = {}) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  if (!text) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const date = new Date(Number(year), Number(month) - 1, Number(day), endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
    return Number.isFinite(date.getTime()) ? date.getTime() : null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 读日志目录里的全部条目；坏行（写到一半 / 手动改坏）跳过，不让一条脏数据毁掉整个草稿。 */
export async function readCallLogEntries({ logDir, since = null, until = null } = {}) {
  if (!logDir) throw new Error("readCallLogEntries 需要 logDir");
  let names;
  try {
    names = await readdir(logDir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const entries = [];
  for (const name of names.filter((file) => LOG_FILE.test(file)).sort()) {
    const content = await readFile(path.join(logDir, name), "utf8").catch(() => "");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const time = timeOf(entry);
      if (since !== null && time && time < since) continue;
      if (until !== null && time && time > until) continue;
      entries.push(entry);
    }
  }
  return entries;
}

/** windrise_version：直接读包版本；打包成 asar 也能 require（读不到就写 unknown，不影响出草稿）。 */
export function windriseVersion() {
  try {
    return String(require("../../package.json").version ?? "unknown");
  } catch {
    return "unknown";
  }
}

/**
 * 从日志生成草稿（读文件 + 抽步骤）。
 * @returns {Promise<{ draft: object, sessionCount: number, scanned: number }>}
 */
export async function buildFlowDraft({ logDir, space = "", name = "", since = null, until = null, version = windriseVersion(), now = new Date() } = {}) {
  const from = parseBoundary(since);
  const to = parseBoundary(until, { endOfDay: true });
  const entries = await readCallLogEntries({ logDir, since: from, until: to });
  const picked = pickSession(entries, { space });
  const draft = draftFromCalls({ entries: picked.entries, space, name, version, now });
  return { draft, sessionCount: picked.sessionCount, scanned: entries.length };
}

/** 站点目录名兜底：不许出现路径分隔符 / 上级目录。 */
function safeSite(site) {
  const value = String(site ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "_");
  if (!value || value === "." || value === "..") return "unknown";
  return value;
}

/** 草稿目录：<数据目录>/flows/drafts（和日志同一层）。 */
export function flowDraftsDir(dataHome) {
  return path.join(dataHome, "flows", "drafts");
}

/**
 * 落盘：<数据目录>/flows/drafts/<site>/<时间戳>.json。
 * 先用临时文件再 rename，读者不会看到半个 json（和项目里其它存储一致）。
 */
export async function saveFlowDraft({ dataHome, draft } = {}) {
  if (!dataHome) throw new Error("saveFlowDraft 需要 dataHome");
  if (!draft || typeof draft !== "object") throw new Error("saveFlowDraft 需要 draft");
  const dir = path.join(flowDraftsDir(dataHome), safeSite(draft.site));
  await mkdir(dir, { recursive: true });
  const stamp = String(draft.created_at ?? new Date().toISOString()).replace(/[:.]/g, "-");
  let file = path.join(dir, `${stamp}.json`);
  // 同一毫秒存两次也不覆盖：加序号
  for (let suffix = 2; ; suffix += 1) {
    const exists = await stat(file).then(() => true, () => false);
    if (!exists) break;
    file = path.join(dir, `${stamp}-${suffix}.json`);
  }
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(draft, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, file);
  return { path: file };
}

/** 列出已存草稿（新的在前）。坏文件跳过，不报错 —— 列表页不该被一个坏 json 卡死。 */
export async function listFlowDrafts({ dataHome, site = "" } = {}) {
  if (!dataHome) throw new Error("listFlowDrafts 需要 dataHome");
  const root = flowDraftsDir(dataHome);
  const sites = site ? [safeSite(site)] : await readdir(root).catch(() => []);
  const drafts = [];
  for (const siteName of sites) {
    const dir = path.join(root, siteName);
    const names = await readdir(dir).catch(() => []);
    for (const name of names.filter((file) => file.endsWith(".json"))) {
      const file = path.join(dir, name);
      let draft;
      try {
        draft = JSON.parse(await readFile(file, "utf8"));
      } catch {
        continue;
      }
      drafts.push({
        site: siteName,
        name: draft.name ?? "",
        created_at: draft.created_at ?? "",
        steps: Array.isArray(draft.steps) ? draft.steps.length : 0,
        variables: Array.isArray(draft.variables) ? draft.variables.length : 0,
        path: file,
      });
    }
  }
  return drafts.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}
