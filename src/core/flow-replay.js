/**
 * 流程重放 —— 拿一份草稿 + 一组变量值，在真浏览器里一步一步执行，每一步都读回校验。
 *
 * 设计参考 workflow-use 的 step verifier（四态 SUCCESS / FAILURE / UNCERTAIN / SKIPPED）和
 * Selenium IDE 的「候选链录制时算好、回放时按顺序试」，但执行层换成 Windrise 自己的 page 工具：
 *
 *   定位   先按草稿里的 locators 在当前快照上打分（testid < role+名字 < label < 文本），取最低分；
 *          多个同分最佳候选一律判失败并列出候选（瞎挑第一个正是误点的来源）。部分匹配（靠包含命中）
 *          记为「脆弱」—— 页面改版后可能失效，但不拦着执行（干跑报告会把脆弱步骤列出来）。
 *   执行   动作走和 Agent 完全一样的 page_act（写操作照样过写操作闸门：提交类步骤没有针对这一步的
 *          确认就停在 NEEDS_CONFIRM，返回已完成的步骤和当前页面状态）。
 *   确认   confirm 绑定到具体一步：confirmStep（第几步，从 1 数）+ confirmTarget（那一步的目标名，
 *          对不上就拒绝）。一次确认只放行那一步，别的提交步骤照样要各自确认。确认第 N（N > 1）步
 *          必须同时给 fromStep: N —— 否则前面的写动作会被重发；老的 confirm:true 不再自动放行任何步骤。
 *          执行前还要拿「实际命中的元素名」和 confirmTarget 再对一次：草稿名字和页面上的元素不是同一个
 *          时，提交类步骤一律不执行（防止改版后点成「确认删除全部订单」）。
 *   续跑   fromStep: N（从 1 数）从第 N 步开始跑，前面的步骤一律不执行 —— 前面已经发出去的写动作
 *          绝不重发（重复下单就是这么来的）。fromStep 越界直接拒绝，不当成「重放完成」。
 *   校验   每步执行后按草稿里的 expect 读回，并且只认「执行前没有、执行后出现」或 page_act 返回的
 *          expectMet（输入框自己的 label 这种一直就有的文字不算数）。没有 expect 的写步骤记为
 *          DISPATCHED（已派发、未验证），总结果绝不会叫「重放成功」；提交类步骤之前如果还有未验证的
 *          写步骤，先停下要求核对。任何一步失败或不确定就停下（后面依赖它，继续跑只会越跑越乱）。
 *   秘密   secret 变量的值只在内存里用，不进返回、不进日志、不落盘；返回文字和 structuredContent 里
 *          一律不回显任何变量值（只给长度和是否已提供）。没标 secret 的老草稿用 classifyVariable
 *          按目标名重判，判不出来按 secret 处理；开跑前缺 secret / 缺必填变量都直接拒绝。
 *   站点   草稿记的站点和当前页面域名对不上时：草稿里有 secret 变量就直接停（不往陌生站点填密码），
 *          没有 secret 才只提醒。草稿的站点是 unknown / 空、又带 secret 时，必须由调用方显式给 expectSite
 *          才继续（这类草稿多半是从「已经打开着的页面」录的，不能等于不核对）。有 secret 的草稿拿不到
 *          页面地址时也按「核对不过」处理（读不到地址不能等于站点对了）。
 *   导航   草稿里的 navigate 步骤会真的执行（走浏览器的导航通道），执行后读回地址才叫成功；没有导航
 *          通道 / 没有地址时直接拒绝，绝不静默跳过。口令作用域的域名白名单对回放同样生效：越界地址在
 *          开跑前就拒绝（一步都不发），真跑到导航那一步时再用同一份判断兜一次。
 *   审计   每一步都写进重放审计；开跑前的拒绝也记一条 event:"refused" 和原因，字段里不放变量值。
 *   干跑   dryRun:true 只做定位检查不执行动作，用来判断网站改版后草稿还能不能用。
 *
 * 这个文件不碰文件系统，也不认 MCP 形状：依赖全部由 tools/flow.js 注入（测试可以换成假实现）。
 */

import { matchCommitKeyword, needsCommitGate } from "./action-policy.js";
import { bestMatch, classifyVariable, isFragile, locateAll, parseSnapshotLine } from "./flow-locate.js";

/** 四态结果（和 workflow-use 的 step_verifier 对齐）。 */
export const STEP_STATUS = Object.freeze({
  SUCCESS: "success",
  DISPATCHED: "dispatched",
  FAILURE: "failure",
  UNCERTAIN: "uncertain",
  SKIPPED: "skipped",
  /** 预演（干跑）时：这一步将会执行，但这次一个动作都没发。 */
  PLANNED: "planned",
});

/** 整体结论。 */
export const RUN_STATUS = Object.freeze({
  SUCCESS: "success",
  PARTIAL: "partial",
  FAILED: "failed",
  UNCERTAIN: "uncertain",
  NEEDS_CONFIRM: "needs_confirm",
  DRY_RUN: "dry_run",
  /** 给了 maxSteps ≤ 0：一步都没跑。绝不能说成 success。 */
  NOOP: "noop",
});

/** 只有这些动作真的会改页面。 */
const WRITE_ACTIONS = new Set(["click", "double_click", "type", "select", "check", "key", "upload", "dialog"]);
/** 只读动作：回放时当成观察步骤，不算「成功一步」，也不触发写操作闸门。 */
const READ_ACTIONS = new Set(["snapshot", "read", "screenshot", "wait"]);
/** 导航步骤单独处理：page_act 不做导航，要走浏览器的导航通道，然后读回地址。 */
const NAV_ACTIONS = new Set(["navigate"]);
/** 空间 / 钉住这类控制步骤：目标格子和空间已经由调用参数定好，回放时不需要重开，按观察步骤跳过。 */
const CONTROL_ACTIONS = new Set(["open", "close", "pin"]);
/**
 * 录制时很常见、但重放不该重走的无副作用动作（action-policy 里都是 BENIGN）：
 *   - scroll：草稿里根本没记滚动距离 / 目标，忠实重放做不到；
 *   - hover / focus：只影响悬停 / 焦点，真正要紧的是后面那一步写动作（它自己会定位 + 聚焦）。
 * 以前这几类既不执行也不跳过，回放到这一步直接「不认识的动作」把整轮判失败 —— 真实录制的草稿
 * 几乎一定带 scroll，等于整个功能用不了。这里按观察类跳过（和 READ / CONTROL 一样），绝不静默当写动作。
 */
const SKIPPABLE_ACTIONS = new Set(["scroll", "hover", "focus"]);

/**
 * 提交边界和真实写操作闸门用同一套判定：只有点击类 / 回车才可能提交。
 *
 *   - 点击类：目标名要命中 action-policy 的提交关键词（「发布 / 提交 / 付款 / 删除 / 授权…」）。
 *     普通点击（翻页、展开、下一步）不算提交边界 —— 否则「前面有未验证写步骤」这道停会在一填完表就被触发。
 *   - 回车：一律算提交边界。真实闸门（surface-act 的 submitTargetName）看的是「焦点元素所在表单里
 *     提交按钮叫什么」，回放拿不到 DOM，没法知道草稿里那个输入框按回车会不会提交；按失败关闭原则，
 *     宁可多停一次让人核对，也不能把一次没核对过的提交当成普通按键发出去（备注框回车照样会提交）。
 */
function isCommitStep(step) {
  const action = String(step?.action ?? "").toLowerCase();
  if (!needsCommitGate(action, step?.key)) return false;
  if (action === "key") return true;
  return Boolean(matchCommitKeyword(step?.target));
}

/**
 * 实际命中的元素名也算：草稿里叫「确认」，页面上改版成「确认删除全部订单」时，
 * 真实闸门会按页面上的 label 拦，回放也必须当成提交边界（否则确认名字对不上还照点）。
 */
function isCommitHit(step, actualName = "") {
  if (isCommitStep(step)) return true;
  const action = String(step?.action ?? "").toLowerCase();
  if (!needsCommitGate(action, step?.key)) return false;
  return Boolean(matchCommitKeyword(actualName));
}

/** 变量值在返回里怎么显示：一律 ●●●（任何值都不回显，secret 也不例外）。 */
function displayValue() {
  return "●●●";
}

/** 预演时描述「这一步将会做什么」：只写动作 / 目标 / 变量名，绝不带任何值。 */
function previewIntent(step, action, provided) {
  const target = String(step?.target ?? "").trim();
  const named = target ? `「${target}」` : "";
  const placeholder = placeholderOf(step);
  const valueNote = placeholder ? `，值来自变量「${placeholder}」（${provided?.has?.(placeholder) ? "这次已给" : "这次没给"}）` : "";
  const expectNote = step?.expect ? `，执行后要看到「${normalizeExpect(step.expect)}」` : "";
  if (action === "click") return `将点击${named || "（没记目标）"}${expectNote}`;
  if (action === "double_click") return `将双击${named || "（没记目标）"}${expectNote}`;
  if (action === "type") return `将填写${named || "当前焦点"}${valueNote}${expectNote}`;
  if (action === "select") return `将选择${named || "（没记目标）"}${valueNote}${expectNote}`;
  if (action === "check") return `将${step?.checked === false ? "取消勾选" : "勾选"}${named || "（没记目标）"}${expectNote}`;
  if (action === "key") return `将在${named || "当前焦点"}按 ${step?.key || "（没记按键）"}${expectNote}`;
  if (action === "upload") return `将上传 ${step?.files?.length ?? step?.filesCount ?? "?"} 个文件到${named || "（没记目标）"}`;
  if (action === "dialog") return `将处理 JS 对话框（${step?.accept === false ? "取消" : step?.accept === true ? "确认" : "没记确认 / 取消"}）`;
  return `将执行「${action || "（空动作）"}」${named}${valueNote}${expectNote}`;
}

/** {{变量名}} 还是 {{varN}}：两种都要认（老草稿只有 varN）。 */
function placeholderOf(step) {
  const match = /\{\{([^}]+)\}\}/.exec(String(step?.value ?? ""));
  return match ? match[1].trim() : null;
}

/**
 * 值里带一次性短时效特征的，不落盘（OTP / 验证码 / 一次一密的动态码）。
 * 理由：它们这次看着是「普通文本」，存下来下次重放必然失败，还等于把一次有效的验证码写进了文件。
 * 名字本身像验证码的变量已经在 classifyVariable 里按 secret 处理，这里兜的是「名字看不出、值是动态码」的情况。
 */
