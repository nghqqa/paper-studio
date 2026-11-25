# -*- coding: utf-8 -*-
"""智能文献管理测试（v0.4）：解析 / 导入查重 / 提交 / 编辑 / 合并改名 / 外部源（打桩）/ 导出 / 权限。

外部请求与 mock 分离：本文件全部用 httpx.MockTransport 打桩，**不联网**；
真实 Crossref/arXiv 联网验证记录在 docs/v04-acceptance.md（由验收脚本产出）。
"""
import asyncio
import importlib
import os
import sys

import httpx
import pytest
from fastapi.testclient import TestClient

PW = "lib-pw!"


def _fresh(name):
    mod = sys.modules.get(name)
    return importlib.reload(mod) if mod is not None else importlib.import_module(name)


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    base = tmp_path_factory.mktemp("library")
    env = {
        "PATENT_STUDIO_AUTH": "on",
        "PATENT_STUDIO_SECRET": "lib-secret",
        "PATENT_PROJECTS_DIR": str(base / "projects"),
        "PATENT_STUDIO_LEGACY_DATABASE_URL": f"sqlite:///{base}/studio.db",
    }
    old = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    (base / "projects").mkdir()
    try:
        for name in ("app.config", "app.auth.db", "app.auth.users", "app.auth.acl", "app.auth.router", "app.main"):
            _fresh(name)
        from app.main import app

        def register(email):
            cc = TestClient(app)
            st = cc.post("/api/auth/register", json={"email": email, "password": PW})
            assert st.status_code in (200, 201), st.text
            st = cc.post("/api/auth/cookie/login", data={"username": email, "password": PW},
                         headers={"Content-Type": "application/x-www-form-urlencoded"})
            assert st.status_code == 204, st.status_code
            return cc

        admin = register("admin@lib.example.com")  # 首注=超管
        yield {"app": app, "admin": admin, "register": register}
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def ensure_bib(c, pid, name="refs.bib"):
    """模板自带该 .bib 则直接用；否则新建。返回当前 sha。"""
    files = c.get(f"/api/projects/{pid}/library").json()["bib_files"]
    if name in files:
        return c.get(f"/api/projects/{pid}/latex/files/{name}").json()["sha"]
    r = c.post(f"/api/projects/{pid}/library/bib-file", json={"name": name})
    assert r.status_code == 200, r.text
    return r.json()["sha"]


def _latex_project(env, email, template="jcip"):
    c = env["admin"] if email == "admin@lib.example.com" else env["register"](email)
    r = c.post("/api/projects/latex-demo", json={"template": template})
    assert r.status_code == 200, r.text
    return c, r.json()["id"]


BIB_OK = """
@article{vaswani2017attention,
  title = {Attention Is All You Need},
  author = {Vaswani, Ashish and Shazeer, Noam},
  journal = {NeurIPS},
  year = {2017},
  volume = {30},
  pages = {5998--6008},
  doi = {10.5555/3295222.3295349},
  unknown_field_x = {保留},
}
"""


