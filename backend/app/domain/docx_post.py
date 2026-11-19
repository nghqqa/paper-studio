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


def _num_run_index(p):
    children = list(p)
    for i in range(len(children) - 1, -1, -1):
        el = children[i]
        if el.tag != W + "r":
            continue
        t = el.find(W + "t")
        if t is not None and t.text and re.fullmatch(r"\(\d{1,3}\)", t.text.strip()):
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
    return bool(joined) and re.fullmatch(r"\(\d{1,3}\)", joined) is not None


def _text_width_twips(body) -> int:
    """版心宽 = pgSz.w - pgMar.left - pgMar.right（twips）。

    制表位/公式表格必须按**本文档**的节几何计算——jcip 系 reference 有单栏/双栏两种版心，
    写死列宽会让编号落在行中（v0.1.4 验收实测发现）。"""
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
    return max(3000, w - left - right)


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
            trailing = [el for el in list(p)[num_idx + 1:]
                        if el.tag != W + "bookmarkEnd"]

        # 1) oMathPara → 内联 oMath
        idx_om = list(p).index(omp)
        p.remove(omp)
        p.insert(idx_om, omath)
        # 2) 段落制表位：居中位 + 列右缘
        ppr = p.find(W + "pPr")
        if ppr is None:
            ppr = el("pPr")
            p.insert(0, ppr)
        tabs = ppr.find(W + "tabs")
        if tabs is None:
            tabs = el("tabs")
            ppr.insert(0, tabs)
        el("tab", tabs, val="center", pos=str(text_w // 2))
        el("tab", tabs, val="right", pos=str(text_w - 140))

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
        if trailing:
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


def apply_meta_layout(docx_path: str, affil: str = "") -> None:
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
        if text == "Abstract":
            runs[0].find(W + "t").text = "摘要"
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
