/**
 * 账号窗口的语义快照：把搬来的 BrowserOS Observer（src/vendor/browseros）接到 CDP 适配层上。
 *
 * BrowserOS 的 Observer 要两样东西：
 *   - PageManager：getSession(pageId) → { session }，refresh(pageId) → { url }
 *   - FrameRegistry：按 frameId 找到对应的 CDP 会话（跨域 iframe 各有一条）
 * 一个账号窗口就是一个页面，根会话不带 sessionId，所以这两样都很薄。
 *
 *   const snap = await createSurfaceSnapshot(cdp);   // cdp = TargetSurface / CDP 适配层
 *   const { text, url } = await snap.snapshot();     // 「- button "发送" [ref=e3]」这样的文字清单
 *   const diff = await snap.diff();                  // 和上一次相比变了什么
 *   const el = await snap.resolveRef("e3");          // 编号 → 页面里的元素（给 act 用）
 *   snap.dispose();                                  // 不用了就摘掉事件订阅
 *
 * 脱敏只覆盖「语义快照」这一条读路径，下面两条限制要明确：
 *   - 截图不脱敏：browser_screenshot / page_screenshot 截出来的 PNG 里，输入框的可见内容原样保留。
 *   - --allow-eval 打开后，AI 可以直接在页面里执行 JS 读 DOM 的 value，绕过这里的任何打码。
 * 因此这里的脱敏防的是「顺带泄漏」，不防拿到了输入/执行能力的对抗性调用方。
 */

import { Observer } from "../vendor/browseros/core/observer/observer.js";
import { FrameRegistry } from "../vendor/browseros/core/observer/frames.js";
import { fetchAxTree } from "../vendor/browseros/core/observer/ax-tree.js";
import { renderSnapshot } from "../vendor/browseros/core/snapshot/render.js";
import { diffSnapshotObservations } from "../vendor/browseros/core/snapshot/diff.js";
import { buildContentMarkdownExpression } from "../vendor/browseros/content-markdown.js";
import { findCursorHits } from "./snapshot-cursor.js";
import { annotateTemporalValues, scanTemporalInFrame } from "./snapshot-temporal.js";
import { augmentLargeDiff, pruneAxNodes, subtreeAxNodes } from "./snapshot-query.js";
import {
  REDACTED,
  isSensitiveText,
} from "./snapshot-redact.js";

/** viewportOnly 时最多量多少个元素的盒子：再多就把「只看当前屏幕」变成几百条往返。 */
const VIEWPORT_BOX_LIMIT = 400;

/** 这些角色的节点会把 value 渲染进快照（vendor 的 VALUE_ROLES，多带上 textarea）。 */
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "textarea"]);

/** 会承载用户输入的角色：拆分验证码的兄弟框判断只在这些节点里找。 */
const TEXT_ENTRY_ROLES = new Set(["textbox", "searchbox", "spinbutton", "textarea"]);

/** 下拉框：值可能藏在 option 里，选中项还要额外打码。 */
const SELECT_ROLES = new Set(["combobox", "listbox"]);

/** 从 DOM.describeNode 取哪些属性（和页面里 PAGE_HELPERS 用的是同一套）。 */
const DESCRIBE_ATTRIBUTES = ["type", "autocomplete", "name", "id", "aria-label", "placeholder", "title", "maxlength", "inputmode"];

/** 做「按单词命中」的属性（type / autocomplete 各有单独规则，不混进来免得一条规则被另一条兜住）。 */
const SENSITIVE_ATTRIBUTE_KEYS = DESCRIBE_ATTRIBUTES.filter((name) => name !== "type" && name !== "autocomplete");

/** 拉丁词按整词命中：password、pwd、cvc、otp 之类；不再用 pass / ssn / card 这种裸子串。 */
// 词表和判断都挪到 ./snapshot-redact.js：光标扫描合成的提示名要用同一套规则。

/** 验证码提示字样：自己、父节点或兄弟节点的名字命中时，整个字段都按验证码处理。 */
// 裸 code / 码 仍要命中（name=code 这种字段名是真验证码），但排除邮编、促销码、邀请码这些常见非密词。
const CAPTCHA_HINT_RE = /验证码|驗證碼|校验码|校驗碼|动态码|動態碼|短信码|簡訊碼|认证码|認證碼|确认码|確認碼|安全码|安全碼|交易码|交易碼|支付密码|支付密碼|(?<![a-z])(?<!zip |postal |post |promo |coupon |discount |voucher |gift |product |country |area |tracking )code(?![a-z])|passcode|(?<![a-z])pin(?![a-z])|(?<![a-z])(?:2fa|mfa|otp)(?![a-z])|authenticat|verif|one.?time|captcha|인증|コード|código(?! postal)|bestätigung|暗証番号|(?<!号|號|编|編|邀请|邀請|优惠|優惠|兑换|兌換|条形|條形|二维|二維|货|貨)码/i;

/** 可以单独关掉的规则，只给测试用；正式调用不传，默认全开。 */
const ALL_RULES = new Set(["bullet", "password-type", "autocomplete", "attributes", "accessible-name", "value-shape", "split-boxes", "captcha"]);

/**
 * 读页面正文（转成 markdown）。快照只列能操作的元素，正文要靠这个读，例如把 AI 的回答原样拿回来。
 *
 * 脱敏说明：vendor 的 buildContentMarkdownExpression 在页面里遇到 INPUT / SELECT / TEXTAREA / BUTTON
 * 直接返回空串（content-markdown.js 的 FORM 表），只输出文本节点，所以输入框里的值不会进正文。
 * 跨域 iframe 只能拿到 src，也带不出值。这里因此不需要再对正文做改写；测试会实际扫一遍输出。
 *
 * selector 一个都匹配不上时抛 NOT_FOUND：以前静默返回空串，AI 分不清是选择器写错、还是页面还没加载完。
 * @param {{ send: Function }} cdp
 * @param {{ selector?: string, last?: boolean, viewportOnly?: boolean, includeLinks?: boolean }} [options]
 */
