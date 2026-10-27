#!/usr/bin/env node
/**
 * 跑「可点元素救回」相关的单元测试（node:test，不需要浏览器），输出「通过 N/N」给 run-all-checks 判定。
 *
 *   node tools/run-clickable-tests.mjs
 *
 * 覆盖两块：
 *   - src/core/snapshot-clickable.test.js：render 渲染被忽略的可点节点、6 级提示名、脱敏、shadow DOM、批量往返、上限 300；
 *   - src/core/surface-act.test.js：编号失效自动重拍重试、最像的 3 个元素、type 不给 ref；
 *   - src/core/sse-endpoint.test.js：旧式 SSE 端点（GET /sse/<口令> + POST /messages/<口令>）的握手 / 列工具 / 调只读工具、
 *   - src/core/page-fill.test.js：page_act 批量填表（一次填完 / 只回读一次 / 提交按钮被拒 /
 *   - src/tools/browser-pageact.test.js：MCP 侧批量正文与错误字段（读回确认失败不冒充已选择 / options / aborted）；
 *   - tools/vendor-patches/apply.test.mjs：vendor 补丁能还原我们改过的文件，打不上就报错。
 *
 * 另外带上长页面那几条修复的纯 Node 测试（不碰浏览器）：
 *   - src/core/snapshot-query.test.js：快照切块 / 查找 / 长页面可操作元素差异 / 子树与视口裁剪；
 *   - src/core/snapshot-states.test.js：checkbox / radio / switch 的 checked 状态、下拉框当前值、状态参与 diff；
 *   - src/core/surface-act.test.js：编号失效自动重拍重试、最像的 3 个元素、type 不给 ref、时间框写入；
 *   - src/core/surface-snapshot.test.js：整页快照只扫一次光标、AX 读取预算每次快照重置；
 *   - src/core/browser-control-dialog.test.js：page_snapshot / page_act 的对话框迟到检查；
 *   - src/core/surface-read.test.js：page_read 的 NOT_FOUND、读之前等页面就绪；
 *   - src/core/dialog.test.js：JS 对话框开着时报 DIALOG_OPEN、action:"dialog" 确认 / 取消 / prompt 带文字；
 *   - src/core/dialog-race.test.js：真适配层里点击与 Page.javascriptDialogOpening 竞速、在途鼠标命令可作废；
 *   - src/core/snapshot-temporal.test.js：时间 / 日期框的值从 DOM property 读出并标进快照；
 *   - src/core/page-settle.test.js：动作后等页面稳定（导航带新 URL / 标题、SPA 后退、超时如实上报）；
 *   - src/core/upload-guard.test.js：上传只许工作区目录里的文件（越界 / 穿越 / 软链 / 目录 / 上限）。
 *   - src/core/jev-choice.test.js：page_choose 的候选抽取 / 255 截断 / ratio / 无密钥报错 / 密钥不外泄。
 *   - src/core/surface-read.test.js：page_read 的 NOT_FOUND、读之前等页面就绪。
 *   - src/core/tool-policy.test.js：工具分组、口令作用域、域名 / cwd 谓词、NOT_ALLOWED 与审计字段；
 *   - src/core/context-bus-agentmsg.test.js：子代理消息落盘回执 / 去重 / 增量拉取 / 限流 / 收件箱上限 / 任务 TTL 与状态机；
 *   - src/core/handoff.test.js：控制权状态机、交还变更摘要、审计事件字段与写入；
 *   - src/core/space-autoclose.test.js：AI 空间自动收摊（空闲关闭 / keep 只卸载 / 需要你与接管中不关 /
 *     人在看的前台不关 / 会话断开 2 分钟触发 / 内存闸门只卸载不碰「我的」/ space_close 返回关闭数量）；
 *   - src/core/oauth.test.js：隧道 OAuth 的 PRM / DCR / PKCE / audience / 过期 / 吊销 / 401 / 作用域映射。
 *   - src/core/client-configs.test.js：按客户端生成远程 MCP 配置（各家字段名 / type / 口令放路径还是请求头 / 不支持的给原因）。
 *   - src/core/tool-meta.test.js：工具返回的 meta（耗时 / 输出 token 估算）、按 MCP 会话累计、
 *     session_stats 的会话隔离、日志摘要不记录网页正文。
 *   - src/core/bridge-stop.test.js：会话收尾不收 resolve 时 stop() 带超时返回，不把退出流程挂死。
 *   - src/core/standalone-selftest.test.js：自检子进程在超时内以退出码 0 退出（不靠 process.exit 硬退）。
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  path.join(ROOT, "src", "core", "snapshot-clickable.test.js"),
  path.join(ROOT, "src", "core", "snapshot-query.test.js"),
  path.join(ROOT, "src", "core", "snapshot-states.test.js"),
  path.join(ROOT, "src", "core", "surface-act.test.js"),
  path.join(ROOT, "src", "core", "surface-snapshot.test.js"),
  path.join(ROOT, "src", "core", "browser-control-dialog.test.js"),
  path.join(ROOT, "src", "core", "surface-read.test.js"),
  path.join(ROOT, "src", "core", "jev-choice.test.js"),
  path.join(ROOT, "src", "core", "action-policy.test.js"),
  path.join(ROOT, "src", "core", "dialog.test.js"),
  path.join(ROOT, "src", "core", "dialog-race.test.js"),
  path.join(ROOT, "src", "core", "snapshot-temporal.test.js"),
  path.join(ROOT, "src", "core", "page-settle.test.js"),
  path.join(ROOT, "src", "core", "upload-guard.test.js"),
  path.join(ROOT, "src", "core", "tool-policy.test.js"),
  path.join(ROOT, "src", "core", "context-bus-agentmsg.test.js"),
  path.join(ROOT, "src", "core", "handoff.test.js"),
  path.join(ROOT, "src", "core", "space-autoclose.test.js"),
  path.join(ROOT, "src", "core", "oauth.test.js"),
  path.join(ROOT, "src", "core", "mcp-compat.test.js"),
  path.join(ROOT, "tools", "mcp-compat-check.test.mjs"),
  path.join(ROOT, "src", "core", "sse-endpoint.test.js"),
  path.join(ROOT, "src", "core", "page-fill.test.js"),
  path.join(ROOT, "src", "tools", "browser-pageact.test.js"),
  path.join(ROOT, "src", "core", "client-configs.test.js"),
  path.join(ROOT, "src", "core", "tool-meta.test.js"),
  path.join(ROOT, "src", "core", "bridge-stop.test.js"),
  path.join(ROOT, "src", "core", "standalone-selftest.test.js"),
  path.join(ROOT, "tools", "vendor-patches", "apply.test.mjs"),
];

const run = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...files], { cwd: ROOT, encoding: "utf8" });
const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
const count = (label) => Number(out.match(new RegExp(`ℹ ${label} (\\d+)`))?.[1] ?? 0);
const tests = count("tests");
const pass = count("pass");
const fail = count("fail");
const broken = fail > 0 || run.status !== 0 || tests === 0 || pass !== tests;
if (broken) console.log(out.split("\n").filter((line) => /✖|Error|期望/.test(line)).slice(0, 40).join("\n"));
console.log(`可点元素救回：${files.length} 个测试文件`);
console.log(`通过 ${pass}/${tests}${broken ? `，失败 ${Math.max(fail, 1)} 个${tests === 0 ? "（没读到测试数）" : ""}` : ""}`);
process.exit(broken ? 1 : 0);
