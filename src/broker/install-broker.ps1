#Requires -Version 5.1
<#
.SYNOPSIS
    安装 / 更新 / 卸载 Windrise 管理员代理（计划任务 WindriseElevatedBroker）。

.DESCRIPTION
    必须以管理员身份运行本脚本。

    安装目录固定为 $env:ProgramFiles\WindriseBroker（不是仓库，也不是用户可写目录）：
      broker\broker.mjs          代理本体
      core\broker-policy.js      命令分级器
      core\guard.js              broker-policy.js 的依赖
      config.json                allowedCwdRoots / handleFile / runDir / logFile

    安装脚本会：
      1. 停掉并删除旧的计划任务，清空安装目录后重新复制文件、写 config.json；
      2. 用 icacls 把安装目录设成「Administrators / SYSTEM 完全控制，Users 只读+执行」，
         再用 Get-Acl 复核：只要有任何非管理员主体可写、或权限继承没关掉，就中止；
      3. 把 %ProgramData%\WindriseBroker 和其中的 run 目录设成只有 Administrators / SYSTEM
         可写（Users 无权限）；再建 handle 目录放句柄文件，只给 Administrators / SYSTEM
         完全控制、安装时的当前用户只读；每一步都用 Get-Acl 复核；
      4. 解析 node.exe 的完整路径，要求它位于 Program Files / Program Files (x86) /
         SystemRoot 之下，且所在目录没有非管理员写权限；
      5. 注册 RunLevel Highest 的计划任务，指向安装目录里的 broker\broker.mjs。

    **更新代理 = 重新运行本脚本**（会有一次管理员确认）。不要手工改安装目录里的文件，
    下次安装会被覆盖，而且运行中的代理也认不到。

    每一步失败都会 throw，不会静默继续。

.EXAMPLE
    # 在「以管理员身份运行」的 PowerShell 里
    powershell -ExecutionPolicy Bypass -File .\src\broker\install-broker.ps1

.EXAMPLE
    # 指定 node.exe，并立刻启动
    powershell -ExecutionPolicy Bypass -File .\src\broker\install-broker.ps1 `
        -NodePath "C:\Program Files\nodejs\node.exe" -Start

.EXAMPLE
    # 只允许代理在指定目录里执行命令（默认是仓库根目录）
    powershell -ExecutionPolicy Bypass -File .\src\broker\install-broker.ps1 `
        -AllowedCwdRoots "<本地路径>"

.EXAMPLE
    # 卸载（停任务、删任务、删安装目录和 ProgramData 目录；不动仓库里的旧 data\）
    powershell -ExecutionPolicy Bypass -File .\src\broker\install-broker.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string]$TaskName = "WindriseElevatedBroker",
    [string]$NodePath = "",
    [string[]]$AllowedCwdRoots = @(),
    [switch]$Start,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# 固定路径
# ---------------------------------------------------------------------------

if (-not $env:ProgramFiles) {
    throw "读不到 `$env:ProgramFiles，无法确定安装目录。请在正常的 Windows 管理员 PowerShell 里运行本脚本。"
}
if (-not $env:ProgramData) {
    throw "读不到 `$env:ProgramData，无法确定运行目录。请在正常的 Windows 管理员 PowerShell 里运行本脚本。"
}

$InstallRoot       = Join-Path $env:ProgramFiles "WindriseBroker"
$InstallBrokerDir  = Join-Path $InstallRoot "broker"
$InstallCoreDir    = Join-Path $InstallRoot "core"
$ConfigFile        = Join-Path $InstallRoot "config.json"
$DataRoot          = Join-Path $env:ProgramData "WindriseBroker"
$HandleDir         = Join-Path $DataRoot "handle"
$RunDir            = Join-Path $DataRoot "run"
$LogFile           = Join-Path $DataRoot "broker.log"

$BrokerSrc         = Join-Path $PSScriptRoot "broker.mjs"
$CoreSrcDir        = Join-Path (Join-Path $PSScriptRoot "..") "core"
$PolicySrc         = Join-Path $CoreSrcDir "broker-policy.js"
$GuardSrc          = Join-Path $CoreSrcDir "guard.js"
$RepoRoot          = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$HandleFile        = Join-Path $HandleDir "broker-handle.json"
$LegacyDataDir     = Join-Path $RepoRoot "data"
$LegacyHandleFile  = Join-Path $LegacyDataDir "broker-handle.json"

