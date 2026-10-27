/**
 * 用户自定义工具（界面里「工具 → 新建工具」创建的那种）。
 *
 * 不用写代码：一条 JSON 规格 = 一个 MCP 工具，存在 <数据目录>/custom-tools.json。
 * 三种类型：
 *   http     发一个 HTTP 请求（GET 只读；其它方法算写入）
 *   command  跑一条命令模板（执行类，参数会被安全加引号）
 *   text     返回一段固定文字（常用说明 / 规范 / 提示词片段）
 * 模板里用 {{参数名}} 引用参数。Bridge 启动时全部注册；界面保存后热更新。
 */

import { exec } from "node:child_process";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { Capability, listTools, registerTool, unregisterTool } from "../core/registry.js";

export const CUSTOM_TOOLS_FILE = "custom-tools.json";
export const CUSTOM_SOURCE = "user";
const TYPES = ["http", "command", "text"];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const MAX_OUTPUT = 60_000;

export function customToolsFile(dataHome) {
  return path.join(dataHome, CUSTOM_TOOLS_FILE);
}

export async function loadCustomToolSpecs(dataHome) {
  const raw = await readFile(customToolsFile(dataHome), "utf8").catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed?.tools;
    return Array.isArray(list) ? list.filter(s => s && typeof s === "object") : [];
  } catch {
    return [];
  }
}

export async function saveCustomToolSpecs(dataHome, specs) {
  await mkdir(dataHome, { recursive: true });
  const file = customToolsFile(dataHome);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, tools: specs }, null, 2), "utf8");
  await rename(tmp, file);
  return specs;
}

const str = (v, max = 4000) => String(v ?? "").slice(0, max);

/** 校验并规范化一条规格；不合法直接抛出中文错误（界面原样展示）。 */
export function normalizeSpec(input = {}) {
  const name = str(input.name, 64).trim();
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(name)) throw new Error("工具名只能用小写字母、数字、下划线，字母开头，3–64 位（例如 get_weather）");
  const type = TYPES.includes(input.type) ? input.type : "http";
  const params = (Array.isArray(input.params) ? input.params : [])
    .map(p => ({ name: str(p?.name, 40).trim(), description: str(p?.description, 300).trim(), required: Boolean(p?.required) }))
    .filter(p => p.name);
  const seen = new Set();
  for (const p of params) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(p.name)) throw new Error(`参数名「${p.name}」不合法：用字母、数字、下划线`);
    if (seen.has(p.name)) throw new Error(`参数名「${p.name}」重复`);
    seen.add(p.name);
  }
  const spec = {
    name,
    type,
    title: str(input.title, 80).trim() || name,
    description: str(input.description, 1000).trim(),
    params,
    enabled: input.enabled !== false,
  };
  if (type === "http") {
    spec.method = METHODS.includes(String(input.method).toUpperCase()) ? String(input.method).toUpperCase() : "GET";
    spec.url = str(input.url, 2000).trim();
    if (!/^https?:\/\//i.test(spec.url)) throw new Error("请求地址要以 http:// 或 https:// 开头");
    spec.headers = typeof input.headers === "string" ? input.headers : Object.entries(input.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n");
    spec.headers = str(spec.headers, 4000);
    spec.body = str(input.body, 20000);
  } else if (type === "command") {
    spec.command = str(input.command, 4000).trim();
    if (!spec.command) throw new Error("命令模板不能为空");
    spec.cwd = str(input.cwd, 500).trim();
    spec.timeoutSec = Math.min(Math.max(Number(input.timeoutSec) || 60, 1), 600);
  } else {
    spec.text = str(input.text, 20000);
    if (!spec.text.trim()) throw new Error("固定文字不能为空");
  }
  return spec;
}

/** 模板里引用到、但没在参数表里声明的名字（界面上提示用） */
export function templateVariables(spec) {
  const text = [spec.url, spec.headers, spec.body, spec.command, spec.text, spec.cwd].filter(Boolean).join("\n");
  return [...new Set([...text.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map(m => m[1]))];
}

function fill(template, args, encode) {
  return String(template ?? "").replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_all, key) => {
    const value = args[key];
    return encode(value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value));
  });
}

