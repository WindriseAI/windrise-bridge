/**
 * 工具能力实测：起一个真实 Bridge，然后像外部 Agent 那样逐个调用工具，
 * 验证「读写文件」这类核心能力在脱离 VS Code 的情况下真的可用。
 *
 * 运行：node src/capability-demo.mjs
 */

import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { boot } from "./standalone.js";

const sandbox = path.join(os.tmpdir(), "bridge-capability-demo");
await rm(sandbox, { recursive: true, force: true });
await mkdir(path.join(sandbox, "src"), { recursive: true });
await writeFile(path.join(sandbox, "src", "app.js"), [
  "// 示例项目",
  "export function greet(name) {",
  "  return `hello ${name}`;",
  "}",
  "",
  "console.log(greet('world'));",
].join("\n"), "utf8");
await writeFile(path.join(sandbox, "README.md"), "# 演示项目\n\n这是一个用来测试工具能力的沙箱。\n", "utf8");

const app = await boot({
  roots: [sandbox],
  workspace: { id: "demo", name: "capability-demo", kind: "folder", uri: sandbox, folders: [sandbox] },
  // 打开「危险命令需要人工确认」：默认是关的（全部自动执行），不打开就测不到⑪⑫的审批门
  // 这个自检直接按 JSON 读响应体，和传输方式无关；默认已改成 SSE，这里显式要 JSON
  options: { approveDangerous: true, jsonResponse: true },
  onLog: () => {},
});

const url = app.server.localUrl;
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const init = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "demo", version: "0" } } }) });
const sid = init.headers.get("mcp-session-id");
await init.json();

let callId = 10;
async function call(name, args) {
  const response = await fetch(url, { method: "POST", headers: { ...headers, "mcp-session-id": sid }, body: JSON.stringify({ jsonrpc: "2.0", id: ++callId, method: "tools/call", params: { name, arguments: args } }) });
  const body = await response.json();
  const text = body?.result?.content?.find(c => c.type === "text")?.text ?? JSON.stringify(body?.error ?? body);
  // JSON-RPC 层的 error 也算失败，不能当成成功
  return { text, isError: Boolean(body?.error) || Boolean(body?.result?.isError), structured: body?.result?.structuredContent };
}

const out = [];
/**
 * expect："ok" = 应该成功；"refuse" = 应该被拒绝；也可以传函数自己判。
 * 每一步都对照预期判定，而不是只看「有没有报错」。
 */
const judge = (expect, r) => typeof expect === "function" ? Boolean(expect(r)) : expect === "refuse" ? r.isError : !r.isError;
const step = async (label, name, args, expect = "ok") => {
  const result = await call(name, args);
  out.push({ label, name, isError: result.isError, pass: judge(expect, result), shown: result.text });
  return result;
};

// 1) 列目录
await step("① 列目录", "list_directory", { path: ".", depth: 2 }, r => !r.isError && /src/.test(r.text));
// 2) 读文件
await step("② 读文件（带行号）", "read_files", { path: "src/app.js" }, r => !r.isError && /greet/.test(r.text));
// 3) 按内容搜索
await step("③ 内容搜索", "search_files", { pattern: "greet", path: "." }, r => !r.isError && /app\.js/.test(r.text));
// 4) 按名字找文件
await step("④ 按名查找", "find_files", { glob: "**/*.md" }, r => !r.isError && /README\.md/.test(r.text));
// 5) 写文件：用补丁改代码
const patch = [
  "*** Update File: src/app.js",
  "@@",
  " export function greet(name) {",
  "-  return `hello ${name}`;",
  "+  return `hello ${name}!`;",
  " }",
].join("\n");
await step("⑤ 打补丁改代码", "apply_patch", { patch });
// 6) 确认改动真的落盘了（脱离工具，直接用 fs 复核）
const afterPatch = await readFile(path.join(sandbox, "src", "app.js"), "utf8");
out.push({ label: "⑥ 磁盘复核（绕过工具直接读）", name: "fs.readFile", isError: false,
  pass: afterPatch.includes("return `hello ${name}!`;"), shown: afterPatch.split("\n")[2] });
// 7) 执行命令：这条在安全白名单内（解释器跑脚本），应直接执行并返回输出
await step("⑦ 执行命令（白名单内，直接跑）", "run_command", { command: "node src/app.js", mode: "wait", timeoutMs: 20000 },
  r => !r.isError && /hello world!/.test(r.text));
// 8) 读回补丁后的文件，确认改动生效
await step("⑧ 补丁后再读一次", "read_files", { path: "src/app.js" }, r => !r.isError && /hello \$\{name\}!/.test(r.text));
// 9) 越界访问必须被拦
await step("⑨ 越界读文件（应被拒绝）", "read_files", { path: "C:\\Windows\\System32\\drivers\\etc\\hosts" },
  r => r.isError && /越界/.test(r.text));
// 10) 任务卡
await step("⑩ 设置任务卡", "set_todos", { new_task: true, todos: [{ id: "s1", title: "验证读写", status: "completed" }], lifecycle: "completed" });
// 11) 高危命令 → 先要求确认。用 run_command 实际的 shell（bash）写法；删的是一个不存在的目录，
//     就算闸门失效真的执行了也不会破坏任何东西
const RISKY = "rm -rf ./__approval_gate_probe__";
const risky = await step("⑪ 高危命令（应要求确认，不放行）", "run_command", { command: RISKY, mode: "wait" },
  r => !r.isError && r.structured?.needsApproval === true);
// 12) 人工批准后原样重试：证明审批门确实能放行（批准一次只放行一次）
if (risky.structured?.needsApproval) app.terminal.approve(RISKY);
await step("⑫ 批准后重放（验证放行路径）", "run_command", { command: RISKY, mode: "wait", timeoutMs: 10000 },
  r => !r.isError && !r.structured?.needsApproval && /exit_code: 0/.test(r.text));

await app.stop();
await rm(sandbox, { recursive: true, force: true });

console.log("工具能力实测（全部通过真实 MCP 协议调用）\n");
for (const row of out) {
  console.log(`${row.label}  [${row.pass ? "符合预期" : "不符合预期"}]（工具${row.isError ? "报错/拒绝" : "返回正常"}）`);
  console.log(row.shown.split("\n").map(l => "    " + l).join("\n"));
  console.log("");
}
const passed = out.filter(r => r.pass).length;
console.log(passed === out.length ? `全部符合预期（${passed}/${out.length}）` : `有 ${out.length - passed} 项不符合预期（${passed}/${out.length}）`);
process.exitCode = passed === out.length ? 0 : 1;
