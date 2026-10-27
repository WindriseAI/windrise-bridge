/**
 * Cloudflare API 客户端 —— 用来「一键开通固定公网地址」。
 *
 * 为什么要有这个：
 *   手动开一条隧道要四步 —— 建隧道、拿令牌、配 ingress、配 DNS。
 *   对普通用户来说这四步每步都能卡住（尤其「DNS 指向哪条隧道」这个坑，
 *   配错了现象是 530，完全看不出原因）。
 *   这个模块把四步合成一次调用，并且**先给出预览再执行**。
 *
 * 凭据从哪来（按优先级）：
 *   ① 设置里填的 API 令牌
 *   ② ~/.cloudflared/cert.pem —— 里面其实是一段 base64 的 JSON，
 *      解出来是 {zoneID, accountID, apiToken}，是**账号级权限**
 *
 * 安全约定：
 *   · 令牌只在请求头里用，**任何日志、错误信息、返回值都不带令牌**
 *   · 所有写操作都要调用方显式确认（本模块不做二次确认，由界面负责）
 */

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 20000;

/** 把令牌抹掉，避免它出现在日志或错误信息里 */
function redact(text) {
  if (typeof text !== "string") return text;
  return text.replace(/\b(cfut_|cf_)[A-Za-z0-9_-]{10,}/g, "$1<已隐藏>");
}

class CloudflareError extends Error {
  constructor(message, { status, codes } = {}) {
    super(redact(message));
    this.name = "CloudflareError";
    this.status = status;
    this.codes = codes ?? [];
  }
}

export class CloudflareClient {
  constructor({ token, accountId, zoneId } = {}) {
    this.token = token ?? null;
    this.accountId = accountId ?? null;
    this.zoneId = zoneId ?? null;
  }

  get ready() {
    return Boolean(this.token && this.accountId);
  }

