# -*- coding: utf-8 -*-
"""Pandoc 运行前 LaTeX 源码预处理与中文项目检测。"""

from __future__ import annotations

import os
import re

_EQ_BLOCK_RE = re.compile(r"(\\begin\{equation\})(.*?)(\\end\{equation\})", re.S)
_ALIGN_BLOCK_RE = re.compile(r"\\begin\{(align|gather)\}(.*?)\\end\{\1\}", re.S)
_NESTED_ENV_RE = re.compile(r"\\(begin|end)\{[^}]+\}")
_CJK_CHAR_RE = re.compile(r"[\u4e00-\u9fff]")
_CTEX_HINT_RE = re.compile(
    r"\\(?:usepackage(?:\[[^\]]*\])?\{[^}]*(?:ctex|xeCJK)[^}]*\}|documentclass(?:\[[^\]]*\])?\{ctex)"
)


def _split_top_level_latex_rows(inner: str) -> list[str]:
    """按顶层 `\\\\` 拆分 align/gather 内容（跳过 cases/matrix 等嵌套环境内部的 `\\\\`）。"""
    rows: list[str] = []
    buf: list[str] = []
    depth = 0
    i = 0
    n = len(inner)
    while i < n:
        m = _NESTED_ENV_RE.match(inner, i)
        if m:
            depth += 1 if m.group(1) == "begin" else -1
            depth = max(0, depth)
            buf.append(m.group(0))
            i = m.end()
            continue
        if depth == 0 and inner.startswith("\\\\", i):
            rows.append("".join(buf))
            buf = []
            i += 2
            if i < n and inner[i] == "*":
                i += 1
            if i < n and inner[i] == "[":
                end_br = inner.find("]", i)
                if end_br != -1:
                    i = end_br + 1
            continue
        buf.append(inner[i])
        i += 1
    if buf:
        rows.append("".join(buf))
    return rows


def _strip_alignment_amp(line: str) -> str:
    """去除 align 对齐符 `&`（保留转义 `\\&` 及嵌套环境内部的 `&`）。"""
    out: list[str] = []
    depth = 0
    i = 0
    n = len(line)
    while i < n:
        m = _NESTED_ENV_RE.match(line, i)
        if m:
            depth += 1 if m.group(1) == "begin" else -1
            depth = max(0, depth)
            out.append(m.group(0))
            i = m.end()
            continue
        if depth == 0 and line[i] == "&" and (i == 0 or line[i - 1] != "\\"):
            i += 1
            continue
        out.append(line[i])
        i += 1
    return "".join(out)


_MAKEBOX_RE = re.compile(r"\\makebox(?:\[[^\]]*\]){0,2}\{([^{}]*)\}")
_EMPTY_NEWCMD_RE = re.compile(r"\\(?:new|renew)command\{\\([A-Za-z@]+)\}\{\s*\}")
_UNDERLINE_EMPTY_RE = re.compile(r"\\underline\{\s*\}")
_CMIDRULE_RE = re.compile(r"\\cmidrule(?:\([^)]*\))?(?:\[[^\]]*\])?\{[^}]*\}")
_PAGEBREAK_CMD_RE = re.compile(r"(?m)^[ \t]*\\(?:clearpage|cleardoublepage|newpage)[ \t]*$")
_CENTER_START_RE = re.compile(r"\\begin\{center\}")
_CENTER_END_RE = re.compile(r"\\end\{center\}")
_TITLEPAGE_START_RE = re.compile(r"\\begin\{titlepage\}")
_TITLEPAGE_END_RE = re.compile(r"\\end\{titlepage\}")
_ZIHao_RE = re.compile(r"\\zihao\{(-?\d+)\}")
_CJK_FONT_CMD_RE = re.compile(r"\\(heiti|songti|kaishu|fangsong)\b")
_VSPACE_RE = re.compile(r"\\vspace\*?\{([0-9.]+)\s*(cm|mm|pt|em)\}")
_LINEBREAK_SPACE_RE = re.compile(r"\\\\\[([0-9.]+)\s*(cm|mm|pt|em)\]")
_VFILL_RE = re.compile(r"\\vfill\b")
_HFILL_RE = re.compile(r"\\hfill\b")
_BIB_CMD_RE = re.compile(r"(?m)^[ \t]*\\bibliography\{[^}]+\}[ \t]*$")

