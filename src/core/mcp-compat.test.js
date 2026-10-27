/**
 * MCP 工具清单兼容性测试。
 *   node --test src/core/mcp-compat.test.js
 *
 * 覆盖：
 *   ① 清单硬限制：instructions < 32,768 字节、工具名 ≤ 128（外部转发最长拼接）、
 *      原始描述 ≤ 1,985、追加提示后 ≤ 2,000、工具总数 ≤ 100、capabilities.tools 非空；
 *   ② DeepSeek / Kimi / 智谱（GLM）拿到 strict 兼容视图（去掉 6 个关键字），
 *      其它客户端拿原样 schema；参数名恰好叫 pattern 的不会被误删；注册表不被改写；
 *   ③ 经 MCP 层 tools/call 测校验：required / type / enum 在两套客户端下都被拦；
 *   ④ 写操作类工具（WRITE 分组 + admin/execute/外部转发 + destructiveHint）的描述只追加一次；
 *   ⑤ clientInfo.name 只决定展示视图，不参与 tools/call 的校验 / 放行 / 闸门；
 *   ⑥ createServerInstructions 出口受 32KB 上限保护。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BridgeServer } from "./bridge.js";
import {
  MAX_INSTRUCTIONS_BYTES,
  SERVER_INSTRUCTIONS,
  assertInstructionsWithinLimit,
  createMcpServer,
  createServerInstructions,
} from "./bridge.js";
import {
  STRICT_UNSUPPORTED_KEYWORDS,
  WRITE_SERIAL_NOTE,
  collectStrictKeywords,
  isStrictCompatClient,
  isWriteLike,
  stripUnsupportedKeywords,
  withWriteSerialNote,
} from "./mcp-compat.js";
import {
  externalToolName,
  getTool,
  listTools,
  registerTool,
  registerTools,
  unregisterTool,
} from "./registry.js";
import { ToolGroup } from "./tool-policy.js";
import { defineAppTools } from "../tools/app.js";
import { defineBrowserTools } from "../tools/browser.js";
import { defineContextTools } from "../tools/context.js";
import { defineCustomToolAdmin } from "../tools/custom.js";
import { defineFlowTools } from "../tools/flow.js";
import { defineBuiltinTools } from "../tools/toolset.js";

const PROBE = "compat_probe";
const PROBE_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    value: { type: "string", minLength: 3, maxLength: 10, pattern: "^[a-z]+$", format: "hostname" },
    list: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", minLength: 1 } },
    // 顶层枚举：validateArgs 会校验 enum，用来证明兼容会话下枚举也照常拦（不被精简）
    mode: { type: "string", enum: ["fast", "safe"] },
    // 参数名恰好叫 pattern：兼容视图只删关键字，不能把参数名一起删掉
    pattern: { type: "string", minLength: 2 },
  },
  required: ["value"],
  additionalProperties: false,
});

function tempHome() {
  return mkdtempSync(path.join(os.tmpdir(), "mcp-compat-"));
}

function registerProductionTools(dataHome) {
  registerTools(defineBuiltinTools({
    control: {},
    terminal: {},
    guard: { roots: [] },
    mcpConfigPath: path.join(dataHome, "external-mcp.json"),
    externalMcp: {},
    broker: {},
  }));
  registerTools(defineBrowserTools());
  registerTools(defineAppTools());
  registerTools(defineFlowTools({ dataHome }));
  registerTools(defineContextTools({ bus: {} }));
  registerTools(defineCustomToolAdmin({ dataHome }));
}

// 体检清单要和真实运行覆盖同一批工具：内置 + 浏览器 + 软件控制 + 流程草稿 + 共享上下文 + 自定义工具管理
const MODULE_HOME = tempHome();
registerProductionTools(MODULE_HOME);

const PROBE_HANDLER = async (input) => {
  if (String(input?.value ?? "").length < 3) throw new Error("value 太短");
  if (Array.isArray(input?.list) && input.list.length > 3) throw new Error("list 太长");
  return { content: [{ type: "text", text: `ok:${input.value}` }] };
};
registerTool({
  name: PROBE,
  title: "兼容性探针",
  capability: "read",
  description: "测试用：带满 strict 不支持关键字的 schema。",
  inputSchema: PROBE_SCHEMA,
  handler: PROBE_HANDLER,
});

test.after(() => {
  unregisterTool(PROBE);
  rmSync(MODULE_HOME, { recursive: true, force: true });
});

async function startServer(dataHome) {
  const server = new BridgeServer({ routeToken: "mcp-compat-route-token", dataHome, port: 0, jsonResponse: true });
  await server.start();
  return server;
}

async function rpc(url, body, { sid } = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sid ? { "mcp-session-id": sid } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null, sid: response.headers.get("mcp-session-id") };
}

async function connect(url, clientName) {
  const init = await rpc(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "1" } },
  });
  assert.equal(init.response.status, 200, `${clientName} initialize 失败：${JSON.stringify(init.body)}`);
  const listed = await rpc(url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { sid: init.sid });
  return { init: init.body?.result ?? {}, tools: listed.body?.result?.tools ?? [], sid: init.sid };
}

async function call(url, session, name, args) {
  const result = await rpc(url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } }, { sid: session.sid });
  return result.body?.result ?? null;
}

async function stopAndRemove(server, ...dirs) {
  await server.stop();
  await new Promise((resolve) => setTimeout(resolve, 80));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

function countOccurrences(text, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = String(text).indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

/* ------------------------------------------------------------------ *
 * ① 各家客户端的硬限制
 * ------------------------------------------------------------------ */
