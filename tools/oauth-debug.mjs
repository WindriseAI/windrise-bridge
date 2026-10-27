#!/usr/bin/env node
/**
 * 隧道 OAuth 本机调试入口（不是 UI）。
 *
 * 远程浏览器打开 /authorize 后只会显示配对码；真正的「同意」要在本机做。
 * 在做出设置页 UI 之前，用这个脚本完成确认：
 *
 *   node tools/oauth-debug.mjs list
 *   node tools/oauth-debug.mjs approve <requestId|配对码> --groups read,navigate
 *   node tools/oauth-debug.mjs deny <requestId|配对码>
 *   node tools/oauth-debug.mjs revoke --client <client_id>
 *   node tools/oauth-debug.mjs revoke --token <access_token>
 *
 * 默认连 127.0.0.1:48272（Bridge 的默认端口）。端口被占用退回随机端口时，
 * 用 --port 指定实际端口。这些端点只接受本机直连，经隧道访问一律 404。
 */

import process from "node:process";

const argv = process.argv.slice(2);
const options = { host: "127.0.0.1", port: 48272, groups: undefined, client: null, token: null };
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const item = argv[i];
  if (item === "--host") options.host = argv[++i];
  else if (item === "--port") options.port = Number(argv[++i]);
  else if (item === "--groups") options.groups = String(argv[++i] ?? "");
  else if (item === "--client") options.client = argv[++i];
  else if (item === "--token") options.token = argv[++i];
  else if (item === "--help" || item === "-h") options.help = true;
  else rest.push(item);
}

if (options.help) {
  console.log(`用法：
  node tools/oauth-debug.mjs list [--port 48272]
  node tools/oauth-debug.mjs approve <requestId|配对码> [--groups read,navigate]
  node tools/oauth-debug.mjs deny <requestId|配对码>
  node tools/oauth-debug.mjs revoke --client <client_id>
  node tools/oauth-debug.mjs revoke --token <access_token>`);
  process.exit(0);
}

const base = `http://${options.host}:${options.port}`;

async function call(pathname, init = {}) {
  const response = await fetch(`${base}${pathname}`, init).catch((error) => {
    throw new Error(`连不上 Bridge（${base}）：${error.message}`);
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!response.ok) {
    const detail = body?.error_description || body?.error || body?.message || response.statusText;
    throw new Error(`HTTP ${response.status}：${detail}`);
  }
  return body;
}

function postJson(pathname, payload) {
  return call(pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function formatTime(value) {
  if (!value) return "-";
  try { return new Date(Number(value)).toLocaleTimeString("zh-CN", { hour12: false }); } catch { return "-"; }
}

async function list() {
  const body = await call("/oauth/local/pending");
  const rows = Array.isArray(body?.pending) ? body.pending : [];
  if (!rows.length) {
    console.log("没有待确认的 OAuth 授权请求。");
    return;
  }
  console.log(`待确认 ${rows.length} 条：`);
  for (const row of rows) {
    console.log("");
    console.log(`  配对码    ${row.pairingCode}`);
    console.log(`  请求号    ${row.requestId}`);
    console.log(`  客户端    ${row.clientName}（${row.clientId}）`);
    console.log(`  请求分组  ${(row.requestedGroups ?? []).join(" / ") || "（未指定）"}`);
    console.log(`  创建时间  ${formatTime(row.createdAt)}`);
    console.log(`  过期时间  ${formatTime(row.expiresAt)}`);
  }
  console.log("");
  console.log(`批准：node tools/oauth-debug.mjs approve <请求号或配对码> --groups read,navigate --port ${options.port}`);
}

async function main() {
  const command = rest[0] ?? "list";
  if (command === "list") {
    await list();
    return;
  }
  if (command === "approve") {
    const reference = rest[1];
    if (!reference) throw new Error("approve 需要 requestId 或配对码");
    const payload = { requestId: reference };
    if (options.groups !== undefined) {
      payload.groups = options.groups.split(",").map((item) => item.trim()).filter(Boolean);
    }
    const body = await postJson("/oauth/local/approve", payload);
    console.log(`已批准 ${body.pending.clientName}（${body.pending.clientId}）`);
    console.log(`给的分组：${(body.pending.requestedGroups ?? []).join(" / ") || "（无）"}`);
    console.log("远程页面最多 2 秒内会跳回客户端；不要关闭客户端。");
    return;
  }
  if (command === "deny") {
    const reference = rest[1];
    if (!reference) throw new Error("deny 需要 requestId 或配对码");
    await postJson("/oauth/local/deny", { requestId: reference });
    console.log("已拒绝。");
    return;
  }
  if (command === "revoke") {
    if (options.client) {
      const body = await postJson("/oauth/local/revoke", { clientId: options.client });
      console.log(`已吊销 ${body.revoked} 把令牌，并断开这个客户端的会话。`);
      return;
    }
    if (options.token) {
      const body = await postJson("/oauth/local/revoke", { token: options.token });
      console.log(body.revoked ? "已吊销这把令牌。" : "这把令牌不存在或已经失效。");
      return;
    }
    throw new Error("revoke 需要 --client <client_id> 或 --token <token>");
  }
  throw new Error(`不认识的命令：${command}（可用：list / approve / deny / revoke）`);
}

main().catch((error) => {
  console.error(`失败：${error.message}`);
  process.exit(1);
});