  async #request(method, endpoint, body) {
    if (!this.token) throw new CloudflareError("没有 API 令牌");
    const response = await fetch(`${API}${endpoint}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success === false) {
      const errors = payload?.errors ?? [];
      const message = errors.map((e) => `${e.code} ${e.message}`).join("；") || `HTTP ${response.status}`;
      throw new CloudflareError(`Cloudflare API 出错：${message}`, {
        status: response.status,
        codes: errors.map((e) => e.code),
      });
    }
    return payload?.result;
  }

  /* ---------------- 只读 ---------------- */

  async verify() {
    const result = await this.#request("GET", "/user/tokens/verify");
    return { id: result?.id, status: result?.status };
  }

  async listZones() {
    const result = await this.#request("GET", "/zones?per_page=50");
    return (result ?? []).map((z) => ({ id: z.id, name: z.name, status: z.status, accountId: z.account_id }));
  }

  async listTunnels() {
    if (!this.accountId) throw new CloudflareError("没有账号 ID");
    const result = await this.#request("GET", `/accounts/${this.accountId}/cfd_tunnel?is_deleted=false&per_page=100`);
    return (result ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      connections: (t.connections ?? []).length,
      createdAt: t.created_at,
    }));
  }

  async listDnsRecords(zoneId) {
    const id = zoneId ?? this.zoneId;
    if (!id) throw new CloudflareError("没有 zone ID");
    const result = await this.#request("GET", `/zones/${id}/dns_records?per_page=100`);
    return (result ?? []).map((r) => ({ id: r.id, type: r.type, name: r.name, content: r.content, proxied: r.proxied }));
  }

  /** 找出 hostname 属于哪个 zone（取最长匹配，比如 a.b.example.com 应该匹配 example.com 而不是 com） */
  async findZoneFor(hostname) {
    const zones = await this.listZones();
    const lower = String(hostname).toLowerCase();
    const matches = zones
      .filter((z) => lower === z.name || lower.endsWith(`.${z.name}`))
      .sort((a, b) => b.name.length - a.name.length);
    return matches[0] ?? null;
  }

  /* ---------------- 写操作 ---------------- */

  /** 建隧道。config_src 用 cloudflare（远端配置），这样本地不用维护配置文件。 */
  async createTunnel(name) {
    if (!this.accountId) throw new CloudflareError("没有账号 ID");
    const result = await this.#request("POST", `/accounts/${this.accountId}/cfd_tunnel`, {
      name,
      config_src: "cloudflare",
    });
    return { id: result.id, name: result.name, token: result.token ?? null };
  }

  /** 拿连接器令牌（本地跑 cloudflared 时用） */
  async getTunnelToken(tunnelId) {
    if (!this.accountId) throw new CloudflareError("没有账号 ID");
    const result = await this.#request("GET", `/accounts/${this.accountId}/cfd_tunnel/${tunnelId}/token`);
    return typeof result === "string" ? result : (result?.token ?? null);
  }

  /** 配 ingress：把 hostname 转到本机端口 */
  async setTunnelIngress(tunnelId, hostname, localPort) {
    if (!this.accountId) throw new CloudflareError("没有账号 ID");
    return this.#request("PUT", `/accounts/${this.accountId}/cfd_tunnel/${tunnelId}/configurations`, {
      config: {
        ingress: [
          { hostname, service: `http://127.0.0.1:${localPort}` },
          { service: "http_status:404" },
        ],
      },
    });
  }

  /** 建 DNS 记录：CNAME 指向 <隧道ID>.cfargotunnel.com */
  async createDnsRecord(zoneId, hostname, tunnelId) {
    const id = zoneId ?? this.zoneId;
    if (!id) throw new CloudflareError("没有 zone ID");
    return this.#request("POST", `/zones/${id}/dns_records`, {
      type: "CNAME",
      name: hostname,
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
      comment: "由 bridge-replica 自动创建",
    });
  }

  /** 改已有 DNS 记录（比如原来指向别的隧道） */
  async updateDnsRecord(zoneId, recordId, tunnelId) {
    const id = zoneId ?? this.zoneId;
    return this.#request("PUT", `/zones/${id}/dns_records/${recordId}`, {
      type: "CNAME",
      name: undefined, // 不改名字
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
      comment: "由 bridge-replica 自动创建",
    });
  }

  /* ---------------- 组合：预览 + 执行 ---------------- */

  /**
   * 先算清楚「要做哪些事」，但**什么都不改**。
   *
   * 界面拿这个结果给用户看，用户确认了再调 provision()。
   * 这样用户能看清「会新建一条隧道」「会覆盖一条已有的 DNS 记录」这类事实。
   */
  async preview({ hostname, tunnelName, localPort }) {
    const zone = await this.findZoneFor(hostname);
    if (!zone) {
      const zones = await this.listZones();
      return {
        ok: false,
        error: `域名 ${hostname} 不属于账号里的任何 zone`,
        availableZones: zones.map((z) => z.name),
      };
    }

    const tunnels = await this.listTunnels();
    const existingTunnel = tunnels.find((t) => t.name === tunnelName) ?? null;

    const records = await this.listDnsRecords(zone.id);
    const existingRecord = records.find((r) => r.name.toLowerCase() === hostname.toLowerCase()) ?? null;

    const steps = [];
    steps.push(existingTunnel
      ? { action: "reuse-tunnel", describe: `复用已有隧道「${tunnelName}」（${existingTunnel.id}）` }
      : { action: "create-tunnel", describe: `新建隧道「${tunnelName}」` });
    steps.push({
      action: "set-ingress",
      describe: `把 ${hostname} 的流量转到本机 http://127.0.0.1:${localPort}`,
    });
    if (existingRecord) {
      steps.push({
        action: "update-dns",
        describe: `改已有 DNS 记录：${existingRecord.type} ${existingRecord.name} → ${existingRecord.content}` +
          `（会改成指向新隧道）`,
        warning: /cfargotunnel\.com$/.test(existingRecord.content)
          ? "这条记录现在指向另一条隧道，改掉它会影响正在用那条隧道的服务"
          : "这条记录现在指向别的地址（不是隧道），改掉它会影响原有用途",
      });
    } else {
      steps.push({ action: "create-dns", describe: `新建 DNS 记录：CNAME ${hostname} → <隧道>.cfargotunnel.com` });
    }

    return {
      ok: true,
      zone: { id: zone.id, name: zone.name },
      tunnel: existingTunnel ? { id: existingTunnel.id, name: existingTunnel.name, existing: true } : { name: tunnelName, existing: false },
      dns: existingRecord ? { ...existingRecord, existing: true } : { existing: false },
      steps,
      /** 有警告就是「会动到已有的东西」，界面必须让用户看清楚 */
      hasWarning: steps.some((s) => s.warning),
    };
  }

  /**
   * 真正执行。调用方必须先让用户确认过 preview。
   *
   * 顺序有讲究：先建隧道 → 再配 ingress → 最后改 DNS。
   * DNS 放最后是因为「DNS 指向的隧道还没配好」会出现 530，
   * 反过来则是「隧道配好了但没人访问」，后者无害。
   */
  async provision({ hostname, tunnelName, localPort, zoneId, tunnelId, dnsRecordId }) {
    const done = [];
    let tunnel = tunnelId ? { id: tunnelId, name: tunnelName } : null;

    if (!tunnel) {
      const created = await this.createTunnel(tunnelName);
      tunnel = { id: created.id, name: created.name };
      done.push(`已建隧道「${tunnelName}」（${created.id}）`);
    } else {
      done.push(`复用隧道「${tunnelName}」（${tunnel.id}）`);
    }

    await this.setTunnelIngress(tunnel.id, hostname, localPort);
    done.push(`已配转发：${hostname} → 127.0.0.1:${localPort}`);

    if (dnsRecordId) {
      await this.updateDnsRecord(zoneId, dnsRecordId, tunnel.id);
      done.push(`已更新 DNS 记录指向新隧道`);
    } else {
      await this.createDnsRecord(zoneId, hostname, tunnel.id);
      done.push(`已建 DNS 记录：${hostname} → ${tunnel.id}.cfargotunnel.com`);
    }

    const token = await this.getTunnelToken(tunnel.id).catch(() => null);
    done.push(token ? "已取到连接器令牌" : "（连接器令牌没取到，可能需要手动跑 cloudflared tunnel login）");

    return { ok: true, tunnelId: tunnel.id, tunnelName: tunnel.name, hostname, token, done };
  }
}