test("工具清单满足 instructions / 名称 / 描述 / 数量 / capabilities 限制", async () => {
  const dataHome = tempHome();
  const server = await startServer(dataHome);
  try {
    const session = await connect(`${server.localUrl}`, "compat-metrics");
    const instructions = String(session.init.instructions ?? "");
    assert.ok(Buffer.byteLength(instructions, "utf8") < 32768, `instructions 超限：${Buffer.byteLength(instructions, "utf8")} 字节`);
    assert.ok(session.init.capabilities?.tools, "capabilities.tools 不能缺失");
    assert.ok(Object.keys(session.init.capabilities.tools).length > 0, "capabilities.tools 不能是空对象");
    assert.ok(session.tools.length > 0, "工具清单为空");
    assert.ok(session.tools.length <= 100, `工具总数超限：${session.tools.length}`);

    // Claude Code 的实际上限是 128；本注册表正则 /^[a-z][a-z0-9_]{2,63}$/ 已经把本地工具限死 64。
    // 真正会长的是外部转发名 ext__<服务器>__<上游工具>，用 externalToolName 构造最长情况来断言。
    for (const tool of session.tools) {
      assert.ok(String(tool.name).length <= 128, `${tool.name} 名字超过 Claude Code 的 128 上限：${String(tool.name).length}`);
    }
    const longestExternal = externalToolName("x".repeat(80), "y".repeat(200));
    assert.ok(longestExternal.length <= 128, `最长外部工具名超过 128：${longestExternal.length}`);

    // 描述拆成两条：原始描述 ≤1985（给追加提示预留 15 字符），追加提示后 ≤2000。
    // 这样以后有人加并行提示或改描述，能立刻看出是哪一条越界。
    for (const tool of session.tools) {
      const description = String(tool.description ?? "");
      const hasNote = description.includes(WRITE_SERIAL_NOTE);
      const raw = hasNote ? description.replace(` ${WRITE_SERIAL_NOTE}。`, "") : description;
      assert.ok(raw.length <= 1985, `${tool.name} 原始描述过长：${raw.length} 字符（上限 1985）`);
      assert.ok(description.length <= 2000, `${tool.name} 描述过长：${description.length} 字符（上限 2000）`);
    }

    // 写操作类工具：每一条都要有并行提示，且只出现一次；只读工具不能混进来
    const writeLikeTools = listTools().filter((tool) => isWriteLike(tool));
    assert.ok(writeLikeTools.length > 0);
    const byName = new Map(session.tools.map((tool) => [tool.name, tool]));
    for (const tool of writeLikeTools) {
      const listed = byName.get(tool.name);
      assert.ok(listed, `写操作类工具 ${tool.name} 不在清单里`);
      assert.equal(countOccurrences(listed.description, WRITE_SERIAL_NOTE), 1, `${tool.name} 的并行提示不是恰好一次`);
    }
    assert.equal(countOccurrences(byName.get("page_snapshot")?.description ?? "", WRITE_SERIAL_NOTE), 0, "只读工具不应有并行提示");
    assert.equal(countOccurrences(byName.get("read_files")?.description ?? "", WRITE_SERIAL_NOTE), 0, "只读文件工具不应有并行提示");
  } finally {
    await stopAndRemove(server, dataHome);
  }
});

