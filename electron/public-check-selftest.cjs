/**
 * 公网实测判定自测（纯 node，不启动 Electron、不发请求）。
 *
 *   node electron/public-check-selftest.cjs
 *
 * 覆盖：200 + uptime 对得上算成功；uptime 对不上 / 非 200 / 超时算失败；
 * 头 30 秒宽限；连续 2 次才报警且重连期间不重复报警；成功后清零；
 * 本机网络问题（断网 / DNS / 代理）不计数不重连、连续 10 次只 warn 一次；
 * 重连中不探测；错误文字和域名里不带令牌。
 */

const crypto = require("node:crypto");
const {
  GRACE_MS,
  UPTIME_SLACK_MS,
  FAIL_THRESHOLD,
  RETRY_EVERY,
  LOCAL_WARN_AFTER,
  newPublicCheck,
  healthTarget,
  publicHost,
  alarmMessage,
  publicStatusOverride,
  settlesVerification,
  classifyProbeError,
  controlTarget,
  judgeWithControl,
  probeDue,
  judgeProbe,
  applyProbe,
  createPublicCheck,
} = require("./public-check.cjs");

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

const token = crypto.randomBytes(32).toString("base64url");
const baseUrl = `https://quick-name-1234.trycloudflare.com/mcp/${token}`;
const t0 = Date.parse("2026-10-24T10:00:00.000Z");

/* ① 地址换算 */
check("a1", "healthTarget 把 /mcp/<令牌> 换成 /healthz/<令牌>", () => {
  const target = healthTarget(baseUrl);
  assert(target && target.pathname === `/healthz/${token}`, `pathname=${target?.pathname}`);
  assert(target.search === "", "查询串没清掉");
  return target.pathname.replace(token, "<令牌>");
});
check("a2", "不像 MCP 地址的不乱探", () => {
  assert(healthTarget(`https://example.com/other/${token}`) === null, "非法路径也生成了目标");
  assert(healthTarget("not a url") === null, "坏 URL 没被拒");
  return "返回 null";
});

/* ② 判定单次结果 */
check("b1", "200 + ok:true + uptime 对得上（差值在耗时 + 15 秒内）算成功", () => {
  const result = judgeProbe({ status: 200, body: { ok: true, uptimeMs: 100_000 }, localUptimeMs: 99_000, latencyMs: 1_200 });
  assert(result.ok, result.error);
  assert(result.uptimeGapMs === 1_000, `uptimeGapMs=${result.uptimeGapMs}`);
  assert(result.allowedGapMs === UPTIME_SLACK_MS + 1_200, `allowedGapMs=${result.allowedGapMs}`);
  return `差值 ${result.uptimeGapMs}ms，允许 ${result.allowedGapMs}ms`;
});
check("b2", "uptime 对不上算失败，并说明可能连到了别的实例", () => {
  const result = judgeProbe({ status: 200, body: { ok: true, uptimeMs: 5_000_000 }, localUptimeMs: 10_000, latencyMs: 800 });
  assert(!result.ok, "居然判成功");
  assert(/别的实例/.test(result.error), result.error);
  assert(/\d+ 秒/.test(result.error), result.error);
  return result.error;
});
check("b3", "非 200 算失败并带上状态码", () => {
  for (const status of [500, 502, 530, 404]) {
    const result = judgeProbe({ status, body: null, localUptimeMs: 1, latencyMs: 10 });
    assert(!result.ok && result.error.includes(String(status)), `${status}: ${result.error}`);
  }
  return "500 / 502 / 530 / 404";
});
check("b4", "200 但 ok 不是 true / 没有 uptimeMs 也算失败", () => {
  const badOk = judgeProbe({ status: 200, body: { ok: false, uptimeMs: 1 }, localUptimeMs: 1, latencyMs: 1 });
  assert(!badOk.ok && /ok 不是 true/.test(badOk.error), badOk.error);
  const noUptime = judgeProbe({ status: 200, body: { ok: true }, localUptimeMs: 1, latencyMs: 1 });
  assert(!noUptime.ok && /uptimeMs/.test(noUptime.error), noUptime.error);
  return `${badOk.error}｜${noUptime.error}`;
});
check("b5", "超时（调用方给出的网络错误）算失败", () => {
  const outcome = applyProbe(newPublicCheck(), { ok: false, error: "请求超时（8 秒）", latencyMs: 8_000 }, { at: t0 + 60_000, connectedAt: t0 });
  assert(outcome.state.failures === 1 && outcome.state.lastError === "请求超时（8 秒）", JSON.stringify(outcome));
  return outcome.state.lastError;
});