_CJK_FONT_MAP = {
    "heiti": "SimHei",
    "songti": "SimSun",
    "kaishu": "KaiTi",
    "fangsong": "FangSong",
}

_ZIHAO_TO_HALF_PT = {
    "0": 84, "-0": 72, "1": 52, "-1": 48, "2": 44, "-2": 36,
    "3": 32, "-3": 30, "4": 28, "-4": 24, "5": 21, "-5": 18,
}


def preprocess_tex_for_pandoc(
    src_dir: str,
    split_multiline: bool = False,
    preserve_layout_markers: bool = False,
) -> int:
    """在临时快照中预处理公式与版式命令以获得原生 Word 体验：

    1. split_multiline=True 时，将 \\begin{align}/\\begin{gather} 按顶层 `\\\\` 拆为逐行
       独立的 \\begin{equation}（含 \\nonumber/\\notag 的行转为 equation*），使多行推导
       的每一行在 Word 中都能独立居中并右对齐编号、保留各自 \\label 与 \\eqref 交叉引用；
    2. preserve_layout_markers=True 时：
       - 展开 Pandoc 会静默丢弃的 \\makebox[...][...]{内容}；
       - 将 \\begin{center}...\\end{center} 与 \\clearpage/\\newpage/\\end{titlepage}
         转为可穿越 Pandoc AST 的占位标记，由 polish_docx_native 还原为真正的居中段落与硬分页符；
    3. 为所有无 \\label 且不含 \\nonumber/\\notag 的 \\begin{equation} 注入合成标签
       \\label{__auto_eq_N__}，确保与原生 LaTeX 一致自动编号 (1), (2), ...。
    """
    counter = 0
    for root_dir, _dirs, files in os.walk(src_dir):
        for fn in sorted(files):
            if not fn.lower().endswith((".tex", ".ltx")):
                continue
            path = os.path.join(root_dir, fn)
            try:
                text = open(path, encoding="utf-8", errors="replace").read()
            except OSError:
                continue

            new_text = text
            if preserve_layout_markers:
                new_text = _CMIDRULE_RE.sub("", new_text)
                empty_macros = set(_EMPTY_NEWCMD_RE.findall(new_text))
                for _ in range(3):
                    updated = _MAKEBOX_RE.sub(r"\1", new_text)
                    if updated == new_text:
                        break
                    new_text = updated
                new_text = _UNDERLINE_EMPTY_RE.sub("__PS_ULINE__", new_text)
                if empty_macros:
                    pat = re.compile(
                        r"\\underline\{\s*\\(?:" + "|".join(re.escape(m) for m in sorted(empty_macros)) + r")\s*\}"
                    )
                    new_text = pat.sub("__PS_ULINE__", new_text)
                doc_pos = new_text.find("\\begin{document}")
                head_part = new_text[:doc_pos] if doc_pos != -1 else ""
                body_part = new_text[doc_pos:] if doc_pos != -1 else new_text

                def _zihao_repl(m: re.Match[str]) -> str:
                    sz = _ZIHAO_TO_HALF_PT.get(m.group(1))
                    return f"__PS_SZ_{sz}__" if sz else ""

                def _cjk_font_repl(m: re.Match[str]) -> str:
                    fam = _CJK_FONT_MAP.get(m.group(1))
                    return f"__PS_FONT_{fam}__" if fam else ""

                def _vspace_repl(m: re.Match[str]) -> str:
                    val, unit = float(m.group(1)), m.group(2)
                    mult = {"cm": 567, "mm": 57, "pt": 20, "em": 240}.get(unit, 200)
                    tw = max(120, min(2400, int(val * mult)))
                    return f"\n\n__PS_VSPACE_{tw}__\n\n"

                def _lb_space_repl(m: re.Match[str]) -> str:
                    val, unit = float(m.group(1)), m.group(2)
                    mult = {"cm": 567, "mm": 57, "pt": 20, "em": 240}.get(unit, 200)
                    tw = max(120, min(1800, int(val * mult)))
                    return f"\\\\\n__PS_VSPACE_{tw}__"

                def _patch_titlepage_lb(m: re.Match[str]) -> str:
                    inner = m.group(0)
                    parts = re.split(r"(\\begin\{tabular\}.*?\\end\{tabular\})", inner, flags=re.S)
                    for idx_p in range(0, len(parts), 2):
                        parts[idx_p] = _LINEBREAK_SPACE_RE.sub(_lb_space_repl, parts[idx_p])
                    return "".join(parts)

                body_part = re.sub(
                    r"\\begin\{titlepage\}.*?\\end\{titlepage\}", _patch_titlepage_lb, body_part, flags=re.S
                )
                body_part = _TITLEPAGE_START_RE.sub(
                    lambda _: "\\begin{titlepage}\n\n__PS_TITLEPAGE_START__\n\n", body_part
                )
                body_part = _TITLEPAGE_END_RE.sub(
                    lambda _: "\n\n__PS_TITLEPAGE_END__\n\n\\end{titlepage}\n\n__PS_PAGEBREAK__\n\n", body_part
                )
                body_part = _ZIHao_RE.sub(_zihao_repl, body_part)
                body_part = _CJK_FONT_CMD_RE.sub(_cjk_font_repl, body_part)
                body_part = _VSPACE_RE.sub(_vspace_repl, body_part)
                body_part = _VFILL_RE.sub("\n\n__PS_VSPACE_1400__\n\n", body_part)
                body_part = _HFILL_RE.sub("__PS_HFILL__", body_part)
                body_part = _CENTER_START_RE.sub("\n\n__PS_CENTER_START__\n\n", body_part)
                body_part = _CENTER_END_RE.sub("\n\n__PS_CENTER_END__\n\n", body_part)
                body_part = _PAGEBREAK_CMD_RE.sub("\n\n__PS_PAGEBREAK__\n\n", body_part)
                body_part = _BIB_CMD_RE.sub(lambda m: f"\n\n__PS_REFS_HERE__\n\n{m.group(0)}", body_part)
                new_text = head_part + body_part

            if split_multiline:
                def _split_align(m: re.Match[str]) -> str:
                    rows = _split_top_level_latex_rows(m.group(2))
                    blocks: list[str] = []
                    for raw in rows:
                        cleaned = _strip_alignment_amp(raw).strip()
                        if not cleaned:
                            continue
                        if "\\nonumber" in cleaned or "\\notag" in cleaned:
                            cleaned = cleaned.replace("\\nonumber", "").replace("\\notag", "").strip()
                            blocks.append(f"\\begin{{equation*}}\n{cleaned}\n\\end{{equation*}}")
                        else:
                            blocks.append(f"\\begin{{equation}}\n{cleaned}\n\\end{{equation}}")
                    return "\n\n".join(blocks) if blocks else m.group(0)

                new_text = _ALIGN_BLOCK_RE.sub(_split_align, new_text)

            def _repl(m: re.Match[str]) -> str:
                nonlocal counter
                head, inner, tail = m.group(1), m.group(2), m.group(3)
                if "\\label{" in inner or "\\nonumber" in inner or "\\notag" in inner:
                    return m.group(0)
                counter += 1
                return f"{head}{inner}\\label{{__auto_eq_{counter}__}}{tail}"

            new_text = _EQ_BLOCK_RE.sub(_repl, new_text)
            if new_text != text:
                with open(path, "w", encoding="utf-8", newline="\n") as f:
                    f.write(new_text)
    return counter


def detect_cjk_project(src_dir: str, main_rel: str) -> bool:
    """检测工程是否为中文论文（ctex/xeCJK 宏包或正文包含中文字符）。"""
    main_path = os.path.join(src_dir, main_rel)
    samples: list[str] = []
    if os.path.isfile(main_path):
        try:
            samples.append(open(main_path, encoding="utf-8", errors="replace").read(65536))
        except OSError:
            pass
    for s in samples:
        if _CTEX_HINT_RE.search(s):
            return True
        if len(_CJK_CHAR_RE.findall(s)) >= 5:
            return True
    for root_dir, _dirs, files in os.walk(src_dir):
        for fn in files:
            if not fn.lower().endswith((".tex", ".ltx")):
                continue
            p = os.path.join(root_dir, fn)
            try:
                txt = open(p, encoding="utf-8", errors="replace").read(16384)
            except OSError:
                continue
            if _CTEX_HINT_RE.search(txt) or len(_CJK_CHAR_RE.findall(txt)) >= 5:
                return True
    return False