test("page_act 描述按审查要求精简：追加提示后仍给上限留余量，细节在参数说明里", async () => {
  const dataHome = tempHome();
  const server = await startServer(dataHome);
  try {
    const session = await connect(`${server.localUrl}`, "compat-metrics");
    const pageAct = session.tools.find((tool) => tool.name === "page_act");
    assert.ok(pageAct, "清单里缺少 page_act");
    // 原描述（去掉写提示）压到 1900 以内：追加提示后离 2000 还有 85+ 字符余量
    const raw = String(pageAct.description).replace(` ${WRITE_SERIAL_NOTE}。`, "");
    assert.ok(raw.length <= 1900, `page_act 描述仍过长：${raw.length} 字符（审查要求压到 1900 以下）`);
    // 信息不丢：动作清单、批量填表、提交闸门这些关键说明都在（细节可以移到参数说明，但必须在清单里）
    const schema = pageAct.inputSchema ?? {};
    const details = [
      "批量填表",
      "confirm:true",
      "REF_STALE",
      "DIALOG_OPEN",
      "outcome",
      "navigation",
      "PATH_DENIED",
      "space_close",
    ];
    for (const word of details) assert.ok(raw.includes(word), `page_act 描述丢了关键说明：${word}`);
    const actionText = String(schema.properties?.action?.description ?? "");
    for (const action of schema.properties?.action?.enum ?? []) {
      assert.ok(actionText.includes(action), `action 参数说明里缺少 ${action}`);
    }
    const fieldsText = String(schema.properties?.fields?.description ?? "");
    for (const word of ["批量填表", "checkbox", "radio", "confirm:true"]) {
      assert.ok(fieldsText.includes(word), `fields 参数说明里缺少 ${word}`);
    }
  } finally {
    await stopAndRemove(server, dataHome);
  }
});

test("会写盘 / 跑命令的 admin 工具也有并行提示（不只 WRITE 分组）", async () => {
  const dataHome = tempHome();
  const server = await startServer(dataHome);
  try {
    const session = await connect(`${server.localUrl}`, "compat-admin-note");
    const byName = new Map(session.tools.map((tool) => [tool.name, tool]));
    // run_command 会改磁盘、跑脚本，但分组是 admin；以前拿不到提示。
    for (const name of ["run_command", "admin_run"]) {
      const entry = getTool(name);
      assert.ok(entry, `缺少 ${name}`);
      assert.equal(entry.group, ToolGroup.ADMIN, `${name} 的分组应仍是 admin（不能为了提示改分组）`);
      assert.equal(isWriteLike(entry), true, `${name} 应被判为写操作类`);
      assert.equal(countOccurrences(byName.get(name)?.description ?? "", WRITE_SERIAL_NOTE), 1, `${name} 缺少并行提示`);
    }
    // 判定不能连累只读工具
    assert.equal(isWriteLike(getTool("read_files")), false);
    assert.equal(isWriteLike(getTool("page_snapshot")), false);
    // 纯函数边界：外部转发工具（source external:）是 admin，应命中
    assert.equal(isWriteLike({ name: "ext__x__y", source: "external:x", capability: "read" }), true);
    // destructiveHint 也算
    assert.equal(isWriteLike({ name: "foo", capability: "read", annotations: { destructiveHint: true } }), true);
  } finally {
    await stopAndRemove(server, dataHome);
  }
});

