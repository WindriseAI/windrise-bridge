/**
 * 「让其他 AI 操作本软件」：
 *   - 安装命令行 windrise（写一个小启动脚本到系统 PATH 里的目录）
 *   - 一键把本软件写进 Claude Desktop / Cursor / Windsurf / Claude Code / Codex / OpenCode / Gemini CLI 的 MCP 配置
 *   - 把仓库里的 skill 装进 Claude Code / Codex / OpenCode 的 skills 目录
 *
 * 所有客户端都用同一种接法：启动本软件自带的 cli.cjs 的 mcp 子命令（标准输入输出），
 * 它再转给本机 MCP 服务。好处：端口、令牌变了也不用改配置；软件没开会自动拉起。
 *
 * 写配置一律「读出来 → 只改 windrise 这一项 → 写回」，并先备份原文件（.windrise-backup）。
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SERVER_NAME = "windrise";
const HOME = os.homedir();
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

/** 启动 cli.cjs 用的命令：本软件的可执行文件 + ELECTRON_RUN_AS_NODE（让它当 Node 用） */
function launcher(dataHome) {
  return {
    command: process.execPath,
    args: [path.join(__dirname, "cli.cjs")],
    env: { ELECTRON_RUN_AS_NODE: "1", BRIDGE_DATA_HOME: dataHome },
  };
}

function mcpEntry(dataHome) {
  const l = launcher(dataHome);
  return { command: l.command, args: [...l.args, "mcp"], env: l.env };
}

/* ---------------- 命令行 ---------------- */

function cliTarget() {
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
    return { dir: path.join(local, "Microsoft", "WindowsApps"), file: "windrise.cmd" };
  }
  return { dir: path.join(HOME, ".local", "bin"), file: "windrise" };
}

function cliScript(dataHome) {
  const l = launcher(dataHome);
  if (IS_WIN) {
    const ascii = /^[\x20-\x7e]*$/.test(l.command + l.args[0] + dataHome);
    return [
      "@echo off",
      // 路径里有中文时要切到 UTF-8 代码页，不然 cmd 读不对路径
      ...(ascii ? [] : ["chcp 65001 >nul"]),
      "setlocal",
      "set ELECTRON_RUN_AS_NODE=1",
      `set "BRIDGE_DATA_HOME=${dataHome}"`,
      `"${l.command}" "${l.args[0]}" %*`,
      "",
    ].join("\r\n");
  }
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh\n# Windrise Bridge 命令行（由软件生成）\nELECTRON_RUN_AS_NODE=1 BRIDGE_DATA_HOME=${q(dataHome)} exec ${q(l.command)} ${q(l.args[0])} "$@"\n`;
}

function cliStatus(dataHome) {
  const t = cliTarget();
  const file = path.join(t.dir, t.file);
  let installed = false, current = false;
  try {
    const text = fs.readFileSync(file, "utf8");
    installed = true;
    current = text === cliScript(dataHome);
  } catch { /* 没装 */ }
  const onPath = String(process.env.PATH || "").split(path.delimiter).some((p) => p && path.resolve(p).toLowerCase() === path.resolve(t.dir).toLowerCase());
  return { installed, current, file, onPath, command: "windrise" };
}

function installCli(dataHome) {
  const t = cliTarget();
  fs.mkdirSync(t.dir, { recursive: true });
  const file = path.join(t.dir, t.file);
  fs.writeFileSync(file, cliScript(dataHome), { mode: 0o755 });
  return cliStatus(dataHome);
}

/* ---------------- AI 客户端 ---------------- */

function claudeDesktopFile() {
  if (IS_MAC) return path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (IS_WIN) {
    // 微软商店版装在 Packages 下，配置目录被重定向
    const local = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
    try {
      const pkg = fs.readdirSync(path.join(local, "Packages")).find((n) => /^(AnthropicPBC\.)?Claude_/i.test(n));
      if (pkg) {
        const dir = path.join(local, "Packages", pkg, "LocalCache", "Roaming", "Claude");
        if (fs.existsSync(dir)) return path.join(dir, "claude_desktop_config.json");
      }
    } catch { /* 没有 Packages 目录 */ }
    return path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  }
  return path.join(HOME, ".config", "Claude", "claude_desktop_config.json");
}

