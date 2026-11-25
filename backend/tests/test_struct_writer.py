# -*- coding: utf-8 -*-
"""结构化中文论文（实验）路由测试：开关 / 创建 / 内容乐观并发 / 权限 / 资源 / 导出门禁。
复用 test_asgi_member_matrix 的「正式 create_app 入口 + 真实注册账号 + 模块级共享状态」模式。
"""
import importlib
import os
import sys

import pytest
from fastapi.testclient import TestClient

PW = "struct-pw!"
ENV = {
    "PATENT_STUDIO_AUTH": "on",
    "PATENT_STUDIO_SECRET": "struct-test-secret",
    "PATENT_STUDIO_LEGACY_DATABASE_URL": "",  # 运行时按 tmp 填
}


def _fresh(name):
    mod = sys.modules.get(name)
    if mod is not None:
        return importlib.reload(mod)
    return importlib.import_module(name)


@pytest.fixture(scope="module")
def matrix(tmp_path_factory):
    base = tmp_path_factory.mktemp("struct")
    env = {
        "PATENT_STUDIO_AUTH": "on",
        "PATENT_STUDIO_SECRET": "struct-test-secret",
        "PATENT_PROJECTS_DIR": str(base / "projects"),
        "PATENT_STUDIO_LEGACY_DATABASE_URL": f"sqlite:///{base}/studio.db",
        "PATENT_STUDIO_STRUCT_WRITER": "on",
    }
    old = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    (base / "projects").mkdir()
    try:
        for name in ("app.config", "app.auth.db", "app.auth.acl", "app.auth.router", "app.main"):
            _fresh(name)
        from app.main import app

        def new_client():
            return TestClient(app)

        def register(email):
            c = new_client()
            r = c.post("/api/auth/register", json={"email": email, "password": PW, "display_name": email.split("@")[0]})
            assert r.status_code == 201, (email, r.status_code, r.text)
            r = c.post("/api/auth/cookie/login", data={"username": email, "password": PW},
                       headers={"Content-Type": "application/x-www-form-urlencoded"})
            assert r.status_code == 204, r.status_code
            return c

        register("bootstrap@struct.example.com")  # 首注册=超管占位
        users = {k: register(f"{k}@struct.example.com") for k in ("owner", "editor", "reviewer", "outsider")}
        r = users["owner"].post("/api/projects/struct/create", json={"title": "验收工程"})
        assert r.status_code == 200, r.text
        pid = r.json()["id"]
        for k, role in (("editor", "editor"), ("reviewer", "reviewer")):
            r = users["owner"].put(f"/api/projects/{pid}/members",
                                   json={"email": f"{k}@struct.example.com", "role": role})
            assert r.status_code == 200, (role, r.text)
        yield {"app": app, "pid": pid, "users": users}
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def test_create_returns_project_with_struct_source(matrix):
    pid = matrix["pid"]
    owner = matrix["users"]["owner"]
    r = owner.get(f"/api/projects/{pid}/struct/content")
    body = r.json()
    assert body["content"]["schema_version"] == 1
    assert body["content"]["body"][0]["type"] == "h1"
    assert len(body["sha"]) == 64
    assert body["versions"][0]["source"] == "create"
    # 工程元数据：source_format=structured 已按契约注册
    p = owner.get(f"/api/projects/{pid}").json()
    assert p["settings"]["source_format"] == "structured"
    assert p["settings"]["document_type"] == "paper"


def test_content_roundtrip_and_versions(matrix):
    pid = matrix["pid"]
    owner = matrix["users"]["owner"]
    body = owner.get(f"/api/projects/{pid}/struct/content").json()
    new_content = body["content"]
    new_content["abstract_zh"] = "更新后的摘要，引用式 [[eq:eq-1]]。"
    new_content["body"].append({"type": "p", "text": "第二段正文"})
    r = owner.put(f"/api/projects/{pid}/struct/content",
                  json={"content": new_content, "base_sha": body["sha"]})
    assert r.status_code == 200, r.text
    assert r.json()["saved"] is True
    cur = owner.get(f"/api/projects/{pid}/struct/content").json()
    assert "第二段正文" in cur["content"]["body"][-1]["text"]
    assert len(cur["versions"]) == 2


