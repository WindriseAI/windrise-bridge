/**
 * 流程回放的定位打分（纯函数，方便单测）。
 *
 * 参考 Playwright 的 selectorGenerator 打分表（分数越低越好），这里只取回放要用的几档，
 * 并且把「草稿里存的多路定位」和「当前页面的快照行」做匹配：
 *
 *   data-testid 1 < role+可访问名 100 < label / 提示名 140 < 纯文本 180 < 只能靠序号 10000
 *
 * 草稿里的每一步都能存好几条候选（locators 数组），回放时按分数从低到高试，取第一个分数够低的；
 * 分数低于阈值的步骤标成「脆弱」（页面改版后很可能失效），但仍然执行 —— 硬拦反而让能用的草稿跑不了。
 */

/** 分数越小越稳。和 Playwright 的表保持一致，方便对照。 */
export const LOCATE_SCORES = Object.freeze({
  testid: 1,
  roleWithName: 100,
  label: 140,
  text: 180,
  css: 500,
  xpath: 600,
  nth: 10_000,
});

/**
 * 「脆弱」阈值：分数 >= 这个值算脆弱（只有序号 / 纯 CSS 这类定位）。
 * 和设计参考里「只允许用分数 ≥ 0.5 的元素作锚点」是同一件事的另一面 —— 那边分越高越好，这边分越低越好。
 */
export const FRAGILE_SCORE = 500;

/**
 * 反向包含要求被包含的名字至少这么多个字：草稿里记「删除」，快照里叫「删」，
 * 靠「删除 ⊃ 删」命中等于瞎猜（一个字的名字到处都是）。正向包含（草稿名字更长）不受这个限制。
 */
export const MIN_CONTAINED_CHARS = 4;

/** 部分匹配（靠包含命中，不是名字完全一样）在分数上加的权重：命中但不够稳。 */
export const PARTIAL_PENALTY = 20;

/** 定位种类（写进草稿的 locators[].kind，也用于排序比较）。 */
export const LOCATOR_KINDS = Object.freeze(["testid", "role", "label", "text", "css", "xpath"]);

const ROLE_ALIASES = new Map([
  ["textbox", ["textbox", "searchbox", "combobox"]],
  ["searchbox", ["searchbox", "textbox", "combobox"]],
  ["combobox", ["combobox", "searchbox", "textbox"]],
  ["link", ["link"]],
  ["button", ["button"]],
  ["checkbox", ["checkbox", "switch"]],
  ["radio", ["radio"]],
]);

