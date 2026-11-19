"""Real HTTP/ACL tests for native DOCX lifecycle; DS network is replaced at its boundary."""

import hashlib
import importlib
import io
import json
import os
import sys
import time
import zipfile
from urllib.parse import urlsplit

import httpx
import pytest
from docx import Document
from docx.oxml import OxmlElement
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def matrix(tmp_path_factory):
    base = tmp_path_factory.mktemp("word")
    projects = base / "projects"
    projects.mkdir()
    env = {"PATENT_STUDIO_AUTH": "on", "PATENT_STUDIO_SECRET": "word-tests-auth-secret-at-least-32-bytes",
           "PATENT_PROJECTS_DIR": str(projects),
           "PATENT_STUDIO_LEGACY_DATABASE_URL": f"sqlite:///{base}/studio.db",
           "PATENT_STUDIO_WORD_EDITOR": "on", "PATENT_STUDIO_ONLYOFFICE_JWT_SECRET": "word-test-secret",
           "PATENT_STUDIO_ONLYOFFICE_URL": "http://localhost:9980",
           "PATENT_STUDIO_ONLYOFFICE_INTERNAL_URL": "http://onlyoffice:80",
           "PATENT_STUDIO_PUBLIC_ORIGIN": "",
           "PATENT_STUDIO_ONLYOFFICE_PUBLIC_URL": "http://studio:8000"}
    previous = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    try:
        for name in ("app.config", "app.auth.db", "app.auth.users", "app.auth.acl", "app.auth.router", "app.main"):
            if name in sys.modules:
                importlib.reload(sys.modules[name])
            else:
                importlib.import_module(name)
        from patent_studio.asgi import create_app

        app = create_app()

        def register(name):
            c = TestClient(app)
            email = name + "@word.example.com"
            r = c.post("/api/auth/register", json={"email": email, "password": "Word-test-pw!",
                                                  "display_name": name})
            assert r.status_code == 201, r.text
            r = c.post("/api/auth/cookie/login", data={"username": email, "password": "Word-test-pw!"})
            assert r.status_code == 204, r.text
            return c

        register("bootstrap")
        users = {k: register(k) for k in ("owner", "editor", "reviewer", "viewer", "outsider")}
        owner = users["owner"]
        r = owner.post("/api/projects/word/create", json={"title": "原生公式稿", "template": "blank"})
        assert r.status_code == 200, r.text
        pid = r.json()["id"]
        for name in ("editor", "reviewer", "viewer"):
            r = owner.put(f"/api/projects/{pid}/members", json={"email": name + "@word.example.com", "role": name})
            assert r.status_code == 200, r.text
        yield {"app": app, "users": users, "pid": pid, "projects": projects}
    finally:
        for k, v in previous.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _new(matrix):
    r = matrix["users"]["owner"].post("/api/projects/word/create", json={"title": "保存往返"})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _config(matrix, pid):
    r = matrix["users"]["owner"].get(f"/api/projects/{pid}/word/editor-config")
    assert r.status_code == 200, r.text
    return r.json()["config"]


def _path(url):
    p = urlsplit(url)
    return p.path + "?" + p.query


def _callback(matrix, cfg, data, status=6, **extra):
    from app.domain import word_documents as w

    body = {"key": cfg["document"]["key"], "status": status,
            "url": "http://onlyoffice/cache/files/session/output.docx", **extra}
    body["token"] = w.sign(body)
    # The anonymous DS client has no browser login cookie.
    return TestClient(matrix["app"]).post(_path(cfg["editorConfig"]["callbackUrl"]), json=body)


def _changed(data):
    d = Document(io.BytesIO(data))
    p = d.add_paragraph("新增段落与原生公式：")
    math = OxmlElement("m:oMath")
    run = OxmlElement("m:r")
    text = OxmlElement("m:t")
    text.text = "E=mc²"
    run.append(text)
    math.append(run)
    p._p.append(math)
    out = io.BytesIO()
    d.save(out)
    return out.getvalue()


def test_meta_project_and_native_content_guard(matrix):
    owner, pid = matrix["users"]["owner"], matrix["pid"]
    meta = owner.get("/api/meta").json()
    assert meta["word_editor"] and meta["word_editor_ready"]
    body = owner.get(f"/api/projects/{pid}").json()
    assert body["settings"]["source_format"] == "docx"
    assert body["content"] == ""
    assert not (matrix["projects"] / pid / "content.md").exists()
    assert owner.get(f"/api/projects/{pid}/content").status_code == 400
    assert owner.put(f"/api/projects/{pid}/content", json={"content": "bad"}).status_code == 400


