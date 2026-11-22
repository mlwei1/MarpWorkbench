# -*- coding: utf-8 -*-
"""
用 python-pptx 校验可编辑 PPTX（M4 spike 自测）。

用法：
  python verify_pptx.py <pptx路径> <期望JSON路径> <输出报告JSON路径>

期望 JSON 结构（见 run-sample.mjs 生成）：
{
  "pages": 5,
  "widthIn": 13.3333, "heightIn": 7.5,
  "allTextContains": ["..."],              # 所有 a:t 合并后必须包含的字符串
  "slideTextContains": [["a","b"], ...],   # 每页文本必须包含的字符串（下标=页-1）
  "notesContains": [["..."], ...],         # 每页备注必须包含的字符串（可为空数组）
  "tablesMin": 1,
  "runFontPropsMin": 2,
  "backgroundMinBytes": 10000
}
"""
import io
import json
import sys

from pptx import Presentation

EMU_PER_INCH = 914400


def fail(checks, name, detail):
    checks.append({"check": name, "ok": False, "detail": detail})


def ok(checks, name, detail=""):
    checks.append({"check": name, "ok": True, "detail": detail})


def image_info(blob):
    info = {"bytes": len(blob), "width": None, "height": None, "format": None}
    try:
        from PIL import Image  # noqa

        with Image.open(io.BytesIO(blob)) as im:
            info["width"], info["height"] = im.size
            info["format"] = im.format
    except Exception as exc:  # pragma: no cover
        info["error"] = str(exc)
    return info