export function isEphemeralValue(value) {
  const text = String(value ?? "").trim();
  return /^\d{4,8}$/.test(text);
}

function normalizeSnapshot(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return String(value.text ?? "");
}

/** 快照结果里的地址（控制服务会给 url；给不出来就 null，不臆造）。 */
function urlOfSnapshot(value) {
  if (!value || typeof value !== "object") return null;
  return typeof value.url === "string" && value.url ? value.url : null;
}

/**
 * 把「草稿里的定位」翻译成 page_act 认的 ref。
 * @returns {{ ref: (string|null), score: (number|null), how: (string|null), fragile: boolean,
 *             candidates: Array<{ref,line}> } | null}  没有候选时返回 null
 */
export function locateStep(step, snapshotText) {
  const locators = Array.isArray(step?.locators) ? step.locators : [];
  const fallback = [];
  // 老草稿没有 locators：target 可能是可访问名，也可能是 CSS 选择器
  const target = String(step?.target ?? "").trim();
  if (target) {
    fallback.push({ kind: "label", value: target }, { kind: "text", value: target });
    if (/^[#.[a-z]/i.test(target) && /[#.[>\s:]/.test(target)) fallback.push({ kind: "css", value: target });
  }
  const probe = locators.length ? locators : fallback;
  const match = bestMatch(probe, snapshotText);
  if (!match) {
    const all = locateAll(probe, snapshotText);
    if (!all.length) return null;
    // 多个同分最佳：判失败，把候选列出来
    return {
      ref: null,
      score: all[0].score,
      how: all[0].how,
      fragile: true,
      ambiguous: true,
      candidates: all.slice(0, 8).map((item) => ({ ref: item.ref, line: item.line })),
    };
  }
  return {
    ref: match.ref,
    score: match.score,
    how: match.how,
    // 实际命中的可访问名：确认类步骤执行前要和草稿里的 target 再对一次。
    // hint（data-testid 之类）只用于定位展示，绝不参与确认判断（网页能写的属性不能放行安全判断）。
    name: match.name ?? "",
    hint: match.hint ?? "",
    fragile: isFragile(match.score, match.partial),
    ambiguous: false,
    candidates: [{ ref: match.ref, line: match.line }],
  };
}

/** 草稿里的 CSS 选择器（老草稿 target 本身就是选择器时也认）。 */
function selectorOf(step) {
  const locators = Array.isArray(step?.locators) ? step.locators : [];
  const declared = locators.find((item) => item?.kind === "css" && String(item.value ?? "").trim());
  if (declared) return String(declared.value).trim();
  const target = String(step?.target ?? "").trim();
  return /^[#.[a-z]/i.test(target) && /[#.[>\s:]/.test(target) ? target : null;
}

/**
 * CSS 选择器兜底：按选择器拍子树快照，只有唯一一个带编号的元素时才认（多个 = 没法确定，不瞎挑）。
 * 照常交给 page_act 按 ref 执行，写操作闸门一点都不绕。
 */
export function locateBySelector(selector, scopedText) {
  const refs = String(scopedText ?? "")
    .split(/\r?\n/)
    .map((line) => parseSnapshotLine(line))
    .filter((item) => item?.ref);
  if (refs.length !== 1) {
    return { ref: null, candidates: refs.slice(0, 8).map((item) => item.ref), name: "", hint: "" };
  }
  return { ref: refs[0].ref, name: refs[0].name, hint: refs[0].hint, candidates: [refs[0].ref] };
}

/** expect 的文本在当前快照 / 正文里出现了吗（先查快照，再查正文，忽略大小写）。 */
function expectHit(expect, { snapshotText = "", pageText = "" } = {}) {
  const spec = normalizeExpect(expect);
  if (!spec) return null;
  const probe = spec.toLowerCase();
  const texts = [snapshotText, pageText].map((value) => String(value ?? "").toLowerCase());
  return texts.some((text) => text.includes(probe));
}

/** expect 可能是字符串，也可能是 { text } / { selector }（草稿里通常只有文字）。 */
function normalizeExpect(expect) {
  if (expect === undefined || expect === null) return "";
  if (typeof expect === "string") return expect.trim();
  if (typeof expect === "object" && typeof expect.text === "string") return expect.text.trim();
  return "";
}

/** 只取域名给提示用：返回里不写整条 URL（可能带 token）。 */
function safeHost(url) {
  try {
    return new URL(String(url)).hostname || "unknown";
  } catch {
    return "unknown";
  }
}

/** 当前页面地址：拿不到就 null，不臆造。 */
function currentUrl(browser, target) {
  try {
    if (typeof browser.urlOf !== "function") return null;
    const url = browser.urlOf(target);
    return typeof url === "string" && url ? url : null;
  } catch {
    return null;
  }
}

/** 草稿里的站点和当前地址对得上吗（unknown 不检查，域名按「同域或子域」算）。 */
export function siteMatches(draftSite, url) {
  const site = String(draftSite ?? "").trim().toLowerCase();
  if (!site || site === "unknown") return true;
  if (!url) return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === site || host.endsWith(`.${site}`);
  } catch {
    return true;
  }
}

/**
 * 导航后核对地址：只看 origin + pathname（query / hash / 末尾斜杠不算差异）。
 * 解析不了就按字符串包含判断；两边都拿不到就 false（没读到地址不算确认）。
 */
export function sameUrlPath(wanted, actual) {
  if (!wanted || !actual) return false;
  try {
    const a = new URL(wanted);
    const b = new URL(actual);
    const path = (value) => value.replace(/\/+$/, "");
    return a.origin === b.origin && path(a.pathname) === path(b.pathname);
  } catch {
    return String(actual).includes(String(wanted));
  }
}

/**
 * 变量是否按 secret 处理：
 *   - 草稿里明确写了 secret:true → secret；
 *   - 明确写了 secret:false → 也要按名字重判一遍，判出来是 secret 就取更严的（手工改过的草稿、
 *     别的写草稿入口把「密码」写成 secret:false 时不能让重判短路）；
 *   - 没写（老草稿）：用 classifyVariable 按名字重判，判得出 secret 就是 secret；
 *   - 连名字都判不出类型（classifyVariable 退回 text）→ 按 secret 处理（宁可多要一次值，也不明文回显）。
 */
export function variableIsSecret(variable) {
  if (variable?.secret === true) return true;
  const reclassified = classifyVariable({ name: variable?.name ?? "", target: variable?.target ?? "" });
  if (reclassified.secret === true) return true;
  if (variable?.secret === false) return false;
  // 判不出类型（text）且草稿也没给类型：按 secret 处理
  if (reclassified.type === "text" && (!variable?.type || variable.type === "text")) return true;
  return false;
}

/**
 * 重放一份草稿。
 *
 * @param {object} draft 草稿（steps / variables / site）
 * @param {object} options
 * @param {Record<string, string>} [options.vars]    变量名 → 值（和 variables[].name 对应）
 * @param {string[]} [options.values]               按变量顺序给值（老调用方式）
 * @param {number}  [options.confirmStep]           确认第几步（从 1 数）；只放行这一步
 * @param {string}  [options.confirmTarget]         那一步的目标名；和草稿里的 target 对不上就拒绝
 * @param {number}  [options.fromStep]              从第几步开始跑（从 1 数）；前面的步骤一律不执行
 * @param {boolean} [options.dryRun]                只定位不执行
 * @param {boolean} [options.preview]               预演：不读页面、不执行，只列出将要做的动作和不支持的步骤（不需要 browser）
 * @param {boolean} [options.autopilot]             调用方明确表示「不用一步步核对」（提交前面有未验证的写步骤也不停）
 * @param {number}  [options.maxSteps]              最多跑几步（调试用；从 fromStep 起算，不是绝对下标）
 * @param {{ id?: string, space?: string }} [options.target] 目标格子 / 空间（显式给的最优先）
 * @param {string}  [options.expectSite]            草稿站点是 unknown / 空、又带 secret 时必须显式给的站点
 * @param {(id: string) => boolean} [options.profileAllowed] 运行时格子授权判断（只给 space 解析出的格子也要过）
 * @param {((url: string) => ({ ok: boolean, reason?: string })) | null} [options.urlAllowed]
 *        口令作用域的域名白名单：草稿站点和每个 navigate 步骤的地址都要过这一道（内联 draft 和已存草稿都覆盖）
 * @param {(entry: object) => void} [options.audit] 每一步的审计回调（不记输入值；开跑前的拒绝也会写）
 * @param {object}  options.browser                 浏览器依赖：resolveTarget / snapshot / snapshotScoped /
 *                                                  read / act / navigate / wait / urlOf
 * @returns {Promise<object>} { status, steps, completed, dispatched, total, current, next_step, message, variables }
 */
export async function replayDraft(draft, {
  vars = {},
  values = [],
  confirmStep = null,
  confirmTarget = "",
  fromStep = null,
  dryRun = false,
  preview = false,
  autopilot = false,
  maxSteps = Infinity,
  target: explicitTarget = null,
  expectSite = "",
  profileAllowed = null,
  urlAllowed = null,
  audit = null,
  browser,
} = {}) {
  if (preview === true) dryRun = true;
  // 预演不需要浏览器：一步都不读页面、不发动作；只有真执行 / 定位干跑才需要 browser 依赖
  if (!browser && !preview) throw new Error("replayDraft 需要 browser 依赖");
  const steps = Array.isArray(draft?.steps) ? draft.steps : [];
  const declared = Array.isArray(draft?.variables) ? draft.variables : [];

  /**
   * 开跑前的拒绝也要留痕：重放是带写权限的通道，「有人拿错误参数反复尝试」必须事后查得到。
   * 只记结论和原因（不含任何变量值），所有「一步都没发」的拒绝路径统一走这里。
   */
  const refused = (message, nextStep, extra = {}) => {
    if (typeof audit === "function") {
      try {
        audit({
          tool: "flow_replay",
          action: "replay",
          event: "refused",
          total: steps.length,
          dryRun,
          fromStep,
          refused: true,
          reason: message,
          completed: extra.completed ?? 0,
          dispatched: extra.dispatched ?? 0,
        });
      } catch { /* 审计失败不影响重放 */ }
    }
    return {
      status: RUN_STATUS.FAILED,
      steps: [],
      completed: extra.completed ?? 0,
      dispatched: extra.dispatched ?? 0,
      total: steps.length,
      dryRun,
      variables: extra.variables,
      message,
      next_step: nextStep ?? null,
    };
  };

  /**
   * 域名白名单（口令作用域里的 domains）：给了判断就按它拒；没有判断（老口令 / 无作用域）直接放行，
   * 和 tool-policy 的「老口令完全跳过」一致。地址解析不了或协议不对都算不过。
   */
  const urlCheck = (url) => {
    if (typeof urlAllowed !== "function") return { ok: true };
    const raw = String(url ?? "").trim();
    if (!raw) return { ok: true };
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return { ok: false, reason: `地址不是合法的绝对 URL：${raw.slice(0, 120)}` };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, reason: `只允许 http / https 地址（收到 ${parsed.protocol}）` };
    }
    try {
      return urlAllowed(raw) ?? { ok: true };
    } catch {
      // 判断本身出错按「不放行」处理
      return { ok: false, reason: "域名白名单判断出错，按不放行处理" };
    }
  };

  // 变量值只在这次调用里存在：优先用按照变量名给的，其次按顺序给（老调用方式）
  const provided = new Map();
  for (const [name, value] of Object.entries(vars ?? {})) provided.set(String(name), String(value ?? ""));
  declared.forEach((variable, index) => {
    if (!provided.has(variable.name) && values[index] !== undefined) provided.set(variable.name, String(values[index]));
  });

  // 每个变量的「真实身份」：secret 与否在这里定下来 —— 值在哪都用它，返回里一律不回显值
  const secretOf = new Map(declared.map((variable) => [variable.name, variableIsSecret(variable)]));
  const isSecret = (name) => secretOf.get(name) === true;

  // 变量摘要：不写任何值，只给「是否 secret / 长度 / 是否已提供」
  const variableSummary = declared.map((variable) => {
    const known = provided.has(variable.name);
    const secret = isSecret(variable.name);
    return {
      name: variable.name,
      type: variable.type ?? (secret ? "password" : "text"),
      required: variable.required !== false,
      secret,
      // secret 连长度都不给（长度也是派生信息）；普通变量给长度（草稿本来就记了）
      length: secret ? undefined : (provided.has(variable.name) ? [...provided.get(variable.name)].length : variable.length),
      provided: known,
      // 值：无论是不是 secret，一律不回显
      value: undefined,
    };
  });

  // 开跑前：缺 secret → 拒绝；缺必填 → 整体拒绝（只跳过那一步会让后面的步骤跑在没填的页面上）
  const missingSecret = declared
    .filter((variable) => isSecret(variable.name) && variable.required !== false && !provided.has(variable.name))
    .map((variable) => variable.name);
  const missingRequired = declared
    .filter((variable) => !isSecret(variable.name) && variable.required !== false && !provided.has(variable.name))
    .map((variable) => variable.name);
  // 预演只是看将要做什么：缺变量不该拦住查看（变量摘要里会标「未给」）
  if (!preview && (missingSecret.length || missingRequired.length)) {
    const parts = [];
    if (missingSecret.length) parts.push(`缺少秘密变量（${missingSecret.join("、")}）的值：secret 只放在本次调用的 vars 里，不落盘、不进日志。`);
    if (missingRequired.length) parts.push(`缺少必填变量（${missingRequired.join("、")}）的值。`);
    return refused(
      `开跑前检查没过，一步都没有执行。${parts.join("")}先向用户要齐这些值（只填在 vars 里），再重放。`,
      "向用户要这些值（只填在 vars 里），不要写进草稿或日志；补齐后重新调用 flow_replay",
      { variables: variableSummary },
    );
  }

  /*
   * 站点：草稿记的站点是 unknown / 空，又带 secret 变量时，不能当成「不用核对」（这类草稿很常见：
   * 从已经打开着的页面录，步骤里没有 browser_navigate，就没有地址可推断）。
   * 这时要求调用方显式给 expectSite；给了就按它核对，不给就直接拒绝。
   */
  const declaredSite = String(draft?.site ?? "").trim().toLowerCase();
  // expectSite 也接受整条 URL：只取域名/主机名
  const expectedSite = String(expectSite ?? "").trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "");
  const hasSecretVars = declared.some((variable) => isSecret(variable.name)) || steps.some((step) => isSecret(placeholderOf(step)));
  if (!preview && hasSecretVars && (!declaredSite || declaredSite === "unknown")) {
    if (!expectedSite) {
      return refused(
        "草稿里有 secret 变量，但草稿没记站点（unknown）：这种草稿不能当「不用核对」。先确认这次要填密码的站点，带 expectSite（域名，例如 login.example.com）再重放。",
        "向用户确认目标站点，带 expectSite: \"域名\" 重放；或重新录一份从 browser_navigate 开始的草稿",
        { variables: variableSummary },
      );
    }
    // expectSite 和草稿里记的站点（如果有）也不能互相矛盾
    if (declaredSite && declaredSite !== "unknown" && !siteMatches(declaredSite, `https://${expectedSite}`)) {
      return refused(
        `expectSite（${expectedSite}）和草稿记的站点（${declaredSite}）不一致：不往两边都不是的站点填 secret。`,
        "核对草稿和这次要操作的站点，确认后再重放",
        { variables: variableSummary },
      );
    }
  }
  /** 站点核对用哪个域名：草稿记了就用草稿的；草稿是 unknown 时用调用方显式给的 expectSite。 */
  const siteToCheck = declaredSite && declaredSite !== "unknown" ? declaredSite : expectedSite || declaredSite;

  /*
   * 口令作用域的域名白名单（scope.domains）对 flow_replay 同样生效：
   *   ① 草稿记的站点必须在白名单里（它是从哪录的都不例外）；
   *   ② 每个 navigate 步骤的地址都必须在白名单里 —— 内联 draft 和已存草稿两条路都在开跑前拦住，一步都不发；
   *      真跑到导航那一步时还会用同一份判断再兜一次（草稿可能在两次调用之间被改过）。
   * 不在白名单时只提域名，不把整条 URL（可能带 token）写进返回。
   */
  const navigationSteps = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => NAV_ACTIONS.has(String(step?.action ?? "").toLowerCase()))
    .map(({ step, index }) => ({ index, url: String(step?.url_pattern ?? "").trim() }));
  if (declaredSite && declaredSite !== "unknown") {
    const siteCheck = urlCheck(`https://${declaredSite}/`);
    if (!siteCheck.ok) {
      return refused(
        `草稿的站点（${declaredSite}）不在这个口令允许的域名范围里：重放一步都没有执行。${siteCheck.reason ? `（${siteCheck.reason}）` : ""}`,
        "换一个允许的站点，或让用户改口令作用域里的域名列表",
        { variables: variableSummary },
      );
    }
  }
  /*
   * expectSite 同样要过口令白名单：草稿站点是 unknown 时，它是唯一决定「往哪个站点填 secret」的地址。
   * 只校验草稿站点和 navigate 地址、漏掉它，等于让调用方自己挑一个白名单外的站点去填密码。
   */
  if (expectedSite) {
    const expectedCheck = urlCheck(`https://${expectedSite}/`);
    if (!expectedCheck.ok) {
      return refused(
        `expectSite（${expectedSite}）不在这个口令允许的域名范围里：重放一步都没有执行。${expectedCheck.reason ? `（${expectedCheck.reason}）` : ""}`,
        "换成口令允许的站点再给 expectSite；需要放开请让用户改口令作用域里的域名列表",
        { variables: variableSummary },
      );
    }
  }
  for (const item of navigationSteps) {
    if (!item.url) continue; // 缺地址由执行那一步拒绝（报得更具体）
    const check = urlCheck(item.url);
    if (!check.ok) {
      let host = "";
      try { host = new URL(item.url).hostname; } catch { host = ""; }
      return refused(
        `第 ${item.index + 1} 步要导航到 ${host || "一个不在允许范围的地址"}，不在这个口令允许的域名范围里：重放一步都没有执行${check.reason ? `（${check.reason}）` : ""}。`,
        "换一个允许的地址，或让用户改口令作用域里的域名列表；地址内联在 draft 里或存成草稿都绕不过这道检查",
        { variables: variableSummary },
      );
    }
  }

  /** 目标格子 / 空间：显式给的 id / space 原样带下去，绝不给就把 space 丢掉。 */
  let target = null;
  if (preview && !browser) {
    // 预演不需要浏览器：只记下显式给的格子 / 空间，不去解析（更不会落到人用的「我的」）
    const explicit = explicitTarget && typeof explicitTarget === "object" ? explicitTarget : {};
    const hasId = typeof explicit.id === "string" && explicit.id.trim() !== "";
    const hasSpace = typeof explicit.space === "string" && explicit.space.trim() !== "";
    if (hasId) target = { id: String(explicit.id), ...(hasSpace ? { space: String(explicit.space) } : {}) };
    else if (hasSpace) target = { space: String(explicit.space) };
    if (target?.id && typeof profileAllowed === "function" && !profileAllowed(target.id)) {
      return unresolvedTarget(refused, variableSummary, "显式给的格子不在当前口令 / 连接器允许的范围内");
    }
  } else {
    const explicit = explicitTarget && typeof explicitTarget === "object" ? explicitTarget : {};
    const hasId = typeof explicit.id === "string" && explicit.id.trim() !== "";
    const hasSpace = typeof explicit.space === "string" && explicit.space.trim() !== "";
    if (hasId) {
      // 只给格子时空间交给浏览器依赖解析（在那个格子的空间列表里找唯一的 owner=ai 空间）。
      // 解析不出来就拒绝 —— 绝不把 space 留空，page_* 的缺省含义是「我的」（人正在用的）。
      if (hasSpace) {
        target = { id: String(explicit.id), space: String(explicit.space) };
      } else {
        const extra = await resolveSpaceIfNeeded({ browser, id: explicit.id, site: draft?.site, url: firstUrl(draft) });
        if (!extra.space) return unresolvedTarget(refused, variableSummary, "只给了格子，没解析出这个格子里属于 AI 的唯一空间");
        target = { id: String(explicit.id), space: String(extra.space) };
      }
    } else if (hasSpace) {
      // 只给 space：格子可以是草稿里记的，也可以交给浏览器依赖按空间找；解析不出唯一目标就拒绝
      const draftGrid = draft?.target?.id ? String(draft.target.id) : "";
      if (draftGrid) {
        const resolved = typeof browser.resolveTarget === "function"
          ? await safeResolve(browser, { id: draftGrid, space: explicit.space, site: draft?.site, url: firstUrl(draft) })
          : null;
        const id = resolved?.id ? String(resolved.id) : draftGrid;
        target = { id, space: String(explicit.space) };
      } else {
        const resolved = typeof browser.resolveTarget === "function"
          ? await safeResolve(browser, { space: explicit.space, site: draft?.site, url: firstUrl(draft) })
          : null;
        if (!resolved?.id) return unresolvedTarget(refused, variableSummary);
        if (resolved.space && String(resolved.space) !== String(explicit.space)) {
          // 依赖给的格子不属于这个空间：绝不能落到人用的「我的」上，直接拒绝
          return unresolvedTarget(refused, variableSummary, `「${explicit.space}」这个空间所在的格子没解析出来`);
        }
        target = { id: String(resolved.id), space: String(explicit.space) };
      }
    } else if (typeof browser.resolveTarget === "function") {
      const resolved = await safeResolve(browser, { site: draft?.site, url: firstUrl(draft) });
      if (resolved?.id) {
        const space = resolved.space
          ? String(resolved.space)
          : (await resolveSpaceIfNeeded({ browser, id: resolved.id, site: draft?.site, url: firstUrl(draft) })).space;
        // 没有空间就不跑：space 缺省等于「我的」，重放绝不能落到人正在用的标签页
        if (space) target = { id: String(resolved.id), space };
      }
    }
    if (!target) return unresolvedTarget(refused, variableSummary);
    // 只给 space 时格子是运行时解析出来的：同样要过口令作用域 / 连接器授权（bridge 只能查显式 grid）
    if (typeof profileAllowed === "function" && !profileAllowed(target.id)) {
      return unresolvedTarget(refused, variableSummary, "解析出的格子不在当前口令 / 连接器允许的范围内");
    }
  }

  const results = [];
  let completed = 0;
  let dispatched = 0;
  const done = () => Promise.resolve({ completed, dispatched });

  /*
   * 普通失败（定位不到 / 缺参数 / 动作返回 failed …）时的下一步：
   * 「先 page_snapshot 看看」本身没错，但前面如果已经执行过写步骤，绝不能引导调用方从头重跑
   * （重复下单 / 重复发帖就是这么来的）。只要 completed > 0 或 dispatched > 0，就统一带上
   * fromStep 和「不要从头重跑」，和 UNCERTAIN 路径一个口径。
   * retry 不传时就用 base：前面什么都没执行时可以照原样重试。
   */
  const stepHint = (base, retry = null, nextIndex = null) => {
    if (dispatched <= 0 && completed <= 0) {
      const plain = retry ?? base;
      return { retry: plain, next: plain };
    }
    const already = dispatched > 0
      ? `前 ${completed} 步已经执行过（其中 ${dispatched} 步只派发、还没验证）`
      : `前 ${completed} 步已经执行过`;
    const resumeText = nextIndex === null || nextIndex === undefined
      ? "核对后用 fromStep 从下一步续跑"
      : `核对后用 fromStep: ${nextIndex} 续跑`;
    return {
      retry: `${base}（${already}，不要从头重跑）`,
      next: `${already}：${base}；${resumeText}，不要从头重跑（前面的写动作会重发）`,
    };
  };

  if (typeof audit === "function") {
    try {
      audit({ tool: "flow_replay", action: "replay", event: "start", total: steps.length, dryRun, preview, fromStep, target: { id: target?.id ?? null, space: target?.space ?? null } });
    } catch { /* 审计失败不影响重放 */ }
  }

  // 站点：第一次拿到页面地址就核对。草稿有 secret 变量时不一致直接停，不往陌生站点填密码
  let warning = null;
  const checkSite = (url) => {
    /*
     * 拿不到地址（快照降级 / 还没 remember 到值）：有 secret 的草稿不能当「站点对上了」放行 ——
     * 这正是 #7「unknown 不能等于不核对」的同一件事，只是发生在运行时。没有 secret 才只提醒。
     */
    if (!url) {
      if (!hasSecretVars) return null;
      return {
        stop: true,
        message: `读不到当前页面的地址，没法确认现在打开的是不是 ${siteToCheck || "草稿记的站点"}。草稿里有 secret 变量，不确认站点就不填：先 page_snapshot / page_read 确认页面地址，再用 fromStep 决定从哪一步继续。`,
      };
    }
    if (siteMatches(siteToCheck, url)) return null;
    const text = `当前页面 ${url} 和草稿记的站点（${siteToCheck || "unknown"}）不一致。`;
    if (!hasSecretVars) return { stop: false, message: `${text}确认这个格子 / 空间里打开的是对的网站。` };
    return {
      stop: true,
      message: `${text}草稿里有 secret 变量，绝不在别的站点上填：先打开对的网站，再用 fromStep 决定从哪一步继续。`,
    };
  };

  const finish = async (status, message, nextStep, extra = {}) => {
    let snapshot = "";
    let url = null;
    // 预演没有浏览器依赖：不去读页面（也不该碰真实端口）
    if (browser) {
      try {
        const shot = await browser.snapshot(target);
        snapshot = normalizeSnapshot(shot);
        url = urlOfSnapshot(shot) ?? currentUrl(browser, target);
      } catch { /* 页面状态读不到不影响结论 */ }
    }
    // 每一步都写进审计：只记步骤号 / 动作 / 目标名 / 四态，不记任何输入值
    if (typeof audit === "function") {
      for (const entry of results) {
        try { audit({ ...stepAudit(entry), tool: "flow_replay", event: "step", dryRun }); } catch { /* 审计失败不影响重放 */ }
      }
      try {
        audit({ tool: "flow_replay", action: "replay", event: "end", status, completed, dispatched, total: steps.length });
      } catch { /* 审计失败不影响重放 */ }
    }
    return {
      status,
      steps: results,
      completed,
      dispatched,
      total: steps.length,
      dryRun,
      variables: variableSummary,
      message,
      next_step: nextStep ?? null,
      warning,
      ...extra,
      current: { url, snapshot: snapshot.slice(0, 4000), truncated: snapshot.length > 4000 },
    };
  };

  // 续跑起点：fromStep（从 1 数）；越界直接拒绝，不能当成「重放完成」
  const parsedFrom = Number(fromStep);
  if (Number.isFinite(parsedFrom) && Math.floor(parsedFrom) > steps.length) {
    return refused(
      `fromStep 给的是第 ${Math.floor(parsedFrom)} 步，但草稿只有 ${steps.length} 步：没有续跑任何一步。`,
      "先 flow_get_draft 核对步骤编号（草稿可能被重新保存过）",
      { variables: variableSummary },
    );
  }
  const start = Number.isFinite(parsedFrom) && parsedFrom > 1 ? Math.floor(parsedFrom) - 1 : 0;
  /*
   * maxSteps 是「最多跑几步」，不是绝对下标：从 start 往后数。
   * 给了有限数值就严格按它算 —— 0 / 负数表示「一步都不跑」，绝不当成「不限」；
   * 只有没给（undefined / null）/ Infinity 才算不限。给了别的值却解析不出整数（例如 "2 步"、空字符串、
   * 布尔值）时直接拒绝：当「不限」会顺手把后面的提交步骤全跑掉，方向正好相反。
   */
  const rawMax = maxSteps === undefined || maxSteps === null ? Infinity : maxSteps;
  let maxCount = steps.length;
  if (rawMax !== Infinity) {
    const numeric = typeof rawMax === "number"
      ? rawMax
      : (typeof rawMax === "string" && rawMax.trim() !== "" ? Number(rawMax) : NaN);
    if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) {
      return refused(
        `maxSteps 只接受整数（收到 ${String(rawMax).slice(0, 40) || "空值"}）：这次一步都没有执行，也没有把「解析不出数字」当成不限。`,
        "把 maxSteps 改成整数（0 表示一步都不跑；不给才表示不限）后再调用 flow_replay",
        { variables: variableSummary },
      );
    }
    maxCount = Math.max(0, numeric);
  }
  const limit = Math.min(steps.length, start + maxCount);

  // 确认绑定到步：confirmStep 给的是哪一步就只放行那一步
  let confirmedIndex = null;
  const parsedConfirmStep = Number(confirmStep);
  if (Number.isFinite(parsedConfirmStep) && parsedConfirmStep >= 1) {
    confirmedIndex = Math.floor(parsedConfirmStep) - 1;
    if (confirmedIndex >= steps.length) {
      return refused(
        `confirmStep 给的是第 ${parsedConfirmStep} 步，但草稿只有 ${steps.length} 步。`,
        "先 flow_get_draft 看步骤编号，再用正确的 confirmStep 调用",
        { variables: variableSummary },
      );
    }
    // 确认第 N（N > 1）步却不给 fromStep：start 还是 0，前面的写动作会被重发（重复下单）
    if (!dryRun && parsedConfirmStep > 1 && !(Number.isFinite(parsedFrom) && parsedFrom > 1)) {
      return refused(
        `确认第 ${parsedConfirmStep} 步要同时给 fromStep: ${parsedConfirmStep}：不然第 1..${parsedConfirmStep - 1} 步会重新执行，前面已经发出去的写动作会重发。`,
        `先用 page_read 核对前面的步骤，再带 fromStep: ${parsedConfirmStep} + confirmStep: ${parsedConfirmStep} 续跑`,
        { variables: variableSummary },
      );
    }
    /*
     * 确认的那一步必须在这次要跑的范围内：fromStep 抄大一位（confirmStep: 3 + fromStep: 4）时，
     * 第 3 步根本不会执行，确认就被静默吞掉 —— 调用方会误以为已经确认过。
     */
    const confirmedStepNo = confirmedIndex + 1;
    if (!dryRun && confirmedStepNo < start + 1) {
      return refused(
        `confirmStep 给的是第 ${confirmedStepNo} 步，但这次从第 ${start + 1} 步开始跑：被确认的那一步不会执行，确认就白费了（也看不出你确认的是哪一步）。确认第 ${confirmedStepNo} 步要从第 ${confirmedStepNo} 步开始跑。`,
        `用 fromStep: ${confirmedStepNo} + confirmStep: ${confirmedStepNo} 续跑（前面的写动作不重发）`,
        { variables: variableSummary },
      );
    }
    if (confirmedIndex >= limit) {
      return refused(
        `confirmStep 给的是第 ${confirmedStepNo} 步，但这次最多只跑到第 ${limit} 步（fromStep: ${start + 1} + maxSteps: ${maxCount}）外的步骤不会执行：确认不会生效。`,
        `把 maxSteps 放到能覆盖第 ${confirmedStepNo} 步，或直接从第 ${confirmedStepNo} 步开始（fromStep: ${confirmedStepNo}）`,
        { variables: variableSummary },
      );
    }
    const wanted = String(confirmTarget ?? "").trim();
    const actual = String(steps[confirmedIndex]?.target ?? "").trim();
    if (!wanted) {
      return refused(
        `确认第 ${parsedConfirmStep} 步要带上那一步的目标名（confirmTarget），否则没法确认你确认的是哪一步。第 ${parsedConfirmStep} 步是「${actual || steps[confirmedIndex]?.action || "?"}」。`,
        `带上 confirmStep: ${parsedConfirmStep} 和 confirmTarget: "${actual}" 再调`,
        { variables: variableSummary },
      );
    }
    if (wanted !== actual) {
      return refused(
        `第 ${parsedConfirmStep} 步的目标是「${actual}」，不是「${wanted}」：确认绑定到具体一步，名字对不上就拒绝（绝不顺手放行别的提交步骤）。`,
        "flow_get_draft 核对步骤编号和目标名，再重新确认",
        { variables: variableSummary },
      );
    }
  }

  /*
   * maxSteps: 0 / 负数：一步都没执行。绝不能返回 success + 「重放完成：0/0 步都读回确认了」——
   * 调用方会把 maxSteps 当阀门，拿到 success 就以为「草稿没问题、已经跑通」，接着放开全跑。
   */
  if (limit <= start) {
    const why = rawMax === Infinity ? "草稿里没有可执行的步骤" : `maxSteps: ${maxCount}`;
    return finish(
      RUN_STATUS.NOOP,
      `${why}，没有执行任何步骤（草稿共 ${steps.length} 步${start > 0 ? `，这次从第 ${start + 1} 步起算` : ""}）。`,
      rawMax === Infinity
        ? "先 flow_get_draft 确认草稿里确实有步骤，再重放"
        : `把 maxSteps 改成大于 0 的整数（或去掉不给）再重放；要给第 ${Math.min(start + 1, steps.length)} 步做确认时用 fromStep: ${Math.min(start + 1, steps.length)} + confirmStep`,
    );
  }

  for (let index = start; index < limit; index += 1) {
    const step = steps[index] ?? {};
    const action = String(step.action ?? "").toLowerCase();
    const entry = {
      index: index + 1,
      action,
      target: step.target ?? "",
      // 按键要带进审计：commitBoundary 只有 key=Enter 这类才算提交边界（stepAudit 用）
      key: typeof step.key === "string" ? step.key : null,
      status: STEP_STATUS.SUCCESS,
      fragile: false,
      ref: null,
      locator: null,
      note: "",
    };
    results.push(entry);

    /*
     * 草稿里标了「不支持」的步骤（back / reload、没有可定位名字的写步骤、批量填表…）：
     *   - 预演：如实列出来，不执行也不假装支持；
     *   - 真执行：直接停下，绝不静默跳过 —— 跳过会让后面的步骤跑在错的页面状态上。
     */
    if (step.unsupported === true) {
      const reason = String(step.unsupportedReason ?? "回放没法重走这一步");
      if (preview) {
        entry.status = STEP_STATUS.SKIPPED;
        entry.unsupported = true;
        entry.unsupportedReason = reason;
        entry.note = `不支持：${reason}`;
        continue;
      }
      entry.status = STEP_STATUS.FAILURE;
      entry.note = `草稿标记这一步「不支持」：${reason}`;
      const hint = stepHint("先手工处理这一步，或重新录一份能重放的草稿", null, index + 1);
      return finish(RUN_STATUS.FAILED, `第 ${index + 1} 步不支持：${entry.note}`, hint.next);
    }

    // 0. 提交类步骤之前还有未验证的写步骤：先停下要求核对（别在没确认的页面上继续点提交）
    //    — dryRun 只是定位检查，不拦；
    //    — autopilot 是调用方明确表示「不用一步步核对」，只有它能豁免这道停；
    //    — 本步的 confirmStep 只豁免「这一步自己的 confirm」，绝不能豁免「前面有未验证写步骤」
    //      （确认这一步不代表前面的步骤已经核对过；要续跑请用 fromStep 从这一步开始）。
    const stepConfirmed = index === confirmedIndex;
    if (!dryRun && !autopilot && isCommitStep(step) && dispatched > 0) {
      entry.status = STEP_STATUS.SKIPPED;
      entry.note = "前面还有未验证的写步骤，这一步没有执行";
      // 回车既可能是普通回车（换行 / 搜索），也可能是提交：回放拿不到表单结构，只能按失败关闭停下
      const what = String(step.action ?? "").toLowerCase() === "key"
        ? `第 ${index + 1} 步是回车（可能是普通回车，也可能是提交）`
        : `第 ${index + 1} 步是提交类动作`;
      return finish(
        RUN_STATUS.UNCERTAIN,
        `${what}，但前面有 ${dispatched} 步写动作只派发了、没验证：先 page_snapshot / page_read 核对，确认后再从第 ${index + 1} 步续跑（fromStep: ${index + 1}）。`,
        `先 page_read 核对前面 ${dispatched} 步的结果；确认无误后用 fromStep: ${index + 1} 续跑`,
      );
    }

    // 1. 导航步骤：走浏览器的导航通道，导航后读回地址才算成功（绝不静默跳过）
    if (NAV_ACTIONS.has(action)) {
      /*
       * 干跑不导航，但也不能「记成功什么都不查」：至少校验地址非空、协议 http/https、域名和草稿站点一致、
       * 口令白名单放行。查不过就不算进「能定位」的分子，也不说草稿可用。
       */
      if (dryRun) {
        const dryUrl = String(step.url_pattern ?? "").trim();
        const dryNote = preview ? "预演不导航（只检查草稿里的地址）" : "干跑不导航（只检查草稿里的地址）";
        if (!dryUrl) {
          entry.status = STEP_STATUS.FAILURE;
          entry.note = "草稿里的导航步骤没有地址，干跑也当失败";
          return finish(RUN_STATUS.FAILED, `第 ${index + 1} 步导航地址为空：${entry.note}`, "先用 flow_get_draft 看这一步，补上地址或重新录一份草稿");
        }
        const dryCheck = urlCheck(dryUrl);
        if (!dryCheck.ok) {
          entry.status = STEP_STATUS.FAILURE;
          entry.note = `导航地址不在这个口令允许的域名范围里${dryCheck.reason ? `（${dryCheck.reason}）` : ""}`;
          return finish(RUN_STATUS.FAILED, `第 ${index + 1} 步干跑就过不了：${entry.note}`, "换一个允许的地址，或让用户改口令作用域里的域名列表");
        }
        if (siteToCheck && !siteMatches(siteToCheck, dryUrl)) {
          entry.status = STEP_STATUS.UNCERTAIN;
          entry.note = `干跑不导航；这一步的地址（${safeHost(dryUrl)}）和草稿站点（${siteToCheck}）不一致，干跑报告不算它能用`;
          return finish(
            RUN_STATUS.UNCERTAIN,
            `第 ${index + 1} 步干跑发现地址和草稿站点不一致：${entry.note}`,
            "核对草稿里的地址和站点，确认后再重放",
            { uncertainStep: index + 1 },
          );
        }
        entry.status = preview ? STEP_STATUS.PLANNED : STEP_STATUS.SUCCESS;
        entry.note = preview
          ? `将导航到 ${safeHost(dryUrl)}（预演不导航；地址通过检查）`
          : `${dryNote}；地址 ${safeHost(dryUrl)} 通过检查`;
        if (!preview) completed += 1;
        continue;
      }
      const url = String(step.url_pattern ?? "").trim();
      // 兜底：开跑前已经按口令白名单查过一遍，真正导航前再用同一份判断查一次（草稿可能被改过）
      if (url) {
        const navCheck = urlCheck(url);
        if (!navCheck.ok) {
          entry.status = STEP_STATUS.FAILURE;
          entry.note = `导航地址 ${safeHost(url)} 不在这个口令允许的域名范围里${navCheck.reason ? `（${navCheck.reason}）` : ""}`;
          return finish(RUN_STATUS.FAILED, `第 ${index + 1} 步导航被口令作用域拒绝：${entry.note}`, "换一个允许的地址，或让用户改口令作用域里的域名列表", { refused: true });
        }
      }
      if (!url || typeof browser.navigate !== "function") {
        entry.status = STEP_STATUS.FAILURE;
        entry.note = !url
          ? "草稿里的导航步骤没有地址，没法执行"
          : "浏览器依赖没有导航通道，重放不会假装这一步做过了";
        const hint = stepHint("先在格子里打开目标站点，或改用带 browser_navigate 重新录的草稿", null, index + 1);
        return finish(RUN_STATUS.FAILED, `第 ${index + 1} 步无法导航：${entry.note}`, hint.next);
      }
      try {
        await browser.navigate(target, url);
        if (typeof browser.wait === "function") await browser.wait(500);
        const after = await browser.snapshot(target);
        const afterUrl = urlOfSnapshot(after) ?? currentUrl(browser, target);
        if (sameUrlPath(url, afterUrl)) {
          entry.status = STEP_STATUS.SUCCESS;
          entry.note = `已导航到 ${afterUrl}`;
          completed += 1;
        } else {
          entry.status = STEP_STATUS.UNCERTAIN;
          entry.note = `导航后读回的地址是 ${afterUrl || "未知"}，和草稿里的 ${url} 对不上`;
          return finish(
            RUN_STATUS.UNCERTAIN,
            `第 ${index + 1} 步导航结果不确定：${entry.note}`,
            "先 page_snapshot / page_read 核对页面现在停在哪，确认后再用 fromStep 决定是否继续",
            { uncertainStep: index + 1 },
          );
        }
      } catch (error) {
        entry.status = STEP_STATUS.UNCERTAIN;
        entry.note = `${error?.code || "NAVIGATE_FAILED"}：${error.message}`;
        return finish(
          RUN_STATUS.UNCERTAIN,
          `第 ${index + 1} 步导航没确认：${entry.note}`,
          "导航可能已经发生（地址可能已变）：先 page_snapshot 核对，再用 fromStep 决定是否继续；不要直接从头重跑",
          { uncertainStep: index + 1 },
        );
      }
      continue;
    }

    // 2. 只读观察 / 空间控制 / 无副作用动作（scroll / hover / focus）：回放时跳过
    //    （草稿可能记了快照 / 读取 / space_open / 滚动，重放不需要重走）
    if (READ_ACTIONS.has(action) || CONTROL_ACTIONS.has(action) || SKIPPABLE_ACTIONS.has(action) || (!WRITE_ACTIONS.has(action) && !step.value && !action)) {
      entry.status = STEP_STATUS.SKIPPED;
      entry.note = CONTROL_ACTIONS.has(action)
        ? "空间 / 钉住控制步骤，回放时跳过（目标已由参数指定）"
        : SKIPPABLE_ACTIONS.has(action)
          ? `「${action}」不改变页面内容（滚动 / 悬停 / 聚焦），回放时跳过`
          : "观察类步骤，回放时跳过";
      continue;
    }

    /*
     * 预演：到这里剩下的都是写动作（或未知动作）。不读页面、不定位、不执行，
     * 只说清楚「将会做什么」；未知动作标不支持，让调用方在预演里就看见。
     */
    if (preview) {
      if (!WRITE_ACTIONS.has(action)) {
        entry.status = STEP_STATUS.SKIPPED;
        entry.unsupported = true;
        entry.unsupportedReason = `动作「${action || "（空）"}」回放不认识`;
        entry.note = `不支持：${entry.unsupportedReason}`;
        continue;
      }
      entry.status = STEP_STATUS.PLANNED;
      entry.note = previewIntent(step, action, provided);
      continue;
    }

    if (!WRITE_ACTIONS.has(action)) {
      entry.status = STEP_STATUS.FAILURE;
      entry.note = `不认识的动作（${action || "空"}）：重放不会静默跳过它`;
      const hint = stepHint("先 flow_get_draft 看这一步，重新录一份能重放的草稿或手工处理这一步", null, index + 1);
      return finish(RUN_STATUS.FAILED, `第 ${index + 1} 步的动作「${action || "空"}」不支持：${entry.note}`, hint.next);
    }

    // 3. dialog 没有目标元素，也不该在对话框还开着的时候拍快照（控制服务会报 DIALOG_OPEN）
    const isDialog = action === "dialog";
    let shot = "";
    let located = { ref: null, score: null, how: isDialog ? "dialog" : null, name: "", hint: "", fragile: false, ambiguous: false, candidates: [] };
    if (!isDialog) {
      // 站点核对：第一次拿到页面地址就做（有 secret 时不一致直接停）
      try {
        const siteShot = await browser.snapshot(target);
        const immediate = checkSite(urlOfSnapshot(siteShot) ?? currentUrl(browser, target));
        if (immediate) {
          if (immediate.stop) {
            entry.status = STEP_STATUS.FAILURE;
            entry.note = immediate.message;
            const hint = stepHint(`先导航到 ${siteToCheck || "草稿记的站点"}，再重放`, null, index + 1);
            return finish(RUN_STATUS.FAILED, `站点核对没过：${immediate.message}`, hint.next);
          }
          warning = warning ?? immediate.message;
        }
      } catch { /* 拿不到快照不影响下面的定位（下一行会再拍一次） */ }

      /*
       * 4. 定位：在当前快照上按多路定位打分。
       * 拍快照本身也可能失败（DIALOG_OPEN / 控制服务超时 / 页面正在导航 / 格子被关掉）：
       * 这一步还没执行，但前面可能已经有「已派发未验证」的写动作。异常绝不能直接冲出 replayDraft
       * —— 那会让调用方只看到「重放失败」，然后天然地想从头再跑一遍（重复下单 / 重复发帖）。
       */
      try {
        shot = normalizeSnapshot(await browser.snapshot(target));
      } catch (error) {
        const code = error?.code || "SNAPSHOT_FAILED";
        const message = error?.message ?? String(error);
        // 前面只要执行过（写动作 / 导航），就不能说「可以修好再重试」诱导从头重跑
        const performed = completed > 0;
        entry.status = performed ? STEP_STATUS.UNCERTAIN : STEP_STATUS.FAILURE;
        entry.note = `${code}：${message}`;
        if (performed) {
          const already = dispatched > 0
            ? `前 ${dispatched} 步写动作已经派发、还没验证`
            : `前面已经有 ${completed} 步执行过`;
          return finish(
            RUN_STATUS.UNCERTAIN,
            `第 ${index + 1} 步之前读页面失败（${entry.note}）：${already}。先 page_snapshot 核对前面几步的结果，再用 fromStep: ${index + 1} 续跑；不要从头重跑（前面的动作会重发）。`,
            `先 page_snapshot / page_read 核对前面几步的结果（DIALOG_OPEN 就先关对话框），确认后用 fromStep: ${index + 1} 续跑；不要从头重跑`,
            { uncertainStep: index + 1 },
          );
        }
        return finish(
          RUN_STATUS.FAILED,
          `第 ${index + 1} 步之前读页面失败（${entry.note}）：这一轮还没有执行过任何动作，可以修好页面状态后重试。`,
          `先 page_snapshot 看页面能不能读（DIALOG_OPEN 就先关对话框、等页面导航完），再重放`,
        );
      }
      located = locateStep(step, shot);
      if (!located) {
        // CSS 选择器兜底：按选择器拍子树快照，唯一一个编号才认（照常走 page_act，闸门不绕）
        const selector = selectorOf(step);
        if (selector && typeof browser.snapshotScoped === "function") {
          try {
            const scoped = normalizeSnapshot(await browser.snapshotScoped(target, selector));
            const bySelector = locateBySelector(selector, scoped);
            located = bySelector.ref
              ? { ref: bySelector.ref, score: null, how: "css", name: bySelector.name, hint: bySelector.hint, fragile: true, ambiguous: false, candidates: [{ ref: bySelector.ref }] }
              : bySelector.candidates.length
                ? { ref: null, score: null, how: "css", name: "", hint: "", fragile: true, ambiguous: true, candidates: bySelector.candidates.map((ref) => ({ ref })) }
                : null;
          } catch { /* 选择器兜底失败就按下面的「找不到」处理 */ }
        }
      }
      if (!located) {
        entry.status = STEP_STATUS.FAILURE;
        entry.note = `在当前页面找不到「${step.target || action}」：网站可能改版了，重新录一遍这段，或者先 page_snapshot 看看现在的页面`;
        const hint = stepHint("先 page_snapshot 看页面，确认目标还在不在（改版后要重新录草稿，但别从头重跑）", null, index + 1);
        return finish(RUN_STATUS.FAILED, `第 ${index + 1} 步定位失败：${entry.note}`, hint.next);
      }
      if (located.ambiguous) {
        entry.status = STEP_STATUS.FAILURE;
        entry.candidates = located.candidates.map((item) => item.ref);
        entry.note = `「${step.target || action}」在页面上有 ${located.candidates.length} 个同分候选（${located.candidates.map((item) => item.ref).join("、")}）：没法确定是哪一个，没有执行`;
        const hint = stepHint("先用 page_snapshot 看清是哪一个，改草稿给目标补 data-testid / 更精确的可访问名，再重放", null, index + 1);
        return finish(
          RUN_STATUS.FAILED,
          `第 ${index + 1} 步定位不唯一：${entry.note}`,
          hint.next,
        );
      }
      entry.ref = located.ref;
      entry.score = located.score;
      entry.locator = located.how;
      entry.fragile = located.fragile;
    } else {
      entry.locator = "dialog";
    }

    /*
     * 确认绑定到草稿里的 target，但真正执行的是页面上命中的那个元素：
     * 两者名字不一致时，提交类步骤一律不执行（改版后「确认」可能命中「确认删除全部订单」）。
     */
    const draftName = String(step.target ?? "").trim();
    // 只认快照里的可访问名：data-testid 之类（提示名）是网页自己可写的属性，绝不能拿来放行确认
    const actualName = String(located.name ?? "").trim();
    let mismatchNote = "";
    if (!isDialog && draftName) {
      if (!actualName && !dryRun && isCommitStep(step)) {
        entry.status = STEP_STATUS.UNCERTAIN;
        entry.note = "页面上命中的提交元素没有可访问名，没法核对确认的是同一个元素，没有执行";
        return finish(
          RUN_STATUS.UNCERTAIN,
          `第 ${index + 1} 步无法核对确认目标：${entry.note}`,
          "先 page_snapshot 核对页面上的按钮名；没有可访问名的按钮建议重新录草稿或手工确认",
          { uncertainStep: index + 1 },
        );
      }
      if (actualName && actualName.toLowerCase() !== draftName.toLowerCase()) {
        mismatchNote = `实际命中的是「${actualName}」，不是草稿里的「${draftName}」`;
        if (!dryRun && isCommitHit(step, actualName)) {
          entry.status = STEP_STATUS.UNCERTAIN;
          entry.note = `${mismatchNote}：提交类步骤没有执行（要确认的和你确认的不是同一个元素）`;
          return finish(
            RUN_STATUS.UNCERTAIN,
            `第 ${index + 1} 步确认目标和实际元素不一致：${entry.note}`,
            "先 page_snapshot 核对页面上的按钮名；改版后要重新录草稿，不要按草稿名字硬点",
            { uncertainStep: index + 1 },
          );
        }
      }
    }

    // 3. 变量：把 {{占位符}} 换成这次给的值（返回里只显示 ●●●）
    const placeholder = placeholderOf(step);
    if (placeholder) {
      if (!provided.has(placeholder)) {
        const known = declared.find((item) => item.name === placeholder);
        // 必填变量缺值：开跑前就整轮拒绝过；能走到这里说明草稿里没登记这个占位符，同样不瞎填
        if (!known || known.required !== false) {
          entry.status = STEP_STATUS.FAILURE;
          entry.note = known
            ? `缺少必填变量「${placeholder}」的值`
            : `草稿里的变量「${placeholder}」没有登记在 variables 里，没法填`;
          const hint = stepHint("补齐 vars 里的变量值（只填在 vars 里），再重放", null, index + 1);
          return finish(RUN_STATUS.FAILED, `第 ${index + 1} 步的变量「${placeholder}」没有值：整轮停止`, hint.next);
        }
        // 选填变量没给：只跳过这一步（不瞎填）
        entry.status = STEP_STATUS.SKIPPED;
        entry.note = `选填变量「${placeholder}」这次没给值，跳过`;
        continue;
      }
      entry.value = displayValue();
    }

    // 5. 干跑：只报定位结果，不执行
    if (dryRun) {
      entry.status = STEP_STATUS.SUCCESS;
      const locNote = located.fragile ? "定位到了，但分数偏低（脆弱）：改版后很可能失效" : "定位到了";
      entry.note = mismatchNote ? `${locNote}；${mismatchNote}` : locNote;
      completed += 1;
      continue;
    }

    // 6. 执行：和 Agent 一样走 page_act（写操作闸门在这里生效）
    const call = { action };
    if (located.ref) call.ref = located.ref;
    if (placeholder) call.text = provided.get(placeholder);
    if (step.value && !placeholder) call.text = String(step.value);
    if (action === "select") {
      const selectValue = step.selectValue !== undefined ? step.selectValue : step.value && !placeholder ? String(step.value) : undefined;
      if (selectValue !== undefined) call.value = selectValue;
      if (placeholder) call.value = provided.get(placeholder);
    }
    if (action === "dialog") {
      // accept 必须显式带：缺省处理可能把用户本来要确认的对话框取消掉
      if (typeof step.accept !== "boolean") {
        entry.status = STEP_STATUS.FAILURE;
        entry.note = "草稿里的 dialog 步骤没有记 accept（确认 / 取消），不能发一个猜的动作";
        const hint = stepHint("重新录草稿，或先用 page_act 带 action:\"dialog\" + accept 手工处理这一步", null, index + 1);
        return finish(RUN_STATUS.FAILED, `第 ${index + 1} 步缺参数：${entry.note}`, hint.next);
      }
      call.accept = step.accept;
    }
    if (action === "check") {
      if (typeof step.checked !== "boolean") {
        entry.status = STEP_STATUS.FAILURE;
        entry.note = "草稿里的 check 步骤没有记 checked（要勾上还是取消），不能发一个半成品动作";
        const hint = stepHint("重新录草稿，或先用 page_act 带 checked 手工处理这一步", null, index + 1);
        return finish(RUN_STATUS.FAILED, `第 ${index + 1} 步缺参数：${entry.note}`, hint.next);
      }
      call.checked = step.checked;
    }
    if (action === "upload") {
      const files = Array.isArray(step.files) ? step.files.filter((file) => typeof file === "string" && file.trim()) : [];
      if (!files.length) {
        entry.status = STEP_STATUS.FAILURE;
        // 真实调用日志里 files 只记了形状（「[1 项]」），抽草稿时拿不到文件名：这一步必须由调用方补 files
        entry.note = "草稿里的 upload 步骤没有记文件（调用日志只记了文件数量），回放时给不出 files";
        const hint = stepHint("上传的文件不进日志也不进草稿：先用 page_act 带 files 手工上传这一步，或补一份带 files 的草稿再重放", null, index + 1);
        return finish(RUN_STATUS.FAILED, `第 ${index + 1} 步缺参数：${entry.note}`, hint.next);
      }
      call.files = files;
    }
    if (action === "key") {
      /*
       * 按键必须用草稿里记的：缺了就拒绝发半成品动作（和 dialog / upload 一致）。
       * 以前默认成 Enter，等于把「Tab / Escape / 任意按键」都悄悄换成一次回车 —— 在表单里就是一次提交。
       */
      const pressed = typeof step.key === "string" ? step.key.trim() : "";
      if (!pressed) {
        entry.status = STEP_STATUS.FAILURE;
        entry.note = "草稿里的 key 步骤没有记按的是哪个键，不能默认发一次回车（那可能直接提交表单）";
        const hint = stepHint("重新录草稿，或先用 page_act 带 key 手工处理这一步", null, index + 1);
        return finish(RUN_STATUS.FAILED, `第 ${index + 1} 步缺参数：${entry.note}`, hint.next);
      }
      call.key = pressed;
    }
    if (step.expect) call.expect = step.expect;
    // 确认只对绑定的那一步生效：老 confirm:true 不再自动放行任何步骤
    if (index === confirmedIndex) call.confirm = true;

    let beforeShot = shot;
    try {
      const result = await browser.act(target, call);
      entry.outcome = result?.outcome ?? null;
      entry.expectMet = result?.expectMet ?? null;
      // 动作返回明确失败：立即停下，绝不能继续点后面的步骤，也不能把整轮总结叫「重放完成」
      if (result?.ok === false || result?.outcome === "failed") {
        entry.status = STEP_STATUS.FAILURE;
        entry.note = `动作返回失败（outcome=${result?.outcome ?? "failed"}），没有继续执行后面的步骤`;
        const hint = stepHint("先 page_snapshot 看页面现在什么样，再决定下一步", null, index + 1);
        return finish(RUN_STATUS.FAILED, `第 ${index + 1} 步失败：${entry.note}`, hint.next);
      }
      // 已经执行后，实际命中的元素名和草稿里的不一致（例如「确认」变成「确认删除全部订单」）
      const actedName = String(result?.target ?? result?.clicked?.label ?? "").trim();
      if (isCommitHit(step, actedName) && draftName && actedName && actedName.toLowerCase() !== draftName.toLowerCase()) {
        entry.status = STEP_STATUS.UNCERTAIN;
        entry.note = `动作已发出，但实际命中的是「${actedName}」，不是草稿里的「${draftName}」：先核对结果，不要直接重跑`;
        return finish(
          RUN_STATUS.UNCERTAIN,
          `第 ${index + 1} 步提交目标和实际元素不一致：${entry.note}`,
          "先 page_read / page_snapshot 核对刚才点到了什么、有没有造成后果，再用 fromStep 决定是否继续",
          { uncertainStep: index + 1 },
        );
      }
      const wanted = normalizeExpect(step.expect);
      /*
       * 页面上一开始就是目标状态（勾选 / 选项已经是那个值）：surface-act 返回
       * outcome:"confirmed" + dispatched:false + skipped:"already_in_state" —— 一个事件都没发。
       * 记成「已派发」会让 dispatched 虚增，把后面的提交步骤误拦在「前面有未验证写步骤」上
       * （用户 / agent 去核对一个根本不存在的派发）。这里如实记 SKIPPED，也不计 dispatched。
       */
      const alreadyInState = result?.dispatched === false || result?.skipped === "already_in_state";
      if (alreadyInState) {
        entry.status = STEP_STATUS.SKIPPED;
        entry.note = "已经是目标状态，没有发事件（不计入已派发）";
      } else if (wanted) {
        // 6. 校验：只认「执行前没有、执行后出现」（或 page_act 自己给的 expectMet）
        const afterShot = normalizeSnapshot(await browser.snapshot(target));
        const pageText = action === "type" || action === "click" || action === "key"
          ? normalizeSnapshot(await browser.read(target))
          : "";
        const appeared = expectHit(wanted, { snapshotText: afterShot, pageText });
        const existedBefore = expectHit(wanted, { snapshotText: beforeShot });
        // 输入框自己的 label 这种「执行前就有」的文字不算证据
        const hit = result?.expectMet === true || (appeared === true && existedBefore !== true);
        if (hit) {
          entry.status = STEP_STATUS.SUCCESS;
          entry.note = `读到了期望结果「${wanted}」`;
        } else if (result?.outcome === "failed" || result?.ok === false) {
          entry.status = STEP_STATUS.FAILURE;
          entry.note = `动作没做成，也没读到期望结果「${wanted}」`;
        } else {
          entry.status = STEP_STATUS.UNCERTAIN;
          entry.note = `动作已发出，但没读到期望结果「${wanted}」（${
            existedBefore === true ? "这段文字执行前就已经在页面上，不能当证据" : "执行后没出现"
          }）`;
        }
      } else if (isCommitStep(step)) {
        // 提交类动作没带 expect：只能算「已派发、未验证」，绝不能说成功
        entry.status = STEP_STATUS.DISPATCHED;
        entry.note = `提交类动作已发出，但没有 expect 佐证（outcome=${result?.outcome ?? "无回执"}）：先 page_read 核对结果`;
      } else {
        // 普通写动作也没有 expect：派发了但未验证
        entry.status = STEP_STATUS.DISPATCHED;
        entry.note = entry.value ? `已派发（值 ${entry.value}，未验证）` : `已派发（outcome=${result?.outcome ?? "只读/无回执"}，未验证）`;
      }
      if (mismatchNote && entry.status !== STEP_STATUS.FAILURE) {
        entry.note = entry.note ? `${entry.note}；${mismatchNote}` : mismatchNote;
      }
      if (entry.status === STEP_STATUS.FAILURE) {
        // 兜底：任何走到这里的失败都立即停下，绝不继续后面的步骤
        const hint = stepHint("先 page_snapshot 看页面现在什么样，再决定下一步", null, index + 1);
        return finish(RUN_STATUS.FAILED, `第 ${index + 1} 步失败：${entry.note}`, hint.next);
      }
      if (entry.status === STEP_STATUS.SUCCESS) completed += 1;
      else if (entry.status === STEP_STATUS.DISPATCHED) { completed += 1; dispatched += 1; }
    } catch (error) {
      const code = error?.code ?? "";
      if (code === "NEEDS_CONFIRM") {
        entry.status = STEP_STATUS.FAILURE;
        entry.note = error.message;
        // 提示里只说「确认这一步」，绝不说「带 confirm:true 重跑」（那会重发前面的写动作）
        const name = String(step.target ?? "").trim();
        return finish(
          RUN_STATUS.NEEDS_CONFIRM,
          `第 ${index + 1} 步是提交类动作，执行前就停在 NEEDS_CONFIRM，事件没有发出：${error.message}`,
          `先向用户确认第 ${index + 1} 步「${name}」；确认后用 fromStep: ${index + 1} + confirmStep: ${index + 1} + confirmTarget: "${name}" 续跑（前面的步骤不会重发）`,
          { confirmStep: index + 1, confirmTarget: name },
        );
      }
      /*
       * 动作已经正常返回、之后读回（snapshot / read）才抛错：这一步可能已经生效。
       * 记 UNCERTAIN，提示「先核对，别从头重跑」—— 绝不能让调用方以为它失败了又重发一次。
       */
      const errorOutcome = String(error?.outcome ?? "");
      /*
       * 控制服务超时 / 断连：src/tools/browser.js 的 callControl 抛的是不带 outcome 的普通 Error。
       * 事件可能已经通过 page/act 发出去，只是没等到回包（页面卡住 / 正在跳转 / 服务忙）。
       * surface-act 保证 MUTATING 动作一定会补 outcome，所以「没有 outcome」恰恰只出现在传输层 ——
       * 这时绝不能记 FAILED（调用方看到「重放失败」最自然的反应就是从头再跑一遍：重复下单 / 重复发帖）。
       * 只有明确 outcome:"failed" / dispatched:false 才算「事件没发出去」。
       *
       * 前置失败（控制服务没运行 / 连接被拒，callControl 标的 BROWSER_UNAVAILABLE + dispatched:false）
       * 发生在请求真正发出去之前：事件确定没发出，记 FAILED，并说「先打开控制服务」而不是「可能已发出」。
       */
      const failedClean = errorOutcome === "failed" || error?.dispatched === false;
      const offline = code === "BROWSER_UNAVAILABLE";
      const maybeActed = !failedClean && !offline;
      const offlineNext = stepHint("先打开 Windrise Bridge 界面（浏览器控制服务随它启动），等它能连上后再重放", null, index + 1).next;
      entry.status = maybeActed ? STEP_STATUS.UNCERTAIN : STEP_STATUS.FAILURE;
      entry.note = offline
        ? `${code}：${error.message}（事件没有发出）`
        : failedClean
          ? `${code || "ACT_FAILED"}：${error.message}`
          : `${code || "ACT_FAILED"}：${error.message}（事件可能已经发出、只是没收到回执）`;
      return finish(
        entry.status === STEP_STATUS.UNCERTAIN ? RUN_STATUS.UNCERTAIN : RUN_STATUS.FAILED,
        entry.status === STEP_STATUS.UNCERTAIN ? `第 ${index + 1} 步不确定：${entry.note}` : `第 ${index + 1} 步失败：${entry.note}`,
        offline
          ? offlineNext
          : entry.status === STEP_STATUS.UNCERTAIN
            ? `先 page_snapshot / page_read 核对这一步的结果（DIALOG_OPEN 就先关对话框），确认后再用 fromStep: ${index + 1} 决定是否继续；不要从头重跑`
            : stepHint(error?.next_step ?? "先 page_snapshot 看页面现在什么样，再决定下一步", null, index + 1).next,
        entry.status === STEP_STATUS.UNCERTAIN ? { uncertainStep: index + 1 } : {},
      );
    }

    // 7. 任何一步不确定就停下：后面的步骤依赖它，继续跑只会越跑越乱
    if (entry.status === STEP_STATUS.UNCERTAIN) {
      return finish(
        RUN_STATUS.UNCERTAIN,
        `第 ${index + 1} 步不确定：${entry.note}`,
        `这一步可能已经生效，请先 page_read 核对，再用 fromStep: ${index + 1} 决定是否继续；不要从头重跑`,
        { uncertainStep: index + 1 },
      );
    }

    const wait = Number(step.wait);
    // wait 只在真跑的时候生效（干跑没有动作可等）
    if (Number.isFinite(wait) && wait > 0 && typeof browser.wait === "function") await browser.wait(Math.min(wait, 10_000));
  }

  if (dryRun) {
    if (preview) {
      /*
       * 预演：没有执行任何动作，也不需要浏览器。如实列出计划执行的动作和「不支持」的步骤，
       * 让调用方在打开执行开关前就能判断这份草稿能不能用。
       */
      const planned = results.filter((item) => item.status === STEP_STATUS.PLANNED);
      const unsupported = results
        .filter((item) => item.unsupported === true)
        .map((item) => ({
          index: item.index,
          action: item.action,
          target: item.target,
          reason: item.unsupportedReason ?? item.note ?? "回放没法重走这一步",
        }));
      const message = unsupported.length
        ? `干跑（预演）：没有执行任何动作。共 ${results.length} 步，${planned.length} 步计划执行；${unsupported.length} 步回放不支持（第 ${unsupported.map((item) => item.index).join("、")} 步）。`
        : `干跑（预演）：没有执行任何动作。共 ${results.length} 步，其中 ${planned.length} 步计划执行，没有不支持的步骤。`;
      return finish(
        RUN_STATUS.DRY_RUN,
        message,
        unsupported.length
          ? "不支持的步骤先手工处理，或改用 page_* / browser_* 重新录一份草稿；要真正执行，先在设置里打开「流程回放允许真正执行」（flowReplayExecute），再带 execute:true 调用"
          : "如果预演内容没问题：先在设置里打开「流程回放允许真正执行」（flowReplayExecute），再带 execute:true 调用；这一步不会自动执行",
        { preview: true, unsupported, plannedSteps: planned.map((item) => item.index) },
      );
    }
    const fragile = results.filter((item) => item.fragile);
    return finish(
      RUN_STATUS.DRY_RUN,
      fragile.length
        ? `干跑完成：${completed}/${results.length} 步能定位，其中 ${fragile.length} 步脆弱（改版后可能失效：第 ${fragile.map((item) => item.index).join("、")} 步）`
        : `干跑完成：${completed}/${results.length} 步都能定位`,
      fragile.length ? "脆弱的步骤建议重新录，或给目标补 data-testid / 可访问名" : null,
      { fragile: fragile.map((item) => ({ index: item.index, target: item.target, locator: item.locator, score: item.score })) },
    );
  }
  if (dispatched > 0) {
    // 有派发但没验证的写步骤：绝不能说「重放成功」
    return finish(
      RUN_STATUS.PARTIAL,
      `重放结束：${completed - dispatched} 步已确认、${dispatched} 步已派发未验证（共 ${results.length} 步）`,
      "先 page_read / page_snapshot 核对那几步派发未验证的写动作，确认结果后再继续",
    );
  }
  // 保险：只要有任何失败 / 不确定，绝不返回 SUCCESS
  const bad = results.find((item) => item.status === STEP_STATUS.FAILURE || item.status === STEP_STATUS.UNCERTAIN);
  if (bad) {
    return finish(
      bad.status === STEP_STATUS.FAILURE ? RUN_STATUS.FAILED : RUN_STATUS.UNCERTAIN,
      `重放结束：第 ${bad.index} 步${bad.status === STEP_STATUS.FAILURE ? "失败" : "不确定"}，没有全部读回确认`,
      `先 page_read / page_snapshot 核对第 ${bad.index} 步的结果，再决定下一步`,
    );
  }
  /*
   * 一步都没确认（只读 / 控制类草稿，或唯一的写步骤因选填变量没给值被跳过）：
   * 走不到「每步都读回确认」的 SUCCESS —— 一个动作都没发生、也没读回确认过任何东西。
   * 调用方会把 success 当成「草稿已经跑通」，和 maxSteps ≤ 0 是同一条原则。
   */
  if (completed === 0) {
    return finish(
      RUN_STATUS.NOOP,
      `重放结束：这一轮没有任何动作被确认（共 ${results.length} 步，全部是只读 / 控制步骤或被跳过）。`,
      "先 flow_get_draft 核对步骤；如果是选填变量没给值，补上 vars 里的值再重放",
    );
  }
  return finish(RUN_STATUS.SUCCESS, `重放完成：${completed}/${results.length} 步都读回确认了`, null);
}

