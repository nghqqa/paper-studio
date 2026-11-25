# -*- coding: utf-8 -*-
"""AI 润色 / 模型接入配置 / 科研图表渲染 路由测试（v0.3）。

复用 test_latex_product 的 client fixture 形态（tmp_path + AUTH=on）。模型调用全部打桩，
不联网；图表渲染用 matplotlib Agg 真实出图。
"""
import importlib
import os
import sys

import pytest
from fastapi.testclient import TestClient

PW = "paper-pw!"
ENV = {"PATENT_STUDIO_AUTH": "on", "PATENT_STUDIO_SECRET": "ai-secret"}


def _fresh(name):
    mod = sys.modules.get(name)
    return importlib.reload(mod) if mod is not None else importlib.import_module(name)


import sys  # noqa: E402


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    # module 作用域：同一进程内第二次新建 app 的 auth reload 链不可靠（与 test_struct_writer 同规避）
    base = tmp_path_factory.mktemp("ai-polish")
    env = {
        "PATENT_STUDIO_AUTH": "on",
        "PATENT_STUDIO_SECRET": "ai-secret",
        "PATENT_PROJECTS_DIR": str(base / "projects"),
        "PATENT_STUDIO_LEGACY_DATABASE_URL": f"sqlite:///{base}/studio.db",
    }
    old = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    (base / "projects").mkdir()
    try:
        for name in ("app.config", "app.auth.db", "app.auth.acl", "app.auth.router", "app.main"):
            _fresh(name)
        from app.main import app
        c = TestClient(app)

        def register(email):
            cc = TestClient(app)
            st = cc.post("/api/auth/register", json={"email": email, "password": PW})
            assert st.status_code in (200, 201), st.text
            st = cc.post("/api/auth/cookie/login", data={"username": email, "password": PW},
                         headers={"Content-Type": "application/x-www-form-urlencoded"})
            assert st.status_code == 204, st.status_code
            return cc

        admin = register("admin@ai.example.com")  # 首注=超管
        yield {"client": c, "admin": admin}
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def test_polish_requires_provider(client):
    anon = client["client"]
    r = anon.post("/api/ai/polish", json={"text": "这句需要润色。", "mode": "polish"})
    assert r.status_code == 401
    r = client["admin"].post("/api/ai/polish", json={"text": "这句需要润色。", "mode": "polish"})
    assert r.status_code == 400
    assert "未配置" in r.json()["detail"]["message"]


def test_polish_with_provider_and_mocked_chat(client, monkeypatch):
    c = client["admin"]
    # 配置 provider（经管理员接口，走真实存储路径）
    r = c.put("/api/admin/settings", json={"ai_provider": {
        "base_url": "https://api.fake.example/v1", "api_key": "sk-test",
        "model_interactive": "m1", "model_heavy": "m2", "model_fallback": "m1"}})
    assert r.status_code == 200, r.text
    masked = r.json().get("ai_provider") or c.get("/api/admin/settings").json()["ai_provider"]
    assert masked["has_api_key"] is True and "sk-test" not in r.text

    # 打桩 chat：拦截 AiClient.chat 返回固定结果
    calls = {}

    class FakeResult:
        text = "这句已经润色。"
        model = "m1"
        usage = None
        ms = 1
        fallback = False

    class FakeClient:
        def __init__(self, provider, models=None):
            calls["models"] = models
            calls["base_url"] = provider.base_url
            calls["key"] = provider.key

        async def chat(self, messages, purpose, **kw):
            calls["messages"] = messages
            return FakeResult()

    import app.domain.user_ai as user_ai_mod
    monkeypatch.setattr(user_ai_mod, "AiClient", FakeClient)
    monkeypatch.setattr(user_ai_mod, "OpenAICompatProvider", lambda key, base_url=None: type("P", (), {"key": key, "base_url": base_url or "", "name": "fake"})())

    r = c.post("/api/ai/polish", json={"text": "原始句子。", "mode": "academic"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["text"] == "这句已经润色。" and body["model"] == "m1"
    assert calls["base_url"] == "https://api.fake.example/v1" and calls["key"] == "sk-test"
    assert any(m["role"] == "system" for m in calls["messages"])

    # 脱敏：任何接口都不回传 api_key
    assert "sk-test" not in c.get("/api/admin/settings").text


def test_polish_rejects_bad_mode(client):
    r = client["admin"].post("/api/ai/polish", json={"text": "ok", "mode": "nope"})
    assert r.status_code == 422


def test_provider_test_endpoint_reports_unreachable(client):
    r = client["admin"].post("/api/admin/settings/ai-provider/test", json={
        "base_url": "http://127.0.0.1:9", "api_key": "k", "model": "m"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False and "无法连接" in body["error"]


def test_charts_render_line_png(client):
    r = client["admin"].post("/api/charts/render", json={
        "type": "line", "title": "对比", "x_label": "轮次", "y_label": "精度",
        "categories": ["1", "2", "3"],
        "series": [{"name": "基线", "values": [0.8, 0.85, 0.9]}, {"name": "本文", "values": [0.86, 0.9, 0.95]}]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["data_url"].startswith("data:image/png;base64,") and body["bytes"] > 1000
    # 插件运行在 HTTP 内网（无 crypto.subtle）：尺寸与 sha256 必须由服务端给出。
    import base64 as _b64, hashlib as _hashlib

    png = _b64.b64decode(body["data_url"].split(",", 1)[1])
    assert body["width_px"] > 0 and body["height_px"] > 0
    assert body["sha256"] == _hashlib.sha256(png).hexdigest()


def test_charts_render_rejects_mismatch(client):
    r = client["admin"].post("/api/charts/render", json={
        "type": "line", "categories": ["a", "b"], "series": [{"name": "s", "values": [1, 2, 3]}]})
    assert r.status_code == 422


def test_charts_render_pie_single_series(client):
    r = client["admin"].post("/api/charts/render", json={
        "type": "pie", "categories": ["A", "B"], "series": [{"name": "占比", "values": [1, 2]}]})
    assert r.status_code == 200
