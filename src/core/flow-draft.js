/**
 * 流程草稿 —— 把一次跑通的 MCP 调用序列抽成可复用的流程描述，给以后的 Skill / flow-pack 攒素材。
 *
 * 数据来源只有调用日志（<数据目录>/logs/mcp-calls-YYYY-MM-DD.jsonl，见 core/call-log.js）：
 * 日志本来就是事后审计用的，这里不再额外记任何东西，也不改日志格式。
 *
 * ── 几条硬规则（都是隐私 / 可重放性要求）──
 *   1. type / fill 的输入值绝不进草稿：日志里已经只剩「[输入内容，N 字]」，
 *      这里再统一换成 {{变量名}}，variables 只登记名字、类型、是否必填；secret 变量（密码 / 验证码）
 *      连长度都不记；即使旧日志里有原文也不读。
 *   2. URL 去掉 token / code / session 这类 query 参数，也去掉 hash（可能带一次性令牌）。
 *   3. target 只认日志里的 target（可访问名 / 提示名）或 CSS 选择器，绝不把快照编号（e12）写进草稿 ——
 *      编号每次快照都会变，写进去等于写了个必坏的值。每一步另存 locators（多路定位：testid > role+名字
 *      > label > 文本），回放时按分数重找元素；站点由第一个页面地址推断，按域名分目录。
 *   4. 只留成功的步骤：ok 必须是 true，写操作（MUTATING）的 outcome 只能是 confirmed / dispatched；
 *      failed / unknown 的尝试剔除，而且「成功之后又拿着同一步重试并失败」的那次成功也剔除。
 *   5. 连续重复的快照读取合并成一步，不然草稿里全是 page_snapshot。
 *   6. 只收「回放真能执行」的动作（REPLAYABLE_ACTIONS）：调用日志里还有一堆非页面工具
 *      （set_todos / read_files / flow_get_draft / browser_profiles …），以前被原样收进草稿，
 *      回放在第 1 步就「不认识的动作」整轮失败。这些不改页面，抽草稿时静默跳过。
 *      但批量填表（page_act fields[]，日志里只剩「[N 项]」）、browser_nav 的 back / forward / reload、
 *      没有可定位名字的写步骤都会改页面又没法忠实重放，不能静默跳过 —— 统一保留在原位并标
 *      unsupported + 原因，干跑时列出来；真执行遇到这种步骤会停下，不跳过继续。
 *
 * 空间 / 时间范围怎么挑「一次运行」：日志里带 sessionId，一个会话就是 Agent 连着干的一串活。
 * 给定 space 时，先挑「有调用带这个空间」的会话，再取其中最新的一个；给了 since/until 就先按时间裁。
 * 同一个会话里显式写了别的空间的调用会被剔掉；没写 space 的调用（例如 space_open）保留。
 */

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { classifyAction } from "./action-policy.js";
import { classifyVariable, locatorsFor, variableName } from "./flow-locate.js";

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

/**
 * 回放真能执行的动作（和 core/flow-replay.js 的 WRITE / NAV / READ / CONTROL 集合一一对应）。
 * BENIGN（scroll / hover / focus …）在进这里之前就已经丢掉了。
 */
const REPLAYABLE_ACTIONS = new Set([
  "click", "double_click", "type", "select", "check", "key", "upload", "dialog",
  "navigate",
  "snapshot", "read", "screenshot", "wait",
  "open", "close", "pin",
]);

/**
 * 需要能定位到元素的写动作：日志里 target 和 locators 都为空时，回放第一步就会定位失败。
 * 这类步骤不能静默丢，也不该假装能跑 —— 在草稿里标「不支持」，干跑时列出来。
 * （dialog 不需要元素；navigate / 只读 / 控制步骤也不在这个表里。）
 */
const TARGET_REQUIRED_ACTIONS = new Set(["click", "double_click", "type", "select", "check", "key", "upload"]);

/**
 * 会改页面、但回放没法忠实重走的导航动作：后退 / 前进 / 刷新。
 * 静默丢掉会让后面的步骤在错的页面上执行（例如 back 之后在 A 页点「保存」，回放却在 B 页点）。
 */
const UNSUPPORTED_NAV_ACTIONS = new Set(["back", "forward", "reload"]);

/** 批量填表在日志里的样子：「[N 项]」（见 call-log.js 的 summarizeArgs）。 */
const BATCH_FIELDS_MARKER = /^\[(\d+) 项\]$/;
/** 和 page-fill.js 的单次上限保持一致。 */
const MAX_BATCH_FIELDS = 30;

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
  return actionNameOf(entry?.tool, entry?.args);
}

