# -*- coding: utf-8 -*-
"""结构化中文论文（实验，v0.1 proto）：内容模型、版本快照、校验与 jcip 子集 LaTeX 生成。

事实源 = 项目目录内 content.json（schema_version 化 JSON；对象稳定 ID；引用存目标 ID）。
版本快照 = .studio/structured/versions/{sha}.json + versions.json 索引。
公式源码 = LaTeX 数学子集（KaTeX 渲染 ∩ pandoc→OMML 可靠转换），白名单外交互提示、导出阻断。
边界：本模块不做 DOCX 导入、不做任意模板适配、不承诺格式无损双向同步。
"""
import hashlib
import json
import os
import re
import time

SCHEMA_VERSION = 1
STRUCT_CONTENT_FILE = "content.json"
STRUCT_VERSIONS_DIR = os.path.join(".studio", "structured", "versions")
STRUCT_VERSIONS_INDEX = os.path.join(".studio", "structured", "versions.json")

# 允许的 LaTeX 命令（KaTeX 渲染 ∩ pandoc→OMML 可靠转换的交集；矩阵限定常用环境）
ALLOWED_COMMANDS = {
    "frac", "dfrac", "sqrt", "sum", "prod", "int", "lim",
    "exp", "max", "min", "log", "ln", "sin", "cos", "tan", "top",
    "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta",
    "theta", "iota", "kappa", "lambda", "mu", "nu", "xi", "pi", "rho",
    "sigma", "tau", "upsilon", "phi", "varphi", "chi", "psi", "omega",
    "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Phi", "Psi", "Omega",
    "times", "cdot", "div", "pm", "mp", "leq", "geq", "neq", "approx", "equiv",
    "infty", "partial", "nabla", "forall", "exists", "in", "subset", "cup", "cap",
    "rightarrow", "leftarrow", "Rightarrow", "Leftarrow", "mapsto", "to",
    "mathbf", "mathrm", "mathit", "boldsymbol", "text", "operatorname",
    "left", "right", "quad", "qquad",
    "begin", "end",  # 环境限定见 ALLOWED_ENVIRONMENTS
}
ALLOWED_ENVIRONMENTS = {"pmatrix", "bmatrix", "matrix", "cases", "aligned"}

CMD_RE = re.compile(r"\\([a-zA-Z]+)")
ENV_NAME_RE = re.compile(r"\\(?:begin|end)\{(\w+\*?)\}")
LABEL_RE = re.compile(r"\\label\s*\{([^}]*)\}")
REF_RE = re.compile(r"\[\[(eq|fig|tab):([A-Za-z0-9_-]+)\]\]")
INLINE_MATH_RE = re.compile(r"\$([^$]+)\$")

OBJECT_KINDS = {"formula": "eq", "figure": "fig", "table": "tab"}


def check_formula(latex: str) -> list:
    """不支持命令/环境列表（空=通过）。\\label 由系统注入，用户手写视为不支持。"""
    bad = []
    for name in CMD_RE.findall(latex or ""):
        if name in ALLOWED_COMMANDS:
            continue
        if name == "label":
            bad.append("\\label（编号由系统生成，请勿手写）")
            continue
        bad.append("\\" + name)
    for env in ENV_NAME_RE.findall(latex or ""):
        if env not in ALLOWED_ENVIRONMENTS:
            bad.append(f"\\begin{{{env}}}")
    return sorted(set(bad))


def check_inline_math(text: str) -> list:
    bad = set()
    for m in INLINE_MATH_RE.finditer(text or ""):
        for x in check_formula(m.group(1)):
            bad.add(x)
    return sorted(bad)


def collect_objects(content: dict) -> dict:
    """{"eq:<id>"/"fig:<id>"/"tab:<id>": block}，按文档顺序（编号事实源）。"""
    out = {}
    for b in content.get("body", []):
        t = b.get("type")
        if t in OBJECT_KINDS and b.get("id"):
            out[f"{OBJECT_KINDS[t]}:{b['id']}"] = b
    return out


