#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Validate an editable MarpWorkbench PPTX export (called by scripts/verify-editable-pptx.mjs).

Usage:
  python scripts/dev/check-editable-pptx.py <pptx> --slides 13 --width-in 13.333 --height-in 7.5 \
      --require "M4 可编辑导出" --require "const editable = true" --require "指标" \
      --require-notes "讲稿" --require-tables 1

Prints one JSON object to stdout. Exit code 0 when all checks pass, 1 otherwise.
"""
import argparse
import json
import os
import sys

from pptx import Presentation


def slide_background_info(slide):
    xml = slide._element.xml
    has_bg = "<p:bg" in xml
    has_blip = "<a:blipFill" in xml
    # count image relationships on this slide
    blips = 0
    try:
        blips = xml.count("<a:blip")
    except Exception:
        pass
    return has_bg, has_blip, blips


def all_text(slide):
    parts = []
    for shape in slide.shapes:
        if shape.has_text_frame:
            parts.append(shape.text_frame.text)
        if getattr(shape, "has_table", False):
            for row in shape.table.rows:
                for cell in row.cells:
                    parts.append(cell.text_frame.text)
    if slide.has_notes_slide:
        try:
            parts.append(slide.notes_slide.notes_text_frame.text or "")
        except Exception:
            pass
    return "\n".join(parts)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("pptx")
    parser.add_argument("--slides", type=int, default=0)
    parser.add_argument("--width-in", type=float, default=0)
    parser.add_argument("--height-in", type=float, default=0)
    parser.add_argument("--require", action="append", default=[])
    parser.add_argument("--require-notes", action="append", default=[])
    parser.add_argument("--require-tables", type=int, default=0)
    parser.add_argument("--min-text-chars", type=int, default=0)
    args = parser.parse_args()

    out = {"ok": False, "path": os.path.abspath(args.pptx)}
    try:
        prs = Presentation(args.pptx)
    except Exception as exc:  # noqa: BLE001
        out["error"] = f"无法打开 PPTX: {exc}"
        print(json.dumps(out, ensure_ascii=False))
        return 1

    slides = list(prs.slides)
    out["slide_count"] = len(slides)
    out["size_in"] = {
        "width": round(prs.slide_width / 914400.0, 4),
        "height": round(prs.slide_height / 914400.0, 4),
    }
    texts = [all_text(s) for s in slides]
    joined = "\n".join(texts)
    out["text_chars"] = len(joined)
    out["text_sample"] = joined.replace("\n", " | ")[:1200]
    out["notes"] = []
    out["tables"] = 0
    out["bg_blip_slides"] = 0
    for idx, s in enumerate(slides):
        try:
            notes = s.notes_slide.notes_text_frame.text
            if notes and notes.strip():
                out["notes"].append({"slide": idx + 1, "text": notes.strip()[:300]})
        except Exception:
            pass
        for shape in s.shapes:
            if getattr(shape, "has_table", False):
                out["tables"] += 1
        has_bg, has_blip, blips = slide_background_info(s)
        if has_blip and blips >= 1:
            out["bg_blip_slides"] += 1

    checks = []

    def chk(name, ok, detail=""):
        checks.append({"name": name, "ok": bool(ok), "detail": str(detail)})

    chk("可被 python-pptx 打开", True)
    if args.slides:
        chk(f"页数 = {args.slides}", len(slides) == args.slides, len(slides))
    if args.width_in and args.height_in:
        chk(
            f"尺寸 ≈ {args.width_in}x{args.height_in} in",
            abs(out["size_in"]["width"] - args.width_in) < 0.06
            and abs(out["size_in"]["height"] - args.height_in) < 0.06,
            out["size_in"],
        )
    for t in args.require:
        chk(f"文本包含：{t}", t in joined)
    for t in args.require_notes:
        chk(f"备注包含：{t}", any(t in n["text"] for n in out["notes"]) if out["notes"] else False, out["notes"][:3])
    if args.require_tables:
        chk(f"表格对象数 ≥ {args.require_tables}", out["tables"] >= args.require_tables, out["tables"])
    if args.min_text_chars:
        chk(f"文本字符数 ≥ {args.min_text_chars}", out["text_chars"] >= args.min_text_chars, out["text_chars"])
    if len(slides):
        chk("每页均有背景图（blipFill）", out["bg_blip_slides"] == len(slides), f"{out['bg_blip_slides']}/{len(slides)}")

    out["checks"] = checks
    out["ok"] = all(c["ok"] for c in checks)
    print(json.dumps(out, ensure_ascii=False))
    return 0 if out["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
