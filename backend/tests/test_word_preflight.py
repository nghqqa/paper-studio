# -*- coding: utf-8 -*-
"""中文信息学报投稿前检查（jcip-preflight/1）回归：V1-V14 验收矩阵。

覆盖 docs/preflight-jcip-mvp.md：合格样稿/缺双语摘要与关键词/缺章节/占位残留/
批注/修订/文献编号异常与无法定位/非法 DOCX/权限/保存中/报告过期/只读性。
全部为隔离探针（TestClient + 合成 DOCX，无真实 DS）。
"""
import importlib
import hashlib
import io
import json
import os
import sys
import zipfile

import pytest
from docx import Document
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def matrix(tmp_path_factory):
    base = tmp_path_factory.mktemp("preflight")
    projects = base / "projects"
    projects.mkdir()
    env = {"PATENT_STUDIO_AUTH": "on", "PATENT_STUDIO_SECRET": "preflight-tests-secret-at-least-32-bytes",
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
        from app.main import app

        def register(name):
            c = TestClient(app)
            email = name + "@pf.example.com"
            r = c.post("/api/auth/register", json={"email": email, "password": "Pf-test-pw!"})
            assert r.status_code == 201, r.text
            r = c.post("/api/auth/cookie/login", data={"username": email, "password": "Pf-test-pw!"})
            assert r.status_code == 204, r.text
            return c

        register("bootstrap")
        users = {k: register(k) for k in ("owner", "editor", "viewer", "outsider")}
        owner = users["owner"]
        r = owner.post("/api/projects/word/create", json={"title": "投稿前检查稿", "template": "blank"})
        assert r.status_code == 200, r.text
        pid = r.json()["id"]
        for name in ("editor", "reviewer", "viewer"):
            r = owner.put(f"/api/projects/{pid}/members", json={"email": name + "@pf.example.com", "role": name})
            assert r.status_code in (200, 201), r.text
        return {"app": app, "users": users, "pid": pid, "root": projects}
    finally:
        for k, v in previous.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def doc_path(matrix):
    return matrix["root"] / matrix["pid"] / "document.docx"


def build_doc_bytes(paragraphs, tables=None):
    d = Document()
    for t in paragraphs:
        d.add_paragraph(t)
    for rows in tables or []:
        t = d.add_table(rows=len(rows), cols=len(rows[0]))
        for i, row in enumerate(rows):
            for j, cell in enumerate(row):
                t.rows[i].cells[j].text = cell
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def write_doc(matrix, paragraphs, tables=None):
    raw = build_doc_bytes(paragraphs, tables)
    doc_path(matrix).write_bytes(raw)
    return raw


def with_comments(docx_bytes):
    """向已生成 DOCX 注入最小 word/comments.xml + 内容类型覆盖（检查端只需读到该部件）。"""
    src = zipfile.ZipFile(io.BytesIO(docx_bytes))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for item in src.infolist():
            data = src.read(item.filename)
            if item.filename == "[Content-Types].xml":
                data = data.replace(b"</Types>",
                                    b'<Override PartName="/word/comments.xml" '
                                    b'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>')
            z.writestr(item, data)
        z.writestr("word/comments.xml",
                   '<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                   '<w:comment w:id="1" w:author="导师"><w:p><w:r><w:t>这里要改</w:t></w:r></w:p></w:comment></w:comments>')
    return out.getvalue()


def with_revisions(docx_bytes):
    src = zipfile.ZipFile(io.BytesIO(docx_bytes))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for item in src.infolist():
            data = src.read(item.filename)
            if item.filename == "word/document.xml":
                data = data.replace("</w:body>".encode("utf-8"),
                                    '<w:ins w:id="9" w:author="合作者"><w:r><w:t>增补</w:t></w:r></w:ins></w:body>'.encode("utf-8"))
            z.writestr(item, data)
    return out.getvalue()


def statuses(report):
    return {it["rule_id"]: it["status"] for it in report["items"]}


PF_HEAD = "[参考文献-平台生成]（由文献面板管理；删除此标记前请先在面板更新）"
PF_TAIL = "[参考文献-平台生成]（完）"

GOOD_DOC = [
    "中文标题：基于某模型的研究",
    "作者：张三",
    "（1.某大学，某市 邮编）",
    "摘要：本文提出了一种方法，实验验证了有效性。",
    "关键词：自然语言处理；信息抽取；某模型",
    "中图分类号：TP391",
    "Abstract: This paper proposes a method with experiments.",
    "Key words: NLP; extraction; model",
    "0  引言",
    "本文的方法在实验中表现良好[1]。",
    "1  方法",
    "对比实验引用了已有工作[2]。",
    "参考文献",
    "[1] 某作者. 某论文[J]. 某刊, 2023.",
    "[2] 另一作者. 另一论文[J]. 某刊, 2024.",
]


def test_v1_v14_matrix(matrix):
    owner = matrix["users"]["owner"]
    pid = matrix["pid"]

    # GET 404（尚未运行）
    r = owner.get(f"/api/projects/{pid}/word/preflight")
    assert r.status_code == 404

    # V1 合格样稿：相关项全 pass
    raw = write_doc(matrix, GOOD_DOC)
    sha_before = hashlib.sha256(raw).hexdigest()
    r = owner.post(f"/api/projects/{pid}/word/preflight")
    assert r.status_code == 200, r.text
    body = r.json()
    report = body["report"]
    st = statuses(report)
    assert st["jcip-abstract-cn"] == "pass"
    assert st["jcip-keywords-cn"] == "pass"
    assert st["jcip-abstract-en"] == "pass"
    assert st["jcip-keywords-en"] == "pass"
    assert st["jcip-sections"] == "pass"
    assert st["jcip-placeholder"] == "pass"
    assert st["jcip-revision"] == "pass"
    assert st["jcip-comment"] == "pass"
    assert st["jcip-citation-integrity"] == "pass"
    assert report["version"] >= 1 and report["ruleset_id"] == "jcip-preflight"
    assert report["sha256"] == sha_before, f"报告 sha {report['sha256'][:16]} vs 文件 {sha_before[:16]}"
    assert body["expired"] is False and body["superseded"] is False  # 新鲜快照报告
    # V14 只读性：检查前后 document.docx 字节不变
    assert doc_path(matrix).read_bytes() == raw

    # GET：不过期 + 元数据一致
    r = owner.get(f"/api/projects/{pid}/word/preflight")
    assert r.status_code == 200
    body = r.json()
    assert body["expired"] is False
    assert body["report"]["sha256"] == sha_before
    assert body["current"]["version"] == report["version"]

    # V2 缺英文摘要与 Key words
    write_doc(matrix, [p for p in GOOD_DOC if not (p.startswith("Abstract") or p.startswith("Key words"))])
    r = owner.post(f"/api/projects/{pid}/word/preflight")
    st = statuses(r.json()["report"])
    assert st["jcip-abstract-en"] == "warn" and st["jcip-keywords-en"] == "warn"
    assert st["jcip-abstract-cn"] == "pass"

    # V3 缺中文摘要与关键词
    write_doc(matrix, [p for p in GOOD_DOC if not (p.startswith("摘要：") or p.startswith("关键词："))])
    st = statuses(owner.post(f"/api/projects/{pid}/word/preflight").json()["report"])
    assert st["jcip-abstract-cn"] == "warn" and st["jcip-keywords-cn"] == "warn"

    # V4 缺编号章节
    write_doc(matrix, [p for p in GOOD_DOC if p not in ("0  引言", "1  方法")])
    st = statuses(owner.post(f"/api/projects/{pid}/word/preflight").json()["report"])
    assert st["jcip-sections"] == "warn"

    # V5 模板占位残留
    write_doc(matrix, GOOD_DOC[:1] + ["中文标题题目三号", "摘要：中文摘要100-300字，用“该文”不用“本文”。"] + GOOD_DOC[4:])
    st = statuses(owner.post(f"/api/projects/{pid}/word/preflight").json()["report"])
    assert st["jcip-placeholder"] == "warn"
    assert st["jcip-abstract-cn"] == "warn"  # 占位段不算正文摘要

    # V6 批注
    write_doc(matrix, GOOD_DOC)
    doc_path(matrix).write_bytes(with_comments(doc_path(matrix).read_bytes()))
    st = statuses(owner.post(f"/api/projects/{pid}/word/preflight").json()["report"])
    assert st["jcip-comment"] == "warn"

    # V7 修订
    write_doc(matrix, GOOD_DOC)
    doc_path(matrix).write_bytes(with_revisions(doc_path(matrix).read_bytes()))
    st = statuses(owner.post(f"/api/projects/{pid}/word/preflight").json()["report"])
    assert st["jcip-revision"] == "warn"

    # V8 文献编号异常：引用了文献表中不存在的编号 + 首次出现顺序非递增
    write_doc(matrix, GOOD_DOC[:9] + ["实验引用了工作[4]。", "1  方法", "对比工作[1]。", "参考文献", "[1] 甲", "[2] 乙", "[3] 丙"])
    body8 = owner.post(f"/api/projects/{pid}/word/preflight").json()
    st = statuses(body8["report"])
    assert st["jcip-citation-integrity"] == "warn"
    evidence = next(it["evidence"] for it in body8["report"]["items"] if it["rule_id"] == "jcip-citation-integrity")
    assert "不存在的编号" in evidence

    # V9 无文献表可定位 → unknown
    write_doc(matrix, ["中文标题", "摘要：某摘要。", "关键词：某词", "Abstract: Something.", "Key words: words", "0  引言", "正文段"])
    st = statuses(owner.post(f"/api/projects/{pid}/word/preflight").json()["report"])
    assert st["jcip-citation-integrity"] == "unknown"

    # V9b 修订标记换行/属性换行写法 + rPrChange 格式修订：命名空间解析不漏检
    raw = write_doc(matrix, GOOD_DOC)
    src = zipfile.ZipFile(io.BytesIO(raw))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for item in src.infolist():
            data = src.read(item.filename)
            if item.filename == "word/document.xml":
                data = data.replace(
                    "</w:body>".encode("utf-8"),
                    ('<w:ins\n  w:id="7" w:author="审"><w:r><w:t>增</w:t></w:r></w:ins>'
                     '<w:p><w:pPr><w:rPr><w:rPrChange w:id="8" w:author="审"/></w:rPr></w:pPr></w:p></w:body>').encode("utf-8"))
            z.writestr(item, data)
    doc_path(matrix).write_bytes(buf.getvalue())
    st = statuses(owner.post(f"/api/projects/{pid}/word/preflight").json()["report"])
    assert st["jcip-revision"] == "warn"

    # V9c 尾标记后的附录编号：不补齐文献表缺失、不计入引用对账
    write_doc(matrix, [PF_HEAD, "[1] 文献一", PF_TAIL, "正文引言[1]。正文又引[3]。", "附录", "[3] 附录文献"])
    r = owner.post(f"/api/projects/{pid}/word/preflight")
    body9c = r.json()
    st = statuses(body9c["report"])
    assert st["jcip-citation-integrity"] == "warn"
    ev9c = next(it["evidence"] for it in body9c["report"]["items"] if it["rule_id"] == "jcip-citation-integrity")
    assert "不存在的编号 [3]" in ev9c  # 附录里的 [3] 未被当作文献表条目补位

    # V9d 表格单元格内的引用纳入对账（缺失编号告警）
    write_doc(matrix, GOOD_DOC[:12] + ["参考文献", "[1] 甲", "[2] 乙"],
              tables=[[["对比工作[3]的表格"]]])
    report_v9d = owner.post(f"/api/projects/{pid}/word/preflight").json()["report"]
    st = statuses(report_v9d)
    assert st["jcip-citation-integrity"] == "warn"
    ev9d = next(it["evidence"] for it in owner.post(f"/api/projects/{pid}/word/preflight").json()["report"]["items"]
                if it["rule_id"] == "jcip-citation-integrity")
    assert "不存在的编号 [3]" in ev9d

    # V10 非法 DOCX
    doc_path(matrix).write_bytes(b"this is not a zip")
    r = owner.post(f"/api/projects/{pid}/word/preflight")
    assert r.status_code == 422

    # V11 权限：viewer / outsider
    r = matrix["users"]["viewer"].post(f"/api/projects/{pid}/word/preflight")
    assert r.status_code == 403
    r = matrix["users"]["viewer"].get(f"/api/projects/{pid}/word/preflight")
    assert r.status_code == 403
    r = matrix["users"]["outsider"].get(f"/api/projects/{pid}/word/preflight")
    assert r.status_code in (403, 404)

    # V13 报告过期：检查后改写 document.docx（文件 SHA 变化；state 版本不变）→ expired=true
    write_doc(matrix, GOOD_DOC)
    owner.post(f"/api/projects/{pid}/word/preflight")
    write_doc(matrix, GOOD_DOC + ["补充段——文档已更新"])
    body = owner.get(f"/api/projects/{pid}/word/preflight").json()
    assert body["expired"] is True
    assert body["report"]["sha256"] != body["current"]["sha256"]
    assert body["report"]["version"] == body["current"]["version"]  # 改文件不动 state，版本仍相同

    state_path = matrix["root"] / pid / ".studio" / "word" / "state.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    state["saving"] = True
    state_path.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    r = owner.post(f"/api/projects/{pid}/word/preflight")
    assert r.status_code == 409
    assert "保存" in r.json()["detail"]["message"]
    state["saving"] = False
    state_path.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")


def test_concurrent_save_during_check_marks_expired(matrix, monkeypatch):
    """检查执行期间另一保存完成 → 报告绑定旧快照并如实返回 expired（本轮审查问题 3）。"""
    owner = matrix["users"]["owner"]
    pid = matrix["pid"]
    import app.domain.word_preflight as wpm

    old = write_doc(matrix, GOOD_DOC)

    real = wpm.run_checks

    def fake_run_checks(data):
        # 模拟检查执行期间另一保存完成：快照文件与 state 一并推进
        new = write_doc(matrix, GOOD_DOC + ["并发保存的新段"])
        new_sha = hashlib.sha256(new).hexdigest()
        state_path = matrix["root"] / pid / ".studio" / "word" / "state.json"
        st = json.loads(state_path.read_text(encoding="utf-8"))
        st["sha"] = new_sha
        st["version"] = st.get("version", 1) + 1
        state_path.write_text(json.dumps(st, ensure_ascii=False), encoding="utf-8")
        return real(data)

    monkeypatch.setattr(wpm, "run_checks", fake_run_checks)
    r = owner.post(f"/api/projects/{pid}/word/preflight")
    assert r.status_code == 200
    body = r.json()
    assert body["expired"] is True
    assert body["superseded"] is False
    assert body["report"]["sha256"] == hashlib.sha256(old).hexdigest()  # 报告绑定其检查的旧快照


def test_stale_check_does_not_overwrite_newer_report(matrix, monkeypatch):
    """旧快照的迟到检查不得覆盖与当前快照一致的较新报告（本轮审查问题 3）。
    时序：POST 读取旧快照 → 检查执行期间另一保存推进到新字节 →
    预置的较新报告（与推进后快照一致）不得被旧结果覆盖。"""
    owner = matrix["users"]["owner"]
    pid = matrix["pid"]
    import app.domain.word_preflight as wpm

    # 预置较新报告：其 sha256 对应"并发保存之后"的字节
    new_bytes = build_doc_bytes(GOOD_DOC + ["较新内容"])
    new_sha = hashlib.sha256(new_bytes).hexdigest()
    report_path = matrix["root"] / pid / ".studio" / "word" / "preflight-report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps({
        "schema": "paper-studio/word-preflight@1", "project_id": pid, "version": 99,
        "sha256": new_sha, "ruleset_id": "jcip-preflight", "ruleset_version": "1",
        "generated_at": "2026-10-30T00:00:00Z", "items": [],
    }, ensure_ascii=False), encoding="utf-8")

    real = wpm.run_checks

    def fake_run_checks(data):
        # POST 已按旧字节建立快照；此处模拟并发保存推进 document.docx 与 state
        doc_path(matrix).write_bytes(new_bytes)
        state_path = matrix["root"] / pid / ".studio" / "word" / "state.json"
        st = json.loads(state_path.read_text(encoding="utf-8"))
        st["sha"] = new_sha
        st["version"] = 99
        state_path.write_text(json.dumps(st, ensure_ascii=False), encoding="utf-8")
        return real(data)

    monkeypatch.setattr(wpm, "run_checks", fake_run_checks)
    r = owner.post(f"/api/projects/{pid}/word/preflight")
    assert r.status_code == 200
    body = r.json()
    assert body["superseded"] is True
    assert body["expired"] is True          # 如实标记：报告对应旧快照
    on_disk = json.loads(report_path.read_text(encoding="utf-8"))
    assert on_disk["sha256"] == new_sha     # 较新报告保持原样