export async function readSurfaceContent(cdp, options = {}) {
  if (options.selector) {
    const count = await selectorMatchCount(cdp, options.selector);
    if (count === 0) {
      const page = await pageIdentity(cdp);
      throw Object.assign(
        new Error(`NOT_FOUND：选择器没匹配到任何元素（${options.selector}），页面地址是 ${page.url}、标题是 ${page.title}。可能是页面还没加载完，等一会儿再读；也可能是选择器写错了，先调 page_snapshot 看看实际结构`),
        { code: "NOT_FOUND", selector: options.selector, url: page.url, title: page.title },
      );
    }
    if (options.last) return readLastMatch(cdp, options);
  }
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
    expression: buildContentMarkdownExpression(options),
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(`读页面内容失败：${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  return typeof result?.value === "string" ? result.value : String(result?.value ?? "");
}

/** 选择器在页面里匹配到几个元素（选择器写错也当 0 个，交给上层报 NOT_FOUND）。 */
async function selectorMatchCount(cdp, selector) {
  try {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
      expression: `document.querySelectorAll(${JSON.stringify(selector)}).length`,
      returnByValue: true,
    });
    if (exceptionDetails) return 0;
    return Number(result?.value) || 0;
  } catch {
    return 0;
  }
}

/** 页面地址和标题：NOT_FOUND 的报错里要写清楚「在哪一页上没找到」。 */
async function pageIdentity(cdp) {
  try {
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: "({ url: location.href, title: document.title })",
      returnByValue: true,
    });
    return { url: String(result?.value?.url ?? ""), title: String(result?.value?.title ?? "") };
  } catch {
    return { url: "unknown", title: "unknown" };
  }
}

/** 等页面的最长时长（毫秒）：导航刚发生、DOM 还在长的时候，读之前先等。 */
const READY_TIMEOUT_MS = 5_000;
/** DOM 安静多久算「加载完了」：连续这么多毫秒没有新增 / 删除节点。 */
const DOM_QUIET_MS = 300;

/**
 * 读之前先等页面就绪：document.readyState 为 complete，或者 DOM 连续 300ms 没有变动，最长等 5 秒。
 *
 * 为什么不是只等 readyState：维基这类页面在 complete 之后才异步填内容（正文、语言面板），
 * 只看 complete 会读到半截。反过来只等 DOM 安静，长轮询的页面永远不安静 —— 所以两条取先满足的那条。
 * 超时不算失败：返回 { waitedMs, reason: "timeout" }，照常往下读，让上层的 NOT_FOUND 说清是没找到。
 */
export async function waitForPageReady(cdp, { timeoutMs = READY_TIMEOUT_MS, quietMs = DOM_QUIET_MS } = {}) {
  const started = Date.now();
  const deadline = started + Math.max(0, Number(timeoutMs) || 0);
  const probe = async () => {
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: `(() => ({ readyState: document.readyState, lastAt: window.__windriseQuiet ? window.__windriseQuiet.lastAt : Date.now() }))()`,
      returnByValue: true,
    });
    return result?.value ?? {};
  };
  /** 挂一个「最后一次 DOM 变动」的时间戳（每个文档只挂一次）；页面不让挂就只按 readyState 判。 */
  const installQuietTracker = async () => {
    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        if (window.__windriseQuiet) return true;
        const quiet = { count: 0, lastAt: Date.now() };
        window.__windriseQuiet = quiet;
        try {
          const observer = new MutationObserver(() => { quiet.count += 1; quiet.lastAt = Date.now(); });
          observer.observe(document.documentElement || document, { childList: true, subtree: true, characterData: true });
        } catch (error) { /* 挂不上就只按 readyState 判 */ }
        return true;
      })()`,
      returnByValue: true,
    }).catch(() => {});
  };
  try {
    const first = await probe();
    if (first.readyState === "complete") return { waitedMs: Date.now() - started, reason: "complete" };
  } catch {
    // 页面还在跳转（执行上下文没了）：下面按「还没就绪」继续等
  }
  await installQuietTracker();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    let state;
    try {
      state = await probe();
    } catch {
      continue; // 正在导航：等下一次
    }
    if (state.readyState === "complete") return { waitedMs: Date.now() - started, reason: "complete" };
    if (Number(state.lastAt) && Date.now() - Number(state.lastAt) >= quietMs) {
      return { waitedMs: Date.now() - started, reason: "dom-quiet" };
    }
  }
  return { waitedMs: Date.now() - started, reason: "timeout" };
}

/**
 * 选择器匹配到多个时读最后一个（AI 对话网站的「最新一条回答」）。
 * 借用的 BrowserOS 正文脚本只认 querySelector（第一个），文件又不能改：
 * 先给最后一个匹配临时打一个随机属性，用属性选择器读，读完摘掉。
 */
