/**
 * 按编号动作：把搬来的 Ego Lite 输入层（src/vendor/ego-lite）接到格子的 CDP 适配层和语义快照上。
 *
 *   const snap = await createSurfaceSnapshot(cdp);     // cdp = TargetSurface / CDP 适配层
 *   const actor = createSurfaceAct(cdp, snap);
 *   await actor.act({ ref: "e3", action: "click" });
 *   await actor.act({ ref: "e2", action: "type", text: "你好" });
 *
 * 全程走 CDP 的 Input.*，不动系统光标、不切前台（Ego 原版里切前台的代码没有搬）。
 * Ego 点之前会等元素停稳（两帧不动），后台格子里 requestAnimationFrame 不跑，所以先开焦点模拟（规划 5.2）。
 * 编号只认最近一次快照发的；跨域 iframe 里的元素按 FrameRegistry 记下的会话去点。
 *
 * 失败一律抛带 code 的错误：
 *   REF_STALE（编号过期，重拍快照）、NOT_ACTIONABLE（被盖住、看不见、不可用）、
 *   CONTROL_PREEMPTED（人接管了这个格子）、INVALID_ARGUMENT（参数不对）、ACT_FAILED（其它）。
 *
 * 写操作闸门（action-policy.js）：
 *   - 事件发出前失败 → outcome:"failed"，可以走「重拍快照再试一次」；
 *   - 事件已发出（Input.*）之后才出错 → outcome:"unknown"，禁止任何自动重试；
 *   - 带 expect 且读到了 → "confirmed"；没带 expect 最多 "dispatched"；
 *   - 提交边界只拦点击类动作（click / double_click / key+Enter）：目标名命中发布 / 付款 / 删除…
 *     且没带 confirm:true 时直接 NEEDS_CONFIRM，不发事件；type / select / check / focus / hover 不套；
 *   - checkbox / radio / switch / select 已经是目标状态就不发事件。
 */

import {
  clickInPage,
  fillInPage,
  focusInPage,
  hoverInPage,
  selectOptionInPage,
  wheelInPage,
} from "../vendor/ego-lite/driver/page-actions.js";
import { pressKeyInPage } from "../vendor/ego-lite/driver/keyboard.js";
import { ElementResolutionError } from "../vendor/ego-lite/ego-shims.js";
import {
  ACTION_CLASSES,
  DEFAULT_COMMIT_EXCLUDES,
  DEFAULT_COMMIT_KEYWORDS,
  OUTCOMES,
  OUTCOME_NEXT_STEP,
  alreadyInState,
  classifyAction,
  confirmRequired,
  decideOutcome,
  expectProbeExpression,
  matchCommitKeyword,
  needsCommitGate,
  normalizeExpect,
} from "./action-policy.js";
import { classifyFillTarget, optionNotFoundError, parseCheckedValue } from "./page-fill.js";

const ROOT = "";
const ACTIONS = new Set(["click", "double_click", "type", "select", "check", "hover", "focus", "key", "scroll", "dialog"]);
const NEEDS_REF = new Set(["click", "double_click", "type", "select", "check", "hover", "focus"]);
/** CDP Input 的修饰键位：Alt=1、Ctrl=2、Meta=4、Shift=8 */
const MODIFIER_BITS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 };

/** 「这个编号指向的 DOM 节点没了」的几种说法：框架重新渲染（React / Vue）后最常见的失败。 */
const STALE_MESSAGE = /element is not connected|not connected|stale ref|node is detached|no node with given id|已不在|已经不在了|过期/i;

/**
 * 批量填表前的页面探针：只读标签 / type / 显式 role / 是否可编辑，不做任何动作。
 * 页面里的脚本故意保持最小，避免每次填字段都额外算一遍布局。
 */
const FILL_PROBE_SOURCE = `function probeFillTargetForAction() {
  const tag = String(this.tagName || "").toLowerCase();
  return {
    tag,
    type: tag === "input" ? String(this.type || "").toLowerCase() : "",
    role: String(this.getAttribute ? this.getAttribute("role") || "" : "").trim(),
    contentEditable: this.isContentEditable === true,
    disabled: Boolean(this.disabled) || String(this.getAttribute ? this.getAttribute("aria-disabled") || "" : "") === "true",
  };
}`;

/**
 * 自定义下拉（role=combobox / listbox）点开后：在「这个下拉自己的弹层」里找看得见的
 * role=option，只认完全相等（忽略大小写也算完全相等），不再用「包含」瞎猜。
 *   - 弹层范围：aria-controls / aria-owns 指向的元素；没有就找最近的 role=listbox；
 *     再没有才退回最近几层父容器里的 listbox（找出的选项仍带范围信息）。
 *   - 遮挡：算好坐标后用 elementFromPoint 确认命中的就是这个 option（含子元素 / shadow DOM），
 *     被吸底按钮之类盖住就返回 occluded，调用方不许发鼠标事件；坐标落在视口外返回 outOfView，
 *     单独报「先滚动列表」，不要误报成被别的元素挡住。
 *   - 找不到时把看到的选项和「包含」候选一起带回去，让 AI 换个值重试。
 * 会递归进 shadowRoot —— 组件库的弹层经常挂在别处。
 */
const COMBO_OPTIONS_SOURCE = `function comboOptionsForAction(wanted) {
  const doc = this.ownerDocument || document;
  const norm = (value) => String(value == null ? "" : value).replace(/\\s+/g, " ").trim();
  const textOf = (node) => norm(
    (node.getAttribute && node.getAttribute("aria-label")) || node.innerText || node.textContent || ""
  );
  const visible = (node) => {
    try {
      const rect = node.getBoundingClientRect();
      const view = node.ownerDocument.defaultView;
      if (!view || rect.width <= 0 || rect.height <= 0) return false;
      const style = view.getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    } catch (error) { return false; }
  };
  const roots = [];
  const addRoot = (node) => { if (node && !roots.includes(node)) roots.push(node); };
  const addControlledBy = (el) => {
    if (!el || !el.getAttribute) return;
    for (const name of ["aria-controls", "aria-owns"]) {
      const ids = String(el.getAttribute(name) || "").split(/\\s+/).filter(Boolean);
      for (const id of ids) {
        let target = null;
        try { target = nodeDocument(el).getElementById(id); } catch (error) { target = null; }
        addRoot(target);
      }
    }
  };
  const nodeDocument = (el) => (el && el.ownerDocument) || doc;
  const closestOf = (el, selector) => (el && el.closest ? el.closest(selector) : null);
  const queryAll = (root, selector) => {
    try { return Array.from(root.querySelectorAll(selector)); } catch (error) { return []; }
  };
  if (!this.getAttribute || this.getAttribute("role") !== "option") {
    addControlledBy(this);
    for (const el of queryAll(this, '[role="combobox"],[role="listbox"],[aria-controls],[aria-owns]')) addControlledBy(el);
  }
  if (!roots.length) addRoot(closestOf(this, '[role="listbox"]'));
  if (!roots.length) {
    // 很多组件没有 aria-controls：从自己开始往上找几层，只有最近的那个 listbox 算数
    // （不要把 combobox 自己当根 —— 弹层通常是它的兄弟节点）
    let parent = this.parentElement;
    for (let depth = 0; parent && depth < 6; depth += 1, parent = parent.parentElement) {
      const listbox = queryAll(parent, '[role="listbox"]')[0] || null;
      if (listbox) { addRoot(listbox); break; }
    }
  }
  if (!roots.length) addRoot(doc);

  const options = [];
  const seenNodes = new Set();
  const collect = (root) => {
    if (!root) return;
    let nodes = queryAll(root, '[role="option"]');
    if (root.getAttribute && root.getAttribute("role") === "option") nodes.unshift(root);
    for (const node of nodes) {
      if (seenNodes.has(node)) continue;
      seenNodes.add(node);
      options.push(node);
    }
    for (const node of queryAll(root, '*')) if (node.shadowRoot) collect(node.shadowRoot);
  };
  for (const root of roots) collect(root);

  const hitOf = (node) => {
    const rect = node.getBoundingClientRect();
    const x = (rect.left + rect.right) / 2;
    const y = (rect.top + rect.bottom) / 2;
    let hit = null;
    try { hit = doc.elementFromPoint(x, y); } catch (error) { hit = null; }
    let guard = 0;
    while (hit && hit.shadowRoot && guard < 8) {
      let inner = null;
      try { inner = hit.shadowRoot.elementFromPoint(x, y); } catch (error) { inner = null; }
      if (!inner || inner === hit) break;
      hit = inner;
      guard += 1;
    }
    // elementFromPoint 在坐标落到视口外（长下拉需要滚动才看得见）时返回 null：
    // 这是「不在可视区域」，不是「被别的元素挡住」，诊断和文案要分开。
    const outOfView = hit === null;
    const covered = !outOfView && hit !== node && !(node.contains && node.contains(hit));
    return {
      x, y, covered, outOfView,
      hitText: outOfView ? "" : textOf(hit).slice(0, 80),
      hitTag: outOfView ? "" : String(hit.tagName || "").toLowerCase(),
    };
  };

  const seen = [];
  const contains = [];
  const exact = [];
  const icase = [];
  const needle = norm(wanted);
  const lower = needle.toLowerCase();
  for (const node of options) {
    if (!visible(node)) continue;
    const text = textOf(node);
    if (!text) continue;
    if (seen.length < 60) seen.push(text);
    if (text === needle) exact.push({ node, text, matchedBy: "exact" });
    else if (lower && text.toLowerCase() === lower) icase.push({ node, text, matchedBy: "icase" });
    else if (lower && text.toLowerCase().includes(lower) && contains.length < 60) contains.push(text);
  }
  const pick = (rows) => {
    if (!rows.length) return null;
    const hits = rows.map((row) => ({ ...row, hit: hitOf(row.node) }));
    const open = hits.find((row) => !row.hit.covered && !row.hit.outOfView) || null;
    const chosen = open || hits[0];
    return {
      x: chosen.hit.x,
      y: chosen.hit.y,
      name: chosen.text,
      matchedBy: chosen.matchedBy,
      occluded: chosen.hit.covered ? { name: chosen.hit.hitText, tag: chosen.hit.hitTag } : null,
      // 视口外（长下拉要滚动）：调用方不能按坐标点，也不该说成「被挡住」
      outOfView: chosen.hit.outOfView === true && !chosen.hit.covered,
    };
  };
  return { options: seen, contains, match: pick(exact) || pick(icase) };
}`;

