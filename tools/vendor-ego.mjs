#!/usr/bin/env node
/**
 * 从 ego-lite 仓库搬运页面动作核心到 src/vendor/ego-lite/（可重复执行）。
 *
 *   node tools/vendor-ego.mjs --commit <40 位十六进制提交号> [--src <ego-lite 仓库>] [--out <输出目录>] [--ts <typescript.js>]
 *
 * 做的事：
 *   1. 用 typescript 把选定的 .ts 文件转成 ESM .js（只去类型，不改逻辑，保留注释）；
 *   2. 把 cdp-eval / element-resolver / browser-runtime / state / element-ops / waits
 *      这些上游内部模块的导入统一指向手写的 ego-shims.js；
 *   3. 测试文件里指向 dist/ 的导入改成本仓库搬进来的文件；
 *   4. 每个文件头加来源、提交号和 MIT 许可证，并写 SOURCE.json 记下清单；
 *   5. 检查产物里没有切前台或自己开页面的 CDP 调用。
 *
 * ego-shims.js 是手写垫片，不属于搬运内容：脚本只往它旁边写文件，绝不创建或覆盖它。
 * 逻辑改动不要直接改 vendor 里的文件（下次重跑会被覆盖），改 ego-shims.js 或适配层。
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM = "https://github.com/citrolabs/ego-lite";
const SHIM = "ego-shims.js";
const DEFAULT_SRC = "D:/work/refs/ego-lite";
const COMMIT_RE = /^[0-9a-f]{40}$/i;

/** 上游这些内部模块不在搬运清单里，统一改指向手写垫片。 */
const SHIM_SOURCES = new Set([
  "../cdp-eval.js",
  "../element-resolver.js",
  "../browser-runtime.js",
  "../state.js",
  "./element-ops.js",
  "./waits.js",
]);

/** 我们不允许切前台，也不允许自己开页面。 */
const FORBIDDEN_CALLS = ["Target.activateTarget", "Page.bringToFront", "Target.createTarget"];

/** 搬哪些文件：[上游相对仓库根的路径, OUT 下的路径]。 */
const FILES = [
  ["package/ego-browser/src/driver/page-actions.ts", "driver/page-actions.js"],
  ["package/ego-browser/src/driver/action-target.ts", "driver/action-target.js"],
  ["package/ego-browser/src/driver/scroll-motion.ts", "driver/scroll-motion.js"],
  ["package/ego-browser/src/driver/keyboard.ts", "driver/keyboard.js"],
  ["package/ego-browser/src/ref-map.ts", "ref-map.js"],
  ["package/ego-browser/src/driver/action-target.test.mjs", "driver/action-target.test.js"],
  ["package/ego-browser/src/driver/scroll-motion.test.mjs", "driver/scroll-motion.test.js"],
  ["package/ego-browser/src/ref-map.test.mjs", "ref-map.test.js"],
];

const OUTPUTS = new Set(FILES.map(([, outRel]) => outRel));

/** 测试里的 dist/src/... 导入按这个表找回搬进来的文件。 */
const DIST_OUTPUTS = new Map(
  FILES.filter(([rel]) => rel.endsWith(".ts")).map(([rel, outRel]) => [
    rel.replace(/^package\/ego-browser\/src\//, "").replace(/\.ts$/, ".js"),
    outRel,
  ]),
);

/** 匹配 from "x"、import "x" 和 import("x")，只取路径本身。 */
const SPECIFIER_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"'\r\n]+)\2/g;

function header(rel, commit, date) {
  return [
    "// SPDX-License-Identifier: MIT",
    "// Portions derived from citrolabs/ego-lite (MIT),",
    `//   file: ${rel}`,
    `//   commit: ${commit}`,
    "// Copyright (c) 2026 CitroLabs",
    `// Modified for Windrise Bridge: imports routed to ego-shims.js (CDP via webContents.debugger). ${date}.`,
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    src: DEFAULT_SRC,
    out: path.join(ROOT, "src", "vendor", "ego-lite"),
    commit: "",
    ts: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!["--src", "--out", "--commit", "--ts"].includes(flag)) {
      throw new Error(`未知参数：${flag}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} 缺少值`);
    }
    args[flag.slice(2)] = value;
    i += 1;
  }
  if (!COMMIT_RE.test(args.commit)) {
    throw new Error("--commit 必须是 40 位十六进制提交号");
  }
  return args;
}

/** 默认从仓库安装的 typescript 加载；--ts 则用 createRequire 按路径加载。 */
async function loadTypeScript(tsPath) {
  const require = createRequire(import.meta.url);
  try {
    const loaded = tsPath ? require(path.resolve(tsPath)) : await import("typescript");
    return loaded.default ?? loaded;
  } catch {
    throw new Error("加载 typescript 失败：请安装 typescript，或用 --ts <typescript.js> 指定");
  }
}

function toPosix(value) {
  return value.replace(/\\/g, "/");
}