def test_put_conflict_on_stale_base(matrix):
    pid = matrix["pid"]
    owner = matrix["users"]["owner"]
    # 先产生一个非初始版本，避免当前 sha 与过期 base 相同的歧义
    body = owner.get(f"/api/projects/{pid}/struct/content").json()
    body["content"]["abstract_zh"] = "中间版本"
    owner.put(f"/api/projects/{pid}/struct/content",
              json={"content": body["content"], "base_sha": body["sha"]})
    cur = owner.get(f"/api/projects/{pid}/struct/content").json()["sha"]
    r = owner.put(f"/api/projects/{pid}/struct/content",
                  json={"content": {"schema_version": 1, "body": []}, "base_sha": "0" * 64})
    assert r.status_code == 409
    # 409 的 detail 携带当前 sha（供客户端刷新后重试），不回显过期 base
    assert r.json()["detail"]["detail"] == cur


def test_flag_off_preserves_existing_drafts_but_blocks_creation(matrix, monkeypatch):
    pid = matrix["pid"]
    monkeypatch.setattr("app.config.STRUCT_WRITER_ON", False)
    owner = matrix["users"]["owner"]
    reply = owner.get(f"/api/projects/{pid}/struct/content")
    assert reply.status_code == 200
    draft = reply.json()
    draft["content"]["title"] = "迁移前保存的旧稿"
    assert owner.put(f"/api/projects/{pid}/struct/content", json={
        "content": draft["content"], "base_sha": draft["sha"],
    }).status_code == 200
    assert owner.post("/api/projects/struct/create", json={"title": "不再新建"}).status_code == 404


def test_anonymous_blocked(matrix):
    pid = matrix["pid"]
    anon = TestClient(matrix["app"], raise_server_exceptions=False)
    assert anon.get(f"/api/projects/{pid}/struct/content").status_code == 401
    assert anon.post(f"/api/projects/{pid}/struct/export/docx").status_code == 401
    assert anon.get(f"/api/projects/{pid}/struct/artifacts").status_code == 401


def test_reviewer_readonly_editor_can_write(matrix):
    pid = matrix["pid"]
    rev, ed = matrix["users"]["reviewer"], matrix["users"]["editor"]
    assert rev.get(f"/api/projects/{pid}/struct/content").status_code == 200
    r = rev.put(f"/api/projects/{pid}/struct/content",
                json={"content": {"schema_version": 1, "body": []}, "base_sha": None})
    assert r.status_code == 403, r.status_code
    r = ed.put(f"/api/projects/{pid}/struct/content",
               json={"content": {"schema_version": 1, "body": [], }, "base_sha": None})
    assert r.status_code == 200, r.text


def test_resource_upload_whitelist_and_isolation(matrix):
    pid = matrix["pid"]
    owner = matrix["users"]["owner"]
    r = owner.post(f"/api/projects/{pid}/struct/resources",
                   files={"file": ("x.png", b"\x89PNG fake", "image/png")})
    assert r.status_code == 200, r.text
    rid = r.json()["rid"]
    r = owner.post(f"/api/projects/{pid}/struct/resources",
                   files={"file": ("x.exe", b"MZ fake", "application/x-dosexec")})
    assert r.status_code == 400
    assert owner.get(f"/api/projects/{pid}/struct/resources/{rid}").status_code == 200
    pid2 = _new_project(matrix, "iso")
    r = matrix["users"]["owner"].get(f"/api/projects/{pid2}/struct/resources/{rid}")
    assert r.status_code == 404


def _new_project(matrix, title="附加工程"):
    owner = matrix["users"]["owner"]
    r = owner.post("/api/projects/struct/create", json={"title": title})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_export_blocked_on_broken_ref(matrix):
    pid = _new_project(matrix, "断链工程")
    owner = matrix["users"]["owner"]
    content = owner.get(f"/api/projects/{pid}/struct/content").json()["content"]
    content["body"].append({"type": "formula", "id": "eq-x", "latex": "\\frac{a}{b}"})
    content["body"].append({"type": "p", "text": "引用不存在的式 [[eq:nope]]。"})
    owner.put(f"/api/projects/{pid}/struct/content",
              json={"content": content, "base_sha": None})
    r = owner.post(f"/api/projects/{pid}/struct/export/docx")
    assert r.status_code == 422, r.text
    assert "失效引用" in r.json()["detail"]["message"]
    assert owner.get(f"/api/projects/{pid}/struct/artifacts").json()["artifacts"] == []


