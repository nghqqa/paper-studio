# -*- coding: utf-8 -*-
"""公式居中 + 编号右对齐后处理（制表位法 / 1x3 无边框对称表格法）。"""

from __future__ import annotations

import copy
import os
import re
import shutil
import zipfile

from .ooxml import M, W, _text_width_twips

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
            tbl = el("tbl")
            tblpr = el("tblPr", tbl)
            el("tblW", tblpr, w=str(text_w), type="dxa")
            borders = el("tblBorders", tblpr)
            for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
                el(side, borders, val="none", sz="0", space="0", color="auto")
            el("tblLayout", tblpr, type="fixed")
            grid = el("tblGrid", tbl)
            w_side = 1400
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
