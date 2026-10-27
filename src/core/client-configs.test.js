/**
 * 按客户端生成远程 MCP 配置的单元测试（纯 Node，不碰网络）：
 *   node --test src/core/client-configs.test.js
 *
 * 覆盖：
 *   - 每个客户端都能生成，关键字段在、JSON 能被解析；
 *   - 各家最容易写错的字段：Claude Code 的 type、Gemini 的 httpUrl、Cline 的 streamableHttp、
 *     Trae 没有 type、Cherry 的 baseUrl、VS Code 的 servers / mcpServers、Devin 旧版的 serverUrl、Codex 的 20/120 超时；
 *   - pathToken:false 时口令改走 Authorization: Bearer 头，路径里不留口令；
 *   - 口令优先于地址里的旧口令；地址没带 /mcp 时补成 <origin>/mcp；
 *   - 口令只出现在配置正文，不进 steps / notes；缺口令时给 <你的口令> / <你的口令-URL编码后> 占位并提示；
 *   - 不支持的客户端 supported:false 且给出原因；
 *   - 界面用的分组清单 buildClientConfigGroups。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildClientConfig, buildClientConfigGroups, CLIENTS, GROUPS, listClients, normalizeBaseUrl } from "./client-configs.js";
import {
  clientCopyToast,
  escapeHtml,
  pickClientCopy,
  renderClientConfigMode,
  renderClientDetails,
  renderClientRow,
} from "../../electron/ui/client-config-view.js";

const BASE = "https://demo.example.com/mcp";
const TOKEN = "abc123def456abc123def456abc123de";
const OPTS = { baseUrl: BASE, token: TOKEN };

/** 从配置文本里取 JSON（本文件的 JSON 类配置整段就是 JSON） */
function parseJson(text) {
  return JSON.parse(text);
}

function server(text) {
  return parseJson(text).mcpServers.windrise;
}

test("CLIENTS：key 唯一、分组都在 GROUPS 里、覆盖报告第 13 节的客户端", () => {
  const keys = CLIENTS.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length, "key 不能重复");
  for (const c of CLIENTS) {
    assert.ok(GROUPS.includes(c.group), `${c.key} 的分组 ${c.group} 不在 GROUPS 里`);
    assert.ok(c.name && c.name.length > 0);
  }
  for (const key of [
    "claude", "chatgpt", "claude-code", "codex", "gemini-cli", "cursor", "vscode", "devin",
    "devin-legacy", "cline", "cherry-studio", "trae", "kimi-code", "deepseek-harness", "lingma",
    "chatwise", "yuanbao", "doubao", "zhipu",
  ]) {
    assert.ok(keys.includes(key), `缺客户端 ${key}`);
  }
  assert.deepEqual(listClients().map((c) => c.key), keys, "listClients 是副本");
  listClients()[0].name = "改了也不影响原表";
  assert.notEqual(CLIENTS[0].name, "改了也不影响原表");
});

test("每个客户端都能生成：返回形状完整，不支持的带 reason", () => {
  for (const c of CLIENTS) {
    const cfg = buildClientConfig(c.key, OPTS);
    assert.equal(typeof cfg.kind, "string", c.key);
    assert.ok(["json", "toml", "yaml", "cli", "form"].includes(cfg.kind), `${c.key} kind=${cfg.kind}`);
    assert.equal(typeof cfg.text, "string", c.key);
    assert.ok(Array.isArray(cfg.steps), c.key);
    assert.ok(Array.isArray(cfg.notes), c.key);
    assert.ok(Array.isArray(cfg.variants), c.key);
    assert.equal(typeof cfg.supported, "boolean", c.key);
    if (!cfg.supported) {
      assert.ok(cfg.reason && cfg.reason.length > 0, `${c.key} 不支持时必须有 reason`);
    } else {
      assert.equal(cfg.reason, null, `${c.key} 支持时 reason 应为 null`);
    }
  }
});

test("buildClientConfigGroups：按 GROUPS 分组，覆盖全部客户端，不支持的带原因", () => {
  const groups = buildClientConfigGroups(OPTS);
  assert.deepEqual(groups.map((g) => g.group), GROUPS.filter((group) => CLIENTS.some((c) => c.group === group)));
  const flat = groups.flatMap((g) => g.clients);
  assert.equal(flat.length, CLIENTS.length);
  const expectedOrder = GROUPS.flatMap((group) => CLIENTS.filter((c) => c.group === group).map((c) => c.key));
  assert.deepEqual(flat.map((c) => c.key), expectedOrder);
  for (const item of flat) {
    assert.equal(typeof item.name, "string");
    assert.equal(typeof item.config.text, "string");
    if (!item.config.supported) assert.ok(item.config.reason);
  }
  const yuanbao = flat.find((c) => c.key === "yuanbao");
  assert.equal(yuanbao.config.supported, false);
});

