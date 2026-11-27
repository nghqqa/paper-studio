# -*- coding: utf-8 -*-
"""LaTeX 工程投稿前检查（只读 MVP）：基于当前工程源文件做确定性规则检查。
（时间戳与项目元数据由路由层附上，本模块只产报告体。）

规则集：
- latex-general/1：待办/高亮残留（TODO/FIXME/\\hl/??）、未定义 \\cite/\\ref（基于工程源码
  索引——\\label/\\bibitem/bib 条目键对账；单行扫描，跨行键列表是已知边界）、
  未解决的手动 Issue（issues.jsonl）；
- double-blind/1：扫描**非注释行**中的 \\author{...}/\\thanks{...}/\\affiliation/
  Acknowledgments 结构标记、资助基金关键词与屏蔽词（请求 blind_terms 或项目设置）；
  被 % 注释掉的行明确跳过不误报（\\% 为转义百分号，不算注释起点）。

红线（继承 docs/preflight-jcip-mvp.md）：只读，不修改任何源文件；无屏蔽词/无源文件时
对应条目一律 unknown（绝不假 pass）；不设模板未明示的阈值类规则，不调用外部 AI。
报告绑定被扫描文件的内容哈希（digest/digest_sha），源文件变化后如实 expired。
"""
import hashlib
import os
import re

from app.domain import latex_build, latex_issues

DEFAULT_RULESET = "latex-general"

# 与 word_preflight._FUNDING_RE 同口径：基金/资助表述（命中即 warn 供人工复核）
_FUNDING_RE = re.compile(
    r"(?i)基金项目|基金资助|国家自然科学|grant\s*no|funded\s+by|funding|foundation")

# latex-general 待办/高亮残留：TODO/FIXME（区分大小写）、soul 包高亮 \hl{、连续问号
_RESIDUE_RE = re.compile(r"TODO|FIXME|\\hl\s*\{|\?{2,}")

_LABEL_RE = re.compile(r"\\label\{([^}]+)\}")
_BIBITEM_RE = re.compile(r"\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}")
_BIB_ENTRY_RE = re.compile(r"@(\w+)\s*\{\s*([^,\s{}]+)\s*,")
_CITE_CMD_RE = re.compile(
    r"\\(?:cite|citep|citet|citealp|citealt|citeauthor|citeyear|parencite|textcite|footcite|autocite|nocite)\*?"
    r"(?:\[[^\]]*\]){0,2}\{([^}]*)\}")
_REF_CMD_RE = re.compile(r"\\(?:ref|eqref|pageref|autoref|cref|Cref|vref|Vref)\*?\{([^}]*)\}")

# 双盲结构标记：作者块/致谢（非注释行命中即 warn——送审稿通常应匿名化或删除）
_AUTHOR_RE = re.compile(r"\\author\s*\{([^}]*)\}")
_THANKS_RE = re.compile(r"\\thanks\s*\{")
_AFFIL_RE = re.compile(r"\\affil(?:iation)?\s*[\[{]")
_ACK_RE = re.compile(r"(?i)acknowledg")

_SRC_GENERAL_RESIDUE = "通用投稿规范（模板未明示）：定稿源码不应残留 TODO/FIXME/\\hl/?? 等待办与未解析标记"
_SRC_GENERAL_REFS = "通用投稿规范（模板未明示）：\\cite/\\ref 键应在工程源码（\\label/\\bibitem/bib 条目）中有定义——单行扫描，跨行键列表不在覆盖范围"
_SRC_GENERAL_ISSUES = "通用投稿规范（模板未明示）：投稿前应解决工程内全部手动 Issue（issues.jsonl）"
_SRC_BLIND = "通用双盲评审规范（模板未明示）：送审稿源码不应残留作者/单位身份或资助信息；% 注释行已跳过"

_LATEX_GENERAL_RULE_IDS = (
    "latex-todo-residue",
    "latex-undefined-refs",
    "latex-open-issues",
    "latex-unused-figures",
    "latex-acronym-consistency",
    "latex-glossary-consistency",
)
_LATEX_BLIND_RULE_IDS = ("blind-author-block", "blind-author-terms", "blind-funding-terms")
_SUBMISSION_READINESS_RULE_IDS = (
    "sub-pdf-pages",
    "sub-bbl-ready",
    "sub-unused-figures",
    "sub-uncited-bib",
    "sub-acronym-consistency",
    "sub-glossary-consistency",
)