def test_acl_and_review_permissions_are_signed(matrix):
    from app.domain import word_documents as w

    pid, users = matrix["pid"], matrix["users"]
    assert TestClient(matrix["app"]).get(f"/api/projects/{pid}/word/editor-config").status_code == 401
    assert users["outsider"].get(f"/api/projects/{pid}/word/download").status_code in (403, 404)
    assert users["viewer"].post(f"/api/projects/{pid}/word/save").status_code == 403
    keys = []
    for role in ("owner", "editor", "reviewer", "viewer"):
        r = users[role].get(f"/api/projects/{pid}/word/editor-config")
        assert r.status_code == 200, r.text
        cfg = r.json()["config"]
        decoded = w.verify(cfg["token"])
        assert decoded["document"] == cfg["document"]
        perms = cfg["document"]["permissions"]
        assert perms["edit"] is (role in ("owner", "editor"))
        assert perms["review"] is (role != "viewer")
        numbering = cfg["editorConfig"]["plugins"]
        assert numbering["autostart"] == ([w.NUMBERING_GUID, w.AI_POLISH_GUID, w.REFS_GUID] if role in ("owner", "editor") else [])
        assert numbering["pluginsData"][-1].endswith("/api/office-charts/config.json")
        assert any(u.endswith("/api/office-plugin-refs/config.json") for u in numbering["pluginsData"])
        assert any(u.endswith("/api/office-plugin/native/config.json") for u in numbering["pluginsData"])
        if role == "reviewer":
            assert cfg["editorConfig"]["customization"]["review"]["trackChanges"] is True
        keys.append(cfg["document"]["key"])
    assert len(set(keys)) == 1


def test_upload_validation_and_exact_original_bytes(matrix):
    from app.domain import word_documents as w

    owner = matrix["users"]["owner"]
    raw = _changed(w.make_document("上传稿", "blank"))
    r = owner.post("/api/projects/word/import", files={"file": ("中文稿.docx", raw, w.DOCX_MEDIA)})
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    assert owner.get(f"/api/projects/{pid}/word/download").content == raw
    s = owner.get(f"/api/projects/{pid}/word/state").json()
    assert s["version"] == 1 and s["versions"][0]["source"] == "import"
    for name, data in (("bad.docx", b"not a zip"), ("fake.docm", raw), ("bad.txt", raw)):
        r = owner.post("/api/projects/word/import", files={"file": (name, data, w.DOCX_MEDIA)})
        assert r.status_code == 422, r.text


def test_journal_template_preserves_the_complete_package(matrix):
    from pathlib import Path
    from app import config
    owner = matrix["users"]["owner"]
    expected = Path(config.BACKEND_DIR, "app", "word_templates", "jcip", "template.docx").read_bytes()
    r = owner.post("/api/projects/word/create", json={"title": "项目名称不替换论文标题", "template": "jcip"})
    assert r.status_code == 200, r.text
    actual = owner.get(f"/api/projects/{r.json()['id']}/word/download").content
    assert actual == expected  # Includes headers, floating text, columns, styles and fields.


def test_paper_submission_metadata_roundtrips_without_rewriting_docx(matrix):
    users, pid = matrix["users"], matrix["pid"]
    path = f"/api/projects/{pid}"
    original = users["owner"].get(path + "/word/download").content
    metadata = {"venue": "中文信息学报", "deadline": "2027-01-01", "field": "自然语言处理",
                "stage": "internal_review", "keywords": "自然语言处理，毕业论文"}
    assert users["viewer"].put(path + "/settings", json={"submission": metadata}).status_code == 403
    assert users["reviewer"].put(path + "/settings", json={"submission": metadata}).status_code == 403
    r = users["editor"].put(path + "/settings", json={"submission": metadata})
    assert r.status_code == 200, r.text
    summary = next(p for p in users["owner"].get('/api/projects').json() if p['id'] == pid)
    assert summary['submission'] == metadata
    assert summary['source_format'] == 'docx'
    assert summary['owner']['display_name'] == 'owner'
    assert users["owner"].get(path + "/word/download").content == original


def test_capabilities_and_callback_jwt_reject_tampering(matrix):
    from app.domain import word_documents as w

    pid = _new(matrix)
    cfg = _config(matrix, pid)
    anon = TestClient(matrix["app"])
    file_url = _path(cfg["document"]["url"])
    token = w.sign({"payload": {"url": cfg["document"]["url"]}, "operation": "download"})
    assert anon.get(file_url, headers={"Authorization": "Bearer " + token}).status_code == 200
    assert anon.get(file_url).status_code == 403
    # A visible browser config token cannot be reused as a DS download token.
    assert anon.get(file_url, headers={"Authorization": "Bearer " + cfg["token"]}).status_code == 403
    assert anon.get(file_url[:-1] + ("a" if file_url[-1] != "a" else "b")).status_code == 403
    body = {"key": cfg["document"]["key"], "status": 6, "url": "http://onlyoffice/cache/a.docx"}
    callback_url = _path(cfg["editorConfig"]["callbackUrl"])
    assert anon.post(callback_url, json=body).status_code == 403
    token = w.sign(body)
    body["url"] = "http://evil.example/cache/a.docx"
    body["token"] = token
    assert anon.post(callback_url, json=body).status_code == 403
    expired = w.sign({"aud": "studio-word-cap", "pid": pid, "key": cfg["document"]["key"],
                      "purpose": "document", "exp": int(time.time()) - 1})
    assert anon.get(f"/api/office/document/{pid}/{cfg['document']['key']}?cap={expired}").status_code == 403


