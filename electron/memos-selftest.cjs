#!/usr/bin/env node
/**
 * MemOS 接入自测（纯 Node，不启动 Electron、不联网）。
 *   node electron/memos-selftest.cjs
 *
 * 覆盖：新建 / 更新 / 禁用 memos 外部 MCP 条目，保留已有 command / url / 其它头，
 * Key 不出现在面板状态、日志和状态返回值里，旧 settings.context.memosApiKey 只读迁移。
 * 所有文件都写在系统临时目录，不碰 data/ 和 ~/.bridge-replica。
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildPanelState } = require("./panel-state.cjs");
const { collectSecrets, redact } = require("./app-log.cjs");
const { SettingsStore } = require("./settings.cjs");
const {
  memosConfigFile,
  memosStatus,
  readLegacyMemosKey,
  saveMemosKey,
  setMemosEnabled,
} = require("./memos-bridge.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "windrise-memos-"));
const results = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    results.push([name, true, detail]);
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ""}`);
  } catch (error) {
    results.push([name, false, error.message]);
    console.log(`FAIL  ${name}  — ${error.message}`);
  }
};
const checkAsync = async (name, fn) => {
  try {
    const detail = await fn();
    results.push([name, true, detail]);
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ""}`);
  } catch (error) {
    results.push([name, false, error.message]);
    console.log(`FAIL  ${name}  — ${error.message}`);
  }
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const keyA = `memos-test-key-${"a".repeat(24)}`;
const keyB = `memos-test-key-${"b".repeat(24)}`;
const keyC = `memos-test-key-${"c".repeat(24)}`;
const logs = [];

async function main() {
  const home = path.join(root, "new");
  await checkAsync("新建 memos 条目：写 http 地址 + Authorization: Bearer", async () => {
    const result = await saveMemosKey({
      dataHome: home,
      key: keyA,
      url: "https://memos.example.test/mcp",
      log: (line) => logs.push(line),
    });
    const doc = readJson(memosConfigFile(home));
    const entry = doc.mcpServers.memos;
    assert.equal(result.created, true);
    assert.equal(entry.enabled, true);
    assert.equal(entry.transport, "http");
    assert.equal(entry.url, "https://memos.example.test/mcp");
    assert.equal(entry.headers.Authorization, `Bearer ${keyA}`);
    return `memos / ${entry.transport} / ${entry.url}`;
  });

  check("状态：已连接只回 configured / status，不带 Key", () => {
    const status = memosStatus({ dataHome: home, health: [{ id: "memos", state: "ready", toolCount: 6 }] });
    assert.deepEqual(status, { configured: true, status: "running", enabled: true });
    assert.ok(!JSON.stringify(status).includes(keyA));
    return JSON.stringify(status);
  });

  await checkAsync("更新 Key：沿用原地址 / 其它头，不新建第二条", async () => {
    await saveMemosKey({ dataHome: home, key: keyB, log: (line) => logs.push(line) });
    const doc = readJson(memosConfigFile(home));
    const names = Object.keys(doc.mcpServers);
    assert.deepEqual(names, ["memos"]);
    assert.equal(doc.mcpServers.memos.url, "https://memos.example.test/mcp");
    assert.equal(doc.mcpServers.memos.headers.Authorization, `Bearer ${keyB}`);
    return names.join(",");
  });

  await checkAsync("生成的配置能被 ExternalMcpConfigStore 正常归一化", async () => {
    const { ExternalMcpConfigStore } = await import("../src/core/external-mcp.js");
    const store = new ExternalMcpConfigStore({ configPath: memosConfigFile(home) });
    const { servers, errors } = await store.servers();
    const entry = servers.find((server) => server.id === "memos");
    assert.ok(entry, "没有解析出 memos 条目");
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert.equal(entry.transport, "http");
    assert.equal(entry.url, "https://memos.example.test/mcp");
    assert.equal(entry.headers.Authorization, `Bearer ${keyB}`);
    assert.equal(entry.enabled, true);
    return "transport / url / headers / enabled 都对";
  });

  const home2 = path.join(root, "existing");
  await checkAsync("已有条目：更新 key 头，保留 command / timeout / tools / 顶层字段", async () => {
    fs.mkdirSync(home2, { recursive: true });
    fs.writeFileSync(memosConfigFile(home2), JSON.stringify({
      version: 1,
      keep: "top-level",
      mcpServers: {
        "memos-mcp": {
          label: "手工配的 MemOS",
          transport: "http",
          url: "https://memos.example.test/v1/mcp",
          httpTransport: "sse",
          timeout: 12,
          headers: { "x-api-key": "old-key", "X-Trace": "keep" },
          tools: { allow: ["search_memory"] },
          enabled: false,
        },
      },
    }, null, 2));
    const result = await saveMemosKey({ dataHome: home2, key: keyC, log: (line) => logs.push(line) });
    const doc = readJson(memosConfigFile(home2));
    const entry = doc.mcpServers["memos-mcp"];
    assert.equal(result.id, "memos-mcp");
    assert.equal(doc.keep, "top-level");
    assert.equal(doc.mcpServers.memos, undefined);
    assert.equal(entry.headers["x-api-key"], keyC);
    assert.equal(entry.headers["X-Trace"], "keep");
    assert.equal(entry.timeout, 12);
    assert.equal(entry.httpTransport, "sse");
    assert.deepEqual(entry.tools, { allow: ["search_memory"] });
    assert.equal(entry.command, undefined);
    assert.equal(entry.enabled, true);
    return "memos-mcp / 保留 5 个字段";
  });

  const home3 = path.join(root, "stdio");
  await checkAsync("stdio 条目：更新 env 里的 Key，保留 command / args / 其它 env", async () => {
    fs.mkdirSync(home3, { recursive: true });
    fs.writeFileSync(memosConfigFile(home3), JSON.stringify({
      version: 1,
      mcpServers: {
        memos: {
          transport: "stdio",
          command: "node",
          args: ["memos-mcp.js"],
          env: { MEMOS_API_KEY: "old-key", KEEP: "1" },
          enabled: true,
        },
      },
    }, null, 2));
    await saveMemosKey({ dataHome: home3, key: keyA, log: (line) => logs.push(line) });
    const entry = readJson(memosConfigFile(home3)).mcpServers.memos;
    assert.equal(entry.transport, "stdio");
    assert.equal(entry.command, "node");
    assert.deepEqual(entry.args, ["memos-mcp.js"]);
    assert.equal(entry.env.MEMOS_API_KEY, keyA);
    assert.equal(entry.env.KEEP, "1");
    return "env 已更新，command / args 未动";
  });

  await checkAsync("断开：只禁用条目，Key 仍在", async () => {
    await setMemosEnabled({ dataHome: home, enabled: false, log: (line) => logs.push(line) });
    const entry = readJson(memosConfigFile(home)).mcpServers.memos;
    assert.equal(entry.enabled, false);
    assert.equal(entry.headers.Authorization, `Bearer ${keyB}`);
    const status = memosStatus({ dataHome: home, health: [{ id: "memos", state: "ready" }] });
    assert.deepEqual(status, { configured: true, status: "disabled", enabled: false });
    return JSON.stringify(status);
  });

  await checkAsync("断开后再保存（key 留空）：重新启用，沿用旧 Key", async () => {
    await saveMemosKey({ dataHome: home, key: "", log: (line) => logs.push(line) });
    const entry = readJson(memosConfigFile(home)).mcpServers.memos;
    assert.equal(entry.enabled, true);
    assert.equal(entry.headers.Authorization, `Bearer ${keyB}`);
    return "已重新启用";
  });

  check("面板状态：MemOS 只有 configured + status", () => {
    const state = buildPanelState({ memosConfigured: true, memosStatus: "running" });
    assert.deepEqual(state.memos, { configured: true, status: "running" });
    assert.ok(!JSON.stringify(state).includes(keyA));
    assert.ok(!JSON.stringify(state).includes(keyB));
    const legacy = buildPanelState({ memosConfigured: true });
    assert.equal(legacy.memos.status, "stopped");
    const off = buildPanelState({ memosConfigured: true, memosStatus: "disabled" });
    assert.equal(off.memos.status, "disabled");
    const broken = buildPanelState({ memosConfigured: false, memosStatus: "error" });
    assert.deepEqual(broken.memos, { configured: false, status: "error" });
    return JSON.stringify(state.memos);
  });

  check("日志：所有行列都不含 Key", () => {
    const text = logs.join("\n");
    for (const key of [keyA, keyB, keyC]) assert.ok(!text.includes(key), "日志里出现了 Key");
    return `${logs.length} 行`;
  });

  check("日志脱敏：外部 MCP 配置里的 Key 会被换成 <令牌>", () => {
    const secrets = collectSecrets({ dataHome: home2 });
    const out = redact(`request header x-api-key=${keyC}`, secrets);
    assert.ok(!out.includes(keyC), out);
    return out.slice(0, 40);
  });

  const missing = path.join(root, "missing");
  await checkAsync("没有现成条目、也没有地址：报错但不写文件、不回显 Key", async () => {
    let error;
    try {
      await saveMemosKey({ dataHome: missing, key: keyA });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, "应当报错");
    assert.match(error.message, /MCP 地址/);
    assert.ok(!error.message.includes(keyA));
    assert.equal(fs.existsSync(memosConfigFile(missing)), false);
    return error.message.slice(0, 48);
  });

  check("旧 settings.context.memosApiKey 只读出来做迁移，不写回设置", () => {
    const legacyHome = path.join(root, "legacy");
    fs.mkdirSync(legacyHome, { recursive: true });
    fs.writeFileSync(path.join(legacyHome, "settings.json"), JSON.stringify({ context: { memosApiKey: keyA } }));
    assert.equal(readLegacyMemosKey(legacyHome), keyA);
    assert.equal(readLegacyMemosKey(path.join(root, "none")), "");
    return "legacy reader ok";
  });

  check("settings 不再保存 MemOS Key（只认已知字段）", () => {
    const dir = path.join(root, "settings");
    const store = new SettingsStore(dir);
    store.save({ toolTier: "full", context: { memosApiKey: keyA } });
    const saved = store.all();
    assert.equal(saved.context, undefined);
    assert.equal(saved.toolTier, "full");
    assert.ok(!JSON.stringify(saved).includes(keyA));
    return "context.memosApiKey 被忽略";
  });

  check("状态：没有条目是 not-configured，坏 JSON 是 error", () => {
    assert.deepEqual(memosStatus({ dataHome: missing }), { configured: false, status: "not-configured" });
    const broken = path.join(root, "broken");
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(memosConfigFile(broken), "{ not json");
    assert.deepEqual(memosStatus({ dataHome: broken }), { configured: false, status: "error" });
    return "not-configured / error";
  });
}

main()
  .catch((error) => {
    results.push(["未捕获异常", false, error.stack || error.message]);
    console.log(`FAIL  未捕获异常  — ${error.stack || error.message}`);
  })
  .finally(() => {
    fs.rmSync(root, { recursive: true, force: true });
    console.log("");
    const failed = results.filter(([, ok]) => !ok);
    console.log(`通过 ${results.length - failed.length}/${results.length}`);
    process.exit(failed.length ? 1 : 0);
  });
