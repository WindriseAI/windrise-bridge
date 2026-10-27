/**
 * 日志去噪规则 —— 纯函数，不碰 Electron、不读文件。
 *
 * 为什么要单独一个模块：cloudflared 新版每次起隧道都会打一整张「连通性预检」表格，
 * 三十多行全是 PASS，把真正有用的日志挤出内存里那 500 条（界面和 windrise_logs 都读它）。
 * 这里只决定「隧道某一行要不要记」和「Bridge 事件怎么变成一行文字」，
 * 调用方（main.cjs）负责 pushLog / 落盘，electron/log-tidy-selftest.cjs 直接跑这里。
 */

/** 只处理 cloudflared 的 INF 行：[stderr] <时间> INF <内容>；ERR / WRN 一律不碰 */
const STDERR_INF = /^\[stderr\]\s+\S+\s+INF\s(.*)$/;

/**
 * 隧道日志去噪（返回 null 表示不记，否则原样返回）。
 * 只丢预检表格里没有诊断价值的部分：边框、标题、表头、PASS 行。
 * SUMMARY 有结论（用了哪个协议）、precheck complete 有总体结果、非 PASS（FAIL / WARN / SKIP）
 * 都说明有问题，必须留；快速隧道地址、Registered、ERR / WRN 也不能丢。
 */
function tidyTunnelLine(line) {
  if (typeof line !== "string") return line;
  const match = STDERR_INF.exec(line);
  if (!match) return line;
  const rest = match[1];
  // 表格边框（预检表格和快速隧道地址框都有）：纯装饰，没有信息
  if (/^\+-+/.test(rest)) return null;
  if (rest.startsWith("|")) {
    // 去掉首尾竖线再压空白：这样纯空白的表格行会变成空串
    const cells = rest.replace(/^\|/, "").replace(/\|\s*$/, "").replace(/\s+/g, " ").trim();
    if (!cells) return null;
    if (cells.includes("CONNECTIVITY PRE-CHECKS")) return null;
    // 表头（COMPONENT + STATUS 同时出现）本身不是结果
    if (cells.includes("COMPONENT") && cells.includes("STATUS")) return null;
    // SUMMARY 要留：它说明最终用的协议；放到 PASS 判断之前，免得被误伤
    if (cells.includes("SUMMARY")) return line;
    // 某一列状态是 PASS：这个组件没问题，逐行记下来只会挤掉有用的日志
    if (/\bPASS\b/.test(cells)) return null;
    return line;
  }
  // 表格外的逐组件预检结果：只丢 status=pass 的，fail / warn 要留
  if (rest.startsWith("precheck component=")) {
    if (/(?:^|\s)status=pass(?:\s|$)/i.test(rest)) return null;
    return line;
  }
  return line;
}

/** Bridge 事件转一行日志：带 text 的只用 text，否则整个 JSON 化 */
function logText(event) {
  if (event && typeof event.text === "string") return event.text;
  return JSON.stringify(event);
}

/**
 * 带 meta 的工具调用（page_* / browser_*）在界面日志里怎么记。
 *
 * 为什么不能每条都 pushLog：一轮长浏览器自动化几百次 page_act / browser_click，
 * 会把内存里那 500 条日志环占满，真正要看的隧道断开 / 待批准命令反而被挤掉。
 * 所以按「时间」限流到每 30 秒最多一行，并且每个会话有一个小账本：
 * addMetaCall() 把窗口内每次调用的次数 / 耗时 / 输出字数 / token / 图片张数累加起来，
 * metaLogPlan() 到点输出累计值，主进程随后把账本清零 —— 丢掉的调用不会在数字里算漏。
 */
const META_ROW_INTERVAL_MS = 30_000;

const numberOr0 = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const emptyMetaTotals = () => ({
  calls: 0,
  ms: 0,
  outChars: 0,
  approxTokens: 0,
  images: 0,
  tools: [],
  lastAction: null,
  cached: false,
});

/**
 * 把一次工具调用的 meta 累加进会话账本（纯函数，不改入参）。
 *   - meta：Bridge 给的这一条调用的摘要（tool / action_id / ms / out_chars / approx_tokens / images）
 * 返回新的账本；到点输出后由调用方丢弃（相当于清零）。
 */
function addMetaCall(totals, meta) {
  const base = totals ?? emptyMetaTotals();
  const tool = typeof meta?.tool === "string" ? meta.tool : "";
  const tools = tool && !base.tools.includes(tool) ? [...base.tools, tool] : [...base.tools];
  const action = Number(meta?.action_id);
  return {
    calls: base.calls + 1,
    ms: base.ms + numberOr0(meta?.ms),
    outChars: base.outChars + numberOr0(meta?.out_chars),
    approxTokens: base.approxTokens + numberOr0(meta?.approx_tokens),
    images: base.images + numberOr0(meta?.images),
    tools,
    lastAction: Number.isFinite(action) ? action : base.lastAction,
    cached: base.cached || Boolean(meta?.cached),
  };
}

/**
 * 到点没有就返回 null；到了就返回要写进日志的那一行（数字全是窗口内的累计）。
 *   - totals：addMetaCall() 累计出来的账本
 *   - sessionTag：会话短号，没有会话时为空串
 */
function metaLogPlan(totals, sessionTag, now, lastAt) {
  const interval = Number(now) - Number(lastAt ?? 0);
  // 上一次记录还没过 30 秒：先攒着，累计数字都在主进程的账本里，不会丢
  if (Number(lastAt) > 0 && interval < META_ROW_INTERVAL_MS) return null;
  const calls = numberOr0(totals?.calls);
  const tools = Array.isArray(totals?.tools) ? totals.tools : [];
  const label = tools.length === 0 ? "页面动作" : tools.length === 1 ? tools[0] : `${tools[0]} 等 ${tools.length} 个工具`;
  const action = totals?.lastAction === null || totals?.lastAction === undefined ? "" : (Number.isFinite(Number(totals.lastAction)) ? ` #${totals.lastAction}` : "");
  const images = numberOr0(totals?.images) > 0 ? ` ${numberOr0(totals.images)} 张图` : "";
  return {
    text: `工具 ${label}${action} ${sessionTag}共 ${calls} 次 耗时 ${numberOr0(totals?.ms)}ms 输出 ${numberOr0(totals?.outChars)} 字${images} ≈ ${numberOr0(totals?.approxTokens)} tokens${totals?.cached ? "（缓存）" : ""}（页面动作日志按会话每 30 秒汇总一行，明细见调用日志）`,
  };
}

module.exports = {
  tidyTunnelLine,
  logText,
  addMetaCall,
  metaLogPlan,
  META_ROW_INTERVAL_MS,
};
