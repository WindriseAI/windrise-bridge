/**
 * 工具调用日志 —— 每次 tools/call 往当天的 jsonl 里追加一行，方便事后查「谁在什么时候调了什么」。
 *
 * 设计取舍：
 *   - 一天一个文件（mcp-calls-YYYY-MM-DD.jsonl，本地日期），按行追加，读的时候不用解析整个大 JSON；
 *   - 参数只做摘要，不落原文：密码 / 令牌类键名一律打码，长字符串截断，数组和对象只留形状；
 *   - 日志写失败绝不影响工具调用本身 —— 调用方只管调 record，出错在这里吃掉并记一句。
 */

import { appendFile, mkdir } from "node:fs/promises";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

const HIDDEN = "[已隐藏]";
const STRING_LIMIT = 80;
const DAY_MS = 24 * 60 * 60 * 1000;
const FILE_PATTERN = /^mcp-calls-\d{4}-\d{2}-\d{2}\.jsonl$/;
/** 键名命中这些词的参数值不落原文（前后都能有别的字母，比如 myToken / user_password） */
const SENSITIVE_KEY = /pass|secret|token|cookie|auth|credential|otp|apikey|api_key|private/i;
/**
 * 往网页里输入的内容（page_act 的 text、表单的 value 等）只记长度：
 * 桥不知道对面是不是密码框，键名又是普通的 text，靠键名打码拦不住。
 */
const TYPED_KEY = /^(text|value|values|keys)$/i;

/**
 * 日志里的数字字段：缺失就记 null。
 * 注意不能用 Number.isFinite(Number(x))——Number(null) / Number("") 都是 0，
 * 字段缺失会被写成 0，排障时误判成「这一步不耗时 / 没输出」。
 */
export function numOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * 参数摘要：只看顶层键，够判断「调了什么」即可，不把整份参数（可能带密码、长文本）写进日志。
 * 导出是为了单测能直接验规则，不用先跑一遍服务器。
 */export function summarizeArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const summary = {};
  for (const [key, value] of Object.entries(args)) {
    if (SENSITIVE_KEY.test(key)) {
      summary[key] = HIDDEN;
      continue;
    }
    if (TYPED_KEY.test(key) && typeof value === "string") {
      summary[key] = `[输入内容，${value.length} 字]`;
      continue;
    }
    summary[key] = summarizeValue(value);
  }
  return summary;
}

/** 目标名截断（换行压成空格，保证日志一行一条）。审计字段专用。 */
function clipText(text, limit) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function summarizeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (value.length <= STRING_LIMIT) return value;
    return `${value.slice(0, STRING_LIMIT)}…（共 ${value.length} 字）`;
  }
  if (Array.isArray(value)) return `[${value.length} 项]`;
  if (typeof value === "object") return `{${Object.keys(value).join(",")}}`;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  return null;
}

/** 本地日期（不是 UTC）：用户看日志时按自己电脑的「今天」找文件才对得上。 */
function localDateStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isoTime(value) {
  try {
    if (value instanceof Date) return value.toISOString();
    if (value !== undefined && value !== null) return new Date(value).toISOString();
  } catch {
    // 传进来的时间不合法就退回当前时间，不能因为一个字段让日志写不出去
  }
  return new Date().toISOString();
}

/**
 * @param {object} options
 * @param {string} options.dir             日志目录（通常是 <dataHome>/logs）
 * @param {number} [options.retentionDays] 保留天数，默认 7 天
 * @param {(line: string) => void} [options.onError] 写失败时记一句，默认打到 stderr
 */
