# -*- coding: utf-8 -*-
"""per-project GitHub/Gitea 推拉（v0.6.8，#5）：学生把论文工程推到自己仓库的轻量 git-bridge。

底座是 v0.6.6 的 per-project git（.studio/history，与专利线同库但 LaTeX 线黑名单 exclude）——
remote 配置与推拉只作用于已提交内容（exclude 之外的全部源文件），.studio/ 产物永不外发。

存储：`<project>/.studio/git-remote.json` = {url, branch, token}（数据卷内随备份走）；
api token 明文落盘与 user-ai 同口径，**接口永不回传**（GET 返回 masked）。

安全边界：
- URL 仅接受 https://（拒绝 ssh/file/本地路径——服务器不出站到任意协议）；
- 推拉时 token 以 x-access-token 注入 URL，只进子进程 argv 环境之外的部分——错误信息一律
  清洗 token 后再返回/记录；GIT_TERMINAL_PROMPT=0 防交互挂死；
- push 前总是先 commit（快照本次工作区，语义同编译快照）；pull 只做 fast-forward，
  分叉（本地与远端各有提交）一律 409 拒绝——防丢稿工具不做会覆盖本地修改的合并。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess

from app import atomic
from app.domain import latex_history
from app.domain.projects import ProjectError

REMOTE_FILE = os.path.join(".studio", "git-remote.json")
_TIMEOUT_S = 180


def remote_path(project) -> str:
    return os.path.join(project.dir, REMOTE_FILE)


def _origin(url: str) -> str:
    """https://github.com/u/r.git → https://github.com（凭据绑定来源：令牌绝不跨 host 复用）。"""
    rest = url.split("://", 1)[1] if "://" in url else url
    return url.split("://", 1)[0] + "://" + rest.split("/", 1)[0]


def load_remote(project) -> dict | None:
    p = remote_path(project)
    if not os.path.isfile(p):
        return None
    try:
        with open(p, encoding="utf-8") as f:
            row = json.load(f)
    except (OSError, ValueError):
        return None
    url = str(row.get("url") or "")
    if not url.lower().startswith("https://"):
        return None
    return {"url": url, "branch": str(row.get("branch") or "main"),
            "token": str(row.get("token") or ""), "origin": str(row.get("origin") or _origin(url))}


def masked_out(row: dict | None) -> dict | None:
    """GET 语义：url 打码 token 段、has_token 布尔；token 永不回传。"""
    if row is None:
        return None
    url = row["url"]
    if "@" in url and "://" in url:
        # 用户把 token 直接拼在 URL 里的形态也打码掉凭据段
        scheme, rest = url.split("://", 1)
        if "@" in rest:
            host = rest.split("@", 1)[1]
            url = f"{scheme}://***@{host}"
    return {"url": url, "branch": row["branch"], "has_token": bool(row.get("token"))}


def save_remote(project, url: str, branch: str, token: str = "") -> dict:
    url = (url or "").strip()
    branch = (branch or "main").strip() or "main"
    if not url.lower().startswith("https://"):
        raise ProjectError("仓库地址必须以 https:// 开头（不支持 ssh/file 协议）", 422)
    if any(c.isspace() for c in url) or ".." in url:
        raise ProjectError("仓库地址格式非法", 422)
    if not re_branch_ok(branch):
        raise ProjectError("分支名非法", 422)
    row = {"url": url, "branch": branch, "token": (token or "").strip()}
    if not row["token"]:
        prev = load_remote(project)
        if prev and prev["token"] and prev.get("origin") == _origin(url):
            row["token"] = prev["token"]  # 留空=保留已存 token（仅限同一来源 host；换源必须重新提供）
        elif prev and prev["token"]:
            row["origin"] = _origin(url)  # 换源且未提供新令牌：旧令牌作废，落库无 token
    row["origin"] = row.get("origin") or _origin(url)
    atomic.write_json(remote_path(project), row)
    return row


def re_branch_ok(branch: str) -> bool:
    import re as _re

    return bool(_re.fullmatch(r"[A-Za-z0-9._/\-]{1,120}", branch)) and not branch.startswith(".") and ".." not in branch


def delete_remote(project) -> bool:
    p = remote_path(project)
    if os.path.isfile(p):
        os.remove(p)
        return True
    return False


def _authed_url(row: dict) -> str:
    if not row["token"]:
        return row["url"]
    # https://user/repo.git → https://x-access-token:TOKEN@user/repo.git（GitHub/Gitea 通用 PAT 形态）
    scheme, rest = row["url"].split("://", 1)
    return f"{scheme}://x-access-token:{row['token']}@{rest}"


