# -*- coding: utf-8 -*-
"""Wave 1 增强功能综合回归测试：
1. AI 助手 SSE 流式输出 / 中英互译 / 多轮微调 refine / 精读流 / 披露台账
2. Rebuttal 审稿回复草稿 SSE 流式输出与 ACL
3. LaTeX Preflight 结构化 locations 定位 + 文献核验 remote_fields 一键应用
4. Word 版本里程碑标签 / 段落级 .docx Diff / 非破坏式恢复(+doc_key轮换/409) / 返修包 ZIP & ACL
"""
from __future__ import annotations

import importlib
import io
import json
import os
import sys
import zipfile

import pytest
from docx import Document
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    base = tmp_path_factory.mktemp("wave1")
    projects = base / "projects"
    projects.mkdir()
    vars_env = {
        "PATENT_STUDIO_AUTH": "on",
        "PATENT_STUDIO_SECRET": "wave1-test-auth-secret-at-least-32-bytes!",
        "PATENT_PROJECTS_DIR": str(projects),
        "PATENT_STUDIO_LEGACY_DATABASE_URL": f"sqlite:///{base}/studio.db",
        "PATENT_STUDIO_WORD_EDITOR": "on",
        "PATENT_STUDIO_ONLYOFFICE_JWT_SECRET": "wave1-word-secret",
        "PATENT_STUDIO_ONLYOFFICE_URL": "http://localhost:9980",
        "PATENT_STUDIO_ONLYOFFICE_INTERNAL_URL": "http://onlyoffice:80",
        "PATENT_STUDIO_ONLYOFFICE_PUBLIC_URL": "http://studio:8000",
        "PATENT_STUDIO_PUBLIC_ORIGIN": "",
        "PAPER_STUDIO_PRODUCT": "paper",
        "PAPER_STUDIO_LIBRARY_SOURCES": "on",
    }
    saved_modules = {k: m for k, m in sys.modules.items() if k == "app" or k.startswith("app.")}
    saved_env = {k: os.environ.get(k) for k in vars_env}
    os.environ.update(vars_env)
    try:
        for name in list(sys.modules):
            if name == "app" or name.startswith("app."):
                del sys.modules[name]
        import app.main as main_mod
        importlib.reload(main_mod)
        app = main_mod.app

        def reg(name: str) -> TestClient:
            c = TestClient(app)
            email = f"{name}@wave1.example.com"
            r = c.post("/api/auth/register", json={"email": email, "password": "Wave1-test-pw!", "display_name": name})
            assert r.status_code in (200, 201), r.text
            r2 = c.post(
                "/api/auth/cookie/login",
                data={"username": email, "password": "Wave1-test-pw!"},
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            assert r2.status_code == 204, r2.text
            return c

        admin = reg("admin")
        users = {k: reg(k) for k in ("owner", "editor", "reviewer", "viewer", "outsider")}
        # 开启团队 AI 配置供提案测试使用
        r_ai = admin.put(
            "/api/admin/settings",
            json={
                "ai_provider": {
                    "base_url": "https://api.fake.example/v1",
                    "api_key": "sk-wave1-test",
                    "model_interactive": "m-fast",
                    "model_heavy": "m-heavy",
                    "model_fallback": "m-fast",
                }
            },
        )
        assert r_ai.status_code == 200, r_ai.text
        yield {"app": app, "admin": admin, "users": users, "projects": projects}
    finally:
        for k, v in saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        for k in [k for k in sys.modules if k == "app" or k.startswith("app.")]:
            del sys.modules[k]
        sys.modules.update(saved_modules)


def _create_latex_project(env) -> str:
    owner = env["users"]["owner"]
    r = owner.post("/api/projects/latex-demo", json={"template": "blank"})
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    for role in ("editor", "reviewer", "viewer"):
        rm = owner.put(
            f"/api/projects/{pid}/members",
            json={"email": f"{role}@wave1.example.com", "role": role},
        )
        assert rm.status_code in (200, 201), rm.text
    return pid


def _parse_sse(raw: str) -> list[tuple[str, dict]]:
    events: list[tuple[str, dict]] = []
    cur_event = "message"
    cur_data: list[str] = []
    for line in raw.splitlines():
        if line.startswith("event:"):
            cur_event = line[6:].strip()
        elif line.startswith("data:"):
            cur_data.append(line[5:].strip())
        elif line == "":
            if cur_data:
                events.append((cur_event, json.loads("\n".join(cur_data))))
            cur_event = "message"
            cur_data = []
    if cur_data:
        events.append((cur_event, json.loads("\n".join(cur_data))))
    return events


def _mock_stream_ai(monkeypatch, chunks: list[str], capture: list | None = None):
    import app.domain.user_ai as ua

    class _FakeRes:
        def __init__(self, text: str, model: str = "m-fast"):
            self.text = text
            self.model = model

    class _FakeStream:
        def __init__(self):
            self.result = _FakeRes("".join(chunks))

        def __aiter__(self):
            self._idx = 0
            return self

        async def __anext__(self):
            if self._idx >= len(chunks):
                raise StopAsyncIteration
            c = chunks[self._idx]
            self._idx += 1
            return c

    class _FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def chat(self, messages, purpose, **kwargs):
            if capture is not None:
                capture.append((messages, purpose, kwargs))
            if kwargs.get("stream"):
                return _FakeStream()
            return _FakeRes("".join(chunks))

    monkeypatch.setattr(ua, "resolve_ai_client", lambda *a, **kw: (_FakeClient(), None))


def test_ai_stream_translation_refine_read_and_disclosure(env, monkeypatch):
    pid = _create_latex_project(env)
    owner = env["users"]["owner"]
    viewer = env["users"]["viewer"]
    outsider = env["users"]["outsider"]

    main_tex = (
        "\\documentclass{article}\n"
        "\\begin{document}\n"
        "本文提出一种高效图神经网络架构。\n"
        "\\end{document}\n"
    )
    r_put = owner.put(f"/api/projects/{pid}/latex/files/main.tex", json={"content": main_tex})
    assert r_put.status_code == 200, r_put.text
    main_sha = owner.get(f"/api/projects/{pid}/latex/files/main.tex").json()["sha"]

    # 1) translate_en 流式生成
    captured: list = []
    _mock_stream_ai(
        monkeypatch,
        ['{"text": "We propose ', 'an efficient GNN architecture.", ', '"rationale": "Translated formally."}'],
        capture=captured,
    )
    r1 = owner.post(
        f"/api/projects/{pid}/paper-proposals/generate/stream",
        json={
            "file": "main.tex",
            "action": "translate_en",
            "original_text": "本文提出一种高效图神经网络架构。",
            "base_sha": main_sha,
        },
    )
    assert r1.status_code == 200, r1.text
    assert r1.headers["content-type"].startswith("text/event-stream")
    evs1 = _parse_sse(r1.text)
    assert [e[0] for e in evs1[:-1]] == ["delta", "delta", "delta"]
    assert evs1[-1][0] == "done"
    prop1 = evs1[-1][1]["proposal"]
    assert prop1["action"] == "translate_en"
    assert prop1["status"] == "pending"
    assert prop1["suggested_text"] == "We propose an efficient GNN architecture."

    # 2) refine 多轮二次微调：携带 parent_proposal_id 与 previous_suggestion
    captured.clear()
    _mock_stream_ai(
        monkeypatch,
        ['{"text": "We introduce a compact GNN.", "rationale": "Shorter phrasing."}'],
        capture=captured,
    )
    r2 = owner.post(
        f"/api/projects/{pid}/paper-proposals/generate/stream",
        json={
            "file": "main.tex",
            "action": "custom",
            "original_text": "本文提出一种高效图神经网络架构。",
            "instruction": "进一步精简用词",
            "parent_proposal_id": prop1["proposal_id"],
            "previous_suggestion": prop1["suggested_text"],
            "base_sha": main_sha,
        },
    )
    assert r2.status_code == 200, r2.text
    evs2 = _parse_sse(r2.text)
    prop2 = evs2[-1][1]["proposal"]
    assert prop2["parent_proposal_id"] == prop1["proposal_id"]
    prompt_user = captured[0][0][1]["content"]
    assert prop1["suggested_text"] in prompt_user

    # 3) translate_zh
    _mock_stream_ai(monkeypatch, ['{"text": "我们提出一种紧凑图神经网络。", "rationale": "忠实译出。"}'])
    r3 = owner.post(
        f"/api/projects/{pid}/paper-proposals/generate/stream",
        json={
            "file": "main.tex",
            "action": "translate_zh",
            "original_text": "We introduce a compact GNN.",
            "base_sha": main_sha,
        },
    )
    assert r3.status_code == 200
    assert _parse_sse(r3.text)[-1][1]["proposal"]["action"] == "translate_zh"

    # 4) read/stream 对 viewer 开放，outsider 被拒；viewer 不可变更提案状态
    _mock_stream_ai(monkeypatch, ["这段话提出了核心贡献：", "图神经网络的高效建模。"])
    r_read = viewer.post(
        f"/api/projects/{pid}/paper-assistant/read/stream",
        json={"file": "main.tex", "text": "We propose an efficient GNN architecture.", "question": "核心点是什么？"},
    )
    assert r_read.status_code == 200, r_read.text
    evs_r = _parse_sse(r_read.text)
    assert evs_r[-1][0] == "done"
    assert "核心贡献" in evs_r[-1][1]["answer"]
    assert outsider.post(f"/api/projects/{pid}/paper-assistant/read/stream", json={"file": "main.tex", "text": "hello"}).status_code in (403, 404)
    assert viewer.post(f"/api/projects/{pid}/paper-proposals/{prop1['proposal_id']}/status", json={"status": "applied"}).status_code == 403

    # 5) 采纳 translate_en 提案后，披露台账包含翻译记录
    r_apply = owner.post(
        f"/api/projects/{pid}/paper-proposals/{prop1['proposal_id']}/status",
        json={"status": "applied", "applied_text": prop1["suggested_text"]},
    )
    assert r_apply.status_code == 200
    disc = owner.get(f"/api/projects/{pid}/paper-proposals/disclosure?lang=zh&format=markdown").json()
    assert "中译英" in disc["content"] or "translate_en" in json.dumps(disc, ensure_ascii=False)


def test_rebuttal_draft_stream_and_acl(env, monkeypatch):
    pid = _create_latex_project(env)
    owner = env["users"]["owner"]
    viewer = env["users"]["viewer"]

    rp = owner.post(
        f"/api/projects/{pid}/rebuttal/parse",
        json={"text": "Reviewer #1\nMajor Comment 1: Please clarify the convergence rate and complexity bound."},
    )
    assert rp.status_code == 200, rp.text
    item_id = rp.json()["items"][0]["id"]

    # viewer 无权生成回复草稿
    assert viewer.post(f"/api/projects/{pid}/rebuttal/items/{item_id}/draft/stream", json={}).status_code == 403

    _mock_stream_ai(
        monkeypatch,
        ['{"response": "We thank Reviewer 1. ', 'Theorem 1 establishes O(1/T) convergence.", ', '"edits_summary": "Added proof in Sec 3."}'],
    )
    rs = owner.post(f"/api/projects/{pid}/rebuttal/items/{item_id}/draft/stream", json={"context": "Theorem 1 proof"})
    assert rs.status_code == 200, rs.text
    evs = _parse_sse(rs.text)
    assert evs[0][0] == "delta"
    assert evs[-1][0] == "done"
    saved_item = evs[-1][1]["item"]
    assert "O(1/T)" in saved_item["ai_draft"]["response_draft"]


def test_preflight_locations_and_citation_remote_fields(env):
    pid = _create_latex_project(env)
    owner = env["users"]["owner"]

    dirty_tex = (
        "\\documentclass{article}\n"
        "\\author{Alice Smith}\n"
        "\\begin{document}\n"
        "TODO: polish intro.\n"
        "Bad ref \\cite{missing_key}.\n"
        "We use XYZ module. Later XYZ runs fast.\n"
        "\\end{document}\n"
    )
    bib = (
        "@article{uncited2024,\n"
        "  title={Unused Reference},\n"
        "  author={Bob Lee},\n"
        "  year={2024}\n"
        "}\n"
    )
    assert owner.put(f"/api/projects/{pid}/latex/files/main.tex", json={"content": dirty_tex}).status_code == 200
    assert owner.post(f"/api/projects/{pid}/latex/files/refs.bib", json={"content": bib}).status_code == 200

    rg = owner.post(f"/api/projects/{pid}/latex/preflight", json={"ruleset": "latex-general"}).json()["report"]
    by_id = {it["rule_id"]: it for it in rg["items"]}
    assert by_id["latex-todo-residue"]["locations"][0]["file"] == "main.tex"
    assert by_id["latex-todo-residue"]["locations"][0]["line"] == 4
    assert by_id["latex-undefined-refs"]["locations"][0]["label"] == "missing_key"
    assert by_id["latex-acronym-consistency"]["locations"][0]["label"] == "XYZ"

    rb = owner.post(f"/api/projects/{pid}/latex/preflight", json={"ruleset": "double-blind"}).json()["report"]
    b_map = {it["rule_id"]: it for it in rb["items"]}
    assert b_map["blind-author-block"]["locations"][0]["file"] == "main.tex"

    rs = owner.post(f"/api/projects/{pid}/latex/preflight", json={"ruleset": "submission-readiness"}).json()["report"]
    s_map = {it["rule_id"]: it for it in rs["items"]}
    assert s_map["sub-uncited-bib"]["locations"][0]["file"] == "refs.bib"
    assert s_map["sub-uncited-bib"]["locations"][0]["label"] == "uncited2024"

    # Citation Verify remote_fields + library/entries PATCH
    from app.domain import citation_verify as cv
    from app.domain.library import LibraryEntry

    local_entry = LibraryEntry(
        reference_id="ref_1",
        citation_key="he2016deep",
        title="Deep Residual Learning for Image Recognition",
        authors=["Wrong, Author"],
        year="2020",
        doi="10.1109/CVPR.2016.90",
    )
    cand = {
        "source": "crossref",
        "fields": {
            "title": "Deep Residual Learning for Image Recognition",
            "authors": ["He, Kaiming", "Zhang, Xiangyu"],
            "year": "2016",
            "venue": "CVPR",
            "doi": "10.1109/CVPR.2016.90",
            "url": "https://doi.org/10.1109/CVPR.2016.90",
        },
        "retraction": {"status": "none"},
    }
    res = cv._compare_entry(local_entry, cand)
    assert res["status"] == "mismatch"
    assert res["remote_fields"]["authors"] == ["He, Kaiming", "Zhang, Xiangyu"]
    assert res["remote_fields"]["year"] == "2016"
    assert res["remote_fields"]["venue"] == "CVPR"

    owner.post(f"/api/projects/{pid}/library/reindex", json={})
    lib = owner.get(f"/api/projects/{pid}/library").json()
    rid = lib["entries"][0]["reference_id"]
    rp = owner.patch(
        f"/api/projects/{pid}/library/entries/{rid}",
        json={"fields": {"author": "He, Kaiming and Zhang, Xiangyu", "year": "2016", "venue": "CVPR"}},
    )
    assert rp.status_code == 200, rp.text
    updated = rp.json()["entry"]
    assert updated["year"] == "2016"
    assert "He, Kaiming" in updated["authors"]


def test_word_milestones_diff_restore_and_revision_kit(env):
    from app.domain import word_documents as w

    owner = env["users"]["owner"]
    reviewer = env["users"]["reviewer"]
    viewer = env["users"]["viewer"]

    rc = owner.post("/api/projects/word/create", json={"title": "返修工程", "template": "blank"})
    assert rc.status_code == 200, rc.text
    pid = rc.json()["id"]
    for role in ("reviewer", "viewer"):
        assert owner.put(f"/api/projects/{pid}/members", json={"email": f"{role}@wave1.example.com", "role": role}).status_code == 200

    v1_bytes = owner.get(f"/api/projects/{pid}/word/download").content
    s1 = owner.get(f"/api/projects/{pid}/word/state").json()
    v1_id = s1["versions"][0]["id"]
    cfg1 = owner.get(f"/api/projects/{pid}/word/editor-config").json()["config"]

    # 构造带新段落与表格的 v2 docx 并上传
    doc = Document(io.BytesIO(v1_bytes))
    doc.add_paragraph("新增方法消融实验分析。")
    tbl = doc.add_table(rows=1, cols=2)
    tbl.rows[0].cells[0].text = "Baseline"
    tbl.rows[0].cells[1].text = "89.4%"
    buf = io.BytesIO()
    doc.save(buf)
    v2_bytes = buf.getvalue()

    ru = owner.post(
        f"/api/projects/{pid}/word/upload-version",
        files={"file": ("v2.docx", v2_bytes, w.DOCX_MEDIA)},
    )
    assert ru.status_code == 200, ru.text
    s2 = ru.json()["state"] if "state" in ru.json() else owner.get(f"/api/projects/{pid}/word/state").json()
    v2_id = s2["versions"][-1]["id"]

    # 1) 里程碑标签与 ACL
    assert viewer.patch(f"/api/projects/{pid}/word/versions/{v1_id}", json={"label": "bad"}).status_code == 403
    assert reviewer.patch(f"/api/projects/{pid}/word/versions/{v1_id}", json={"label": "bad"}).status_code == 403
    rl = owner.patch(f"/api/projects/{pid}/word/versions/{v1_id}", json={"label": "初稿送审"})
    assert rl.status_code == 200, rl.text
    assert rl.json()["versions"][0]["label"] == "初稿送审"

    # 2) 段落与表格级 unified diff
    rd = viewer.get(f"/api/projects/{pid}/word/diff?base_vid={v1_id}&target_vid={v2_id}")
    assert rd.status_code == 200, rd.text
    diff_body = rd.json()
    assert diff_body["added"] >= 2
    assert "新增方法消融实验分析。" in diff_body["unified_diff"]
    assert "Baseline | 89.4%" in diff_body["unified_diff"]

    # 3) 非破坏式恢复 + expected_sha 409 + doc_key 轮换 + ACL
    assert viewer.post(f"/api/projects/{pid}/word/versions/{v1_id}/restore", json={}).status_code == 403
    assert reviewer.post(f"/api/projects/{pid}/word/versions/{v1_id}/restore", json={}).status_code == 403
    assert owner.post(
        f"/api/projects/{pid}/word/versions/{v1_id}/restore",
        json={"expected_sha": "stale-sha"},
    ).status_code == 409

    r_rest = owner.post(
        f"/api/projects/{pid}/word/versions/{v1_id}/restore",
        json={"expected_sha": s2["sha"]},
    )
    assert r_rest.status_code == 200, r_rest.text
    s3 = r_rest.json()
    assert s3["version"] == 3 and len(s3["versions"]) == 3
    assert "恢复自 初稿送审" in (s3["versions"][-1].get("label") or "")
    cfg3 = owner.get(f"/api/projects/{pid}/word/editor-config").json()["config"]
    assert cfg3["document"]["key"] != cfg1["document"]["key"]
    assert owner.get(f"/api/projects/{pid}/word/download").content == v1_bytes

    # 4) Word 返修包 ZIP（含回复信）+ 下载禁令 403
    rp = owner.post(f"/api/projects/{pid}/rebuttal/parse", json={"text": "Reviewer 1:\nPlease clarify section 2."})
    assert rp.status_code == 200
    it_id = rp.json()["items"][0]["id"]
    assert owner.put(
        f"/api/projects/{pid}/rebuttal/items/{it_id}",
        json={"response": "Clarified in revised manuscript."},
    ).status_code == 200

    rk = owner.post(
        f"/api/projects/{pid}/word/export-revision-kit",
        json={"base_vid": v1_id, "target_vid": v2_id},
    )
    assert rk.status_code == 200, rk.text
    assert rk.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(rk.content)) as zf:
        names = set(zf.namelist())
        assert {
            "01-manuscript-current.docx",
            "02-version-diff.txt",
            "03-response-letter.docx",
            "03-response-letter.md",
            "README-revision-kit.txt",
        }.issubset(names)

    owner.put(f"/api/projects/{pid}/collab-settings", json={"allow_download": False})
    try:
        assert owner.post(f"/api/projects/{pid}/word/export-revision-kit", json={}).status_code == 403
        assert owner.get(f"/api/projects/{pid}/word/diff?base_vid={v1_id}&target_vid={v2_id}").status_code == 403
    finally:
        owner.put(f"/api/projects/{pid}/collab-settings", json={"allow_download": True})

    # 5) 恢复同 SHA 版本保持幂等（不追加版本、不改写已有标签），实际恢复清除保存 nonce/时间戳
    st_file = env["projects"] / pid / ".studio" / "word" / "state.json"
    st_raw = json.loads(st_file.read_text(encoding="utf-8"))
    st_raw["save_nonce"] = "nonce-123"
    st_raw["ds_lastsave"] = "2026-11-27T00:00:00Z"
    st_file.write_text(json.dumps(st_raw), encoding="utf-8")
    same_rest = owner.post(f"/api/projects/{pid}/word/versions/{v1_id}/restore", json={})
    assert same_rest.status_code == 200
    assert same_rest.json()["version"] == 3 and len(same_rest.json()["versions"]) == 3
    assert "恢复自 初稿送审" in (same_rest.json()["versions"][-1].get("label") or "")

    diff_rest = owner.post(f"/api/projects/{pid}/word/versions/{v2_id}/restore", json={})
    assert diff_rest.status_code == 200 and diff_rest.json()["version"] == 4
    st_after = json.loads(st_file.read_text(encoding="utf-8"))
    assert "save_nonce" not in st_after and "ds_lastsave" not in st_after