def main():
    if len(sys.argv) < 3:
        print("usage: verify_pptx.py <pptx> <expect.json> [report.json]", file=sys.stderr)
        return 2
    pptx_path, expect_path = sys.argv[1], sys.argv[2]
    report_path = sys.argv[3] if len(sys.argv) > 3 else None

    with open(expect_path, "r", encoding="utf-8") as fh:
        expect = json.load(fh)

    checks = []
    prs = Presentation(pptx_path)
    slides = list(prs.slides)

    width_in = prs.slide_width / EMU_PER_INCH
    height_in = prs.slide_height / EMU_PER_INCH
    report = {
        "file": pptx_path,
        "bytes": None,
        "slideCount": len(slides),
        "slideWidthEmu": prs.slide_width,
        "slideHeightEmu": prs.slide_height,
        "sizeInches": {"width": round(width_in, 4), "height": round(height_in, 4)},
        "slides": [],
        "checks": checks,
    }
    try:
        import os

        report["bytes"] = os.path.getsize(pptx_path)
    except OSError:
        pass

    if len(slides) == expect.get("pages"):
        ok(checks, "pages", "页数 = %s" % len(slides))
    else:
        fail(checks, "pages", "期望 %s 页，实际 %s 页" % (expect.get("pages"), len(slides)))

    for key, actual in (("widthIn", width_in), ("heightIn", height_in)):
        want = expect.get(key)
        if want is None:
            continue
        if abs(actual - want) <= 0.02:
            ok(checks, "slide_%s" % key, "实际 %.4f 英寸（期望 %.4f）" % (actual, want))
        else:
            fail(checks, "slide_%s" % key, "实际 %.4f 英寸，期望 %.4f" % (actual, want))

    all_text_chunks = []
    table_count = 0
    run_font_props = 0
    notes_pages = 0

    for idx, slide in enumerate(slides):
        info = {
            "index": idx + 1,
            "blipFill": False,
            "backgroundImages": [],
            "texts": [],
            "tables": [],
            "shapeCount": len(slide.shapes),
            "notes": "",
        }
        xml = slide._element.xml
        info["blipFill"] = "blipFill" in xml
        # 背景图：slide part 的图片 relationship
        try:
            for rel in slide.part.rels.values():
                if "image" in rel.reltype:
                    blob = rel.target_part.blob
                    info["backgroundImages"].append(image_info(blob))
        except Exception as exc:  # pragma: no cover
            info["backgroundImagesError"] = str(exc)

        for shape in slide.shapes:
            if getattr(shape, "has_text_frame", False):
                text = shape.text_frame.text
                if text.strip():
                    info["texts"].append(text)
                    all_text_chunks.append(text)
                    # 文本框应落在页面范围内（±0.1 英寸容差）
                    try:
                        left = shape.left or 0
                        top = shape.top or 0
                        right = left + (shape.width or 0)
                        bottom = top + (shape.height or 0)
                        tol = 100000
                        if left < -tol or top < -tol or right > prs.slide_width + tol or bottom > prs.slide_height + tol:
                            info.setdefault("outOfBounds", []).append(text[:30])
                    except Exception:
                        pass
                    for paragraph in shape.text_frame.paragraphs:
                        for run in paragraph.runs:
                            if run.font.size is not None and run.font.name:
                                run_font_props += 1
            if getattr(shape, "has_table", False):
                table_count += 1
                rows = []
                for row in shape.table.rows:
                    cells = [cell.text for cell in row.cells]
                    rows.append(cells)
                    all_text_chunks.extend([c for c in cells if c.strip()])
                info["tables"].append(rows)
        if getattr(slide, "has_notes_slide", False):
            try:
                notes = slide.notes_slide.notes_text_frame.text
            except Exception:
                notes = ""
            info["notes"] = notes
            if notes.strip():
                notes_pages += 1
                all_text_chunks.append(notes)

        # 每页断言
        if info["blipFill"]:
            ok(checks, "slide%d_blipFill" % (idx + 1), "背景 XML 含 blipFill")
        else:
            fail(checks, "slide%d_blipFill" % (idx + 1), "背景 XML 不含 blipFill")
        if info["backgroundImages"]:
            if info["backgroundImages"][0]["bytes"] >= expect.get("backgroundMinBytes", 1):
                ok(checks, "slide%d_backgroundImage" % (idx + 1), str(info["backgroundImages"][0]))
            else:
                fail(checks, "slide%d_backgroundImage" % (idx + 1), "背景图过小 %s" % info["backgroundImages"][:1])
            want_size = expect.get("bgImageSize")
            if want_size:
                first = info["backgroundImages"][0]
                if first.get("width") == want_size[0] and first.get("height") == want_size[1]:
                    ok(checks, "slide%d_bgImageSize" % (idx + 1), "%sx%s" % (first["width"], first["height"]))
                else:
                    fail(checks, "slide%d_bgImageSize" % (idx + 1), "背景图尺寸 %sx%s，期望 %sx%s" % (first.get("width"), first.get("height"), want_size[0], want_size[1]))
        else:
            fail(checks, "slide%d_backgroundImage" % (idx + 1), "找不到背景图片 relationship")

        if info.get("outOfBounds"):
            fail(checks, "slide%d_shapeBounds" % (idx + 1), "越界文本：%s" % info["outOfBounds"][:3])
        else:
            ok(checks, "slide%d_shapeBounds" % (idx + 1), "文本形状均在页面范围内")

        wanted_texts = []
        if idx < len(expect.get("slideTextContains", [])):
            wanted_texts = expect["slideTextContains"][idx]
        table_flat = []
        for table in info["tables"]:
            for row in table:
                table_flat.extend([cell for cell in row if cell.strip()])
        slide_text = "\n".join(info["texts"]) + "\n" + "\n".join(table_flat)
        for want in wanted_texts:
            if want in slide_text:
                ok(checks, "slide%d_text_%s" % (idx + 1, want[:12]), "包含：%s" % want)
            else:
                fail(checks, "slide%d_text_%s" % (idx + 1, want[:12]), "缺少：%s（实际 %d 字）" % (want, len(slide_text)))

        wanted_notes = []
        if idx < len(expect.get("notesContains", [])):
            wanted_notes = expect["notesContains"][idx]
        for want in wanted_notes:
            if want in info["notes"]:
                ok(checks, "slide%d_notes" % (idx + 1), "备注包含：%s" % want)
            else:
                fail(checks, "slide%d_notes" % (idx + 1), "备注缺少：%s（实际：%r）" % (want, info["notes"][:120]))

        report["slides"].append(info)

    all_text = "\n".join(all_text_chunks)
    for want in expect.get("allTextContains", []):
        if want in all_text:
            ok(checks, "allText_%s" % want[:16], "全局包含：%s" % want)
        else:
            fail(checks, "allText_%s" % want[:16], "全局缺少：%s" % want)

    if table_count >= expect.get("tablesMin", 1):
        ok(checks, "tables", "a:tbl 表格对象数 = %d" % table_count)
    else:
        fail(checks, "tables", "表格对象数 %d，期望 ≥ %d" % (table_count, expect.get("tablesMin", 1)))

    if run_font_props >= expect.get("runFontPropsMin", 2):
        ok(checks, "runFontProps", "含 fontSize+fontFace 的 run 数 = %d" % run_font_props)
    else:
        fail(checks, "runFontProps", "含 fontSize+fontFace 的 run 数 = %d，期望 ≥ %d" % (run_font_props, expect.get("runFontPropsMin", 2)))

    if notes_pages >= expect.get("notesPagesMin", 1):
        ok(checks, "notes", "有备注的页数 = %d" % notes_pages)
    else:
        fail(checks, "notes", "有备注的页数 = %d，期望 ≥ %d" % (notes_pages, expect.get("notesPagesMin", 1)))

    report["summary"] = {
        "tables": table_count,
        "runFontProps": run_font_props,
        "notesPages": notes_pages,
        "allTextChars": len(all_text),
        "slides": len(slides),
        "checks": len(checks),
        "passed": len([c for c in checks if c["ok"]]),
        "failed": len([c for c in checks if not c["ok"]]),
    }

    if report_path:
        with open(report_path, "w", encoding="utf-8") as fh:
            json.dump(report, fh, ensure_ascii=False, indent=2)
    print(json.dumps(report["summary"], ensure_ascii=False))
    failures = [c for c in checks if not c["ok"]]
    if failures:
        for item in failures:
            print("[FAIL] %s: %s" % (item["check"], item["detail"]), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
