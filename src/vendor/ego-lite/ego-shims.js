/**
 * 垫片：搬来的 Ego Lite 输入层（driver/page-actions.js、driver/keyboard.js）原本依赖 Ego 自己的浏览器运行时、
 * 全局状态和一个 2500 多行的元素解析器。这些我们不搬：编号由我们的语义快照（src/vendor/browseros 的 Observer）发，
 * CDP 走账号窗口的 CDP 适配层（electron/target-surface.cjs）。这里只按它们用到的形状补上几个导出；没接的一律报错，免得悄悄走到 Ego 的旧路径。
 *
 * 本文件是 Windrise 自己写的，不是搬来的；tools/vendor-ego.mjs 不会覆盖它。
 */

export class ElementResolutionError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = "ElementResolutionError";
    this.kind = kind;
  }
}

/** 取 Runtime.evaluate / callFunctionOn 的返回值；页面里抛了异常就报出来。 */
export function runtimeValue(response, expression) {
  const result = response?.result || {};
  const details = response?.exceptionDetails;
  if (details || result.subtype === "error") {
    const desc = result.description || details?.exception?.description || details?.text || "未知错误";
    const snippet = String(expression ?? "").replace(/\s+/g, " ").slice(0, 120);
    throw new Error(`页面脚本出错：${desc}；脚本：${snippet}`);
  }
  if (Object.hasOwn(result, "value")) return result.value;
  if (Object.hasOwn(result, "unserializableValue")) {
    const raw = result.unserializableValue;
    if (raw === "NaN") return NaN;
    if (raw === "Infinity") return Infinity;
    if (raw === "-Infinity") return -Infinity;
    if (raw === "-0") return -0;
    if (/^-?\d+n$/.test(raw)) return BigInt(raw.slice(0, -1));
    return raw;
  }
  return null;
}

/**
 * page-actions 用它把「选择器或编号」换成页面里的元素。我们只认快照编号：
 * refMap 是 src/core/surface-act.js 传进来的解析器（resolve(ref, options)），不是 Ego 的 RefMap。
 */
export async function resolveElementObjectId(_cdp, _sessionId, refMap, selectorOrRef, _iframeSessions, options = {}) {
  if (typeof refMap?.resolve !== "function") {
    throw new ElementResolutionError("只认快照编号：refMap 必须是 surface-act 提供的解析器", "permanent");
  }
  return refMap.resolve(selectorOrRef, options);
}

/** keyboard.js 只读 state.platform。 */
export const state = { platform: process.platform };

const unsupported = (name) => () => {
  throw new Error(`${name} 没有接进 Windrise（只搬了按编号动作那部分），请用 src/core/surface-act.js`);
};
export const cdp = unsupported("cdp-eval.cdp");
export const browserCdp = unsupported("browser-runtime.browserCdp");
export const withHandle = unsupported("element-ops.withHandle");
export const resolveAndCall = unsupported("element-ops.resolveAndCall");
export const waitForElement = unsupported("waits.waitForElement");
