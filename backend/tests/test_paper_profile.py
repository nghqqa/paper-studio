# -*- coding: utf-8 -*-
"""w20 批 A1：论文文档档案（paper profile）。

覆盖：缺省类型兼容 patent、patent 仍拒绝非法章节、paper 接受自定义 ## 章节、document_type 在
保存/设置更新/重载后保持、未知类型明确报错、paper DOCX 无 [0001] 段号与 CNIPA 页眉页脚、
公式为 OMML 原生对象、API 全链（创建→保存→重载→构建→导出）。合成论文示例：examples/paper-demo。
"""

import os
import shutil
import urllib.parse
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.domain.projects import ProjectStore
from patent_studio.kernel.ast import AstError, parse_ast, parse_paper_ast
from patent_studio.kernel.paper import parse_paper_md
from patent_studio.kernel.paper_builder import build_paper_ex

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEMO = os.path.join(ROOT, "examples", "paper-demo")
DEMO_MD = os.path.join(DEMO, "content.md")

PAPER_MD = open(DEMO_MD, encoding="utf-8").read()

PATENT_LIKE = """# 一种示例装置

## 摘要

一种示例装置。

## 权利要求书

1.一种示例装置，其特征在于……

## 说明书

### 技术领域

本发明涉及示例领域。
"""

CUSTOM_SECTION = """# 论文标题

## 摘要

中文摘要，含行内公式 $x_{i}$。

## 引言

正文一段。

$$E = mc^{2}$$(1)
"""


# ---------------- 内核：解析与 AST ----------------


def test_paper_parse_custom_sections():
    title, sections = parse_paper_md(CUSTOM_SECTION)
    assert title == "论文标题"
    assert [n for n, _ in sections] == [None, "摘要", "引言"]
    items = dict(sections)["引言"]
    assert ("e", "E = mc^{2}", "(1)") in items


def test_paper_ast_shape_and_line_math():
    ast = parse_paper_ast(CUSTOM_SECTION)
    assert ast["profile"] == "paper"
    assert ast["title"]["text"] == "论文标题" and ast["title"]["line"] == 1
    kinds = [(b["kind"], b.get("title") or b.get("text")) for b in ast["description"]]
    assert ("section", "摘要") in kinds and ("section", "引言") in kinds
    assert any(b["kind"] == "equation" and b["label"] == "(1)" for b in ast["description"])
    assert all(b.get("para_no") is None for b in ast["description"])
    # 行坐标系：full = books.description.offset + 块 rel 行（patch/comments 共用算术）
    off = ast["books"]["description"]["offset"]
    src_lines = CUSTOM_SECTION.rstrip("\n").split("\n")
    for b in ast["description"]:
        text = "\n".join(src_lines[off + b["lines"]["start"] - 1 : off + b["lines"]["end"]])
        if b["kind"] == "equation":
            assert "$$" in text
        if b["kind"] == "section":
            assert text.strip() == f"## {b['title']}"
    assert ast["claims"] == [] and ast["figures"] == []


def test_paper_ast_missing_title():
    with pytest.raises(AstError):
        parse_paper_ast("## 摘要\n\n没有标题行\n")


def test_patent_mode_still_rejects_custom_section():
    with pytest.raises(AstError) as ei:
        parse_ast(CUSTOM_SECTION)
    assert "未知章节" in str(ei.value)


def test_patent_parse_unchanged_on_patent_content():
    from patent_studio.kernel.content import parse_md

    t, a, c, s = parse_md(PATENT_LIKE)
    assert t == "一种示例装置" and len(c) == 1 and ("h", "技术领域") in s


# ---------------- 内核：构建（DOCX 包结构断言） ----------------


def _docx_xml(out):
    with zipfile.ZipFile(out) as z:
        return z.read("word/document.xml"), [n for n in z.namelist() if n.startswith("word/media/")]


def test_paper_build_docx_structure(tmp_path):
    out = str(tmp_path / "out.docx")
    res = build_paper_ex(
        {"content_md": DEMO_MD, "out": out, "figs_dir": os.path.join(DEMO, "figs"), "sub_except": ()}
    )
    assert res.title == "基于注意力机制的示例模型在中英混合文本分类上的应用"
    assert res.abstract_chars > 40 and res.claims == 0 and res.paragraphs > 10
    doc, media = _docx_xml(out)
    text = doc.decode("utf-8")
    # 无专利段号 / CNIPA 页眉页脚标识
    assert "[0001]" not in text and "100004" not in text and "2023.03" not in text
    assert "说明书摘要" not in text and "权利要求书" not in text
    # 公式为 OMML 原生对象（Word 中可双击编辑），图片恰好嵌入一张
    assert b"<m:oMath" in doc and len(media) == 1
    # 中英正文 / 表格 / 图片题注 / 参考文献都落进 document.xml
    for frag in ("基于注意力机制的示例模型", "Abstract", "AdamW", "图1 两组方法", "[1] 张三"):
        assert frag in text


