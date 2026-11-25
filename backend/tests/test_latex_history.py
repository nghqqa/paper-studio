# -*- coding: utf-8 -*-
import subprocess
import sys
import threading

import pytest

"""LaTeX 工程版本历史（防丢稿）+ 编译取消（v0.6.6）。

复用 test_latex_files_panel 的 client fixture 形态（tmp_path + 模块 reload 链），
reload 链插入 latex_history（latex_build 依赖它，须先于 latex_build 重载）。
提交粒度契约：编译/结构性操作必提交；保存按 COALESCE_S 时间合并；restore 整树写回。
"""

from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setenv("PATENT_PROJECTS_DIR", str(projects))
    monkeypatch.setenv("LO_PROFILE_DIR", str(tmp_path / "lo"))
    import importlib

    from app import config, main
    from app.domain import latex_build as latex_build_mod
    from app.domain import latex_files as latex_files_mod
    from app.domain import latex_history as latex_history_mod
    from app.domain import latex_issues as latex_issues_mod
    from app.domain import projects as projects_mod
    from app.routes import latex as latex_routes
    from app.routes import latex_history as latex_history_routes

    importlib.reload(config)
    importlib.reload(projects_mod)
    importlib.reload(latex_history_mod)
    importlib.reload(latex_build_mod)
    importlib.reload(latex_files_mod)
    importlib.reload(latex_issues_mod)
    importlib.reload(latex_routes)
    importlib.reload(latex_history_routes)
    importlib.reload(main)
    # reload 重置进程内「上次提交时刻」缓存：用例间互不串窗口
    latex_history_mod._last_commit_at.clear()
    return TestClient(main.app), projects, latex_history_mod


def _demo(c):
    return c.post("/api/projects/latex-demo").json()["id"]


def _backdate_window(lh, projects_dir, pid, seconds):
    """把该工程的「上次提交时刻」拨回 COALESCE 窗口之外，让下一次保存可提交。"""
    import os
    import time

    lh._last_commit_at[os.path.realpath(os.path.join(str(projects_dir), pid))] = time.time() - seconds


def test_save_commits_then_coalesces(client):
    c, _projects, lh = client
    pid = _demo(c)
    rel = "bare_conf.tex"
    # 首次保存：仓库还没有任何提交 ⇒ 立即落一版
    r = c.put(f"/api/projects/{pid}/latex/files/{rel}", json={"content": "\\documentclass{IEEEtran}\n% v1\n"})
    assert r.status_code == 200, r.text
    versions = c.get(f"/api/projects/{pid}/latex/history").json()
    assert len(versions) == 1 and versions[0]["message"] == f"save {rel}"
    assert versions[0]["files"] >= 1  # 首次提交包含种子全量
    # 合并窗口内的连续保存不刷版本
    c.put(f"/api/projects/{pid}/latex/files/{rel}", json={"content": "% v2"})
    assert len(c.get(f"/api/projects/{pid}/latex/history").json()) == 1
    # 拨回窗口之外 ⇒ 再保存落一版
    _backdate_window(lh, _projects, pid, lh.COALESCE_S + 5)
    c.put(f"/api/projects/{pid}/latex/files/{rel}", json={"content": "% v3"})
    versions = c.get(f"/api/projects/{pid}/latex/history").json()
    assert len(versions) == 2 and versions[0]["message"] == f"save {rel}"


def test_structural_ops_always_commit(client):
    c, _projects, _lh = client
    pid = _demo(c)
    c.post(f"/api/projects/{pid}/latex/files/sections/a.tex", json={"content": "v1"})
    c.post(f"/api/projects/{pid}/latex/upload",
           data={"rel": "figs/f.png"}, files={"file": ("f.png", b"\x89PNG", "image/png")})
    c.post(f"/api/projects/{pid}/latex/files/sections/a.tex/rename", json={"new_path": "sections/b.tex"})
    c.delete(f"/api/projects/{pid}/latex/files/sections/b.tex")
    msgs = [v["message"] for v in c.get(f"/api/projects/{pid}/latex/history").json()]
    assert msgs[0] == "delete sections/b.tex"
    assert "rename sections/a.tex -> sections/b.tex" in msgs
    assert "upload figs/f.png" in msgs
    assert "create sections/a.tex" in msgs


def test_restore_roundtrip_full_tree(client):
    c, projects, _lh = client
    pid = _demo(c)
    root = projects / pid
    # v1：新建 a.tex（结构性提交）
    c.post(f"/api/projects/{pid}/latex/files/sections/a.tex", json={"content": "v1\n"})
    v1 = c.get(f"/api/projects/{pid}/latex/history").json()[0]["sha"]
    # v2：覆盖上传改内容 + 新增 b.tex（都是强制提交）
    r = c.post(f"/api/projects/{pid}/latex/upload",
               data={"rel": "sections/a.tex", "overwrite": "true"},
               files={"file": ("a.tex", "v2\n", "text/x-tex")})
    assert r.status_code == 200, r.text
    c.post(f"/api/projects/{pid}/latex/files/sections/b.tex", json={"content": "extra\n"})
    # 二进制进树：图片也能被恢复
    c.post(f"/api/projects/{pid}/latex/upload",
           data={"rel": "figs/cover.png"}, files={"file": ("cover.png", b"\x89PNG-data", "image/png")})
    assert (root / "sections" / "a.tex").read_text(encoding="utf-8") == "v2\n"
    # 恢复 v1：a.tex 回 v1，b.tex/cover.png 被删除（工作区精确回到目标状态）
    r = c.post(f"/api/projects/{pid}/latex/history/{v1}/restore")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True and body["changed"] is True
    assert body["written"] >= 1 and set(body["deleted"]) >= {"sections/b.tex", "figs/cover.png"}
    assert (root / "sections" / "a.tex").read_text(encoding="utf-8") == "v1\n"
    assert not (root / "sections" / "b.tex").exists()
    assert not (root / "figs").exists()  # 空目录收掉
    # 恢复本身成一版「restore <sha7>」
    msgs = [v["message"] for v in c.get(f"/api/projects/{pid}/latex/history").json()]
    assert msgs[0] == f"restore {v1[:7]}"
    # 再恢复到 HEAD（与工作区一致）⇒ changed=false 且不再新增版本
    n_before = len(c.get(f"/api/projects/{pid}/latex/history").json())
    head_sha = c.get(f"/api/projects/{pid}/latex/history").json()[0]["sha"]
    r = c.post(f"/api/projects/{pid}/latex/history/{head_sha}/restore")
    assert r.json()["changed"] is False
    assert len(c.get(f"/api/projects/{pid}/latex/history").json()) == n_before