def test_force_save_final_reopen_and_stale_callback(matrix, monkeypatch):
    from app.domain import word_documents as w

    pid = _new(matrix)
    owner = matrix["users"]["owner"]
    cfg = _config(matrix, pid)
    original = owner.get(f"/api/projects/{pid}/word/download").content
    modified = _changed(original)
    monkeypatch.setattr(w, "fetch_document", lambda url, pdf=False: modified)
    monkeypatch.setattr(w, "server_request", lambda path, body: {"error": 0})
    requested = owner.post(f"/api/projects/{pid}/word/save").json()
    assert requested["pending"] is True
    assert _callback(matrix, cfg, modified, userdata=requested["request_id"]).json() == {"error": 0}
    s = owner.get(f"/api/projects/{pid}/word/state").json()
    assert s["version"] == 2 and not s["saving"]
    assert owner.get(f"/api/projects/{pid}/word/download").content == modified
    assert _config(matrix, pid)["document"]["key"] == cfg["document"]["key"]
    first = s["versions"][0]["id"]
    assert owner.get(f"/api/projects/{pid}/word/versions/{first}/download").content == original
    assert _callback(matrix, cfg, modified, status=2).json() == {"error": 0}
    reopened = _config(matrix, pid)
    assert reopened["document"]["key"] != cfg["document"]["key"]
    # Exact retry of a successful final save is idempotent, even after reopen.
    assert _callback(matrix, cfg, modified, status=2).json() == {"error": 0}
    late = _callback(matrix, cfg, modified, status=6, userdata="late-old-request")
    assert late.status_code == 409, late.text
    assert owner.get(f"/api/projects/{pid}/word/download").content == modified
    assert owner.get(f"/api/projects/{pid}/word/state").json()["version"] == 2


def test_failed_or_disallowed_callback_never_overwrites(matrix, monkeypatch):
    from app.domain import word_documents as w
    from app.domain.projects import ProjectError

    pid = _new(matrix)
    owner = matrix["users"]["owner"]
    cfg = _config(matrix, pid)
    original = owner.get(f"/api/projects/{pid}/word/download").content
    assert _callback(matrix, cfg, b"", status=7).json() == {"error": 0}
    assert owner.get(f"/api/projects/{pid}/word/state").json()["last_error"]
    assert owner.get(f"/api/projects/{pid}/word/download").content == original
    with monkeypatch.context() as m:
        def failed(url, pdf=False):
            raise ProjectError("测试下载失败", 502)
        m.setattr(w, "fetch_document", failed)
        assert _callback(matrix, cfg, b"").status_code == 502
    assert owner.get(f"/api/projects/{pid}/word/download").content == original
    for url in ("http://169.254.169.254/cache/a", "http://onlyoffice.evil/cache/a", "http://onlyoffice/admin",
                "http://onlyoffice/cache/%2e%2e/admin", "http://user:pw@onlyoffice/cache/a"):
        r = _callback(matrix, cfg, b"", url=url)
        assert r.status_code == 400, (url, r.text)
    assert w.server_download_url("http://localhost:9980/cache/files/a.docx?x=y") == "http://onlyoffice:80/cache/files/a.docx?x=y"
    assert owner.get(f"/api/projects/{pid}/word/state").json()["version"] == 1


def test_no_configuration_is_readable_503(matrix, monkeypatch):
    from app import config

    monkeypatch.setattr(config, "ONLYOFFICE_JWT_SECRET", "")
    owner = matrix["users"]["owner"]
    assert owner.get("/api/meta").json()["word_editor_ready"] is False
    r = owner.post("/api/projects/word/create", json={"title": "missing"})
    assert r.status_code == 503 and "PATENT_STUDIO_ONLYOFFICE_JWT_SECRET" in r.text


def test_download_policy_has_server_enforcement(matrix):
    owner, pid = matrix["users"]["owner"], matrix["pid"]
    r = owner.put(f"/api/projects/{pid}/collab-settings", json={"allow_download": False})
    assert r.status_code == 200, r.text
    try:
        assert matrix["users"]["viewer"].get(f"/api/projects/{pid}/word/download").status_code == 403
        assert owner.post(f"/api/projects/{pid}/word/export/pdf").status_code == 403
    finally:
        owner.put(f"/api/projects/{pid}/collab-settings", json={"allow_download": True})


def test_unchanged_save_retry_and_header_callback(matrix, monkeypatch):
    from app.domain import word_documents as w

    owner, pid = matrix["users"]["owner"], _new(matrix)
    cfg = _config(matrix, pid)
    before = owner.get(f"/api/projects/{pid}/word/state").json()
    raw = owner.get(f"/api/projects/{pid}/word/download").content
    monkeypatch.setattr(w, "fetch_document", lambda url, pdf=False: raw)
    monkeypatch.setattr(w, "server_request", lambda path, body: {"error": 0})
    _callback(matrix, cfg, raw, status=7)
    request_id = owner.post(f"/api/projects/{pid}/word/save").json()["request_id"]
    assert owner.get(f"/api/projects/{pid}/word/state").json()["last_error"] is None
    body = {"key": cfg["document"]["key"], "status": 6,
            "url": "http://onlyoffice/cache/files/session/output.docx", "userdata": request_id}
    header = w.sign({"payload": body, "operation": "callback"})
    r = TestClient(matrix["app"]).post(_path(cfg["editorConfig"]["callbackUrl"]),
                                        json=body, headers={"Authorization": "Bearer " + header})
    assert r.status_code == 200 and r.json() == {"error": 0}, r.text
    after = owner.get(f"/api/projects/{pid}/word/state").json()
    assert after["sha"] == before["sha"] and after["version"] == before["version"]
    assert after["updated_at"] != before["updated_at"] and not after["saving"]
    monkeypatch.setattr(w, "server_request", lambda path, body: {"error": 4})
    r = owner.post(f"/api/projects/{pid}/word/save")
    assert r.status_code == 409 and "尚未确认" in r.text


