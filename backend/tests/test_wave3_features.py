# -*- coding: utf-8 -*-
"""Wave 3 平台化与国际化综合回归测试：
1. 科研图表新增类型（radar / violin / forest / grouped_bar）+ Vision OCR 图片识别数据还原（POST /api/charts/from-image）
2. 通用企业 OIDC / OAuth 2.0 单点登录 SSO（config / PKCE login 302 / callback 建号与会话 Cookie 签发）
3. 项目便携整档（.zip）导出/导入往返（含术语表/回复信/文献，Zip-Slip 422 与下载禁令 403）
4. 管理端数据目录健康体检与 SQLite 一致性热备（含 PAT 密钥隔离与非超管 403）
"""
from __future__ import annotations

import asyncio
import importlib
import io
import json
import os
import sqlite3
import sys
import zipfile
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


_ONE_PX_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc```\x00\x00"
    b"\x00\x04\x00\x01\xf6\x178U\x00\x00\x00\x00IEND\xaeB`\x82"
)


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    base = tmp_path_factory.mktemp("wave3")
    projects = base / "projects"
    projects.mkdir()
    vars_env = {
        "PATENT_STUDIO_AUTH": "on",
        "PATENT_STUDIO_SECRET": "wave3-test-auth-secret-at-least-32-bytes!",
        "PATENT_PROJECTS_DIR": str(projects),
        "PATENT_STUDIO_LEGACY_DATABASE_URL": f"sqlite:///{base}/studio.db",
        "PATENT_STUDIO_WORD_EDITOR": "on",
        "PATENT_STUDIO_ONLYOFFICE_JWT_SECRET": "wave3-word-secret",
        "PATENT_STUDIO_ONLYOFFICE_URL": "http://localhost:9980",
        "PATENT_STUDIO_ONLYOFFICE_INTERNAL_URL": "http://onlyoffice:80",
        "PATENT_STUDIO_ONLYOFFICE_PUBLIC_URL": "http://studio:8000",
        "PATENT_STUDIO_PUBLIC_ORIGIN": "",
        "PAPER_STUDIO_PRODUCT": "paper",
        "PAPER_STUDIO_OIDC_ISSUER": "https://sso.fake.example",
        "PAPER_STUDIO_OIDC_CLIENT_ID": "ps-oidc-client",
        "PAPER_STUDIO_OIDC_CLIENT_SECRET": "ps-oidc-secret",
        "PAPER_STUDIO_OIDC_LABEL": "实验室 SSO 登录",
    }
    saved_modules = {k: m for k, m in sys.modules.items() if k == "app" or k.startswith("app.")}
    saved_env = {k: os.environ.get(k) for k in vars_env}
    os.environ.update(vars_env)
    try:
        for name in list(sys.modules):
            if name == "app" or name.startswith("app."):
                del sys.modules[name]
        import app.main as main_mod

        importlib.reload(main_mod)
        app = main_mod.app

        def reg(name: str) -> TestClient:
            c = TestClient(app)
            email = f"{name}@wave3.example.com"
            r = c.post("/api/auth/register", json={"email": email, "password": "Wave3-test-pw!", "display_name": name})
            assert r.status_code in (200, 201), r.text
            r2 = c.post(
                "/api/auth/cookie/login",
                data={"username": email, "password": "Wave3-test-pw!"},
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            assert r2.status_code == 204, r2.text
            return c

        admin = reg("admin")
        users = {k: reg(k) for k in ("owner", "viewer")}
        assert (
            admin.put(
                "/api/admin/settings",
                json={
                    "ai_provider": {
                        "base_url": "https://api.fake.example/v1",
                        "api_key": "sk-wave3-secret-key",
                        "model_interactive": "m-vision",
                        "model_heavy": "m-heavy",
                        "model_fallback": "m-vision",
                    }
                },
            ).status_code
            == 200
        )
        yield {"app": app, "admin": admin, "users": users, "projects": projects, "base": base}
    finally:
        for k, v in saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        for k in [k for k in sys.modules if k == "app" or k.startswith("app.")]:
            del sys.modules[k]
        sys.modules.update(saved_modules)


def test_charts_new_types_and_vision_from_image(env, monkeypatch):
    owner = env["users"]["owner"]
    for ctype, payload in (
        (
            "radar",
            {
                "type": "radar",
                "title": "Radar Eval",
                "categories": ["Acc", "F1", "Latency", "Memory"],
                "series": [{"name": "Ours", "values": [91, 89, 82, 85]}],
                "palette": "academic",
                "show_values": True,
            },
        ),
        (
            "violin",
            {
                "type": "violin",
                "categories": ["S1", "S2", "S3", "S4"],
                "series": [{"name": "Baseline", "values": [78, 80, 77, 81]}, {"name": "Ours", "values": [88, 90, 87, 91]}],
            },
        ),
        (
            "forest",
            {
                "type": "forest",
                "categories": ["SubA", "SubB", "Overall"],
                "series": [{"name": "OR", "values": [1.4, 1.8, 1.55], "errors": [0.2, 0.3, 0.15]}],
                "show_values": True,
            },
        ),
        (
            "grouped_bar",
            {
                "type": "grouped_bar",
                "categories": ["MMLU", "GSM8K"],
                "series": [{"name": "Base", "values": [64.0, 58.0]}, {"name": "Ours", "values": [73.0, 75.0]}],
                "show_values": True,
            },
        ),
    ):
        r = owner.post("/api/charts/render", json=payload)
        assert r.status_code == 200, (ctype, r.text)
        body = r.json()
        assert body["data_url"].startswith("data:image/png;base64,")
        assert body["width_px"] > 100 and body["height_px"] > 100

    # Vision OCR 图表还原测试（mock 多模态模型返回值 + 非法扩展名拦截 422）
    assert (
        owner.post(
            "/api/charts/from-image",
            files={"file": ("notes.txt", b"not-an-image", "text/plain")},
        ).status_code
        == 422
    )

    import app.domain.user_ai as ua

    captured: list = []

    class _Res:
        text = json.dumps(
            {
                "type": "radar",
                "title": "Extracted Radar",
                "x_label": "",
                "y_label": "",
                "categories": ["Precision", "Recall", "Speed"],
                "series": [{"name": "ModelA", "values": [92.1, 88.4, 79.0]}],
            }
        )
        model = "m-vision"

    class _Client:
        async def chat(self, messages, purpose, **kwargs):
            captured.append((messages, purpose, kwargs))
            return _Res()

    monkeypatch.setattr(ua, "resolve_ai_client", lambda *a, **kw: (_Client(), None))
    rv = owner.post(
        "/api/charts/from-image",
        files={"file": ("plot.png", _ONE_PX_PNG, "image/png")},
        data={"hint": "Extract percentages"},
    )
    assert rv.status_code == 200, rv.text
    out = rv.json()
    assert out["chart"]["type"] == "radar"
    assert out["chart"]["categories"] == ["Precision", "Recall", "Speed"]
    assert isinstance(captured[0][0][1]["content"], list)
    assert captured[0][0][1]["content"][1]["type"] == "image_url"


def test_oidc_sso_discovery_pkce_and_login(env, monkeypatch):
    anon = TestClient(env["app"])
    cfg = anon.get("/api/auth/oidc/config").json()
    assert cfg == {"enabled": True, "label": "实验室 SSO 登录"}
    meta = anon.get("/api/meta").json()
    assert meta["oidc"]["enabled"] is True

    import app.auth.oidc as oidc_mod

    class _FakeResp:
        def __init__(self, status_code: int, payload: dict):
            self.status_code = status_code
            self._payload = payload

        def raise_for_status(self):
            if self.status_code >= 400:
                raise RuntimeError(f"http {self.status_code}")

        def json(self):
            return self._payload

    class _FakeHttp:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, url, **kwargs):
            if url.endswith("/.well-known/openid-configuration"):
                return _FakeResp(
                    200,
                    {
                        "authorization_endpoint": "https://sso.fake.example/authorize",
                        "token_endpoint": "https://sso.fake.example/token",
                        "userinfo_endpoint": "https://sso.fake.example/userinfo",
                    },
                )
            if url == "https://sso.fake.example/userinfo":
                return _FakeResp(200, {"email": "sso.researcher@wave3.example.com", "name": "SSO Researcher"})
            return _FakeResp(404, {})

        async def post(self, url, **kwargs):
            assert url == "https://sso.fake.example/token"
            return _FakeResp(200, {"access_token": "oidc-access-123"})

    monkeypatch.setattr(oidc_mod.httpx, "AsyncClient", _FakeHttp)

    r_login = anon.get("/api/auth/oidc/login", follow_redirects=False)
    assert r_login.status_code == 302, r_login.text
    qs = parse_qs(urlparse(r_login.headers["location"]).query)
    assert qs["code_challenge_method"] == ["S256"]
    state = qs["state"][0]

    # 无效 state 拒绝 400
    assert anon.get("/api/auth/oidc/callback?state=bad-state&code=c1", follow_redirects=False).status_code == 400

    # 有效回调自动建号并签发 Cookie 会话，跳转 /#/
    r_cb = anon.get(f"/api/auth/oidc/callback?state={state}&code=good-code", follow_redirects=False)
    assert r_cb.status_code == 302, r_cb.text
    assert r_cb.headers["location"] == "/#/"
    me = anon.get("/api/users/me")
    assert me.status_code == 200, me.text
    assert me.json()["email"] == "sso.researcher@wave3.example.com"


