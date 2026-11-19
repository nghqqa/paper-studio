# -*- coding: utf-8 -*-
"""回归：外层 asgi 把 legacy 成员/分享路由 include 到新栈时必须带回 project_access 门槛。

asgi.create_app() 在 AUTH=on 时把 app.auth.router 直接 include 到外层 app（先于 legacy mount 命中）。
旧面的成员/分享门槛来自 legacy app 的全局 Depends(project_access)，include 会丢掉这层——
曾导致匿名 GET/PUT /api/projects/{pid}/members 与 GET /share 直接 200（可自授 owner、枚举分享链接）。
"""

import os
import shutil

import fastapi.testclient as ftc


def test_outer_app_member_share_blocked_for_anon(monkeypatch, tmp_path):
    monkeypatch.setenv("PATENT_STUDIO_SECRET", "test-secret-asgi")
    projects = tmp_path / "projects"
    projects.mkdir()
    shutil.copytree(
        os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "examples", "method"),
        projects / "method",
        ignore=shutil.ignore_patterns("*.docx", ".studio", "*.bak-*"),
    )
    monkeypatch.setenv("PATENT_PROJECTS_DIR", str(projects))
    # app.auth.router / users_me 在模块级按 config.AUTH_ON 选真路由/桩——此前任一文件在 AUTH=off 下
    # import/reload 过它们，这里 include 到外层 app 的就是桩（members/share 路由缺失，先跑文件污染）。
    # 与 test_latex_comments 同口径：env 就位后 reload config（烙进 SECRET/AUTH 当前值）→ 切 AUTH_ON →
    # reload auth 路由模块，测完再归位 AUTH=off 缺省态。
    import importlib

    from app import config as legacy_config

    importlib.reload(legacy_config)
    monkeypatch.setattr(legacy_config, "AUTH_ON", True)
    import app.auth.router as _auth_router
    import app.auth.users_me as _users_me

    importlib.reload(_auth_router)
    importlib.reload(_users_me)
    try:
        from patent_studio.asgi import create_app

        app = create_app()
        # 旧成员/分享路由确实注册在外层 app（先于 legacy mount 命中）
        paths = app.openapi()["paths"]
        assert "/api/projects/{pid}/members" in paths
        assert "/api/projects/{pid}/share" in paths

        with ftc.TestClient(app, raise_server_exceptions=False) as c:
            for path in ("/api/projects/method/members", "/api/projects/method/share"):
                assert c.get(path).status_code == 401, (path, c.get(path).status_code)
            put = c.put("/api/projects/method/members", json={"email": "x@y.z", "role": "owner"})
            assert put.status_code == 401, put.status_code
    finally:
        import sys

        import app.config as _cfg

        _cfg.AUTH_ON = False
        importlib.reload(_auth_router)
        importlib.reload(_users_me)
        for _mod in ("app.auth.users", "app.auth.acl", "app.auth.db"):
            sys.modules.pop(_mod, None)


def test_mjs_served_as_javascript_mime(tmp_path):
    """Windows 托管 frontend/dist 的 MIME 兜底：main.py 模块初始化 add_type 后，
    guess_type 与真实 StaticFiles 响应都必须给 .mjs JS 类型——否则 nosniff 拦截，
    pdf.worker.min-*.mjs 拒执行、Word 工作台 pdf.js 全挂。
    隔离用例：函数内 import app.main（与 test_api 等既有口径一致，不 reload 任何
    AUTH 模块、置于上方 reload 舞步之后，仅消费缓存，无全局状态污染）。"""
    import mimetypes

    import fastapi.testclient as ftc
    from fastapi import FastAPI
    from fastapi.staticfiles import StaticFiles

    from app import main  # noqa: F401 — 模块级 add_type("text/javascript", ".mjs") 即本回归对象

    assert mimetypes.guess_type("pdf.worker.min.mjs")[0] == "text/javascript"
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "pdf.worker.min-e2e.mjs").write_bytes(b"export default 1\n")
    probe = FastAPI()
    # 探针挂 /static（根挂载在 TestClient 下 404；生产是 app.mount("/", …) 但同走 mimetypes 注册表）
    probe.mount("/static", StaticFiles(directory=str(tmp_path), html=True), name="static")
    with ftc.TestClient(probe) as c:
        resp = c.get("/static/assets/pdf.worker.min-e2e.mjs")
    assert resp.status_code == 200
    assert "javascript" in resp.headers.get("content-type", "")
