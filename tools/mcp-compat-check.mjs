#!/usr/bin/env node
/**
 * MCP 工具清单兼容性体检。
 *
 *   node tools/mcp-compat-check.mjs
 *
 * 在进程内起一个 Bridge（参考 npm run selftest 的方式：boot + initialize + tools/list），
 * 然后把各家客户端的硬限制逐项量出来：
 *   · 工具总数（Devin 旧版 ≤ 100）
 *   · 每个工具名长度（Claude Code ≤ 128；本项目约定 ≤ 64）
 *   · 每个描述长度（Claude Code 报告为 4,096 / 16,384 字符；本项目按 2,000 收紧）
 *   · inputSchema 里 DeepSeek strict 不支持的 6 个关键字
 *   · initialize.instructions 的 UTF-8 字节数（DeepSeek Harness < 32,768）
 *   · tools/list 结果的 JSON 字节数
 *
 * 超限的项在状态列写「超限」。同一份数据写到 .tmp/mcp-compat.json。
 *
 * 同一次运行在同一个 Bridge 上开两个会话并排对比：
 *   · 普通客户端（mcp-compat-check）→ 原 schema（表中「原」那一列，即修前）；
 *   · DeepSeek Harness → strict 兼容视图（表中「兼容」那一列，即修后）。
 * 兼容会话里不该再出现 strict 不支持的关键字，否则脚本以非零退出。
 *
 * 数据目录和共享目录都放在当前目录的 .tmp 下，不碰用户目录和 data/。
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  STRICT_UNSUPPORTED_KEYWORDS,
  collectStrictKeywords,
} from "../src/core/mcp-compat.js";

// 按脚本所在位置找仓库根（tools/ 的上一级），别用 cwd：从别的目录调用时 .tmp / roots 不能跑偏。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = path.join(ROOT, ".tmp");
const DATA_HOME = path.join(TMP, "mcp-compat-data");
const SHARED_HOME = path.join(TMP, "mcp-compat-shared");
const OUT_FILE = path.join(TMP, "mcp-compat.json");

/** 本项目的验收阈值（减法来自各家文档，取了更严的一档）。 */
export const LIMITS = Object.freeze({
  toolCount: 100,
  toolNameLength: 64,
  descriptionLength: 2000,
  instructionsBytes: 32768,
});

process.env.BRIDGE_DATA_HOME = DATA_HOME;
process.env.BRIDGE_SHARED_DATA_HOME = SHARED_HOME;

const { boot } = await import("../src/standalone.js");
const { registerTools } = await import("../src/core/registry.js");
const { defineBrowserTools } = await import("../src/tools/browser.js");
const { defineAppTools } = await import("../src/tools/app.js");

/** 普通会话用的客户端名（不命中兼容规则，拿到原 schema）。 */
const PLAIN_CLIENT = "mcp-compat-check";
/** 命中兼容规则的客户端名（DeepSeek Harness 会拿到精简 schema）。 */
const COMPAT_CLIENT = "DeepSeek Harness";

const byteLength = (text) => Buffer.byteLength(String(text ?? ""), "utf8");

function readMcp(response) {
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return response.json();
  return response.text().then((text) => {
    const lines = text.split(/\r?\n/).filter((line) => line.startsWith("data:"));
    if (!lines.length) return JSON.parse(text);
    return JSON.parse(lines[lines.length - 1].slice(5));
  });
}

function pad(value, width) {
  const text = String(value);
  let used = 0;
  for (const char of text) used += /[\u4e00-\u9fff]/.test(char) ? 2 : 1;
  return text + " ".repeat(Math.max(0, width - used));
}

