# -*- coding: utf-8 -*-
"""用户自带 AI 接入（v0.4.2 /api/ai/my-provider）路由与解析测试。

复用 test_ai_polish 的 client fixture 形态（tmp_path + AUTH=on + 短 reload 链）。
覆盖：脱敏（key 永不回传）、key 留空保留原值、用户优先 > 机构回退、清除后回退、
非法 base_url 422、未登录 401、生成链解析（resolve_ai_client 打桩捕获 base_url/key）。
"""
import importlib
import os
import sys

import pytest
from fastapi.testclient import TestClient

PW = "paper-pw!"


def _fresh(name):
    mod = sys.modules.get(name)
    return importlib.reload(mod) if mod is not None else importlib.import_module(name)


PROVIDER = {"base_url": "https://user.fake.example/v1", "api_key": "sk-user-key-99",
            "model_interactive": "um1", "model_heavy": "um2", "model_fallback": "um1"}
ORG_PROVIDER = {"base_url": "https://org.fake.example/v1", "api_key": "sk-org-key-77",
                "model_interactive": "om1", "model_heavy": "", "model_fallback": ""}


@pytest.fixture(scope="module")
def env_client(tmp_path_factory):
    base = tmp_path_factory.mktemp("user-ai")
    env = {
        "PATENT_STUDIO_AUTH": "on",
        "PATENT_STUDIO_SECRET": "user-ai-secret",
        "PATENT_PROJECTS_DIR": str(base / "projects"),
        "PATENT_STUDIO_LEGACY_DATABASE_URL": f"sqlite:///{base}/studio.db",
    }
    old = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    (base / "projects").mkdir()
    try:
        for name in ("app.config", "app.auth.db", "app.auth.acl", "app.auth.router", "app.main"):
            _fresh(name)
        from patent_studio.asgi import create_app
        app = create_app()

        def register(email):
            cc = TestClient(app)
            st = cc.post("/api/auth/register", json={"email": email, "password": PW})
            assert st.status_code in (200, 201), st.text
            st = cc.post("/api/auth/cookie/login", data={"username": email, "password": PW},
                         headers={"Content-Type": "application/x-www-form-urlencoded"})
            assert st.status_code == 204, st.status_code
            return cc

        yield {
            "app": app,
            "admin": register("boss@ua.example.com"),  # 首注=超管
            "alice": register("alice@ua.example.com"),
            "bob": register("bob@ua.example.com"),
            "projects_dir": str(base / "projects"),
        }
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def test_requires_login(env_client):
    anon = TestClient(env_client["app"])
    assert anon.get("/api/ai/my-provider").status_code == 401
    assert anon.put("/api/ai/my-provider", json={**PROVIDER}).status_code == 401
    assert anon.delete("/api/ai/my-provider").status_code == 401


def test_empty_then_put_get_delete(env_client):
    c = env_client["alice"]
    r = c.get("/api/ai/my-provider")
    assert r.status_code == 200
    assert r.json() == {"provider": None, "org_fallback": None, "effective": "none"}

    # 首配不给 key ⇒ 400
    r = c.put("/api/ai/my-provider", json={**PROVIDER, "api_key": ""})
    assert r.status_code == 400 and "API Key" in r.json()["detail"]["message"]

    # 首配带 key ⇒ 200 脱敏；响应与后续 GET 均不回传明文
    r = c.put("/api/ai/my-provider", json=PROVIDER)
    assert r.status_code == 200, r.text
    assert "sk-user-key-99" not in r.text
    body = r.json()["provider"]
    assert body["has_api_key"] is True and body["api_key_hint"].endswith("y-99")
    assert body["base_url"] == "https://user.fake.example/v1"

    r = c.get("/api/ai/my-provider")
    assert "sk-user-key-99" not in r.text
    assert r.json()["effective"] == "user"

    # 落盘位置：<projects>/.studio/user-ai/<uid>.json
    files = os.listdir(os.path.join(env_client["projects_dir"], ".studio", "user-ai"))
    assert len(files) == 1 and files[0].endswith(".json")

    # key 留空 = 保留原值（只改 base_url 的场景）
    r = c.put("/api/ai/my-provider", json={**PROVIDER, "api_key": "", "base_url": "https://user2.fake.example/v1"})
    assert r.status_code == 200
    r = c.get("/api/ai/my-provider")
    assert r.json()["provider"]["base_url"] == "https://user2.fake.example/v1"
    assert r.json()["provider"]["api_key_hint"].endswith("y-99")

    # 删除 ⇒ 回 none
    assert c.delete("/api/ai/my-provider").json()["removed"] is True
    assert c.get("/api/ai/my-provider").json()["effective"] == "none"


def test_bad_base_url_rejected(env_client):
    r = env_client["alice"].put("/api/ai/my-provider", json={**PROVIDER, "base_url": "ftp://x.example/v1"})
    assert r.status_code == 422


def test_user_overrides_org_and_fallback(env_client):
    # 管理员配置机构接入
    r = env_client["admin"].put("/api/admin/settings", json={"ai_provider": ORG_PROVIDER})
    assert r.status_code == 200, r.text

    # 未自配的用户：生效来源=org，且回显机构脱敏
    rb = env_client["bob"].get("/api/ai/my-provider").json()
    assert rb["effective"] == "org"
    assert rb["org_fallback"]["has_api_key"] is True
    assert "sk-org-key-77" not in rb["org_fallback"]["api_key_hint"]

    # alice 自配后覆盖机构
    env_client["alice"].put("/api/ai/my-provider", json=PROVIDER)
    ra = env_client["alice"].get("/api/ai/my-provider").json()
    assert ra["effective"] == "user" and ra["org_fallback"] is not None

    # alice 清除后回退机构
    env_client["alice"].delete("/api/ai/my-provider")
    assert env_client["alice"].get("/api/ai/my-provider").json()["effective"] == "org"


def test_resolve_client_prefers_user_then_org(env_client, monkeypatch):
    from fastapi import HTTPException

    import app.domain.user_ai as ua

    captured = {}

    class FakeClient:
        def __init__(self, provider, models=None):
            captured["base_url"] = provider.base_url
            captured["key"] = provider.key
            captured["models"] = models or {}

    monkeypatch.setattr(ua, "AiClient", FakeClient)
    monkeypatch.setattr(ua, "OpenAICompatProvider",
                        lambda key, base_url=None: type("P", (), {"key": key, "base_url": base_url or ""})())

    # alice 自建（带 key）⇒ 用自建
    ua.save_user_provider("uid-alice", type("In", (), {"model_dump": lambda self: dict(PROVIDER)})())
    ua.resolve_ai_client(type("U", (), {"id": "uid-alice"})())
    assert captured["base_url"] == "https://user.fake.example/v1" and captured["key"] == "sk-user-key-99"
    # bob 未自建 ⇒ 回退机构（org.json 已由 admin 用例配置）
    ua.resolve_ai_client(type("U", (), {"id": "uid-bob"})())
    assert captured["base_url"] == "https://org.fake.example/v1" and captured["key"] == "sk-org-key-77"
    # 都没有 ⇒ 400 ai_not_configured（stub 掉机构配置，模拟两处均未配置）
    from app.domain.org import Org
    monkeypatch.setattr(ua, "load_org", lambda: Org())
    with pytest.raises(HTTPException) as ei:
        ua.resolve_ai_client(type("U", (), {"id": "uid-nobody"})())
    assert ei.value.status_code == 400
    assert ei.value.detail.get("kind") == "ai_not_configured"
