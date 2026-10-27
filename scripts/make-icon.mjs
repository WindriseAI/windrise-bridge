#!/usr/bin/env node
/**
 * 组装 build/icon.ico（零依赖）。
 *
 * 流程：
 *   1) 如果 build/.icon-raw 里没有原始像素，就先调 scripts/render-icon.ps1 渲染
 *   2) 把每个尺寸的原始 BGRA 拼成 ico 里的 DIB 条目（BITMAPINFOHEADER + XOR 位图 + AND 掩码）
 *   3) 写 build/icon.ico，并把 ico 解析回来校验一遍（条目数 / 尺寸 / 偏移 / 总长度）
 *
 * 用法：
 *   node scripts/make-icon.mjs            # 缺原始像素时自动渲染
 *   node scripts/make-icon.mjs --force    # 强制重新渲染
 *
 * 为什么手写 ico 而不是用现成库：electron-builder 只认 .ico，而本项目不想为了一个图标
 * 再拉一个转换库；ico 容器本身很简单，DIB 条目是 Windows 全版本都认的格式。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BUILD_DIR = path.join(ROOT, "build");
const RAW_DIR = path.join(BUILD_DIR, ".icon-raw");
const ICO_PATH = path.join(BUILD_DIR, "icon.ico");

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const force = process.argv.includes("--force");

mkdirSync(BUILD_DIR, { recursive: true });

/** 需要时调 PowerShell 渲染原始像素。 */
function renderRaw() {
  const ps1 = path.join(HERE, "render-icon.ps1");
  const shell = process.platform === "win32" ? "pwsh.exe" : "pwsh";
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-OutDir", RAW_DIR];
  console.log(`[icon] 渲染原始像素：${shell} ${args.join(" ")}`);
  const result = spawnSync(shell, args, { stdio: "inherit", cwd: ROOT });
  if (result.status !== 0) {
    throw new Error(`render-icon.ps1 退出码 ${result.status}（需要 PowerShell 7 与 System.Drawing）`);
  }
}

const haveRaw = SIZES.every((s) => existsSync(path.join(RAW_DIR, `${s}.bgra`)));
if (force || !haveRaw) {
  if (force) rmSync(RAW_DIR, { recursive: true, force: true });
  renderRaw();
}

/** 一个尺寸 → ico 里的一条 DIB。 */
function buildDib(size) {
  const raw = readFileSync(path.join(RAW_DIR, `${size}.bgra`));
  const expect = size * size * 4;
  if (raw.length !== expect) {
    throw new Error(`${size}x${size} 原始像素大小不对：期望 ${expect} 字节，实际 ${raw.length} 字节`);
  }

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight = 2×（XOR + AND）
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB
  header.writeUInt32LE(size * size * 4, 20); // biSizeImage

  // DIB 像素是自下而上存的，渲染出来的是自上而下，所以按行倒序
  const xor = Buffer.alloc(size * size * 4);
  const rowBytes = size * 4;
  for (let y = 0; y < size; y += 1) {
    raw.copy(xor, y * rowBytes, (size - 1 - y) * rowBytes, (size - y) * rowBytes);
  }

  // AND 掩码：32bpp 有 alpha，掩码全 0 即可；每行按 4 字节对齐
  const maskRowBytes = Math.ceil(Math.ceil(size / 8) / 4) * 4;
  const and = Buffer.alloc(maskRowBytes * size);

  return Buffer.concat([header, xor, and]);
}

const entries = SIZES.map((size) => ({ size, data: buildDib(size) }));

const headerSize = 6 + entries.length * 16;
let offset = headerSize;
const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0); // reserved
dir.writeUInt16LE(1, 2); // type = icon
dir.writeUInt16LE(entries.length, 4);

const dirEntries = [];
for (const { size, data } of entries) {
  const e = Buffer.alloc(16);
  e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 表示 256
  e.writeUInt8(size >= 256 ? 0 : size, 1);
  e.writeUInt8(0, 2); // 调色板数
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bitCount
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  dirEntries.push(e);
  offset += data.length;
}

writeFileSync(ICO_PATH, Buffer.concat([dir, ...dirEntries, ...entries.map((e) => e.data)]));

/* ------------------------------------------------------------------ *
 * 校验：把刚写出来的 ico 解析回来
 * ------------------------------------------------------------------ */

const ico = readFileSync(ICO_PATH);
const reserved = ico.readUInt16LE(0);
const type = ico.readUInt16LE(2);
const count = ico.readUInt16LE(4);
if (reserved !== 0 || type !== 1 || count !== entries.length) {
  throw new Error(`ico 头部不对：reserved=${reserved} type=${type} count=${count}`);
}
const parsed = [];
for (let i = 0; i < count; i += 1) {
  const base = 6 + i * 16;
  const w = ico.readUInt8(base) || 256;
  const h = ico.readUInt8(base + 1) || 256;
  const bytes = ico.readUInt32LE(base + 8);
  const at = ico.readUInt32LE(base + 12);
  if (at + bytes > ico.length) throw new Error(`第 ${i} 条条目越界`);

  if (ico.readUInt32LE(at) !== 40) throw new Error(`第 ${i} 条条目的 DIB 头不是 40 字节`);
  parsed.push(`${w}x${h}(${bytes}B@${at})`);
}

console.log(`[icon] 写出 ${ICO_PATH}`);
console.log(`[icon] 大小 ${(ico.length / 1024).toFixed(1)} KB，条目 ${count} 条：${parsed.join(" ")}`);