/** 一行快照拆成 role / 名字 / 提示名 / 编号。解析不出来就返回 null（不是可操作行）。 */
function parseSnapshotLine(line) {
  const match = /^(\s*)- ([^\s"[]+)(?: "((?:[^"\\]|\\.)*)")?/.exec(String(line ?? ""));
  if (!match) return null;
  const hint = /\(提示: ([^)]*)\)/.exec(line);
  const ref = /\[ref=(e\d+)\]/.exec(line);
  return {
    indent: match[1].length,
    role: match[2],
    name: match[3] ?? "",
    hint: hint?.[1] ?? "",
    ref: ref?.[1] ?? null,
    // 行尾 `: "值"` 和状态位 `[value="…"]`：旧编号失效重拍时，值变了不代表是另一个元素
    value: (/\[value=("(?:[^"\\]|\\.)*")\]/.exec(line)?.[1] ?? /: ("(?:[^"\\]|\\.)*")\s*$/.exec(line)?.[1] ?? ""),
    states: [...String(line ?? "").matchAll(/\[(checked|unchecked|indeterminate|selected|expanded|collapsed)\]|\[level=\d+\]/g)].map((item) => item[0]),
  };
}

/** 同一个元素的身份：角色 + 无障碍名 + 提示名（提示名覆盖「没有无障碍名、只有合成名」的那种）。 */
function signatureOf(parsed) {
  return `${parsed.role}\u0000${parsed.name}\u0000${parsed.hint}\u0000${parsed.value}\u0000${parsed.states.join(",")}`;
}

/**
 * 「形状」身份：角色 + 名字 + 提示名，不含 value / 状态。
 * 值或勾选状态变了还是同一个元素，重认时必须按这个口径数序号（见 findRefBySignature）。
 */
function shapeOf(parsed) {
  return `${parsed.role}\u0000${parsed.name}\u0000${parsed.hint}`;
}

/** 这个身份在第几处出现（从 0 数）：同名的多个按钮靠它区分。 */
function ordinalOf(lines, index, signature, identityOf = signatureOf) {
  let ordinal = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    const parsed = parseSnapshotLine(lines[cursor]);
    if (parsed && identityOf(parsed) === signature) ordinal += 1;
  }
  return ordinal;
}

/**
 * 在新快照里按「role + 名字（或提示名）+ 序号」找回同一个元素，返回它的新编号。
 *
 * 分三档，从严到宽：先认「角色 + 名字 + 提示名 + 序号」；再认「名字 + 序号」（框架重新渲染时
 * 角色会变，实测维基搜索框从 searchbox 变成 combobox）；最后认「提示名 + 序号」。
 * 三档都找不到返回 null —— 调用方据此报 REF_STALE，并附上最像的几个元素。
 */
function findRefBySignature(text, identity, ordinal, shapeOrdinal = ordinal) {
  const parsed = String(text ?? "")
    .split("\n")
    .map((line) => parseSnapshotLine(line))
    .filter((item) => item?.ref);
  const pick = (predicate, nth = ordinal) => {
    let seen = 0;
    for (const item of parsed) {
      if (!predicate(item)) continue;
      if (seen === nth) return item.ref;
      seen += 1;
    }
    return null;
  };
  const { role, name, hint, value = "", states = [] } = identity;
  const exact = pick((item) => signatureOf(item) === `${role}\u0000${name}\u0000${hint}\u0000${value}\u0000${states.join(",")}`);
  if (exact) return exact;
  // 值 / 状态变了（勾上之后 [unchecked] → [checked]、输入框的值改了）也还是同一个元素：
  // 按「角色 + 名字 + 提示名」的序号认，免得自己刚做的动作把编号弄失效。
  // 这里必须用旧行在「形状」分组里的序号：完整签名分组里可能只有它一个（序号 0），
  // 拿 0 去同名集合里取会落到第一个同名元素上（写错目标还不报错）。
  const sameShape = pick((item) => shapeOf(item) === `${role}\u0000${name}\u0000${hint}`, shapeOrdinal);
  if (sameShape) return sameShape;
  if (name) {
    const byName = pick((item) => item.name === name, shapeOrdinal);
    if (byName) return byName;
  }
  if (hint) {
    const byHint = pick((item) => item.hint === hint, shapeOrdinal);
    if (byHint) return byHint;
  }
  return null;
}

/** 旧编号在旧快照里的那一行（拿它的 role / 名字 / 提示名 / 序号）。 */
function locateOldLine(text, ref) {
  const lines = String(text ?? "").split("\n");
  const index = lines.findIndex((line) => line.includes(`[ref=${ref}]`));
  if (index < 0) return null;
  const parsed = parseSnapshotLine(lines[index]);
  if (!parsed) return null;
  const signature = signatureOf(parsed);
  const shape = shapeOf(parsed);
  const [role, name, hint, value, states] = signature.split("\u0000");
  return {
    identity: { role, name, hint, value, states: states ? states.split(",") : [] },
    ordinal: ordinalOf(lines, index, signature),
    shapeOrdinal: ordinalOf(lines, index, shape, shapeOf),
    line: lines[index],
  };
}

/** 最像的 3 个元素：先看角色，再看名字的重合度。给「找不到」的报错用。 */
function similarElements(text, { role, name }, limit = 3) {
  const scored = [];
  for (const line of String(text ?? "").split("\n")) {
    const parsed = parseSnapshotLine(line);
    if (!parsed?.ref) continue;
    let score = 0;
    if (role && parsed.role === role) score += 2;
    const a = String(name ?? "").toLowerCase();
    const b = (parsed.name || parsed.hint || "").toLowerCase();
    if (a && b) {
      if (a === b) score += 4;
      else if (a.includes(b) || b.includes(a)) score += 3;
      else {
        const parts = new Set(a.split(/[\s\p{P}]+/u).filter(Boolean));
        const hits = b.split(/[\s\p{P}]+/u).filter((word) => parts.has(word)).length;
        score += Math.min(2, hits);
      }
    }
    if (score > 0) scored.push({ score, line: line.trim() });
  }
  return scored.sort((x, y) => y.score - x.score).slice(0, limit).map((item) => item.line);
}

function fail(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function modifierMask(list = []) {
  let mask = 0;
  for (const name of list) {
    const bit = MODIFIER_BITS[name];
    if (!bit) throw fail("INVALID_ARGUMENT", `不认识的修饰键：${name}（可用 Alt、Control、Meta、Shift）`);
    mask |= bit;
  }
  return mask;
}

/**
 * @param {import("../../electron/target-surface.cjs").TargetSurface} cdp
 * @param {object} snap createSurfaceSnapshot 返回的 Observer（用到它的 refs、frames、resolveRef）
 * @param {{ platform?: string, showAgentMousePosition?: (x: number, y: number) => Promise<void>,
 *           showAgentTaskState?: (label: string) => Promise<void>, overlayUi?: () => boolean }} [options]
 *   showAgentMousePosition / showAgentTaskState：AI 光标覆盖层的两个显示钩子（Ego 原版就有的口子）。
 *   两者都必须静默 —— 画光标失败绝不能影响动作本身；不传就是空的（测试 / 老路径照常跑）。
 *   overlayUi：要不要算覆盖层提示（标签 + 光标点）。设置关掉时返回 false，动作前那趟
 *   DOM.resolveNode / getBoxModel 就省了，动作路径和没这个功能时一模一样。
 *   commitKeywords / commitExcludes：提交边界的关键词表与排除词表（可配置，默认用 action-policy 的）。
 */
export function createSurfaceAct(cdp, snap, {
  platform = process.platform,
  showAgentMousePosition = async () => {},
  showAgentTaskState = async () => {},
  overlayUi = () => true,
  commitKeywords = DEFAULT_COMMIT_KEYWORDS,
  commitExcludes = DEFAULT_COMMIT_EXCLUDES,
} = {}) {
  const focusEmulated = new Set();
  const iframeSessions = () => snap.frames?.oopifSessions ?? new Map();

  const services = {
    cdp: (method, params = {}, sessionId = ROOT, timeoutMs) => cdp.send(method, params, sessionId ?? ROOT, timeoutMs ? { timeoutMs } : {}),
    showAgentMousePosition: (x, y) => Promise.resolve(showAgentMousePosition(x, y)).catch(() => {}),
    showAgentTaskState: (label) => Promise.resolve(showAgentTaskState(label)).catch(() => {}),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    platform,
  };

  async function ensureFocusEmulation(sessionId) {
    if (focusEmulated.has(sessionId)) return;
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId).catch(() => {});
    focusEmulated.add(sessionId);
  }

  /**
   * 页面刷新或跳转过，旧编号一律作废（规划 6.1「不猜」）。BrowserOS 的解析在元素没了时会按角色、名字、序号
   * 重新找一个，同一页面里 DOM 变动时这很好用，但换了文档以后找到的可能是另一个页面上的同名按钮。
   */
  async function assertSameDocument() {
    const scope = snap.refScope;
    if (!scope?.documentId) return; // 拍快照时没拿到文档身份，只能交给 BrowserOS 的复查
    const now = await snap.readMainFrameState(cdp.session(ROOT));
    if (now.documentId && now.documentId !== scope.documentId) {
      throw fail("REF_STALE", "页面已经刷新或跳转，旧编号作废，请重新拍快照");
    }
  }

  /** 给 Ego 的 resolveElementObjectId 用：编号 → { objectId, sessionId, frameId } */
  const resolver = {
    async resolve(ref) {
      const entry = snap.refs?.get(ref);
      if (!entry) throw fail("REF_STALE", `编号 ${ref} 不在最近一次快照里，请重新拍快照`);
      await assertSameDocument();
      let element;
      try {
        element = await snap.resolveRef(ref);
      } catch (error) {
        throw fail("REF_STALE", `编号 ${ref} 对应的元素已经不在了，请重新拍快照`, error);
      }
      const sessionId = (entry.frameId && iframeSessions().get(entry.frameId)) || ROOT;
      await ensureFocusEmulation(sessionId);
      const resolved = await cdp.send("DOM.resolveNode", { backendNodeId: element.backendNodeId }, sessionId);
      const objectId = resolved?.object?.objectId;
      if (!objectId) throw fail("REF_STALE", `编号 ${ref} 对应的元素已经不在了，请重新拍快照`);
      return { objectId, sessionId, frameId: entry.frameId };
    },
  };

  /**
   * type 不给 ref：往当前获得焦点的元素里输入。
   *
   * 为什么需要：维基的搜索面板展开后，输入框是刚渲染出来的新节点，AI 手里没有它的编号；
   * 「点开面板 → 直接打字」是最自然的用法。没有可输入的焦点元素时明确报错，不猜目标。
   */
  async function typeIntoFocused(request, svc = services) {
    if (typeof request.text !== "string") throw fail("INVALID_ARGUMENT", "type 需要 text（字符串）");
    await ensureFocusEmulation(ROOT);
    const found = await svc.cdp("Runtime.evaluate", {
      expression: `(() => {
        let el = document.activeElement;
        while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
        return el || null;
      })()`,
      returnByValue: false,
    });
    const objectId = found?.result?.objectId;
    if (!objectId) throw fail("INVALID_ARGUMENT", "type 没给 ref，而页面上当前没有获得焦点的元素：先用 page_act 的 click / focus 点一下输入框，或者给 ref");
    try {
      // 焦点落在时间 / 日期框（或它 shadow 里的分段）上：和给 ref 时走同一条原生 setter 路径。
      // 以前这里把 input:time 当成「不是输入框」直接拒掉（真机 t12 问题 7）。
      const temporal = await temporalOf({ objectId, sessionId: ROOT });
      if (temporal) {
        const combined = combineTemporalValue(temporal.type, temporal.value, request.text);
        if (combined || looksTemporal(request.text)) {
          const filled = await fillTemporalObject({ objectId, sessionId: ROOT }, combined ?? request.text, { clear: request.clear !== false, svc });
          return { ...filled, temporal: filled };
        }
      }
      const prepared = await svc.cdp("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function (clearFirst) {
          const tag = String(this.tagName || "").toLowerCase();
          const editable = this.isContentEditable === true;
          const fillable = tag === "input" || tag === "textarea" || editable;
          if (!fillable) return { error: "not-fillable", tag };
          const type = tag === "input" ? String(this.type || "").toLowerCase() : "";
          const textTypes = ["", "email", "number", "password", "search", "tel", "text", "url"];
          const temporalTypes = ["date", "time", "datetime-local", "month", "week"];
          if (tag === "input" && !textTypes.includes(type) && !temporalTypes.includes(type)) return { error: "not-fillable", tag, type };
          if (this.readOnly) return { error: "read-only", tag };
          if (this.disabled) return { error: "disabled", tag };
          this.focus({ preventScroll: true });
          if (clearFirst) {
            if (tag === "input" || tag === "textarea") this.select();
            else {
              const range = this.ownerDocument.createRange();
              range.selectNodeContents(this);
              const selection = this.ownerDocument.defaultView.getSelection();
              selection?.removeAllRanges();
              selection?.addRange(range);
            }
          }
          return { ok: true, tag };
        }`,
        arguments: [{ value: request.clear !== false }],
        returnByValue: true,
      }, ROOT);
      const value = prepared?.result?.value ?? {};
      if (value.error === "not-fillable") {
        throw fail("NOT_ACTIONABLE", `当前焦点元素不是输入框（${value.tag || "?"}${value.type ? `:${value.type}` : ""}）：先 click / focus 到输入框，或者给 ref`);
      }
      if (value.error === "read-only") throw fail("NOT_ACTIONABLE", "当前焦点元素是只读的，输入不进去");
      if (value.error === "disabled") throw fail("NOT_ACTIONABLE", "当前焦点元素被禁用了，输入不进去");
    } finally {
      await svc.cdp("Runtime.releaseObject", { objectId }, ROOT).catch(() => {});
    }
    await svc.cdp("Input.insertText", { text: String(request.text) }, ROOT);
  }

  /** Ego 会把底层错误包一层再抛，人接管的错误码可能被包掉，所以以适配层的拦截状态为准 */
  function mapError(error) {
    if (cdp.inputBlocked) return fail("CONTROL_PREEMPTED", `人接管了这个格子：${cdp.inputBlocked}`, error);
    if (error?.code) return error;
    if (error instanceof ElementResolutionError) return fail("NOT_ACTIONABLE", error.message, error);
    if (error instanceof TypeError) return fail("INVALID_ARGUMENT", error.message, error);
    return fail("ACT_FAILED", error?.message || String(error), error);
  }

  /**
   * 编号失效（React / Vue 重新渲染，节点被换掉）时：重拍一次快照，按 role + 名字（或提示名）+ 序号
   * 找回同一个元素，返回它的新编号。找不到就抛 REF_STALE，并带上最新快照里最像的 3 个元素。
   * 返回 null 表示「这次失败和编号无关」，调用方原样抛出。
   */
  async function refAfterStale(request, error) {
    const stale = error?.code === "REF_STALE" || STALE_MESSAGE.test(String(error?.message ?? ""));
    if (!stale || !request.ref) return null;
    const oldText = snap.baseline?.text ?? "";
    const located = locateOldLine(oldText, request.ref);
    const fresh = await snap.snapshot().catch(() => null);
    if (!fresh) return null;
    if (located) {
      const next = findRefBySignature(fresh.text, located.identity, located.ordinal, located.shapeOrdinal);
      if (next) return next;
    }
    const identity = located ? located.identity : { role: "", name: "", hint: "" };
    const similar = similarElements(fresh.text, identity);
    const hint = similar.length ? `最新快照里最像的 3 个元素：\n${similar.map((line, index) => `${index + 1}. ${line}`).join("\n")}` : "最新快照里没有相似的元素";
    throw fail(
      "REF_STALE",
      `编号 ${request.ref} 已经失效（${error.message}），重拍快照后没找到同一个元素（${identity.role || "?"} "${identity.name || identity.hint}"）。${hint}。用上面的编号重新调，或者先 page_snapshot 看看页面`,
      error,
    );
  }

  async function elementCenter(ref) {
    const { objectId, sessionId } = await resolver.resolve(ref);
    const box = await cdp.send("DOM.getBoxModel", { objectId }, sessionId);
    const q = box?.model?.content;
    if (!q) throw fail("NOT_ACTIONABLE", `编号 ${ref} 的元素没有可见的位置`);
    return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
  }

  /* ---------------- 覆盖层（AI 光标 + 动作标签）显示层 ---------------- */

  /**
   * 覆盖层标签里用到的元素名：来自最近一次快照（已经脱敏过），拿不到就用编号。
   * 没有无障碍名、只有合成提示名的元素（SPA 里常见的可点 div，例如「发布」图标）也要能拿到名字 ——
   * 提交边界靠它判断，漏掉提示名就等于漏掉发布按钮。
   */
  const refName = (ref) => {
    const name = String(snap.refs?.get(ref)?.name ?? "");
    if (name) return name;
    const line = locateOldLine(snap.baseline?.text ?? "", ref);
    return line ? String(line.identity.hint || "") : "";
  };
  const verbLabel = (verb, ref) => {
    const name = refName(ref);
    return name ? `${verb}：${name}` : `${verb}：${ref}`;
  };

  /** type 的标签：输入内容超过 20 字截断；密码框（type / autocomplete 命中）只显示 •••• */
  async function typeLabel(ref, text) {
    const value = String(text ?? "");
    const clipped = value.length > 20 ? `${value.slice(0, 20)}…` : value;
    let sensitive = false;
    try {
      const { objectId, sessionId } = await resolver.resolve(ref);
      const read = await cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function () { const t = String(this.type || '').toLowerCase(); const ac = String(this.autocomplete || '').toLowerCase(); return t === 'password' || ac.indexOf('password') >= 0 || ac.indexOf('one-time-code') >= 0; }",
        returnByValue: true,
      }, sessionId);
      sensitive = Boolean(read?.result?.value);
      await cdp.send("Runtime.releaseObject", { objectId }, sessionId).catch(() => {});
    } catch { /* 读不到就当普通输入框：覆盖层只是显示层 */ }
    return sensitive ? "输入：••••" : `输入：${clipped}`;
  }

  async function viewportCenter() {
    const r = await cdp.send("Runtime.evaluate", { expression: "({ x: innerWidth / 2, y: innerHeight / 2 })", returnByValue: true });
    return r.result.value;
  }

  /**
   * 动作开始前，把「AI 正在做什么」画到覆盖层上：光标移到目标元素中心（拿不到坐标的动作
   * 只显示标签），旁边写动作标签。Ego 驱动自己也会在 mouseMoved / fill 时回报坐标，
   * 所以先算一次（自动滚动后可能过时）也不影响最终位置。失败一律吞掉。
   */
  async function describeForOverlay(request) {
    const { ref, action } = request;
    let label = "";
    switch (action) {
      case "click": label = verbLabel("点击", ref); break;
      case "double_click": label = verbLabel("双击", ref); break;
      case "select": label = verbLabel("选择", ref); break;
      case "check": label = verbLabel("勾选", ref); break;
      case "hover": label = verbLabel("悬停", ref); break;
      case "focus": label = verbLabel("聚焦", ref); break;
      // type 不给 ref 时是往焦点元素输入，没有元素可指：只显示标签，不算光标位置
      case "type": label = ref ? await typeLabel(ref, request.text) : `输入：${String(request.text ?? "").slice(0, 20)}`; break;
      case "key": label = `按键：${request.key}`; break;
      case "scroll": label = "滚动"; break;
      default: return;
    }
    let point = null;
    if (NEEDS_REF.has(action) || (action === "key" && ref)) {
      point = await elementCenter(ref);
    } else if (action === "scroll") {
      point = ref ? await elementCenter(ref) : await viewportCenter();
    }
    if (point) await services.showAgentMousePosition(point.x, point.y);
    if (label) await services.showAgentTaskState(label);
    return label;
  }

  async function readChecked(ref) {
    const { objectId, sessionId } = await resolver.resolve(ref);
    const r = await cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function () { return 'checked' in this ? Boolean(this.checked) : this.getAttribute('aria-checked') === 'true'; }",
      returnByValue: true,
    }, sessionId);
    return Boolean(r?.result?.value);
  }

  /* ---------------- 时间 / 日期框：宿主 input 和它 shadow 里的 spinbutton 都能填 ---------------- */

  /**
   * 时间 / 日期类 input 的可填类型。Chromium 里 `input[type=time]` 渲染成 shadow DOM 里的
   * 小时 / 分钟两个 spinbutton，使用者（以及 AI 从快照里）先看到的是 spinbutton 的编号，不是宿主的。
   */
  const TEMPORAL_TYPES = ["date", "time", "datetime-local", "month", "week"];

  /** 从载荷 / 快照提示名里认出时间类输入框：单独给了日期段、或文本本身就是 hh:mm 这类格式。 */
  function looksTemporal(text) {
    const value = String(text ?? "").trim();
    if (!value) return false;
    return /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)?$/.test(value)
      || /^\d{4}-\d{2}$/.test(value)
      || /^\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value);
  }

  /** 时间类 input 的目标宿主：自己就是宿主，或者是从 shadow 里的分段往上找到的宿主。 */

  /** 只读探测：这个编号是不是时间 / 日期框（宿主或它的内部段）。读不到（例如 iframe 跨域）就当不是。 */
  async function temporalOf(element) {
    const sessionId = element.sessionId;
    try {
      const r = await cdp.send("Runtime.callFunctionOn", {
        objectId: element.objectId,
        functionDeclaration: `function () {
          const TEMPORAL = ${JSON.stringify(TEMPORAL_TYPES)};
          const typeOf = (node) => String(node && node.tagName === "INPUT" ? node.type : "").toLowerCase();
          let node = this;
          for (let hop = 0; node && hop < 6; hop += 1) {
            if (typeOf(node) && TEMPORAL.includes(typeOf(node))) return { type: typeOf(node), value: String(node.value ?? "") };
            const root = node.getRootNode ? node.getRootNode() : null;
            node = root && root.host ? root.host : (node.parentElement || null);
          }
          return null;
        }`,
        returnByValue: true,
      }, sessionId);
      const value = r?.result?.value;
      return value && typeof value.type === "string" ? value : null;
    } catch {
      return null;
    }
  }

  /** 能填时间 / 日期框就算命中：宿主本身就是，或者编号落到了 shadow 里的分段（spinbutton）。 */
  async function temporalInfoForRef(ref) {
    let element = null;
    try {
      element = await resolver.resolve(ref);
      return await temporalOf(element);
    } catch {
      return null;
    } finally {
      if (element?.objectId) await cdp.send("Runtime.releaseObject", { objectId: element.objectId }, element.sessionId).catch(() => {});
    }
  }

  /**
   * 只给了一个数字（t12 问题 7：点小时段后 type "12"）时，把它并进当前时间值。
   * 分段能认出来就按分段填；认不出来时按 0–23 当时、24–59 当分（最常见的用法）。
   */
  function combineTemporalValue(type, current, text, segment = null) {
    const raw = String(text ?? "").trim();
    if (!/^\d{1,2}$/.test(raw)) return null;
    if (type !== "time") return null;
    const number = Number(raw);
    const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(current ?? ""));
    const hour = match ? match[1] : "00";
    const minute = match ? match[2] : "00";
    const second = match?.[3] ? `:${match[3]}` : "";
    const pick = segment === "minute" ? "minute" : segment === "hour" ? "hour" : (number <= 23 ? "hour" : "minute");
    const nextHour = pick === "hour" ? String(number).padStart(2, "0") : hour;
    const nextMinute = pick === "minute" ? String(number).padStart(2, "0") : minute;
    if (Number(nextHour) > 23 || Number(nextMinute) > 59) return null;
    return `${nextHour}:${nextMinute}${second}`;
  }

  /** 从快照里的分段名字认出是小时还是分钟（中文 / 英文都认）。 */
  function temporalSegmentFromName(name) {
    const text = String(name ?? "");
    if (/分钟|minute|分/i.test(text)) return "minute";
    if (/小时|hour|时/i.test(text)) return "hour";
    return null;
  }

  /**
   * 把时间 / 日期填进宿主 input：原生 setter 写 value（绕开 React 之类的受控包装），再派发
   * input / change（宿主和每个 shadow 里的内部分段都派发一遍 —— Chrome 的时间框靠内部分段重画显示值）。
   * 写完读回确认，值对不上就按 malformed value 报错，绝不假成功。
   *
   * 为什么要在这一层：vendor 的 fillInPage 只认 textbox 类类型，且遇到 spinbutton 会当成「不是输入框」；
   * 真机 t12 里时间框在快照里就是两个 spinbutton，type 怎么填都失败。
   */
  async function fillTemporal(ref, text, { clear = true, svc = services } = {}) {
    return fillTemporalObject(await resolver.resolve(ref), text, { clear, svc });
  }

  /**
   * fillTemporal 的实体：ref 解析出来的对象 / 焦点对象都走这里。
   * element = { objectId, sessionId }（焦点路径不经过 resolver，直接给 Runtime.evaluate 拿到的对象）。
   *
   * svc 必须是本次动作的 trackedServices：写入置位 dispatched，写过了但格式不对时才能按
   * unknown（禁止自动重试）上报，而不是 failed（允许重试）。
   */
  async function fillTemporalObject(element, text, { clear = true, svc = services } = {}) {
    const { objectId, sessionId } = element;
    try {
      // 时间 / 日期是整段值：没有可靠的「只换分钟段」实现，明确拒绝，绝不默默整段覆盖。
      if (clear === false) {
        throw fail("INVALID_ARGUMENT", "时间 / 日期框只能整段填：clear:false 不支持，请去掉 clear 或传 true");
      }
      const r = await svc.cdp("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function setTemporalValueForAction(payload) {
          const TEMPORAL = ${JSON.stringify(TEMPORAL_TYPES)};
          const typeOf = (node) => String(node && node.tagName === "INPUT" ? node.type : "").toLowerCase();
          const hostFor = (start) => {
            let node = start;
            for (let hop = 0; node && hop < 6; hop += 1) {
              if (typeOf(node) && TEMPORAL.includes(typeOf(node))) return node;
              // 分段 input 的「上一级」可能不是 input，也可能整个在 shadow 里：两种都往上找
              const parent = node.parentElement || node.parentNode;
              const root = node.getRootNode ? node.getRootNode() : null;
              const inShadow = root && root.host && root.nodeType === 11;
              const next = inShadow ? root.host : parent;
              if (typeOf(next) && TEMPORAL.includes(typeOf(next))) return next;
              node = next;
            }
            return null;
          };
          const host = hostFor(this);
          if (!host) return { error: "not-temporal" };
          if (host.disabled) return { error: "element is disabled" };
          if (host.readOnly) return { error: "element is read only" };
          const type = typeOf(host);
          const next = String(payload == null ? "" : payload).trim();
          // 原生 setter 写 value：绕开 React / Vue 在实例上包过的 value 属性（整段填值靠它才对得上）
          const view = host.ownerDocument && host.ownerDocument.defaultView ? host.ownerDocument.defaultView : window;
          const proto = view.HTMLInputElement && view.HTMLInputElement.prototype;
          const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
          if (descriptor && descriptor.set) descriptor.set.call(host, next);
          else host.value = next;
          if (String(host.value ?? "") !== next) {
            return { error: "malformed value", type, value: String(host.value ?? ""), expected: next };
          }
          const fire = (target) => {
            try {
              target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
              target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
            } catch (error) { /* 分段派发失败不影响宿主 */ }
          };
          fire(host);
          const segments = host.shadowRoot ? Array.from(host.shadowRoot.querySelectorAll("*")) : [];
          for (const segment of segments) {
            if (segment.tagName === "INPUT" || (segment.getAttribute && segment.getAttribute("role") === "spinbutton")) fire(segment);
          }
          try { host.focus({ preventScroll: true }); } catch (error) { /* 聚焦失败不影响写入 */ }
          return { ok: true, type, value: String(host.value ?? ""), expected: next };
        }`,
        arguments: [{ value: String(text) }],
        returnByValue: true,
      }, sessionId);
      const value = r?.result?.value ?? {};
      if (value.error === "not-temporal") throw fail("NOT_TEMPORAL", "这个编号不是时间 / 日期输入框");
      if (value.error === "element is disabled") throw fail("NOT_ACTIONABLE", "时间 / 日期框被禁用了，输入不进去");
      if (value.error === "element is read only") throw fail("NOT_ACTIONABLE", "时间 / 日期框是只读的，输入不进去");
      // 宿主已经收到这个值（可能被浏览器清空），页面上确实发生过写入：按 unknown 上报、禁止自动重试。
      if (value.error === "malformed value") throw fail("ACT_FAILED", `${formatHint(value.type, text, value.value)}；宿主字段已经写入过这个值，可能已经生效，不要直接重试`);
      // 读回值已经和期望比对过：这是确凿证据，设 confirmed 让 settle 直接走 confirmed 分支。
      return { confirmed: true, kind: "temporal", type: value.type, value: value.value, expected: value.expected };
    } finally {
      await svc.cdp("Runtime.releaseObject", { objectId }, sessionId).catch(() => {});
    }
  }

  /** 时间框格式不对时说清楚要什么格式（浏览器会静默接受不合格式的值吗？不会，value 会是空串）。 */
  function formatHint(type, text, actual) {
    const format = type === "time" ? "hh:mm 或 hh:mm:ss"
      : type === "date" ? "yyyy-mm-dd"
      : type === "month" ? "yyyy-mm"
      : type === "week" ? "yyyy-Www"
      : "yyyy-mm-ddThh:mm";
    return `「${text}」不是有效的 ${type} 值（浏览器要 ${format}），页面上的值现在是 ${JSON.stringify(actual ?? "")}：换成正确格式再试`;
  }

  /**
   * 下拉框当前状态：[{ value, label, selected }]。
   * 读不到（不是 select）返回 null —— 闸门据此决定「不跳过，照常选」。
   */
  async function readSelectOptions(ref) {
    const { objectId, sessionId } = await resolver.resolve(ref);
    try {
      const r = await cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function () {
          let select = String(this.tagName || '').toUpperCase() === 'SELECT' ? this : null;
          if (!select && this.control?.tagName === 'SELECT') select = this.control;
          if (!select) return null;
          return Array.from(select.options).map((option) => ({
            value: String(option.value),
            label: String(option.label ?? option.text ?? ''),
            selected: option.selected === true,
          }));
        }`,
        returnByValue: true,
      }, sessionId);
      return Array.isArray(r?.result?.value) ? r.result.value : null;
    } catch {
      return null;
    }
  }

  /** 批量填表用：读一次元素类型（只读，不发事件）。 */
  async function probeFillTarget(ref) {
    const { objectId, sessionId } = await resolver.resolve(ref);
    try {
      const read = await cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: FILL_PROBE_SOURCE,
        returnByValue: true,
      }, sessionId);
      const probe = read?.result?.value;
      if (!probe || typeof probe !== "object") throw fail("NOT_ACTIONABLE", `编号 ${ref} 读不到元素类型`);
      return probe;
    } finally {
      await cdp.send("Runtime.releaseObject", { objectId }, sessionId).catch(() => {});
    }
  }

  /** 自定义下拉里点一个选项：坐标来自点开后的 DOM（支持 shadowRoot / 浮层）。 */
  async function clickAtPoint(point, sessionId = ROOT, svc = services) {
    await ensureFocusEmulation(sessionId);
    await svc.cdp("Input.dispatchMouseEvent", {
      type: "mouseMoved", x: point.x, y: point.y, button: "none", buttons: 0,
    }, sessionId);
    await svc.cdp("Input.dispatchMouseEvent", {
      type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1,
    }, sessionId);
    await svc.cdp("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1,
    }, sessionId);
  }

  /** 点完自定义下拉后读回 combobox 当前值 / aria-activedescendant（只有读回才算确认）。 */
  async function readComboSelection(ref, svc = services) {
    const { objectId, sessionId } = await resolver.resolve(ref);
    try {
      const read = await svc.cdp("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function readComboSelectionForAction() {
          const doc = this.ownerDocument || document;
          const norm = (value) => String(value == null ? "" : value).replace(/\\s+/g, " ").trim();
          const activeId = this.getAttribute ? String(this.getAttribute("aria-activedescendant") || "").trim() : "";
          let active = null;
          if (activeId) {
            try { active = doc.getElementById(activeId); } catch (error) { active = null; }
            if (!active && this.shadowRoot) {
              try { active = this.shadowRoot.getElementById(activeId); } catch (error) { active = null; }
            }
          }
          const activeText = active ? norm((active.getAttribute && active.getAttribute("aria-label")) || active.innerText || active.textContent) : "";
          return {
            activeText,
            value: norm(typeof this.value === "string" ? this.value : ""),
            text: norm(this.innerText || this.textContent || ""),
            expanded: this.getAttribute ? this.getAttribute("aria-expanded") : null,
          };
        }`,
        returnByValue: true,
      }, sessionId);
      const value = read?.result?.value;
      return value && typeof value === "object" ? value : null;
    } finally {
      await svc.cdp("Runtime.releaseObject", { objectId }, sessionId).catch(() => {});
    }
  }

  /** 读回的值和刚点的选项文字是否一致（只做归一化后的完全相等，不靠「包含」猜）。 */
  function comboValueMatches(readBack, chosen) {
    if (!readBack) return false;
    const wanted = String(chosen ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!wanted) return false;
    return [readBack.activeText, readBack.value, readBack.text]
      .some((value) => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase() === wanted);
  }

  /**
   * 常见自定义下拉：点开 → 在它自己的 listbox 里按文字找 role=option → 遮挡检查 → 点击 → 读回。
   * 找不到时把看到的选项文字带回去（最多 50 个），并尽量把弹层收起来。
   */
  async function chooseFromCombo(ref, wanted, label, svc = services) {
    const text = String(wanted ?? "").trim();
    if (!text) throw fail("INVALID_ARGUMENT", `${ref} 是自定义下拉，value 要给选项文字`);
    await clickInPage(svc, ROOT, resolver, ref, { label }, 0, iframeSessions());
    // 等弹层渲染出来；这一步是逐个字段填的一部分，不是整表的事后等待
    await services.sleep(150);
    const { objectId, sessionId } = await resolver.resolve(ref);
    let found;
    try {
      const read = await svc.cdp("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: COMBO_OPTIONS_SOURCE,
        arguments: [{ value: text }],
        returnByValue: true,
      }, sessionId);
      found = read?.result?.value ?? null;
    } finally {
      await svc.cdp("Runtime.releaseObject", { objectId }, sessionId).catch(() => {});
    }
    const options = Array.isArray(found?.options) ? found.options : [];
    if (!found?.match) {
      // 收不起来也不影响结果：把看到的选项带回去，让 AI 换个值
      await pressKeyInPage(svc, sessionId, "Escape", 0).catch(() => {});
      const error = optionNotFoundError(text, options.map((name) => ({ value: name, label: name })));
      if (Array.isArray(found?.contains) && found.contains.length) error.suggestions = found.contains;
      throw error;
    }
    if (found.match.outOfView) {
      // 选项在视口外（长列表要滚动）：按坐标点会落空，一个鼠标事件都不发
      await pressKeyInPage(svc, sessionId, "Escape", 0).catch(() => {});
      const error = fail("NOT_ACTIONABLE", `${ref} 的选项「${found.match.name}」不在可视区域（下拉列表比视口高，需要先滚动才看得见），没有点击它；先把下拉列表（或页面）滚动到该选项可见，再重试`);
      error.ref = ref;
      error.target = found.match.name;
      error.reason = "out_of_view";
      throw error;
    }
    if (found.match.occluded) {
      // 坐标点下去会落到别的东西上（吸底按钮 / 浮层）：一个鼠标事件都不发
      await pressKeyInPage(svc, sessionId, "Escape", 0).catch(() => {});
      const blocker = found.match.occluded;
      const detail = blocker.name ? `「${blocker.name}」${blocker.tag ? `（${blocker.tag}）` : ""}` : blocker.tag || "其他元素";
      const error = fail("NOT_ACTIONABLE", `${ref} 的选项「${found.match.name}」被${detail}挡住了，没有点击它；先把遮挡元素移开或滚动页面再试`);
      error.ref = ref;
      error.target = found.match.name;
      error.reason = `选项被${detail}挡住`;
      throw error;
    }
    await clickAtPoint(found.match, sessionId, svc);
    // 点击派发出去只是「dispatched」；必须读回 combobox 当前值才算选好
    let readBack = null;
    for (const wait of [120, 180]) {
      await services.sleep(wait);
      readBack = await readComboSelection(ref, svc).catch(() => null);
      if (comboValueMatches(readBack, found.match.name)) break;
    }
    return {
      name: found.match.name || text,
      matchedBy: found.match.matchedBy,
      verified: comboValueMatches(readBack, found.match.name),
      readBack,
    };
  }

  /**
   * 等 expect 出现：每 100ms 探一次，超时返回 false。
   * 探测走 Runtime.evaluate，不产生任何输入事件，所以不会改变页面状态。
   */
  async function expectAppeared(expect) {
    const expression = expectProbeExpression(expect);
    if (!expression) return null;
    const spec = normalizeExpect(expect);
    const deadline = Date.now() + spec.timeoutMs;
    for (;;) {
      // 对话框开着时页面脚本被堵住，Runtime.evaluate 只会立刻报 DIALOG_OPEN；再等下去纯属浪费。
      // 交给上层按 DIALOG_OPEN 返回，调用方先处理对话框。
      if (cdp.dialog) return false;
      const hit = await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, ROOT).catch(() => null);
      if (hit?.result?.value === true) return true;
      if (Date.now() >= deadline) return false;
      await services.sleep(100);
    }
  }

  /**
   * 「事件已经发到页面了吗」的探针：包一层 cdp，看到真正会改页面的调用就置位。
   *
   * 只认三种：
   *   Input.*                             —— 鼠标 / 键盘 / 插入文本，全部是真实输入事件；
   *   Page.handleJavaScriptDialog         —— 关对话框本身也可能提交业务动作；
   *   Runtime.callFunctionOn 里直接改值的 —— select（options[].selected）和时间框（原生 setter 写 value）。
   * 其余（DOM.resolveNode / getBoxModel / Runtime.evaluate / focus / fill 的准备工作）都是只读，
   * 所以「元素不可见 / 编号过期」这类失败仍然算 failed，可以走自动重拍重试。
   */
  function trackedServices(track) {
    return {
      ...services,
      cdp: (method, params = {}, sessionId = ROOT, timeoutMs) => {
        const name = String(method);
        const mutates = name.startsWith("Input.")
          || name === "Page.handleJavaScriptDialog"
          || (name === "Runtime.callFunctionOn" && /selectOptionsForAction|setTemporalValueForAction/.test(String(params?.functionDeclaration ?? "")));
        if (mutates) track.dispatched = true;
        return services.cdp(method, params, sessionId, timeoutMs);
      },
    };
  }

  /** type 不给 ref 时，当前焦点元素的名字（提交边界 + 审计用）；读不到就是空 */
  async function focusedTargetName() {
    const found = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        let el = document.activeElement;
        while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
        if (!el) return "";
        const parts = [
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("placeholder"),
          el.getAttribute?.("name"),
          el.labels ? Array.from(el.labels).map((label) => label.innerText || label.textContent || "").join(" ") : "",
        ];
        return parts.filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
      })()`,
      returnByValue: true,
    }, ROOT);
    return String(found?.result?.value ?? "");
  }

  /**
   * key + Enter 的提交边界目标名：回车可能提交表单，要拦的是「提交」这个后果，
   * 不是焦点元素自己叫什么。先找焦点元素所在 form 里 type=submit 的按钮（没写 type 的
   * <button> 默认就是 submit），取它的名字；没有 form / 没有提交按钮再退回元素自己的名字。
   */
  async function submitTargetName(ref) {
    let objectId = null;
    let sessionId = ROOT;
    if (ref) {
      try {
        const resolved = await resolver.resolve(ref);
        objectId = resolved.objectId;
        sessionId = resolved.sessionId;
      } catch { /* 编号不在了：当成没有焦点元素，不拦（不猜） */ }
    }
    if (!objectId) {
      const found = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          let el = document.activeElement;
          while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
          return el || null;
        })()`,
        returnByValue: false,
      }, ROOT).catch(() => null);
      objectId = found?.result?.objectId ?? null;
    }
    if (!objectId) return "";
    try {
      const read = await cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function () {
          // 提交按钮的名字：文字标签、aria-label、input[type=submit] 的 value
          const buttonName = (node) => [
            node.getAttribute ? node.getAttribute("aria-label") : "",
            node.innerText || node.textContent || "",
            node.getAttribute ? node.getAttribute("value") : "",
            node.getAttribute ? node.getAttribute("name") : "",
          ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
          // 焦点元素自己的名字：只读标签类属性，绝不读 value / 正文（那可能是用户刚输入的内容）
          const fieldName = (node) => {
            const parts = [];
            if (node.getAttribute) {
              parts.push(node.getAttribute("aria-label"), node.getAttribute("placeholder"), node.getAttribute("name"));
            }
            try { if (node.labels) parts.push(Array.from(node.labels).map((label) => label.innerText || label.textContent || "").join(" ")); } catch {}
            try { if (node.closest) parts.push(node.closest("label")?.innerText || ""); } catch {}
            return parts.filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
          };
          const form = this.form || (this.closest ? this.closest("form") : null);
          if (form) {
            const submit = Array.from(form.querySelectorAll("button, input")).find((node) => {
              const tag = String(node.tagName || "").toLowerCase();
              const type = String(node.type || "").toLowerCase();
              if (tag === "button") return type === "submit" || !node.getAttribute("type");
              return type === "submit";
            });
            const name = submit ? buttonName(submit) : "";
            if (name) return name;
          }
          // 焦点元素自己就是提交按钮（先 focus 再按回车）：读它自己的文字
          const tag = String(this.tagName || "").toLowerCase();
          const type = String(this.type || "").toLowerCase();
          if ((tag === "button" && (type === "submit" || !this.getAttribute("type"))) || (tag === "input" && type === "submit")) {
            return buttonName(this);
          }
          return fieldName(this);
        }`,
        returnByValue: true,
      }, sessionId);
      return String(read?.result?.value ?? "").trim();
    } catch {
      return "";
    } finally {
      await cdp.send("Runtime.releaseObject", { objectId }, sessionId).catch(() => {});
    }
  }

  async function run(request, label, svc = services) {
    const { ref, action } = request;
    const frames = iframeSessions();
    switch (action) {
      case "click":
      case "double_click":
        await clickInPage(svc, ROOT, resolver, ref, { clickCount: action === "double_click" ? 2 : 1, label }, modifierMask(request.modifiers), frames);
        return;
      case "type":
        if (typeof request.text !== "string") throw fail("INVALID_ARGUMENT", "type 需要 text（字符串）");
        // 时间 / 日期框（包括快照里显示成 spinbutton 的 shadow 分段）：原生 setter 写宿主 value + input/change，写完读回。
        // 这一步必须在 fillInPage 之前判定：vendor 把 spinbutton 当「不是输入框」，fill 会直接失败（t12 问题 6）。
        {
          const temporal = await temporalInfoForRef(ref);
          if (temporal) {
            const combined = combineTemporalValue(temporal.type, temporal.value, request.text, temporalSegmentFromName(refName(ref)));
            const filled = await fillTemporal(ref, combined ?? request.text, { clear: request.clear !== false, svc });
            return { ...filled, temporal: filled };
          }
        }
        await fillInPage(svc, ROOT, resolver, ref, request.text, { clearFirst: request.clear !== false }, frames);
        return;
      case "select": {
        const values = request.values ?? (request.value !== undefined ? [request.value] : []);
        if (!values.length) throw fail("INVALID_ARGUMENT", "select 需要 value 或 values（选项的值或显示文字）");
        // 先读一遍选项：找不到时直接回候选列表（最多 50 个），不用等 vendor 报一长串
        const options = await readSelectOptions(ref).catch(() => null);
        if (options) {
          const wanted = values.map(String);
          const missing = wanted.find((choice) => !options.some((option) =>
            String(option.value) === choice || String(option.label) === choice));
          if (missing !== undefined) throw optionNotFoundError(missing, options);
        }
        // 已经是目标状态就不发事件（闸门：同一值再选一次在有些后台会触发保存）
        if (alreadyInState({ action: "select", current: options, target: values })) return { skipped: "already_in_state" };
        await selectOptionInPage(svc, ROOT, resolver, ref, values.map(String), frames);
        return;
      }
      case "check": {
        if (typeof request.checked !== "boolean") throw fail("INVALID_ARGUMENT", "check 需要 checked（true 或 false）");
        if (alreadyInState({ action: "check", current: await readChecked(ref), target: request.checked })) return { skipped: "already_in_state" };
        await clickInPage(svc, ROOT, resolver, ref, { label }, 0, frames);
        if ((await readChecked(ref)) !== request.checked) throw fail("ACT_FAILED", `点了 ${ref}，但勾选状态没有变成 ${request.checked}`);
        return;
      }
      case "hover":
        await hoverInPage(svc, ROOT, resolver, ref, { label }, modifierMask(request.modifiers), frames);
        return;
      case "focus":
        await focusInPage(svc, ROOT, resolver, ref, frames);
        return;
      case "key": {
        if (typeof request.key !== "string" || !request.key) throw fail("INVALID_ARGUMENT", "key 需要 key（例如 Enter、Tab、a）");
        let sessionId = ROOT;
        if (ref) {
          await focusInPage(svc, ROOT, resolver, ref, frames);
          sessionId = (await resolver.resolve(ref)).sessionId;
        }
        await ensureFocusEmulation(sessionId);
        await pressKeyInPage(svc, sessionId, request.key, modifierMask(request.modifiers));
        return;
      }
      case "scroll": {
        const deltaX = Number(request.deltaX ?? 0), deltaY = Number(request.deltaY ?? 0);
        if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || (deltaX === 0 && deltaY === 0)) {
          throw fail("INVALID_ARGUMENT", "scroll 需要 deltaX 或 deltaY（像素，不能都是 0）");
        }
        let point;
        if (ref) point = await elementCenter(ref);
        else {
          const r = await cdp.send("Runtime.evaluate", { expression: "({ x: innerWidth / 2, y: innerHeight / 2 })", returnByValue: true });
          point = r.result.value;
        }
        await ensureFocusEmulation(ROOT);
        await wheelInPage(svc, ROOT, point.x, point.y, deltaX, deltaY, modifierMask(request.modifiers), { label });
        return;
      }
      case "dialog": {
        // 关掉页面上开着的 JS 对话框。accept 缺省按 true（确认），但调用方最好显式给。
        if (typeof request.accept !== "boolean") throw fail("INVALID_ARGUMENT", "dialog 需要 accept（true 确认 / false 取消）");
        const open = cdp.dialog ?? null;
        if (!open) throw fail("DIALOG_NOT_OPEN", "页面上现在没有开着的 JS 对话框（可能已经自己关掉了，或者被别的操作确认过了）");
        if (typeof cdp.handleDialog !== "function") {
          // 适配层没实现时退回直接发 CDP，行为一样，只是少了「清记录」那一层
          await svc.cdp("Page.handleJavaScriptDialog", {
            accept: request.accept,
            ...(open.type === "prompt" && typeof request.text === "string" ? { promptText: request.text } : {}),
          }, ROOT, 5_000);
          return { dialog: open, accepted: request.accept, closed: true, confirmed: true };
        }
        const handled = await cdp.handleDialog({ accept: request.accept, promptText: request.text });
        // 后置校验：对话框记录还挂着就说明浏览器没真的关（命令被拒 / 页面已经换了），不能报成功
        if (cdp.dialog) throw fail("ACT_FAILED", `发了关闭 ${open.type} 的命令，但页面上这个对话框还开着`);
        // 复核过了：对话框确实关了，这是确凿证据，直接 confirmed
        return { dialog: handled ?? open, accepted: request.accept, closed: true, confirmed: true };
      }
    }
  }

  return {
    async act(request = {}) {
      const { action } = request;
      const actionClass = classifyAction(action);
      /** 入口就失败（参数错、人接管、编号不在快照里）：事件一个都没发，写动作要标 failed + dispatched:false */
      const entryFail = (code, message) => {
        const error = fail(code, message);
        if (actionClass === ACTION_CLASSES.MUTATING) {
          error.outcome = OUTCOMES.FAILED;
          error.dispatched = false;
          error.next_step = OUTCOME_NEXT_STEP.failed;
        }
        return error;
      };
      if (!ACTIONS.has(action)) {
        // upload 不在这一层：它要先过主进程的工作区路径守卫（只许传授权目录里的文件），
        // 所以由 browser-control 的 pageAct 单独处理。这里说清楚，免得以为是动作名写错了。
        if (String(action ?? "").trim().toLowerCase() === "upload") {
          throw entryFail("INVALID_ARGUMENT", "upload 由控制层处理（要先过工作区路径守卫），不经过按编号动作这一层：请直接用 page_act 的 action:\"upload\"");
        }
        throw entryFail("INVALID_ARGUMENT", `不认识的动作：${action}（可用：${[...ACTIONS].join("、")}）`);
      }
      // type 可以不给 ref：往当前获得焦点的元素里输入（展开搜索面板后直接打字的场景）
      const focusTyping = action === "type" && !request.ref;
      if (NEEDS_REF.has(action) && !request.ref && !focusTyping) throw entryFail("INVALID_ARGUMENT", `${action} 需要 ref（快照里的编号，例如 e3）`);
      // 人接管期间不动手：动作还没开始，步数为 0（规划 6.7）
      if (cdp.inputBlocked) throw entryFail("CONTROL_PREEMPTED", `人接管了这个格子：${cdp.inputBlocked}`);

      // 只有 MUTATING 才套闸门；其余动作的行为和返回字段一个字都不改（含编号失效后的自动重试）
      if (actionClass !== ACTION_CLASSES.MUTATING) {
        let label = "";
        try { if (overlayUi()) label = await describeForOverlay(request); } catch { /* 静默 */ }
        const plain = async (current) => {
          try {
            await run(current, label || undefined, services);
          } catch (error) {
            throw mapError(error);
          }
        };
        try {
          await plain(request);
          return { ok: true, action, ref: request.ref ?? null };
        } catch (error) {
          const nextRef = await refAfterStale(request, error);
          if (!nextRef) throw error;
          const retried = { ...request, ref: nextRef };
          try {
            if (overlayUi()) label = await describeForOverlay(retried).catch(() => label);
          } catch { /* 静默 */ }
          await plain(retried);
          return { ok: true, action, ref: nextRef, retried: true, previousRef: request.ref };
        }
      }

      // 目标名：快照里的可访问名 / 提示名。拿不到就是空（不猜，也就不会误拦）
      let target = request.ref ? refName(request.ref) : "";
      if (!target && focusTyping) target = await focusedTargetName().catch(() => "");
      const expect = normalizeExpect(request.expect);

      // 提交边界：只有点击类（click / double_click / key+Enter）才可能提交，其余动作不套闸门
      const gate = async (current, name) => {
        if (current.confirm === true || !needsCommitGate(current.action, current.key)) return;
        // 回车提交看的是表单里那个提交按钮叫什么，不是焦点输入框叫什么
        const gatedName = current.action === "key" ? (await submitTargetName(current.ref).catch(() => "")) || name : name;
        const keyword = matchCommitKeyword(gatedName, commitKeywords, commitExcludes);
        if (!keyword) return;
        const error = fail("NEEDS_CONFIRM", `「${gatedName}」是不可撤销的提交动作（命中「${keyword}」），没有 confirm:true 不执行`);
        Object.assign(error, confirmRequired({ target: gatedName, keyword }), { outcome: OUTCOMES.FAILED, dispatched: false });
        throw error;
      };
      await gate(request, target);

      // 覆盖层提示（光标 + 标签）先画；画失败绝不能影响动作本身。设置关掉时整段跳过。
      let label = "";
      try { if (overlayUi()) label = await describeForOverlay(request); } catch { /* 静默 */ }

      const track = { dispatched: false };
      const svc = trackedServices(track);
      const attempt = async (current) => {
        try {
          return await run(current, label || undefined, svc);
        } catch (error) {
          throw mapError(error);
        }
      };
      // 发出去之后才有的判定：expect 读到 → confirmed，否则 dispatched（绝不说成功）
      const settle = async (base) => {
        if (base?.skipped === "already_in_state") {
          return { ...base, outcome: OUTCOMES.CONFIRMED, dispatched: false, next_step: "已经是目标状态，没有发事件，不用再点" };
        }
        // 动作把对话框点出来了：不要再等 expect（页面脚本被模态框堵住，等满超时也读不到）。
        // 控制层看到 cdp.dialog 会立刻按 DIALOG_OPEN 返回，这里只负责别把时间浪费在 expect 上。
        if (cdp.dialog) {
          return {
            ...base,
            outcome: OUTCOMES.DISPATCHED,
            dispatched: true,
            expectMet: null,
            next_step: "对话框已经弹出来了：先调 page_act 带 action:\"dialog\" 和 accept:true / false 处理它，再继续原来的动作",
          };
        }
        // 动作自己带回了确凿证据（例如关对话框后复核过「确实关了」）：直接 confirmed，不必再等 expect
        if (base?.confirmed === true) {
          const { confirmed: _confirmed, ...rest } = base;
          const expectMet = expect ? await expectAppeared(expect).catch(() => false) : null;
          return { ...rest, outcome: OUTCOMES.CONFIRMED, dispatched: true, expectMet, next_step: OUTCOME_NEXT_STEP[OUTCOMES.CONFIRMED] };
        }
        let expectMet = null;
        if (expect) expectMet = await expectAppeared(expect).catch(() => false);
        const { outcome } = decideOutcome({ dispatched: true, expectSatisfied: expectMet === true });
        return {
          ...base,
          outcome,
          dispatched: true,
          expectMet,
          next_step: expectMet === false
            ? "事件已经发出，但 expect 没在超时内读到：先 page_snapshot / page_read 读回确认，不要直接再点"
            : OUTCOME_NEXT_STEP[outcome],
        };
      };

      try {
        if (focusTyping) {
          return await settle({ ok: true, action, ref: null, focused: true, target, ...(await typeIntoFocused(request, svc)) });
        }
        try {
          const value = await attempt(request);
          return await settle({ ok: true, action, ref: request.ref ?? null, target, ...(value ?? {}) });
        } catch (error) {
          // 事件已经发出去了：可能已生效，禁止任何自动重试
          if (track.dispatched) {
            error.outcome = OUTCOMES.UNKNOWN;
            error.dispatched = true;
            // 对话框开着：下一步不是「读回确认」（读不到，页面脚本被模态框堵住），而是先处理对话框
            error.next_step = error.code === "DIALOG_OPEN"
              ? "对话框已经弹出来了：先调 page_act 带 action:\"dialog\" 和 accept:true / false 处理它，再继续原来的动作"
              : OUTCOME_NEXT_STEP.unknown;
            error.target = target;
            throw error;
          }
          // 节点被框架换掉（element is not connected）：重拍一次快照、按 role + 名字 + 序号找回同一个元素，重试一次
          const nextRef = await refAfterStale(request, error);
          if (!nextRef) throw error;
          // 换成新编号后目标可能已经是另一个按钮：提交边界重新过一遍
          const retryTarget = refName(nextRef) || target;
          await gate({ ...request, ref: nextRef }, retryTarget);
          const retried = { ...request, ref: nextRef };
          try {
            if (overlayUi()) label = await describeForOverlay(retried).catch(() => label);
          } catch { /* 静默 */ }
          const value = await attempt(retried);
          return await settle({ ok: true, action, ref: nextRef, retried: true, previousRef: request.ref, target: retryTarget, ...(value ?? {}) });
        }
      } catch (error) {
        const mapped = error?.code ? error : mapError(error);
        if (!mapped.outcome) {
          if (mapped.code === "DIALOG_OPEN") {
            // 对话框已经弹出来 = 事件确定发出去了（点击 / 输入已经让页面弹框），下一步是先关对话框，
            // 不是「读回确认」；outcome 仍按 unknown 上报（动作结果要看对话框的返回值），但 dispatched 必须为 true，
            // 调用方据此禁止自动重试（真机 t12：第一次点击卡 15 秒，还报 unknown 让人以为是超时）。
            mapped.outcome = OUTCOMES.UNKNOWN;
            mapped.dispatched = true;
            mapped.next_step = "对话框已经弹出来了：先调 page_act 带 action:\"dialog\" 和 accept:true / false 处理它，再继续原来的动作";
            mapped.target = mapped.target ?? target;
            throw mapped;
          }
          // 没发事件（failed）或发出去之后才出错（unknown）
          const decided = decideOutcome({ dispatched: track.dispatched, error: track.dispatched ? mapped : null });
          mapped.outcome = decided.outcome;
          mapped.dispatched = decided.dispatched;
          mapped.next_step = OUTCOME_NEXT_STEP[decided.outcome];
          mapped.target = mapped.target ?? target;
        }
        throw mapped;
      }
    },
    /**
     * 批量填表的单个字段（page-fill.js 逐个调用，全部填完才由控制层等一次、回读一次 diff）。
     * 只处理「填值」：文本框 / textarea / 原生 select / checkbox / radio / 自定义下拉。
     * 按钮、链接、提交类元素直接拒绝 —— 批量填表绝不触发提交。
     */
    async fillField(field = {}) {
      const ref = String(field?.ref ?? "").trim();
      if (!ref) throw fail("INVALID_ARGUMENT", "fields 里的每一项都要给 ref");
      const entry = snap.refs?.get(ref);
      if (!entry) throw fail("REF_STALE", `编号 ${ref} 不在最近一次快照里，请重新拍快照`);
      const name = String(entry.name ?? "").trim()
        || String(locateOldLine(snap.baseline?.text ?? "", ref)?.identity.hint ?? "");
      const probe = await probeFillTarget(ref);
      const verdict = classifyFillTarget(probe);
      if (verdict.kind === "reject") {
        const error = fail("FIELD_REJECTED", `${ref}${name ? `（${name}）` : ""}不能批量填：${verdict.reason}`);
        error.ref = ref;
        error.target = name;
        error.reason = verdict.reason;
        throw error;
      }
      // 单个字段内部也走 mapError：人接管导致的失败要保留 CONTROL_PREEMPTED，
      // 不能退化成一条普通 ACT_FAILED（批量中止要认得这个码）。
      const mappedRun = async (request) => {
        try {
          return await run(request, undefined, services);
        } catch (error) {
          throw mapError(error);
        }
      };
      const requireText = (what) => {
        if (typeof field?.value !== "string") {
          throw fail("INVALID_ARGUMENT", `${ref}${name ? `（${name}）` : ""}是${what}，value 只能填字符串`);
        }
        return field.value;
      };

      const value = field?.value;
      switch (verdict.kind) {
        case "text": {
          const text = requireText("文本框 / 可编辑区域");
          await mappedRun({ ref, action: "type", text, clear: true });
          return { ok: true, action: "type", target: name };
        }
        case "select": {
          // 原生 select 的 value / 显示文字都只收字符串；数字 / true 不许悄悄变成 "3" / "true"
          const choice = requireText("原生下拉");
          const outcome = await mappedRun({ ref, action: "select", value: choice });
          return {
            ok: true,
            action: "select",
            selected: choice,
            ...(outcome?.skipped ? { skipped: outcome.skipped } : {}),
            target: name,
          };
        }
        case "checkbox": {
          const checked = parseCheckedValue(value);
          if (checked === null) {
            throw fail("INVALID_ARGUMENT", `${ref}${name ? `（${name}）` : ""}是勾选框 / 单选框，value 只能填 true 或 false`);
          }
          if (verdict.radio && checked === false) {
            // 单选框只能「选中」，点不掉；已经是未选中就当已达目标状态
            if (!(await readChecked(ref).catch(() => false))) {
              return { ok: true, action: "check", checked: false, skipped: "already_in_state", target: name };
            }
            throw fail("FIELD_REJECTED", `${ref}${name ? `（${name}）` : ""}是单选框，只能选中另一项，不能取消`);
          }
          const outcome = await mappedRun({ ref, action: "check", checked });
          return { ok: true, action: "check", checked, ...(outcome?.skipped ? { skipped: outcome.skipped } : {}), target: name };
        }
        case "combo": {
          const choice = requireText("自定义下拉");
          let picked;
          try {
            picked = await chooseFromCombo(ref, choice, name || undefined, services);
          } catch (error) {
            throw mapError(error);
          }
          return {
            ok: true,
            action: "select",
            selected: picked.name || choice,
            ...(picked.matchedBy === "icase" ? { matchedBy: picked.matchedBy } : {}),
            // 点完没读回 combobox 当前值：只算「已点选」，不算「已选择」
            ...(picked.verified ? { verified: true } : { verified: false, dispatched: true }),
            target: name,
          };
        }
      }
      throw fail("FIELD_REJECTED", `${ref}${name ? `（${name}）` : ""}不能批量填：只支持文本框 / textarea / select / checkbox / radio / 自定义下拉`);
    },
    /** 批量填完之后的一次性 expect 等待（只调用一次，不按字段重复等）。 */
    async waitForExpect(expect) {
      const spec = normalizeExpect(expect);
      if (!spec) return null;
      return expectAppeared(spec).catch(() => false);
    },
    dispose() {
      focusEmulated.clear();
    },
  };
}
