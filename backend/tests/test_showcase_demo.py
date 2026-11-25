# -*- coding: utf-8 -*-
"""Step 1 回归测试：一键全功能演示论文（showcase-demo）与免注册 Demo 模式。"""
from __future__ import annotations

import importlib
import sys

import pytest
from fastapi.testclient import TestClient


def _boot(tmp_path, monkeypatch, request, *, demo_mode: bool):
    proj = tmp_path / "projects"
    proj.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("PAPER_STUDIO_PROJECTS_DIR", str(proj))
    monkeypatch.setenv("PAPER_STUDIO_AUTH", "on")
    monkeypatch.setenv("PAPER_STUDIO_SECRET", "showcase-demo-test-secret-32-chars!!")
    monkeypatch.setenv("PAPER_STUDIO_PRODUCT", "paper")
    monkeypatch.setenv("PAPER_STUDIO_DEMO_MODE", "on" if demo_mode else "off")

    # 环境切换需要整棵 app.* 按新 env 重导。但直接 del sys.modules 不还原会把进程劈成两代模块：
    # 之后的测试模块持有旧代引用（如 plans.is_plan_handler 按 `handler is m.run` 身份判别、
    # _modules() 取的是新代），身份失配 → run_scenario 建错 ctx → 全量下 test_agent_core 死锁。
    # 故快照-清-重建，测试结束后原样还原（同测多次 _boot 时 finalizer LIFO，最终仍回到首代）。
    saved = {k: m for k, m in sys.modules.items() if k == "app" or k.startswith("app.")}

    def _restore_app_modules():
        for k in [k for k in sys.modules if k == "app" or k.startswith("app.")]:
            del sys.modules[k]
        sys.modules.update(saved)

    request.addfinalizer(_restore_app_modules)

    for name in list(sys.modules):
        if name == "app" or name.startswith("app."):
            del sys.modules[name]
    import app.main as main_mod
    importlib.reload(main_mod)
    return main_mod.app


def test_showcase_demo_and_demo_login_lifecycle(tmp_path, monkeypatch, request):
    # 1. DEMO_MODE=off 时：/api/meta.demo_mode=False，/api/auth/demo-login 404 fail-closed
    app_off = _boot(tmp_path / "off", monkeypatch, request, demo_mode=False)
    c_off = TestClient(app_off)
    assert c_off.get("/api/meta").json()["demo_mode"] is False
    assert c_off.post("/api/auth/demo-login").status_code == 404

    # 2. DEMO_MODE=on 时：/api/meta.demo_mode=True，一键免注册登录成功（非超管）并自动种演示论文
    app_on = _boot(tmp_path / "on", monkeypatch, request, demo_mode=True)
    c = TestClient(app_on)
    assert c.get("/api/meta").json()["demo_mode"] is True

    r_login = c.post("/api/auth/demo-login")
    assert r_login.status_code in (200, 204), r_login.text
    me = c.get("/api/users/me").json()
    assert me["email"] == "demo@demo.paperstudio.org"
    assert me["is_superuser"] is False  # 绝不得成为超管

    # 演示账号禁止修改密码（403）
    r_pwd = c.put("/api/users/me", json={"password": {"current": "any", "new": "new-password-123"}})
    assert r_pwd.status_code == 403

    # 自动生成的全功能演示论文已含：LaTeX 文件 + 真实 DOI 文献 + AI 披露台账 + Rebuttal 审稿意见
    projects = c.get("/api/projects").json()
    assert isinstance(projects, list) and len(projects) == 1
    pid = projects[0]["id"]

    disc = c.get(f"/api/projects/{pid}/paper-proposals/disclosure?lang=en&format=latex")
    assert disc.status_code == 200, disc.text
    assert disc.json()["summary"]["applied_count"] == 1
    assert disc.json()["summary"]["human_edited_count"] == 1
    assert "\\section*{AI Usage Disclosure}" in disc.json()["content"]

    reb = c.get(f"/api/projects/{pid}/rebuttal")
    assert reb.status_code == 200, reb.text
    assert len(reb.json()["items"]) == 2

    # 3. 显式再调用 POST /api/projects/showcase-demo 创建第二份演示论文也成功
    r2 = c.post("/api/projects/showcase-demo", json={})
    assert r2.status_code == 200, r2.text
    assert r2.json()["id"] != pid

    # 4. 经正式 app.main:app 入口调用 demo-login 也必须正常
    from app.main import app as main_app

    c_asgi = TestClient(main_app)
    r_asgi = c_asgi.post("/api/auth/demo-login")
    assert r_asgi.status_code in (200, 204), r_asgi.text
    assert c_asgi.get("/api/users/me").json()["email"] == "demo@demo.paperstudio.org"