def test_bib_parse_and_library_flow(env):
    c, pid = _latex_project(env, "flow@lib.example.com")
    sha0 = ensure_bib(c, pid)
    entry = {
        "citation_key": "vaswani2017attention", "entry_type": "article",
        "title": "Attention Is All You Need",
        "authors": ["Vaswani, Ashish", "Shazeer, Noam"],
        "year": "2017", "venue": "NeurIPS", "volume": "30", "pages": "5998--6008",
        "doi": "10.5555/3295222.3295349",
        "fields": {"title": "Attention Is All You Need", "author": "Vaswani, Ashish and Shazeer, Noam",
                   "journal": "NeurIPS", "year": "2017", "volume": "30", "pages": "5998--6008",
                   "doi": "10.5555/3295222.3295349", "unknown_field_x": "保留"},
    }
    r = c.post(f"/api/projects/{pid}/library/commit",
               json={"entries": [entry], "target_bib": "refs.bib", "base_sha": sha0})
    assert r.status_code == 200, r.text
    rid = r.json()["reference_ids"][0]
    lib = c.get(f"/api/projects/{pid}/library").json()
    assert lib["mode"] == "bib"
    ent = next(e for e in lib["entries"] if e["reference_id"] == rid)
    assert ent["title"].startswith("Attention")
    assert ent["bib_files"] == ["refs.bib"]
    # bib 文件确实被写入（事实源），未知字段保留
    f = c.get(f"/api/projects/{pid}/latex/files/refs.bib").json()
    assert "vaswani2017attention" in f["content"] and "unknown_field_x" in f["content"]
    # 人工确认 → verified 状态跨 rebuild 持久（回归：确认后 rebuild 曾把状态覆盖回 unverified）
    r = c.post(f"/api/projects/{pid}/library/entries/{rid}/confirm", json={"fields": []})
    assert r.status_code == 200, r.text
    lib2 = c.get(f"/api/projects/{pid}/library").json()
    ent2 = next(e for e in lib2["entries"] if e["reference_id"] == rid)
    assert ent2["verified"] == "verified"


def test_bib_parse_errors_are_per_entry(env):
    c, pid = _latex_project(env, "parse@lib.example.com")
    ensure_bib(c, pid)
    bad = BIB_OK + "\n@inproceedings{broken{ title = oops\n"
    f = c.get(f"/api/projects/{pid}/latex/files/refs.bib").json()
    r = c.put(f"/api/projects/{pid}/latex/files/refs.bib", json={"content": bad, "base": f["sha"]})
    assert r.status_code == 200
    lib = c.get(f"/api/projects/{pid}/library").json()
    keys = [e["citation_key"] for e in lib["entries"]]
    assert "vaswani2017attention" in keys  # 好条目不受坏条目影响
    errs = lib["diagnostics"]["parse_errors"]
    assert len(errs) == 1 and "结构损坏" in errs[0]["error"]


def test_import_preview_dedup_and_commit(env):
    c, pid = _latex_project(env, "import@lib.example.com")
    ensure_bib(c, pid)
    r = c.post(f"/api/projects/{pid}/library/commit", json={
        "entries": [{"citation_key": "a2016deep", "entry_type": "book", "title": "Deep Learning",
                     "year": "2016", "doi": "10.1234/dupe", "fields": {"title": "Deep Learning", "year": "2016", "doi": "10.1234/dupe"}}],
        "target_bib": "refs.bib"})
    assert r.status_code == 200
    # 导入：同 DOI 重复 + key 冲突 + 坏条目
    text = BIB_OK + "\n@book{a2016deep, title={Deep Learning}, year={2016}, doi={10.1234/dupe}}\n@broken{xxx"
    r = c.post(f"/api/projects/{pid}/library/import", json={"text": text})
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["errors"]) == 1  # 坏块逐条报错，不吞整库
    dup_entry = next(e for e in body["entries"] if e["citation_key"] == "a2016deep")
    assert any(d["kind"] == "doi" for d in dup_entry["duplicates"])
    assert dup_entry["key_conflict"] is True
    new_entry = next(e for e in body["entries"] if e["citation_key"] == "vaswani2017attention")
    assert new_entry["duplicates"] == []


def test_edit_and_delete_entry_rewrite_bib(env):
    c, pid = _latex_project(env, "edit@lib.example.com")
    sha0 = ensure_bib(c, pid)
    r = c.post(f"/api/projects/{pid}/library/commit", json={
        "entries": [{"citation_key": "gb2016", "entry_type": "book", "title": "Deep Learning",
                     "year": "2016", "fields": {"title": "Deep Learning", "year": "2016"}}],
        "target_bib": "refs.bib", "base_sha": sha0})
    rid = r.json()["reference_ids"][0]
    r = c.patch(f"/api/projects/{pid}/library/entries/{rid}",
                json={"fields": {"publisher": "MIT Press"}})
    assert r.status_code == 200, r.text
    f = c.get(f"/api/projects/{pid}/latex/files/refs.bib").json()
    assert "MIT Press" in f["content"]
    r = c.request("DELETE", f"/api/projects/{pid}/library/entries/{rid}", json={})
    assert r.status_code == 200, r.text
    f = c.get(f"/api/projects/{pid}/latex/files/refs.bib").json()
    assert "gb2016" not in f["content"]
    r = c.request("DELETE", f"/api/projects/{pid}/library/entries/{rid}", json={})
    assert r.status_code == 404


