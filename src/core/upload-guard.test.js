/**
 * 上传路径守卫：只许传用户授权过的工作区目录里的文件（纯 Node，真临时目录 + 软链）。
 *   node --test src/core/upload-guard.test.js
 *
 * 覆盖：
 *   ① 工作区里的普通文件：通过，返回真实路径；
 *   ② 工作区之外的绝对路径：PATH_DENIED（并且不泄露「这个文件存不存在」）；
 *   ③ 相对路径 / 网址：PATH_DENIED；
 *   ④ .. 穿越：解析后越界，PATH_DENIED；
 *   ⑤ 软链指向工作区之外：PATH_DENIED（真实路径判定）；
 *   ⑥ 不存在 / 是目录：NOT_FOUND / INVALID_ARGUMENT；
 *   ⑦ 没有授权目录 / 授权目录都不存在：PATH_DENIED；
 *   ⑧ 数量上限：超过 MAX_UPLOAD_FILES 报 INVALID_ARGUMENT。
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { MAX_UPLOAD_FILES, checkUploadPaths, normalizeRoots } from "./upload-guard.js";

const ROOT = mkdtempSync(path.join(os.tmpdir(), "windrise-upload-guard-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const WORKSPACE = path.join(ROOT, "workspace");
const OUTSIDE = path.join(ROOT, "outside");
mkdirSync(WORKSPACE, { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });
const INSIDE_FILE = path.join(WORKSPACE, "report.txt");
writeFileSync(INSIDE_FILE, "hello");
const OUTSIDE_FILE = path.join(OUTSIDE, "secret.txt");
writeFileSync(OUTSIDE_FILE, "secret");
const SUB_DIR = path.join(WORKSPACE, "sub");
mkdirSync(SUB_DIR, { recursive: true });
const NESTED_FILE = path.join(SUB_DIR, "nested.txt");
writeFileSync(NESTED_FILE, "nested");

/** 跑一次并拿错误（成功时返回 null）。 */
async function failure(files, roots) {
  return checkUploadPaths(files, roots).then(() => null, (error) => error);
}

test("工作区里的普通文件：通过，返回真实路径", async () => {
  const resolved = await checkUploadPaths([INSIDE_FILE], [WORKSPACE]);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0], INSIDE_FILE);
});

test("子目录里的文件也算在工作区里", async () => {
  const resolved = await checkUploadPaths(NESTED_FILE, [WORKSPACE]);
  assert.deepEqual(resolved, [NESTED_FILE]);
});

test("工作区之外的绝对路径：PATH_DENIED，且不提「文件存在」", async () => {
  const error = await failure([OUTSIDE_FILE], [WORKSPACE]);
  assert.equal(error?.code, "PATH_DENIED");
  assert.match(error.message, /不在授权的工作区目录里/);
  assert.ok(!/不存在/.test(error.message), "越界时不该泄露文件存不存在");
});

test("相对路径：PATH_DENIED（不猜相对于谁）", async () => {
  const error = await failure(["report.txt"], [WORKSPACE]);
  assert.equal(error?.code, "PATH_DENIED");
  assert.match(error.message, /绝对路径/);
});

test("网址：PATH_DENIED（只收本机文件）", async () => {
  const error = await failure(["https://example.test/a.txt"], [WORKSPACE]);
  assert.equal(error?.code, "PATH_DENIED");
});

test(".. 穿越：解析后越界，PATH_DENIED", async () => {
  const sneaky = path.join(WORKSPACE, "..", "outside", "secret.txt");
  const error = await failure([sneaky], [WORKSPACE]);
  assert.equal(error?.code, "PATH_DENIED");
});

test("软链指向工作区之外：PATH_DENIED（按真实路径判）", async () => {
  const link = path.join(WORKSPACE, "link-to-secret.txt");
  try {
    symlinkSync(OUTSIDE_FILE, link, "file");
  } catch {
    return; // 没权限建软链（Windows 非管理员）：跳过这一条
  }
  const error = await failure([link], [WORKSPACE]);
  assert.equal(error?.code, "PATH_DENIED");
  assert.match(error.message, /软链/);
});

test("文件不存在：NOT_FOUND", async () => {
  const error = await failure([path.join(WORKSPACE, "nope.txt")], [WORKSPACE]);
  assert.equal(error?.code, "NOT_FOUND");
});

test("目录不是文件：INVALID_ARGUMENT", async () => {
  const error = await failure([SUB_DIR], [WORKSPACE]);
  assert.equal(error?.code, "INVALID_ARGUMENT");
  assert.match(error.message, /普通文件/);
});

test("没有授权目录：PATH_DENIED（不能因为没配置就放开）", async () => {
  const error = await failure([INSIDE_FILE], []);
  assert.equal(error?.code, "PATH_DENIED");
  assert.match(error.message, /还没有授权/);
});

test("授权目录都不存在：PATH_DENIED", async () => {
  const error = await failure([INSIDE_FILE], [path.join(ROOT, "ghost")]);
  assert.equal(error?.code, "PATH_DENIED");
  assert.match(error.message, /都不存在/);
});

test("多个授权目录：任意一个包含就行", async () => {
  const resolved = await checkUploadPaths([INSIDE_FILE, OUTSIDE_FILE], [WORKSPACE, OUTSIDE]);
  assert.deepEqual(resolved, [INSIDE_FILE, OUTSIDE_FILE]);
});

test("一次给了空清单：INVALID_ARGUMENT", async () => {
  const error = await failure([], [WORKSPACE]);
  assert.equal(error?.code, "INVALID_ARGUMENT");
  assert.match(error.message, /files/);
});

test(`数量上限：超过 ${MAX_UPLOAD_FILES} 个报 INVALID_ARGUMENT`, async () => {
  const many = Array.from({ length: MAX_UPLOAD_FILES + 1 }, (_, index) => path.join(WORKSPACE, `f${index}.txt`));
  const error = await failure(many, [WORKSPACE]);
  assert.equal(error?.code, "INVALID_ARGUMENT");
  assert.match(error.message, new RegExp(String(MAX_UPLOAD_FILES)));
});

test("normalizeRoots：去空、去重、解析绝对路径", () => {
  const roots = normalizeRoots([" " + WORKSPACE + " ", WORKSPACE, "", null]);
  assert.deepEqual(roots, [path.resolve(WORKSPACE)]);
});
