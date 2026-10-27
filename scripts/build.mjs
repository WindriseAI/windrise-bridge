#!/usr/bin/env node
/**
 * 一键打包：生成图标 → 调 electron-builder → 打印产物清单。
 *
 * 用法：
 *   node scripts/build.mjs                 # nsis + portable 全量打包
 *   node scripts/build.mjs --dir           # 只出 dist/win-unpacked（最快，调试用）
 *   node scripts/build.mjs --win nsis      # 只出 nsis
 *   node scripts/build.mjs --icon-only     # 只重新生成 build/icon.ico
 *   node scripts/build.mjs --mac           # 在 Mac 上打 dmg + zip（Intel 和 Apple 芯片各一份）
 *
 * 说明：
 *   - electron-builder 优先用项目本地的 node_modules/electron-builder；
 *     没装的话用 npx 拉固定版本（不会改 package.json / package-lock.json）。
 *   - 配置全部在 electron-builder.yml 里，本脚本只是包一层，方便一条命令跑完。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const EB_VERSION = "26.15.3"; // 仅在没有本地安装时使用，保证可复现

const argv = process.argv.slice(2);

function run(command, args, options = {}) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", cwd: ROOT, ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** 跑一条已经拼好的命令行（Windows 上 npx 是 .cmd，必须过 shell）。 */
function runShell(commandLine) {
  console.log(`\n$ ${commandLine}`);
  const result = spawnSync(commandLine, { stdio: "inherit", cwd: ROOT, shell: true });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/* ---------------- 1) 图标 ---------------- */
const isMacBuild = argv.includes("--mac") || (process.platform === "darwin" && !argv.includes("--win"));
console.log("[build] 1/4 生成图标");
// Mac 包直接用 electron/assets/icon.png（1024px），不需要 Windows 的 ico（生成 ico 要 PowerShell）
const iconStatus = isMacBuild ? 0 : run(process.execPath, [path.join(HERE, "make-icon.mjs")]);
if (iconStatus !== 0) {
  console.error("[build] 图标生成失败，停止");
  process.exit(iconStatus);
}
if (argv.includes("--icon-only")) {
  console.log("[build] --icon-only：到此为止");
  process.exit(0);
}

/* ---------------- 1.5) 附带的 cloudflared ---------------- */
// 打进安装包，用户第一次打开就能连，不用再从 GitHub 下载（国内经常下不动）
{
  const fetchArgs = isMacBuild ? ["mac", "arm64", "mac", "x64"] : ["win", "x64"];
  const st = run(process.execPath, [path.join(HERE, "fetch-cloudflared.mjs"), ...fetchArgs]);
  if (st !== 0) { console.error("[build] cloudflared 准备失败，停止（安装包里必须带上它）"); process.exit(st); }
}

/* ---------------- 1.6) 随包浏览器安装包 ---------------- */
// 只进 NSIS 安装包：build/browser/windrise-browser-setup.exe（见 build/installer.nsh）。
// 浏览器安装包不在仓库里，第一次打包要先放进来，或者设置 WINDRISE_BROWSER_INSTALLER。
// --dir（只出解包目录）和只打 portable 时不编译 NSIS，不需要它，也不能因为缺它挡路。
function needsBundledBrowser() {
  if (isMacBuild) return false;
  if (argv.includes("--dir")) return false;
  const winIndex = argv.indexOf("--win");
  if (winIndex === -1) return true; // 默认 win.target 里有 nsis
  const targets = [];
  for (let i = winIndex + 1; i < argv.length && !argv[i].startsWith("--"); i += 1) {
    targets.push(argv[i].toLowerCase());
  }
  // --win 后面不写目标 = 用配置里的默认目标（nsis + portable）
  return targets.length === 0 || targets.includes("nsis");
}

if (needsBundledBrowser()) {
  console.log("[build] 1.6/4 准备浏览器安装包");
  const st = run(process.execPath, [path.join(HERE, "prepare-browser-installer.mjs")]);
  if (st !== 0) { console.error("[build] 浏览器安装包准备失败，停止（NSIS 安装包要带上它）"); process.exit(st); }
} else {
  console.log("[build] 1.6/4 这次不生成 NSIS，跳过浏览器安装包");
}

/* ---------------- 2) electron-builder ---------------- */
console.log("[build] 2/4 调 electron-builder");
const local = path.join(ROOT, "node_modules", "electron-builder", "package.json");
const hasLocal = existsSync(local);
const version = hasLocal ? JSON.parse(readFileSync(local, "utf8")).version : null;
console.log(`[build] electron-builder：${hasLocal ? `本地 ${version}` : `npx 拉取 ${EB_VERSION}`}`);

// npx 在 Windows 上是 npx.cmd，必须走 shell；把整条命令拼成一个字符串，
// 避免 Node 20+ 对 (shell: true + args 数组) 的 DEP0190 告警。
const args = ["--config", "electron-builder.yml", "--publish", "never", ...argv.filter((a) => a !== "--icon-only")];
const cmd = hasLocal
  ? `npx electron-builder ${args.map(quote).join(" ")}`
  : `npx --yes electron-builder@${EB_VERSION} ${args.map(quote).join(" ")}`;

function quote(value) {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

const status = runShell(cmd);
if (status !== 0) {
  console.error(`\n[build] electron-builder 退出码 ${status} —— 打包失败（错误见上面的输出）`);
  process.exit(status);
}

/* ---------------- 3) 产物清单 ---------------- */
console.log("[build] 3/4 产物");
const dist = path.join(ROOT, "dist");
if (!existsSync(dist)) {
  console.error("[build] dist/ 不存在？打包可能没有真正产出文件");
  process.exit(1);
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const dirSize = (dir) => {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
};

for (const entry of readdirSync(dist, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  const full = path.join(dist, entry.name);
  if (entry.isFile()) {
    console.log(`  [file] dist/${entry.name}  ${mb(statSync(full).size)}`);
  } else if (entry.name === "win-unpacked") {
    console.log(`  [dir ] dist/${entry.name}/  ${mb(dirSize(full))}（解包目录，安装包就是它压出来的）`);
  } else {
    console.log(`  [dir ] dist/${entry.name}/`);
  }
}
console.log("[build] 4/4 完成");
