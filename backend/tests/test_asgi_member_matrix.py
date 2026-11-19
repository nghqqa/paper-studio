# -*- coding: utf-8 -*-
"""v0.1.2 回归：外层 ASGI（patent_studio.asgi:create_app，正式运行入口）上成员/分享路由的角色矩阵。

背景：asgi include legacy 成员/分享路由时曾丢失全局 Depends(project_access)（匿名可自授 owner）。
本文件把该修复固化为行为矩阵：匿名 / 非成员 / viewer / reviewer / editor / owner 六类主体 ×
members(members/{uid}) / share(share/{token}) / invites / accept 全部入口。

只测该根因涉及的路由面与既有门槛语义（ROUTE_ROLE），不扩大为通用安全重构。
"""

import importlib
import os
import shutil
import sys
import uuid

import pytest
from fastapi.testclient import TestClient

PW = "matrix-Passw0rd!"


def _fresh(modname: str):
    mod = sys.modules.get(modname)
    if mod is not None:
        return importlib.reload(mod)
    return importlib.import_module(modname)


@pytest.fixture(scope="module")
def matrix(tmp_path_factory):
    """一次性 boot：独立 tmp 目录（projects + sqlite），真实注册 6 类账号，owner 建项目并授角色。"""
    base = tmp_path_factory.mktemp("matrix")
    monkey_env = {
        "PATENT_STUDIO_AUTH": "on",
        "PATENT_STUDIO_SECRET": "matrix-secret-test",
        "PATENT_PROJECTS_DIR": str(base / "projects"),
        "PATENT_STUDIO_LEGACY_DATABASE_URL": f"sqlite:///{base}/studio.db",
    }
    old = {k: os.environ.get(k) for k in monkey_env}
    os.environ.update(monkey_env)
    (base / "projects").mkdir()
    try:
        for name in ("app.config", "app.auth.db", "app.auth.users", "app.auth.users_me", "app.auth.acl", "app.auth.router", "app.main"):
            _fresh(name)
        from patent_studio.asgi import create_app

        app = create_app()

        def new_client() -> TestClient:
            return TestClient(app, raise_server_exceptions=False)

        def register(email: str) -> TestClient:
            c = new_client()
            r = c.post("/api/auth/register", json={"email": email, "password": PW, "display_name": email.split("@")[0]})
            assert r.status_code == 201, (email, r.status_code, r.text)
            r = c.post(
                "/api/auth/cookie/login",
                data={"username": email, "password": PW},
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            assert r.status_code == 204, (email, r.status_code)
            return c

        # 首个注册者自动成为超管：先注册一次性引导账号，避免污染 owner 语义
        register("bootstrap@matrix.example.com")
        users = {role: register(f"{role}@matrix.example.com") for role in ("owner", "viewer", "reviewer", "editor", "outsider")}

        r = users["owner"].post("/api/projects/latex-demo")
        assert r.status_code == 200, r.text
        pid = r.json()["id"]
        for role in ("viewer", "reviewer", "editor"):
            r = users["owner"].put(
                f"/api/projects/{pid}/members", json={"email": f"{role}@matrix.example.com", "role": role}
            )
            assert r.status_code == 200, (role, r.status_code, r.text)
        yield {"app": app, "pid": pid, "users": users}
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(base, ignore_errors=True)


ADMIN_PATHS = lambda pid: {  # noqa: E731
    "GET members": f"/api/projects/{pid}/members",
    "PUT members": f"/api/projects/{pid}/members",
    "PUT members/uid": f"/api/projects/{pid}/members/00000000-0000-0000-0000-000000000000",
    "DELETE members/uid": f"/api/projects/{pid}/members/00000000-0000-0000-0000-000000000000",
    "GET share": f"/api/projects/{pid}/share",
    "POST share": f"/api/projects/{pid}/share",
    "DELETE share/token": f"/api/projects/{pid}/share/nonexistent-token",
}


def _hit(client: TestClient, key: str, path: str):
    if key == "GET members":
        return client.get(path)
    if key == "PUT members":
        return client.put(path, json={"email": "nobody@matrix.example.com", "role": "viewer"})
    if key == "PUT members/uid":
        return client.put(path, json={"role": "viewer"})
    if key == "DELETE members/uid":
        return client.delete(path)
    if key == "GET share":
        return client.get(path)
    if key == "POST share":
        return client.post(path, json={"role": "viewer", "expires_in_days": None})
    if key == "DELETE share/token":
        return client.delete(path)
    raise KeyError(key)


def test_anonymous_all_admin_denied(matrix):
    c = TestClient(matrix["app"], raise_server_exceptions=False)
    for key, path in ADMIN_PATHS(matrix["pid"]).items():
        r = _hit(c, key, path)
        assert r.status_code == 401, (key, r.status_code, r.text[:120])


def test_nonmember_cannot_admin_or_read(matrix):
    c = matrix["users"]["outsider"]
    for key, path in ADMIN_PATHS(matrix["pid"]).items():
        r = _hit(c, key, path)
        assert r.status_code in (403, 404), (key, r.status_code, r.text[:120])  # latex 工程（无 content.md）⇒ 404 隐存在
    # 也不能经 accept 之外的途径读到项目内容
    assert c.get(f"/api/projects/{matrix['pid']}/latex/files").status_code == 404


def test_low_roles_read_but_cannot_admin(matrix):
    pid = matrix["pid"]
    for role in ("viewer", "reviewer", "editor"):
        c = matrix["users"][role]
        # 可读性 sanity：viewer 也能读文件/构建历史（门槛=viewer）
        assert c.get(f"/api/projects/{pid}/latex/files").status_code == 200, role
        for key, path in ADMIN_PATHS(pid).items():
            r = _hit(c, key, path)
            assert r.status_code == 403, (role, key, r.status_code, r.text[:120])
        # 普通成员不能把自己升为 owner
        r = c.put(f"/api/projects/{pid}/members", json={"email": f"{role}@matrix.example.com", "role": "owner"})
        assert r.status_code == 403, (role, "self-promote", r.status_code)


def test_owner_admin_roundtrip(matrix):
    pid = matrix["pid"]
    owner = matrix["users"]["owner"]
    # 成员列表（owner 门槛内可读）
    r = owner.get(f"/api/projects/{pid}/members")
    assert r.status_code == 200
    roles = {m["email"]: m["role"] for m in r.json()}
    assert roles["owner@matrix.example.com"] == "owner" and roles["reviewer@matrix.example.com"] == "reviewer"
    # 邀请已注册 outsider（直接成员）；改角色；移除
    r = owner.put(f"/api/projects/{pid}/members", json={"email": "outsider@matrix.example.com", "role": "viewer"})
    assert r.status_code == 200, r.text
    r = owner.put(f"/api/projects/{pid}/members", json={"email": "outsider@matrix.example.com", "role": "reviewer"})
    assert r.status_code == 200
    uid = next(m["user_id"] for m in owner.get(f"/api/projects/{pid}/members").json() if m["email"] == "outsider@matrix.example.com")
    r = owner.put(f"/api/projects/{pid}/members/{uid}", json={"role": "viewer"})
    assert r.status_code == 200
    r = owner.delete(f"/api/projects/{pid}/members/{uid}")
    assert r.status_code == 200
    # 分享链接：创建（owner 角色 422）/ 列出 / 撤销
    r = owner.post(f"/api/projects/{pid}/share", json={"role": "owner", "expires_in_days": None})
    assert r.status_code == 422
    r = owner.post(f"/api/projects/{pid}/share", json={"role": "viewer", "expires_in_days": 7})
    assert r.status_code == 201, r.text
    token = r.json()["token"]
    assert owner.get(f"/api/projects/{pid}/share").status_code == 200
    assert owner.delete(f"/api/projects/{pid}/share/{token}").status_code == 200
    # 末主保护：owner 降自己 → 409
    own_uid = next(m["user_id"] for m in owner.get(f"/api/projects/{pid}/members").json() if m["email"] == "owner@matrix.example.com")
    r = owner.put(f"/api/projects/{pid}/members/{own_uid}", json={"role": "viewer"})
    assert r.status_code == 409
    # 邀请（未注册邮箱 → pending）：owner 201；viewer 403
    r = owner.post(f"/api/projects/{pid}/invites", json={"email": "new-mentor@matrix.example.com", "role": "reviewer"})
    assert r.status_code == 201, r.text
    assert matrix["users"]["viewer"].get(f"/api/projects/{pid}/invites").status_code == 403
    assert owner.get(f"/api/projects/{pid}/invites").status_code == 200


def test_share_accept_grants_link_role_only(matrix):
    pid = matrix["pid"]
    owner = matrix["users"]["owner"]
    r = owner.post(f"/api/projects/{pid}/share", json={"role": "viewer", "expires_in_days": None})
    token = r.json()["token"]
    outsider = matrix["users"]["outsider"]
    r = outsider.post(f"/api/share/{token}/accept")
    assert r.status_code == 200, r.text
    # 获得的只是链接角色 viewer：可读文件，不可写源码
    assert outsider.get(f"/api/projects/{pid}/latex/files").status_code == 200
    r = outsider.put(
        f"/api/projects/{pid}/latex/files/main.tex",
        json={"content": "\\documentclass{article}\\n hacked", "base": None},
    )
    assert r.status_code == 403, r.status_code