# SID：Administrators / SYSTEM / TrustedInstaller（系统服务账户，不属于普通用户）
$TrustedSids = @(
    "S-1-5-32-544",  # BUILTIN\Administrators
    "S-1-5-18",      # NT AUTHORITY\SYSTEM
    "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"  # NT SERVICE\TrustedInstaller
)
# 只对以后创建的对象生效，不是当前能写的主体；不当作「非管理员可写」
$IgnoredSids = @(
    "S-1-3-0",       # CREATOR OWNER
    "S-1-3-4"        # OWNER RIGHTS
)
# 写权限掩码（FileSystemRights）：
#   Write=278, DeleteSubdirectoriesAndFiles=64, Delete=65536,
#   ChangePermissions=262144, TakeOwnership=524288
$WriteRightsMask = 278 + 64 + 65536 + 262144 + 524288
$FullControlValue = [int][System.Security.AccessControl.FileSystemRights]::FullControl

# 安装时的当前用户：Bridge 以同一个用户读句柄文件，所以 handle 目录只给它只读权限。
$InstallerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if (-not $InstallerSid) {
    throw "读不到当前用户的 SID，无法给句柄目录设置只读权限。中止安装。"
}

# ---------------------------------------------------------------------------
# 工具函数（每个关键判断都单独成函数，便于复核）
# ---------------------------------------------------------------------------

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "需要管理员权限：请右键 PowerShell「以管理员身份运行」，再执行本脚本。安装 / 更新 / 卸载代理都需要这一次确认。"
    }
}

<#
    判断 $Candidate 是否等于 $Root 或位于 $Root 之下（按路径段比较，不分大小写）。
    不能简单用 StartsWith，否则 C:\Program FilesEvil 会被当成在 C:\Program Files 下。
#>
function Test-PathUnder {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$Root
    )
    $candidateFull = [IO.Path]::GetFullPath($Candidate).TrimEnd('\')
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    if ($candidateFull.Equals($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    return $candidateFull.StartsWith($rootFull + "\", [StringComparison]::OrdinalIgnoreCase)
}

<# 把账户名 / IdentityReference 翻译成 SID；翻译不了返回 $null（调用方按不安全处理）。 #>
function Get-SidValue {
    param($Identity)
    if ($null -eq $Identity) { return $null }
    try {
        if ($Identity -is [string]) {
            $Identity = New-Object System.Security.Principal.NTAccount($Identity)
        }
        return $Identity.Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
        return $null
    }
}

<# 跑 icacls；原生命令不会自动 throw，所以必须自己检查退出码。 #>
function Invoke-Icacls {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    & icacls.exe @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "icacls 失败（退出码 $LASTEXITCODE）：icacls $($Arguments -join ' ')"
    }
}

<#
    复核「目录权限已加固」：
      · 权限继承必须已关闭（AreAccessRulesProtected = true）；
      · owner 必须是管理员 / SYSTEM（owner 永远能改 ACL，所以这也算写权限）；
      · 任何非管理员主体不得有写权限（Deny 不算；CREATOR OWNER 这类「未来对象」不算）；
      · Administrators 和 SYSTEM 必须都有完全控制。
    任何一条不满足都 throw，绝不继续安装。
#>
function Assert-ProtectedDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "$Label 不存在：$Path"
    }
    $acl = Get-Acl -LiteralPath $Path

    if (-not $acl.AreAccessRulesProtected) {
        throw "$Label 仍启用了权限继承（$Path）。icacls /inheritance:r 没有生效，中止安装。"
    }

    $ownerSid = Get-SidValue $acl.Owner
    if ($TrustedSids -notcontains $ownerSid) {
        throw "$Label 的 owner 不是 Administrators / SYSTEM（$($acl.Owner)）。owner 可以改 ACL，按不安全处理，中止安装。"
    }

    $adminFull = $false
    $systemFull = $false
    $rules = @($acl.Access)
    if ($rules.Count -eq 0) {
        throw "$Label 没有任何权限项，按不安全处理，中止安装。"
    }

    foreach ($rule in $rules) {
        if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny) {
            continue
        }
        $sid = Get-SidValue $rule.IdentityReference
        if ($IgnoredSids -contains $sid) {
            continue
        }
        $rights = [int]$rule.FileSystemRights
        $isTrusted = $TrustedSids -contains $sid

        if (-not $isTrusted -and (($rights -band $WriteRightsMask) -ne 0)) {
            throw "$Label 有非管理员主体可写：$($rule.IdentityReference)（$($rule.FileSystemRights)）。中止安装。"
        }
        if ($sid -eq "S-1-5-32-544" -and (($rights -band $FullControlValue) -eq $FullControlValue)) {
            $adminFull = $true
        }
        if ($sid -eq "S-1-5-18" -and (($rights -band $FullControlValue) -eq $FullControlValue)) {
            $systemFull = $true
        }
    }

    if (-not $adminFull) {
        throw "$Label 没有 Administrators 的完全控制权限。中止安装。"
    }
    if (-not $systemFull) {
        throw "$Label 没有 SYSTEM 的完全控制权限。中止安装。"
    }
}

