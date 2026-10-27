<#
  打包产物端到端验证（Windows 专用）。

  做四件事：
    1) 启动 dist\win-unpacked\Windrise Bridge.exe（启动前清掉 ELECTRON_RUN_AS_NODE）
    2) 用 user32!EnumWindows 枚举这个进程的可见顶层窗口 —— 证明「窗口真的出现了」
    3) 把窗口区域截屏存成 PNG —— 证明「界面真的渲染了」
    4) 调 scripts/smoke-packaged.mjs --attach：CDP 点「启动 Bridge」、读 #mcp-url、打 healthz 和 MCP 握手
    5) 收尾：taskkill 掉整棵进程树，并确认没有残留

  用法：
    pwsh -NoProfile -File scripts/verify-packaged.ps1
    pwsh -NoProfile -File scripts/verify-packaged.ps1 -Exe "D:\...\Windrise Bridge.exe" -Port 9223
#>
param(
  [string]$Exe = (Join-Path (Split-Path -Parent $PSScriptRoot) "dist\win-unpacked\Windrise Bridge.exe"),
  [int]$Port = 9223,
  [string]$OutDir = (Join-Path (Split-Path -Parent $PSScriptRoot) "dist"),
  [int]$WindowWaitSeconds = 90,
  [switch]$KeepRunning
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Exe)) { throw "找不到可执行文件：$Exe" }
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public class BridgeWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<string> List(uint pid) {
    var outList = new List<string>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) {
        var sb = new StringBuilder(512); GetWindowTextW(h, sb, sb.Capacity);
        RECT r; GetWindowRect(h, out r);
        outList.Add(sb.ToString() + " | " + (r.Right - r.Left) + "x" + (r.Bottom - r.Top) + " @" + r.Left + "," + r.Top + " | hwnd=" + h.ToInt64());
      }
      return true;
    }, IntPtr.Zero);
    return outList;
  }
  public static IntPtr First(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static bool Rect(IntPtr h, out RECT r) { return GetWindowRect(h, out r); }
}
"@

$exeDir = Split-Path -Parent $Exe

# portable 版是个自解压壳：真正的窗口属于它的子进程，所以找窗口时要连子孙进程一起看
function Get-ProcessTree([int]$rootPid) {
  $all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId, ParentProcessId
  $ids = New-Object System.Collections.Generic.List[int]
  $ids.Add($rootPid)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($p in $all) {
      if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {
        $ids.Add([int]$p.ProcessId); $changed = $true
      }
    }
  }
  return $ids
}

function Find-Window([int]$rootPid) {
  foreach ($id in (Get-ProcessTree $rootPid)) {
    $h = [BridgeWin]::First([uint32]$id)
    if ($h -ne [IntPtr]::Zero) { return [pscustomobject]@{ hwnd = $h; pid = $id } }
  }
  return $null
}

# 1) 启动
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Write-Host "[verify] 启动：$Exe --remote-debugging-port=$Port（cwd=$exeDir）"
$proc = Start-Process -FilePath $Exe -ArgumentList "--remote-debugging-port=$Port" -WorkingDirectory $exeDir -PassThru
Write-Host "[verify] pid=$($proc.Id)"

try {
  # 2) 等窗口出现
  $found = $null
  $deadline = (Get-Date).AddSeconds($WindowWaitSeconds)
  while ((Get-Date) -lt $deadline) {
    $found = Find-Window $proc.Id
    if ($found) { break }
    if ($proc.HasExited) { throw "进程提前退出（exit code $($proc.ExitCode)）—— 大概率是 ELECTRON_RUN_AS_NODE 之类的问题" }
    Start-Sleep -Milliseconds 500
  }
  if (-not $found) { throw "$WindowWaitSeconds 秒内没有出现可见窗口" }
  $hwnd = $found.hwnd
  Write-Host "[verify] 窗口属于 pid $($found.pid)（启动器 pid $($proc.Id)）"
  Write-Host "[verify] 可见窗口："
  foreach ($line in [BridgeWin]::List([uint32]$found.pid)) { Write-Host "  $line" }

  # 3) 截屏窗口区域
  [BridgeWin]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 900
  $rect = New-Object BridgeWin+RECT
  [BridgeWin]::Rect($hwnd, [ref]$rect) | Out-Null
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  $shot = Join-Path $OutDir "verify-window.png"
  $bmp = New-Object System.Drawing.Bitmap -ArgumentList $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $g.Dispose()
  $bmp.Save($shot, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "[verify] 窗口截图：$shot（$w x $h，$((Get-Item $shot).Length) 字节）"

  # 4) CDP 冒烟（点「启动 Bridge」→ 读 MCP 地址 → 握手）
  $smoke = Join-Path $PSScriptRoot "smoke-packaged.mjs"
  Write-Host "[verify] CDP 冒烟：node $smoke --attach --port $Port --no-kill"
  & node $smoke --attach --port $Port --no-kill --shot (Join-Path $OutDir "verify-cdp.png")
  $smokeExit = $LASTEXITCODE
  Write-Host "[verify] 冒烟退出码：$smokeExit"
} finally {
  # 5) 收尾
  if ($KeepRunning) {
    Write-Host "[verify] -KeepRunning：保留进程 $($proc.Id)"
  } else {
    Write-Host "[verify] 收尾：taskkill /PID $($proc.Id) /T /F"
    $tree = @(Get-ProcessTree $proc.Id)
    taskkill /PID $proc.Id /T /F 2>&1 | ForEach-Object { "  $_" }
    Start-Sleep -Seconds 3
    $alive = @($tree | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    $left = @(Get-Process -Name "Windrise Bridge" -ErrorAction SilentlyContinue)
    if ($alive.Count -eq 0 -and $left.Count -eq 0) {
      Write-Host "[verify] 已清理干净：进程树（$($tree.Count) 个 pid）全部退出，也没有残留的 Windrise Bridge 进程"
    } else {
      Write-Host "[verify] 警告：仍在运行 -> 树内 pid: $($alive -join ','); Windrise Bridge 进程: $($left.Id -join ',')"
    }
  }
}

if ($smokeExit -ne 0) { exit $smokeExit }
