# -*- coding: utf-8 -*-
"""P1-4：公开审阅链接适配 LaTeX / Word 论文工程。

- LaTeX：meta 不读 content.md、取 latex-builds 最新成功构建产物加水印、layout-ast 400 validation、
  页级批注（pdf:page-N 锚）与 confirm 全通。
- Word：只认与 state sha 严格一致的 exports/{sha}.pdf；未导出 ⇒ pdf_ready=False + /pdf 404；
  state.json 缺失 ⇒ (0, "") 安全回退；批注 / confirm 记录 Word 真实 version / sha。
- 兼容：markdown 链接 meta 三新字段回填缺省值（既有 test_public_share.py 断言全部不变）。

夹具复用 test_legacy_auth（on / _register / _login）；工程替身一律改写 pytest tmp_path 里
test_auth.on 复制出的副本，绝不触碰仓库 examples/。
"""

import io
import json

import test_legacy_auth as test_auth
from fastapi.testclient import TestClient
from pypdf import PdfReader, PdfWriter

from app.domain import cases

on = test_auth.on
_register, _login = test_auth._register, test_auth._login

SHA_A = "a" * 64
SHA_B = "b" * 64


def _team(on):
    anon = TestClient(on.app)
    _register(anon, "su@example.com", display_name="所长")
    su = _login(on, "su@example.com")
    return anon, su


