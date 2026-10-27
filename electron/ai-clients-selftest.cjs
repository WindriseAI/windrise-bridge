/**
 * ai-clients 自测：在临时目录里跑一遍 OpenCode / Gemini CLI 的写入和 skill 安装 / 卸载，不碰真实配置。
 * 用法：node electron/ai-clients-selftest.cjs
 */

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "windrise-ai-clients-"));
process.env.USERPROFILE = tmp;
process.env.HOME = tmp;

try {
  fs.mkdirSync(path.join(tmp, ".gemini"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".config", "opencode"), { recursive: true });

  const opencodeFile = path.join(tmp, ".config", "opencode", "opencode.json");
  const geminiFile = path.join(tmp, ".gemini", "settings.json");
  const initial = { theme: "x", mcp: { other: { type: "remote", url: "http://a" } } };
  const original = JSON.stringify(initial, null, 2) + "\n";
  fs.writeFileSync(opencodeFile, original);

  const { installClient, clientsStatus } = require("./ai-clients.cjs");

  installClient("opencode", "D:/data");
  installClient("gemini-cli", "D:/data");

  const oc = JSON.parse(fs.readFileSync(opencodeFile, "utf8"));
  assert.equal(oc.theme, "x");
  assert.deepEqual(oc.mcp.other, { type: "remote", url: "http://a" });
  assert.equal(oc.mcp.windrise.type, "local");
  assert.ok(Array.isArray(oc.mcp.windrise.command));
  assert.equal(oc.mcp.windrise.command[0], process.execPath);
  assert.equal(oc.mcp.windrise.command.at(-1), "mcp");
  assert.equal(oc.mcp.windrise.environment.BRIDGE_DATA_HOME, "D:/data");
  assert.equal(oc.mcp.windrise.enabled, true);

  const gm = JSON.parse(fs.readFileSync(geminiFile, "utf8"));
  assert.equal(gm.mcpServers.windrise.args.at(-1), "mcp");

  const status = clientsStatus();
  assert.equal(status.find((c) => c.key === "opencode").configured, true);
  assert.equal(status.find((c) => c.key === "gemini-cli").configured, true);

  const before = fs.readFileSync(opencodeFile, "utf8");
  installClient("opencode", "D:/data");
  installClient("gemini-cli", "D:/data");
  assert.equal(fs.readFileSync(opencodeFile, "utf8"), before);

  const backupFile = `${opencodeFile}.windrise-backup`;
  assert.ok(fs.existsSync(backupFile));
  assert.equal(fs.readFileSync(backupFile, "utf8"), original);

  // 配置文件原本不存在时要带上 $schema
  fs.rmSync(opencodeFile, { force: true });
  installClient("opencode", "D:/data");
  assert.equal(JSON.parse(fs.readFileSync(opencodeFile, "utf8")).$schema, "https://opencode.ai/config.json");

  // ---- skill 一键安装 ----
  fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".config", "opencode"), { recursive: true });

  const skillsRoot = path.join(tmp, "repo", "skills");
  const demoSkill = path.join(skillsRoot, "demo-skill");
  fs.mkdirSync(demoSkill, { recursive: true });
  const skillText = "---\nname: demo-skill\ndescription: 自测用\n---\n\n# demo\n";
  const notesText = "- 第一行\n- 第二行\n";
  fs.writeFileSync(path.join(demoSkill, "SKILL.md"), skillText);
  fs.writeFileSync(path.join(demoSkill, "notes.md"), notesText);
  const dataHome = path.join(tmp, "data");

  const { skillsStatus, installSkill, uninstallSkill } = require("./ai-clients.cjs");

  const status0 = skillsStatus(skillsRoot);
  assert.equal(status0.length, 3);
  assert.ok(status0.every((s) => s.detected));
  assert.ok(status0.every((s) => !s.installed && !s.current));

  for (const key of ["claude-code", "codex", "opencode"]) installSkill(key, skillsRoot, "demo-skill", dataHome);

  const skillDirs = {
    "claude-code": path.join(tmp, ".claude", "skills", "demo-skill"),
    codex: path.join(tmp, ".codex", "skills", "demo-skill"),
    opencode: path.join(tmp, ".config", "opencode", "skills", "demo-skill"),
  };
  for (const dir of Object.values(skillDirs)) {
    assert.equal(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"), skillText);
    assert.equal(fs.readFileSync(path.join(dir, "notes.md"), "utf8"), notesText);
  }

  const manifestFile = path.join(dataHome, "skills-installed.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  assert.equal(manifest.installs.length, 3);
  assert.ok(manifest.installs.every((i) => i.path && i.installedAt && i.files["SKILL.md"] && i.files["notes.md"]));

  const status1 = skillsStatus(skillsRoot);
  assert.ok(status1.every((s) => s.installed && s.current));

  // 目标已有同名但内容不同：旧目录整体备份
  fs.writeFileSync(path.join(skillDirs.codex, "SKILL.md"), "旧版本\n");
  installSkill("codex", skillsRoot, "demo-skill", dataHome);
  const backups = fs.readdirSync(path.join(tmp, ".codex", "skills")).filter((n) => n.startsWith("demo-skill.windrise-backup-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(tmp, ".codex", "skills", backups[0], "SKILL.md"), "utf8"), "旧版本\n");
  assert.equal(fs.readFileSync(path.join(skillDirs.codex, "SKILL.md"), "utf8"), skillText);

  // 用户改过的文件不删，没改的删掉
  fs.writeFileSync(path.join(skillDirs.codex, "notes.md"), notesText + "- 我改的\n");
  const result = uninstallSkill("codex", "demo-skill", dataHome);
  assert.deepEqual([...result.kept].sort(), ["notes.md"]);
  assert.deepEqual([...result.removed].sort(), ["SKILL.md"]);
  assert.ok(fs.existsSync(path.join(skillDirs.codex, "notes.md")));
  assert.ok(!fs.existsSync(path.join(skillDirs.codex, "SKILL.md")));
  assert.equal(JSON.parse(fs.readFileSync(manifestFile, "utf8")).installs.length, 2);

  // 路径穿越一律拒绝
  assert.throws(() => installSkill("claude-code", skillsRoot, "../evil", dataHome), /不合法/);

  // ---- 给 AI 的连接说明：默认口令形态，只有路径入口开着才用带令牌地址 ----
  const { promptText } = require("./ai-clients.cjs");
  const pathPrompt = promptText({ publicMcpUrl: "https://demo.example.com/mcp/path-token-123", pathEnabled: true });
  assert.ok(pathPrompt.includes("https://demo.example.com/mcp/path-token-123"), "路径开着时没用带令牌地址");
  const bearerPrompt = promptText({ publicMcpUrl: "https://demo.example.com/mcp/path-token-123", pathEnabled: false });
  assert.ok(bearerPrompt.includes("https://demo.example.com/mcp"), "口令形态没给不带令牌的地址");
  assert.ok(!bearerPrompt.includes("path-token-123"), "口令形态泄露了路径令牌");
  assert.ok(bearerPrompt.includes("Authorization: Bearer 你的口令"), "口令形态没写请求头");

  console.log("ai-clients 自测通过");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
