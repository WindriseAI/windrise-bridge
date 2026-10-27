/**
 * 管理员代理（elevated broker）的命令分级 —— 在 core/guard.js 的 classifyCommand 之上再分三档。
 *
 * 设计见 docs/research/admin-broker-review-2026-10-25.md（v2 规格「1. 分级器改成白名单」）。
 * 这里只做**纯函数**分级，不执行、不联网、不落盘。
 *
 * 三档：
 *   · never   —— 明确毁灭性且没有正当用途（格式化系统盘、全盘删除、覆盖物理磁盘……），连确认都不给；
 *   · confirm —— 默认档。任何没通过白名单的写法（含 destructive、unknown、编码、伪装）都在这里；
 *                不执行，等用户确认；
 *   · auto    —— 只有**同时**满足下面两条：
 *                1. 纯文本闸门：单行，只含 A-Za-z0-9 空格 _ - . : \ / ' " = , *；
 *                2. 整行锚定命中 AUTO_WHITELIST 里某条严格的只读 / 启停服务正则。
 *
 * 判定顺序固定：never → 安全设置（防火墙/杀毒/Defender 至少 confirm）→ 白名单。
 * guard.js 的 classifyCommand 只用来提供 baseLevel，在 confirm 档说明风险；它**不能**让任何命令变成 auto。
 * 任何无法静态核验的写法（子表达式、管道、分号、变量、反引号、非 ASCII……）都被纯文本闸门挡在 auto 之外。
 */

import { classifyCommand, splitCommandSegments } from "./guard.js";

/** 系统盘盘符：默认 C:，认 SystemDrive（自测/非 C 盘安装都能用）。 */
const SYSTEM_DRIVE_LETTER = (() => {
  const raw = String(process.env.SystemDrive || "C:").trim();
  const match = /^([A-Za-z]):/.exec(raw);
  return match ? match[1].toUpperCase() : "C";
})();

/* ------------------------------------------------------------------ *
 * NEVER_PATTERNS：明确毁灭性、没有正当用途的命令
 *
 * 每一条都是「命中即拒绝」。正则一律不带 g（避免 lastIndex 状态）；
 * 需要组合判断的条目用 test(text) 函数，保持清单可读、可维护。
 * ------------------------------------------------------------------ */

const DELETE_VERB = String.raw`(?:rm|del|erase|rd|rmdir|remove-item|ri)`;
const RECURSE_FLAGS = String.raw`(?:-recurse\b|-force\b|\/s\b|--recursive\b|--force\b|-[rR]\b|-[fF]\b|-[rR][fF]\b|-[fF][rR]\b|-[a-zA-Z]*[rR][a-zA-Z]*[fF][a-zA-Z]*\b|-[a-zA-Z]*[fF][a-zA-Z]*[rR][a-zA-Z]*\b)`;
/** 盘根 / Unix 根 / Git Bash 的 /c/ / WSL 的 /mnt/c/；后面必须真的是结尾或分隔符。 */
const ROOT_TARGET = String.raw`(?:[A-Za-z]:[\\/](?:\*|\.)?(?=\s|$|[;"'|&])|%SystemDrive%[\\/]?(?:\*|\.)?(?=\s|$|[;"'|&])|\$(?:env:)?SystemDrive[\\/]?(?:\*|\.)?(?=\s|$|[;"'|&])|\$\{(?:env:)?SystemDrive\}[\\/]?(?:\*|\.)?(?=\s|$|[;"'|&])|(?:^|\s)["']?\/(?:\*|\.)?(?=\s|$|[;"'|&])|(?:^|\s)["']?\/[A-Za-z]\/+(?:\*)?(?=\s|$|[;"'|&])|(?:^|\s)["']?\/mnt\/[A-Za-z]\/+(?:\*)?(?=\s|$|[;"'|&]))`;
/** 系统目录整棵树（Windows / Program Files / Users）；子目录不算（C:\Windows\Temp\a 不是整棵）。 */
const SYSTEM_TREE_TARGET = String.raw`(?:[A-Za-z]:\\(?:Windows|Windows\\System32|Windows\\SysWOW64|Windows\\WinSxS|Program Files(?: \(x86\))?|ProgramData|Users)(?:\\\*(?:\.[^\s"'\x60;|&]*)?|\\\.[^\s"'\x60;|&]*)?(?=\s|$|[;"'|&])|%SystemRoot%|%windir%|\$env:(?:SystemRoot|windir)|\$\{(?:env:)?(?:SystemRoot|windir)\})`;
/** 物理磁盘（整盘；分区 /dev/sda1 属于「要确认」，不是「永不执行」）。 */
const BLOCK_DEVICE_TARGET = String.raw`(?:[^\s"'=]*physicaldrive\d+|[^\s"'=]*\/dev\/(?:sd[a-z](?![0-9])|hd[a-z](?![0-9])|vd[a-z](?![0-9])|nvme\d+n\d+(?!p\d)|disk\d+))`;