/** 草稿里第一条带页面地址的步骤（给 resolveTarget 当线索）。 */
function firstUrl(draft) {
  const steps = Array.isArray(draft?.steps) ? draft.steps : [];
  return steps.find((step) => step?.url_pattern)?.url_pattern ?? null;
}

async function safeResolve(browser, hint) {
  try {
    return await browser.resolveTarget(hint);
  } catch {
    return null;
  }
}

/**
 * 只给了格子 id：空间交给浏览器依赖解析（page/snapshot 的 space 必须是空间 id，传名字会被当成「我的」）。
 * 调用时显式给的格子必须原样保住：依赖解析回来别的格子（或解析不出来）时，就把 space 留空、不瞎换格子。
 */
async function resolveSpaceIfNeeded({ browser, id, site, url }) {
  if (typeof browser.resolveTarget !== "function") return { space: undefined };
  const resolved = await safeResolve(browser, { id, site, url });
  if (resolved?.id && String(resolved.id) !== String(id)) return { space: undefined };
  return { space: resolved?.space ? String(resolved.space) : undefined };
}

/** 目标格子 / 空间解析不出来：拒绝执行，绝不落到人用的「我的」空间（拒绝也要留审计）。 */
function unresolvedTarget(refused, variableSummary, detail = "") {
  return refused(
    `没解析出唯一的格子 / 空间${detail ? `（${detail}）` : ""}：重放不会落到人正在用的「我的」空间。先 browser_open / space_open 打开目标格子，再显式给 grid（和 space）重放。`,
    "先 space_open 打开目标空间（记住它属于哪个格子），再用 flow_replay 时显式给 grid + space",
    { variables: variableSummary },
  );
}