def test_pdf_uses_immutable_saved_snapshot(matrix, monkeypatch):
    from app.domain import word_documents as w

    owner, pid = matrix["users"]["owner"], _new(matrix)
    snapshot = owner.get(f"/api/projects/{pid}/word/state").json()
    calls = []
    pdf = b"%PDF-1.7\n% test PDF snapshot\n"

    def convert(path, body):
        calls.append((path, body))
        assert path == "/converter"
        assert snapshot["versions"][0]["id"] in body["url"]
        # Conversion service can fetch the capability without a browser cookie,
        # but it must provide its independent outbox JWT.
        token = w.sign({"payload": {"url": body["url"]}, "operation": "download"})
        r = TestClient(matrix["app"]).get(_path(body["url"]), headers={"Authorization": "Bearer " + token})
        assert r.status_code == 200, r.text
        return {"endConvert": True, "fileUrl": "http://onlyoffice/cache/files/pdf/output.pdf"}

    monkeypatch.setattr(w, "server_request", convert)
    monkeypatch.setattr(w, "fetch_document", lambda url, pdf=False: b"%PDF-1.7\n% test PDF snapshot\n")
    r = owner.post(f"/api/projects/{pid}/word/export/pdf")
    assert r.status_code == 200, r.text
    assert r.json()["sha"] == snapshot["sha"]
    assert owner.get(r.json()["url"]).content == pdf
    assert owner.post(f"/api/projects/{pid}/word/export/pdf").status_code == 200
    assert len(calls) == 1


def test_structured_conversion_creates_copy_and_preserves_original(matrix, monkeypatch):
    from app import config
    from app.domain import structured_export
    from app.domain import word_documents as w
    from app.main import store

    owner = matrix["users"]["owner"]
    monkeypatch.setattr(config, "STRUCT_WRITER_ON", True)
    r = owner.post("/api/projects/struct/create", json={"title": "旧稿"})
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    old = (matrix["projects"] / pid / "content.json").read_bytes()
    exported = matrix["projects"] / "conversion-result.docx"
    exported.write_bytes(w.make_document("旧稿", "blank"))
    monkeypatch.setattr(config, "STRUCT_WRITER_ON", False)
    monkeypatch.setattr(structured_export, "export_docx", lambda *args: {"docx": str(exported)})
    count = len(store.list_ids())
    assert owner.put(f"/api/projects/{pid}/collab-settings", json={"allow_download": False}).status_code == 200
    denied = owner.post(f"/api/projects/{pid}/word/convert-structured")
    assert denied.status_code == 403 and len(store.list_ids()) == count
    assert (matrix["projects"] / pid / "content.json").read_bytes() == old
    assert owner.put(f"/api/projects/{pid}/collab-settings", json={"allow_download": True}).status_code == 200
    r = owner.post(f"/api/projects/{pid}/word/convert-structured")
    assert r.status_code == 200, r.text
    assert r.json()["id"] != pid and r.json()["source_format"] == "docx"
    assert (matrix["projects"] / pid / "content.json").read_bytes() == old
    assert store.get(pid).settings["source_format"] == "structured"

    def blocked(*args):
        raise structured_export.StructExportBlocked(["不支持的公式"])

    monkeypatch.setattr(structured_export, "export_docx", blocked)
    count = len(store.list_ids())
    r = owner.post(f"/api/projects/{pid}/word/convert-structured")
    assert r.status_code == 422 and "不支持的公式" in r.text
    assert len(store.list_ids()) == count

    def unavailable(*args):
        raise structured_export.StructExportUnavailable("需要 Pandoc 3.1 或更高版本；原稿已保留")

    monkeypatch.setattr(structured_export, "export_docx", unavailable)
    r = owner.post(f"/api/projects/{pid}/word/convert-structured")
    assert r.status_code == 503 and "Pandoc 3.1" in r.text
    assert len(store.list_ids()) == count


def test_local_migration_converter_uses_configured_binary_and_rejects_old_lua_api(monkeypatch):
    from types import SimpleNamespace

    from app import config
    from app.domain import structured_export

    executable = r"D:\tools\pandoc-3.6.4\pandoc.exe"
    monkeypatch.setattr(config, "DOCX_EXPORT_PANDOC", executable)
    calls = []

    def old_version(args, **kwargs):
        calls.append(args)
        return SimpleNamespace(stdout="pandoc.exe 2.12\n")

    monkeypatch.setattr(structured_export.subprocess, "run", old_version)
    with pytest.raises(structured_export.StructExportUnavailable, match="Pandoc 3.1"):
        structured_export._local_pandoc()
    assert calls == [[executable, "--version"]]
    monkeypatch.setattr(structured_export.subprocess, "run",
                        lambda *args, **kwargs: SimpleNamespace(stdout="pandoc.exe 3.6.4\n"))
    assert structured_export._local_pandoc() == (executable, "pandoc.exe 3.6.4")


