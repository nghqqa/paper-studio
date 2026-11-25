# -*- coding: utf-8 -*-
"""Zotero API Key 凭据回归（B2）：masked 永不回传 / 留空保留 / 匿名 401 / 工程零泄漏。"""
import importlib
import io
import json
import os
import sys
import zipfile

import pytest
from fastapi.testclient import TestClient

PW = "zot-cred-pw!"
KEY = "ztr-secret-key-9f8e7d6c"


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    base = tmp_path_factory.mktemp("zot-cred")
    env = {
        "PATENT_STUDIO_AUTH": "on",
        "PATENT_STUDIO_SECRET": "zot-cred-secret",
        "PATENT_PROJECTS_DIR": str(base / "projects"),
        "PATENT_STUDIO_LEGACY_DATABASE_URL": f"sqlite:///{base}/studio.db",
    }
    old = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    (base / "projects").mkdir()
    try:
        for name in ("app.config", "app.auth.db", "app.auth.users", "app.auth.acl", "app.auth.router", "app.main"):
            mod = sys.modules.get(name)
            if mod is not None:
                importlib.reload(mod)
            else:
                importlib.import_module(name)
        from app.main import app

        def register(email):
            cc = TestClient(app)
            assert cc.post("/api/auth/register", json={"email": email, "password": PW}).status_code in (200, 201)
            assert cc.post("/api/auth/cookie/login", data={"username": email, "password": PW},
                           headers={"Content-Type": "application/x-www-form-urlencoded"}).status_code == 204
            return cc

        yield {"app": app, "register": register}
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _url(path):
    return f"/api/zotero{path}"


def test_anonymous_get_is_401_when_auth_on(env):
    assert TestClient(env["app"]).get(_url("/credentials")).status_code == 401
    assert TestClient(env["app"]).put(_url("/credentials"), json={"api_key": KEY}).status_code == 401
    assert TestClient(env["app"]).delete(_url("/credentials")).status_code == 401


def test_put_get_masked_roundtrip_and_keep_on_empty(env):
    c = env["register"]("cred@zot.example.com")
    r = c.put(_url("/credentials"), json={"api_key": KEY, "zotero_user_id": "445566"})
    assert r.status_code == 200, r.text
    body = r.json()["credentials"]
    assert body["has_api_key"] is True and body["zotero_user_id"] == "445566"
    assert body["api_key_hint"].endswith(KEY[-4:])
    assert KEY not in r.text  # key 本体永不回传
    r = c.get(_url("/credentials"))
    assert KEY not in r.text and r.json()["credentials"]["has_api_key"] is True
    # 留空 = 保留已存值；可单独更新 zotero_user_id
    r = c.put(_url("/credentials"), json={"api_key": "", "zotero_user_id": "778899"})
    assert r.status_code == 200, r.text
    assert r.json()["credentials"]["zotero_user_id"] == "778899"
    assert r.json()["credentials"]["api_key_hint"].endswith(KEY[-4:])


def test_first_configure_requires_key(env):
    c = env["register"]("fresh@zot.example.com")
    r = c.put(_url("/credentials"), json={"api_key": "", "zotero_user_id": "1"})
    assert r.status_code == 400 and "不能为空" in r.text


def test_delete_clears(env):
    c = env["register"]("del@zot.example.com")
    assert c.put(_url("/credentials"), json={"api_key": KEY}).status_code == 200
    assert c.delete(_url("/credentials")).json()["credentials"]["has_api_key"] is False
    assert c.get(_url("/credentials")).json()["credentials"]["has_api_key"] is False


def test_credentials_never_inside_project_dir_or_export(env):
    import re

    c = env["register"]("leak@zot.example.com")
    assert c.put(_url("/credentials"), json={"api_key": KEY}).status_code == 200
    assert c.post("/api/projects/latex-demo", json={"template": "blank"}).status_code == 200
    pid = c.get("/api/projects").json()[0]["id"]
    project_dir = None
    from app import config as cfg

    for name in os.listdir(cfg.PROJECTS_DIR):
        if name == pid:
            project_dir = os.path.join(cfg.PROJECTS_DIR, name)
    assert project_dir and os.path.isdir(project_dir)
    # 工程 .studio/ 内无凭据文件
    studio = os.path.join(project_dir, ".studio")
    hits = [os.path.join(base, f) for base, _d, files in os.walk(studio) for f in files
            if "zotero-credentials" in base or "zotero-credentials" in f]
    assert hits == []
    # 整包导出 zip 无凭据文件与 key 本体
    r = c.get(f"/api/projects/{pid}/latex/export-zip")
    assert r.status_code == 200, r.text
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    assert not [n for n in zf.namelist() if "zotero-credentials" in n]
    assert KEY not in r.text


def test_redact_scrubs_key_from_error_text(tmp_path, monkeypatch):
    import app.config as cfg
    from app.domain import zotero_credentials as zc

    monkeypatch.setattr(cfg, "PROJECTS_DIR", str(tmp_path))
    zc.save_credentials("some-uid-123", api_key=KEY)
    noisy = f"connect failed while POSTing {KEY} upstream"
    assert zc.redact(noisy, "some-uid-123") == "connect failed while POSTing *** upstream"
    assert zc.redact("clean message", "some-uid-123") == "clean message"
    assert zc.redact(noisy, "no-such-user") == noisy  # 无已存 key 原样返回


def test_auth_off_falls_back_to_anon_single_file(tmp_path, monkeypatch):
    import app.config as cfg
    from app.domain import zotero_credentials as zc

    monkeypatch.setattr(cfg, "PROJECTS_DIR", str(tmp_path))
    monkeypatch.setattr(cfg, "AUTH_ON", False)
    zc.save_credentials(None, api_key="anon-key-1234", zotero_user_id="42")
    path = zc.credentials_path(None)
    assert path.endswith(os.path.join(".studio", "zotero-credentials", "anon.json"))
    assert zc.load_credentials(None)["api_key"] == "anon-key-1234"
    assert zc.masked_out(zc.load_credentials(None))["has_api_key"] is True
    assert zc.clear_credentials(None) is True
    assert zc.load_credentials(None) is None
