/**
 * 路径守卫 —— 参照学习软件的写入边界思想。
 *
 * 学习软件的真实约束（其源码 BRIDGE_LOCAL_ONLY_NOTE）：
 *   「当前打开的项目文件夹是默认目标，不是硬禁令；任务相关路径可以用
 *     run_command 先做只读探测，但文件类工具仍限制在 workspace / Skill 根目录内。」
 *
 * 也就是分两档：
 *   - 文件读写工具（read_files / apply_patch 等）：硬守卫，越界直接拒绝。
 *   - 命令执行工具（run_command）：Soft 限制 —— 允许只读探测，危险命令单独拦。
 *
 * 这里把两档都实现出来，并把判定结果写进返回值，方便展示给用户看「谁被拦了」。
 */

import path from "node:path";
import { realpath } from "node:fs/promises";

/** 解析为绝对路径，并消除 .. 带来的穿越。 */
export function resolveInside(root, candidate) {
  const abs = path.resolve(root, candidate ?? ".");
  const normalizedRoot = path.resolve(root);
  // 盘符根目录（D:\）resolve 后自带结尾分隔符，再拼一个就谁都匹配不上了
  const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
  const inside = abs === normalizedRoot || abs.startsWith(prefix);
  return { abs, root: normalizedRoot, inside };
}

/** 软链可能指向工作区之外，因此真实路径也要再判一次。 */
export async function resolveRealInside(root, candidate) {
  const first = resolveInside(root, candidate);
  const real = await realpath(first.abs).catch(() => null);
  if (!real) return { ...first, real: null, insideReal: first.inside };
  const second = resolveInside(root, real);
  return { ...first, real, insideReal: second.inside };
}

export class PathDeniedError extends Error {
  constructor(candidate, root) {
    super(`路径越界：${candidate} 不在工作区（${root}）内。文件工具只能访问工作区；要看工作区外的文件可以用 run_command（cat / ls），要读写请让用户在 Windrise Bridge「设置 → 工作区」里添加这个文件夹（加完立即生效，不用重连）。`);
    this.name = "PathDeniedError";
    this.code = "PATH_DENIED";
  }
}

/**
 * 组装一个守卫函数：允许根可以是多个（工作区 + 额外授权目录）。
 * 返回的 guard 抛 PathDeniedError，调用方不用各自写判断。
 */
export function createPathGuard(roots) {
  const list = (Array.isArray(roots) ? roots : [roots]).filter(Boolean).map(r => path.resolve(r));
  if (!list.length) throw new Error("路径守卫至少需要一个允许根目录");
  return {
    roots: list,
    /** 运行中改工作区：原地替换，所有拿着 guard 的工具立即生效，不用重启 Bridge、不断隧道 */
    setRoots(next) {
      const fresh = (Array.isArray(next) ? next : [next]).filter(Boolean).map(r => path.resolve(r));
      if (!fresh.length) return list;
      list.splice(0, list.length, ...fresh);
      return list;
    },
    async check(candidate) {
      for (const root of list) {
        const info = await resolveRealInside(root, candidate);
        if (info.inside && info.insideReal) return info;
      }
      throw new PathDeniedError(candidate, list.join(" / "));
    },
    /** 只做字符串层判定，用于列表类工具的快速过滤。 */
    quickCheck(candidate) {
      return list.some(root => resolveInside(root, candidate).inside);
    },
    /** 展示用：把绝对路径压成工作区相对路径，和学习软件的返回风格一致。 */
    toRelative(abs) {
      for (const root of list) {
        const info = resolveInside(root, abs);
        if (info.inside) {
          const rel = path.relative(root, abs);
          return rel === "" ? "." : rel.split(path.sep).join("/");
        }
      }
      return abs;
    },
  };
}

