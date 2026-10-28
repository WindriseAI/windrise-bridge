/**
 * 流程草稿工具 —— flow_save_draft / flow_list_drafts / flow_get_draft / flow_replay。
 *
 * 草稿本身只做本地文件读写：素材来自调用日志（<数据目录>/logs/mcp-calls-*.jsonl），
 * 抽步骤和脱敏全在 core/flow-draft.js 里；重放（flow_replay）要真操作页面，走的还是
 * page_* 那套控制服务通道（和 Agent 自己调用完全一样，写操作闸门照样生效），
 * 定位和四态判定在 core/flow-replay.js / core/flow-locate.js 里。
 *
 * 为什么单独一个文件而不是塞进内置工具表：草稿依赖数据目录（dataHome），
 * 而内置工具表拿不到它；注册点放在 boot() 里，和上下文工具同一个位置。
 */

import path from "node:path";
import { Capability } from "../core/registry.js";
import {
  buildFlowDraft,
  flowDraftsDir,
  listDraftSites,
  listFlowDrafts,
  readFlowDraft,
  saveFlowDraft,
} from "../core/flow-draft.js";
import { isEphemeralValue, replayDraft, RUN_STATUS, STEP_STATUS } from "../core/flow-replay.js";
import { flowReplayExecuteEnabled } from "../core/flow-config.js";
import { checkUrlAllowed } from "../core/tool-policy.js";

const reply = (text, data) => ({ content: [{ type: "text", text }], structuredContent: data });

/** 统一错误回执：保留错误码（例如 NO_CALLS / DRAFT_NOT_FOUND），前端 / Agent 可以直接照着下一步做。 */
function failure(error, prefix = "存草稿失败") {
  const message = error?.message ?? String(error);
  return {
    content: [{ type: "text", text: `${prefix}：${message}` }],
    structuredContent: { code: error?.code ?? "FLOW_DRAFT_FAILED", message },
    isError: true,
  };
}

/** 流程回放执行开关没开：带 execute:true 也一步都不执行，只提示怎么预演 / 怎么打开。 */
function featureDisabledReply() {
  const message = "流程回放的执行开关（flowReplayExecute）没有打开：这次一步都没有执行，也不会碰浏览器。"
    + "先用不带 execute 的 flow_replay 预演（列出将要做的动作和不支持的步骤）；确认无误后，让用户在设置里打开"
    + "「流程回放允许真正执行」，再带 execute:true 调用。";
  return {
    content: [{ type: "text", text: `FEATURE_DISABLED：${message}` }],
    structuredContent: { code: "FEATURE_DISABLED", message, feature: "flowReplayExecute" },
    isError: true,
  };
}

/**
 * 草稿里变量那一行的文字：
 *   - secret（密码 / 验证码）只说「secret，不记长度」—— 连长度都是派生信息；
 *   - 其余给 名字 / 类型 / 是否必填 / 长度。
 */
function describeVariable(variable) {
  if (variable.secret === true) return `${variable.name}（secret，不记长度）`;
  const bits = [variable.name, variable.type ?? "text"];
  bits.push(variable.required === false ? "选填" : "必填");
  if (variable.length !== undefined && variable.length !== null) bits.push(`长度 ${variable.length}`);
  return bits.join("，");
}

/**
 * 把草稿渲染成给人 / 模型看的摘要。和草稿 JSON 是同一份信息，只是不含任何输入值。
 * @param {object} draft 草稿
 * @param {{ includeSteps?: boolean }} [options]
 */
