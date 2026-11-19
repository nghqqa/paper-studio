# -*- coding: utf-8 -*-
"""Zotero v2 一键刷新回归：鉴权头/用户库端点/401-403-404 文案、分类 diff、
rid 稳定、citation_order 保护、bib 单次合成落盘。全部 MockTransport，不联网。"""
import importlib
import json
import os
import sys

import httpx
import pytest
from fastapi.testclient import TestClient

PW = "zot-refresh-pw!"
KEY = "ztr-refresh-key-11223344"
GROUP_JSON = {"id": 333, "data": {"id": 333, "name": "刷新群组", "description": ""}}

BIB_V1 = "@article{einstein1905,\n  title = {Ist die Tragheit},\n  author = {Einstein, A.},\n  year = {1905}\n}\n"
BIB_V2 = "@article{einstein1905,\n  title = {Ist die Tragheit},\n  author = {Einstein, A.},\n  year = {1915}\n}\n"
BIB_NEW = "@book{bohr1913,\n  title = {On the Constitution},\n  author = {Bohr, N.},\n  year = {1913}\n}\n"


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    base = tmp_path_factory.mktemp("zot-refresh")
    env = {
        "PATENT_STUDIO_AUTH": "on",
        "PATENT_STUDIO_SECRET": "zot-refresh-secret",
        "PATENT_PROJECTS_DIR": str(base / "projects"),
        "PATENT_STUDIO_LEGACY_DATABASE_URL": f"sqlite:///{base}/studio.db",
        "PATENT_STUDIO_WORD_EDITOR": "on",
        "PATENT_STUDIO_ONLYOFFICE_JWT_SECRET": "zot-refresh-only",
        "PATENT_STUDIO_ONLYOFFICE_URL": "http://localhost:9980",
        "PATENT_STUDIO_ONLYOFFICE_INTERNAL_URL": "http://onlyoffice:80",
        "PATENT_STUDIO_ONLYOFFICE_PUBLIC_URL": "http://studio:8000",
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
        from patent_studio.asgi import create_app

        app = create_app()

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


def _patch_client(monkeypatch, handler, seen=None):
    import app.config as cfg
    import app.domain.zotero_sources as ZS

    monkeypatch.setattr(cfg, "LIBRARY_SOURCE_MIN_INTERVAL_S", 0.0, raising=False)

    def wrapped(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        return handler(request)

    monkeypatch.setattr(ZS, "_client", lambda api_key=None: httpx.AsyncClient(
        transport=httpx.MockTransport(wrapped), timeout=5, follow_redirects=False,
        headers=ZS._headers(api_key)))


def _bib_handler(text_by_group):
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "/groups/" in url and "format=bibtex" not in url:
            return httpx.Response(200, json=GROUP_JSON)
        if "/users/" in url and "format=bibtex" not in url:
            return httpx.Response(200, json={})
        if "format=bibtex" in url:
            gid = url.split("/groups/")[1].split("/")[0] if "/groups/" in url else None
            if gid is None:
                uid = url.split("/users/")[1].split("/")[0]
                gid = f"user-{uid}"
            body = text_by_group.get(str(gid), "")
            if not body:
                return httpx.Response(200, text="", headers={"Content-Type": "text/plain"})
            return httpx.Response(200, text=body, headers={"Content-Type": "text/plain"})
        return httpx.Response(500)
    return handler


def _preview_and_commit(c, pid, group_id="333", bibtex=BIB_V1, mode_bib=None, base_sha=None):
    """preview → 全选 commit（带 source 锚点）；bib 模式带 target_bib/base_sha。返回 commit 响应。"""
    r = c.post(f"/api/projects/{pid}/library/zotero/preview", json={"group_id": group_id})
    assert r.status_code == 200, r.text
    entries = [e for e in r.json()["entries"] if not e.get("duplicates")]
    assert entries, "预览无条目"
    body = {"entries": entries, "target_bib": mode_bib, "base_sha": base_sha,
            "source": {"provider": "zotero", "group_id": int(group_id), "collection_key": None,
                       "group_name": "刷新群组", "library_type": "group", "zotero_user_id": None}}
    r = c.post(f"/api/projects/{pid}/library/commit", json=body)
    assert r.status_code == 200, r.text
    return r.json()


# ---------------------------------------------------------------- v2 源与鉴权 ----


def test_api_key_header_and_user_library_endpoint(env, monkeypatch):
    import app.domain.zotero_sources as ZS

    seen: list = []
    _patch_client(monkeypatch, _bib_handler({"user-445566": BIB_V1}), seen)
    out = ZS.sync_via = None
    import asyncio
    fetched = asyncio.run(ZS.fetch_user_bibtex("445566", api_key=KEY))
    assert fetched["count"] == 1 and "einstein1905" in fetched["bibtex"]
    req = seen[-1]
    assert str(req.url).startswith("https://api.zotero.org/users/445566/items/top")
    assert req.headers["Zotero-API-Key"] == KEY
    assert req.headers["Zotero-API-Version"] == "3"
    # 公开群组（无 key）：请求头不带鉴权
    seen.clear()
    asyncio.run(ZS.fetch_bibtex(333))
    assert "Zotero-API-Key" not in seen[-1].headers
    assert str(seen[-1].url).startswith("https://api.zotero.org/groups/333/items/top")


def test_auth_error_messages(env, monkeypatch):
    import app.domain.zotero_sources as ZS

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/401g"):
            return httpx.Response(401)
        if url.endswith("/403g"):
            return httpx.Response(403)
        if url.endswith("/404g"):
            return httpx.Response(404)
        return httpx.Response(500)

    _patch_client(monkeypatch, handler)
    for suffix, kind, frag in (("401g", "source_auth", "无效或已过期"),
                               ("403g", "source_auth", "无访问权限")):
        with pytest.raises(ZS.ZoteroError) as e:
            ZS.parse_group_id = ZS.parse_group_id  # keep import alive
            import asyncio
            asyncio.run(ZS._get(f"https://api.zotero.org/groups/{suffix}", api_key=KEY))
        assert e.value.kind == kind and frag in e.value.message
    import asyncio
    with pytest.raises(ZS.ZoteroError) as e:
        asyncio.run(ZS._get("https://api.zotero.org/groups/404g", api_key=KEY))
    assert "无权访问" in e.value.message
    with pytest.raises(ZS.ZoteroError) as e:
        asyncio.run(ZS._get("https://api.zotero.org/groups/404g"))
    assert "公开群组" in e.value.message  # 无 key 保留 v1 语义


def test_refresh_user_library_requires_key(env, monkeypatch):
    c = env["register"]("needkey@zot.example.com")
    assert c.post("/api/projects/word/create", json={"title": "T", "template": "blank"}).status_code == 200
    pid = c.get("/api/projects").json()[0]["id"]
    r = c.post(f"/api/projects/{pid}/library/zotero/refresh-preview",
               json={"library_type": "user", "zotero_user_id": "445566"})
    assert r.status_code == 422 and "API Key" in r.text
    anon = TestClient(env["app"])
    r = anon.post(f"/api/projects/{pid}/library/zotero/refresh-preview",
                  json={"library_type": "user", "zotero_user_id": "445566"})
    assert r.status_code == 401


# ---------------------------------------------------------------- index 模式刷新 ----


def _word_project(env, c):
    r = c.post("/api/projects/word/create", json={"title": "刷新", "template": "blank"})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_refresh_baseline_zero_after_import(env, monkeypatch):
    _patch_client(monkeypatch, _bib_handler({"333": BIB_V1}))
    c = env["register"]("base@zot.example.com")
    pid = _word_project(env, c)
    _preview_and_commit(c, pid)
    r = c.post(f"/api/projects/{pid}/library/zotero/refresh-preview", json={"group_id": 333})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["counts"] == {"added": 0, "updated": 0, "removed": 0, "unchanged": 1}
    assert body["removed_supported"] is True and body["mode"] == "index"


def test_refresh_update_and_add_commit_keeps_rid_and_key(env, monkeypatch):
    _patch_client(monkeypatch, _bib_handler({"333": BIB_V1}))
    c = env["register"]("upd@zot.example.com")
    pid = _word_project(env, c)
    committed = _preview_and_commit(c, pid)
    rid = committed["reference_ids"][0]
    from app.domain import library as lib

    index = lib.load_index(f'{os.environ["PATENT_PROJECTS_DIR"]}/{pid}')
    assert index.entries[0].source["group_id"] == 333  # commit 已把溯源写入条目
    _patch_client(monkeypatch, _bib_handler({"333": BIB_V2 + "\n" + BIB_NEW}))
    r = c.post(f"/api/projects/{pid}/library/zotero/refresh-preview", json={"group_id": 333})
    body = r.json()
    assert body["counts"]["added"] == 1 and body["counts"]["updated"] == 1
    upd = body["updated"][0]
    assert upd["reference_id"] == rid and upd["old"]["year"] == "1905" and upd["new"]["year"] == "1915"
    r = c.post(f"/api/projects/{pid}/library/zotero/refresh-commit", json={
        "group_id": 333,
        "updates": [{"reference_id": rid, "entry": upd["entry"]}],
        "additions": body["added"],
    })
    assert r.status_code == 200, r.text
    assert r.json()["applied"] == {"added": 1, "updated": 1, "removed": 0}
    index = lib.load_index(f'{os.environ["PATENT_PROJECTS_DIR"]}/{pid}')
    kept = next(e for e in index.entries if e.reference_id == rid)
    assert kept.citation_key == "einstein1905" and kept.year == "1915"  # rid/key 稳定、字段已更新
    assert len(index.entries) == 2
    recs = json.loads(open(f'{os.environ["PATENT_PROJECTS_DIR"]}/{pid}/.studio/library/zotero-imports.json',
                           encoding="utf-8").read())
    assert recs[-1]["refresh"] is True and recs[-1]["library_type"] == "group"


def test_refresh_removed_requires_explicit_citation_order_consent(env, monkeypatch):
    _patch_client(monkeypatch, _bib_handler({"333": BIB_V1 + "\n" + BIB_NEW}))
    c = env["register"]("rm@zot.example.com")
    pid = _word_project(env, c)
    committed = _preview_and_commit(c, pid)
    rids = committed["reference_ids"]
    from app.domain import library as lib

    pdir = f'{os.environ["PATENT_PROJECTS_DIR"]}/{pid}'
    index = lib.load_index(pdir)
    index.citation_order = list(rids)  # 模拟两条都已在 Word 引用顺序表
    lib.save_index(pdir, index)
    # 远端只剩 einstein1905 → bohr1913 判 removed
    _patch_client(monkeypatch, _bib_handler({"333": BIB_V1}))
    r = c.post(f"/api/projects/{pid}/library/zotero/refresh-preview", json={"group_id": 333})
    body = r.json()
    assert body["counts"]["removed"] == 1
    removed_rid = body["removed"][0]["reference_id"]
    assert removed_rid == rids[1] and body["removed"][0]["in_citation_order"] is True
    # 未勾选 → 整体拒绝
    r = c.post(f"/api/projects/{pid}/library/zotero/refresh-commit",
               json={"group_id": 333, "removals": [removed_rid]})
    assert r.status_code == 422 and "引用顺序表" in r.text
    index = lib.load_index(pdir)
    assert len(index.entries) == 2 and index.citation_order == rids  # 未落盘
    # 勾选 → 只摘除该 rid，其余顺序保留
    r = c.post(f"/api/projects/{pid}/library/zotero/refresh-commit", json={
        "group_id": 333, "removals": [removed_rid], "remove_from_citation_order": True})
    assert r.status_code == 200, r.text
    index = lib.load_index(pdir)
    assert [e.reference_id for e in index.entries] == rids[:1]
    assert index.citation_order == rids[:1]


# ---------------------------------------------------------------- bib 模式刷新 ----


def _latex_project_with_bib(env, c, email_hint):
    r = c.post("/api/projects/latex-demo", json={"template": "blank"})
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    r = c.post(f"/api/projects/{pid}/library/bib-file", json={"name": "refs.bib"})
    assert r.status_code in (200, 201), r.text
    return pid, r.json()["path"], r.json()["sha"]


def test_refresh_bib_mode_single_write(env, monkeypatch):
    _patch_client(monkeypatch, _bib_handler({"333": BIB_V1}))
    c = env["register"]("bib@zot.example.com")
    pid, bib_rel, sha0 = _latex_project_with_bib(env, c, "bib")
    _preview_and_commit(c, pid, mode_bib=bib_rel, base_sha=sha0)
    from app.domain import library as lib
    from app.domain.latex_build import read_source_file

    project = type("P", (), {"dir": f'{os.environ["PATENT_PROJECTS_DIR"]}/{pid}',
                             "settings": {"source_format": "latex"}})()
    sha1 = lib.atomic_read(os.path.join(project.dir, *bib_rel.split("/")))
    import hashlib
    sha1 = hashlib.sha256(sha1.encode()).hexdigest()
    # 远端：更新 year + 新增一条 —— 单次 base 校验合成落盘（若循环逐条会 409）
    _patch_client(monkeypatch, _bib_handler({"333": BIB_V2 + "\n" + BIB_NEW}))
    r = c.post(f"/api/projects/{pid}/library/zotero/refresh-preview", json={"group_id": 333})
    body = r.json()
    assert body["counts"]["updated"] == 1 and body["counts"]["added"] == 1
    assert body["removed_supported"] is False
    r = c.post(f"/api/projects/{pid}/library/zotero/refresh-commit", json={
        "group_id": 333, "target_bib": bib_rel, "base_sha": sha1,
        "updates": [{"reference_id": body["updated"][0]["reference_id"], "entry": body["updated"][0]["entry"]}],
        "additions": body["added"],
    })
    assert r.status_code == 200, r.text
    content = lib.atomic_read(os.path.join(project.dir, *bib_rel.split("/")))
    assert "year = {1915}" in content and "bohr1913" in content and "einstein1905" in content
    # bib 模式 removals / 缺 base_sha 一律 422
    r = c.post(f"/api/projects/{pid}/library/zotero/refresh-commit", json={
        "group_id": 333, "target_bib": bib_rel, "base_sha": sha1, "removals": ["ref_x"]})
    assert r.status_code == 422
    r = c.post(f"/api/projects/{pid}/library/zotero/refresh-commit", json={
        "group_id": 333, "target_bib": bib_rel, "updates": []})
    assert r.status_code == 422


# ---------------------------------------------------------------- B2 修补回归 ----


def test_refresh_user_library_passes_api_key_header(env, monkeypatch):
    """个人库有 Key：refresh-preview 把 api_key 透传到 /users/{uid}（Zotero-API-Key 头）。"""
    seen: list = []
    _patch_client(monkeypatch, _bib_handler({"user-445566": BIB_V1}), seen)
    c = env["register"]("userkey@zot.example.com")
    assert c.put("/api/zotero/credentials", json={"api_key": KEY, "zotero_user_id": "445566"}).status_code == 200
    assert c.post("/api/projects/word/create", json={"title": "T", "template": "blank"}).status_code == 200
    pid = [r for r in c.get("/api/projects").json() if r.get("my_role") == "owner"][-1]["id"]
    r = c.post(f"/api/projects/{pid}/library/zotero/refresh-preview",
               json={"library_type": "user", "zotero_user_id": "445566"})
    assert r.status_code == 200, r.text
    assert r.json()["counts"]["added"] == 1
    req = seen[-1]
    assert str(req.url).startswith("https://api.zotero.org/users/445566/items/top")
    assert req.headers["Zotero-API-Key"] == KEY
    assert r.json()["source"]["zotero_user_id"] == "445566"


def test_private_group_cache_isolated_by_key(env, monkeypatch):
    """带 Key 的私有视图与无 Key 公开视图互不串户：B 无 Key 不得命中 A 的缓存。"""
    import asyncio
    import app.domain.zotero_sources as ZS

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "format=bibtex" in url or "/collections" in url:
            return httpx.Response(200, text="[]", headers={"Content-Type": "text/plain"})
        if request.headers.get("Zotero-API-Key") == KEY:
            return httpx.Response(200, json={"id": 333, "data": {"id": 333, "name": "私有视图A", "description": ""}})
        return httpx.Response(404)

    _patch_client(monkeypatch, handler)
    meta_a = asyncio.run(ZS.group_meta(333, api_key=KEY))
    assert meta_a["name"] == "私有视图A"
    with pytest.raises(ZS.ZoteroError) as e:
        asyncio.run(ZS.group_meta(333))  # 无 Key：不得命中 A 的缓存，必须走上游受拒
    assert e.value.status == 404
    # 另一个 Key 的视图同样不串户（隔离键不同）→ 走上游受该 Key 权限约束
    with pytest.raises(ZS.ZoteroError) as e2:
        asyncio.run(ZS.group_meta(333, api_key="other-key-0000"))
    assert e2.value.status == 404


def test_parse_collection_key_validation():
    import app.domain.zotero_sources as ZS

    assert ZS.parse_collection_key("ABCdef123") == "ABCdef123"
    with pytest.raises(ZS.ZoteroError) as e:
        ZS.parse_collection_key("../evil")
    assert e.value.status == 422
    with pytest.raises(ZS.ZoteroError):
        ZS.parse_collection_key("has space")
    with pytest.raises(ZS.ZoteroError):
        ZS.parse_collection_key("x" * 33)


def test_imports_endpoint_returns_refreshable_anchor(env, monkeypatch):
    _patch_client(monkeypatch, _bib_handler({"333": BIB_V1}))
    c = env["register"]("imp@zot.example.com")
    pid = _word_project(env, c)
    _preview_and_commit(c, pid)
    r = c.get(f"/api/projects/{pid}/library/zotero/imports")
    assert r.status_code == 200, r.text
    latest = r.json()["latest_refreshable"]
    assert latest and latest["group_id"] == 333 and latest["provider"] == "zotero"
    # 空项目：latest 为 null
    pid2 = _word_project(env, c)
    r2 = c.get(f"/api/projects/{pid2}/library/zotero/imports")
    assert r2.json()["latest_refreshable"] is None