def test_plugin_is_local_and_embeddable(matrix):
    from app import config

    r = TestClient(matrix["app"]).get("/api/office-plugin/config.json?ds=http://evil.example")
    assert r.status_code == 200, r.text
    assert "evil.example" not in r.text
    assert "X-Frame-Options" not in r.headers
    assert r.json()["variations"][0]["url"] == "index.html"
    assert r.json()["baseUrl"] == config.PUBLIC_ORIGIN + "/api/office-plugin/"
    settings = TestClient(matrix["app"]).get("/api/office-plugin/settings.json?ds=http://evil.example")
    assert settings.json() == {"document_server_url": config.ONLYOFFICE_URL}
    index = TestClient(matrix["app"]).get("/api/office-plugin/index.html")
    assert index.status_code == 200 and "X-Frame-Options" not in index.headers
    native = TestClient(matrix["app"]).get("/api/office-plugin/native/config.json?ds=http://evil.example")
    assert native.status_code == 200 and "evil.example" not in native.text
    assert native.json()["baseUrl"] == config.PUBLIC_ORIGIN + "/api/office-plugin/native/"
    assert native.json()["variations"][0]["url"] == "index.html"
    assert native.json()["variations"][0]["type"] == "background"
    page = TestClient(matrix["app"]).get("/api/office-plugin/native/index.html")
    assert page.status_code == 200 and "X-Frame-Options" not in page.headers


def test_browser_plugins_use_public_origin_and_ds_keeps_internal_origin(matrix, monkeypatch):
    from app import config
    from app.domain import word_documents as w

    monkeypatch.setattr(config, "PUBLIC_ORIGIN", "https://paper.example.com")
    monkeypatch.setattr(config, "ONLYOFFICE_PUBLIC_URL", "http://app:8000")
    owner, pid = matrix["users"]["owner"], _new(matrix)
    # A relay may send an internal HTTP scheme. Neither that nor forged host
    # headers may replace the configured public origin or the DS callback URL.
    headers = {"X-Forwarded-Proto": "http", "X-Forwarded-Host": "evil.example",
               "Forwarded": "proto=http;host=evil.example",
               "CloudFront-Forwarded-Proto": "http"}
    r = owner.get(f"/api/projects/{pid}/word/editor-config", headers=headers)
    assert r.status_code == 200, r.text
    cfg = r.json()["config"]
    plugin_paths = ["/api/office-plugin/", "/api/office-plugin/native/",
                    "/api/office-plugin-ai/", "/api/office-plugin-refs/", "/api/office-charts/"]
    expected_plugins = [config.PUBLIC_ORIGIN + p + "config.json" for p in plugin_paths]
    assert cfg["editorConfig"]["plugins"]["pluginsData"] == expected_plugins
    assert w.verify(cfg["token"])["editorConfig"]["plugins"]["pluginsData"] == expected_plugins
    for path in plugin_paths:
        r = TestClient(matrix["app"]).get(path + "config.json", headers=headers)
        assert r.status_code == 200, r.text
        assert r.json()["baseUrl"] == config.PUBLIC_ORIGIN + path
    # 插件页面必须能被 DS iframe 嵌入：外层安全头中间件不得对任一插件路径回填 XFO。
    # （回归锚点：office-charts 拆为独立插件后漏出本名单，浏览器打开图表面板被 DENY 拒绝。）
    for path in plugin_paths:
        for page in ("config.json", "index.html"):
            r = TestClient(matrix["app"]).get(path + page, headers=headers)
            assert r.status_code == 200, r.text
            assert "X-Frame-Options" not in r.headers, path + page

    assert cfg["document"]["url"].startswith("http://app:8000/api/office/document/")
    assert cfg["editorConfig"]["callbackUrl"].startswith("http://app:8000/api/office/callback/")
    download_token = w.sign({"payload": {"url": cfg["document"]["url"]}})
    r = TestClient(matrix["app"]).get(_path(cfg["document"]["url"]),
                                      headers={"Authorization": "Bearer " + download_token})
    assert r.status_code == 200, r.text
    assert r.content == owner.get(f"/api/projects/{pid}/word/download").content


