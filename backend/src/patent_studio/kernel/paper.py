# -*- coding: utf-8 -*-
"""论文文档档案（paper profile）：文档类型常量与 content.md 论文解析（w20 批 A1）。

document_type（studio.json 顶层字段，项目级规范值）：
  "patent"  CN 发明专利三书档案（缺省值）：content.parse_md 封闭三书语法 + [0001] 段号，行为不变
  "paper"   学术论文单栏档案：`## ` 任意章节、无段号、paper_builder 版式

论文 markdown 约定（与 patent 说明书共用同一套正文 spec 项）：
  # 标题        → 文档标题（全文唯一，居中）
  ## 章名       → 一级章节（摘要/引言/方法/结果/讨论/参考文献……任意命名、任意数量）
  ### 节名      → 二级小节
  #### 子节名    → 三级小节
  正文块 = 一段一行；$$…$$（编号）独立公式、$…$ 行内公式、| 管道表格（含 三线/列宽/^^ 合并）、
  ``` 代码块、![alt](figs/x){width=N} 内嵌图，语法与 patent 说明书一致。

不支持（显式记录，不静默丢弃）：列表/脚注/引用块等语法行按普通段落文本原样保留（内容不丢、
版式不解析）；文内引用 [N] 与「## 参考文献」只是普通文本/章节，语义化在 w20 批 C1/C2。
"""

from .content import _spec_from_lines

DOCUMENT_TYPES = ("patent", "paper")
DEFAULT_DOCUMENT_TYPE = "patent"


def normalize_document_type(value):
    """None/空 → patent；未知值抛 ValueError（domain 层转 422，未知类型明确报错）。"""
    if value is None or str(value).strip() == "":
        return DEFAULT_DOCUMENT_TYPE
    v = str(value).strip()
    if v not in DOCUMENT_TYPES:
        raise ValueError(f"未知文档类型：{value}（允许：{'、'.join(DOCUMENT_TYPES)}）")
    return v


def parse_paper_md(text):
    """论文档案解析 → (title, sections)。

    sections = [(章名|None, [spec 项])]：章名 None 表示 `# 标题` 之后、首个 `## ` 之前的散落内容
    （渲染为无标题正文）；spec 项形状与 content.parse_md 的说明书项一致。"""
    raw = text.rstrip("\n").split("\n")
    title = None
    sections = []
    cur = None
    for ln in raw:
        if ln.startswith("# ") and not ln.startswith("## "):
            title = ln[2:].strip()
        elif ln.startswith("## "):
            cur = []
            sections.append((ln[3:].strip(), cur))
        else:
            if cur is None:
                cur = []
                sections.append((None, cur))
            cur.append(ln)
    return title, [(name, _spec_from_lines(items)) for name, items in sections]
