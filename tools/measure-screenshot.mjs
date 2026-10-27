/**
 * 实测真实网页截图的大小 —— 这是「1GB 够不够」最关键的一个数。
 *
 * browser_screenshot 默认 maxWidth=1024。截图尺寸不同，大小能差十倍。
 */

const BASE = `http://127.0.0.1:${process.argv[2] ?? "48272"}`;
const TOKEN = process.argv[3] ?? "REVOKED_OLD_ROUTE_TOKEN";
const MCP = `${BASE}/mcp/${TOKEN}`;
const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

let sessionId = null;
let nextId = 1;

async function rpc(method, params) {
  const response = await fetch(MCP, {
    method: "POST",
    headers: sessionId ? { ...HEADERS, "mcp-session-id": sessionId } : HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    signal: AbortSignal.timeout(90000),
  });
  const sid = response.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  const raw = await response.arrayBuffer();
  const text = Buffer.from(raw).toString("utf8");
  // 不能只看整段是否以 "data:" 开头 —— SSE 的首行是 event:，那样判断永远为假
  const dataLines = text.split(/\r?\n/).filter((l) => l.startsWith("data:"));
  const body = dataLines.length > 0 ? dataLines[dataLines.length - 1].slice(5) : text;
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* 不是 JSON */ }
  return { bytes: raw.byteLength, parsed };
}

const KB = (n) => `${(n / 1024).toFixed(1)} KB`;

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "shot", version: "1" } });

// browser_open 要的是窗口 id（从 browser_profiles 拿），不是直接给 url
const profiles = await rpc("tools/call", { name: "browser_profiles", arguments: {} });
const profileList = profiles.parsed?.result?.structuredContent?.profiles ?? [];
const windowId = profileList[0]?.id;
console.log(`可用窗口：${profileList.map((p) => p.id).join(", ") || "（一个都没有）"}\n`);
if (!windowId) {
  console.log("没有可用窗口，没法测截图。");
  process.exit(0);
}

const pages = [
  ["本地测试站", "http://127.0.0.1:19555/index.html"],
  ["example.com", "https://example.com"],
];

console.log("=".repeat(76));
console.log("真实网页截图大小（browser_screenshot）");
console.log("=".repeat(76));

for (const [label, url] of pages) {
  console.log(`\n--- ${label}：${url} ---`);
  const opened = await rpc("tools/call", { name: "browser_open", arguments: { id: windowId, url } });
  if (opened.parsed?.result?.isError) {
    console.log(`  打开失败：${opened.parsed.result.content?.[0]?.text?.slice(0, 160)}`);
    continue;
  }
  await new Promise((r) => setTimeout(r, 2500)); // 等页面渲染

  for (const [tag, args] of [
    ["默认（maxWidth 1024）", { id: windowId }],
    ["缩到 512 宽", { id: windowId, maxWidth: 512 }],
    ["原尺寸（maxWidth 0）", { id: windowId, maxWidth: 0 }],
  ]) {
    const shot = await rpc("tools/call", { name: "browser_screenshot", arguments: args });
    const content = shot.parsed?.result?.content ?? [];
    const image = content.find((c) => c.type === "image");
    const textPart = content.find((c) => c.type === "text");
    const imageBytes = image ? Math.round((image.data.length * 3) / 4) : 0;
    console.log(`  ${tag.padEnd(22)} 响应体 ${KB(shot.bytes).padStart(9)}   图片本身 ${KB(imageBytes).padStart(9)}`);
    if (textPart) console.log(`    ${textPart.text}`);
  }

  await rpc("tools/call", { name: "browser_close", arguments: { id: windowId } });
}

console.log("");
console.log("=".repeat(76));
console.log("换算：一次截图 ≈ 多少请求额度");
console.log("=".repeat(76));
console.log("  ngrok 免费版：1 GB 流量 / 20,000 次请求 / 月");
console.log("  Cloudflare 隧道：流量不限（免费）");