<#
    复核句柄目录：
      · 权限继承必须已关闭；
      · owner 必须是 Administrators（owner 永远能改 ACL）；
      · 除 Administrators / SYSTEM 外，任何主体不得有写权限（安装用户只有 RX）。
    handle 目录里只有 broker 写的端口 / 会话密钥，不要求安装用户有完全控制，
    所以不能直接用 Assert-ProtectedDirectory。
#>
function Assert-ProtectedHandleDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "$Label 不存在：$Path"
    }
    $acl = Get-Acl -LiteralPath $Path

    if (-not $acl.AreAccessRulesProtected) {
        throw "$Label 仍启用了权限继承（$Path）。icacls /inheritance:r 没有生效，中止安装。"
    }

    $ownerSid = Get-SidValue $acl.Owner
    if ($ownerSid -ne "S-1-5-32-544") {
        throw "$Label 的 owner 不是 Administrators（$($acl.Owner)）。owner 可以改 ACL，按不安全处理，中止安装。"
    }

    $rules = @($acl.Access)
    if ($rules.Count -eq 0) {
        throw "$Label 没有任何权限项，按不安全处理，中止安装。"
    }

    foreach ($rule in $rules) {
        if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny) {
            continue
        }
        $sid = Get-SidValue $rule.IdentityReference
        if ($IgnoredSids -contains $sid) {
            continue
        }
        if ($sid -eq "S-1-5-32-544" -or $sid -eq "S-1-5-18") {
            continue
        }
        if ((([int]$rule.FileSystemRights) -band $WriteRightsMask) -ne 0) {
            throw "$Label 有非 Administrators / SYSTEM 主体可写：$($rule.IdentityReference)（$($rule.FileSystemRights)）。中止安装。"
        }
    }
}

<#
    只复核「没有非管理员主体可写」（不要求关闭继承 / owner）。
    用于 node.exe 所在目录：它继承自 Program Files，本来就不该被改 ACL，
    但我们仍然要确认 Users 之类的主体没有写权限。
#>
function Assert-NoUntrustedWrite {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )
    $acl = Get-Acl -LiteralPath $Path
    $sawTrusted = $false
    foreach ($rule in @($acl.Access)) {
        if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny) {
            continue
        }
        $sid = Get-SidValue $rule.IdentityReference
        if ($IgnoredSids -contains $sid) {
            continue
        }
        if ($TrustedSids -contains $sid) {
            $sawTrusted = $true
            continue
        }
        if ((([int]$rule.FileSystemRights) -band $WriteRightsMask) -ne 0) {
            throw "$Label 有非管理员主体可写：$($rule.IdentityReference)（$($rule.FileSystemRights)）。请把 Node 安装到受保护位置，或用 -NodePath 指向已受保护的位置。"
        }
    }
    if (-not $sawTrusted) {
        throw "$Label 没有 Administrators / SYSTEM 的权限项，无法确认受保护。中止安装。"
    }
}

<# 停掉正在运行的代理任务（存在才停），避免复制 / 删除安装目录时被占用。 #>
function Stop-BrokerTask {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $existing) { return }
    if ($existing.State -ne "Running" -and $existing.State -ne "Queued") { return }
    # 停不下来就 throw（不吞错误），否则后面删除安装目录可能删到一半。
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
}