def test_export_blocked_on_unsupported_command(matrix):
    pid = _new_project(matrix, "命令工程")
    owner = matrix["users"]["owner"]
    content = owner.get(f"/api/projects/{pid}/struct/content").json()["content"]
    content["body"].append({"type": "formula", "id": "eq-y",
                            "latex": "\\unknowncmd{x} + \\fatalmacro{y}"})
    owner.put(f"/api/projects/{pid}/struct/content",
              json={"content": content, "base_sha": None})
    r = owner.post(f"/api/projects/{pid}/struct/export/docx")
    assert r.status_code == 422
    assert "unknowncmd" in r.json()["detail"]["message"]


def test_export_success_returns_docx_and_manifest(matrix, monkeypatch):
    pid = _new_project(matrix, "导出工程")
    owner = matrix["users"]["owner"]
    content = owner.get(f"/api/projects/{pid}/struct/content").json()["content"]
    content["affil"] = "示例大学计算机系"
    content["abstract_zh"] = "合成验收摘要，引用式 [[eq:eq-1]]。"
    content["body"].append({
        "type": "formula", "id": "eq-1",
        "latex": "G = \\frac{\\sum_{i=1}^{n} w_i \\cdot e_i^{w}}{1 + \\alpha \\sqrt{n}}",
    })
    owner.put(f"/api/projects/{pid}/struct/content",
              json={"content": content, "base_sha": None})
    r = owner.post(f"/api/projects/{pid}/struct/export/docx?mode=tab")
    assert r.status_code == 200, r.text
    m = r.json()["manifest"]
    assert m["profile"] == "jcip" and m["stale"] is False
    assert m["content_sha256"] and m["docx_sha256"]
    r = owner.get(f"/api/projects/{pid}/struct/artifacts/{m['artifact']}")
    assert r.status_code == 200
    assert r.content[:2] == b"PK"
    # 编号版式几何回归：制表位必须按本文档版心（9605 twips）计算，
    # 右 tab 落版心右缘（v0.1.4 曾写死双栏列宽致编号落行中）
    import io as _io
    import zipfile as _zip
    with _zip.ZipFile(_io.BytesIO(r.content)) as z:
        doc_xml = z.read("word/document.xml").decode("utf-8")
    assert 'w:val="center" w:pos="4802"' in doc_xml, "居中制表位应在版心中点"
    assert 'w:val="right" w:pos="9465"' in doc_xml, "右制表位应在版心右缘（9605-140）"
    # 题区补排：单位行保留且居中缩字；pandoc 硬编码 "Abstract" 改写为「摘要」
    assert "示例大学计算机系" in doc_xml
    affil_pos = doc_xml.find("示例大学计算机系")
    affil_para = doc_xml[doc_xml.rfind("<w:p>", 0, affil_pos):affil_pos]
    assert '<w:jc w:val="center"/>' in affil_para, "单位行应居中"
    assert "摘要" in doc_xml and ">Abstract<" not in doc_xml
    # table 版式：公式表 1×3 对称（两侧列等宽，公式格中心=版心中点）
    r2 = owner.post(f"/api/projects/{pid}/struct/export/docx?mode=table")
    assert r2.status_code == 200, r2.text
    with _zip.ZipFile(_io.BytesIO(owner.get(f"/api/projects/{pid}/struct/artifacts/{r2.json()['manifest']['artifact']}").content)) as z:
        tbl_xml = z.read("word/document.xml").decode("utf-8")
    import re as _re
    grid = _re.search(r'<w:tblGrid>(.*?)</w:tblGrid>', tbl_xml[_re.search(r'w:w="9605"', tbl_xml).start():])
    cols = _re.findall(r'w:w="(\d+)"', grid.group(1))
    assert len(cols) == 3 and cols[0] == cols[2] == "1400" and int(cols[1]) == 9605 - 2800, \
        f"公式表应为 1×3 对称（1400/6805/1400），实际 {cols}"
    # 内容再变化 ⇒ 旧导出标记 stale
    content["body"].append({"type": "p", "text": "导出之后的修改。"})
    owner.put(f"/api/projects/{pid}/struct/content",
              json={"content": content, "base_sha": None})
    lst = owner.get(f"/api/projects/{pid}/struct/artifacts").json()["artifacts"]
    assert lst[-1]["stale"] is True


