# -*- coding: utf-8 -*-
"""Step 3 回归测试：管理员系统诊断（GET /api/admin/doctor）与权限/脱敏守卫。"""
from __future__ import annotations

import importlib
import sys

from fastapi.testclient import TestClient


def _boot(tmp_path, monkeypatch, request):
    proj = tmp_path / "projects"
    proj.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("PAPER_STUDIO_PROJECTS_DIR", str(proj))
    monkeypatch.setenv("PAPER_STUDIO_AUTH", "on")
    monkeypatch.setenv("PAPER_STUDIO_SECRET", "doctor-super-secret-value-at-least-32-chars")
    monkeypatch.setenv("PAPER_STUDIO_ONLYOFFICE_JWT_SECRET", "doctor-jwt-secret-must-never-leak-out")
    monkeypatch.setenv("PAPER_STUDIO_PRODUCT", "paper")
    monkeypatch.setenv("PAPER_STUDIO_WORD_EDITOR", "off")

    # 环境切换需要整棵 app.* 按新 env 重导。但直接 del sys.modules 不还原会把进程劈成两代模块：
    # 本文件之后的测试模块持有旧代引用（如 plans.is_plan_handler 按 `handler is m.run` 身份判别、
    # _modules() 取的是新代），身份失配 → run_scenario 建错 ctx → 全量下 test_agent_core 死锁。
    # 故快照-清-重建，测试结束后原样还原（新代条目清除、旧代条目放回）。
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


def _reg_login(app, email: str) -> TestClient:
    c = TestClient(app)
    r = c.post("/api/auth/register", json={"email": email, "password": "password1234", "display_name": "u"})
    assert r.status_code in (200, 201), r.text
    r2 = c.post("/api/auth/cookie/login", data={"username": email, "password": "password1234"})
    assert r2.status_code in (200, 204), r2.text
    return c


def test_admin_doctor_checks_permissions_and_redaction(tmp_path, monkeypatch, request):
    app = _boot(tmp_path, monkeypatch, request)
    # 匿名 401
    assert TestClient(app).get("/api/admin/doctor").status_code == 401

    # 首个注册成为超管 → 200
    admin = _reg_login(app, "doc-admin@example.com")
    # 第二个注册为普通成员 → 403
    member = _reg_login(app, "doc-member@example.com")
    assert member.get("/api/admin/doctor").status_code == 403

    r = admin.get("/api/admin/doctor")
    assert r.status_code == 200, r.text
    body = r.json()
    ids = [c["id"] for c in body["checks"]]
    assert ids == ["auth", "storage", "latex", "pandoc", "poppler", "onlyoffice", "ai"]
    by_id = {c["id"]: c for c in body["checks"]}
    assert by_id["auth"]["status"] == "ok"
    assert by_id["storage"]["status"] == "ok"
    assert by_id["onlyoffice"]["status"] == "off"

    # 绝不泄露任何密钥原文
    raw = r.text
    assert "doctor-super-secret" not in raw
    assert "doctor-jwt-secret" not in raw