/* ③ 宽限期 */
check("c1", "刚打通的头 30 秒失败不计数、不报警", () => {
  const first = applyProbe(newPublicCheck(), { ok: false, error: "HTTP 502" }, { at: t0 + 5_000, connectedAt: t0 });
  assert(first.state.failures === 0 && !first.alarm && first.withinGrace, JSON.stringify(first));
  const second = applyProbe(first.state, { ok: false, error: "HTTP 502" }, { at: t0 + 29_999, connectedAt: t0 });
  assert(second.state.failures === 0 && !second.alarm, JSON.stringify(second));
  return `5 秒、29.999 秒都还是 0 次`;
});
check("c2", "宽限期一过，失败开始计数", () => {
  const outcome = applyProbe(newPublicCheck(), { ok: false, error: "HTTP 502" }, { at: t0 + GRACE_MS, connectedAt: t0 });
  assert(outcome.state.failures === 1 && !outcome.withinGrace, JSON.stringify(outcome));
  return `第 ${outcome.state.failures} 次失败`;
});

/* ④ 连续 2 次报警；重连期间不重复；成功清零 */
check("d1", "连续 2 次失败才报警，第 3 次不重复触发", () => {
  const at = (offset) => t0 + GRACE_MS + offset * 30_000;
  const first = applyProbe(newPublicCheck(), { ok: false, error: "HTTP 502" }, { at: at(0), connectedAt: t0 });
  assert(first.state.failures === 1 && !first.alarm && !first.alerted, JSON.stringify(first));
  const second = applyProbe(first.state, { ok: false, error: "HTTP 502" }, { at: at(1), connectedAt: t0, alerted: first.alerted });
  assert(second.state.failures === FAIL_THRESHOLD && second.alarm && second.reconnect && second.alerted, JSON.stringify(second));
  const third = applyProbe(second.state, { ok: false, error: "HTTP 502" }, { at: at(2), connectedAt: t0, alerted: second.alerted });
  assert(third.state.failures === 3 && !third.alarm && !third.reconnect, "重连期间又报了一次警");
  return `failures=${second.state.failures} 时 alarm，之后第三次 alarm=${third.alarm}`;
});
check("d2", "公网实测成功一次就清零、恢复 connected", () => {
  const broken = { ok: false, failures: 2, lastError: "HTTP 502", at: t0, lastOkAt: 0, latencyMs: 500 };
  const outcome = applyProbe(broken, { ok: true, latencyMs: 320 }, { at: t0 + 90_000, connectedAt: t0, alerted: true });
  assert(outcome.state.failures === 0 && outcome.state.ok === true, JSON.stringify(outcome.state));
  assert(outcome.state.lastOkAt === t0 + 90_000 && outcome.state.lastError === null, JSON.stringify(outcome.state));
  assert(outcome.recovered && !outcome.alarm && !outcome.alerted, JSON.stringify(outcome));
  return `failures=0，lastOkAt=${new Date(outcome.state.lastOkAt).toISOString()}`;
});
check("d3", "恢复后再次连续失败，可以重新报警", () => {
  const machine = createPublicCheck();
  let outcome = machine.push({ ok: false, error: "HTTP 502" }, { at: t0 + GRACE_MS, connectedAt: t0 });
  outcome = machine.push({ ok: false, error: "HTTP 502" }, { at: t0 + GRACE_MS + 30_000, connectedAt: t0 });
  assert(outcome.alarm, "第一次连续失败没报警");
  outcome = machine.push({ ok: true, latencyMs: 100 }, { at: t0 + 120_000, connectedAt: t0 });
  assert(outcome.recovered && machine.state.failures === 0, "成功后没清零");
  outcome = machine.push({ ok: false, error: "HTTP 530" }, { at: t0 + 150_000, connectedAt: t0 });
  const again = machine.push({ ok: false, error: "HTTP 530" }, { at: t0 + 180_000, connectedAt: t0 });
  assert(!outcome.alarm && again.alarm, "恢复后没有重新报警");
  return `第二次报警时 failures=${again.state.failures}`;
});
check("d4", "报警重连后还是不通：每再失败 6 次（约 3 分钟）重试一次，中间不重复", () => {
  const machine = createPublicCheck();
  const alarmsAt = [];
  for (let i = 0; i < 16; i++) {
    const outcome = machine.push({ ok: false, error: "HTTP 530" }, { at: t0 + GRACE_MS + i * 30_000, connectedAt: t0 });
    if (outcome.alarm) alarmsAt.push(outcome.state.failures);
  }
  assert(RETRY_EVERY === 6, `RETRY_EVERY=${RETRY_EVERY}`);
  assert(alarmsAt.join(",") === `${FAIL_THRESHOLD},${FAIL_THRESHOLD + 6},${FAIL_THRESHOLD + 12}`, `报警发生在第 ${alarmsAt.join("、")} 次失败`);
  return `第 ${alarmsAt.join("、")} 次失败时重连`;
});