async function readLastMatch(cdp, options) {
  const mark = `w${Math.random().toString(36).slice(2, 10)}`;
  const tag = await cdp.send("Runtime.evaluate", {
    expression: `(() => { const all = document.querySelectorAll(${JSON.stringify(options.selector)}); const el = all[all.length - 1]; if (!el) return 0; el.setAttribute("data-windrise-read", ${JSON.stringify(mark)}); return all.length; })()`,
    returnByValue: true,
  });
  if (tag.exceptionDetails) throw new Error(`选择器不对：${tag.exceptionDetails.exception?.description ?? tag.exceptionDetails.text}`);
  if (!tag.result?.value) return "";
  try {
    return await readSurfaceContent(cdp, { ...options, last: false, selector: `[data-windrise-read="${mark}"]` });
  } finally {
    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelectorAll('[data-windrise-read="${mark}"]').forEach(el => el.removeAttribute("data-windrise-read"))`,
    }).catch(() => {});
  }
}

const PAGE_ID = 1;

/**
 * 把 CDP 会话包一层：Accessibility 里凡是会返回 AXNode 的方法都先脱敏再交给 vendor。
 * 根会话和每个 iframe 子会话都要包（支付框基本都在跨域 iframe 里）。
 *
 * 默认拒绝：除了明确放行的 enable / disable，凡是没列进来的 Accessibility 方法一律抛错，
 * 免得上游升级后把 resolve / render 挪到 queryAXTree、getChildAXNodes 之类的方法上时悄悄漏值。
 * DOM.getAttributes / DOM.describeNode 也会带出 value 属性，这里一并改写。
 *
 * FrameRegistry 和 Observer 只用到 { Domain.method } 和 { Domain.on }，所以这里返回同形状的代理；
 * describeNode 用传进来的同一个 sessionId 发，保证在 iframe 子会话里也能解析到元素。
 */
function createRedactingSession(cdp, sessionId, options = {}) {
  const session = cdp.session(sessionId);
  // 无障碍读取预算挂在显式传进来的上下文对象上（一次快照一个），不再拿「原始 session 对象」
  // 当 WeakMap 的键：外面拿到的是 Proxy，delete(Proxy) 只会静默空操作，预算就跨快照累积。
  const budgetKey = options.axBudget ?? session;
  const budgetMs = Number(options.axBudgetMs) > 0 ? Number(options.axBudgetMs) : AX_TREE_BUDGET_MS;
  return new Proxy({}, {
    get(_target, domain) {
      if (typeof domain !== "string" || domain === "then") return undefined;
      const source = session[domain];
      if (domain === "DOM") return wrapDomSession(source, session);
      if (domain !== "Accessibility") return source;
      return new Proxy({}, {
        get(_domain, method) {
          if (typeof method !== "string" || method === "then") return undefined;
          const original = source[method];
          if (method === "enable" || method === "disable") return original;
          // 事件里也可能挂 AXNode；nodesUpdated 一律不转给 vendor，其它事件原样放行。
          if (method === "on") {
            return (event, handler) => {
              if (/nodesUpdated/i.test(String(event))) return () => {};
              return original(event, handler);
            };
          }
          if (AX_NODE_METHODS.has(method)) {
            return async (params = {}) => {
              const deadline = axTreeDeadline(budgetKey, budgetMs);
              const read = (call) => withDeadline(call, deadline, method, budgetMs);
              const result = await read(() => original(params));
              // 部分树方法只返回被点名的节点，里面往往没有敏感输入本身，收集不到原始值。
              // 补一次同一 frame 的整树，只借它的原始值；整树本身不交给 vendor。
              let variantNodes = null;
              if (method !== "getFullAXTree") {
                if (typeof source.getFullAXTree !== "function") {
                  throw new Error(`Accessibility.${method} 需要整树脱敏上下文，但这条会话不支持 getFullAXTree`);
                }
                const full = await read(() => source.getFullAXTree({}));
                variantNodes = full?.nodes ?? [];
              }
              await redactAccessibilityResult(cdp, sessionId, result, options, variantNodes);
              return result;
            };
          }
          return async () => {
            throw new Error(`Accessibility.${method} 没有纳入脱敏，拒绝返回原始数据`);
          };
        },
      });
    },
  });
}

/** 会返回 AXNode（或 AXNode 列表）的方法。 */
const AX_NODE_METHODS = new Set([
  "getFullAXTree",
  "getPartialAXTree",
  "queryAXTree",
  "getChildAXNodes",
  "getRootAXNode",
  "getAXNodeAndAncestors",
]);

/**
 * 一次快照 / 一次差异最多给无障碍读取留多久。超过就当场按 CDP_TIMEOUT 失败，
 * 而不是让整条 page_snapshot 挂十几秒（真机：页面里 alert 打断脚本时，下一次读整树会被浏览器吞掉）。
 * 预算挂在一个显式的上下文对象上（一次快照一个），从第一次读取开始算，同一次快照里的多个 frame
 * 共用一个 deadline；拍完（resetAxTreeBudget）就清掉，下一次快照重新计时。
 *
 * 为什么不用 session 对象当键：调用方手里是 createRedactingSession 返回的 Proxy，而这里拿到的
 * 是 cdp.session(...) 的原始对象，两者不是同一个键；delete(pageSession) 全是空操作。
 */
const AX_TREE_BUDGET_MS = 8_000;
const axDeadlines = new WeakMap();

function axTreeDeadline(key, budgetMs = AX_TREE_BUDGET_MS) {
  let deadline = axDeadlines.get(key);
  if (!deadline || deadline <= Date.now()) {
    deadline = Date.now() + budgetMs;
    axDeadlines.set(key, deadline);
  }
  return deadline;
}

/** 清掉一次快照的预算（下一次快照重新计时）。给的是创建 RedactingSession 时的同一个 axBudget 对象。 */
function resetAxTreeBudget(key) {
  axDeadlines.delete(key);
}

/** 给一个可能永远不返回的 CDP Promise 套上 deadline；超时抛和连接层同形状的 CDP_TIMEOUT。 */
function withDeadline(call, deadline, method, budgetMs = AX_TREE_BUDGET_MS) {
  const left = Math.max(0, deadline - Date.now());
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`CDP 命令 ${method} 超过 ${Math.round(budgetMs / 1000)} 秒没有返回`);
      Object.assign(error, { name: "TimeoutError", code: "CDP_TIMEOUT", method, aborted: true });
      reject(error);
    }, left);
  });
  return Promise.race([Promise.resolve().then(call), timeout]).finally(() => clearTimeout(timer));
}

/** 按不同 Accessibility 方法的返回形状找出所有 AXNode，交给同一套规则改写。 */
async function redactAccessibilityResult(cdp, sessionId, result, options, variantNodes = null) {
  if (!result || typeof result !== "object") return;
  const merged = variantNodes ? { ...options, variantNodes } : options;
  if (Array.isArray(result.nodes)) await redactAxNodes(cdp, sessionId, result.nodes, merged);
  const extra = [
    ...(Array.isArray(result.ancestors) ? result.ancestors : []),
    ...(result.node ? [result.node] : []),
  ];
  if (extra.length) await redactAxNodes(cdp, sessionId, extra, merged);
}

/** DOM 返回的属性表里，value 属性可能被上游直接读走；统一换成固定标记。 */
function redactDomAttributeList(list) {
  if (!Array.isArray(list)) return;
  for (let index = 0; index + 1 < list.length; index += 2) {
    if (String(list[index]).toLowerCase() === "value") list[index + 1] = REDACTED;
  }
}

/** DOM.describeNode 可能带 depth，递归把每一层的 value 属性都换掉。 */
function redactDomNode(node) {
  if (!node || typeof node !== "object") return;
  redactDomAttributeList(node.attributes);
  for (const child of node.children ?? []) redactDomNode(child);
  for (const shadow of node.shadowRoots ?? []) redactDomNode(shadow);
  if (node.contentDocument) redactDomNode(node.contentDocument);
}

function wrapDomSession(source, session) {
  return new Proxy({}, {
    get(_domain, method) {
      if (typeof method !== "string" || method === "then") return undefined;
      const original = source[method];
      if (method === "getAttributes") {
        return async (params = {}) => {
          const result = await original(params);
          redactDomAttributeList(result);
          return result;
        };
      }
      if (method === "describeNode") {
        return async (params = {}) => {
          const result = await original(params);
          redactDomNode(result?.node);
          return result;
        };
      }
      // DOM.describeNode 还有一条老路径：传 objectId（按对象取节点）。这时原始结果里没有属性表，
      // 脱敏本来就没东西可抹；而「DOM 域没开」时浏览器会直接拒绝它，把光标扫描整条打掉
      // （真机 2026-10-27：checkbox 的提示名和勾选状态就是这么丢的）。需要节点身份时补开一次 DOM 域。
      if (method === "describeNode") {
        return async (params = {}) => {
          try {
            const result = await original(params);
            redactDomNode(result?.node);
            return result;
          } catch (error) {
            if (!session?.DOM?.enable || !/DOM agent hasn't been enabled|DOM domain is not enabled/i.test(String(error?.message ?? ""))) throw error;
            await session.DOM.enable().catch(() => {});
            const result = await original(params);
            redactDomNode(result?.node);
            return result;
          }
        };
      }
      return original;
    },
  });
}

/**
 * 快照内部扫描用的窄会话：只放 Runtime / Page / DOM，Accessibility 一律不转发。
 *
 * 光标扫描和时间框取值都只需要「跑一段只读脚本 + 按对象取节点」，不需要无障碍树；
 * 它们返回的是 objectId / backendNodeId，不是页面文本。给它们走脱敏代理会让 Accessiblity.getFullAXTree
 * 每次都再读一遍整树（慢、而且脱敏层里那条「读整树」的路径本来就不该被内部扫描借用）。
 * 如果以后有个扫描真要读无障碍树，必须显式加上，不能默认放行。
 */
function scanSessionOf(cdp, sessionId) {
  const session = cdp.session(sessionId);
  const allowed = new Set(["Runtime", "Page", "DOM", "Target"]);
  return new Proxy({}, {
    get(_target, domain) {
      if (typeof domain !== "string" || domain === "then") return undefined;
      if (!allowed.has(domain)) return undefined;
      return session[domain];
    },
  });
}

/** 传播用：取属性里的字符串值。 */
function stringValue(value) {
  if (typeof value === "string") return value;
  return typeof value?.value === "string" ? value.value : "";
}

/** 一个节点下面所有 option（下拉框收起时也还在 AX 树里）。 */
function optionsUnder(node, byId) {
  const out = [];
  const seen = new Set();
  const stack = [...(node.childIds ?? [])];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const child = byId.get(id);
    if (!child) continue;
    if (child.role?.value === "option") out.push(child);
    stack.push(...(child.childIds ?? []));
  }
  return out;
}

function isSelectedOption(node) {
  return (node.properties ?? []).some((prop) => prop.name === "selected" && prop.value?.value === true);
}

/**
 * 分析一棵 AX 树：分类敏感字段、套拆分框规则、收集要被抹掉的原始值。
 * 只读不改，部分树方法可以把整树的分析结果当作「原始值来源」，只把规则套在返回的少量节点上。
 */
async function analyzeAxNodes(cdp, sessionId, nodes, options = {}) {
  const disabled = new Set(options.disabledRules ?? []);
  const ruleOn = (rule) => !disabled.has(rule);
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const parentOf = new Map();
  for (const node of nodes) {
    for (const childId of node.childIds ?? []) parentOf.set(childId, node.nodeId);
  }

  const session = cdp.session(sessionId);
  const attrsCache = new Map();
  const describe = (backendNodeId) => {
    if (!attrsCache.has(backendNodeId)) {
      attrsCache.set(backendNodeId, session.DOM.describeNode({ backendNodeId }).then((result) => parseAttributes(result?.node)));
    }
    return attrsCache.get(backendNodeId);
  };

  const entries = [];
  const candidates = nodes.filter((node) => node && !node.ignored && (
    VALUE_ROLES.has(node.role?.value) || SELECT_ROLES.has(node.role?.value)
  ));
  await Promise.all(candidates.map(async (node) => {
    const role = node.role?.value;
    const rawValue = stringValue(node.value);
    const options = SELECT_ROLES.has(role) ? optionsUnder(node, byId) : [];
    const selectedOptions = options.filter(isSelectedOption);
    const selectedNames = selectedOptions.map((option) => stringValue(option.name)).filter(Boolean);
    const value = rawValue || selectedNames.join(" ");

    let attrs = {};
    let describeFailed = false;
    const backendNodeId = node.backendDOMNodeId;
    if (backendNodeId === undefined) {
      describeFailed = true;
    } else {
      try {
        attrs = await describe(backendNodeId);
      } catch {
        describeFailed = true;
      }
    }

    const maxLength = Number.parseInt(attrs.maxlength ?? "", 10);
    const inputmode = String(attrs.inputmode ?? "").toLowerCase();
    const entry = {
      node,
      role,
      value,
      attrs,
      options,
      selectedOptions,
      maxLength,
      inputmode,
      describeFailed,
      sensitive: describeFailed,
      baseSensitive: false,
    };
    if (!describeFailed) {
      entry.sensitive = isSensitiveValue(value, attrs, node, { byId, parentOf, ruleOn });
    }
    entry.baseSensitive = entry.sensitive;
    entries.push(entry);
  }));

  // 拆分验证码：同一个父节点下 3 个以上短框，或者短框里已经有一个判为敏感，整组一起打码。
  if (ruleOn("split-boxes")) {
    const entriesById = new Map(entries.map((entry) => [entry.node.nodeId, entry]));
    for (const entry of entries) {
      if (!TEXT_ENTRY_ROLES.has(entry.role)) continue;
      if (!(entry.maxLength > 0 && entry.maxLength <= 2)) continue;
      const parentId = parentOf.get(entry.node.nodeId);
      const siblingEntries = (byId.get(parentId)?.childIds ?? [])
        .filter((childId) => childId !== entry.node.nodeId)
        .map((childId) => entriesById.get(childId))
        .filter((sibling) => sibling && TEXT_ENTRY_ROLES.has(sibling.role));
      const shortSiblings = siblingEntries.filter((sibling) => sibling.maxLength > 0 && sibling.maxLength <= 2);
      if (shortSiblings.length >= 2 || shortSiblings.some((sibling) => sibling.baseSensitive)) entry.sensitive = true;
    }
  }

  // 收集所有敏感原始值（含去掉空格 / 连字符、压缩连续空白的版本），再在可见字符串里统一替换。
  const variants = new Set();
  const addVariant = (raw) => {
    const text = String(raw ?? "");
    if (!text) return;
    variants.add(text);
    variants.add(text.trim());
    variants.add(text.replace(/\s+/g, ""));
    variants.add(text.replace(/[\s-]/g, ""));
    // Chrome 从内容拼名字时会把连续空白 / 换行压成一个空格，双空格卡号和 textarea 多行都要能对上。
    variants.add(text.replace(/\s+/g, " ").trim());
  };
  for (const entry of entries) {
    if (!entry.sensitive) continue;
    const picked = entry.selectedOptions.map((option) => stringValue(option.name)).filter(Boolean);
    // 下拉框的值本来就写在 option 里，不进全文替换：否则同名标签（身份证号）会被打码，
    // 从剩下的选项也能反推出选中项。改由下面只在下拉框的祖先名字里单独抹掉。
    const fromOptions = SELECT_ROLES.has(entry.role) && entry.options.length > 0
      && (picked.includes(entry.value) || entry.value === picked.join(" "));
    if (!fromOptions) addVariant(entry.value);
    // title 和 value 相同的框：还没填值时 value 是空的，但 title 已经把这个秘密写在名字里了。
    // 只收「title 就是无障碍名字且带数字」的，避免把 Password 这类普通标签也整段抹掉。
    const accessibleName = stringValue(entry.node.name);
    const title = String(entry.attrs.title ?? "");
    if (accessibleName && accessibleName === title && /\d/.test(title)) addVariant(title);
  }
  return { byId, parentOf, entries, variants };
}

/** 按规则改写一棵 AX 树（variantNodes 给出时只用它收集原始值，改写仍只落在 nodes 上）。 */
async function redactAxNodes(cdp, sessionId, nodes, options = {}) {
  const variantNodes = Array.isArray(options.variantNodes) && options.variantNodes.length ? options.variantNodes : null;
  const context = await analyzeAxNodes(cdp, sessionId, variantNodes ?? nodes, options);
  const target = variantNodes ? await analyzeAxNodes(cdp, sessionId, nodes, options) : context;

  const variants = new Set([...context.variants, ...target.variants]);
  const orderedVariants = [...variants].filter(Boolean).sort((a, b) => b.length - a.length);

  const replaceText = (text) => {
    if (typeof text !== "string" || !text) return text;
    let out = text;
    for (const variant of orderedVariants) {
      // 1-2 位的值（验证码单个数字、有效期 "08"）在普通名字里到处都能碰到，
      // 不做全文替换；下拉框的选中项和拆分框的外层名字在下面单独按节点打码。
      if (variant.length < 3) continue;
      if (out.includes(variant)) {
        out = out.split(variant).join(REDACTED);
        continue;
      }
      const collapsed = out.replace(/\s+/g, " ");
      if (collapsed.includes(variant)) out = collapsed.split(variant).join(REDACTED);
    }
    // 密码的圆点个数本身就是长度信息，连续 2 个以上一律换掉。
    return out.replace(/[\u2022\u25CF\u25E6\u26AB]{2,}/g, REDACTED);
  };

  for (const node of nodes) {
    if (node?.name && typeof node.name.value === "string") {
      node.name = { ...node.name, value: replaceText(node.name.value) };
    }
    if (node?.description && typeof node.description.value === "string") {
      node.description = { ...node.description, value: replaceText(node.description.value) };
    }
    if (Array.isArray(node?.properties)) {
      node.properties = node.properties.map((prop) => {
        if (prop?.value && typeof prop.value.value === "string") {
          return { ...prop, value: { ...prop.value, value: replaceText(prop.value.value) } };
        }
        return prop;
      });
    }
  }

  // 1-2 位的敏感值不做全文替换，但 Chromium 会把它拼进外层格子 / 按钮 / 行的名字，
  // 以及同一个 <label> 里第一个框的名字：只在这些地方按整词打码。
  const entryById = new Map(target.entries.map((e) => [e.node.nodeId, e]));
  const scrub = (node, patterns) => {
    for (const key of ["name", "description"]) {
      const v = node?.[key]?.value;
      if (typeof v !== "string" || !v) continue;
      const next = patterns.reduce((s, re) => s.replace(re, REDACTED), v);
      if (next !== v) node[key] = { ...node[key], value: next };
    }
  };
  for (const entry of target.entries) {
    if (!entry.sensitive) continue;
    const patterns = [...new Set([entry.value, ...entry.selectedOptions.map((o) => stringValue(o.name))]
      .map((s) => String(s ?? "").trim()).filter((s) => s && s.length < 3))]
      .map((s) => new RegExp(String.raw`(?<![\p{L}\p{N}])` + s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + String.raw`(?![\p{L}\p{N}])`, "gu"));
    if (!patterns.length) continue;
    for (let id = target.parentOf.get(entry.node.nodeId), depth = 0; id !== undefined && depth < 8; id = target.parentOf.get(id), depth += 1) {
      const ancestor = target.byId.get(id);
      if (!ancestor || ancestor.role?.value === "RootWebArea" || ancestor.role?.value === "WebArea") break;
      scrub(ancestor, patterns);
      if (ancestor.role?.value !== "LabelText") continue;
      const stack = [...(ancestor.childIds ?? [])];
      while (stack.length) {
        const d = target.byId.get(stack.pop());
        if (!d) continue;
        stack.push(...(d.childIds ?? []));
        if (d === entry.node || !VALUE_ROLES.has(d.role?.value)) continue;
        const aria = entryById.get(d.nodeId)?.attrs["aria-label"];
        if (aria && aria === stringValue(d.name)) continue; // name came from aria-label, has no embedded values
        scrub(d, patterns);
      }
    }
  }

  for (const entry of target.entries) {
    if (!entry.sensitive) continue;
    if (VALUE_ROLES.has(entry.role) && entry.value) {
      const original = typeof entry.node.value === "object" && entry.node.value ? entry.node.value : {};
      entry.node.value = { ...original, value: REDACTED };
    }
    // 敏感下拉框：选项名照常保留（只去掉 [selected]，否则靠排除法就能猜出选中的是哪一项），
    // 选中的文字只在它自己的祖先名字里抹掉（「Exp 08」这种格子），别动页面其它地方的同名标签。
    if (SELECT_ROLES.has(entry.role)) {
      for (const option of entry.options) {
        option.properties = (option.properties ?? []).filter((prop) => prop.name !== "selected");
      }
      const hide = [...new Set([entry.value, ...entry.selectedOptions.map((o) => stringValue(o.name))].filter(Boolean))]
        .sort((a, b) => b.length - a.length);
      for (let id = target.parentOf.get(entry.node.nodeId), depth = 0; id !== undefined && depth < 64; id = target.parentOf.get(id), depth += 1) {
        const ancestor = target.byId.get(id);
        if (typeof ancestor?.name?.value !== "string") continue;
        let v = ancestor.name.value;
        for (const h of hide) v = v.split(h).join(REDACTED);
        ancestor.name = { ...ancestor.name, value: v };
      }
    }
  }
}

/** DOM.describeNode 的 attributes 是 [名, 值, 名, 值…]，这里转成小写键的普通对象。 */
function parseAttributes(node) {
  if (!node) throw new Error("DOM.describeNode 没返回节点");
  const attrs = {};
  const flat = Array.isArray(node.attributes) ? node.attributes : [];
  for (let index = 0; index + 1 < flat.length; index += 2) {
    attrs[String(flat[index]).toLowerCase()] = String(flat[index + 1]);
  }
  return attrs;
}

/** 拉丁词按驼峰 / 下划线 / 横线 / 空格 / 点切成单词，再整词匹配（实现在 ./snapshot-redact.js）。 */

/** 这个输入值是否属于敏感信息（属性命中、值像卡号 / 身份证、拆分验证码、或验证码提示词旁边）。 */
function isSensitiveValue(value, attrs, node, { byId, parentOf, ruleOn }) {
  const text = String(value ?? "");

  // 已是圆点的密码框：不管属性能不能拿到，都不能把圆点个数放出去
  if (ruleOn("bullet") && /^[\u2022\u25CF\u25E6\u26AB]+$/.test(text.trim())) return true;

  const type = String(attrs.type ?? "").toLowerCase();
  if (ruleOn("password-type") && type === "password") return true;

  const autocomplete = String(attrs.autocomplete ?? "").toLowerCase();
  if (ruleOn("autocomplete") && (autocomplete.includes("password") || autocomplete.includes("one-time-code") || autocomplete.includes("cc-"))) return true;

  const attributeText = SENSITIVE_ATTRIBUTE_KEYS.map((name) => attrs[name] ?? "").join(" ");
  if (ruleOn("attributes") && isSensitiveText(attributeText)) return true;

  // 无障碍名字就是 <label> / aria-labelledby / title 算出来的文字；description 只是补充说明，
  // 里面有 password 字样不代表这个框就是密码框（Username 就是被这条误伤的）。
  const accessibleText = node.name?.value ?? "";
  if (ruleOn("accessible-name") && isSensitiveText(accessibleText)) return true;

  const maxLength = Number.parseInt(attrs.maxlength ?? "", 10);
  const shortValue = /^\d{1,2}$/.test(text.trim());
  // inputmode=numeric 太常见（数量、邮编都写它），只认 maxlength 很短的拆分框；整组规则在上面兜底。
  if (ruleOn("split-boxes") && shortValue && maxLength > 0 && maxLength <= 2) return true;

  if (ruleOn("value-shape") && (looksLikeLongDigits(text) || looksLikeChineseId(text))) return true;
  // 验证码提示只对「像验证码的值」生效：手机号、带空格的文字、城市名都不该因为旁边有「验证码」三个字就被藏。
  // 验证码提示只对「像验证码的值」生效：手机号、带空格的文字、城市名都不该因为旁边有「验证码」三个字就被藏。
  if (ruleOn("captcha") && /^[A-Za-z0-9]{1,8}$/.test(text.replace(/[\s-]/g, "")) && captchaNearby(node, attrs, byId, parentOf)) return true;
  return false;
}

/** 去掉空格和连字符后有 12 位以上纯数字：不再等 Luhn，半截卡号也要挡住。 */
function looksLikeLongDigits(value) {
  return /^\d{12,}$/.test(String(value ?? "").replace(/[\s-]/g, ""));
}

/** 身份证：15 位老号，或 18 位（最后一位可以是 X）。 */
function looksLikeChineseId(value) {
  return /^(?:\d{15}|\d{17}[\dXx])$/.test(String(value ?? "").replace(/[\s-]/g, ""));
}

/** 验证码提示词是否在自己、父节点或兄弟节点的名字里。 */
function captchaNearby(node, attrs, byId, parentOf) {
  const own = [
    attrs.name, attrs.id, attrs["aria-label"], attrs.placeholder, attrs.title,
    node.name?.value, node.description?.value,
  ].filter(Boolean).join(" ");
  if (CAPTCHA_HINT_RE.test(own)) return true;

  const parent = byId.get(parentOf.get(node.nodeId));
  if (!parent) return false;
  if (CAPTCHA_HINT_RE.test([parent.name?.value, parent.description?.value].filter(Boolean).join(" "))) return true;

  // 只看紧挨着的前后两个兄弟：表单是平的，整层兄弟里总会有「验证码」标签，
  // 全扫会把普通城市 / 姓名框一起误伤。拆分验证码靠上面的整组规则兜底。
  const childIds = parent.childIds ?? [];
  const index = childIds.indexOf(node.nodeId);
  const neighbors = [childIds[index - 1], childIds[index + 1]]
    .filter((childId) => childId !== undefined)
    .map((childId) => byId.get(childId))
    .filter(Boolean)
    .map((sibling) => [sibling.name?.value, sibling.description?.value].filter(Boolean).join(" "))
    .join(" ");
  return CAPTCHA_HINT_RE.test(neighbors);
}

/**
 * @param {{ api: object, session: (id?: string) => object, send: Function }} cdp  TargetSurface 实例
 * @param {{ getUrl?: () => string }} [options]
 */
export async function createSurfaceSnapshot(cdp, { getUrl } = {}) {
  const rootSessionId = "";
  // 无障碍读取预算的键：一次快照（含 diff / scoped）共用一个，拍完显式 reset。
  // 用对象而不是 session Proxy，保证 delete 能删到同一个键。
  const axBudget = {};
  const pageSession = createRedactingSession(cdp, rootSessionId, { axBudget });
  // 快照内部扫描（光标命中、时间框的值）只读 Document / 元素值，不碰无障碍树，也不返回页面文本。
  // 给它们开一个「只有 Runtime / Page / DOM」的窄会话：Accessibility 一律不转发 —— 否则会在脱敏层之外
  // 拿到整棵树（含输入值），而且脱敏代理也拦不到它们。
  const scanSession = scanSessionOf(cdp, rootSessionId);

  // FrameRegistry 在构造时订阅 Target.attachedToTarget，所以要在打开自动挂接之前建好。
  // 它自己不留取消订阅的句柄，这里替它收着，dispose() 时一起摘掉，避免同一个格子反复建快照时监听越积越多
  const unsubscribe = [];
  const connection = {
    Target: { on: (event, handler) => { const off = cdp.api.Target.on(event, handler); unsubscribe.push(off); return off; } },
    // 跨域 iframe 会话也走同一层脱敏，describeNode 用的就是这条子会话
    session: (id) => createRedactingSession(cdp, id, { axBudget }),
  };
  const frames = new FrameRegistry(connection);

  await Promise.all([
    pageSession.Page.enable().catch(() => {}),
    pageSession.DOM.enable().catch(() => {}),
    pageSession.Accessibility.enable().catch(() => {}),
  ]);
  await frames.registerPage(pageSession, PAGE_ID, rootSessionId);

  const pages = {
    getSession: async () => ({ session: pageSession }),
    refresh: async () => ({ url: getUrl?.() ?? "unknown" }),
  };
  const observer = new Observer(pages, frames, PAGE_ID);
  observer.dispose = () => { for (const off of unsubscribe.splice(0)) off(); };
  // vendor 的光标扫描默认用页面会话；换成窄会话（只放 Runtime / Page / DOM），不让扫描借道无障碍脱敏层
  observer.scanSessionFor = () => scanSessionOf(cdp, rootSessionId);
  /** 快照渲染完后，把扫描会话挂在结果上：后面的「时间值」一步要用同一条会话解析元素。 */
  const withScanSession = (rendered, session) => ({ ...rendered, scanSession: session });
  const vendorSnapshot = observer.snapshot.bind(observer);
  /**
   * 整页快照：vendor 流程 + 时间 / 日期值（编号表沿用 vendor 那份，不动 ref）。
   *
   * 光标提示名不再在这里补第二遍：vendor 的 capture 已经跑过一次整页扫描，命中的
   * backendNodeId 也已经在 collect 时解析好并交给 render 了。以前 withHints 又扫一遍整页，
   * 一次快照等于两次全页 Runtime.evaluate（长页面 / 多 iframe 明显变慢）。
   */
  observer.snapshot = async () => {
    resetAxTreeBudget(axBudget);
    let captured;
    try {
      captured = withScanSession(await withTemporalValues(await vendorSnapshot(), scanSession), scanSession);
    } finally {
      resetAxTreeBudget(axBudget);
    }
    // vendor 的 commit 发生在补标之前：基线要换成补过值的那份，diff 才看得见变化
    observer.commit(captured);
    return captured;
  };
  /**
   * 时间 / 日期框的值：无障碍树里只有「小时 / 分钟」两个 spinbutton，值本身要靠 DOM property 读。
   * 在整树渲染之后补标到对应的行上（宿主行写 [value=…]，宿主不在树里就补一行 time-value），
   * 同时把标记写进基线 —— diff 才会把「12:30 → 07:05」算成页面变了。
   *
   * session：跑扫描用的会话（快照层给的是窄会话，只放 Runtime / Page / DOM）。
   * 拿不到就是空表：纯 Node 的假会话里没有对象 ID 语义，读不到就原样返回。
   */
  const withTemporalValues = async (rendered, session, { frameId } = {}) => {
    const scan = await scanTemporalInFrame(session, { frameId }).catch(() => null);
    if (!scan) return rendered;
    const values = await scan.collect(rendered?.scanSession ?? session).catch(() => new Map());
    if (!values?.size) return rendered;
    return { ...rendered, text: annotateTemporalValues(rendered.text, rendered.refs, values, { documentId: rendered.documentId }) };
  };
  /**
   * 差异：长页面上 vendor 的逐行 diff 会因为超出 LCS 预算而跳过，只回「多少行变了」——那等于什么都没给。
   * 这种情况换成「新出现 / 消失的可操作元素」（各最多 40 条，带编号），AI 拿得到 ref 才能接着做事。
   */
  observer.diff = async () => {
    const before = observer.baseline;
    resetAxTreeBudget(axBudget);
    let result;
    try {
      result = await observer.capture();
      result = await withTemporalValues(result, scanSession);
    } finally {
      resetAxTreeBudget(axBudget);
    }
    observer.commit(result);
    // 长页面上 vendor 会跳过逐行 diff（只回「多少行变了」），这里换成可操作元素清单
    return augmentLargeDiff(diffSnapshotObservations(before, result), before?.text ?? "", result.text, { limit: 40 });
  };
  /**
   * 带范围的快照：只拍某个 CSS 选择器的子树，或者只留当前屏幕里看得见的元素。
   *
   * 不复用 observer.snapshot()：它按整棵树渲染，没有「只渲染一部分」的入口。
   * 这里自己做一遍（取树 → 按需裁剪 → 渲染），编号照旧交给同一份 RefMap，
   * 所以 page_act 拿到的编号和普通快照完全通用。
   *
   * 找不到选择器时抛 NOT_FOUND：空清单会让 AI 以为「页面上没有这个元素」，而真相是选择器写错了。
   */
  observer.scopedSnapshot = async ({ selector, viewportOnly = false } = {}) => {
    const before = await observer.readMainFrameState(pageSession);
    const refs = observer.refsForCapture(before);
    resetAxTreeBudget(axBudget);
    try {
      return await scopedSnapshotWith(observer, pageSession, before, refs, { selector, viewportOnly, withTemporalValues, scanSession });
    } finally {
      resetAxTreeBudget(axBudget);
    }
  };
  return observer;
}

/** scopedSnapshot 的实体：取树 → 按需裁剪 → 渲染 → 提交基线。 */
async function scopedSnapshotWith(observer, pageSession, before, refs, { selector, viewportOnly, withTemporalValues, scanSession = pageSession }) {
  const nodes = await fetchAxTree(pageSession, {});
  let scoped = nodes;
  if (selector) {
    const backendNodeId = await backendNodeIdForSelector(pageSession, selector);
    if (backendNodeId === undefined) {
      throw codedError("NOT_FOUND", `选择器没匹配到任何元素：${selector}`);
    }
    scoped = subtreeAxNodes(nodes, backendNodeId);
    if (!scoped.length) throw codedError("NOT_FOUND", `选择器 ${selector} 命中的元素不在无障碍树里（可能是隐藏的）`);
  }
  if (viewportOnly) {
    scoped = pruneAxNodes(scoped, await visibleBackendNodeIds(pageSession, scoped));
  }
  const cursorHits = await findCursorHits(pageSession, { keepSemantic: true }).catch(() => new Map());
  const rendered = renderSnapshot(scoped, {
    refs,
    documentId: before.documentId,
    cursorHits,
  });
  // 和整页快照同一条管线：时间 / 日期值（用渲染时的同一份 refs，编号不动）。
  // 光标提示名已经在 render 时由 findCursorHits 的命中写好了，不再重复整页扫描。
  const withTemporal = await withTemporalValues({ ...rendered, documentId: before.documentId }, scanSession).catch(() => rendered);
  const text = withTemporal.text;
  observer.commit({ text, refs, url: before.url, scope: refScopeOf(before) });
  return { text, url: before.url };
}

/** 和一个选择器匹配到的第一个元素对应的 backendNodeId；找不到 / 选择器写错都返回 undefined。 */
async function backendNodeIdForSelector(session, selector) {
  let objectId;
  try {
    const evaluated = await session.Runtime.evaluate({
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      returnByValue: false,
    });
    objectId = evaluated?.result?.objectId;
  } catch {
    return undefined;
  }
  if (!objectId) return undefined;
  try {
    const described = await session.DOM.describeNode({ objectId });
    return described?.node?.backendNodeId;
  } catch {
    return undefined;
  } finally {
    await session.Runtime.releaseObject({ objectId }).catch(() => {});
  }
}

/**
 * 这些节点里有几个落在当前视口里：逐个量盒子（并发，最多 VIEWPORT_BOX_LIMIT 个）。
 * 量不到盒子的（被忽略的装饰层、已脱离文档的）一律不算可见。
 */
async function visibleBackendNodeIds(session, nodes) {
  const ids = nodes
    .map((node) => node.backendDOMNodeId)
    .filter((id) => id !== undefined)
    .slice(0, VIEWPORT_BOX_LIMIT);
  const visible = new Set();
  await Promise.all(ids.map(async (backendNodeId) => {
    try {
      const box = await session.DOM.getBoxModel({ backendNodeId });
      const quad = box?.model?.border;
      if (!quad || quad.length < 8) return;
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      const ys = [quad[1], quad[3], quad[5], quad[7]];
      const left = Math.min(...xs);
      const right = Math.max(...xs);
      const top = Math.min(...ys);
      const bottom = Math.max(...ys);
      const viewport = await viewportSize(session);
      // 有交集就算看得见：露出一半的元素也是「当前屏幕里的」
      if (right > 0 && bottom > 0 && left < viewport.width && top < viewport.height) visible.add(backendNodeId);
    } catch { /* 量不到就不算可见 */ }
  }));
  return visible;
}

/** 视口尺寸：量一次就够，量不到按 0 处理（那就一个都看不见，只剩根节点）。 */
async function viewportSize(session) {
  try {
    const result = await session.Runtime.evaluate({
      expression: "({ width: window.innerWidth, height: window.innerHeight })",
      returnByValue: true,
    });
    const value = result?.result?.value ?? {};
    return { width: Number(value.width) || 0, height: Number(value.height) || 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

/** 和 observer 内部的 refScopeFrom 一致：文档身份 + 网址，决定旧编号要不要作废。 */
function refScopeOf(state) {
  if (state.documentId === undefined) return undefined;
  return { documentId: state.documentId, url: state.url };
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** 只给测试用：直接拿脱敏层和规则开关，正式代码不要依赖这些内部实现。 */
export const __testing = {
  REDACTED,
  ALL_RULES,
  createRedactingSession,
  resetAxTreeBudget,
  redactAxNodes,
  isSensitiveValue,
};