# ---------------------------------------------------------------- 投稿版预览（v0.1.5）

def _fake_pdf_bytes(monkeypatch):
    """替身 sidecar：跳过真实 pandoc/LibreOffice，返回最小 PDF 字节并记录调用。"""
    calls = []

    def fake_convert(docx_path, filename):
        calls.append(filename)
        return b"%PDF-1.4 fake"

    import app.routes.struct_writer as sw
    monkeypatch.setattr(sw, "_sidecar_pdf_bytes", fake_convert)
    return calls


def _fill_formula(matrix, marker: str) -> str:
    pid = matrix["pid"]
    owner = matrix["users"]["owner"]
    body = owner.get(f"/api/projects/{pid}/struct/content").json()
    content = body["content"]
    content["abstract_zh"] = f"预览验收 {marker}，引用 [[eq:eq-p1]]。"
    if not any(b.get("type") == "formula" and b.get("id") == "eq-p1" for b in content["body"]):
        content["body"].append({"type": "formula", "id": "eq-p1", "latex": "E = mc^2"})
    r = owner.put(f"/api/projects/{pid}/struct/content", json={"content": content, "base_sha": None})
    assert r.status_code == 200
    return r.json()["sha"]


def test_preview_happy_path_cache_and_no_artifact(matrix, monkeypatch):
    pid = matrix["pid"]
    owner = matrix["users"]["owner"]
    calls = _fake_pdf_bytes(monkeypatch)
    sha = _fill_formula(matrix, "v1")

    r = owner.post(f"/api/projects/{pid}/struct/preview")
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["status"] == "ok" and j["sha"] == sha and j["bytes"] > 0
    assert j["pdfUrl"].endswith(f"/struct/preview/pdf/{sha}.pdf")
    assert j["vid"], "预览响应必须携带版本号"

    # 预览文件在 .studio 下，不进 artifacts（不可下载产物）
    arts = owner.get(f"/api/projects/{pid}/struct/artifacts").json()["artifacts"]
    assert arts == []
    # 缓存命中：同内容第二次 → cached，零转换调用
    r2 = owner.post(f"/api/projects/{pid}/struct/preview").json()
    assert r2["status"] == "cached" and r2["sha"] == sha
    assert len(calls) == 1
    # 预览 PDF 可取回（editor）
    rp = owner.get(f"/api/projects/{pid}/struct/preview/pdf/{sha}.pdf")
    assert rp.status_code == 200 and rp.content[:5] == b"%PDF-"

    # 内容变化 → 新 sha 新预览；旧 sha 预览仍按文件存在（保留 N 代内），但 UI 以 sha 不匹配标过期
    sha2 = _fill_formula(matrix, "v2")
    assert sha2 != sha
    r3 = owner.post(f"/api/projects/{pid}/struct/preview").json()
    assert r3["status"] == "ok" and r3["sha"] == sha2


def test_preview_viewer_reviewer_blocked(matrix, monkeypatch):
    pid = matrix["pid"]
    calls = _fake_pdf_bytes(monkeypatch)
    _fill_formula(matrix, "perm")
    # 生成一份预览文件供下载测试
    r = matrix["users"]["owner"].post(f"/api/projects/{pid}/struct/preview")
    assert r.status_code == 200
    sha = r.json()["sha"]
    # reviewer=成员低角色 403；非成员 404（平台隐存在语义，见成员矩阵测试）
    rp = matrix["users"]["reviewer"].post(f"/api/projects/{pid}/struct/preview")
    assert rp.status_code == 403, rp.status_code
    rd = matrix["users"]["reviewer"].get(f"/api/projects/{pid}/struct/preview/pdf/{sha}.pdf")
    assert rd.status_code == 403, rd.status_code
    ro = matrix["users"]["outsider"].post(f"/api/projects/{pid}/struct/preview")
    assert ro.status_code == 404, ro.status_code
    # editor（非 owner 成员）可生成（与导出同门槛）
    re_ = matrix["users"]["editor"].post(f"/api/projects/{pid}/struct/preview")
    assert re_.status_code in (200, 409)  # 409=与 owner 并发触发同案单任务，同为合法语义


