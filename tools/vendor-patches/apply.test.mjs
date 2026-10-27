/**
 * vendor 补丁机制的单元测试（纯 Node）：
 *   node --test tools/vendor-patches/apply.test.mjs
 *
 * 覆盖：
 *   ① 补丁能把「上游转换结果」还原成我们改过的文件（逐字节相同）；
 *   ② 上游那几行变了 → 明确报错，不会模糊匹配改坏别处；
 *   ③ 上下文在文件里出现多次 → 报错（位置不确定比打不上更危险）；
 *   ④ 补丁指向不存在的文件 → 报错；
 *   ⑤ 补丁文件为空 → 报错；
 *   ⑥ CRLF 检出（含末尾无换行）：打上再打回必须逐字节相同，且在 Linux / CI 上也真的跑到这条分支。
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { applyFilePatch, applyPatchDirectory, parsePatch, reverseFilePatch } from "./apply.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PATCH_DIR = path.join(ROOT, "tools", "vendor-patches", "browseros");
const VENDOR = path.join(ROOT, "src", "vendor", "browseros");

/** 从仓库里的补丁反推出「上游原样」：把补丁反过来打 */
function upstreamFromPatch(file, patchedText) {
  return applyFilePatch(patchedText, reverseFilePatch(file), file.newPath);
}

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "windrise-vendor-patch-"));
}

test("每个补丁都能把上游原样还原成仓库里的文件", () => {
  const names = ["render.js.patch", "observer.js.patch", "resolve.js.patch"];
  for (const name of names) {
    const files = parsePatch(readFileSync(path.join(PATCH_DIR, name), "utf8"));
    assert.equal(files.length, 1, `${name} 应该只改一个文件`);
    const file = files[0];
    const patchedPath = path.join(ROOT, file.newPath);
    const patched = readFileSync(patchedPath, "utf8");
    const upstream = upstreamFromPatch(file, patched);
    const rePatched = applyFilePatch(upstream, file, name);
    assert.equal(rePatched, patched, `${name} 打回原样后必须逐字节相同`);
  }
});