def test_legacy_build_export_and_source_format_cannot_reinterpret_docx(matrix):
    owner, pid = matrix["users"]["owner"], _new(matrix)
    original = owner.get(f"/api/projects/{pid}/word/download").content
    for endpoint, body in (("/content", {"content": "# alternate source"}),
                           ("/settings", {"source_format": "markdown"})):
        r = owner.put(f"/api/projects/{pid}" + endpoint, json=body)
        assert r.status_code == 400, r.text
    r = owner.post(f"/api/projects/{pid}/build", json={"content": "# bypass", "pdf": False})
    assert r.status_code == 400, r.text
    for path in ("/export?fmt=docx", "/export?fmt=pdf", "/export/docx?mode=tracked",
                 "/builds/fake/out.docx"):
        assert owner.get(f"/api/projects/{pid}" + path).status_code == 400
    assert owner.post(f"/api/projects/{pid}/export/xml", json={"content": "# bypass"}).status_code == 400
    assert not (matrix["projects"] / pid / "content.md").exists()
    assert not (matrix["projects"] / pid / ".studio" / "builds").exists()
    assert owner.get(f"/api/projects/{pid}/word/download").content == original


def test_service_request_negotiates_json_and_has_purpose_bound_jwt(matrix, monkeypatch):
    from app import config
    from app.domain import word_documents as w

    original_client = httpx.Client
    calls = []

    def handler(request):
        calls.append(request)
        assert request.headers["Accept"] == "application/json"
        body = json.loads(request.content)
        signed = w.verify(body["token"])
        assert signed["operation"] == "converter"
        assert signed["url"] == body["url"] and signed["key"] == body["key"]
        assert request.url == httpx.URL(config.ONLYOFFICE_INTERNAL_URL + "/converter")
        return httpx.Response(200, json={"endConvert": True,
                                        "fileUrl": config.ONLYOFFICE_INTERNAL_URL + "/cache/files/a/output.pdf"})

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(w.httpx, "Client", lambda **kwargs: original_client(transport=transport, **kwargs))
    result = w.server_request("/converter", {"key": "snapshot-a", "url": "http://studio/a.docx"})
    assert result["endConvert"] and len(calls) == 1


def test_large_callback_body_token_survives_ds_header_history_truncation(matrix, monkeypatch):
    from app.domain import word_documents as w

    owner, pid = matrix["users"]["owner"], _new(matrix)
    cfg = _config(matrix, pid)
    raw = owner.get(f"/api/projects/{pid}/word/download").content
    monkeypatch.setattr(w, "fetch_document", lambda url, pdf=False: raw)
    original = {"key": cfg["document"]["key"], "status": 6,
                "url": "http://onlyoffice/cache/files/a/output.docx",
                "changesurl": "http://onlyoffice/cache/files/a/changes.zip",
                "history": {"changes": ["history-entry" * 10000]}}
    body_token = w.sign({**original, "operation": "callback"})
    assert len(body_token) > 65536
    shortened = {k: v for k, v in original.items() if k != "changesurl"}
    shortened["history"] = {}
    header_token = w.sign({"payload": shortened, "operation": "callback"})
    shortened["token"] = body_token
    r = TestClient(matrix["app"]).post(_path(cfg["editorConfig"]["callbackUrl"]), json=shortened,
                                        headers={"Authorization": "Bearer " + header_token})
    assert r.status_code == 200 and r.json() == {"error": 0}, r.text


def test_manual_save_needs_own_nonce_and_rejects_earlier_auto_snapshot(matrix, monkeypatch):
    from app.domain import word_documents as w

    owner, pid = matrix["users"]["owner"], _new(matrix)
    cfg = _config(matrix, pid)
    original = owner.get(f"/api/projects/{pid}/word/download").content
    older, newer = _changed(original), _changed(_changed(original))
    monkeypatch.setattr(w, "server_request", lambda path, body: {"error": 0})
    current = owner.post(f"/api/projects/{pid}/word/save").json()["request_id"]
    assert owner.post(f"/api/projects/{pid}/word/save").status_code == 409
    monkeypatch.setattr(w, "fetch_document", lambda url, pdf=False: older)
    assert _callback(matrix, cfg, older, lastsave="2026-10-21T12:00:00.000Z").status_code == 200
    pending = owner.get(f"/api/projects/{pid}/word/state").json()
    assert pending["saving"] and pending["last_saved_request_id"] is None
    # A failed unrelated request must not invalidate the current save waiter.
    _callback(matrix, cfg, older, status=7, userdata="a-different-save")
    assert owner.get(f"/api/projects/{pid}/word/state").json()["last_error"] is None
    monkeypatch.setattr(w, "fetch_document", lambda url, pdf=False: newer)
    assert _callback(matrix, cfg, newer, userdata=current, lastsave="2026-10-21T12:00:01.000Z").status_code == 200
    done = owner.get(f"/api/projects/{pid}/word/state").json()
    assert not done["saving"] and done["last_saved_request_id"] == current
    # A delayed auto callback with an earlier or equal DS timestamp cannot roll
    # the already acknowledged manual document bytes back.
    monkeypatch.setattr(w, "fetch_document", lambda url, pdf=False: older)
    assert _callback(matrix, cfg, older, lastsave="2026-10-21T12:00:01.000Z").status_code == 200
    assert owner.get(f"/api/projects/{pid}/word/download").content == newer