RULESETS: dict[str, dict] = {
    "latex-general": {
        "version": "1",
        "run": "run_latex_general",
        "title": "通用学术投稿检查",
        "scope": (".tex", ".bib"),  # 报告 digest 与过期判定同口径（引用对账含 .bib）
    },
    "double-blind": {
        "version": "1",
        "run": "run_latex_double_blind",
        "title": "双盲匿名审查",
        "scope": (".tex",),  # .bib 条目是他引作者名单，不参与匿名扫描，也不绑定过期
    },
    "submission-readiness": {
        "version": "1",
        "run": "run_submission_readiness",
        "title": "投稿就绪度体检",
        "scope": (".tex", ".bib"),
    },
}

_SRC_UNUSED_FIG = "源码 \\includegraphics 与浮动体 \\label{fig:/tab:}"
_SRC_ACRONYM = "缩略语展开与连字符拼写一致性"
_SRC_GLOSSARY = "项目术语表（glossary.json）启用条目一致性"
_SRC_SUBMISSION = "最新编译 PDF/.bbl 与源码投稿就绪检查"

_COMMON_ACRONYMS = frozenset({
    "CPU", "GPU", "TPU", "RAM", "ROM", "API", "SDK", "CLI", "GUI", "URL", "URI", "HTTP", "HTTPS",
    "JSON", "YAML", "HTML", "XML", "PDF", "PNG", "JPEG", "JPG", "SVG", "EPS", "CSV", "SQL",
    "UTF", "ASCII", "IEEE", "ACM", "NIST", "ISO", "MIT", "BSD", "GPL", "RGB", "RGBA", "FPS",
    "RMSE", "MSE", "MAE", "AUC", "ROC", "SGD", "CNN", "RNN", "LSTM", "GRU", "MLP", "GAN", "VAE",
    "LLM", "LLMS", "NLP", "NLU", "NLG", "BLEU", "ROUGE", "SOTA", "BERT", "GPT", "TODO", "FIXME",
    "DNA", "RNA", "MRI", "USA", "EOF", "DOI", "ISSN", "ISBN", "TEX", "BIB", "END", "TAB", "FIG",
})
_STRIP_CMD_ARG_RE = re.compile(
    r"\\(?:documentclass|usepackage|bibliographystyle|bibliography|addbibresource|"
    r"label|ref|eqref|autoref|cref|Cref|pageref|nameref|figref|tabref|"
    r"[a-zA-Z]*cite[a-zA-Z]*|nocite|includegraphics|includesvg|overpic|"
    r"input|include|begin|end|url|href|newcommand|renewcommand|newacronym|acro)"
    r"\*?(?:\s*\[[^\]]*\])*(?:\s*\{[^{}]*\})+"
)
_INLINE_MATH_RE = re.compile(r"\$\$[\s\S]*?\$\$|\$[^$]*\$|\\\[[\s\S]*?\\\]|\\\([^)]*\\\)")
_HYPHEN_PAIR_RE = re.compile(r"\b([A-Za-z]{3,})-([A-Za-z]{3,})\b")
_BIB_ENTRY_KEY_RE = re.compile(r"^\s*@\s*(?!comment\b|string\b|preamble\b)[A-Za-z]+\s*[({]\s*([^,\s]+)\s*,", re.MULTILINE)
_ANY_CITE_KEYS_RE = re.compile(r"\\(?:[a-zA-Z]*cite[a-zA-Z]*|nocite)\*?(?:\s*\[[^\]]*\])*\s*\{([^}]+)\}")


def _dedup_locations(locs: list[dict], limit: int = 10) -> list[dict]:
    seen: set[tuple[str, int | None, str]] = set()
    out: list[dict] = []
    for loc in locs:
        f = str(loc.get("file") or "")
        ln = loc.get("line")
        lbl = str(loc.get("label") or "")
        key = (f, int(ln) if ln is not None else None, lbl)
        if not f or key in seen:
            continue
        seen.add(key)
        entry: dict = {"file": f, "line": int(ln) if ln is not None else None}
        if lbl:
            entry["label"] = lbl
        out.append(entry)
        if len(out) >= limit:
            break
    return out


