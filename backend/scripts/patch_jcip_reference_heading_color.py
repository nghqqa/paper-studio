#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""jcip-reference.docx 的 Heading1-5 颜色改黑（中文期刊标题惯例）。

背景（v0.1.5 用户实测）：reference 模板沿用 Word 主题色（Heading1-5=0F4761 深蓝），
导出的 DOCX/预览 PDF 里「1 引言」等标题是蓝色，不符合中文期刊黑色标题惯例。
幂等：已改则跳过。运行一次即完成资产修补。

用法：python backend/scripts/patch_jcip_reference_heading_color.py
"""
import os
import re
import shutil
import sys
import tempfile
import zipfile

ASSET = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                     "..", "app", "docx_export_assets", "jcip-reference.docx"))


def main() -> int:
    with zipfile.ZipFile(ASSET) as z:
        styles = z.read("word/styles.xml").decode("utf-8")

    changed = 0

    def repl(m: re.Match) -> str:
        nonlocal changed
        block = m.group(0)
        new_block, n = re.subn(r'(<w:color w:val=")[0-9A-Fa-f]{6}(")', r"\1auto\2", block)
        changed += n
        return new_block

    patched = re.sub(r'<w:style [^>]*w:styleId="Heading\d"[^>]*>.*?</w:style>', repl, styles, flags=re.S)
    if changed == 0:
        print("SKIP: Heading 样式无主题色（幂等）")
        return 0

    tmp = tempfile.mktemp(suffix=".docx")
    with zipfile.ZipFile(ASSET) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "word/styles.xml":
                data = patched.encode("utf-8")
            zout.writestr(item, data)
    shutil.move(tmp, ASSET)
    print(f"OK: Heading1-9 颜色改 auto（黑），共 {changed} 处 →", ASSET)
    return 0


if __name__ == "__main__":
    sys.exit(main())
