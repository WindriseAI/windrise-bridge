/**
 * 浏览器工具的 MCP 侧 —— 把「开窗口、点页面、填表单、截图」暴露给外部 Agent。
 *
 * 这一层不直接碰浏览器：它读发现文件找到 Windrise 主程序里的控制服务，然后转发指令。
 * 好处是纯 Node 模式（没开界面）也能正常启动，只是这些工具会如实告诉你「浏览器没开」。
 *
 * 典型用法（模型视角）：
 *   browser_profiles            看看有哪些账号窗口
 *   browser_open                开一个窗口
 *   browser_snapshot            看页面现在长什么样（文本 + 可点元素清单）
 *   browser_click / browser_type 操作
 *   browser_screenshot          看画面
 */

import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Capability } from "../core/registry.js";
import { JEV_MAX_CRITERIA, askJev, decideFromAnswer, extractChoices } from "../core/jev-choice.js";
import { CONTROL_STATE_LABELS, prefixReturnSummary } from "../core/handoff.js";

const DISCOVERY_DIR = process.env.BRIDGE_DATA_HOME?.trim() || path.join(os.homedir(), ".bridge-replica");
const DISCOVERY_FILE = path.join(DISCOVERY_DIR, "browser-control.json");

/**
 * AI 空间的收摊提醒（用户 2026-10-28 定：AI 用完浏览器必须关掉，不然吃大量内存）。
 * 每个 page_* / space_* 工具说明里都带这一句；space_open 另有一份完整说明。
 */
const CLOSE_REMINDER = "一次性任务做完必须调用 space_close；只有用户需要亲自看结果时才传 keep:true，并在回复里告诉用户这个空间留着。";

/**
 * 找出所有可能活着的控制服务。
 *
 * 为什么不止读一个文件：
 *   主文件是「一个文件记录一个实例」，两个实例（开发版 + 打包版）同时开时
 *   会互相覆盖，先退出的还会把主文件删掉 —— 结果活着的那个反而找不到。
 *   所以每个实例还写一份 browser-control-<pid>.json，这里全扫出来，
 *   由调用方逐个探活，谁活着用谁。
 *
 * 返回顺序：主文件优先（单实例时就是它），然后按启动时间新的在前。
 */
async function discoverAll() {
  const candidates = [];

  const readOne = async (file) => {
    const raw = await readFile(file, "utf8").catch(() => null);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed?.url ? parsed : null;
    } catch { return null; }
  };

  const main = await readOne(DISCOVERY_FILE);
  if (main) candidates.push(main);

  const files = await readdir(DISCOVERY_DIR).catch(() => []);
  const perPid = files.filter((f) => /^browser-control-\d+\.json$/.test(f));
  const rest = [];
  for (const name of perPid) {
    const parsed = await readOne(path.join(DISCOVERY_DIR, name));
    // 主文件已经收过了就别重复
    if (parsed && !candidates.some((c) => c.url === parsed.url)) rest.push(parsed);
  }
  rest.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  candidates.push(...rest);

  return candidates;
}

/** 探一下这个控制服务还活着吗 */
async function probe(discovery, timeoutMs = 2500) {
  try {
    const response = await fetch(`${discovery.url}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** 第一个候选（不探活）。需要「确定能用」的场景请用 discoverLive()。 */
async function discover() {
  const all = await discoverAll();
  return all[0] ?? null;
}

/** 第一个**活着**的候选。全都不通就返回 null。 */
async function discoverLive() {
  for (const candidate of await discoverAll()) {
    if (await probe(candidate)) return candidate;
  }
  return null;
}

async function callControl(action, params = {}, { method = "POST", timeoutMs = 30_000 } = {}) {
  // 用 discoverLive：多实例时可能有好几个候选，陈旧的会连不上，
  // 挑一个活着的不然每次调用都白跑一趟
  const discovery = await discoverLive();
  if (!discovery) {
    throw new Error(
      "浏览器控制服务没有运行。它是随控制面板一起启动的 —— 请先打开 Windrise Bridge 界面（npm run ui），" +
      "再重试。纯命令行模式下这些工具用不了，因为账号窗口由 Windrise 主程序启动。"
    );
  }
  const url = `${discovery.url}/${action}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify(params) : undefined,
      // 截图这类操作可能慢，但绝不能无限等
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new Error(`浏览器操作「${action}」超过 ${Math.round(timeoutMs / 1000)} 秒没有返回。窗口可能被遮挡或页面卡住了，可以先用 browser_snapshot 看页面状态。`);
    }
    throw new Error(`连不上浏览器控制服务（${error.message}）。界面可能已经关掉了。`);
  }
  if (response.status === 404) {
    throw new Error("控制服务拒绝了请求（令牌不匹配，可能界面已重启）。请重新开界面。");
  }
  const payload = await response.json();
  if (!payload.ok) {
    const error = new Error(payload.error ?? "浏览器操作失败");
    if (payload.code) error.code = payload.code;
    // 写操作闸门的字段原样带到 MCP 侧（三态、提交边界、下一步），别在这一层丢掉
    for (const key of ["outcome", "dispatched", "next_step", "target", "reason", "keyword", "retryable", "skipped", "dialog", "returnSummary", "options", "optionsTotal", "optionsTruncated", "suggestions", "matchedBy", "verified", "occludedBy", "fields", "filled", "failed", "total", "aborted", "unverified"]) {
      if (payload[key] !== undefined) error[key] = payload[key];
    }
    throw error;
  }
  return payload.result;
}

/** page_* 工具出错时按规划 6.7 的契约回：错误码、能不能原样重试、下一步怎么办 */
const PAGE_NEXT_STEP = {
  REF_STALE: { retryable: false, next_step: "编号过期了：先调 page_snapshot 重新拍快照，用新编号再做（page_act 已经自动重拍重试过一次，再失败说明元素真的换了）" },
  NOT_FOUND: { retryable: false, next_step: "选择器没匹配到任何元素：先调 page_snapshot 看看页面实际结构，改对选择器再读；页面刚打开的话等一会儿重试" },
  // 格子没开（或它的标签页被关了）：唯一的下一步是 browser_open 那一格，不要让人去 page_snapshot
  TARGET_CLOSED: { retryable: false, next_step: "这一格没开，或它的标签页已经被关掉了：先 browser_open 打开它（id 填格子编号，例如 1、「格子 1」、「slot:1」；开着只会聚焦、不会新开），把主标签页带回来，然后重试这一步" },
  NOT_ACTIONABLE: { retryable: false, next_step: "元素被挡住、看不见或不能用：调 page_snapshot 看看页面现在什么样，换个元素，或先关掉挡住它的弹窗" },
  CONTROL_PREEMPTED: { retryable: true, next_step: "人正在用这个窗口：等人点「交还给 AI」后再做，或者换一个窗口" },
  TASK_STOPPED: { retryable: false, next_step: "用户终止了这个任务：停下来，向用户报告做到哪了；不要重试，也不要换别的标签页继续同一个任务" },
  INVALID_ARGUMENT: { retryable: false, next_step: "参数不对：按错误信息改参数再调" },
  OPTION_NOT_FOUND: { retryable: true, next_step: "下拉框里没有这个选项：按返回的 options 候选换个值重试（最多 50 个，优先填 value 或选项文字）" },
  FIELD_REJECTED: { retryable: false, next_step: "这一项不能批量填（按钮 / 链接 / 提交类元素）：批量填表只填值、不会提交。跳过它继续填别的；要提交请单独调用一次 page_act，提交类动作还要 confirm:true" },
  // 登录页只许人操作（electron/ai-site-guard.cjs）：这同时是「需要人来登录」的交接信号
  SIGNIN_PAGE_HUMAN_ONLY: { retryable: false, next_step: "这是账号登录页，只能由人登录：请告诉用户在这个窗口里自己登录（优先邮箱或手机号），登好后再调；也可以后退离开" },
  URL_NOT_ALLOWED: { retryable: false, next_step: "账号窗口只能打开 http / https 网址" },
  SPACE_NOT_FOUND: { retryable: false, next_step: "没有这个空间：调 space_list 看有哪些空间，用里面给的 id 或名字" },
  SPACE_CLOSED: { retryable: false, next_step: "这个空间的标签页没开（格子重开后标签页不会自动恢复）：先 space_open 用同一个名字重开它" },
  PIN_NOT_FOUND: { retryable: false, next_step: "没有这个钉住：调 pin_list 看有哪些，用里面给的 id" },
  PIN_LIMIT: { retryable: false, next_step: "这个空间的钉住满了（最多 50 个）：先用 pin_remove 删掉不用的再钉" },
  PIN_UNSUPPORTED: { retryable: false, next_step: "这个格子的插件没连上或太旧，钉住用不了：稍后再试，或确认主程序还开着" },
  ACT_FAILED: { retryable: false, next_step: "动作没做成：调 page_snapshot 看页面实际变成了什么样，再决定下一步" },
  // JS 对话框（alert / confirm / prompt）开着：页面脚本和输入都被它挡住，等下去只会超时
  DIALOG_OPEN: { retryable: true, next_step: "页面开着 JS 对话框：先调 page_act 带 action:\"dialog\" 和 accept:true（确认）/ false（取消）把它关掉，再继续原来的动作。对话框的类型和文字在返回的 dialog 字段里" },
  DIALOG_NOT_OPEN: { retryable: false, next_step: "现在没有开着的对话框（可能已经自己关掉或被别的操作确认过了）：直接继续原来的动作；要看页面就用 page_snapshot" },
  // 上传路径越界：只能传用户授权过的工作区目录里的文件
  PATH_DENIED: { retryable: false, next_step: "上传只收用户授权过的工作区目录里的文件：让用户在「设置 → 工作区」里添加那个文件夹，或者把文件先复制进工作区再传" },
  // 写操作闸门：提交类动作（发布 / 付款 / 删除…）没带 confirm:true 时拦在这里，事件一个都没发
  NEEDS_CONFIRM: { retryable: true, next_step: "这是不可撤销的提交动作。先向用户确认，确认后带 confirm:true 重试" },
  // 空间控制权在人手里（human_control / paused / needs_help）：写操作一律停，读操作照常
  HUMAN_IN_CONTROL: { retryable: false, next_step: "这个空间现在由人控制 / 等人处理：不要再试写操作，读操作（page_snapshot / page_read）照常可用。等人把控制权交还、space_list 里 control.state 变回 ai_running 后再写" },
  INVALID_CONTROL_STATE: { retryable: false, next_step: "这一步控制权状态转换不合法：先用 space_list 看当前 control.state，按状态机允许的方向走" },
  // 小决策模型 Jev：没配密钥、网络不通、返回不可用都归到这里，只影响 page_choose 自己
  JEV_UNAVAILABLE: { retryable: false, next_step: "小决策模型 Jev 暂不可用（没配 TYPESAFE_API_KEY 或网络不通）：先调 page_snapshot 自己看快照挑元素，按编号用 page_act 做；不影响其他工具" },
};

