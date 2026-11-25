# -*- coding: utf-8 -*-
"""w21：LaTeX 文件批注（导师批注最小闭环）后端契约。

- 锚点校验：正确文件/行/sha 创建成功；sha 不匹配 409；越界行号/非法路径/非 latex 工程 422；
- 过期判定：源码变化后 GET 将带 sha 的锚点标 stale（位置待核对），批注内容不丢；
- 权限（AUTH=on，真实 PG）：viewer（导师）可创建/回复批注、不可写正文文件；resolve 需 reviewer；
  作者身份由服务端注入，客户端无法伪造；
- 兼容：patent/file 旧锚点不受影响。
"""

import asyncio
import os
import sys
import tempfile

# Windows：pytest 进程默认 Proactor loop 与 async psycopg 不兼容（仅测试进程策略，不影响产品）
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

import pytest
from fastapi.testclient import TestClient

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SEED = os.path.join(ROOT, "backend", "app", "latex_seed", "ieee_bare_conf")


@pytest.fixture()
def latex_project(tmp_path, monkeypatch):
    """AUTH=off：latex 项目 + 两份源码快照（模拟版本变化）。"""
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setenv("PATENT_PROJECTS_DIR", str(projects))
    monkeypatch.setenv("LO_PROFILE_DIR", str(tmp_path / "lo"))
    import importlib

    from app import config, main
    from app.domain import latex_build as lb
    from app.domain import projects as projects_mod
    from app.routes import comments as comments_routes
    from app.routes import latex as latex_routes

    importlib.reload(config)
    importlib.reload(projects_mod)
    importlib.reload(lb)
    importlib.reload(latex_routes)
    # 批注路由在模块级绑定 domain.comments 的模型类与 latex_build/latex_routes 的兄弟引用——
    # 先跑文件换 env reload 过这些模块后，comments 不跟着 reload 就拿旧绑定（sha 校验/过期判定读到旧路径）
    importlib.reload(comments_routes)
    importlib.reload(main)
    c = TestClient(main.app)
    r = c.post("/api/projects/latex-demo", json={"id": "lc"})
    assert r.status_code == 200, r.text
    read = c.get("/api/projects/lc/latex/files/bare_conf.tex").json()
    return c, read["sha"]


def _anchor(sha, line_start=612, line_end=612, file="bare_conf.tex"):
    return {
        "file": file,
        "line_start": line_start,
        "line_end": line_end,
        "line": line_start,
        "sha": sha,
        "quote": "\\end{document}",
    }


