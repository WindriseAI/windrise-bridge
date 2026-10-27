/**
 * 自动更新：定期问服务器有没有新版本，验签后下载安装包，核对大小和 sha256 再安装。
 *
 * 信任链：服务器返回 { manifest(JSON 字符串), sig }，sig 是 Ed25519 对 manifest 原文的签名，
 * 公钥写死在这里。安装包本身没有代码签名，所以靠 manifest 里的 sha256 + size 保证内容没被换过。
 * 状态（idle / checking / available / downloading / ready / error）通过 onState 推给界面。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

/** 更新清单公钥（SPKI DER hex），和许可证同一把 */
const UPDATE_PUBLIC_KEY_HEX = "302a300506032b6570032100fd00f2e4f064bdf619688d405bee6b7a5e0346a113f46e71e072e1912b63fa58";
const FIRST_CHECK_MS = 20_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const CHECK_JITTER_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

const PUBLIC_KEY = crypto.createPublicKey({ key: Buffer.from(UPDATE_PUBLIC_KEY_HEX, "hex"), format: "der", type: "spki" });

/** 验签并解析 manifest；任何一步不对都返回 null */
function openManifest(body, { platform, current }) {
  try {
    if (!body || typeof body.manifest !== "string" || typeof body.sig !== "string") return null;
    if (!crypto.verify(null, Buffer.from(body.manifest), PUBLIC_KEY, Buffer.from(body.sig, "base64url"))) return null;
    const manifest = JSON.parse(body.manifest);
    if (manifest?.kind !== "windrise-update" || manifest.platform !== platform || manifest.current !== current) return null;
    return manifest;
  } catch {
    return null;
  }
}