function actionNameOf(tool, args) {
  const declared = args?.action;
  if (typeof declared === "string" && declared.trim()) return declared.trim().toLowerCase();
  return TOOL_ACTION.get(String(tool ?? "")) ?? String(tool ?? "");
}

/** 日志里批量填表的项数（「[N 项]」）；不是批量填表返回 null。 */
function batchFieldCount(args) {
  const fields = args?.fields;
  if (Array.isArray(fields)) return fields.length || null;
  if (typeof fields === "string") {
    const match = BATCH_FIELDS_MARKER.exec(fields.trim());
    if (match) return Number(match[1]) || null;
  }
  return null;
}

/** 日志里这一条是不是批量填表（回放本身不认 fields[]，抽草稿时标 unsupported，不拆、不丢）。 */
function isBatchFill(entry) {
  /*
   * 工具名不认识时 actionOf 会退化成工具名（page_act → "page_act"）—— 它是 MUTATING，
   * 但既不是 BENIGN 也不在白名单里，光看 action 会把它当成普通非页面工具丢掉。
   * 所以 page_act 一律先按批量填表处理，再看日志里有没有 fields：
   * 有就记成 unsupported（避免静默丢一条写操作），没有就按未知动作标不支持。
   */
  if (String(entry?.tool ?? "") === "page_act") return !REPLAYABLE_ACTIONS.has(actionOf(entry));
  return batchFieldCount(entry?.args) !== null && !REPLAYABLE_ACTIONS.has(actionOf(entry));
}

/** 日志里的 target 才是人看的名字（可访问名 / 提示名）；没有就退回 CSS 选择器。 */
function targetOf(entry) {
  const target = typeof entry?.target === "string" ? entry.target.trim() : "";
  if (target) return target;
  const selector = typeof entry?.args?.selector === "string" ? entry.args.selector.trim() : "";
  return selector || "";
}