<#
    拒绝联接点 / 符号链接（reparse point）。
    否则攻击者可以预先把安装目录 / 运行目录做成指向别处的联接点，
    icacls 加固的其实是目标目录，代理却从别处加载。
#>
function Assert-NotReparsePoint {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "$Label 是联接点 / 符号链接（$Path）。拒绝在可重定向的目录上安装，请先删掉它。"
    }
}

# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

Assert-Administrator

if ($Uninstall) {
    Stop-BrokerTask
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -ne $existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    }
    foreach ($dir in @($InstallRoot, $DataRoot)) {
        Assert-NotReparsePoint -Path $dir -Label "要删除的目录"
        if (Test-Path -LiteralPath $dir) {
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction Stop
        }
    }
    Write-Host "已停止并删除计划任务 $TaskName。"
    Write-Host "已删除安装目录 $InstallRoot 和运行目录 $DataRoot（含 handle 子目录）。"
    Write-Host "仓库里的旧 data\broker-handle.json 不在本次卸载范围内（如存在，请手动删除）。"
    return
}

# 1) 源文件检查 -------------------------------------------------------------
foreach ($src in @($BrokerSrc, $PolicySrc, $GuardSrc)) {
    if (-not (Test-Path -LiteralPath $src)) {
        throw "找不到源文件：$src。请在完整仓库里运行本脚本。"
    }
}

# 2) node.exe 必须在受保护位置 ---------------------------------------------
if (-not $NodePath) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) {
        throw "找不到 node.exe。请安装 Node.js，或用 -NodePath 指定完整的 node.exe 路径（例如 C:\Program Files\nodejs\node.exe）。"
    }
    $NodePath = $nodeCommand.Source
}
$nodeResolved = Resolve-Path -LiteralPath $NodePath -ErrorAction SilentlyContinue
if (-not $nodeResolved) {
    throw "node.exe 路径不存在：$NodePath"
}
$NodePath = $nodeResolved.Path
if (-not $NodePath.EndsWith("node.exe", [StringComparison]::OrdinalIgnoreCase)) {
    throw "-NodePath 必须指向 node.exe：$NodePath"
}
$NodeDir = Split-Path -Parent $NodePath

$allowedNodeRoots = @()
foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:SystemRoot)) {
    if ($root) { $allowedNodeRoots += $root }
}
$nodeUnderProtectedRoot = $false
foreach ($root in $allowedNodeRoots) {
    if (Test-PathUnder -Candidate $NodePath -Root $root) {
        $nodeUnderProtectedRoot = $true
        break
    }
}
if (-not $nodeUnderProtectedRoot) {
    throw "node.exe 必须位于 Program Files、Program Files (x86) 或 SystemRoot 之下，当前是：$NodePath。请把 Node.js 安装到 Program Files，或用 -NodePath 指向已受保护的位置。"
}
# node.exe 所在目录和 node.exe 本身都不能让普通用户写，否则仍然可以替换 node.exe 提权。
Assert-NoUntrustedWrite -Path $NodeDir -Label "node.exe 所在目录（$NodeDir）"
Assert-NoUntrustedWrite -Path $NodePath -Label "node.exe（$NodePath）"

# 3) 允许 cwd 根 ------------------------------------------------------------
if ($AllowedCwdRoots.Count -gt 0) {
    $cwdRoots = @()
    foreach ($root in $AllowedCwdRoots) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) {
            throw "-AllowedCwdRoots 里的目录不存在：$root"
        }
        $cwdRoots += (Resolve-Path -LiteralPath $root).Path
    }
} else {
    $cwdRoots = @($RepoRoot)
}

# 4) 停旧任务，重建安装目录 -------------------------------------------------
Stop-BrokerTask

# 旧版句柄文件在仓库 data\ 下：那里普通用户可写。提权脚本不去删它——
# 在可被联接点重定向的目录里用管理员身份删文件，本身就是一个风险。只提示用户手动删。
if (Test-Path -LiteralPath $LegacyHandleFile) {
    Write-Warning "发现旧版句柄文件 $LegacyHandleFile（已不再使用），请用普通权限手动删除。"
}