export const NEVER_PATTERNS = [
  {
    // format C: / format %SystemDrive% / format $env:SystemDrive / format \\?\C:
    pattern: new RegExp(String.raw`\bformat(?:\.(?:com|exe))?["']?\s+(?:["']?\s*)?(?:\/[A-Za-z][^\s]*\s+)*(?:\\\\\?\\)?(?:${SYSTEM_DRIVE_LETTER}:|c:|%systemdrive%|\$(?:env:)?systemdrive\b|\$\{env:systemdrive\})`, "i"),
    note: "格式化系统盘",
  },
  {
    pattern: new RegExp(String.raw`\bformat-volume\b[^\n]*(?:-DriveLetter\s+["']?${SYSTEM_DRIVE_LETTER}\b|-Path\s+["']?(?:\\\\\?\\)?${SYSTEM_DRIVE_LETTER}:)`, "i"),
    note: "格式化系统盘（Format-Volume）",
  },
  {
    // rm -rf /、rm -rf --no-preserve-root /、del /f /s /q C:\*、rd /s /q C:\
    pattern: new RegExp(String.raw`\b${DELETE_VERB}\b[^\n]{0,600}?${RECURSE_FLAGS}[^\n]{0,600}?${ROOT_TARGET}`, "i"),
    note: "递归删除盘根 / 全盘",
  },
  {
    // Remove-Item C:\ -Recurse、rd C:\ /s /q（目标在前、参数在后）
    pattern: new RegExp(String.raw`\b${DELETE_VERB}\b[^\n]{0,600}?${ROOT_TARGET}[^\n]{0,600}?${RECURSE_FLAGS}`, "i"),
    note: "递归删除盘根 / 全盘",
  },
  {
    // 删 C:\Windows、C:\Users、C:\Program Files 这类系统目录整棵树
    pattern: new RegExp(String.raw`\b${DELETE_VERB}\b[^\n]{0,600}?${RECURSE_FLAGS}[^\n]{0,600}?${SYSTEM_TREE_TARGET}`, "i"),
    note: "递归删除系统目录",
  },
  {
    pattern: new RegExp(String.raw`\b${DELETE_VERB}\b[^\n]{0,600}?${SYSTEM_TREE_TARGET}[^\n]{0,600}?${RECURSE_FLAGS}`, "i"),
    note: "递归删除系统目录",
  },
  {
    // 即便没写 -Recurse，直接删 C:\Windows\System32、C:\Windows\System32\*.dll、
    // C:\Users\* 这类系统目录根 / 直接子项也一样是毁灭性的。
    pattern: new RegExp(String.raw`\b${DELETE_VERB}\b[^\n]{0,600}?${SYSTEM_TREE_TARGET}`, "i"),
    note: "删除系统目录或其直接内容",
  },
  {
    // dd if=... of=\\.\PhysicalDrive0 / of=/dev/sda
    pattern: new RegExp(String.raw`\bdd\b[^\n]*\bof\s*=\s*${BLOCK_DEVICE_TARGET}`, "i"),
    note: "覆盖物理磁盘（dd）",
  },
  {
    // 直接重定向到物理磁盘
    pattern: /(?:>|>>)\s*["']?(?:\\\\\.\\)?physicaldrive\d+/i,
    note: "直接写物理磁盘",
  },
  {
    pattern: /(?:>|>>)\s*["']?\/dev\/(?:sd[a-z]|hd[a-z]|vd[a-z]|nvme\d|disk\d)/i,
    note: "直接写块设备",
  },
  {
    pattern: new RegExp(String.raw`\b(?:wipefs|shred|blkdiscard)\b[^\n]*${BLOCK_DEVICE_TARGET}`, "i"),
    note: "擦除物理磁盘",
  },
  {
    pattern: new RegExp(String.raw`\bmkfs(?:\.\w+)?\b[^\n]*${BLOCK_DEVICE_TARGET}`, "i"),
    note: "在物理磁盘上创建文件系统",
  },
  {
    pattern: /\bclear-disk\b[^\n]*(?:-Number\s+0\b|physicaldrive0\b)/i,
    note: "清空 0 号物理磁盘（Clear-Disk）",
  },
  {
    // cipher /w:C:（整盘空闲空间擦除，无法恢复）
    pattern: /\bcipher(?:\.exe)?\s+(?:\/w:?|\/W)\s*(?:[A-Za-z]:|%systemdrive%|\$env:systemdrive)/i,
    note: "整盘擦除（cipher /w）",
  },
  {
    pattern: /\b(?:vssadmin|wmic)\b[^\n]*(?:delete\s+shadows|shadowcopy\s+delete)[^\n]*\/all\b/i,
    note: "删除全部卷影副本（系统还原点）",
  },
  {
    pattern: /\bwmic\s+shadowcopy\s+delete\b/i,
    note: "删除全部卷影副本（系统还原点）",
  },
  {
    pattern: /\bwmic\b[^\n]*\bdiskdrive\b[^\n]*\b(?:delete|format|clean|clear|zero)\b/i,
    note: "清空物理磁盘（wmic diskdrive）",
  },
  {
    pattern: /\bdiskpart\b[\s\S]*?\bclean\s+all\b/i,
    note: "整盘擦除（diskpart clean all）",
  },
  {
    pattern: /\bselect\s+disk\s+0\b[\s\S]{0,200}?\bclean\b/i,
    note: "擦除 0 号物理磁盘",
  },
  {
    // 先关系统还原再全量删除 —— 组合判断，单独关还原还不算 never
    test: (text) => /(?:disable-computerrestore|disable-systemrestore|disable-sr\b)/i.test(text)
      && new RegExp(String.raw`${DELETE_VERB}\b[^\n]*(?:-recurse|\/s\b|-[rf]{1,2}\b)`, "i").test(text),
    note: "关闭系统还原后全量删除",
  },
];

/* ------------------------------------------------------------------ *
 * AUTO_WHITELIST：唯一允许 auto 的命令形状
 *
 * 每条都必须整行锚定（^...$）。参数名只认下面写出来的，缩写、多余参数、
 * 其它开关一律不匹配。「名字/服务名」首字符不能是 -，避免
 * `Restart-Service -ComputerName` 被当成位置参数服务名。
 * ------------------------------------------------------------------ */

const DIGITS = String.raw`\d+`;
const PROC_NAME = String.raw`[A-Za-z0-9_.*][A-Za-z0-9_.*-]{0,63}`;
const PROC_LIST = String.raw`${PROC_NAME}(?:,${PROC_NAME})*`;
const EVENT_LOG_NAME = String.raw`[A-Za-z0-9_.][A-Za-z0-9_.-]{0,63}`;
const SERVICE_NAME = String.raw`[A-Za-z0-9_.][A-Za-z0-9_.-]{0,63}`;
/** 1~200。 */
const MAX_EVENTS = String.raw`(?:[1-9]|[1-9]\d|1\d\d|200)`;

const AUTO_WHITELIST = [
  {
    pattern: new RegExp(String.raw`^Get-Process(?: +(?:-Name +${PROC_LIST}|${PROC_LIST}|-Id +${DIGITS})(?: +-IncludeUserName)?| +-IncludeUserName)?$`, "i"),
    note: "查询进程",
  },
  {
    pattern: new RegExp(String.raw`^Get-Service(?: +(?:-Name +${PROC_LIST}|${PROC_LIST}))?$`, "i"),
    note: "查询服务",
  },
  {
    pattern: new RegExp(String.raw`^Get-NetTCPConnection(?: +-LocalPort +${DIGITS})?(?: +-State +Listen)?$`, "i"),
    note: "查询 TCP 连接",
  },
  {
    pattern: new RegExp(String.raw`^Get-WinEvent +-LogName +${EVENT_LOG_NAME}(?: +-MaxEvents +${MAX_EVENTS})?$`, "i"),
    note: "查询事件日志",
  },
  {
    pattern: /^tasklist(?: +\/v)?$/i,
    note: "查询进程列表",
  },
  {
    pattern: /^netstat +-ano$/i,
    note: "查询网络连接",
  },
  {
    pattern: new RegExp(String.raw`^(?:Restart-Service|Start-Service)(?: +-Name +${SERVICE_NAME}| +${SERVICE_NAME})(?: +-Force)?$`, "i"),
    note: "启动 / 重启服务",
  },
  {
    pattern: new RegExp(String.raw`^net +start +${SERVICE_NAME}$`, "i"),
    note: "启动服务",
  },
  {
    pattern: new RegExp(String.raw`^(?:sc|sc\.exe) +start +${SERVICE_NAME}$`, "i"),
    note: "启动服务",
  },
];

/* ------------------------------------------------------------------ *
 * 纯文本闸门
 * ------------------------------------------------------------------ */

/**
 * 只允许这些字符：A-Za-z0-9、空格、_ - . : \ / ' " = , *
 * 其它任何字符（$ ( ) { } [ ] ; & | < > @ # ` ^ % ! ~、反引号、换行、非 ASCII……）
 * 都让命令失去 auto 资格。
 */
const SAFE_TEXT = /^[A-Za-z0-9 _\-.:\\/'",=*]+$/;

function passesTextGate(text) {
  if (!text) return false;
  if (text.includes("\n")) return false;
  return SAFE_TEXT.test(text);
}

/** 只做 CRLF 归一，不 trim —— 闸门要看命令的原始形状（前导 NBSP、尾随换行都不能被悄悄抹掉）。 */
function normalizeNewlines(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n");
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

const LEVEL_TEXT = { readonly: "只读", unknown: "未识别", destructive: "危险" };

function asText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

/** 只去掉成对的整段引号；`echo "x"` 这种不要把结尾引号吃掉。 */
function stripOuterQuotes(text) {
  const value = text.trim();
  if (value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

/** 去掉解释器外壳，看到真正要执行的东西。 */
function unwrap(text) {
  let out = stripOuterQuotes(asText(text));
  for (let round = 0; round < 6; round += 1) {
    const before = out;
    out = out.replace(/^&\s+/, "").trim();
    out = out.replace(/^(?:cmd(?:\.exe)?)\s+(?:\/[A-Za-z]\s+)*\/[cCkK]\s+/i, "").trim();
    out = out.replace(/^(?:powershell|pwsh)(?:\.exe)?\s+(?:-[A-Za-z]+\s+(?:[A-Za-z]+\s+)?)*-(?:command|c)\s+/i, "").trim();
    out = out.replace(/^(?:bash|sh|zsh)\s+-l?c\s+/i, "").trim();
    out = out.replace(/^\/(?:usr\/)?bin\/(?:ba|z)?sh\s+-c\s+/i, "").trim();
    out = out.replace(/^(?:sudo|runas)\s+(?:\/[A-Za-z]+\s+)*/i, "").trim();
    out = out.replace(/^call\s+/i, "").trim();
    out = out.replace(/^start\s+(?:""\s+)?/i, "").trim();
    out = stripOuterQuotes(out);
    if (out === before) break;
  }
  return out;
}

/** 按行切，但引号里的换行不切（它可能是 powershell -Command 的整段脚本）。 */
function splitLines(text) {
  const lines = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === "\n") { lines.push(current); current = ""; continue; }
    current += ch;
  }
  lines.push(current);
  return lines;
}

/** 比 guard 多切一刀：cmd 的单 & 也是命令分隔符（PowerShell 开头的 & 调用运算符不算）。 */
function splitForPolicy(text) {
  const out = [];
  for (const part of splitCommandSegments(text)) {
    let current = "";
    let quote = null;
    for (let i = 0; i < part.length; i += 1) {
      const ch = part[i];
      const next = part[i + 1];
      if (quote) {
        current += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
      if (ch === "&" && next !== "&") {
        const prev = current.slice(-1);
        if (next === ">" || prev === ">" || current.trim() === "") { current += ch; continue; }
        out.push(current);
        current = "";
        continue;
      }
      current += ch;
    }
    out.push(current);
  }
  return out.map(value => value.trim()).filter(Boolean);
}

/** 从 base64 里把真正要执行的脚本解出来（PowerShell -enc / FromBase64String / base64 -d）。 */
function decodeVariants(text) {
  const found = [];
  const seen = new Set();
  const patterns = [
    /-enc(?:odedcommand)?\s+["']?([A-Za-z0-9+/=]{16,})["']?/gi,
    /frombase64string\s*\(\s*(["'])([A-Za-z0-9+/=]{16,})\1\s*\)/gi,
    /\b(?:echo|printf|Write-Output)\s+["']?([A-Za-z0-9+/=]{20,})["']?\s*\|\s*(?:base64\s+(?:-d|--decode)|openssl\s+base64\s+-d|certutil\s+-decode)/gi,
  ];
  const push = (payload, source) => {
    for (const encoding of ["utf16le", "utf8"]) {
      let decoded;
      try { decoded = Buffer.from(payload, "base64").toString(encoding); } catch { continue; }
      if (!decoded.trim() || decoded.length < 4) continue;
      const chars = [...decoded];
      const printable = chars.filter((ch) => {
        const code = ch.codePointAt(0);
        return code === 9 || code === 10 || code === 13 || code >= 32;
      }).length;
      if (printable / chars.length < 0.7) continue;
      const clean = decoded.replace(/\u0000/g, "").trim();
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      found.push({ text: clean, source });
    }
  };
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) {
      const payload = match.length >= 3 && match[2] ? match[2] : match[1];
      if (payload) push(payload, "base64 解码后的命令");
    }
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * 安全 / 敏感目标
 * ------------------------------------------------------------------ */

const SENSITIVE_TARGET = /\b(?:windefend|mpssvc|sharedaccess|wscsvc|securityhealthservice|sense|defender|firewall|antivirus|avast|kaspersky|360tray|火绒|防火墙|杀毒|杀软)\b/i;
const SENSITIVE_COMMAND = /\b(?:Set-MpPreference|Add-MpPreference|Set-NetFirewallProfile|Set-NetFirewallRule|Disable-NetFirewallRule|netsh\s+advfirewall)\b/i;
/** 注册表写入一律要确认（guard 把 New-Item 当只读，不能让它 auto 到注册表里）。 */
const REGISTRY_TARGET = /(?:^|[\\/\s"'`(])(?:HKLM|HKCU|HKCR|HKU|HKCC):|Registry::HKEY_/i;

function touchesSecuritySettings(text) {
  return SENSITIVE_TARGET.test(text) || SENSITIVE_COMMAND.test(text) || REGISTRY_TARGET.test(text);
}

/* ------------------------------------------------------------------ *
 * 候选文本：整行、每一行、每一段、解释器外壳内部
 * ------------------------------------------------------------------ */

function variantsOf(raw) {
  const list = [];
  const seen = new Set();
  const add = (value) => {
    const text = String(value ?? "").trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    list.push(text);
  };
  add(raw);
  for (const line of splitLines(raw)) {
    add(line);
    add(unwrap(line));
    for (const segment of splitForPolicy(line)) {
      add(segment);
      add(unwrap(segment));
    }
  }
  return list;
}

function findNeverAnywhere(raw) {
  for (const text of variantsOf(raw)) {
    const hit = findNever(text);
    if (hit) return hit;
  }
  for (const variant of decodeVariants(raw)) {
    for (const text of variantsOf(variant.text)) {
      const hit = findNever(text);
      if (hit) return `${hit}（${variant.source}）`;
    }
  }
  return null;
}

function touchesSecurityAnywhere(raw) {
  for (const text of variantsOf(raw)) {
    if (touchesSecuritySettings(text)) return true;
  }
  for (const variant of decodeVariants(raw)) {
    for (const text of variantsOf(variant.text)) {
      if (touchesSecuritySettings(text)) return true;
    }
  }
  return false;
}

function matchWhitelist(text) {
  for (const entry of AUTO_WHITELIST) {
    if (entry.pattern.test(text)) return entry;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * never 查询（导出）
 * ------------------------------------------------------------------ */

/** 命中返回说明文字，否则 null。 */
export function findNever(command) {
  const text = asText(command);
  if (!text) return null;
  for (const entry of NEVER_PATTERNS) {
    const hit = typeof entry.test === "function" ? entry.test(text) : entry.pattern.test(text);
    if (hit) return entry.note;
  }
  return null;
}

/**
 * 分级入口。
 *
 * @param {string} command 命令原文（多行、多段都行）
 * @returns {{tier: "auto"|"confirm"|"never", reason: string, baseLevel: "readonly"|"unknown"|"destructive"}}
 */
export function classifyForBroker(command) {
  const raw = asText(command);
  const gateText = normalizeNewlines(command);
  const base = classifyCommand(raw);
  const baseLevel = base?.level ?? "unknown";

  if (!raw) return { tier: "confirm", reason: "空命令，无法识别", baseLevel };

  // 1. never：整行 + 每一行 + 每一段 + 解释器内部 + base64 解码后的内容
  const never = findNeverAnywhere(raw);
  if (never) {
    return {
      tier: "never",
      reason: `明确毁灭性命令：${never}。这类命令没有正当用途，连确认都不提供。`,
      baseLevel,
    };
  }

  // 2. 安全设置：防火墙 / 杀毒 / Defender / 注册表，至少 confirm
  if (touchesSecurityAnywhere(raw)) {
    return {
      tier: "confirm",
      reason: "涉及防火墙 / 杀毒 / Defender / 系统安全设置，必须人工确认",
      baseLevel,
    };
  }

  // 3. 编码命令本身不足以自动放行（解码后没发现危险也只能 confirm）
  if (decodeVariants(raw).length) {
    return {
      tier: "confirm",
      reason: "命令经过 base64 / -enc 编码，编码本身不足以自动放行，需要人工确认",
      baseLevel,
    };
  }

  // 4. auto 必须同时通过纯文本闸门和整行白名单
  if (passesTextGate(gateText)) {
    const whitelisted = matchWhitelist(raw);
    if (whitelisted) {
      return { tier: "auto", reason: `白名单命令：${whitelisted.note}`, baseLevel };
    }
  }

  // 5. 其余一律 confirm；baseLevel 只用来写风险说明
  if (baseLevel === "destructive") {
    return {
      tier: "confirm",
      reason: `危险命令：${base?.note ?? "破坏性操作"}，需要人工确认`,
      baseLevel,
    };
  }

  return {
    tier: "confirm",
    reason: `未通过白名单，需要人工确认（guard: ${LEVEL_TEXT[baseLevel] ?? "未识别"}）`,
    baseLevel,
  };
}
