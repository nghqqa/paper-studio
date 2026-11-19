# -*- coding: utf-8 -*-
"""P1-0-B Word 引用编号重排：OOXML 引擎单测 + 真实 HTTP/ACL 路由测试。

引擎测试直接构造 document.xml 的段落/表格/修订结构（跨 Run 括号、托管块、w:ins/w:del），
验证确定性重写与全部 fail-closed 分支；路由测试沿用 test_word_editor 的模块级 app 矩阵
（AUTH on、DS 网络在其边界外），覆盖权限/并发 sha/幂等/顺序表同步。"""

import importlib
import io
import os
import sys
import zipfile
from xml.etree import ElementTree

import pytest
from docx import Document
from fastapi.testclient import TestClient

from app.domain import word_citations as wc
from app.errors import ProjectError

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def _q(tag):
    return f"{{{W_NS}}}{tag}"


# ---------------------------------------------------------------- 构造辅助 ----


def _run(text, rpr_xml=None):
    r = ElementTree.Element(_q("r"))
    if rpr_xml:
        r.append(ElementTree.fromstring(rpr_xml))
    t = ElementTree.SubElement(r, _q("t"))
    t.text = text
    if text != text.strip():
        t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    return r


def _para(runs):
    """runs: str（单 run）| [str | Element]（Element → 直接挂载，用于修订/上标 run）。"""
    if isinstance(runs, str):
        runs = [runs]
    p = ElementTree.Element(_q("p"))
    for item in runs:
        p.append(_run(item) if isinstance(item, str) else item)
    return p


def _ins(*runs):
    el = ElementTree.Element(_q("ins"))
    for item in runs:
        el.append(_run(item) if isinstance(item, str) else item)
    return el


def _del(*texts):
    el = ElementTree.Element(_q("del"))
    for text in texts:
        r = ElementTree.SubElement(el, _q("r"))
        t = ElementTree.SubElement(r, _q("delText"))
        t.text = text
    return el


def _rpr(inner):
    return ElementTree.fromstring(f'<w:rPr xmlns:w="{W_NS}">{inner}</w:rPr>')


def _table_cell(*paragraphs):
    tc = ElementTree.Element(_q("tc"))
    for p in paragraphs:
        tc.append(p)
    return tc


def _table_row(*cells):
    tr = ElementTree.Element(_q("tr"))
    for c in cells:
        tr.append(c)
    return tr


def _table(*rows):
    tbl = ElementTree.Element(_q("tbl"))
    for r in rows:
        tbl.append(r)
    return tbl


def _docx_bytes(paragraphs):
    """python-docx 空文档骨架 + 自定义 body 段落 → 合法 DOCX 字节。"""
    buf = io.BytesIO()
    Document().save(buf)
    data = buf.getvalue()
    return _replace_body(data, paragraphs)


def _replace_body(data, paragraphs):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        infos = z.infolist()
        contents = {i.filename: z.read(i.filename) for i in infos}
    raw = contents["word/document.xml"]
    for _, (prefix, uri) in ElementTree.iterparse(io.BytesIO(raw), events=("start-ns",)):
        try:
            ElementTree.register_namespace(prefix, uri)
        except ValueError:
            pass
    root = ElementTree.fromstring(raw)
    body = root.find(_q("body"))
    for child in list(body):
        body.remove(child)
    for p in paragraphs:
        body.append(p)
    contents["word/document.xml"] = ElementTree.tostring(root, encoding="UTF-8", xml_declaration=True)
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for info in infos:
            zi = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            zi.compress_type = info.compress_type
            zi.external_attr = info.external_attr
            z.writestr(zi, contents[info.filename])
    return out.getvalue()


