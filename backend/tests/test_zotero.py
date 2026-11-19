# -*- coding: utf-8 -*-
"""Zotero 公开群组导入测试（v0.5）：全部 httpx.MockTransport 打桩，**不联网**；
真实公开群组验收记录在 E2E Phase Z / docs。adapter 单独锁契约（外部 API 变动只改 domain 一处）。"""
import importlib
import json
import os
import sys

import httpx
import pytest
from fastapi.testclient import TestClient

PW = "zot-pw!"

BIB_PAGE1 = "@article{einstein1905,\n  title = {Ist die Tragheit...},\n  author = {Einstein, A.},\n  year = {1905}\n}\n"
BIB_PAGE2 = "@book{knuth1984,\n  title = {The TeXbook},\n  author = {Knuth, D. E.},\n  year = {1984}\n}\n"

GROUP_JSON = {"id": 12345, "name": "E2E 群组", "data": {"id": 12345, "name": "E2E 群组",
                                                       "description": "测试用公开群组"}}
COLLECTIONS_JSON = [
    {"key": "COLL1", "data": {"key": "COLL1", "name": "方法一", "parentCollection": False}},
    {"key": "COLL2", "data": {"key": "COLL2", "name": "子集合", "parentCollection": "COLL1"}},
]


def _fresh(name):
    mod = sys.modules.get(name)
    return importlib.reload(mod) if mod is not None else importlib.import_module(name)


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    base = tmp_path_factory.mktemp("zotero")
    env = {
        "PATENT_STUDIO_AUTH": "on",
        "PATENT_STUDIO_SECRET": "zot-secret",
        "PATENT_PROJECTS_DIR": str(base / "projects"),
        "PATENT_STUDIO_LEGACY_DATABASE_URL": f"sqlite:///{base}/studio.db",
    }
    old = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    (base / "projects").mkdir()
    try:
        for name in ("app.config", "app.auth.db", "app.auth.users", "app.auth.acl", "app.auth.router", "app.main"):
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

        register("admin@zot.example.com")
        yield {"app": app, "register": register}
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _patch_client(monkeypatch, handler):
    import app.domain.zotero_sources as ZS
    import app.config as cfg

    monkeypatch.setattr(cfg, "LIBRARY_SOURCE_MIN_INTERVAL_S", 0.0, raising=False)
    # 替换 transport 但保留模块真实 headers（版本头/鉴权头契约仍受测；v2 _client 带 api_key）
    monkeypatch.setattr(ZS, "_client", lambda api_key=None: httpx.AsyncClient(
        transport=httpx.MockTransport(handler), timeout=5, follow_redirects=False,
        headers=ZS._headers(api_key)))


def _new_project(env, monkeypatch, email):
    """latex 工程（bib 模式）+ 新建空 refs.bib；返回 (client, pid, bib_path, bib_sha)。"""
    c = env["register"](email)
    r = c.post("/api/projects/latex-demo", json={"template": "blank"})
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    r = c.post(f"/api/projects/{pid}/library/bib-file", json={"name": "refs.bib"})
    assert r.status_code in (200, 201), r.text
    bib = r.json()
    return c, pid, bib["path"], bib["sha"]


# ---------------------------------------------------------------- adapter ----


def test_parse_group_id():
    import app.domain.zotero_sources as ZS

    assert ZS.parse_group_id("12345") == 12345
    assert ZS.parse_group_id(" https://www.zotero.org/groups/987/coollab/items ") == 987
    with pytest.raises(ZS.ZoteroError) as e:
        ZS.parse_group_id("not-a-number")
    assert e.value.status == 422


def test_adapters_lock_contract():
    import app.domain.zotero_sources as ZS

    meta = ZS._parse_group(GROUP_JSON)
    assert meta == {"id": 12345, "name": "E2E 群组", "description": "测试用公开群组"}
    cols = ZS._parse_collections(COLLECTIONS_JSON)
    assert cols[0] == {"key": "COLL1", "name": "方法一", "parent": None}
    assert cols[1]["parent"] == "COLL1"
    text, count = ZS._merge_bibtex_pages([BIB_PAGE1, BIB_PAGE2])
    assert count == 2 and "einstein1905" in text and "knuth1984" in text


# ---------------------------------------------------------------- 路由（打桩） ----