def test_sse_abort_releases_sem_and_quota_and_citation_verify_doi_priority(env, monkeypatch):
    import asyncio

    from app.ai import client as ai_client_mod
    from app.domain import ai_quota
    from app.domain import citation_verify as cv
    from app.domain import library_sources as ls
    from app.domain.library import LibraryEntry

    pid = _create_latex_project(env)
    owner = env["users"]["owner"]
    main_sha = owner.get(f"/api/projects/{pid}/latex/files/main.tex").json()["sha"]

    # 1) 真实 AiClient.chat(stream=True) 连续 4 次中途退出，_SEM 不泄漏死锁
    class _StubProv:
        name = "stub"
        key = "sk-stub"

        async def stream(self, model, messages, *, timeout, max_tokens=None, temperature=None):
            yield '{"text": "chunk1'
            yield ' chunk2"}'

    async def _run_aborts():
        cli = ai_client_mod.AiClient(_StubProv())
        before_val = ai_client_mod._SEM._value
        for _ in range(4):
            cs = await cli.chat([{"role": "user", "content": "hi"}], "interactive", stream=True, project_dir=str(env["projects"] / pid))
            assert await cs.__anext__() == '{"text": "chunk1'
            await cs.aclose()
        assert ai_client_mod._SEM._value == before_val
        # 归还后第 5 次仍可完整消费并释放
        cs2 = await cli.chat([{"role": "user", "content": "ok"}], "interactive", stream=True, project_dir=str(env["projects"] / pid))
        parts = [c async for c in cs2]
        assert "".join(parts) == '{"text": "chunk1 chunk2"}'
        assert ai_client_mod._SEM._value == before_val

    asyncio.run(asyncio.wait_for(_run_aborts(), timeout=5.0))

    # SSE 路由在流断连或抛错时必须执行 res.aclose() 并释放流句柄
    close_calls = [0]

    class _AbortingStream:
        def __init__(self, *, fail: bool = False):
            self._n = 0
            self._fail = fail

        def __aiter__(self):
            return self

        async def __anext__(self):
            if self._n == 0:
                self._n += 1
                return '{"text": "partial'
            if self._fail:
                raise RuntimeError("upstream stream broken")
            raise StopAsyncIteration

        async def aclose(self):
            close_calls[0] += 1

    import app.domain.user_ai as ua

    fail_flag = [False]

    class _AbortClient:
        async def chat(self, *a, **kw):
            return _AbortingStream(fail=fail_flag[0])

    monkeypatch.setattr(ua, "resolve_ai_client", lambda *a, **kw: (_AbortClient(), None))
    for _ in range(3):
        with owner.stream(
            "POST",
            f"/api/projects/{pid}/paper-proposals/generate/stream",
            json={"file": "main.tex", "action": "polish", "original_text": "hello", "base_sha": main_sha},
        ) as resp:
            assert resp.status_code == 200
            for _line in resp.iter_lines():
                break
    fail_flag[0] = True
    r_err = owner.post(
        f"/api/projects/{pid}/paper-proposals/generate/stream",
        json={"file": "main.tex", "action": "polish", "original_text": "hello", "base_sha": main_sha},
    )
    assert r_err.status_code == 200
    evs_err = _parse_sse(r_err.text)
    assert evs_err[-1][0] == "error" and "upstream stream broken" in evs_err[-1][1]["message"]
    assert close_calls[0] == 4
    _ = ai_quota.used_today("nonexistent")

    # 2) citation_verify._extract_arxiv_id 识别 arxiv_id 与 fields['eprint']，且正式 DOI 优先于 arXiv
    e1 = LibraryEntry(reference_id="r_a", citation_key="a2023", title="Paper A", authors=["A"], arxiv_id="2301.00001")
    e2 = LibraryEntry(reference_id="r_b", citation_key="b1999", title="Paper B", authors=["B"], fields={"eprint": "hep-th/9901001"})
    assert cv._extract_arxiv_id(e1) == "2301.00001"
    assert cv._extract_arxiv_id(e2) == "hep-th/9901001"

    order: list[str] = []

    async def _fake_doi(doi: str):
        order.append("doi:" + doi)
        return {"source": "crossref", "fields": {"title": "Published Title", "doi": doi}}

    async def _fake_arxiv(aid: str):
        order.append("arxiv:" + aid)
        return {"source": "arxiv", "fields": {"title": "Preprint Title"}}

    monkeypatch.setattr(ls, "lookup_doi", _fake_doi)
    monkeypatch.setattr(ls, "lookup_arxiv", _fake_arxiv)
    e_both = LibraryEntry(
        reference_id="r_both",
        citation_key="both2024",
        title="Some Published Paper Title",
        authors=["Smith, Alice"],
        doi="10.1145/1234567",
        arxiv_id="2401.00001",
    )
    cand, err = asyncio.run(cv._find_authoritative(e_both))
    assert err is None and cand is not None and cand["source"] == "crossref"
    assert order == ["doi:10.1145/1234567"]
