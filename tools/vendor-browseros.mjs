#!/usr/bin/env node
/**
 * 浠?BrowserOS 浠撳簱鎼繍璇箟蹇収鏍稿績鍒?src/vendor/browseros/锛堝彲閲嶅鎵ц锛夈€? *
 *   node tools/vendor-browseros.mjs [BrowserOS 浠撳簱鐩綍]   榛樿 <本地路径>
 *
 * 鍋氱殑浜嬶細
 *   1. 鐢ㄦ湰浠撳簱鑷甫鐨?typescript 鎶婇€夊畾鐨?.ts 鏂囦欢杞垚 ESM .js锛堝彧鍘荤被鍨嬶紝涓嶆敼閫昏緫锛屼繚鐣欐敞閲婏級锛? *   2. 鐩稿瀵煎叆琛ヤ笂 .js 鍚庣紑锛圢ode 鐨?ESM 瑕佹眰鍐欏叏锛夛紱绾被鍨嬪鍏ュ湪杞瘧鏃惰嚜鐒舵秷澶憋紱
 *   3. 娴嬭瘯鏂囦欢閲岀殑 bun:test 鎹㈡垚鏈粨搴撶殑鍨墖 src/vendor/bun-test-shim.js锛堝湪 node:test 涓婂疄鐜板悓鍚嶆帴鍙ｏ級锛? *   4. 姣忎釜鏂囦欢澶村姞鏉ユ簮銆佹彁浜ゅ彿鍜岃鍙瘉锛圓GPL-3.0锛夛紝骞跺啓 src/vendor/browseros/SOURCE.json 璁颁笅娓呭崟锛? *   5. 鎶婃垜浠嚜宸辩殑鏀瑰姩锛坱ools/vendor-patches/browseros/*.patch锛夐€愭潯鎵撲笂锛涗换浣曚竴鏉℃墦涓嶄笂灏辨姤閿欓€€鍑恒€? *
 * 涓轰粈涔堟槸琛ヤ竵鑰屼笉鏄€屽寘涓€灞傘€嶏細琚敼鐨勯兘鏄浆鎹骇鐗╁唴閮ㄧ殑鎺у埗娴侊紙render 鐨?visit銆乷bserver 鐨勬壂鎻忚皟鐢ㄣ€? * resolve 鐨勪袱灞傛煡鎵撅級锛屽寘涓€灞傚彧鑳芥敼琛屼负銆佹敼涓嶄簡閭ｅ嚑琛屽垽鏂紱鑰岃 vendor 鏂囦欢鍙涓€琛屾敞鍏ヤ篃鍋氫笉鍒? * 鈥斺€?render 閲岀殑銆岃蹇界暐鑺傜偣鐩存帴涓㈡帀銆嶅繀椤诲氨鍦版敼銆傝ˉ涓佺殑浠ｄ环鏄笂娓告敼浜嗗氨鎶ラ敊锛屼絾鎶ラ敊鏄樉寮忕殑锛? * 姣旀倓鎮勮瑕嗙洊瀹夊叏寰楀銆? *
 * 閫昏緫鏀瑰姩涓嶈鐩存帴鏀?vendor 閲岀殑鏂囦欢锛堜笅娆￠噸璺戜細琚鐩栵級锛屾敼 tools/vendor-patches/browseros/ 閲岀殑琛ヤ竵銆? */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { applyPatchDirectory } from "./vendor-patches/apply.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(process.argv[2] || "refs/browseros");
const PKG = path.join(REPO, "packages", "browseros-agent", "packages");
const OUT = path.join(ROOT, "src", "vendor", "browseros");
const UPSTREAM = "https://github.com/browseros-ai/BrowserOS";