test("read_result 只是读分页结果：不进注册表也不能被加上写操作并行提示", async () => {
  const dataHome = tempHome();
  const server = await startServer(dataHome);
  try {
    const session = await connect(`${server.localUrl}`, "compat-admin-note");
    const readResult = session.tools.find((tool) => tool.name === "read_result");
    assert.ok(readResult, "清单里缺少 read_result");
    assert.equal(countOccurrences(readResult.description ?? "", WRITE_SERIAL_NOTE), 0, "只读的 read_result 被加了写操作提示");
    // 判定层也给出同样的结论：没有 group 的只读工具不能因为兜底 admin 就被当成写操作
    const shape = {
      name: "read_result",
      description: "分页读取",
      annotations: { readOnlyHint: true, destructiveHint: false },
    };
    assert.equal(isWriteLike(shape), false, "没 group 的只读工具被兜底判成写操作");
    assert.equal(isWriteLike({ ...shape, group: "read" }), false);
  } finally {
    await stopAndRemove(server, dataHome);
  }
});

/* ------------------------------------------------------------------ *
 * ② strict 兼容视图
 * ------------------------------------------------------------------ */
test("DeepSeek / Kimi / 智谱拿到精简 schema，其它客户端拿原样", async () => {
  const dataHome = tempHome();
  const server = await startServer(dataHome);
  try {
    const url = server.localUrl;
    const originalProbe = getTool(PROBE).inputSchema;

    for (const clientName of ["DeepSeek Harness", "kimi-code-cli", "GLM-4.6", "ZhipuAI"]) {
      assert.equal(isStrictCompatClient(clientName), true, `${clientName} 应该命中兼容视图`);
      const session = await connect(url, clientName);
      const probe = session.tools.find((tool) => tool.name === PROBE);
      assert.ok(probe, `${clientName} 没拿到 ${PROBE}`);
      assert.deepEqual([...collectStrictKeywords(probe.inputSchema)], [], `${clientName} 的 schema 仍有关键字`);
      // 参数名 pattern 必须保留（find_files 真有用叫 pattern 的参数）
      assert.equal(probe.inputSchema?.properties?.pattern?.type, "string", `${clientName} 把参数名 pattern 删掉了`);
      assert.equal(probe.inputSchema?.properties?.value?.type, "string");
      const searchFiles = session.tools.find((tool) => tool.name === "search_files");
      assert.ok(searchFiles, "缺少 search_files");
      assert.equal(searchFiles.inputSchema?.properties?.pattern?.type, "string", "search_files 的 pattern 参数被误删");
      assert.equal(searchFiles.inputSchema?.properties?.pattern?.minLength, undefined);
      const findFiles = session.tools.find((tool) => tool.name === "find_files");
      assert.ok(findFiles, "缺少 find_files");
      assert.equal(findFiles.inputSchema?.properties?.patterns?.type, "array", "find_files 的 patterns 参数被误删");
      assert.equal(findFiles.inputSchema?.properties?.patterns?.minItems, undefined);
      assert.equal(findFiles.inputSchema?.properties?.patterns?.maxItems, undefined);
      const readFiles = session.tools.find((tool) => tool.name === "read_files");
      assert.equal(readFiles.inputSchema?.properties?.files?.maxItems, undefined);
    }

    for (const clientName of ["Claude Code", "some-other-client"]) {
      assert.equal(isStrictCompatClient(clientName), false, `${clientName} 不应该命中兼容视图`);
      const session = await connect(url, clientName);
      const probe = session.tools.find((tool) => tool.name === PROBE);
      assert.deepEqual(probe.inputSchema, JSON.parse(JSON.stringify(PROBE_SCHEMA)), `${clientName} 拿到的 schema 被改过`);
      const readFiles = session.tools.find((tool) => tool.name === "read_files");
      assert.equal(readFiles.inputSchema?.properties?.files?.maxItems, 20, `${clientName} 的 read_files 丢了 maxItems`);
    }

    // tools/list 只影响给客户端的视图，注册表里的原 schema 不能被改
    assert.deepEqual(getTool(PROBE).inputSchema, JSON.parse(JSON.stringify(PROBE_SCHEMA)), "注册表 schema 被兼容视图改掉了");
    assert.ok(collectStrictKeywords(originalProbe).has("minLength"));
  } finally {
    await stopAndRemove(server, dataHome);
  }
});