Assert-NotReparsePoint -Path $InstallRoot -Label "安装目录"
if (Test-Path -LiteralPath $InstallRoot) {
    Remove-Item -LiteralPath $InstallRoot -Recurse -Force -ErrorAction Stop
}
New-Item -ItemType Directory -Path $InstallBrokerDir -Force | Out-Null
New-Item -ItemType Directory -Path $InstallCoreDir -Force | Out-Null
Assert-NotReparsePoint -Path $InstallRoot -Label "安装目录"

Copy-Item -LiteralPath $BrokerSrc -Destination (Join-Path $InstallBrokerDir "broker.mjs") -Force -ErrorAction Stop
Copy-Item -LiteralPath $PolicySrc -Destination (Join-Path $InstallCoreDir "broker-policy.js") -Force -ErrorAction Stop
Copy-Item -LiteralPath $GuardSrc  -Destination (Join-Path $InstallCoreDir "guard.js") -Force -ErrorAction Stop

# 5) config.json ------------------------------------------------------------
$config = [ordered]@{
    allowedCwdRoots = [object[]]$cwdRoots
    handleFile      = $HandleFile
    runDir          = $RunDir
    logFile         = $LogFile
}
$configJson = $config | ConvertTo-Json -Depth 5
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($ConfigFile, $configJson + "`n", $utf8NoBom)

# 复核 config.json 真的能被读成「数组 + 绝对路径」，避免写坏了才在启动时才发现。
$configCheck = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
if ($configCheck.allowedCwdRoots -isnot [array] -or @($configCheck.allowedCwdRoots).Count -eq 0) {
    throw "config.json 的 allowedCwdRoots 没有写成非空数组：$ConfigFile"
}
foreach ($field in @("handleFile", "runDir", "logFile")) {
    $value = $configCheck.$field
    if (-not $value -or -not [IO.Path]::IsPathRooted([string]$value)) {
        throw "config.json 的 $field 不是绝对路径：$value"
    }
}

# 6) 安装目录 ACL：去继承 + 只给 Administrators/SYSTEM 完全控制 + Users 只读执行
Invoke-Icacls -Arguments @(
    $InstallRoot,
    "/inheritance:r",
    "/grant:r",
    "*S-1-5-32-544:(OI)(CI)F",
    "*S-1-5-18:(OI)(CI)F",
    "*S-1-5-32-545:(OI)(CI)RX"
)
# owner 设成 Administrators：owner 永远能改 ACL，不能留给普通用户。
Invoke-Icacls -Arguments @($InstallRoot, "/setowner", "*S-1-5-32-544")
Assert-ProtectedDirectory -Path $InstallRoot -Label "安装目录（$InstallRoot）"

# 7) ProgramData 运行目录 ACL：只有 Administrators/SYSTEM 可写 -----------------
Assert-NotReparsePoint -Path $DataRoot -Label "运行数据目录"
if (Test-Path -LiteralPath $RunDir) {
    Assert-NotReparsePoint -Path $RunDir -Label "运行目录"
    Remove-Item -LiteralPath $RunDir -Recurse -Force -ErrorAction Stop
}
if (-not (Test-Path -LiteralPath $DataRoot)) {
    New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null
}
Assert-NotReparsePoint -Path $DataRoot -Label "运行数据目录"

# 先把 DataRoot 加固，再创建 RunDir，避免新目录先继承一遍宽松权限。
# DataRoot 放日志和 run 目录：Users 一律无权限（日志里有命令原文）。
Invoke-Icacls -Arguments @(
    $DataRoot,
    "/inheritance:r",
    "/grant:r",
    "*S-1-5-32-544:(OI)(CI)F",
    "*S-1-5-18:(OI)(CI)F"
)
Invoke-Icacls -Arguments @($DataRoot, "/setowner", "*S-1-5-32-544")
Assert-ProtectedDirectory -Path $DataRoot -Label "运行数据目录（$DataRoot）"

# 句柄目录：broker 只往这里写端口 / 会话密钥。普通用户（包括安装时的当前用户）只读，
# 同机其它账号无权限。先确认不是联接点，再创建、加固，最后复核。
Assert-NotReparsePoint -Path $HandleDir -Label "句柄目录"
if (-not (Test-Path -LiteralPath $HandleDir)) {
    New-Item -ItemType Directory -Path $HandleDir -Force | Out-Null
}
Assert-NotReparsePoint -Path $HandleDir -Label "句柄目录"