/* ------------------------------------------------------------------ *
 * 凭据发现
 * ------------------------------------------------------------------ */

/**
 * 找可用凭据。按优先级：显式传入 → cert.pem。
 *
 * cert.pem 的真相：它不是证书，是一段 base64 的 JSON。
 * 文件名骗人，但这是 cloudflared 自己写的格式，只能照着读。
 */
export async function discoverCredentials({ token, accountId, zoneId, certPath } = {}) {
  if (token) {
    return { token, accountId: accountId ?? null, zoneId: zoneId ?? null, source: "设置里填的令牌" };
  }

  const file = certPath ?? path.join(os.homedir(), ".cloudflared", "cert.pem");
  try {
    const raw = await readFile(file, "utf8");
    const base64 = raw.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    const parsed = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
    if (!parsed?.apiToken) {
      return { token: null, error: `${file} 里没有 apiToken 字段` };
    }
    return {
      token: parsed.apiToken,
      accountId: parsed.accountID ?? accountId ?? null,
      zoneId: parsed.zoneID ?? zoneId ?? null,
      source: `${file}（cloudflared 登录时留下的凭据，账号级权限）`,
      certPath: file,
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        token: null,
        error: `没找到 ${file}。要么先在命令行跑一次 cloudflared tunnel login，要么在设置里直接填 API 令牌。`,
      };
    }
    return { token: null, error: `读 ${file} 失败：${redact(error.message)}` };
  }
}

export { CloudflareError, redact };