/* ⑤ 状态形状与脱敏 */
check("e1", "对外状态只有约定的 6 个字段", () => {
  const keys = Object.keys(newPublicCheck()).sort().join(",");
  assert(keys === "at,failures,lastError,lastOkAt,latencyMs,ok", keys);
  return keys;
});
check("e2", "日志用的域名不含令牌，判定错误文字也不含令牌", () => {
  const host = publicHost(baseUrl);
  assert(host === "quick-name-1234.trycloudflare.com", host);
  assert(!host.includes(token), "域名里居然带令牌");
  const results = [
    judgeProbe({ status: 200, body: { ok: true, uptimeMs: 9_999_999 }, localUptimeMs: 1, latencyMs: 10 }),
    judgeProbe({ status: 502, body: null, localUptimeMs: 1, latencyMs: 10 }),
    judgeProbe({ status: 200, body: { ok: false }, localUptimeMs: 1, latencyMs: 10 }),
  ];
  for (const result of results) {
    assert(!String(result.error).includes(token), `错误文字带令牌：${result.error}`);
    assert(!String(result.error).includes("/mcp/"), `错误文字带路径：${result.error}`);
  }
  const message = alarmMessage({ failures: 2, error: results[1].error, host });
  assert(!message.includes(token), `报警日志带令牌：${message}`);
  assert(!message.includes("/mcp/"), `报警日志带路径：${message}`);
  assert(message.includes("连续 2 次") && message.includes("自动重连隧道"), message);
  return `${host}；${message}`;
});

