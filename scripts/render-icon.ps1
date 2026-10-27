<#
  渲染图标源图：每个尺寸画一个「圆角方块 + 白色字母 B」，导出成原始 BGRA 像素文件。
  为什么导出原始像素而不是 PNG：组装 .ico 时需要 DIB（BITMAPINFOHEADER + BGRA + AND 掩码），
  用原始像素省掉一次 PNG 解码，Node 侧零依赖就能拼出标准的 ico。

  用法：
    pwsh -NoProfile -File scripts/render-icon.ps1
    pwsh -NoProfile -File scripts/render-icon.ps1 -OutDir build/.icon-raw
#>
param(
  [string]$OutDir = (Join-Path (Split-Path -Parent $PSScriptRoot) "build\.icon-raw"),
  [int[]]$Sizes = @(16, 24, 32, 48, 64, 128, 256)
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $OutDir)) {
  New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

# 背景渐变（蓝）—— 不用任何外部素材
$colorTop = [System.Drawing.Color]::FromArgb(255, 58, 118, 232)
$colorBottom = [System.Drawing.Color]::FromArgb(255, 20, 54, 138)

foreach ($s in $Sizes) {
  $bmp = New-Object System.Drawing.Bitmap -ArgumentList $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  # 圆角方块
  $pad = [Math]::Max(0.5, $s * 0.02)
  $rect = [System.Drawing.RectangleF]::new([single]$pad, [single]$pad, [single]($s - 2 * $pad), [single]($s - 2 * $pad))
  $rad = [single]([Math]::Max(2.0, $s * 0.2))
  $d = [single]($rad * 2)
  $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
  $gp.AddArc([single]$rect.X, [single]$rect.Y, $d, $d, 180, 90)
  $gp.AddArc([single]($rect.Right - $d), [single]$rect.Y, $d, $d, 270, 90)
  $gp.AddArc([single]($rect.Right - $d), [single]($rect.Bottom - $d), $d, $d, 0, 90)
  $gp.AddArc([single]$rect.X, [single]($rect.Bottom - $d), $d, $d, 90, 90)
  $gp.CloseFigure()

  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush -ArgumentList $rect, $colorTop, $colorBottom, ([single]55)
  $g.FillPath($brush, $gp)
  $brush.Dispose()

  # 白色字母 B（居中）
  $fontPx = [single]([Math]::Max(8.0, $s * 0.66))
  $font = New-Object System.Drawing.Font -ArgumentList "Segoe UI", $fontPx, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $textRect = [System.Drawing.RectangleF]::new(0, 0, [single]$s, [single]$s)
  $g.DrawString("B", $font, [System.Drawing.Brushes]::White, $textRect, $fmt)
  $font.Dispose()
  $fmt.Dispose()
  $gp.Dispose()
  $g.Dispose()

  # 取像素：Format32bppArgb 在内存里就是 B,G,R,A 的顺序，正好是 ico 要的 DIB 像素
  $lockRect = New-Object System.Drawing.Rectangle -ArgumentList 0, 0, $s, $s
  $bd = $bmp.LockBits($lockRect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $bytes = New-Object byte[] ([Math]::Abs($bd.Stride) * $s)
  [System.Runtime.InteropServices.Marshal]::Copy($bd.Scan0, $bytes, 0, $bytes.Length)
  $stride = $bd.Stride
  $bmp.UnlockBits($bd)
  $bmp.Dispose()

  $target = Join-Path $OutDir "$s.bgra"
  [System.IO.File]::WriteAllBytes($target, $bytes)
  Write-Host ("rendered {0,3}x{0,-3} -> {1} (stride {2}, {3} bytes)" -f $s, $target, $stride, $bytes.Length)
}

Write-Host "done: $OutDir"
