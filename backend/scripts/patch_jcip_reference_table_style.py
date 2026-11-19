#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""jcip-reference.docx 的 Table 样式补三线：顶线 + 底线（1pt），保留既有表头底线。

背景（v0.1.4 验收，visual-judge 发现）：pandoc 给数据表套 reference 的 Table 样式，
该样式原本只有表头单元格下边线 → 导出的表只有一条线，不满足中文期刊三线表惯例。
pandoc 不透传 booktabs 的 \\toprule/\\bottomrule 到 DOCX 表格边框，只能在样式层补。
运行一次即完成资产修补（幂等：已含 tblBorders 时跳过）。

用法：python backend/scripts/patch_jcip_reference_table_style.py
"""
import os
import re
import shutil
import sys
import tempfile
import zipfile

ASSET = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                     "..", "app", "docx_export_assets", "jcip-reference.docx"))

TBL_BORDERS = (
    '<w:tblBorders>'
    '<w:top w:val="single" w:sz="8" w:space="0" w:color="auto"/>'
    '<w:left w:val="none" w:sz="0" w:space="0" w:color="auto"/>'
    '<w:bottom w:val="single" w:sz="8" w:space="0" w:color="auto"/>'
    '<w:right w:val="none" w:sz="0" w:space="0" w:color="auto"/>'
    '<w:insideH w:val="none" w:sz="0" w:space="0" w:color="auto"/>'
    '<w:insideV w:val="none" w:sz="0" w:space="0" w:color="auto"/>'
    '</w:tblBorders>'
)


def main() -> int:
    with zipfile.ZipFile(ASSET) as z:
        styles = z.read("word/styles.xml").decode("utf-8")
    m = re.search(r'<w:style [^>]*w:type="table"[^>]*>.*?</w:style>', styles, re.S)
    if m is None:
        print("FAIL: reference 中未找到 table 样式")
        return 1
    block = m.group(0)
    if "tblBorders" in block:
        print("SKIP: Table 样式已含 tblBorders（幂等）")
        return 0
    # tblBorders 插到 tblCellMar 之前（schema 顺序：tblBorders 在 tblCellMar/tblLook 之前）
    anchor = block.find("<w:tblCellMar")
    if anchor < 0:
        anchor = block.find("</w:tblPr>")
    if anchor < 0:
        print("FAIL: Table 样式无 tblPr 收尾锚点")
        return 1
    patched_block = block[:anchor] + TBL_BORDERS + block[anchor:]
    patched_styles = styles[:m.start()] + patched_block + styles[m.end():]

    tmp = tempfile.mktemp(suffix=".docx")
    with zipfile.ZipFile(ASSET) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "word/styles.xml":
                data = patched_styles.encode("utf-8")
            zout.writestr(item, data)
    shutil.move(tmp, ASSET)
    print("OK: Table 样式已补三线（top/bottom 1pt，其余无线）→", ASSET)
    return 0


if __name__ == "__main__":
    sys.exit(main())