def _check_unused_figures(project, lines: dict[str, list[tuple[int, str]]], rule_id: str = "latex-unused-figures") -> dict:
    from app.domain import latex_submission

    tex_map = {rel: "\n".join(code for _ln, code in rows) for rel, rows in lines.items() if rel.lower().endswith(".tex")}
    all_rels = {item["path"] for item in latex_build.list_source_files(project)}
    media_rels = sorted(r for r in all_rels if os.path.splitext(r)[1].lower() in latex_submission.MEDIA_EXTS)
    used_media = latex_submission.find_referenced_media_in_texts(tex_map, all_rels)
    unused_media = [r for r in media_rels if r not in used_media]

    float_labels: dict[str, tuple[str, int]] = {}
    referenced_labels: set[str] = set()
    ref_re = re.compile(r"\\(?:[Cc]?ref|eqref|autoref|pageref|nameref|figref|tabref)\s*\{([^}]+)\}")
    lbl_re = re.compile(r"\\label\s*\{((?:fig|figure|tab|table):[^}]+)\}")
    for rel, rows in lines.items():
        if not rel.lower().endswith(".tex"):
            continue
        for lineno, code in rows:
            for lm in lbl_re.finditer(code):
                float_labels.setdefault(lm.group(1).strip(), (rel, lineno))
            for rm in ref_re.finditer(code):
                for part in rm.group(1).split(","):
                    if k := part.strip():
                        referenced_labels.add(k)
    unused_labels = sorted(lbl for lbl in float_labels if lbl not in referenced_labels)

    issues: list[str] = []
    locs: list[dict] = []
    if unused_media:
        issues.append(f"未引用的图片文件（{len(unused_media)}）：" + "、".join(unused_media[:3]))
        for r in unused_media:
            locs.append({"file": r, "line": None, "label": f"未引用图片 {os.path.basename(r)}"})
    if unused_labels:
        sample = [f"{lbl} ({float_labels[lbl][0]}:{float_labels[lbl][1]})" for lbl in unused_labels[:3]]
        issues.append(f"未在正文引用的图表标签（{len(unused_labels)}）：" + "、".join(sample))
        for lbl in unused_labels:
            locs.append({"file": float_labels[lbl][0], "line": float_labels[lbl][1], "label": lbl})
    item: dict = {
        "rule_id": rule_id,
        "status": "warn" if issues else "pass",
        "evidence": "；".join(issues) if issues else "工程图片文件与图表标签均已在正文引用",
        "source": _SRC_UNUSED_FIG,
    }
    if locs:
        item["locations"] = _dedup_locations(locs)
    return item


def _check_acronyms_and_consistency(lines: dict[str, list[tuple[int, str]]], rule_id: str = "latex-acronym-consistency") -> dict:
    prose_chunks: list[str] = []
    body_rows: list[tuple[str, int, str]] = []
    for rel, rows in lines.items():
        if not rel.lower().endswith(".tex"):
            continue
        raw_tex = "\n".join(code for _ln, code in rows)
        has_begin_doc = "\\begin{document}" in raw_tex
        in_body = not has_begin_doc
        for lineno, code in rows:
            if not in_body:
                if "\\begin{document}" in code:
                    in_body = True
                    tail = code.split("\\begin{document}", 1)[1]
                    if tail.strip():
                        cleaned_row = re.sub(r"\\[A-Za-z@]+\*?", " ", _INLINE_MATH_RE.sub(" ", _STRIP_CMD_ARG_RE.sub(" ", tail)))
                        body_rows.append((rel, lineno, cleaned_row))
                continue
            cleaned_row = re.sub(r"\\[A-Za-z@]+\*?", " ", _INLINE_MATH_RE.sub(" ", _STRIP_CMD_ARG_RE.sub(" ", code)))
            body_rows.append((rel, lineno, cleaned_row))
        if has_begin_doc:
            raw_tex = raw_tex.split("\\begin{document}", 1)[1]
        cleaned = _STRIP_CMD_ARG_RE.sub(" ", raw_tex)
        cleaned = _INLINE_MATH_RE.sub(" ", cleaned)
        cleaned = re.sub(r"\\[A-Za-z@]+\*?", " ", cleaned)
        prose_chunks.append(cleaned)
    prose = "\n".join(prose_chunks)

    defined_acros: set[str] = set()
    for m in re.finditer(r"\(([A-Z]{3,6})\)|\b([A-Z]{3,6})\s*\([^)]{4,80}\)", prose):
        defined_acros.add(m.group(1) or m.group(2))
    for rel, rows in lines.items():
        if rel.lower().endswith(".tex"):
            full = "\n".join(c for _l, c in rows)
            for am in re.finditer(r"\\(?:newacronym|acro)\s*\{[^}]*\}\s*\{([A-Z]{3,6})\}", full):
                defined_acros.add(am.group(1))

    acro_counts: dict[str, int] = {}
    for am in re.finditer(r"\b([A-Z]{3,6})\b", prose):
        tok = am.group(1)
        if tok in _COMMON_ACRONYMS or tok in defined_acros:
            continue
        acro_counts[tok] = acro_counts.get(tok, 0) + 1
    undefined_repeats = sorted(k for k, cnt in acro_counts.items() if cnt >= 2)

    hyphen_hits: list[str] = []
    hyphen_pairs: list[tuple[str, str]] = []
    seen_pairs: set[tuple[str, str]] = set()
    for hm in _HYPHEN_PAIR_RE.finditer(prose):
        a, b = hm.group(1), hm.group(2)
        pair = (a.lower(), b.lower())
        if pair in seen_pairs:
            continue
        seen_pairs.add(pair)
        alt_space = re.search(rf"\b{re.escape(a)}\s+{re.escape(b)}\b", prose, re.IGNORECASE)
        alt_joined = re.search(rf"\b{re.escape(a)}{re.escape(b)}\b", prose, re.IGNORECASE)
        if alt_space:
            hyphen_hits.append(f"{a}-{b} / {alt_space.group(0)}")
            hyphen_pairs.append((a, b))
        elif alt_joined:
            hyphen_hits.append(f"{a}-{b} / {alt_joined.group(0)}")
            hyphen_pairs.append((a, b))

    locs: list[dict] = []
    for tok in undefined_repeats:
        pat = re.compile(rf"\b{re.escape(tok)}\b")
        for rel, lineno, cleaned_row in body_rows:
            if pat.search(cleaned_row):
                locs.append({"file": rel, "line": lineno, "label": tok})
                break
    for a, b in hyphen_pairs:
        pat = re.compile(rf"\b{re.escape(a)}-{re.escape(b)}\b", re.IGNORECASE)
        for rel, lineno, cleaned_row in body_rows:
            if pat.search(cleaned_row):
                locs.append({"file": rel, "line": lineno, "label": f"{a}-{b}"})
                break

    warnings: list[str] = []
    if undefined_repeats:
        warnings.append("疑似未展开的大写缩略语：" + "、".join(undefined_repeats[:4]))
    if hyphen_hits:
        warnings.append("复合词连字符写法不统一：" + "；".join(hyphen_hits[:3]))
    item: dict = {
        "rule_id": rule_id,
        "status": "warn" if warnings else "pass",
        "evidence": "；".join(warnings) if warnings else "缩略语展开与复合词连字符写法一致",
        "source": _SRC_ACRONYM,
    }
    if locs:
        item["locations"] = _dedup_locations(locs)
    return item