# ==================== 多规则集（P1-3）：cn-general / double-blind ====================


def with_core_props(docx_bytes, creator, last_modified_by):
    """整体替换 docProps/core.xml（python-docx 默认值不可控），构造确定的作者属性。"""
    core = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/">'
            f'<dc:creator>{creator}</dc:creator>'
            f'<cp:lastModifiedBy>{last_modified_by}</cp:lastModifiedBy>'
            '</cp:coreProperties>').encode("utf-8")
    src = zipfile.ZipFile(io.BytesIO(docx_bytes))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for item in src.infolist():
            data = core if item.filename == "docProps/core.xml" else src.read(item.filename)
            z.writestr(item, data)
    return out.getvalue()


def with_broken_document_xml(docx_bytes):
    """合法 zip 但 document.xml XML 损坏（截断闭合标签，<w:body 仍在）→ 全 unknown 路径。"""
    src = zipfile.ZipFile(io.BytesIO(docx_bytes))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for item in src.infolist():
            data = src.read(item.filename)
            if item.filename == "word/document.xml":
                data = data.replace(b"</w:document>", b"<!-- truncated")
            z.writestr(item, data)
    return out.getvalue()


def test_cn_general_ruleset(matrix):
    """cn-general/1：待办残留/修订/批注命中 + 干净稿全 pass + 分文件存储与 GET 路由。"""
    owner = matrix["users"]["owner"]
    pid = matrix["pid"]
    url = f"/api/projects/{pid}/word/preflight"

    # 命中：TODO / 【待补】 / ？？ 残留；引用对账不受影响（[1] 对 [1]）
    write_doc(matrix, GOOD_DOC[:9] + [
        "实验方法参考[1]。TODO 补充实验",
        "注：数据【待补】",
        "1  方法",
        "结果如何？？",
        "参考文献",
        "[1] 甲",
    ])
    r = owner.post(url, json={"ruleset": "cn-general"})
    assert r.status_code == 200, r.text
    report = r.json()["report"]
    assert report["ruleset_id"] == "cn-general" and report["ruleset_version"] == "1"
    st = statuses(report)
    assert st["cn-placeholder-residue"] == "warn"
    ev = next(it["evidence"] for it in report["items"] if it["rule_id"] == "cn-placeholder-residue")
    assert "TODO" in ev and "【待补】" in ev
    assert st["cn-revision"] == "pass" and st["cn-comment"] == "pass"
    assert st["cn-citation-integrity"] == "pass"

    # 修订 / 批注命中（与 jcip 同口径的 XML 解析）
    write_doc(matrix, GOOD_DOC)
    doc_path(matrix).write_bytes(with_comments(doc_path(matrix).read_bytes()))
    st = statuses(owner.post(url, json={"ruleset": "cn-general"}).json()["report"])
    assert st["cn-comment"] == "warn"
    write_doc(matrix, GOOD_DOC)
    doc_path(matrix).write_bytes(with_revisions(doc_path(matrix).read_bytes()))
    st = statuses(owner.post(url, json={"ruleset": "cn-general"}).json()["report"])
    assert st["cn-revision"] == "warn"

    # 干净稿 → 全 pass；jcip 旧路径文件与 cn-general 分文件并存
    write_doc(matrix, GOOD_DOC)
    r = owner.post(url, json={"ruleset": "cn-general"})
    st = statuses(r.json()["report"])
    assert set(st.values()) == {"pass"}
    assert (matrix["root"] / pid / ".studio" / "word" / "preflight-cn-general.json").is_file()
    assert (matrix["root"] / pid / ".studio" / "word" / "preflight-report.json").is_file()

    # 空对象 body = 默认 jcip（旧行为不变）
    r = owner.post(url, json={})
    assert r.status_code == 200
    assert r.json()["report"]["ruleset_id"] == "jcip-preflight"

    # GET 分规则集：带参数返回 cn-general；不带参数返回旧默认 jcip 报告
    r = owner.get(url + "?ruleset=cn-general")
    assert r.status_code == 200
    assert r.json()["report"]["ruleset_id"] == "cn-general"
    assert r.json()["expired"] is False
    r = owner.get(url)
    assert r.json()["report"]["ruleset_id"] == "jcip-preflight"
    # 未运行过的规则集 → 404；未知规则集 → 422（POST/GET 同口径）
    r = owner.get(url + "?ruleset=double-blind")
    assert r.status_code == 404
    assert owner.post(url, json={"ruleset": "nope"}).status_code == 422
    assert owner.get(url + "?ruleset=nope").status_code == 422

    # 权限：viewer 403（与 jcip 同门槛）
    assert matrix["users"]["viewer"].post(url, json={"ruleset": "cn-general"}).status_code == 403
    assert matrix["users"]["viewer"].get(url + "?ruleset=cn-general").status_code == 403


