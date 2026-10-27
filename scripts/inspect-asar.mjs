#!/usr/bin/env node
/**
 * 检查打进包里的文件对不对（关键文件在不在、测试脚本有没有漏进去）。
 *
 * 两种输入都支持：
 *   - app.asar 文件（asar: true 时）
 *   - 解包后的应用目录（asar: false 时，也就是当前配置：dist/win-unpacked/resources/app）
 *
 * asar 头部布局（容易踩的坑）：
 *   [0..4)  u32 = 4                        pickle 里放的是「一个 u32」
 *   [4..8)  u32 = 整个 header pickle 的字节数
 *   [8..12) u32 = 下面 JSON 字符串的字节数
 *   [12..)  JSON（实际字符串起点 12，长度 = u32@8）
 * 所以 JSON 起点是 12，不是 8 —— 直接按 u32@4 的长度从 8 开始读会多读 4 字节，
 * JSON.parse 必炸（tools/asar-peek.mjs 就是这么挂的，这里用 indexOf 兜底更稳）。
 *
 * 用法：
 *   node scripts/inspect-asar.mjs                                    # 默认看 dist/win-unpacked/resources/app
 *   node scripts/inspect-asar.mjs <app.asar 或 app 目录> check
 *   node scripts/inspect-asar.mjs <app.asar 或 app 目录> list [前缀]
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TARGET = path.resolve(HERE, "..", "dist", "win-unpacked", "resources", "app");

const [, , targetArg = DEFAULT_TARGET, command = "check", prefix = ""] = process.argv;

/** 目录输入：直接递归列文件。 */
function walkDir(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full, base, out);
    else out.push({ path: "/" + path.relative(base, full).split(path.sep).join("/"), size: statSync(full).size });
  }
  return out;
}

/** asar 输入：解析 header 再列文件。 */
function walkAsar(asarPath) {
  const buf = readFileSync(asarPath);
  const readHeader = () => {
    const declared = buf.readUInt32LE(8);
    try {
      return JSON.parse(buf.subarray(12, 12 + declared).toString("utf8"));
    } catch {
      const at = buf.indexOf('{"files"');
      if (at < 0) throw new Error("找不到 asar header JSON");
      const length = buf.readUInt32LE(at - 4);
      return JSON.parse(buf.subarray(at, at + length).toString("utf8"));
    }
  };
  const header = readHeader();
  const walk = (node, p = "") =>
    Object.entries(node.files ?? {}).flatMap(([name, value]) =>
      value.files ? walk(value, `${p}/${name}`) : [{ path: `${p}/${name}`, size: value.size ?? 0 }],
    );
  return { files: walk(header), header };
}

const isDir = statSync(targetArg).isDirectory();
const { files, header } = isDir ? { files: walkDir(targetArg), header: null } : walkAsar(targetArg);

if (command === "list") {
  const hits = files.filter((f) => f.path.startsWith(prefix));
  console.log(`# ${targetArg}（${files.length} 个文件，显示 ${hits.length} 个）`);
  for (const f of hits) console.log(`${String(f.size).padStart(9)}  ${f.path}`);
} else {
  // check：关键文件必须在，测试/文档类必须不在
  const mustHave = [
    "/package.json",
    "/electron/main.cjs",
    "/electron/preload.cjs",
    "/electron/index.html",
    "/electron/ui/app.css",
    "/electron/ui/app.js",
    "/src/package.json", // 缺了它 src 里的 .js 会被当成 CJS，动态 import 直接崩
    "/src/standalone.js",
    "/src/core/bridge.js",
    "/src/core/registry.js",
    "/src/core/lsp.js",
    "/src/tools/toolset.js",
    "/node_modules/@modelcontextprotocol/sdk/package.json",
    "/node_modules/zod/package.json",
  ];
  // 只看顶层目录：src/tools/ 是正常代码，不能跟仓库根目录的 tools/ 混淆
  const forbiddenTop = /^\/(_probe|_smoke|docs|tools|scripts|build|dist)\//;
  const forbiddenAny = /(\.old-esm$|-selftest\.mjs$|-demo\.mjs$|\/probe\.mjs$|\/README\.md$|\/electron-builder\.yml$|\/package-lock\.json$)/;

  const present = new Set(files.map((f) => f.path));
  let bad = 0;
  console.log(`目标: ${targetArg}（${isDir ? "解包目录" : "asar"}）`);
  console.log(`文件总数: ${files.length}${header ? `，node_modules 顶层包: ${Object.keys(header.files.node_modules?.files ?? {}).length}` : ""}`);
  for (const k of mustHave) {
    const ok = present.has(k);
    if (!ok) bad += 1;
    console.log(`${ok ? "OK  " : "MISS"} ${k}`);
  }
  const leaked = files.filter((f) => forbiddenTop.test(f.path) || forbiddenAny.test(f.path));
  console.log(leaked.length ? `FAIL 不该进包的文件: ${leaked.map((f) => f.path).join(", ")}` : "OK   探针/文档/脚本/自测/demo/说明文件都没有进包");
  if (leaked.length) bad += 1;
  process.exit(bad ? 1 : 0);
}
