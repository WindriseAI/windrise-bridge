/**
 * 批量填表（page_act 的 fields[]）。
 *
 * 背景：一张 8 个字段的表以前要调 8 次 page_act，每次都要等一次、回读一次 diff。
 * 这里只做「编排」这一层，纯函数 / 无浏览器依赖，方便单测：
 *   - 先把整份 fields 的结构校验完（最多 30 项、ref 必填、value 只能是字符串 / 数字 / true / false）
 *     再动手：结构错整次拒绝；但「value 类型和控件不匹配」（例如往文本框填 true）是逐项拒绝 ——
 *     前面的字段可能已经填好，逐项结果会如实标出失败项和后面的结果，绝不假装整批成功；
 *   - 按顺序逐个交给 fillField（surface-act 实现：文本框 / textarea / 原生 select /
 *     checkbox / radio / 自定义下拉），一项失败只记结果，接着填后面的；
 *   - 全部填完只调一次 readBack（browser-control 在里面等一次页面稳定、回读一次 diff）。
 *
 * 安全边界也在这一层定义：按钮、链接、提交类元素一律拒绝 —— 批量填表只填值，
 * 绝不触发提交；要提交仍然单独调用一次 page_act（提交类动作还要 confirm:true）。
 */

export const MAX_FIELDS = 30;
export const MAX_OPTION_CANDIDATES = 50;

/** 可以「填值」的 input type：和 ego 的 fillInPage 认的文本类保持一致。 */
const TEXT_INPUT_TYPES = new Set(["", "email", "number", "password", "search", "tel", "text", "url"]);
/** 直接写 value 的 input type（日期 / 颜色 / 滑杆），也算填值。 */
const DIRECT_INPUT_TYPES = new Set(["color", "date", "time", "datetime-local", "month", "range", "week"]);
/** 角色是这些的元素一律不碰：点了就可能提交 / 跳转。 */
const REJECT_ROLES = new Set([
  "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option",
]);

const REJECT_REASON = "这是按钮 / 链接 / 提交类元素，批量填表只填值、不会触发提交。要提交请单独调用一次 page_act（提交类动作需要 confirm:true）";
const NOT_FILLABLE_REASON = "只能填文本框 / textarea / 原生 select / checkbox / radio / 自定义下拉";
const FILE_REASON = "文件框不能批量填：要用 page_act 的 action:\"upload\" 单独上传";

function invalidArgument(message) {
  const error = new Error(message);
  error.code = "INVALID_ARGUMENT";
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 校验并规范化 fields。任何一项结构不对都整次拒绝（还没碰页面就失败，最安全）。
 * 返回 [{ ref, value }]，顺序保持调用方给的顺序。
 */
export function normalizeFields(fields) {
  if (!Array.isArray(fields)) throw invalidArgument("fields 必须是数组：[{ref, value}, …]");
  if (fields.length === 0) throw invalidArgument("fields 至少要有 1 项");
  if (fields.length > MAX_FIELDS) {
    throw invalidArgument(`fields 最多 ${MAX_FIELDS} 项，这次给了 ${fields.length} 项；分成几次填，或先只填必填项`);
  }
  return fields.map((item, index) => {
    const at = `fields[${index}]`;
    if (!isPlainObject(item)) throw invalidArgument(`${at} 必须是 {ref, value} 对象`);
    const ref = typeof item.ref === "string" ? item.ref.trim() : "";
    if (!ref) throw invalidArgument(`${at} 缺 ref（快照里的编号，例如 e3）`);
    if (item.value === undefined) throw invalidArgument(`${at} 缺 value`);
    const type = typeof item.value;
    if (type !== "string" && type !== "number" && type !== "boolean") {
      throw invalidArgument(`${at}.value 只能是字符串 / 数字 / true / false`);
    }
    return { ref, value: item.value };
  });
}

/**
 * 页面探针（surface-act 的 probeFillTargetForAction 返回）→ 该用哪种填法。
 *   text / select / checkbox / combo / reject
 * 只看标签、type、显式 role、contentEditable；判断顺序故意把「提交类」放最前面。
 */
export function classifyFillTarget(probe = {}) {
  const tag = String(probe.tag ?? "").toLowerCase();
  const type = String(probe.type ?? "").toLowerCase();
  const role = String(probe.role ?? "").trim().toLowerCase();

  if (probe.disabled === true) return { kind: "reject", reason: "元素被禁用了，填不进去" };
  if (REJECT_ROLES.has(role)) return { kind: "reject", reason: REJECT_REASON };
  if (tag === "button" || tag === "a") return { kind: "reject", reason: REJECT_REASON };
  if (tag === "input" && ["submit", "button", "reset", "image"].includes(type)) {
    return { kind: "reject", reason: REJECT_REASON };
  }
  if (tag === "input" && type === "file") return { kind: "reject", reason: FILE_REASON };

  if (tag === "select") return { kind: "select" };
  if (tag === "textarea") return { kind: "text" };
  if (tag === "input") {
    if (TEXT_INPUT_TYPES.has(type) || DIRECT_INPUT_TYPES.has(type)) return { kind: "text" };
    if (type === "checkbox" || type === "radio") {
      return { kind: "checkbox", radio: type === "radio" };
    }
    return { kind: "reject", reason: `type=${type || "?"} 的输入框不能批量填，${NOT_FILLABLE_REASON}` };
  }
  if (probe.contentEditable === true) return { kind: "text" };
  if (role === "checkbox" || role === "switch") return { kind: "checkbox", radio: false };
  if (role === "radio") return { kind: "checkbox", radio: true };
  if (role === "combobox" || role === "listbox") return { kind: "combo" };
  return { kind: "reject", reason: NOT_FILLABLE_REASON };
}

/** checkbox / radio / switch 的 value：只认明确的真假值，含糊的就报错（不猜）。 */
export function parseCheckedValue(value) {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "on", "yes", "是", "勾选", "选中", "check", "checked"].includes(text)) return true;
  if (["false", "0", "off", "no", "否", "取消", "不勾选", "uncheck", "unchecked"].includes(text)) return false;
  return null;
}

