# -*- coding: utf-8 -*-
"""LaTeX 干净投稿打包与大修返修三件套导出：

- strip_tex_comments：安全剥离 % 注释，完整保留 \\% 与 verbatim/lstlisting/minted/Verbatim/comment 环境；
- find_referenced_media_in_texts：解析 \\graphicspath 与 \\includegraphics/\\includesvg/\\overpic，定位实际被引用的插图；
- latest_build_bbl：提取最近编译生成的 .bbl；
- build_submission_package：构造干净投稿 ZIP（支持去注释、带 .bbl、裁剪未引用媒体、50 MB arXiv 预警）；
- build_revision_kit_zip：打包返修三件套（干净终稿 PDF + 修订高亮 Diff PDF + 多格式审稿回复信 + 说明清单）。
"""

from __future__ import annotations

import io
import os
import posixpath
import re
import time
import zipfile
from urllib.parse import quote

from app.domain import latex_build, latex_diff, rebuttal
from app.domain.projects import ProjectError

MEDIA_EXTS = frozenset({".png", ".jpg", ".jpeg", ".pdf", ".eps", ".svg"})
ARXIV_WARN_BYTES = 50 * 1024 * 1024

_BEGIN_VERBATIM_RE = re.compile(
    r"\\begin\{(verbatim\*|verbatim|lstlisting|minted|Verbatim|comment)\}"
)
_GRAPHICS_PATH_RE = re.compile(r"\\graphicspath\s*\{((?:\s*\{[^{}]*\}\s*)+)\}")
_BRACE_DIR_RE = re.compile(r"\{([^{}]*)\}")
_INC_GFX_RE = re.compile(r"\\(?:includegraphics|includesvg|overpic)(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}")


def _line_comment_start(line: str) -> int | None:
    """返回首个未转义 % 的下标（考虑偶数个连续反斜杠为换行符 \\\\）；无则返回 None。"""
    bs = 0
    for idx, ch in enumerate(line):
        if ch == "\\":
            bs += 1
        elif ch == "%":
            if bs % 2 == 0:
                return idx
            bs = 0
        else:
            bs = 0
    return None


def strip_tex_comments(tex: str) -> str:
    """剥离 .tex 注释行与行内注释；完整保留 \\% 转义与 verbatim 类环境原文。"""
    out: list[str] = []
    active_env: str | None = None
    for line in tex.splitlines(keepends=True):
        if active_env is not None:
            out.append(line)
            if re.search(rf"\\end\{{{re.escape(active_env)}\}}", line):
                active_env = None
            continue

        c_idx = _line_comment_start(line)
        if c_idx is not None:
            eol = "\r\n" if line.endswith("\r\n") else ("\n" if line.endswith("\n") else "")
            code = line[:c_idx]
            if not code.strip():
                continue
            kept = code.rstrip(" \t") + eol
        else:
            kept = line

        out.append(kept)
        m = _BEGIN_VERBATIM_RE.search(kept)
        if m:
            env = m.group(1)
            if not re.search(rf"\\end\{{{re.escape(env)}\}}", kept[m.end() :]):
                active_env = env
    return "".join(out)


def find_referenced_media_in_texts(tex_map: dict[str, str], all_rels: set[str]) -> set[str]:
    """根据已剥离注释的 .tex 源码字典 {rel: clean_text} 找出实际引用的媒体文件集合。"""
    media_rels = {rel for rel in all_rels if os.path.splitext(rel)[1].lower() in MEDIA_EXTS}
    if not media_rels:
        return set()

    search_dirs: list[str] = [""]
    for clean_tex in tex_map.values():
        for gm in _GRAPHICS_PATH_RE.finditer(clean_tex):
            for dm in _BRACE_DIR_RE.finditer(gm.group(1)):
                d = dm.group(1).strip().replace("\\", "/").strip("/")
                if d and d not in search_dirs:
                    search_dirs.append(d)

    referenced: set[str] = set()
    for tex_rel, clean_tex in tex_map.items():
        tex_dir = posixpath.dirname(tex_rel)
        dirs = list(search_dirs)
        if tex_dir and tex_dir not in dirs:
            dirs.append(tex_dir)
        for im in _INC_GFX_RE.finditer(clean_tex):
            ref = im.group(1).strip().replace("\\", "/")
            if not ref or ref.startswith("{") or "#" in ref:
                continue
            ref = ref.lstrip("./") if ref.startswith("./") else ref
            for base_dir in dirs:
                cand = posixpath.normpath(posixpath.join(base_dir, ref)) if base_dir else posixpath.normpath(ref)
                if cand.startswith("../"):
                    continue
                if cand in media_rels:
                    referenced.add(cand)
                elif not os.path.splitext(cand)[1]:
                    for ext in (".pdf", ".png", ".jpg", ".jpeg", ".eps", ".svg"):
                        with_ext = f"{cand}{ext}"
                        if with_ext in media_rels:
                            referenced.add(with_ext)
    return referenced


