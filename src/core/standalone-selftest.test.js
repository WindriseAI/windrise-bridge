/**
 * 自检进程的回归测试。
 *   node --test src/core/standalone-selftest.test.js
 *
 * 以前 src/standalone.js 的自检结尾是「睡 50ms + process.exit(0)」，把 SSE 响应的句柄
 * 还没收干净就硬退出，慢机器上会撞 libuv 断言（退出码非 0）。这条测试真的起一个子进程
 * 跑 `--self-test`：必须在超时内以退出码 0 退出，并且协议握手真的成功。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TIMEOUT_MS = 15000;

test("standalone --self-test 在超时内以退出码 0 退出", { timeout: 25000 }, async () => {
  // 数据目录必须放在临时目录里，不能碰用户目录下的真实 Bridge 数据
  const home = mkdtempSync(path.join(os.tmpdir(), "standalone-selftest-"));
  try {
    const child = spawn(process.execPath, [path.join(ROOT, "src", "standalone.js"), "--self-test"], {
      cwd: ROOT,
      env: { ...process.env, BRIDGE_DATA_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve({ timedOut: true, code: null });
      }, TIMEOUT_MS);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ timedOut: false, code });
      });
    });
    assert.equal(result.timedOut, false, `自检 ${TIMEOUT_MS}ms 内没退出（进程被强杀）`);
    assert.equal(result.code, 0, `自检退出码应为 0，实际 ${result.code}；输出：\n${output.slice(-2000)}`);
    assert.match(output, /自检结果/, output.slice(-2000));
    assert.match(output, /协议版本\s*:\s*2025-06-18/, output.slice(-2000));
    assert.match(output, /错误令牌被拒\s*:\s*HTTP 404/, output.slice(-2000));
  } finally {
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 清理失败无所谓 */ }
  }
});