test("Claude 网页/桌面/手机：表单步骤，地址带口令，不需要请求头", () => {
  const cfg = buildClientConfig("claude", OPTS);
  assert.equal(cfg.kind, "form");
  assert.ok(cfg.supported);
  assert.ok(cfg.text.includes(`${BASE}/${TOKEN}`), "地址里带口令");
  assert.ok(cfg.steps.join("\n").includes("Add custom connector"));
  assert.ok(cfg.notes.some((n) => n.includes("beta")), "要说明 Request headers 是 beta");
});

test("Claude pathToken:false：注意事项里给出 Bearer 请求头写法", () => {
  const cfg = buildClientConfig("claude", { ...OPTS, pathToken: false });
  assert.equal(cfg.kind, "form");
  assert.ok(cfg.text.includes(BASE));
  assert.ok(!cfg.text.includes(`${BASE}/${TOKEN}`), "路径里不该再带口令");
  const notes = cfg.notes.join("\n");
  assert.ok(notes.includes("authorization") && notes.includes("Bearer <口令>"));
});

test("Claude 请求头模式：text 的鉴权行改说 Request headers，不再写「口令在路径里」", () => {
  const cfg = buildClientConfig("claude", { ...OPTS, pathToken: false });
  assert.ok(cfg.text.includes("No sign-in + Request headers（beta）"), cfg.text);
  assert.ok(cfg.text.includes(`authorization: Bearer ${TOKEN}`), "text 里要给真实请求头");
  assert.ok(!cfg.text.includes("口令在路径里"), "不能自相矛盾");
});

test("ChatGPT：表单步骤，只支持 OAuth 或无鉴权", () => {
  const cfg = buildClientConfig("chatgpt", OPTS);
  assert.equal(cfg.kind, "form");
  assert.ok(cfg.supported);
  assert.ok(cfg.text.includes("No authentication"));
  assert.ok(cfg.notes.some((n) => n.includes("没有自定义请求头")));
  assert.ok(cfg.notes.join("\n").includes("Refresh"), "要提醒工具变更后点 Refresh");
});

test("Claude Code：必须有 type: http，pathToken 默认不加请求头", () => {
  const cfg = buildClientConfig("claude-code", OPTS);
  assert.equal(cfg.kind, "json");
  const entry = server(cfg.text);
  assert.equal(entry.type, "http");
  assert.equal(entry.url, `${BASE}/${TOKEN}`);
  assert.equal(entry.headers, undefined, "口令在路径里时不需要 headers");
  assert.equal(entry.timeout, 120000);
  assert.ok(cfg.notes.join("\n").includes('has a "url" but no "type"'));
});

test("Claude Code pathToken:false：改成 Authorization: Bearer 头，路径里不带口令", () => {
  const cfg = buildClientConfig("claude-code", { ...OPTS, pathToken: false });
  const entry = server(cfg.text);
  assert.equal(entry.type, "http");
  assert.equal(entry.url, BASE);
  assert.deepEqual(entry.headers, { Authorization: `Bearer ${TOKEN}` });
});

test("Codex：TOML，显式 startup_timeout_sec = 20 / tool_timeout_sec = 120", () => {
  const cfg = buildClientConfig("codex", OPTS);
  assert.equal(cfg.kind, "toml");
  assert.ok(cfg.text.includes("[mcp_servers.windrise]"));
  assert.ok(cfg.text.includes(`url = "${BASE}/${TOKEN}"`));
  assert.ok(cfg.text.includes("startup_timeout_sec = 20"));
  assert.ok(cfg.text.includes("tool_timeout_sec = 120"));
  assert.ok(!cfg.text.includes("bearer_token_env_var"), "口令在路径里时不用环境变量");
  const urlLine = cfg.text.split("\n").find((line) => line.startsWith('url = "'));
  assert.ok(urlLine && urlLine.length > 'url = ""'.length, "url 必须非空");
  assert.ok(!cfg.text.includes("http_headers"), "路径模式不写明文请求头");
});