def test_cite_scan_rename_and_style_detection(env):
    c, pid = _latex_project(env, "cite@lib.example.com", template="blank")
    ensure_bib(c, pid)
    c.post(f"/api/projects/{pid}/library/commit", json={
        "entries": [
            {"citation_key": "oldkey", "entry_type": "article", "title": "Old", "year": "2019", "fields": {"title": "Old", "year": "2019"}},
            {"citation_key": "keep", "entry_type": "article", "title": "Keep", "year": "2020", "fields": {"title": "Keep", "year": "2020"}},
        ],
        "target_bib": "refs.bib"})
    main = c.get(f"/api/projects/{pid}/latex/files/main.tex").json()
    tex = main["content"] + "\n\\cite{oldkey} and \\citep{keep,oldkey}\n"
    r = c.put(f"/api/projects/{pid}/latex/files/main.tex", json={"content": tex, "base": main["sha"]})
    assert r.status_code == 200
    usage = c.get(f"/api/projects/{pid}/library/citations").json()
    assert usage["usage"]["oldkey"] == [{"file": "main.tex", "count": 2}]
    main = c.get(f"/api/projects/{pid}/latex/files/main.tex").json()
    r = c.post(f"/api/projects/{pid}/library/apply-renames", json={
        "updates": [{"path": "main.tex", "base": main["sha"], "renames": {"oldkey": "newkey"}}]})
    assert r.status_code == 200 and r.json()["results"][0]["replaced"] == 2, r.text
    newtex = c.get(f"/api/projects/{pid}/latex/files/main.tex").json()["content"]
    assert "\\cite{newkey}" in newtex and "\\citep{keep,newkey}" in newtex
    style = c.get(f"/api/projects/{pid}/library").json()["cite_style"]
    assert style["style"] == "plain" and style["command"] == "cite"


def test_merge_with_key_rename(env):
    c, pid = _latex_project(env, "merge@lib.example.com")
    ensure_bib(c, pid)
    c.post(f"/api/projects/{pid}/library/commit", json={
        "entries": [
            {"citation_key": "deep2016", "entry_type": "book", "title": "Deep Learning",
             "year": "2016", "publisher": "MIT Press", "fields": {"title": "Deep Learning", "year": "2016", "publisher": "MIT Press"}},
            {"citation_key": "dl16", "entry_type": "book", "title": "Deep Learning",
             "year": "2016", "fields": {"title": "Deep Learning", "year": "2016", "note": "dup"}},
        ],
        "target_bib": "refs.bib"})
    lib = c.get(f"/api/projects/{pid}/library").json()
    assert lib["diagnostics"]["fuzzy_duplicates"]  # 疑似重复被提示
    surv = next(e for e in lib["entries"] if e["citation_key"] == "deep2016")
    lose = next(e for e in lib["entries"] if e["citation_key"] == "dl16")
    main = c.get(f"/api/projects/{pid}/latex/files/main.tex").json()
    c.put(f"/api/projects/{pid}/latex/files/main.tex",
          json={"content": main["content"] + "\\cite{dl16}", "base": main["sha"]})
    main = c.get(f"/api/projects/{pid}/latex/files/main.tex").json()
    r = c.post(f"/api/projects/{pid}/library/merge", json={
        "survivor_rid": surv["reference_id"], "loser_rid": lose["reference_id"],
        "field_choices": {"note": "loser"},
        "tex_updates": [{"path": "main.tex", "base": main["sha"]}]})
    assert r.status_code == 200, r.text
    assert r.json()["renames"] == {"dl16": "deep2016"}
    assert r.json()["tex_updates"][0]["replaced"] == 1
    lib2 = c.get(f"/api/projects/{pid}/library").json()
    keys = [e["citation_key"] for e in lib2["entries"]]
    assert "dl16" not in keys and "deep2016" in keys
    newtex = c.get(f"/api/projects/{pid}/latex/files/main.tex").json()["content"]
    assert "\\cite{deep2016}" in newtex and "dl16" not in newtex


