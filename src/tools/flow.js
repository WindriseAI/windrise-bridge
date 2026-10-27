/**
 * 流程草稿工具 —— flow_save_draft / flow_list_drafts。
 *
 * 只做本地文件读写，不碰浏览器：素材来自调用日志（<数据目录>/logs/mcp-calls-*.jsonl），
 * 抽步骤和脱敏全在 core/flow-draft.js 里，这里只负责参数防御和给人看的回执。
 *
 * 为什么单独一个文件而不是塞进内置工具表：草稿依赖数据目录（dataHome），
 * 而内置工具表拿不到它；注册点放在 boot() 里，和上下文工具同一个位置。
 */

import path from "node:path";
import { Capability } from "../core/registry.js";
import {
  buildFlowDraft,
  flowDraftsDir,
  listFlowDrafts,
  saveFlowDraft,
} from "../core/flow-draft.js";

const reply = (text, data) => ({ content: [{ type: "text", text }], structuredContent: data });

/** 统一错误回执：保留错误码（例如 NO_CALLS），前端 / Agent 可以直接照着下一步做。 */
function failure(error) {
  const message = error?.message ?? String(error);
  return {
    content: [{ type: "text", text: `存草稿失败：${message}` }],
    structuredContent: { code: error?.code ?? "FLOW_DRAFT_FAILED", message },
    isError: true,
  };
}

export function defineFlowTools({ dataHome } = {}) {
  if (!dataHome) throw new Error("defineFlowTools 需要 dataHome");
  const draftsDir = flowDraftsDir(dataHome);

  return [
    {
      name: "flow_save_draft",
      title: "把刚跑通的流程存成草稿",
      capability: Capability.WRITE,
      description: [
        "把某个空间里刚跑通的一串 MCP 操作抽成流程草稿，存到本机（以后给 Skill / flow-pack 用）。",
        "数据来自本机调用日志，只收成功的步骤：写操作必须是 confirmed / dispatched，failed / unknown 的尝试会剔除；连续重复的快照读取合并成一步。",
        "隐私：type / fill 的输入值一律不写进草稿，替换成 {{var1}} 这样的变量占位符（只记名字和长度）；URL 去掉 token / code / session 这类参数；不记 cookie、口令、账号名。",
        "space 是空间 id 或名字（space_list 里能给）。不给 space 就用 since / until 里最近一次会话；都不给就取日志保留期内的最近一次会话。",
        "步骤里的 target 是可访问名 / 提示名或 CSS 选择器，不含快照编号 —— 编号每次都会变，写进去不能重放。",
      ].join(""),
      inputSchema: {
        type: "object",
        properties: {
          space: { type: "string", description: "空间 id 或名字；不给就按时间范围取最近一次会话" },
          name: { type: "string", description: "草稿名（可选，默认用空间名）" },
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
          const { path: file } = await saveFlowDraft({ dataHome, draft });
          const lines = [
            `已存流程草稿：${draft.name}`,
            `站点：${draft.site}`,
            `步骤：${draft.steps.length} 步，变量：${draft.variables.length} 个${draft.variables.length ? `（${draft.variables.map((v) => `${v.name} 长度 ${v.length ?? "未知"}`).join("，")}）` : ""}`,
            `来源：调用日志（${sessionCount} 个会话里取了最近一次）`,
            `文件：${file}`,
          ];
          if (draft.steps.some((step) => step.value)) lines.push("输入内容没有落盘，草稿里只有 {{varN}} 占位符。");
          return reply(lines.join("\n"), { draft, path: file });
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: "flow_list_drafts",
      title: "列出流程草稿",
      capability: Capability.READ,
      description: `列出本机已经存下的流程草稿（新的在前）。可按 site 过滤（域名或存储目录名）。草稿目录：${draftsDir}`,
      inputSchema: {
        type: "object",
        properties: {
          site: { type: "string", description: "只看这个站点（域名，如 example.com）" },
        },
        additionalProperties: false,
      },
      handler: async (input = {}) => {
        try {
          const drafts = await listFlowDrafts({ dataHome, site: typeof input.site === "string" ? input.site.trim() : "" });
          if (!drafts.length) {
            return reply("还没有流程草稿。先用 flow_save_draft 存一个。", { drafts: [], directory: draftsDir });
          }
          const lines = [
            `已有 ${drafts.length} 个流程草稿（${draftsDir}）：`,
            ...drafts.map((draft) => `- ${draft.name || "（未命名）"}｜${draft.site}｜${draft.steps} 步｜${draft.created_at}\n  ${draft.path}`),
          ];
          return reply(lines.join("\n"), { drafts, directory: draftsDir });
        } catch (error) {
          return failure(error);
        }
      },
    },
  ];
}