def _check_glossary_consistency(project, lines: dict[str, list[tuple[int, str]]], rule_id: str) -> dict:
    from app.domain import glossary

    entries = [e for e in glossary.list_entries(project.dir) if e.get("enforce") and e.get("aliases")]
    if not entries:
        return {
            "rule_id": rule_id,
            "status": "pass",
            "evidence": "未配置需强制核对别名的术语条目",
            "source": _SRC_GLOSSARY,
        }
    hits: list[str] = []
    locs: list[dict] = []
    for entry in entries:
        term = str(entry.get("term") or "")
        for alias in entry.get("aliases") or []:
            alias = str(alias).strip()
            if not alias:
                continue
            pat = re.compile(rf"\b{re.escape(alias)}\b") if alias.isascii() else re.compile(re.escape(alias))
            for rel, rows in lines.items():
                if not rel.lower().endswith(".tex"):
                    continue
                for lineno, code in rows:
                    if pat.search(code):
                        hits.append(f"{rel}:{lineno}「{alias}」建议统一为「{term}」")
                        locs.append({"file": rel, "line": lineno, "label": f"{alias} → {term}"})
                        break
    item: dict = {
        "rule_id": rule_id,
        "status": "warn" if hits else "pass",
        "evidence": ("命中术语表弃用别名：" + "；".join(hits[:4])) if hits else f"已核对 {len(entries)} 条术语规范，未命中弃用别名",
        "source": _SRC_GLOSSARY,
    }
    if locs:
        item["locations"] = _dedup_locations(locs)
    return item


def resolve_ruleset(ruleset: str | None) -> tuple[str, dict]:
    """规则集名（None=默认 latex-general）→ (id, entry)；未知名称抛 ValueError（路由转 422）。"""
    rid = (ruleset or "").strip() or DEFAULT_RULESET
    entry = RULESETS.get(rid)
    if entry is None:
        raise ValueError(f"未知规则集：{ruleset}（允许：{'、'.join(RULESETS)}）")
    return rid, entry


def strip_comment(line: str) -> str:
    """剥离 % 行注释：\\% 是转义百分号（不算注释起点），\\\\ 后的 % 仍是注释。
    与 TeX 常见语义一致的确定性近似（verbatim 环境内 % 不在覆盖范围）。"""
    out: list[str] = []
    i = 0
    while i < len(line):
        ch = line[i]
        if ch == "\\" and i + 1 < len(line):
            out.append(line[i:i + 2])
            i += 2
            continue
        if ch == "%":
            break
        out.append(ch)
        i += 1
    return "".join(out)


