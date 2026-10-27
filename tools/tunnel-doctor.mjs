/**
 * 命名隧道诊断：一条命令查清「为什么公网地址不通」。
 *
 * 这个脚本的价值在于**排查顺序** —— 这次的 530 花了四步才定位：
 *   ① 先看 DNS 指向哪条隧道（最容易忽略，也最常见）
 *   ② 再看那条隧道有没有连接器在跑
 *   ③ 再看配置在本地还是云端（云端会覆盖本地！）
 *   ④ 最后才看域名有没有匹配的规则
 *
 * 顺序反了就会像这次一样：改了半天本地配置，结果问题在 DNS 指向。
 *
 * 用法：
 *   node tools/tunnel-doctor.mjs                     # 自动读 ~/.cloudflared 的配置
 *   node tools/tunnel-doctor.mjs mcp.example.com     # 指定要查的域名
 */

import { readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import path from "node:path";

const run = promisify(execFile);
const CF_BIN = process.env.RELAY_CF_BIN ?? "cloudflared";
const cfDir = path.join(homedir(), ".cloudflared");

const findings = [];
const say = (level, text) => {
  findings.push({ level, text });
  const icon = { ok: "✓", warn: "!", bad: "✗", info: "·" }[level] ?? "·";
  console.log(`  ${icon} ${text}`);
};

console.log("");
console.log("命名隧道诊断");
console.log("=".repeat(74));

/* ---------- 读本地 cloudflared 配置 ---------- */
let localConfig = null;
try {
  localConfig = await readFile(path.join(cfDir, "config.yml"), "utf8");
} catch { /* 没有就算了 */ }

const tunnelRef = localConfig ? /^\s*tunnel:\s*(.+)$/m.exec(localConfig)?.[1]?.trim() : null;
const credsRef = localConfig ? /^\s*credentials-file:\s*(.+)$/m.exec(localConfig)?.[1]?.trim() : null;
const localHostnames = [...(localConfig ?? "").matchAll(/^\s*-?\s*hostname:\s*(.+)$/gm)].map((m) => m[1].trim());

const targetHost = process.argv[2] ?? localHostnames[0] ?? null;

console.log("");
console.log("【0】基本情况");
say("info", `cloudflared 配置目录：${cfDir}`);
say("info", `本地 config.yml：${localConfig ? "有" : "没有"}`);
if (tunnelRef) say("info", `本地配置里的隧道：${tunnelRef}`);
if (credsRef) say("info", `凭据文件：${credsRef}`);
if (targetHost) say("info", `要诊断的域名：${targetHost}`);

/* ---------- ① DNS 指向哪条隧道 ---------- */
console.log("");
console.log("【1】DNS 指向哪条隧道（最先查这个）");

const CF_IPV4 = /^(104\.2[0-9]\.|172\.6[4-9]\.|172\.7[0-1]\.|188\.114\.|190\.93\.|197\.234\.|198\.41\.|162\.15[89]\.|173\.245\.|103\.2[12]\.|141\.101\.)/;

let dnsTunnelId = null;
try {
  // 走 DoH，绕开本地可能存在的假 IP 代理
  const doh = await fetch(`https://cloudflare-dns.com/dns-query?name=${targetHost}&type=A`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(10000),
  });
  const data = await doh.json();
  const aRecords = (data.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);

  if (!aRecords.length) {
    say("bad", `查不到 ${targetHost} 的记录 —— 域名可能没配`);
  } else if (aRecords.some((ip) => CF_IPV4.test(ip))) {
    // 已代理的记录，Cloudflare 会把真实 CNAME 藏起来，公开 DNS 只能看到它的 IP
    say("ok", `${targetHost} 存在，且走 Cloudflare 代理（A → ${aRecords.slice(0, 2).join(", ")}）`);
    say("info", "已代理的记录，公开 DNS 看不到它指向哪条隧道，得走 API 查");
  } else {
    say("warn", `A → ${aRecords.join(", ")}（不是 Cloudflare 的 IP，说明没走隧道）`);
  }
} catch (error) {
  say("warn", `DNS 查询失败：${error.message}`);
}