# ---------------------------------------------------------------- 外部源（MockTransport 打桩，不联网） ----


def _patch_client(monkeypatch, handler):
    from app.domain import library_sources as LS

    def fake_client():
        return httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=5, follow_redirects=False)
    monkeypatch.setattr(LS, "_client", fake_client)
    LS._cache.clear()


CROSSREF_BODY = {"status": "ok", "message": {
    "type": "journal-article", "title": ["Real Paper Title"], "author": [{"family": "Smith", "given": "J."}],
    "issued": {"date-parts": [[2021]]}, "container-title": ["Nature"], "volume": "1", "page": "2-3",
    "DOI": "10.1111/real", "URL": "https://api.crossref.org/works/10.1111/real"}}


def test_lookup_doi_success_and_cache(monkeypatch):
    from app.domain import library_sources as LS

    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        assert request.url.host == "api.crossref.org"
        assert request.url.path.startswith("/works/10.1111/real")
        return httpx.Response(200, json=CROSSREF_BODY)

    _patch_client(monkeypatch, handler)

    async def run():
        cand = await LS.lookup_doi("10.1111/real")
        assert cand["matched"] and cand["fields"]["title"] == "Real Paper Title"
        assert cand["fields"]["year"] == "2021"
        assert cand["retraction"]["status"] == "unknown"  # 未查询到撤稿记录 ≠ 已证明未撤稿
        await LS.lookup_doi("10.1111/real")
        assert calls["n"] == 1  # 命中缓存，不重复出站

    asyncio.run(run())


def test_lookup_doi_not_found_and_429(monkeypatch):
    from app.domain import library_sources as LS

    def handler404(request):
        return httpx.Response(404, json={})

    _patch_client(monkeypatch, handler404)
    with pytest.raises(LS.SourceError) as ei:
        asyncio.run(LS.lookup_doi("10.2222/nope"))
    assert ei.value.status == 404 and ei.value.kind == "source_not_found"

    def handler429(request):
        return httpx.Response(429, headers={"Retry-After": "0"}, json={})

    _patch_client(monkeypatch, handler429)
    with pytest.raises(LS.SourceError) as ei:
        asyncio.run(LS.lookup_doi("10.3333/rate"))
    assert ei.value.kind == "source_rate_limited"


def test_lookup_doi_timeout(monkeypatch):
    from app.domain import library_sources as LS

    def handler(request):
        raise httpx.ConnectTimeout("boom")

    _patch_client(monkeypatch, handler)
    with pytest.raises(LS.SourceError) as ei:
        asyncio.run(LS.lookup_doi("10.4444/slow"))
    assert ei.value.kind == "source_timeout"


def test_lookup_rejects_bad_identifier_and_redirect(monkeypatch):
    from app.domain import library_sources as LS

    with pytest.raises(LS.SourceError):
        asyncio.run(LS.lookup_doi("not-a-doi"))
    with pytest.raises(LS.SourceError):
        asyncio.run(LS.lookup_arxiv("../../etc/passwd"))

    def handler_redirect(request):
        return httpx.Response(302, headers={"Location": "http://evil.example/"})

    _patch_client(monkeypatch, handler_redirect)
    with pytest.raises(LS.SourceError) as ei:
        asyncio.run(LS.lookup_doi("10.5555/redir"))
    assert ei.value.kind == "source_redirect"


