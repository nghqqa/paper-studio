# -*- coding: utf-8 -*-
"""B3 Rebuttal 多轮归档 + 工程锚点 + 导出 Round/Refs 回归。"""
import importlib
import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

REVIEW_TEXT = """The manuscript studies X. Overall the contribution is solid but needs work.

Reviewer #1
Major Comment 1: The motivation in the introduction is too weak for a general audience.
Minor Comment 2: There are several typos, e.g. "teh" on page 3.
"""


@pytest.fixture()
def client(tmp_path, monkeypatch):
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setenv("PATENT_PROJECTS_DIR", str(projects))
    monkeypatch.setenv("PATENT_STUDIO_AI_PROVIDER", "mock")
    from app import config, main
    from app.domain import projects as projects_mod

    for m in (config, projects_mod, main):
        importlib.reload(m)
    with TestClient(main.app) as c:
        r = c.post("/api/projects", json={"id": "pap1", "title": "示例论文", "document_type": "paper"})
        assert r.status_code == 201, r.text
        yield c, projects


def _parse(c, pid, mode=None):
    body = {"text": REVIEW_TEXT}
    if mode:
        body["mode"] = mode
    r = c.post(f"/api/projects/{pid}/rebuttal/parse", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _patch(c, pid, item_id, **body):
    return c.put(f"/api/projects/{pid}/rebuttal/items/{item_id}", json=body)


def test_replace_archives_previous_round_and_round_never_zero(client):
    c, projects = client
    pid = "pap1"
    st1 = _parse(c, pid)  # 首轮（round 0 → 1）：无旧条目，不产生归档
    assert st1["round"] == 1 and len(st1["items"]) == 3
    r = c.get(f"/api/projects/{pid}/rebuttal/rounds")
    assert r.json()["rounds"] == []
    assert not (projects / pid / ".studio" / "rebuttal" / "rounds" / "round-0.json").exists()
    # 填回复（归档内容含作者元数据）
    rid = st1["items"][0]["id"]
    assert _patch(c, pid, rid, response="我们补充了动机讨论。").status_code == 200
    # 二次 replace → round 1 归档，round 2 生效
    st2 = _parse(c, pid, mode="replace")
    assert st2["round"] == 2 and st2["items"][0]["id"] == "rb-1"
    archive_path = projects / pid / ".studio" / "rebuttal" / "rounds" / "round-1.json"
    assert archive_path.is_file()
    archived = json.loads(archive_path.read_text(encoding="utf-8"))
    assert archived["round"] == 1 and len(archived["items"]) == 3
    assert archived["items"][0]["response"] == "我们补充了动机讨论。"  # 原样保留
    assert archived["items"][0]["id"] == rid
    # 只读接口
    lst = c.get(f"/api/projects/{pid}/rebuttal/rounds").json()["rounds"]
    assert lst == [{"round": 1, "items": 3, "archived_at": archived["archived_at"]}]
    detail = c.get(f"/api/projects/{pid}/rebuttal/rounds/1").json()
    assert detail["round"] == 1 and detail["items"][0]["id"] == rid
    assert c.get(f"/api/projects/{pid}/rebuttal/rounds/9").status_code == 404
    # append 模式：不归档不替换
    st3 = _parse(c, pid, mode="append")
    assert st3["round"] == 2 and len(st3["items"]) == 6
    assert c.get(f"/api/projects/{pid}/rebuttal/rounds").json()["rounds"] == lst


def test_anchor_fields_validation_and_persistence(client):
    c, projects = client
    pid = "pap1"
    st = _parse(c, pid)
    rid = st["items"][1]["id"]  # Reviewer #1 的 rb-2（rb-1 是 Editor 导语条）
    # 合法锚点持久化（_norm_item 白名单不丢）
    r = _patch(c, pid, rid, comment_ids=["a1b2c3d4e5f6", "a1b2c3d4e5f6"],
               snapshot={"type": "word-version", "sha": "f" * 64, "vid": "v000012-abcdef123456"})
    assert r.status_code == 200, r.text
    it = r.json()
    assert it["comment_ids"] == ["a1b2c3d4e5f6"]  # 去重保序
    assert it["snapshot"]["vid"] == "v000012-abcdef123456"
    # latex-history 形态
    r = _patch(c, pid, rid, snapshot={"type": "latex-history", "sha": "abc123def456"})
    assert r.status_code == 200 and r.json()["snapshot"]["sha"] == "abc123def456"
    # 显式 null 清除
    r = _patch(c, pid, rid, comment_ids=None, snapshot=None)
    assert r.status_code == 200 and r.json()["comment_ids"] == [] and r.json()["snapshot"] is None
    # 非法形态 422
    assert _patch(c, pid, rid, comment_ids=["NOT-VALID!"]).status_code == 422
    assert _patch(c, pid, rid, snapshot={"type": "word-version", "sha": "f" * 64}).status_code == 422  # 缺 vid
    assert _patch(c, pid, rid, snapshot={"type": "word-version", "sha": "f" * 64, "vid": "bad"}).status_code == 422
    assert _patch(c, pid, rid, snapshot={"type": "latex-history", "sha": "xyz"}).status_code == 422
    assert _patch(c, pid, rid, snapshot={"type": "unknown-kind", "sha": "f" * 12}).status_code == 422


def test_export_contains_round_header_and_refs_anchor_line(client):
    c, projects = client
    pid = "pap1"
    st = _parse(c, pid)
    rid = st["items"][0]["id"]
    assert _patch(c, pid, rid, response="已补充动机与相关工作讨论，并修订了引言。",
                  comment_ids=["a1b2c3d4e5f6"],
                  snapshot={"type": "word-version", "sha": "f" * 64, "vid": "v000012-abcdef123456"}).status_code == 200
    assert _patch(c, pid, st["items"][1]["id"], edits_summary="修正错别字。").status_code == 200
    r = c.get(f"/api/projects/{pid}/rebuttal/export", params={"format": "md"})
    assert r.status_code == 200, r.text
    md = r.content.decode("utf-8")
    assert "**Round 1**" in md
    assert "*Refs: 关联批注 1 条（#a1b2c3d4e5f6）；快照 word-version v000012-abcdef123456*" in md
    r = c.get(f"/api/projects/{pid}/rebuttal/export", params={"format": "tex"})
    tex = r.content.decode("utf-8")
    assert "\\textbf{Round 1}" in tex
    assert "Refs: " in tex
    r = c.get(f"/api/projects/{pid}/rebuttal/export", params={"format": "docx"})
    assert r.status_code == 200 and r.content[:2] == b"PK"
    # 二次轮导出标注 Round 2
    _parse(c, pid, mode="replace")
    st2 = c.get(f"/api/projects/{pid}/rebuttal").json()
    rid2 = st2["items"][0]["id"]
    assert _patch(c, pid, rid2, response="第二轮回复。").status_code == 200
    md2 = c.get(f"/api/projects/{pid}/rebuttal/export", params={"format": "md"}).content.decode("utf-8")
    assert "**Round 2**" in md2 and "**Round 1**" not in md2