def test_paper_build_requires_title(tmp_path):
    bad = str(tmp_path / "bad.md")
    with open(bad, "w", encoding="utf-8") as f:
        f.write("## 摘要\n\n没有标题\n")
    with pytest.raises(ValueError) as ei:
        build_paper_ex({"content_md": bad, "out": str(tmp_path / "o.docx"), "figs_dir": tmp_path})
    assert "标题" in str(ei.value)


# ---------------- domain：settings / create / build_config ----------------


def _store(tmp_path):
    return ProjectStore(str(tmp_path))


def test_default_type_is_patent(tmp_path):
    store = _store(tmp_path)
    p = store.create("案甲", "一种示例装置")
    assert p.settings["document_type"] == "patent"
    assert "## 权利要求书" in store.read_content("案甲")
    cfg = store.build_config(p, out=str(tmp_path / "o.docx"))
    assert "abstract_figure" in cfg and "abstract_limit" in cfg


def test_create_paper_and_type_persists(tmp_path):
    store = _store(tmp_path)
    p = store.create("论文乙", "示例论文", document_type="paper")
    assert p.settings["document_type"] == "paper"
    assert "## 参考文献" in store.read_content("论文乙")
    # 保存内容 / 更新设置 / 重载后类型保持
    store.save_content("论文乙", PAPER_MD)
    store.update_settings("论文乙", {"abstract_limit": 200})
    p2 = store.get("论文乙")
    assert p2.settings["document_type"] == "paper"
    assert p2.settings["abstract_limit"] == 200
    cfg = store.build_config(p2, out=str(tmp_path / "o.docx"))
    assert set(cfg) == {"content_md", "out", "figs_dir", "sub_except"}  # paper 无专利附图/摘要约束


def test_unknown_type_rejected(tmp_path):
    store = _store(tmp_path)
    # 不依赖 ProjectError 类身份：其他测试文件的 client fixture 会 reload app.domain.projects，
    # 使本文件顶部导入的类对象过期（store 抛的是重载后的新类）。用 message + status 判定。
    with pytest.raises(Exception) as ei:
        store.create("案丙", "x", document_type="latex")
    assert "未知文档类型" in str(ei.value) and getattr(ei.value, "status", None) == 422
    with pytest.raises(Exception) as ei2:
        store.create("案丁", "x", document_type="Paper")  # 大小写敏感，明确报错
    assert getattr(ei2.value, "status", None) == 422
    p = store.create("案戊", "x")  # None / 空串 → patent
    assert p.settings["document_type"] == "patent"


def test_paper_collab_books_rejected(tmp_path):
    """paper 案拒绝三书协同房间（防 docset 装配污染全文）；content 房间是普通路径，不在此测。"""
    import asyncio

    from app.collab import rooms

    store = _store(tmp_path)
    store.create("论文己", "示例", document_type="paper")
    with pytest.raises(Exception) as ei:
        asyncio.run(rooms.get_or_create("论文己", "abstract", store))
    assert "paper 档案无三书" in str(ei.value) and getattr(ei.value, "status", None) == 400


# ---------------- API 全链 ----------------


@pytest.fixture()
def client(tmp_path, monkeypatch):
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setenv("PATENT_PROJECTS_DIR", str(projects))
    monkeypatch.setenv("LO_PROFILE_DIR", str(tmp_path / "lo"))
    import importlib

    from app import config, main
    from app.domain import build, xml_export
    from app.domain import projects as projects_mod

    importlib.reload(config)
    importlib.reload(projects_mod)
    importlib.reload(build)
    importlib.reload(xml_export)
    importlib.reload(main)
    return TestClient(main.app), projects