def validate(content: dict) -> dict:
    """导出/保存门禁。errors 非空 = 导出阻断（保存草稿允许，问题原样返回给前端展示）。"""
    errors = []
    objs = collect_objects(content)
    ids = [b.get("id") for b in content.get("body", []) if b.get("id")]
    if len(ids) != len(set(ids)):
        errors.append("存在重复对象 ID")

    def scan_text(text, where):
        for m in REF_RE.finditer(text or ""):
            full = f"{m.group(1)}:{m.group(2)}"
            if full not in objs:
                errors.append(f"{where}：失效引用 [[{full}]]（对象不存在或已删除）")
        for x in check_inline_math(text or ""):
            errors.append(f"{where}：行内公式使用不支持命令 {x}")

    for b in content.get("body", []):
        bid = b.get("id") or b.get("type")
        t = b.get("type")
        if t == "p":
            scan_text(b.get("text", ""), f"段落[{bid}]")
        elif t == "formula":
            for x in check_formula(b.get("latex", "")):
                errors.append(f"公式[{bid}]：不支持命令 {x}")
            if LABEL_RE.search(b.get("latex", "")):
                errors.append(f"公式[{bid}]：请勿手写 \\label（编号由系统生成）")
            if not (b.get("latex") or "").strip():
                errors.append(f"公式[{bid}]：公式源码为空")
        elif t == "figure":
            if not b.get("resource"):
                errors.append(f"图[{bid}]：未上传图片")
            scan_text(b.get("caption", ""), f"图题[{bid}]")
        elif t == "table":
            if not (b.get("rows") or []):
                errors.append(f"表[{bid}]：表格无内容")
            scan_text(b.get("caption", ""), f"表题[{bid}]")
    for k in ("abstract_zh", "abstract_en", "title_en"):
        for x in check_inline_math(content.get(k, "")):
            errors.append(f"{k}：行内公式使用不支持命令 {x}")
    return {"ok": not errors, "errors": errors, "warnings": []}


# ---------------------------------------------------------------- 持久化


def content_path(project_dir: str) -> str:
    return os.path.join(project_dir, STRUCT_CONTENT_FILE)