/** 一行快照拆成 role / 名字 / 提示名 / 状态 / 编号（和 surface-act.js 的解析保持一致）。 */
export function parseSnapshotLine(line) {
  const text = String(line ?? "");
  const match = /^(\s*)- ([^\s"[]+)(?: "((?:[^"\\]|\\.)*)")?/.exec(text);
  if (!match) return null;
  const hint = /\(提示: ([^)]*)\)/.exec(text);
  const ref = /\[ref=(e\d+)\]/.exec(text);
  const states = new Set([...text.matchAll(/\[(checked|unchecked|selected|disabled|expanded|collapsed)\]/g)].map((m) => m[1]));
  return {
    indent: match[1].length,
    role: match[2],
    name: unescape(match[3] ?? ""),
    hint: hint?.[1] ?? "",
    states,
    ref: ref?.[1] ?? null,
    line: text.trim(),
  };
}

function unescape(value) {
  return String(value ?? "").replace(/\\(.)/g, "$1");
}

/** 一个元素的所有「人话」：可访问名、提示名、以及值（下拉框当前值可能就在名字里）。 */
function nameCandidates(item) {
  return [item.name, item.hint].map((value) => String(value ?? "").trim().toLowerCase()).filter(Boolean);
}

function roleMatches(wanted, actual) {
  if (!wanted) return true;
  const list = ROLE_ALIASES.get(wanted) ?? [wanted];
  return list.includes(actual);
}

/**
 * 文本是否命中：
 *   - 完全相等 → exact；
 *   - 草稿名字更长、快照名字是它的一部分（「收货人姓名」⊃「收货人」的另一种方向）→ partial；
 *   - 快照名字更长、草稿名字被包含 → partial，但被包含的名字至少 MIN_CONTAINED_CHARS 个字
 *     （去掉「删除」命中「删」这种反向包含：名字太短，包含关系毫无意义）。
 */
function textHit(wanted, actual) {
  if (!wanted) return null;
  if (!actual) return null;
  if (wanted === actual) return "exact";
  if (actual.includes(wanted)) return "partial";
  if (wanted.includes(actual) && [...actual].length >= MIN_CONTAINED_CHARS) return "partial";
  return null;
}

/**
 * 给「一条草稿定位」和「一行快照」打分。
 * 返回 null 表示这一行不匹配这条定位；否则返回 { score, how, partial }（how 说明靠什么匹配上的，
 * partial 表示靠包含命中而不是名字完全一样——这种要记成脆弱）。
 */
export function scoreLocator(locator, item) {
  if (!locator || !item) return null;
  switch (locator.kind) {
    case "testid": {
      // 快照行里没有属性，只能从提示名 / 名字里认；控制层会把 data-testid 拼进提示名
      const wanted = String(locator.value ?? "").trim().toLowerCase();
      if (!wanted) return null;
      const hits = nameCandidates(item).map((text) => (text === wanted ? "exact" : text.includes(wanted) ? "partial" : null)).filter(Boolean);
      if (!hits.length) return null;
      const partial = !hits.includes("exact");
      return { score: LOCATE_SCORES.testid + (partial ? PARTIAL_PENALTY : 0), how: "testid", partial };
    }
    case "role": {
      if (!roleMatches(String(locator.role ?? "").toLowerCase(), item.role)) return null;
      const wanted = String(locator.name ?? "").trim().toLowerCase();
      if (!wanted) {
        return locator.nameRequired === false
          ? { score: LOCATE_SCORES.roleWithName + 40, how: "role-without-name", partial: false }
          : null;
      }
      const how = nameCandidates(item).map((text) => textHit(wanted, text)).find(Boolean);
      if (!how) return null;
      return { score: LOCATE_SCORES.roleWithName + (how === "partial" ? PARTIAL_PENALTY : 0), how: "role+name", partial: how === "partial" };
    }
    case "label": {
      const wanted = String(locator.value ?? locator.name ?? "").trim().toLowerCase();
      if (!wanted) return null;
      const how = nameCandidates(item).map((text) => textHit(wanted, text)).find(Boolean);
      if (!how) return null;
      return { score: LOCATE_SCORES.label + (how === "partial" ? PARTIAL_PENALTY : 0), how: "label", partial: how === "partial" };
    }
    case "text": {
      const wanted = String(locator.value ?? locator.text ?? "").trim().toLowerCase();
      if (!wanted) return null;
      const how = nameCandidates(item).map((text) => textHit(wanted, text)).find(Boolean);
      if (!how) return null;
      return { score: LOCATE_SCORES.text + (how === "partial" ? PARTIAL_PENALTY : 0), how: "text", partial: how === "partial" };
    }
    case "css":
    case "xpath":
      // 回放阶段只能在快照上按「名字」定位，拿不到 DOM 属性。
      // CSS 选择器会在 flow-replay 里退回「按选择器拍子树快照、再取唯一编号」（见 locateBySelector），
      // XPath 没有这条通路，只能当「记录」，不在这里打分。
      return null;
    default:
      return null;
  }
}

/**
 * 在一个快照里找出所有命中的元素，按分数从低到高排好。
 * @returns {Array<{ ref: string, line: string, name: string, hint: string, score: number,
 *                   how: string, partial: boolean, locator: object }>}
 */
export function locateAll(locators, snapshotText) {
  const items = String(snapshotText ?? "")
    .split(/\r?\n/)
    .map((line) => parseSnapshotLine(line))
    .filter((item) => item?.ref);
  const found = [];
  for (const locator of locators ?? []) {
    for (const item of items) {
      const scored = scoreLocator(locator, item);
      if (!scored) continue;
      // 名字一起带出去：确认类步骤要拿「实际命中的元素名」和草稿里的 target 比对，不能只看草稿
      found.push({
        ref: item.ref,
        line: item.line,
        name: item.name,
        hint: item.hint,
        score: scored.score,
        how: scored.how,
        partial: scored.partial === true,
        locator,
      });
    }
  }
  // 同一个编号被多条定位命中：留分数最低的那条
  const byRef = new Map();
  for (const hit of found) {
    const previous = byRef.get(hit.ref);
    if (!previous || hit.score < previous.score) byRef.set(hit.ref, hit);
  }
  return [...byRef.values()].sort((a, b) => a.score - b.score);
}

/**
 * 在一个快照里找最匹配的元素：对每条定位打分，取最低分。
 * 有多个「同分最佳」候选时判失败（返回 null）—— 瞎挑第一个正是误点（点错删除、点错账号）的来源。
 * 调用方可以先调 locateAll 把候选列给用户 / 调用者。
 * @returns {{ ref: string, score: number, how: string, partial: boolean, locator: object, line: string } | null}
 */
export function bestMatch(locators, snapshotText) {
  const ranked = locateAll(locators, snapshotText);
  if (!ranked.length) return null;
  const [best, second] = ranked;
  if (second && second.score === best.score) return null;
  return best;
}

/** 分数 → 脆弱标记：只有序号 / 纯 CSS 这类才脆弱；靠包含命中的部分匹配也算脆弱。 */
export function isFragile(score, partial = false) {
  return partial === true || !Number.isFinite(score) || score >= FRAGILE_SCORE;
}

/**
 * 从快照行 + 草稿里的 target 组装一条步骤的「多路定位」。
 *
 * target 是草稿里人话的名字（可访问名 / 提示名）；能解析到 role 就记 role + name，
 * 同时始终记一条 label（名字也可能来自 label / 提示名）和一条 text，回放时按分数试。
 * testid 只有控制层知道（data-testid 会拼进提示名），这里不硬造。
 */
export function locatorsFor({ target = "", hint = "", role = "" } = {}) {
  const name = String(target ?? "").trim();
  const list = [];
  if (role && name) list.push({ kind: "role", role: String(role).toLowerCase(), name });
  if (name) list.push({ kind: "label", value: name });
  if (hint && hint !== name) list.push({ kind: "label", value: hint });
  if (name) list.push({ kind: "text", value: name });
  return list;
}

/**
 * 变量的类型 / 是否必填 / 是否 secret —— 只靠「名字」和调用日志里能给到的信号推断。
 *
 * 优先级：名字里的强信号（password / 验证码 / 密码）> 输入框类型（type 空不出来，用名字里的关键词）
 * > 通用关键词（email / tel / phone / date / time）。
 */
export function classifyVariable({ name = "", target = "", hint = "", required = true } = {}) {
  const label = `${name} ${target} ${hint}`.toLowerCase();
  const secretPattern = /password|passcode|passwd|pwd|密码|密碼|口令|验证码|驗證碼|校验码|校驗碼|动态码|動態碼|otp|one.?time|pin\b|安全码|安全碼|支付密码|支付密碼|secret|token/i;
  if (secretPattern.test(label)) return { type: "password", required: Boolean(required), secret: true };
  if (/e-?mail|邮箱|郵箱|电子邮件|電子郵件/i.test(label)) return { type: "email", required: Boolean(required), secret: false };
  if (/phone|mobile|tel\b|电话|電話|手机|手機|手机号|手機號/i.test(label)) return { type: "tel", required: Boolean(required), secret: false };
  if (/生日|出生|date\b|日期/i.test(label)) return { type: "date", required: Boolean(required), secret: false };
  if (/时间|時間|time\b|delivery|送达|送達/i.test(label)) return { type: "time", required: Boolean(required), secret: false };
  if (/url|网址|網址|链接|鏈接/i.test(label)) return { type: "url", required: Boolean(required), secret: false };
  if (/number|num\b|数量|數量|年龄|年齡|金额|金額/i.test(label)) return { type: "number", required: Boolean(required), secret: false };
  if (/search|搜索|查找/i.test(label)) return { type: "search", required: Boolean(required), secret: false };
  return { type: "text", required: Boolean(required), secret: false };
}

/**
 * 给变量挑一个「人话名字」：优先用输入框的 label / 提示名，其次 target，最后退回 varN。
 * 名字要能直接当 {{占位符}} 用：去掉空白和花括号，最多 24 个字。
 *
 * 英文多词 label（E-mail address、Customer name）在 JSON 里当键很难传、也难读，
 * 所以英文按空格 / 连字符拆开、首字母大写连起来（E-mail_address → EmailAddress）；
 * 中文（以及名字里已经带中文的）原样保留 —— 中文名正是「从 label 推断出『姓名』『电话』」要看的东西。
 */
export function variableName({ index, target = "", hint = "" } = {}) {
  const source = [target, hint].map((value) => String(value ?? "").trim()).find(Boolean) ?? "";
  const clean = (value) => value
    .replace(/[{}]/g, "")
    .replace(/[^\p{L}\p{N}_.\s-]/gu, "")
    .trim();
  let text = clean(source);
  if (!text) return `var${index}`;
  if (!/[\u3400-\u9fff]/.test(text) && /[\s-]/.test(text)) {
    // 驼峰：Customer name → CustomerName、E-mail address → EMailAddress
    text = text.split(/[\s_-]+/).filter(Boolean)
      .map((word) => `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}`)
      .join("");
  }
  return text.slice(0, 24) || `var${index}`;
}
