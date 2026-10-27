#!/usr/bin/env node
/**
 * 打包前把浏览器安装包放到 build/browser/windrise-browser-setup.exe。
 *
 * 这个文件只被 NSIS 安装包引用（见 build/installer.nsh）：
 *   - 不进便携版；
 *   - 不会被解压到安装目录；
 *   - 安装时从安装包临时解到 $PLUGINSDIR，装完就删。
 *
 * 用法：
 *   node scripts/prepare-browser-installer.mjs "C:\path\to\Windrise浏览器测试版-安装.exe"
 *   node scripts/prepare-browser-installer.mjs --force "C:\path\to\Windrise浏览器测试版-安装.exe"
 *   set WINDRISE_BROWSER_INSTALLER=C:\path\to\Windrise浏览器测试版-安装.exe
 *   node scripts/prepare-browser-installer.mjs
 * 目标文件存在、大小和 sha256 都和来源一致时跳过；--force 强制重新复制。
 */
import { closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "build", "browser", "windrise-browser-setup.exe");
const MIN_SIZE = 20 * 1024 * 1024;

const args = process.argv.slice(2);
const force = args.includes("--force");
const source = args.find((arg) => !arg.startsWith("--")) || process.env.WINDRISE_BROWSER_INSTALLER || "";

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** 分块算 sha256：浏览器安装包 160 MB，不一次读进内存 */
function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** 只读文件头两个字节，确认是 Windows 可执行文件 */
function hasMzHeader(file) {
  const fd = openSync(file, "r");
  const head = Buffer.alloc(2);
  try {
    readSync(fd, head, 0, 2, 0);
  } finally {
    closeSync(fd);
  }
  return head.toString("ascii") === "MZ";
}

/** 检查一个安装包能不能用；不行就打印原因并退出 */
function assertUsable(file) {
  if (!existsSync(file)) {
    console.error(`[browser] 找不到：${file}`);
    process.exit(1);
  }
  const size = statSync(file).size;
  if (size < MIN_SIZE) {
    console.error(`[browser] 只有 ${mb(size)}，不像 Chromium 安装包：${file}`);
    process.exit(1);
  }
  if (!hasMzHeader(file)) {
    console.error(`[browser] 不是 Windows 可执行文件（缺少 MZ 头）：${file}`);
    process.exit(1);
  }
  return size;
}

if (!source) {
  if (!existsSync(OUT)) {
    console.error("[browser] 没有浏览器安装包，NSIS 安装包会缺浏览器。用法：");
    console.error("  node scripts/prepare-browser-installer.mjs <浏览器安装包路径>");
    console.error("  或者先设置环境变量 WINDRISE_BROWSER_INSTALLER");
    process.exit(1);
  }
  const size = assertUsable(OUT);
  console.log(`[browser] 已存在（${mb(size)}），跳过：${path.relative(ROOT, OUT)}`);
  process.exit(0);
}

const size = assertUsable(source);

if (path.resolve(source).toLowerCase() === OUT.toLowerCase()) {
  console.log(`[browser] 来源就是目标文件，无需复制：${path.relative(ROOT, OUT)}`);
  process.exit(0);
}

if (!force && existsSync(OUT) && statSync(OUT).size === size) {
  const [sourceHash, outHash] = await Promise.all([sha256(source), sha256(OUT)]);
  if (sourceHash === outHash) {
    console.log(`[browser] 目标已是最新（${mb(size)}，sha256 ${sourceHash.slice(0, 16)}…），跳过`);
    process.exit(0);
  }
}

mkdirSync(path.dirname(OUT), { recursive: true });
copyFileSync(source, OUT);

const hash = await sha256(OUT);
console.log(`[browser] 已复制：${source}`);
console.log(`[browser]      -> ${path.relative(ROOT, OUT)}（${mb(size)}，sha256 ${hash.slice(0, 16)}…）`);