export function formatDraft(draft, { includeSteps = true } = {}) {
  const lines = [
    `草稿：${draft.name || "（未命名）"}`,
    `站点：${draft.site || "unknown"}`,
    `创建：${draft.created_at || "未知"}`,
    `步骤：${Array.isArray(draft.steps) ? draft.steps.length : 0} 步，变量：${Array.isArray(draft.variables) ? draft.variables.length : 0} 个${draft.variables?.length ? `（${draft.variables.map(describeVariable).join("；")}）` : ""}`,
  ];
  if (!includeSteps) return lines.join("\n");
  const steps = Array.isArray(draft.steps) ? draft.steps : [];
  lines.push("步骤：");
  steps.forEach((step, index) => {
    const bits = [`${index + 1}. ${step.action ?? "?"}`, step.target ? `「${step.target}」` : ""];
    if (step.unsupported) bits.push(`不支持：${step.unsupportedReason || "回放没法重走"}`);
    if (step.value) bits.push(`值 ${step.value}`);
    if (step.expect) bits.push(`期望「${step.expect}」`);
    if (step.url_pattern) bits.push(`页面 ${step.url_pattern}`);
    if (step.key) bits.push(`按键 ${step.key}`);
    if (step.filesCount !== undefined && !step.files) bits.push(`上传 ${step.filesCount} 个文件（文件名没记，回放要补 files）`);
    const locators = Array.isArray(step.locators) ? step.locators : [];
    if (locators.length) bits.push(`定位 ${locators.map((item) => (item.kind === "role" ? `role=${item.role}+${item.name}` : `${item.kind}=${item.value ?? item.name}`)).join(" / ")}`);
    lines.push(`  ${bits.filter(Boolean).join(" ")}`);
  });
  return lines.join("\n");
}

/** 「该站点没有草稿」和「一份草稿都没有」要说清楚，并列出可用站点（t14 的 P2）。 */
async function emptyDraftReply({ dataHome, draftsDir, site }) {
  const sites = await listDraftSites({ dataHome }).catch(() => []);
  if (!sites.length) {
    return reply("还没有流程草稿。先用 flow_save_draft 存一个。", { drafts: [], directory: draftsDir, sites: [] });
  }
  const what = site ? `站点「${site}」下没有流程草稿` : "还没有流程草稿";
  return reply(`${what}。现有草稿的站点：${sites.join("、")}（去掉 site 参数可以看全部）。`, {
    drafts: [],
    directory: draftsDir,
    sites,
    site: site || null,
  });
}

/**
 * 重放用的浏览器依赖：全部走和 Agent 同一条控制服务通道。
 * 测试可以注入 deps.browser；不注入时在第一次真正重放时才去加载浏览器工具
 * （纯 Node 模式没有控制服务也不影响其它三个工具）。
 */
async function defaultBrowser({ dataHome } = {}) {
  const module = await import("./browser.js");
  if (!(await module.browserControlAvailable())) {
    const error = new Error(
      "浏览器控制服务没有运行：重放要真的操作页面 —— 先打开 Windrise Bridge 界面（或在这个 worktree 里单开一份带控制服务的实例），再重试。",
    );
    error.code = "BROWSER_UNAVAILABLE";
    throw error;
  }
  return createFlowBrowserActions({ dataHome });
}

/**
 * 重放用的浏览器动作集：全部走和 Agent 同一条控制服务通道（下面的 import 是动态的，
 * 纯 Node 模式没有控制服务时只是重放跑不起来，其它三个工具照常可用）。
 *
 * @param {{ dataHome?: string }} [options]
 * @returns {{ resolveTarget: Function, snapshot: Function, read: Function, act: Function, wait: Function,
 *             urlOf: Function }}
 *   resolveTarget(hint) —— 按草稿的站点 / 首个地址挑目标格子（调用时显式给的 id / space 优先）；
 *                         hint 里带 space 时返回那个空间所在的格子（不唯一就返回 null）
 *   snapshot(target)    —— page/snapshot 的结果（带 url）
 *   read(target)        —— page/read 的正文
 *   act(target, call)   —— page/act（写操作闸门在这里生效，NEEDS_CONFIRM 原样抛上来）
 *   urlOf(target)       —— 最近一次快照 / 读取拿到的地址（不是去问页面）
 */
export async function createFlowBrowserActions({ dataHome } = {}) {
  const module = await import("./browser.js");
  return buildFlowBrowserActions({
    callControl: module.callControl,
    discoverLive: module.discoverLive,
    dataHome,
  });
}

/**
 * createFlowBrowserActions 的可注入版本（单测用假的 callControl / discoverLive，不碰真浏览器）。
 * 关键点：urlOf 从最近一次 page/snapshot / page/read 的结果里取 url —— 和线上一样，不去额外问页面。
 *
 * @param {{ callControl: Function, discoverLive: Function, dataHome?: string }} deps
 */
