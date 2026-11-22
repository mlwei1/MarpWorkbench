# -*- coding: utf-8 -*-
"""生成 spike 样例背景图（PNG data URI），并写入 harness/sample.md 的 `![bg right:38%](...)` 行。

为什么不用 SVG data URI：markdown-it（marp-core 用的 markdown 解析器）为了防 XSS
只允许 data:image/gif|png|jpeg|webp，`data:image/svg+xml` 不会被解析成图片，
而是变成字面文本（实测）。因此这里用 PNG。

运行：python gen-sample-bg.py（一次性；产物已写入 sample.md）
"""
import base64
import io
import re
from pathlib import Path

from PIL import Image, ImageDraw

here = Path(__file__).resolve().parent
harness = here.parent / "harness"
out_dir = here.parent / "out"
out_dir.mkdir(parents=True, exist_ok=True)

W, H = 320, 576
img = Image.new("RGB", (W, H))
px = img.load()
for y in range(H):
    for x in range(W):
        t = (x / W + y / H) / 2.0
        r = int(245 + (239 - 245) * t)
        g = int(158 + (68 - 158) * t)
        b = int(11 + (68 - 11) * t)
        px[x, y] = (r, g, b)
draw = ImageDraw.Draw(img, "RGBA")
draw.ellipse((40, 170, 280, 410), fill=(255, 255, 255, 70))
png_path = out_dir / "sample-bg.png"
img.save(png_path, "PNG", optimize=True)
raw = png_path.read_bytes()
b64 = base64.b64encode(raw).decode("ascii")
data_uri = "data:image/png;base64," + b64
print(f"PNG {len(raw)} B, data URI {len(data_uri)} chars")

md_path = harness / "sample.md"
md = md_path.read_text(encoding="utf-8")
new_line = f"![bg right:38%]({data_uri})"
md2, n = re.subn(r"^!\[bg right:38%\]\([^\n]*\)$", new_line, md, flags=re.MULTILINE)
if n != 1:
    raise SystemExit(f"未找到要替换的 bg 图片行（匹配 {n} 次）")
md_path.write_text(md2, encoding="utf-8")
print(f"已写入 {md_path}（替换 {n} 行）")