/** 命令参数加引号：防止 AI 传进来的参数拼出第二条命令 */
export function shellQuote(value, platform = process.platform) {
  const text = String(value);
  if (platform === "win32") return `"${text.replace(/["\r\n]/g, " ")}"`;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function parseHeaders(text) {
  const headers = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return headers;
}

function clip(text) {
  const s = String(text ?? "");
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…（已截断，共 ${s.length} 字符）` : s;
}

function capabilityOf(spec) {
  if (spec.type === "command") return Capability.EXECUTE;
  if (spec.type === "http" && spec.method !== "GET") return Capability.WRITE;
  return Capability.READ;
}

async function runHttp(spec, args, signal) {
  const url = fill(spec.url, args, encodeURIComponent);
  const headers = parseHeaders(fill(spec.headers, args, v => v.replace(/[\r\n]/g, " ")));
  const jsonBody = /^\s*[[{]/.test(spec.body ?? "");
  const body = spec.method === "GET" || !spec.body ? undefined
    : fill(spec.body, args, v => (jsonBody ? JSON.stringify(v).slice(1, -1) : v));
  if (body && jsonBody && !Object.keys(headers).some(k => k.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetch(url, { method: spec.method, headers, body, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  let text = await response.text();
  if (/json/i.test(response.headers.get("content-type") ?? "")) {
    try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* 原样 */ }
  }
  return {
    isError: !response.ok,
    text: clip(`HTTP ${response.status} ${response.statusText}\n${text}`),
    structuredContent: { status: response.status, ok: response.ok, url },
  };
}

function runCommand(spec, args, { cwd, signal }) {
  const command = fill(spec.command, args, v => shellQuote(v));
  const env = { ...process.env };
  for (const [k, v] of Object.entries(args)) env[`ARG_${k.toUpperCase()}`] = typeof v === "string" ? v : JSON.stringify(v);
  return new Promise((resolve) => {
    const child = exec(command, {
      cwd: spec.cwd ? fill(spec.cwd, args, v => v) : cwd,
      env,
      timeout: spec.timeoutSec * 1000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      signal,
    }, (error, stdout, stderr) => {
      const code = error ? (error.code ?? 1) : 0;
      const parts = [`$ ${command}`, `退出码 ${code}${error?.killed ? "（超时被终止）" : ""}`];
      if (stdout) parts.push(String(stdout));
      if (stderr) parts.push(`[stderr]\n${stderr}`);
      resolve({ isError: code !== 0, text: clip(parts.join("\n")), structuredContent: { exitCode: code } });
    });
    child.stdin?.end();
  });
}

/** 规格 → 注册表里的工具定义 */
export function buildCustomTool(spec, { cwd = process.cwd() } = {}) {
  const properties = {};
  for (const p of spec.params) properties[p.name] = { type: "string", description: p.description || p.name };
  const required = spec.params.filter(p => p.required).map(p => p.name);
  return {
    name: spec.name,
    title: spec.title,
    description: `${spec.description || spec.title}（用户自定义 · ${spec.type === "http" ? `HTTP ${spec.method}` : spec.type === "command" ? "命令" : "文字"}）`,
    capability: capabilityOf(spec),
    inputSchema: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false },
    source: CUSTOM_SOURCE,
    handler: async (rawArgs, ctx) => {
      const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
      const missing = required.filter(k => args[k] === undefined || args[k] === "");
      if (missing.length) return { isError: true, text: `缺少参数：${missing.join(", ")}` };
      if (spec.type === "text") return { text: fill(spec.text, args, v => v) };
      if (spec.type === "http") return runHttp(spec, args, ctx?.signal);
      return runCommand(spec, args, { cwd, signal: ctx?.signal });
    },
  };
}

/**
 * 把规格全部（重新）注册：先摘掉上一批，再挂新的。
 * 不允许顶替内置 / 浏览器 / 外部工具的名字，撞名的跳过并报出来。
 */
export async function installCustomTools(dataHome, { cwd } = {}) {
  for (const tool of listTools()) if (tool.source === CUSTOM_SOURCE) unregisterTool(tool.name);
  const taken = new Set(listTools().map(t => t.name));
  const loaded = [];
  const errors = [];
  for (const raw of await loadCustomToolSpecs(dataHome)) {
    if (raw?.enabled === false) continue;
    try {
      const spec = normalizeSpec(raw);
      if (taken.has(spec.name)) throw new Error(`和已有工具重名：${spec.name}`);
      registerTool(buildCustomTool(spec, { cwd }));
      taken.add(spec.name);
      loaded.push(spec.name);
    } catch (error) {
      errors.push(`${raw?.name ?? "?"}：${error.message}`);
    }
  }
  return { loaded, errors };
}

/**
 * 让 Agent 自己管理自定义工具：用户只要说「帮我加一个查快递的工具」，
 * Agent 调 custom_tool_save 写好规格，Bridge 立刻热更新、工具列表通知客户端刷新。
 *
 * 安全边界：命令类（command）由 Agent 创建时默认**关闭**，要用户在「工具」页手动打开开关 ——
 * 否则 Agent 可以借自定义工具绕过「危险命令需人工确认」。http / text 类直接生效。
 */
export function defineCustomToolAdmin({ dataHome, cwd, onChanged = () => {}, log = () => {} } = {}) {
  const summary = (s) => ({
    name: s.name, title: s.title, type: s.type, enabled: s.enabled !== false, description: s.description,
    params: s.params, ...(s.type === "http" ? { method: s.method, url: s.url } : s.type === "command" ? { command: s.command } : {}),
  });
  const reinstall = async () => {
    const result = await installCustomTools(dataHome, { cwd });
    try { onChanged(); } catch { /* 通知失败不影响保存 */ }
    return result;
  };
  return [
    {
      name: "custom_tool_list",
      title: "列出自定义工具",
      description: "列出用户在 Bridge 里添加的自定义工具（名字、类型、是否启用、参数）。添加或修改前先调一次，避免重名。",
      capability: Capability.READ,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      source: "builtin",
      handler: async () => {
        const specs = await loadCustomToolSpecs(dataHome);
        return {
          text: specs.length ? specs.map(s => `- ${s.name}（${s.type}${s.enabled === false ? "，已关闭" : ""}）：${s.title}${s.description ? " — " + s.description : ""}`).join("\n") : "还没有自定义工具。",
          structuredContent: { tools: specs.map(summary) },
        };
      },
    },
    {
      name: "custom_tool_save",
      title: "添加 / 修改自定义工具",
      description: [
        "替用户新建或修改一个自定义工具，保存后马上生效（客户端会收到工具列表更新）。",
        "用户用大白话描述需求（例如「加个查天气的工具」「把我们的接口规范做成一个工具」）时，由你来决定规格并调用本工具，不要让用户自己填表。",
        "三种类型：http = 调一个 HTTP 接口（url/headers/body 里用 {{参数名}} 引用参数，GET 只读，其它方法算写入）；",
        "text = 返回一段固定文字（规范、模板、提示词）；command = 运行命令模板（参数会自动加引号；出于安全，新建的命令类工具默认关闭，需要用户在 Bridge「工具」页打开开关）。",
        "name 用小写字母/数字/下划线，字母开头，3–64 位，不能和已有工具重名；修改已有工具时传 original=旧名字。",
      ].join(""),
      capability: Capability.WRITE,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "工具名，例如 get_weather" },
          original: { type: "string", description: "修改已有工具时填它原来的名字；新建不填" },
          type: { type: "string", enum: TYPES, description: "http / text / command" },
          title: { type: "string", description: "给人看的中文名" },
          description: { type: "string", description: "什么时候该用这个工具（写清楚，AI 靠它判断）" },
          params: {
            type: "array",
            description: "参数列表",
            items: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, required: { type: "boolean" } }, required: ["name"] },
          },
          method: { type: "string", enum: METHODS, description: "http 类：请求方法，默认 GET" },
          url: { type: "string", description: "http 类：请求地址，可含 {{参数}}" },
          headers: { type: "string", description: "http 类：请求头，每行一个「名: 值」" },
          body: { type: "string", description: "http 类：请求体（JSON 或文本），可含 {{参数}}" },
          text: { type: "string", description: "text 类：要返回的文字，可含 {{参数}}" },
          command: { type: "string", description: "command 类：命令模板，可含 {{参数}}" },
          cwd: { type: "string", description: "command 类：工作目录（可选）" },
          timeoutSec: { type: "number", description: "command 类：超时秒数，默认 60" },
        },
        required: ["name", "type", "description"],
        additionalProperties: false,
      },
      source: "builtin",
      handler: async (raw) => {
        const input = raw && typeof raw === "object" ? raw : {};
        let spec;
        try { spec = normalizeSpec(input); } catch (error) { return { isError: true, text: error.message }; }
        const original = str(input.original, 64).trim();
        const specs = await loadCustomToolSpecs(dataHome);
        if (specs.some(x => x.name === spec.name && x.name !== original)) return { isError: true, text: `已经有叫 ${spec.name} 的自定义工具了；要修改它请传 original=${spec.name}` };
        const clash = listTools().find(t => t.name === spec.name && t.source !== CUSTOM_SOURCE);
        if (clash) return { isError: true, text: `${spec.name} 是内置工具的名字，换一个` };
        const index = specs.findIndex(x => x.name === (original || spec.name));
        const previous = index >= 0 ? specs[index] : null;
        // 命令类：新建默认关；修改时保留用户原来的开关状态
        if (spec.type === "command") spec.enabled = previous?.type === "command" ? previous.enabled !== false : false;
        if (index >= 0) specs[index] = spec; else specs.push(spec);
        await saveCustomToolSpecs(dataHome, specs);
        const result = await reinstall();
        log(`Agent ${previous ? "修改" : "添加"}了自定义工具 ${spec.name}`);
        const note = spec.type === "command" && !spec.enabled
          ? "命令类工具出于安全默认关闭：请提醒用户到 Bridge 的「工具」页打开它的开关。"
          : "已生效，可以直接调用。";
        return {
          text: `${previous ? "已修改" : "已添加"}自定义工具 ${spec.name}（${spec.title}）。${note}${result.errors.length ? `\n注意：${result.errors.join("；")}` : ""}`,
          structuredContent: { tool: summary(spec), live: spec.enabled !== false },
        };
      },
    },
    {
      name: "custom_tool_remove",
      title: "删除自定义工具",
      description: "删除一个用户自定义工具（只能删自定义的，内置工具删不了）。",
      capability: Capability.WRITE,
      inputSchema: { type: "object", properties: { name: { type: "string", description: "要删除的工具名" } }, required: ["name"], additionalProperties: false },
      source: "builtin",
      handler: async (raw) => {
        const name = str(raw?.name, 64).trim();
        const specs = await loadCustomToolSpecs(dataHome);
        if (!specs.some(x => x.name === name)) return { isError: true, text: `没有叫 ${name} 的自定义工具` };
        await saveCustomToolSpecs(dataHome, specs.filter(x => x.name !== name));
        await reinstall();
        log(`Agent 删除了自定义工具 ${name}`);
        return { text: `已删除自定义工具 ${name}` };
      },
    },
  ];
}