test("applyPatchDirectory 在临时目录里跑完整流程", () => {
  const dir = tempDir();
  try {
    const out = path.join(dir, "src", "vendor", "browseros");
    for (const name of ["render.js.patch", "observer.js.patch", "resolve.js.patch"]) {
      const file = parsePatch(readFileSync(path.join(PATCH_DIR, name), "utf8"))[0];
      const patched = readFileSync(path.join(ROOT, file.newPath), "utf8");
      const upstream = upstreamFromPatch(file, patched);
      const target = path.join(out, file.newPath.replace(/^src\/vendor\/browseros\//, ""));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, upstream);
    }
    const applied = applyPatchDirectory(PATCH_DIR, out);
    assert.equal(applied.length, 3);
    for (const file of ["core/snapshot/render.js", "core/observer/observer.js", "core/observer/resolve.js"]) {
      assert.equal(readFileSync(path.join(out, file), "utf8"), readFileSync(path.join(VENDOR, file), "utf8"), file);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("同一补丁分别打在 LF / CRLF 源上，输出行尾跟输入一致", () => {
  const file = {
    newPath: "x.js",
    hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ["-b", "+B"] }],
  };
  assert.equal(applyFilePatch("a\nb\nc\n", file, "x.js"), "a\nB\nc\n");
  assert.equal(applyFilePatch("a\r\nb\r\nc\r\n", file, "x.js"), "a\r\nB\r\nc\r\n");
});

test("混合行尾：只动被替换的行，其他行原样保留，不整文件改写", () => {
  const file = {
    newPath: "x.js",
    hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ["-b", "+B"] }],
  };
  const source = "a\r\nb\nc\n";
  assert.equal(applyFilePatch(source, file, "x.js"), "a\r\nB\nc\n");
});

test("\\ No newline at end of file：按补丁去掉 / 补上文件末尾换行", () => {
  const removeEol = parsePatch([
    "--- a/x.js",
    "+++ b/x.js",
    "@@ -1,2 +1,2 @@",
    " a",
    "-b",
    "+B",
    "\\ No newline at end of file",
    "",
  ].join("\n"))[0];
  assert.equal(removeEol.hunks[0].newNoEol, true);
  assert.equal(applyFilePatch("a\nb\n", removeEol, "x.js"), "a\nB", "旧文件有尾换行 → 新文件没有");

  const addEol = parsePatch([
    "--- a/x.js",
    "+++ b/x.js",
    "@@ -1,2 +1,2 @@",
    " a",
    "-b",
    "\\ No newline at end of file",
    "+B",
    "",
  ].join("\n"))[0];
  assert.equal(addEol.hunks[0].oldNoEol, true);
  // 旧文件末尾没有换行、补丁也没给「新文件有换行」的标记时，保持源文件原样（不能凭空补一个 \n）
  assert.equal(applyFilePatch("a\nb", addEol, "x.js"), "a\nB", "旧文件没有尾换行 → 新文件也保持没有");

  // 反过来的补丁也应该带着标记：原补丁只声明「新文件没尾换行」，反向后只知道「旧文件没尾换行」，
  // 新文件该不该有换行没有信息，所以保持现状（不凭空补 \n）
  assert.equal(applyFilePatch("a\nB", reverseFilePatch(removeEol), "x.js"), "a\nb");
});

test("补丁没写 \\ No newline 时不动文件末尾的换行（相对上一版的行为）", () => {
  const noMark = parsePatch([
    "--- a/x.js",
    "+++ b/x.js",
    "@@ -1,2 +1,2 @@",
    " a",
    "-b",
    "+B",
    "",
  ].join("\n"))[0];
  assert.equal(noMark.hunks[0].newNoEol, false);
  assert.equal(applyFilePatch("a\nb", noMark, "x.js"), "a\nB", "源文件末尾没换行 → 不能补");
  assert.equal(applyFilePatch("a\nb\n", noMark, "x.js"), "a\nB\n", "源文件末尾有换行 → 保留");
});

test("零旧行 hunk（@@ -X,0）插在第 X 行之后，不是第 X-1 行之后", () => {
  const zero = parsePatch([
    "--- a/x.js",
    "+++ b/x.js",
    "@@ -5,0 +6,1 @@",
    "+new",
    "",
  ].join("\n"))[0];
  assert.equal(zero.hunks[0].oldLines, 0);
  assert.equal(
    applyFilePatch("l1\nl2\nl3\nl4\nl5\nl6\n", zero, "x.js"),
    "l1\nl2\nl3\nl4\nl5\nnew\nl6\n",
    "new 必须落在 l5 之后",
  );
});

test("零旧行 hunk 落在没有尾换行的文件末尾：先补行尾再插，不能把两行拼在一起", () => {
  const zero = parsePatch([
    "--- a/x.js",
    "+++ b/x.js",
    "@@ -2,0 +3,1 @@",
    "+new",
    "",
  ].join("\n"))[0];
  assert.equal(applyFilePatch("l1\nl2", zero, "x.js"), "l1\nl2\nnew\n", "源文件末尾没换行也要先补上再插");
  assert.equal(applyFilePatch("l1\nl2\n", zero, "x.js"), "l1\nl2\nnew\n", "有尾换行时结果一致");

  const beyond = parsePatch([
    "--- a/x.js",
    "+++ b/x.js",
    "@@ -4,0 +5,1 @@",
    "+new",
    "",
  ].join("\n"))[0];
  assert.equal(applyFilePatch("a\nb\nc", beyond, "x.js"), "a\nb\nc\nnew\n", "越过末尾的插入点收回到文件末尾");
});

test("上游那几行变了就报错，不猜位置", () => {
  const file = parsePatch(readFileSync(path.join(PATCH_DIR, "observer.js.patch"), "utf8"))[0];
  const patched = readFileSync(path.join(ROOT, file.newPath), "utf8");
  // 改动要落在某个 hunk 的上下文行上（hunk 之外的整行替换本来就不影响补丁，测不出问题）
  const upstream = upstreamFromPatch(file, patched).replace(
    "const nodes = await fetchAxTree(session, axParams);",
    "const nodes = await readAxTree(session, axParams);",
  );
  assert.throws(() => applyFilePatch(upstream, file, "observer.js.patch"), /补丁打不上/);
});

test("上下文出现多次时报错（位置不确定）", () => {
  const file = {
    newPath: "x.js",
    hunks: [{
      oldStart: 2, oldLines: 2, newStart: 2, newLines: 3,
      lines: [" same();", "-old();", "+new();", " next();"],
    }],
  };
  const source = "same();\nold();\nnext();\nsame();\nold();\nnext();\n";
  assert.throws(() => applyFilePatch(source, file, "x.js"), /出现 2 次/);
});

test("补丁指向不存在的文件时报错", () => {
  const dir = tempDir();
  try {
    mkdirSync(path.join(dir, "patches"));
    writeFileSync(path.join(dir, "patches", "a.patch"), [
      "--- a/src/vendor/browseros/core/nope.js",
      "+++ b/src/vendor/browseros/core/nope.js",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
      "",
    ].join("\n"));
    assert.throws(() => applyPatchDirectory(path.join(dir, "patches"), path.join(dir, "out")), /文件不存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("空补丁文件报错", () => {
  const dir = tempDir();
  try {
    mkdirSync(path.join(dir, "patches"));
    writeFileSync(path.join(dir, "patches", "empty.patch"), "\n");
    assert.throws(() => applyPatchDirectory(path.join(dir, "patches"), path.join(dir, "out")), /没有任何文件改动/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * ⑥ CRLF 检出：不依赖仓库文件的真实换行，纯内存跑一遍
 * ------------------------------------------------------------------ */

const CRLF_PATCH = {
  oldPath: "a/src/vendor/browseros/core/eol.js",
  newPath: "b/src/vendor/browseros/core/eol.js",
  hunks: [{
    oldStart: 2, oldLines: 3, newStart: 2, newLines: 4,
    lines: [" 第二行", "-旧逻辑();", "+新逻辑();", "+额外一行();", " 第四行"],
  }],
};

test("CRLF 文件打上补丁再打回，逐字节还原（含末尾无换行）", () => {
  // 末尾有换行 / 末尾无换行两种：Windows 检出的文件两种都常见
  const upstreamTexts = [
    "第一行\r\n第二行\r\n旧逻辑();\r\n第四行\r\n第五行\r\n",
    "第一行\r\n第二行\r\n旧逻辑();\r\n第四行\r\n第五行",
  ];
  for (const upstream of upstreamTexts) {
    const patched = applyFilePatch(upstream, CRLF_PATCH, "eol.js");
    // 补丁应用后必须真的改到了目标行，且整文件仍是 CRLF（不能混进裸 LF）
    assert.equal(patched.includes("新逻辑();"), true);
    assert.equal(patched.includes("额外一行();"), true);
    assert.equal(patched.includes("旧逻辑();"), false);
    assert.equal(patched.replace(/\r\n/g, "").includes("\n"), false, "不应混进裸 LF");
    assert.equal(patched.endsWith("\r\n"), upstream.endsWith("\r\n"), "末尾换行要和原来一致");

    const restored = applyFilePatch(patched, reverseFilePatch(CRLF_PATCH), "eol.js");
    assert.equal(restored, upstream, "CRLF 文件打回后必须逐字节相同");
  }
});

test("LF 文件仍然逐字节还原（没被 CRLF 逻辑带偏）", () => {
  const upstream = "第一行\n第二行\n旧逻辑();\n第四行\n第五行\n";
  const patched = applyFilePatch(upstream, CRLF_PATCH, "eol.js");
  assert.equal(patched.includes("\r"), false);
  assert.equal(applyFilePatch(patched, reverseFilePatch(CRLF_PATCH), "eol.js"), upstream);
});
