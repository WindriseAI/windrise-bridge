#!/usr/bin/env node
/**
 * 打包前把 cloudflared 放进 build/bin/<系统>-<架构>/，随安装包一起发（用户装好就能用，不用再从 GitHub 下载）。
 *
 * 用法：
 *   node scripts/fetch-cloudflared.mjs                    # 当前系统 + 架构
 *   node scripts/fetch-cloudflared.mjs win x64
 *   node scripts/fetch-cloudflared.mjs mac arm64 mac x64  # 一次准备多个
 * 已经有了就跳过（删掉 build/bin 可强制重新下载）。
 */
import { existsSync, mkdirSync, writeFileSync, chmodSync, renameSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://github.com/cloudflare/cloudflared/releases/latest/download/";
const MIRRORS = ["", "https://ghfast.top/", "https://gh-proxy.com/"];

const cur = [{ win32: "win", darwin: "mac", linux: "linux" }[process.platform], process.arch];
const argv = process.argv.slice(2);
const targets = [];
for (let i = 0; i < argv.length; i += 2) targets.push([argv[i], argv[i + 1] || "x64"]);
if (!targets.length) targets.push(cur);

async function download(url) {
  let last;
  for (const m of MIRRORS) {
    try {
      const res = await fetch(m + url, { redirect: "follow", signal: AbortSignal.timeout(180000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 5_000_000) throw new Error(`文件太小（${buf.length} 字节）`);
      return buf;
    } catch (error) { last = error; console.log(`  ${m || "官方"} 失败：${error.message}`); }
  }
  throw last;
}

for (const [os, arch] of targets) {
  const dir = path.join(ROOT, "build", "bin", `${os}-${arch}`);
  const name = os === "win" ? "cloudflared.exe" : "cloudflared";
  const out = path.join(dir, name);
  if (existsSync(out)) { console.log(`[cloudflared] ${os}-${arch} 已存在，跳过`); continue; }
  mkdirSync(dir, { recursive: true });
  const cfArch = arch === "arm64" ? "arm64" : "amd64";
  const file = os === "win" ? `cloudflared-windows-${cfArch}.exe` : os === "mac" ? `cloudflared-darwin-${cfArch}.tgz` : `cloudflared-linux-${cfArch}`;
  console.log(`[cloudflared] 下载 ${file}`);
  const buf = await download(BASE + file);
  if (file.endsWith(".tgz")) {
    const tgz = path.join(dir, "cf.tgz");
    writeFileSync(tgz, buf);
    execFileSync("tar", ["-xzf", tgz, "-C", dir]);
    rmSync(tgz, { force: true });
    if (!existsSync(out)) throw new Error("解压后没找到 cloudflared");
  } else {
    writeFileSync(out + ".part", buf);
    renameSync(out + ".part", out);
  }
  if (os !== "win") chmodSync(out, 0o755);
  console.log(`[cloudflared] 已放到 ${path.relative(ROOT, out)}`);
}