def test_lookup_arxiv_mock(monkeypatch):
    from app.domain import library_sources as LS

    atom = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <title>Attention Is All You Need</title>
    <summary>We propose a new architecture.</summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <published>2017-06-12T17:57:34Z</published>
    <arxiv:comment xmlns:arxiv="http://arxiv.org/schemas/atom">15 pages</arxiv:comment>
  </entry>
</feed>"""

    def handler(request):
        assert request.url.host == "export.arxiv.org"
        assert "id_list=1706.03762" in str(request.url)
        return httpx.Response(200, text=atom)

    _patch_client(monkeypatch, handler)
    cand = asyncio.run(LS.lookup_arxiv("https://arxiv.org/abs/1706.03762v7"))
    assert cand["fields"]["title"] == "Attention Is All You Need"
    assert cand["fields"]["year"] == "2017"
    assert cand["fields"]["arxiv_id"] == "1706.03762"
    assert cand["retraction"]["status"] == "unknown"  # arXiv 无撤稿信息：恒未知


# ---------------------------------------------------------------- 导出 / 渲染 ----


def test_export_and_bibliography(env):
    c, pid = _latex_project(env, "export@lib.example.com")
    ensure_bib(c, pid)
    r = c.post(f"/api/projects/{pid}/library/commit", json={
        "entries": [{
            "citation_key": "v2017", "entry_type": "article", "title": "Attention Is All You Need",
            "authors": ["Vaswani, Ashish"], "year": "2017", "venue": "NeurIPS", "volume": "30",
            "pages": "5998--6008",
            "fields": {"title": "Attention Is All You Need", "author": "Vaswani, Ashish",
                       "journal": "NeurIPS", "year": "2017", "volume": "30", "pages": "5998--6008"},
        }],
        "target_bib": "refs.bib"})
    rid = r.json()["reference_ids"][0]
    r = c.get(f"/api/projects/{pid}/library/export?format=bibtex")
    assert r.status_code == 200 and "@article{v2017" in r.text
    r = c.get(f"/api/projects/{pid}/library/export?format=csl-json")
    assert r.status_code == 200
    csl = r.json()[0]
    csl = next(x for x in r.json() if x["id"] == rid)  # 导出含种子条目，按 rid 定位
    assert csl["type"] == "article-journal"
    r = c.post(f"/api/projects/{pid}/library/bibliography", json={"order": [rid], "style": "ieee"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["labels"][rid] == "[1]"
    assert any("Vaswani" in item for item in body["bibliography"])
    assert "非 Word 原生" in body["note"]


def test_undefined_citations_from_log():
    from app.domain.library import undefined_citations_from_log

    log = ("LaTeX Warning: Citation `foo2020' on page 1 undefined on input line 12.\n"
           "Warning--I didn't find a database entry for \"bar2019\"\n")
    assert sorted(undefined_citations_from_log(log)) == ["bar2019", "foo2020"]


# ---------------------------------------------------------------- 权限矩阵 ----


def test_permissions_matrix(env):
    owner, pid = _latex_project(env, "owner@lib.example.com")
    anon = TestClient(env["app"])
    outsider = env["register"]("out@lib.example.com")
    viewer = env["register"]("viewer@lib.example.com")
    reviewer = env["register"]("reviewer@lib.example.com")
    editor = env["register"]("editor@lib.example.com")
    for email, role in (("viewer@lib.example.com", "viewer"), ("reviewer@lib.example.com", "reviewer"),
                        ("editor@lib.example.com", "editor")):
        r = owner.post(f"/api/projects/{pid}/invites", json={"email": email, "role": role})
        assert r.status_code in (200, 201), r.text
    # 匿名 401
    assert anon.get(f"/api/projects/{pid}/library").status_code == 401
    assert anon.post(f"/api/projects/{pid}/library/lookup", json={"query": "x"}).status_code == 401
    # 非成员 404（不泄露存在性）
    assert outsider.get(f"/api/projects/{pid}/library").status_code in (403, 404)
    # viewer：可读/可查询；不可写
    assert viewer.get(f"/api/projects/{pid}/library").status_code == 200
    assert viewer.post(f"/api/projects/{pid}/library/lookup", json={"query": "attention"}).status_code in (200, 502, 504)
    assert viewer.post(f"/api/projects/{pid}/library/bib-file", json={"name": "x.bib"}).status_code == 403
    assert viewer.post(f"/api/projects/{pid}/library/commit", json={"entries": [{}]}).status_code == 403
    assert viewer.post(f"/api/projects/{pid}/library/merge", json={}).status_code == 403
    # reviewer：写禁
    assert reviewer.post(f"/api/projects/{pid}/library/commit", json={"entries": [{}]}).status_code == 403
    # editor：可写
    assert editor.post(f"/api/projects/{pid}/library/bib-file", json={"name": "extra.bib"}).status_code == 200


def test_bib_file_name_validation(env):
    c, pid = _latex_project(env, "nameval@lib.example.com")
    assert c.post(f"/api/projects/{pid}/library/bib-file", json={"name": "../evil.bib"}).status_code in (400, 422)
    assert c.post(f"/api/projects/{pid}/library/bib-file", json={"name": "refs.txt"}).status_code in (400, 422)
    c.post(f"/api/projects/{pid}/library/bib-file", json={"name": "dup.bib"})
    assert c.post(f"/api/projects/{pid}/library/bib-file", json={"name": "dup.bib"}).status_code == 409


def test_rid_validation_blocks_traversal(env):
    c, pid = _latex_project(env, "rid@lib.example.com")
    r = c.request("DELETE", f"/api/projects/{pid}/library/entries/not-a-rid", json={})
    assert r.status_code == 422
    r = c.patch(f"/api/projects/{pid}/library/entries/ref_ffffffffffff", json={"fields": {"title": "x"}})
    assert r.status_code == 404  # 合法形态但不存在


def test_word_mode_uses_index_truth(env):
    """Word 工程 index 模式：不依赖 ONLYOFFICE 可用性（word/create 的 JWT 门槛在
    全量套件下受其他文件的 env 恢复影响）——以 latex 工程改写 source_format 构造。"""
    c, pid = _latex_project(env, "word@lib.example.com")
    import json as _json
    import os as _os
    studio = _os.path.join(env["PROJECTS_DIR"] if "PROJECTS_DIR" in env else _os.environ["PATENT_PROJECTS_DIR"], pid, "studio.json")
    meta = _json.load(open(studio, encoding="utf-8"))
    meta["source_format"] = "docx"
    _json.dump(meta, open(studio, "w", encoding="utf-8"))
    lib = c.get(f"/api/projects/{pid}/library").json()
    assert lib["mode"] == "index"
    r = c.post(f"/api/projects/{pid}/library/commit", json={
        "entries": [{"citation_key": "w2020", "entry_type": "article", "title": "Word Entry",
                     "year": "2020", "fields": {"title": "Word Entry", "year": "2020"}}]})
    assert r.status_code == 200, r.text
    lib = c.get(f"/api/projects/{pid}/library").json()
    assert len(lib["entries"]) == 1
    # 导出 bibtex 由字段生成
    r = c.get(f"/api/projects/{pid}/library/export?format=bibtex")
    assert "@article{w2020" in r.text


def test_refs_plugin_task_inbox_cycle(env):
    """Word 引用插件任务箱（v0.4.1 doc_key 会话绑定）：下发→插件轮询→回执→配对→单飞。
    回归①：曾因 threading.Lock 自锁打死整个事件循环；回归②：doc_key 与工程当前
    DS 会话不符的任务必须不可见/409。"""
    c, pid = _latex_project(env, "inbox@lib.example.com")
    from app import config as _cfg
    # 造一个 doc_key：直接向工程 word state 写入（测试环境无 DS，用会话文件构造）
    import json as _json
    import os as _os
    state_path = _os.path.join(_os.environ["PATENT_PROJECTS_DIR"], pid, ".studio", "word", "state.json")
    os_makedirs = _os.makedirs(_os.path.dirname(state_path), exist_ok=True)
    fake_key = "testsessionkey1234567890"
    _json.dump({"key": fake_key, "closed": False, "versions": [], "sha": "x", "saving": False},
               open(state_path, "w", encoding="utf-8"))
    # viewer 403（只读角色不能下发写任务）
    viewer = env["register"]("inbox-viewer@lib.example.com")
    owner_c = c
    r = owner_c.post(f"/api/projects/{pid}/invites", json={"email": "inbox-viewer@lib.example.com", "role": "viewer"})
    assert r.status_code in (200, 201), r.text
    r = viewer.post("/api/office-plugin-refs/task",
                    json={"pid": pid, "doc_key": fake_key, "kind": "insert-citation", "payload": {"label": "[1]", "rids": ["ref_x"]}})
    assert r.status_code == 403, r.status_code
    # editor 下发成功
    r2 = c.post("/api/office-plugin-refs/task",
                json={"pid": pid, "doc_key": fake_key, "kind": "collect-refs", "payload": {}})
    assert r2.status_code == 200, r2.text
    rid = r2.json()["request_id"]
    # 插件按 doc_key 轮询可见；doc_key 错误不可见
    r3 = c.get(f"/api/office-plugin-refs/task?doc_key={fake_key}")
    assert r3.status_code == 200 and r3.json()["task"]["request_id"] == rid
    r4 = c.get("/api/office-plugin-refs/task?doc_key=wrongkey123456789")
    assert r4.json()["task"] is None
    # 伪造 request_id 的回执 404；配对回执 200 并清任务（单飞）
    r5 = c.post("/api/office-plugin-refs/result",
                json={"doc_key": fake_key, "request_id": "rp_ffffffffffff", "ok": True, "data": {}})
    assert r5.status_code == 404
    r6 = c.post("/api/office-plugin-refs/result",
                json={"doc_key": fake_key, "request_id": rid, "ok": True, "data": {"refs": []}})
    assert r6.status_code == 200
    r7 = c.post("/api/office-plugin-refs/task",
                json={"pid": pid, "doc_key": fake_key, "kind": "collect-refs", "payload": {}})
    assert r7.status_code == 200  # 桶已释放
    # doc_key 与当前会话不符（过期会话键）→ 409 stale
    r8 = c.post("/api/office-plugin-refs/task",
                json={"pid": pid, "doc_key": "stalesessionkey9876543", "kind": "collect-refs", "payload": {}})
    assert r8.status_code == 409 and "stale" in r8.json()["detail"]["kind"]


def test_multi_file_rename_partial_failure_is_atomic(env):
    """多文件 \cite 改名：一个文件 base 过期（409 stale）时该文件不写，
    其他文件各自成败如实返回——不产生一半成功的静默混合状态。"""
    c, pid = _latex_project(env, "multi@lib.example.com", template="jcip")
    ensure_bib(c, pid)
    c.post(f"/api/projects/{pid}/library/commit", json={
        "entries": [{"citation_key": "sharedkey", "entry_type": "article", "title": "S",
                     "year": "2021", "fields": {"title": "S", "year": "2021"}}],
        "target_bib": "refs.bib"})
    # 两个 tex 文件都引用 sharedkey
    # main.tex 与 sections/part.tex 分别写入引用
    files = {f["path"]: f for f in c.get(f"/api/projects/{pid}/latex/files").json()["files"]}
    assert "sections/part.tex" in files  # jcip 多文件工程
    main = c.get(f"/api/projects/{pid}/latex/files/main.tex").json()
    c.put(f"/api/projects/{pid}/latex/files/main.tex",
          json={"content": main["content"] + "\cite{sharedkey}", "base": main["sha"]})
    part = c.get(f"/api/projects/{pid}/latex/files/sections/part.tex").json()
    c.put(f"/api/projects/{pid}/latex/files/sections/part.tex",
          json={"content": part["content"] + "\cite{sharedkey}", "base": part["sha"]})
    # b.tex 的 base 故意给错 → 该文件 409 不写；main.tex 正常改名
    main2 = c.get(f"/api/projects/{pid}/latex/files/main.tex").json()
    # 两阶段原子性：任一文件 base 过期 ⇒ 整批 409、零写入（不产生一半成功一半失败的混合态）
    r = c.post(f"/api/projects/{pid}/library/apply-renames", json={"updates": [
        {"path": "main.tex", "base": main2["sha"], "renames": {"sharedkey": "renamed"}},
        {"path": "sections/part.tex", "base": "deadbeef" * 8, "renames": {"sharedkey": "renamed"}},
    ]})
    assert r.status_code == 409
    mt_bad = c.get(f"/api/projects/{pid}/latex/files/main.tex").json()["content"]
    pt_bad = c.get(f"/api/projects/{pid}/latex/files/sections/part.tex").json()["content"]
    assert "sharedkey" in mt_bad and "renamed" not in mt_bad
    assert "sharedkey" in pt_bad
    # base 全部正确时整批成功
    part2 = c.get(f"/api/projects/{pid}/latex/files/sections/part.tex").json()
    r = c.post(f"/api/projects/{pid}/library/apply-renames", json={"updates": [
        {"path": "main.tex", "base": main2["sha"], "renames": {"sharedkey": "renamed"}},
        {"path": "sections/part.tex", "base": part2["sha"], "renames": {"sharedkey": "renamed"}},
    ]})
    assert r.status_code == 200, r.text
    mt = c.get(f"/api/projects/{pid}/latex/files/main.tex").json()["content"]
    pt = c.get(f"/api/projects/{pid}/latex/files/sections/part.tex").json()["content"]
    assert "renamed" in mt and "renamed" in pt


def test_gbt7714_parse_scholar_conference_line():
    from app.domain import library
    r = library.parse_gbt7714_text(
        "Xu X, Bai C, Yang K, et al. Thinking-free policy initialization makes distilled "
        "reasoning models more effective and efficient reasoners[C]//International "
        "Conference on Learning Representations. 2026, 2026: 24062-24086.")
    assert not r.errors
    e = r.entries[0]
    assert e.entry_type == "inproceedings"
    assert e.title == ("Thinking-free policy initialization makes distilled reasoning "
                       "models more effective and efficient reasoners")
    assert e.authors == ["Xu X", "Bai C", "Yang K"]
    assert e.venue == "International Conference on Learning Representations"
    assert e.year == "2026" and e.pages == "24062-24086"
    assert e.citation_key == "xu2026" and e.fields["booktitle"] == e.venue


def test_gbt7714_parse_journal_book_and_bad_line():
    from app.domain import library
    text = "\n".join([
        "Zhang S, Li S. Understanding deep learning requires rethinking generalization[J]. "
        "Communications of the ACM, 2017, 61(6): 68-77.",
        "Knuth D E. The Art of Computer Programming, Volume 1[M]. Reading: Addison-Wesley, 1997.",
        "这不是一条能识别的引文，没有类型标记。",
    ])
    r = library.parse_gbt7714_text(text)
    assert len(r.entries) == 2 and len(r.errors) == 1
    j, b = r.entries
    assert j.entry_type == "article" and j.venue == "Communications of the ACM"
    assert j.volume == "61" and j.number == "6" and j.pages == "68-77" and j.year == "2017"
    assert b.entry_type == "book" and b.publisher == "Addison-Wesley" and b.year == "1997"
    assert r.errors[0].line == 3


def test_citation_text_dispatch():
    from app.domain import library
    assert library.looks_like_bibtex("@article{a, title={x}}")
    assert not library.looks_like_bibtex("Xu X. 标题[J]. 期刊, 2026.")
    r = library.parse_citation_text("Xu X. 标题[J]. 期刊, 2026.")
    assert r.entries[0].entry_type == "article" and r.entries[0].year == "2026"