const CLIENTS = [
  { key: "claude-desktop", name: "Claude 桌面版", kind: "json", file: claudeDesktopFile, detect: (f) => fs.existsSync(path.dirname(f)), restart: "需要完全退出 Claude（托盘里也退出）再打开" },
  { key: "cursor", name: "Cursor", kind: "json", file: () => path.join(HOME, ".cursor", "mcp.json"), detect: (f) => fs.existsSync(path.dirname(f)), restart: "在 Cursor 设置 → MCP 里打开 windrise 开关" },
  { key: "windsurf", name: "Windsurf", kind: "json", file: () => path.join(HOME, ".codeium", "windsurf", "mcp_config.json"), detect: (f) => fs.existsSync(path.dirname(f)), restart: "在 Windsurf 的 MCP 面板里点刷新" },
  { key: "claude-code", name: "Claude Code", kind: "json", file: () => path.join(HOME, ".claude.json"), detect: (f) => fs.existsSync(f) || fs.existsSync(path.join(HOME, ".claude")), restart: "重新打开 claude 命令行" },
  { key: "codex", name: "Codex", kind: "toml", file: () => path.join(HOME, ".codex", "config.toml"), detect: (f) => fs.existsSync(path.dirname(f)), restart: "重新打开 codex" },
  { key: "opencode", name: "OpenCode", kind: "opencode", file: () => path.join(HOME, ".config", "opencode", "opencode.json"), detect: (f) => fs.existsSync(path.dirname(f)), restart: "重新打开 opencode" },
  { key: "gemini-cli", name: "Gemini CLI", kind: "json", file: () => path.join(HOME, ".gemini", "settings.json"), detect: (f) => fs.existsSync(path.dirname(f)), restart: "重新打开 gemini 命令行" },
];

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); }
  catch { throw new Error(`${file} 不是合法的 JSON，为了不弄坏它没有改动。请先修好这个文件`); }
}

/** TOML：找出 [mcp_servers.windrise] 及其子表，整段去掉 */
function stripTomlServer(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let skipping = false;
  const head = new RegExp(`^\\s*\\[\\s*mcp_servers\\.("?)${SERVER_NAME}\\1(\\.[^\\]]+)?\\s*\\]\\s*$`);
  for (const line of lines) {
    if (/^\s*\[/.test(line)) skipping = head.test(line);
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
}

function tomlBlock(entry) {
  // 用单引号的「字面字符串」：Windows 路径里的反斜杠不用转义
  const lit = (s) => (String(s).includes("'") ? JSON.stringify(String(s)) : `'${s}'`);
  const env = Object.entries(entry.env).map(([k, v]) => `${k} = ${lit(v)}`).join(", ");
  return [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${lit(entry.command)}`,
    `args = [${entry.args.map(lit).join(", ")}]`,
    `env = { ${env} }`,
  ].join("\n");
}

/** OpenCode 的格式不一样：command 和 args 合成一个数组，env 叫 environment */
function opencodeEntry(entry) {
  return { type: "local", command: [entry.command, ...entry.args], environment: entry.env, enabled: true };
}

function hasEntry(client, file) {
  try {
    if (client.kind === "toml") {
      const text = fs.readFileSync(file, "utf8");
      return new RegExp(`^\\s*\\[\\s*mcp_servers\\.("?)${SERVER_NAME}\\1\\s*\\]`, "m").test(text);
    }
    if (client.kind === "opencode") return Boolean(readJson(file)?.mcp?.[SERVER_NAME]);
    return Boolean(readJson(file)?.mcpServers?.[SERVER_NAME]);
  } catch { return false; }
}

function clientsStatus() {
  return CLIENTS.map((c) => {
    const file = c.file();
    return { key: c.key, name: c.name, file, detected: c.detect(file), configured: hasEntry(c, file), restart: c.restart };
  });
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const to = `${file}.windrise-backup`;
  // 只备份第一次：保留的是改动之前的原样，重复写入不会把备份覆盖成改过的版本
  if (!fs.existsSync(to)) fs.copyFileSync(file, to);
  return to;
}

function installClient(key, dataHome) {
  const client = CLIENTS.find((c) => c.key === key);
  if (!client) throw new Error(`不认识的客户端：${key}`);
  const file = client.file();
  const entry = mcpEntry(dataHome);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backupFile = null;
  if (client.kind === "toml") {
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    backupFile = backup(file);
    const rest = stripTomlServer(text);
    fs.writeFileSync(file, (rest ? rest + "\n\n" : "") + tomlBlock(entry) + "\n");
  } else if (client.kind === "opencode") {
    const existed = fs.existsSync(file);
    const data = readJson(file);
    backupFile = backup(file);
    if (!data.mcp || typeof data.mcp !== "object") data.mcp = {};
    data.mcp[SERVER_NAME] = opencodeEntry(entry);
    const out = existed ? data : { $schema: "https://opencode.ai/config.json", ...data };
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  } else {
    const data = readJson(file);
    backupFile = backup(file);
    if (!data.mcpServers || typeof data.mcpServers !== "object") data.mcpServers = {};
    data.mcpServers[SERVER_NAME] = client.key === "claude-code" ? { type: "stdio", ...entry } : entry;
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  }
  return { key, name: client.name, file, backup: backupFile, restart: client.restart };
}

/** 通用配置（给列表里没有的客户端手动粘贴） */
function genericConfig(dataHome) {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: mcpEntry(dataHome) } }, null, 2);
}