/* ⑥ 本机网络问题 vs 隧道层故障 */
check("f1", "名单外的错误要打对照：RESET + 对照失败算本机，RESET / 超时 + 对照成功才算隧道", () => {
  const cases = [
    Object.assign(new Error("Failed to fetch"), { code: "net::ERR_INTERNET_DISCONNECTED" }),
    { message: "net::ERR_NAME_NOT_RESOLVED" },
    { message: "net::ERR_PROXY_CONNECTION_FAILED" },
    { message: "net::ERR_NETWORK_CHANGED" },
    { message: "net::ERR_ADDRESS_UNREACHABLE" },
    { cause: { code: "ENOTFOUND" } },
    { code: "ECONNREFUSED" },
  ];
  for (const error of cases) {
    const result = classifyProbeError(error);
    assert(result.kind === "local-network" && !result.ok, JSON.stringify(result));
    assert(result.error.includes("这台电脑现在访问不到公网") && result.error.includes("不算隧道故障"), result.error);
    assert(!result.error.includes("/mcp/"), `错误文字带路径：${result.error}`);
  }

  const reset = { message: "net::ERR_CONNECTION_RESET" };
  const resetLocal = judgeWithControl({ probeError: reset, control: { ok: false, error: { message: "net::ERR_CONNECTION_REFUSED" } } });
  assert(resetLocal.kind === "local-network", `对照失败应按本机处理：${JSON.stringify(resetLocal)}`);
  assert(resetLocal.error.includes("这台电脑现在访问不到 Cloudflare") && resetLocal.error.includes("不算隧道故障"), resetLocal.error);
  const resetTunnel = judgeWithControl({ probeError: reset, control: { ok: true } });
  assert(resetTunnel.kind === "tunnel", `对照成功应按隧道计数：${JSON.stringify(resetTunnel)}`);
  assert(resetTunnel.error.includes("Cloudflare 能访问，但隧道没把请求送到桥"), resetTunnel.error);
  const timeoutTunnel = judgeWithControl({ probeError: new Error("The operation was aborted"), timedOut: true, control: { ok: true } });
  assert(timeoutTunnel.kind === "tunnel", `超时 + 对照成功应按隧道计数：${JSON.stringify(timeoutTunnel)}`);
  assert(timeoutTunnel.error.includes("请求超时 8 秒"), timeoutTunnel.error);

  // 拿到 HTTP 响应（530）走 judgeProbe，不需要对照：直接按隧道故障计数
  const http530 = judgeProbe({ status: 530, body: null, localUptimeMs: 1, latencyMs: 20 });
  assert(!http530.ok && http530.error.includes("HTTP 530"), JSON.stringify(http530));

  // 对照地址只带域名 + /cdn-cgi/trace，不带令牌和 MCP 路径
  const control = controlTarget(baseUrl);
  assert(control && control.href === "https://quick-name-1234.trycloudflare.com/cdn-cgi/trace", control?.href);
  assert(!control.href.includes(token) && !control.href.includes("/mcp/"), control.href);

  return `${cases.length} 种白名单错误；RESET 对照失败=${resetLocal.kind}、对照成功=${resetTunnel.kind}；超时对照成功=${timeoutTunnel.kind}；530 直接 ${http530.error}`;
});
check("f2", "本机网络问题不计数、不报警、不重连，只更新 lastError", () => {
  const result = classifyProbeError({ message: "net::ERR_INTERNET_DISCONNECTED" });
  const outcome = applyProbe(newPublicCheck(), { ...result, latencyMs: 20 }, { at: t0 + GRACE_MS, connectedAt: t0 });
  assert(outcome.state.failures === 0, `failures=${outcome.state.failures}`);
  assert(outcome.state.ok === false, "ok 应为 false");
  assert(!outcome.alarm && !outcome.reconnect, JSON.stringify(outcome));
  assert(outcome.localFailures === 1 && !outcome.localAlarm, JSON.stringify(outcome));
  assert(outcome.state.lastError.includes("ERR_INTERNET_DISCONNECTED"), outcome.state.lastError);
  return outcome.state.lastError;
});
check("f3", `连续 ${LOCAL_WARN_AFTER} 次本机网络问题只 warn 一次，恢复后清零`, () => {
  const machine = createPublicCheck();
  const result = classifyProbeError({ cause: { code: "ENOTFOUND" } });
  let warns = 0;
  for (let i = 0; i < 12; i++) {
    const outcome = machine.push({ ...result }, { at: t0 + GRACE_MS + i * 30_000, connectedAt: t0 });
    assert(outcome.state.failures === 0, `第 ${i + 1} 次把本机问题算进了隧道失败`);
    assert(!outcome.alarm && !outcome.reconnect, `第 ${i + 1} 次触发了重连`);
    if (outcome.localAlarm) warns++;
  }
  assert(LOCAL_WARN_AFTER === 10, `LOCAL_WARN_AFTER=${LOCAL_WARN_AFTER}`);
  assert(warns === 1, `12 次里 warn 了 ${warns} 次`);
  const recovered = machine.push({ ok: true, latencyMs: 100 }, { at: t0 + GRACE_MS + 13 * 30_000, connectedAt: t0 });
  assert(recovered.recovered, "本机网络恢复后没有报恢复");
  assert(machine.localFailures === 0 && machine.localAlerted === false, `恢复后 local=${machine.localFailures}/${machine.localAlerted}`);
  let again = 0;
  for (let i = 0; i < 10; i++) {
    const outcome = machine.push({ ...result }, { at: t0 + GRACE_MS + (14 + i) * 30_000, connectedAt: t0 });
    if (outcome.localAlarm) again++;
  }
  assert(again === 1, `恢复后再次连续 10 次 warn 了 ${again} 次`);
  return `12 次里 warn ${warns} 次；恢复清零后再次连续 10 次 warn ${again} 次`;
});
check("f4", "HTTP 530 和请求超时（对照成功）仍按隧道层故障计数并在第 2 次报警", () => {
  const timeout = judgeWithControl({ probeError: new Error("The operation was aborted"), timedOut: true, control: { ok: true } });
  assert(timeout.kind === "tunnel" && timeout.error.includes("请求超时 8 秒"), JSON.stringify(timeout));

  const httpMachine = createPublicCheck();
  const http1 = httpMachine.push(judgeProbe({ status: 530, body: null, latencyMs: 20 }), { at: t0 + GRACE_MS, connectedAt: t0 });
  const http2 = httpMachine.push(judgeProbe({ status: 530, body: null, latencyMs: 20 }), { at: t0 + GRACE_MS + 30_000, connectedAt: t0 });
  assert(http1.state.failures === 1 && !http1.alarm, JSON.stringify(http1));
  assert(http2.state.failures === FAIL_THRESHOLD && http2.alarm && http2.reconnect, JSON.stringify(http2));

  const timeoutMachine = createPublicCheck();
  const t1 = timeoutMachine.push({ ...timeout, latencyMs: 8_000 }, { at: t0 + GRACE_MS, connectedAt: t0 });
  const t2 = timeoutMachine.push({ ...timeout, latencyMs: 8_000 }, { at: t0 + GRACE_MS + 30_000, connectedAt: t0 });
  assert(t1.state.failures === 1 && !t1.alarm, JSON.stringify(t1));
  assert(t2.state.failures === FAIL_THRESHOLD && t2.alarm && t2.reconnect, JSON.stringify(t2));
  return `530 第 ${http2.state.failures} 次报警；超时第 ${t2.state.failures} 次报警`;
});
check("f5", "重连中（reconnecting）不探测；正常时才探测", () => {
  const url = "https://quick-name-1234.trycloudflare.com/mcp/fake";
  assert(probeDue({ publicMcpUrl: url }), "正常情况被跳过");
  assert(!probeDue({ publicMcpUrl: url, reconnecting: true }), "公网实测重连中还在探");
  assert(!probeDue({ publicMcpUrl: url, tunnelReconnecting: true }), "隧道重连中还在探");
  assert(!probeDue({ publicMcpUrl: url, busy: true }), "上一次没结束还在探");
  assert(!probeDue({ publicMcpUrl: null }), "没有公网地址也在探");
  return "reconnecting / tunnelReconnecting / busy / 无地址 都跳过";
});

