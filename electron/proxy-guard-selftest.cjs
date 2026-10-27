/**
 * 代理串解析自测（规划隐私方案 WP-09）：纯 node，不启动 Electron。
 *
 *   node electron/proxy-guard-selftest.cjs
 *
 * 只测纯函数 parseProxyRule / checkProxyForSave；真会话里 setProxy 与 resolveProxy 的核对见
 * _probe/proxy-guard-test.mjs。
 */

const { parseProxyRule, checkProxyForSave } = require("./proxy-guard.cjs");

const results = [];
const record = (id, name, ok, detail = "") => {
  results.push({ id, name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id} ${name}${detail ? `\n        ${detail}` : ""}`);
};

/* ① 能接受的写法：规范化结果与 resolveProxy 期望串都要对 */
const accepted = [
  ["socks5://127.0.0.1:1080", "socks5://127.0.0.1:1080", "SOCKS5 127.0.0.1:1080"],
  ["socks://127.0.0.1:1080", "socks5://127.0.0.1:1080", "SOCKS5 127.0.0.1:1080"],
  ["http://127.0.0.1:8080", "http://127.0.0.1:8080", "PROXY 127.0.0.1:8080"],
  ["https://proxy.example.com:443", "https://proxy.example.com:443", "HTTPS proxy.example.com:443"],
  ["127.0.0.1:8080", "http://127.0.0.1:8080", "PROXY 127.0.0.1:8080"],
  ["SOCKS5://Proxy.Example.COM:1080", "socks5://proxy.example.com:1080", "SOCKS5 proxy.example.com:1080"],
  ["proxy.example.com:1", "http://proxy.example.com:1", "PROXY proxy.example.com:1"],
  ["proxy.example.com:65535", "http://proxy.example.com:65535", "PROXY proxy.example.com:65535"],
  ["[::1]:1080", "http://[::1]:1080", "PROXY [::1]:1080"],
  // 按 Chromium / WHATWG URL 的方式规范化：存进去的串和 resolveProxy 的返回串必须一致
  ["socks5://127.1:1080", "socks5://127.0.0.1:1080", "SOCKS5 127.0.0.1:1080"],
  ["http://0x7f.0.0.1:8080", "http://127.0.0.1:8080", "PROXY 127.0.0.1:8080"],
  ["0x7f.0.0.1:8080", "http://127.0.0.1:8080", "PROXY 127.0.0.1:8080"],
  ["[0:0::1]:1080", "http://[::1]:1080", "PROXY [::1]:1080"],
  ["[::FFFF:127.0.0.1]:8080", "http://[::ffff:7f00:1]:8080", "PROXY [::ffff:7f00:1]:8080"],
  // :80 是企业 HTTP 代理最常见的端口；WHATWG URL 会把它当默认端口吃掉，不能因此判成没写端口
  ["http://proxy.corp:80", "http://proxy.corp:80", "PROXY proxy.corp:80"],
  ["127.0.0.1:80", "http://127.0.0.1:80", "PROXY 127.0.0.1:80"],
  ["socks5://10.0.0.1:80", "socks5://10.0.0.1:80", "SOCKS5 10.0.0.1:80"],
  ["https://proxy:80", "https://proxy:80", "HTTPS proxy:80"],
  ["[::1]:80", "http://[::1]:80", "PROXY [::1]:80"],
  ["proxy:0080", "http://proxy:80", "PROXY proxy:80"],
];
for (const [input, normalized, expect] of accepted) {
  const rule = parseProxyRule(input);
  record(
    `a${accepted.findIndex((row) => row[0] === input) + 1}`,
    `接受 ${input}`,
    rule.ok && rule.normalized === normalized && rule.expect === expect,
    `ok=${rule.ok}｜normalized=${rule.normalized}｜expect=${rule.expect}｜error=${rule.error}`,
  );
}

/* ② 必须拒绝的写法：错误信息要是中文，且说清楚怎么改 */
const rejected = [
  ["http://a:1,http://b:2", "一个代理"],
  ["http://a:1;http://b:2", "一个代理"],
  ["http=http://a:1", "一个代理"],
  ["direct://", "直连"],
  ["socks4://127.0.0.1:1080", "本机解析"],
  ["socks4a://127.0.0.1:1080", "本机解析"],
  ["socks5h://127.0.0.1:1080", "socks5://"],
  ["socks5://user:pass@127.0.0.1:1080", "账号密码"],
  ["http://u:p@127.0.0.1:8080", "账号密码"],
  ["PROXY 127.0.0.1:8080", "PAC"],
  ["SOCKS 127.0.0.1:1080", "PAC"],
  ["ftp://127.0.0.1:21", "只支持"],
  ["http://127.0.0.1", "主机:端口"],
  ["127.0.0.1:0", "端口"],
  ["127.0.0.1:65536", "端口"],
  ["http://127.0.0.1:8080/path", "路径"],
  ["", "请填写"],
];
for (const [input, mustSay] of rejected) {
  const rule = parseProxyRule(input);
  const chinese = /[\u4e00-\u9fa5]/.test(rule.error);
  record(
    `b${rejected.findIndex((row) => row[0] === input) + 1}`,
    `拒绝 ${JSON.stringify(input)}`,
    !rule.ok && chinese && rule.error.includes(mustSay) && rule.normalized === "",
    `ok=${rule.ok}｜error=${rule.error}`,
  );
}

/* ③ checkProxyForSave：空串、去空白、抛错带 code */
const saveCases = [];
const check = (id, name, fn) => {
  try { saveCases.push({ id, name, ok: Boolean(fn()), detail: "" }); }
  catch (error) { saveCases.push({ id, name, ok: false, detail: `${error.code || ""} ${error.message}` }); }
};
check("c1", "空串返回空串", () => checkProxyForSave("") === "");
check("c2", "纯空白返回空串", () => checkProxyForSave("   ") === "");
check("c3", "有效串返回规范化结果", () => checkProxyForSave(" socks://127.0.0.1:1080 ") === "socks5://127.0.0.1:1080");
check("c3b", "主机按 Chromium 规则规范化后保存", () => checkProxyForSave("socks://127.1:1080") === "socks5://127.0.0.1:1080");
check("c4", "无效串抛 PROXY_INVALID", () => {
  try { checkProxyForSave("socks4://127.0.0.1:1080"); return false; }
  catch (error) {
    return error.code === "PROXY_INVALID" && /本机解析/.test(error.message) && /[\u4e00-\u9fa5]/.test(error.message);
  }
});
check("c5", "带账号密码抛 PROXY_INVALID 并说明原因", () => {
  try { checkProxyForSave("http://u:p@127.0.0.1:8080"); return false; }
  catch (error) { return error.code === "PROXY_INVALID" && /账号密码/.test(error.message); }
});
for (const item of saveCases) record(item.id, item.name, item.ok, item.detail);

const passed = results.filter((item) => item.ok).length;
console.log(`\n通过 ${passed}/${results.length}（Electron 未加载，Node ${process.versions.node}）`);
if (process.env.WINDRISE_EXPERIMENT_OUT) {
  require("node:fs").writeFileSync(
    process.env.WINDRISE_EXPERIMENT_OUT,
    JSON.stringify({ passed, total: results.length, results }, null, 2),
  );
}
process.exit(passed === results.length ? 0 : 1);