test("兼容会话与普通会话都不改写注册表 schema（逐个对比 strict 关键字）", async () => {
  const dataHome = tempHome();
  const server = await startServer(dataHome);
  try {
    const url = server.localUrl;
    // 先记下注册表里每个工具的原 schema 关键字（快照），再开两种会话各列一次清单，最后复查注册表。
    const before = new Map(listTools().map((tool) => [tool.name, [...collectStrictKeywords(tool.inputSchema)].sort()]));
    const plain = await connect(url, "Claude Code");
    const compat = await connect(url, "DeepSeek Harness");
    const plainByName = new Map(plain.tools.map((tool) => [tool.name, tool]));
    const compatByName = new Map(compat.tools.map((tool) => [tool.name, tool]));

    for (const [name, keywordsBefore] of before) {
      const plainTool = plainByName.get(name);
      const compatTool = compatByName.get(name);
      if (!plainTool || !compatTool) continue; // 基础档 / 作用域过滤掉的不比
      // 普通会话：给的就是原 schema
      assert.deepEqual(
        [...collectStrictKeywords(plainTool.inputSchema)].sort(),
        keywordsBefore,
        `${name} 普通会话拿到的 schema 和注册表不一致`,
      );
      // 兼容会话：严格为空
      assert.deepEqual([...collectStrictKeywords(compatTool.inputSchema)], [], `${name} 兼容会话仍有关键字`);
      // 注册表本身没被改写
      assert.deepEqual(
        [...collectStrictKeywords(getTool(name).inputSchema)].sort(),
        keywordsBefore,
        `${name} 注册表 schema 被兼容视图改掉了`,
      );
    }
  } finally {
    await stopAndRemove(server, dataHome);
  }
});