def _clean(err: str, row: dict) -> str:
    if row.get("token"):
        err = err.replace(row["token"], "***")
    return err.strip()[:400]


def _run_git(project_dir: str, *args: str, timeout: int = _TIMEOUT_S) -> subprocess.CompletedProcess:
    """history._run 的同环境（GIT_DIR/GIT_WORK_TREE/autocrlf=input）+ 防交互；返回原始进程（调用方清洗）。"""
    env = dict(os.environ)
    env.update({
        "GIT_DIR": latex_history.git_dir(project_dir),
        "GIT_WORK_TREE": project_dir,
        "GIT_TERMINAL_PROMPT": "0",
        "LC_ALL": "C",
    })
    g = shutil.which("git")
    if g is None:
        raise ProjectError("git 不可用：服务器未安装 git", 503)
    return subprocess.run(
        [g, "-c", "commit.gpgsign=false", "-c", "core.autocrlf=input", *args],
        cwd=project_dir, env=env, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=timeout, check=False,
    )


def status(project) -> dict:
    """远端配置（masked）+ 本地相对上次 fetch 的 ahead/behind（无 fetch 记录则 null，不自动联网）。"""
    row = load_remote(project)
    out: dict = {"remote": masked_out(row), "ahead": None, "behind": None, "head": latex_history.head(project.dir)}
    if row is None:
        return out
    branch = row["branch"]
    r = _run_git(project.dir, "rev-list", "--left-right", "--count", f"HEAD...refs/remotes/origin/{branch}")
    if r.returncode == 0:
        ahead, _, behind = r.stdout.strip().partition("\t")
        out["ahead"], out["behind"] = int(ahead or 0), int(behind or 0)
    return out


def _ensure_remote_ref(project_dir: str, row: dict, sha: str | None = None) -> None:
    """把远端状态固化为 refs/remotes/origin/<branch>（供 status 与 ff 判断）。
    fetch 后无 sha ⇒ 用 FETCH_HEAD；push 后必须显式传 HEAD（此时没有 FETCH_HEAD）。"""
    value = sha if sha is not None else "FETCH_HEAD"
    _run_git(project_dir, "update-ref", f"refs/remotes/origin/{row['branch']}", value)


def push(project, force: bool = False) -> dict:
    """提交当前工作区（快照）→ 推送 HEAD 到远端分支。返回 {ok, sha}；认证失败/冲突 → 4xx。
    force=True 覆盖远端（首推到已初始化仓库/确认放弃远端版本时用；前端须显式确认）。"""
    row = load_remote(project)
    if row is None:
        raise ProjectError("尚未配置远端仓库", 400)
    sha = latex_history.commit(project.dir, "sync", force=True)
    head = latex_history.head(project.dir)
    if head is None:
        raise ProjectError("工程没有任何可推送的提交", 422)
    args = ["push"]
    if force:
        args.append("--force")
    args += [_authed_url(row), f"HEAD:refs/heads/{row['branch']}"]
    r = _run_git(project.dir, *args)
    if r.returncode != 0:
        err = _clean(r.stderr, row)
        low = err.lower()
        if "403" in err or "denied" in low or "authentication" in low or "invalid username" in low:
            raise ProjectError(f"推送被拒绝（检查 token 权限/仓库地址）：{err}", 403)
        if "fetch first" in low or "non-fast-forward" in low or "[rejected]" in err:
            raise ProjectError(
                "远端有本地没有的提交（推送被拒）。若远端内容可以覆盖（如仅是仓库初始化的 README），"
                "可选择「强制推送」；否则请先在另一台机器处理远端。",
                409)
        raise ProjectError(f"推送失败：{err}", 502)
    _ensure_remote_ref(project.dir, row, head)
    return {"ok": True, "sha": head, "committed": sha is not None, "forced": force}


_PROTECTED_PATHS = ("studio.json", ".studio/")


_PROTECTED_EXACT = {"studio.json", "case.json", ".studio", "reviews"}
_PROTECTED_PREFIX = (".studio/", "reviews/")