export function buildFlowBrowserActions({ callControl, discoverLive, dataHome } = {}) {
  void dataHome;
  /*
   * 关键：所有控制调用都带上注入的 discoverLive。以前只有 resolveTarget 用它，
   * act / snapshot 仍然走真实 callControl 自己的发现逻辑 —— 测试里换掉 discoverLive 并不生效，
   * 开发机上 Bridge 开着时测试会真的向用户浏览器发点击。这里统一包一层，注入必须真正生效。
   */
  const control = (action, params = {}, options = {}) => callControl(action, params, { ...options, discover: discoverLive });
  // 最近一次快照 / 读取拿到的地址：urlOf 从这里取，和线上一样（不额外问页面）
  const lastUrl = new Map();
  const keyOf = (target) => `${target?.id ?? ""}|${target?.space ?? ""}`;
  const remember = (target, result) => {
    const url = typeof result?.url === "string" && result.url ? result.url : null;
    if (target && url) lastUrl.set(keyOf(target), url);
    return result;
  };
  return {
    async resolveTarget(hint = {}) {
      // 调用时显式给了格子：没给空间就在这个格子的空间列表里找唯一的 owner=ai 空间。
      // 找不到就返回 null —— 绝不把空间留空（page_* 的缺省是「我的」，人正在用的那个）。
      if (hint?.id) {
        const id = String(hint.id);
        if (hint.space) return { id, space: String(hint.space) };
        let spaces = [];
        try {
          spaces = (await control("space/list", { id }))?.spaces ?? [];
        } catch {
          spaces = [];
        }
        const aiSpaces = (Array.isArray(spaces) ? spaces : []).filter((space) => space?.owner === "ai" && String(space?.id ?? "").trim());
        if (aiSpaces.length !== 1) return null;
        return { id, space: String(aiSpaces[0].id) };
      }
      const discovery = await discoverLive();
      if (!discovery) return null;
      const listed = await control("list", {}, { method: "GET" });
      const profiles = listed?.profiles ?? [];
      if (!profiles.length) return null;
      // 只给了 space：在那个格子的空间列表里找同名 / 同 id 的空间，只认唯一那个（绝不落到「我的」）
      if (hint?.space) {
        const wanted = String(hint.space).trim().toLowerCase();
        const hits = [];
        for (const profile of profiles) {
          let spaces = [];
          try {
            spaces = (await control("space/list", { id: profile.id }))?.spaces ?? [];
          } catch {
            continue;
          }
          for (const space of spaces) {
            const same = [space?.id, space?.name].filter((value) => typeof value === "string" && value.trim())
              .some((value) => value.trim().toLowerCase() === wanted);
            if (!same) continue;
            // 「我的」是人正在用的空间：只在明确点名 id 时才认，名字永远不认
            if (space?.owner !== "ai" && String(space?.id ?? "").trim().toLowerCase() !== wanted) continue;
            hits.push({ id: String(profile.id), space: String(space.id) });
          }
        }
        return hits.length === 1 ? hits[0] : null;
      }
      return profiles.length === 1 ? { id: String(profiles[0].id) } : null;
    },
    snapshot: async (target) => remember(target, await control("page/snapshot", { id: target.id, space: target.space })),
    // CSS 选择器兜底：只拍选择器对应的子树，回放再从里面取唯一的编号（照常走 page_act，闸门不绕）
    snapshotScoped: async (target, selector) => remember(target, await control("page/snapshot", { id: target.id, space: target.space, selector })),
    read: async (target) => remember(target, await control("page/read", { id: target.id, space: target.space })),
    act: (target, call) => control("page/act", { ...call, id: target.id, space: target.space }),
    // 导航步骤走和 browser_navigate 同一条通道
    navigate: (target, url) => control("navigate", { id: target.id, space: target.space, url }),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    urlOf: (target) => lastUrl.get(keyOf(target)) ?? null,
  };
}

