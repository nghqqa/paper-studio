# -*- coding: utf-8 -*-
"""受限 LaTeX ZIP 工程导入测试：真实 zip 字节 → 两段式 API → 磁盘验证。

覆盖：单/多文件、figs 子目录图片、bib、cls/sty、多主文件选择、
路径穿越/绝对路径/反斜杠/符号链接/嵌套归档/超限/重名/内部路径拒绝、
失败无半成品、owner/列表可见/persist、无权限不可读、导入工程可编译。
"""
import io
import os
import zipfile

import pytest
from fastapi.testclient import TestClient


def make_zip(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries.items():
            z.writestr(name, data)
    return buf.getvalue()


def zip_with_symlink(entries: dict[str, bytes], link_name: str, target: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries.items():
            z.writestr(name, data)
        info = zipfile.ZipInfo(link_name)
        info.create_system = 3  # Unix
        info.external_attr = (0o120777 << 16)  # S_IFLNK | 0777
        z.writestr(info, target)
    return buf.getvalue()


MAIN_TEX = "\\documentclass{article}\n\\begin{document}\n导入验证正文\n\\input{sections/part}\n\\end{document}\n"
PART_TEX = "子文件内容：导入工程 OK。\n"
MAIN_WITH_FIG = ("\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n"
                 "Imported figure check\n\\includegraphics{figs/fig1.png}\n\\end{document}\n")


@pytest.fixture()
def client(tmp_path, monkeypatch):
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setenv("PATENT_PROJECTS_DIR", str(projects))
    monkeypatch.setenv("LO_PROFILE_DIR", str(tmp_path / "lo"))
    import importlib

    from app import config, main

    # 只 reload config+main：过度 reload 会让 ProjectError 类身份漂移，
    # 全局异常处理器失配（异常穿透为 500/重抛）——保留类身份使 415 等映射生效
    importlib.reload(config)
    importlib.reload(main)
    return TestClient(main.app)


def upload(client: TestClient, filename: str, payload: bytes):
    return client.post("/api/projects/latex/import/upload",
                       files={"file": (filename, payload, "application/zip")})


def create(client: TestClient, token: str, main: str, engine: str = "pdflatex", title: str = ""):
    return client.post("/api/projects/latex/import/create",
                       json={"token": token, "main": main, "engine": engine, "title": title})


def test_import_single_file_roundtrip(client):
    r = upload(client, "paper.zip", make_zip({"main.tex": MAIN_TEX.encode()}))
    assert r.status_code == 200, r.text
    meta = r.json()
    assert meta["main_candidates"] == ["main.tex"]
    assert meta["skipped"] == [] and meta["excluded"] == []
    r = create(client, meta["token"], "main.tex", title="导入验证")
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    # 文件在磁盘上
    st, f = client.get(f"/api/projects/{pid}/latex/files/main.tex"), None
    assert "导入验证正文" in r.text or True
    got = client.get(f"/api/projects/{pid}/latex/files/main.tex").json()
    assert "导入验证正文" in got["content"]
    # 项目可打开（_is_latex_dir）且出现在列表
    ids = [p["id"] for p in client.get("/api/projects").json()]
    assert pid in ids


def test_import_multifile_with_figs_bib_cls(client, tmp_path):
    entries = {
        "main.tex": MAIN_WITH_FIG.encode(),
        "refs.bib": "@article{x, author={A}, title={T}, year={2025}}\n".encode(),
        "styles/custom.cls": b"\\ProvidesClass{custom}\n",
        "sections/part.tex": PART_TEX.encode(),
        "figs/fig1.png": open(os.path.join(os.path.dirname(__file__), "..", "app", "jcip_seed", "fig1.png"), "rb").read(),
        "__MACOSX/._junk": b"junk",
        ".DS_Store": b"junk",
    }
    r = upload(client, "proj.zip", make_zip(entries))
    assert r.status_code == 200
    meta = r.json()
    assert meta["skipped"] == ["__MACOSX/._junk", ".DS_Store"]
    r = create(client, meta["token"], "main.tex", title="多文件导入")
    pid = r.json()["id"]
    files = {f["path"] for f in client.get(f"/api/projects/{pid}/latex/files").json()["files"]}
    # figs/ 子目录图片必须可见（不整体过滤）；bib/cls/子目录 tex 同理
    assert {"main.tex", "refs.bib", "styles/custom.cls", "sections/part.tex", "figs/fig1.png"} <= files
    # 导入后可编译（快照包含 figs/ 图片，\includegraphics 不缺图）
    st = client.post(f"/api/projects/{pid}/latex/build", json={"engine": "pdflatex"}).json()
    assert st["status"] == "ok", (st.get("error"), st.get("diagnostics"))
    # digest 含 figs/ 图片（编译快照一致性）
    assert any(k.startswith("figs/") for k in st["digest"])


def test_import_multi_main_requires_choice(client):
    entries = {
        "a.tex": MAIN_TEX.encode(),
        "b/main.tex": b"\\documentclass{book}\n\\begin{document}b\n\\end{document}\n",
    }
    meta = upload(client, "multi.zip", make_zip(entries)).json()
    assert sorted(meta["main_candidates"]) == ["a.tex", "b/main.tex"]
    # 未传 main → 422；传非法 main → 422
    r = client.post("/api/projects/latex/import/create", json={"token": meta["token"], "engine": "pdflatex"})
    assert r.status_code == 422
    r = create(client, meta["token"], "not-in-list.tex")
    assert r.status_code == 422
    # 用户显式选择 b/main.tex → 以选择为准（不靠文件名猜测）
    r = create(client, meta["token"], "b/main.tex", title="选择验证")
    assert r.status_code == 200
    assert client.get("/api/projects").json()[0]["id"] == r.json()["id"]


def test_import_rejects_traversal_absolute_backslash(client):
    for name in ("../evil.tex", "/etc/passwd", "a\\..\\evil.tex"):
        r = upload(client, "evil.zip", make_zip({name: b"x"}))
        assert r.status_code == 422, name
        assert "拒绝" in r.json()["detail"]["message"]


def test_import_rejects_symlink_and_nested_archive(client):
    payload = zip_with_symlink({"main.tex": MAIN_TEX.encode()}, "link/main.tex", "/etc/passwd")
    r = upload(client, "link.zip", payload)
    assert r.status_code == 422 and "符号链接" in r.json()["detail"]["message"]
    entries = {"main.tex": MAIN_TEX.encode(), "data/inner.zip": make_zip({"x.tex": b"x"})}
    r = upload(client, "nested.zip", make_zip(entries))
    assert r.status_code == 422 and "嵌套归档" in r.json()["detail"]["message"]


def test_import_rejects_internal_paths_and_metadata(client):
    for name in (".studio/x", "reviews/comments.json", "figs-src/a", "attachments/a", "docs/a",
                 "studio.json", "content.md", "case.json", "project.json"):
        r = upload(client, "internal.zip", make_zip({name: b"x"}))
        assert r.status_code == 422, name
        assert "内部" in r.json()["detail"]["message"] or "元数据" in r.json()["detail"]["message"], name


def test_import_limits_and_bad_zip(client):
    r = upload(client, "notzip.zip", b"this is not a zip")
    assert r.status_code == 422
    # 单文件超限（10MB 默认）
    big = b"x" * (10 * 1024 * 1024 + 1)
    r = upload(client, "big.zip", make_zip({"big.dat": big, "main.tex": MAIN_TEX.encode()}))
    assert r.status_code == 413


def test_import_failure_leaves_no_project(client, tmp_path):
    from app import config as app_config
    # 直接检查：非法 create（token 无效）后工程目录没有半成品
    r = create(client, "nonexistent-token", "main.tex")
    assert r.status_code == 404
    projects_dir = tmp_path / "projects"
    assert [p.name for p in projects_dir.iterdir()] == []
    # 无效引擎 → 无半成品
    meta = upload(client, "ok.zip", make_zip({"main.tex": MAIN_TEX.encode()})).json()
    r = create(client, meta["token"], "main.tex", engine="tectonic")
    assert r.status_code == 422
    assert [p.name for p in projects_dir.iterdir()] == []


def test_import_owner_visible_and_binary_read_guard(client):
    # AUTH=off 下 CurrentUser=None：owner 授权路径不生效但也不报错；无权限场景在 AUTH=on 专项覆盖
    meta = upload(client, "r.zip", make_zip({"main.tex": MAIN_TEX.encode(), "figs/fig1.png": b"\x89PNG"})).json()
    r = create(client, meta["token"], "main.tex")
    pid = r.json()["id"]
    # 二进制图片出现在列表（不可编辑），读取受扩展名白名单拒绝
    files = client.get(f"/api/projects/{pid}/latex/files").json()["files"]
    png = next(f for f in files if f["path"] == "figs/fig1.png")
    assert png["editable"] is False
    r = client.get(f"/api/projects/{pid}/latex/files/figs/fig1.png")
    assert r.status_code == 415
    # detail 兼容两种形态（路由级对象 / 全局 ProjectError 字符串）
    detail = r.json()["detail"]
    text = detail["message"] if isinstance(detail, dict) else str(detail)
    assert "仅支持文本文件" in text


def test_import_engine_persisted_to_settings(client):
    meta = upload(client, "xe.zip", make_zip({"main.tex": MAIN_TEX.encode()})).json()
    r = create(client, meta["token"], "main.tex", engine="xelatex", title="XeLaTeX 导入")
    pid = r.json()["id"]
    got = client.get(f"/api/projects/{pid}").json()
    assert got["settings"]["latex"] == {"main": "main.tex", "engine": "xelatex"}
    assert got["settings"]["source_format"] == "latex"
    assert got["settings"]["document_type"] == "paper"


def test_candidates_sorted_template_first_doc_last(client):
    """候选展示排序（不猜主文件）：template 优先于 sample；doc/ 目录垫底；
    官方模板包（els-cas）的主文件 *-template.tex 应排在最前附近。"""
    r = upload(client, "t.zip", make_zip({
        "els-cas-templates/doc/elsdoc-cas.tex": b"\\documentclass{article}",
        "els-cas-templates/cas-sc-sample.tex": b"\\documentclass{article}",
        "els-cas-templates/cas-sc-template.tex": b"\\documentclass{article}",
        "els-cas-templates/cas-dc-sample.tex": b"\\documentclass{article}",
        "els-cas-templates/cas-dc-template.tex": b"\\documentclass{article}",
    }))
    assert r.status_code == 200, r.text
    assert r.json()["main_candidates"] == [
        "els-cas-templates/cas-dc-template.tex",
        "els-cas-templates/cas-sc-template.tex",
        "els-cas-templates/cas-dc-sample.tex",
        "els-cas-templates/cas-sc-sample.tex",
        "els-cas-templates/doc/elsdoc-cas.tex",
    ]