/** 危险命令名单：参照学习软件那份 terminalAutoApproveRules 的「false 部分」。 */
export const DESTRUCTIVE_COMMAND_PATTERNS = [
  { pattern: /\brm\s+-[rf]/i, note: "递归删除" },
  { pattern: /\brmdir\s+\/s/i, note: "递归删目录" },
  { pattern: /\bdel\s+\/[sfq]/i, note: "强制删除" },
  { pattern: /Remove-Item\b.*-Recurse/i, note: "递归删除" },
  { pattern: /\bformat\s+[a-z]:/i, note: "格式化磁盘" },
  { pattern: /\bmkfs(\.\w+)?\b/i, note: "创建文件系统" },
  { pattern: /\bdd\s+if=/i, note: "裸设备写入" },
  { pattern: /\btaskkill\b|\bStop-Process\b|\bkill\s+-9/i, note: "强制终止进程" },
  { pattern: /\bshutdown\b|\breboot\b/i, note: "关机/重启" },
  { pattern: /\bgit\s+push\b.*--force/i, note: "强推覆盖远端" },
  { pattern: /\bnpm\s+publish\b|\byarn\s+publish\b/i, note: "发布包" },
  { pattern: />\s*\/dev\/(sd|nvme)/i, note: "写裸设备" },
];

/** 只读 / 安全命令白名单（对应学习软件里值为 true 的那批）。 */
export const READONLY_COMMAND_PATTERNS = [
  /^(ls|dir|pwd|cd|cat|head|tail|wc|which|stat|file|od|du|df|tree|rg|grep|findstr|find|sort|uniq|nl|basename|dirname|realpath)\b/i,
  /^(git\s+(status|log|show|diff|ls-files|grep|branch|remote))\b/i,
  /^(node|python|python3)\s+(-v|--version)$/i,
  /^(npm|pnpm|yarn|node|git|python|tsc)\s+--version$/i,
  // 安全的自解释型命令：解释器跑脚本、依赖安装、构建测试。都是常见开发动作，且可回滚。
  /^(node|python|python3|deno|bun)\s+[\w./\\-]+/i,
  /^(npm|pnpm|yarn)\s+(run|test|ci|install|ls|list|outdated|why|view|info)\b/i,
  /^(npm|pnpm|yarn)\s+(exec|dlx)\s+/i,
  /^npx\s+/i,
  /^(tsc|eslint|prettier|vitest|jest|mocha|pytest)\b/i,
  /^git\s+(add|commit|checkout|switch|stash|fetch|pull|merge|rebase|tag|init|clone|worktree)\b/i,
  /^(Get-ChildItem|Get-Content|Get-Date|Get-Location|Get-Process|Get-Command|Select-String|Measure-Object|Compare-Object|Format-List|Format-Table|Sort-Object|Write-Output|Write-Host|Out-String|Split-Path|Join-Path|Test-Path|New-Item|Copy-Item|Move-Item|Get-Item)\b/i,
  /^echo\b/i,
  /*
   * 媒体处理：ffmpeg / ffprobe / magick。
   *
   * 为什么要加：做视频/图片处理时每条命令都不一样（换个时间点、换个尺寸就是新命令），
   * 而批准是**按命令原文**记的 —— 每条都要批一次，等于没法用。
   * 实测踩过：agent 想 ffprobe 看一眼视频信息直接被拦死，而且**没有地方能批准**
   * （shell.approve 没暴露出口），用户看到「确认后重试即可执行」却找不到确认按钮。
   *
   * 安全性说明：这几个工具会写文件（ffmpeg -y 会覆盖）。但白名单里本来就有
   * `node|python <脚本>` —— 那等于能跑任意代码，比 ffmpeg 强得多。
   * 所以加它们不降低现有安全水位。真正的边界是**路径守卫**（只能在工作区根目录内读写）。
   *
   * 第二条、第三条正则管「用绝对路径调 exe」的写法。
   * 为什么要有第三条带 `&` 的：**PowerShell 里带引号的路径必须用调用运算符 `&`**，
   * 直接写 `"C:\...\ffmpeg.exe" -y ...` 会报「表达式或语句中包含意外的标记"-y"」。
   * 实测踩过：加完前两条以为好了，agent 实际执行时用的是 `& "路径"` 的写法，照样被拦。
   */
  /^(ffmpeg|ffprobe|magick|convert)\b/i,
  /^["']?[A-Za-z]:[\\/][^"']*[\\/](ffmpeg|ffprobe|magick|convert)\.exe["']?\s/i,
  /^&\s*["']?[A-Za-z]:[\\/][^"']*[\\/](ffmpeg|ffprobe|magick|convert)\.exe["']?\s/i,
  /*
   * 下载：让 agent 把文件取到本机。
   *
   * 为什么要加：这是**唯一正确的「把大文件弄到本机」的方式**。
   * 下载是**本机直连对方服务器**做的，走用户自己的宽带，
   * MCP 隧道只传一条命令和一行结果（几 KB），跟文件多大完全无关。
   * 反过来让 agent 通过 MCP 把文件「推」过来，几百 MB 就直接把隧道堵死了。
   *
   * 实测过：下 1 MB 和下 20 MB，MCP 流量几乎一样 —— 证明数据没过桥。
   */
  /^(Invoke-WebRequest|Invoke-RestMethod|curl|wget|Start-BitsTransfer)\b/i,
];