def _scan_files(project, exts: tuple[str, ...]) -> tuple[dict[str, str], dict[str, list[tuple[int, str]]], str | None]:
    """读取工程内指定扩展名的源文件。返回 (digest{rel:sha}, lines{rel:[(lineno, 去注释行)]}, error)。
    error 非空 = 有文件读取/解码异常（调用方把相关条目降为 unknown）。"""
    digest: dict[str, str] = {}
    lines: dict[str, list[tuple[int, str]]] = {}
    error = None
    root = latex_build.source_root(project)
    for item in latex_build.list_source_files(project):
        rel = item["path"]
        if os.path.splitext(rel)[1].lower() not in exts:
            continue
        p = os.path.join(root, rel)
        try:
            with open(p, "rb") as f:
                raw = f.read()
        except OSError as e:
            error = f"读取 {rel} 失败：{e}"
            continue
        digest[rel] = hashlib.sha256(raw).hexdigest()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("utf-8", "replace")
            error = error or f"文件 {rel} 不是合法 UTF-8（按替换字符扫描）"
        lines[rel] = [(i, strip_comment(ln)) for i, ln in enumerate(text.splitlines(), 1)]
    return digest, lines, error


def digest_fingerprint(digest: dict[str, str]) -> str:
    """逐文件 sha256 → 单一指纹（路径+哈希拼接再哈希；文件集或任一内容变化即变）。"""
    h = hashlib.sha256()
    for path in sorted(digest):
        h.update(path.encode("utf-8"))
        h.update(b"\x00")
        h.update(digest[path].encode("ascii"))
        h.update(b"\n")
    return h.hexdigest()


def _unknown_items(rule_ids, source: str, parse_error: str) -> list[dict]:
    return [{"rule_id": rid, "status": "unknown",
             "evidence": f"无法检查：{parse_error}", "source": source}
            for rid in rule_ids]


def _body(digest: dict[str, str], items: list[dict], parse_error: str | None) -> dict:
    out: dict = {"digest": digest, "digest_sha": digest_fingerprint(digest), "items": items}
    if parse_error:
        out["parse_error"] = parse_error
    return out


def run_checks(project, ruleset_id: str | None = None, blind_terms=()) -> dict:
    """按规则集执行只读检查。返回报告体（digest/digest_sha/items[/parse_error]）。
    检查函数按**模块属性名**解析——与 word_preflight 同款，测试 monkeypatch 不被绕过。"""
    rid, entry = resolve_ruleset(ruleset_id)
    fn = globals()[entry["run"]]
    return fn(project, tuple(blind_terms))


