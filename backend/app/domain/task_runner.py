# -*- coding: utf-8 -*-
"""LaTeX/DOCX 任务子进程的统一运行边界（v0.1 实验室发行版）。

- 全局并发信号量（默认单任务；满载立即 busy，不无限排队）；
- POSIX 子进程：独立进程组 + RLIMIT_AS/CPU，超时/失败后 killpg 清理整组
  （latexmk 会派生 perl/xelatex 子进程，仅 kill 父进程会留孤儿）；
- Windows 开发态：rlimit/进程组不可用，自动降级为普通子进程 + 超时 kill（如实降级）；
- 产物保留策略：只清理 .studio/latex-builds 与 .studio/docx-exports 两个派生产物目录
  （按目录名时间戳排序，超出保留代数的整目录删除）；绝不触碰用户源码/批注/配置。
"""
from __future__ import annotations

import errno
import os
import signal
import subprocess
import threading
import time

from app import config

_latex_slots = threading.BoundedSemaphore(max(1, config.LATEX_CONCURRENCY))
_docx_slots = threading.BoundedSemaphore(max(1, config.DOCX_EXPORT_CONCURRENCY))


class Busy(Exception):
    """并发上限已满：调用方映射为 429。"""

    def __init__(self, what: str):
        super().__init__(f"{what}并发已满（上限 {config.LATEX_CONCURRENCY}），请稍后重试")
        self.what = what


class _Slot:
    def __init__(self, sem: threading.BoundedSemaphore, what: str):
        self.sem = sem
        self.what = what
        self.acquired = False

    def acquire(self, blocking: bool = True) -> bool:
        """有限排队：满载时等待 TASK_QUEUE_WAIT_S，超时返回 False（调用方映射 429）。"""
        if self.sem.acquire(blocking=False):
            self.acquired = True
            return True
        if not blocking:
            return False
        deadline = time.time() + max(0, config.TASK_QUEUE_WAIT_S)
        while time.time() < deadline:
            time.sleep(0.2)
            if self.sem.acquire(blocking=False):
                self.acquired = True
                return True
        return False

    def __enter__(self):
        if not self.acquire():
            raise Busy(self.what)
        return self

    def __exit__(self, *exc):
        if self.acquired:
            self.sem.release()
        return False


def latex_slot() -> _Slot:
    return _Slot(_latex_slots, "LaTeX 编译")


def docx_slot() -> _Slot:
    return _Slot(_docx_slots, "DOCX 导出")


def _preexec() -> None:  # pragma: no cover - 仅 POSIX 子进程内执行
    os.setsid()
    try:
        import resource

        gb = int(config.LATEX_RLIMIT_AS_GB * 1024 * 1024 * 1024)
        if gb > 0:
            resource.setrlimit(resource.RLIMIT_AS, (gb, gb))
        cpu = config.LATEX_RLIMIT_CPU_S
        if cpu > 0:
            resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 10))
    except (ValueError, OSError):
        pass  # 限制不适用/被拒时不阻断任务（wall timeout 仍兜底）


def run_task(
    cmd: list[str],
    cwd: str,
    timeout_s: int,
    log_file=None,
    env: dict | None = None,
    on_proc=None,
) -> int:
    """运行编译/转换子进程：独立进程组 + rlimit；超时 killpg 清理整组。
    on_proc(proc) 在 Popen 后立即回调（取消功能借此拿到进程句柄）。
    返回退出码；超时抛 TimeoutExpired（语义与 subprocess.run 一致）。
    Windows 无 setsid/killpg：降级为普通子进程（开发态边界 weaker，如实记录）。"""
    logf = open(log_file, "w", encoding="utf-8", errors="replace") if log_file else subprocess.PIPE
    try:
        kwargs: dict = {}
        if os.name == "posix":
            kwargs["preexec_fn"] = _preexec
        proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            env=env,
            stdout=logf if log_file else subprocess.PIPE,
            stderr=subprocess.STDOUT if log_file else subprocess.PIPE,
            text=True,
            errors="replace",
            **kwargs,
        )
        if on_proc is not None:
            on_proc(proc)
        try:
            proc.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            _terminate_group(proc)
            raise
        return proc.returncode
    finally:
        if logf is not subprocess.PIPE:
            logf.close()


def terminate(proc: subprocess.Popen) -> None:
    """主动中止任务子进程（整组）：编译取消用。已退出的进程静默忽略。"""
    if proc.poll() is not None:
        return
    try:
        _terminate_group(proc)
    except OSError:
        pass


def _terminate_group(proc: subprocess.Popen) -> None:
    if os.name == "posix":
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            return
        except (ProcessLookupError, PermissionError, errno.ESRCH):
            pass
    proc.kill()


def prune_dirs(base: str, keep: int) -> list[str]:
    """派生产物保留策略：base 下按名排序（时间戳前缀），仅删除超出 keep 的整目录。
    base 不存在或 keep<0（不限）时不动。返回被删目录名。调用方保证 base 为派生产物目录。"""
    if keep < 0 or not os.path.isdir(base):
        return []
    names = sorted(n for n in os.listdir(base) if os.path.isdir(os.path.join(base, n)))
    removed = names[:-keep] if len(names) > keep else []
    for n in removed:
        import shutil

        shutil.rmtree(os.path.join(base, n), ignore_errors=True)
    return removed
