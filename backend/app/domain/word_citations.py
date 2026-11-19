# -*- coding: utf-8 -*-
"""Word (.docx) 正文引用编号确定性重排（P1-0-B）。

从服务端权威 DOCX 直接执行 OOXML 重排：静态引用文本 [n] / [1,2] / [1-3] 按正文首次出现
顺序重编号（顺序编码制），同步重建托管参考文献表并返回新的引用顺序表（citation_order）。

设计约束（全部 fail-closed，任何不满足即 ProjectError 409/422，绝不半途改写正文）：
- 纯标准库（zipfile + xml.etree）：ZIP 内除 word/document.xml 外的部件字节原样保留；
- 扫描范围 = 文档序深度遍历的全部正文段落（含表格单元格）；遇托管头标记或独立
  「参考文献」/「References」标题段停止；有效托管块的条目区本身不参与扫描（块后附录正文仍算）；
- 跨 Run 括号识别：拼接全部可见 <w:t>（跳过 <w:del>；删除修订区域以占位符断开 token，
  防止 "[1" + 已删除片段 + "2]" 被误判为编号 12）；括号内文交给
  gbt7714.parse_citation_numbers——年份 [2020-2024]、带文字标签 [1, 甲] 一类不误改；
- 无损格式改写：只改写括号覆盖的首个 <w:t> 并清空其余碎片（保留首 <w:r> 的 rPr/上标等
  样式与无关 run）；括号跨越 <w:ins>/<w:del> 修订边界时拒绝重写（提示先接受/拒绝修订）；
- 越界编号（> 文献库顺序表长度）拒绝映射——保留旧号会与新号冲突污染引用，必须先清理；
- 托管参考文献表重建沿用原首条目段落的 pPr 与首 run 的 rPr，条目文本按指定样式
  （gb-t-7714-2015 平台确定性渲染器 / ieee citeproc + vendored csl）重新生成。
"""

from __future__ import annotations

import copy
import io
import os
import re
import threading
import zipfile
from typing import Any
from xml.etree import ElementTree

from app.domain import gbt7714
from app.errors import ProjectError

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
XML_NS = "http://www.w3.org/XML/1998/namespace"
_NS_LOCK = threading.Lock()
# 引用样式唯一白名单（B3）：gb 走确定性国标渲染器，其余按 app/csl/<style>.csl 走 citeproc。
# 新增样式必须 citation-format="numeric" 且 bibliography 前缀可被 _CSL_LABEL_RE 干净剥离
# （守卫见 tests/test_csl_styles.py）。
STYLES = ("gb-t-7714-2015", "ieee", "springer-lncs", "acm", "elsevier-vancouver")

HEAD_MARKER = "[参考文献-平台生成]"
TAIL_MARKER = "[参考文献-平台生成]（完）"

# 与 refs.js builderCollectRefs v3 同款：纯编号/范围/混合括号
_CITE_BRACKET_RE = re.compile(r"\[([0-9]{1,4}(?:\s*[,，\-–—−]\s*[0-9]{1,4})*)\]")
_ENTRY_LABEL_RE = re.compile(r"^\[\d+\]")
_CSL_LABEL_RE = re.compile(r"^\s*(?:\[\d+\]|\d+\s*[.):])\s*")
# 删除修订占位符：不落入引用括号的字符类，天然断开跨删除区域的编号匹配
_DEL_SENTINEL = "\x00"
_BOOKMARK_TAGS = frozenset("{%s}%s" % (W_NS, t) for t in ("bookmarkStart", "bookmarkEnd"))


def _q(tag: str) -> str:
    return f"{{{W_NS}}}{tag}"


# ---------------------------------------------------------------- 文本建模 ----


