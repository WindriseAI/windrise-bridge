/**
 * tsserver 接入实测：造一个真有小毛病的小项目，看诊断和跳转是不是真的能用。
 * 运行：node src/lsp-selftest.mjs
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { boot } from "./standalone.js";
import { disposeAll } from "./core/lsp.js";

// tsserver 会占住目录句柄，所以清理要容错
const forceRm = (dir) => rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});

const sandbox = path.join(os.tmpdir(), "bridge-lsp-test");
disposeAll();
await forceRm(sandbox);
await mkdir(path.join(sandbox, "src"), { recursive: true });

// 故意留几处类型错误和一个跨文件引用，用来验证诊断与跳转
await writeFile(path.join(sandbox, "src", "math.ts"), [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "",
  "export function broken(x: number): string {",
  "  return x;              // 类型错误：number 不能当 string 返回",
  "}",
  "",
  "export const unusedValue = 42;",
].join("\n"), "utf8");

await writeFile(path.join(sandbox, "src", "main.ts"), [
  "import { add, broken } from './math';",
  "",
  "const total = add(1, 2);",
  "const text: string = add(3, 4);   // 类型错误：number 赋给 string",
  "console.log(total, text, broken(1));",
  "",
  "const missing: number = notDeclared;  // 类型错误：变量不存在",
].join("\n"), "utf8");

await writeFile(path.join(sandbox, "tsconfig.json"), JSON.stringify({
  compilerOptions: { target: "ES2022", module: "ESNext", strict: true, noUnusedLocals: true },
  include: ["src/**/*.ts"],
}, null, 2), "utf8");

const app = await boot({
  roots: [sandbox],
  workspace: { id: "lsp", name: "lsp-test", kind: "folder", uri: sandbox, folders: [sandbox] },
  // 自检按 JSON 读响应体，测的不是传输方式；默认已改成 SSE，这里显式要 JSON
  options: { jsonResponse: true },
  onLog: () => {},
});

const url = app.server.localUrl;
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const init = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "lsp-test", version: "0" } } }) });
const sid = init.headers.get("mcp-session-id");
await init.json();

let callId = 10;
async function call(name, args) {
  const response = await fetch(url, { method: "POST", headers: { ...headers, "mcp-session-id": sid }, body: JSON.stringify({ jsonrpc: "2.0", id: ++callId, method: "tools/call", params: { name, arguments: args } }) });
  const body = await response.json();
  return {
    text: body?.result?.content?.find(c => c.type === "text")?.text ?? JSON.stringify(body?.error ?? body),
    structured: body?.result?.structuredContent,
    isError: Boolean(body?.result?.isError),
  };
}

const sections = [];

/* ---------- 1. 引擎状态 ---------- */
const status = await call("lsp", { operation: "status" });
sections.push(["① 语言服务状态", status.text]);

/* ---------- 2. 真诊断 ---------- */
const diag = await call("get_diagnostics", { path: "src" });
sections.push(["② 目录级真诊断", diag.text, `引擎=${diag.structured?.engine} 错误=${diag.structured?.errors} 警告=${diag.structured?.warnings}`]);

/* ---------- 3. 跳定义 ---------- */
const def = await call("lsp", { operation: "definition", path: "src/main.ts", line: 1, offset: 10 });
sections.push(["③ 跳到 add 的定义", def.text]);

/* ---------- 4. 找引用 ---------- */
const refs = await call("lsp", { operation: "references", path: "src/math.ts", line: 1, offset: 17 });
sections.push(["④ 找 add 的引用", refs.text, `共 ${refs.structured?.count ?? 0} 处`]);

/* ---------- 5. 列符号 ---------- */
const syms = await call("lsp", { operation: "symbols", path: "src/math.ts" });
sections.push(["⑤ 列文件符号", syms.text]);

/* ---------- 6. 看类型 ---------- */
const qi = await call("lsp", { operation: "quickinfo", path: "src/main.ts", line: 3, offset: 7 });
sections.push(["⑥ 查看变量类型", qi.text]);

/* ---------- 7. 补全 ---------- */
const comp = await call("lsp", { operation: "completion", path: "src/main.ts", line: 4, offset: 30 });
sections.push(["⑦ 补全建议", comp.text.split("\n").slice(0, 8).join("\n") + "\n  …"]);

await app.stop();
disposeAll();
await forceRm(sandbox);

console.log("tsserver 接入实测（全部通过真实 MCP 协议调用）\n");
for (const [title, text, extra] of sections) {
  console.log(`${title}${extra ? `   [${extra}]` : ""}`);
  console.log(text.split("\n").map(l => "    " + l).join("\n"));
  console.log("");
}
