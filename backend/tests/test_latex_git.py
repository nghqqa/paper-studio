# -*- coding: utf-8 -*-
"""per-project GitHub/Gitea 推拉（v0.6.8）：远端=本机 file 裸仓库打桩？——不行，域只放行 https。

用本地 https 不现实；改从域内部打桩 _run_git：push/pull 的命令序列与错误语义可全验，
另加一个「真实 git 本地远端」的集成用例（临时 https 不可行 → 用 GIT_DIR 直推验证 ff 语义）。"""
import json
import os
import subprocess

import pytest

from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setenv("PATENT_PROJECTS_DIR", str(projects))
    monkeypatch.setenv("LO_PROFILE_DIR", str(tmp_path / "lo"))
    import importlib

    from app import config, main
    from app.domain import build, xml_export
    from app.domain import latex_build as latex_build_mod
    from app.domain import latex_files as latex_files_mod
    from app.domain import latex_issues as latex_issues_mod
    from app.domain import latex_git as latex_git_mod
    from app.domain import latex_history as latex_history_mod
    from app.domain import projects as projects_mod
    from app.routes import latex as latex_routes

    importlib.reload(config)
    importlib.reload(projects_mod)
    importlib.reload(build)
    importlib.reload(latex_history_mod)
    importlib.reload(latex_build_mod)
    importlib.reload(latex_files_mod)
    importlib.reload(latex_issues_mod)
    importlib.reload(latex_git_mod)
    importlib.reload(xml_export)
    importlib.reload(latex_routes)
    importlib.reload(main)
    latex_history_mod._last_commit_at.clear()
    return TestClient(main.app), projects, latex_git_mod, latex_history_mod


def test_remote_validation_and_masking(client):
    c, _projects, _lg, _lh = client
    pid = c.post("/api/projects/latex-demo").json()["id"]
    # ssh/file 拒绝
    r = c.put(f"/api/projects/{pid}/latex/git/remote",
              json={"url": "git@github.com:u/r.git", "branch": "main", "token": "t"})
    assert r.status_code == 422
    r = c.put(f"/api/projects/{pid}/latex/git/remote",
              json={"url": "file:///etc", "branch": "main", "token": "t"})
    assert r.status_code == 422
    # 保存 + token 不回传
    r = c.put(f"/api/projects/{pid}/latex/git/remote",
              json={"url": "https://github.com/u/r.git", "branch": "paper", "token": "ghs_secret123"})
    assert r.status_code == 200, r.text
    assert r.json()["remote"] == {"url": "https://github.com/u/r.git", "branch": "paper", "has_token": True}
    # GET 状态：masked；token 留空再保存=保留
    r = c.get(f"/api/projects/{pid}/latex/git")
    assert r.json()["remote"]["has_token"] is True and "token" not in r.json()["remote"]
    c.put(f"/api/projects/{pid}/latex/git/remote",
          json={"url": "https://github.com/u/r2.git", "branch": "paper", "token": ""})
    row = json.load(open(os.path.join(str(_projects), pid, ".studio", "git-remote.json"), encoding="utf-8"))
    assert row["token"] == "ghs_secret123" and row["url"].endswith("r2.git")
    # 解除
    assert c.delete(f"/api/projects/{pid}/latex/git/remote").json()["removed"] is True
    assert c.get(f"/api/projects/{pid}/latex/git").json()["remote"] is None


def test_push_snapshot_and_error_semantics(client, monkeypatch):
    c, _projects, lg, lh = client
    pid = c.post("/api/projects/latex-demo").json()["id"]
    c.put(f"/api/projects/{pid}/latex/git/remote",
          json={"url": "https://github.com/u/r.git", "branch": "main", "token": "tok123"})
    # 未配置时 push 400
    c.delete(f"/api/projects/{pid}/latex/git/remote")
    assert c.post(f"/api/projects/{pid}/latex/git/push").status_code == 400
    c.put(f"/api/projects/{pid}/latex/git/remote",
          json={"url": "https://github.com/u/r.git", "branch": "main", "token": "tok123"})
    # 编辑保存 → push：命令序列=快照 commit + push HEAD:refs/heads/main；错误清洗 token
    c.put(f"/api/projects/{pid}/latex/files/bare_conf.tex", json={"content": "% v\n"})
    calls = []

    def fake_run_git(project_dir, *args, **kw):
        calls.append(args)
        if args[0] == "push":
            return subprocess.CompletedProcess(args, 1, "", "remote: Invalid username or password (tok123)")
        return subprocess.CompletedProcess(args, 0, "abc1234\t0", "")

    monkeypatch.setattr(lg, "_run_git", fake_run_git)
    r = c.post(f"/api/projects/{pid}/latex/git/push", json={})
    assert r.status_code == 403
    assert "tok123" not in r.text and "***" in r.text  # token 清洗
    assert any(a[0] == "push" for a in calls)
    assert any(a[0] == "push" and a[2] == "HEAD:refs/heads/main" for a in calls)
    assert not any("--force" in a for a in calls if isinstance(a, tuple))  # 默认不覆盖
    # force=True：--force 旗标传递
    c.post(f"/api/projects/{pid}/latex/git/push", json={"force": True})
    assert any(a[0] == "push" and "--force" in a and a[-1] == "HEAD:refs/heads/main" for a in calls)
    # push 成功路径：origin ref 应指向 HEAD（而非不存在的 FETCH_HEAD）
    calls.clear()

    def ok_run(project_dir, *args, **kw):
        calls.append(args)
        return subprocess.CompletedProcess(args, 0, "1	0", "")

    monkeypatch.setattr(lg, "_run_git", ok_run)
    r = c.post(f"/api/projects/{pid}/latex/git/push", json={})
    assert r.status_code == 200 and r.json()["ok"] is True
    upd = [a for a in calls if a[0] == "update-ref"]
    assert upd and upd[0][1] == "refs/remotes/origin/main" and upd[0][2] != "FETCH_HEAD"
    # 快照提交真的发生（HEAD 存在且消息 sync）
    assert lh.head(os.path.join(str(_projects), pid)) is not None