/** 从 fromOutRel 指向 toOutRel 的 ESM 相对路径。 */
function relativeImport(fromOutRel, toOutRel) {
  const rel = path.posix.relative(path.posix.dirname(fromOutRel), toOutRel);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** 改写模块路径；rewrite 返回原值时原样保留整条 import。 */
function rewriteSpecifiers(code, rewrite) {
  return code.replace(SPECIFIER_RE, (match, lead, quote, spec) => {
    const next = rewrite(spec);
    return next === spec ? match : `${lead}${quote}${next}${quote}`;
  });
}

function scanSpecifiers(code) {
  const re = new RegExp(SPECIFIER_RE.source, "g");
  return Array.from(code.matchAll(re), (match) => match[3]);
}

/** 改写后仍有相对导入指向清单外文件时直接报错。 */
function assertKnownImports(code, outRel) {
  for (const spec of scanSpecifiers(code)) {
    if (!spec.startsWith(".")) continue;
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(outRel), spec),
    );
    if (resolved === SHIM || OUTPUTS.has(resolved)) continue;
    throw new Error(`${outRel} 的 import "${spec}" 指向清单外的文件`);
  }
}

function transpile(ts, source, fileName) {
  const { outputText, diagnostics } = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
      isolatedModules: true,
      removeComments: false,
      useDefineForClassFields: true,
    },
  });
  if (diagnostics?.length) {
    throw new Error(
      `${fileName} 转译报错：${diagnostics
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
        .join("; ")}`,
    );
  }
  return outputText;
}

/** 运行当天的本地日期，避免 UTC 把凌晨算成前一天。 */
function today() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function countLines(text) {
  const lines = text.split(/\r?\n/);
  return text.endsWith("\n") ? lines.length - 1 : lines.length;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const SRC = path.resolve(args.src);
  const OUT = path.resolve(args.out);
  const commit = args.commit;
  const date = today();
  const ts = await loadTypeScript(args.ts);
  const manifest = [];
  const lineCounts = [];

  /** 只写清单里的文件；垫片碰都不碰。 */
  function writeManaged(sourceRel, outRel, content, buffer) {
    if (outRel === SHIM) {
      throw new Error(`${SHIM} 是手写垫片，脚本不能创建或覆盖它`);
    }
    const target = path.join(OUT, outRel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    manifest.push({ upstream: sourceRel, local: outRel, sha256: sha256(buffer) });
  }

  // 注意：这里不 rm -rf OUT。OUT 里有手写的 ego-shims.js，删目录会把它一起删掉。
  mkdirSync(OUT, { recursive: true });

  for (const [sourceRel, outRel] of FILES) {
    const sourceFile = path.join(SRC, sourceRel);
    let buffer;
    try {
      buffer = readFileSync(sourceFile);
    } catch {
      throw new Error(`读不到源文件：${sourceFile}`);
    }
    const source = buffer.toString("utf8");
    let code;
    if (sourceRel.endsWith(".ts")) {
      code = transpile(ts, source, path.basename(sourceRel));
      code = rewriteSpecifiers(code, (spec) =>
        SHIM_SOURCES.has(spec) ? relativeImport(outRel, SHIM) : spec,
      );
    } else {
      // 测试是现成的 .mjs，只把 dist/ 路径换成搬进来的文件。
      code = rewriteSpecifiers(source, (spec) => {
        const marker = "dist/src/";
        const at = spec.indexOf(marker);
        if (at < 0) return spec;
        const target = DIST_OUTPUTS.get(spec.slice(at + marker.length));
        if (!target) {
          throw new Error(`${outRel} 的 import "${spec}" 找不到对应的搬运文件`);
        }
        return relativeImport(outRel, target);
      });
    }
    assertKnownImports(code, outRel);
    const content = header(sourceRel, commit, date) + code;
    for (const call of FORBIDDEN_CALLS) {
      if (content.includes(call)) {
        throw new Error(`${outRel} 含有禁用调用 ${call}`);
      }
    }
    writeManaged(sourceRel, outRel, content, buffer);
    lineCounts.push([outRel, countLines(content)]);
  }

  // LICENSE 原样复制，不加文件头。
  const licenseFile = path.join(SRC, "LICENSE");
  let license;
  try {
    license = readFileSync(licenseFile);
  } catch {
    throw new Error(`读不到 LICENSE：${licenseFile}`);
  }
  writeManaged("LICENSE", "LICENSE", license, license);
  lineCounts.push(["LICENSE", countLines(license.toString("utf8"))]);

  writeFileSync(
    path.join(OUT, "SOURCE.json"),
    JSON.stringify(
      {
        upstream: UPSTREAM,
        commit,
        license: "MIT",
        note: "ego-shims.js 是手写适配层（CDP 走 webContents.debugger），不由本脚本生成或覆盖。",
        vendoredAt: date,
        files: manifest.map(({ upstream, local, sha256 }) => ({ upstream, local, sha256 })),
      },
      null,
      2,
    ) + "\n",
  );

  console.log(
    `已搬 ${FILES.length} 个 .js 文件 + LICENSE → ${toPosix(path.relative(ROOT, OUT)) || OUT}（ego-lite ${commit.slice(0, 12)}）`,
  );
  for (const [rel, lines] of lineCounts) {
    console.log(`  ${rel}  ${lines} 行`);
  }
}

main().catch((error) => {
  console.error(`vendor-ego: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