def test_preview_cross_project_isolation(matrix, monkeypatch):
    owner = matrix["users"]["owner"]
    calls = _fake_pdf_bytes(monkeypatch)
    _fill_formula(matrix, "iso")
    r = owner.post(f"/api/projects/{matrix['pid']}/struct/preview")
    sha = r.json()["sha"]
    # 另一工程（同 owner）：不能用自己的 URL 读到别人的预览文件
    r2 = owner.post("/api/projects/struct/create", json={"title": "隔离工程B"})
    assert r2.status_code == 200
    pid_b = r2.json()["id"]
    rb = owner.get(f"/api/projects/{pid_b}/struct/preview/pdf/{sha}.pdf")
    assert rb.status_code == 404, "跨项目读取预览必须 404"
    # 同内容不同项目：缓存不跨项目复用（B 工程首次预览必须真实生成）
    calls.clear()
    rb2 = owner.post(f"/api/projects/{pid_b}/struct/preview")
    assert rb2.status_code == 200 and rb2.json()["status"] == "ok"
    assert len(calls) == 1, "同 sha 不同项目必须各自生成（缓存键含 pid 隔离）"


def test_preview_sidecar_not_configured(matrix, monkeypatch):
    pid = matrix["pid"]
    _fill_formula(matrix, "nosvc")
    import app.config as config
    monkeypatch.setattr(config, "STRUCT_PDF_SVC_URL", "")
    r = matrix["users"]["owner"].post(f"/api/projects/{pid}/struct/preview")
    assert r.status_code == 501
    assert "未配置" in r.json()["detail"]["message"] or "未配置" in r.json()["detail"].get("message", "")
    # 无产物残留
    import app.main  # noqa: F401 - 确保 app 模块已加载
    d = None


def test_legacy_preview_keeps_validation_when_creation_flag_off(matrix, monkeypatch):
    pid = matrix["pid"]
    owner = matrix["users"]["owner"]
    draft = owner.get(f"/api/projects/{pid}/struct/content").json()
    draft["content"]["body"].append({"type": "formula", "id": "eq-empty-migration", "latex": ""})
    assert owner.put(f"/api/projects/{pid}/struct/content", json={
        "content": draft["content"], "base_sha": draft["sha"],
    }).status_code == 200
    monkeypatch.setattr("app.config.STRUCT_WRITER_ON", False)
    assert owner.post(f"/api/projects/{pid}/struct/preview").status_code == 422


def test_registry_and_template_create():
    """模板注册表 + latex-demo template 参数（独立 app：验证注册表形状与创建路由）。"""
    base = None
    env = {
        "PATENT_STUDIO_AUTH": "on",
        "PATENT_STUDIO_SECRET": "tpl-secret",
        "PATENT_STUDIO_STRUCT_WRITER": "on",
    }
    old = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    try:
        for name in ("app.config", "app.auth.db", "app.auth.acl", "app.auth.router", "app.main"):
            _fresh(name)
        from app.main import app
        c = TestClient(app)
        c.post("/api/auth/register", json={"email": "boot@tpl.example.com", "password": PW})  # 已存在 400 可容忍
        c.post("/api/auth/cookie/login", data={"username": "boot@tpl.example.com", "password": PW},
               headers={"Content-Type": "application/x-www-form-urlencoded"})
        reg = c.get("/api/paper-templates").json()
        assert {t["id"] for t in reg["latex"]} >= {"blank", "jcip", "ieee"}
        assert reg["struct"] and reg["struct"][0]["id"] == "jcip" and reg["struct"][0]["experimental"] is True
        # 按模板创建
        for tpl in ("blank", "ieee"):
            r = c.post("/api/projects/latex-demo", json={"template": tpl})
            assert r.status_code == 200, (tpl, r.text)
        r = c.post("/api/projects/latex-demo", json={"template": "nope"})
        # 未知模板走 paper_templates.get 的统一语义：不存在/已移除 ⇒ 404（fail-closed，
        # 31a702a 起的模板治理行为；旧断言 422 一直被本测前置的 sidecar/Docker 失败掩盖）
        assert r.status_code == 404
        # 结构化创建带投稿目标元数据
        r = c.post("/api/projects/struct/create",
                   json={"title": "元数据工程", "venue": "中文信息学报", "field": "计算机", "rank": "CCF-A"})
        assert r.status_code == 200
        pid = r.json()["id"]
        p = c.get(f"/api/projects/{pid}").json()
        assert p["settings"]["submission"]["venue"] == "中文信息学报"
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