export function defineFlowTools({ dataHome, browser = null, logStep = null } = {}) {
  if (!dataHome) throw new Error("defineFlowTools 需要 dataHome");
  const draftsDir = flowDraftsDir(dataHome);

  return [
    {
      name: "flow_save_draft",
      title: "把刚跑通的流程存成草稿",
      capability: Capability.WRITE,
      description: [
        "把某个空间里刚跑通的一串 MCP 操作抽成流程草稿，存到本机（以后给 Skill / flow-pack 用，也能用 flow_replay 重放）。",
        "数据来自本机调用日志，只收成功的步骤：写操作必须是 confirmed / dispatched，failed / unknown 的尝试会剔除；连续重复的快照读取合并成一步。",
        "隐私：type / fill 的输入值一律不写进草稿，替换成 {{变量名}} 占位符。变量名从输入框的 label / 提示名推断（例如「姓名」「电话」），并记类型（text / email / tel / password / time 等）和是否必填；password 和验证码类变量标 secret：不记长度、不记任何派生信息，日志同样脱敏。",
        "URL 去掉 token / code / session 这类参数；不记 cookie、口令、账号名。步骤里的 target 是可访问名 / 提示名或 CSS 选择器，不含快照编号；每一步另存多路定位（testid > role+名字 > label > 文本），重放时按顺序打分重找。",
        "站点从步骤里的页面地址自动推断（域名），草稿按域名分目录存，flow_list_drafts(site=...) 能按域名过滤；日志里推断不出站点（unknown）时可以传 site 显式补上。",
        "space 是空间 id 或名字（space_list 里能给）。不给 space 就用 since / until 里最近一次会话；都不给就取日志保留期内的最近一次会话。",
      ].join(""),
      inputSchema: {
        type: "object",
        properties: {
          space: { type: "string", description: "空间 id 或名字；不给就按时间范围取最近一次会话" },
          name: { type: "string", description: "草稿名（可选，默认用空间名）" },
          site: { type: "string", description: "草稿站点（域名）；日志里推断不出站点（unknown）时用它补上，避免以后回放没法核对站点" },
          since: { type: "string", description: "起始时间：YYYY-MM-DD 或 ISO 时间（可选）" },
          until: { type: "string", description: "结束时间：YYYY-MM-DD 或 ISO 时间（可选，只有日期时算到当天 23:59:59）" },
        },
        additionalProperties: false,
      },
      handler: async (input = {}) => {
        try {
          const space = typeof input.space === "string" ? input.space.trim() : "";
          const name = typeof input.name === "string" ? input.name.trim() : "";
          const { draft, sessionCount } = await buildFlowDraft({
            logDir: path.join(dataHome, "logs"),
            space,
            name,
            since: input.since,
            until: input.until,
          });
          // 日志推断不出站点时，允许调用方显式补上（不补的话以后带 secret 的草稿没法做站点核对）
          const site = typeof input.site === "string" ? input.site.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "") : "";
          if (site && (!draft.site || draft.site === "unknown")) draft.site = site;
          const { path: file } = await saveFlowDraft({ dataHome, draft });
          const lines = [
            `已存流程草稿：${draft.name}`,
            `站点：${draft.site}`,
            `步骤：${draft.steps.length} 步，变量：${draft.variables.length} 个${draft.variables.length ? `（${draft.variables.map(describeVariable).join("；")}）` : ""}`,
            `来源：调用日志（${sessionCount} 个会话里取了最近一次）`,
            `文件：${file}`,
          ];
          if (draft.steps.some((step) => step.value)) lines.push("输入内容没有落盘，草稿里只有 {{变量名}} 占位符。");
          // 回放不了的步骤在草稿里标了「不支持」：回执里也要说清楚，别让调用方以为整份草稿都能跑
          const unsupported = draft.steps
            .map((step, index) => ({ step, index }))
            .filter(({ step }) => step.unsupported === true);
          if (unsupported.length) {
            lines.push(`注意：其中 ${unsupported.length} 步回放不支持（已保留在原位并标「不支持」，干跑时会列出来）：`);
            for (const { step, index } of unsupported) lines.push(`  第 ${index + 1} 步 ${step.action ?? "?"}：${step.unsupportedReason ?? "回放没法重走"}`);
          }
          return reply(lines.join("\n"), { draft, path: file, unsupported });
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: "flow_list_drafts",
      title: "列出流程草稿",
      capability: Capability.READ,
      description: `列出本机已经存下的流程草稿（新的在前）。可按 site 过滤（域名，如 example.com；也认存储目录名）。该站点没有草稿时会列出可用的站点。草稿目录：${draftsDir}`,
      inputSchema: {
        type: "object",
        properties: {
          site: { type: "string", description: "只看这个站点（域名，如 example.com）" },
        },
        additionalProperties: false,
      },
      handler: async (input = {}) => {
        try {
          const site = typeof input.site === "string" ? input.site.trim() : "";
          const drafts = await listFlowDrafts({ dataHome, site });
          if (!drafts.length) return emptyDraftReply({ dataHome, draftsDir, site });
          const lines = [
            `已有 ${drafts.length} 个流程草稿（${draftsDir}）：`,
            ...drafts.map((draft) => `- ${draft.name || "（未命名）"}｜${draft.site}｜${draft.steps} 步｜${draft.created_at}｜id=${path.basename(draft.path, ".json")}\n  ${draft.path}`),
          ];
          return reply(lines.join("\n"), { drafts, directory: draftsDir });
        } catch (error) {
          return failure(error, "列草稿失败");
        }
      },
    },
    {
      name: "flow_get_draft",
      title: "查看流程草稿（脱敏后的步骤）",
      capability: Capability.READ,
      description: [
        "按名字或 id 读一份草稿，返回脱敏后的步骤：步骤类型、目标的多路定位信息、变量占位符、期望结果；不返回任何原始输入值。",
        "name 是草稿名（同名取最新的一份）；id 是 flow_list_drafts 返回的 id（文件名，不带 .json）或保存时返回的完整路径（按该路径读，不在所有站点目录里找同名文件）。",
        "secret 变量（密码 / 验证码）只说「secret」，不记长度、不记任何派生信息。",
        "返回的 draft 可以直接当 flow_replay 的参数用。",
      ].join(""),
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "草稿名（和 id 二选一）" },
          id: { type: "string", description: "草稿 id（文件名，不带 .json；也接受 flow_save_draft 返回的完整路径）" },
        },
        additionalProperties: false,
      },
      handler: async (input = {}) => {
        try {
          const name = typeof input.name === "string" ? input.name.trim() : "";
          const id = typeof input.id === "string" ? input.id.trim() : "";
          if (!name && !id) throw Object.assign(new Error("要给 name 或 id：先用 flow_list_drafts 看有哪些草稿"), { code: "INVALID_ARGUMENT" });
          const found = await readFlowDraft({ dataHome, name, id });
          return reply(`${formatDraft(found.draft)}\n文件：${found.path}`, {
            draft: found.draft,
            path: found.path,
            id: found.id,
            site: found.site,
          });
        } catch (error) {
          return failure(error, "读草稿失败");
        }
      },
    },
    {
      name: "flow_replay",
      title: "重放流程草稿",
      capability: Capability.EXECUTE,
      // 和 page_* 一样按格子授权：草稿 id 也叫 id，所以窗口参数名是 grid（registry 的 scopeArg）
      scope: "profile",
      scopeArg: "grid",
      description: [
        "拿一份草稿 + 变量值，在浏览器里逐步执行并逐步校验。参数是草稿（draft 对象，或 name / id 指定已存的草稿）和变量值（vars：变量名 → 值；也接受按顺序给的 values）。",
        "默认只做预演（干跑）：逐步列出将要执行的动作、哪些步骤回放不支持，一步都不碰页面，也不需要浏览器在运行。要真正执行必须同时满足两个条件：设置里的「流程回放允许真正执行」（flowReplayExecute）已打开，并且这次显式带 execute:true；开关关着时带 execute:true 直接返回 FEATURE_DISABLED。",
        "变量值一律不回显：返回文字和 structuredContent 里只给「是否已提供 / 长度」，任何值都不出现在返回、日志、错误里；secret 变量只在内存里用，不落盘。没标 secret 的老草稿按目标名重判，判不出来按 secret 处理。",
        "开跑前检查全部必填变量：缺 secret 或缺必填都直接拒绝，一步都不执行。",
        "每步先按多路定位找元素：ref 失效时按 testid > role+名称 > label > 文本 的顺序打分重找。多个同分候选判失败并列出候选（不瞎挑）；分数低于阈值或靠包含命中的步骤标为「脆弱」（照常执行，只是提醒改版后可能失效，dryRun 报告里会列出来）。",
        "执行后按草稿里的期望读回，并且只认「执行前没有、执行后出现」（输入框自己的 label 这种一直就有的文字不算证据）或 page_act 返回的 expectMet。结果分 成功 / 已派发未验证 / 失败 / 不确定 / 跳过：没有 expect 的写步骤只能是「已派发未验证」，总结果不会叫「重放成功」；提交类步骤之前还有没验证的写步骤时先停下。",
        "confirm 绑定到具体一步：confirmStep（第几步，从 1 数）+ confirmTarget（那一步的目标名，名字对不上就拒绝），执行前还会拿页面上实际命中的元素名再对一次，不一致就不执行。一次确认只放行那一步，别的提交步骤照样各自要确认；确认第 N（N > 1）步必须同时给 fromStep: N，否则前面的写动作会重发。老的 confirm:true 不再自动放行任何步骤。",
        "fromStep（从第几步续跑，从 1 数）：前面的步骤一律不执行，已经发出去的写动作绝不重发；fromStep 越界直接拒绝。NEEDS_CONFIRM / UNCERTAIN 时返回里会给出 confirmStep / fromStep 建议。",
        "草稿有 secret 变量时站点核对不通过（当前页面域名和草稿记的站点不一致）直接停，绝不往别的站点填密码；没有 secret 时才只提醒。草稿站点是 unknown / 空又带 secret 时，必须显式给 expectSite 才继续。",
        "草稿里的 navigate 步骤会真的执行（走浏览器导航通道），导航后读回地址才算成功；没有导航通道 / 没有地址时直接拒绝，不会静默跳过。口令作用域的域名白名单对回放同样生效：草稿站点或导航地址不在允许范围时开跑前就拒绝（一步都不发），内联 draft 和已存草稿都绕不过去。",
        "dryRun:true 配合 execute:true 时只做定位检查、不执行动作，用来判断网站改版后草稿还能不能用；不带 execute:true 时一律按预演处理（不读页面）。",
        "重放要先知道在哪个格子里跑：用 grid + space 指定（和 page_* 一样）；只给 space 时会去找那个空间所在的格子，只给 grid 时会在那个格子里找唯一的 AI 空间，解析不出唯一目标就拒绝执行，绝不落到人用的「我的」空间。",
        "每一步都会写进重放审计（<数据目录>/logs/flow-replay/ 下，只记动作 / 目标 / 结果，不记任何输入值），不会污染 flow_save_draft 抽取用的 mcp-calls 日志。",
      ].join(""),
      inputSchema: {
        type: "object",
        properties: {
          grid: { type: "string", description: "在哪个格子里重放（账号 id，或「格子 1」「slot:1」「1」）" },
          space: { type: "string", description: "在哪个空间里重放（空间 id 或名字）；不给就是「我的」，AI 做任务时应该指定自己的空间" },
          name: { type: "string", description: "已存草稿的名字（和 id / draft 三选一）" },
          id: { type: "string", description: "已存草稿的 id（文件名，不带 .json；也接受保存时返回的完整路径）" },
          draft: { type: "object", description: "草稿对象（flow_get_draft 返回的 draft），给了就不用 name / id" },
          vars: {
            type: "object",
            description: "变量名 → 值，例如 {\"姓名\":\"张三\",\"电话\":\"13900001111\"}；secret 变量也只放在这里",
          },
          values: { type: "array", items: { type: "string" }, description: "按草稿里 variables 的顺序给值（老调用方式）" },
          confirmStep: { type: "integer", description: "确认第几步（从 1 数）；只放行这一步。第 N > 1 步必须同时给 fromStep: N，否则前面的写动作会重发" },
          confirmTarget: { type: "string", description: "confirmStep 那一步的目标名；和草稿里的 target、页面上实际命中的元素名都对不上就拒绝 / 不执行" },
          fromStep: { type: "integer", description: "从第几步开始跑（从 1 数）；前面的步骤一律不执行、不重发" },
          expectSite: { type: "string", description: "草稿站点是 unknown / 空又带 secret 变量时必须给：这次要填密码的域名（例如 login.example.com）" },
          execute: { type: "boolean", description: "显式要求真正执行（默认不传 = 只预演）。必须先在设置里打开 flowReplayExecute；开关关着时传 true 会返回 FEATURE_DISABLED" },
          dryRun: { type: "boolean", description: "配合 execute:true 时只做定位检查，不执行任何动作；不带 execute:true 时一律按预演处理" },
          maxSteps: { type: "integer", description: "最多跑几步（调试用；0 表示一步都不跑，绝不当成「不限」；只接受整数，解析不出数字直接拒绝）" },
        },
        additionalProperties: false,
      },
      handler: async (input = {}, context = {}) => {
        try {
          // 目标格子：id 是草稿 id，格子用 grid 传（两个都叫 id 会撞，所以分开）
          const grid = typeof input.grid === "string" ? input.grid.trim() : "";
          const space = typeof input.space === "string" ? input.space.trim() : "";
          let draft = input.draft;
          if (!draft) {
            const name = typeof input.name === "string" ? input.name.trim() : "";
            const id = typeof input.id === "string" ? input.id.trim() : "";
            if (!name && !id) throw Object.assign(new Error("要给 draft，或者用 name / id 指定已存的草稿"), { code: "INVALID_ARGUMENT" });
            draft = (await readFlowDraft({ dataHome, name, id })).draft;
          }
          const vars = input.vars && typeof input.vars === "object" && !Array.isArray(input.vars) ? input.vars : {};
          const values = Array.isArray(input.values) ? input.values : [];
          /*
           * 默认只预演：不创建浏览器依赖，也不连控制服务（连带测试都不该碰真实端口）。
           * 真正执行要两道闸：设置里的 flowReplayExecute 已打开 + 这次显式 execute:true。
           */
          const wantsExecute = input.execute === true;
          const executeEnabled = await flowReplayExecuteEnabled(dataHome);
          if (wantsExecute && !executeEnabled) return featureDisabledReply();
          const previewMode = !wantsExecute;
          // 值为空 / 动态码的变量不往日志里带：日志层只记键名和长度，这里再提醒一句
          const browserDeps = previewMode ? null : (browser ?? (await defaultBrowser({ dataHome })));
          // 只给 space 不给 grid：target 里只剩 space，由 replayDraft 交给 resolveTarget 去找格子（绝不落到「我的」）
          const target = grid ? { id: grid, space: space || undefined } : (space ? { space } : null);
          // 每一步写进调用日志 / 动作审计：复用 action-policy 的审计字段（不记任何输入值）
          const audit = (entry) => {
            if (typeof logStep !== "function") return;
            logStep(entry);
          };
          /*
           * 只给 space 时格子是运行时解析出来的，bridge 只能核对显式 grid —— 这里用同一份
           * 口令作用域 / 连接器授权再核对一次，防止「换个方式指定格子」绕过。
           */
          const allowedProfiles = Array.isArray(context?.scope?.profiles) ? context.scope.profiles.map(String) : null;
          const connectorProfiles = Array.isArray(context?.connector?.profiles) ? context.connector.profiles.map(String) : null;
          const profileAllowed = (id) => {
            const wanted = String(id ?? "").trim();
            if (!wanted) return false;
            if (allowedProfiles && !allowedProfiles.includes(wanted)) return false;
            if (connectorProfiles && !connectorProfiles.includes(wanted)) return false;
            return true;
          };
          /*
           * 域名白名单（口令作用域里的 domains；连接器的作用域也是从 connector.scope 取到 context.scope，
           * 这里只有一道判断）：flow_replay 的参数里没有 url，地址藏在草稿的站点和 navigate 步骤里，
           * checkToolArguments 按工具名查表根本看不到它。这里把同一份判断（checkUrlAllowed + scope.domains）
           * 注入回放，草稿站点、expectSite 和每个导航地址都过一遍，内联 draft 和已存草稿两条路都覆盖
           * —— 不让「换条通道」绕过人对这个口令设的域名范围。
           */
          const scopeDomains = Array.isArray(context?.scope?.domains) ? context.scope.domains : null;
          const urlAllowed = scopeDomains === null
            ? () => ({ ok: true })
            : (url) => checkUrlAllowed("browser_navigate", { url }, { domains: scopeDomains });
          const result = await replayDraft(draft, {
            vars,
            values,
            confirmStep: input.confirmStep,
            confirmTarget: input.confirmTarget,
            fromStep: input.fromStep,
            dryRun: previewMode ? true : input.dryRun === true,
            preview: previewMode,
            maxSteps: input.maxSteps,
            expectSite: input.expectSite,
            target,
            profileAllowed,
            urlAllowed,
            audit,
            browser: browserDeps,
          });
          return reply(formatReplay(result), { ...result, draft: { name: draft.name ?? "", site: draft.site ?? "" } });
        } catch (error) {
          return failure(error, "重放失败");
        }
      },
    },
  ];
}