test("兼容视图只删 6 个关键字：confirm / enum / required 与注册表完全一致", async () => {
  const dataHome = tempHome();
  const server = await startServer(dataHome);
  try {
    const compat = await connect(`${server.localUrl}`, "DeepSeek Harness");
    const byName = new Map(compat.tools.map((tool) => [tool.name, tool]));
    // 安全相关参数：提交闸门 confirm 不能被删、action / diff 的枚举不能被放宽、required 不能少
    for (const name of ["page_act", "apply_patch", "run_command", PROBE]) {
      const entry = getTool(name);
      assert.ok(entry, `缺少 ${name}`);
      const listed = byName.get(name);
      assert.ok(listed, `兼容会话缺少 ${name}`);
      const original = JSON.parse(JSON.stringify(entry.inputSchema));
      // 兼容视图 == 原 schema 去掉 6 个关键字（深比较，不是只看差集）
      assert.deepEqual(listed.inputSchema, JSON.parse(JSON.stringify(stripUnsupportedKeywords(original))), `${name} 兼容视图和「只删 6 个关键字」不一致`);
      assert.deepEqual(listed.inputSchema.required, original.required, `${name} 的 required 被兼容视图改动了`);
      for (const [prop, schema] of Object.entries(original.properties ?? {})) {
        const view = listed.inputSchema.properties?.[prop];
        assert.ok(view, `${name}.${prop} 被兼容视图删掉了`);
        if (schema.enum) assert.deepEqual(view.enum, schema.enum, `${name}.${prop} 的 enum 被放宽了`);
      }
      if (original.properties?.confirm) {
        assert.equal(listed.inputSchema.properties.confirm?.type, "boolean", `${name} 的 confirm 参数被兼容视图删掉 / 改型了`);
      }
    }
    // 注册表本身没被改写
    assert.equal(getTool("page_act").inputSchema.properties?.confirm?.type, "boolean");
    assert.deepEqual(getTool("page_act").inputSchema.properties?.action?.enum, ["click", "double_click", "type", "select", "check", "hover", "focus", "key", "scroll", "upload", "dialog"]);
  } finally {
    await stopAndRemove(server, dataHome);
  }
});

test("clientInfo.name 只决定展示视图：compatSchema 不参与 tools/call 校验 / 放行 / 闸门", async () => {
  const dataHome = tempHome();
  const server = await startServer(dataHome);
  try {
    const url = server.localUrl;
    // 任何客户端自称 DeepSeek / Kimi 都不能在调用层得到任何宽松：
    // 必备参数仍缺一不可，非法类型仍被拦（与普通客户端完全一致）。
    const liars = ["DeepSeek Harness", "kimi", "glm-4.6", "zhipu"];
    const honest = await connect(url, "Claude Code");
    for (const name of liars) {
      const session = await connect(url, name);
      const missing = await call(url, session, PROBE, {});
      assert.equal(missing?.isError, true, `${name} 缺必填没被拦`);
      assert.match(missing?.content?.[0]?.text ?? "", /缺少必填参数 value/);
      const wrongType = await call(url, session, PROBE, { value: 123 });
      assert.equal(wrongType?.isError, true, `${name} 类型错误没被拦`);
      // 结果与普通客户端一致
      const honestMissing = await call(url, honest, PROBE, {});
      assert.equal(missing?.content?.[0]?.text, honestMissing?.content?.[0]?.text, `${name} 与普通客户端的拒绝理由不一致`);
    }

    // 静态守门：bridge.js 里 compatSchema / isStrictCompatClient / stripUnsupportedKeywords
    // 只能出现在 tools/list 处理器里（import 区除外）。防止以后有人在 tools/call 里写
    // `if (isStrictCompatClient(...)) skip(...)` 用客户端自报名字放行。
    const bridgeSource = readFileSync(new URL("./bridge.js", import.meta.url), "utf8");
    const listHandlerStart = bridgeSource.indexOf("setRequestHandler(ListToolsRequestSchema");
    const callHandlerStart = bridgeSource.indexOf("setRequestHandler(CallToolRequestSchema");
    assert.ok(listHandlerStart >= 0 && callHandlerStart > listHandlerStart, "找不到 tools/list、tools/call 处理器");
    const guard = /isStrictCompatClient|compatSchema|stripUnsupportedKeywords/;
    // tools/call 及之后的全部代码里不能出现兼容判断
    const callHandler = bridgeSource.slice(callHandlerStart);
    assert.equal(guard.test(callHandler), false, "tools/call 里出现了兼容判断（禁止用客户端自报名字参与校验 / 放行）");
    // tools/list 之前（去掉 import 区）不能出现兼容判断
    const beforeList = bridgeSource.slice(0, listHandlerStart).replace(/^import[\s\S]*?;$/gm, "");
    assert.equal(guard.test(beforeList), false, "tools/list 之前（import 以外）出现了兼容判断");
  } finally {
    await stopAndRemove(server, dataHome);
  }
});

