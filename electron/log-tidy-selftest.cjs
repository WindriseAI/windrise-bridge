/**
 * 日志去噪自测（纯 node，不启动 Electron、不读日志文件）。
 *
 *   node electron/log-tidy-selftest.cjs
 *
 * 覆盖：真实云端预检表格的每一行（边框 / 标题 / 表头 / PASS / 空白丢，SUMMARY、地址、Registered 留）；
 * FAIL / WARN / SKIP 表格行留；ERR 行、非 [stderr] 行留；非字符串原样返回；
 * logText 有 text / 没 text / text 不是字符串三种情况；
 * metaLogPlan 按会话每 30 秒汇总一行（页面动作日志不占主日志的 500 条），
 * 窗口里的多次调用由 addMetaCall 累加（次数 / 耗时 / 字数 / token / 图片都算进去，输出后清零）。
 */

const { tidyTunnelLine, logText, addMetaCall, metaLogPlan, META_ROW_INTERVAL_MS } = require("./log-tidy.cjs");

const results = [];
const record = (id, name, ok, detail = "") => {
  results.push({ id, name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id} ${name}${detail ? `\n        ${detail}` : ""}`);
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const check = (id, name, fn) => {
  try { record(id, name, true, fn() || ""); }
  catch (error) { record(id, name, false, error.message); }
};

const brief = (line) => (line.length > 78 ? `${line.slice(0, 78)}…` : line);
const expectDrop = (id, name, line) => check(id, name, () => {
  const kept = tidyTunnelLine(line);
  assert(kept === null, `应该丢掉，实际返回 ${JSON.stringify(kept)}`);
  return "已丢弃";
});
const expectKeep = (id, name, line) => check(id, name, () => {
  const kept = tidyTunnelLine(line);
  assert(kept === line, `应该原样保留，实际返回 ${JSON.stringify(kept)}`);
  return `保留：${brief(line)}`;
});

/* ① 真实样例：预检表格里没有诊断价值的行 */
expectDrop("a1", "表格边框（INF +---）丢掉",
  "[stderr] 2026-10-24T11:45:33Z INF +-------------------------------------------------------------------------------------+");
expectDrop("a2", "预检标题（CONNECTIVITY PRE-CHECKS）丢掉",
  "[stderr] 2026-10-24T11:45:33Z INF |                               CONNECTIVITY PRE-CHECKS                               |");
expectDrop("a3", "表头（COMPONENT / STATUS）丢掉",
  "[stderr] 2026-10-24T11:45:33Z INF |  COMPONENT         TARGET                     STATUS  DETAILS                       |");
expectDrop("a4", "DNS 预检 PASS 行丢掉",
  "[stderr] 2026-10-24T11:45:33Z INF |  DNS Resolution    region1.v2.argotunnel.com  PASS    DNS Resolved successfully     |");
expectDrop("a5", "UDP 预检 PASS 行丢掉",
  "[stderr] 2026-10-24T11:45:33Z INF |  UDP Connectivity  region2.v2.argotunnel.com  PASS    QUIC connection successful    |");
expectDrop("a6", "表格空白行丢掉",
  "[stderr] 2026-10-24T11:45:33Z INF |                                                                                     |");
expectDrop("a7", "表格外 status=pass 的组件行丢掉",
  "[stderr] 2026-10-24T11:45:33Z INF precheck component=\"DNS Resolution\" details=\"DNS Resolved successfully\" run_id=ea8d3567 status=pass target=region1.v2.argotunnel.com");

/* ② 真实样例：有结论的行必须留 */
expectKeep("b1", "SUMMARY 行保留（说明最终用的协议）",
  "[stderr] 2026-10-24T11:45:33Z INF |  SUMMARY: Environment is healthy. cloudflared will use 'quic' as primary protocol.  |");
expectKeep("b2", "precheck complete 行保留（总体结果）",
  "[stderr] 2026-10-24T11:45:33Z INF precheck complete hard_fail=false run_id=ea8d3567 suggested_protocol=quic");
expectKeep("b3", "快速隧道地址框的文字行保留",
  "[stderr] 2026-10-24T11:45:32Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |");
expectKeep("b4", "快速隧道地址本身保留",
  "[stderr] 2026-10-24T11:45:32Z INF |  https://render-styles-earthquake-stored.trycloudflare.com                                 |");
expectKeep("b5", "Registered tunnel connection 保留",
  "[stderr] 2026-10-24T11:45:34Z INF Registered tunnel connection connIndex=0 connection=febcfa8d event=0 ip=198.18.0.225 location=sin13 protocol=quic");

/* ③ 错误 / 告警 / 非 [stderr] 行一律不碰 */
expectKeep("c1", "ERR 行保留",
  "[stderr] 2026-10-24T11:47:01Z ERR failed to serve tunnel connection error=\"timeout: no recent network activity\"");
expectKeep("c2", "WRN 行保留",
  "[stderr] 2026-10-24T11:47:02Z WRN failed to serve tunnel connection error=\"timeout: no recent network activity\"");
expectKeep("c3", "不是 [stderr] 开头的行原样保留（哪怕像表格）",
  "隧道已打通：https://render-styles-earthquake-stored.trycloudflare.com（直连）");
expectKeep("c4", "没有 [stderr] 前缀的 INF 表格行也不碰",
  "INF |  DNS Resolution    region1.v2.argotunnel.com  PASS    DNS Resolved successfully     |");

/* ④ 非 PASS 的预检状态必须留：说明有问题 */
expectKeep("d1", "预检 FAIL 行保留",
  "[stderr] 2026-10-24T11:45:33Z INF |  UDP Connectivity  region2.v2.argotunnel.com  FAIL    QUIC connection refused       |");
expectKeep("d2", "预检 WARN 行保留",
  "[stderr] 2026-10-24T11:45:33Z INF |  DNS Resolution    region1.v2.argotunnel.com  WARN    slow lookup                   |");
expectKeep("d3", "预检 SKIP 行保留",
  "[stderr] 2026-10-24T11:45:33Z INF |  UDP Connectivity  region2.v2.argotunnel.com  SKIP    not tested                    |");
expectKeep("d4", "status=fail 的组件行保留",
  "[stderr] 2026-10-24T11:45:33Z INF precheck component=\"UDP Connectivity\" details=\"QUIC connection refused\" run_id=ea8d3567 status=fail target=region2.v2.argotunnel.com");

/* ⑤ 非字符串输入原样返回 */
check("e1", "非字符串原样返回（null / 数字 / 对象）", () => {
  const values = [null, 42, { kind: "tunnel", text: "x" }];
  for (const value of values) {
    const kept = tidyTunnelLine(value);
    assert(kept === value, `${JSON.stringify(value)} 变成了 ${JSON.stringify(kept)}`);
  }
  return "null / 42 / 对象 都原样返回";
});

/* ⑥ Bridge 事件转文字 */
check("f1", "logText 有 text：只用 text，不再包 JSON", () => {
  const event = { kind: "browser-tools", text: "已挂载 13 个浏览器工具…" };
  const text = logText(event);
  assert(text === event.text, `实际返回 ${JSON.stringify(text)}`);
  return text;
});
check("f2", "logText 没 text：整个事件 JSON 化", () => {
  const event = { kind: "custom-tools", name: "demo" };
  const text = logText(event);
  assert(text === JSON.stringify(event), `实际返回 ${text}`);
  return text;
});
check("f3", "logText 的 text 不是字符串：仍走 JSON 化", () => {
  const event = { kind: "x", text: { nested: 1 } };
  const text = logText(event);
  assert(text === JSON.stringify(event), `实际返回 ${text}`);
  assert(text.includes('"kind":"x"') && text.includes('"nested":1'), text);
  return text;
});

/* ⑦ 页面动作日志汇总：每个会话每 30 秒最多一行，行里是窗口内的累计 */
const META = { tool: "page_snapshot", action_id: 7, ms: 12, out_chars: 34, approx_tokens: 20 };
check("g1", "第一次（lastAt 为 0）就记：工具、编号、数字都在", () => {
  const totals = addMetaCall(null, META);
  const plan = metaLogPlan(totals, "会话 abcd1234 ", 100_000, 0);
  assert(plan && typeof plan.text === "string", `应该返回一行日志，实际 ${JSON.stringify(plan)}`);
  assert(plan.text.includes("工具 page_snapshot #7"), plan.text);
  assert(plan.text.includes("共 1 次"), plan.text);
  assert(plan.text.includes("12ms") && plan.text.includes("34 字") && plan.text.includes("20 tokens"), plan.text);
  assert(plan.text.includes("会话 abcd1234"), plan.text);
  return brief(plan.text);
});
check("g2", "30 秒内同一会话不再记（不占 500 条日志环）", () => {
  const totals = addMetaCall(addMetaCall(null, META), META);
  const plan = metaLogPlan(totals, "", 100_000 + META_ROW_INTERVAL_MS - 1, 100_000);
  assert(plan === null, `应该不记，实际 ${JSON.stringify(plan)}`);
  return "已并入上一条";
});
check("g3", "满 30 秒重新记一行", () => {
  const totals = addMetaCall(null, META);
  const plan = metaLogPlan(totals, "", 100_000 + META_ROW_INTERVAL_MS, 100_000);
  assert(plan && plan.text.includes("#7"), `应该记一行，实际 ${JSON.stringify(plan)}`);
  return brief(plan.text);
});
check("g4", "图片张数与缓存标记跟着出现", () => {
  const totals = addMetaCall(addMetaCall(null, META), { ...META, images: 2, cached: true });
  const plan = metaLogPlan(totals, "", 1, 0);
  assert(plan.text.includes("2 张图") && plan.text.includes("（缓存）"), plan.text);
  return brief(plan.text);
});
check("g5", "meta 字段缺失时不吐 undefined / null 也不会崩", () => {
  const plan = metaLogPlan(addMetaCall(null, {}), "", 1, 0);
  assert(plan && !plan.text.includes("undefined") && !plan.text.includes("null"), plan.text);
  return brief(plan.text);
});
check("g6", "窗口里多次调用的数字要累加，不是只取最后一次", () => {
  // 修之前 metaLogPlan 只格式化当次调用：这里会只剩最后一条的 12ms / 34 字
  let totals = null;
  for (let index = 0; index < 200; index += 1) totals = addMetaCall(totals, META);
  const plan = metaLogPlan(totals, "", 1, 0);
  assert(plan.text.includes("共 200 次"), plan.text);
  assert(plan.text.includes("耗时 2400ms"), plan.text);
  assert(plan.text.includes("输出 6800 字"), plan.text);
  assert(plan.text.includes("4000 tokens"), plan.text);
  return brief(plan.text);
});
check("g7", "累加不碰入参，输出后主进程另起新账本就等价于清零", () => {
  const first = addMetaCall(null, META);
  const second = addMetaCall(first, { ...META, ms: 8 });
  assert(first.calls === 1 && first.ms === 12, "第一次的账本不能被改");
  assert(second.calls === 2 && second.ms === 20, "第二次要在旧账本上累加");
  const reset = addMetaCall(null, { ...META, tool: "browser_click", action_id: 8 });
  assert(reset.calls === 1 && reset.ms === 12 && reset.tools.length === 1, "清零后只算新的一次");
  return "累计 / 清零都正确";
});

const passed = results.filter((item) => item.ok).length;console.log(`\n通过 ${passed}/${results.length}（Electron 未加载，Node ${process.versions.node}）`);
process.exit(passed === results.length ? 0 : 1);