def run_latex_general(project, blind_terms=()) -> dict:
    """latex-general/1：残留 / 未定义引用 / 未解决 Issue。扫描全部 .tex+.bib。"""
    del blind_terms
    digest, lines, error = _scan_files(project, (".tex", ".bib"))
    if not digest:
        parse_error = error or "工程内没有可扫描的 .tex/.bib 文件"
        return _body({}, _unknown_items(_LATEX_GENERAL_RULE_IDS, "latex-general/1", parse_error),
                     parse_error)
    items: list[dict] = []

    # --- 待办/高亮残留（非注释行） ---
    hits = []
    todo_locs: list[dict] = []
    for rel, rows in lines.items():
        for lineno, code in rows:
            m = _RESIDUE_RE.search(code)
            if m:
                frag = code[max(0, m.start() - 10):m.start() + 34].strip()
                hits.append(f"{rel}:{lineno}「…{frag}…」")
                todo_locs.append({"file": rel, "line": lineno, "label": m.group(0).strip()[:32]})
    todo_item: dict = {
        "rule_id": "latex-todo-residue",
        "status": "pass" if not hits else "warn",
        "evidence": ("残留待办/未解析标记：" + "；".join(hits[:4])) if hits
        else "非注释行未发现 TODO/FIXME/\\hl/?? 残留",
        "source": _SRC_GENERAL_RESIDUE,
    }
    if todo_locs:
        todo_item["locations"] = _dedup_locations(todo_locs)
    items.append(todo_item)

    # --- 未定义 \cite/\ref（工程源码索引对账） ---
    try:
        defined: set[str] = set()
        used_cite: list[tuple[str, int, str]] = []
        used_ref: list[tuple[str, int, str]] = []
        for rel, rows in lines.items():
            is_bib = rel.lower().endswith(".bib")
            for lineno, code in rows:
                if not code.strip():
                    continue
                for m in _LABEL_RE.finditer(code):
                    defined.add(m.group(1).strip())
                for m in _BIBITEM_RE.finditer(code):
                    defined.add(m.group(1).strip())
                if is_bib:
                    for m in _BIB_ENTRY_RE.finditer(code):
                        defined.add(m.group(2).strip())
                for m in _CITE_CMD_RE.finditer(code):
                    for key in m.group(1).split(","):
                        key = key.strip()
                        if key and key != "*":  # \nocite{*} 是"全引"，不参与对账
                            used_cite.append((rel, lineno, key))
                for m in _REF_CMD_RE.finditer(code):
                    for key in m.group(1).split(","):
                        key = key.strip()
                        if key:
                            used_ref.append((rel, lineno, key))
        missing = []
        ref_locs: list[dict] = []
        seen: set[str] = set()
        for rel, lineno, key in used_cite + used_ref:
            if key not in defined and key not in seen:
                seen.add(key)
                missing.append(f"{key}（{rel}:{lineno}）")
                ref_locs.append({"file": rel, "line": lineno, "label": key})
        ref_item: dict = {
            "rule_id": "latex-undefined-refs",
            "status": "warn" if missing else "pass",
            "evidence": ("存在未定义引用键：" + "；".join(missing[:8])) if missing
            else f"引用/标签对账一致：\\cite {len(used_cite)} 处、\\ref {len(used_ref)} 处、定义键 {len(defined)} 个",
            "source": _SRC_GENERAL_REFS,
        }
        if ref_locs:
            ref_item["locations"] = _dedup_locations(ref_locs)
        items.append(ref_item)
    except Exception as e:  # noqa: BLE001 — 子检查失败→该条 unknown，不连坐全报告
        items.append({"rule_id": "latex-undefined-refs", "status": "unknown",
                      "evidence": f"引用对账检查异常：{e}", "source": _SRC_GENERAL_REFS})

    # --- 未解决的手动 Issue ---
    try:
        issues = latex_issues.list_issues(project)
        open_issues = [r for r in issues if r.get("status") != "resolved"]
        issue_locs = [
            {"file": r["file"], "line": r.get("line"), "label": (r.get("message") or "未解决 Issue")[:32]}
            for r in open_issues if r.get("file")
        ]
        issue_item: dict = {
            "rule_id": "latex-open-issues",
            "status": "warn" if open_issues else "pass",
            "evidence": ("存在未解决的手动 Issue：" + "；".join(
                (r.get("message") or "")[:60] for r in open_issues[:3])
                + (f" 等共 {len(open_issues)} 条" if len(open_issues) > 3 else ""))
            if open_issues else "无未解决的手动 Issue",
            "source": _SRC_GENERAL_ISSUES,
        }
        if issue_locs:
            issue_item["locations"] = _dedup_locations(issue_locs)
        items.append(issue_item)
    except Exception as e:  # noqa: BLE001
        items.append({"rule_id": "latex-open-issues", "status": "unknown",
                      "evidence": f"Issue 读取异常：{e}", "source": _SRC_GENERAL_ISSUES})

    try:
        items.append(_check_unused_figures(project, lines, "latex-unused-figures"))
    except Exception as e:  # noqa: BLE001
        items.append({"rule_id": "latex-unused-figures", "status": "unknown",
                      "evidence": f"图片引用核对异常：{e}", "source": _SRC_UNUSED_FIG})

    items.append(_check_acronyms_and_consistency(lines, "latex-acronym-consistency"))
    items.append(_check_glossary_consistency(project, lines, "latex-glossary-consistency"))
    return _body(digest, items, error)