def latest_build_bbl(project) -> tuple[str, bytes] | None:
    """从最近一次编译产物中提取主文件对应的 .bbl；若不存在则返回 None。"""
    build = latex_build.latest_build(project, ok_only=True) or latex_build.latest_build(project, ok_only=False)
    if not build:
        return None
    main = build.get("main") or (project.settings.get("latex") or {}).get("main") or "main.tex"
    stem = os.path.splitext(main)[0]
    build_dir = os.path.join(latex_build.builds_dir(project), build["build_id"])
    for cand_rel in (f"{stem}.bbl", f"{os.path.basename(stem)}.bbl"):
        p = os.path.join(build_dir, *cand_rel.split("/"))
        if os.path.isfile(p) and os.path.getsize(p) > 0:
            with open(p, "rb") as f:
                return f"{stem}.bbl", f.read()
    return None


def _require_latex(project) -> None:
    if project.settings.get("source_format") != "latex":
        raise ProjectError("仅 LaTeX 工程支持此导出操作", 400)


def build_submission_package(
    project,
    *,
    strip_comments: bool = True,
    include_bbl: bool = True,
    prune_unused_media: bool = True,
) -> dict:
    """构造干净投稿 ZIP 包与完整清单报告。"""
    _require_latex(project)
    source_entries = latex_build.list_source_files(project)
    if not source_entries:
        raise ProjectError("当前 LaTeX 工程没有任何源文件", 404)

    raw_files: dict[str, bytes] = {}
    for item in source_entries:
        rel = item["path"]
        real = latex_build.resolve_source_path(project, rel)
        with open(real, "rb") as f:
            raw_files[rel] = f.read()

    tex_clean_map = {
        rel: strip_tex_comments(data.decode("utf-8", errors="replace"))
        for rel, data in raw_files.items()
        if rel.lower().endswith(".tex")
    }
    all_rels = set(raw_files.keys())
    media_rels = {rel for rel in all_rels if os.path.splitext(rel)[1].lower() in MEDIA_EXTS}
    referenced_media = find_referenced_media_in_texts(tex_clean_map, all_rels) if prune_unused_media else set(media_rels)

    out_files: dict[str, bytes] = {}
    pruned_media: list[str] = []
    kept_media: list[str] = []
    stripped_tex_count = 0

    for rel in sorted(raw_files.keys()):
        if rel in media_rels:
            if prune_unused_media and rel not in referenced_media:
                pruned_media.append(rel)
                continue
            kept_media.append(rel)
            out_files[rel] = raw_files[rel]
        elif rel.lower().endswith(".tex") and strip_comments:
            out_files[rel] = tex_clean_map[rel].encode("utf-8")
            stripped_tex_count += 1
        else:
            out_files[rel] = raw_files[rel]

    warnings: list[str] = []
    bbl_file: str | None = None
    if include_bbl:
        bbl = latest_build_bbl(project)
        if bbl is not None:
            bbl_rel, bbl_bytes = bbl
            out_files[bbl_rel] = bbl_bytes
            bbl_file = bbl_rel
        else:
            has_bib_ref = any(
                re.search(r"\\(?:cite|bibliography|addbibresource)\b", txt)
                for txt in tex_clean_map.values()
            )
            if has_bib_ref:
                warnings.append("未找到最新编译生成的 .bbl；若提交至 arXiv，建议先编译一次再打包")

    buf = io.BytesIO()
    total_bytes = 0
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for rel in sorted(out_files.keys()):
            payload = out_files[rel]
            total_bytes += len(payload)
            zf.writestr(rel, payload)
    zip_bytes = buf.getvalue()
    exceeds = len(zip_bytes) > ARXIV_WARN_BYTES or total_bytes > ARXIV_WARN_BYTES
    if exceeds:
        warnings.append("打包体积超过 50 MB（arXiv 常见上限），建议压缩高分辨率位图后重新打包")

    base = re.sub(r"[^A-Za-z0-9._-]+", "-", project.title or project.id).strip("-") or project.id
    return {
        "zip_bytes": zip_bytes,
        "filename": f"{base}-submission.zip",
        "included_files": sorted(out_files.keys()),
        "pruned_media": sorted(pruned_media),
        "kept_media": sorted(kept_media),
        "stripped_tex_count": stripped_tex_count,
        "bbl_file": bbl_file,
        "total_bytes": total_bytes,
        "zip_size_bytes": len(zip_bytes),
        "exceeds_arxiv_limit": exceeds,
        "warnings": warnings,
    }