/**
 * 把一行命令按 ; && || | 换行 切成多段（引号里的不切）。
 *
 * 修复：原来是拿整行去匹配 `^ls` 这种只看开头的正则，
 * 于是 `ls; Remove-Item C:\重要文件` 会被当成「只读命令」直接执行 —— 白名单形同虚设。
 * 现在每一段都要单独过判定，取最危险的那个结果。
 */
export function splitCommandSegments(command) {
  const text = String(command ?? "");
  const segments = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) { segments.push(current); current = ""; i++; continue; }
    if (ch === ";" || ch === "|" || ch === "\n" || ch === "\r") { segments.push(current); current = ""; continue; }
    current += ch;
  }
  segments.push(current);
  return segments.map(s => s.trim()).filter(Boolean);
}

/** 这些写法能在「看起来安全」的命令里夹带任意代码，一律不自动放行。 */
const SMUGGLING_PATTERNS = [
  { pattern: /\$\(/, note: "子表达式 $( )" },
  { pattern: /`/, note: "反引号转义" },
  { pattern: /\b(iex|Invoke-Expression|Invoke-Command|Start-Process|Add-Type)\b/i, note: "动态执行" },
  { pattern: /^(node|deno|bun)\s+(-e|-p|--eval|--print)\b/i, note: "内联脚本" },
  { pattern: /^(python|python3|py)\s+-c\b/i, note: "内联脚本" },
  { pattern: /(^|\s)-EncodedCommand\b|(^|\s)-enc\b/i, note: "编码命令" },
];

function classifySegment(text) {
  for (const entry of DESTRUCTIVE_COMMAND_PATTERNS) {
    if (entry.pattern.test(text)) return { level: "destructive", note: entry.note, requiresApproval: true };
  }
  for (const entry of SMUGGLING_PATTERNS) {
    if (entry.pattern.test(text)) return { level: "unknown", note: `含${entry.note}`, requiresApproval: true };
  }
  for (const pattern of READONLY_COMMAND_PATTERNS) {
    if (pattern.test(text)) return { level: "readonly", note: "只读命令", requiresApproval: false };
  }
  return { level: "unknown", note: "未在白名单内", requiresApproval: true };
}

const LEVEL_RANK = { readonly: 0, unknown: 1, destructive: 2 };

export function classifyCommand(command) {
  const text = String(command ?? "").trim();
  // 整行先过一遍危险名单（有的危险写法会跨段，比如 `rm -rf` 后面接管道）
  for (const entry of DESTRUCTIVE_COMMAND_PATTERNS) {
    if (entry.pattern.test(text)) return { level: "destructive", note: entry.note, requiresApproval: true };
  }
  const segments = splitCommandSegments(text);
  if (!segments.length) return { level: "unknown", note: "空命令", requiresApproval: true };
  let worst = null;
  for (const segment of segments) {
    const result = classifySegment(segment);
    if (!worst || LEVEL_RANK[result.level] > LEVEL_RANK[worst.level]) {
      worst = segments.length > 1 && result.level !== "readonly"
        ? { ...result, note: `${result.note}（第 ${segments.indexOf(segment) + 1} 段：${segment.slice(0, 60)}）` }
        : result;
    }
  }
  return worst;
}
