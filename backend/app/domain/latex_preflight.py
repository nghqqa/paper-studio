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

_LATEX_GENERAL_RULE_IDS = ("latex-todo-residue", "latex-undefined-refs", "latex-open-issues")
_LATEX_BLIND_RULE_IDS = ("blind-author-block", "blind-author-terms", "blind-funding-terms")

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
}


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
    for rel, rows in lines.items():
        for lineno, code in rows:
            m = _RESIDUE_RE.search(code)
            if m:
                frag = code[max(0, m.start() - 10):m.start() + 34].strip()
                hits.append(f"{rel}:{lineno}「…{frag}…」")
    items.append({
        "rule_id": "latex-todo-residue",
        "status": "pass" if not hits else "warn",
        "evidence": ("残留待办/未解析标记：" + "；".join(hits[:4])) if hits
        else "非注释行未发现 TODO/FIXME/\\hl/?? 残留",
        "source": _SRC_GENERAL_RESIDUE,
    })

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
        for rel, lineno, key in used_cite + used_ref:
            if key not in defined:
                missing.append(f"{key}（{rel}:{lineno}）")
        # 按键去重（同一键多处引用只报首处），最多列 8 个
        seen: set[str] = set()
        uniq = [x for x in missing if not (x.split("（")[0] in seen or seen.add(x.split("（")[0]))]
        items.append({
            "rule_id": "latex-undefined-refs",
            "status": "warn" if uniq else "pass",
            "evidence": ("存在未定义引用键：" + "；".join(uniq[:8])) if uniq
            else f"引用/标签对账一致：\\cite {len(used_cite)} 处、\\ref {len(used_ref)} 处、定义键 {len(defined)} 个",
            "source": _SRC_GENERAL_REFS,
        })
    except Exception as e:  # noqa: BLE001 — 子检查失败→该条 unknown，不连坐全报告
        items.append({"rule_id": "latex-undefined-refs", "status": "unknown",
                      "evidence": f"引用对账检查异常：{e}", "source": _SRC_GENERAL_REFS})

    # --- 未解决的手动 Issue ---
    try:
        issues = latex_issues.list_issues(project)
        open_issues = [r for r in issues if r.get("status") != "resolved"]
        items.append({
            "rule_id": "latex-open-issues",
            "status": "warn" if open_issues else "pass",
            "evidence": ("存在未解决的手动 Issue：" + "；".join(
                (r.get("message") or "")[:60] for r in open_issues[:3])
                + (f" 等共 {len(open_issues)} 条" if len(open_issues) > 3 else ""))
            if open_issues else "无未解决的手动 Issue",
            "source": _SRC_GENERAL_ISSUES,
        })
    except Exception as e:  # noqa: BLE001
        items.append({"rule_id": "latex-open-issues", "status": "unknown",
                      "evidence": f"Issue 读取异常：{e}", "source": _SRC_GENERAL_ISSUES})

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
    for rel, rows in lines.items():
        for lineno, code in rows:
            m = _AUTHOR_RE.search(code)
            if m and m.group(1).strip():
                hits.append(f"{rel}:{lineno} \\author{{…{m.group(1).strip()[:24]}…}}")
            if _THANKS_RE.search(code):
                hits.append(f"{rel}:{lineno} \\thanks{{…}}")
            if _AFFIL_RE.search(code):
                hits.append(f"{rel}:{lineno} \\affil/\\affiliation")
            if _ACK_RE.search(code):
                hits.append(f"{rel}:{lineno} Acknowledgments（致谢）")
    items.append({
        "rule_id": "blind-author-block",
        "status": "warn" if hits else "pass",
        "evidence": ("命中作者块/致谢结构标记：" + "；".join(hits[:4])) if hits
        else "非注释行未发现 \\author/\\thanks/\\affiliation/Acknowledgments 标记",
        "source": _SRC_BLIND,
    })

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
        for rel, rows in lines.items():
            for lineno, code in rows:
                for term in terms:
                    idx = code.lower().find(term.lower())
                    if idx >= 0:
                        hits.append(f"{rel}:{lineno}「{term}」…{code[max(0, idx - 6):idx + 30].strip()}…")
        items.append({
            "rule_id": "blind-author-terms",
            "status": "warn" if hits else "pass",
            "evidence": ("命中屏蔽词：" + "；".join(hits[:3])) if hits
            else f".tex 非注释行未命中屏蔽词（{len(terms)} 词）",
            "source": _SRC_BLIND,
        })

    # --- 资助基金关键词 ---
    hits = []
    for rel, rows in lines.items():
        for lineno, code in rows:
            m = _FUNDING_RE.search(code)
            if m:
                hits.append(f"{rel}:{lineno}「…{code[max(0, m.start() - 8):m.start() + 30].strip()}…」")
    items.append({
        "rule_id": "blind-funding-terms",
        "status": "warn" if hits else "pass",
        "evidence": ("命中资助/基金表述：" + "；".join(hits[:3])) if hits
        else "非注释行未发现基金或资助表述",
        "source": _SRC_BLIND,
    })

    return _body(digest, items, error)