def test_portable_project_archive_export_import_and_security(env):
    owner = env["users"]["owner"]
    viewer = env["users"]["viewer"]

    r = owner.post("/api/projects/latex-demo", json={"template": "blank"})
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    assert owner.put(f"/api/projects/{pid}/members", json={"email": "viewer@wave3.example.com", "role": "viewer"}).status_code == 200

    # 写入术语与回复信状态验证整档完整携带
    assert owner.post(f"/api/projects/{pid}/glossary", json={"term": "GraphSAGE", "category": "term"}).status_code == 200
    assert owner.post(f"/api/projects/{pid}/rebuttal/parse", json={"text": "Reviewer 1\nClarify dataset split."}).status_code == 200

    # 协作禁下载开启后拒绝导出整档
    owner.put(f"/api/projects/{pid}/collab-settings", json={"allow_download": False})
    assert viewer.get(f"/api/projects/{pid}/archive/export").status_code == 403
    owner.put(f"/api/projects/{pid}/collab-settings", json={"allow_download": True})

    arch = viewer.get(f"/api/projects/{pid}/archive/export")
    assert arch.status_code == 200 and arch.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(arch.content)) as zf:
        names = set(zf.namelist())
        assert {"manifest.json", "studio.json", ".studio/glossary.json", ".studio/rebuttal/state.json"}.issubset(names)
        assert not any(".studio/latex-builds" in n for n in names)

    # Zip-Slip 恶意路径拦截 422
    bad_buf = io.BytesIO()
    with zipfile.ZipFile(bad_buf, "w") as zf:
        zf.writestr("manifest.json", json.dumps({"schema": "paper-studio/archive@1"}))
        zf.writestr("../../escaped.txt", "pwn")
    assert (
        owner.post(
            "/api/projects/archive/import",
            files={"file": ("bad.zip", bad_buf.getvalue(), "application/zip")},
        ).status_code
        == 422
    )

    # 导入为全新独立项目，原术语/回复信完整保留且导入者自动获得 owner 权限
    imp = owner.post(
        "/api/projects/archive/import",
        files={"file": ("project.zip", arch.content, "application/zip")},
        data={"preferred_id": f"{pid}-clone"},
    )
    assert imp.status_code == 200, imp.text
    new_pid = imp.json()["project"]["id"]
    assert new_pid != pid
    gl = owner.get(f"/api/projects/{new_pid}/glossary").json()
    assert any(e["term"] == "GraphSAGE" for e in gl["entries"])
    reb = owner.get(f"/api/projects/{new_pid}/rebuttal").json()
    assert len(reb["items"]) == 1