def _link(su, **body):
    body = {"scope": "confirm", "ttl_days": 7, "allow_download": True, **body}
    r = su.post("/api/projects/method/public-links", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _set_settings(d, patch: dict):
    p = d / "studio.json"
    s = json.loads(p.read_text(encoding="utf-8")) if p.is_file() else {}
    s.update(patch)
    p.write_text(json.dumps(s, ensure_ascii=False), encoding="utf-8")


def _make_pdf(path, pages=1):
    path.parent.mkdir(parents=True, exist_ok=True)
    w = PdfWriter()
    for _ in range(pages):
        w.add_blank_page(595, 842)
    with open(path, "wb") as f:
        w.write(f)


def _to_paper_dir(projects, fmt: str, title: str):
    d = projects / "method"
    (d / "content.md").unlink(missing_ok=True)
    _set_settings(d, {"source_format": fmt, "document_type": "paper", "title": title})
    return d


def _to_latex(projects, title="基于扩散模型的时序预测方法"):
    return _to_paper_dir(projects, "latex", title)


def _to_word(projects, sha=SHA_A, version=3, title="一种基于联邦学习的控制方法"):
    d = _to_paper_dir(projects, "docx", title)
    _write_word_state(d, sha=sha, version=version)
    return d


def _write_word_state(d, sha, version):
    base = d / ".studio" / "word"
    base.mkdir(parents=True, exist_ok=True)
    state = {
        "version": version,
        "sha": sha,
        "updated_at": "2026-11-17T00:00:00+00:00",
        "saving": False,
        "versions": [{"id": f"v{version:06d}-{sha[:12]}", "sha": sha, "created_at": "2026-11-17T00:00:00+00:00", "source": "import"}],
        "key": "k" * 40,
        "closed": False,
        "receipts": [],
    }
    (base / "state.json").write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")


def _write_latex_build(root, bid, *, status, pdf, synctex=False, pages=1):
    d = root / bid
    d.mkdir(parents=True, exist_ok=True)
    manifest = {"build_id": bid, "pid": "method", "engine": "xelatex", "main": "main.tex", "status": status}
    (d / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    if synctex:
        (d / "main.synctex.gz").write_bytes(b"")
    if pdf:
        _make_pdf(d / "main.pdf", pages=pages)
    return d


# ---------------- LaTeX ----------------


def test_latex_link_meta_pdf_comments_confirm(on, tmp_path):
    anon, su = _team(on)
    projects = tmp_path / "projects"
    _to_latex(projects)
    builds = projects / "method" / ".studio" / "latex-builds"
    _write_latex_build(builds, "b1", status="failed", pdf=True, pages=1)  # 失败构建带旧 PDF：绝不可取
    _write_latex_build(builds, "b2", status="ok", pdf=True, synctex=True, pages=2)  # 目标：最新 ok 且产物在
    _write_latex_build(builds, "b3", status="ok", pdf=False)  # ok 但产物丢失：跳过

    tok = _link(su, scope="confirm", allow_download=True)["token"]
    r = anon.get(f"/api/public/{tok}/meta")
    assert r.status_code == 200, r.text
    m = r.json()
    assert m["source_format"] == "latex" and m["document_type"] == "paper"
    assert m["layout_supported"] is False and m["pending_revisions"] == 0 and m["pdf_ready"] is True
    assert m["org_name"] == "研稿"

    # PDF：取 b2 的产物（2 页，b1 失败构建的 1 页旧 PDF 未被误取）+ 水印 + 允许下载
    r = anon.get(f"/api/public/{tok}/pdf")
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
    assert r.headers["content-disposition"].startswith("attachment;")
    assert r.headers["x-watermark"] == "footer"
    assert len(PdfReader(io.BytesIO(r.content)).pages) == 2

    # 版面 AST：专利 Markdown 版面路由已彻底下线（404）
    r = anon.get(f"/api/public/{tok}/layout-ast")
    assert r.status_code == 404

    # 页级批注：保存 + 读取（不读 content.md、不进专利 AST 重锚）
    r = anon.post(
        f"/api/public/{tok}/comments",
        json={"name": "李编辑", "anchor": {"block_id": "pdf:page-1", "line": 1, "quote": "第 1 页"}, "body": "摘要建议压缩到 250 字以内"},
    )
    assert r.status_code == 201, r.text
    c = r.json()
    assert c["source"] == "client" and c["anchor"]["block_id"] == "pdf:page-1"
    assert [x["id"] for x in anon.get(f"/api/public/{tok}/comments").json()] == [c["id"]]

    # 确认：替身无 git ⇒ version 0，仍落 case.json.confirmations[]
    r = anon.post(f"/api/public/{tok}/confirm", json={"name": "李编辑", "note": "同意投稿"})
    assert r.status_code == 200, r.text
    rec = cases.load_case(str(projects / "method")).confirmations[0]
    assert rec.name == "李编辑" and rec.actor == "client:李编辑"

    # 不泄露源码 / 文件端点（公开域只有 meta / pdf / comments / confirm / layout-*）
    assert anon.get(f"/api/public/{tok}/content").status_code == 404
    assert anon.get(f"/api/public/{tok}/latex/files").status_code == 404
    assert anon.get("/api/projects/method/latex/files/main.tex").status_code == 401


# ---------------- Word ----------------


def test_word_pdf_matches_current_sha_and_missing_export(on, tmp_path):
    anon, su = _team(on)
    projects = tmp_path / "projects"
    d = _to_word(projects, sha=SHA_A, version=3)
    _make_pdf(d / ".studio" / "word" / "exports" / f"{SHA_A}.pdf", pages=1)

    tok = _link(su)["token"]
    m = anon.get(f"/api/public/{tok}/meta").json()
    assert m["source_format"] == "docx" and m["document_type"] == "paper" and m["layout_supported"] is False
    assert m["version"] == 3 and m["sha"] == SHA_A and m["pdf_ready"] is True

    r = anon.get(f"/api/public/{tok}/pdf")
    assert r.status_code == 200 and len(PdfReader(io.BytesIO(r.content)).pages) == 1

    # 新版本尚未导出 PDF ⇒ pdf_ready=False；/pdf 404（不现场触发 ONLYOFFICE）
    _write_word_state(d, sha=SHA_B, version=4)
    m = anon.get(f"/api/public/{tok}/meta").json()
    assert m["version"] == 4 and m["sha"] == SHA_B and m["pdf_ready"] is False
    r = anon.get(f"/api/public/{tok}/pdf")
    assert r.status_code == 404 and r.json()["detail"]["kind"] == "not_found"

    # state.json 丢失：安全回退 (0, "")，meta 不崩溃、不泄露
    (d / ".studio" / "word" / "state.json").unlink()
    r = anon.get(f"/api/public/{tok}/meta")
    assert r.status_code == 200, r.text
    m = r.json()
    assert m["version"] == 0 and m["sha"] == "" and m["pdf_ready"] is False

    # DOCX 本体不经公开链接暴露
    assert anon.get(f"/api/public/{tok}/download").status_code == 404
    assert anon.get("/api/projects/method/word/download").status_code == 401


def test_word_comments_and_confirm_record_word_version(on, tmp_path):
    anon, su = _team(on)
    projects = tmp_path / "projects"
    _to_word(projects, sha=SHA_A, version=3)
    tok = _link(su, scope="confirm")["token"]

    r = anon.post(
        f"/api/public/{tok}/comments",
        json={"name": "王编辑", "anchor": {"block_id": "pdf:page-2", "line": 2, "quote": "第 2 页"}, "body": "图 2 建议放大"},
    )
    assert r.status_code == 201, r.text
    cid = r.json()["id"]
    assert [x["id"] for x in anon.get(f"/api/public/{tok}/comments").json()] == [cid]
    # 站内同一份数据可按 source 筛（同样不读 content.md）
    assert [x["id"] for x in su.get("/api/projects/method/comments?source=client").json()] == [cid]

    r = anon.post(f"/api/public/{tok}/confirm", json={"name": "王编辑", "note": "同意投稿"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["version"] == 3 and out["sha"] == SHA_A
    rec = cases.load_case(str(projects / "method")).confirmations[0]
    assert rec.version == 3 and rec.sha == SHA_A and rec.actor == "client:王编辑" and rec.token == tok


# ---------------- structured / markdown 兼容 ----------------


def test_markdown_meta_keeps_paper_defaults(on):
    """纯化后公开审阅仅支持 PDF 审阅（layout_supported 恒为 False，默认 paper）。"""
    anon, su = _team(on)
    tok = _link(su)["token"]
    m = anon.get(f"/api/public/{tok}/meta").json()
    assert m["document_type"] == "paper" and m["layout_supported"] is False and m["pending_revisions"] == 0
