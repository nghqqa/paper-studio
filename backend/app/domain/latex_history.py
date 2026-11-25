# -*- coding: utf-8 -*-
"""LaTeX 工程版本历史（防丢稿最后保险）：同一套 per-project git（<project>/.studio/history）。

与专利线 app.domain.history 的关系：同一把 repo_lock、同一套 git 调用环境，但两线项目互斥
（一个项目非 latex 即 markdown），跟踪范围不同——专利线白名单（content.md/docs/case.json），
LaTeX 线黑名单（只排除平台内部区，跟踪文件面板可见的全部源文件，含图片/PDF 二进制资源：
图被误覆盖同样可救回）。

提交粒度（打字停顿 2s 自动保存太密，逐保存提交会产生海量噪声版本）：
- 编译前总是提交（「build」）：编译过的状态必在历史里；
- 保存走时间合并：距上次提交 ≥ COALESCE_S 才提交「save <rel>」；合并窗口内的改动留在
  工作区，由下一次编译/结构性操作兜底；
- 结构性操作（新建/上传/ZIP 合并/重命名/删除/文献写回 .bib）总是提交；
- 恢复：整树写回目标版本（目标树全部文件写回 + 删除源可见但目标树没有的文件）后提交
  「restore <sha7>」；树相同则不提交（changed=false，与专利线口径一致）。

git 缺失 ⇒ 提交静默跳过（保存不受影响，与专利线同口径）；读操作抛 GitUnavailable。
"""

import os
import time

from app.domain.history import (  # noqa: F401  (_SHA_RE 随 resolve 间接复用)
    DEFAULT_AUTHOR,
    WORK,
    GitUnavailable,
    HistoryError,
    _git_bin,
    _run,
    _write_exclude,
    git_dir,
    repo_lock,
    resolve,
)

COALESCE_S = 90

LATEX_EXCLUDE = (
    "# 研稿 LaTeX 工程：跟踪源可见全量（文件面板范围），仅排除平台内部区\n"
    ".studio/\n"
    "__pycache__/\n"
    "reviews/\n"
    "studio.json\n"
    "content.md\n"
    "case.json\n"
    "project.json\n"
)

# 进程内「上次提交时刻」缓存（按工程目录真实路径）；重启后回落 git log 查询一次
_last_commit_at: dict[str, float] = {}


def _ensure_repo(project_dir: str) -> None:
    """不存在则 `git init -q -b main` 并写黑名单 exclude；已存在则幂等校正 exclude 内容。"""
    gd = git_dir(project_dir)
    exclude = os.path.join(gd, "info", "exclude")
    if os.path.isfile(os.path.join(gd, "HEAD")):
        _write_exclude(exclude, LATEX_EXCLUDE)
        return
    os.makedirs(gd, exist_ok=True)
    _run(project_dir, "init", "-q", "-b", "main")
    os.makedirs(os.path.join(gd, "info"), exist_ok=True)
    _write_exclude(exclude, LATEX_EXCLUDE)


def _last_commit(project_dir: str) -> float | None:
    """上次提交时刻（epoch 秒）：先查进程内缓存，未命中（重启后首次）回落 git log。"""
    key = os.path.realpath(project_dir)
    cached = _last_commit_at.get(key)
    if cached is not None:
        return cached
    if head(project_dir) is None:
        return None
    r = _run(project_dir, "log", "-1", "--format=%at", check=False)
    raw = r.stdout.strip()
    if not raw:
        return None
    try:
        at = float(raw)
    except ValueError:
        return None
    _last_commit_at[key] = at
    return at


def commit(project_dir: str, message: str, author: str | None = None, force: bool = False) -> str | None:
    """提交工作区当前状态（黑名单 exclude 之外的全部变化）；返回 sha，无变化/git 缺失 ⇒ None。

    force=False（保存路径）按 COALESCE_S 时间合并：距上次提交不足窗口 ⇒ 跳过本次
    （改动留工作区，等下一次编译/结构性操作兜底），避免自动保存刷屏版本列表。
    """
    if _git_bin() is None:
        return None
    key = os.path.realpath(project_dir)
    with repo_lock(project_dir):
        _ensure_repo(project_dir)
        if not force:
            last = _last_commit(project_dir)
            if last is not None and time.time() - last < COALESCE_S:
                return None
        _run(project_dir, "add", "-A")
        if _run(project_dir, "diff", "--cached", "--quiet", check=False).returncode == 0:
            _last_commit_at[key] = time.time()
            return None
        _run(project_dir, "commit", "-q", "-m", message, author=author)
        _last_commit_at[key] = time.time()
        return head(project_dir)