$handleGrantArgs = @(
    $HandleDir,
    "/inheritance:r",
    "/grant:r",
    "*S-1-5-32-544:(OI)(CI)F",
    "*S-1-5-18:(OI)(CI)F"
)
# 安装用户只读；如果安装身份本身就是 SYSTEM / Administrators，就不要重复授权。
if ($InstallerSid -ne "S-1-5-18" -and $InstallerSid -ne "S-1-5-32-544") {
    $handleGrantArgs += "*$($InstallerSid):(OI)(CI)RX"
}
Invoke-Icacls -Arguments $handleGrantArgs
Invoke-Icacls -Arguments @($HandleDir, "/setowner", "*S-1-5-32-544")
Assert-ProtectedHandleDirectory -Path $HandleDir -Label "句柄目录（$HandleDir）"

New-Item -ItemType Directory -Path $RunDir -Force | Out-Null
Assert-NotReparsePoint -Path $RunDir -Label "运行目录"

# run 目录：命令文件落在这里，同样只有 Administrators/SYSTEM 可写。
# 重新设一遍，保证它是独立加固过的（即使以后 DataRoot 的 ACL 被改也不继承）。
Invoke-Icacls -Arguments @(
    $RunDir,
    "/inheritance:r",
    "/grant:r",
    "*S-1-5-32-544:(OI)(CI)F",
    "*S-1-5-18:(OI)(CI)F"
)
Invoke-Icacls -Arguments @($RunDir, "/setowner", "*S-1-5-32-544")
Assert-ProtectedDirectory -Path $RunDir -Label "运行目录（$RunDir）"

# 8) 注册计划任务 -----------------------------------------------------------
$InstalledBroker = Join-Path $InstallBrokerDir "broker.mjs"
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name

$principal = New-ScheduledTaskPrincipal `
    -UserId $currentUser `
    -LogonType Interactive `
    -RunLevel Highest

$action = New-ScheduledTaskAction `
    -Execute $NodePath `
    -Argument ('"{0}"' -f $InstalledBroker) `
    -WorkingDirectory $InstallRoot

$triggers = @(
    (New-ScheduledTaskTrigger -AtStartup),
    (New-ScheduledTaskTrigger -AtLogOn -User $currentUser)
)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $triggers `
    -Principal $principal `
    -Settings $settings `
    -Description "Windrise 管理员代理：只监听 127.0.0.1；命令分级 + 一次性确认 + runDir 哈希校验。" `
    -Force `
    -ErrorAction Stop | Out-Null

# 复核任务确实指向受保护的安装目录，而不是仓库或别的地方。
$registered = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$registeredAction = @($registered.Actions)[0]
if ($null -eq $registeredAction) {
    throw "计划任务 $TaskName 没有 Action。"
}
if (-not $registeredAction.Execute.Equals($NodePath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "计划任务 $TaskName 的 Execute 不是预期的 node.exe：$($registeredAction.Execute)"
}
if ($registeredAction.Arguments.IndexOf($InstalledBroker, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw "计划任务 $TaskName 的参数没有指向安装目录：$($registeredAction.Arguments)"
}
$taskBrokerArg = ([string]$registeredAction.Arguments).Trim().Trim('"')
if (-not (Test-PathUnder -Candidate $taskBrokerArg -Root $InstallRoot)) {
    throw "计划任务 $TaskName 的参数不在安装目录内：$($registeredAction.Arguments)"
}

Write-Host "已安装管理员代理（更新代理 = 重新运行本脚本）。"
Write-Host "  安装目录  ：$InstallRoot"
Write-Host "  程序      ：$NodePath"
Write-Host "  参数      ：$InstalledBroker"
Write-Host "  工作目录  ：$InstallRoot"
Write-Host "  允许 cwd  ：$($cwdRoots -join ' / ')"
Write-Host "  句柄文件  ：$HandleFile（broker 启动时写入）"
Write-Host "  运行目录  ：$RunDir（只有 Administrators / SYSTEM 可写）"
Write-Host "  日志      ：$LogFile"
Write-Host ""

if ($Start) {
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    Write-Host "已请求启动 $TaskName。Bridge 侧下次提权调用会自动读取新的句柄文件。"
} else {
    Write-Host "没有自动启动。需要现在启动就运行："
    Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
}
