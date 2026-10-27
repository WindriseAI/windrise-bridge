/**
 * 日志落盘自测（纯 node，不启动 Electron）。
 *
 *   node electron/app-log-selftest.cjs
 *
 * 覆盖：按天分文件、换行处理、5MB 上限、14 天清理（启动时 + 跨天）、
 * 各种秘密值脱敏、网址查询串 / # 片段省略、短值不误伤、写盘出错不抛异常。
 * 所有令牌都是随机生成的假值。
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  MAX_BYTES,
  MIN_SECRET_LENGTH,
  formatLine,
  redact,
  collectSecrets,
  cleanupOldLogs,
  createAppLog,
} = require("./app-log.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "windrise-applog-"));
const results = [];
const record = (id, name, ok, detail = "") => {
  results.push({ id, name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id} ${name}${detail ? `\n        ${detail}` : ""}`);
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const check = async (id, name, fn) => {
  try { record(id, name, true, (await fn()) || ""); }
  catch (error) { record(id, name, false, error.message); }
};
const read = (file) => fs.readFileSync(file, "utf8");

/* 随机生成的假令牌 —— 绝不使用真实令牌 */
const routeToken = crypto.randomBytes(16).toString("hex");
const tunnelToken = crypto.randomBytes(24).toString("base64url");
const ngrokToken = crypto.randomBytes(24).toString("base64url");
const cfToken = crypto.randomBytes(24).toString("base64url");
const connectorToken = crypto.randomBytes(24).toString("base64url");
const jwtLike = "eyJ" + crypto.randomBytes(24).toString("base64url");
/** 只出现在 TUNNEL_TOKEN= / --token 后面，不在已知秘密列表里 —— 专门验证通用模式 */
const flagToken = crypto.randomBytes(24).toString("base64url");
const fallbackToken = crypto.randomBytes(24).toString("base64url");
const sixteen = "0123456789abcdef";
const shortSecret = "short-secret-1";

const settings = {
  all: () => ({
    tunnel: { token: tunnelToken, ngrokAuthtoken: ngrokToken },
    cloudflare: { apiToken: cfToken },
  }),
};
const connectors = { list: () => [{ id: "c-test", token: connectorToken }] };

const day1 = new Date(2026, 9, 20, 10, 0, 0, 123).getTime();
const day2 = new Date(2026, 9, 21, 9, 30, 0, 4).getTime();
/** 用一个固定 16 位值验证边界（不是任何真实令牌） */
const CFG_SIXTEEN_PROBE = "fedcba9876543210";

