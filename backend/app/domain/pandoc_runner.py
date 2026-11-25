# -*- coding: utf-8 -*-
"""Pandoc 运行与 DOCX 导出管线公共原语（local / docker 双运行时、资产复制、环境隔离、锁与清单）。"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading

from app import config
from app.domain import task_runner
from app.domain.projects import ProjectError

DOCX_ASSETS_DIR = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docx_export_assets"))
JCIP_LAYOUT_PARAMS = {"w": 11419, "h": 15600, "l": 907, "r": 907, "t": 623, "b": 284, "cs": 424}
SAFE_ENV_KEYS = ("PATH", "SystemRoot", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LANG", "LC_ALL")


class ProjectLockPool:
    """线程安全的按项目加锁池。"""

    def __init__(self) -> None:
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def get(self, pid: str) -> threading.Lock:
        with self._guard:
            lock = self._locks.get(pid)
            if lock is None:
                lock = threading.Lock()
                self._locks[pid] = lock
            return lock


def copy_docx_assets(dst_dir: str) -> None:
    """复制 reference.docx / CSL / Lua 过滤器等导出资产到目标目录。"""
    os.makedirs(dst_dir, exist_ok=True)
    if not os.path.isdir(DOCX_ASSETS_DIR):
        return
    for fn in os.listdir(DOCX_ASSETS_DIR):
        src = os.path.join(DOCX_ASSETS_DIR, fn)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(dst_dir, fn))


def clean_local_env(extra: dict[str, str] | None = None, *, inherit_all: bool = False) -> dict[str, str]:
    """构造本地 pandoc 子进程环境变量（默认仅透传安全系统键，避免泄漏应用机密）。"""
    env = dict(os.environ) if inherit_all else {k: v for k, v in os.environ.items() if k in SAFE_ENV_KEYS}
    if extra:
        env.update(extra)
    return env


def jcip_layout_env(pg: dict[str, int] | None = None, *, title_pg: bool = True) -> dict[str, str]:
    """生成 layout.lua 所需的版式环境变量字典。"""
    p = pg or JCIP_LAYOUT_PARAMS
    return {
        "LAYOUT_PAGE_W": str(p["w"]),
        "LAYOUT_PAGE_H": str(p["h"]),
        "LAYOUT_MAR_L": str(p["l"]),
        "LAYOUT_MAR_R": str(p["r"]),
        "LAYOUT_MAR_T": str(p["t"]),
        "LAYOUT_MAR_B": str(p["b"]),
        "LAYOUT_COL_SPACE": str(p["cs"]),
        "LAYOUT_TITLE_PG": "1" if title_pg else "0",
    }


def ensure_runtime_ready(
    runtime: str | None = None,
    *,
    docker_msg: str | None = None,
    local_msg: str | None = None,
    which_fn=shutil.which,
) -> str:
    """校验导出/转换运行时可执行文件是否存在，缺失抛出 503 ProjectError。"""
    rt = runtime or getattr(config, "DOCX_EXPORT_RUNTIME", "local")
    if rt == "docker":
        if not which_fn("docker"):
            raise ProjectError(
                docker_msg or "导出运行时为 docker，但当前环境不可用（或改用 PATENT_STUDIO_DOCX_EXPORT_RUNTIME=local）",
                503,
            )
    else:
        if not which_fn(config.DOCX_EXPORT_PANDOC):
            raise ProjectError(
                local_msg or "导出运行时为 local，但镜像内未找到 pandoc（部署镜像应内置）",
                503,
            )
    return rt


def local_pandoc_version(binary: str | None = None, *, timeout_s: int = 30, subprocess_run=subprocess.run) -> str:
    """探测本地 pandoc 首行版本号，失败返回 unavailable 说明。"""
    exe = binary or config.DOCX_EXPORT_PANDOC or "pandoc"
    try:
        proc = subprocess_run([exe, "--version"], capture_output=True, text=True, timeout=timeout_s)
        return (proc.stdout.splitlines() or ["?"])[0].strip()
    except Exception as e:  # noqa: BLE001
        return f"unavailable: {e}"


def run_pandoc_local(
    args: list[str],
    *,
    cwd: str,
    timeout_s: int,
    env: dict[str, str],
    binary: str | None = None,
    log_file: str | None = None,
    use_task_runner: bool = False,
    run_task_fn=None,
    subprocess_run=subprocess.run,
) -> tuple[int, str, str]:
    """在本地进程执行 pandoc，返回 `(rc, stdout, stderr)`；超时统一返回 `(-1, "", "转换超时")`."""
    exe = binary or config.DOCX_EXPORT_PANDOC or "pandoc"
    cmd = [exe, *args]
    if use_task_runner:
        runner = run_task_fn or task_runner.run_task
        rc = runner(cmd, cwd=cwd, timeout_s=timeout_s, log_file=log_file, env=env)
        err = ""
        if log_file and os.path.isfile(log_file):
            with open(log_file, encoding="utf-8", errors="replace") as f:
                err = f.read()
        return rc, "", err
    try:
        proc = subprocess_run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_s,
            env=env,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "转换超时"


def run_pandoc_docker(
    *,
    mount_dir: str,
    workdir: str,
    cmd: str,
    env_vars: dict[str, str] | None = None,
    image: str | None = None,
    timeout_s: int = 120,
    subprocess_run=subprocess.run,
) -> tuple[int, str, str]:
    """在 `docker run --rm` 临时容器中执行 pandoc shell 命令，返回 `(rc, stdout, stderr)`."""
    env_flags: list[str] = []
    for k, v in (env_vars or {}).items():
        env_flags += ["-e", f"{k}={v}"]
    docker_cmd = [
        "docker",
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        "-v",
        f"{mount_dir.replace(os.sep, '/')}:/proj",
        "-w",
        workdir,
        *env_flags,
        image or config.DOCX_EXPORT_IMAGE,
        "-c",
        cmd,
    ]
    try:
        proc = subprocess_run(
            docker_cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_s,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "转换超时"


def list_export_manifests(
    base_dir: str,
    current_digest: dict,
    artifact_names: tuple[str, ...],
    *,
    include_artifacts: bool = False,
    strict_json: bool = False,
) -> list[dict]:
    """按导出目录倒序读取 manifest 并标记是否过期。"""
    out: list[dict] = []
    if not os.path.isdir(base_dir):
        return out
    for eid in sorted(os.listdir(base_dir), reverse=True):
        mp = os.path.join(base_dir, eid, "manifest.json")
        if not os.path.isfile(mp):
            continue
        if strict_json:
            with open(mp, encoding="utf-8") as f:
                m = json.load(f)
        else:
            try:
                with open(mp, encoding="utf-8") as f:
                    m = json.load(f)
            except ValueError:
                continue
        m["stale"] = m.get("digest") != current_digest
        m["export_id"] = eid
        if include_artifacts:
            m["artifacts"] = {n: n for n in artifact_names if os.path.isfile(os.path.join(base_dir, eid, n))}
        out.append(m)
    return out


def resolve_export_artifact(
    base_dir: str,
    eid: str,
    name: str,
    artifact_names: tuple[str, ...],
    *,
    not_found_msg: str = "产物不存在",
) -> str:
    """安全校验导出 ID 与白名单产物名并返回绝对文件路径。"""
    if eid != os.path.basename(eid) or not eid:
        raise ProjectError("非法导出 ID", 400)
    if name not in artifact_names:
        raise ProjectError("非法产物名", 400)
    p = os.path.join(base_dir, eid, name)
    if not os.path.isfile(p):
        raise ProjectError(not_found_msg, 404)
    return p