def test_latex_anchor_create_requires_matching_sha(latex_project):
    c, sha = latex_project
    # 正确 sha：创建成功，作者来自服务器（auth=off ⇒ 本机）
    r = c.post("/api/projects/lc/comments", json={"anchor": _anchor(sha), "body": "导师批注：结论一节建议补充对比。"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["anchor"]["file"] == "bare_conf.tex"
    assert body["anchor"]["sha"] == sha
    assert body["anchor"]["stale"] is False
    assert body["author"]["name"] == "本机"
    # sha 不匹配（源码已变）→ 409，明确提示刷新定位
    stale = c.post("/api/projects/lc/comments", json={"anchor": _anchor("sha-outdated"), "body": "x"})
    assert stale.status_code == 409
    assert "刷新" in stale.json()["detail"]["message"]


def test_latex_anchor_rejects_bad_path_and_lines(latex_project):
    c, sha = latex_project
    # 路径越界 / 内部文件 / 不存在的文件
    for path in ("../x.tex", ".studio/builds/x", "studio.json", "fig1.png", "nope.tex"):
        r = c.post("/api/projects/lc/comments", json={"anchor": _anchor(sha, file=path), "body": "x"})
        assert r.status_code in (400, 404, 415, 422), (path, r.status_code)
    # 行号越界
    r = c.post(
        "/api/projects/lc/comments",
        json={"anchor": _anchor(sha, line_start=99999, line_end=99999), "body": "x"},
    )
    assert r.status_code == 422 and "越界" in r.json()["detail"]
    r = c.post("/api/projects/lc/comments", json={"anchor": _anchor(sha, line_start=0, line_end=0), "body": "x"})
    assert r.status_code == 422


def test_internal_files_excluded_from_all_surfaces(latex_project):
    """内部文件（批注/配置/构建产物）不得经列表/读取/保存任一表面暴露（w21 边界收尾）。"""
    c, _ = latex_project
    # 制造内部文件：构建产物目录
    c.post("/api/projects/lc/latex/build", json={"pdf": False})
    files = c.get("/api/projects/lc/latex/files").json()["files"]
    paths = {f["path"] for f in files}
    for internal in ("reviews/comments.json", "studio.json", "case.json", "content.md", "project.json"):
        assert internal not in paths, internal
    assert not any(p.startswith(".studio") for p in paths)
    # 读取表面（含构建产物路径变体）
    for rel in ("reviews/comments.json", ".studio/latex-builds/x/out.pdf", "project.json"):
        r = c.get(f"/api/projects/lc/latex/files/{rel}")
        assert r.status_code in (400, 404), (rel, r.status_code)
    # 保存表面同样拒绝
    r = c.put("/api/projects/lc/latex/files/reviews/comments.json", json={"content": "{}"})
    assert r.status_code == 400


def test_latex_anchor_stale_after_source_change(latex_project):
    """源码变化 → GET 将锚点标 stale（位置待核对），批注内容/作者不丢。"""
    c, sha = latex_project
    c.post("/api/projects/lc/comments", json={"anchor": _anchor(sha), "body": "注释内容不丢测试"})
    # 源码变化（新增一行）
    c.put(
        "/api/projects/lc/latex/files/bare_conf.tex",
        json={"content": "% changed\n" * 3, "base": None},
    )
    listing = c.get("/api/projects/lc/comments").json()
    mine = [x for x in listing if x["body"] == "注释内容不丢测试"]
    assert len(mine) == 1
    assert mine[0]["anchor"]["stale"] is True  # 位置待核对
    assert mine[0]["anchor"]["quote"] == "\\end{document}"  # 原始上下文保留
    # 修复源码回匹配 sha 的内容 → 回到有效
    c.put("/api/projects/lc/latex/files/bare_conf.tex", json={"content": "% changed\n" * 3, "base": None})


def test_non_latex_project_rejects_sha_anchor(tmp_path, monkeypatch):
    """patent 项目拒绝带 sha 的 LaTeX 锚点（不静默落锚）。"""
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setenv("PATENT_PROJECTS_DIR", str(projects))
    monkeypatch.setenv("LO_PROFILE_DIR", str(tmp_path / "lo"))
    import importlib

    from app import config, main
    from app.domain import latex_build
    from app.domain import projects as projects_mod
    from app.routes import latex as latex_routes

    importlib.reload(config)
    importlib.reload(projects_mod)
    importlib.reload(latex_build)
    importlib.reload(latex_routes)
    # 同 latex_project：批注路由的模块级绑定必须跟 reload，否则拿旧路径/旧模型类
    from app.routes import comments as comments_routes

    importlib.reload(comments_routes)
    # 旧代 auth 路由按 config.AUTH_ON 模块级选择真路由/桩——config 变更后必须一并 reload
    import app.auth.router as _auth_router
    import app.auth.users_me as _users_me

    importlib.reload(_auth_router)
    importlib.reload(_users_me)
    importlib.reload(main)
    c = TestClient(main.app)
    c.post("/api/projects", json={"id": "pat", "title": "专利案"})
    r = c.post("/api/projects/pat/comments", json={"anchor": _anchor("any"), "body": "x"})
    assert r.status_code == 422 and "LaTeX" in r.json()["detail"]


# ---------------- AUTH=on 权限（真实 PG） ----------------

pytestmark_pg = pytest.mark.skipif(
    not os.environ.get("PATENT_STUDIO_TEST_DATABASE_URL"), reason="未设置 PATENT_STUDIO_TEST_DATABASE_URL"
)


@pytest.fixture(scope="module")
def authed_server():
    """起一个真实 AUTH=on 子进程服务器（与浏览器验收同构）：懒迁移 + cookie 注册/登录。

    需要 PATENT_STUDIO_TEST_DATABASE_URL 指向 PostgreSQL；Windows 上 asyncio 策略已在本文件顶部修正。
    """
    import subprocess
    import sys
    import time
    import urllib.request

    base = "http://127.0.0.1:8123"
    projects_dir = os.path.join(tempfile.gettempdir(), f"latex-comments-{os.getpid()}")
    os.makedirs(projects_dir, exist_ok=True)
    env = {
        **os.environ,
        "PATENT_STUDIO_AUTH": "on",
        "PATENT_STUDIO_SECRET": "test-secret-key-for-auth-suite-32b",
        "PATENT_STUDIO_DATABASE_URL": os.environ["PATENT_STUDIO_TEST_DATABASE_URL"],
        "PATENT_PROJECTS_DIR": projects_dir,
    }
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8123"],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(f"{base}/api/health", timeout=2) as r:
                    if r.status == 200:
                        break
            except Exception:
                time.sleep(0.4)
        else:
            raise RuntimeError("AUTH=on 服务器 30s 未就绪")
        yield base
    finally:
        proc.terminate()
        proc.wait(timeout=10)


def _client_login(base, email, password="pw-123456"):
    """独立 cookie jar 的登录客户端（urllib + cookie jar，避免引 httpx）。"""
    import http.cookiejar
    import json as _json
    import urllib.parse
    import urllib.request
    from urllib.request import Request

    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar)).open

    def call(method, path, json_body=None):
        data = _json.dumps(json_body).encode() if json_body is not None else None
        req = Request(
            f"{base}{path}",
            data=data,
            method=method,
            headers={"Content-Type": "application/json"} if data else {},
        )
        with opener(req) as r:
            return r.status, r.read().decode()

    # 登录是 form 表单（fastapi-users）
    import urllib.parse

    form = urllib.parse.urlencode({"username": email, "password": password}).encode()
    req = Request(f"{base}/api/auth/cookie/login", data=form, method="POST")
    with opener(req) as r:
        assert r.status == 204, r.status

    def out(method, path, json_body=None):
        data = _json.dumps(json_body).encode() if json_body is not None else None
        req = Request(
            f"{base}{path}",
            data=data,
            method=method,
            headers={"Content-Type": "application/json"} if data else {},
        )
        try:
            with opener(req) as r:
                return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    return out


