/**
 * 隧道客户端的自动安装。
 *
 * 为什么要有这个：
 *   cloudflared 和 ngrok 都是命令行工具，官网让你「下载解压放到 PATH 里」——
 *   对普通用户这一步就卡死了。既然程序自己要用，就该自己装到自己的目录里。
 *
 * 装到哪：~/.bridge-replica/bin/
 *   不往系统 PATH 里塞东西，也不动用户已有的安装。
 *   卸载就是删这一个目录。
 *
 * 查找顺序（找到就用，不重复装）：
 *   ① 我们自己装的目录
 *   ② 系统 PATH
 *   ③ 常见安装位置
 */

import { chmod, mkdir, rename, rm, stat, writeFile, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);

const IS_WINDOWS = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

/*
 * 下载用的 fetch。Electron 里由主进程换成 net.fetch —— 它走 Chromium 网络栈，自动用系统代理；
 * Node 自带的 fetch 不认系统代理，只开了系统代理（没开 TUN）的电脑上直连 GitHub 经常超时。
 */
let fetchImpl = (...args) => fetch(...args);
export function setFetch(fn) { if (typeof fn === "function") fetchImpl = fn; }

/** GitHub 在国内经常连不上：官方地址失败后依次试这些加速镜像（下载完会校验 Cloudflare 的数字签名，被篡改的文件不会用） */
const GITHUB_MIRRORS = ["https://ghfast.top/", "https://gh-proxy.com/"];

/** 随安装包附带的客户端目录（打包时放进 resources/bin，由主进程通过环境变量告诉我们） */
function bundledDir() {
  return process.env.BRIDGE_BUNDLED_BIN?.trim() || null;
}

/** 我们自己的安装目录 —— 放这儿不污染系统 */
export function binDir(dataHome = (process.env.BRIDGE_DATA_HOME?.trim() || path.join(os.homedir(), ".bridge-replica"))) {
  return path.join(dataHome, "bin");
}

const ARCH = process.arch === "arm64" ? "arm64" : "amd64";

/**
 * 下载地址。都指向官方的「latest / stable」链接，这样不用跟着版本号改。
 */