/* ⑦ 重连后的界面状态覆盖 */
check("h1", "低于阈值不覆盖；重连后等验证显示「连接中」；验证还失败说会自动重连、不再说正在重连", () => {
  assert(publicStatusOverride({ failures: FAIL_THRESHOLD - 1, verifying: false }) === null, "低于阈值还覆盖了");
  assert(publicStatusOverride({ failures: FAIL_THRESHOLD - 1, verifying: true }) === null, "低于阈值（验证中）还覆盖了");
  const verifying = publicStatusOverride({ failures: FAIL_THRESHOLD, verifying: true });
  assert(verifying.level === "connecting" && verifying.label === "连接中", JSON.stringify(verifying));
  assert(verifying.detail === "已重连，正在验证公网…", verifying.detail);
  const failed = publicStatusOverride({ failures: 5, verifying: false });
  assert(failed.level === "error" && failed.label === "公网不通", JSON.stringify(failed));
  assert(failed.error.includes("已连续 5 次"), failed.error);
  assert(!failed.error.includes("正在自动重连"), failed.error);
  return `${verifying.detail}｜${failed.error}`;
});

check("h2", "重连后的验证：成功、计数的失败算做过；宽限期里的失败、本机网络问题不算", () => {
  const prev = { ...newPublicCheck(), failures: FAIL_THRESHOLD };
  const t0 = 1_000_000;
  const tunnelFail = { ok: false, kind: "tunnel", error: "公网返回 HTTP 530" };
  const ok = applyProbe(prev, { ok: true, latencyMs: 80 }, { at: t0 + 5_000, connectedAt: t0 });
  assert(settlesVerification(ok, { ok: true }), "成功没算验证过");
  const grace = applyProbe(prev, tunnelFail, { at: t0 + 5_000, connectedAt: t0 });
  assert(grace.withinGrace && !settlesVerification(grace, tunnelFail), "宽限期里的失败被算成验证过");
  const counted = applyProbe(prev, tunnelFail, { at: t0 + 60_000, connectedAt: t0 });
  assert(!counted.withinGrace && settlesVerification(counted, tunnelFail), "宽限期后的失败没算验证过");
  const local = { ok: false, kind: "local-network", code: "ERR_INTERNET_DISCONNECTED" };
  const localOutcome = applyProbe(prev, local, { at: t0 + 60_000, connectedAt: t0 });
  assert(!settlesVerification(localOutcome, local), "本机网络问题被算成验证过");
  return "成功 / 宽限后失败 → 算；宽限内失败 / 本机断网 → 不算";
});

