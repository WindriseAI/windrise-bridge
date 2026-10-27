// 管理员代理真机验收（普通权限运行）：node tools/broker-accept.mjs
import { createBrokerClient } from "../src/core/broker-client.js";
const c = createBrokerClient();
const out = [];
const ok = (name, pass, detail) => { out.push(`${pass ? "PASS" : "FAIL"}  ${name}  —— ${detail}`); };
try {
  const a = await c.runElevated("Get-Process");
  ok("自动档：Get-Process 直接执行", a.status === "executed" && a.code === 0, `status=${a.status} code=${a.code} 输出${(a.stdout||"").length}字`);
  const isAdmin = "[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators')";
  const p = await c.runElevated(isAdmin);
  ok("确认档：先返回待确认", p.status === "needs_confirm", `status=${p.status}`);
  if (p.status === "needs_confirm") {
    const id = p.pending_id ?? p.pendingId ?? p.id;
    const r = await c.confirmElevated(id, { command: isAdmin });
    ok("确认后以管理员身份执行", r.status === "executed" && /True/.test(r.stdout || ""), `status=${r.status} stdout=${(r.stdout||"").trim()}`);
    const again = await c.confirmElevated(id).catch((e) => ({ status: "error", reason: e.message }));
    ok("同一条确认不能用第二次", again.status !== "executed", `status=${again.status}`);
  }
  const n = await c.runElevated("format C: /q");
  ok("禁止档：format 被拒", n.status === "denied", `status=${n.status} ${n.reason || ""}`);
} catch (e) {
  out.push(`FAIL  连接管理员代理  —— ${e.message}`);
}
console.log(out.join("\n"));
console.log(out.every((l) => l.startsWith("PASS")) ? "\n全部通过" : "\n有失败项");