export function createCallLog({ dir, retentionDays = 7, onError } = {}) {
  if (!dir) throw new Error("createCallLog 需要 dir");
  const keepDays = Number.isFinite(Number(retentionDays)) ? Number(retentionDays) : 7;
  const report = typeof onError === "function" ? onError : (line) => console.warn(`[call-log] ${line}`);

  // 串行写：多个工具并发调用时按完成顺序落盘，不会互相插行；写失败只报一句，之后的还能继续写。
  let queue = Promise.resolve();

  /**
   * 删掉超过保留期的日志文件（只认 mcp-calls-*.jsonl）。
   * 用同步 IO：只在启动和每 24 小时各跑一次，目录里最多几个小文件，
   * 换来的是「createCallLog 返回时旧日志已经清掉」这个确定行为。
   */
  function prune() {
    try {
      mkdirSync(dir, { recursive: true });
      const cutoff = Date.now() - keepDays * DAY_MS;
      for (const name of readdirSync(dir)) {
        // 只碰自己写的日志文件，目录里别的东西（用户放的备份、别的日志）一概不动
        if (!FILE_PATTERN.test(name)) continue;
        const file = path.join(dir, name);
        try {
          const info = statSync(file);
          if (info.isFile() && info.mtimeMs < cutoff) unlinkSync(file);
        } catch {
          // 单个文件被占用 / 刚好被删：不影响其它文件
        }
      }
    } catch (error) {
      report(`清理过期日志失败：${error.message}`);
    }
  }

  function record(entry = {}) {
    let line;
    try {
      const payload = {
        at: isoTime(entry.at),
        sessionId: entry.sessionId ?? null,
        // client 里的 name / version 是 MCP 客户端自报的；tokenName / tokenId 是这次用的口令身份
        // （连接器名 / 主口令标签 + 指纹），口令原文绝不落日志。
        client: entry.client ?? null,
        // 谁调用的：主令牌写 "owner"，连接器写它的 id
        connector: entry.connector ?? null,
        tool: entry.tool ?? null,
        // 工具分组和这次调用的授权结论（allow / deny + 原因）
        group: entry.group ?? null,
        decision: entry.decision === "deny" ? "deny" : (entry.decision === "allow" ? "allow" : null),
        reason: entry.reason ? clipText(entry.reason, 240) : null,
        args: entry.args ?? {},
        ok: entry.ok === true,
        code: entry.code ?? null,
        durationMs: numOrNull(entry.durationMs),
        resultBytes: numOrNull(entry.resultBytes),
        stored: entry.stored ?? null,
      };
      // 耗时 / 输出估算的摘要：只有 page_* / browser_* 调用才有；只记数字，不记网页内容
      if (entry.meta && typeof entry.meta === "object") {
        // 字段缺失（undefined / null / 空串）一律记 null，不能记成 0：
        // 以前 Number(null) === 0，缺失的 ms 会被读成「这一步不耗时」
        const meta = {
          action_id: numOrNull(entry.meta.action_id),
          ms: numOrNull(entry.meta.ms),
          out_chars: numOrNull(entry.meta.out_chars),
          approx_tokens: numOrNull(entry.meta.approx_tokens),
        };
        const images = numOrNull(entry.meta.images);
        if (images !== null) meta.images = images;
        if (typeof entry.meta.cached === "boolean") meta.cached = entry.meta.cached;
        payload.meta = meta;
      }
      // 写操作闸门的审计字段：只有 MUTATING 调用才有（只读动作不加，日志和以前一样）
      if (entry.action) {
        payload.actionClass = entry.action.actionClass ?? null;
        payload.outcome = entry.action.outcome ?? null;
        // 目标名截到 80 字；绝不记输入的文本内容（可能是密码 / 验证码）
        payload.target = entry.action.target ? clipText(entry.action.target, 80) : null;
        payload.commitBoundary = entry.action.commitBoundary === true;
      }
      // 控制权交接 / 审批 / 空间自动收摊：一等事件，不和 tool call 混在一起
      if (entry.event && typeof entry.event === "object") {
        const type = String(entry.event.type ?? "");
        payload.type = ["handoff", "return", "approval", "space_auto_close", "space_auto_discard"].includes(type) ? type : null;
        payload.space = entry.event.space ? clipText(entry.event.space, 64) : null;
        payload.from = entry.event.from === undefined || entry.event.from === null ? null : String(entry.event.from).slice(0, 40);
        payload.to = entry.event.to === undefined || entry.event.to === null ? null : String(entry.event.to).slice(0, 40);
        payload.reason = entry.event.reason ? clipText(entry.event.reason, 240) : null;
        // 自动收摊事件带「关掉 / 卸载了几个标签页」；别的审计事件没有这个字段
        if (entry.event.tabs !== undefined) {
          payload.tabs = numOrNull(entry.event.tabs);
        }
        if (entry.event.at) payload.at = isoTime(entry.event.at);
      }
      line = JSON.stringify(payload);
    } catch (error) {
      // 字段里有循环引用 / 不合法的时间：这条不写，但也绝不让调用方失败
      report(`序列化调用日志失败：${error.message}`);
      return Promise.resolve();
    }
    // 日期在调用发生时定下来：跨零点排队写入也不会跑到第二天的文件里
    const file = path.join(dir, `mcp-calls-${localDateStamp()}.jsonl`);
    queue = queue
      .then(async () => {
        await mkdir(dir, { recursive: true });
        await appendFile(file, `${line}\n`, "utf8");
      })
      .catch((error) => report(`写入调用日志失败（不影响工具调用）：${error.message}`));
    return queue;
  }

  // 启动时先清一次，之后每 24 小时一次；unref 避免定时器把独立运行的进程吊住
  prune();
  const timer = setInterval(prune, DAY_MS);
  timer.unref?.();

  return { record, prune };
}