async function main() {
  await rm(DATA_HOME, { recursive: true, force: true });
  await rm(SHARED_HOME, { recursive: true, force: true });
  await mkdir(DATA_HOME, { recursive: true });
  await mkdir(SHARED_HOME, { recursive: true });

  // 纯命令行起 Bridge 时没有 Electron 主进程，浏览器控制服务不在线；
  // 但清单体检要覆盖浏览器工具，所以把定义直接注册进注册表再起服务。
  registerTools(defineBrowserTools());
  registerTools(defineAppTools());

  const app = await boot({
    roots: [ROOT],
    dataHome: DATA_HOME,
    browser: false,
    context: true,
    onLog: () => {},
  });

  // 分组从 listTools() 的 entry 拿（bridge.js 拼 tools/list 时不带 group）。
  // 必须在 boot 之后取：内置工具是 boot 时才注册进注册表的；read_result 不进注册表，单独补 READ。
  const { listTools } = await import("../src/core/registry.js");
  const groupByName = new Map(listTools().map((tool) => [tool.name, tool.group ?? null]));
  groupByName.set("read_result", "read");

  try {
    const url = app.server.localUrl;
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const post = (body, sid) => fetch(url, {
      method: "POST",
      headers: sid ? { ...headers, "mcp-session-id": sid } : headers,
      body: JSON.stringify(body),
    });

    // 同一个 Bridge 上开两个会话：普通客户端拿原 schema；DeepSeek Harness 拿兼容视图。
    // 这样一次运行就能同时给出「修前（原 schema）」和「修后（兼容视图）」的关键行。
    const session = async (clientName) => {
      const initResponse = await post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: clientName, version: "0" },
        },
      });
      const initBody = await readMcp(initResponse);
      const init = initBody?.result ?? {};
      const sid = initResponse.headers.get("mcp-session-id");
      const listBody = await readMcp(await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sid));
      return { clientName, init, listBody, tools: listBody?.result?.tools ?? [] };
    };

    const plain = await session(PLAIN_CLIENT);
    const compat = await session(COMPAT_CLIENT);

    // 以普通会话为准量「清单本身的硬限制」（工具数 / 名字 / 描述 / instructions）。
    const init = plain.init;
    const tools = plain.tools;
    const instructions = init.instructions ?? "";
    const capabilities = init.capabilities ?? {};

    // 按工具名把两个会话的 strict 关键字并起来算，方便并排看。
    const compatByName = new Map(compat.tools.map((tool) => [tool.name, tool]));
    const rows = tools.map((tool) => {
      const compatTool = compatByName.get(tool.name);
      const originalKeywords = [...collectStrictKeywords(tool.inputSchema)].sort();
      const compatKeywords = compatTool ? [...collectStrictKeywords(compatTool.inputSchema)].sort() : originalKeywords;
      const over = [];
      if (String(tool.name).length > LIMITS.toolNameLength) over.push("工具名");
      if (String(tool.description ?? "").length > LIMITS.descriptionLength) over.push("描述");
      return {
        name: tool.name,
        nameLength: String(tool.name).length,
        descriptionLength: String(tool.description ?? "").length,
        // 分组从 listTools() 的 entry 拿；read_result 不在注册表里，用上面补的 READ。
        group: groupByName.get(tool.name) ?? tool.group ?? null,
        strictKeywords: originalKeywords,
        compatStrictKeywords: compatKeywords,
        over,
      };
    });
    const options = await runtimeOptions();
    const strictHitBefore = rows.filter((row) => row.strictKeywords.length > 0);
    const strictHitAfter = rows.filter((row) => row.compatStrictKeywords.length > 0);
    const summary = {
      toolCount: tools.length,
      toolCountOver: tools.length > LIMITS.toolCount,
      instructionsBytes: byteLength(instructions),
      instructionsOver: byteLength(instructions) >= LIMITS.instructionsBytes,
      toolsListBytes: byteLength(JSON.stringify(tools)),
      toolsListResultBytes: byteLength(JSON.stringify(plain.listBody?.result ?? {})),
      capabilitiesToolKeys: Object.keys(capabilities.tools ?? {}),
      capabilitiesToolsEmpty: !capabilities.tools || (!Array.isArray(capabilities.tools) && Object.keys(capabilities.tools).length === 0),
      // 「修前 / 修后」的关键数字：命中兼容规则的客户端拿到的 schema 里还剩多少关键字。
      strictKeywordToolsBefore: strictHitBefore.length,
      strictKeywordToolsAfter: strictHitAfter.length,
      compatClient: COMPAT_CLIENT,
      plainClient: PLAIN_CLIENT,
      options,
    };

    const keywordWidth = Math.max(
      "strict 关键字(原/兼容)".length,
      ...rows.map((row) => `${row.strictKeywords.join(",") || "-"}/${row.compatStrictKeywords.join(",") || "-"}`.length),
    );
    const nameWidth = Math.max("工具名".length, ...rows.map((row) => row.name.length));
    const groupWidth = Math.max("分组".length, ...rows.map((row) => String(row.group ?? "-").length));
    console.log("MCP 工具清单兼容性体检");
    console.log(`工具总数：${summary.toolCount}（上限 ${LIMITS.toolCount}）${summary.toolCountOver ? " 超限" : ""}`);
    console.log(`instructions：${summary.instructionsBytes} 字节（上限 ${LIMITS.instructionsBytes - 1}）${summary.instructionsOver ? " 超限" : ""}`);
    console.log(`tools/list 字节数：${summary.toolsListBytes}（result 整体 ${summary.toolsListResultBytes} 字节）`);
    console.log(`capabilities.tools：${JSON.stringify(capabilities.tools ?? null)}${summary.capabilitiesToolsEmpty ? " 超限（空对象）" : ""}`);
    console.log("");
    console.log("strict 兼容对比（同一份清单在两个会话下的样子）");
    console.log(`  普通会话（${summary.plainClient}）：含 strict 不支持关键字的工具 ${summary.strictKeywordToolsBefore} 个`);
    console.log(`  兼容会话（${summary.compatClient}）：含 strict 不支持关键字的工具 ${summary.strictKeywordToolsAfter} 个${summary.strictKeywordToolsAfter === 0 ? "（兼容视图生效，修后）" : " 超限（兼容视图没生效）"}`);
    console.log(`  命中兼容规则并去掉关键字的工具：${strictHitBefore.length} → ${strictHitAfter.length}`);
    console.log("");
    console.log(`${pad("工具名", nameWidth)}  ${pad("名长", 4)}  ${pad("描述字数", 8)}  ${pad("分组", groupWidth)}  ${pad("strict 关键字(原/兼容)", keywordWidth)}  状态`);
    console.log(`${"-".repeat(nameWidth)}  ----  --------  ${"-".repeat(groupWidth)}  ${"-".repeat(keywordWidth)}  ----`);
    for (const row of rows) {
      const keywords = `${row.strictKeywords.join(",") || "-"}/${row.compatStrictKeywords.join(",") || "-"}`;
      console.log(`${pad(row.name, nameWidth)}  ${pad(row.nameLength, 4)}  ${pad(row.descriptionLength, 8)}  ${pad(row.group ?? "-", groupWidth)}  ${pad(keywords, keywordWidth)}  ${row.over.length ? `超限（${row.over.join("/")}）` : "正常"}`);
    }

    const report = {
      generatedAt: new Date().toISOString(),
      thresholds: LIMITS,
      strictUnsupportedKeywords: STRICT_UNSUPPORTED_KEYWORDS,
      initialize: {
        protocolVersion: init.protocolVersion ?? null,
        serverInfo: init.serverInfo ?? null,
        capabilities,
        instructions,
        instructionsBytes: summary.instructionsBytes,
      },
      compat: {
        plainClient: PLAIN_CLIENT,
        compatClient: COMPAT_CLIENT,
        toolsWithStrictKeywordsBefore: summary.strictKeywordToolsBefore,
        toolsWithStrictKeywordsAfter: summary.strictKeywordToolsAfter,
        tools: rows
          .filter((row) => row.strictKeywords.length || row.compatStrictKeywords.length)
          .map((row) => ({ name: row.name, before: row.strictKeywords, after: row.compatStrictKeywords })),
      },
      summary,
      tools: rows,
    };
    await writeFile(OUT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log("");
    console.log(`结果已写入：${OUT_FILE}`);

    if (
      summary.toolCountOver
      || summary.instructionsOver
      || summary.capabilitiesToolsEmpty
      || summary.strictKeywordToolsAfter > 0
      || rows.some((row) => row.over.length)
    ) {
      process.exitCode = 1;
    }
  } finally {
    await app.stop().catch(() => {});
  }
}

/** 各工具的口径参数（写操作提示等），用于解读体检结果；拿不到就返回空。 */
async function runtimeOptions() {
  try {
    const { isWriteLike, WRITE_SERIAL_NOTE } = await import("../src/core/mcp-compat.js");
    const { listTools } = await import("../src/core/registry.js");
    return {
      writeSerialNote: WRITE_SERIAL_NOTE,
      writeLikeTools: listTools().filter((tool) => isWriteLike(tool)).map((tool) => tool.name),
    };
  } catch {
    return {};
  }
}

main().catch((error) => {
  console.error(`兼容性体检失败：${error?.stack ?? error}`);
  process.exitCode = 1;
});