function pageError(error) {
  const code = error.code ?? "ACT_FAILED";
  const hint = PAGE_NEXT_STEP[code] ?? { retryable: false, next_step: "调 page_snapshot 看看页面现在什么样" };
  const structured = { code, message: error.message, ...hint };
  // 写操作闸门的字段：三态（outcome / dispatched）、目标名、下一步，有就带上（没有就保持原样）
  for (const key of ["outcome", "dispatched", "target", "reason", "keyword", "skipped", "dialog", "returnSummary", "options", "optionsTotal", "optionsTruncated", "suggestions", "matchedBy", "verified", "occludedBy", "fields", "filled", "failed", "total", "aborted", "unverified"]) {
    if (error[key] !== undefined) structured[key] = error[key];
  }
  if (typeof error.next_step === "string" && error.next_step) structured.next_step = error.next_step;
  if (typeof error.retryable === "boolean") structured.retryable = error.retryable;
  const outcomeNote = structured.outcome ? `\n结果：${structured.outcome}${structured.dispatched === false ? "（事件没有发出）" : ""}` : "";
  // 对话框的类型和文字要直接写在正文里：AI 据此判断该确认还是取消（确认可能真的提交业务动作）
  const dialogNote = structured.dialog
    ? `\n对话框：${structured.dialog.type ?? "?"}${structured.dialog.message ? `「${structured.dialog.message}」` : ""}`
    : "";
  return {
    content: [{ type: "text", text: prefixReturnSummary(`${code}：${error.message}${dialogNote}${outcomeNote}\n下一步：${structured.next_step}`, structured.returnSummary) }],
    structuredContent: structured,
    isError: true,
  };
}

/** 返回里的目标格子标识（主程序会补 slot / accountName；老版本没有就什么都不加） */
function gridTag(result) {
  const slot = result?.slot;
  if (slot === undefined || slot === null) return "";
  return `（格子 ${slot}${result.accountName ? ` · ${result.accountName}` : ""}）\n`;
}

/**
 * page_act 的回读说明：差异正文、导航提示、对话框提示。单次动作和批量填表共用，
 * 保证「填完只回读一次」的两条路给出的说明一致。
 */
function pageActNotes(result) {
  const diff = result.diff;
  // 差异只含能操作的元素；正文变了（例如冒出了回答）另外提示去 page_read 读
  const textNote = diff?.textDelta ? `\n页面文字${diff.textDelta > 0 ? `多了 ${diff.textDelta}` : `少了 ${-diff.textDelta}`} 字，要看具体内容用 page_read。` : "";
  const nav = result.navigation;
  // 导航过就必须写在最前面：以前返回里只有「no change」，AI 据此判定动作没生效又点一次。
  // diff 已经报了 urlChanged 时不再重复同一句。
  const navNote = nav?.navigated && !diff?.urlChanged
    ? `\n页面跳转到了 ${nav.url ?? "(未知地址)"}${nav.title ? `（标题：${nav.title}）` : ""}`
    : nav && nav.settled === false && !diff
      ? `\n页面还在加载（${nav.settleReason ?? "没等到稳定"}），现在的地址是 ${nav.url ?? "(未知地址)"}`
      : "";
  const dialogNote = result.dialog
    ? `\n对话框：${result.dialog.type}${result.dialog.message ? `「${result.dialog.message}」` : ""}${result.closed ? "（已关闭）" : ""}`
    : "";
  const summary = !diff ? (result.note ?? "没有回读变化")
    : diff.urlChanged ? `页面跳转到了 ${diff.url}\n\n${diff.text}`
    : diff.lineDiffSkipped ? `页面变化很大（逐行差异太长了，跳过），这里只列可操作元素的变化：\n${diff.text}${textNote}`
    : diff.changed ? `页面有变化（新增 ${diff.added} 行，去掉 ${diff.removed} 行）：\n${diff.text}${textNote}`
    : diff.textDelta ? `能操作的元素没变。${textNote.trim()}`
    : nav?.navigated ? `页面跳转到了 ${nav.url ?? "(未知地址)"}，快照没有变化`
    : "页面没有变化";
  return { navNote, dialogNote, summary };
}

/** 批量填表的正文：逐项结果 + 一次 diff。失败的项也照常列出来，不隐藏。 */
function formatBatchAct(result) {
  const { navNote, dialogNote, summary } = pageActNotes(result);
  const verbOf = (item) => {
    // 点了但没读回确认：只能说「已点选」，不能说「已选择」
    if (item.verified === false) return `已点选${item.selected ? `「${item.selected}」` : ""}（没能读回确认，请 page_snapshot 复核）`;
    if (item.action === "type") return "已填写";
    if (item.action === "select") return `已选择${item.selected ? `「${item.selected}」` : ""}`;
    if (item.action === "check") return item.checked === false ? "已取消勾选" : "已勾选";
    return "已完成";
  };
  const aborted = result.aborted ?? 0;
  const lines = [
    `一次填写 ${result.total ?? 0} 个字段：成功 ${result.filled ?? 0}${result.skipped && result.skipped - aborted > 0 ? `（其中 ${result.skipped - aborted} 个本来就是目标状态）` : ""}，失败 ${result.failed ?? 0}${aborted ? `，中止未填 ${aborted}` : ""}`,
  ];
  for (const item of result.fields ?? []) {
    if (item.skipped === "batch_aborted") {
      lines.push(`- ${item.ref}${item.target ? ` ${item.target}` : ""}：未填（批量已中止：${item.code ?? "ABORTED"}）${item.reason || item.error || ""}`);
    } else if (item.ok) {
      lines.push(`- ${item.ref}${item.target ? ` ${item.target}` : ""}：${verbOf(item)}${item.skipped ? "（已经是目标状态，没有重复触发）" : ""}`);
    } else {
      lines.push(`- ${item.ref}${item.target ? ` ${item.target}` : ""}：失败（${item.code}）${item.reason || item.error}`);
    }
  }
  if (result.failed || aborted) {
    lines.push("批量填表只填值、不会提交；要提交请单独调用一次 page_act（提交类动作需要 confirm:true）。");
  }
  const next = result.next_step ? `\n下一步：${result.next_step}` : "";
  return `${gridTag(result)}${lines.join("\n")}${dialogNote}${navNote}\n结果：${result.outcome ?? ""}\n${summary}${next}`;
}

/**
 * page_* 工具组。
 *
 * deps 只用来注入测试替身（拿快照、问 Jev、读环境变量），正常启动时不传：
 *   - snapshot：拿语义快照（默认走控制服务的 page/snapshot，和 page_snapshot 工具同一条路）；
 *   - fetchImpl：问 Jev 用的 fetch；
 *   - env：读 TYPESAFE_API_KEY 的环境变量对象。
 */