def test_api_paper_full_cycle(client):
    """创建 paper → 保存 fixture → 重载一致 → 构建 DOCX → 导出。"""
    c, projects = client
    r = c.post("/api/projects", json={"id": "paper-e2e", "title": "示例论文", "document_type": "paper"})
    assert r.status_code == 201, r.text
    assert r.json()["settings"]["document_type"] == "paper"
    # fixture 图片覆盖占位图，构建嵌真实合成图
    shutil.copyfile(os.path.join(DEMO, "figs", "fig1.png"), projects / "paper-e2e" / "figs" / "fig1.png")
    r = c.put("/api/projects/paper-e2e/content", json={"content": PAPER_MD})
    assert r.status_code == 200
    # 重载一致：content 与 document_type 都不丢
    got = c.get("/api/projects/paper-e2e").json()
    assert got["content"] == PAPER_MD
    assert got["settings"]["document_type"] == "paper"
    assert got["title"] == "基于注意力机制的示例模型在中英混合文本分类上的应用"
    # AST / lint / preflight 的 paper 分支
    ast = c.get("/api/projects/paper-e2e/ast").json()
    assert ast["profile"] == "paper" and "摘要" in [b["title"] for b in ast["description"] if b["kind"] == "section"]
    lint = c.post("/api/projects/paper-e2e/lint", json={}).json()
    assert lint["diagnostics"] == [] and lint["counts"]["error"] == 0
    pf = c.get("/api/projects/paper-e2e/preflight").json()
    assert pf["items"] == []
    # 构建（不依赖 LibreOffice）：ok + 摘要字数来自「摘要」章
    r = c.post("/api/projects/paper-e2e/build", json={"pdf": False})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "ok", body.get("error")
    assert body["summary"]["claims"] == 0 and body["summary"]["abstract_chars"] > 40
    # 产物 + 导出（文件名前缀 论文-，标题取自 content.md 的 `# ` 行；非 ASCII 走 RFC5987 编码）
    docx = c.get(body["docx_url"])
    assert docx.status_code == 200 and docx.content[:2] == b"PK"
    exp = c.get("/api/projects/paper-e2e/export?fmt=docx")
    assert exp.status_code == 200
    cd = urllib.parse.unquote(exp.headers["content-disposition"])
    assert "论文-基于注意力机制的示例模型" in cd and cd.endswith(".docx")


def test_api_patent_project_rejects_custom_section_ast(client):
    c, _ = client
    c.post("/api/projects", json={"id": "pat-e2e", "title": "专利案"})
    r = c.post("/api/projects/pat-e2e/ast", json={"content": CUSTOM_SECTION})
    assert r.status_code == 422 and r.json()["detail"]["kind"] == "content"


def test_api_create_unknown_document_type_422(client):
    c, _ = client
    r = c.post("/api/projects", json={"id": "bad-type", "title": "x", "document_type": "latex"})
    assert r.status_code == 422 and "未知文档类型" in r.json()["detail"]


def test_api_put_settings_unknown_type_422(client):
    c, _ = client
    c.post("/api/projects", json={"id": "set-type", "title": "x"})
    r = c.put("/api/projects/set-type/settings", json={"document_type": "docbook"})
    assert r.status_code == 422 and "未知文档类型" in r.text


def test_api_paper_markup_mode_rejected(client):
    c, projects = client
    c.post("/api/projects", json={"id": "paper-mk", "title": "示例", "document_type": "paper"})
    shutil.copyfile(os.path.join(DEMO, "figs", "fig1.png"), projects / "paper-mk" / "figs" / "fig1.png")
    c.put("/api/projects/paper-mk/content", json={"content": PAPER_MD})
    r = c.post("/api/projects/paper-mk/build", json={"pdf": False, "mode": "markup"})
    assert r.status_code == 200 and r.json()["status"] == "error"
    assert "markup" in r.json()["error"]["message"]


def test_api_paper_build_pdf_requires_libreoffice(client):
    """want_pdf 时走既有 lo.py 链路：无 LibreOffice 的机器得到可读错误而不是假成功。
    有 soffice 的机器（CI/容器）应得到 ok + pdf_url。"""
    c, projects = client
    c.post("/api/projects", json={"id": "paper-pdf", "title": "示例", "document_type": "paper"})
    shutil.copyfile(os.path.join(DEMO, "figs", "fig1.png"), projects / "paper-pdf" / "figs" / "fig1.png")
    c.put("/api/projects/paper-pdf/content", json={"content": PAPER_MD})
    r = c.post("/api/projects/paper-pdf/build", json={"pdf": True})
    body = r.json()
    if shutil.which("soffice"):
        assert body["status"] == "ok" and body["pdf_url"]
    else:
        assert body["status"] == "error" and body["pdf_url"] is None