def test_diff_endpoint_unified(client):
    c, _projects, _lh = client
    pid = _demo(c)
    c.post(f"/api/projects/{pid}/latex/files/sections/d.tex", json={"content": "one\n"})
    sha = c.get(f"/api/projects/{pid}/latex/history").json()[0]["sha"]
    c.post(f"/api/projects/{pid}/latex/upload",
           data={"rel": "sections/d.tex", "overwrite": "true"},
           files={"file": ("d.tex", "two\n", "text/x-tex")})
    r = c.get(f"/api/projects/{pid}/latex/history/diff?a={sha}")
    assert r.status_code == 200
    diff = r.json()["diff"]
    assert "-one" in diff and "+two" in diff


def test_history_routes_guard_non_latex_project(client):
    """专利案（markdown）不得误建 LaTeX 库（exclude 白名单语义互斥）。"""
    c, _projects, _lh = client
    c.post("/api/projects", json={"id": "pat-h1", "title": "专利案"})
    assert c.get("/api/projects/pat-h1/latex/history").status_code == 400
    assert c.get("/api/projects/pat-h1/latex/history/diff?a=abcd123").status_code == 400
    assert c.post("/api/projects/pat-h1/latex/history/abcd123/restore").status_code == 400


def test_git_missing_save_unaffected(client, monkeypatch):
    c, _projects, lh = client
    pid = _demo(c)
    monkeypatch.setattr(lh, "_git_bin", lambda: None)
    r = c.put(f"/api/projects/{pid}/latex/files/bare_conf.tex", json={"content": "% no git"})
    assert r.status_code == 200
    assert c.get(f"/api/projects/{pid}/latex/history").json() == []


def test_cancel_without_running_build_409(client):
    c, _projects, _lh = client
    pid = _demo(c)
    r = c.post(f"/api/projects/{pid}/latex/builds/cancel")
    assert r.status_code == 409


def test_cancel_running_build(client, monkeypatch):
    """取消进行中的编译：桩子进程被终止，run_build 以 status=canceled 落 manifest。"""
    c, _projects, _lh = client
    pid = _demo(c)
    from app.domain import latex_build

    started = threading.Event()

    def fake_run(cmd, cwd, timeout_s, log_file=None, env=None, on_proc=None):
        # 真实 run_build 全链照常（快照/锁/manifest），只把编译子进程换成可被终止的长睡进程
        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        if on_proc is not None:
            on_proc(proc)
        started.set()
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()
            return -1
        return proc.returncode

    monkeypatch.setattr(latex_build.task_runner, "run_task", fake_run)

    results: list[dict] = []

    def worker():
        results.append(latex_build.run_build(c.app.state.store, pid))

    t = threading.Thread(target=worker)
    t.start()
    assert started.wait(15)
    r = c.post(f"/api/projects/{pid}/latex/builds/cancel")
    assert r.status_code == 200 and r.json()["ok"] is True
    t.join(30)
    assert not t.is_alive()
    manifest = results[0]
    assert manifest["status"] == "canceled" and "取消" in manifest["error"]
    assert manifest["pdf_url"] is None
    # 编译前快照已落版本历史（取消也救得回「编译过什么」）
    msgs = [v["message"] for v in c.get(f"/api/projects/{pid}/latex/history").json()]
    assert "build" in msgs
    # 编译已结束再取消 ⇒ 409
    assert c.post(f"/api/projects/{pid}/latex/builds/cancel").status_code == 409


def test_cancel_before_process_attach(client, monkeypatch):
    """取消早于进程启动（快照阶段）：登记句柄时立即终止，不漏杀。"""
    from app.domain import latex_build

    state = latex_build._RunState()
    state.canceled = True

    class DummyProc:
        def __init__(self):
            self.killed = False

        def poll(self):
            return None

        def kill(self):
            self.killed = True

    dummy = DummyProc()
    state.attach(dummy)  # type: ignore[arg-type]
    assert dummy.killed


def test_build_always_snapshots_despite_coalesce_window(client, monkeypatch):
    """编译快照不受 90s 保存合并窗口约束：两次编译间有编辑 ⇒ 各落一版「build」（E2E L6b 回归）。"""
    c, _projects, _lh = client
    pid = _demo(c)
    from app.domain import latex_build

    monkeypatch.setattr(latex_build.task_runner, "run_task",
                        lambda *a, **k: 0)  # 秒回假编译（无 PDF 会在 ok 分支转 error，与快照无关）
    store = c.app.state.store
    latex_build.run_build(store, pid)
    # 两次编译之间改源码：若无 force=True，第二次 build 提交会被保存合并窗口吞掉
    latex_build.save_source_file(store.get(pid), "bare_conf.tex", "% edited between builds\n")
    latex_build.run_build(store, pid)
    msgs = [v["message"] for v in c.get(f"/api/projects/{pid}/latex/history").json()]
    assert msgs.count("build") == 2
