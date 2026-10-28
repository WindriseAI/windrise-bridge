/**
 * 设置存储：一个 JSON 文件，带默认值和原子写入。
 *
 * 为什么单独写一个而不是用 electron-store：
 *   只有十来个字段，自己写能保证「读坏了不崩、写一半不烂」，
 *   而且不用多一个依赖。设置坏了应该回退到默认值继续跑，
 *   绝不能因为一个配置文件读不了就开不了机。
 */

const { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

/** 默认设置。新增字段直接加这里，老配置文件缺字段会自动补上。 */
const DEFAULTS = {
  /** Bridge 监听端口。0 = 随机（最安全）。接命名隧道时必须固定。 */
  port: 48272,
  /** 允许文件工具访问的根目录 */
  roots: [],
  /** 用户确认过工作区（看过「AI 能访问哪些文件夹」的引导，或自己改过）—— 没确认过，隧道打通后会提示一次 */
  workspaceConfirmed: false,
  /** 危险命令需人工确认 */
  approveDangerous: false,
  /** 对外暴露的工具档位：basic（默认，基本功能 + 浏览器操作 + 鼠标兜底）| full（全部，含私人外接） */
  toolTier: "basic",
  /** 隧道 OAuth（默认关闭）：ChatGPT 这类只能填网址的客户端走 OAuth；老路径 / 口令入口不受影响 */
  oauthEnabled: false,
  /** 已按新规则（命令默认自动执行）迁移过老设置 */
  approvalAutoV2: false,
  /** 只读命令自动放行 */
  autoAllowReadonly: true,
  /** 默认边跑边回（SSE），长工具调用每 15 秒发心跳，不会被 Cloudflare 100 秒掐断；某个客户端不认 SSE 时再打开 */
  jsonResponse: false,
  /** 已把老配置里的 jsonResponse 迁移成边跑边回 */
  responseModeV2: false,
  /** 开机自启 */
  autoLaunch: false,
  /** 启动时自动打开「格子 1」（打开软件 = 出浏览器，浏览器是门面；关掉就只留托盘） */
  openGridOnStart: true,
  /** 开机自启时也自动打开格子 1（默认关：一开机不弹浏览器，只起后台 + 托盘） */
  openGridOnAutostart: false,
  /** 启动程序时自动起 Bridge */
  autoStartBridge: true,
  /** 打开软件自动连接：起 Bridge 后按上次用的隧道类型自动打通 */
  autoConnect: false,
  /** 用户自己选的连接方式：cloudflare（快速隧道）| cloudflare-named（固定地址）| ngrok；空 = 还没选 */
  connectChoice: "",
  /** 用户已经在「选择连接方式」里做过选择（没选过之前打开软件不会自动连接） */
  connectChoiceDone: false,
  /** 自动检查更新（手动检查不受影响） */
  autoUpdate: true,
  /** 用户点了「跳过此版本」的版本号（强制更新不受影响） */
  skipVersion: "",
  /** 更新渠道：stable（默认）| beta（测试用） */
  updateChannel: "stable",
  /** 关闭主窗口时缩到托盘（Bridge 和隧道继续在后台跑） */
  closeToTray: true,
  /** 显示 AI 光标和控制条：AI 操作网页时在页面上画虚拟光标、顶部提示和「接管 / 终止任务」按钮 */
  showAgentCursor: true,
  /**
   * 流程回放允许真正执行（默认关）：关着时 flow_replay 只做预演、列出步骤和不支持项，一步都不执行；
   * 带 execute:true 会返回 FEATURE_DISABLED。打开后才允许真正操作页面。
   */
  flowReplayExecute: false,
  /** 新装的插件自动装到所有格子（默认开）：关掉后新插件只在侧边栏列出来，等人手动点「装到所有格子」 */
  extAutoSync: true,
  /** AI 空间空闲多久自动收摊（分钟）：5 / 10 / 30；0 = 永不（不关闭，空闲 10 分钟后只卸载后台标签页） */
  idleMinutes: 10,
  /** 初次设置引导（引导页 8 步）走完了吗：false = 格子 1 打开时在它里面弹引导页 */
  onboardingDone: false,
  /** 命名隧道配置（空 = 不用固定地址） */
  tunnel: {
    /** 公网域名，例如 mcp.example.com */
    hostname: "",
    /** 隧道 ID 或名字 */
    tunnelId: "",
    /** 凭据文件绝对路径；留空则自动找 */
    credentials: "",
    /** 仪表板管理模式下的一长串令牌（与 tunnelId 二选一） */
    token: "",
    /** ngrok 的 authtoken（ngrok v3 必填） */
    ngrokAuthtoken: "",
    /** ngrok 固定域名（可选，免费版没有） */
    ngrokDomain: "",
    /** cloudflared 连边缘的路线：auto（直连不通且有代理就走中继）| direct | proxy */
    edgeRoute: "auto",
    /** 中继用的代理，如 http://127.0.0.1:7897；留空则读 HTTPS_PROXY / 系统代理 */
    edgeProxy: "",
    /** 上次打通用的路线（direct / direct-tcp / relay），下次优先试 */
    lastRoute: "",
    /** 启动 Bridge 后自动起隧道 */
    autoStart: false,
    /** 上次成功打通用的隧道类型（自动连接时沿用） */
    lastProvider: "",
  },
  /** Cloudflare API 凭据（一键开通固定地址用；留空则自动读 cert.pem） */
  cloudflare: {
    apiToken: "",
    accountId: "",
  },
  /*
   * MemOS 的 API Key 不放在这里：它只写进 <数据目录>/external-mcp.json 的 memos 条目，
   * 由外部 MCP 管理器直接读取（见 electron/memos-bridge.cjs）。
   * 设置文件会整份回给渲染层，不适合再存一份密钥。
   */
};

function settingsFile(dataHome) {
  return path.join(dataHome, "settings.json");
}

/** 把读到的对象和默认值深合并（只认已知字段，不塞垃圾进来；已下线功能的旧字段静默忽略） */
function merge(defaults, loaded) {
  if (!loaded || typeof loaded !== "object") return { ...defaults };
  const out = { ...defaults };
  for (const key of Object.keys(defaults)) {
    const value = loaded[key];
    if (value === undefined) continue;
    if (defaults[key] && typeof defaults[key] === "object" && !Array.isArray(defaults[key])) {
      out[key] = merge(defaults[key], value);
    } else if (Array.isArray(defaults[key])) {
      if (Array.isArray(value)) out[key] = value.filter((v) => typeof v === "string");
    } else if (typeof value === typeof defaults[key]) {
      out[key] = value;
    }
  }
  return out;
}

class SettingsStore {
  #file;
  #cache = null;
  #warned = false;

  constructor(dataHome) {
    this.#file = settingsFile(dataHome);
  }

  get file() {
    return this.#file;
  }

  /**
   * 读设置。读不到 / 读坏了都返回默认值 —— 绝不抛。
   * 坏文件会被改名留档（不是删掉），方便事后看是什么问题。
   */
  load() {
    if (this.#cache) return this.#cache;
    try {
      const raw = readFileSync(this.#file, "utf8");
      const parsed = JSON.parse(raw);
      this.#cache = merge(DEFAULTS, parsed);
      return this.#cache;
    } catch (error) {
      if (error.code !== "ENOENT" && !this.#warned) {
        this.#warned = true;
        // 读坏了：改名留档，别删 —— 用户可能想知道为什么设置没生效
        const broken = `${this.#file}.broken-${Date.now()}`;
        try {
          renameSync(this.#file, broken);
          console.error(`[settings] 设置文件读不了（${error.message}），已改名留档到 ${broken}，本次用默认值`);
        } catch {
          console.error(`[settings] 设置文件读不了（${error.message}），本次用默认值`);
        }
      }
      this.#cache = { ...DEFAULTS };
      return this.#cache;
    }
  }

  /** 合并写入（只改传入的字段）。临时文件 + rename，写一半断电不会烂。 */
  save(patch) {
    const next = merge(this.load(), patch);
    mkdirSync(path.dirname(this.#file), { recursive: true });
    const temp = `${this.#file}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(next, null, 2), "utf8");
    try {
      renameSync(temp, this.#file);
    } catch (error) {
      // Windows 上 rename 覆盖被占用的文件会 EPERM（和 context-bus 那个坑同源）。
      // 设置文件读得没那么频繁，简单重试几次就够。
      let lastError = error;
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          const until = Date.now() + 5 * (attempt + 1);
          while (Date.now() < until) { /* 忙等一小会儿 */ }
          renameSync(temp, this.#file);
          lastError = null;
          break;
        } catch (retryError) {
          lastError = retryError;
        }
      }
      if (lastError) {
        try { unlinkSync(temp); } catch { /* 清理失败无所谓 */ }
        throw lastError;
      }
    }
    this.#cache = next;
    return next;
  }

  /** 只读地拿一份拷贝 */
  all() {
    return JSON.parse(JSON.stringify(this.load()));
  }
}

module.exports = { SettingsStore, DEFAULTS, settingsFile };