async function main() {
  /* ① 秘密值收集：路由令牌读文件、隧道 / ngrok / Cloudflare 读设置、连接器走 list() */
  const secretHome = path.join(root, "secret");
  fs.mkdirSync(secretHome, { recursive: true });
  fs.writeFileSync(path.join(secretHome, "route-token.json"), JSON.stringify({ version: 1, token: routeToken }));
  await check("a1", "collectSecrets 收齐各路秘密值，短值不收", () => {
    const secrets = collectSecrets({ dataHome: secretHome, currentToken: sixteen, settings, connectors });
    for (const value of [routeToken, sixteen, tunnelToken, ngrokToken, cfToken, connectorToken]) {
      assert(secrets.includes(value), `缺少 ${value.slice(0, 6)}…`);
    }
    assert(!secrets.includes(shortSecret), "短于 16 的值不该参与替换");
    return `收集到 ${secrets.length} 个值`;
  });

  await check("a1b", "没有 ConnectorStore 时从 connectors.json 只读兜底", () => {
    const dir = path.join(root, "fallback");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "route-token.json"), JSON.stringify({ version: 1, token: routeToken }));
    fs.writeFileSync(path.join(dir, "connectors.json"), JSON.stringify({ version: 1, connectors: [{ token: fallbackToken }] }));
    const secrets = collectSecrets({ dataHome: dir });
    assert(secrets.includes(routeToken) && secrets.includes(fallbackToken), `只收集到 ${secrets.length} 个`);
    return `收集到 ${secrets.length} 个值`;
  });

  /* ② 通用模式 + 已知值脱敏 */
  await check("a2", "/mcp/、eyJ、TUNNEL_TOKEN=、--token 与已知值都换成 <令牌>", () => {
    const text = [
      `路由 ${routeToken}`,
      `隧道 ${tunnelToken}`,
      `ngrok ${ngrokToken}`,
      `cf ${cfToken}`,
      `连接器 ${connectorToken}`,
      `地址 https://abc.trycloudflare.com/mcp/${routeToken}`,
      `健康 https://abc.trycloudflare.com/healthz/${connectorToken}`,
      `jwt ${jwtLike}`,
      `TUNNEL_TOKEN=${flagToken}`,
      `--token ${flagToken}`,
      `--token=${flagToken}`,
      `短值 ${shortSecret}`,
    ].join(" ");
    const secrets = collectSecrets({ dataHome: secretHome, currentToken: sixteen, settings, connectors });
    const out = redact(text, secrets);
    for (const value of [routeToken, tunnelToken, ngrokToken, cfToken, connectorToken, jwtLike, sixteen, flagToken]) {
      assert(!out.includes(value), `仍然出现令牌：${value.slice(0, 6)}…`);
    }
    assert((out.match(/<令牌>/g) || []).length >= 9, "替换次数不对");
    assert(out.includes(shortSecret), "短值被误伤");
    assert(out.includes("/mcp/<令牌>"), "/mcp/ 路径没替换");
    assert(out.includes("/healthz/<令牌>"), "/healthz/ 路径没替换");
    assert(out.includes("TUNNEL_TOKEN=<令牌>"), "TUNNEL_TOKEN= 没替换");
    assert(out.includes("--token <令牌>") && out.includes("--token=<令牌>"), "--token 没替换");
    return out.slice(out.indexOf("地址"), out.indexOf("地址") + 80);
  });

  await check("a3", "网址的查询串和 # 片段整体省略（里面的令牌 / 邮箱不落盘，括号参数整段吃掉）", () => {
    const queryToken = crypto.randomBytes(12).toString("hex");
    const email = `user-${crypto.randomBytes(4).toString("hex")}@example.com`;
    const fragment = crypto.randomBytes(8).toString("hex");
    const bracketToken = crypto.randomBytes(8).toString("hex");
    const bracketEmail = `user-${crypto.randomBytes(4).toString("hex")}@example.com`;
    const text = [
      `打开 https://example.com/cb?token=${queryToken}&email=${email}#${fragment} 下一步`,
      `另一个 https://example.com/page#section`,
      `没有查询串的 https://example.com/plain 保持原样`,
      `带令牌的地址 https://abc.trycloudflare.com/mcp/${routeToken}?x=1`,
      `跟踪参数 https://example.com/t1?__cft__[0]=${bracketToken}，后面的中文说明保留`,
      `邮箱参数 https://example.com/t2?user[email]=${bracketEmail}，后面的中文说明保留`,
    ].join("；");
    const out = redact(text, []);
    assert(out.includes("https://example.com/cb?<已省略>#<已省略> 下一步"), out);
    assert(out.includes("https://example.com/page#<已省略>"), out);
    assert(out.includes("https://example.com/plain"), "没有查询串的网址被误改");
    assert(out.includes("/mcp/<令牌>?<已省略>"), out);
    assert(out.includes("https://example.com/t1?<已省略>，后面的中文说明保留"), out);
    assert(out.includes("https://example.com/t2?<已省略>，后面的中文说明保留"), out);
    for (const value of [queryToken, email, fragment, "section", bracketToken, bracketEmail, "__cft__", "user[email]"]) {
      assert(!out.includes(value), `仍然出现 ${value.slice(0, 8)}…`);
    }
    return out;
  });

  /* ③ 按天分文件 + 一条一行（换行换成 ⏎）+ 实际写盘也脱敏 */
  const splitHome = path.join(root, "split");
  const logger = createAppLog({ dataHome: splitHome, getSecrets: () => collectSecrets({ dataHome: secretHome, settings, connectors }), now: () => day2 });
  await check("b1", "按天分文件，时间与 kind / level 格式正确", async () => {
    logger.write({ at: day1, kind: "tunnel", text: "第一天的日志" });
    logger.write({ at: day2, kind: "bridge", level: "warn", text: "第二天的日志" });
    await logger.flush();
    const file1 = path.join(splitHome, "logs", "app-2026-10-20.log");
    const file2 = path.join(splitHome, "logs", "app-2026-10-21.log");
    assert(fs.existsSync(file1) && fs.existsSync(file2), "没有按天生成两个文件");
    const line1 = read(file1).trim();
    assert(/^2026-10-20 10:00:00\.123 \[tunnel\] info 第一天的日志$/.test(line1), `第一天格式不对：${line1}`);
    assert(/^2026-10-21 09:30:00\.004 \[bridge\] warn 第二天的日志$/.test(read(file2).trim()), "第二天格式不对");
    return `${path.basename(file1)} / ${path.basename(file2)}`;
  });

  await check("b2", "文本里的换行换成 ⏎，一条记录只占一行", async () => {
    const file = path.join(splitHome, "logs", "app-2026-10-21.log");
    const before = read(file).split("\n").filter(Boolean).length;
    logger.write({ at: day2, kind: "app", text: "第一行\n第二行\r\n第三行" });
    await logger.flush();
    const lines = read(file).split("\n").filter(Boolean);
    assert(lines.length === before + 1, `行数不对：${lines.length}`);
    assert(lines.at(-1).includes("第一行⏎第二行⏎第三行"), "换行没有替换成 ⏎");
    return lines.at(-1);
  });

  await check("b3", "写盘前脱敏：文件里看不到令牌和 /mcp/ 路径段", async () => {
    logger.write({ at: day2, kind: "tunnel", text: `已打通：https://abc.trycloudflare.com/mcp/${routeToken} 隧道 ${tunnelToken} 连接器 ${connectorToken} jwt ${jwtLike} TUNNEL_TOKEN=${flagToken} --token ${flagToken}` });
    await logger.flush();
    const text = read(path.join(splitHome, "logs", "app-2026-10-21.log"));
    assert(!text.includes(routeToken) && !text.includes(tunnelToken) && !text.includes(connectorToken), "文件里还有令牌");
    assert(!text.includes(jwtLike) && !text.includes(flagToken), "JWT 或命令行令牌还在文件里");
    assert(text.includes("/mcp/<令牌>"), "路径段没脱敏");
    assert(text.includes("TUNNEL_TOKEN=<令牌>") && text.includes("--token <令牌>"), "命令行令牌没脱敏");
    return text.trim().split("\n").at(-1);
  });

  /* ④ 5MB 上限（自测用更小的 maxBytes 快速触发，默认值单独核对） */
  await check("c1", "默认上限就是 5MB", () => {
    assert(MAX_BYTES === 5 * 1024 * 1024, `MAX_BYTES=${MAX_BYTES}`);
    return `MAX_BYTES=${MAX_BYTES}`;
  });

  await check("c2", "超过上限后停写当天，并记一条提示", async () => {
    const home = path.join(root, "limit");
    const small = createAppLog({ dataHome: home, maxBytes: 200, now: () => day1 });
    for (let i = 0; i < 10; i++) small.write({ at: day1, kind: "tunnel", text: `LIMIT-${i}-${"x".repeat(80)}` });
    small.write({ at: day1, kind: "tunnel", text: "AFTER-LIMIT" });
    await small.flush();
    const text = read(path.join(home, "logs", "app-2026-10-20.log"));
    assert(text.includes("日志超过 5MB，今天剩下的不再写盘"), "没有写上限提示");
    assert(!text.includes("AFTER-LIMIT"), "超过上限后还在写");
    return `文件 ${Buffer.byteLength(text)} 字节`;
  });

  /* ⑤ 14 天清理 */
  await check("d1", "启动清理：删 14 天以前，保留 14 天内和非 app-*.log", async () => {
    const dir = path.join(root, "retain");
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ["app-2026-10-01.log", "app-2026-10-09.log", "app-2026-10-10.log", "app-2026-10-24.log", "other.log"]) {
      fs.writeFileSync(path.join(dir, name), name);
    }
    const removed = await cleanupOldLogs(dir, new Date(2026, 9, 24, 12).getTime(), 14);
    assert(removed.includes("app-2026-10-01.log"), "20 天前的没删");
    assert(removed.includes("app-2026-10-09.log"), "15 天前的没删");
    assert(fs.existsSync(path.join(dir, "app-2026-10-10.log")), "正好 14 天的被误删");
    assert(fs.existsSync(path.join(dir, "app-2026-10-24.log")), "今天的被误删");
    assert(fs.existsSync(path.join(dir, "other.log")), "非 app-*.log 被误删");
    return `删除 ${removed.join("、")}`;
  });

  await check("d2", "createAppLog 启动时自动清理旧日志", async () => {
    const home = path.join(root, "retain-start");
    const dir = path.join(home, "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "app-2026-09-01.log"), "旧");
    fs.writeFileSync(path.join(dir, "app-2026-10-23.log"), "新");
    const fresh = createAppLog({ dataHome: home, now: () => new Date(2026, 9, 24, 12).getTime() });
    await fresh.ready;
    assert(!fs.existsSync(path.join(dir, "app-2026-09-01.log")), "旧日志没清");
    assert(fs.existsSync(path.join(dir, "app-2026-10-23.log")), "新日志被误删");
    return "旧日志已清理";
  });

  await check("d3", "跨天写日志时也会清理 14 天以前的旧日志", async () => {
    const home = path.join(root, "retain-crossday");
    const dir = path.join(home, "logs");
    fs.mkdirSync(dir, { recursive: true });
    // 10-06 相对 10-20 正好 14 天（启动时保留），到 10-21 就超过 14 天（跨天清理要删）
    fs.writeFileSync(path.join(dir, "app-2026-10-06.log"), "15 天前");
    fs.writeFileSync(path.join(dir, "app-2026-10-20.log"), "当天");
    let clock = new Date(2026, 9, 20, 23, 50).getTime();
    const logger = createAppLog({ dataHome: home, now: () => clock });
    await logger.ready;
    assert(fs.existsSync(path.join(dir, "app-2026-10-06.log")), "启动时不该删 10-06（从 10-20 算正好 14 天）");
    clock = new Date(2026, 9, 21, 0, 10).getTime();
    logger.write({ at: clock, kind: "app", text: "跨天第一条" });
    await logger.flush();
    assert(!fs.existsSync(path.join(dir, "app-2026-10-06.log")), "跨天后没有清理 15 天前的日志");
    assert(fs.existsSync(path.join(dir, "app-2026-10-21.log")), "跨天日志没写进新文件");
    return "10-06 已删，10-21 已写";
  });

  /* ⑥ 出错不抛 */
  await check("e1", "日志目录建不了时 write / flush 都不抛异常", async () => {
    const blocked = path.join(root, "blocked");
    fs.writeFileSync(blocked, "我不是目录");
    const broken = createAppLog({ dataHome: blocked, now: () => day1 });
    let threw = null;
    try {
      broken.write({ at: day1, kind: "app", text: "写不进去" });
      await broken.flush();
    } catch (error) { threw = error; }
    assert(!threw, `抛了异常：${threw?.message}`);
    return "静默跳过";
  });

  await check("e2", "getSecrets 抛异常时照常写盘（只是不脱敏）", async () => {
    const home = path.join(root, "secret-throw");
    const noisy = createAppLog({ dataHome: home, getSecrets: () => { throw new Error("读不到令牌"); }, now: () => day1 });
    let threw = null;
    try {
      noisy.write({ at: day1, kind: "app", text: "普通一条" });
      await noisy.flush();
    } catch (error) { threw = error; }
    assert(!threw, `抛了异常：${threw?.message}`);
    assert(read(path.join(home, "logs", "app-2026-10-20.log")).includes("普通一条"), "没写进去");
    return "照常写盘";
  });

  await check("e3", "formatLine 对空记录也不抛", () => {
    const line = formatLine({});
    assert(/\[app\] info/.test(line), line);
    return line;
  });

  await check("e4", "短于 16 位的值不参与替换（边界 16 位替换）", () => {
    const secrets = collectSecrets({ settings: { tunnel: { token: "x".repeat(15) } }, currentToken: CFG_SIXTEEN_PROBE });
    assert(!secrets.some((value) => value.length < MIN_SECRET_LENGTH), "收集到了短值");
    const out = redact(`a 0123456789abcde b ${sixteen}`, [sixteen]);
    assert(out.includes("0123456789abcde"), "15 位被误伤");
    assert(out.includes("<令牌>") && !out.includes(sixteen), "16 位没替换");
    return out;
  });
}

main()
  .catch((error) => record("z", "自测自身异常", false, error.stack || error.message))
  .finally(() => {
    fs.rmSync(root, { recursive: true, force: true });
    const passed = results.filter((item) => item.ok).length;
    console.log(`\n通过 ${passed}/${results.length}（Electron 未加载，Node ${process.versions.node}）`);
    process.exit(passed === results.length ? 0 : 1);
  });
