# -*- coding: utf-8 -*-
"""公式编号版式后处理：针对 pandoc docx writer 的真实输出结构。

实测结构（结构化生成器产出的 Div(Plain(math+(N))) 经 docx writer）有两种变体：
  V-A  单段合并：<w:p>[书签][oMathPara][(N)][后续文本 runs…]
  V-B  拆分两段：<w:p>[oMathPara]</w:p> + <w:p>[(N)]</w:p>
统一重排为中文期刊惯例的「公式居中 + 编号靠右」（制表位法）：
  P_formula = [tab→居中位][内联 oMath][tab→右位][(N)]
  （oMathPara 会强制独占一行并忽略制表位，必须转为内联 oMath —— 与 Word 用户
    在行内插入公式后用制表位对齐编号的习惯一致；分式尺寸为行内风格，如实记录）
  编号后的正文 runs 移入新段落（保持文流）。
table 模式：公式与编号放入无边框 1×2 表格（左 86% 居中 / 右 12% 靠右），
  后续文本 runs 同样移入新段落。
仅处理满足特征的段落；其余一律不动。
"""
import copy
import os
import re
import shutil
import zipfile

NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS_M = "http://schemas.openxmlformats.org/officeDocument/2006/math"
DEFAULT_TEXT_W = 9605  # 兜底版心宽（twips）：结构化导出 reference 的 11419 - 907*2
W = "{%s}" % NS_W
M = "{%s}" % NS_M


_EQ_NUM_RE = re.compile(r"\(\d{1,3}(?:[.\-]\d{1,3})?\)")


def _num_run_index(p):
    children = list(p)
    for i in range(len(children) - 1, -1, -1):
        el = children[i]
        if el.tag != W + "r":
            continue
        t = el.find(W + "t")
        if t is not None and t.text and _EQ_NUM_RE.fullmatch(t.text.strip()):
            return i, el
    return None, None


def _is_number_para(p) -> bool:
    parts = []
    for child in p:
        if child.tag == W + "pPr":
            continue
        if child.tag == W + "r":
            t = child.find(W + "t")
            if t is not None and t.text:
                parts.append(t.text)
            else:
                return False
        else:
            return False
    joined = "".join(parts).strip()
    return bool(joined) and _EQ_NUM_RE.fullmatch(joined) is not None


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


