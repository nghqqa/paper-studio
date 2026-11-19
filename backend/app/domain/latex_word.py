# -*- coding: utf-8 -*-
"""LaTeX 工程 → Word 通用导出（v0.6.7，导师阅读版）。

与 jcip 实验导出（docx_export.py，中文信息学报 profile）的关系：**完全独立**。jcip 是
版式符合性管线（reference.docx + GB/T 7714 CSL + 编号/版式校验，只服务一个 profile）；
本模块是通用转换——pandoc 默认样式 + 工程自带 .bib 的 citeproc（无 CSL 时用 pandoc 默认
引用格式），目标是「导师要 Word 版提意见」的阅读稿，**不是投稿稿**。

边界（如实）：
- 数学公式转 OMML（pandoc 强项）；自定义宏、浮动体版式、复杂表格可能走样——产物 banner
  与前端提示都写明「转换后需人工核对」；
- 编译管线（latexmk）不参与：转换的是源码语义而非排版结果，PDF 里的分页/字号不在本管线目标内；
- runtime 复用 DOCX_EXPORT_RUNTIME（local=容器内置 pandoc / docker=宿主 pandoc/latex 镜像），
  并发占 docx_slot（与 jcip 导出同一资源池）；
- 无 .bib 时不用 citeproc：`\\\\cite` 以原样文本残留（诊断里如实降级提示）。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
import uuid

from app import config
from app.domain import latex_build, task_runner
from app.domain.docx_export import _analyze_docx
from app.domain.projects import ProjectError

EXPORTS_DIR = os.path.join(".studio", "word-exports")
MANIFEST = "manifest.json"
ARTIFACT_NAMES = ("paper.docx", "manifest.json")

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(pid: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(pid, threading.Lock())


def exports_dir(project) -> str:
    return os.path.join(project.dir, EXPORTS_DIR)


def _bib_rel(src_root: str) -> str | None:
    for base, _dirs, files in os.walk(src_root):
        for fn in files:
            if fn.lower().endswith(".bib"):
                return os.path.relpath(os.path.join(base, fn), src_root).replace(os.sep, "/")
    return None


def list_exports(project) -> list[dict]:
    out = []
    base = exports_dir(project)
    if not os.path.isdir(base):
        return out
    cur = latex_build.digest_source(project)
    for eid in sorted(os.listdir(base), reverse=True):
        mp = os.path.join(base, eid, MANIFEST)
        if not os.path.isfile(mp):
            continue
        try:
            with open(mp, encoding="utf-8") as f:
                m = json.load(f)
        except ValueError:
            continue
        m["stale"] = m.get("digest") != cur
        out.append(m)
    return out


def artifact_file(project, eid: str, name: str) -> str:
    if eid != os.path.basename(eid) or not eid:
        raise ProjectError("非法导出 ID", 400)
    if name not in ARTIFACT_NAMES:
        raise ProjectError("非法产物名", 400)
    p = os.path.join(exports_dir(project), eid, name)
    if not os.path.isfile(p):
        raise ProjectError("产物不存在（导出失败或已被清理）", 404)
    return p


def export_word(store, pid: str) -> dict:
    """同步执行通用 Word 导出（路由 asyncio.to_thread 调用）。返回 manifest。"""
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
        if config.DOCX_EXPORT_RUNTIME == "docker" and not shutil.which("docker"):
            raise ProjectError("导出运行时为 docker，但当前环境不可用（或改用 PATENT_STUDIO_DOCX_EXPORT_RUNTIME=local）", 503)
        if config.DOCX_EXPORT_RUNTIME == "local" and not shutil.which(config.DOCX_EXPORT_PANDOC):
            raise ProjectError("导出运行时为 local，但镜像内未找到 pandoc（部署镜像应内置）", 503)

        digest = latex_build.digest_source(project)
        eid = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
        e_dir = os.path.join(exports_dir(project), eid)
        src_dir = os.path.join(e_dir, "src")
        os.makedirs(src_dir, exist_ok=True)
        for rel in digest:
            dst = os.path.join(src_dir, rel)
            os.makedirs(os.path.dirname(dst) or src_dir, exist_ok=True)
            shutil.copy2(os.path.join(src_root, rel), dst)

        bib_rel = _bib_rel(src_root)
        main_rel = main.replace(os.sep, "/")
        main_dir = os.path.dirname(main_rel)
        # 主文件在子目录时，\input 相对主文件目录解析——resource-path 必须包含主文件所在目录
        res_docker = "/proj/src" + (f":/proj/src/{main_dir}" if main_dir else "")
        t0 = time.perf_counter()
        rc, out, err, pandoc_version = 0, "", "", ""
        if config.DOCX_EXPORT_RUNTIME == "docker":
            bib_arg = f"--bibliography=/proj/src/{bib_rel} --citeproc " if bib_rel else ""
            cmd = (
                "pandoc --version | head -1; "
                "pandoc --from=latex --to=docx --standalone --number-sections --wrap=auto "
                f"{bib_arg}"
                f"--resource-path={res_docker} "
                f"--output=/proj/paper.docx /proj/src/{main_rel}"
            )
            try:
                proc = subprocess.run(
                    ["docker", "run", "--rm", "--entrypoint", "sh",
                     "-v", f"{e_dir.replace(os.sep, '/')}:/proj",
                     "pandoc/latex:3.6.4", "-c", cmd],
                    capture_output=True, text=True, encoding="utf-8", errors="replace",
                    timeout=config.DOCX_EXPORT_TIMEOUT_S,
                )
                rc, out, err = proc.returncode, proc.stdout, proc.stderr
            except subprocess.TimeoutExpired:
                rc, err = -1, "转换超时"
            pandoc_version = out.strip().splitlines()[0] if out.strip() else ""
        else:
            # local：cwd=src（\input 相对主文件解析，同 jcip 实测教训）；
            # 子目录主文件按相对路径传入，resource-path 补主文件目录（Windows 分号分隔）
            res_local = os.path.pathsep.join([".", main_dir] if main_dir else ["."])
            args = [
                "--from=latex", "--to=docx", "--standalone", "--number-sections", "--wrap=auto",
            ]
            if bib_rel:
                args += ["--citeproc", "--bibliography", bib_rel]
            args += ["--resource-path", res_local, "--output", os.path.join("..", "paper.docx"),
                     main_rel]
            rc = task_runner.run_task(
                [config.DOCX_EXPORT_PANDOC, *args],
                cwd=src_dir,
                timeout_s=config.DOCX_EXPORT_TIMEOUT_S,
                env={k: v for k, v in os.environ.items()
                     if k in ("PATH", "SystemRoot", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LANG", "LC_ALL")},
            )
        elapsed_ms = round((time.perf_counter() - t0) * 1000)

        docx_path = os.path.join(e_dir, "paper.docx")
        status, reasons = "pass", []
        if rc != 0:
            status = "blocked"
            reasons.append(f"pandoc 退出码 {rc}")
            if err:
                reasons.append("stderr: " + err.strip()[:400])
        dx: dict = {}
        if os.path.isfile(docx_path):
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
            "digest": digest,
            "status": status,  # pass | degraded | blocked
            "degrades": reasons,
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