function definePageTools({ snapshot = (params) => callControl("page/snapshot", params), fetchImpl = fetch, env = process.env } = {}) {
  const idProp = { type: "string", description: "目标格子：账号 id，或「格子 2」「slot:2」「2」这样的编号" };
  const spaceProp = {
    type: "string",
    description: "在哪个空间里操作（空间 id 或名字）。不给就是「我的」空间（人正在用）的主标签页。AI 做任务时应先 space_open 开一个自己的空间，把 space 传成那个空间，不要动人正在用的「我的」。",
  };
  return [
    {
      name: "page_snapshot",
      title: "看页面（语义快照）",
      capability: Capability.READ,
      scope: "profile",
      description: [
        "看一个格子里的页面：返回按页面结构排好的清单，每个能点、能填的东西后面带编号，例如 `- button \"发送\" [ref=e12]`。拿到编号再用 page_act 操作它。清单只列能操作的东西和标题；要读页面上的文字（例如 AI 的回答），用 page_read。",
        "控件的当前状态写在方括号里，可以直接用来核对：`[checked]` / `[unchecked]`（勾选框、单选框、开关，两头都会写出来）、`[selected]`（选中项）、`[value=\"…\"]`（下拉框当前值）、`[disabled]`、`[expanded]` / `[collapsed]`。输入框的内容写在行尾，例如 `- textbox \"搜索\" [ref=e3]: \"关键字\"`。这些状态参与 diff：勾上 / 取消 / 换选项之后，page_act 的差异会如实显示。",
        "没有无障碍名但能点的元素（SPA 里常见的 div / 卡片 / 图标）会写成 `- clickable [ref=e5] [cursor=pointer] (提示: 添加封面)`，括号里是按页面内容猜的提示名，不是真实无障碍名；隐藏的上传框写成 `- file-input [ref=e7] [hidden] (提示: 添加封面)`，它点不动，但可以把它（或包着它的按钮 / label）的编号交给 page_act 的 action:\"upload\" 放文件。",
        "大页面（维基词条那种十万字的）不要从头翻：先用 find 找关键字（例如 find: \"English\"），或者用 selector 只拍正文那一块。",
        "参数：",
        "- selector：只拍这个 CSS 选择器对应的子树；选择器一个都匹配不上时报 NOT_FOUND（不会返回空清单）。",
        "- viewportOnly：只列当前屏幕里看得见的元素（视口外的兄弟节点会被摘掉，结构还在）。",
        "- offset / maxChars：按字切块读长快照。返回里带 nextOffset 和 totalChars，截断时末尾会写「还有多少字，用 offset=N 继续」。",
        "- find：只返回包含这段文字的行（不区分大小写），每行前面带上它的祖先行，用来在长快照里定位某个链接。",
        "默认看「我的」空间（人正在用）；AI 自己的空间用 space 指定。不会动你的鼠标，也不会把窗口切到前台。",
        CLOSE_REMINDER,
      ].join(""),
      inputSchema: {
        type: "object",
        properties: {
          id: idProp,
          space: spaceProp,
          maxChars: { type: "integer", description: "本次最多返回多少字，默认 20000" },
          offset: { type: "integer", description: "从第几个字开始返回，默认 0；接着读时用上一次返回的 nextOffset" },
          selector: { type: "string", description: "只拍这个 CSS 选择器对应的子树（可选）；匹配不到报 NOT_FOUND" },
          viewportOnly: { type: "boolean", description: "只列当前屏幕里看得见的元素（可选）" },
          find: { type: "string", description: "只返回含这段文字的行（不区分大小写），带祖先行（可选）" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      handler: async (input) => {
        try {
          const result = await callControl("page/snapshot", input);
          const head = `${gridTag(result)}标题：${result.title}\n地址：${result.url}\n`;
          if (result.mode === "find") {
            const tail = result.matches
              ? `\n\n（含「${result.find}」的行共 ${result.matches} 处${result.truncated ? "，只回了前面一部分" : ""}）`
              : "";
            return { content: [{ type: "text", text: prefixReturnSummary(`${head}按「${result.find}」在快照里找：\n${result.text}${tail}`, result.returnSummary) }], structuredContent: result };
          }
          const scope = result.mode === "selector" ? `范围：选择器 ${result.selector}\n`
            : result.mode === "viewport" ? "范围：当前屏幕\n"
            : "";
          // 截断提示由服务端写在正文末尾（写明还有多少字、用哪个 offset 继续），这里不重复
          const tail = result.truncated && !/用 offset=\d+ 继续/.test(result.text) ? `\n（还有 ${result.remaining} 字，用 offset=${result.nextOffset} 继续）` : "";
          return { content: [{ type: "text", text: prefixReturnSummary(`${head}${scope}\n${result.text}${tail}`, result.returnSummary) }], structuredContent: result };
        } catch (error) {
          return pageError(error);
        }
      },
    },
    {
      name: "page_choose",
      title: "在相似元素里挑一个（问 Jev）",
      capability: Capability.READ,
      scope: "profile",
      description: [
        "只选不点：页面上一排长得很像的按钮、一批同名链接、好几个上传入口，拿不准该动哪一个的时候先调它，让小决策模型 Jev 挑。",
        "它不改页面、不发任何事件；选完必须用 page_act 按返回的 ref 执行，写操作照样过写操作闸门（提交类动作仍然要 confirm:true）。",
        "工作方式：用 page_snapshot 同一条路径拿快照，抽出带 [ref=eN] 编号的行当候选（最多 255 个，每个标签 160 字以内），把 intent 和候选一起发给 Jev，返回选中的 ref、label、confidence（第一名概率）、ratio（第一名概率 / 第二名）和 second（第二名）。",
        "decided 为 true 表示第一名领先第二名 minRatio 倍以上（默认 3），可以照 ref 去 page_act；decided 为 false 说明把握不大，next_step 会写「请自己看快照判断」，别硬按它的选择往下做。",
        "selector / find（和 page_snapshot 同名）用来缩小候选范围：只想在页面某一块里挑，或者只挑含某段文字的行，就直接传。",
        "TYPESAFE_API_KEY 从环境变量读，不会出现在返回里；没配或网络不通时报 JEV_UNAVAILABLE，其他工具不受影响。",
        CLOSE_REMINDER,
      ].join(""),
      inputSchema: {
        type: "object",
        properties: {
          id: idProp,
          space: spaceProp,
          intent: { type: "string", description: "要做的事，写具体一点，例如「点发布按钮」「给这条评论点赞」「选第二张当封面」" },
          selector: { type: "string", description: "只在这块子树里挑候选（可选）" },
          find: { type: "string", description: "只在含这段文字的行里挑候选（可选，不区分大小写）" },
          minRatio: { type: "number", description: "第一名要比第二名领先多少倍才算确定，默认 3" },
        },
        required: ["id", "intent"],
        additionalProperties: false,
      },
      handler: async (input) => {
        try {
          const intent = typeof input.intent === "string" ? input.intent.trim() : "";
          if (!intent) {
            throw Object.assign(
              new Error("缺少 intent：要说清这次想做什么（例如「点发布按钮」），Jev 才知道该看什么"),
              { code: "INVALID_ARGUMENT" },
            );
          }
          const wanted = Number(input.minRatio);
          const minRatio = Number.isFinite(wanted) && wanted > 0 ? wanted : 3;

          // 和 page_snapshot 传同样的参数：selector / find 也交给控制服务，省一次本地过滤
          const params = { id: input.id };
          for (const key of ["space", "selector", "find", "sessionId"]) {
            if (input[key] !== undefined && input[key] !== null) params[key] = input[key];
          }
          const shot = await snapshot(params);
          const choices = extractChoices(shot?.text ?? "");
          if (!choices.length) {
            const scope = input.selector ? `（选择器 ${input.selector}）` : input.find ? `（find「${input.find}」）` : "";
            throw Object.assign(
              new Error(`快照里没有带编号的候选元素${scope}：先用 page_snapshot 看看页面结构，或者放宽 selector / find`),
              { code: "NOT_FOUND", next_step: "快照里没有可操作元素：先调 page_snapshot（可以先不带 selector / find）看看页面实际结构，再决定怎么缩小范围" },
            );
          }

          const asked = await askJev({ intent, choices, apiKey: env.TYPESAFE_API_KEY ?? "", fetchImpl });
          const picked = decideFromAnswer(asked.answer, { minRatio });
          const labels = new Map(choices.map((choice) => [choice.ref, choice.label]));
          if (!labels.has(picked.ref)) {
            throw Object.assign(
              new Error(`Jev 选了一个不在候选里的编号（${picked.ref}），这次结果不可用`),
              { code: "JEV_UNAVAILABLE" },
            );
          }

          const label = labels.get(picked.ref);
          const second = picked.second
            ? { ref: picked.second.ref, label: labels.get(picked.second.ref) ?? null, p: picked.second.p }
            : null;
          const decided = picked.decided;
          const nextStep = decided
            ? `用 page_act 按编号执行（例如 {"action":"click","ref":"${picked.ref}"}）；提交类动作照样要 confirm:true`
            : "把握不大，请自己看快照判断";
          const result = {
            id: input.id,
            space: input.space ?? null,
            url: shot?.url ?? null,
            title: shot?.title ?? null,
            intent,
            model: asked.model,
            candidates: choices.length,
            candidatesTruncated: choices.length >= JEV_MAX_CRITERIA,
            snapshotTruncated: Boolean(shot?.truncated),
            ref: picked.ref,
            label,
            confidence: picked.confidence,
            ratio: picked.ratio,
            second,
            decided,
            minRatio,
            latencyMs: asked.latencyMs,
            next_step: nextStep,
          };

          const formatP = (p) => (typeof p === "number" ? String(Number(p.toFixed(3))) : "?");
          const lines = [
            `${gridTag(result)}在 ${result.candidates} 个候选里问 Jev（${result.model}，${result.latencyMs}ms）：${intent}`,
            `选中：${result.ref}  ${label}`,
            `信心：${formatP(picked.confidence)}${second
              ? `  第二名：${second.ref}${second.label ? `  ${second.label}` : ""} ${formatP(second.p)}`
              : "（没有第二名）"}${result.ratio !== null ? `  领先 ${result.ratio} 倍（阈值 ${minRatio}）` : ""}`,
            decided ? "把握够。" : "把握不够。",
            `下一步：${nextStep}`,
            result.candidatesTruncated ? `（候选只取了前 ${JEV_MAX_CRITERIA} 个带编号的行）` : "",
            result.snapshotTruncated ? "（快照被截断过，后面的元素没进候选）" : "",
          ].filter(Boolean);
          if (shot?.returnSummary) result.returnSummary = shot.returnSummary;
          return { content: [{ type: "text", text: prefixReturnSummary(lines.join("\n"), result.returnSummary) }], structuredContent: result };
        } catch (error) {
          return pageError(error);
        }
      },
    },
    {
      name: "page_act",
      title: "按编号操作页面",
      capability: Capability.EXECUTE,
      scope: "profile",
      description: [
        "按 page_snapshot 的编号操作页面，走页面里的虚拟输入：不动你的鼠标键盘、不抢焦点，中文 / 富文本都能输入。单个动作走 action，整表填值走 fields，两者不要同时传。",
        "批量填表（优先）：fields（最多 30 项）按顺序一次填完，全部填完只等一次、只回读一次 diff，返回逐项 ok / 失败原因，一项失败不影响后面的。fields 只填值（见 fields 参数说明），按钮、链接、提交类元素会被拒绝；批量填表不会提交，提交要单独再调一次 page_act（自定义下拉会点开再点 role=option）。",
        "action 取值见 action 参数说明。做完自动回读变化（diff）；不要就传 diff: \"none\"。长页面变化很大时不逐行比较，改列新出现 / 消失的可操作元素（各最多 40 条）。",
        "动作可能触发导航：返回带 navigation { url, title, navigated }，会先等页面稳定（readyState 完成或 DOM 安静 300ms）再读，diff 如实报 urlChanged。SPA 后退 / 前进请用 browser_nav。",
        "页面开着 JS 对话框（alert / confirm / prompt）时，动作和读取立刻返回 DIALOG_OPEN（带 dialog.type / dialog.message），不会卡到超时（处理办法见 action 说明）。",
        "上传只收用户授权过的工作区目录里的文件，其他路径一律拒绝（PATH_DENIED）。上传完回读文件框里的文件名和大小，0 个 / 0 字节报 ACT_FAILED，不假成功。",
        "编号失效（React / Vue 重渲染把节点换掉，报 element is not connected）时自动重拍一次快照，按 role + 名字 + 序号找回同一个元素重试一次；找不到才报 REF_STALE，并附最新快照里最像的 3 个元素。type 可以不给 ref：那就输进当前焦点元素（点开搜索面板后直接打字），没有可输入的焦点元素时明确报错。",
        "写操作闸门：会改页面的动作返回 outcome —— confirmed（带 expect 且读到了）、dispatched（事件已发出但没 expect 佐证）、unknown（事件已发出后出错，可能已生效，禁止直接重试，先 page_snapshot / page_read 读回）、failed（事件没发出，可以重试）。要确认真的生效就传 expect，不传最多算 dispatched。",
        "提交边界只拦点击类动作：click / double_click，以及 key 按 Enter（回车可能提交表单，按焦点元素所在 form 里 type=submit 按钮的名字匹配）。目标名命中提交类词（见 confirm 说明）时必须先带 confirm:true，否则返回 NEEDS_CONFIRM，一个事件都不发；type / select / check / focus / hover 不套提交边界。目标名超过 12 个字或带「设置 / 管理 / 记录 / 列表 / 中心 / 指南 / 帮助 / settings / history」的（导航标签、入口页）不拦。",
        "出错时给错误码和下一步：REF_STALE 重新拍快照，NOT_ACTIONABLE 元素被挡或不可用，CONTROL_PREEMPTED 人正在用这个格子，TASK_STOPPED 用户终止了任务，DIALOG_OPEN 先用 action:\"dialog\" 关掉对话框。",
        CLOSE_REMINDER,
      ].join(""),
      inputSchema: {
        type: "object",
        properties: {
          id: idProp,
          space: spaceProp,
          ref: { type: "string", description: "快照里的编号，例如 e12。type 可以不给：不给就输入到当前获得焦点的元素" },
          action: {
            type: "string",
            enum: ["click", "double_click", "type", "select", "check", "hover", "focus", "key", "scroll", "upload", "dialog"],
            description: [
              "click 点、double_click 双击。",
              "type 输入（text 必填，默认先清空，ref 可省见工具说明）。",
              "select 下拉选择（value 写选项的值或显示文字）、check 勾选（checked 填 true / false）、hover 悬停、focus 聚焦。",
              "key 按键（key 例如 Enter，给了 ref 就先聚焦它）、scroll 滚动（deltaY 正数往下，给了 ref 就在它上面滚）。",
              "upload 往文件框放文件（ref 指向 file-input 或它的按钮 / label，files 填路径数组）。",
              "dialog 处理开着的 JS 对话框：accept:true 确认 / false 取消，prompt 可带 text 作为输入值；确认一个 confirm 可能真的提交业务动作，要先问用户。",
            ].join("\n"),
          },
          fields: {
            type: "array",
            maxItems: 30,
            description: "批量填表：按顺序一次填多个字段，全部填完只等一次、只回读一次 diff。每项 {ref, value}，最多 30 项。只填值（文本框 / textarea / 原生 select / checkbox / radio / 自定义下拉 role=combobox 或 listbox），按钮、链接、提交类元素会被拒绝——批量填表不会提交，提交要单独调用一次 page_act（需 confirm:true）。value：文本框填字符串；原生 select / 自定义下拉填选项文字或 value（原生 select 会派发 input / change，自定义下拉会点开再点 role=option）；checkbox / radio 填 true 或 false（自定义下拉会点开再点 role=option）；选项不存在时返回候选列表（最多 50 个）。",
            items: {
              type: "object",
              properties: {
                ref: { type: "string", description: "快照里的编号，例如 e12" },
                value: {
                  description: "文本框填字符串；select / 自定义下拉填选项文字或 value；checkbox / radio 填 true 或 false",
                  anyOf: [{ type: "string" }, { type: "boolean" }, { type: "number" }],
                },
              },
              required: ["ref", "value"],
              additionalProperties: false,
            },
          },
          text: { type: "string", description: "type 要输入的内容；dialog 处理 prompt 时作为要填进输入框的值" },
          clear: { type: "boolean", description: "type 时先清空，默认 true" },
          value: { type: "string", description: "select 选哪一项（值或显示文字）" },
          values: { type: "array", items: { type: "string" }, description: "select 多选时用" },
          checked: { type: "boolean", description: "check 时要勾上还是取消" },
          accept: { type: "boolean", description: "dialog 时确认（true）还是取消（false）对话框" },
          files: { type: "array", items: { type: "string" }, description: "upload 时要放进去的文件路径（绝对路径，必须在用户授权的工作区目录里）" },
          key: { type: "string", description: "key 时按哪个键，例如 Enter、Tab、Escape" },
          modifiers: { type: "array", items: { type: "string", enum: ["Alt", "Control", "Meta", "Shift"] }, description: "同时按住的修饰键" },
          deltaX: { type: "number" },
          deltaY: { type: "number", description: "scroll 时滚多少像素，正数往下" },
          expect: {
            description: "可选：动作生效的判据。给文字（动作后页面上要出现的文字），或 { selector } / { text, timeoutMs }（timeoutMs 默认 3000，最多 10000）。读到了返回 outcome:\"confirmed\"；不传 expect 的写动作最多是 dispatched。",
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  text: { type: "string", description: "动作后页面上要出现的文字" },
                  selector: { type: "string", description: "动作后要出现的元素选择器" },
                  timeoutMs: { type: "integer", description: "最多等多久，默认 3000 毫秒" },
                },
                additionalProperties: false,
              },
            ],
          },
          confirm: {
            type: "boolean",
            description: "提交类动作（click / double_click，或 key 按 Enter 且目标命中发布 / 提交 / 付款 / 删除 / 授权 / Publish / Submit / Pay / Delete / Buy）必须先向用户确认，再带 confirm:true 调用；不带就返回 NEEDS_CONFIRM，不会执行。type / select / check / focus / hover 不需要 confirm。",
          },
          diff: { type: "string", enum: ["summary", "none"], description: "做完要不要回读变化，默认 summary" },
          maxChars: { type: "integer", description: "变化最多返回多少字，默认 20000" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      handler: async (input) => {
        try {
          const result = await callControl("page/act", input);
          if (result.batch) {
            return { content: [{ type: "text", text: prefixReturnSummary(formatBatchAct(result), result.returnSummary) }], structuredContent: result };
          }
          const { navNote, dialogNote, summary } = pageActNotes(result);
          // 动作标题：dialog / upload 没有 ref，硬拼成「已dialog 」读起来是错的
          const ACTION_VERB = { click: "点击", double_click: "双击", type: "输入", select: "选择", check: "勾选", hover: "悬停", focus: "聚焦", key: "按键", scroll: "滚动" };
          const headline = input.action === "dialog"
            ? `已处理 ${result.dialog?.type ?? "JS"} 对话框（${result.accepted ? "确认" : "取消"}）`
            : input.action === "upload"
              ? `已上传到 ${input.ref ?? ""}`
              : `已${ACTION_VERB[input.action] ?? input.action} ${input.ref ?? ""}`;
          const uploaded = Array.isArray(result.files) ? `\n已放入文件：${result.files.map((file) => `${file.name}${file.size === null ? "" : `（${file.size} 字节）`}`).join("、")}` : "";
          return { content: [{ type: "text", text: prefixReturnSummary(`${gridTag(result)}${headline}${uploaded}${dialogNote}${navNote}\n结果：${result.outcome ?? "（只读动作）"}${result.skipped ? `（${result.skipped}）` : ""}\n${summary}${result.next_step ? `\n下一步：${result.next_step}` : ""}`, result.returnSummary) }], structuredContent: result };
        } catch (error) {
          return pageError(error);
        }
      },
    },
    {
      name: "page_read",
      title: "读页面正文",
      capability: Capability.READ,
      scope: "profile",
      description: [
        "把页面正文转成 markdown 读回来，用来拿 AI 对话网站的回答、文章内容这类文字。可以用 selector 只读某一块。",
        "selector 一个都匹配不上时会明确报 NOT_FOUND（带上页面地址和标题），不会静默返回空字符串；页面刚导航完、还没加载完时会先等（document.readyState 为 complete，或 DOM 安静 300ms，最长等 5 秒）再读。",
        "默认读「我的」空间；AI 自己的空间用 space 指定。不动鼠标，不切前台。",
        CLOSE_REMINDER,
      ].join(""),
      inputSchema: {
        type: "object",
        properties: {
          id: idProp,
          space: spaceProp,
          selector: { type: "string", description: "只读这个 CSS 选择器对应的那一块（可选）" },
          last: { type: "boolean", description: "selector 匹配到好几块时读最后一块，例如对话网站的最新一条回答" },
          viewportOnly: { type: "boolean", description: "只读当前屏幕里看得见的部分" },
          includeLinks: { type: "boolean", description: "保留链接地址" },
          maxChars: { type: "integer", description: "最多返回多少字，默认 20000" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      handler: async (input) => {
        try {
          const result = await callControl("page/read", input);
          const tail = result.truncated ? `\n（已截断：全长 ${result.length} 字）` : "";
          return { content: [{ type: "text", text: prefixReturnSummary(`${gridTag(result)}地址：${result.url}\n\n${result.text}${tail}`, result.returnSummary) }], structuredContent: result };
        } catch (error) {
          return pageError(error);
        }
      },
    },
  ];
}

function textOf(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** 把一个窗口的页面快照整理成模型好读的样子。 */
function formatSnapshot(result) {
  const lines = [
    `标题：${result.title || "(无)"}`,
    `地址：${result.url}`,
    `加载状态：${result.readyState}`,
    `正文长度：${result.textLength} 字符${result.truncated ? "（已截断）" : ""}`,
    "",
    "── 页面正文 ──",
    result.text || "(空)",
  ];
  if (result.elements?.length) {
    lines.push("", `── 可操作元素（${result.elements.length} 个）──`);
    for (const el of result.elements.slice(0, 60)) {
      const bits = [`[${el.tag}${el.type ? `:${el.type}` : ""}]`, el.label || "(无标签)"];
      if (el.disabled) bits.push("(禁用)");
      bits.push(`→ ${el.selector}`);
      lines.push(bits.join("  "));
    }
  }
  return lines.join("\n");
}

export function defineBrowserTools(deps = {}) {
  const tools = [
    {
      name: "browser_profiles",
      title: "列出浏览器窗口",
      capability: Capability.READ,
      description: "列出所有多开浏览器窗口（账号/格子），含运行状态、当前地址、格子编号 slot、是否被收起（hidden），以及各自独立的分区名。分区不同意味着登录态完全隔离。操作某个格子时，id 可以直接填账号 id，也可以填「格子 2」「slot:2」「2」。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async (_input, context) => {
        const result = await callControl("list", {}, { method: "GET" });
        const profiles = result.profiles ?? [];
        // 主令牌（context.connector 为 null）照常给全字段；连接器才标「分给你 / 没分给你」
        const connector = context?.connector ?? null;
        if (!profiles.length) {
          return { content: [{ type: "text", text: "还没有浏览器窗口。用 browser_open 之前，先在控制面板里建一个（或让用户建）。" }], structuredContent: { profiles: [] } };
        }
        if (!connector) {
          const lines = profiles.map(p =>
            `${p.slot ? `[格子 ${p.slot}]${p.hidden ? "（已收起）" : ""} ` : (p.hidden ? "[已收起] " : "")}${p.running ? "运行中" : "未打开"}  ${p.name}  id=${p.id}  ${p.currentUrl || p.startUrl}  分区=${p.partition}${p.proxy ? "  代理=" + p.proxy : ""}`
          );
          return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: { profiles } };
        }
        // 受限连接器：只按白名单给字段。没分给它的窗口只给名字和 id（够它申请），不给地址、代理、分区
        const trimmed = profiles.map((p) => {
          const yours = connector.profiles.includes(p.id);
          const grid = { slot: p.slot ?? null, hidden: Boolean(p.hidden) };
          return yours
            ? { id: p.id, name: p.name, running: Boolean(p.running), currentUrl: p.currentUrl || p.startUrl || "", ...grid, yours }
            : { id: p.id, name: p.name, running: Boolean(p.running), ...grid, yours };
        });
        const lines = trimmed.map(p => p.yours
          ? `${p.slot ? `[格子 ${p.slot}] ` : ""}${p.running ? "运行中" : "未打开"}  ${p.name}  id=${p.id}  ${p.currentUrl}  分给你`
          : `${p.slot ? `[格子 ${p.slot}] ` : ""}${p.name}  id=${p.id}  没分给你，要用得先请人批准`);
        return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: { profiles: trimmed } };
      },
    },
    {
      name: "browser_open",
      title: "打开浏览器窗口",
      capability: Capability.EXECUTE,
      scope: "profile",
      description: "打开一个多开浏览器窗口（按 id 或格子编号）。每个窗口是独立且持久的浏览器身份，所以同一个网站能同时登多个账号。窗口已经开着的话只会聚焦，不会新开。",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "账号 id，或格子编号（格子 2 / slot:2 / 2）" },
          url: { type: "string", description: "要打开的地址；省略则用窗口自己配的启动地址" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const result = await callControl("open", input);
        return {
          content: [{ type: "text", text: `${gridTag(result)}窗口 ${result.id} 已${result.reused ? "聚焦（本来就开着，没有新开）" : "打开"}。\n分区：${result.partition}\n地址：${result.url ?? "(窗口默认)"}` }],
          structuredContent: result,
        };
      },
    },
    {
      name: "browser_close",
      title: "关闭浏览器窗口",
      capability: Capability.EXECUTE,
      scope: "profile",
      description: "关闭某个浏览器窗口。只关窗口，磁盘上的登录态保留，下次打开还在。",
      inputSchema: { type: "object", properties: { id: { type: "string", description: "账号 id，或格子编号（格子 2 / slot:2 / 2）" } }, required: ["id"], additionalProperties: false },
      handler: async (input) => {
        const result = await callControl("close", input);
        return { content: [{ type: "text", text: `${gridTag(result)}${result.closed ? `窗口 ${input.id} 已关闭（登录态已保留在磁盘）` : `窗口 ${input.id} 本来就没开`}` }], structuredContent: result };
      },
    },
    {
      name: "browser_navigate",
      title: "浏览器跳转",
      capability: Capability.EXECUTE,
      scope: "profile",
      description: "让某个窗口跳到指定地址。默认跳「我的」空间；AI 自己的空间用 space 指定（空间 id 或名字）。",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "账号 id，或格子编号（格子 2 / slot:2 / 2）" },
          space: { type: "string", description: "空间 id 或名字；不给就是「我的」空间" },
          url: { type: "string" },
        },
        required: ["id", "url"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const result = await callControl("navigate", input);
        await new Promise(r => setTimeout(r, 800));
        // 重定向要明确标出来：站点把目标地址换掉（登录墙 / 反爬 / 移动版）时，
        // 只报「已跳转到 requested」会让 AI 在错的页面上继续干活（t3/t4 报告）。
        const redirect = result.redirected ? `（重定向：请求的是 ${result.requestedUrl}）` : "";
        const title = result.title ? `\n标题：${result.title}` : "";
        const loading = result.stillLoading ? `\n注意：页面还在加载（${result.settleReason ?? "没等到稳定"}），稍后用 page_snapshot 看状态。` : "";
        return { content: [{ type: "text", text: `${gridTag(result)}已跳转到 ${result.url}${redirect}${title}${loading}` }], structuredContent: result };
      },
    },
    {
      name: "browser_snapshot",
      title: "读取页面内容",
      capability: Capability.READ,
      scope: "profile",
      description: "看某个窗口现在是什么样：标题、地址、正文文本、以及页面上所有可点击/可输入的元素的清单（带 CSS 选择器）。做点击或填表前先用这个，才能知道该点哪里。默认看「我的」空间；AI 自己的空间用 space 指定。",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "账号 id，或格子编号（格子 2 / slot:2 / 2）" },
          space: { type: "string", description: "空间 id 或名字；不给就是「我的」空间" },
          maxChars: { type: "integer", description: "正文最多取多少字符，默认 4000" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const result = await callControl("snapshot", input);
        return { content: [{ type: "text", text: `${gridTag(result)}${formatSnapshot(result)}` }], structuredContent: result };
      },
    },
    {
      name: "browser_click",
      title: "点击页面元素",
      capability: Capability.EXECUTE,
      scope: "profile",
      description: "点击页面上的元素。优先用可见文字定位（对中文界面最稳），也可以给 CSS 选择器。会先把元素滚动到可视区域再点。默认点「我的」空间；AI 自己的空间用 space 指定。返回里带 outcome：confirmed（带 expect 且读到了）、dispatched（事件已发出但没 expect 佐证）、unknown（已发出后出错，可能已生效，先读回确认，不要直接再点）、failed（没发出去，可以重试）。目标文字命中发布 / 提交 / 付款 / 删除 / 授权这类不可撤销动作时，必须先向用户确认，再带 confirm:true；「发布设置」「发布记录」这类导航标签不拦。",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "账号 id，或格子编号（格子 2 / slot:2 / 2）" },
          space: { type: "string", description: "空间 id 或名字；不给就是「我的」空间" },
          text: { type: "string", description: "按钮或链接上的可见文字（推荐）" },
          selector: { type: "string", description: "CSS 选择器（text 找不到时用）" },
          waitMs: { type: "integer", description: "点击后等多久再看结果，默认 900 毫秒" },
          expect: {
            description: "可选：点击生效的判据。给文字（点击后页面上要出现的文字），或 { selector } / { text, timeoutMs }。读到了 outcome 才是 confirmed。",
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  text: { type: "string", description: "动作后页面上要出现的文字" },
                  selector: { type: "string", description: "动作后要出现的元素选择器" },
                  timeoutMs: { type: "integer", description: "最多等多久，默认 3000 毫秒" },
                },
                additionalProperties: false,
              },
            ],
          },
          confirm: { type: "boolean", description: "提交类点击（发布 / 提交 / 付款 / 删除 / 授权 / Publish / Submit / Pay / Delete / Buy）必须先向用户确认，再带 confirm:true 调用；不带就返回 NEEDS_CONFIRM，不会点击。目标名超过 12 个字或带「设置 / 管理 / 记录 / 列表 / 中心 / 指南 / 帮助 / settings / history」的导航标签不拦。" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      handler: async (input) => {
        try {
          const result = await callControl("click", input);
          return {
            content: [{ type: "text", text: `${gridTag(result)}已点击 [${result.clicked.tag}] ${result.clicked.label}\n结果：${result.outcome ?? "unknown"}${result.next_step ? `\n下一步：${result.next_step}` : ""}\n当前地址：${result.url}` }],
            structuredContent: result,
          };
        } catch (error) {
          return pageError(error);
        }
      },
    },
    {
      name: "browser_type",
      title: "填写输入框",
      capability: Capability.EXECUTE,
      scope: "profile",
      description: "往输入框里填内容。用可见文字或占位符定位输入框，也可以给 CSS 选择器。用原生 setter 写值并派发 input/change 事件，所以 React/Vue 这类框架的受控输入也能识别。submit=true 会直接提交表单（页面自己提交，不等同于按「发布」按钮；真要走不可撤销的发布，请点那个按钮并带 confirm:true）。填写本身不套提交边界，往「删除原因」这类输入框里打字不会被拦。默认填「我的」空间；AI 自己的空间用 space 指定。返回里带 outcome：confirmed（带 expect 且读到了）、dispatched（事件已发出但没 expect 佐证）、unknown（已发出后出错，可能已生效，先读回确认，不要直接再填）、failed（没发出去，可以重试）。",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "账号 id，或格子编号（格子 2 / slot:2 / 2）" },
          space: { type: "string", description: "空间 id 或名字；不给就是「我的」空间" },
          text: { type: "string", description: "输入框的标签或占位符文字（推荐）" },
          selector: { type: "string", description: "CSS 选择器" },
          value: { type: "string", description: "要填的内容" },
          submit: { type: "boolean", description: "填完是否立刻提交表单" },
          waitMs: { type: "integer" },
          expect: {
            description: "可选：填写的判据。给文字（填完后页面上要出现的文字），或 { selector } / { text, timeoutMs }。读到了 outcome 才是 confirmed。",
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  text: { type: "string", description: "动作后页面上要出现的文字" },
                  selector: { type: "string", description: "动作后要出现的元素选择器" },
                  timeoutMs: { type: "integer", description: "最多等多久，默认 3000 毫秒" },
                },
                additionalProperties: false,
              },
            ],
          },
        },
        required: ["id", "value"],
        additionalProperties: false,
      },
      handler: async (input) => {
        try {
          const result = await callControl("type", input);
          return {
            content: [{ type: "text", text: `${gridTag(result)}已填入 [${result.typed.tag}] ${result.typed.label}${result.typed.submitted ? "，并已提交" : ""}\n结果：${result.outcome ?? "unknown"}${result.next_step ? `\n下一步：${result.next_step}` : ""}\n当前地址：${result.url}` }],
            structuredContent: result,
          };
        } catch (error) {
          return pageError(error);
        }
      },
    },
    {
      name: "browser_screenshot",
      title: "页面截图",
      capability: Capability.READ,
      scope: "profile",
      description: "给某个窗口截图，返回 PNG 图片。适合需要看画面布局、验证码、图表这类纯文本读不出来的情况。建议带上 maxWidth 缩小尺寸以节省 token（默认 1024）。默认截「我的」空间；AI 自己的空间用 space 指定。",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "账号 id，或格子编号（格子 2 / slot:2 / 2）" },
          space: { type: "string", description: "空间 id 或名字；不给就是「我的」空间" },
          maxWidth: { type: "integer", description: "缩放到指定宽度，默认 1024；填 0 表示原尺寸" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const params = { maxWidth: 1024, ...input };
        const result = await callControl("screenshot", params, { timeoutMs: 45_000 });
        return {
          content: [
            { type: "text", text: `${gridTag(result)}截图完成：${result.width}x${result.height}，${Math.round(result.bytes / 1024)} KB（方式：${result.via}）` },
            { type: "image", data: result.base64, mimeType: "image/png" },
          ],
          structuredContent: { id: result.id, width: result.width, height: result.height, bytes: result.bytes, via: result.via, slot: result.slot, accountName: result.accountName, name: result.name },
        };
      },
    },
    {
      name: "browser_wait",
      title: "等待页面条件",
      capability: Capability.READ,
      scope: "profile",
      description: "等页面出现某段文字、某个元素，或等加载完成。点击后页面异步变化时用它，比盲等固定时间可靠。默认等「我的」空间；AI 自己的空间用 space 指定。",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "账号 id，或格子编号（格子 2 / slot:2 / 2）" },
          space: { type: "string", description: "空间 id 或名字；不给就是「我的」空间" },
          text: { type: "string", description: "等这段文字出现" },
          selector: { type: "string", description: "等这个元素出现" },
          timeoutMs: { type: "integer", description: "超时时间，默认 15000 毫秒" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const result = await callControl("wait", input);
        return { content: [{ type: "text", text: `${gridTag(result)}条件已满足（${result.how}），等了 ${result.elapsedMs} 毫秒` }], structuredContent: result };
      },
    },
    {
      name: "browser_nav",
      title: "浏览器导航",
      capability: Capability.EXECUTE,
      scope: "profile",
      description: "浏览器导航操作：back（后退）、forward（前进）、reload（刷新）、scroll（滚动）、key（按一个键，比如 Enter / Tab / Escape）。默认作用于「我的」空间；AI 自己的空间用 space 指定。",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "账号 id，或格子编号（格子 2 / slot:2 / 2）" },
          space: { type: "string", description: "空间 id 或名字；不给就是「我的」空间" },
          action: { type: "string", enum: ["back", "forward", "reload", "scroll", "key"] },
          amount: { type: "integer", description: "scroll 用：滚多少像素，正数向下" },
          key: { type: "string", description: "key 用：键名，例如 Enter" },
        },
        required: ["id", "action"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const { id, action, ...rest } = input;
        const result = await callControl(action, { id, ...rest });
        // 后退 / 前进已经等到页面稳下来才回来（SPA 里以前会拿到空壳快照），标题一并给出
        const title = result.title ? `，标题：${result.title}` : "";
        const loading = result.stillLoading ? `（页面还在加载：${result.settleReason ?? "没等到稳定"}，稍后用 page_snapshot 看状态）` : "";
        return { content: [{ type: "text", text: `${gridTag(result)}已执行 ${action}${result.url ? `，当前地址：${result.url}` : ""}${title}${loading}` }], structuredContent: result };
      },
    },
    // page_*：语义快照 + 问 Jev 挑元素 + 按编号动作 + 读正文，走 CDP 虚拟输入。上面的 browser_snapshot/click/type 保留给旧用法
    ...definePageTools(deps),
    {
      name: "space_list",
      title: "列出这个格子的空间",
      capability: Capability.READ,
      scope: "profile",
      description: [
        "列出某个格子里现在有哪些空间。每个格子至少有一个「我的」空间（owner=human，就是人正在用的那个标签页）；",
        "AI 开过的空间（owner=ai）也会列出来，格子里重开只恢复名字、标签页要按需重开（tabCount=0 表示还没开标签页）。",
        CLOSE_REMINDER,
      ].join(""),
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "账号 id，或格子编号（格子 2 / slot:2 / 2）" } },
        required: ["id"],
        additionalProperties: false,
      },
      handler: async (input) => {
        try {
          const result = await callControl("space/list", input);
          const lines = (result.spaces ?? []).map((space) => {
            const control = space.control ?? {};
            const stateLabel = CONTROL_STATE_LABELS[control.state] ?? control.state ?? "AI 运行中";
            const why = control.state && control.state !== "ai_running" && control.reason ? `（${control.reason}）` : "";
            return `${space.name}  id=${space.id}  ${space.owner === "ai" ? "AI 的空间" : "人的空间「我的」"}  ${space.tabCount > 0 ? `标签页开着` : "标签页没开（要用先 space_open）"}  控制权=${stateLabel}${why}`;
          });
          return { content: [{ type: "text", text: `${gridTag(result)}${lines.join("\n") || "（这个格子还没有空间记录）"}` }], structuredContent: result };
        } catch (error) {
          return pageError(error);
        }
      },
    },
    {
      name: "space_open",
      title: "开一个自己的空间",
      capability: Capability.EXECUTE,
      scope: "profile",
      description: [
        "在这个格子里开一个 AI 空间（一个折叠的浏览器标签组，共用这个账号的登录），返回空间 id，之后把 page_* / browser_* 的 space 参数填成它，就在这个空间里干活了。",
        "做任务时应该先开空间再干活，不要动人正在用的「我的」空间。同名空间会复用；可以带 url 让空间的主标签页直接打开（或导航到）那个网址，返回里的 url 就是主标签页的真实地址。",
        "keep 默认 false：一次性任务做完必须调用 space_close；只有用户需要亲自看结果时才传 keep:true，并在回复里告诉用户这个空间留着。keep:true 的空间不会被自动关闭，空闲后只卸载内存，用户点回去会自动重新加载。",
        "格子没开的话会自动打开它，不用先调 browser_open。",
      ].join(""),
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "账号 id，或格子编号（格子 2 / slot:2 / 2）" },
          name: { type: "string", description: "给空间起个名字，例如「整理邮件」" },
          url: { type: "string", description: "主标签页要打开的网址（可选，不给就是空白页）" },
          keep: { type: "boolean", description: "用户需要亲自看结果时才传 true：这个空间不会自动关，空闲后只卸载内存（默认 false，做完要 space_close）" },
        },
        required: ["id", "name"],
        additionalProperties: false,
      },
      handler: async (input) => {
        try {
          const result = await callControl("space/open", input);
          const space = result.space ?? {};
          const openedGrid = result.gridOpened ? "（这个格子刚被自动打开）" : "";
          // 导航没等到 load（CDP_TIMEOUT 之类）不算开空间失败：空间和标签页都在，只是页面还在加载。
          // 这一句必须写清楚，否则 AI 会以为整个 space_open 失败又开一次，堆出好几个同名空间。
          const warning = result.navigationWarning ? `\n注意：${result.navigationWarning}` : "";
          const keepNote = space.keep === true
            ? "\n这个空间是留给用户亲自看的（keep:true）：不会被自动关闭，空闲后只卸载内存，用户点回去会自动重新加载。回复里要告诉用户这个空间留着。"
            : "";
          const text = `${gridTag(result)}空间「${space.name}」${result.reused ? "（复用已有的）" : ""}已开好，空间 id=${space.id}${openedGrid}。${keepNote}\n之后所有 page_* / browser_* 操作都带上 space: "${space.id}"，在这个空间里干活，不要动「我的」。${result.url && result.url !== "about:blank" ? `\n主标签页现在是：${result.url}` : "\n主标签页是空白页，用 browser_navigate 带 space 跳到你需要的网址。"}${warning}`;
          return { content: [{ type: "text", text }], structuredContent: result };
        } catch (error) {
          return pageError(error);
        }
      },
    },
    {
      name: "space_close",
      title: "关掉一个空间",
      capability: Capability.EXECUTE,
      scope: "profile",
      description: `关掉这个空间的全部标签页并删除记录（任务做完收摊用），返回里写明关掉了几个标签页。空间里 AI 操作时点链接弹出来的新标签页也归在这个空间里，会一起关。「我的」是人正在用的空间，不能关。${CLOSE_REMINDER}`,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "账号 id，或格子编号（格子 2 / slot:2 / 2）" },
          space: { type: "string", description: "空间 id 或名字（「我的」不能关）" },
        },
        required: ["id", "space"],
        additionalProperties: false,
      },
      handler: async (input) => {
        try {
          const result = await callControl("space/close", input);
          const tabs = Number(result.closedTabs);
          const count = Number.isFinite(tabs) && tabs >= 0 ? tabs : 0;
          return { content: [{ type: "text", text: `${gridTag(result)}空间「${result.name}」已关掉，关掉了 ${count} 个标签页，记录也清掉了。` }], structuredContent: result };
        } catch (error) {
          return pageError(error);
        }
      },
    },
    {
      name: "space_handoff",
      title: "把空间交给用户",
      capability: Capability.EXECUTE,
      scope: "profile",
      description: [
        "把当前空间的控制权交给用户，并且停下 AI 的写操作（读操作照常）。",
        "什么时候用：需要人来扫码 / 输入验证码 / 登录 / 支付 / 授权，或者你看不懂页面、需要人亲自处理时。reason 写清楚原因，例如「需要扫码登录」「短信验证码」「支付确认」。",
        "reason 决定状态：带「暂停」→ paused；带登录 / 扫码 / 验证码 / 密码 / 支付 / 授权这类词 → needs_help（人处理完就交还）；其余 → human_control（整段交给用户）。",
        "调用后这个空间的写操作（page_act 的点击 / 输入 / 提交等）一律返回 HUMAN_IN_CONTROL；等人交还后，你下一次 page_* 调用的返回最前面会自动带「交接前后变更摘要」（URL、标题、新出现 / 消失的元素、登录状态），然后你继续。",
        CLOSE_REMINDER,
      ].join(""),
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "账号 id，或格子编号（格子 2 / slot:2 / 2）" },
          space: { type: "string", description: "空间 id 或名字" },
          to: { type: "string", enum: ["human"], description: "交给谁：现在只支持 human" },
          reason: { type: "string", description: "为什么交给用户，例如「需要扫码登录」「短信验证码」「需要人确认支付」" },
          message: { type: "string", description: "可选：给用户看的补充说明" },
        },
        required: ["id", "space", "reason"],
        additionalProperties: false,
      },
      handler: async (input) => {
        try {
          const result = await callControl("space/handoff", input);
          const state = CONTROL_STATE_LABELS[result.control?.state] ?? result.control?.state ?? "需要人处理";
          const note = result.notified ? "已经通知用户。" : "（通知接口没接上，已写进日志。）";
          return {
            content: [{ type: "text", text: `${gridTag(result)}空间「${result.space?.name}」已交给用户（${state}）。\n原因：${input.reason}${input.message ? `\n说明：${input.message}` : ""}\n${note}现在读操作照常，写操作会返回 HUMAN_IN_CONTROL；等人交还后，下一次 page_* 返回最前面会带变更摘要。` }],
            structuredContent: result,
          };
        } catch (error) {
          return pageError(error);
        }
      },
    },
    {
      name: "pin_list",
      title: "看这个空间的钉住",
      capability: Capability.READ,
      scope: "profile",
      description: [
        "看某个空间里钉住的常用网页（像 Windows 资源管理器的「快速访问」，人和 AI 都能钉）。",
        "钉住按空间分开存：每个空间一份清单，AI 钉的不会挤到人正在用的「我的」里。默认看「我的」空间；看 AI 自己的空间用 space 指定。",
        "返回每条钉住的 id、标题、网址、谁钉的（by=ai 是 AI 钉的，by=human 是人钉的）。",
      ].join(""),
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "账号 id，或格子编号（格子 2 / slot:2 / 2）" },
          space: { type: "string", description: "空间 id 或名字；不给就是「我的」空间" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      handler: async (input) => {
        try {
          const result = await callControl("pin/list", input);
          const lines = (result.pins ?? []).map((pin) => `${pin.title || pin.url}  id=${pin.id}  ${pin.by === "ai" ? "AI 钉的" : "人钉的"}\n  ${pin.url}`);
          return { content: [{ type: "text", text: `${gridTag(result)}${lines.join("\n") || "（这个空间还没有钉住）"}` }], structuredContent: result };
        } catch (error) {
          return pageError(error);
        }
      },
    },
    {
      name: "pin_add",
      title: "钉住一个网页",
      capability: Capability.EXECUTE,
      scope: "profile",
      description: [
        "把一个网页钉进某个空间（像「快速访问」），下次用 pin_open 直接打开，不用再输地址。",
        "钉住按空间分开存：space 必填。AI 默认钉在自己的空间里（先 space_open 开空间再钉）；只有用户明确要求时才钉进「我的」，别把人正在用的「我的」空间挤满 AI 的网址。",
        "同一个空间里同一个网址只存一条，重复钉只是更新标题；每个空间最多 50 条；只收 http / https 网址。",
      ].join(""),
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "账号 id，或格子编号（格子 2 / slot:2 / 2）" },
          space: { type: "string", description: "钉进哪个空间（空间 id 或名字，必填）" },
          url: { type: "string", description: "要钉住的网址（只收 http / https）" },
          title: { type: "string", description: "显示用的名字，不给就用网址的域名" },
        },
        required: ["id", "space", "url"],
        additionalProperties: false,
      },
      handler: async (input) => {
        try {
          const result = await callControl("pin/add", input);
          const pin = result.pin ?? {};
          return { content: [{ type: "text", text: `${gridTag(result)}已钉住「${pin.title || pin.url}」（${pin.url}），钉住 id=${pin.id}。之后 pin_open 带 space 和这个 id 直接打开。` }], structuredContent: result };
        } catch (error) {
          return pageError(error);
        }
      },
    },
    {
      name: "pin_remove",
      title: "取消一个钉住",
      capability: Capability.EXECUTE,
      scope: "profile",
      description: "从某个空间里取消一个钉住（pin 是 pin_list 返回的钉住 id）。",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "账号 id，或格子编号（格子 2 / slot:2 / 2）" },
          space: { type: "string", description: "空间 id 或名字（必填）" },
          pin: { type: "string", description: "钉住 id（pin_list 返回的 id）" },
        },
        required: ["id", "space", "pin"],
        additionalProperties: false,
      },
      handler: async (input) => {
        try {
          const result = await callControl("pin/remove", input);
          return { content: [{ type: "text", text: `${gridTag(result)}已取消这个钉住，这个空间还剩 ${(result.pins ?? []).length} 个。` }], structuredContent: result };
        } catch (error) {
          return pageError(error);
        }
      },
    },
    {
      name: "pin_open",
      title: "打开一个钉住的网页",
      capability: Capability.EXECUTE,
      scope: "profile",
      description: "把某个空间的主标签页导航到这个钉住的网页（和 browser_navigate 同一条路）。空间标签页没开时会报 SPACE_CLOSED，先 space_open 重开。",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "账号 id，或格子编号（格子 2 / slot:2 / 2）" },
          space: { type: "string", description: "钉住所在的空间（空间 id 或名字，必填）" },
          pin: { type: "string", description: "钉住 id（pin_list 返回的 id）" },
        },
        required: ["id", "space", "pin"],
        additionalProperties: false,
      },
      handler: async (input) => {
        try {
          const result = await callControl("pin/open", input);
          return { content: [{ type: "text", text: `${gridTag(result)}已把空间的主标签页导航到钉住的网页：${result.url}` }], structuredContent: result };
        } catch (error) {
          return pageError(error);
        }
      },
    },
    {
      name: "extension_list",
      title: "看插件装到哪些格子",
      capability: Capability.READ,
      description: [
        "只看，不能装也不能卸：列出「装到所有格子」的共享插件库，以及每个开着的格子里装了哪些商店插件（标出哪些已在所有格子生效）。",
        "插件权限很大，单独安装 / 移除只能由人在浏览器侧边栏的「插件」区里点，不给 AI 工具；把插件本身同步到别的格子用 extension_sync（只同步插件，不同步登录和数据）。",
      ].join(""),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => {
        try {
          const result = await callControl("extension/list", {});
          const shared = result.shared ?? [];
          const lines = [];
          lines.push(`自动同步：${result.autoSync === false ? "关（新插件只列出来，要人手动点「装到所有格子」）" : "开（新装的插件自动装到所有格子）"}`);
          lines.push("");
          lines.push(`共享插件库（装到所有格子的）：${shared.length ? "" : "空"}`);
          for (const item of shared) {
            lines.push(`  ${item.name || item.id}${item.version ? ` v${item.version}` : ""}  id=${item.id}  ${item.enabled === false ? "停用" : "启用"}`);
          }
          lines.push("");
          lines.push("各开着的格子：");
          for (const grid of (result.grids ?? [])) {
            const head = grid.slot ? `[格子 ${grid.slot}] ` : "";
            if (!grid.extensions?.length) {
              lines.push(`${head}${grid.name}  id=${grid.id}  没有商店插件`);
              continue;
            }
            for (const ext of grid.extensions) {
              lines.push(`${head}${grid.name}  id=${grid.id}  ${ext.name || ext.id}${ext.version ? ` v${ext.version}` : ""}  ${ext.shared ? "已在所有格子" : "只在这个格子"}`);
            }
          }
          return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: result };
        } catch (error) {
          return pageError(error);
        }
      },
    },
    {
      name: "extension_sync",
      title: "把插件同步到所有格子",
      capability: Capability.EXECUTE,
      scope: "profile",
      description: [
        "把一个格子里装好的商店插件，一键同步到其他格子（默认除源格子外的所有格子）。",
        "只同步插件本身：往目标格子写一份「插件 id + 更新地址」的外部清单，目标格子下次启动时浏览器自己去商店装。插件里的登录、chrome.storage、cookie、浏览数据一概不同步，格子之间的账号隔离不变。",
        "只收用户自己从商店装的插件：组件扩展、Windrise / BrowserOS 自带插件、开发者未打包插件、命令行加载的插件都排除。",
        "正在运行的格子不强制重启，返回里会提示「重开这个格子后生效」。",
      ].join(""),
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string", description: "源格子：账号 id、账号名或格子编号（格子 2 / slot:2 / 2）" },
          to: {
            type: "array",
            items: { type: "string" },
            description: "目标格子（账号 id / 名字 / 格子编号）。不给就是除源格子外的所有格子",
          },
          ids: {
            type: "array",
            items: { type: "string" },
            description: "只同步这几个插件 id；不给就是源格子里所有用户自己装的商店插件",
          },
        },
        required: ["from"],
        additionalProperties: false,
      },
      handler: async (input) => {
        try {
          const result = await callControl("extension/sync", {
            from: input.from,
            ...(input.to !== undefined ? { to: input.to } : {}),
            ...(input.ids !== undefined ? { ids: input.ids } : {}),
          });
          const source = result.from ?? {};
          const lines = [];
          const picked = source.extensions ?? [];
          lines.push(`源格子：${source.name}  id=${source.id}；要同步 ${picked.length} 个插件${picked.length ? "" : "（这个格子里没有用户自己装的商店插件）"}`);
          for (const ext of picked) lines.push(`  ${ext.name}  id=${ext.id}  v${ext.version}`);
          if (result.badIds?.length) lines.push(`这些插件 id 不合法，已忽略：${result.badIds.join("、")}`);
          if (result.notInSource?.length) lines.push(`这些插件不在源格子里，没同步：${result.notInSource.join("、")}`);
          if (result.targetIssues?.length) {
            for (const issue of result.targetIssues) lines.push(`目标格子 ${issue.target} 没同步：${issue.reason}`);
          }
          if (result.sourceHint) lines.push(result.sourceHint);
          for (const warning of (result.warnings ?? [])) lines.push(`注意：${warning}`);
          lines.push("");
          for (const grid of (result.grids ?? [])) {
            const head = grid.slot ? `[格子 ${grid.slot}] ` : "";
            const miss = grid.missing?.length ? `；缺 ${grid.missing.length} 个：${grid.missing.join("、")}` : "";
            lines.push(`${head}${grid.name}  id=${grid.id}  写清单 ${grid.written}/${grid.expected}${miss}${grid.ok ? "" : `（${grid.error || "有插件没写进去"}）`}${grid.restartHint ? `  ${grid.restartHint}` : ""}`);
          }
          lines.push("");
          lines.push("只写了 External Extensions 清单（插件 id + 更新地址），没有复制插件里的登录和任何数据目录；目标格子下次启动时浏览器会自动安装。正在运行的格子不用现在重启。");
          if (result.platformNote) lines.push(`前提：${result.platformNote}`);
          return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: result };
        } catch (error) {
          return pageError(error);
        }
      },
    },
  ];
  /*
   * 把这次 MCP 调用的 sessionId 塞进参数：控制服务靠它记「发起这个空间的会话」，
   * 会话断了满 2 分钟就能收摊，不用干等 idleMinutes。
   * 只在 MCP 校验之后再塞，不影响 inputSchema 的 additionalProperties: false。
   */
  return tools.map((tool) => {
    const run = tool.handler;
    return {
      ...tool,
      handler: (input, context) => run({ ...(input ?? {}), sessionId: context?.sessionId ?? null }, context),
    };
  });
}