test("Codex pathToken:false：改用 bearer_token_env_var，不把口令写进文件；明文版另放 variants", () => {
  const cfg = buildClientConfig("codex", { ...OPTS, pathToken: false });
  assert.ok(cfg.text.includes("bearer_token_env_var"));
  assert.ok(!cfg.text.includes(TOKEN), "默认不把口令明文写进 config.toml");
  assert.ok(cfg.text.includes(`url = "${BASE}"`));
  assert.equal(cfg.variants.length, 1);
  assert.ok(cfg.variants[0].text.includes(`Bearer ${TOKEN}`), "明文版是可复制的配置");
});

test("Gemini CLI：字段是 httpUrl，不能是 url", () => {
  const cfg = buildClientConfig("gemini-cli", OPTS);
  assert.equal(cfg.kind, "json");
  const entry = server(cfg.text);
  assert.equal(entry.httpUrl, `${BASE}/${TOKEN}`);
  assert.equal(entry.url, undefined, "写成 url 会被当 SSE");
  assert.ok(cfg.notes.join("\n").includes("httpUrl"));
});

test("Gemini pathToken:false：请求头带口令，URL 不带", () => {
  const entry = server(buildClientConfig("gemini-cli", { ...OPTS, pathToken: false }).text);
  assert.equal(entry.httpUrl, BASE);
  assert.deepEqual(entry.headers, { Authorization: `Bearer ${TOKEN}` });
});

test("Cursor：url + 含密钥提示", () => {
  const cfg = buildClientConfig("cursor", OPTS);
  const entry = server(cfg.text);
  assert.equal(entry.url, `${BASE}/${TOKEN}`);
  assert.ok(cfg.notes.join("\n").includes("含密钥"));
});

test("VS Code：text 是 .vscode/mcp.json 的 servers 版，可移植版另给 mcpServers", () => {
  const cfg = buildClientConfig("vscode", OPTS);
  const data = parseJson(cfg.text);
  assert.ok(data.servers.windrise, "原生格式顶层是 servers");
  assert.equal(data.mcpServers, undefined, "text 不能是可移植格式");
  assert.equal(data.servers.windrise.type, "http");
  assert.equal(data.servers.windrise.url, `${BASE}/${TOKEN}`);
  assert.equal(cfg.variants.length, 1);
  assert.ok(parseJson(cfg.variants[0].text).mcpServers.windrise, "可移植版顶层是 mcpServers");
  assert.ok(cfg.notes.join("\n").includes("servers vs mcpServers"));
});

test("Devin：transport + url；旧 Windsurf 用 serverUrl，且旧版在 CLIENTS 里能看到", () => {
  const entry = server(buildClientConfig("devin", OPTS).text);
  assert.equal(entry.url, `${BASE}/${TOKEN}`);
  assert.equal(entry.transport, "http");

  assert.ok(CLIENTS.some((c) => c.key === "devin-legacy"), "旧版必须在界面的清单里");
  const legacy = buildClientConfig("devin-legacy", OPTS);
  assert.equal(legacy.kind, "json");
  const old = server(legacy.text);
  assert.equal(old.serverUrl, `${BASE}/${TOKEN}`);
  assert.equal(old.url, undefined);
});

test("Cline：type 必须是 streamableHttp", () => {
  const entry = server(buildClientConfig("cline", OPTS).text);
  assert.equal(entry.type, "streamableHttp");
  assert.equal(entry.url, `${BASE}/${TOKEN}`);
  assert.equal(entry.disabled, false);
});

test("Cherry Studio：字段是 baseUrl", () => {
  const entry = server(buildClientConfig("cherry-studio", OPTS).text);
  assert.equal(entry.baseUrl, `${BASE}/${TOKEN}`);
  assert.equal(entry.type, "streamableHttp");
});

test("Trae：没有 type 字段，超时放在 headers 里", () => {
  const entry = server(buildClientConfig("trae", OPTS).text);
  assert.equal(entry.type, undefined);
  assert.equal(entry.url, `${BASE}/${TOKEN}`);
  assert.equal(entry.headers.START_MCP_TIMEOUT_MS, "30000");
  assert.equal(entry.headers.RUN_MCP_TIMEOUT_MS, "120000");
});