def test_error_four_never_acknowledges_and_preserves_previous_nonce(matrix, monkeypatch):
    from app.domain import word_documents as w
    from app.domain.projects import ProjectError

    owner, pid = matrix["users"]["owner"], _new(matrix)
    cfg = _config(matrix, pid)
    raw = owner.get(f"/api/projects/{pid}/word/download").content
    nonces = []

    def accepted_but_timed_out(path, body):
        nonces.append(body["userdata"])
        raise ProjectError("network timeout after DS accepted command", 502)

    monkeypatch.setattr(w, "server_request", accepted_but_timed_out)
    assert owner.post(f"/api/projects/{pid}/word/save").status_code == 502
    first = nonces[0]
    monkeypatch.setattr(w, "server_request", lambda path, body: {"error": 4})
    r = owner.post(f"/api/projects/{pid}/word/save")
    assert r.status_code == 409 and "尚未确认" in r.text
    s = owner.get(f"/api/projects/{pid}/word/state").json()
    assert s["last_saved_request_id"] is None
    assert s["last_error"] is None and not s["saving"]
    monkeypatch.setattr(w, "fetch_document", lambda url, pdf=False: raw)
    assert _callback(matrix, cfg, raw, userdata=first).status_code == 200
    assert owner.get(f"/api/projects/{pid}/word/state").json()["last_saved_request_id"] == first


def test_citation_register_global_order(matrix):
    """Word 静态引用闭环后端：登记去重追加 + 全局序渲染标签（防多次插入都被编成 [1]）。"""
    owner, pid = matrix["users"]["owner"], matrix["pid"]
    bib_text = ("@article{a2020x, title={Alpha}, author={A. Author}, year={2020}}\n"
                "@book{b2021x, title={Beta}, author={B. Beta}, year={2021}}\n")
    preview = owner.post(f"/api/projects/{pid}/library/import", json={"text": bib_text}).json()
    assert len(preview["entries"]) == 2, preview
    committed = owner.post(f"/api/projects/{pid}/library/commit",
                           json={"entries": preview["entries"]}).json()
    rids = committed["reference_ids"]
    assert len(rids) == 2
    r1 = owner.post(f"/api/projects/{pid}/library/citations/register", json={"append": [rids[1]]})
    assert r1.status_code == 200 and r1.json() == {"order": [rids[1]], "changed": True}
    r2 = owner.post(f"/api/projects/{pid}/library/citations/register", json={"append": [rids[0]]})
    assert r2.json()["order"] == [rids[1], rids[0]] and r2.json()["changed"] is True
    r3 = owner.post(f"/api/projects/{pid}/library/citations/register", json={"append": [rids[1]]})
    assert r3.json()["order"] == [rids[1], rids[0]] and r3.json()["changed"] is False
    bib = owner.post(f"/api/projects/{pid}/library/bibliography",
                     json={"order": r3.json()["order"]}).json()
    assert bib["labels"][rids[1]] == "[1]" and bib["labels"][rids[0]] == "[2]"
    unknown = owner.post(f"/api/projects/{pid}/library/citations/register", json={"append": ["nope"]})
    assert unknown.status_code == 404


