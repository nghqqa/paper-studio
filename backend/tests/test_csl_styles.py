# -*- coding: utf-8 -*-
"""B3 多引文样式守卫：numeric 顺序制准入 + bibliography 前缀可剥离 + labels [n] 形态。"""
import os
import re
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.domain.word_citations import STYLES, _CSL_LABEL_RE  # noqa: E402

NEW_STYLES = ("springer-lncs", "acm", "elsevier-vancouver")
CSL_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app", "csl")

ENTRIES = [
    {"reference_id": "r1", "citation_key": "zhang2024", "entry_type": "article",
     "title": "Deep Learning Survey", "authors": ["Zhang, San", "Li, Si"], "year": "2024",
     "venue": "Nature", "volume": "10", "number": "2", "pages": "1-10",
     "fields": {"title": "Deep Learning Survey", "author": "Zhang, San and Li, Si",
                "year": "2024", "journal": "Nature", "volume": "10", "pages": "1--10"}},
    {"reference_id": "r2", "citation_key": "liu2023", "entry_type": "inproceedings",
     "title": "Transformer Tricks", "authors": ["Liu, Wu"], "year": "2023",
     "venue": "NeurIPS", "fields": {"title": "Transformer Tricks", "author": "Liu, Wu",
                                    "year": "2023", "booktitle": "NeurIPS"}},
]


def test_styles_whitelist_contains_new_entries():
    for s in NEW_STYLES:
        assert s in STYLES
    assert STYLES[0] == "gb-t-7714-2015"  # 默认样式契约（既有断言依赖）


@pytest.mark.parametrize("style", NEW_STYLES)
def test_csl_file_is_numeric_with_license(style):
    from app import config

    path = os.path.join(config.BACKEND_DIR, "app", "csl", f"{style}.csl")
    xml = open(path, encoding="utf-8").read()
    assert 'citation-format="numeric"' in xml, f"{style} 不是顺序编码制"
    assert "creativecommons.org/licenses/by-sa/3.0/" in xml, f"{style} 缺少 CC BY-SA 声明"


@pytest.mark.parametrize("style", [*NEW_STYLES, "ieee"])
def test_render_labels_bracketed_and_bibliography_prefix_strippable(style):
    """闸门：labels 恒 [n] 方括号；bibliography 前缀被 _CSL_LABEL_RE 干净剥离且无双标号。"""
    from app.routes.library import _render_csl
    from app.domain.library import LibraryEntry

    entries = [LibraryEntry.model_validate(e) for e in ENTRIES]
    style_file = os.path.join(CSL_DIR, f"{style}.csl")
    out = _render_csl(entries, style, style_file)
    assert out["style"] == style
    assert out["labels"] == {"r1": "[1]", "r2": "[2]"}
    for i, item in enumerate(out["bibliography"], 1):
        assert isinstance(item, str) and item.strip()
        stripped = _CSL_LABEL_RE.sub("", item).strip()
        assert stripped, f"{style} 第 {i} 条剥离后为空"
        # 双标号防护：剥离后不得再以 [n]/n. 形态开头（防 "[1] 1. 作者"）
        assert not _CSL_LABEL_RE.match(stripped), f"{style} 第 {i} 条出现双标号：{item[:40]!r}"
        assert stripped != item  # 确实剥掉了原生前缀


def test_render_failure_mentions_style_not_ieee_hardcode():
    """渲染失败文案不得再硬编码 IEEE（B3 复核项）：_render_entries 段内无 IEEE 字样。"""
    wc_path = os.path.abspath(os.path.join(CSL_DIR, "..", "domain", "word_citations.py"))
    src = open(wc_path, encoding="utf-8").read()
    section = src.split("def _render_entries")[1].split("\ndef ")[0]
    assert "IEEE" not in section
