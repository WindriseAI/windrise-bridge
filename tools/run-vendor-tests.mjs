#!/usr/bin/env node
/**
 * 跑 src/vendor 下搬来的上游单元测试（node:test + bun:test 垫片），输出「通过 N/N」给 run-all-checks 判定。
 *
 *   node tools/run-vendor-tests.mjs
 */

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(ROOT, "src", "vendor");

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name.endsWith(".test.js")) files.push(full);
  }
};
walk(VENDOR);

// 一个测试文件都没找到时不能直接跑 `node --test`：不带参数它会在整个仓库里自己找测试
if (!files.length) {
  console.log("搬来的上游测试：一个测试文件都没找到（src/vendor 下没有 *.test.js），失败 1 个");
  process.exit(1);
}

const run = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...files], { cwd: ROOT, encoding: "utf8" });
const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
const count = (label) => Number(out.match(new RegExp(`ℹ ${label} (\\d+)`))?.[1] ?? 0);
const tests = count("tests");
const pass = count("pass");
const fail = count("fail");
// 读不出测试数（输出格式变了）也算失败，不能因为「0/0」就判通过
const broken = fail > 0 || run.status !== 0 || tests === 0 || pass !== tests;
if (broken) console.log(out.split("\n").filter((line) => /✖|Error|expected|期望/.test(line)).slice(0, 40).join("\n"));
console.log(`搬来的上游测试：${files.length} 个文件`);
console.log(`通过 ${pass}/${tests}${broken ? `，失败 ${Math.max(fail, 1)} 个${tests === 0 ? "（没读到测试数）" : ""}` : ""}`);
process.exit(broken ? 1 : 0);
