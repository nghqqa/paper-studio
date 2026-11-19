"""Real authenticated HTTP lifecycle for the platform template catalogue."""
import asyncio
import io
import json
import zipfile

import pytest
from docx import Document
from fastapi.testclient import TestClient

from test_word_editor import matrix  # Shared native Word/auth fixture, isolated data volume.

BASE = "/api/admin/paper-templates"


def admin(matrix):
    c = TestClient(matrix["app"])
    assert c.post("/api/auth/cookie/login", data={"username": "bootstrap@word.example.com", "password": "Word-test-pw!"}).status_code == 204
    return c


def docx(text="期刊模板内容不应被重建"):
    doc = Document()
    doc.add_paragraph(text)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def zip_bytes(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            entry = zipfile.ZipInfo(name)
            entry.filename = name  # Preserve malicious backslashes even on Windows.
            z.writestr(entry, data)
    return buf.getvalue()


def upload(c, data, fmt="docx", **extra):
    return c.post(BASE, data={"metadata": json.dumps({"format": fmt, "name": "团队模板", **extra})},
                  files={"file": ("template.docx" if fmt == "docx" else "template.zip", data)})


def test_admin_permissions_fail_closed_including_auth_off(matrix, monkeypatch):
    from app import config

    assert TestClient(matrix["app"]).get(BASE).status_code == 401
    assert TestClient(matrix["app"]).get("/api/paper-templates").status_code == 401
    owner = matrix["users"]["owner"]
    assert owner.get(BASE).status_code == 403
    assert upload(owner, docx()).status_code == 403
    assert owner.delete(BASE + "/docx/jcip").status_code == 403
    assert owner.patch(BASE + "/docx/jcip", json={"enabled": True}).status_code == 403
    monkeypatch.setattr(config, "AUTH_ON", False)
    assert TestClient(matrix["app"]).get(BASE).status_code == 503


def test_word_publish_remove_restore_preserves_original_and_project(matrix):
    c = admin(matrix)
    data = docx()
    r = upload(c, data)
    assert r.status_code == 201, r.text
    row = r.json()
    assert row["origin"] == "upload" and row["enabled"]
    assert "document" not in row
    tid = row["id"]
    author = matrix["users"]["owner"]
    assert any(t["id"] == tid for t in author.get("/api/paper-templates").json()["word"])
    p = author.post("/api/projects/word/create", json={"title": "自定义期刊", "template": tid}).json()["id"]
    assert author.get(f"/api/projects/{p}/word/download").content == data
    assert c.delete(BASE + "/docx/" + tid).status_code == 200
    assert not any(t["id"] == tid for t in author.get("/api/paper-templates").json()["word"])
    assert author.post("/api/projects/word/create", json={"template": tid}).status_code == 404
    assert author.get(f"/api/projects/{p}/word/download").content == data
    # Reading the volume afresh must retain unpublished state.
    assert next(t for t in c.get(BASE).json()["items"] if t["id"] == tid)["enabled"] is False
    assert c.patch(BASE + "/docx/" + tid, json={"enabled": True}).status_code == 200
    assert author.post("/api/projects/word/create", json={"template": tid}).status_code == 200
    audit = c.get("/api/admin/audit", params={"kind": "template.removed"})
    assert audit.status_code == 200 and any(t["data"].get("id") == tid for t in audit.json()["items"])


def test_latex_complete_package_and_builtin_removal(matrix):
    c = admin(matrix)
    source = "\\documentclass{article}\n\\begin{document}Hello\\end{document}"
    data = zip_bytes({"paper/main.tex": source, "paper/library.bib": "@book{x,title={Book}}", "paper/figure.png": b"image"})
    r = upload(c, data, "latex", main="paper/main.tex", engine="pdflatex", venue="My Journal")
    assert r.status_code == 201, r.text
    row = r.json()
    assert row["verify"] == "unverified"
    author = matrix["users"]["owner"]
    r = author.post("/api/projects/latex-demo", json={"template": row["id"]})
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    root = matrix["projects"] / pid
    assert (root / "paper/main.tex").read_text(encoding="utf-8") == source
    assert (root / "paper/library.bib").is_file() and (root / "paper/figure.png").is_file()
    assert r.json()["latex"] == {"main": "paper/main.tex", "engine": "pdflatex"}
    assert r.json()["settings"]["submission"]["venue"] == "My Journal"
    assert c.delete(BASE + "/latex/" + row["id"]).status_code == 200
    assert (root / "paper/main.tex").is_file()
    assert c.delete(BASE + "/latex/iclr2027").status_code == 200
    assert author.post("/api/projects/latex-demo", json={"template": "iclr2027"}).status_code == 404
    assert c.patch(BASE + "/latex/iclr2027", json={"enabled": True}).status_code == 200


@pytest.mark.parametrize("name", ["../escape.tex", "/escape.tex", "C:/escape.tex", "folder/evil:stream.tex", "a\\escape.tex", ".latexmkrc", "folder/studio.json", "folder/CON.tex", "bad.sh", "nested.zip"])
def test_zip_rejects_unsafe_paths_and_executables(matrix, name):
    r = upload(admin(matrix), zip_bytes({"main.tex": "\\documentclass{article}", name: "no"}), "latex")
    assert r.status_code == 422, r.text


def test_rejects_bad_docx_main_file_size_and_duplicate(matrix, monkeypatch):
    from app import config

    c = admin(matrix)
    assert upload(c, b"not-docx").status_code == 422
    # 22026aa 起主文件可自动检测（含 \documentclass 的 .tex 即候选）——断言 422 须用无任何
    # \documentclass 的 zip
    assert upload(c, zip_bytes({"other.tex": "just text without documentclass"}), "latex").status_code == 422
    assert upload(c, zip_bytes({"main.tex": "\\documentclass{article}", "MAIN.tex": "conflict"}), "latex").status_code == 422
    monkeypatch.setattr(config, "IMPORT_MAX_FILE_MB", 0)
    assert upload(c, zip_bytes({"main.tex": "\\documentclass{article}"}), "latex").status_code == 413


def test_password_setup_token_is_single_use_and_does_not_promote_author(matrix):
    from app.auth.create_user import ProvisioningManager
    from app.auth.db import SessionLocal
    from app.auth.models import User
    from fastapi_users.db import SQLAlchemyUserDatabase

    async def token():
        async with SessionLocal() as session:
            manager = ProvisioningManager(SQLAlchemyUserDatabase(session, User))
            user = await manager.user_db.get_by_email("outsider@word.example.com")
            await manager.forgot_password(user)
            return manager.setup_token

    c = TestClient(matrix["app"])
    jwt = asyncio.run(token())
    assert c.post("/api/auth/setup-password", json={"token": jwt, "password": "short"}).status_code == 422
    assert c.post("/api/auth/setup-password", json={"token": jwt, "password": "My-new-safe-password!"}).status_code == 200
    assert c.post("/api/auth/setup-password", json={"token": jwt, "password": "Another-password!"}).status_code == 400
    assert c.post("/api/auth/setup-password", json={"token": "bad", "password": "Another-password!"}).status_code == 400
    assert c.post("/api/auth/cookie/login", data={"username": "outsider@word.example.com", "password": "Word-test-pw!"}).status_code == 400
    assert c.post("/api/auth/cookie/login", data={"username": "outsider@word.example.com", "password": "My-new-safe-password!"}).status_code == 204
    assert c.get("/api/users/me").json()["is_superuser"] is False


def test_patch_updates_meta_and_builtin_whitelist(matrix, monkeypatch):
    """PATCH 部分更新：upload 展示字段直接改行、builtin 走 catalog override 白名单；
    main/engine 仅 upload LaTeX 可改，变更即重置 verify（代际令牌推进）。"""
    from app.domain import task_runner

    c = admin(matrix)
    author = matrix["users"]["owner"]
    source = "\\documentclass{article}\n\\begin{document}x\\end{document}"
    r = upload(c, zip_bytes({"main.tex": source, "alt.tex": source}), "latex",
               main="main.tex", engine="pdflatex", venue="Old Venue")
    assert r.status_code == 201, r.text
    tid = r.json()["id"]
    assert r.json()["version"] == 1
    # 部分更新：只动给定字段；作者目录即时生效
    r = c.patch(BASE + "/latex/" + tid, json={"name": "改名后", "venue": "新会场"})
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "改名后" and r.json()["venue"] == "新会场" and r.json()["engine"] == "pdflatex"
    item = next(t for t in author.get("/api/paper-templates").json()["latex"] if t["id"] == tid)
    assert item["name"] == "改名后" and item["venue"] == "新会场"
    # 空体幂等 200
    assert c.patch(BASE + "/latex/" + tid, json={}).status_code == 200
    # 旧 body {"enabled": bool} 兼容：builtin jcip 启用态照旧返回 200
    assert c.patch(BASE + "/docx/jcip", json={"enabled": True}).status_code == 200
    # builtin 展示字段可改（catalog override），且 jcip 仍可正常建案
    r = c.patch(BASE + "/docx/jcip", json={"name": "中文信息学报（自定义名）", "desc": "自定义描述"})
    assert r.status_code == 200, r.text
    assert any(t["name"] == "中文信息学报（自定义名）" for t in author.get("/api/paper-templates").json()["word"])
    assert author.post("/api/projects/word/create", json={"title": "内置改名后建案", "template": "jcip"}).status_code == 200
    # 白名单边界：builtin 改 main/engine → 422；docx 改 main/engine → 422；资产里不存在的 main → 422
    assert c.patch(BASE + "/latex/iclr2027", json={"main": "x.tex"}).status_code == 422
    r = upload(c, docx())
    assert c.patch(BASE + "/docx/" + r.json()["id"], json={"main": "a.tex"}).status_code == 422
    assert c.patch(BASE + "/latex/" + tid, json={"main": "missing/main.tex"}).status_code == 422
    # main 变更 ⇒ verify 重置：先真实验证到 verified，再切 alt.tex
    def fake(cmd, cwd=None, **kw):
        import os
        stem = os.path.splitext(os.path.basename(cmd[-1]))[0]
        with open(os.path.join(cwd, stem + ".pdf"), "wb") as f:
            f.write(b"%PDF-1.4 stub")
        return 0
    monkeypatch.setattr(task_runner, "run_task", fake)
    assert c.post(f"{BASE}/latex/{tid}/verify").json()["status"] == "ok"
    r = c.patch(BASE + "/latex/" + tid, json={"main": "alt.tex"})
    assert r.status_code == 200, r.text
    mine = next(t for t in c.get(BASE).json()["items"] if t["id"] == tid)
    assert mine["verify"] == "unverified" and mine["main"] == "alt.tex" and mine["updated_at"]
    # 审计：template.updated 携带 changes 明细
    audit = c.get("/api/admin/audit", params={"kind": "template.updated"})
    assert audit.status_code == 200
    hits = [t for t in audit.json()["items"] if t["data"].get("id") == tid]
    assert hits and any("name" in t["data"].get("changes", {}) for t in hits)


def test_replace_version_upload_only_and_rollback(matrix):
    """PUT 替换版本：tid 不变、version 自增、verify 重置、新内容对新工程生效；
    builtin 禁止替换；坏包 422 且旧版本完好回滚（version 不再推进）。"""
    c = admin(matrix)
    author = matrix["users"]["owner"]
    v1 = "\\documentclass{article}\n\\begin{document}V1\\end{document}"
    v2 = "\\documentclass{article}\n\\begin{document}V2\\end{document}"
    r = upload(c, zip_bytes({"main.tex": v1}), "latex", main="main.tex", engine="pdflatex")
    assert r.status_code == 201, r.text
    tid = r.json()["id"]
    # 替换 → version 2 + verify 重置 + updated_at
    r = c.put(BASE + f"/latex/{tid}/file", files={"file": ("template.zip", zip_bytes({"main.tex": v2}))})
    assert r.status_code == 200, r.text
    row = r.json()
    assert row["version"] == 2 and row["verify"] == "unverified" and row["updated_at"]
    pid = author.post("/api/projects/latex-demo", json={"template": tid}).json()["id"]
    assert (matrix["projects"] / pid / "main.tex").read_text(encoding="utf-8") == v2
    # builtin 禁止替换
    r = c.put(BASE + "/latex/iclr2027/file", files={"file": ("template.zip", zip_bytes({"main.tex": v2}))})
    assert r.status_code == 422, r.text
    # 坏包（嵌套 zip 成员）→ 422 且旧版本完好：version 仍是 2、内容仍 v2
    bad = zip_bytes({"main.tex": v2, "nested.zip": b"PK"})
    assert c.put(BASE + f"/latex/{tid}/file", files={"file": ("template.zip", bad)}).status_code == 422
    pid2 = author.post("/api/projects/latex-demo", json={"template": tid}).json()["id"]
    assert (matrix["projects"] / pid2 / "main.tex").read_text(encoding="utf-8") == v2
    assert next(t for t in c.get(BASE).json()["items"] if t["id"] == tid)["version"] == 2
    # docx 替换：版本推进、新建工程拿到新字节（旧工程不受影响）
    orig = docx()
    r = upload(c, orig)
    dtid = r.json()["id"]
    replaced = docx("替换后的期刊模板")
    r = c.put(BASE + f"/docx/{dtid}/file", files={"file": ("template.docx", replaced)})
    assert r.status_code == 200 and r.json()["version"] == 2, r.text
    p = author.post("/api/projects/word/create", json={"title": "替换版建案", "template": dtid}).json()["id"]
    assert author.get(f"/api/projects/{p}/word/download").content == replaced
    # docx 替换带 main/engine 元数据 → 422
    r = c.put(BASE + f"/docx/{dtid}/file", files={"file": ("template.docx", orig)},
              data={"metadata": json.dumps({"main": "a.tex"})})
    assert r.status_code == 422, r.text
    # 审计：template.replaced 带 version
    audit = c.get("/api/admin/audit", params={"kind": "template.replaced"})
    assert any(t["data"].get("id") == tid and t["data"].get("version") == 2 for t in audit.json()["items"])


def test_thumbnail_endpoint_etag_and_access(matrix, monkeypatch):
    """缩略图端点：仅启用模板可读、纯 PNG、ETag 304；thumb 布尔进作者目录；匿名 401。"""
    from app.domain import paper_templates as domain
    from app.domain import task_runner

    c = admin(matrix)
    author = matrix["users"]["owner"]
    source = "\\documentclass{article}\n\\begin{document}x\\end{document}"
    r = upload(c, zip_bytes({"main.tex": source}), "latex", main="main.tex", engine="pdflatex")
    tid = r.json()["id"]
    url = f"/api/paper-templates/latex/{tid}/thumbnail"
    assert next(t for t in author.get("/api/paper-templates").json()["latex"] if t["id"] == tid)["thumb"] is False
    assert author.get(url).status_code == 404
    assert TestClient(matrix["app"]).get(url).status_code == 401
    # 验证成功产缩略图（pdftoppm 桩；真实 pdftoppm 存在时同一断言也成立）
    def fake(cmd, cwd=None, **kw):
        import os
        stem = os.path.splitext(os.path.basename(cmd[-1]))[0]
        with open(os.path.join(cwd, stem + ".pdf"), "wb") as f:
            f.write(b"%PDF-1.4 stub")
        return 0
    monkeypatch.setattr(task_runner, "run_task", fake)
    monkeypatch.setattr(domain, "_pdf_first_png", lambda p: b"\x89PNG-fake" if p else None)
    assert c.post(f"{BASE}/latex/{tid}/verify").json()["status"] == "ok"
    data = author.get(url)
    assert data.status_code == 200 and data.headers["content-type"].startswith("image/png")
    assert data.headers["x-content-type-options"] == "nosniff"
    etag = data.headers["etag"]
    assert author.get(url, headers={"if-none-match": etag}).status_code == 304
    assert next(t for t in author.get("/api/paper-templates").json()["latex"] if t["id"] == tid)["thumb"] is True
    # 下架后对作者 404（不暴露已移除模板的存在）
    assert c.delete(BASE + "/latex/" + tid).status_code == 200
    assert author.get(url).status_code == 404


def test_word_preview_conversion_and_degrade(matrix, monkeypatch):
    """Word「生成预览」：DS 不可达 ⇒ status=error + 可读原因且不降级内置 verify 既有值；
    stub 转换成功 ⇒ jcip 产缩略图；/api/office/template 回拉路由无 cap/无 DS 下载 JWT 均 403。"""
    from app.domain import paper_templates as domain
    from app.domain import word_documents as word

    c = admin(matrix)
    jcip_before = next(t for t in c.get(BASE).json()["items"] if t["id"] == "jcip")
    r = c.post(BASE + "/docx/jcip/preview")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "error" and body["verify_error"]
    jcip_after = next(t for t in c.get(BASE).json()["items"] if t["id"] == "jcip")
    assert jcip_after["verify"] == jcip_before["verify"]
    assert next(t for t in c.get(BASE).json()["items"] if t["id"] == "jcip")["thumb"] is False
    # LaTeX 调 preview → 422（LaTeX 用「验证编译」）
    assert c.post(BASE + "/latex/iclr2027/preview").status_code == 422
    # 成功路径（stub DS /converter 与 PDF 拉取）
    monkeypatch.setattr(word, "server_request",
                        lambda path, body: {"endConvert": True, "fileUrl": "http://onlyoffice/cache/converted.pdf"}
                        if path == "/converter" else (_ for _ in ()).throw(AssertionError(path)))
    monkeypatch.setattr(word, "fetch_document", lambda url, pdf=False: b"%PDF-1.4 stub")
    monkeypatch.setattr(domain, "_pdf_first_png", lambda p: b"\x89PNG-fake" if p else None)
    r = c.post(BASE + "/docx/jcip/preview")
    assert r.status_code == 200 and r.json()["status"] == "ok", r.text
    author = matrix["users"]["owner"]
    assert author.get("/api/paper-templates/docx/jcip/thumbnail").status_code == 200
    assert next(t for t in c.get(BASE).json()["items"] if t["id"] == "jcip")["thumb"] is True
    # 回拉路由双重校验：缺 cap 参数 → 422（FastAPI 必填，与 ds_document 同形）；
    # 伪造 cap → 403；真 cap 但缺 DS 下载 JWT → 403
    assert TestClient(matrix["app"]).get("/api/office/template/docx/jcip").status_code == 422
    assert TestClient(matrix["app"]).get("/api/office/template/docx/jcip?cap=forged").status_code == 403
    cap = word.capability("docx:jcip", "template-doc", "template")
    assert TestClient(matrix["app"]).get(f"/api/office/template/docx/jcip?cap={cap}").status_code == 403
