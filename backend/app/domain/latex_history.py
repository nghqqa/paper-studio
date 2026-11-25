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

import json
import os
import re
import shutil
import time

from app import atomic
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
MILESTONES_FILE = os.path.join(".studio", "milestones.json")
_MILESTONE_RE = re.compile(r"^[^\x00-\x1f/\\]{1,48}$")

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


def list_milestones(project_dir: str) -> list[dict]:
    """读取命名里程碑列表（新→旧）。"""
    path = os.path.join(project_dir, MILESTONES_FILE)
    if not os.path.isfile(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return []
    if not isinstance(raw, list):
        return []
    rows = [
        {
            "name": str(m.get("name") or ""),
            "sha": str(m.get("sha") or ""),
            "at": int(m.get("at") or 0),
            "author": str(m.get("author") or DEFAULT_AUTHOR),
        }
        for m in raw
        if isinstance(m, dict) and m.get("name") and m.get("sha")
    ]
    return sorted(rows, key=lambda m: m["at"], reverse=True)


def create_milestone(project_dir: str, name: str, sha: str | None = None, author: str | None = None) -> dict:
    """标记命名里程碑；未传 sha 时若工作区有未提交改动先快照再标记当前 HEAD。"""
    clean_name = (name or "").strip()
    if not _MILESTONE_RE.match(clean_name):
        raise HistoryError("里程碑名称须为 1–48 个字符，且不能包含斜杠或换行", 422)
    if _git_bin() is None:
        raise GitUnavailable()
    with repo_lock(project_dir):
        _ensure_repo(project_dir)
        rows = list_milestones(project_dir)
        if any(m["name"] == clean_name for m in rows):
            raise HistoryError(f"里程碑「{clean_name}」已存在", 409)
        if sha:
            target_sha = resolve(project_dir, sha)
        else:
            _run(project_dir, "add", "-A")
            if _run(project_dir, "diff", "--cached", "--quiet", check=False).returncode != 0:
                _run(project_dir, "commit", "-q", "-m", f"milestone {clean_name}", author=author)
                _last_commit_at[os.path.realpath(project_dir)] = time.time()
            target_sha = head(project_dir)
            if target_sha is None:
                raise HistoryError("当前工程暂无可标记的版本，请先保存或编译一次", 422)
        entry = {
            "name": clean_name,
            "sha": target_sha,
            "at": int(time.time()),
            "author": (author or DEFAULT_AUTHOR).strip() or DEFAULT_AUTHOR,
        }
        rows = [entry, *rows][:50]
        atomic.write_json(os.path.join(project_dir, MILESTONES_FILE), rows)
        return entry


def delete_milestone(project_dir: str, name: str) -> bool:
    """删除指定名称的里程碑标签（不删 git 提交本身）。"""
    clean_name = (name or "").strip()
    if not clean_name:
        return False
    with repo_lock(project_dir):
        rows = list_milestones(project_dir)
        kept = [m for m in rows if m["name"] != clean_name]
        if len(kept) == len(rows):
            return False
        atomic.write_json(os.path.join(project_dir, MILESTONES_FILE), kept)
        return True


def log(project_dir: str, limit: int = 200) -> list[dict]:
    """[{sha, at, message, author, added, deleted, files, milestones}] 新→旧（上限 limit）。
    行数统计跨全部文件求和（二进制文件的 numstat 为「-」，只计入 files 数）。"""
    if _git_bin() is None or head(project_dir) is None:
        return []
    by_sha: dict[str, list[str]] = {}
    for m in list_milestones(project_dir):
        by_sha.setdefault(m["sha"], []).append(m["name"])
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
                "milestones": by_sha.get(sha, []),
            }
        )
    return versions


def diff(project_dir: str, a: str, b: str = WORK) -> str:
    """整树 unified diff；b="work" 表示工作区。二进制文件显示为「Binary files … differ」。"""
    a = resolve(project_dir, a)
    refs = [a] if b == WORK else [a, resolve(project_dir, b)]
    return _run(project_dir, "diff", "--no-color", *refs).stdout


def export_tree(project_dir: str, ref: str, dst_dir: str) -> None:
    """将指定提交或当前工作区（ref='work'）的源可见文件完整导出到 dst_dir。"""
    from app.domain.latex_build import LATEX_SOURCE_EXCLUDE_DIRS, _is_source_rel

    os.makedirs(dst_dir, exist_ok=True)
    dst_real = os.path.realpath(dst_dir)
    if ref == WORK:
        root = os.path.realpath(project_dir)
        for base, dirs, files in os.walk(root):
            rel_base = os.path.relpath(base, root).replace(os.sep, "/")
            dirs[:] = [d for d in dirs if d not in LATEX_SOURCE_EXCLUDE_DIRS]
            for fn in files:
                rel = fn if rel_base == "." else f"{rel_base}/{fn}"
                if not _is_source_rel(rel):
                    continue
                target = os.path.realpath(os.path.join(dst_real, *rel.split("/")))
                if target != dst_real and not target.startswith(dst_real + os.sep):
                    continue
                os.makedirs(os.path.dirname(target), exist_ok=True)
                shutil.copy2(os.path.join(base, fn), target)
        return

    full = resolve(project_dir, ref)
    ls = _run(project_dir, "ls-tree", "-r", "--name-only", "-z", full).stdout
    for rel in (p for p in ls.split("\0") if p):
        target = os.path.realpath(os.path.join(dst_real, *rel.split("/")))
        if target != dst_real and not target.startswith(dst_real + os.sep):
            continue
        data = _run(project_dir, "cat-file", "blob", f"{full}:{rel}", binary=True).stdout
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "wb") as f:
            f.write(data)


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