function timeOf(entry) {
  const parsed = Date.parse(entry?.at ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 抽出来的「不支持」步骤：保留在原位，标明原因，不静默丢弃。
 * 干跑会把它列进 unsupported；真执行时回放也会拒绝执行它（不会跳过一步让后面的步骤跑在错的状态上）。
 */
function unsupportedDraftStep(entry, action, urlPattern, reason) {
  const step = {
    tool: String(entry?.tool ?? ""),
    action: String(action ?? ""),
    target: targetOf(entry),
    url_pattern: urlPattern ?? "",
    unsupported: true,
    unsupportedReason: reason,
  };
  return step;
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
    // 重放自己的审计条目绝不能再被抽成草稿（不管它写在哪份日志里，都兜一层）
    .filter(({ entry }) => String(entry?.tool ?? "") !== "flow_replay")
    .sort((a, b) => timeOf(a.entry) - timeOf(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);

  /** 当前页面地址：只有跳转类调用会更新它，其余步骤沿用最近一次已知地址。 */
  let currentUrl = "";
  const steps = [];
  const variables = [];
  /** 同一个输入框重复填同一个变量（先输入、再回车提交时日志里会出现两次）→ 复用同一个占位符。 */
  const variableByTarget = new Map();
  /** 已经用掉的变量名：两个不同输入框清洗 / 截断后撞名时加后缀，避免一个值填两处。 */
  const usedNames = new Set();
  const freshVariableName = (base) => {
    let candidate = base;
    for (let suffix = 2; usedNames.has(candidate); suffix += 1) candidate = `${base}${suffix}`;
    usedNames.add(candidate);
    return candidate;
  };

  for (let i = 0; i < ordered.length; i += 1) {
    const entry = ordered[i];
    const tool = String(entry.tool ?? "");
    if (!tool) continue;

    // 跳转成功后先把地址记下来，下面这一条跳转步骤自己也用新地址
    if (!isSuccess(entry)) continue;
    if (hasFailedRetryAfter(ordered, i)) continue;
    /*
     * 无副作用动作（scroll / hover / focus，action-policy 里都是 BENIGN）不收进草稿：
     * 滚动距离 / 悬停目标都没记，回放根本没法忠实重走；留在草稿里只会让回放「不认识这个动作」整轮失败。
     * 真正要紧的是后面那一步写动作（它自己会定位 + 聚焦），跳过这几步不影响重放结果。
     */
    if (classifyAction(actionOf(entry)) === "BENIGN") continue;
    /*
     * 只收回放真能执行的动作：set_todos / read_files / flow_get_draft / browser_profiles 这类
     * 非页面工具不改页面，静默跳过。
     * 但页面工具里「回放不认识、又会改页面」的动作（back / forward / reload、未知 page_act 动作）
     * 不能静默丢 —— 否则后面的步骤会在错的页面上执行。统一保留成 unsupported 步骤，干跑时列出来。
     */
    const rawAction = actionOf(entry);
    // 只看「页面动作」工具：browser_profiles / browser_snapshot 这类元数据工具没有回放动作，照旧静默跳过
    const pageTool = tool === "page_act" || tool === "browser_nav";
    if (!REPLAYABLE_ACTIONS.has(rawAction) && !isBatchFill(entry)) {
      if (pageTool) {
        const reason = UNSUPPORTED_NAV_ACTIONS.has(rawAction)
          ? "后退 / 前进 / 刷新会改变页面，回放没法忠实重走"
          : `动作「${rawAction || tool}」回放不支持`;
        steps.push(unsupportedDraftStep(entry, rawAction || tool, currentUrl, reason));
      }
      continue;
    }

    const target = targetOf(entry);
    let urlPattern = currentUrl;
    if (tool === "browser_navigate" || rawAction === "navigate") {
      const raw = typeof entry.args?.url === "string" ? entry.args.url : "";
      if (raw) urlPattern = redactUrl(raw);
      currentUrl = urlPattern;
    }

    if (isBatchFill(entry)) {
      /*
       * 批量填表：日志里只剩「[N 项]」，字段名 / 各自的 action 都没了（真实审计里 target 恒为 null），
       * 回放没法逐个重填。和 upload 一样标成「不支持」，既不丢这一步，也不生成跑一半的草稿。
       */
      const count = batchFieldCount(entry.args);
      const declaredAction = typeof entry.args?.action === "string" ? entry.args.action.trim().toLowerCase() : "";
      let reason;
      if (!count) {
        reason = declaredAction && declaredAction !== "page_act" && !REPLAYABLE_ACTIONS.has(declaredAction)
          ? `动作「${declaredAction}」回放不支持`
          : "这条 page_act 调用在日志里没有 action / 字段信息（只有工具名），回放没法重走";
      } else if (count > MAX_BATCH_FIELDS) {
        reason = `批量填表有 ${count} 项，超过单次上限 ${MAX_BATCH_FIELDS}，回放不支持`;
      } else {
        reason = `批量填表（一次填 ${count} 个字段）回放不支持：日志里没有每个字段的可定位名字，没法逐个重填`;
      }
      const item = unsupportedDraftStep(entry, count ? "fields" : (declaredAction || tool), urlPattern, reason);
      if (count) item.batchFields = count;
      steps.push(item);
      continue;
    }

    const action = rawAction;
    const step = { tool, action, target, url_pattern: urlPattern };

    // 多路定位：回放时按 testid > role+名字 > label > 文本 的顺序打分重找（编号不进草稿）
    const locators = locatorsFor({ target });
    if (locators.length) step.locators = locators;

    /*
     * 写动作没有可定位名字：回放第一步就会定位失败。这种步骤进草稿时必须标「不支持」，
     * 不生成变量、不假装能跑（真实日志里 page_act type/key 不传 ref 时 target 就是 null）。
     */
    if (TARGET_REQUIRED_ACTIONS.has(action) && !target && !locators.length) {
      step.unsupported = true;
      step.unsupportedReason = "调用日志没有记下可定位的名字（target / locators 都为空），回放时找不到这个元素";
      steps.push(step);
      continue;
    }

    /*
     * 上传：日志里的 files 只记了形状（「[1 项]」），拿不到文件名就没法重放。
     * 标「不支持」保留在原位，干跑时明确列出来，不静默丢。
     */
    if (action === "upload") {
      const files = entry.args?.files;
      const names = Array.isArray(files) ? files.filter((file) => typeof file === "string" && file.trim()) : [];
      if (!names.length) {
        if (typeof files === "string") {
          const count = /^\[(\d+) 项\]$/.exec(files.trim());
          if (count) step.filesCount = Number(count[1]);
        }
        step.unsupported = true;
        step.unsupportedReason = "调用日志只记了上传文件的数量，拿不到文件名，回放时给不出 files";
        steps.push(step);
        continue;
      }
    }

    if (TYPED_ACTIONS.has(action)) {
      // 输入值只留占位符；名字从输入框的 label / 提示名推断，类型 / 是否必填写进 variables；
      // secret（密码、验证码）既不给长度也不给别的派生信息，日志里同样不会带出来。
      const reused = target ? variableByTarget.get(target) : null;
      if (reused) {
        step.value = `{{${reused.name}}}`;
      } else {
        const name = freshVariableName(variableName({ index: variables.length + 1, target }));
        const typed = classifyVariable({ name, target });
        const variable = { name, type: typed.type, required: typed.required, secret: typed.secret };
        if (!typed.secret) variable.length = typedLength(entry.args);
        variables.push(variable);
        if (target) variableByTarget.set(target, variable);
        step.value = `{{${variable.name}}}`;
      }
    } else if (action === "select") {
      // 下拉框选的目标值也当输入值处理：只留 {{变量}} 占位符，回放时按 value 传，绝不把选项值写进草稿
      const reused = target ? variableByTarget.get(target) : null;
      if (reused) {
        step.value = `{{${reused.name}}}`;
        step.selectValue = `{{${reused.name}}}`;
      } else {
        const name = freshVariableName(variableName({ index: variables.length + 1, target }));
        const typed = classifyVariable({ name, target });
        const variable = { name, type: typed.type, required: typed.required, secret: typed.secret };
        if (!typed.secret) variable.length = typedLength({ text: entry.args?.value });
        variables.push(variable);
        if (target) variableByTarget.set(target, variable);
        step.value = `{{${variable.name}}}`;
        step.selectValue = `{{${variable.name}}}`;
      }
    }

    const expect = typeof entry.args?.expect === "string" && entry.args.expect.trim() && !entry.args.expect.startsWith("[")
      ? entry.args.expect
      : "";
    if (expect) step.expect = expect;

    const wait = Number(entry.args?.waitMs);
    if (Number.isFinite(wait) && wait > 0) step.wait = Math.round(wait);

    // dialog / check / key / upload 的必需参数：不记下来，回放时只能发半成品动作或报错
    if (action === "dialog" && typeof entry.args?.accept === "boolean") step.accept = entry.args.accept;
    if (action === "check" && typeof entry.args?.checked === "boolean") step.checked = entry.args.checked;
    /*
     * 按键（key）：不记的话回放只能默认发一次 Enter —— 录的可能是 Tab / Escape，Enter 在表单里就是提交。
     * 日志里的 key 是短字符串（summarizeArgs 原样保留），直接抄过来即可。
     */
    if (action === "key" && typeof entry.args?.key === "string" && entry.args.key.trim()) step.key = entry.args.key.trim();
    if (action === "upload") {
      /*
       * 日志里 files 只记了形状（summarizeArgs 压成「[1 项]」），文件名从来拿不到：
       * 记下数量，回放侧据此明确要求调用方补 files（上传的文件不进日志，也不进草稿）。
       */
      const files = entry.args?.files;
      if (Array.isArray(files)) {
        const names = files.filter((file) => typeof file === "string" && file.trim());
        if (names.length) step.files = names;
      } else if (typeof files === "string") {
        const count = /^\[(\d+) 项\]$/.exec(files.trim());
        if (count) step.filesCount = Number(count[1]);
      }
    }

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

  // 站点：草稿里第一个已知页面地址（跳转或跳转后沿用）的域名；整条流程都在空白页 / 没有地址时是 unknown
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
  // 重放审计不该参与「最近一次会话」的选择：否则 replay 一次后存草稿会抽到重放日志本身
  const usable = entries.filter((entry) => String(entry?.tool ?? "") !== "flow_replay");
  const picked = pickSession(usable, { space });
  const draft = draftFromCalls({ entries: picked.entries, space, name, version, now });
  return { draft, sessionCount: picked.sessionCount, scanned: entries.length };
}

/** 站点目录名兜底：不许出现路径分隔符 / 上级目录。 */
export function safeSite(site) {
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
/**
 * ～site 过滤：域名比较忽略大小写、协议、端口、末尾点；也给目录名本身留一条路（老草稿在 unknown/ 下）。
 * 返回 null 表示「没有给过滤条件」。
 */
function siteFilterOf(site) {
  const text = String(site ?? "").trim().toLowerCase();
  if (!text) return null;
  let host = text;
  if (host.includes("://")) {
    try { host = new URL(host).hostname; } catch { host = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); }
  }
  host = host.split(/[/?#]/, 1)[0].replace(/:\d+$/, "").replace(/\.$/, "");
  const dir = safeSite(host);
  return { host, dir };
}

function sameSite(draftSite, dirName, filter) {
  const candidate = String(draftSite ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (candidate && (candidate === filter.host || candidate === filter.dir)) return true;
  return String(dirName ?? "").toLowerCase() === filter.dir;
}

/**
 * 列出已存草稿（新的在前）。坏文件跳过，不报错 —— 列表页不该被一个坏 json 卡死。
 * 返回值时给足供过滤 / 汇总的信息：site 用草稿里记的域名（老草稿退回目录名），另有 sites 汇总。
 */
export async function listFlowDrafts({ dataHome, site = "" } = {}) {
  if (!dataHome) throw new Error("listFlowDrafts 需要 dataHome");
  const root = flowDraftsDir(dataHome);
  const filter = siteFilterOf(site);
  // 过滤时不能只去一个目录看一眼：老草稿在 unknown/ 下，得读文件里的 site 才算得出来
  const sites = await readdir(root).catch(() => []);
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
      const draftSite = String(draft.site ?? "").trim() || siteName;
      if (filter && !sameSite(draftSite, siteName, filter)) continue;
      drafts.push({
        site: draftSite,
        dir: siteName,
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

/** 目录里有哪些站点（给「该站点没有草稿」时列出可用站点用）。 */
export async function listDraftSites({ dataHome } = {}) {
  if (!dataHome) throw new Error("listDraftSites 需要 dataHome");
  const drafts = await listFlowDrafts({ dataHome });
  return [...new Set(drafts.map((draft) => draft.site))].sort();
}

/** 找不到草稿时的错误：带 code，调用方据此给「有哪些可用站点」的提示。 */
export function draftNotFound(what) {
  const error = new Error(`没有找到流程草稿：${what}`);
  error.code = "DRAFT_NOT_FOUND";
  return error;
}

/**
 * 按名字或 id（文件名，可带 .json）读一份草稿；同名有多份时取最新的一份。
 * `id` 也接受列表 / 保存返回的完整路径（必须是草稿目录里的文件，越界一律拒绝）。
 * 返回 { draft, path, id, site }。
 */
export async function readFlowDraft({ dataHome, name = "", id = "" } = {}) {
  if (!dataHome) throw new Error("readFlowDraft 需要 dataHome");
  const root = flowDraftsDir(dataHome);
  const wantedId = String(id ?? "").trim();
  const wantedName = String(name ?? "").trim();

  if (wantedId) {
    const base = path.basename(wantedId.replace(/[\\/]+$/, ""));
    if (!base || base === "." || base === "..") throw draftNotFound(wantedId);
    // 传的是完整路径（含目录），或带目录的 .json：就按这个路径读，不在所有站点目录里找同名文件
    if (/[\\/]/.test(wantedId) || (wantedId !== base && /\.json$/i.test(base))) {
      const full = path.resolve(wantedId);
      const inside = path.relative(path.resolve(root), full);
      if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) throw draftNotFound(wantedId);
      const draft = await readFile(full, "utf8").then((text) => JSON.parse(text), () => null);
      if (draft) {
        return { draft, path: full, id: path.basename(full, ".json"), site: String(draft.site ?? "").trim() || path.basename(path.dirname(full)) };
      }
      throw draftNotFound(wantedId);
    }
    // 只给文件名 / id：id 统一不带 .json，两种都认；在所有站点目录里找
    const fileName = base.endsWith(".json") ? base : `${base}.json`;
    const sites = await readdir(root).catch(() => []);
    for (const siteName of sites) {
      const file = path.join(root, siteName, fileName);
      const draft = await readFile(file, "utf8").then((text) => JSON.parse(text), () => null);
      if (draft) return { draft, path: file, id: path.basename(file, ".json"), site: String(draft.site ?? "").trim() || siteName };
    }
    throw draftNotFound(wantedId);
  }

  if (!wantedName) throw draftNotFound("（没给 name 或 id）");
  const listed = await listFlowDrafts({ dataHome });
  const byName = listed.filter((draft) => draft.name === wantedName);
  if (byName.length) {
    const newest = byName[0]; // listFlowDrafts 已按时间倒序
    const draft = JSON.parse(await readFile(newest.path, "utf8"));
    return { draft, path: newest.path, id: path.basename(newest.path, ".json"), site: newest.site };
  }
  throw draftNotFound(wantedName);
}