/* ---------- ①b 有 API 凭据的话，查出真实指向 ---------- */
let apiCred = null;
try {
  const pem = await readFile(path.join(cfDir, "cert.pem"), "utf8");
  const b64 = /-----BEGIN ARGO TUNNEL TOKEN-----([\s\S]*?)-----END ARGO TUNNEL TOKEN-----/.exec(pem)?.[1]?.replace(/\s/g, "");
  if (b64) apiCred = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
} catch { /* 没有就算了 */ }

if (apiCred?.apiToken && apiCred?.zoneID) {
  say("info", "发现 cert.pem 里的 API 凭据，用它查真实指向（只读）");
  try {
    const H = { authorization: `Bearer ${apiCred.apiToken}` };
    const listed = await (await fetch(`https://api.cloudflare.com/client/v4/zones/${apiCred.zoneID}/dns_records?per_page=100`, {
      headers: H, signal: AbortSignal.timeout(20000),
    })).json();

    if (!listed.success) {
      say("warn", `API 查询失败：${JSON.stringify(listed.errors)}`);
    } else {
      const record = listed.result.find((r) => r.name === targetHost);
      if (!record) {
        say("bad", `API 里没有 ${targetHost} 这条记录`);
      } else {
        say("ok", `记录类型 ${record.type}，已代理=${record.proxied}`);
        const tid = /([0-9a-f-]{36})/.exec(record.content)?.[1];
        if (tid) {
          dnsTunnelId = tid;
          say("info", `真实指向隧道：${tid}`);
        } else {
          say("warn", `指向的不是隧道：${record.content}`);
        }

        // 顺便看看这个 zone 下所有指向隧道的记录，方便对照
        const tunnelRecords = listed.result.filter((r) => String(r.content).includes("cfargotunnel"));
        if (tunnelRecords.length > 1) {
          say("info", "这个域名下指向隧道的记录（对照用）：");
          for (const r of tunnelRecords) {
            const id = /([0-9a-f-]{36})/.exec(r.content)?.[1] ?? "?";
            say("info", `  ${r.name.padEnd(30)} → ${id.slice(0, 8)}…`);
          }
        }
      }
    }
  } catch (error) {
    say("warn", `API 查询异常：${error.message}`);
  }
} else {
  say("info", "没有 API 凭据，无法查出已代理记录的真实指向");
}

/* ---------- ② 本地凭据是哪条隧道 ---------- */
console.log("");
console.log("【2】本地凭据是哪条隧道");

let credTunnelId = null;
if (credsRef) {
  try {
    const cred = JSON.parse(await readFile(credsRef, "utf8"));
    credTunnelId = cred.TunnelID ?? null;
    say("info", `凭据文件里的 TunnelID：${credTunnelId}`);
    say("info", `账号 ID：${cred.AccountTag}`);
  } catch (error) {
    say("warn", `读不了凭据文件：${error.message}`);
  }
} else {
  // 目录里可能还有别的凭据
  try {
    const files = (await readdir(cfDir)).filter((f) => f.endsWith(".json"));
    say("info", `配置里没写凭据，目录下有 ${files.length} 个 json：${files.slice(0, 5).join(", ")}`);
  } catch { /* 忽略 */ }
}

if (dnsTunnelId && credTunnelId && dnsTunnelId !== credTunnelId) {
  say("bad", `不一致！DNS 指向 ${dnsTunnelId.slice(0, 8)}…，本地凭据是 ${credTunnelId.slice(0, 8)}…`);
  say("bad", "→ 这是最隐蔽的问题：改配置改到死也不会生效，因为压根不是同一条隧道");
} else if (dnsTunnelId && credTunnelId) {
  say("ok", "DNS 与本地凭据指向同一条隧道");
}

