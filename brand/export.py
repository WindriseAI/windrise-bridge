"""Windrise Bridge 图标导出。

先用 Chrome（独立的临时配置，不碰你自己的 Chrome）把 SVG 母版渲染成 1024 的透明 PNG，
再用 Pillow 缩出各个尺寸。48 及以上用完整版，32 及以下用单独重画的小尺寸版（缩图会糊）。

运行：python -I brand/export.py
"""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
OUT = HERE / "export"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
BIG_SIZES = [48, 64, 128, 256, 512, 1024]
SMALL_SIZES = [16, 20, 24, 32]


def render(svg: Path, png: Path, size: int = 1024) -> None:
    """Chrome 无头模式，透明背景，一次渲染一张"""
    with tempfile.TemporaryDirectory() as tmp:
        page = Path(tmp) / "page.html"
        page.write_text(
            f'<html><body style="margin:0;background:transparent">'
            f'<img src="{svg.as_uri()}" width="{size}" height="{size}" style="display:block"></body></html>',
            encoding="utf-8",
        )
        subprocess.run(
            [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files",
             f"--user-data-dir={Path(tmp) / 'prof'}", "--default-background-color=00000000",
             "--force-device-scale-factor=1", f"--window-size={size},{size}", f"--screenshot={png}", page.as_uri()],
            check=True, capture_output=True, timeout=60,
        )


def main() -> None:
    OUT.mkdir(exist_ok=True)
    masters = {}
    for name in ("windrise-bridge-icon", "windrise-bridge-icon-small", "windrise-bridge-mark-mono"):
        png = OUT / f"{name}-1024.png"
        render(HERE / f"{name}.svg", png)
        masters[name] = Image.open(png).convert("RGBA")
        print("渲染", png.name)

    big, small = masters["windrise-bridge-icon"], masters["windrise-bridge-icon-small"]
    frames = {}
    for s in BIG_SIZES:
        img = big if s == 1024 else big.resize((s, s), Image.LANCZOS)
        img.save(OUT / f"icon-{s}.png")
        frames[s] = img
    for s in SMALL_SIZES:
        img = small.resize((s, s), Image.LANCZOS)
        img.save(OUT / f"icon-{s}.png")
        frames[s] = img
    print("尺寸", sorted(frames))

    # Windows 多尺寸 .ico：每个尺寸用自己那一版的图，不让系统从一张大图里缩
    ico_sizes = [16, 20, 24, 32, 48, 64, 128, 256]
    frames[256].save(OUT / "windrise-bridge.ico", format="ICO", sizes=[(s, s) for s in ico_sizes],
                     append_images=[frames[s] for s in ico_sizes if s != 256])
    # 网站用：favicon（32 小尺寸版）、苹果触屏图标 180、网页分享图标 512
    frames[32].save(OUT / "favicon-32.png")
    big.resize((180, 180), Image.LANCZOS).save(OUT / "apple-touch-icon.png")
    masters["windrise-bridge-mark-mono"].resize((512, 512), Image.LANCZOS).save(OUT / "mark-mono-512.png")

    ico = Image.open(OUT / "windrise-bridge.ico")
    print("ico 内含尺寸", sorted(ico.info.get("sizes", [])))


if __name__ == "__main__":
    sys.exit(main())
