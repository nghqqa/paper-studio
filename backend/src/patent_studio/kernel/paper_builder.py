# -*- coding: utf-8 -*-
"""学术论文单栏基础版式装配器（paper 档案，w20 批 A1）。

版式（独立常量，不占用 CNIPA DEFAULT_STYLE 语义；参数化在 w20 批 A3）：
  A4，页边距同 patent 默认（上25/下15/左25/右15mm）；无页眉、无 CNIPA 页脚表格编号与年份——页脚仅居中页码；
  `# 标题`   → 文档标题：黑体 16pt 加粗居中；
  `## 章`    → 一级标题：黑体 14pt 加粗；
  `### 节`   → 二级标题：黑体 12pt 加粗；
  `#### 子节` → 三级标题：宋体 12pt 加粗；
  正文段     → 宋体 12pt 两端对齐、首行缩进 24pt；无 [0001] 段号（paper 不调用 numbering）。
  公式（OMML）/表格（三线等选项）/图片/题注装配复用 PatentBuilder 同名方法，仅去掉段号包装；
  builder.py 本体零改动——专利零漂移由构造保证。

mode=markup（Word 真修订）暂不支持（build 层显式拒绝，见 app/domain/build.py）。
"""

import os

from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt

from .builder import BuildResult, PatentBuilder
from .paper import parse_paper_md
from .style import merge_style

PAPER_SIZES = {"title": 16, "h1": 14, "h2": 12, "h3": 12}
"""pt：文档标题 / 一级 / 二级 / 三级标题。"""
PAPER_FIRST_INDENT_PT = 24
"""正文首行缩进（2 字符 @ 12pt），与 patent 正文一致。"""


class PaperBuilder(PatentBuilder):
    """复用公式/表格/图片/页码装配；标题与正文重定义（无段号、无 CNIPA 页眉页脚）。"""

    def heading_level(self, text, level):
        """`## `/`### `/`#### ` → 一/二/三级标题（level ∈ 1/2/3）。"""
        if level == 1:
            return self.para(
                text, size=PAPER_SIZES["h1"], font=self.hei, bold=True,
                align=WD_ALIGN_PARAGRAPH.LEFT, space_after=12,
            )
        if level == 2:
            return self.para(
                text, size=PAPER_SIZES["h2"], font=self.hei, bold=True,
                align=WD_ALIGN_PARAGRAPH.LEFT, space_after=8,
            )
        return self.para(
            text, size=PAPER_SIZES["h3"], font=self.song, bold=True,
            align=WD_ALIGN_PARAGRAPH.LEFT, space_after=6,
        )

    def body_para(self, text):
        return self.para(text, first_indent=PAPER_FIRST_INDENT_PT, space_after=self.gap("body"))

    def caption(self, text):
        """表题后置/图题注：居中小字号段（专利的表题走编号段，paper 无段号）。"""
        return self.para(text, size=self.sz("table"), align=WD_ALIGN_PARAGRAPH.CENTER, space_after=2)

    def table_note(self, text):
        return self.para(text, size=self.sz("table"), space_after=2)

    def code_block(self, lines_):
        """代码块：单段多行等宽体，无段号（对照专利 add_pseudocode 的编号段写法）。"""
        p = self.doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.LEFT
        p.paragraph_format.space_after = Pt(self.gap("body"))
        p.paragraph_format.line_spacing = self.style["paragraph"]["line_spacing"]
        for k, ln in enumerate(lines_):
            if k:
                p.add_run().add_break()
            run = p.add_run(ln)
            run.font.name = self.style["fonts"]["mono"]
            run.font.size = Pt(self.sz("code"))
            run._element.rPr.rFonts.set(qn("w:eastAsia"), self.song)
        return p

    def _page_setup(self):
        doc = self.doc
        st = doc.settings.element
        tab = st.find(qn("w:defaultTabStop"))
        if tab is None:
            tab = OxmlElement("w:defaultTabStop")
            st.append(tab)
        tab.set(qn("w:val"), str(self.style["page"]["default_tab_stop"]))
        self.a4(doc.sections[0])
        doc.sections[0].footer.is_linked_to_previous = False
        fp = doc.sections[0].footer.paragraphs[0]
        fp.text = ""
        self.add_page_field(fp)


def build_paper_ex(config):
    """paper 档案构建：config = {content_md, out, figs_dir, style?, sub_except?, run_hook?}。

    返回 BuildResult（摘要字数取「摘要」章正文，claims=0，paragraphs=正文块计数）——
    形状与 build_patent_ex 一致，run_build 汇总/产物逻辑共用。"""
    style = merge_style(config.get("style"))
    b = PaperBuilder(
        sub_except=config.get("sub_except", ()), style=style, run_hook=config.get("run_hook")
    )
    with open(config["content_md"], encoding="utf-8") as f:
        title, sections = parse_paper_md(f.read())
    if not title:
        raise ValueError("缺少「# 标题」行：paper 档案必须以「# 标题」开始")
    figs = config["figs_dir"]
    b._page_setup()
    b.para(
        title, size=PAPER_SIZES["title"], font=b.hei, bold=True,
        align=WD_ALIGN_PARAGRAPH.CENTER, space_after=b.gap("title"),
    )
    abstract_chars = 0
    paragraphs = 0
    for name, items in sections:
        if name:
            b.heading_level(name, 1)
        for item in items:
            if not isinstance(item, tuple):
                b.body_para(item)
                paragraphs += 1
                if name == "摘要":
                    abstract_chars += len(item)
                continue
            kind = item[0]
            if kind == "f":
                b.add_figure(os.path.join(figs, item[1]), item[3] or "", item[2])
                paragraphs += 1
            elif kind == "e":
                b.equation(item[1], item[2])
            elif kind == "t":
                topts = b.table_opts(item[2] if len(item) > 2 else {})
                b.add_table(item[1], topts)
                if topts.get("表题后置"):
                    b.caption(topts["表题后置"])
                if topts.get("表注"):
                    b.table_note(topts["表注"])
                b.para("", space_after=b.gap("table_gap"))
                paragraphs += 1
            elif kind == "c":
                b.code_block(item[1])
                paragraphs += 1
            elif kind == "h":
                b.heading_level(item[1], 2)
            else:
                b.heading_level(item[1], 3)
            if name == "摘要" and not isinstance(item, tuple):
                abstract_chars += len(item)
    doc = b.doc
    doc.save(config["out"])
    return BuildResult(
        out=config["out"], abstract_chars=abstract_chars, claims=0, paragraphs=paragraphs, title=title
    )
