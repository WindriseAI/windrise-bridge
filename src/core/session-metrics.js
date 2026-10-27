/**
 * 工具返回的 meta 与按 MCP 会话累计的调用统计。
 *
 * 设计取舍：
 *   - 只统计「文本输出」的字数 / token；不读网页内容、不把正文写进日志。
 *   - token 是粗估：汉字 / 日文假名 / 谚文（含全角标点）按字算，其余非空白字符约 4 个算 1 token；
 *     图片按每张 IMAGE_TOKENS 粗估（图片本身只记张数，绝不写进日志）。
 *   - action_id 是「带 meta 的调用」自己的计数器（page_* / browser_*），从 1 开始自增：
 *     read_result / session_stats / 未知工具 / 被拒绝的调用都不占号，同一会话的 #n 因此连续，
 *     可以直接拿返回里的 meta 去日志里找对应那一条。
 *   - 会话记录有上限，超过先丢最早那个；单个会话里的工具明细也有上限
 *     （最多 TOOL_DETAIL_LIMIT 条真名 + 1 条 (other)），避免远端拿随机工具名把内存撑大。
 */

/** 汉字 / 日文假名 / 谚文 / 中文标点 / 全角字符：按字估算 token */
const CJK_CHAR = /[\u3000-\u303f\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

/** 没有工具明细可算时，每张图按多少 token 粗估（按常见的视觉编码开销取中间值） */
const IMAGE_TOKENS = 1200;

/** 单个会话最多保留多少条工具明细，再多就统一归到这里 */
export const TOOL_DETAIL_LIMIT = 64;
export const OTHER_TOOL = "(other)";

/** 按 Unicode 码点数字符数（emoji 不会被算成两个） */
export function countChars(text) {
  let count = 0;
  for (const _ of String(text ?? "")) count += 1;
  return count;
}

/** 一次遍历同时算字数和 token：大文本上不再为统计多扫几遍、也不摊数组 */
function measureText(text) {
  let chars = 0;
  let cjk = 0;
  let other = 0;
  for (const char of String(text ?? "")) {
    chars += 1;
    if (CJK_CHAR.test(char)) cjk += 1;
    else if (!/\s/.test(char)) other += 1;
  }
  return { chars, tokens: cjk + Math.ceil(other / 4) };
}

/** 简单 token 估算：中文按字，英文按 4 字符约 1 token；不引入依赖 */
export function estimateApproxTokens(text) {
  return measureText(text).tokens;
}

/** 哪些工具的返回要带 meta：page_* / browser_* */
export function isMetaTool(name) {
  return /^(?:page|browser)_/.test(String(name ?? ""));
}

/** 返回里那一行很短的 meta 文本（只在没有结构化结果时用） */
export function formatMetaLine(meta) {
  const cached = meta?.cached ? " cached" : "";
  const images = Number(meta?.images) > 0 ? ` images=${meta.images}` : "";
  return `[meta action=${meta?.action_id ?? "?"} ms=${meta?.ms ?? "?"} out=${meta?.out_chars ?? "?"} tokens=${meta?.approx_tokens ?? "?"}${images}${cached}]`;
}

/**
 * 数 content 里的图片张数（只数个数，data 本身不参与任何保存）。
 * 文本的字数 / token 由 record() 自己算（它本来就要遍历文本），这里不重复扫。
 */
export function countImages(content) {
  let images = 0;
  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type === "image") images += 1;
  }
  return images;
}

/**
 * 把 meta 放进结构化结果；当前返回只有文本时，在最后一段文本末尾追加一行。
 * 结构化结果里的其他字段原样保留（不改变任何现有字段的含义）。
 */
export function attachToolMeta(response, meta) {
  if (!response || typeof response !== "object") return response;
  const structured = response.structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    response.structuredContent = { ...structured, meta };
    return response;
  }
  const parts = Array.isArray(response.content) ? response.content : [];
  const line = formatMetaLine(meta);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.type === "text") {
      parts[index] = { ...parts[index], text: `${parts[index].text ?? ""}\n${line}` };
      return response;
    }
  }
  parts.push({ type: "text", text: line });
  response.content = parts;
  return response;
}

/**
 * 会话统计存储。record() 返回这次调用对应的 meta，stats() 返回累计和输出最多的 5 个工具。
 *
 * @param {object} [options]
 * @param {number} [options.maxSessions] 最多保留多少个会话的统计，默认 512
 * @param {number} [options.maxTools] 单个会话最多保留多少条真名工具明细（另加 1 条 (other)），默认 64
 */