def build_revision_kit_zip(project, *, diff_id: str | None = None) -> tuple[bytes, str]:
    """一键打包返修三件套 ZIP（干净终稿 PDF / latexdiff 高亮 PDF / 多格式回复信 / 说明文件）。"""
    _require_latex(project)
    included: list[str] = []
    notes: list[str] = []
    entries: list[tuple[str, bytes]] = []

    clean_build = latex_build.latest_build(project, ok_only=True)
    if clean_build:
        build_dir = os.path.join(latex_build.builds_dir(project), clean_build["build_id"])
        pdf_path, _gz = latex_build._build_artifact_pair(build_dir, clean_build["main"])
        if pdf_path and os.path.isfile(pdf_path):
            with open(pdf_path, "rb") as f:
                entries.append(("01-manuscript-clean.pdf", f.read()))
            included.append(f"01-manuscript-clean.pdf (build {clean_build['build_id']})")
        else:
            notes.append("01-manuscript-clean.pdf：最近编译记录缺少 PDF 产物")
    else:
        notes.append("01-manuscript-clean.pdf：尚无成功编译的 PDF，请先编译正文")

    picked_diff: dict | None = None
    if diff_id:
        diff_pdf = latex_diff.diff_pdf_path(project, diff_id)
        with open(diff_pdf, "rb") as f:
            entries.append(("02-manuscript-marked-up-diff.pdf", f.read()))
        included.append(f"02-manuscript-marked-up-diff.pdf (diff {diff_id})")
    else:
        for d in latex_diff.list_diffs(project):
            if d.get("status") == "ok":
                picked_diff = d
                break
        if picked_diff is not None:
            try:
                diff_pdf = latex_diff.diff_pdf_path(project, picked_diff["diff_id"])
                with open(diff_pdf, "rb") as f:
                    entries.append(("02-manuscript-marked-up-diff.pdf", f.read()))
                included.append(
                    f"02-manuscript-marked-up-diff.pdf ({picked_diff.get('base_label', '')} -> {picked_diff.get('target_label', '')})"
                )
            except ProjectError:
                notes.append("02-manuscript-marked-up-diff.pdf：Diff PDF 文件不存在")
        else:
            notes.append("02-manuscript-marked-up-diff.pdf：尚未生成已成功的返修版本对比（请在历史面板运行 Diff）")

    project_dict = {"id": project.id, "title": project.title, "dir": project.dir}
    try:
        reb_state = rebuttal.load_state(project.dir)
        items = reb_state.get("items") or []
        if items and rebuttal._has_exportable(items):
            for fmt in ("md", "tex", "docx"):
                content = rebuttal.export_letter(project_dict, reb_state, fmt)
                arcname = f"03-response-letter.{fmt}"
                entries.append((arcname, content))
                included.append(f"{arcname} (round {max(int(reb_state.get('round') or 0), 1)})")
        else:
            notes.append("03-response-letter.*：审稿回复信暂无已撰写内容")
    except rebuttal.RebuttalError as exc:
        notes.append(f"03-response-letter.*：{exc}")

    if not entries:
        raise ProjectError("当前工程尚无已编译 PDF、返修对比 PDF 或可导出的审稿回复信，无法生成返修包", 409)

    readme_lines = [
        f"Paper Studio Revision Kit - {project.title or project.id}",
        f"Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        "Included files:",
        *[f"  - {line}" for line in included],
    ]
    if notes:
        readme_lines.extend(["", "Skipped / Missing items:", *[f"  - {line}" for line in notes]])
    entries.append(("README-revision-kit.txt", ("\n".join(readme_lines) + "\n").encode("utf-8")))

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries:
            zf.writestr(name, data)

    base = re.sub(r"[^A-Za-z0-9._-]+", "-", project.title or project.id).strip("-") or project.id
    return buf.getvalue(), quote(f"{base}-revision-kit.zip")