def _scan_paragraph(p_elem: ElementTree.Element) -> dict:
    """段落 → {text, pieces}。pieces 按文档序：每个可见 <w:t> 记录（elem, text, container），
    container = 所在 <w:ins> 元素（None=非修订文本）；<w:del> 子树整块跳过并留占位符；
    tab/br 折叠为空格（含分隔符的括号不再是合法编号引用，自然放弃改写）。"""
    pieces: list[dict] = []

    def walk(elem: ElementTree.Element, container: ElementTree.Element | None) -> None:
        for child in elem:
            tag = child.tag
            if tag == _q("del"):
                pieces.append({"elem": None, "text": _DEL_SENTINEL, "container": None})
                continue
            if tag == _q("ins"):
                walk(child, child)
                continue
            if tag == _q("r"):
                for node in child:
                    if node.tag == _q("t"):
                        pieces.append({"elem": node, "text": node.text or "", "container": container})
                    elif node.tag in (_q("tab"), _q("br"), _q("cr")):
                        pieces.append({"elem": None, "text": " ", "container": container})
                continue
            if tag == _q("pPr"):
                continue
            if len(child):
                walk(child, container)

    walk(p_elem, None)
    pos = 0
    for p in pieces:
        p["start"], p["end"] = pos, pos + len(p["text"])
        pos = p["end"]
    return {"text": "".join(p["text"] for p in pieces), "pieces": pieces}


def _collapsed(text: str) -> str:
    return re.sub(r"\s+", "", text).strip()


def _para_text(p_elem: ElementTree.Element) -> str:
    return "".join(t.text or "" for t in p_elem.iter(_q("t")))


# ---------------------------------------------------------------- 主入口 ----


def renumber_docx(
    data: bytes,
    *,
    citation_order: list[str],
    entries: dict[str, Any],
    style: str = "gb-t-7714-2015",
) -> dict:
    """重排 DOCX 正文引用编号。返回 {data, changed_doc, mapping, order, warnings, rebuilt_block}。

    - data：无字节变化时返回原 bytes（调用方据此跳过版本落盘与会话轮换）；
    - mapping：{旧编号字符串: 新编号字符串}（按旧编号数值序）；
    - order：新引用顺序表（已引用条目按首次出现序在前，未引用条目按原相对序追加在后）。"""
    if style not in STYLES:
        raise ProjectError(f"暂不支持引用样式：{style}（当前支持：{'、'.join(STYLES)}）", 422)
    with zipfile.ZipFile(io.BytesIO(data)) as zin:
        if "word/document.xml" not in zin.namelist():
            raise ProjectError("DOCX 缺少 word/document.xml，无法重排引用", 422)
        infos = zin.infolist()
        contents = {i.filename: zin.read(i.filename) for i in infos}
    raw_xml = contents["word/document.xml"]

    root = ElementTree.fromstring(raw_xml)
    result = _renumber_tree(root, citation_order=citation_order, entries=entries, style=style)
    if not result["changed_doc"]:
        return {**result, "data": data}

    ns_pairs = [(p, u) for _, (p, u) in ElementTree.iterparse(io.BytesIO(raw_xml), events=("start-ns",))]
    with _NS_LOCK:
        saved_ns = dict(ElementTree._namespace_map)  # noqa: SLF001 — ET 无公开快照接口；锁内序列化并还原
        try:
            for prefix, uri in ns_pairs:
                try:
                    ElementTree.register_namespace(prefix, uri)
                except ValueError:  # 非法前缀：回退默认命名策略，序列化仍合法
                    pass
            contents["word/document.xml"] = ElementTree.tostring(root, encoding="UTF-8", xml_declaration=True)
        finally:
            ElementTree._namespace_map.clear()
            ElementTree._namespace_map.update(saved_ns)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in infos:
            zi = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            zi.compress_type = info.compress_type
            zi.external_attr = info.external_attr
            zout.writestr(zi, contents[info.filename])
    new_data = buf.getvalue()
    if new_data == data:  # 序列化等价（如重复重排）：同样视为未变化，不做版本落盘
        return {**result, "data": data, "changed_doc": False,
                "warnings": [w for w in result["warnings"] if not w.startswith("托管参考文献表已按新顺序重建")]}
    return {**result, "data": new_data}