def _audit_remote_tree(project_dir: str, remote_ref: str, row: dict) -> None:
    """拉取改写工作区前审计远端文件树（ff 与 force 都先过这道闸）：
    - 平台内部文件/目录（studio.json、case.json、.studio、reviews 的根与内容）
      出现在远端时拒绝——覆盖它们等于改写工程类型与远端配置或丢评论（reviews
      作为普通文件/gitlink 时不带斜杠，须按精确名拦）；
    - 符号链接（120000）与子模块（160000）一律拒绝——检出会把平台写入路径
      （.studio/**）引到工程目录之外，等于逃逸出项目沙盒。
    用 -z 原始路径：非 -z 输出会按 core.quotePath 把非 ASCII 转义成带引号的
    八进制串，前缀检查可能漏配。"""
    ls = _run_git(project_dir, "ls-tree", "-r", "-z", remote_ref)
    if ls.returncode != 0:
        raise ProjectError(f"读取远端文件树失败：{_clean(ls.stderr, row)}", 502)
    blocked, unsafe = set(), set()
    for entry in ls.stdout.split("\0"):
        if not entry or "\t" not in entry:
            continue
        meta, path = entry.split("\t", 1)
        mode = meta.split()[0]
        if path in _PROTECTED_EXACT or any(path.startswith(p) for p in _PROTECTED_PREFIX):
            blocked.add(path)
        if mode in ("120000", "160000"):
            unsafe.add(path)
    if blocked:
        shown = "、".join(sorted(blocked)[:3]) + ("…" if len(blocked) > 3 else "")
        raise ProjectError(
            f"远端仓库包含平台内部文件（{shown}），拉取已拒绝——它们会覆盖工程类型、远端配置或评论数据。"
            "请先在远端仓库删除这些文件再重试。", 422)
    if unsafe:
        shown = "、".join(sorted(unsafe)[:3]) + ("…" if len(unsafe) > 3 else "")
        raise ProjectError(
            f"远端仓库包含符号链接或子模块（{shown}），拉取已拒绝——检出会把平台写入路径引到工程之外。",
            422)


def pull(project, force: bool = False) -> dict:
    """fetch 远端 → 仅 fast-forward：本地无独立提交时把工作区与 HEAD 快进到远端。
    分叉（本地与远端各有提交）→ 409（含 ahead/behind），绝不自动合并/覆盖；
    force=True 是显式逃生门：放弃本地独立提交，工作区与分支硬重置到远端（须前端二次确认）。
    两条路径都会先校验远端文件树不含平台内部文件（studio.json / .studio/**）。"""
    row = load_remote(project)
    if row is None:
        raise ProjectError("尚未配置远端仓库", 400)
    if not force:
        latex_history.commit(project.dir, "sync", force=True)
    before = latex_history.head(project.dir)
    r = _run_git(project.dir, "fetch", _authed_url(row), row["branch"])
    if r.returncode != 0:
        raise ProjectError(f"拉取失败：{_clean(r.stderr, row)}", 502)
    _ensure_remote_ref(project.dir, row)
    remote_ref = f"refs/remotes/origin/{row['branch']}"
    _audit_remote_tree(project.dir, remote_ref, row)
    if force:
        rr = _run_git(project.dir, "reset", "--hard", remote_ref)
        if rr.returncode != 0:
            raise ProjectError(f"强制拉取失败：{_clean(rr.stderr, row)}", 502)
        after = latex_history.head(project.dir)
        return {"ok": True, "changed": after != before, "ahead": 0, "behind": 0, "sha": after, "forced": True}
    cnt = _run_git(project.dir, "rev-list", "--left-right", "--count", f"HEAD...{remote_ref}")
    if cnt.returncode != 0:
        # 远端分支还没有任何提交（空仓库首推前的 pull）：按「远端无新提交」处理，不报错
        chk = _run_git(project.dir, "rev-parse", "--verify", "-q", remote_ref, check=False)
        if chk.returncode != 0:
            return {"ok": True, "changed": False, "ahead": 0, "behind": 0, "note": "remote_empty"}
        raise ProjectError(f"版本比较失败：{_clean(cnt.stderr, row)}", 502)
    ahead_s, _, behind_s = cnt.stdout.strip().partition("\t")
    ahead, behind = int(ahead_s or 0), int(behind_s or 0)
    if behind == 0:
        return {"ok": True, "changed": False, "ahead": ahead, "behind": 0}
    if ahead > 0:
        raise ProjectError(
            f"本地与远端各有修改（本地多 {ahead} 个提交、远端多 {behind} 个）——自动合并已拒绝。"
            "请先「推送」（会因非快进被拒并提示），或确认放弃本地提交后联系管理员处理。",
            409)
    ff = _run_git(project.dir, "merge", "--ff-only", remote_ref)
    if ff.returncode != 0:
        raise ProjectError(f"快进合并失败：{_clean(ff.stderr, row)}", 502)
    after = latex_history.head(project.dir)
    return {"ok": True, "changed": after != before, "ahead": 0, "behind": 0, "sha": after}