test("Trae pathToken:false：口令我到 headers.Authorization，超时头还在", () => {
  const entry = server(buildClientConfig("trae", { ...OPTS, pathToken: false }).text);
  assert.equal(entry.url, BASE);
  assert.equal(entry.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(entry.headers.RUN_MCP_TIMEOUT_MS, "120000");
});

test("Kimi Code：路径模式不提供去掉口令的环境变量版，steps 里也不塞多行 JSON", () => {
  const cfg = buildClientConfig("kimi-code", OPTS);
  const entry = server(cfg.text);
  assert.equal(entry.url, `${BASE}/${TOKEN}`);
  assert.equal(entry.toolTimeoutMs, 120000);
  assert.deepEqual(cfg.variants, [], "路径模式口令在 URL 里，环境变量版换不干净");
  assert.ok(!cfg.steps.join("\n").includes("bearerTokenEnvVar"));
  assert.ok(!cfg.steps.some((step) => step.includes("\n")), "steps 不该塞多行 JSON");
});

test("Kimi Code 请求头模式：环境变量版放 variants，url 不带口令", () => {
  const cfg = buildClientConfig("kimi-code", { ...OPTS, pathToken: false });
  assert.ok(server(cfg.text).headers.Authorization.includes(TOKEN));
  assert.equal(cfg.variants.length, 1);
  const envEntry = parseJson(cfg.variants[0].text).mcpServers.windrise;
  assert.equal(envEntry.url, BASE, "环境变量版的地址不能带口令");
  assert.equal(envEntry.bearerTokenEnvVar, "WINDRISE_TOKEN");
});

test("DeepSeek Harness：路径模式无 headers；请求头模式填真实口令而不是占位符", () => {
  const cfg = buildClientConfig("deepseek-harness", OPTS);
  assert.equal(cfg.kind, "yaml");
  const lines = cfg.text.split("\n");
  assert.ok(lines.includes("- id: mcp-windrise"));
  assert.ok(lines.includes("  name: '@deepseek-ai/dsh-mcp-client'"));
  assert.ok(lines.includes("  config:"));
  assert.ok(lines.includes("    serverName: windrise"));
  assert.ok(lines.includes("    transport: streamable-http"));
  assert.ok(lines.includes(`    url: ${BASE}/${TOKEN}`));
  assert.ok(lines.includes("    toolCallTimeoutMs: 120000"));
  assert.ok(!cfg.text.includes("headers:"), "口令在路径里时不需要 headers");

  const noPath = buildClientConfig("deepseek-harness", { ...OPTS, pathToken: false }).text.split("\n");
  assert.ok(noPath.includes(`    url: ${BASE}`));
  assert.ok(noPath.includes("    headers:"));
  const auth = noPath.find((line) => line.trim().startsWith("Authorization:"));
  assert.ok(auth.includes(`Bearer ${TOKEN}`), "要用真实口令");
  assert.ok(!auth.includes("<你的口令>"), "不能留占位符");
});

test("通义灵码：HTTP 版给 streamable-http，步骤里给 SSE 地址并标注只支持 SSE", () => {
  const cfg = buildClientConfig("lingma", OPTS);
  const entry = server(cfg.text);
  assert.equal(entry.type, "streamable-http");
  const steps = cfg.steps.join("\n");
  assert.ok(steps.includes("https://demo.example.com/sse/<口令>"), "SSE 地址要给对，但口令用占位");
  assert.ok(!steps.includes(TOKEN), "steps 不能带口令");
  assert.ok(cfg.notes.join("\n").includes("只支持 SSE"));
  assert.ok(cfg.supported, "有降级方案，不算不支持");
});

test("ChatWise：text 里给真实地址，不只是「见上方」", () => {
  const cfg = buildClientConfig("chatwise", OPTS);
  assert.ok(cfg.supported);
  assert.ok(cfg.text.includes("实验性"));
  assert.ok(cfg.text.includes(`${BASE}/${TOKEN}`), "可复制的内容必须是地址");
  assert.ok(cfg.notes.join("\n").includes("OAuth"));
});

test("口令只出现在配置正文：steps / notes 一律用占位符", () => {
  for (const c of CLIENTS) {
    for (const pathToken of [true, false]) {
      const cfg = buildClientConfig(c.key, { ...OPTS, pathToken });
      const leaked = [...cfg.steps, ...cfg.notes].filter((text) => String(text).includes(TOKEN));
      assert.deepEqual(leaked, [], `${c.key} pathToken=${pathToken} 的 steps/notes 泄漏了口令`);
    }
  }
});

test("口令优先于 baseUrl 里的旧口令，并提示冲突", () => {
  const rotated = "newtoken000000000000000000000000";
  const cfg = buildClientConfig("claude-code", { baseUrl: `${BASE}/${TOKEN}`, token: rotated });
  assert.equal(server(cfg.text).url, `${BASE}/${rotated}`, "不能用地址里的旧口令");
  assert.ok(cfg.notes.some((note) => note.includes("旧口令")), "要提示冲突");
});

test("baseUrl 不带 /mcp 时补成 <origin>/mcp，灵码的 SSE 地址也跟着正确", () => {
  const cfg = buildClientConfig("claude-code", { baseUrl: "https://demo.example.com", token: TOKEN });
  assert.equal(server(cfg.text).url, `https://demo.example.com/mcp/${TOKEN}`);

  const lingma = buildClientConfig("lingma", { baseUrl: "https://demo.example.com", token: TOKEN });
  assert.ok(lingma.steps.join("\n").includes("https://demo.example.com/sse/<口令>"));
  assert.equal(normalizeBaseUrl("https://demo.example.com").base, "https://demo.example.com/mcp");
});

test("认不出的地址：supported:false + 原因，不猜一个地址", () => {
  const cfg = buildClientConfig("claude", { baseUrl: "not a url", token: TOKEN });
  assert.equal(cfg.supported, false);
  assert.ok(cfg.reason.includes("地址格式"));
  assert.equal(cfg.text, "");
});

test("缺口令：路径里放带 URL 编码说明的占位并在 notes 里提示", () => {
  const cfg = buildClientConfig("claude-code", { baseUrl: BASE, token: "" });
  assert.equal(server(cfg.text).url, `${BASE}/<你的口令-URL编码后>`);
  assert.ok(cfg.notes.some((note) => note.includes("缺少口令")));
  assert.ok(cfg.notes.join("\n").includes("URL 编码"), "路径占位符必须说明先做 URL 编码");

  const header = buildClientConfig("claude-code", { baseUrl: BASE, token: "", pathToken: false });
  assert.equal(server(header.text).headers.Authorization, "Bearer <你的口令>");
  assert.ok(header.notes.some((note) => note.includes("缺少口令")));
  assert.ok(!header.notes.join("\n").includes("URL 编码"), "请求头模式不需要 URL 编码提示");
});

test("口令做 URL 编码后再拼路径", () => {
  const cfg = buildClientConfig("claude-code", { baseUrl: BASE, token: "ab#cd" });
  assert.equal(server(cfg.text).url, `${BASE}/ab%23cd`);
});

test("pathToken 传 0 / \"false\" 也按请求头模式处理", () => {
  for (const value of [0, "false", "0", false]) {
    const entry = server(buildClientConfig("claude-code", { ...OPTS, pathToken: value }).text);
    assert.equal(entry.url, BASE, `pathToken=${JSON.stringify(value)}`);
    assert.deepEqual(entry.headers, { Authorization: `Bearer ${TOKEN}` });
  }
  for (const value of [true, 1, "true", undefined]) {
    const entry = server(buildClientConfig("claude-code", { ...OPTS, pathToken: value }).text);
    assert.equal(entry.url, `${BASE}/${TOKEN}`, `pathToken=${JSON.stringify(value)}`);
  }
});

test("腾讯元宝 / 豆包 / 智谱清言：supported:false + 统一原因", () => {
  for (const key of ["yuanbao", "doubao", "zhipu"]) {
    const cfg = buildClientConfig(key, OPTS);
    assert.equal(cfg.supported, false, key);
    assert.equal(cfg.reason, "目前没有用户可配的 MCP 入口", key);
    assert.equal(cfg.text, "", key);
    assert.deepEqual(cfg.steps, [], key);
  }
});

test("不认识的客户端：supported:false", () => {
  const cfg = buildClientConfig("nope", OPTS);
  assert.equal(cfg.supported, false);
  assert.ok(cfg.reason.includes("nope"));
});

test("地址已带 /mcp/<口令>：再生成不会重复拼口令", () => {
  const withToken = `https://demo.example.com/mcp/${TOKEN}`;
  const entry = server(buildClientConfig("claude-code", { baseUrl: withToken, token: TOKEN }).text);
  assert.equal(entry.url, withToken);
  const noToken = buildClientConfig("claude-code", { baseUrl: withToken, token: TOKEN, pathToken: false });
  assert.equal(server(noToken.text).url, BASE);
});

test("空地址 / 空口令不抛错，给占位符", () => {
  const cfg = buildClientConfig("claude-code", { baseUrl: "", token: "", pathToken: false });
  const entry = server(cfg.text);
  assert.ok(entry.url.startsWith("https://"), entry.url);
  assert.equal(entry.headers.Authorization, "Bearer <你的口令>");
  const form = buildClientConfig("claude", {});
  assert.ok(form.text.includes("https://<你的公网域名>/mcp"));
});

test("normalizeBaseUrl：去掉 /mcp/<口令>、去掉查询串、缺 /mcp 时补 origin", () => {
  assert.deepEqual(normalizeBaseUrl(`${BASE}/${TOKEN}`), { base: BASE, pathToken: TOKEN, tail: "" });
  assert.deepEqual(normalizeBaseUrl(`${BASE}/`), { base: BASE, pathToken: null, tail: "" });
  assert.equal(normalizeBaseUrl("https://x.example.com/mcp?foo=1").base, "https://x.example.com/mcp");
  assert.equal(normalizeBaseUrl("https://x.example.com").base, "https://x.example.com/mcp");
  assert.equal(normalizeBaseUrl("").base, "");
});

test("所有 JSON 类配置都能被 JSON.parse", () => {
  for (const c of CLIENTS) {
    const cfg = buildClientConfig(c.key, OPTS);
    if (cfg.kind !== "json") continue;
    const data = parseJson(cfg.text);
    assert.ok(data && typeof data === "object", c.key);
    const top = data.mcpServers || data.servers;
    assert.ok(top && top.windrise, `${c.key} 缺 mcpServers/servers.windrise`);
  }
});

test("界面接入：主进程生成、preload 暴露、界面用渲染函数画出步骤 / 提示", () => {
  const main = readFileSync(new URL("../../electron/main.cjs", import.meta.url), "utf8");
  const preload = readFileSync(new URL("../../electron/preload.cjs", import.meta.url), "utf8");
  const app = readFileSync(new URL("../../electron/ui/app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../../electron/index.html", import.meta.url), "utf8");
  assert.ok(main.includes('ipcMain.handle("client-configs:groups"'), "主进程要有 client-configs:groups");
  assert.ok(main.includes("buildClientConfigGroups({ baseUrl, token, pathToken: pathEnabled })"), "主进程用 buildClientConfigGroups 生成");
  assert.ok(!main.includes("return { ok: true, token"), "主进程不能把口令回传给界面");
  assert.ok(main.includes("hasToken"), "主进程只回传「有没有口令」这个事实");
  assert.ok(preload.includes("clientConfigGroups: () => ipcRenderer.invoke(\"client-configs:groups\")"), "preload 要暴露窄接口");
  assert.ok(app.includes("renderClientGroupList(clientConfigGroups)"), "界面必须用渲染函数，而不是内联拼字符串");
  assert.ok(app.includes("renderClientConfigMode("), "界面要渲染模式说明");
  assert.ok(html.includes('id="btn-client-config"') && html.includes('id="client-config-groups"'), "界面上要有入口和弹窗");
  assert.ok(html.includes('id="client-config-mode"'), "弹窗里要有模式说明那一行");
});

/** ---- 界面渲染（纯函数，断言真正的输出） ---- */

function renderRowFor(options, key) {
  const item = buildClientConfigGroups(options).flatMap((g) => g.clients).find((c) => c.key === key);
  return { item, html: renderClientRow(item) };
}

test("renderClientRow：steps / notes 真的出现在输出里，不只是存在数据里", () => {
  const { item, html } = renderRowFor({ baseUrl: BASE, token: TOKEN }, "codex");
  assert.ok(item.config.steps.length > 0);
  for (const step of item.config.steps) {
    assert.ok(html.includes(escapeHtml(step)), `步骤没渲染出来：${step.slice(0, 24)}`);
  }
  for (const note of item.config.notes) {
    assert.ok(html.includes(escapeHtml(note)), `提示没渲染出来：${note.slice(0, 24)}`);
  }
  assert.ok(html.includes("config.toml"), "Codex 的「放哪」必须能看见");
});

test("renderClientRow：缺口令时这一行标注要替换占位符，其它行不标", () => {
  const missing = renderRowFor({ baseUrl: BASE, token: "", pathToken: false }, "claude-code");
  assert.ok(missing.item.config.needsToken, "缺口令要给 needsToken");
  assert.ok(missing.html.includes("缺口令"), "界面上要看得见");
  assert.ok(missing.html.includes("你的口令"), "要说清楚换成什么");

  const withToken = renderRowFor({ baseUrl: BASE, token: TOKEN, pathToken: false }, "claude-code");
  assert.ok(!withToken.item.config.needsToken);
  assert.ok(!withToken.html.includes("缺口令"));
});

test("缺口令时每个 supported 条目要么正文不含占位符，要么带 needsToken", () => {
  const groups = buildClientConfigGroups({ baseUrl: BASE, token: "", pathToken: false });
  for (const item of groups.flatMap((g) => g.clients)) {
    if (!item.config.supported) continue;
    const texts = [item.config.text, ...(item.config.variants || []).map((v) => v.text)].join("\n");
    if (texts.includes("<你的口令")) {
      assert.equal(item.config.needsToken, true, `${item.key} 正文有占位符却没标 needsToken`);
      assert.ok(item.config.notes.some((n) => n.includes("缺少口令")), `${item.key} 要提示缺口令`);
    }
  }
});

test("renderClientConfigMode：四种模式都说清楚现在是什么情况", () => {
  assert.ok(renderClientConfigMode({ pathToken: true, hasToken: true }).includes("已经带好口令"));
  assert.ok(renderClientConfigMode({ pathToken: true, hasToken: false }).includes("还没有口令"));
  assert.ok(renderClientConfigMode({ pathToken: false, hasToken: true }).includes("请求头"));
  assert.ok(renderClientConfigMode({ pathToken: false, hasToken: false }).includes("还没有口令"));
});

test("clientCopyToast：说「已复制」，缺口令时额外提醒替换占位符", () => {
  assert.ok(clientCopyToast("Codex", { needsToken: false }).includes("已复制"));
  assert.ok(!clientCopyToast("Codex", { needsToken: false }).includes("你的口令"));
  assert.ok(clientCopyToast("Codex", { needsToken: true }).includes("你的口令"));
});

test("灵码请求头模式：正文里必须有 Authorization，否则必然 401", () => {
  const entry = server(buildClientConfig("lingma", { baseUrl: BASE, token: TOKEN, pathToken: false }).text);
  assert.equal(entry.url, BASE);
  assert.equal(entry.headers.Authorization, `Bearer ${TOKEN}`);

  const pathMode = buildClientConfig("lingma", OPTS);
  assert.equal(server(pathMode.text).headers, undefined, "路径模式不写请求头");
  assert.ok(!pathMode.steps.join("\n").includes("Headers 字段单独填"), "路径模式不能让人再填 Bearer 头");
});

test("无协议但带 /mcp 的地址：补 https，不能原样当 base", () => {
  assert.deepEqual(normalizeBaseUrl("demo.example.com/mcp"), {
    base: "https://demo.example.com/mcp",
    pathToken: null,
    tail: "",
  });
  const cfg = buildClientConfig("claude-code", { baseUrl: "demo.example.com/mcp", token: TOKEN });
  assert.equal(server(cfg.text).url, `https://demo.example.com/mcp/${TOKEN}`);
  assert.ok(!cfg.text.includes('"url": "demo.example.com'), "不能生成无协议的地址");
});

test("ChatGPT / ChatWise 在请求头模式下 supported:false 并给出原因", () => {
  for (const key of ["chatgpt", "chatwise"]) {
    const cfg = buildClientConfig(key, { baseUrl: BASE, token: TOKEN, pathToken: false });
    assert.equal(cfg.supported, false, `${key} 请求头模式不可用`);
    assert.ok(cfg.reason.includes("路径口令"), `${key} 要说明为什么不可用`);
    assert.ok(buildClientConfig(key, OPTS).supported, `${key} 路径模式仍然可用`);
  }
});

test("Codex 环境变量版缺口令：提示设 WINDRISE_TOKEN，不再让人去换不存在的请求头占位符", () => {
  const cfg = buildClientConfig("codex", { baseUrl: BASE, token: "", pathToken: false });
  assert.ok(cfg.text.includes('bearer_token_env_var = "WINDRISE_TOKEN"'));
  assert.ok(!cfg.text.includes("<你的口令"), "主推正文里没有请求头占位符");
  const notes = cfg.notes.join("\n");
  assert.ok(!notes.includes("请求头里的 <你的口令>"), "不能让人去找正文里不存在的东西");
  assert.ok(notes.includes("WINDRISE_TOKEN"), "要指出真实的环境变量名");
  assert.ok(notes.includes("环境变量"), "要说明这是环境变量版");
});

test("Kimi 环境变量版缺口令：notes 同时讲清请求头占位符和 WINDRISE_TOKEN", () => {
  const cfg = buildClientConfig("kimi-code", { baseUrl: BASE, token: "", pathToken: false });
  const notes = cfg.notes.join("\n");
  assert.ok(server(cfg.text).headers.Authorization.includes("<你的口令>"));
  assert.ok(notes.includes("请求头里的 <你的口令>"), "主推正文里确实有请求头占位符");
  assert.ok(notes.includes("WINDRISE_TOKEN"), "备选环境变量版也要说明怎么设");
});

test("normalizeBaseUrl 保留 /mcp 前面的路径前缀（反代子路径），无协议仍然补 https", () => {
  assert.deepEqual(normalizeBaseUrl("https://h.example.com/proxy/mcp/TOK"), {
    base: "https://h.example.com/proxy/mcp",
    pathToken: "TOK",
    tail: "",
  });
  assert.equal(normalizeBaseUrl("demo.example.com/proxy/mcp").base, "https://demo.example.com/proxy/mcp");
  assert.equal(normalizeBaseUrl("demo.example.com/mcp").base, "https://demo.example.com/mcp");

  const cfg = buildClientConfig("claude-code", { baseUrl: "https://h.example.com/proxy/mcp", token: "T" });
  assert.equal(server(cfg.text).url, "https://h.example.com/proxy/mcp/T", "前缀 /proxy 不能被丢掉");
});

test("supported:false 的条目不返回可复制正文，也不再让人「地址填上面」", () => {
  for (const key of ["chatgpt", "chatwise", "yuanbao", "doubao", "zhipu"]) {
    const cfg = buildClientConfig(key, { baseUrl: BASE, token: TOKEN, pathToken: false });
    assert.equal(cfg.supported, false, key);
    assert.equal(cfg.text, "", `${key} 不能给一份没有鉴权的可复制地址`);
    assert.ok(![...cfg.steps, ...cfg.notes].join("\n").includes("地址填上面"), `${key} 步骤不能让人去粘`);
    assert.ok(![...cfg.steps, ...cfg.notes].join("\n").includes("https://"), `${key} 步骤里不该有地址`);
  }
  const chatwise = buildClientConfig("chatwise", { baseUrl: BASE, token: TOKEN, pathToken: false });
  assert.ok(chatwise.steps.join("\n").includes("公网允许路径令牌"), "要指向界面上真实存在的开关");
  assert.ok(!chatwise.steps.join("\n").includes("生成器里切换到"), "不能指向不存在的控件");
  // 详情里可以展开看「为什么不可用 + 怎么打开路径口令」，但正文仍是空的
  const html = renderClientDetails(chatwise.config ?? chatwise, "chatwise");
  assert.ok(html.includes("公网允许路径令牌"));
  assert.ok(!html.includes("地址填上面"));
});

test("pickClientCopy：主行取 config.text，备选行按下标取 variants[i].text（字符串下标也认）", () => {
  const groups = buildClientConfigGroups({ baseUrl: BASE, token: TOKEN });
  const main = pickClientCopy(groups, { key: "vscode" });
  const item = groups.flatMap((g) => g.clients).find((c) => c.key === "vscode");
  assert.equal(main.text, item.config.text, "主行复制的必须是 config.text");
  assert.ok(main.message.includes("VSCode") || main.message.includes(item.name));

  const variant = pickClientCopy(groups, { key: "vscode", variantIndex: "0" });
  assert.equal(variant.text, item.config.variants[0].text, "备选行要按下标取 variants[0].text");
  assert.notEqual(variant.text, item.config.text);
  assert.ok(variant.message.includes(item.name));

  const codex = buildClientConfigGroups({ baseUrl: BASE, token: TOKEN, pathToken: false });
  const codexItem = codex.flatMap((g) => g.clients).find((c) => c.key === "codex");
  assert.equal(pickClientCopy(codex, { key: "codex", variantIndex: 0 }).text, codexItem.config.variants[0].text);

  const unsupported = pickClientCopy(codex, { key: "chatwise" });
  assert.equal(unsupported.unsupported, true);
  assert.equal(unsupported.text, "");
  assert.ok(unsupported.message.includes("路径口令"));

  assert.equal(pickClientCopy(groups, { key: "nope" }), null);
  assert.equal(pickClientCopy(groups, { key: "vscode", variantIndex: 9 }), null);
});

test("界面接入：复制逻辑走 pickClientCopy，不再在事件处理里手搓下标 / 字段", () => {
  const app = readFileSync(new URL("../../electron/ui/app.js", import.meta.url), "utf8");
  assert.ok(app.includes("pickClientCopy(clientConfigGroups"), "界面必须调用纯函数 pickClientCopy");
  assert.ok(!app.includes("item.config.variants?.[Number(variantIndex)]"), "下标解析不能留在事件处理里");
});