def _renumber_tree(root: ElementTree.Element, *, citation_order, entries, style) -> dict:
    body = root.find(_q("body"))
    if body is None:
        raise ProjectError("DOCX 缺少文档主体（w:body），无法重排引用", 422)
    paras = list(root.iter(_q("p")))  # 文档序深度遍历（含表格单元格/嵌套容器）
    parent_of = {c: p for p in root.iter() for c in p}

    # ---- ① 定位托管块标记（只读）：与 refs.js / word_preflight 同一异常形态判定 ----
    heads = [i for i, el in enumerate(paras) if _collapsed(_para_text(el)).startswith(HEAD_MARKER)]
    tails = [i for i, el in enumerate(paras) if _collapsed(_para_text(el)).startswith(TAIL_MARKER)]
    heads = [i for i in heads if i not in tails]  # 「（完）」以尾标记优先（尾串以头串为前缀）
    head_i = heads[0] if heads else None
    tail_i = tails[0] if tails else None
    if len(heads) > 1 or len(tails) > 1:
        raise ProjectError(
            f"检测到重复的参考文献托管块标记（头 {len(heads)} 个、尾 {len(tails)} 个）"
            "——为避免误改正文，请手动清理到仅剩一组完整的头/尾标记段后再重排", 409)
    if tail_i is not None and head_i is None:
        raise ProjectError("检测到孤立的托管块尾标记（无对应头标记）——请手动清理该标记段后再重排", 409)
    if head_i is not None and tail_i is None:
        raise ProjectError(
            "检测到旧格式托管参考文献块（只有开始标记、没有「（完）」尾标记）——无法确认块内段落归属，"
            "请先在文献面板「更新参考文献表」重建为新格式托管块，或手动删除旧块后再重排", 409)
    if head_i is not None and tail_i is not None and tail_i < head_i:
        raise ProjectError("参考文献托管块头尾标记顺序倒置——请手动核对两标记段位置后再重排", 409)
    block_ok = head_i is not None and tail_i is not None
    if block_ok and (parent_of.get(paras[head_i]) is not body or parent_of.get(paras[tail_i]) is not body):
        raise ProjectError("托管块标记不在文档正文顶层（位于表格等容器内）——无法安全重建，请手动调整后再重排", 409)

    # ---- ② 计算扫描范围：遇托管头标记或「参考文献」/「References」标题段停止；块后附录正文仍算 ----
    interior: set[int] = set(range(head_i + 1, tail_i)) if block_ok else set()
    stop = len(paras)
    for i in range(len(paras)):
        if i in interior:
            continue
        collapsed = _collapsed(_para_text(paras[i]))
        if block_ok and i == head_i:
            stop = i
            break
        if collapsed == "参考文献" or collapsed.lower() == "references":
            stop = i
            break
    scan_indexes = [i for i in range(len(paras))
                    if i not in interior and (i < stop or (block_ok and i > tail_i))]
    heading_stop = stop < len(paras) and not (block_ok and stop == head_i)

    # ---- ③ 解析全部引用括号（含跨 Run 覆盖信息）→ 首次出现序映射 ----
    order: list[str] = []  # 旧编号首次出现序
    seen: set[int] = set()
    stale: set[int] = set()
    pending: list[dict] = []  # {text, pieces, edits: [(m, covered_idx_list)]}
    for i in scan_indexes:
        model = _scan_paragraph(paras[i])
        hits = []
        for m in _CITE_BRACKET_RE.finditer(model["text"]):
            nums = gbt7714.parse_citation_numbers(m.group(1))
            if not nums:
                continue  # 年份 [2020-2024]、带文字标签 [1, 甲]：不是编号引用
            covered = [k for k, p in enumerate(model["pieces"])
                       if p["elem"] is not None and p["start"] < m.end() and p["end"] > m.start()]
            if not covered:
                continue
            containers = {id(model["pieces"][k]["container"]) if model["pieces"][k]["container"] is not None else -1
                          for k in covered}
            if len(containers) > 1:
                raise ProjectError(
                    "正文引用 [" + m.group(1) + "] 跨越修订（插入/删除）边界，无法无损重写——"
                    "请先在 Word 中接受或拒绝全部修订后再重排", 409)
            for n in nums:
                if n not in seen:
                    seen.add(n)
                    order.append(str(n))
            hits.append((m, covered))
        if hits:
            pending.append({"model": model, "hits": hits})

    k = len(citation_order)
    if pending and k == 0:
        raise ProjectError(
            "文献库引用顺序表为空——请先在文献面板向正文插入引用（或导入条目）后再重排", 422)
    unknown_rids = [rid for rid in citation_order if rid not in entries]
    if unknown_rids:
        raise ProjectError(
            "文献顺序表包含库中不存在的条目（" + ", ".join(unknown_rids[:5]) + "）"
            "——请先在文献面板修复文献库后再重排", 422)
    stale = {int(s) for s in order if int(s) > k}
    if stale:
        shown = ", ".join(f"[{n}]" for n in sorted(stale)[:8])
        raise ProjectError(
            f"正文引用编号 {shown} 超出文献库范围（当前顺序表共 {k} 条）——可能是模板示例文字或"
            "已删除引用的失效标记；为避免错误映射到错误文献已拒绝重排，请先在正文中清理这些编号", 422)

    mapping = {old: str(new + 1) for new, old in enumerate(order)}
    rid_of_old = {i + 1: rid for i, rid in enumerate(citation_order)}
    new_order = [rid_of_old[int(old)] for old in order]
    appended = [rid for rid in citation_order if rid not in set(new_order)]
    new_order_full = new_order + appended

    # ---- ④ 应用改写：括号覆盖的首个 <w:t> 承载新文本，其余碎片清空（rPr 原样保留）----
    changed_doc = False
    for item in pending:
        edits: dict[int, list[tuple[int, int, str]]] = {}
        for m, covered in item["hits"]:
            nums = [mapping[str(n)] for n in gbt7714.parse_citation_numbers(m.group(1))]
            label = "[" + gbt7714.compress_number_ranges([int(x) for x in nums]) + "]"
            first = True
            for idx in covered:
                p = item["model"]["pieces"][idx]
                local_s = max(p["start"], m.start()) - p["start"]
                local_e = min(p["end"], m.end()) - p["start"]
                edits.setdefault(idx, []).append((local_s, local_e, label if first else ""))
                first = False
        for idx, ed in edits.items():
            piece = item["model"]["pieces"][idx]
            old_text = piece["text"]
            buf: list[str] = []
            pos = 0
            for ls, le, repl in sorted(ed):
                buf.append(old_text[pos:ls])
                buf.append(repl)
                pos = le
            buf.append(old_text[pos:])
            new_piece_text = "".join(buf)
            if new_piece_text != old_text:
                piece["elem"].text = new_piece_text
                changed_doc = True

    # ---- ⑤ 重建托管参考文献表（若有完整托管块）----
    rebuilt = False
    warnings: list[str] = []
    if block_ok:
        new_texts = _render_entries(new_order_full, entries, style)
        interior_elems = _block_interior(body, paras[head_i], paras[tail_i])
        if new_texts or interior_elems:
            if not new_texts and interior_elems:
                raise ProjectError(
                    "托管参考文献表存在条目但文献库引用顺序表为空——无法重建，请先在文献面板恢复文献库", 422)
            current_texts = [_para_text(el) for el in interior_elems]
            if current_texts != new_texts:
                _rebuild_block(body, paras[head_i], paras[tail_i], interior_elems, new_texts)
                rebuilt = True
                changed_doc = True
                warnings.append(f"托管参考文献表已按新顺序重建（{len(new_texts)} 条，样式 {style}）")

    if heading_stop:
        warnings.append("已在「参考文献」标题段停止正文引用扫描（其后按文献表区处理，不参与编号）")
    return {"changed_doc": changed_doc, "mapping": mapping, "order": new_order_full,
            "warnings": warnings, "rebuilt_block": rebuilt}