/** 选项列表 → 候选（最多 50 个）。给「选项不存在」的报错和返回体共用。 */
export function optionCandidates(options = [], { limit = MAX_OPTION_CANDIDATES } = {}) {
  const list = Array.isArray(options) ? options : [];
  const capped = Math.max(0, Math.floor(Number(limit) || MAX_OPTION_CANDIDATES));
  const items = list.slice(0, capped).map((option) => {
    const value = String(option?.value ?? "");
    return {
      value,
      label: String(option?.label ?? option?.text ?? value),
      selected: option?.selected === true,
    };
  });
  return { items, total: list.length, truncated: list.length > items.length };
}

/**
 * 原生 select / 自定义下拉找不到目标选项时的错误：带可选项列表（最多 50 个）。
 * 报错文案里也直接写出来 —— 模型只看正文也能换个值重试。
 */
export function optionNotFoundError(wanted, options = []) {
  const candidates = optionCandidates(options);
  const shown = candidates.items.map((option) => option.label || option.value).join("、");
  const tail = candidates.truncated ? `…（共 ${candidates.total} 项，这里只列前 ${candidates.items.length} 个）` : "";
  const error = new Error(`选项里没有「${wanted}」，可选：${shown || "（没有可选项）"}${tail}`);
  error.code = "OPTION_NOT_FOUND";
  error.wanted = String(wanted ?? "");
  error.options = candidates.items;
  error.optionsTotal = candidates.total;
  error.optionsTruncated = candidates.truncated;
  return error;
}

/** 一批结果里各状态的个数（失败项 / 中止项 / 已点但没读回确认的项分开算）。 */
function summarizeResults(results) {
  return {
    total: results.length,
    filled: results.filter((item) => item.ok && !item.skipped).length,
    skipped: results.filter((item) => item.skipped).length,
    aborted: results.filter((item) => item.skipped === "batch_aborted").length,
    failed: results.filter((item) => !item.ok && !item.skipped).length,
    unverified: results.filter((item) => item.ok && item.verified === false).length,
  };
}

/** 把逐项结果挂到错误上再抛：HTTP 层会按白名单带回去，AI 能知道哪些填了、哪些没填。 */
function attachBatch(error, results) {
  Object.assign(error, { fields: results, ...summarizeResults(results) });
  return error;
}

/**
 * 顺序填完整张表，最后只回读一次。
 *
 *   fillField(field) → { ok:true, action?, … }（失败请抛带 code 的错误）
 *   beforeField(field, index, results) → 每个字段动手前的复查（闸门 / 对话框）
 *   readBack(results) → { navigation?, diff?, code?, note? }（只会被调用一次）
 *
 * 一项失败不打断后面的；但 beforeField 抛错（人接管 / 任务终止 / 对话框）会立刻中止
 * 整批，当前项和剩余项都记成 skipped:"batch_aborted"，把已完成的结果挂在 error.fields
 * 上再抛，绝不继续往页面里写。readBack 自己抛错时同样带上已完成的结果。
 */
export async function fillFieldsOnce({ fields, fillField, beforeField, readBack } = {}) {
  const list = normalizeFields(fields);
  if (typeof fillField !== "function") throw invalidArgument("缺 fillField：不知道单个字段怎么填");

  const results = [];
  for (let index = 0; index < list.length; index += 1) {
    const field = list[index];
    if (typeof beforeField === "function") {
      try {
        await beforeField(field, index, results);
      } catch (error) {
        // 闸门复查失败：剩下的字段一个都不碰，当前项也标成中止（不是失败，原因单独带上）
        const code = error?.code ?? "ACT_FAILED";
        const message = String(error?.message ?? error);
        for (const pending of list.slice(index)) {
          results.push({ ref: pending.ref, ok: false, skipped: "batch_aborted", code, error: message });
        }
        throw attachBatch(error, results);
      }
    }
    try {
      const filled = await fillField(field);
      results.push({ ref: field.ref, ...(filled ?? {}), ok: true });
    } catch (error) {
      const item = {
        ref: field.ref,
        ok: false,
        code: error?.code ?? "ACT_FAILED",
        error: String(error?.message ?? error),
      };
      if (error?.target) item.target = error.target;
      if (error?.reason) item.reason = error.reason;
      if (Array.isArray(error?.options)) {
        item.options = error.options;
        item.optionsTotal = error.optionsTotal ?? error.options.length;
        item.optionsTruncated = Boolean(error.optionsTruncated);
      }
      if (Array.isArray(error?.suggestions) && error.suggestions.length) item.suggestions = error.suggestions;
      results.push(item);
    }
  }

  let after = {};
  if (typeof readBack === "function") {
    try {
      after = (await readBack(results)) ?? {};
    } catch (error) {
      throw attachBatch(error, results);
    }
  }

  return {
    ok: results.every((item) => item.ok || item.skipped),
    batch: true,
    ...summarizeResults(results),
    fields: results,
    ...after,
  };
}