/**
 * 引导页「连 AI」的按客户端填法：复用上面 CLIENTS 表（本机客户端）加远程客户端的通用填法，
 * 不另写一份数据。返回 [{ key, name, kind: "remote"|"local", hint }]；
 * 地址和请求头由引导页自己拼（地址是面板状态里的不带令牌公网地址），这里不掺。
 */
function clientGuides() {
  const remote = (key, name, hint) => ({ key, name, kind: "remote", hint });
  return [
    remote(
      "claude-web",
      "Claude 网页 / 手机",
      "在 Claude 的 MCP 连接里选「添加远程服务器」：地址填上面的公网 MCP 地址，请求头加 Authorization: Bearer 你的口令。手机端能不能自定义请求头以应用实际界面为准，请实测。",
    ),
    remote(
      "chatgpt",
      "ChatGPT",
      "ChatGPT 的 MCP 连接界面通常只能填地址、不能单独加请求头。支持请求头时加 Authorization: Bearer 你的口令；不支持就先改用 Claude、Codex、Cursor 这类能自定义请求头的客户端。",
    ),
    remote(
      "codex",
      "Codex（云端）",
      "本机命令行版在 Windrise 设置里一键写入（不用填地址和口令）；云端 Codex 填上面的公网 MCP 地址 + 请求头 Authorization: Bearer 你的口令。",
    ),
    remote(
      "cursor",
      "Cursor（远程）",
      "填上面的公网 MCP 地址 + 请求头 Authorization: Bearer 你的口令；本机版也可以在 Windrise 设置里一键写入。",
    ),
    remote(
      "deepseek",
      "DeepSeek",
      "DeepSeek 的接入界面以实际版本为准：地址填公网 MCP 地址，能自定义请求头就加 Authorization: Bearer 你的口令；没有 MCP 连接入口就用它的命令行 / IDE 插件，或换支持自定义 MCP 服务器的客户端。",
    ),
    ...CLIENTS.map((client) => ({
      key: client.key,
      name: client.name,
      kind: "local",
      hint: `本机客户端：在 Windrise 设置里点「一键写入」即可，不用手动填地址和口令。${client.restart}`,
    })),
  ];
}