def head(project_dir: str) -> str | None:
    r = _run(project_dir, "rev-parse", "--verify", "-q", "HEAD", check=False)
    return r.stdout.strip() or None


def log(project_dir: str, limit: int = 200) -> list[dict]:
    """[{sha, at, message, author, added, deleted, files}] 新→旧（上限 limit）。
    行数统计跨全部文件求和（二进制文件的 numstat 为「-」，只计入 files 数）。"""
    if _git_bin() is None or head(project_dir) is None:
        return []
    out = _run(
        project_dir,
        "log",
        f"--max-count={max(1, min(limit, 500))}",
        "--format=%x1e%H%x1f%at%x1f%an%x1f%s",
        "--numstat",
    ).stdout
    versions = []
    for rec in out.split("\x1e"):
        if not rec.strip():
            continue
        header, _, stat = rec.partition("\n")
        sha, at, author, message = header.split("\x1f", 3)
        added = deleted = files = 0
        for ln in stat.splitlines():
            parts = ln.split("\t")
            if len(parts) == 3 and parts[2]:
                files += 1
                if parts[0].isdigit() and parts[1].isdigit():
                    added += int(parts[0])
                    deleted += int(parts[1])
        versions.append(
            {
                "sha": sha,
                "at": int(at),
                "message": message,
                "author": author,
                "added": added,
                "deleted": deleted,
                "files": files,
            }
        )
    return versions


def diff(project_dir: str, a: str, b: str = WORK) -> str:
    """整树 unified diff；b="work" 表示工作区。二进制文件显示为「Binary files … differ」。"""
    a = resolve(project_dir, a)
    refs = [a] if b == WORK else [a, resolve(project_dir, b)]
    return _run(project_dir, "diff", "--no-color", *refs).stdout


def restore(project_dir: str, sha: str, author: str | None = None) -> dict:
    """整树写回目标版本并提交「restore <sha7>」。返回 {sha_new, changed, written, deleted}。

    工作区目标树之外的源可见文件一律删除（含从未提交过的新文件）——恢复=工作区精确回到
    目标状态；二进制按字节写回（cat-file blob，不走 text 解码）。全程持 repo_lock，
    与并发保存/编译提交互斥。"""
    from app.domain.latex_build import (
        LATEX_SOURCE_EXCLUDE_DIRS,  # 延迟导入：latex_build 亦引用本模块
        _is_source_rel,
    )

    full = resolve(project_dir, sha)
    root = os.path.realpath(project_dir)
    with repo_lock(project_dir):
        _ensure_repo(project_dir)
        ls = _run(project_dir, "ls-tree", "-r", "--name-only", "-z", full).stdout
        target = [p for p in ls.split("\0") if p]
        written = 0
        for rel in target:
            data = _run(project_dir, "cat-file", "blob", f"{full}:{rel}", binary=True).stdout
            p = os.path.join(root, *rel.split("/"))
            os.makedirs(os.path.dirname(p) or root, exist_ok=True)
            with open(p, "wb") as f:
                f.write(data)
            written += 1
        target_set = set(target)
        deleted: list[str] = []
        for base, dirs, files in os.walk(root):
            rel_base = os.path.relpath(base, root).replace(os.sep, "/")
            dirs[:] = [d for d in dirs if d not in LATEX_SOURCE_EXCLUDE_DIRS]
            for fn in files:
                rel = fn if rel_base == "." else f"{rel_base}/{fn}"
                if rel in target_set or not _is_source_rel(rel):
                    continue
                os.remove(os.path.join(base, fn))
                deleted.append(rel)
        # 收掉因删除而空掉的目录（绝不碰根本身）
        for rel in deleted:
            d = os.path.dirname(os.path.join(root, *rel.split("/")))
            while os.path.realpath(d) != root:
                try:
                    os.rmdir(d)
                except OSError:
                    break
                d = os.path.dirname(d)
        _run(project_dir, "add", "-A")
        changed = _run(project_dir, "diff", "--cached", "--quiet", check=False).returncode != 0
        sha_new = head(project_dir)
        if changed:
            _run(project_dir, "commit", "-q", "-m", f"restore {full[:7]}", author=author)
            _last_commit_at[os.path.realpath(project_dir)] = time.time()
            sha_new = head(project_dir)
        return {"sha_new": sha_new, "changed": changed, "written": written, "deleted": deleted}
