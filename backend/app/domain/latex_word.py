# -*- coding: utf-8 -*-
"""LaTeX 工程 → 原生体验 Word 导出引擎（统一学术单栏 + 中文信息学报双栏）。

管线：
  源码快照 → 无 label equation 自动编号预处理 → 语言自动检测（zh/en）
  → pandoc（学术 reference.docx + numbering.lua 软编号 + 可选 layout.lua + GB/T 7714 CSL + 参考文献标题）
  → 布局安全化（按实际栏宽缩图/限表宽）→ 公式居中+编号右对齐 → 摘要汉化与题区润色 → 产物分析。

profile：
  - academic（默认）：A4 标准单栏学术版（宋体/黑体 + Times New Roman，三线表，居中页码）；
  - jcip：中文信息学报双栏版（标题通栏 + 正文双栏）。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid

from app import config
from app.domain import docx_post, latex_build, pandoc_runner, task_runner
from app.domain.docx_export import ASSETS, _analyze_docx, _layout_safe  # noqa: F401
from app.domain.projects import ProjectError

EXPORTS_DIR = os.path.join(".studio", "word-exports")
MANIFEST = "manifest.json"
ARTIFACT_NAMES = ("paper.docx", "manifest.json")

PROFILES = {
    "academic": {"display": "标准学术单栏", "reference": "academic-reference.docx", "columns": 1, "top_level": None},
    "thesis": {
        "display": "学位论文（大论文）",
        "reference": "academic-reference.docx",
        "columns": 1,
        "top_level": "chapter",
    },
    "jcip": {"display": "中文信息学报（双栏）", "reference": "jcip-reference.docx", "columns": 2, "top_level": None},
}
EQ_LAYOUTS = ("tab", "table")

_locks = pandoc_runner.ProjectLockPool()


def _lock_for(pid: str) -> threading.Lock:
    return _locks.get(pid)


def exports_dir(project) -> str:
    return os.path.join(project.dir, EXPORTS_DIR)


def _bib_rel(src_root: str) -> str | None:
    for base, _dirs, files in os.walk(src_root):
        for fn in files:
            if fn.lower().endswith(".bib"):
                return os.path.relpath(os.path.join(base, fn), src_root).replace(os.sep, "/")
    return None


def list_exports(project) -> list[dict]:
    return pandoc_runner.list_export_manifests(
        exports_dir(project),
        latex_build.digest_source(project),
        ARTIFACT_NAMES,
        include_artifacts=True,
    )


def artifact_file(project, eid: str, name: str) -> str:
    return pandoc_runner.resolve_export_artifact(
        exports_dir(project),
        eid,
        name,
        ARTIFACT_NAMES,
        not_found_msg="产物不存在（导出失败或已被清理）",
    )


def export_word(
    store,
    pid: str,
    profile: str = "academic",
    eq_layout: str = "tab",
) -> dict:
    """同步执行 Word 导出（路由 asyncio.to_thread 调用）。返回 manifest。"""
    if profile not in PROFILES:
        raise ProjectError(f"不支持的导出模板：{profile}（可选：{', '.join(PROFILES)}）", 400)
    if eq_layout not in EQ_LAYOUTS:
        raise ProjectError(f"不支持的公式编号版式：{eq_layout}（可选：{', '.join(EQ_LAYOUTS)}）", 400)

    latex_build._require_latex_project(store, pid)
    lock = _lock_for(pid)
    if not lock.acquire(blocking=False):
        raise ProjectError("该案已有导出在进行", 409)
    slot = task_runner.docx_slot()
    if not slot.acquire():
        lock.release()
        raise ProjectError(str(task_runner.Busy("Word 导出")), 429)
    try:
        project = store.get(pid)
        cfg = project.settings.get("latex") or {}
        main = str(cfg.get("main") or "")
        src_root = latex_build.source_root(project)
        if not main or not os.path.isfile(os.path.join(src_root, main)):
            raise ProjectError(f"主文件不存在：{main}", 422)
        pandoc_runner.ensure_runtime_ready(config.DOCX_EXPORT_RUNTIME, which_fn=shutil.which)

        digest = latex_build.digest_source(project)
        eid = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
        e_dir = os.path.join(exports_dir(project), eid)
        src_dir = os.path.join(e_dir, "src")
        assets_dir = os.path.join(e_dir, "assets")
        os.makedirs(src_dir, exist_ok=True)
        for rel in digest:
            dst = os.path.join(src_dir, rel)
            os.makedirs(os.path.dirname(dst) or src_dir, exist_ok=True)
            shutil.copy2(os.path.join(src_root, rel), dst)
        pandoc_runner.copy_docx_assets(assets_dir)

        main_rel = main.replace(os.sep, "/")
        main_dir = os.path.dirname(main_rel)
        # 预处理：拆分 align/gather 多行多编号公式 + 保留分页/居中/makebox + 无 \label equation 自动编号
        docx_post.preprocess_tex_for_pandoc(src_dir, split_multiline=True, preserve_layout_markers=True)
        is_zh = docx_post.detect_cjk_project(src_dir, main_rel)
        doc_lang = "zh" if is_zh else "en"
        ref_title = "参考文献" if is_zh else "References"

        prof = PROFILES[profile]
        ref_name = prof["reference"]
        if not os.path.isfile(os.path.join(assets_dir, ref_name)):
            ref_name = "jcip-reference.docx"
        has_ref = os.path.isfile(os.path.join(assets_dir, ref_name))
        has_csl = is_zh and os.path.isfile(os.path.join(assets_dir, "gb7714-2015-numeric.csl"))
        has_num_lua = os.path.isfile(os.path.join(assets_dir, "numbering.lua"))
        has_layout_lua = profile == "jcip" and os.path.isfile(os.path.join(assets_dir, "layout.lua"))

        bib_rel = _bib_rel(src_root)
        # 主文件在子目录时，\input 相对主文件目录解析——resource-path 必须包含主文件所在目录
        res_docker = "/proj/src" + (f":/proj/src/{main_dir}" if main_dir else "")
        layout_env = pandoc_runner.jcip_layout_env() if has_layout_lua else {}

        t0 = time.perf_counter()
        rc, out, err, pandoc_version = 0, "", "", ""
        if config.DOCX_EXPORT_RUNTIME == "docker":
            parts = [
                "pandoc --from=latex --to=docx --standalone --number-sections --wrap=auto",
            ]
            if prof.get("top_level"):
                parts.append(f"--top-level-division={prof['top_level']}")
            if has_ref:
                parts.append(f"--reference-doc=/proj/assets/{ref_name}")
            if bib_rel:
                parts.append("--citeproc")
                if has_csl:
                    parts.append("--csl=/proj/assets/gb7714-2015-numeric.csl")
                parts.append(f"--metadata reference-section-title={ref_title}")
                parts.append(f"--bibliography=/proj/src/{bib_rel}")
            if has_num_lua:
                parts.append("--lua-filter=/proj/assets/numbering.lua")
            if has_layout_lua:
                parts.append("--lua-filter=/proj/assets/layout.lua")
            parts.append(f"--resource-path={res_docker}")
            parts.append(f"--output=/proj/paper.docx /proj/src/{main_rel}")
            cmd = "pandoc --version | head -1; " + " ".join(parts)
            rc, out, err = pandoc_runner.run_pandoc_docker(
                mount_dir=e_dir,
                workdir="/proj/src",
                cmd=cmd,
                env_vars={
                    "PANDOC_NUMBERING_REPORT": "/proj/numbering.json",
                    "PANDOC_NUMBERING_SOFT": "1",
                    "PANDOC_DOC_LANG": doc_lang,
                    "PANDOC_CHAPTER_NUMBERING": "1" if profile == "thesis" else "0",
                    **layout_env,
                },
                image=config.DOCX_EXPORT_IMAGE,
                timeout_s=config.DOCX_EXPORT_TIMEOUT_S,
                subprocess_run=subprocess.run,
            )
            pandoc_version = out.strip().splitlines()[0] if out.strip() else ""
        else:
            # local：cwd=src（\input 相对主文件解析，同 jcip 实测教训）
            res_local = os.path.pathsep.join([".", main_dir] if main_dir else ["."])
            log_path = os.path.join(e_dir, "pandoc.log")
            args = [
                "--from=latex", "--to=docx", "--standalone", "--number-sections", "--wrap=auto",
            ]
            if prof.get("top_level"):
                args += ["--top-level-division", prof["top_level"]]
            if has_ref:
                args += ["--reference-doc", os.path.join("..", "assets", ref_name)]
            if bib_rel:
                args += ["--citeproc"]
                if has_csl:
                    args += ["--csl", os.path.join("..", "assets", "gb7714-2015-numeric.csl")]
                args += ["--metadata", f"reference-section-title={ref_title}"]
                args += ["--bibliography", bib_rel]
            if has_num_lua:
                args += ["--lua-filter", os.path.join("..", "assets", "numbering.lua")]
            if has_layout_lua:
                args += ["--lua-filter", os.path.join("..", "assets", "layout.lua")]
            args += ["--resource-path", res_local, "--output", os.path.join("..", "paper.docx"), main_rel]
            local_env = pandoc_runner.clean_local_env({
                "PANDOC_NUMBERING_REPORT": os.path.join("..", "numbering.json"),
                "PANDOC_NUMBERING_SOFT": "1",
                "PANDOC_DOC_LANG": doc_lang,
                "PANDOC_CHAPTER_NUMBERING": "1" if profile == "thesis" else "0",
                **layout_env,
            })
            rc, _out, err = pandoc_runner.run_pandoc_local(
                args,
                cwd=src_dir,
                timeout_s=config.DOCX_EXPORT_TIMEOUT_S,
                env=local_env,
                log_file=log_path,
                use_task_runner=True,
                run_task_fn=task_runner.run_task,
            )
        elapsed_ms = round((time.perf_counter() - t0) * 1000)

        docx_path = os.path.join(e_dir, "paper.docx")
        numbering = None
        n_path = os.path.join(e_dir, "numbering.json")
        if os.path.isfile(n_path):
            try:
                with open(n_path, encoding="utf-8") as f:
                    numbering = json.load(f)
            except ValueError:
                numbering = None

        status, reasons = "pass", []
        if rc != 0:
            status = "blocked"
            reasons.append(f"pandoc 退出码 {rc}")
            if err:
                reasons.append("stderr: " + err.strip()[:400])
        else:
            nf = re.findall(r"Citeproc: citation (\S+) not found", err or "")
            if nf:
                status = "degraded"
                reasons.append("citeproc 未解析引用: " + ", ".join(sorted(set(nf))))
            if numbering and numbering.get("warnings"):
                status = "degraded"
                reasons.append("编号提示: " + "; ".join(numbering["warnings"]))

        dx: dict = {}
        if os.path.isfile(docx_path):
            # 原生排版后处理（图片按栏宽缩放、公式居中编号靠右、摘要汉化、题区润色）
            try:
                _layout_safe(docx_path, columns=prof["columns"])
                docx_post.apply_eq_layout(docx_path, mode=eq_layout)
                docx_post.apply_meta_layout(docx_path, lang=doc_lang)
                docx_post.polish_docx_native(docx_path, lang=doc_lang, is_thesis=(profile == "thesis"))
            except Exception as e:  # noqa: BLE001
                status = "degraded" if status == "pass" else status
                reasons.append(f"版式后处理降级: {e}")

            dx = _analyze_docx(docx_path)
            if dx.get("wellformed"):
                if dx.get("chars", 0) == 0:
                    status, reasons = "blocked", reasons + ["产物正文为空"]
                if dx.get("latex_residues"):
                    status = "degraded" if status == "pass" else status
                    reasons.append("LaTeX 残留: " + json.dumps(dx["latex_residues"], ensure_ascii=False))
                if dx.get("broken_links"):
                    status = "degraded" if status == "pass" else status
                    reasons.append(f"交叉引用断链: {dx['broken_links']}")
                if (not bib_rel and status != "blocked" and any(
                        "\\cite{" in open(os.path.join(src_root, r), encoding="utf-8", errors="replace").read()
                        for r in digest if r.lower().endswith((".tex", ".ltx")))):
                    status = "degraded" if status == "pass" else status
                    reasons.append("工程无 .bib：\\cite 以原文残留（未生成文献表）")
            elif status == "pass":
                status, reasons = "blocked", reasons + [f"产物分析失败: {dx.get('error')}"]
            if status == "blocked" and os.path.isfile(docx_path):
                os.remove(docx_path)  # blocked 不得留下可下载的「成功产物」
        elif status != "blocked":
            status, reasons = "blocked", reasons + ["产物不存在"]

        manifest = {
            "schema": "paper-studio/word-export@1",
            "export_id": eid,
            "pid": pid,
            "main": main,
            "profile": profile,
            "profile_display": prof["display"],
            "lang": doc_lang,
            "eq_layout": eq_layout,
            "digest": digest,
            "status": status,  # pass | degraded | blocked
            "degrades": reasons,
            "numbering": numbering,
            "docx": dx,
            "tool": {"pandoc": pandoc_version, "runtime": config.DOCX_EXPORT_RUNTIME,
                     "exit_code": rc, "duration_ms": elapsed_ms, "stderr": err.strip()[:2000]},
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        with open(os.path.join(e_dir, MANIFEST), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
        manifest["artifacts"] = {n: n for n in ARTIFACT_NAMES if os.path.isfile(os.path.join(e_dir, n))}
        task_runner.prune_dirs(exports_dir(project), config.ARTIFACT_KEEP)
        return manifest
    finally:
        slot.sem.release()
        lock.release()