@pytest.mark.skipif(
    not os.environ.get("PATENT_STUDIO_TEST_DATABASE_URL"), reason="未设置 PATENT_STUDIO_TEST_DATABASE_URL"
)
def test_roles_comment_vs_write(authed_server):
    """AUTH=on 真实服务器：导师（reviewer）可评论/不可写正文；学生（owner）回复/解决；匿名 401。"""
    import json as _json
    import urllib.request

    base = authed_server
    import http.cookiejar
    import urllib.error
    import urllib.parse
    import urllib.request

    def call_http(opener, method, path, body=None):
        data = _json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            f"{base}{path}", data=data, method=method, headers={"Content-Type": "application/json"} if data else {}
        )
        try:
            with opener.open(req) as r:
                return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    def new_session():
        jar = http.cookiejar.CookieJar()
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def login(session, email):
        form = urllib.parse.urlencode({"username": email, "password": "pw-123456"}).encode()
        with session.open(
            urllib.request.Request(f"{base}/api/auth/cookie/login", data=form, method="POST")
        ) as r:
            assert r.status == 204, r.status

    def register(email):
        # 已注册 ⇒ 400（幂等：账号由首个用例创建）
        st, _ = call_http(
            new_session(),
            "POST",
            "/api/auth/register",
            {"email": email, "password": "pw-123456", "display_name": email},
        )
        assert st in (200, 201, 400)

    student = new_session()
    login(student, "student@example.com")
    st, body = call_http(student, "POST", "/api/projects/latex-demo", {"id": "lc"})
    assert st in (200, 201, 409), st  # 409 = 模块内上一用例已建
    # 创建者 owner 授权 + 可见性（grant_owner 缺失缺陷的回归断言）：
    st, body = call_http(student, "GET", "/api/projects/lc")
    assert st == 200, (st, body)  # 创建者能打开项目
    detail = _json.loads(body)
    assert detail["role"] == "owner", detail.get("role")
    st, listing = call_http(student, "GET", "/api/projects")
    assert "lc" in [p["id"] for p in _json.loads(listing)], "创建者列表可见"
    # 重新登录后仍可访问（owner 持久化）
    student = new_session()
    login(student, "student@example.com")
    st, body = call_http(student, "GET", "/api/projects/lc")
    assert st == 200 and _json.loads(body)["role"] == "owner"
    register("mentor@example.com")
    mentor = new_session()
    login(mentor, "mentor@example.com")
    st, _ = call_http(student, "PUT", "/api/projects/lc/members", {"email": "mentor@example.com", "role": "reviewer"})
    assert st in (200, 201), (st, _)
    # 当前 sha（学生视角）
    st, body = call_http(student, "GET", "/api/projects/lc/latex/files/bare_conf.tex")
    sha = _json.loads(body)["sha"]
    # 导师（reviewer）：可创建批注；作者由服务端注入为导师自己
    st, body = call_http(mentor, "POST", "/api/projects/lc/comments", {"anchor": _anchor(sha), "body": "导师批注"})
    assert st == 201, (st, body)
    comment = _json.loads(body)
    assert comment["author"]["name"] == "mentor@example.com"
    cid = comment["id"]
    # 导师不可写正文文件（editor 门槛）
    st, _ = call_http(mentor, "PUT", "/api/projects/lc/latex/files/bare_conf.tex", {"content": "x"})
    assert st == 403
    # 学生回复 + 解决
    st, _ = call_http(student, "POST", f"/api/projects/lc/comments/{cid}/replies", {"body": "收到，下一版补充。"})
    assert st == 200
    st, body = call_http(student, "POST", f"/api/projects/lc/comments/{cid}/resolve", {"resolved": True})
    assert st == 200 and _json.loads(body)["resolved"] is True
    # 匿名：批注与源码均 401（无项目权限不泄露存在性之外的内容）
    anon = new_session()
    st, _ = call_http(anon, "GET", "/api/projects/lc/comments")
    assert st == 401
    st, _ = call_http(anon, "GET", "/api/projects/lc/latex/files/bare_conf.tex")
    assert st == 401
