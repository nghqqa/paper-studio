# -*- coding: utf-8 -*-
"""LaTeX 期刊返修高亮 PDF（latexdiff）：对比历史提交/里程碑与工作区生成红删蓝增 Marked-up PDF。"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import time

from app import config
from app.domain import latex_build, latex_history, task_runner
from app.domain.projects import ProjectError

DIFFS_DIR = os.path.join(".studio", "latex-diffs")
MANIFEST = "manifest.json"
KEEP_DIFFS = 10
_DIFF_ID_RE = re.compile(r"^[0-9]{8}-[0-9]{6}-[0-9]{9}$")


def _latexdiff_bin() -> str | None:
    path = os.environ.get("PATH", "")
    if config.LATEX_EXTRA_PATH:
        path = config.LATEX_EXTRA_PATH + os.pathsep + path
    return shutil.which("latexdiff", path=path)


def available() -> bool:
    return _latexdiff_bin() is not None


def diffs_dir(project) -> str:
    return os.path.join(project.dir, DIFFS_DIR)


def _pdf_url(pid: str, diff_id: str) -> str:
    return f"/api/projects/{pid}/latex/diffs/{diff_id}/pdf"


def list_diffs(project) -> list[dict]:
    root = diffs_dir(project)
    if not os.path.isdir(root):
        return []
    out: list[dict] = []
    for did in sorted(os.listdir(root), reverse=True):
        if not _DIFF_ID_RE.match(did):
            continue
        mp = os.path.join(root, did, MANIFEST)
        if not os.path.isfile(mp):
            continue
        try:
            with open(mp, encoding="utf-8") as f:
                row = json.load(f)
        except (OSError, ValueError):
            continue
        if isinstance(row, dict):
            row["pdf_url"] = _pdf_url(project.id, did) if row.get("status") == "ok" else None
            out.append(row)
    return out


def diff_pdf_path(project, diff_id: str) -> str:
    if not _DIFF_ID_RE.match(diff_id):
        raise ProjectError("返修高亮 PDF 标识不合法", 400)
    path = os.path.join(diffs_dir(project), diff_id, "diff.pdf")
    if not os.path.isfile(path):
        raise ProjectError("返修高亮 PDF 不存在或已被清理", 404)
    return path


def _prune_old_diffs(root: str) -> None:
    if not os.path.isdir(root):
        return
    ids = sorted(d for d in os.listdir(root) if _DIFF_ID_RE.match(d))
    for stale in ids[:-KEEP_DIFFS]:
        shutil.rmtree(os.path.join(root, stale), ignore_errors=True)


def _milestone_map(project_dir: str) -> dict[str, list[str]]:
    by_sha: dict[str, list[str]] = {}
    for m in latex_history.list_milestones(project_dir):
        by_sha.setdefault(m["sha"], []).append(m["name"])
    return by_sha


def _label_for(sha: str, by_sha: dict[str, list[str]]) -> str:
    if sha == latex_history.WORK:
        return "当前工作区"
    names = by_sha.get(sha)
    if names:
        return f"{names[0]} ({sha[:7]})"
    return sha[:7]


def generate_diff_pdf(
    store,
    pid: str,
    base_sha: str,
    target_sha: str = latex_history.WORK,
    engine: str | None = None,
) -> dict:
    """在隔离临时目录执行 latexdiff --flatten + latexmk，产出并持久化 diff.pdf。"""
    project = latex_build._require_latex_project(store, pid)
    ld_bin = _latexdiff_bin()
    if ld_bin is None:
        raise ProjectError("当前运行环境未安装 latexdiff 工具（Docker 镜像默认内置支持）", 503)

    cfg = project.settings.get("latex") or {}
    eng = engine or cfg.get("engine") or "xelatex"
    if eng not in config.LATEX_ENGINES:
        raise ProjectError(f"未知 LaTeX 引擎：{eng}", 422)
    main = str(cfg.get("main") or "")
    src_root = latex_build.source_root(project)
    if not main or not os.path.isfile(os.path.join(src_root, main)):
        raise ProjectError(f"主文件不存在：{main}", 422)

    base_full = latex_history.resolve(src_root, base_sha)
    target_full = (
        latex_history.WORK if target_sha == latex_history.WORK else latex_history.resolve(src_root, target_sha)
    )
    if target_full != latex_history.WORK and base_full == target_full:
        raise ProjectError("对比的两个版本相同，请选择不同版本", 422)

    lock = latex_build._lock_for(pid)
    if not lock.acquire(blocking=False):
        raise ProjectError("该案已有编译或对比任务在进行", 409)
    slot = task_runner.latex_slot()
    if not slot.acquire():
        lock.release()
        raise ProjectError(str(task_runner.Busy("LaTeX 返修对比")), 429)

    try:
        by_sha = _milestone_map(src_root)
        diff_id = time.strftime("%Y%m%d-%H%M%S") + "-" + f"{time.time_ns() % 1_000_000_000:09d}"
        out_root = diffs_dir(project)
        out_dir = os.path.join(out_root, diff_id)
        os.makedirs(out_dir, exist_ok=True)
        log_path = os.path.join(out_dir, "build.log")

        status = "error"
        err: str | None = None
        t0 = time.perf_counter()

        with tempfile.TemporaryDirectory(prefix="paper-latexdiff-") as tmp:
            old_dir = os.path.join(tmp, "old")
            new_dir = os.path.join(tmp, "new")
            work_dir = os.path.join(tmp, "diff")
            latex_history.export_tree(src_root, base_full, old_dir)
            latex_history.export_tree(src_root, target_full, new_dir)

            old_main = os.path.join(old_dir, *main.split("/"))
            new_main = os.path.join(new_dir, *main.split("/"))
            if not os.path.isfile(old_main):
                raise ProjectError(f"旧版本（{base_full[:7]}）中不包含主文件 {main}", 422)
            if not os.path.isfile(new_main):
                raise ProjectError(f"目标版本中不包含主文件 {main}", 422)

            shutil.copytree(new_dir, work_dir, dirs_exist_ok=True)
            work_main = os.path.join(work_dir, *main.split("/"))
            old_rel_arg = f"old/{main}"
            new_rel_arg = f"new/{main}"

            env = latex_build._build_env(work_dir)
            try:
                with open(work_main, "wb") as tex_out, open(log_path, "w", encoding="utf-8", errors="replace") as log_f:
                    proc = subprocess.run(
                        [
                            ld_bin,
                            "--flatten",
                            "--encoding=utf8",
                            "--allow-spaces",
                            "--math-markup=coarse",
                            old_rel_arg,
                            new_rel_arg,
                        ],
                        cwd=tmp,
                        stdout=tex_out,
                        stderr=log_f,
                        env=env,
                        timeout=60,
                    )
                if proc.returncode != 0 or os.path.getsize(work_main) == 0:
                    err = f"latexdiff 执行失败（退出码 {proc.returncode}）"
            except subprocess.TimeoutExpired:
                err = "latexdiff 差异生成超时（>60s）"

            if err is None:
                stem = os.path.splitext(main)[0]
                compile_log = os.path.join(work_dir, "latexmk.log")
                cmd = [
                    config.LATEX_LATEXMK,
                    f"-{eng}",
                    "-norc",
                    "-interaction=nonstopmode",
                    "-no-shell-escape",
                    "-f",
                    main,
                ]
                try:
                    rc = task_runner.run_task(
                        cmd,
                        cwd=work_dir,
                        timeout_s=config.LATEX_TIMEOUT_S,
                        log_file=compile_log,
                        env=env,
                    )
                except subprocess.TimeoutExpired:
                    rc = -1
                    err = f"返修高亮 PDF 编译超时（>{config.LATEX_TIMEOUT_S}s）"
                except FileNotFoundError:
                    rc = -1
                    err = f"找不到 latexmk（{config.LATEX_LATEXMK}）"

                if os.path.isfile(compile_log):
                    with open(log_path, "a", encoding="utf-8", errors="replace") as dst_log:
                        dst_log.write("\n--- latexmk ---\n")
                        with open(compile_log, encoding="utf-8", errors="replace") as src_log:
                            dst_log.write(src_log.read())

                produced = os.path.join(work_dir, f"{stem}.pdf")
                if not os.path.isfile(produced):
                    alt = os.path.join(work_dir, f"{os.path.basename(stem)}.pdf")
                    if os.path.isfile(alt):
                        produced = alt
                if os.path.isfile(produced) and os.path.getsize(produced) > 0:
                    shutil.copy2(produced, os.path.join(out_dir, "diff.pdf"))
                    status = "ok"
                    err = None
                elif err is None:
                    err = f"返修高亮 PDF 编译失败（latexmk 退出码 {rc}）"

        elapsed_ms = round((time.perf_counter() - t0) * 1000)
        manifest = {
            "diff_id": diff_id,
            "pid": pid,
            "engine": eng,
            "base_sha": base_full,
            "target_sha": target_full,
            "base_label": _label_for(base_full, by_sha),
            "target_label": _label_for(target_full, by_sha),
            "status": status,
            "error": err,
            "elapsed_ms": elapsed_ms,
            "created_at": int(time.time()),
            "pdf_url": _pdf_url(pid, diff_id) if status == "ok" else None,
        }
        with open(os.path.join(out_dir, MANIFEST), "w", encoding="utf-8") as mf:
            json.dump(manifest, mf, ensure_ascii=False, indent=2)
        _prune_old_diffs(out_root)
        return manifest
    finally:
        slot.sem.release()
        lock.release()