def test_admin_data_health_and_backup_isolation(env, tmp_path):
    admin = env["admin"]
    owner = env["users"]["owner"]
    viewer = env["users"]["viewer"]

    # 创建至少一条 PAT，验证平台备份绝不泄露 pat-tokens
    assert owner.post("/api/tokens", json={"name": "LeakCheckToken"}).status_code == 201

    # 非超管拒绝 403
    assert viewer.get("/api/admin/data/health").status_code == 403
    assert viewer.get("/api/admin/data/backup").status_code == 403

    rh = admin.get("/api/admin/data/health")
    assert rh.status_code == 200, rh.text
    h = rh.json()
    assert h["project_count"] >= 1
    assert h["db"]["ok"] is True
    assert h["storage"]["total_bytes"] > 0
    assert h["disk"]["free_bytes"] > 0

    rb = admin.get("/api/admin/data/backup?include_projects=true")
    assert rb.status_code == 200 and rb.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(rb.content)) as zf:
        names = set(zf.namelist())
        assert "studio.db" in names
        assert "backup-manifest.json" in names
        assert not any("pat-tokens" in n for n in names)
        org_data = json.loads(zf.read(".studio/org.json").decode("utf-8"))
        assert org_data["ai_provider"]["api_key"] == ""

        db_out = tmp_path / "restored.db"
        db_out.write_bytes(zf.read("studio.db"))
        conn = sqlite3.connect(db_out)
        try:
            chk = conn.execute("PRAGMA integrity_check").fetchone()
            assert chk and chk[0] == "ok"
        finally:
            conn.close()
