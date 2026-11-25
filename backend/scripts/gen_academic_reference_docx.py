#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成通用单栏学术论文 Pandoc reference.docx（academic-reference.docx）。

基于 jcip-reference.docx（已具备 Pandoc 全部内置样式 ID 与三线表样式）改造：
1. A4 标准单栏页面（210×297mm，上下 2.54cm、左右 2.8cm），清空期刊固定页眉，保留居中自动页码；
2. 统一中英文字体（中文宋体/黑体 + 英文 Times New Roman）与黑色标题（消除 Word 默认蓝色标题）；
3. 正文小四（12pt）、1.35 倍行距、两端对齐、首行缩进 2 字符；标题/图注/表注/参考文献各司其职；
4. 保持三线表样式，全程 lxml 良构校验。

用法：python backend/scripts/gen_academic_reference_docx.py
"""
from __future__ import annotations

import os
import zipfile

import lxml.etree as ET

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ASSETS_DIR = os.path.join(REPO_ROOT, "backend", "app", "docx_export_assets")
SRC_REF = os.path.join(ASSETS_DIR, "jcip-reference.docx")
DST_REF = os.path.join(ASSETS_DIR, "academic-reference.docx")

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W = f"{{{W_NS}}}"


def _get_or_add(parent: ET._Element, tag: str) -> ET._Element:
    el = parent.find(f"{W}{tag}")
    if el is None:
        el = ET.SubElement(parent, f"{W}{tag}")
    return el


def _set_rpr(
    style: ET._Element,
    *,
    ea: str,
    latin: str,
    sz: int,
    bold: bool | None = None,
    italic: bool | None = None,
    color: str | None = "000000",
) -> None:
    rpr = _get_or_add(style, "rPr")
    rf = _get_or_add(rpr, "rFonts")
    rf.set(f"{W}ascii", latin)
    rf.set(f"{W}hAnsi", latin)
    rf.set(f"{W}cs", latin)
    rf.set(f"{W}eastAsia", ea)
    for attr in ("asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme"):
        rf.attrib.pop(f"{W}{attr}", None)

    for tag in ("sz", "szCs"):
        el = _get_or_add(rpr, tag)
        el.set(f"{W}val", str(sz))

    if bold is not None:
        for tag in ("b", "bCs"):
            existing = rpr.find(f"{W}{tag}")
            if bold:
                if existing is None:
                    ET.SubElement(rpr, f"{W}{tag}")
                else:
                    existing.attrib.pop(f"{W}val", None)
            elif existing is not None:
                rpr.remove(existing)

    if italic is not None:
        for tag in ("i", "iCs"):
            existing = rpr.find(f"{W}{tag}")
            if italic:
                if existing is None:
                    ET.SubElement(rpr, f"{W}{tag}")
                else:
                    existing.attrib.pop(f"{W}val", None)
            elif existing is not None:
                rpr.remove(existing)

    if color is not None:
        col = _get_or_add(rpr, "color")
        col.set(f"{W}val", color)
        for attr in ("themeColor", "themeTint", "themeShade"):
            col.attrib.pop(f"{W}{attr}", None)


def _set_ppr(
    style: ET._Element,
    *,
    jc: str | None = None,
    before: int | None = None,
    after: int | None = None,
    line: int | None = None,
    line_rule: str = "auto",
    first_line: int | None = None,
    first_line_chars: int | None = None,
    left: int | None = None,
    right: int | None = None,
    hanging: int | None = None,
    keep_next: bool | None = None,
) -> None:
    ppr = _get_or_add(style, "pPr")
    if jc is not None:
        _get_or_add(ppr, "jc").set(f"{W}val", jc)
    if before is not None or after is not None or line is not None:
        sp = _get_or_add(ppr, "spacing")
        if before is not None:
            sp.set(f"{W}before", str(before))
        if after is not None:
            sp.set(f"{W}after", str(after))
        if line is not None:
            sp.set(f"{W}line", str(line))
            sp.set(f"{W}lineRule", line_rule)
    if any(v is not None for v in (first_line, first_line_chars, left, right, hanging)):
        ind = _get_or_add(ppr, "ind")
        for attr in ("firstLine", "firstLineChars", "hanging", "hangingChars", "left", "right"):
            ind.attrib.pop(f"{W}{attr}", None)
        if first_line is not None and first_line > 0:
            ind.set(f"{W}firstLine", str(first_line))
        if first_line_chars is not None and first_line_chars > 0:
            ind.set(f"{W}firstLineChars", str(first_line_chars))
        if left is not None and left > 0:
            ind.set(f"{W}left", str(left))
        if right is not None and right > 0:
            ind.set(f"{W}right", str(right))
        if hanging is not None and hanging > 0:
            ind.set(f"{W}hanging", str(hanging))
    if keep_next is not None:
        kn = ppr.find(f"{W}keepNext")
        if keep_next and kn is None:
            ET.SubElement(ppr, f"{W}keepNext")
        elif not keep_next and kn is not None:
            ppr.remove(kn)


def _patch_document_xml(raw: bytes) -> bytes:
    root = ET.fromstring(raw)
    body = root.find(f"{W}body")
    assert body is not None
    sect = body.find(f"{W}sectPr")
    if sect is None:
        sect = ET.SubElement(body, f"{W}sectPr")

    # 移除双栏与 continuous 分节类型，恢复标准 A4 单栏；开启 titlePg 让封面首页不印页码
    for tag in ("type", "cols", "titlePg"):
        for old in sect.findall(f"{W}{tag}"):
            sect.remove(old)
    ET.SubElement(sect, f"{W}titlePg")

    pgsz = _get_or_add(sect, "pgSz")
    pgsz.set(f"{W}w", "11906")   # A4 210mm
    pgsz.set(f"{W}h", "16838")   # A4 297mm

    pgmar = _get_or_add(sect, "pgMar")
    pgmar.set(f"{W}top", "1440")     # 2.54cm
    pgmar.set(f"{W}bottom", "1440")  # 2.54cm
    pgmar.set(f"{W}left", "1587")    # 2.80cm
    pgmar.set(f"{W}right", "1587")   # 2.80cm
    pgmar.set(f"{W}header", "851")   # 1.50cm
    pgmar.set(f"{W}footer", "992")   # 1.75cm
    pgmar.set(f"{W}gutter", "0")

    cols = ET.SubElement(sect, f"{W}cols")
    cols.set(f"{W}space", "425")

    return ET.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def _patch_header_xml(raw: bytes) -> bytes:
    """清空期刊专属页眉文字，保持干净空白页眉。"""
    root = ET.fromstring(raw)
    for t in root.iter(f"{W}t"):
        t.text = ""
    return ET.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def _patch_styles_xml(raw: bytes) -> bytes:
    root = ET.fromstring(raw)

    # 同步 docDefaults 字体为宋体 + Times New Roman，小四（12pt = sz 24）
    rpr_def = root.find(f"{W}docDefaults/{W}rPrDefault/{W}rPr")
    if rpr_def is not None:
        rf = _get_or_add(rpr_def, "rFonts")
        rf.set(f"{W}ascii", "Times New Roman")
        rf.set(f"{W}hAnsi", "Times New Roman")
        rf.set(f"{W}cs", "Times New Roman")
        rf.set(f"{W}eastAsia", "SimSun")
        for attr in ("asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme"):
            rf.attrib.pop(f"{W}{attr}", None)
        for tag in ("sz", "szCs"):
            _get_or_add(rpr_def, tag).set(f"{W}val", "24")

    by_id = {st.get(f"{W}styleId"): st for st in root.findall(f"{W}style")}

    # Normal（基础样式，不加首行缩进，以免表格/图注/公式意外缩进）
    if "Normal" in by_id:
        _set_rpr(by_id["Normal"], ea="SimSun", latin="Times New Roman", sz=24, bold=False, color="000000")
        _set_ppr(by_id["Normal"], jc="both", before=0, after=60, line=324, first_line=0)

    # BodyText / FirstParagraph（正文段落：首行缩进 2 字符）
    for sid in ("BodyText", "FirstParagraph"):
        if sid in by_id:
            _set_rpr(by_id[sid], ea="SimSun", latin="Times New Roman", sz=24, bold=False, color="000000")
            _set_ppr(by_id[sid], jc="both", before=0, after=80, line=324, first_line=480, first_line_chars=200)

    # 题区：标题、副标题、作者、日期
    if "Title" in by_id:
        _set_rpr(by_id["Title"], ea="SimHei", latin="Times New Roman", sz=36, bold=True, color="000000")
        _set_ppr(by_id["Title"], jc="center", before=120, after=120, line=280, first_line=0, keep_next=True)
    if "Subtitle" in by_id:
        _set_rpr(by_id["Subtitle"], ea="SimHei", latin="Times New Roman", sz=28, bold=False, color="333333")
        _set_ppr(by_id["Subtitle"], jc="center", before=0, after=100, line=280, first_line=0, keep_next=True)
    if "Author" in by_id:
        _set_rpr(by_id["Author"], ea="SimSun", latin="Times New Roman", sz=24, bold=False, color="000000")
        _set_ppr(by_id["Author"], jc="center", before=40, after=60, line=280, first_line=0, keep_next=False)
    if "Date" in by_id:
        _set_rpr(by_id["Date"], ea="SimSun", latin="Times New Roman", sz=21, bold=False, color="444444")
        _set_ppr(by_id["Date"], jc="center", before=0, after=160, line=260, first_line=0, keep_next=False)

    # 摘要标题与正文
    if "AbstractTitle" in by_id:
        _set_rpr(by_id["AbstractTitle"], ea="SimHei", latin="Times New Roman", sz=24, bold=True, color="000000")
        _set_ppr(by_id["AbstractTitle"], jc="center", before=120, after=80, line=280, first_line=0, keep_next=True)
    if "Abstract" in by_id:
        _set_rpr(by_id["Abstract"], ea="SimSun", latin="Times New Roman", sz=21, bold=False, color="000000")
        _set_ppr(by_id["Abstract"], jc="both", before=0, after=140, line=300, left=240, right=240, first_line=0)

    # 各级章节标题（黑体黑色，层次清晰）
    heading_specs = {
        "Heading1": (28, True, 280, 120),  # 四号 14pt
        "Heading2": (24, True, 200, 80),   # 小四 12pt
        "Heading3": (21, True, 140, 60),   # 五号 10.5pt
        "Heading4": (21, True, 100, 40),
        "Heading5": (21, False, 80, 40),
    }
    for sid, (sz, bold, bef, aft) in heading_specs.items():
        if sid in by_id:
            _set_rpr(by_id[sid], ea="SimHei", latin="Times New Roman", sz=sz, bold=bold, color="000000")
            _set_ppr(by_id[sid], jc="left", before=bef, after=aft, line=280, first_line=0, keep_next=True)
        char_sid = sid + "Char"
        if char_sid in by_id:
            _set_rpr(by_id[char_sid], ea="SimHei", latin="Times New Roman", sz=sz, bold=bold, color="000000")

    # 图表题注与图片段落
    for sid in ("Caption", "ImageCaption", "TableCaption"):
        if sid in by_id:
            _set_rpr(by_id[sid], ea="SimHei", latin="Times New Roman", sz=21, bold=False, italic=False, color="000000")
            _set_ppr(by_id[sid], jc="center", before=80, after=100, line=260, first_line=0)
    for sid in ("Figure", "CaptionedFigure"):
        if sid in by_id:
            _set_ppr(by_id[sid], jc="center", before=100, after=40, first_line=0)

    # 参考文献列表：五号宋体、悬挂缩进、两端对齐
    if "Bibliography" in by_id:
        _set_rpr(by_id["Bibliography"], ea="SimSun", latin="Times New Roman", sz=21, bold=False, color="000000")
        _set_ppr(by_id["Bibliography"], jc="both", before=0, after=80, line=280, left=420, hanging=420)

    # 脚注
    for sid in ("FootnoteText", "FootnoteBlockText"):
        if sid in by_id:
            _set_rpr(by_id[sid], ea="SimSun", latin="Times New Roman", sz=18, bold=False, color="000000")
            _set_ppr(by_id[sid], jc="both", before=0, after=40, line=240, first_line=0)

    return ET.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def build() -> str:
    with zipfile.ZipFile(SRC_REF) as zin:
        items = {info.filename: zin.read(info.filename) for info in zin.infolist()}

    items["word/document.xml"] = _patch_document_xml(items["word/document.xml"])
    items["word/styles.xml"] = _patch_styles_xml(items["word/styles.xml"])
    if "word/header1.xml" in items:
        items["word/header1.xml"] = _patch_header_xml(items["word/header1.xml"])

    # 良构校验
    for name in ("word/document.xml", "word/styles.xml"):
        ET.fromstring(items[name])

    tmp = DST_REF + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for name, data in items.items():
            zout.writestr(name, data)
    os.replace(tmp, DST_REF)
    return DST_REF


if __name__ == "__main__":
    out = build()
    print(f"Generated: {out} ({os.path.getsize(out)} bytes)")