def test_double_blind_ruleset(matrix):
    """double-blind/1：settings 屏蔽词 + core.xml creator 泄露 + 正文命中 + 请求词优先 + 无词 unknown。"""
    owner = matrix["users"]["owner"]
    pid = matrix["pid"]
    url = f"/api/projects/{pid}/word/preflight"

    # 项目设置 blind_terms（studio.json 元信息）作为屏蔽词来源
    r = owner.put(f"/api/projects/{pid}/settings", json={"blind_terms": ["张三", "某大学"]})
    assert r.status_code == 200, r.text

    write_doc(matrix, GOOD_DOC)  # 正文天然含「作者：张三」「1.某大学」
    doc_path(matrix).write_bytes(with_core_props(doc_path(matrix).read_bytes(), "张三", "李四"))
    r = owner.post(url, json={"ruleset": "double-blind"})
    assert r.status_code == 200, r.text
    report = r.json()["report"]
    assert report["ruleset_id"] == "double-blind" and report["ruleset_version"] == "1"
    st = statuses(report)
    # core.xml creator 命中屏蔽词
    assert st["blind-docprops"] == "warn"
    ev = next(it["evidence"] for it in report["items"] if it["rule_id"] == "blind-docprops")
    assert "creator" in ev and "张三" in ev
    # 正文命中作者词
    assert st["blind-author-terms"] == "warn"
    ev = next(it["evidence"] for it in report["items"] if it["rule_id"] == "blind-author-terms")
    assert "张三" in ev
    # 无基金表述 → pass
    assert st["blind-funding-terms"] == "pass"

    # 页眉页脚命中：注入 header1.xml 后作者词扫描范围含页眉
    def with_header(docx_bytes, text):
        src = zipfile.ZipFile(io.BytesIO(docx_bytes))
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for item in src.infolist():
                z.writestr(item, src.read(item.filename))
            z.writestr("word/header1.xml",
                       '<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                       f'<w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:hdr>')
        return out.getvalue()

    doc_path(matrix).write_bytes(with_header(doc_path(matrix).read_bytes(), "某大学课题组内部稿"))
    st = statuses(owner.post(url, json={"ruleset": "double-blind"}).json()["report"])
    assert st["blind-author-terms"] == "warn"

    # 请求 blind_terms 优先于项目设置：换成未命中的词 → pass（张三不再被扫描）
    doc_path(matrix).write_bytes(with_core_props(
        build_doc_bytes(GOOD_DOC), "张三", "李四"))
    r = owner.post(url, json={"ruleset": "double-blind", "blind_terms": ["王五"]})
    st = statuses(r.json()["report"])
    assert st["blind-author-terms"] == "pass"
    assert st["blind-docprops"] == "pass"

    # 基金词命中（正文显式资助表述，无需屏蔽词即可给确定结论）
    write_doc(matrix, GOOD_DOC + ["本项目受国家自然科学基金资助（Grant No. 12345678）。"])
    report = owner.post(url, json={"ruleset": "double-blind"}).json()["report"]
    assert statuses(report)["blind-funding-terms"] == "warn"
    ev = next(it["evidence"] for it in report["items"] if it["rule_id"] == "blind-funding-terms")
    assert "国家自然科学基金" in ev or "Grant" in ev


def test_double_blind_without_terms_unknown(matrix):
    """未配置屏蔽词：作者词/文档属性条目如实 unknown（绝不假 pass），基金词仍给确定结论。"""
    owner = matrix["users"]["owner"]
    r = owner.post("/api/projects/word/create", json={"title": "双盲无词稿", "template": "blank"})
    assert r.status_code == 200, r.text
    pid2 = r.json()["id"]
    (matrix["root"] / pid2 / "document.docx").write_bytes(build_doc_bytes(GOOD_DOC))
    r = owner.post(f"/api/projects/{pid2}/word/preflight", json={"ruleset": "double-blind"})
    assert r.status_code == 200, r.text
    report = r.json()["report"]
    st = statuses(report)
    assert st["blind-author-terms"] == "unknown"
    assert st["blind-docprops"] == "unknown"
    assert st["blind-funding-terms"] == "pass"
    ev = next(it["evidence"] for it in report["items"] if it["rule_id"] == "blind-author-terms")
    assert "未配置" in ev


def test_corrupted_docx_all_unknown_per_ruleset(matrix):
    """合法 zip 但 document.xml XML 损坏：cn-general / double-blind 全 unknown + parse_error，
    绝不输出"全部通过"（jcip 同输入行为不变：也全 unknown）。"""
    owner = matrix["users"]["owner"]
    pid = matrix["pid"]
    url = f"/api/projects/{pid}/word/preflight"
    raw = build_doc_bytes(GOOD_DOC)
    doc_path(matrix).write_bytes(with_broken_document_xml(raw))
    for ruleset in ("cn-general", "double-blind", "jcip-preflight"):
        r = owner.post(url, json={"ruleset": ruleset})
        assert r.status_code == 200, r.text
        report = r.json()["report"]
        assert report.get("parse_error"), f"{ruleset} 应带 parse_error"
        assert report["items"], "损坏文档不应返回空条目"
        assert all(it["status"] == "unknown" for it in report["items"]), f"{ruleset} 应全 unknown"

    # 非 zip（结构性损坏）仍 422——所有规则集同口径
    doc_path(matrix).write_bytes(b"this is not a zip")
    assert owner.post(url, json={"ruleset": "cn-general"}).status_code == 422
    assert owner.post(url, json={"ruleset": "double-blind"}).status_code == 422


def test_ruleset_reports_freshen_independently(matrix):
    """分规则集报告各自绑定各自快照：cn-general 刷新不影响 jcip 旧报告的过期判定。"""
    owner = matrix["users"]["owner"]
    pid = matrix["pid"]
    url = f"/api/projects/{pid}/word/preflight"
    write_doc(matrix, GOOD_DOC)
    owner.post(url)  # jcip 报告 v_snapshot_a
    write_doc(matrix, GOOD_DOC + ["文档已更新段"])
    owner.post(url, json={"ruleset": "cn-general"})  # cn-general 报告绑定新快照
    body_jcip = owner.get(url).json()
    assert body_jcip["expired"] is True  # jcip 旧报告已过期
    body_cn = owner.get(url + "?ruleset=cn-general").json()
    assert body_cn["expired"] is False  # cn-general 是新快照结果


def test_jcip_article_number_allowed_and_word_autonum_bib_parsed():
    """真实录用稿回归：
    1) 文章编号：1003-0077（2017）00-0000-00 为编辑部待填默认占位，不触发 jcip-placeholder 告警；
    2) Word 自动编号列表（<w:numPr>）参考文献 + 空行/References 副标题 + [1-3] 范围引用可正确解析通过；
    3) 文献表未解析出编号条目时，正文与表格中的 [n] 引用仍应如实计数，不误报「正文引用 0 处」。
    """
    from docx import Document
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    import app.domain.word_preflight as wpm

    # 1 + 2: 含默认文章编号、表格/正文 [1-3] 引用、空行 + References 副标题 + Word 自动编号文献列表
    doc = Document()
    for p in [
        "文章编号：1003-0077（2017）00-0000-00",
        "基于门控机制的少样本命名实体识别研究",
        "摘要：该文提出一种少样本命名实体识别框架。",
        "关键词：命名实体识别；少样本学习；大语言模型",
        "Abstract: This paper proposes a few-shot NER framework.",
        "Key words: named entity recognition; few-shot learning; LLM",
        "0  引言",
        "已有方法[1-3]在少样本场景表现受限。",
        "1  方法",
        "本文进一步改进基线[2]。",
        "参 考 文 献",
        "",
        "References",
    ]:
        doc.add_paragraph(p)

    for ref_txt in [
        "Vaswani A, et al. Attention Is All You Need[C]//NeurIPS, 2017.",
        "He K, et al. Deep Residual Learning[C]//CVPR, 2016.",
        "Devlin J, et al. BERT[C]//NAACL, 2019.",
    ]:
        rp = doc.add_paragraph(ref_txt)
        ppr = rp._p.get_or_add_pPr()
        numpr = OxmlElement("w:numPr")
        ilvl = OxmlElement("w:ilvl")
        ilvl.set(qn("w:val"), "0")
        numid = OxmlElement("w:numId")
        numid.set(qn("w:val"), "1")
        numpr.append(ilvl)
        numpr.append(numid)
        ppr.append(numpr)

    buf = io.BytesIO()
    doc.save(buf)
    rep = wpm.run_checks(buf.getvalue())
    st = {it["rule_id"]: it["status"] for it in rep["items"]}
    ev = {it["rule_id"]: it["evidence"] for it in rep["items"]}
    assert st["jcip-placeholder"] == "pass", ev["jcip-placeholder"]
    assert st["jcip-citation-integrity"] == "pass", ev["jcip-citation-integrity"]
    assert "正文引用 4 处，文献表 3 条" in ev["jcip-citation-integrity"]

    # 3: 文献表为无编号纯文本时，正文引用仍如实计数（非 0 处）
    doc2 = Document()
    for p in ["0  引言", "引用了工作[1]与[2]。", "参考文献", "无编号文献甲", "无编号文献乙"]:
        doc2.add_paragraph(p)
    buf2 = io.BytesIO()
    doc2.save(buf2)
    rep2 = wpm.run_checks(buf2.getvalue())
    it2 = next(it for it in rep2["items"] if it["rule_id"] == "jcip-citation-integrity")
    assert it2["status"] == "warn"
    assert "正文引用 2 处，文献表 0 条" in it2["evidence"]