def apply_eq_layout(docx_path: str, mode: str = "tab", col_w: int | None = None) -> int:
    import lxml.etree as ET

    tmp = docx_path + ".eqtmp"
    shutil.copyfile(docx_path, tmp)
    with zipfile.ZipFile(tmp) as zin:
        items = {i.filename: zin.read(i.filename) for i in zin.infolist()}
    root = ET.fromstring(items["word/document.xml"])
    body = root.find(W + "body")
    text_w = col_w if col_w is not None else _text_width_twips(body)

    def el(tag, parent=None, **attrs):
        e = ET.Element(W + tag, {W + k: v for k, v in attrs.items()})
        if parent is not None:
            parent.append(e)
        return e

    count = 0
    for p in list(body.iter(W + "p")):
        omp = p.find(M + "oMathPara")
        if omp is None:
            continue
        omath = omp.find(M + "oMath")
        if omath is None:
            continue
        num_idx, num_run = _num_run_index(p)
        trailing = []
        next_p = None
        if num_idx is None:
            nxt = p.getnext()
            if nxt is None or nxt.tag != W + "p" or not _is_number_para(nxt):
                continue
            next_p = nxt
            num_run = nxt.findall(W + "r")[-1]
        else:
            trailing = [c for c in list(p)[num_idx + 1:]
                        if c.tag != W + "bookmarkEnd"]

        # 0) 若 oMathPara 前面有正文文本 runs（LaTeX 中未空行导致 Pandoc 合并到同一段），
        #    将前导正文留在原段，新建独立公式段落，保证公式始终独占一行居中！
        idx_om = list(p).index(omp)
        before_om = [c for c in list(p)[:idx_om] if c.tag != W + "pPr"]
        has_leading_text = any(
            (t.text or "").strip() for c in before_om for t in c.iter(W + "t")
        )
        if has_leading_text and p.getparent() is body:
            eq_p = el("p")
            # 把 omp、num_run 及 trailing 移入独立公式段 eq_p（保留前导文本在 p）
            p.remove(omp)
            eq_p.append(omp)
            if num_run.getparent() is p:
                p.remove(num_run)
                eq_p.append(num_run)
            for tr_el in trailing:
                if tr_el.getparent() is p:
                    p.remove(tr_el)
                    eq_p.append(tr_el)
            body.insert(list(body).index(p) + 1, eq_p)
            p = eq_p
            idx_om = list(p).index(omp)

        # 1) oMathPara → 内联 oMath
        p.remove(omp)
        p.insert(idx_om, omath)
        # 2) 段落制表位：居中位 + 列右缘，同时清除正文首行缩进与两端对齐（避免公式左偏）
        ppr = p.find(W + "pPr")
        if ppr is None:
            ppr = el("pPr")
            p.insert(0, ppr)
        ind = ppr.find(W + "ind")
        if ind is None:
            ind = el("ind", ppr)
        ind.set(W + "firstLine", "0")
        ind.set(W + "firstLineChars", "0")
        jc = ppr.find(W + "jc")
        if jc is None:
            jc = el("jc", ppr)
        jc.set(W + "val", "left")
        tabs = ppr.find(W + "tabs")
        if tabs is None:
            tabs = el("tabs")
            ppr.insert(0, tabs)
        el("tab", tabs, val="center", pos=str(text_w // 2))
        el("tab", tabs, val="right", pos=str(text_w - 60))

        if mode == "tab":
            tr1 = el("r")
            el("tab", tr1)
            p.insert(list(p).index(omath), tr1)
            if num_run.getparent() is not p:
                p.append(num_run)
            tr2 = el("r")
            el("tab", tr2)
            p.insert(list(p).index(num_run), tr2)
        elif mode == "table":
            if num_run.getparent() is not p:
                p.append(num_run)
            # 1×3 对称布局：[空|编号宽][公式（居中）][编号（靠右）]——公式格中心恰好
            # 落在版心中点（v0.1.4 验收：1×2 版式公式在左格内居中，整体左偏 ~12mm）
            tbl = el("tbl")
            tblpr = el("tblPr", tbl)
            el("tblW", tblpr, w=str(text_w), type="dxa")
            borders = el("tblBorders", tblpr)
            for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
                el(side, borders, val="none", sz="0", space="0", color="auto")
            el("tblLayout", tblpr, type="fixed")
            grid = el("tblGrid", tbl)
            w_side = 1400  # 两侧对称列宽（twips，≈2.5cm，容纳 (99)）
            w_mid = text_w - 2 * w_side
            for cw in (w_side, w_mid, w_side):
                el("gridCol", grid, w=str(cw))
            tr = el("tr", tbl)
            for cw, child, align in (
                    (w_side, None, None),
                    (w_mid, omath, "center"),
                    (w_side, num_run, "right"),
            ):
                tc = el("tc", tr)
                tcpr = el("tcPr", tc)
                el("tcW", tcpr, w=str(cw), type="dxa")
                el("vAlign", tcpr, val="center")
                pc = el("p", tc)
                if align:
                    el("jc", el("pPr", pc), val=align)
                if child is not None:
                    pc.append(child)
            body.replace(p, tbl)
            if trailing:
                np_ = el("p")
                body.insert(list(body).index(tbl) + 1, np_)
                for r in trailing:
                    np_.append(r)
        # 后续文本 runs 移入新段落（保持文流）；书签标记留在原位
        if mode == "tab" and trailing:
            np_ = el("p")
            st = p.find(W + "pPr")
            if st is not None:
                np_.append(copy.deepcopy(st))
            body.insert(list(body).index(p) + 1, np_)
            for r in trailing:
                np_.append(r)
        if next_p is not None:
            body.remove(next_p)
        count += 1

    items["word/document.xml"] = ET.tostring(root, xml_declaration=True,
                                             encoding="UTF-8", standalone=True)
    with zipfile.ZipFile(docx_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for name, data in items.items():
            zout.writestr(name, data)
    os.remove(tmp)
    return count


def apply_meta_layout(docx_path: str, affil: str = "", lang: str = "zh") -> None:
    """题区补排（pandoc docx writer 的两处已知丢信息行为，v0.1.4 验收发现）：

    1. 单位丢失：pandoc 丢弃 \\affil（authblk）→ 生成器把单位作为正文段落输出后，
       此处按文本精确匹配将其居中并缩小字号（题区惯例排版）；
    2. 摘要标签：pandoc 硬编码英文 "Abstract" 标签 → 中文论文改写为「摘要」。
    """
    import lxml.etree as ET

    tmp = docx_path + ".metatmp"
    shutil.copyfile(docx_path, tmp)
    with zipfile.ZipFile(tmp) as zin:
        items = {i.filename: zin.read(i.filename) for i in zin.infolist()}
    root = ET.fromstring(items["word/document.xml"])
    body = root.find(W + "body")
    affil = (affil or "").strip()

    for p in body.iter(W + "p"):
        runs = [r for r in p.findall(W + "r") if r.find(W + "t") is not None]
        if not runs:
            continue
        text = "".join((r.find(W + "t").text or "") for r in runs).strip()
        if not text:
            continue
        if lang == "zh" and text == "Abstract":
            # 仅在 Pandoc 自动生成的 AbstractTitle 且下一段含中文时改写为「摘要」；
            # 双语学位论文里紧跟英文正文的 "Abstract" 标题必须保留为英文！
            st = p.find(f"{W}pPr/{W}pStyle")
            st_val = st.get(W + "val", "") if st is not None else ""
            nxt = p.getnext()
            nxt_txt = "".join((t.text or "") for t in nxt.iter(W + "t")).strip() if nxt is not None else ""
            nxt_has_zh = bool(re.search(r"[\u4e00-\u9fff]", nxt_txt))
            if st_val == "AbstractTitle" or (nxt_has_zh and st_val != "Heading1"):
                runs[0].find(W + "t").text = "摘要"
                for extra in runs[1:]:
                    t = extra.find(W + "t")
                    if t is not None:
                        t.text = ""
        elif affil and text == affil:
            ppr = p.find(W + "pPr")
            if ppr is None:
                ppr = ET.Element(W + "pPr")
                p.insert(0, ppr)
            if ppr.find(W + "jc") is None:
                ppr.append(ET.Element(W + "jc", {W + "val": "center"}))
            for r in runs:
                rpr = r.find(W + "rPr")
                if rpr is None:
                    rpr = ET.Element(W + "rPr")
                    r.insert(0, rpr)
                if rpr.find(W + "sz") is None:
                    # 五号（10.5pt = sz 21）：单位行小于正文，题区惯例
                    rpr.append(ET.Element(W + "sz", {W + "val": "21"}))
                    rpr.append(ET.Element(W + "szCs", {W + "val": "21"}))

    items["word/document.xml"] = ET.tostring(root, xml_declaration=True,
                                             encoding="UTF-8", standalone=True)
    with zipfile.ZipFile(docx_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for name, data in items.items():
            zout.writestr(name, data)
    os.remove(tmp)


_SZ_MARKER_RE = re.compile(r"__PS_SZ_(\d+)__")
_VS_MARKER_RE = re.compile(r"__PS_VSPACE_(\d+)__")
_FONT_MARKER_RE = re.compile(r"__PS_FONT_(SimHei|SimSun|KaiTi|FangSong)__")
_META_STYLES = {"Title", "Subtitle", "Author", "Date", "AbstractTitle", "Abstract"}


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


def _pass_split_soft_breaks(body) -> None:
    """Pass 0: 拆分含普通行内软回车 (<w:br/>) 的段落，根治两端对齐+软回车散字拉伸。"""
    import lxml.etree as ET

    for p in list(body):
        if p.tag != W + "p":
            continue
        has_line_br = any(br.get(W + "type") in (None, "", "textWrapping") for br in p.iter(W + "br"))
        if not has_line_br or p.find(f".//{M}oMath") is not None:
            continue
        orig_ppr = p.find(W + "pPr")
        segments: list[list] = [[]]
        for child in list(p):
            if child.tag == W + "pPr":
                continue
            if child.tag == W + "r":
                rpr = child.find(W + "rPr")
                cur_r = None
                for rc in list(child):
                    if rc.tag == W + "rPr":
                        continue
                    if rc.tag == W + "br" and rc.get(W + "type") in (None, "", "textWrapping"):
                        segments.append([])
                        cur_r = None
                    else:
                        if cur_r is None:
                            cur_r = ET.Element(W + "r")
                            if rpr is not None:
                                cur_r.append(copy.deepcopy(rpr))
                            segments[-1].append(cur_r)
                        cur_r.append(copy.deepcopy(rc))
            else:
                segments[-1].append(copy.deepcopy(child))
        if len(segments) > 1:
            idx_p = list(body).index(p)
            body.remove(p)
            for seg in segments:
                if not seg:
                    continue
                np_ = ET.Element(W + "p")
                if orig_ppr is not None:
                    np_.append(copy.deepcopy(orig_ppr))
                for node in seg:
                    np_.append(node)
                body.insert(idx_p, np_)
                idx_p += 1


def _pass_layout_markers(body, text_w: int) -> None:
    """Pass 1: 转换 __PS_PAGEBREAK__ / __PS_CENTER_* / __PS_SZ_* / __PS_VSPACE_* / __PS_HFILL__ / __PS_TITLEPAGE_*。"""
    import lxml.etree as ET

    in_center = False
    in_titlepage = False
    pending_vspace = 0
    pending_tbl_sz: int | None = None
    pending_tbl_font: str | None = None
    to_delete_markers = []

    for ch in list(body):
        if ch.tag == W + "tbl":
            if in_titlepage:
                _set_table_borderless_centered(ch)
                for tp in ch.iter(W + "p"):
                    if pending_tbl_sz:
                        _apply_font_size(tp, pending_tbl_sz)
                    if pending_tbl_font:
                        _apply_ea_font(tp, pending_tbl_font)
            pending_vspace = 0
            pending_tbl_sz = None
            pending_tbl_font = None
            continue
        if ch.tag != W + "p":
            continue
        full = "".join((t.text or "") for t in ch.iter(W + "t")).strip()
        if full == "__PS_TITLEPAGE_START__":
            in_titlepage = True
            to_delete_markers.append(ch)
            continue
        if full == "__PS_TITLEPAGE_END__":
            in_titlepage = False
            to_delete_markers.append(ch)
            continue
        if full == "__PS_PAGEBREAK__":
            for sub in list(ch):
                if sub.tag != W + "pPr":
                    ch.remove(sub)
            r = ET.SubElement(ch, W + "r")
            ET.SubElement(r, W + "br", {W + "type": "page"})
            pending_vspace = 0
            continue
        if full == "__PS_CENTER_START__":
            in_center = True
            to_delete_markers.append(ch)
            continue
        if full == "__PS_CENTER_END__":
            in_center = False
            to_delete_markers.append(ch)
            continue
        m_vs_only = _VS_MARKER_RE.fullmatch(full)
        if m_vs_only:
            pending_vspace += int(m_vs_only.group(1))
            to_delete_markers.append(ch)
            continue

        if _strip_marker(ch, "__PS_TITLEPAGE_START__"):
            in_titlepage = True
        if _strip_marker(ch, "__PS_TITLEPAGE_END__"):
            in_titlepage = False
        if _strip_marker(ch, "__PS_PAGEBREAK__"):
            ppr = ch.find(W + "pPr")
            if ppr is None:
                ppr = ET.Element(W + "pPr")
                ch.insert(0, ppr)
            if ppr.find(W + "pageBreakBefore") is None:
                ET.SubElement(ppr, W + "pageBreakBefore")
        if _strip_marker(ch, "__PS_CENTER_START__"):
            in_center = True
        if in_center:
            _set_center_no_indent(ch)
        if _strip_marker(ch, "__PS_CENTER_END__"):
            in_center = False

        cur_full = "".join((t.text or "") for t in ch.iter(W + "t"))
        for vm in _VS_MARKER_RE.finditer(cur_full):
            pending_vspace += int(vm.group(1))
        if _VS_MARKER_RE.search(cur_full):
            for t in ch.iter(W + "t"):
                if t.text:
                    t.text = _VS_MARKER_RE.sub("", t.text)

        sz_matches = _SZ_MARKER_RE.findall(cur_full)
        if sz_matches:
            for t in ch.iter(W + "t"):
                if t.text:
                    t.text = _SZ_MARKER_RE.sub("", t.text)

        font_matches = _FONT_MARKER_RE.findall(cur_full)
        if font_matches:
            for t in ch.iter(W + "t"):
                if t.text:
                    t.text = _FONT_MARKER_RE.sub("", t.text)

        rem_txt = "".join((t.text or "") for t in ch.iter(W + "t")).strip()
        if sz_matches:
            sz_val = int(sz_matches[0])
            _apply_font_size(ch, sz_val)
            if in_titlepage and not rem_txt:
                pending_tbl_sz = sz_val
        if font_matches:
            fam = font_matches[0]
            _apply_ea_font(ch, fam)
            if in_titlepage and not rem_txt:
                pending_tbl_font = fam
        if in_titlepage and not rem_txt and (sz_matches or font_matches):
            to_delete_markers.append(ch)
            continue

        _replace_uline_with_run(ch)
        _replace_hfill_with_tab(ch, text_w)

        if pending_vspace > 0 and "".join((t.text or "") for t in ch.iter(W + "t")).strip():
            _apply_space_before(ch, min(pending_vspace, 2400))
            pending_vspace = 0

    for ch in to_delete_markers:
        body.remove(ch)


def _pass_thesis_chapters(body, lang: str) -> None:
    """Pass 3: 学位论文模式章标题 Heading1 居中、段前分页、并将数字章号转为 '第 N 章'。"""
    import lxml.etree as ET

    for ch in list(body):
        if ch.tag != W + "p":
            continue
        st = ch.find(f"{W}pPr/{W}pStyle")
        if st is None or st.get(W + "val") != "Heading1":
            continue
        _set_center_no_indent(ch)
        ppr = ch.find(W + "pPr")
        if ppr is not None and ppr.find(W + "pageBreakBefore") is None:
            ET.SubElement(ppr, W + "pageBreakBefore")
        if lang == "zh":
            for r in ch.findall(W + "r"):
                rst = r.find(f"{W}rPr/{W}rStyle")
                t = r.find(W + "t")
                if (
                    rst is not None
                    and rst.get(W + "val") == "SectionNumber"
                    and t is not None
                    and t.text
                    and re.fullmatch(r"\d+", t.text.strip())
                ):
                    t.text = f"第 {t.text.strip()} 章 "
                    break


def _pass_relocate_references(body) -> None:
    """Pass 3.5: 将 Pandoc citeproc 生成在文末的「参考文献」块原位移动到 __PS_REFS_HERE__ 处。"""
    refs_anchor = None
    for ch in list(body):
        if ch.tag == W + "p" and "__PS_REFS_HERE__" in "".join((t.text or "") for t in ch.iter(W + "t")):
            refs_anchor = ch
            break
    if refs_anchor is None:
        return
    ref_heading = None
    bib_nodes = []
    children_now = list(body)
    for idx in range(len(children_now) - 1, -1, -1):
        ch = children_now[idx]
        if ch.tag != W + "p":
            continue
        txt = "".join((t.text or "") for t in ch.iter(W + "t")).strip()
        st = ch.find(f"{W}pPr/{W}pStyle")
        st_val = st.get(W + "val", "") if st is not None else ""
        if txt in ("参考文献", "References") and st_val in ("Heading1", "BibliographyHeading", "TOCHeading", ""):
            j = idx + 1
            collected = []
            while j < len(children_now):
                nxt = children_now[j]
                if nxt.tag == W + "sectPr":
                    break
                if nxt.tag == W + "p":
                    nst = nxt.find(f"{W}pPr/{W}pStyle")
                    if nst is not None and nst.get(W + "val") == "Heading1":
                        break
                collected.append(nxt)
                j += 1
            if collected:
                ref_heading = ch
                bib_nodes = collected
                break
    if ref_heading is not None and bib_nodes and list(body).index(ref_heading) > list(body).index(refs_anchor):
        move_list = [ref_heading, *bib_nodes]
        for node in move_list:
            body.remove(node)
        ins_idx = list(body).index(refs_anchor)
        for node in move_list:
            body.insert(ins_idx, node)
            ins_idx += 1
    body.remove(refs_anchor)


def _pass_trim_empty_frontmatter(body) -> None:
    """Pass 4: 清理开头与题区多余空段落。"""
    children = list(body)
    to_remove = []
    for idx, ch in enumerate(children):
        if not _is_empty_plain_para(ch):
            continue
        prev_st = _style_of(children[idx - 1]) if idx > 0 else ""
        next_st = _style_of(children[idx + 1]) if idx + 1 < len(children) else ""
        if idx == 0 or prev_st in _META_STYLES or next_st in _META_STYLES:
            to_remove.append(ch)
    for ch in to_remove:
        body.remove(ch)


def _pass_dedup_pagebreaks(body) -> None:
    """Pass 5: 消除连续硬分页符与分页符紧邻 pageBreakBefore 导致的空白页。"""
    dedup_remove = []
    nodes = [c for c in list(body) if c.tag != W + "sectPr"]
    for idx, ch in enumerate(nodes):
        if not _is_pure_pagebreak(ch):
            continue
        prev_el = nodes[idx - 1] if idx > 0 else None
        next_el = nodes[idx + 1] if idx + 1 < len(nodes) else None
        if prev_el is None or next_el is None or _is_pure_pagebreak(prev_el) or _has_pb_before(next_el):
            dedup_remove.append(ch)
    for ch in dedup_remove:
        body.remove(ch)


def polish_docx_native(docx_path: str, lang: str = "zh", is_thesis: bool = False) -> None:
    """原生 Word 观感润色（按 Pass 0→5 依次执行，良构保底）。"""
    import lxml.etree as ET

    tmp = docx_path + ".polishtmp"
    shutil.copyfile(docx_path, tmp)
    with zipfile.ZipFile(tmp) as zin:
        items = {i.filename: zin.read(i.filename) for i in zin.infolist()}
    root = ET.fromstring(items["word/document.xml"])
    body = root.find(W + "body")
    if body is None:
        os.remove(tmp)
        return

    _pass_split_soft_breaks(body)
    _pass_layout_markers(body, _text_width_twips(body))
    if is_thesis:
        _pass_thesis_chapters(body, lang)
    _pass_relocate_references(body)
    _pass_trim_empty_frontmatter(body)
    _pass_dedup_pagebreaks(body)

    items["word/document.xml"] = ET.tostring(
        root, xml_declaration=True, encoding="UTF-8", standalone=True,
    )
    with zipfile.ZipFile(docx_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for name, data in items.items():
            zout.writestr(name, data)
    os.remove(tmp)


_EQ_BLOCK_RE = re.compile(r"(\\begin\{equation\})(.*?)(\\end\{equation\})", re.S)
_ALIGN_BLOCK_RE = re.compile(r"\\begin\{(align|gather)\}(.*?)\\end\{\1\}", re.S)
_NESTED_ENV_RE = re.compile(r"\\(begin|end)\{[^}]+\}")
_CJK_CHAR_RE = re.compile(r"[\u4e00-\u9fff]")
_CTEX_HINT_RE = re.compile(
    r"\\(?:usepackage(?:\[[^\]]*\])?\{[^}]*(?:ctex|xeCJK)[^}]*\}|documentclass(?:\[[^\]]*\])?\{ctex)"
)


def _split_top_level_latex_rows(inner: str) -> list[str]:
    """按顶层 `\\\\` 拆分 align/gather 内容（跳过 cases/matrix 等嵌套环境内部的 `\\\\`）。"""
    rows: list[str] = []
    buf: list[str] = []
    depth = 0
    i = 0
    n = len(inner)
    while i < n:
        m = _NESTED_ENV_RE.match(inner, i)
        if m:
            depth += 1 if m.group(1) == "begin" else -1
            depth = max(0, depth)
            buf.append(m.group(0))
            i = m.end()
            continue
        if depth == 0 and inner.startswith("\\\\", i):
            rows.append("".join(buf))
            buf = []
            i += 2
            # 跳过可选行距参数如 \\[6pt] 或 \\*
            if i < n and inner[i] == "*":
                i += 1
            if i < n and inner[i] == "[":
                end_br = inner.find("]", i)
                if end_br != -1:
                    i = end_br + 1
            continue
        buf.append(inner[i])
        i += 1
    if buf:
        rows.append("".join(buf))
    return rows


def _strip_alignment_amp(line: str) -> str:
    """去除 align 对齐符 `&`（保留转义 `\\&` 及嵌套环境内部的 `&`）。"""
    out: list[str] = []
    depth = 0
    i = 0
    n = len(line)
    while i < n:
        m = _NESTED_ENV_RE.match(line, i)
        if m:
            depth += 1 if m.group(1) == "begin" else -1
            depth = max(0, depth)
            out.append(m.group(0))
            i = m.end()
            continue
        if depth == 0 and line[i] == "&" and (i == 0 or line[i - 1] != "\\"):
            i += 1
            continue
        out.append(line[i])
        i += 1
    return "".join(out)


_MAKEBOX_RE = re.compile(r"\\makebox(?:\[[^\]]*\]){0,2}\{([^{}]*)\}")
_EMPTY_NEWCMD_RE = re.compile(r"\\(?:new|renew)command\{\\([A-Za-z@]+)\}\{\s*\}")
_UNDERLINE_EMPTY_RE = re.compile(r"\\underline\{\s*\}")
_CMIDRULE_RE = re.compile(r"\\cmidrule(?:\([^)]*\))?(?:\[[^\]]*\])?\{[^}]*\}")
_PAGEBREAK_CMD_RE = re.compile(r"(?m)^[ \t]*\\(?:clearpage|cleardoublepage|newpage)[ \t]*$")
_CENTER_START_RE = re.compile(r"\\begin\{center\}")
_CENTER_END_RE = re.compile(r"\\end\{center\}")
_TITLEPAGE_START_RE = re.compile(r"\\begin\{titlepage\}")
_TITLEPAGE_END_RE = re.compile(r"\\end\{titlepage\}")
_ZIHao_RE = re.compile(r"\\zihao\{(-?\d+)\}")
_CJK_FONT_CMD_RE = re.compile(r"\\(heiti|songti|kaishu|fangsong)\b")
_VSPACE_RE = re.compile(r"\\vspace\*?\{([0-9.]+)\s*(cm|mm|pt|em)\}")
_LINEBREAK_SPACE_RE = re.compile(r"\\\\\[([0-9.]+)\s*(cm|mm|pt|em)\]")
_VFILL_RE = re.compile(r"\\vfill\b")
_HFILL_RE = re.compile(r"\\hfill\b")
_BIB_CMD_RE = re.compile(r"(?m)^[ \t]*\\bibliography\{[^}]+\}[ \t]*$")

_CJK_FONT_MAP = {
    "heiti": "SimHei",
    "songti": "SimSun",
    "kaishu": "KaiTi",
    "fangsong": "FangSong",
}

_ZIHAO_TO_HALF_PT = {
    "0": 84, "-0": 72, "1": 52, "-1": 48, "2": 44, "-2": 36,
    "3": 32, "-3": 30, "4": 28, "-4": 24, "5": 21, "-5": 18,
}


def preprocess_tex_for_pandoc(
    src_dir: str,
    split_multiline: bool = False,
    preserve_layout_markers: bool = False,
) -> int:
    """在临时快照中预处理公式与版式命令以获得原生 Word 体验：

    1. split_multiline=True 时，将 \\begin{align}/\\begin{gather} 按顶层 `\\\\` 拆为逐行
       独立的 \\begin{equation}（含 \\nonumber/\\notag 的行转为 equation*），使多行推导
       的每一行在 Word 中都能独立居中并右对齐编号、保留各自 \\label 与 \\eqref 交叉引用；
    2. preserve_layout_markers=True 时：
       - 展开 Pandoc 会静默丢弃的 \\makebox[...][...]{内容}；
       - 将 \\begin{center}...\\end{center} 与 \\clearpage/\\newpage/\\end{titlepage}
         转为可穿越 Pandoc AST 的占位标记，由 polish_docx_native 还原为真正的居中段落与硬分页符；
    3. 为所有无 \\label 且不含 \\nonumber/\\notag 的 \\begin{equation} 注入合成标签
       \\label{__auto_eq_N__}，确保与原生 LaTeX 一致自动编号 (1), (2), ...。
    """
    counter = 0
    for root_dir, _dirs, files in os.walk(src_dir):
        for fn in sorted(files):
            if not fn.lower().endswith((".tex", ".ltx")):
                continue
            path = os.path.join(root_dir, fn)
            try:
                text = open(path, encoding="utf-8", errors="replace").read()
            except OSError:
                continue

            new_text = text
            if preserve_layout_markers:
                # 1) 清除 Pandoc 无法解析而吐出乱码的 \cmidrule(lr){2-3}
                new_text = _CMIDRULE_RE.sub("", new_text)
                # 2) 展开 \makebox[...][...]{内容}（防止学校代码/学号被 Pandoc 静默吃掉），
                #    并将空的 \underline{} 或引用空宏的 \underline{\EmptyMacro} 转为定长下划线占位符
                empty_macros = set(_EMPTY_NEWCMD_RE.findall(new_text))
                for _ in range(3):
                    updated = _MAKEBOX_RE.sub(r"\1", new_text)
                    if updated == new_text:
                        break
                    new_text = updated
                new_text = _UNDERLINE_EMPTY_RE.sub("__PS_ULINE__", new_text)
                if empty_macros:
                    pat = re.compile(
                        r"\\underline\{\s*\\(?:" + "|".join(re.escape(m) for m in sorted(empty_macros)) + r")\s*\}"
                    )
                    new_text = pat.sub("__PS_ULINE__", new_text)
                # 3) 正文区（\begin{document} 之后）保留分页、居中、封面字号/字体/留白、\hfill 与参考文献位置
                doc_pos = new_text.find("\\begin{document}")
                head_part = new_text[:doc_pos] if doc_pos != -1 else ""
                body_part = new_text[doc_pos:] if doc_pos != -1 else new_text

                def _zihao_repl(m: re.Match[str]) -> str:
                    sz = _ZIHAO_TO_HALF_PT.get(m.group(1))
                    return f"__PS_SZ_{sz}__" if sz else ""

                def _cjk_font_repl(m: re.Match[str]) -> str:
                    fam = _CJK_FONT_MAP.get(m.group(1))
                    return f"__PS_FONT_{fam}__" if fam else ""

                def _vspace_repl(m: re.Match[str]) -> str:
                    val, unit = float(m.group(1)), m.group(2)
                    mult = {"cm": 567, "mm": 57, "pt": 20, "em": 240}.get(unit, 200)
                    tw = max(120, min(2400, int(val * mult)))
                    return f"\n\n__PS_VSPACE_{tw}__\n\n"

                def _lb_space_repl(m: re.Match[str]) -> str:
                    val, unit = float(m.group(1)), m.group(2)
                    mult = {"cm": 567, "mm": 57, "pt": 20, "em": 240}.get(unit, 200)
                    tw = max(120, min(1800, int(val * mult)))
                    return f"\\\\\n__PS_VSPACE_{tw}__"

                # 仅对 titlepage 内的 \\[Xcm] 保留行间距（避免影响表格 tabular 内的 \\[8pt]）
                def _patch_titlepage_lb(m: re.Match[str]) -> str:
                    inner = m.group(0)
                    # 不触碰 \begin{tabular}...\end{tabular} 内部
                    parts = re.split(r"(\\begin\{tabular\}.*?\\end\{tabular\})", inner, flags=re.S)
                    for idx_p in range(0, len(parts), 2):
                        parts[idx_p] = _LINEBREAK_SPACE_RE.sub(_lb_space_repl, parts[idx_p])
                    return "".join(parts)

                body_part = re.sub(
                    r"\\begin\{titlepage\}.*?\\end\{titlepage\}", _patch_titlepage_lb, body_part, flags=re.S
                )
                body_part = _TITLEPAGE_START_RE.sub(
                    lambda _: "\\begin{titlepage}\n\n__PS_TITLEPAGE_START__\n\n", body_part
                )
                body_part = _TITLEPAGE_END_RE.sub(
                    lambda _: "\n\n__PS_TITLEPAGE_END__\n\n\\end{titlepage}\n\n__PS_PAGEBREAK__\n\n", body_part
                )
                body_part = _ZIHao_RE.sub(_zihao_repl, body_part)
                body_part = _CJK_FONT_CMD_RE.sub(_cjk_font_repl, body_part)
                body_part = _VSPACE_RE.sub(_vspace_repl, body_part)
                body_part = _VFILL_RE.sub("\n\n__PS_VSPACE_1400__\n\n", body_part)
                body_part = _HFILL_RE.sub("__PS_HFILL__", body_part)
                body_part = _CENTER_START_RE.sub("\n\n__PS_CENTER_START__\n\n", body_part)
                body_part = _CENTER_END_RE.sub("\n\n__PS_CENTER_END__\n\n", body_part)
                body_part = _PAGEBREAK_CMD_RE.sub("\n\n__PS_PAGEBREAK__\n\n", body_part)
                body_part = _BIB_CMD_RE.sub(lambda m: f"\n\n__PS_REFS_HERE__\n\n{m.group(0)}", body_part)
                new_text = head_part + body_part

            if split_multiline:
                def _split_align(m: re.Match[str]) -> str:
                    rows = _split_top_level_latex_rows(m.group(2))
                    blocks: list[str] = []
                    for raw in rows:
                        cleaned = _strip_alignment_amp(raw).strip()
                        if not cleaned:
                            continue
                        if "\\nonumber" in cleaned or "\\notag" in cleaned:
                            cleaned = cleaned.replace("\\nonumber", "").replace("\\notag", "").strip()
                            blocks.append(f"\\begin{{equation*}}\n{cleaned}\n\\end{{equation*}}")
                        else:
                            blocks.append(f"\\begin{{equation}}\n{cleaned}\n\\end{{equation}}")
                    return "\n\n".join(blocks) if blocks else m.group(0)

                new_text = _ALIGN_BLOCK_RE.sub(_split_align, new_text)

            def _repl(m: re.Match[str]) -> str:
                nonlocal counter
                head, inner, tail = m.group(1), m.group(2), m.group(3)
                if "\\label{" in inner or "\\nonumber" in inner or "\\notag" in inner:
                    return m.group(0)
                counter += 1
                return f"{head}{inner}\\label{{__auto_eq_{counter}__}}{tail}"

            new_text = _EQ_BLOCK_RE.sub(_repl, new_text)
            if new_text != text:
                with open(path, "w", encoding="utf-8", newline="\n") as f:
                    f.write(new_text)
    return counter


def detect_cjk_project(src_dir: str, main_rel: str) -> bool:
    """检测工程是否为中文论文（ctex/xeCJK 宏包或正文包含中文字符）。"""
    main_path = os.path.join(src_dir, main_rel)
    samples: list[str] = []
    if os.path.isfile(main_path):
        try:
            samples.append(open(main_path, encoding="utf-8", errors="replace").read(65536))
        except OSError:
            pass
    for s in samples:
        if _CTEX_HINT_RE.search(s):
            return True
        if len(_CJK_CHAR_RE.findall(s)) >= 5:
            return True
    for root_dir, _dirs, files in os.walk(src_dir):
        for fn in files:
            if not fn.lower().endswith((".tex", ".ltx")):
                continue
            p = os.path.join(root_dir, fn)
            try:
                txt = open(p, encoding="utf-8", errors="replace").read(16384)
            except OSError:
                continue
            if _CTEX_HINT_RE.search(txt) or len(_CJK_CHAR_RE.findall(txt)) >= 5:
                return True
    return False