/** 鎼摢浜涙枃浠讹細[涓婃父鐩稿 PKG 鐨勮矾寰? 鏈粨搴?OUT 涓嬬殑璺緞] */
const FILES = [
  ...["ax-types", "roles", "refs", "render", "diff"].flatMap((name) => [`browser-core/src/core/snapshot/${name}.ts`]),
  ...["refs", "render", "diff"].map((name) => `browser-core/src/core/snapshot/${name}.test.ts`),
  // cursor-augment 涓嶅啀鎼細鎵弿宸茬敱 src/core/snapshot-cursor.js 鍙栦唬锛堣 observer.js.patch锛夛紝
  // 鐣欑潃瀹冨彧浼氳銆屽埌搴曞摢浠藉湪璺戙€嶅彉寰楀惈绯娿€?  ...["ax-tree", "frames", "resolve", "observer"].map((name) => `browser-core/src/core/observer/${name}.ts`),
  ...["resolve", "observer"].map((name) => `browser-core/src/core/observer/${name}.test.ts`),
  // 璇婚〉闈㈡枃瀛楋細蹇収鍙垪鑳芥搷浣滅殑鍏冪礌锛屾鏂囷紙渚嬪 AI 鐨勫洖绛旓級瑕侀潬瀹冭浆鎴?markdown 璇诲洖鏉?  "browser-core/src/content-markdown.ts",
  "browser-mcp/src/tools/token-estimate.ts",
  "browser-mcp/src/tools/trust-boundary.ts",
].map((rel) => [rel, rel.replace(/^browser-core\/src\//, "").replace(/^browser-mcp\/src\//, "mcp/").replace(/\.ts$/, ".js")]);

const commit = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

function header(rel) {
  return [
    "// SPDX-License-Identifier: AGPL-3.0",
    `// 鏉ユ簮锛欱rowserOS锛?{UPSTREAM}锛夋彁浜?${commit.slice(0, 12)}`,
    `//       packages/browseros-agent/packages/${rel}`,
    "// 鐢?tools/vendor-browseros.mjs 浠?TypeScript 杞垚 JavaScript锛岄€昏緫鏈敼銆備笉瑕佺洿鎺ユ敼杩欎釜鏂囦欢锛岄噸璺戣剼鏈細瑕嗙洊銆?,
    "",
  ].join("\n");
}

/** 鐩稿瀵煎叆琛?.js锛沚un:test 鎹㈡垚鍨墖銆?*/
function fixImports(code, outRel) {
  const shim = path.relative(path.dirname(path.join(OUT, outRel)), path.join(ROOT, "src", "vendor", "bun-test-shim.js")).replace(/\\/g, "/");
  return code
    .replace(/(from\s+["'])(\.{1,2}\/[^"']+?)(["'])/g, (m, a, spec, b) => (/\.(m?js|json)$/.test(spec) ? m : `${a}${spec}.js${b}`))
    .replace(/(import\(\s*["'])(\.{1,2}\/[^"']+?)(["']\s*\))/g, (m, a, spec, b) => (/\.(m?js|json)$/.test(spec) ? m : `${a}${spec}.js${b}`))
    // 鍙负鍓綔鐢ㄧ殑瀵煎叆锛歩mport './polyfill'
    .replace(/(^|\n)(\s*import\s+["'])(\.{1,2}\/[^"']+?)(["'])/g, (m, pre, a, spec, b) => (/\.(m?js|json)$/.test(spec) ? m : `${pre}${a}${spec}.js${b}`))
    .replace(/from\s+["']bun:test["']/g, `from "${shim.startsWith(".") ? shim : "./" + shim}"`);
}

rmSync(OUT, { recursive: true, force: true });
const manifest = [];
for (const [rel, outRel] of FILES) {
  const source = readFileSync(path.join(PKG, rel), "utf8");
  const { outputText, diagnostics } = ts.transpileModule(source, {
    fileName: path.basename(rel),
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
  if (diagnostics?.length) throw new Error(`${rel} 杞瘧鎶ラ敊锛?{diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("; ")}`);
  const target = path.join(OUT, outRel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, header(rel) + fixImports(outputText, outRel));
  manifest.push({ upstream: `packages/browseros-agent/packages/${rel}`, local: `src/vendor/browseros/${outRel.replace(/\\/g, "/")}` });
}

// 鎴戜滑鐨勬敼鍔細杞畬鍐嶆墦琛ヤ竵銆傛墦涓嶄笂灏辨姏閿欙紝鑴氭湰浠ラ潪 0 閫€鍑猴紝缁濅笉鐣欎笅鍗婃垚鍝併€?const PATCHES = path.join(ROOT, "tools", "vendor-patches", "browseros");
const applied = applyPatchDirectory(PATCHES, OUT, { log: (line) => console.log(line) });

writeFileSync(path.join(OUT, "SOURCE.json"), JSON.stringify({
  upstream: UPSTREAM,
  commit,
  license: "AGPL-3.0",
  note: "涓婃父 README 鍙啓 AGPL-3.0锛坧ackage.json 鍐?or-later锛夛紝鎸?AGPL-3.0 鏍囨敞銆傛湰浠撳簱鏁翠綋鏄?AGPL-3.0-or-later锛屼袱鑰呭吋瀹广€?,
  patched: "tools/vendor-patches/browseros/*.patch 鐢辨湰鑴氭湰鍦ㄨ浆鎹㈠悗鑷姩鎵撲笂锛涙敼琛屼负璇锋敼琛ヤ竵锛屼笉瑕佹敼 vendor 鏂囦欢銆?,
  patches: applied,
  vendoredAt: new Date().toISOString().slice(0, 10),
  files: manifest,
}, null, 2) + "\n");

console.log(`宸叉惉 ${manifest.length} 涓枃浠?鈫?${path.relative(ROOT, OUT)}锛圔rowserOS ${commit.slice(0, 12)}锛夛紝琛ヤ竵 ${applied.length} 澶勬敼鍔╜);
