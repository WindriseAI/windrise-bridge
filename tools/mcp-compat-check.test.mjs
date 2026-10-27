/**
 * 体检脚本本身的自测：node --test tools/mcp-compat-check.test.mjs
 *
 * 为什么要测脚本：它是「修前 / 修后」对比行的唯一出口（任务第 3 条），
 * 一旦有人把兼容客户端名改坏、或让兼容会话不再生效，其它测试照样全绿，
 * 只有在这里跑一遍脚本、看真实输出才能发现。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { isStrictCompatClient } from "../src/core/mcp-compat.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DECODE = new TextDecoder("utf-8");
// 输出按原始字节解码，避免 Windows 控制台代码页把中文变成乱码后匹配不上。
const decode = (buffer) => DECODE.decode(buffer ?? Buffer.alloc(0));

test("体检脚本能跑出「修前 / 修后」关键行，兼容会话残留关键字就报错", () => {
  const dataHome = path.join(ROOT, ".tmp", "mcp-compat-check-test-data");
  const sharedHome = path.join(ROOT, ".tmp", "mcp-compat-check-test-shared");
  rmSync(dataHome, { recursive: true, force: true });
  rmSync(sharedHome, { recursive: true, force: true });
  try {
    const run = spawnSync(process.execPath, [path.join(ROOT, "tools", "mcp-compat-check.mjs")], {
      cwd: ROOT,
      encoding: "buffer",
      timeout: 180_000,
      env: {
        ...process.env,
        BRIDGE_DATA_HOME: dataHome,
        BRIDGE_SHARED_DATA_HOME: sharedHome,
      },
    });
    const out = `${decode(run.stdout)}${decode(run.stderr)}`;
    assert.equal(run.status, 0, `体检脚本退出码不是 0：\n${out.slice(-2000)}`);
    assert.match(out, /普通会话（mcp-compat-check）：含 strict 不支持关键字的工具 \d+ 个/, `缺少「修前」关键行：\n${out.slice(0, 2000)}`);
    assert.match(out, /兼容会话（DeepSeek Harness）：含 strict 不支持关键字的工具 0 个（兼容视图生效，修后）/, `缺少「修后」关键行：\n${out.slice(0, 2000)}`);
    assert.match(out, /命中兼容规则并去掉关键字的工具：\d+ → 0/);
    // 两个会话名必须真是「一个不命中、一个命中」，否则上面两行会变成同一份 schema
    assert.equal(isStrictCompatClient("mcp-compat-check"), false);
    assert.equal(isStrictCompatClient("DeepSeek Harness"), true);
  } finally {
    rmSync(dataHome, { recursive: true, force: true });
    rmSync(sharedHome, { recursive: true, force: true });
  }
});