/** 公网地址去掉路径里的令牌：https://xxx/mcp/<令牌> → https://xxx/mcp */
function publicMcpBase(publicMcpUrl) {
  const url = String(publicMcpUrl || "");
  return url ? url.replace(/\/mcp\/[^/?#]+\/?$/, "/mcp") : null;
}

/** 复制给 AI 的提示词：告诉对方有哪些工具、怎么用、哪些要先问用户 */
function promptText({ publicMcpUrl, pathEnabled = true } = {}) {
  const connection = publicMcpUrl
    ? pathEnabled
      ? ["", `网页版 AI 可以直接使用这个公开地址：${publicMcpUrl}（路径口令在地址里，请勿外传）`]
      : ["", `网页版 AI 用这个地址：${publicMcpBase(publicMcpUrl)}`, "连接时在请求头加：Authorization: Bearer 你的口令（口令在软件的「设置 → 口令入口」里生成）"]
    : [];
  return [
    "你可以通过名为 windrise 的 MCP 服务操作我电脑上的 Windrise Bridge 软件。",
    "",
    "常用工具：",
    "- windrise_status：查看软件状态（隧道、本机和公开 MCP 地址、账号数量）。不确定时先调用它。",
    "- windrise_tunnel：打通 / 重连 / 断开隧道（action = start / restart / stop）。断开和重连要带 confirm: true。",
    "- windrise_profiles：管理浏览器账号窗口（列出、新建、改名、打开、关闭、删除）。删除要带 confirm: true。",
    "- windrise_folders：查看、添加、移除 AI 可访问的文件夹（添加时我会在电脑上点允许）。",
    "- windrise_logs：查看最近的运行日志，排查问题时用。",
    "- windrise_show：把软件主界面叫到前台。",
    "此外还有 browser_* 工具可以操作这些账号窗口里的网页。",
    "",
    "规则：删除账号、断开或重连隧道之前，先用一句话告诉我要做什么，得到我同意后再执行。",
    ...connection,
  ].join("\n");
}

/* ---------------- Skill ---------------- */

/** 各家放 skill 的目录（skills 下面一层才是具体的 skill） */
const SKILL_TARGETS = [
  { key: "claude-code", name: "Claude Code", dir: () => path.join(HOME, ".claude", "skills"), detect: (d) => fs.existsSync(d) || fs.existsSync(path.dirname(d)) },
  { key: "codex", name: "Codex", dir: () => path.join(HOME, ".codex", "skills"), detect: (d) => fs.existsSync(d) || fs.existsSync(path.dirname(d)) },
  { key: "opencode", name: "OpenCode", dir: () => path.join(HOME, ".config", "opencode", "skills"), detect: (d) => fs.existsSync(d) || fs.existsSync(path.dirname(d)) },
];

const SKILL_NAME = /^[A-Za-z0-9_-]+$/;

function checkSkillName(name) {
  if (typeof name !== "string" || !SKILL_NAME.test(name)) throw new Error(`skill 名不合法：${name}`);
  return name;
}

/** 仓库里真实存在的 skill：子目录 + SKILL.md，名字还要过白名单 */
function listSkills(skillsRoot) {
  if (!fs.existsSync(skillsRoot)) return [];
  return fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && SKILL_NAME.test(e.name))
    .map((e) => e.name)
    .filter((name) => fs.existsSync(path.join(skillsRoot, name, "SKILL.md")))
    .sort();
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** 目录里所有文件的相对路径，统一用 /，方便写进清单和比较 */
function skillFiles(dir) {
  const out = [];
  const walk = (current, prefix) => {
    for (const e of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const full = path.join(current, e.name);
      if (e.isDirectory()) walk(full, rel);
      else if (e.isFile()) out.push(rel);
    }
  };
  walk(dir, "");
  return out.sort();
}

function hashFiles(dir, files = skillFiles(dir)) {
  const hashes = {};
  for (const rel of files) hashes[rel] = sha256File(path.join(dir, rel));
  return hashes;
}

function sameSkillDir(a, b) {
  const af = skillFiles(a);
  const bf = skillFiles(b);
  if (af.length !== bf.length || af.some((f, i) => f !== bf[i])) return false;
  return af.every((f) => sha256File(path.join(a, f)) === sha256File(path.join(b, f)));
}

function manifestPath(dataHome) {
  return path.join(dataHome, "skills-installed.json");
}

function readManifest(dataHome) {
  try {
    const raw = fs.readFileSync(manifestPath(dataHome), "utf8").replace(/^\uFEFF/, "");
    const data = JSON.parse(raw);
    return { version: 1, installs: Array.isArray(data?.installs) ? data.installs : [] };
  } catch { return { version: 1, installs: [] }; }
}

function writeManifest(dataHome, manifest) {
  fs.mkdirSync(dataHome, { recursive: true });
  fs.writeFileSync(manifestPath(dataHome), JSON.stringify(manifest, null, 2) + "\n");
}

function skillStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 每个目标 × 每个 skill：有没有这个 AI、装没装、装的版本和仓库一不一样 */
function skillsStatus(skillsRoot) {
  const skills = listSkills(skillsRoot);
  const out = [];
  for (const target of SKILL_TARGETS) {
    const dir = target.dir();
    const detected = target.detect(dir);
    for (const skill of skills) {
      const dest = path.join(dir, skill);
      const destMd = path.join(dest, "SKILL.md");
      const sourceMd = path.join(skillsRoot, skill, "SKILL.md");
      const installed = fs.existsSync(destMd);
      const current = installed && sha256File(sourceMd) === sha256File(destMd);
      out.push({ key: target.key, name: target.name, skill, dir: dest, detected, installed, current });
    }
  }
  return out;
}

/**
 * 把仓库里的 skill 复制到某个 AI。已有同名但内容不同的，先把旧目录整体改名备份。
 * dataHome 用来记安装清单（每个文件的 sha256），卸载时只删没被用户改过的。
 */
function installSkill(targetKey, skillsRoot, skillName, dataHome) {
  const target = SKILL_TARGETS.find((t) => t.key === targetKey);
  if (!target) throw new Error(`不认识的 skill 目标：${targetKey}`);
  checkSkillName(skillName);
  const source = path.join(skillsRoot, skillName);
  if (!listSkills(skillsRoot).includes(skillName)) throw new Error(`仓库里没有这个 skill：${skillName}`);

  const dir = target.dir();
  const dest = path.join(dir, skillName);
  fs.mkdirSync(dir, { recursive: true });

  let backup = null;
  if (fs.existsSync(dest) && !(fs.statSync(dest).isDirectory() && sameSkillDir(source, dest))) {
    const stamp = skillStamp();
    let backupName = `${skillName}.windrise-backup-${stamp}`;
    for (let i = 2; fs.existsSync(path.join(dir, backupName)); i += 1) backupName = `${skillName}.windrise-backup-${stamp}-${i}`;
    backup = path.join(dir, backupName);
    fs.renameSync(dest, backup);
  }
  if (!fs.existsSync(dest)) fs.cpSync(source, dest, { recursive: true });

  const files = skillFiles(dest);
  const installedAt = new Date().toISOString();
  const manifest = readManifest(dataHome);
  manifest.installs = manifest.installs.filter((i) => !(i.target === targetKey && i.skill === skillName));
  manifest.installs.push({ target: targetKey, skill: skillName, path: dest, installedAt, files: hashFiles(dest, files) });
  writeManifest(dataHome, manifest);

  return { key: targetKey, name: target.name, skill: skillName, dir: dest, backup, files, installedAt };
}

function removeEmptyDirs(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) if (e.isDirectory()) removeEmptyDirs(path.join(dir, e.name));
  try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); }
  catch { /* 非空或已经删了 */ }
}