# ---------------------------------------------------------------- 托管块重建 ----


def _block_interior(body: ElementTree.Element, head: ElementTree.Element,
                    tail: ElementTree.Element) -> list[ElementTree.Element]:
    """托管块内区（头尾之间）的段落元素；含非段落内容或分节符时 fail-closed。"""
    children = list(body)
    h, t = children.index(head), children.index(tail)
    out: list[ElementTree.Element] = []
    for el in children[h + 1:t]:
        if el.tag == _q("p"):
            if el.find(f"{_q('pPr')}/{_q('sectPr')}") is not None:
                raise ProjectError(
                    "托管参考文献表段落含分节符——重建会改变页面结构，请手动调整后再重排", 409)
            out.append(el)
        elif el.tag in _BOOKMARK_TAGS:
            continue  # 书签锚点原样保留
        else:
            raise ProjectError(
                "托管参考文献表内含非段落内容（表格/图形等）——无法安全重建，请手动处理后重排", 409)
    return out


def _rebuild_block(body: ElementTree.Element, head: ElementTree.Element, tail: ElementTree.Element,
                   interior: list[ElementTree.Element], texts: list[str]) -> None:
    """沿用原首条目段落的 pPr 与首 run 的 rPr，重建条目段并替换旧内区。"""
    template_p = next((el for el in interior if _ENTRY_LABEL_RE.match(_para_text(el).strip())), None)
    template_run = None
    if template_p is not None:
        proto = template_p.find(f".//{_q('r')}")
        template_run = copy.deepcopy(proto) if proto is not None else None
        template_p = copy.deepcopy(template_p)
    for el in interior:
        body.remove(el)
    pos = list(body).index(head) + 1
    for offset, text in enumerate(texts):
        body.insert(pos + offset, _entry_paragraph(template_p, template_run, text))


