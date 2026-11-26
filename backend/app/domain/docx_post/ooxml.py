# -*- coding: utf-8 -*-
"""OOXML DOM 辅助原语与版心几何计算。"""

from __future__ import annotations

import copy

NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS_M = "http://schemas.openxmlformats.org/officeDocument/2006/math"
DEFAULT_TEXT_W = 9605  # 兜底版心宽（twips）：结构化导出 reference 的 11419 - 907*2
W = "{%s}" % NS_W
M = "{%s}" % NS_M


def _text_width_twips(body) -> int:
    """单栏可用版心宽（twips）：单栏取 pgSz.w - left - right；双栏取 (版心宽 - 栏间距) // 栏数。

    制表位/公式表格必须按**本文档**的节几何计算——单栏与双栏版心不同，
    写死列宽会让编号落在行中或跨栏错位。"""
    sect = body.find(W + "sectPr")
    if sect is None:
        found = body.findall(".//" + W + "sectPr")
        sect = found[-1] if found else None
    if sect is None:
        return DEFAULT_TEXT_W
    pgsz = sect.find(W + "pgSz")
    pgmar = sect.find(W + "pgMar")
    if pgsz is None or pgmar is None:
        return DEFAULT_TEXT_W
    try:
        w = int(pgsz.get(W + "w", "11906"))
        left = int(pgmar.get(W + "left", "1440"))
        right = int(pgmar.get(W + "right", "1440"))
    except (TypeError, ValueError):
        return DEFAULT_TEXT_W
    text_w = max(3000, w - left - right)
    cols = sect.find(W + "cols")
    if cols is not None:
        try:
            num = int(cols.get(W + "num", "1"))
            space = int(cols.get(W + "space", "424"))
            if num > 1:
                text_w = max(2000, (text_w - space * (num - 1)) // num)
        except (TypeError, ValueError):
            pass
    return text_w


def _set_center_no_indent(p) -> None:
    import lxml.etree as ET

    ppr = p.find(W + "pPr")
    if ppr is None:
        ppr = ET.Element(W + "pPr")
        p.insert(0, ppr)
    jc = ppr.find(W + "jc")
    if jc is None:
        jc = ET.SubElement(ppr, W + "jc")
    jc.set(W + "val", "center")
    ind = ppr.find(W + "ind")
    if ind is None:
        ind = ET.SubElement(ppr, W + "ind")
    ind.set(W + "firstLine", "0")
    ind.set(W + "firstLineChars", "0")


def _strip_marker(p, marker: str) -> bool:
    """若段落内包含 marker 文本，将其清除并返回 True。"""
    full = "".join((t.text or "") for t in p.iter(W + "t"))
    if marker not in full:
        return False
    for t in p.iter(W + "t"):
        if t.text and marker in t.text:
            t.text = t.text.replace(marker, "")
    return True


def _apply_font_size(p, sz_val: int) -> None:
    import lxml.etree as ET

    for r in p.findall(W + "r"):
        rpr = r.find(W + "rPr")
        if rpr is None:
            rpr = ET.Element(W + "rPr")
            r.insert(0, rpr)
        for tag in ("sz", "szCs"):
            el_sz = rpr.find(W + tag)
            if el_sz is None:
                el_sz = ET.SubElement(rpr, W + tag)
            el_sz.set(W + "val", str(sz_val))


def _apply_ea_font(p, family: str) -> None:
    import lxml.etree as ET

    for r in p.findall(W + "r"):
        rpr = r.find(W + "rPr")
        if rpr is None:
            rpr = ET.Element(W + "rPr")
            r.insert(0, rpr)
        rf = rpr.find(W + "rFonts")
        if rf is None:
            rf = ET.SubElement(rpr, W + "rFonts")
        rf.set(W + "eastAsia", family)
        rf.set(W + "ascii", "Times New Roman")
        rf.set(W + "hAnsi", "Times New Roman")


def _apply_space_before(p, twips: int) -> None:
    import lxml.etree as ET

    ppr = p.find(W + "pPr")
    if ppr is None:
        ppr = ET.Element(W + "pPr")
        p.insert(0, ppr)
    sp = ppr.find(W + "spacing")
    if sp is None:
        sp = ET.SubElement(ppr, W + "spacing")
    cur = int(sp.get(W + "before", "0") or "0")
    sp.set(W + "before", str(cur + twips))


def _set_table_borderless_centered(tbl) -> None:
    import lxml.etree as ET

    tblpr = tbl.find(W + "tblPr")
    if tblpr is None:
        tblpr = ET.Element(W + "tblPr")
        tbl.insert(0, tblpr)
    jc = tblpr.find(W + "jc")
    if jc is None:
        jc = ET.SubElement(tblpr, W + "jc")
    jc.set(W + "val", "center")
    borders = tblpr.find(W + "tblBorders")
    if borders is None:
        borders = ET.SubElement(tblpr, W + "tblBorders")
    else:
        for old in list(borders):
            borders.remove(old)
    for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
        ET.SubElement(
            borders,
            W + side,
            {W + "val": "none", W + "sz": "0", W + "space": "0", W + "color": "auto"},
        )


def _replace_hfill_with_tab(p, text_w: int) -> None:
    import lxml.etree as ET

    full = "".join((t.text or "") for t in p.iter(W + "t"))
    if "__PS_HFILL__" not in full:
        return
    ppr = p.find(W + "pPr")
    if ppr is None:
        ppr = ET.Element(W + "pPr")
        p.insert(0, ppr)
    ind = ppr.find(W + "ind")
    if ind is None:
        ind = ET.SubElement(ppr, W + "ind")
    ind.set(W + "firstLine", "0")
    ind.set(W + "firstLineChars", "0")
    jc = ppr.find(W + "jc")
    if jc is None:
        jc = ET.SubElement(ppr, W + "jc")
    jc.set(W + "val", "left")
    tabs = ppr.find(W + "tabs")
    if tabs is None:
        tabs = ET.SubElement(ppr, W + "tabs")
    ET.SubElement(tabs, W + "tab", {W + "val": "right", W + "pos": str(text_w)})
    for r in list(p.findall(W + "r")):
        t = r.find(W + "t")
        if t is None or not t.text or "__PS_HFILL__" not in t.text:
            continue
        parts = t.text.split("__PS_HFILL__")
        rpr = r.find(W + "rPr")
        idx_r = list(p).index(r)
        p.remove(r)
        for pi, part in enumerate(parts):
            if part:
                nr = ET.Element(W + "r")
                if rpr is not None:
                    nr.append(copy.deepcopy(rpr))
                nt = ET.SubElement(nr, W + "t")
                nt.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
                nt.text = part
                p.insert(idx_r, nr)
                idx_r += 1
            if pi < len(parts) - 1:
                tr = ET.Element(W + "r")
                ET.SubElement(tr, W + "tab")
                p.insert(idx_r, tr)
                idx_r += 1


def _replace_uline_with_run(p) -> None:
    import lxml.etree as ET

    full = "".join((t.text or "") for t in p.iter(W + "t"))
    if "__PS_ULINE__" not in full:
        return
    for r in list(p.findall(W + "r")):
        t = r.find(W + "t")
        if t is None or not t.text or "__PS_ULINE__" not in t.text:
            continue
        parts = t.text.split("__PS_ULINE__")
        rpr = r.find(W + "rPr")
        idx_r = list(p).index(r)
        p.remove(r)
        for pi, part in enumerate(parts):
            if part:
                nr = ET.Element(W + "r")
                if rpr is not None:
                    nr.append(copy.deepcopy(rpr))
                nt = ET.SubElement(nr, W + "t")
                nt.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
                nt.text = part
                p.insert(idx_r, nr)
                idx_r += 1
            if pi < len(parts) - 1:
                ur = ET.Element(W + "r")
                urpr = copy.deepcopy(rpr) if rpr is not None else ET.Element(W + "rPr")
                if urpr.find(W + "u") is None:
                    ET.SubElement(urpr, W + "u", {W + "val": "single"})
                ur.append(urpr)
                ut = ET.SubElement(ur, W + "t")
                ut.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
                ut.text = "\u00a0" * 12
                p.insert(idx_r, ur)
                idx_r += 1


def _is_empty_plain_para(p) -> bool:
    if p.tag != W + "p":
        return False
    if p.find(f".//{W}sectPr") is not None:
        return False
    if p.find(f".//{W}drawing") is not None or p.find(f".//{M}oMath") is not None:
        return False
    if p.find(f".//{W}br") is not None or p.find(f".//{W}bookmarkStart") is not None:
        return False
    return "".join((t.text or "") for t in p.iter(W + "t")).strip() == ""


def _style_of(p) -> str:
    st = p.find(f"{W}pPr/{W}pStyle")
    return st.get(W + "val", "") if st is not None else ""


def _is_pure_pagebreak(el) -> bool:
    if el.tag != W + "p":
        return False
    if el.find(f".//{W}drawing") is not None or el.find(f".//{M}oMath") is not None:
        return False
    if "".join((t.text or "") for t in el.iter(W + "t")).strip():
        return False
    return any(b.get(W + "type") == "page" for b in el.iter(W + "br"))


def _has_pb_before(el) -> bool:
    return el.tag == W + "p" and el.find(f"{W}pPr/{W}pageBreakBefore") is not None