def run_latex_double_blind(project, blind_terms=()) -> dict:
    """double-blind/1：非注释行扫描作者块结构标记、资助基金词与屏蔽词（仅 .tex；
    .bib 文献表条目是他引作者名单，不参与匿名扫描）。"""
    terms = [str(t).strip() for t in (blind_terms or ()) if str(t).strip()][:50]
    digest, lines, error = _scan_files(project, (".tex",))
    if not digest:
        parse_error = error or "工程内没有可扫描的 .tex 文件"
        return _body({}, _unknown_items(_LATEX_BLIND_RULE_IDS, "double-blind/1", parse_error),
                     parse_error)
    items: list[dict] = []

    # --- 作者块结构标记（\author 非空内容 / \thanks / \affiliation / Acknowledgments） ---
    hits = []
    block_locs: list[dict] = []
    for rel, rows in lines.items():
        for lineno, code in rows:
            m = _AUTHOR_RE.search(code)
            if m and m.group(1).strip():
                hits.append(f"{rel}:{lineno} \\author{{…{m.group(1).strip()[:24]}…}}")
                block_locs.append({"file": rel, "line": lineno, "label": "\\author"})
            if _THANKS_RE.search(code):
                hits.append(f"{rel}:{lineno} \\thanks{{…}}")
                block_locs.append({"file": rel, "line": lineno, "label": "\\thanks"})
            if _AFFIL_RE.search(code):
                hits.append(f"{rel}:{lineno} \\affil/\\affiliation")
                block_locs.append({"file": rel, "line": lineno, "label": "\\affiliation"})
            if _ACK_RE.search(code):
                hits.append(f"{rel}:{lineno} Acknowledgments（致谢）")
                block_locs.append({"file": rel, "line": lineno, "label": "Acknowledgments"})
    block_item: dict = {
        "rule_id": "blind-author-block",
        "status": "warn" if hits else "pass",
        "evidence": ("命中作者块/致谢结构标记：" + "；".join(hits[:4])) if hits
        else "非注释行未发现 \\author/\\thanks/\\affiliation/Acknowledgments 标记",
        "source": _SRC_BLIND,
    }
    if block_locs:
        block_item["locations"] = _dedup_locations(block_locs)
    items.append(block_item)

    # --- 屏蔽词（无词 → unknown，绝不假 pass） ---
    if not terms:
        items.append({
            "rule_id": "blind-author-terms", "status": "unknown",
            "evidence": "未配置作者/单位屏蔽词（可在请求 blind_terms 或项目设置 studio.json 的 "
                        "blind_terms 配置），无法核对源码身份残留；结构标记与基金词仍已检查",
            "source": _SRC_BLIND,
        })
    else:
        hits = []
        term_locs: list[dict] = []
        for rel, rows in lines.items():
            for lineno, code in rows:
                for term in terms:
                    idx = code.lower().find(term.lower())
                    if idx >= 0:
                        hits.append(f"{rel}:{lineno}「{term}」…{code[max(0, idx - 6):idx + 30].strip()}…")
                        term_locs.append({"file": rel, "line": lineno, "label": term[:32]})
        term_item: dict = {
            "rule_id": "blind-author-terms",
            "status": "warn" if hits else "pass",
            "evidence": ("命中屏蔽词：" + "；".join(hits[:3])) if hits
            else f".tex 非注释行未命中屏蔽词（{len(terms)} 词）",
            "source": _SRC_BLIND,
        }
        if term_locs:
            term_item["locations"] = _dedup_locations(term_locs)
        items.append(term_item)

    # --- 资助基金关键词 ---
    hits = []
    fund_locs: list[dict] = []
    for rel, rows in lines.items():
        for lineno, code in rows:
            m = _FUNDING_RE.search(code)
            if m:
                hits.append(f"{rel}:{lineno}「…{code[max(0, m.start() - 8):m.start() + 30].strip()}…」")
                fund_locs.append({"file": rel, "line": lineno, "label": m.group(0).strip()[:32]})
    fund_item: dict = {
        "rule_id": "blind-funding-terms",
        "status": "warn" if hits else "pass",
        "evidence": ("命中资助/基金表述：" + "；".join(hits[:3])) if hits
        else "非注释行未发现基金或资助表述",
        "source": _SRC_BLIND,
    }
    if fund_locs:
        fund_item["locations"] = _dedup_locations(fund_locs)
    items.append(fund_item)

    return _body(digest, items, error)