test("兼容视图不改变服务端调用校验（经 MCP 层，两种客户端都按原 schema 拦）", async () => {
  const dataHome = tempHome();
  const server = await startServer(dataHome);
  try {
    const url = server.localUrl;
    const compat = await connect(url, "DeepSeek Harness");
    const other = await connect(url, "Claude Code");

    // 证据 1：两套会话拿到的 schema 不同（兼容会话已去掉关键字），但注册表没被改。
    const compatProbe = compat.tools.find((tool) => tool.name === PROBE);
    assert.deepEqual([...collectStrictKeywords(compatProbe.inputSchema)], [], "兼容会话仍有关键字");
    assert.deepEqual(
      [...collectStrictKeywords(getTool(PROBE).inputSchema)].sort(),
      ["format", "maxItems", "maxLength", "minItems", "minLength", "pattern"],
      "注册表里的原 schema 被改掉了",
    );

    // 证据 2：经 MCP tools/call 传非法参数，两种客户端都被注册表的 validateArgs 拦下。
    // validateArgs 真正管的是 required / 顶层 type / enum（不看 minLength 等），所以这里专测这三项。
    for (const session of [compat, other]) {
      const label = session === compat ? "兼容会话" : "普通会话";

      // required：缺必填
      const missing = await call(url, session, PROBE, {});
      assert.equal(missing?.isError, true, `${label} 缺必填没被拦`);
      assert.match(missing?.content?.[0]?.text ?? "", /缺少必填参数 value/);

      // type：value 该是 string，给了 number
      const wrongType = await call(url, session, PROBE, { value: 123 });
      assert.equal(wrongType?.isError, true, `${label} 类型错误没被拦`);
      assert.match(wrongType?.content?.[0]?.text ?? "", /value 应为 string/);

      // type：list 该是 array，给了 string
      const wrongListType = await call(url, session, PROBE, { value: "abc", list: "not-array" });
      assert.equal(wrongListType?.isError, true, `${label} 数组类型错误没被拦`);
      assert.match(wrongListType?.content?.[0]?.text ?? "", /list 应为 array/);
    }

    // enum：PROBE 的 mode 是顶层枚举；两种客户端传非法值都在进 handler 之前被拦。
    for (const session of [compat, other]) {
      const badMode = await call(url, session, PROBE, { value: "abc", mode: "__bad__" });
      assert.equal(badMode?.isError, true, "枚举非法值没被拦");
      assert.match(badMode?.content?.[0]?.text ?? "", /mode 只能是/);
    }

    // 这里不测 minLength：validateArgs 本来就不执行它，拿 handler 自己的 "value 太短" 当证据
    // 只会让人误以为精简 schema 后面还有一道 schema 防线。真正的防线是上面的 required / type / enum。

    // 合法参数照常成功
    const ok = await call(url, compat, PROBE, { value: "abc", list: ["x"] });
    assert.notEqual(ok?.isError, true);
    assert.match(ok?.content?.[0]?.text ?? "", /ok:abc/);
  } finally {
    await stopAndRemove(server, dataHome);
  }
});

/* ------------------------------------------------------------------ *
 * ③ 纯函数
 * ------------------------------------------------------------------ */
test("兼容视图是深拷贝：去掉关键字但保留参数名和数据字段", () => {
  const view = stripUnsupportedKeywords(PROBE_SCHEMA);
  assert.deepEqual([...collectStrictKeywords(view)], []);
  assert.equal(view.properties.pattern.type, "string");
  assert.equal(view.properties.value.type, "string");
  assert.equal(view.properties.list.items.type, "string");
  // 原 schema 没被改
  assert.equal(PROBE_SCHEMA.properties.value.minLength, 3);
  assert.equal(PROBE_SCHEMA.properties.list.maxItems, 3);
  // 嵌套 anyOf 里的关键字也要去掉
  const nested = stripUnsupportedKeywords({ anyOf: [{ type: "string", minLength: 2 }, { type: "array", minItems: 1 }] });
  assert.deepEqual([...collectStrictKeywords(nested)], []);
  // 数据字段（default 里恰好叫 pattern）不能当关键字删掉
  const withDefault = stripUnsupportedKeywords({ type: "object", properties: { x: { type: "string", default: { pattern: "keep" } } } });
  assert.deepEqual(withDefault.properties.x.default, { pattern: "keep" });
  for (const keyword of STRICT_UNSUPPORTED_KEYWORDS) assert.equal(keyword in view.properties.value, false, keyword);
});