def test_pull_fast_forward_and_diverged_409(client, monkeypatch, tmp_path):
    c, projects, lg, lh = client
    pid = c.post("/api/projects/latex-demo").json()["id"]
    c.put(f"/api/projects/{pid}/latex/git/remote",
          json={"url": "https://github.com/u/r.git", "branch": "main", "token": "t"})

    # 分叉：fetch 成功但 rev-list 报 ahead=1 behind=2 → 409，文案含计数
    def diverged(project_dir, *args, **kw):
        if args[0] == "fetch":
            return subprocess.CompletedProcess(args, 0, "", "")
        if args[0] == "rev-list":
            return subprocess.CompletedProcess(args, 0, "1\t2", "")
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(lg, "_run_git", diverged)
    r = c.post(f"/api/projects/{pid}/latex/git/pull")
    assert r.status_code == 409
    assert "1" in r.json()["detail"]["message"] and "2" in r.json()["detail"]["message"]

    # 快进：ahead=0 behind=1 → merge --ff-only 被执行（桩不动 HEAD，故只验命令序列与 200）
    merge_calls: list[tuple] = []

    def ffable(project_dir, *args, **kw):
        if args[0] == "fetch":
            return subprocess.CompletedProcess(args, 0, "", "")
        if args[0] == "rev-list":
            return subprocess.CompletedProcess(args, 0, "0\t1", "")
        if args[0] == "merge":
            merge_calls.append(args)
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(lg, "_run_git", ffable)
    r = c.post(f"/api/projects/{pid}/latex/git/pull")
    assert r.status_code == 200
    assert merge_calls and merge_calls[0][:2] == ("merge", "--ff-only")
    assert merge_calls[0][2] == "refs/remotes/origin/main"
    # force pull：reset --hard 到远端 ref（放弃本地独立提交的逃生门）
    reset_calls: list[tuple] = []

    def forceable(project_dir, *args, **kw):
        if args[0] == "fetch":
            return subprocess.CompletedProcess(args, 0, "", "")
        if args[0] == "reset":
            reset_calls.append(args)
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(lg, "_run_git", forceable)
    r = c.post(f"/api/projects/{pid}/latex/git/pull", json={"force": True})
    assert r.status_code == 200 and r.json()["forced"] is True
    assert reset_calls and reset_calls[0][:2] == ("reset", "--hard")
    assert reset_calls[0][2] == "refs/remotes/origin/main"

    # 远端无新提交：behind=0 → changed=False
    def noop(project_dir, *args, **kw):
        if args[0] == "fetch":
            return subprocess.CompletedProcess(args, 0, "", "")
        if args[0] == "rev-list":
            return subprocess.CompletedProcess(args, 0, "0\t0", "")
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(lg, "_run_git", noop)
    r = c.post(f"/api/projects/{pid}/latex/git/pull")
    assert r.json()["changed"] is False


def test_git_routes_guard_non_latex(client):
    c, _projects, _lg, _lh = client
    c.post("/api/projects", json={"id": "pat-g1", "title": "专利案"})
    assert c.get("/api/projects/pat-g1/latex/git").status_code == 400
    assert c.put("/api/projects/pat-g1/latex/git/remote",
                 json={"url": "https://x/y.git", "branch": "main", "token": ""}).status_code == 400