function createUpdater({ app, net, shell, settings, apiBase, dataHome, onState, log = () => {}, onQuit }) {
  const dir = path.join(dataHome, "updates");
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE || "";
  const canInstall = app.isPackaged && process.platform === "win32";
  const state = {
    status: "idle", current: app.getVersion(), latest: null, progress: null, error: null,
    lastCheckAt: 0, canInstall, portable: Boolean(portableExe), file: null,
  };
  let timer = null;
  let busy = null;
  let manifest = null;

  const push = () => { try { onState?.({ ...state }); } catch { /* 界面没了不影响更新 */ } };
  const set = (patch) => { Object.assign(state, patch); push(); };
  const channel = () => (/^[a-z0-9-]{1,20}$/.test(settings.all().updateChannel ?? "") ? settings.all().updateChannel : "stable");
  const pickAsset = (latest) => (state.portable ? latest?.assets?.portable : latest?.assets?.setup);

  function assetUrl(asset) {
    const url = new URL(asset.url, apiBase);
    if (url.protocol !== "https:") throw new Error("下载地址不是 https");
    return url.href;
  }

  async function fetchJson(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await net.fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`服务器返回 ${res.status}`);
      return await res.json();
    } finally { clearTimeout(timeout); }
  }

  /** 问服务器。manual=true 时不受「跳过此版本」影响，错误也会显示出来 */
  async function check({ manual = false } = {}) {
    if (busy || state.status === "downloading" || state.status === "ready") return { ...state };
    busy = (async () => {
      if (manual || state.status !== "available") set({ status: "checking", error: null });
      try {
        const q = new URLSearchParams({ version: state.current, platform: process.platform, channel: channel() });
        const body = await fetchJson(`${apiBase}/api/update/check?${q}`);
        const m = openManifest(body, { platform: process.platform, current: state.current });
        if (!m) throw new Error("更新信息校验失败，已忽略");
        manifest = m;
        const latest = m.update ? m.latest : null;
        const asset = latest && pickAsset(latest);
        if (!latest || !asset?.url || !asset.sha256 || !asset.size) { set({ status: "idle", latest: null, lastCheckAt: Date.now() }); return; }
        const skipped = !latest.mandatory && !manual && settings.all().skipVersion === latest.version;
        set({
          status: skipped ? "idle" : "available", lastCheckAt: Date.now(),
          latest: { version: latest.version, notes: latest.notes ?? "", mandatory: Boolean(latest.mandatory), publishedAt: latest.publishedAt ?? null, size: asset.size },
        });
        if (!skipped && latest.mandatory) log(`发现必须安装的新版本 ${latest.version}`);
      } catch (error) {
        // 后台自动检查失败不打扰用户（没网很常见），只有手动检查才报错
        set({ status: manual ? "error" : state.status === "checking" ? "idle" : state.status, error: manual ? error.message : null, lastCheckAt: Date.now() });
      }
    })().finally(() => { busy = null; });
    await busy;
    return { ...state };
  }

  function sha256File(file) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      fs.createReadStream(file).on("data", (c) => hash.update(c)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
    });
  }

  async function verifyFile(file, asset) {
    const stat = fs.statSync(file);
    if (stat.size !== asset.size) return false;
    return (await sha256File(file)) === String(asset.sha256).toLowerCase();
  }

  async function download() {
    if (state.status === "ready") return { ...state };
    if (busy || state.status === "downloading") return { ...state };
    const latest = manifest?.latest;
    const asset = latest && pickAsset(latest);
    if (!asset) { set({ status: "error", error: "没有可下载的新版本，先检查更新" }); return { ...state }; }
    busy = (async () => {
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, path.basename(asset.name || `update-${latest.version}.exe`));
      const part = `${target}.part`;
      try {
        // 上次已经下好的直接用
        if (fs.existsSync(target) && await verifyFile(target, asset)) { set({ status: "ready", file: target, progress: null, error: null }); return; }
        set({ status: "downloading", progress: { received: 0, total: asset.size }, error: null });
        const res = await net.fetch(assetUrl(asset));
        if (!res.ok || !res.body) throw new Error(`下载失败（服务器返回 ${res.status}）`);
        const out = fs.createWriteStream(part);
        const hash = crypto.createHash("sha256");
        let received = 0, lastPush = 0;
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            hash.update(value);
            if (!out.write(value)) await new Promise((r) => out.once("drain", r));
            received += value.length;
            if (received > asset.size) throw new Error("下载内容比预期大");
            if (Date.now() - lastPush > 250) { lastPush = Date.now(); set({ progress: { received, total: asset.size } }); }
          }
        } finally {
          await new Promise((r) => out.end(r));
        }
        if (received !== asset.size || hash.digest("hex") !== String(asset.sha256).toLowerCase()) throw new Error("安装包校验没通过（大小或 sha256 不一致），已删除");
        fs.renameSync(part, target);
        set({ status: "ready", file: target, progress: null });
      } catch (error) {
        try { fs.unlinkSync(part); } catch { /* 没有就算了 */ }
        set({ status: "error", error: error.message, progress: null });
      }
    })().finally(() => { busy = null; });
    await busy;
    return { ...state };
  }

  function portableScript(src, dst) {
    const q = (p) => p.replace(/%/g, "%%");
    const script = path.join(dir, "apply-update.cmd");
    fs.writeFileSync(script, [
      "@echo off", "chcp 65001 >nul",
      `set "SRC=${q(src)}"`, `set "DST=${q(dst)}"`,
      "for /l %%i in (1,1,60) do (",
      "  copy /y \"%SRC%\" \"%DST%\" >nul 2>&1 && goto ok",
      "  ping -n 2 127.0.0.1 >nul",
      ")",
      "exit /b 1", ":ok", "del \"%SRC%\" >nul 2>&1", "start \"\" \"%DST%\"", "(goto) 2>nul & del \"%~f0\"", "",
    ].join("\r\n"), "utf8");
    return script;
  }

  async function install() {
    if (state.status !== "ready" || !state.file) return { ok: false, error: "还没有下载好的更新" };
    if (!canInstall) return { ok: false, error: "开发模式只检查更新，不安装" };
    const asset = pickAsset(manifest?.latest);
    if (!asset || !fs.existsSync(state.file) || !(await verifyFile(state.file, asset))) {
      set({ status: "error", error: "安装包已损坏或被改动，请重新下载", file: null });
      return { ok: false, error: state.error };
    }
    try {
      if (state.portable) {
        const script = portableScript(state.file, portableExe);
        spawn("cmd.exe", ["/c", script], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      } else {
        spawn(state.file, ["/S", "--force-run"], { detached: true, stdio: "ignore" }).unref();
      }
    } catch (error) {
      // 静默安装起不来（比如被杀毒拦了）：退回手动打开安装包
      const err = await shell.openPath(state.file);
      if (err) return { ok: false, error: `${error.message}；${err}` };
    }
    setTimeout(() => (onQuit ? onQuit() : app.quit()), 600);
    return { ok: true };
  }

  function skip() {
    const v = state.latest?.version;
    if (!v || state.latest.mandatory) return { ok: false, error: "这个版本必须更新，不能跳过" };
    settings.save({ skipVersion: v });
    set({ status: "idle", latest: null });
    return { ok: true };
  }

  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (settings.all().autoUpdate !== false) await check().catch(() => {});
      schedule(CHECK_EVERY_MS + Math.round((Math.random() * 2 - 1) * CHECK_JITTER_MS));
    }, delay);
    timer.unref?.();
  }

  function start() {
    // 清掉旧版本留下的安装包
    try { for (const f of fs.readdirSync(dir)) if (/\.(exe|part|cmd)$/i.test(f)) fs.unlinkSync(path.join(dir, f)); } catch { /* 目录不存在 */ }
    schedule(FIRST_CHECK_MS);
  }

  return { start, check, download, install, skip, state: () => ({ ...state }), stop: () => clearTimeout(timer) };
}

module.exports = { createUpdater, openManifest };