def _texts(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        root = ElementTree.fromstring(z.read("word/document.xml"))
    return ["".join(t.text or "" for t in p.iter(_q("t"))) for p in root.iter(_q("p"))]


def _entry(rid, title, surname="张三", year="2023"):
    from app.domain.library import LibraryEntry

    return LibraryEntry(reference_id=rid, citation_key=rid, entry_type="article", title=title,
                        authors=[surname], year=year, venue="计算机学报")


def _lib(*rids):
    return {rid: _entry(rid, f"文献{rid}") for rid in rids}


HEAD = wc.HEAD_MARKER
TAIL = wc.TAIL_MARKER


# ---------------------------------------------------------------- 引擎：正文重排 ----


def test_cross_run_range_and_split_brackets_renumber():
    data = _docx_bytes([
        _para(["正文引用[", "3-5", "]与[", "1, 2", "]同段。"]),
        _para(["另一处[3]。"]),
    ])
    result = wc.renumber_docx(data, citation_order=["a", "b", "c", "d", "e"], entries=_lib("a", "b", "c", "d", "e"))
    assert result["changed_doc"] is True
    assert result["mapping"] == {"3": "1", "4": "2", "5": "3", "1": "4", "2": "5"}
    assert result["order"] == ["c", "d", "e", "a", "b"]
    texts = _texts(result["data"])
    # [3-5]→新 [1-3]（3 连号压缩）；[1,2]→[4,5]（2 连号不压缩）；跨 Run 碎片合并到首个 w:t
    assert texts[0] == "正文引用[1-3]与[4,5]同段。"
    assert texts[1] == "另一处[1]。"


def test_first_occurrence_inversion_fixed():
    data = _docx_bytes([_para("先[3]后[1]。")])
    result = wc.renumber_docx(data, citation_order=["a", "b", "c"], entries=_lib("a", "b", "c"))
    assert result["mapping"] == {"3": "1", "1": "2"}
    assert _texts(result["data"])[0] == "先[1]后[2]。"


def test_table_cell_scanned_in_document_order():
    data = _docx_bytes([
        _para("正文[2]先出现"),
        _table(_table_row(_table_cell(_para("表内[1]后出现")))),
    ])
    result = wc.renumber_docx(data, citation_order=["a", "b"], entries=_lib("a", "b"))
    assert _texts(result["data"]) == ["正文[1]先出现", "表内[2]后出现"]


def test_year_and_text_brackets_untouched():
    data = _docx_bytes([_para("年份[2020-2024]与[2020]及[1, 甲]文字标签保持。")])
    result = wc.renumber_docx(data, citation_order=["a", "b", "c"], entries=_lib("a", "b", "c"))
    assert result["changed_doc"] is False
    assert result["data"] == data
    assert _texts(result["data"])[0] == "年份[2020-2024]与[2020]及[1, 甲]文字标签保持。"


def test_superscript_style_preserved_and_first_run_wins():
    rpr = f'<w:rPr xmlns:w="{W_NS}"><w:vertAlign w:val="superscript"/></w:rPr>'
    sup = _run("[", rpr)
    data = _docx_bytes([_para(["前缀", sup, "1", "]", "尾文"])])
    result = wc.renumber_docx(data, citation_order=["a", "b"], entries=_lib("a", "b"))
    assert _texts(result["data"])[0] == "前缀[1]尾文"
    # 上标 rPr 保留在承载新文本的首 run 上
    with zipfile.ZipFile(io.BytesIO(result["data"])) as z:
        root = ElementTree.fromstring(z.read("word/document.xml"))
    runs = list(root.iter(_q("r")))
    assert any(r.find(_q("rPr")) is not None and r.find(_q("rPr")).find(_q("vertAlign")) is not None
               for r in runs)


def test_no_citations_idempotent():
    data = _docx_bytes([_para("没有引用的正文。")])
    result = wc.renumber_docx(data, citation_order=["a"], entries=_lib("a"))
    assert result["changed_doc"] is False and result["data"] == data and result["mapping"] == {}


def test_stale_number_fail_closed_422():
    data = _docx_bytes([_para("正文[5]越界。")])
    with pytest.raises(ProjectError) as ei:
        wc.renumber_docx(data, citation_order=["a", "b"], entries=_lib("a", "b"))
    assert ei.value.status == 422
    assert "[5]" in str(ei.value)


def test_empty_library_with_citations_fail_closed_422():
    data = _docx_bytes([_para("正文[1]。")])
    with pytest.raises(ProjectError) as ei:
        wc.renumber_docx(data, citation_order=[], entries={})
    assert ei.value.status == 422


def test_del_inside_bracket_breaks_token_not_rewritten():
    # "[1" + 已删除片段 + "2]"：删除区以占位符断开 → 不是合法编号引用，原样保留
    data = _docx_bytes([_para(["引用[", "1", _del("已删除"), "2]", "。"])])
    result = wc.renumber_docx(data, citation_order=["a", "b", "c", "d"], entries=_lib("a", "b", "c", "d"))
    assert result["changed_doc"] is False


def test_ins_del_revision_boundary_fail_closed_409():
    # 括号跨越非修订 run 与 w:ins run：拒绝重写
    data = _docx_bytes([_para(["引用[", "1", _ins(", 2"), "]", "。"])])
    with pytest.raises(ProjectError) as ei:
        wc.renumber_docx(data, citation_order=["a", "b"], entries=_lib("a", "b"))
    assert ei.value.status == 409
    assert "修订" in str(ei.value)
    # 括号整体位于单个 w:ins 内：可无损重写
    data2 = _docx_bytes([_para(["前", _ins("[2", "]", "。")])])
    result = wc.renumber_docx(data2, citation_order=["a", "b"], entries=_lib("a", "b"))
    assert result["changed_doc"] is True
    assert _texts(result["data"])[0] == "前[1]。"


# ---------------------------------------------------------------- 引擎：托管块 ----


def _block_paras(entry_texts, body_before=None):
    paras = list(body_before or [])
    paras.append(_para(HEAD))
    paras.extend(_para(t) for t in entry_texts)
    paras.append(_para(TAIL))
    return paras


def test_managed_block_rebuilt_with_uncited_append():
    data = _docx_bytes(_block_paras(
        ["[1] 文献甲条目文本", "[2] 文献乙条目文本", "[3] 文献丙条目文本", "[4] 文献丁条目文本"],
        body_before=[_para("引言[3]。"), _para("结论[1]。")]))
    result = wc.renumber_docx(data, citation_order=["a", "b", "c", "d"],
                              entries=_lib("a", "b", "c", "d"))
    assert result["changed_doc"] is True and result["rebuilt_block"] is True
    assert result["order"] == ["c", "a", "b", "d"]  # 已引用按出现序在前，未引用 b/d 保持原相对序追加
    texts = _texts(result["data"])
    assert texts[0] == "引言[1]。" and texts[1] == "结论[2]。"
    assert texts[2] == HEAD
    # 条目区按新顺序重建为 GB/T 7714 渲染文本，编号 = 新顺序表位置
    assert texts[3].startswith("[1] 张三. 文献c")
    assert texts[4].startswith("[2] 张三. 文献a")
    assert texts[5].startswith("[3] 张三. 文献b")
    assert texts[6].startswith("[4] 张三. 文献d")
    assert texts[7] == TAIL


def test_managed_block_entry_format_inherited():
    # 首条目段落带 pPr（缩进）+ 加粗 run：重建条目沿用其段落/run 格式
    entry = ElementTree.Element(_q("p"))
    ppr = ElementTree.SubElement(entry, _q("pPr"))
    ElementTree.SubElement(ppr, _q("ind")).set(_q("firstLine"), "420")
    r = ElementTree.SubElement(entry, _q("r"))
    r.append(_rpr("<w:b/>"))
    t = ElementTree.SubElement(r, _q("t"))
    t.text = "[1] 原条目文本"
    data = _docx_bytes([_para("正文[1]。"), _para(HEAD), entry, _para(TAIL)])
    result = wc.renumber_docx(data, citation_order=["a", "b"], entries=_lib("a", "b"))
    with zipfile.ZipFile(io.BytesIO(result["data"])) as z:
        root = ElementTree.fromstring(z.read("word/document.xml"))
    paras = list(root.iter(_q("p")))
    rebuilt = paras[2]  # 头标记段之后第一条
    assert rebuilt.find(_q("pPr")).find(_q("ind")) is not None
    run = rebuilt.find(_q("r"))
    assert run.find(_q("rPr")).find(_q("b")) is not None
    assert "".join(t.text or "" for t in rebuilt.iter(_q("t"))).startswith("[1] 张三. 文献a")


def test_managed_block_missing_tail_fail_closed_409():
    data = _docx_bytes([_para("正文[1]。"), _para(HEAD), _para("[1] 孤立托管条目")])
    with pytest.raises(ProjectError) as ei:
        wc.renumber_docx(data, citation_order=["a"], entries=_lib("a"))
    assert ei.value.status == 409
    assert "尾标记" in str(ei.value)


def test_managed_block_duplicate_and_inverted_and_orphan_fail_closed():
    dup = _docx_bytes([_para(HEAD), _para("[1] x"), _para(HEAD), _para("[2] x"), _para(TAIL)])
    with pytest.raises(ProjectError) as ei:
        wc.renumber_docx(dup, citation_order=["a", "b"], entries=_lib("a", "b"))
    assert ei.value.status == 409 and "重复" in str(ei.value)
    inverted = _docx_bytes([_para(TAIL), _para("[1] x"), _para(HEAD)])
    with pytest.raises(ProjectError) as ei:
        wc.renumber_docx(inverted, citation_order=["a"], entries=_lib("a"))
    assert ei.value.status == 409
    orphan = _docx_bytes([_para("正文"), _para(TAIL), _para("更多")])
    with pytest.raises(ProjectError) as ei:
        wc.renumber_docx(orphan, citation_order=["a"], entries=_lib("a"))
    assert ei.value.status == 409


def test_managed_block_markers_in_table_fail_closed():
    data = _docx_bytes([_table(_table_row(_table_cell(_para(HEAD), _para("[1] x"), _para(TAIL))))])
    with pytest.raises(ProjectError) as ei:
        wc.renumber_docx(data, citation_order=["a"], entries=_lib("a"))
    assert ei.value.status == 409


def test_managed_block_interior_sectpr_fail_closed():
    entry = _para("[1] x")
    ppr = ElementTree.Element(_q("pPr"))
    ElementTree.SubElement(ppr, _q("sectPr"))
    entry.insert(0, ppr)
    data = _docx_bytes([_para(HEAD), entry, _para(TAIL)])
    with pytest.raises(ProjectError) as ei:
        wc.renumber_docx(data, citation_order=["a"], entries=_lib("a"))
    assert ei.value.status == 409 and "分节符" in str(ei.value)


def test_managed_block_empty_library_with_entries_fail_closed_422():
    data = _docx_bytes(_block_paras(["[1] 孤条目"]))
    with pytest.raises(ProjectError) as ei:
        wc.renumber_docx(data, citation_order=[], entries={})
    assert ei.value.status == 422


def test_no_block_stops_at_references_heading():
    data = _docx_bytes([
        _para("正文[2]。"),
        _para("参考文献"),
        _para("[1] 表区条目一 [2] 表区条目二"),  # 标题后不参与正文编号扫描
    ])
    result = wc.renumber_docx(data, citation_order=["a", "b"], entries=_lib("a", "b"))
    assert result["mapping"] == {"2": "1"}
    texts = _texts(result["data"])
    assert texts[0] == "正文[1]。"
    assert texts[2] == "[1] 表区条目一 [2] 表区条目二"  # 文献表区原样
    assert any("标题段" in w for w in result["warnings"])


def test_citations_after_tail_block_scanned():
    paras = _block_paras(["[1] 文献一", "[2] 文献二"], body_before=[_para("正文[2]。")])
    data = _docx_bytes(paras + [_para("附录[1]。")])
    result = wc.renumber_docx(data, citation_order=["a", "b"], entries=_lib("a", "b"))
    assert result["mapping"] == {"2": "1", "1": "2"}
    assert _texts(result["data"])[-1] == "附录[2]。"  # 块后附录正文仍参与编号


def test_full_idempotent_with_managed_block():
    # 条目已是渲染器输出且编号已按出现序：零字节变化（重建等价），不做版本落盘
    from app.domain import gbt7714

    ents = _lib("a", "b")
    data = _docx_bytes(_block_paras(
        [gbt7714.format_gbt7714_entry(ents["a"], 1), gbt7714.format_gbt7714_entry(ents["b"], 2)],
        body_before=[_para("正文[1]。")]))
    result = wc.renumber_docx(data, citation_order=["a", "b"], entries=ents)
    assert result["changed_doc"] is False
    assert result["data"] == data
    assert result["warnings"] == []


def test_already_ordered_noncanonical_xml_skips_reserialize():
    # 模拟真实 Word/ONLYOFFICE XML（属性单引号/附加空间）：编号与托管块已一致时不重写 XML、zero diff
    from app.domain import gbt7714

    ents = _lib("a", "b")
    base = _docx_bytes(_block_paras(
        [gbt7714.format_gbt7714_entry(ents["a"], 1), gbt7714.format_gbt7714_entry(ents["b"], 2)],
        body_before=[_para("引言[1]；方法[2]。")]))
    with zipfile.ZipFile(io.BytesIO(base)) as z:
        contents = {i.filename: z.read(i.filename) for i in z.infolist()}
        infos = z.infolist()
    contents["word/document.xml"] = contents["word/document.xml"].replace(b'"', b"'")
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for info in infos:
            z.writestr(info, contents[info.filename])
    noncanonical = out.getvalue()
    result = wc.renumber_docx(noncanonical, citation_order=["a", "b"], entries=ents)
    assert result["changed_doc"] is False
    assert result["rebuilt_block"] is False
    assert result["data"] == noncanonical


# ---------------------------------------------------------------- 路由（真实 HTTP/ACL）----


@pytest.fixture(scope="module")
def matrix(tmp_path_factory):
    base = tmp_path_factory.mktemp("word-cite")
    projects = base / "projects"
    projects.mkdir()
    env = {"PATENT_STUDIO_AUTH": "on", "PATENT_STUDIO_SECRET": "cite-tests-auth-secret-at-least-32-bytes",
           "PATENT_PROJECTS_DIR": str(projects),
           "PATENT_STUDIO_LEGACY_DATABASE_URL": f"sqlite:///{base}/studio.db",
           "PATENT_STUDIO_WORD_EDITOR": "on", "PATENT_STUDIO_ONLYOFFICE_JWT_SECRET": "cite-test-secret",
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
            email = name + "@cite.example.com"
            r = c.post("/api/auth/register", json={"email": email, "password": "Cite-test-pw!",
                                                   "display_name": name})
            assert r.status_code == 201, r.text
            r = c.post("/api/auth/cookie/login", data={"username": email, "password": "Cite-test-pw!"})
            assert r.status_code == 204, r.text
            return c

        register("bootstrap")
        users = {k: register(k) for k in ("owner", "editor", "reviewer", "viewer")}
        owner = users["owner"]
        r = owner.post("/api/projects/word/create", json={"title": "引用重排", "template": "blank"})
        assert r.status_code == 200, r.text
        pid = r.json()["id"]
        for name in ("editor", "reviewer", "viewer"):
            r = owner.put(f"/api/projects/{pid}/members", json={"email": name + "@cite.example.com", "role": name})
            assert r.status_code == 200, r.text
        yield {"app": app, "users": users, "pid": pid, "projects": projects}
    finally:
        for k, v in previous.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _setup_cited_project(matrix, body_paras, rids):
    """上传带引用的 DOCX 并写入文献库事实源；返回 pid。"""
    from app.domain import library as library_domain
    from app.domain.library import LibraryIndex

    owner = matrix["users"]["owner"]
    r = owner.post("/api/projects/word/create", json={"title": "引用重排稿", "template": "blank"})
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    for name in ("editor", "reviewer", "viewer"):
        r = owner.put(f"/api/projects/{pid}/members", json={"email": name + "@cite.example.com", "role": name})
        assert r.status_code == 200, r.text
    data = _docx_bytes(body_paras)
    r = owner.post(f"/api/projects/{pid}/word/upload-version",
                   files={"file": ("稿.docx", data, "application/vnd.openxmlformats-officedocument"
                                               ".wordprocessingml.document")})
    assert r.status_code == 200, r.text
    project_dir = str(matrix["projects"] / pid)
    library_domain.save_index(project_dir, LibraryIndex(
        mode="index", entries=[_entry(rid, f"文献{rid}") for rid in rids], citation_order=list(rids)))
    return pid


def test_route_acl_and_full_flow(matrix):
    owner, editor = matrix["users"]["owner"], matrix["users"]["editor"]
    pid = _setup_cited_project(matrix, [_para("正文[2]。"), _para("结尾[1]。")], ["a", "b"])
    url = f"/api/projects/{pid}/word/renumber-citations"
    assert matrix["users"]["viewer"].post(url, json={}).status_code == 403
    assert matrix["users"]["reviewer"].post(url, json={}).status_code == 403
    r = editor.post(url, json={})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["changed"] is True
    assert body["mapping"] == {"2": "1", "1": "2"}
    assert body["order"] == ["b", "a"]
    assert body["state"]["version"] == 3  # create=1 → upload-version=2 → renumber=3
    old_key = body["doc_key"]
    assert old_key
    # citation_order 已同步（引用序在前）
    from app.domain import library as library_domain

    index = library_domain.load_index(str(matrix["projects"] / pid))
    assert index.citation_order == ["b", "a"]
    # 文档正文已重排
    from app.domain import word_documents as wd

    with open(wd.document_path(str(matrix["projects"] / pid)), "rb") as f:
        assert _texts(f.read())[0] == "正文[1]。"
    # 幂等：重放无变化，不新增版本、不轮换会话键
    sha = body["state"]["sha"]
    r = editor.post(url, json={"expected_sha": sha})
    assert r.status_code == 200, r.text
    body2 = r.json()
    assert body2["changed"] is False
    assert body2["state"]["version"] == 3
    assert body2["doc_key"] == old_key
    # 并发 sha 冲突 409
    r = owner.post(url, json={"expected_sha": "stale-sha"})
    assert r.status_code == 409
    # 非法样式 422
    assert owner.post(url, json={"style": "apa"}).status_code == 422
    # 空请求体（无 body）等同默认参数
    r = owner.post(url)
    assert r.status_code == 200 and r.json()["changed"] is False


def test_route_saving_conflict_409(matrix):
    import json as _json

    pid = _setup_cited_project(matrix, [_para("正文[2]。"), _para("结尾[1]。")], ["a", "b"])
    state_path = matrix["projects"] / pid / ".studio" / "word" / "state.json"
    state = _json.loads(state_path.read_text(encoding="utf-8"))
    state["saving"] = True
    state_path.write_text(_json.dumps(state), encoding="utf-8")
    r = matrix["users"]["owner"].post(f"/api/projects/{pid}/word/renumber-citations", json={})
    assert r.status_code == 409
    assert "回传保存" in r.json()["detail"]


def test_route_managed_block_rebuild_and_sync(matrix):
    owner = matrix["users"]["owner"]
    paras = _block_paras(["[1] 文献甲", "[2] 文献乙", "[3] 文献丙", "[4] 文献丁"],
                         body_before=[_para("引言[3]。"), _para("结论[1]。")])
    pid = _setup_cited_project(matrix, paras, ["a", "b", "c", "d"])
    r = owner.post(f"/api/projects/{pid}/word/renumber-citations", json={})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["changed"] is True and body["rebuilt_block"] is True
    assert body["order"] == ["c", "a", "b", "d"]
    from app.domain import word_documents as wd

    with open(wd.document_path(str(matrix["projects"] / pid)), "rb") as f:
        texts = _texts(f.read())
    assert texts[0] == "引言[1]。"
    assert texts[3].startswith("[1] 张三. 文献c")
    assert texts[6].startswith("[4] 张三. 文献d")
    assert texts[-1] == TAIL


def test_route_fail_closed_missing_tail_keeps_docx(matrix):
    pid = _setup_cited_project(matrix, [_para("正文[1]。"), _para(HEAD), _para("[1] 孤条目")], ["a"])
    state_path = matrix["projects"] / pid / ".studio" / "word" / "state.json"
    before = state_path.read_text(encoding="utf-8")
    r = matrix["users"]["owner"].post(f"/api/projects/{pid}/word/renumber-citations", json={})
    assert r.status_code == 409
    assert state_path.read_text(encoding="utf-8") == before  # 无版本新增、无状态污染


def test_renumber_preserves_w_prefix_and_passes_preflight(matrix):
    """端到端回归：重排序列化必须保持 w: 命名空间前缀，随后运行 word/preflight 仍可通过（不报缺少 w:body）。"""
    from app.domain import word_documents as wd

    paras = _block_paras(["[1] 文献甲", "[2] 文献乙"], body_before=[_para("引言[2]，方法[1]。")])
    pid = _setup_cited_project(matrix, paras, ["a", "b"])
    owner = matrix["users"]["owner"]
    r = owner.post(f"/api/projects/{pid}/word/renumber-citations", json={})
    assert r.status_code == 200, r.text
    assert r.json()["changed"] is True
    with zipfile.ZipFile(wd.document_path(str(matrix["projects"] / pid))) as zf:
        xml_text = zf.read("word/document.xml").decode("utf-8")
    assert "<w:body" in xml_text and "<ns0:body" not in xml_text
    r_pre = owner.post(f"/api/projects/{pid}/word/preflight", json={"ruleset": "double-blind"})
    assert r_pre.status_code == 200, r_pre.text
    assert r_pre.json()["report"]["ruleset_id"] == "double-blind"