/* ⑦b 启动期的 503：不计数、不重连、不算验证过 */
check("h3", "桥启动期的 503 不算「公网访问不到」：不计数、不报警、不重连", () => {
  const warming = judgeProbe({ status: 503, body: null, latencyMs: 30, retryAfter: "5" });
  assert(warming.kind === "warming" && !warming.ok, JSON.stringify(warming));
  assert(warming.retryAfter === "5" && warming.error.includes("正在启动") && warming.error.includes("5 秒"), warming.error);

  const machine = createPublicCheck();
  let outcome = null;
  // 连续 5 次 503（相当于重启后头两分半钟都在等桥起来）：failures 必须一直是 0
  for (let i = 0; i < 5; i++) {
    outcome = machine.push(warming, { at: t0 + GRACE_MS + i * 30_000, connectedAt: t0 });
    assert(outcome.state.failures === 0, `第 ${i + 1} 次 503 被算成了失败（failures=${outcome.state.failures}）`);
    assert(!outcome.alarm && !outcome.reconnect, `第 ${i + 1} 次 503 触发了重连`);
  }
  assert(outcome.state.ok !== false, `503 把 ok 改成了 false：${outcome.state.ok}`);
  assert(outcome.state.lastError.includes("正在启动"), outcome.state.lastError);
  assert(!settlesVerification(outcome, warming), "启动期的 503 被算成「验证做过了」");

  // 桥起来之后 200：照常算成功，状态干净
  const healthy = machine.push({ ok: true, latencyMs: 60 }, { at: t0 + GRACE_MS + 6 * 30_000, connectedAt: t0 });
  assert(healthy.state.ok === true && healthy.state.failures === 0 && healthy.state.lastError === null, JSON.stringify(healthy.state));

  // 真故障仍然是故障：503 之后来 530 照常计数
  const broken = machine.push(judgeProbe({ status: 530, body: null, latencyMs: 20 }), { at: t0 + GRACE_MS + 7 * 30_000, connectedAt: t0 });
  assert(broken.state.failures === 1, `530 没被计数：${broken.state.failures}`);
  return `连续 5 次 503 后 failures=${outcome.state.failures}；随后 200 清零、530 照常计数`;
});

const passed = results.filter((item) => item.ok).length;
console.log(`\n通过 ${passed}/${results.length}（Electron 未加载，Node ${process.versions.node}）`);
process.exit(passed === results.length ? 0 : 1);
