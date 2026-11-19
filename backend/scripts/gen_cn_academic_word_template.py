#!/usr/bin/env python3
"""Generate an original, Apache-2.0 licensed Chinese academic paper Word template.

Replaces any third-party journal original .doc/.docx file so the open-source
distribution contains zero third-party copyrighted template binaries.
"""
from __future__ import annotations

import hashlib
import json
from datetime import date
from pathlib import Path

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / "backend" / "app" / "word_templates" / "jcip"
OUT_DOCX = OUT_DIR / "template.docx"
OUT_META = OUT_DIR / "template.json"


def _set_run_font(run, cn: str = "宋体", en: str = "Times New Roman", size_pt: float = 10.5, bold: bool = False,
                  italic: bool = False, color: tuple[int, int, int] | None = None) -> None:
    run.font.name = en
    run.font.size = Pt(size_pt)
    run.bold = bold
    run.italic = italic
    if color is not None:
        run.font.color.rgb = RGBColor(*color)
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.insert(0, rfonts)
    rfonts.set(qn("w:ascii"), en)
    rfonts.set(qn("w:hAnsi"), en)
    rfonts.set(qn("w:cs"), en)
    rfonts.set(qn("w:eastAsia"), cn)


def _set_cell_border(cell, **borders) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    tc_borders = tc_pr.find(qn("w:tcBorders"))
    if tc_borders is None:
        tc_borders = OxmlElement("w:tcBorders")
        tc_pr.append(tc_borders)
    for edge, spec in borders.items():
        el = tc_borders.find(qn(f"w:{edge}"))
        if el is None:
            el = OxmlElement(f"w:{edge}")
            tc_borders.append(el)
        if spec is None:
            el.set(qn("w:val"), "nil")
        else:
            el.set(qn("w:val"), spec.get("val", "single"))
            el.set(qn("w:sz"), str(spec.get("sz", 4)))
            el.set(qn("w:space"), "0")
            el.set(qn("w:color"), spec.get("color", "000000"))


def _add_paragraph(doc: Document, text: str = "", *, align=WD_ALIGN_PARAGRAPH.LEFT,
                   cn: str = "宋体", en: str = "Times New Roman", size_pt: float = 10.5,
                   bold: bool = False, italic: bool = False,
                   space_before: float = 0, space_after: float = 0,
                   line_spacing: float = 1.25, first_line_indent_cm: float = 0.0,
                   color: tuple[int, int, int] | None = None):
    p = doc.add_paragraph()
    p.alignment = align
    pf = p.paragraph_format
    pf.space_before = Pt(space_before)
    pf.space_after = Pt(space_after)
    pf.line_spacing = line_spacing
    if first_line_indent_cm:
        pf.first_line_indent = Cm(first_line_indent_cm)
    if text:
        run = p.add_run(text)
        _set_run_font(run, cn=cn, en=en, size_pt=size_pt, bold=bold, italic=italic, color=color)
    return p


