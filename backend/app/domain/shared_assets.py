# -*- coding: utf-8 -*-
"""跨项目共享文献库与 LaTeX 常用片段库：<projects>/.studio/user-assets/<uid>/。

按用户隔离（auth=off 时归入 anon），遵循零双写边界：
- 共享库保存科研作者的常用文献卡片，支持一键复制导入具体项目 .bib/index；
- 片段库预置学术三线表、跨栏大图、并排子图、伪代码、数学定理与对齐公式等标准模板，支持个人增删改。
"""
from __future__ import annotations

import json
import os
import re
import time
import uuid

from app import atomic, config
from app.domain import library
from app.errors import kind_error

_DIR = os.path.join(".studio", "user-assets")
_SAFE = re.compile(r"[^0-9a-zA-Z_-]")

DEFAULT_SNIPPETS: list[dict] = [
    {
        "id": "snp_booktabs_table",
        "title": "三线表（booktabs）",
        "category": "表格",
        "description": "符合 IEEE/ACM/中文期刊排版规范的学术三线表框架",
        "code": (
            "\\begin{table}[htbp]\n"
            "  \\centering\n"
            "  \\caption{实验对比结果}\n"
            "  \\label{tab:results}\n"
            "  \\begin{tabular}{lcc}\n"
            "    \\toprule\n"
            "    方法 & 指标 A & 指标 B \\\\\n"
            "    \\midrule\n"
            "    Baseline & 81.2 & 76.4 \\\\\n"
            "    Ours     & \\textbf{87.5} & \\textbf{82.1} \\\\\n"
            "    \\bottomrule\n"
            "  \\end{tabular}\n"
            "\\end{table}"
        ),
    },
    {
        "id": "snp_figure_wide",
        "title": "双栏跨栏图（figure*）",
        "category": "图表",
        "description": "双栏模板顶部通栏展示系统架构或主流程",
        "code": (
            "\\begin{figure*}[t]\n"
            "  \\centering\n"
            "  \\includegraphics[width=0.92\\textwidth]{figures/architecture.pdf}\n"
            "  \\caption{整体框架示意图。}\n"
            "  \\label{fig:arch}\n"
            "\\end{figure*}"
        ),
    },
    {
        "id": "snp_subfigures",
        "title": "并排子图（subcaption）",
        "category": "图表",
        "description": "左右并排多组对比实验曲线或消融图",
        "code": (
            "\\begin{figure}[htbp]\n"
            "  \\centering\n"
            "  \\begin{subfigure}[b]{0.48\\linewidth}\n"
            "    \\centering\n"
            "    \\includegraphics[width=\\linewidth]{figures/sub-a.pdf}\n"
            "    \\caption{参数敏感度}\n"
            "    \\label{fig:sub_a}\n"
            "  \\end{subfigure}\n"
            "  \\hfill\n"
            "  \\begin{subfigure}[b]{0.48\\linewidth}\n"
            "    \\centering\n"
            "    \\includegraphics[width=\\linewidth]{figures/sub-b.pdf}\n"
            "    \\caption{收敛曲线}\n"
            "    \\label{fig:sub_b}\n"
            "  \\end{subfigure}\n"
            "  \\caption{消融实验与收敛对比。}\n"
            "  \\label{fig:ablation}\n"
            "\\end{figure}"
        ),
    },
    {
        "id": "snp_algorithm",
        "title": "算法伪代码（algorithm2e/algorithmic）",
        "category": "算法",
        "description": "标准算法伪代码环境（兼容 algorithm + algorithmic）",
        "code": (
            "\\begin{algorithm}[htbp]\n"
            "  \\caption{算法流程名称}\n"
            "  \\label{alg:main}\n"
            "  \\begin{algorithmic}[1]\n"
            "    \\REQUIRE 输入数据 $X$，步数 $T$\n"
            "    \\ENSURE 输出结果 $Y$\n"
            "    \\FOR{$t = 1$ to $T$}\n"
            "      \\STATE 更新特征表示 $h_t \\leftarrow f(h_{t-1}, X)$\n"
            "    \\ENDFOR\n"
            "    \\RETURN $Y$\n"
            "  \\end{algorithmic}\n"
            "\\end{algorithm}"
        ),
    },
    {
        "id": "snp_theorem_proof",
        "title": "数学定理与证明",
        "category": "公式与定理",
        "description": "定理陈述与证明推导区块",
        "code": (
            "\\begin{theorem}[收敛界]\n"
            "  在标准凸假设下，所提迭代格式满足 $\\|x_T - x^*\\|^2 \\le \\mathcal{O}(1/T)$。\n"
            "\\end{theorem}\n"
            "\\begin{proof}\n"
            "  由光滑性不等式直接展开可得……\n"
            "\\end{proof}"
        ),
    },
    {
        "id": "snp_align_eq",
        "title": "多行对齐公式（align）",
        "category": "公式与定理",
        "description": "多步目标函数或梯度推导对齐环境",
        "code": (
            "\\begin{align}\n"
            "  \\mathcal{L}(\\theta) &= \\mathcal{L}_{\\mathrm{task}}(\\theta) + \\lambda \\mathcal{L}_{\\mathrm{reg}}(\\theta) \\\\\n"
            "  &= \\frac{1}{N}\\sum_{i=1}^{N} \\ell(f_\\theta(x_i), y_i) + \\lambda \\|\\theta\\|_2^2 .\n"
            "\\end{align}"
        ),
    },
]