export function createSessionMetrics({ maxSessions = 512, maxTools = TOOL_DETAIL_LIMIT } = {}) {
  const limit = Number.isFinite(Number(maxSessions)) && Number(maxSessions) > 0 ? Math.floor(Number(maxSessions)) : 512;
  const toolLimit = Number.isFinite(Number(maxTools)) && Number(maxTools) > 0 ? Math.floor(Number(maxTools)) : TOOL_DETAIL_LIMIT;
  const sessions = new Map();
  const keyOf = (sessionId) => String(sessionId ?? "anonymous");
  const blank = () => ({ actions: 0, calls: 0, totalMs: 0, totalChars: 0, totalTokens: 0, totalImages: 0, tools: new Map() });

  function entryFor(key) {
    let state = sessions.get(key);
    if (state) return state;
    state = blank();
    sessions.set(key, state);
    if (sessions.size > limit) sessions.delete(sessions.keys().next().value);
    return state;
  }

  /** 工具名只留短前缀，detail:false 的调用（未知工具 / 拒绝）不建明细，名字任意长也占不到内存 */
  const detailName = (name) => (countChars(name) > 64 ? `${[...name].slice(0, 64).join("")}…` : name);

  return {
    /**
     * 记录一次工具调用，返回 meta。
     * text / imageCount 只用来数字符 / 估算 token，本身不会保存。
     * detail:false 时只累加调用次数和总耗时（未知工具 / 被拒绝的调用），不计输出也不建工具明细。
     * action_id 只对带 meta 的工具（page_* / browser_*）自增，桥自带工具和失败调用不占号。
     */
    record({ sessionId, tool, ms, text, imageCount = 0, cached, detail = true } = {}) {
      const state = entryFor(keyOf(sessionId));
      const name = detailName(String(tool ?? "(unknown)"));
      const durationMs = Number.isFinite(Number(ms)) ? Math.max(0, Math.round(Number(ms))) : 0;
      const counted = detail !== false;
      const images = counted && Number.isFinite(Number(imageCount)) ? Math.max(0, Math.floor(Number(imageCount))) : 0;
      const measured = counted ? measureText(text) : { chars: 0, tokens: 0 };
      const outChars = measured.chars;
      const approxTokens = counted ? measured.tokens + images * IMAGE_TOKENS : 0;

      state.calls += 1;
      state.totalMs += durationMs;
      if (!counted) {
        return { action_id: state.actions, ms: durationMs, out_chars: 0, approx_tokens: 0 };
      }
      // 只有要带 meta 的工具占 action_id：read_files 之类的普通工具不算，日志里的 #n 才连号
      if (isMetaTool(name)) state.actions += 1;
      state.totalChars += outChars;
      state.totalTokens += approxTokens;
      state.totalImages += images;

      // 明细有条数上限：真名最多 toolLimit 条，再多统一归到 (other)，否则随机工具名能把内存撑满
      let key = name;
      if (!state.tools.has(name) && state.tools.size >= toolLimit) key = OTHER_TOOL;
      const toolState = state.tools.get(key) ?? { tool: key, calls: 0, ms: 0, outChars: 0, approxTokens: 0, images: 0 };
      toolState.calls += 1;
      toolState.ms += durationMs;
      toolState.outChars += outChars;
      toolState.approxTokens += approxTokens;
      toolState.images += images;
      state.tools.set(key, toolState);

      return {
        action_id: state.actions,
        ms: durationMs,
        out_chars: outChars,
        approx_tokens: approxTokens,
        ...(images ? { images } : {}),
        ...(typeof cached === "boolean" ? { cached } : {}),
      };
    },

    /** 当前会话的累计；没有记录时返回全 0。top_tools 按输出 token 从多到少取前 5。 */
    stats(sessionId) {
      const state = sessions.get(keyOf(sessionId)) ?? blank();
      const topTools = [...state.tools.values()]
        .sort((a, b) => b.approxTokens - a.approxTokens || b.calls - a.calls || a.tool.localeCompare(b.tool))
        .slice(0, 5)
        .map((row) => ({
          tool: row.tool,
          calls: row.calls,
          ms: row.ms,
          out_chars: row.outChars,
          approx_tokens: row.approxTokens,
          images: row.images,
        }));
      return {
        session_id: sessionId ?? null,
        calls: state.calls,
        total_ms: state.totalMs,
        out_chars: state.totalChars,
        approx_tokens: state.totalTokens,
        images: state.totalImages,
        top_tools: topTools,
      };
    },

    /** 会话关闭时清掉它的统计（连接器 / 客户端断开后不留垃圾） */
    drop(sessionId) {
      sessions.delete(keyOf(sessionId));
    },

    reset() {
      sessions.clear();
    },

    get size() {
      return sessions.size;
    },
  };
}