/** 给「当前页面状态」用：把快照里和目标最像的几行挑出来（报错时提示用）。只读，不猜。 */
export function nearbyElements(snapshotText, step, limit = 3) {
  const name = String(step?.target ?? "").trim().toLowerCase();
  if (!name) return [];
  return String(snapshotText ?? "")
    .split(/\r?\n/)
    .map((line) => parseLine(line))
    .filter((item) => item?.ref)
    .filter((item) => {
      const own = String(item.name ?? "").trim().toLowerCase();
      const hint = String(item.hint ?? "").trim().toLowerCase();
      return [own, hint].filter(Boolean).some((text) => text.includes(name));
    })
    .slice(0, limit)
    .map((item) => item.line);
}

/** nearbyElements 内部用：只取名字 / 提示名 / 编号（不在这个文件里重复实现整个解析器）。 */
function parseLine(line) {
  const text = String(line ?? "");
  const match = /^(\s*)- ([^\s"[]+)(?: "((?:[^"\\]|\\.)*)")?/.exec(text);
  if (!match) return null;
  const hint = /\(提示: ([^)]*)\)/.exec(text);
  const ref = /\[ref=(e\d+)\]/.exec(text);
  return {
    role: match[2],
    name: String(match[3] ?? "").replace(/\\(.)/g, "$1"),
    hint: hint?.[1] ?? "",
    ref: ref?.[1] ?? null,
    line: text.trim(),
  };
}

/** 给审计 / 调用方用：把一个步骤的审计摘要拼出来（不含任何值）。 */
export function stepAudit(entry) {
  const action = String(entry?.action ?? "").toLowerCase();
  const write = WRITE_ACTIONS.has(action) || NAV_ACTIONS.has(action);
  return {
    step: entry?.index ?? null,
    action: entry?.action ?? null,
    // 按键要写进审计：事后要能分清「点了一下」和「按了回车提交」，而不是都像一次普通动作
    key: entry?.key ?? null,
    target: entry?.target ?? null,
    status: entry?.status ?? null,
    fragile: entry?.fragile === true,
    ref: entry?.ref ?? null,
    // 审计按真实情况填：只有真正写页面的步骤才算 MUTATING，提交边界用同一套关键词判定
    actionClass: write ? "MUTATING" : "BENIGN",
    commitBoundary: isCommitStep(entry),
  };
}