def _user_key(uid: str | None) -> str:
    safe = _SAFE.sub("", str(uid or "anon"))
    return safe or "anon"


def _user_dir(uid: str | None) -> str:
    return os.path.join(config.PROJECTS_DIR, _DIR, _user_key(uid))


def _lock_name(uid: str | None) -> str:
    return f"shared-assets-{_user_key(uid)}"


def _lib_path(uid: str | None) -> str:
    return os.path.join(_user_dir(uid), "shared-library.json")


def _snp_path(uid: str | None) -> str:
    return os.path.join(_user_dir(uid), "snippets.json")


def _read_list(path: str, key: str) -> list[dict]:
    if not os.path.isfile(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return []
    raw = data.get(key) if isinstance(data, dict) else data
    return [dict(x) for x in raw if isinstance(x, dict)] if isinstance(raw, list) else []


def _write_list(path: str, key: str, items: list[dict]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    atomic.write_json(path, {"schema_version": 1, key: items})


def list_shared_library(uid: str | None) -> list[dict]:
    with atomic.studio_lock(config.PROJECTS_DIR, _lock_name(uid)):
        return _read_list(_lib_path(uid), "items")


def _norm_lib_item(raw: dict) -> dict:
    title = str(raw.get("title") or "").strip()[:500]
    ckey = str(raw.get("citation_key") or "").strip()[:120]
    if not ckey:
        ckey = library.suggested_key(
            {"title": title, "authors": raw.get("authors") or [], "year": raw.get("year")},
            existing=set(),
        )
    authors = [str(a).strip() for a in (raw.get("authors") or []) if str(a).strip()][:30]
    return {
        "id": str(raw.get("id") or f"sref_{uuid.uuid4().hex[:10]}"),
        "citation_key": ckey,
        "entry_type": str(raw.get("entry_type") or "article").strip() or "article",
        "title": title,
        "authors": authors,
        "year": str(raw.get("year") or "").strip() or None,
        "venue": str(raw.get("venue") or "").strip() or None,
        "doi": str(raw.get("doi") or "").strip() or None,
        "arxiv_id": str(raw.get("arxiv_id") or "").strip() or None,
        "url": str(raw.get("url") or "").strip() or None,
        "abstract": str(raw.get("abstract") or "").strip() or None,
        "raw_bibtex": str(raw.get("raw_bibtex") or "").strip(),
        "tags": [str(t).strip() for t in (raw.get("tags") or []) if str(t).strip()][:10],
        "source_project": str(raw.get("source_project") or "").strip() or None,
        "updated_at": time.time(),
    }


def add_shared_library_items(uid: str | None, items: list[dict]) -> tuple[list[dict], list[dict]]:
    if not items:
        raise kind_error("validation", "请提供要存入共享库的文献条目")
    added: list[dict] = []
    with atomic.studio_lock(config.PROJECTS_DIR, _lock_name(uid)):
        cur = _read_list(_lib_path(uid), "items")
        existing_doi = {str(x.get("doi") or "").lower() for x in cur if x.get("doi")}
        existing_title = {f"{str(x.get('title') or '').lower()}|{x.get('year') or ''}" for x in cur if x.get("title")}
        for raw in items:
            norm = _norm_lib_item(raw)
            doi = str(norm.get("doi") or "").lower()
            tkey = f"{norm['title'].lower()}|{norm.get('year') or ''}"
            if doi and doi in existing_doi:
                continue
            if norm["title"] and tkey in existing_title:
                continue
            cur.insert(0, norm)
            added.append(norm)
            if doi:
                existing_doi.add(doi)
            if norm["title"]:
                existing_title.add(tkey)
        _write_list(_lib_path(uid), "items", cur)
        return added, cur


def delete_shared_library_item(uid: str | None, item_id: str) -> tuple[bool, list[dict]]:
    with atomic.studio_lock(config.PROJECTS_DIR, _lock_name(uid)):
        cur = _read_list(_lib_path(uid), "items")
        kept = [x for x in cur if x.get("id") != item_id]
        removed = len(kept) != len(cur)
        if removed:
            _write_list(_lib_path(uid), "items", kept)
        return removed, kept


def list_snippets(uid: str | None) -> list[dict]:
    p = _snp_path(uid)
    with atomic.studio_lock(config.PROJECTS_DIR, _lock_name(uid)):
        if not os.path.isfile(p):
            now = time.time()
            seeded = [{**s, "builtin": True, "updated_at": now} for s in DEFAULT_SNIPPETS]
            _write_list(p, "items", seeded)
            return seeded
        return _read_list(p, "items")


def upsert_snippet(uid: str | None, payload: dict) -> tuple[dict, list[dict]]:
    title = str(payload.get("title") or "").strip()[:80]
    code = str(payload.get("code") or "")
    if not title or not code.strip():
        raise kind_error("validation", "片段标题与 LaTeX 代码均不能为空")
    cat = str(payload.get("category") or "常用").strip()[:32] or "常用"
    desc = str(payload.get("description") or "").strip()[:240]
    sid = str(payload.get("id") or "").strip()

    with atomic.studio_lock(config.PROJECTS_DIR, _lock_name(uid)):
        p = _snp_path(uid)
        cur = _read_list(p, "items") if os.path.isfile(p) else [{**s, "builtin": True, "updated_at": time.time()} for s in DEFAULT_SNIPPETS]
        hit = next((x for x in cur if sid and x.get("id") == sid), None)
        now = time.time()
        if hit is not None:
            hit.update(title=title, category=cat, description=desc, code=code, updated_at=now)
            saved = dict(hit)
        else:
            saved = {
                "id": sid or f"snp_{uuid.uuid4().hex[:10]}",
                "title": title,
                "category": cat,
                "description": desc,
                "code": code,
                "builtin": False,
                "updated_at": now,
            }
            cur.insert(0, saved)
        _write_list(p, "items", cur)
        return saved, cur


def delete_snippet(uid: str | None, sid: str) -> tuple[bool, list[dict]]:
    with atomic.studio_lock(config.PROJECTS_DIR, _lock_name(uid)):
        p = _snp_path(uid)
        cur = _read_list(p, "items")
        kept = [x for x in cur if x.get("id") != sid]
        removed = len(kept) != len(cur)
        if removed:
            _write_list(p, "items", kept)
        return removed, kept