/** 浏览器控制服务是否在线（用于启动时决定要不要挂这些工具）。 */
export async function browserControlAvailable() {
  // 用 discoverLive：文件在不代表服务活着，而且可能有多个候选
  // （上一次界面异常退出会留下陈旧文件，那样工具挂上去但每次调用都失败，
  //  不如一开始就别挂）。
  const live = await discoverLive();
  return Boolean(live);
}

/** 读发现文件，顺带判断服务是不是还活着（给状态展示用）。 */
export async function browserControlStatus() {
  const all = await discoverAll();
  if (!all.length) return { available: false, reason: "没有发现文件（界面没启动过）" };

  for (const candidate of all) {
    if (await probe(candidate)) {
      try {
        const response = await fetch(`${candidate.url}/status`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(2500),
        });
        const payload = await response.json();
        return { available: true, candidates: all.length, ...payload.result };
      } catch (error) {
        return { available: false, reason: `控制服务应答异常：${error.message}`, staleUrl: candidate.url };
      }
    }
  }

  return {
    available: false,
    reason: `找到 ${all.length} 个发现文件，但都连不上 —— 界面可能已经关掉了，文件是陈旧的`,
    staleUrl: all[0]?.url,
  };
}

/** 软件控制（src/tools/app.js）也走这条通道 */
export { callControl };