/** 重放结果的人话摘要。 */
function formatReplay(result) {
  const icon = { [STEP_STATUS.SUCCESS]: "✓", [STEP_STATUS.DISPATCHED]: "~", [STEP_STATUS.FAILURE]: "✗", [STEP_STATUS.UNCERTAIN]: "?", [STEP_STATUS.SKIPPED]: "-", [STEP_STATUS.PLANNED]: "…" };
  const title = {
    [RUN_STATUS.SUCCESS]: "重放完成（每步都读回确认了）",
    [RUN_STATUS.PARTIAL]: "重放结束（有派发但没验证的写步骤）",
    [RUN_STATUS.FAILED]: "重放失败",
    [RUN_STATUS.UNCERTAIN]: "重放结果不确定",
    [RUN_STATUS.NEEDS_CONFIRM]: "需要确认（提交类步骤）",
    [RUN_STATUS.DRY_RUN]: result.preview ? "预演完成（没有执行任何动作）" : "干跑完成（只定位，没有执行）",
    [RUN_STATUS.NOOP]: "没有执行任何步骤",
  }[result.status] ?? `重放结束（${result.status}）`;
  const planned = Array.isArray(result.steps) ? result.steps.filter((step) => step.status === STEP_STATUS.PLANNED).length : 0;
  const lines = [
    result.preview
      ? `${title}：共 ${result.total} 步，其中 ${planned} 步计划执行${result.unsupported?.length ? `，${result.unsupported.length} 步回放不支持` : ""}`
      : `${title}：${result.completed}/${result.total} 步${result.dispatched ? `（其中 ${result.dispatched} 步已派发未验证）` : ""}${result.dryRun ? "（干跑）" : ""}`,
    result.message,
  ];
  if (result.unsupported?.length) {
    lines.push(`不支持的步骤：${result.unsupported.map((item) => `第 ${item.index} 步 ${item.action}${item.target ? `「${item.target}」` : ""}（${item.reason}）`).join("；")}`);
  }
  if (result.warning) lines.push(`注意：${result.warning}`);
  if (result.variables?.length) {
    // 任何变量值都不回显：只给「已给 / 未给」和（非 secret 的）长度
    lines.push(`变量：${result.variables.map((item) => `${item.name}=${item.provided ? (item.secret ? "已给（secret，不回显）" : "已给（不回显）") : "未给"}${item.length !== undefined ? `（长度 ${item.length}）` : ""}`).join("，")}`);
  }
  if (result.steps?.length) {
    lines.push("步骤：");
    for (const step of result.steps) {
      const bits = [`${icon[step.status] ?? "?"} ${step.index}. ${step.action}`, step.target ? `「${step.target}」` : ""];
      if (step.ref) bits.push(`ref=${step.ref}（${step.locator ?? "?"}，分数 ${step.score ?? "?"}${step.fragile ? "，脆弱" : ""}）`);
      if (step.candidates?.length) bits.push(`候选 ${step.candidates.join("、")}`);
      if (step.value) bits.push(`值 ${step.value}`);
      if (step.note) bits.push(step.note);
      lines.push(`  ${bits.filter(Boolean).join(" ")}`);
    }
  }
  if (result.current?.url) lines.push(`当前页面：${result.current.url}`);
  if (result.next_step) lines.push(`下一步：${result.next_step}`);
  return lines.join("\n");
}

export { isEphemeralValue };