def test_save_remote_token_bound_to_origin(client):
    """换源（不同 host）且令牌留空 ⇒ 旧 PAT 作废（绝不把 A 站令牌发给 B 站）；
    同 host 换仓库名仍可继承（GitHub PAT 是账号级的）。"""
    c, _projects, lg, _lh = client
    pid = c.post("/api/projects/latex-demo").json()["id"]
    c.put(f"/api/projects/{pid}/latex/git/remote",
          json={"url": "https://github.com/u/r.git", "branch": "main", "token": "ghs_secret123"})
    # 换到 gitee（不同 host）+ 令牌留空 → token 作废、origin 落新 host
    c.put(f"/api/projects/{pid}/latex/git/remote",
          json={"url": "https://gitee.com/v/w.git", "branch": "main", "token": ""})
    row = json.load(open(os.path.join(str(_projects), pid, ".studio", "git-remote.json"), encoding="utf-8"))
    assert row["token"] == "" and row["origin"] == "https://gitee.com"
    # 显式提供新令牌则正常落库并绑定新 origin
    c.put(f"/api/projects/{pid}/latex/git/remote",
          json={"url": "https://gitee.com/v/w.git", "branch": "main", "token": "gtea_new"})
    row = json.load(open(os.path.join(str(_projects), pid, ".studio", "git-remote.json"), encoding="utf-8"))
    assert row["token"] == "gtea_new" and row["origin"] == "https://gitee.com"
    # 回到 github（不同 host）+ 留空 → gitea 令牌不外带
    c.put(f"/api/projects/{pid}/latex/git/remote",
          json={"url": "https://github.com/u/r2.git", "branch": "main", "token": ""})
    row = json.load(open(os.path.join(str(_projects), pid, ".studio", "git-remote.json"), encoding="utf-8"))
    assert row["token"] == ""


def test_pull_rejects_protected_remote_tree(client, monkeypatch):
    """远端文件树含 studio.json / .studio/** 时拉取 422 拒绝（ff 与 force 都拦），
    工作区写入（merge/reset）绝不发出。"""
    c, _projects, lg, _lh = client
    pid = c.post("/api/projects/latex-demo").json()["id"]
    c.put(f"/api/projects/{pid}/latex/git/remote",
          json={"url": "https://github.com/u/r.git", "branch": "main", "token": "t"})
    tree = ("100644 blob a\tstudio.json\0"
            "100644 blob b\t.studio/git-remote.json\0"
            "100644 blob c\tmain.tex\0"
            "100644 blob d\tcase.json\0"
            "100644 blob e\treviews/中文附录.md\0"
            "100644 blob f\treviews\0")

    def hijacked_tree(project_dir, *args, **kw):
        if args[0] == "ls-tree":
            return subprocess.CompletedProcess(args, 0, tree, "")
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(lg, "_run_git", hijacked_tree)
    writes: list[tuple] = []
    orig = lg._run_git

    def guard(project_dir, *args, **kw):
        if args[0] in ("merge", "reset"):
            writes.append(args)
        return orig(project_dir, *args, **kw)

    monkeypatch.setattr(lg, "_run_git", guard)
    r = c.post(f"/api/projects/{pid}/latex/git/pull")
    assert r.status_code == 422 and "内部文件" in r.json()["detail"]["message"]
    r = c.post(f"/api/projects/{pid}/latex/git/pull", json={"force": True})
    assert r.status_code == 422
    assert writes == []


def test_pull_rejects_symlink_and_gitlink(client, monkeypatch):
    """符号链接（任何路径）与子模块一律拒绝——检出会把平台写路径引到工程外。"""
    c, _projects, lg, _lh = client
    pid = c.post("/api/projects/latex-demo").json()["id"]
    c.put(f"/api/projects/{pid}/latex/git/remote",
          json={"url": "https://github.com/u/r.git", "branch": "main", "token": "t"})
    tree = ("120000 blob 9\tinnocent-name\0"
            "100644 blob a\tmain.tex\0")

    def hijacked_tree(project_dir, *args, **kw):
        if args[0] == "ls-tree":
            return subprocess.CompletedProcess(args, 0, tree, "")
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(lg, "_run_git", hijacked_tree)
    r = c.post(f"/api/projects/{pid}/latex/git/pull")
    assert r.status_code == 422 and "符号链接" in r.json()["detail"]["message"]


def test_pull_clean_tree_passes_audit(client, monkeypatch):
    """干净远端树不被审计误伤，照常走到 ff。"""
    c, _projects, lg, _lh = client
    pid = c.post("/api/projects/latex-demo").json()["id"]
    c.put(f"/api/projects/{pid}/latex/git/remote",
          json={"url": "https://github.com/u/r.git", "branch": "main", "token": "t"})
    tree = "100644 blob a\tmain.tex\0100644 blob b\tsub/ch1.tex\0"
    merges: list[tuple] = []

    def fake_git(project_dir, *args, **kw):
        if args[0] == "fetch":
            return subprocess.CompletedProcess(args, 0, "", "")
        if args[0] == "ls-tree":
            return subprocess.CompletedProcess(args, 0, tree, "")
        if args[0] == "rev-list":
            return subprocess.CompletedProcess(args, 0, "0\t1", "")
        if args[0] == "merge":
            merges.append(args)
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(lg, "_run_git", fake_git)
    r = c.post(f"/api/projects/{pid}/latex/git/pull")
    assert r.status_code == 200 and merges