/** 只删清单里记着、且 sha256 没变的文件；用户改过的留着并返回 */
function uninstallSkill(targetKey, skillName, dataHome) {
  const target = SKILL_TARGETS.find((t) => t.key === targetKey);
  if (!target) throw new Error(`不认识的 skill 目标：${targetKey}`);
  checkSkillName(skillName);

  const manifest = readManifest(dataHome);
  const entry = manifest.installs.find((i) => i.target === targetKey && i.skill === skillName);
  if (!entry) return { key: targetKey, skill: skillName, dir: null, removed: [], kept: [] };

  // 清单里的路径只认目标目录，清单被改坏也不去删别处
  const expected = path.resolve(target.dir(), skillName);
  const dir = entry.path && path.resolve(entry.path) === expected ? entry.path : expected;

  const removed = [];
  const kept = [];
  for (const [rel, want] of Object.entries(entry.files || {})) {
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).some((p) => p === "..")) continue;
    const file = path.join(dir, rel);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.isFile()) continue;
    if (sha256File(file) !== want) { kept.push(rel); continue; }
    fs.rmSync(file, { force: true });
    removed.push(rel);
  }

  removeEmptyDirs(dir);
  manifest.installs = manifest.installs.filter((i) => i !== entry);
  writeManifest(dataHome, manifest);
  return { key: targetKey, skill: skillName, dir, removed, kept };
}

module.exports = { cliStatus, installCli, clientsStatus, installClient, genericConfig, promptText, mcpEntry, SERVER_NAME, skillsStatus, installSkill, uninstallSkill, clientGuides };