const SOURCES = {
  cloudflared: {
    label: "Cloudflare cloudflared",
    url: {
      win32: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-${ARCH}.exe`,
      linux: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}`,
      darwin: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${ARCH}.tgz`,
    },
    /** 下载下来是压缩包的话，里面哪个文件才是可执行文件 */
    inner: { darwin: "cloudflared" },
    binaryName: { win32: "cloudflared.exe", linux: "cloudflared", darwin: "cloudflared" },
    homepage: "https://github.com/cloudflare/cloudflared/releases",
  },
  ngrok: {
    label: "ngrok",
    url: {
      win32: `https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-${ARCH}.zip`,
      linux: `https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-${ARCH}.zip`,
      darwin: `https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-darwin-${ARCH}.zip`,
    },
    inner: { win32: "ngrok.exe", linux: "ngrok", darwin: "ngrok" },
    binaryName: { win32: "ngrok.exe", linux: "ngrok", darwin: "ngrok" },
    homepage: "https://ngrok.com/download",
  },
};

/** 系统里常见的手动安装位置（找不到就当作没装） */
const COMMON_PATHS = {
  cloudflared: [
    "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
    "C:\\Program Files\\cloudflared\\cloudflared.exe",
    "/usr/local/bin/cloudflared",
    "/usr/bin/cloudflared",
    "/opt/homebrew/bin/cloudflared",
  ],
  ngrok: [
    "C:\\Program Files\\ngrok\\ngrok.exe",
    "/usr/local/bin/ngrok",
    "/usr/bin/ngrok",
    "/opt/homebrew/bin/ngrok",
  ],
};

/** 这个文件能不能跑起来（跑 --version 看） */
async function probeBinary(binPath) {
  try {
    const { stdout } = await run(binPath, ["--version"], { timeout: 15000, windowsHide: true });
    return { ok: true, version: String(stdout).trim().split("\n")[0] || "unknown" };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * 找一个能用的客户端。
 * 顺序：我们自己装的 → PATH → 常见位置。
 */
export async function detect(name, { dataHome } = {}) {
  const spec = SOURCES[name];
  if (!spec) return { found: false, error: `不认识的客户端：${name}` };

  const ownPath = path.join(binDir(dataHome), spec.binaryName[process.platform] ?? name);
  const bundled = bundledDir();
  const candidates = [
    ...(bundled ? [{ path: path.join(bundled, spec.binaryName[process.platform] ?? name), source: "随软件附带" }] : []),
    { path: ownPath, source: "程序自己装的" },
    { path: spec.binaryName[process.platform] ?? name, source: "系统 PATH" },
    ...(COMMON_PATHS[name] ?? []).map((p) => ({ path: p, source: "系统里已有的安装" })),
  ];

  for (const candidate of candidates) {
    // 只对绝对路径做存在性检查；PATH 里的名字交给 probeBinary 去解析
    if (path.isAbsolute(candidate.path)) {
      const exists = await stat(candidate.path).then(() => true).catch(() => false);
      if (!exists) continue;
    }
    const probed = await probeBinary(candidate.path);
    if (probed.ok) {
      return { found: true, path: candidate.path, source: candidate.source, version: probed.version };
    }
  }

  return {
    found: false,
    error: `没找到 ${spec.label}`,
    canInstall: true,
    homepage: spec.homepage,
    installTarget: ownPath,
  };
}

/** 带进度的下载。返回落盘路径。 */
async function downloadFile(url, destPath, onProgress) {
  // 20 秒没收到任何数据就放弃这个地址（换镜像），总时长最多 10 分钟
  const controller = new AbortController();
  let stall = setTimeout(() => controller.abort(new Error("20 秒没有响应")), 20000);
  const total10m = setTimeout(() => controller.abort(new Error("下载超过 10 分钟")), 600000);
  const kick = () => { clearTimeout(stall); stall = setTimeout(() => controller.abort(new Error("下载卡住了（20 秒没有数据）")), 20000); };
  try {
    return await downloadInner(url, destPath, onProgress, controller.signal, kick);
  } finally { clearTimeout(stall); clearTimeout(total10m); }
}

async function downloadInner(url, destPath, onProgress, signal, kick) {
  const response = await fetchImpl(url, { redirect: "follow", signal });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  if (!response.body) throw new Error("下载失败：响应没有内容");
  kick();

  const total = Number(response.headers.get("content-length")) || 0;
  let received = 0;
  let lastReport = 0;

  const source = Readable.fromWeb(response.body);
  source.on("data", (chunk) => {
    kick();
    received += chunk.length;
    const now = Date.now();
    // 每 200ms 报一次，别把界面刷爆
    if (onProgress && now - lastReport > 200) {
      lastReport = now;
      onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : null });
    }
  });

  await pipeline(source, createWriteStream(destPath));
  if (onProgress) onProgress({ received, total, percent: 100, done: true });
  return destPath;
}

/**
 * 校验数字签名确实来自 Cloudflare（从镜像下载时必须过这一关）。
 * Windows：Authenticode；macOS：codesign。校验工具本身不可用时返回 null（不确定）。
 */
async function verifySigner(file, vendor = /Cloudflare/i) {
  try {
    if (IS_WINDOWS) {
      const ps = `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`;
      const { stdout } = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 20000, windowsHide: true });
      const [status, subject] = String(stdout).trim().split("|");
      return status === "Valid" && vendor.test(subject || "");
    }
    if (IS_MAC) {
      const { stderr } = await run("codesign", ["-dv", "--verbose=2", file], { timeout: 20000 });
      return vendor.test(String(stderr));
    }
  } catch { return null; }
  return null;
}

/** 解压。Windows 10+ / macOS / Linux 都自带 bsdtar，它认得 zip 和 tgz。 */
async function extractArchive(archivePath, outDir) {
  await run("tar", ["-xf", archivePath, "-C", outDir], { timeout: 120000, windowsHide: true });
}

/**
 * 装一个客户端。已经装了就直接返回。
 *
 * 流程：下载到临时文件 → 解压（如果是压缩包）→ 移到最终位置 → 跑 --version 验证。
 * 验证不过就当失败，不会留下一个「看起来装了其实跑不起来」的文件。
 */
export async function ensure(name, { dataHome, onProgress } = {}) {
  const spec = SOURCES[name];
  if (!spec) return { ok: false, error: `不认识的客户端：${name}` };

  const existing = await detect(name, { dataHome });
  if (existing.found) return { ok: true, alreadyInstalled: true, ...existing };

  const platform = process.platform;
  const url = spec.url[platform];
  if (!url) return { ok: false, error: `这个系统（${platform}）暂时没有自动安装，请去 ${spec.homepage} 手动下载` };

  const dir = binDir(dataHome);
  await mkdir(dir, { recursive: true });

  const binaryName = spec.binaryName[platform] ?? name;
  const finalPath = path.join(dir, binaryName);
  const isArchive = /\.(zip|tgz|tar\.gz)$/i.test(url);

  const tempDownload = path.join(dir, `.download-${name}-${Date.now()}${isArchive ? path.extname(url.split("?")[0]) : ".exe"}`);

  const urls = [url, ...(url.startsWith("https://github.com/") ? GITHUB_MIRRORS.map((m) => m + url) : [])];
  let fromMirror = false;
  try {
    let lastError = null;
    for (const [i, candidate] of urls.entries()) {
      try {
        if (onProgress) onProgress({ phase: "download", percent: 0, label: i ? `官方地址太慢，换加速线路下载 ${spec.label}…` : `正在下载 ${spec.label}…` });
        await downloadFile(candidate, tempDownload, (p) => onProgress?.({ phase: "download", ...p }));
        fromMirror = i > 0;
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await rm(tempDownload, { force: true }).catch(() => {});
      }
    }
    if (lastError) throw new Error(`下载失败（官方地址和加速线路都试过了）：${lastError.message}`);

    if (isArchive) {
      if (onProgress) onProgress({ phase: "extract", label: "正在解压…" });
      const extractDir = path.join(dir, `.extract-${name}-${Date.now()}`);
      await mkdir(extractDir, { recursive: true });
      try {
        await extractArchive(tempDownload, extractDir);
        const innerName = spec.inner[platform] ?? binaryName;
        // 压缩包里可能在子目录里，递归找一个名字对得上的
        const found = await findFile(extractDir, innerName);
        if (!found) throw new Error(`解压后没找到 ${innerName}`);
        await rename(found, finalPath);
      } finally {
        await rm(extractDir, { recursive: true, force: true }).catch(() => {});
      }
      // 解压完压缩包就没用了。之前忘了删，11.7 MB 一直躺在安装目录里
      // （表现为「装完目录里有两个东西」，用户会以为装重了）。
      await rm(tempDownload, { force: true }).catch(() => {});
    } else {
      await rename(tempDownload, finalPath);
    }

    if (!IS_WINDOWS) await chmod(finalPath, 0o755);

    // 镜像下载的必须验明正身：签名不是 Cloudflare 的一律删掉
    if (fromMirror && name === "cloudflared") {
      const signed = await verifySigner(finalPath);
      if (signed === false) {
        await rm(finalPath, { force: true }).catch(() => {});
        throw new Error("加速线路下载的文件签名不对，已删除（为了安全不使用）");
      }
    }

    // 验证：跑不起来就不算装好
    if (onProgress) onProgress({ phase: "verify", label: "正在验证…" });
    const probed = await probeBinary(finalPath);
    if (!probed.ok) {
      await rm(finalPath, { force: true }).catch(() => {});
      throw new Error(`下载了但跑不起来：${probed.error}`);
    }

    if (onProgress) onProgress({ phase: "done", label: "装好了", percent: 100 });
    return { ok: true, installed: true, path: finalPath, version: probed.version, source: "刚装好的" };
  } catch (error) {
    await rm(tempDownload, { force: true }).catch(() => {});
    return { ok: false, error: error.message, homepage: spec.homepage };
  }
}

/** 在目录里递归找指定名字的文件（压缩包里可能在子目录） */
async function findFile(dir, name) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const found = await findFile(full, name);
      if (found) return found;
    }
  }
  return null;
}

/** 所有客户端的安装状态（界面用） */
export async function statusAll({ dataHome } = {}) {
  const out = {};
  for (const name of Object.keys(SOURCES)) {
    const result = await detect(name, { dataHome });
    out[name] = { ...result, label: SOURCES[name].label, homepage: SOURCES[name].homepage };
  }
  return out;
}

export { SOURCES, probeBinary, IS_WINDOWS, IS_MAC };
