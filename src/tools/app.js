/**
 * windrise_* 工具 —— 让外部 AI 操作 Windrise Bridge 软件本身
 * （状态、隧道、账号窗口、文件夹、日志）。
 *
 * 和浏览器工具一样走本机控制服务（/control/<令牌>/app/<名字>），由 Electron 主进程执行，
 * 效果和在界面上点按钮完全一样。
 */

import { Capability } from "../core/registry.js";
import { callControl } from "./browser.js";

const app = (name, params, timeoutMs = 120_000) => callControl(`app/${name}`, params, { timeoutMs });
const reply = (text, data) => ({ content: [{ type: "text", text }], structuredContent: data });
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

function statusText(s) {
  const lic = s.license || {};
  const lines = [
    `${s.app} ${s.version}`,
    `激活：${lic.activated ? `已激活${lic.daysLeft != null ? `（剩 ${lic.daysLeft} 天）` : ""}` : `未激活 —— ${lic.reason || ""}`}`,
    `连接：${s.connection.label}${s.connection.detail ? `（${s.connection.detail}）` : ""}${s.connection.error ? ` —— ${s.connection.error}` : ""}`,
    `本机 MCP：${s.bridge.localMcpUrl || "（未启动）"}`,
    `公开 MCP：${s.connection.publicMcpUrl || "（隧道未打通）"}`,
    ...(s.publicCheck ? [`公网实测：${s.publicCheck.summary}`] : []),
    ...(s.activity ? [`活动：${s.activity.summary}`] : []),
    ...(Number.isFinite(s.edge?.readyConnections) ? [`边缘连接：${s.edge.readyConnections} 条（cloudflared 自报）`] : []),
    `账号窗口：${s.profiles.total} 个，打开 ${s.profiles.open} 个`,
  ];
  lines.push(`AI 可访问的文件夹：${(s.folders || []).join("；") || "—"}`);
  return lines.join("\n");
}