def run_submission_readiness(project, blind_terms=()) -> dict:
    """submission-readiness/1：PDF 页数、.bbl 就绪度、未使用图片、未引用文献与术语一致性。"""
    del blind_terms
    from pypdf import PdfReader

    from app.domain import latex_submission

    digest, lines, error = _scan_files(project, RULESETS["submission-readiness"]["scope"])
    if error is not None:
        return _body({}, _unknown_items(_SUBMISSION_READINESS_RULE_IDS, "submission-readiness/1", error), error)

    items: list[dict] = []
    latest = latex_build.latest_build(project, ok_only=True)
    if not latest:
        items.append({
            "rule_id": "sub-pdf-pages",
            "status": "warn",
            "evidence": "尚未有成功编译的 PDF，无法核对最终页数与提交产物",
            "source": _SRC_SUBMISSION,
        })
    else:
        bdir = os.path.join(latex_build.builds_dir(project), latest["build_id"])
        pdf_path, _gz = latex_build._build_artifact_pair(bdir, latest["main"])
        if not pdf_path or not os.path.isfile(pdf_path):
            items.append({
                "rule_id": "sub-pdf-pages",
                "status": "warn",
                "evidence": "最近一次编译缺少 PDF 输出文件",
                "source": _SRC_SUBMISSION,
            })
        else:
            try:
                pages = len(PdfReader(pdf_path).pages)
            except Exception:  # noqa: BLE001
                pages = None
            cur_digest = latex_build.digest_source(project)
            stale = bool(latest.get("digest")) and cur_digest != latest.get("digest")
            page_txt = f"{pages} 页" if pages is not None else "页数未知"
            if stale:
                items.append({
                    "rule_id": "sub-pdf-pages",
                    "status": "warn",
                    "evidence": f"最近编译 PDF 共 {page_txt}，但源码在编译后发生过修改（建议重新编译）",
                    "source": _SRC_SUBMISSION,
                })
            else:
                items.append({
                    "rule_id": "sub-pdf-pages",
                    "status": "pass",
                    "evidence": f"最新编译 PDF 共 {page_txt}，与当前源码完全一致",
                    "source": _SRC_SUBMISSION,
                })

    bbl = latex_submission.latest_build_bbl(project)
    tex_full = "\n".join("\n".join(c for _l, c in rows) for rel, rows in lines.items() if rel.lower().endswith(".tex"))
    needs_bbl = bool(re.search(r"\\(?:bibliography|addbibresource)\b|\\(?:[a-zA-Z]*cite[a-zA-Z]*)\b", tex_full))
    if bbl is not None:
        items.append({
            "rule_id": "sub-bbl-ready",
            "status": "pass",
            "evidence": f"已就绪编译产物 {bbl[0]}（{len(bbl[1])} 字节），可直接用于 arXiv/期刊源码打包",
            "source": _SRC_SUBMISSION,
        })
    elif not needs_bbl:
        items.append({
            "rule_id": "sub-bbl-ready",
            "status": "pass",
            "evidence": "当前工程未声明外部书目命令，无需附加 .bbl",
            "source": _SRC_SUBMISSION,
        })
    else:
        items.append({
            "rule_id": "sub-bbl-ready",
            "status": "warn",
            "evidence": "正文包含参考文献引用但最近编译目录缺少 .bbl，投稿打包前建议先完整编译",
            "source": _SRC_SUBMISSION,
        })

    items.append(_check_unused_figures(project, lines, "sub-unused-figures"))

    defined_bib: list[str] = []
    bib_locs: dict[str, tuple[str, int]] = {}
    for rel, rows in lines.items():
        if not rel.lower().endswith(".bib"):
            continue
        for lineno, code in rows:
            for km in _BIB_ENTRY_KEY_RE.finditer(code):
                k = km.group(1).strip()
                if k:
                    bib_locs.setdefault(k, (rel, lineno))
        bib_txt = "\n".join(c for _l, c in rows)
        for km in _BIB_ENTRY_KEY_RE.finditer(bib_txt):
            k = km.group(1).strip()
            if k and k not in defined_bib:
                defined_bib.append(k)
    cited_keys: set[str] = set()
    for cm in _ANY_CITE_KEYS_RE.finditer(tex_full):
        for part in cm.group(1).split(","):
            if pk := part.strip():
                cited_keys.add(pk)
    if "*" in cited_keys:
        uncited = []
    else:
        uncited = [k for k in defined_bib if k not in cited_keys]
    if not defined_bib:
        items.append({
            "rule_id": "sub-uncited-bib",
            "status": "pass",
            "evidence": "未检测到 .bib 条目定义",
            "source": _SRC_SUBMISSION,
        })
    elif uncited:
        uncited_locs = [
            {"file": bib_locs[k][0], "line": bib_locs[k][1], "label": k}
            for k in uncited if k in bib_locs
        ]
        sub_bib_item: dict = {
            "rule_id": "sub-uncited-bib",
            "status": "warn",
            "evidence": f"共有 {len(uncited)} 条 .bib 文献未在正文引用：" + "、".join(uncited[:5]),
            "source": _SRC_SUBMISSION,
        }
        if uncited_locs:
            sub_bib_item["locations"] = _dedup_locations(uncited_locs)
        items.append(sub_bib_item)
    else:
        items.append({
            "rule_id": "sub-uncited-bib",
            "status": "pass",
            "evidence": f".bib 全部 {len(defined_bib)} 条文献均已在正文引用",
            "source": _SRC_SUBMISSION,
        })

    items.append(_check_acronyms_and_consistency(lines, "sub-acronym-consistency"))
    items.append(_check_glossary_consistency(project, lines, "sub-glossary-consistency"))

    return _body(digest, items, error)