def _entry_paragraph(template_p: ElementTree.Element | None,
                     template_run: ElementTree.Element | None, text: str) -> ElementTree.Element:
    p = copy.deepcopy(template_p) if template_p is not None else ElementTree.Element(_q("p"))
    for child in list(p):
        if child.tag != _q("pPr"):
            p.remove(child)
    if template_run is not None:
        r = copy.deepcopy(template_run)
        p.append(r)
    else:
        r = ElementTree.SubElement(p, _q("r"))
    for child in list(r):
        if child.tag != _q("rPr"):
            r.remove(child)
    t = ElementTree.SubElement(r, _q("t"))
    t.text = text
    if text != text.strip():
        t.set(f"{{{XML_NS}}}space", "preserve")
    return p


# ---------------------------------------------------------------- 条目渲染 ----


def _render_entries(order: list[str], entries: dict[str, Any], style: str) -> list[str]:
    """按给定 rid 顺序渲染条目文本（统一 "[n] 文本" 形态，与正文静态标签严格一致）。"""
    out = []
    if style == "gb-t-7714-2015":
        for i, rid in enumerate(order, 1):
            out.append(gbt7714.format_gbt7714_entry(entries[rid], i))
        return out
    from citeproc import Citation, CitationItem, CitationStylesBibliography, CitationStylesStyle, formatter
    from citeproc.source.json import CiteProcJSON

    from app import config
    from app.domain.library import entry_to_csl_json

    style_file = os.path.join(config.BACKEND_DIR, "app", "csl", f"{style}.csl")
    if not os.path.isfile(style_file):
        raise ProjectError(f"引用样式文件缺失（{style}），无法按该样式重建参考文献表", 503)
    try:
        src = CiteProcJSON([entry_to_csl_json(entries[rid]) for rid in order])
        bib = CitationStylesBibliography(CitationStylesStyle(style_file), src, formatter.plain)
        for rid in order:
            bib.register(Citation([CitationItem(rid)]))
        items = [str(it) for it in bib.bibliography()]
    except ProjectError:
        raise
    except Exception as e:  # noqa: BLE001 — CSL 渲染失败如实报错，不做半成品重建
        raise ProjectError(f"参考文献渲染失败（{style}）：{e}", 502) from e
    for i in range(1, len(order) + 1):
        text = _CSL_LABEL_RE.sub("", items[i - 1] if i - 1 < len(items) else "").strip()
        out.append(f"[{i}] {text}")
    return out


# ---------------------------------------------------------------- 路由装配 ----


def build_transform(project_dir: str, style: str):
    """读文献库事实源（index 模式：index.json 即事实）→ 返回可在 word 锁内执行的闭包。

    返回 transform_fn(data) -> (new_data, payload)，供 word_documents.renumber_citations 使用。"""
    from app.domain import library as library_domain

    index = library_domain.load_index(project_dir)
    by_rid = {e.reference_id: e for e in index.entries}

    def transform(data: bytes) -> tuple[bytes, dict]:
        result = renumber_docx(data, citation_order=index.citation_order, entries=by_rid, style=style)
        payload = {k: result[k] for k in ("mapping", "order", "warnings", "rebuilt_block")}
        return result["data"], payload

    return transform