def build_template() -> Path:
    doc = Document()

    # 页面设置：A4，标准中文学术期刊边距
    sec = doc.sections[0]
    sec.page_width = Cm(21.0)
    sec.page_height = Cm(29.7)
    sec.top_margin = Cm(2.5)
    sec.bottom_margin = Cm(2.5)
    sec.left_margin = Cm(2.2)
    sec.right_margin = Cm(2.2)
    sec.header_distance = Cm(1.5)
    sec.footer_distance = Cm(1.5)

    # 页眉 / 页脚
    header_p = sec.header.paragraphs[0]
    header_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    hr = header_p.add_run("Paper Studio 开源中文学术论文通用模板（可按目标期刊规范自由调整）")
    _set_run_font(hr, cn="宋体", en="Times New Roman", size_pt=8.5, color=(110, 110, 110))

    footer_p = sec.footer.paragraphs[0]
    footer_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    fr = footer_p.add_run("— 稿件草稿 · 请在投稿前核对目标期刊版式要求 —")
    _set_run_font(fr, cn="宋体", en="Times New Roman", size_pt=8.5, color=(110, 110, 110))

    # 调整 Normal 默认样式
    normal = doc.styles["Normal"]
    normal.font.name = "Times New Roman"
    normal.font.size = Pt(10.5)
    rpr = normal._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.insert(0, rfonts)
    rfonts.set(qn("w:ascii"), "Times New Roman")
    rfonts.set(qn("w:hAnsi"), "Times New Roman")
    rfonts.set(qn("w:eastAsia"), "宋体")

    # 1. 中文题名与作者信息
    _add_paragraph(
        doc,
        "中文学术论文题目（请替换为您的论文标题）",
        align=WD_ALIGN_PARAGRAPH.CENTER,
        cn="黑体",
        size_pt=16,
        bold=True,
        space_before=4,
        space_after=8,
    )
    _add_paragraph(
        doc,
        "第一作者1，第二作者1,2，通信作者2*",
        align=WD_ALIGN_PARAGRAPH.CENTER,
        cn="仿宋",
        size_pt=11,
        space_after=4,
    )
    _add_paragraph(
        doc,
        "(1. 第一单位全称 学院/实验室，省市 邮编；2. 第二单位全称 学院/实验室，省市 邮编)",
        align=WD_ALIGN_PARAGRAPH.CENTER,
        cn="宋体",
        size_pt=9,
        space_after=10,
        color=(70, 70, 70),
    )

    # 2. 中文摘要与关键词
    p_abs = _add_paragraph(doc, space_after=4, line_spacing=1.2)
    r1 = p_abs.add_run("摘要：")
    _set_run_font(r1, cn="黑体", size_pt=9.5, bold=True)
    r2 = p_abs.add_run(
        "本文给出了一份结构清晰的中文学术论文通用模板。请在 200—300 字内概述研究背景与待解决的核心问题、"
        "所提出的方法或实验设计、主要定量结果以及研究结论。建议以第三人称客观表述，避免出现未定义的缩写或公式编号。"
    )
    _set_run_font(r2, cn="宋体", size_pt=9.5)

    p_kw = _add_paragraph(doc, space_after=10, line_spacing=1.2)
    r1 = p_kw.add_run("关键词：")
    _set_run_font(r1, cn="黑体", size_pt=9.5, bold=True)
    r2 = p_kw.add_run("中文学术写作；协同论文平台；模板规范；科研排版")
    _set_run_font(r2, cn="宋体", size_pt=9.5)

    # 3. 英文题名、作者、摘要与关键词
    _add_paragraph(
        doc,
        "English Paper Title (Replace with Your Manuscript Title)",
        align=WD_ALIGN_PARAGRAPH.CENTER,
        en="Times New Roman",
        size_pt=13,
        bold=True,
        space_before=4,
        space_after=4,
    )
    _add_paragraph(
        doc,
        "First Author1, Second Author1,2, Corresponding Author2*",
        align=WD_ALIGN_PARAGRAPH.CENTER,
        en="Times New Roman",
        size_pt=10,
        space_after=3,
    )
    _add_paragraph(
        doc,
        "(1. School / Laboratory, First Institution, City PostalCode, China; 2. Second Institution, City PostalCode, China)",
        align=WD_ALIGN_PARAGRAPH.CENTER,
        en="Times New Roman",
        size_pt=8.5,
        italic=True,
        space_after=8,
        color=(70, 70, 70),
    )

    p_eabs = _add_paragraph(doc, space_after=4, line_spacing=1.2)
    r1 = p_eabs.add_run("Abstract: ")
    _set_run_font(r1, en="Times New Roman", size_pt=9.5, bold=True)
    r2 = p_eabs.add_run(
        "This open-source template provides a clean starting structure for Chinese academic manuscripts. "
        "Summarize the motivation, proposed methodology, key experimental findings, and main conclusions concisely in English."
    )
    _set_run_font(r2, en="Times New Roman", size_pt=9.5)

    p_ekw = _add_paragraph(doc, space_after=12, line_spacing=1.2)
    r1 = p_ekw.add_run("Keywords: ")
    _set_run_font(r1, en="Times New Roman", size_pt=9.5, bold=True)
    r2 = p_ekw.add_run("academic writing; collaborative editing; manuscript template; reproducible research")
    _set_run_font(r2, en="Times New Roman", size_pt=9.5)

    # 4. 正文章节骨架
    _add_paragraph(doc, "0  引言", cn="黑体", size_pt=12, bold=True, space_before=8, space_after=4)
    _add_paragraph(
        doc,
        "引言部分用于阐述研究背景、现实需求与现有工作的局限性，并清晰概括本文的主要贡献与章节安排。"
        "在 Paper Studio 中，可通过右侧文献面板按顺序编码制插入参考文献，例如 [1]。",
        first_line_indent_cm=0.74,
        space_after=6,
    )

    _add_paragraph(doc, "1  相关工作与方法设计", cn="黑体", size_pt=12, bold=True, space_before=8, space_after=4)
    _add_paragraph(doc, "1.1  问题定义", cn="黑体", size_pt=10.5, bold=True, space_before=4, space_after=3)
    _add_paragraph(
        doc,
        "在此处形式化描述输入、输出与优化目标。如需插入可编辑的原生数学公式，请打开顶部工具栏的「LaTeX 公式」插件，"
        "或在原生公式末尾输入 #(1) 后回车生成居中公式与右对齐编号。",
        first_line_indent_cm=0.74,
        space_after=6,
    )

    _add_paragraph(doc, "1.2  模型与算法框架", cn="黑体", size_pt=10.5, bold=True, space_before=4, space_after=3)
    _add_paragraph(
        doc,
        "建议使用「科研图表」插件或 Excalidraw 方法图绘制系统框架，并在正文中对核心模块与复杂度进行说明。",
        first_line_indent_cm=0.74,
        space_after=6,
    )

    _add_paragraph(doc, "2  实验与结果分析", cn="黑体", size_pt=12, bold=True, space_before=8, space_after=4)
    _add_paragraph(
        doc,
        "表 1 给出了三线表的基础样式示例。实验部分建议依次说明数据集、基线方法、评价指标、消融实验与误差分析。",
        first_line_indent_cm=0.74,
        space_after=6,
    )

    # 三线表示例
    _add_paragraph(
        doc,
        "表 1  不同方法在基准数据集上的性能对比（示例）",
        align=WD_ALIGN_PARAGRAPH.CENTER,
        cn="黑体",
        size_pt=9.5,
        bold=True,
        space_before=4,
        space_after=4,
    )
    table = doc.add_table(rows=3, cols=4)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    headers = ["方法", "准确率 (%)", "F1 值 (%)", "推理耗时 (ms)"]
    rows_data = [
        ["基线模型 A", "84.2", "83.6", "18.5"],
        ["本文方法", "89.7", "89.1", "14.2"],
    ]
    all_rows = [headers] + rows_data
    for r_idx, row_vals in enumerate(all_rows):
        row = table.rows[r_idx]
        for c_idx, val in enumerate(row_vals):
            cell = row.cells[c_idx]
            p = cell.paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p.paragraph_format.space_before = Pt(2)
            p.paragraph_format.space_after = Pt(2)
            run = p.add_run(val)
            _set_run_font(run, cn="宋体", size_pt=9, bold=(r_idx == 0))
            top = {"val": "single", "sz": 12} if r_idx == 0 else None
            bottom = (
                {"val": "single", "sz": 6}
                if r_idx == 0
                else ({"val": "single", "sz": 12} if r_idx == len(all_rows) - 1 else None)
            )
            _set_cell_border(cell, top=top, bottom=bottom, left=None, right=None)

    _add_paragraph(doc, "3  结论", cn="黑体", size_pt=12, bold=True, space_before=10, space_after=4)
    _add_paragraph(
        doc,
        "总结本文的核心发现、适用边界以及未来工作方向。投稿前可使用工作台「投稿检查」功能核验摘要、章节、引用与批注状态。",
        first_line_indent_cm=0.74,
        space_after=8,
    )

    # 5. 参考文献节
    _add_paragraph(doc, "参考文献", cn="黑体", size_pt=11, bold=True, space_before=10, space_after=4)
    _add_paragraph(
        doc,
        "[1] 作者姓名. 论文标题示例[J]. 学术期刊名称, 2026, 1(1): 1-10.",
        cn="宋体",
        size_pt=9,
        space_after=3,
    )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    doc.save(str(OUT_DOCX))

    sha = hashlib.sha256(OUT_DOCX.read_bytes()).hexdigest()
    meta = {
        "id": "jcip",
        "name": "中文学术论文模板（通用开源版）",
        "license": "Apache-2.0",
        "docx_sha256": sha,
        "generated_by": "backend/scripts/gen_cn_academic_word_template.py",
        "updated_at": str(date.today()),
        "source": "Original Apache-2.0 Chinese academic Word template authored for Paper Studio; administrators can upload any target journal .docx template in Admin -> Paper Templates.",
    }
    OUT_META.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return OUT_DOCX


if __name__ == "__main__":
    out = build_template()
    print(f"Generated: {out} ({out.stat().st_size} bytes)")