def content_sha(content: dict) -> str:
    raw = json.dumps(content, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()


def load_content(project_dir: str) -> dict:
    with open(content_path(project_dir), encoding="utf-8") as f:
        return json.load(f)


def save_content(project_dir: str, content: dict, source: str) -> dict:
    """原子保存 + 版本快照（sha 命名；同内容不重复建快照）。返回 {vid, sha}。"""
    raw = json.dumps(content, ensure_ascii=False, sort_keys=True, indent=1)
    sha = hashlib.sha256(raw.encode()).hexdigest()[:16]
    vdir = os.path.join(project_dir, STRUCT_VERSIONS_DIR)
    os.makedirs(vdir, exist_ok=True)
    snap = os.path.join(vdir, f"{sha}.json")
    if not os.path.exists(snap):
        tmp = snap + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(raw)
        os.replace(tmp, snap)
    tmp = content_path(project_dir) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(json.dumps(content, ensure_ascii=False, indent=1))
    os.replace(tmp, content_path(project_dir))
    idx_path = os.path.join(project_dir, STRUCT_VERSIONS_INDEX)
    idx = []
    if os.path.exists(idx_path):
        with open(idx_path, encoding="utf-8") as f:
            idx = json.load(f)
    if idx and idx[-1]["sha"] == sha:
        return {"vid": idx[-1]["vid"], "sha": sha}
    v = {"vid": f"v{len(idx) + 1:03d}-{sha[:6]}", "sha": sha, "at": int(time.time()), "source": source}
    idx.append(v)
    tmp = idx_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(idx, f, ensure_ascii=False, indent=1)
    os.replace(tmp, idx_path)
    return v


def load_versions(project_dir: str) -> list:
    idx_path = os.path.join(project_dir, STRUCT_VERSIONS_INDEX)
    if not os.path.exists(idx_path):
        return []
    with open(idx_path, encoding="utf-8") as f:
        return json.load(f)


def load_version_snapshot(project_dir: str, sha: str) -> dict | None:
    p = os.path.join(project_dir, STRUCT_VERSIONS_DIR, f"{sha}.json")
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------- LaTeX 生成


def _esc_text(t: str) -> str:
    """正文文本 → LaTeX：转义特殊字符；行内 $...$ 片段由调用方先拆出、不经过本函数。"""
    parts = re.split(r"(\$[^$]+\$)", t or "")
    out = []
    for i, part in enumerate(parts):
        if i % 2 == 1:
            out.append(part)
            continue
        x = part
        for a, b in [("\\", r"\textbackslash{}"), ("&", r"\&"), ("%", r"\%"),
                     ("#", r"\#"), ("_", r"\_"), ("{", r"\{"), ("}", r"\}"),
                     ("~", r"\textasciitilde{}"), ("^", r"\textasciicircum{}")]:
            x = x.replace(a, b)
        out.append(x)
    return "".join(out)


def _inline_refs(t: str) -> str:
    """[[eq:id]] → \eqref{eq:id}；[[fig:id]] → 图~\ref{fig:id}；[[tab:id]] → 表~\ref{tab:id}。"""

    def sub(m):
        kind, oid = m.group(1), m.group(2)
        if kind == "eq":
            return f"\\eqref{{eq:{oid}}}"
        label = "图" if kind == "fig" else "表"
        return f"{label}~\\ref{{{kind}:{oid}}}"

    return REF_RE.sub(sub, t)


def _cell_latex(x: str) -> str:
    """表格单元格：$...$ 片段按行内数学保留（保留 $ 定界符 → pandoc→OMML），其余转义。"""
    parts = re.split(r"(\$[^$]+\$)", x or "")
    out = []
    for i, part in enumerate(parts):
        if i % 2 == 1:
            out.append("$" + part + "$")
            continue
        out.append(_inline_refs(_esc_text(part)))
    return "".join(out)


def _para_latex(block: dict) -> str:
    text = _inline_refs(_esc_text(block.get("text", "")))
    return re.sub(r"\n+", " ", text).strip()


def gen_latex(content: dict, resource_files: dict | None = None) -> str:
    """生成 jcip 子集 LaTeX（与 backend/app/domain/jcip_seed 样例同形态；
    经 backend/app/docx_export_assets 的 numbering/layout.lua 出编号与单栏题区+双栏版式）。"""
    title = _esc_text(content.get("title_zh") or content.get("title") or "").replace(" ", "~")
    title_en = _esc_text(content.get("title_en", ""))
    authors = _esc_text(content.get("authors", ""))
    affil = _esc_text(content.get("affil", ""))
    abstract_zh = _inline_refs(_esc_text(content.get("abstract_zh", "")))
    abstract_en = _esc_text(content.get("abstract_en", ""))
    keywords = _esc_text(content.get("keywords", ""))

    out = [
        "\\documentclass[10pt,twocolumn]{article}",
        "\\usepackage{ctex}",
        "\\usepackage{amsmath,amssymb}",
        "\\usepackage{graphicx}",
        "\\usepackage{booktabs}",
        "\\usepackage[numbers]{natbib}",
        "\\usepackage[affil-it]{authblk}",
        "\\title{" + title + "}",
        "\\author{" + authors + "}",
        "\\affil{" + affil + "}",
        "\\date{}",
        "\\begin{document}",
        "\\maketitle",
    ]
    # pandoc docx writer 丢弃 \affil（authblk）——单位另以正文段落输出，
    # 由 docx_post.apply_meta_layout 按文本匹配居中缩字（保住题区单位行）
    if affil:
        out += [affil, ""]
    out += [
        "\\begin{abstract}",
        abstract_zh,
        "\\end{abstract}",
        "\\noindent\\textbf{关键词：}" + keywords,
        "\\vspace{0.5em}",
        "",
    ]
    title_en = _esc_text(content.get("title_en", ""))
    abstract_en = _esc_text(content.get("abstract_en", ""))
    if title_en or abstract_en:
        if title_en:
            out.append("\\noindent\\textbf{" + title_en + "}")
            out.append("")
        if abstract_en:
            out.append("\\noindent " + abstract_en)
            out.append("\\vspace{0.5em}")
            out.append("")

    for b in content.get("body", []):
        t = b.get("type")
        if t == "h1":
            out.append("\\section{" + _inline_refs(_esc_text(b.get("text", ""))) + "}")
        elif t == "h2":
            out.append("\\subsection{" + _inline_refs(_esc_text(b.get("text", ""))) + "}")
        elif t == "p":
            para = _para_latex(b)
            if para:
                out.append(para)
                out.append("")
        elif t == "formula":
            out.append("\\begin{equation}")
            out.append(b.get("latex", "").strip())
            out.append("\\label{eq:" + b["id"] + "}")
            out.append("\\end{equation}")
        elif t == "figure":
            fname = (resource_files or {}).get(b["resource"]) or b["resource"]
            out.append("\\begin{figure}[h]")
            out.append("\\centering")
            out.append("\\includegraphics[width=0.85\\linewidth]{figs/" + fname + "}")
            out.append("\\caption{" + _inline_refs(_esc_text(b.get("caption", ""))) + "}")
            out.append("\\label{fig:" + b["id"] + "}")
            out.append("\\end{figure}")
        elif t == "table":
            rows = b.get("rows") or []
            if not rows:
                continue
            ncol = max(len(r) for r in rows)
            out.append("\\begin{table}[h]")
            out.append("\\centering")
            out.append("\\begin{tabular}{" + "c" * ncol + "}")
            out.append("\\toprule")
            head = b.get("header")
            if head:
                out.append(" & ".join(_cell_latex(x) for x in head) + " \\\\")
                out.append("\\midrule")
            for r in rows:
                out.append(" & ".join(_cell_latex(x) for x in (list(r) + [""] * ncol)[:ncol]) + " \\\\")
            out.append("\\bottomrule")
            out.append("\\end{tabular}")
            out.append("\\caption{" + _inline_refs(_esc_text(b.get("caption", ""))) + "}")
            out.append("\\label{tab:" + b["id"] + "}")
            out.append("\\end{table}")
    out.append("\\end{document}")
    return "\n".join(x for x in out if x is not None)