def _macro_docx() -> bytes:
    """带 vbaProject.bin 的包（真实宏文档的关键特征），扩展名仍伪装为 .docx。"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        z.writestr("word/document.xml",
                   '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>')
        z.writestr("word/vbaProject.bin", b"MBA")
    return buf.getvalue()


def test_upload_version_requires_editor_role(matrix):
    from app.domain import word_documents as w

    raw = w.make_document("上传权限", "blank")
    # 共享 fixture 案件带全套成员角色：viewer/reviewer 必须被写权限挡下
    url = f"/api/projects/{matrix['pid']}/word/upload-version"
    files = {"file": ("local.docx", raw, w.DOCX_MEDIA)}
    assert TestClient(matrix["app"]).post(url, files=files).status_code == 401
    assert matrix["users"]["viewer"].post(url, files=files).status_code == 403
    assert matrix["users"]["reviewer"].post(url, files=files).status_code == 403
    assert matrix["users"]["outsider"].post(url, files=files).status_code == 404
    # editor 的放行路径在独立新案上验证（先邀请为成员），避免污染共享案件
    pid = _new(matrix)
    assert matrix["users"]["owner"].put(
        f"/api/projects/{pid}/members",
        json={"email": "editor@word.example.com", "role": "editor"}).status_code == 200
    r = matrix["users"]["editor"].post(f"/api/projects/{pid}/word/upload-version", files=files)
    assert r.status_code == 200, r.text
    assert r.json()["unchanged"] is False


def test_upload_version_rejects_bad_files_and_non_word_projects(matrix, monkeypatch):
    from app import config
    from app.domain import word_documents as w

    owner = matrix["users"]["owner"]
    pid = _new(matrix)
    url = f"/api/projects/{pid}/word/upload-version"
    good = _changed(w.make_document("种子", "blank"))
    for name, data in (("bad.docx", b"not a zip"), ("fake.docm", good), ("bad.txt", good),
                       ("macro.docx", _macro_docx())):
        r = owner.post(url, files={"file": (name, data, w.DOCX_MEDIA)})
        assert r.status_code == 422, (name, r.text)
    assert "宏" in owner.post(url, files={"file": ("macro.docx", _macro_docx(), w.DOCX_MEDIA)}).text
    monkeypatch.setattr(config, "WORD_MAX_BYTES", 16)
    assert owner.post(url, files={"file": ("big.docx", good, w.DOCX_MEDIA)}).status_code == 413
    monkeypatch.setattr(config, "WORD_MAX_BYTES", 50 * 1024 * 1024)
    monkeypatch.setattr(config, "STRUCT_WRITER_ON", True)
    r = owner.post("/api/projects/struct/create", json={"title": "结构化旧案"})
    assert r.status_code == 200, r.text
    r = owner.post(f"/api/projects/{r.json()['id']}/word/upload-version",
                   files={"file": ("x.docx", good, w.DOCX_MEDIA)})
    assert r.status_code == 400 and "原生 Word" in r.text


def test_upload_version_conflicts_with_saving_and_stale_sha(matrix, monkeypatch):
    from app.domain import word_documents as w

    pid = _new(matrix)
    owner = matrix["users"]["owner"]
    cfg = _config(matrix, pid)
    url = f"/api/projects/{pid}/word/upload-version"
    original = owner.get(f"/api/projects/{pid}/word/download").content
    newer = _changed(original)
    files = {"file": ("local.docx", newer, w.DOCX_MEDIA)}
    stale_sha = owner.get(f"/api/projects/{pid}/word/state").json()["sha"]

    # DS 正在回传保存（forcesave 已受理、回调未到）→ 上传必须 409 拒绝覆盖
    monkeypatch.setattr(w, "server_request", lambda path, body: {"error": 0})
    request_id = owner.post(f"/api/projects/{pid}/word/save").json()["request_id"]
    assert owner.get(f"/api/projects/{pid}/word/state").json()["saving"] is True
    r = owner.post(url, files=files)
    assert r.status_code == 409 and "正在回传" in r.text

    # 他人完成一次保存 → version 2；再带过期 expected_sha 上传 → 409，绝不静默强覆
    monkeypatch.setattr(w, "fetch_document", lambda url, pdf=False: newer)
    assert _callback(matrix, cfg, newer, userdata=request_id).json() == {"error": 0}
    saved = owner.get(f"/api/projects/{pid}/word/state").json()
    assert saved["version"] == 2 and not saved["saving"]
    r = owner.post(url, files=files, data={"expected_sha": stale_sha})
    assert r.status_code == 409 and "刷新" in r.text
    # 传当前 sha、文件内容与最新版本一致 → 幂等 unchanged，不虚增版本
    r = owner.post(url, files=files, data={"expected_sha": saved["sha"]})
    assert r.status_code == 200, r.text
    assert r.json()["unchanged"] is True and r.json()["version"] == 2
    assert owner.get(f"/api/projects/{pid}/word/state").json()["version"] == 2


def test_upload_version_persists_versions_rotates_key_and_rejects_old_callback(matrix):
    from app.domain import events
    from app.domain import word_documents as w

    pid = _new(matrix)
    owner = matrix["users"]["owner"]
    cfg = _config(matrix, pid)
    old_key = cfg["document"]["key"]
    original = owner.get(f"/api/projects/{pid}/word/download").content
    before = owner.get(f"/api/projects/{pid}/word/state").json()
    local = _changed(original)
    seen = []
    unsub = events.subscribe("*", lambda ev: seen.append(ev))
    try:
        r = owner.post(f"/api/projects/{pid}/word/upload-version", files={"file": ("本地精调.docx", local, w.DOCX_MEDIA)},
                       data={"expected_sha": before["sha"]})
    finally:
        unsub()
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["unchanged"] is False
    assert body["version"] == before["version"] + 1
    assert body["sha"] == hashlib.sha256(local).hexdigest()
    assert body["state"]["versions"][-1]["source"] == "upload-version"
    assert len(body["state"]["versions"]) == len(before["versions"]) + 1
    uploaded = [ev for ev in seen if ev.kind == "word.version_uploaded"]
    assert uploaded and uploaded[0].pid == pid and uploaded[0].data["version"] == body["version"]
    # document.docx = 上传的新文件；旧版本文件完整保留且可下载
    assert owner.get(f"/api/projects/{pid}/word/download").content == local
    old_vid = before["versions"][-1]["id"]
    assert owner.get(f"/api/projects/{pid}/word/versions/{old_vid}/download").content == original
    # 会话键已轮换：editor-config 发放新 key；旧 key 的延迟 callback 被 409 拒绝且不落盘
    new_key = body["doc_key"]
    assert new_key and new_key != old_key
    assert _config(matrix, pid)["document"]["key"] == new_key
    stale = _callback(matrix, cfg, local, status=6)
    assert stale.status_code == 409, stale.text
    assert owner.get(f"/api/projects/{pid}/word/state").json()["sha"] == body["sha"]
    # 相同文件重复上传：幂等返回当前状态，不新增冗余版本
    r = owner.post(f"/api/projects/{pid}/word/upload-version", files={"file": ("本地精调.docx", local, w.DOCX_MEDIA)})
    assert r.status_code == 200, r.text
    assert r.json()["unchanged"] is True and r.json()["version"] == body["version"]
    assert owner.get(f"/api/projects/{pid}/word/state").json()["version"] == body["version"]
