# -*- coding: utf-8 -*-
"""原生 Word 观感润色多阶段 Pass（拆分软回车、版式占位还原、学位章标题、参考文献重排与分页去重）。"""

from __future__ import annotations

import copy
import os
import re
import shutil
import zipfile

from .ooxml import (
    M,
    W,
    _apply_ea_font,
    _apply_font_size,
    _apply_space_before,
    _has_pb_before,
    _is_empty_plain_para,
    _is_pure_pagebreak,
    _replace_hfill_with_tab,
    _replace_uline_with_run,
    _set_center_no_indent,
    _set_table_borderless_centered,
    _strip_marker,
    _style_of,
    _text_width_twips,
)

_SZ_MARKER_RE = re.compile(r"__PS_SZ_(\d+)__")
_VS_MARKER_RE = re.compile(r"__PS_VSPACE_(\d+)__")
_FONT_MARKER_RE = re.compile(r"__PS_FONT_(SimHei|SimSun|KaiTi|FangSong)__")
_META_STYLES = {"Title", "Subtitle", "Author", "Date", "AbstractTitle", "Abstract"}


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
