# -*- coding: utf-8 -*-
"""修复验证闭环测试（v0.5）：verify-fix 端点——接受修改→重编译→确认错误消失→Issue 联动。

编译类用例需宿主 latexmk（无则跳过，与 test_latex_product 同惯例）；模型调用全部打桩。
busy/参数校验类用例不依赖 latexmk。
"""
import shutil

import pytest

from test_paper_proposals import _gen_pending, _mock_chat, _read_main, _setup, env  # noqa: F401  env=fixture

HAS_LATEXMK = shutil.which("latexmk") is not None

BROKEN_LINE = "\\thisisnotadefinedcommandX"


def _break_and_build(c, pid):
    """把 main.tex 改坏并真实编译，返回 (修复前诊断, 坏内容)。"""
    main = _read_main(c, pid)
    broken = main["content"].replace("\\begin{document}",
                                     "\\begin{document}\n" + BROKEN_LINE, 1)
    r = c.put(f"/api/projects/{pid}/latex/files/main.tex",
              json={"content": broken, "base": main["sha"]})
    assert r.status_code == 200, r.text
    r = c.post(f"/api/projects/{pid}/latex/build", json={"engine": "pdflatex"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["status"] == "error" and out["diagnostics"], out
    return out["diagnostics"], broken


def _gen_fix_proposal(c, pid, diag, monkeypatch, issue_id=None):
    """从编译错误生成修复提案（action=custom + error_context），返回 proposal dict。"""
    main = _read_main(c, pid)
    _mock_chat(monkeypatch, '{"text": "\\begin{document} 已修复。", "rationale": "去掉未定义命令"}')
    r = c.post(f"/api/projects/{pid}/paper-proposals/generate", json={
        "mode": "latex", "file": "main.tex", "base_sha": main["sha"],
        "original_text": BROKEN_LINE, "action": "custom",
        "instruction": "修复编译错误",
        "error_context": {"file": diag[0].get("file") or "main.tex",
                          "line": diag[0].get("line"),
                          "message": diag[0].get("message") or ""},
        **({"linked_issue_id": issue_id} if issue_id else {})})
    assert r.status_code == 200, r.text
    return r.json()["proposal"]


def _add_issue(c, pid, message="编译错误：undefined control sequence"):
    r = c.post(f"/api/projects/{pid}/latex/issues",
               json={"message": message, "file": "main.tex", "line": 10})
    assert r.status_code in (200, 201), r.text
    return r.json()  # 端点直接返回 issue row（含 id）


def test_verify_fix_requires_applied_latex(env, monkeypatch):
    """非 applied 状态 / word 模式拒绝（不依赖 latexmk）。"""
    c, pid, prop = _gen_pending(env, monkeypatch, "vf-state@pp.example.com", "在此开始撰写。")
    r = c.post(f"/api/projects/{pid}/paper-proposals/{prop['proposal_id']}/verify-fix")
    assert r.status_code == 409  # pending 不能验证
    # word 模式提案：可生成，但无编译验证
    main = _read_main(c, pid)
    _mock_chat(monkeypatch)
    r = c.post(f"/api/projects/{pid}/paper-proposals/generate", json={
        "mode": "word", "file": "document.docx", "base_sha": main["sha"],
        "original_text": "这句要改。", "action": "polish"})
    assert r.status_code == 200, r.text
    wp = r.json()["proposal"]
    r = c.post(f"/api/projects/{pid}/paper-proposals/{wp['proposal_id']}/verify-fix")
    assert r.status_code == 422 and "LaTeX" in r.json()["detail"]["message"]


def test_verify_fix_busy_passthrough(env, monkeypatch):
    """run_build 的 409 busy / 422 配置错误原样透传（打桩，不依赖 latexmk）。"""
    from app.domain.projects import ProjectError

    c, pid = _setup(env, "vf-busy@pp.example.com")
    main = _read_main(c, pid)
    _mock_chat(monkeypatch)
    r = c.post(f"/api/projects/{pid}/paper-proposals/generate", json={
        "mode": "latex", "file": "main.tex", "base_sha": main["sha"],
        "original_text": "在此开始撰写。", "action": "polish",
        "error_context": {"file": "main.tex", "line": 3, "message": "Undefined control sequence"}})
    ppid = r.json()["proposal"]["proposal_id"]
    c.post(f"/api/projects/{pid}/paper-proposals/{ppid}/status", json={"status": "applied"})

    import app.domain.latex_build as LB

    monkeypatch.setattr(LB, "run_build",
                        lambda *a, **k: (_ for _ in ()).throw(ProjectError("该案已有编译在进行", 409)))
    r = c.post(f"/api/projects/{pid}/paper-proposals/{ppid}/verify-fix")
    assert r.status_code == 409
    monkeypatch.setattr(LB, "run_build",
                        lambda *a, **k: (_ for _ in ()).throw(ProjectError("主文件不存在：main.tex", 422)))
    r = c.post(f"/api/projects/{pid}/paper-proposals/{ppid}/verify-fix")
    assert r.status_code == 422


def test_verify_fix_no_reference_error(env, monkeypatch):
    """无 error_context 且最近构建没有失败记录 → 422（没有可对照的错误）。"""
    if not HAS_LATEXMK:
        pytest.skip("需要宿主 latexmk")
    c, pid = _setup(env, "vf-noref@pp.example.com")
    main = _read_main(c, pid)
    _mock_chat(monkeypatch)
    r = c.post(f"/api/projects/{pid}/paper-proposals/generate", json={
        "mode": "latex", "file": "main.tex", "base_sha": main["sha"],
        "original_text": "在此开始撰写。", "action": "polish"})
    ppid = r.json()["proposal"]["proposal_id"]
    c.post(f"/api/projects/{pid}/paper-proposals/{ppid}/status", json={"status": "applied"})
    r = c.post(f"/api/projects/{pid}/paper-proposals/{ppid}/verify-fix")
    assert r.status_code in (400, 422)


@pytest.mark.skipif(not HAS_LATEXMK, reason="需要宿主 latexmk（本机已验证 MiKTeX 26.5）")
def test_verify_fix_resolved_and_issue_linkage(env, monkeypatch):
    """全链：坏工程 → 修复提案（关联 Issue）→ 采纳 → verify-fix → 编译通过 + Issue 已解决。

    HTTP 层等价于前端落地：PUT 修复内容（编辑器事务的服务端等价）+ status=applied。"""
    c, pid = _setup(env, "vf-fix@pp.example.com")
    diags, _broken = _break_and_build(c, pid)
    issue = _add_issue(c, pid)
    prop = _gen_fix_proposal(c, pid, diags, monkeypatch, issue_id=issue["id"])
    ppid = prop["proposal_id"]
    assert prop["error_context"]["file"] and prop["linked_issue_id"] == issue["id"]
    # 采纳前不能验证
    r = c.post(f"/api/projects/{pid}/paper-proposals/{ppid}/verify-fix")
    assert r.status_code == 409
    # 前端采纳等价动作：写回修复内容 + 状态 applied
    main = _read_main(c, pid)
    fixed = main["content"].replace(BROKEN_LINE + "\n", "")
    r = c.put(f"/api/projects/{pid}/latex/files/main.tex",
              json={"content": fixed, "base": main["sha"]})
    assert r.status_code == 200, r.text
    r = c.post(f"/api/projects/{pid}/paper-proposals/{ppid}/status", json={"status": "applied"})
    assert r.status_code == 200
    # 验证闭环
    r = c.post(f"/api/projects/{pid}/paper-proposals/{ppid}/verify-fix")
    assert r.status_code == 200, r.text
    ver = r.json()["verification"]
    assert ver["resolved"] is True and ver["build_status"] == "ok"
    assert ver["issue_resolved"] is True and ver["before"] and ver["after"] == []
    # 记录可回看：proposal.verifications 持久化（重读列表仍带）
    props = c.get(f"/api/projects/{pid}/paper-proposals").json()["proposals"]
    mine = next(p for p in props if p["proposal_id"] == ppid)
    assert len(mine["verifications"]) == 1 and mine["verifications"][0]["resolved"] is True
    # Issues 联动：关联 issue 已 resolved
    issues = c.get(f"/api/projects/{pid}/latex/issues").json()["issues"]
    hit = next(i for i in issues if i["id"] == issue["id"])
    assert hit["status"] == "resolved"
    # 再次验证（幂等闭环，第二次记录追加）
    r = c.post(f"/api/projects/{pid}/paper-proposals/{ppid}/verify-fix")
    assert r.status_code == 200 and r.json()["verification"]["resolved"] is True
    props = c.get(f"/api/projects/{pid}/paper-proposals").json()["proposals"]
    mine = next(p for p in props if p["proposal_id"] == ppid)
    assert len(mine["verifications"]) == 2


@pytest.mark.skipif(not HAS_LATEXMK, reason="需要宿主 latexmk")
def test_verify_fix_not_resolved_when_still_broken(env, monkeypatch):
    """采纳但错误仍在（修复不完整）→ resolved=False，after 带诊断，Issue 不联动。"""
    c, pid = _setup(env, "vf-still@pp.example.com")
    diags, _broken = _break_and_build(c, pid)
    issue = _add_issue(c, pid, "未修复的错误示例")
    prop = _gen_fix_proposal(c, pid, diags, monkeypatch, issue_id=issue["id"])
    ppid = prop["proposal_id"]
    # 采纳但正文原样未修（错误另有所在——verify 必须如实报告未消失）
    r = c.post(f"/api/projects/{pid}/paper-proposals/{ppid}/status", json={"status": "applied"})
    assert r.status_code == 200
    r = c.post(f"/api/projects/{pid}/paper-proposals/{ppid}/verify-fix")
    assert r.status_code == 200, r.text
    ver = r.json()["verification"]
    assert ver["resolved"] is False and ver["build_status"] != "ok" and ver["after"]
    assert ver["issue_resolved"] is False
    issues = c.get(f"/api/projects/{pid}/latex/issues").json()["issues"]
    hit = next(i for i in issues if i["id"] == issue["id"])
    assert hit["status"] == "open"
