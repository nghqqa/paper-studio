# -*- coding: utf-8 -*-
"""文献库重建缓存测试（性能基线 2026-10-24 修复）：快路径命中/失效粒度/provenance 可见/损坏回退。

计数器打在 library.rebuild_from_bib 上（路由经模块属性动态调用，monkeypatch 可截获）；
全部走 HTTP 真实端点，不联网。
"""
import importlib
import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

PW = "lc-pw!"

BIB2 = ("@article{one,\n  title = {First entry},\n  author = {A, B.},\n  year = {2001}\n}\n"
        "@article{two,\n  title = {Second entry},\n  author = {C, D.},\n  year = {2002}\n}\n")
BIB3 = BIB2 + "@book{three,\n  title = {Third entry},\n  author = {E, F.},\n  year = {2003}\n}\n"


def _fresh(name):
    mod = sys.modules.get(name)
    return importlib.reload(mod) if mod is not None else importlib.import_module(name)


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    base = tmp_path_factory.mktemp("libcache")
    env = {
        "PATENT_STUDIO_AUTH": "on",
        "PATENT_STUDIO_SECRET": "lc-secret",
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

        yield {"app": app, "register": register}
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _patch_rebuild_counter(monkeypatch):
    import app.domain.library as L

    calls = {"n": 0}
    real = L.rebuild_from_bib

    def counted(project, rid_hints=None):
        calls["n"] += 1
        return real(project, rid_hints)

    monkeypatch.setattr(L, "rebuild_from_bib", counted)
    return calls


def _new_latex_project(env) -> tuple:
    c = env["register"](f"lc-{__import__('uuid').uuid4().hex[:8]}@lc.example.com")
    r = c.post("/api/projects/latex-demo", json={"template": "blank"})
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    r = c.post(f"/api/projects/{pid}/library/bib-file", json={"name": "refs.bib"})
    assert r.status_code in (200, 201), r.text
    return c, pid


def _write_bib(c, pid, content):
    r = c.get(f"/api/projects/{pid}/latex/files/refs.bib")
    bib = r.json()
    r = c.put(f"/api/projects/{pid}/latex/files/refs.bib",
              json={"content": content, "base": bib["sha"]})
    assert r.status_code == 200, r.text


def _write_main(c, pid, content):
    r = c.get(f"/api/projects/{pid}/latex/files/main.tex")
    main = r.json()
    r = c.put(f"/api/projects/{pid}/latex/files/main.tex",
              json={"content": content, "base": main["sha"]})
    assert r.status_code == 200, r.text


def _get_lib(c, pid):
    r = c.get(f"/api/projects/{pid}/library")
    assert r.status_code == 200, r.text
    return r.json()


def _payload(lib):
    """响应中随缓存应完全一致的部分（entries + 除 parse_errors 外的诊断）。"""
    diag = dict(lib["diagnostics"])
    diag.pop("parse_errors", None)
    return {"entries": lib["entries"], "diagnostics": diag}


def test_warm_hit_skips_rebuild_and_payload_identical(env, monkeypatch):
    c, pid = _new_latex_project(env)
    _write_bib(c, pid, BIB2)
    calls = _patch_rebuild_counter(monkeypatch)

    cold = _get_lib(c, pid)          # 冷：重建 1 次 + 写缓存
    assert calls["n"] == 1
    warm = _get_lib(c, pid)          # 温：命中缓存，不再重建
    assert calls["n"] == 1, "第二次 GET 不应触发重建"
    assert _payload(cold) == _payload(warm)
    assert {e["citation_key"] for e in warm["entries"]} == {"one", "two"}


def test_bib_change_invalidates(env, monkeypatch):
    c, pid = _new_latex_project(env)
    _write_bib(c, pid, BIB2)
    calls = _patch_rebuild_counter(monkeypatch)
    _get_lib(c, pid)
    assert calls["n"] == 1

    _write_bib(c, pid, BIB3)         # .bib 变化 → 必须重建
    warm = _get_lib(c, pid)
    assert calls["n"] == 2
    assert {e["citation_key"] for e in warm["entries"]} == {"one", "two", "three"}


def test_cite_change_invalidates_but_prose_does_not(env, monkeypatch):
    c, pid = _new_latex_project(env)
    _write_bib(c, pid, BIB2)
    calls = _patch_rebuild_counter(monkeypatch)
    _get_lib(c, pid)

    main = c.get(f"/api/projects/{pid}/latex/files/main.tex").json()["content"]
    # 纯散文编辑（不动 \cite）→ 不失效
    _write_main(c, pid, main + "\n% 普通批注，不涉及引用\n")
    _get_lib(c, pid)
    assert calls["n"] == 1, "正文散文编辑不应触发重建"

    # \cite 变化 → 失效重建（诊断依赖引用使用图）
    _write_main(c, pid, main + "\n% 引用\n如文献~\\cite{one} 所示。\n")
    _get_lib(c, pid)
    assert calls["n"] == 2


def test_confirm_rewrites_bib_and_cache_invalidates(env, monkeypatch):
    """confirm 在 bib 模式会重写 .bib（格式化）——缓存失效必须抓住这次改写，
    且重建对账后 verified 状态经由路由回写依然保留（无静默丢失）。"""
    c, pid = _new_latex_project(env)
    _write_bib(c, pid, BIB2)
    calls = _patch_rebuild_counter(monkeypatch)
    lib = _get_lib(c, pid)
    rid = lib["entries"][0]["reference_id"]
    base_n = calls["n"]

    r = c.post(f"/api/projects/{pid}/library/entries/{rid}/confirm", json={"fields": []})
    assert r.status_code == 200, r.text
    assert calls["n"] > base_n, "confirm 重写了 .bib——失效必须触发重建"

    warm = _get_lib(c, pid)
    hit = next(e for e in warm["entries"] if e["reference_id"] == rid)
    assert hit["verified"] == "verified", "重建对账不得丢失确认状态"


def test_corrupted_cache_falls_back_to_rebuild(env, monkeypatch):
    c, pid = _new_latex_project(env)
    _write_bib(c, pid, BIB2)
    calls = _patch_rebuild_counter(monkeypatch)
    _get_lib(c, pid)
    # 破坏缓存文件
    import app.config as cfg

    cache_path = os.path.join(cfg.PROJECTS_DIR, pid, ".studio", "library", "rebuild-cache.json")
    with open(cache_path, "w", encoding="utf-8") as f:
        f.write("{corrupted!!")
    lib = _get_lib(c, pid)           # 坏缓存 → 回退重建且自愈
    assert calls["n"] == 2
    assert {e["citation_key"] for e in lib["entries"]} == {"one", "two"}
    assert _get_lib(c, pid)["entries"]  # 自愈后的缓存可用


def test_index_mode_unaffected(env, monkeypatch):
    """markdown 工程（index 模式）不走 bib 重建，行为照旧。"""
    c = env["register"](f"lc-md-{__import__('uuid').uuid4().hex[:8]}@lc.example.com")
    r = c.post("/api/projects", json={"id": f"md-{__import__('uuid').uuid4().hex[:8]}", "title": "缓存测试 markdown"})
    assert r.status_code in (200, 201), r.text
    pid = r.json()["id"]
    # 默认建项不写 source_format——测试标记为 markdown 使其进入 index 模式文献面
    import app.config as cfg

    sp = os.path.join(cfg.PROJECTS_DIR, pid, "studio.json")
    with open(sp, encoding="utf-8") as f:
        settings = json.load(f)
    settings["source_format"] = "markdown"
    with open(sp, "w", encoding="utf-8") as f:
        json.dump(settings, f, ensure_ascii=False)
    r = c.post(f"/api/projects/{pid}/library/import", json={"text": BIB2})
    assert r.status_code == 200, r.text
    body = r.json()
    calls = _patch_rebuild_counter(monkeypatch)
    r = c.post(f"/api/projects/{pid}/library/commit",
               json={"entries": [{k: v for k, v in e.items()
                                  if k not in ("duplicates", "key_conflict", "suggested_key")}
                                 for e in body["entries"]]})
    assert r.status_code == 200, r.text
    lib = c.get(f"/api/projects/{pid}/library").json()
    assert calls["n"] == 0, "index 模式不触发 bib 重建"
    assert len(lib["entries"]) == 2