def test_collections_endpoint(env, monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/groups/111"):
            return httpx.Response(200, json=GROUP_JSON)
        if "/collections" in url:
            assert request.headers["Zotero-API-Version"] == "3"
            return httpx.Response(200, json=COLLECTIONS_JSON)
        return httpx.Response(500)

    _patch_client(monkeypatch, handler)
    c, pid, _bib, _sha = _new_project(env, monkeypatch, "zot-coll@zot.example.com")
    r = c.post(f"/api/projects/{pid}/library/zotero/collections", json={"group_id": "111"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["group"]["name"] == "E2E 群组"
    assert [x["key"] for x in body["collections"]] == ["COLL1", "COLL2"]
    # URL 形式同链路
    r = c.post(f"/api/projects/{pid}/library/zotero/collections",
               json={"group_id": "https://www.zotero.org/groups/111"})
    assert r.status_code == 200


def test_preview_parses_and_dedupes(env, monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/groups/222"):
            return httpx.Response(200, json=GROUP_JSON)
        if "format=bibtex" in url:
            return httpx.Response(200, text=BIB_PAGE1, headers={"Content-Type": "text/plain"})
        return httpx.Response(500)

    _patch_client(monkeypatch, handler)
    c, pid, _bib, _sha = _new_project(env, monkeypatch, "zot-prev@zot.example.com")
    r = c.post(f"/api/projects/{pid}/library/zotero/preview", json={"group_id": "222"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total_blocks"] == 1 and len(body["entries"]) == 1
    ent = body["entries"][0]
    assert ent["citation_key"] == "einstein1905" and ent["raw_bibtex"]
    assert body["source"] == {"provider": "zotero", "library_type": "group", "group_id": 222,
                              "collection_key": None, "zotero_user_id": None,
                              "truncated": False}
    assert body["group"]["name"] == "E2E 群组"


def test_preview_to_commit_writes_import_record(env, monkeypatch, tmp_path):
    """preview → commit（带 source）→ zotero-imports.json 记录（v2 刷新锚点）。"""
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/groups/333"):
            return httpx.Response(200, json=GROUP_JSON)
        if "format=bibtex" in url:
            return httpx.Response(200, text=BIB_PAGE1)
        return httpx.Response(500)

    _patch_client(monkeypatch, handler)
    c, pid, bib_path, bib_sha = _new_project(env, monkeypatch, "zot-commit@zot.example.com")
    r = c.post(f"/api/projects/{pid}/library/zotero/preview", json={"group_id": "333"})
    ent = r.json()["entries"][0]
    r = c.post(f"/api/projects/{pid}/library/commit", json={
        "entries": [{k: v for k, v in ent.items() if k not in ("duplicates", "key_conflict", "suggested_key")}],
        "target_bib": bib_path, "base_sha": bib_sha,
        "source": {"provider": "zotero", "group_id": 333, "collection_key": None,
                   "group_name": "E2E 群组"}})
    assert r.status_code == 200, r.text
    assert r.json()["total"] == 1
    # 导入记录落盘（.studio/library/zotero-imports.json）
    from app import config as cfg

    rec_path = os.path.join(cfg.PROJECTS_DIR, pid, ".studio", "library", "zotero-imports.json")
    with open(rec_path, encoding="utf-8") as f:
        rows = json.load(f)
    assert rows and rows[-1]["group_id"] == 333 and rows[-1]["count"] == 1
    # 列表接口可见（index 模式直写）
    r = c.get(f"/api/projects/{pid}/library")
    assert any(e["citation_key"] == "einstein1905" for e in r.json()["entries"])


def test_preview_pagination_and_truncation(env, monkeypatch):
    """分页拉取：PAGE_SIZE 打成 1，三页（1条+1条+空页）⇒ 共 2 条且未截断。"""
    import app.domain.zotero_sources as ZS

    monkeypatch.setattr(ZS, "PAGE_SIZE", 1)

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/groups/444"):
            return httpx.Response(200, json=GROUP_JSON)
        if "format=bibtex" in url:
            start = int(httpx.QueryParams(request.url.query).get("start", "0"))
            if start == 0:
                return httpx.Response(200, text=BIB_PAGE1)
            if start == 1:
                return httpx.Response(200, text=BIB_PAGE2)
            return httpx.Response(200, text="")
        return httpx.Response(500)

    _patch_client(monkeypatch, handler)
    c, pid, _bib, _sha = _new_project(env, monkeypatch, "zot-page@zot.example.com")
    r = c.post(f"/api/projects/{pid}/library/zotero/preview", json={"group_id": "444"})
    body = r.json()
    assert body["total_blocks"] == 2 and body["source"]["truncated"] is False


def test_group_not_found_and_rate_limit(env, monkeypatch):
    def handler404(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": "Not found"})

    _patch_client(monkeypatch, handler404)
    c, pid, _bib, _sha = _new_project(env, monkeypatch, "zot-404@zot.example.com")
    r = c.post(f"/api/projects/{pid}/library/zotero/collections", json={"group_id": "999"})
    assert r.status_code == 404
    assert "公开" in r.json()["detail"]["message"]

    def handler429(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"error": "Too Many"}, headers={"Retry-After": "0"})

    _patch_client(monkeypatch, handler429)
    r = c.post(f"/api/projects/{pid}/library/zotero/collections", json={"group_id": "999"})
    assert r.status_code == 429


def test_invalid_group_id_422(env):
    c, pid, _bib, _sha = _new_project(env, None, "zot-bad@zot.example.com")  # 无出站请求
    r = c.post(f"/api/projects/{pid}/library/zotero/collections", json={"group_id": "abc!!!"})
    assert r.status_code == 422