/* ---------- ③ 那条隧道有没有连接器 ---------- */
console.log("");
console.log("【3】隧道有没有连接器在跑（没连接器必然 530）");

const inspectId = dnsTunnelId ?? credTunnelId ?? tunnelRef;
if (inspectId) {
  try {
    const { stdout, stderr } = await run(CF_BIN, ["tunnel", "info", inspectId], { timeout: 30000 });
    const out = stdout + stderr;
    // 注意 EDGE 那列本身带空格（"1xsin14, 1xsin21"），所以最后一段必须吃到行尾，
    // 用 (\S+) 会在第一个空格处断掉，导致「明明有连接器却报没有」。
    const connectors = [...out.matchAll(/^([0-9a-f-]{36})\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/gm)];
    if (connectors.length) {
      say("ok", `有 ${connectors.length} 个连接器在线`);
      for (const c of connectors) say("info", `  ${c[1].slice(0, 8)}…  ${c[3]}  版本 ${c[4]}  边缘 ${c[6]}`);
    } else {
      say("bad", "没有任何连接器在跑 → 公网请求会 530");
      say("bad", "→ 需要启动 cloudflared（或检查它是不是崩了）");
    }
  } catch (error) {
    say("warn", `查不到隧道信息：${(error.message ?? "").split("\n")[0]}`);
  }
} else {
  say("warn", "不知道隧道 ID，跳过");
}

/* ---------- ④ 配置在本地还是云端 ---------- */
console.log("");
console.log("【4】配置在哪（云端会覆盖本地，这是第二常见的坑）");

say("info", "判断方法：看 cloudflared 日志里有没有 'Updated to new configuration ... version=N'");
say("info", "  有 version 号 → 用的是云端配置，改本地文件没用");
say("info", "  没有 → 用的本地配置");
if (localHostnames.length) {
  say("info", `本地配置里的域名：${localHostnames.join(", ")}`);
}
say("warn", "如果确认是云端配置，改法只能走 API 或后台：");
say("info", "  PUT /accounts/{账号ID}/cfd_tunnel/{隧道ID}/configurations");

/* ---------- ⑤ 实测一下 ---------- */
console.log("");
console.log("【5】实测");
if (targetHost) {
  try {
    const r = await fetch(`https://${targetHost}/`, { signal: AbortSignal.timeout(12000), redirect: "manual" });
    const body = await r.text().catch(() => "");
    if (r.status === 530) {
      say("bad", `HTTP 530（Cloudflare Tunnel error 1033）`);
      say("bad", "→ 域名到了隧道，但隧道里没有匹配这条域名的规则（或隧道没连接器）");
    } else if (r.status === 404 && body.includes("jsonrpc")) {
      say("ok", `HTTP 404 且返回 JSON-RPC 错误 —— 这是桥在正常应答（说明整条链路通了）`);
    } else if (r.status === 502) {
      say("warn", `HTTP 502 —— 隧道通了，但它指向的本机端口没服务在跑`);
    } else {
      say("info", `HTTP ${r.status}  ${body.slice(0, 60)}`);
    }
  } catch (error) {
    say("warn", `请求失败：${error.message}`);
  }
} else {
  say("info", "没指定域名，跳过");
}

/* ---------- 汇总 ---------- */
console.log("");
console.log("=".repeat(74));
const bad = findings.filter((f) => f.level === "bad");
if (!bad.length) {
  console.log("没发现明显问题。");
} else {
  console.log(`发现 ${bad.length} 个问题：`);
  for (const f of bad) console.log(`  ✗ ${f.text}`);
}
console.log("");
console.log("排查顺序（别反了）：");
console.log("  1. DNS 指向哪条隧道    ← 最常见，也最容易被跳过");
console.log("  2. 那条隧道有没有连接器");
console.log("  3. 配置在本地还是云端  ← 云端会覆盖本地");
console.log("  4. 域名有没有匹配规则");
console.log("");
