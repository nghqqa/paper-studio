# -*- coding: utf-8 -*-
"""题区（单位与中文摘要标签）后处理。"""

from __future__ import annotations

import os
import re
import shutil
import zipfile

from .ooxml import W


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
                    rpr.append(ET.Element(W + "sz", {W + "val": "21"}))
                    rpr.append(ET.Element(W + "szCs", {W + "val": "21"}))

    items["word/document.xml"] = ET.tostring(root, xml_declaration=True,
                                             encoding="UTF-8", standalone=True)
    with zipfile.ZipFile(docx_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for name, data in items.items():
            zout.writestr(name, data)
    os.remove(tmp)
