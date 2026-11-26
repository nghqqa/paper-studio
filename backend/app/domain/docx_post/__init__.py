# -*- coding: utf-8 -*-
"""公式编号版式、题区补排与原生 Word 观感后处理包（统一再导出原单文件全部接口）。"""

from .equations import apply_eq_layout
from .meta import apply_meta_layout
from .ooxml import DEFAULT_TEXT_W, NS_M, NS_W, M, W, _text_width_twips
from .passes import (
    _pass_dedup_pagebreaks,
    _pass_layout_markers,
    _pass_relocate_references,
    _pass_split_soft_breaks,
    _pass_thesis_chapters,
    _pass_trim_empty_frontmatter,
    polish_docx_native,
)
from .preprocess import (
    _split_top_level_latex_rows,
    _strip_alignment_amp,
    detect_cjk_project,
    preprocess_tex_for_pandoc,
)

__all__ = [
    "NS_W",
    "NS_M",
    "DEFAULT_TEXT_W",
    "W",
    "M",
    "_text_width_twips",
    "apply_eq_layout",
    "apply_meta_layout",
    "polish_docx_native",
    "preprocess_tex_for_pandoc",
    "detect_cjk_project",
    "_split_top_level_latex_rows",
    "_strip_alignment_amp",
    "_pass_split_soft_breaks",
    "_pass_layout_markers",
    "_pass_thesis_chapters",
    "_pass_relocate_references",
    "_pass_trim_empty_frontmatter",
    "_pass_dedup_pagebreaks",
]