export function defineAppTools() {
  return [
    {
      name: "windrise_status",
      title: "查看软件状态",
      capability: Capability.READ,
      description: "查看 Windrise Bridge 软件状态：版本、激活情况（是否已激活、剩余天数，不含激活码）、隧道是否打通、本机和公开 MCP 地址、账号窗口数量、AI 可访问的文件夹，以及公网实测结果（几点验证过、连续失败几次）。还会显示当前会话数和最后一次经公网的请求时间。不确定软件状态时先调用它。",
      inputSchema: obj({}),
      handler: async () => { const s = await app("status", {}); return reply(statusText(s), s); },
    },
    {
      name: "windrise_tunnel",
      title: "隧道：打通 / 重连 / 断开",
      capability: Capability.EXECUTE,
      description: "控制隧道（让网页版 AI 能连到本机的公开地址）。action：status 查看、start 打通、restart 重连、stop 断开。restart 和 stop 必须带 confirm: true，并且要先征得用户同意 —— 如果你正是通过这条隧道连进来的，断开后你会失去连接。",
      inputSchema: obj({
        action: { type: "string", enum: ["status", "start", "restart", "stop"] },
        provider: { type: "string", description: "连接方式（可省略，默认用上次选的）：cloudflare / cloudflare-named / ngrok" },
        confirm: { type: "boolean", description: "restart / stop 时必须为 true" },
      }, ["action"]),
      handler: async (input) => {
        const r = await app("tunnel", { op: input.action, provider: input.provider, confirm: input.confirm });
        if (r.message) return reply(r.message, r);
        const c = r.connection;
        return reply(`连接：${c.label}${c.error ? ` —— ${c.error}` : ""}${c.publicMcpUrl ? `\n公开 MCP：${c.publicMcpUrl}` : ""}`, r);
      },
    },
    {
      name: "windrise_profiles",
      title: "管理账号窗口（格子）",
      capability: Capability.EXECUTE,
      description: [
        "管理多开浏览器的账号窗口（每个账号登录态互相隔离）。Windrise 浏览器下每个窗口就是一个「格子」，默认布局里左上角是 slot 1。",
        "action：list 列出（含 slot 和是否收起）、create 新建（name，可选 url / site）、rename 改名（id + new_name）、open 打开（id，可选 url）、close 关闭（登录态保留）、delete 删除（必须 confirm: true，先征得用户同意；purge: true 会同时清空登录数据）、",
        "layout 换布局（layout = 1x1 / 1x2 / 2x2 / 3x3；可选 id 作为基准格子，被点的格子变 slot 1，不传就用当前 slot 1；不够的格子会自动新建「格子 N」，多余的格子不关、只收起）、",
        "show 把某个格子摆回屏幕内（人要操作时用）、hide 把某个格子收起（挪到屏幕外，进程和登录态都保留）。",
        "Agent 应用 slot 或账号 id 指明操作哪个格子；id 参数认「格子 2」「slot:2」「2」这三种编号写法，也认账号 id / 名字。",
      ].join(""),
      inputSchema: obj({
        action: { type: "string", enum: ["list", "create", "rename", "open", "close", "delete", "layout", "show", "hide"] },
        id: { type: "string", description: "账号 id、名字，或格子编号（格子 2 / slot:2 / 2）" },
        name: { type: "string", description: "create 时的名字" },
        new_name: { type: "string", description: "rename 时的新名字" },
        url: { type: "string" },
        site: { type: "string", description: "create 时的站点标记（可选，仅用于分组显示）" },
        layout: { type: "string", enum: ["1x1", "1x2", "2x2", "3x3"], description: "layout 时用：1x1 / 1x2（左右两格）/ 2x2 / 3x3" },
        purge: { type: "boolean" },
        confirm: { type: "boolean" },
      }, ["action"]),
      handler: async (input) => {
        const r = await app("profiles", { op: input.action, id: input.id, name: input.name, newName: input.new_name, url: input.url, site: input.site, layout: input.layout, purge: input.purge, confirm: input.confirm });
        if (r.profiles && input.action === "list") {
          const text = r.profiles.length ? r.profiles.map((p) => {
            const grid = p.slot ? `[格子 ${p.slot}]${p.hidden ? "（已收起）" : ""} ` : (p.hidden ? "[已收起] " : "");
            return `${grid}${p.running ? "运行中" : "未打开"}  ${p.name}  id=${p.id}${p.site ? `  [${p.site}]` : ""}  ${p.url || ""}`;
          }).join("\n") : "还没有账号窗口";
          return reply(text, r);
        }
        if (r.layout) {
          const created = (r.created || []).map((p) => `${p.name}(格子 ${p.slot})`).join("、");
          const text = `布局已切到 ${r.layout}：已开格子 ${r.assigned?.length ?? 0} 个就位${created ? `，新建 ${created}` : ""}${r.hidden?.length ? `，收起 ${r.hidden.length} 个` : ""}`;
          return reply(text, r);
        }
        const text = r.profile ? `已新建「${r.profile.name}」 id=${r.profile.id}`
          : r.renamed ? `已改名：${r.renamed.from} → ${r.renamed.to}`
          : r.deleted ? `已删除「${r.deleted.name}」${r.deleted.purged ? "（登录数据已清空）" : "（登录数据保留）"}`
          : r.opened ? `已打开「${r.opened.name}」`
          : r.shown ? `已把「${r.shown.name}」摆回屏幕内${r.shown.slot ? `（格子 ${r.shown.slot}）` : ""}`
          : r.hidden && r.hidden.name ? `已收起「${r.hidden.name}」`
          : r.closed ? `已关闭「${r.closed.name}」` : "完成";
        return reply(text, r);
      },
    },
    {
      name: "windrise_folders",
      title: "AI 可访问的文件夹",
      capability: Capability.EXECUTE,
      description: "查看或修改 AI 能读写的文件夹。action：list、add（path；会在用户电脑上弹窗，用户点「允许」才生效，最多等 10 分钟）、remove（path）。",
      inputSchema: obj({ action: { type: "string", enum: ["list", "add", "remove"] }, path: { type: "string" } }, ["action"]),
      handler: async (input) => {
        const r = await app("folders", { op: input.action, path: input.path }, 10 * 60_000);
        const head = r.added ? `已添加：${r.added}\n` : r.removed ? `已移除：${r.removed}\n` : r.unchanged ? "这个文件夹本来就在列表里\n" : "";
        return reply(`${head}当前文件夹：\n${(r.folders || []).join("\n")}`, r);
      },
    },
    {
      name: "windrise_logs",
      title: "查看运行日志",
      capability: Capability.READ,
      description: "查看软件最近的运行日志（排查隧道、浏览器问题时用）。kind 可筛选：tunnel / browser / bridge / license / app。",
      inputSchema: obj({ limit: { type: "integer", minimum: 1, maximum: 500 }, kind: { type: "string" }, level: { type: "string", enum: ["ok", "warn", "err"] } }),
      handler: async (input) => {
        const r = await app("logs", input);
        const text = r.logs.length ? r.logs.map((l) => `${l.at}  [${l.kind}]${l.level !== "info" ? ` ${l.level}` : ""}  ${l.text}`).join("\n") : "没有日志";
        return reply(text, r);
      },
    },
    {
      name: "windrise_show",
      title: "显示软件界面",
      capability: Capability.EXECUTE,
      description: "把 Windrise Bridge 主界面叫到前台（需要用户在电脑上操作时用，比如登录账号）。tab 可选：bridge / browser / tools / context / settings。",
      inputSchema: obj({ tab: { type: "string", enum: ["bridge", "browser", "tools", "context", "settings"] } }),
      handler: async (input) => { await app("show", { tab: input.tab }); return reply("已把软件主界面叫到前台", { shown: true }); },
    },
  ];
}