test("写操作提示幂等，客户端名匹配规则符合预期", () => {
  assert.equal(withWriteSerialNote("原说明"), `原说明 ${WRITE_SERIAL_NOTE}。`);
  assert.equal(withWriteSerialNote(withWriteSerialNote("原说明")), `原说明 ${WRITE_SERIAL_NOTE}。`);
  assert.equal(withWriteSerialNote(""), `${WRITE_SERIAL_NOTE}。`);
  assert.equal(isStrictCompatClient("DeepSeek"), true);
  assert.equal(isStrictCompatClient("DEEPSEEK-HARNESS"), true);
  assert.equal(isStrictCompatClient("kimi"), true);
  assert.equal(isStrictCompatClient("glm-4.6"), true);
  assert.equal(isStrictCompatClient("zhipu.ai"), true);
  assert.equal(isStrictCompatClient("Claude Code"), false);
  assert.equal(isStrictCompatClient("OpenAI Codex"), false);
  assert.equal(isStrictCompatClient(null), false);
});

test("createServerInstructions 出口受 DeepSeek Harness 32KB 上限保护", () => {
  assert.equal(createServerInstructions(), SERVER_INSTRUCTIONS);
  // 典型 extra 仍在上限内
  const typical = createServerInstructions("额外说明：任务卡请用 set_todos 维护。".repeat(10));
  assert.ok(Buffer.byteLength(typical, "utf8") < MAX_INSTRUCTIONS_BYTES, "典型 extra 超限");
  // 往 extra 里塞一大段（模拟有人拼工具清单）：必须抛错，不能静默发出去
  assert.throws(
    () => createServerInstructions("x".repeat(MAX_INSTRUCTIONS_BYTES)),
    /instructions 超过客户端硬上限/,
  );
  // 中文按 UTF-8 字节算，不是字符数
  const chinese = "中".repeat(20000); // 60000 字节
  assert.throws(() => createServerInstructions(chinese), /instructions 超过客户端硬上限/);
});

test("真正的生产出口也守门：boot / BridgeServer / createMcpServer 传超长 instructions 直接启动失败", async () => {
  const huge = "x".repeat(MAX_INSTRUCTIONS_BYTES);
  const dataHome = tempHome();
  try {
    // 守门函数本身：报错里要带真实字节数
    assert.throws(() => assertInstructionsWithinLimit(huge), /32768/);
    assert.equal(assertInstructionsWithinLimit("正常说明"), "正常说明");
    // BridgeServer 构造时（boot({ instructions }) 最终也走到这里）就失败，不会带着超长文本起来
    assert.throws(
      () => new BridgeServer({ routeToken: "mcp-compat-route-token", dataHome, port: 0, instructions: huge }),
      /instructions 超过客户端硬上限/,
    );
    // /mcp 与 /sse 共用的建服务入口同样守门（以后有人绕过 BridgeServer 直接调也拦得住）
    assert.throws(
      () => createMcpServer({ dataHome, instructions: huge }),
      /instructions 超过客户端硬上限/,
    );
    // 正常长度照常建得出来
    const server = createMcpServer({ dataHome, instructions: "短说明" });
    await server.close();
  } finally {
    rmSync(dataHome, { recursive: true, force: true });
  }
});
