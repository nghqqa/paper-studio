# -*- coding: utf-8 -*-
"""工程级 Issue 清单（v1）：手动问题条目（讨论/待办/审稿意见）。

存储 `<project>/.studio/issues.jsonl`（追加写 + 按需整写；小团队规模）。
编译诊断不在其中持久化——面板把「最近构建诊断」与这里的手动 issue 合并展示，
诊断随重新编译自动消失/更新，手动 issue 用 resolved 状态跟踪闭环。
后续接 AI 审稿时，逐条建议以 kind=ai 落到这里（外发需用户显式触发）。
"""
from __future__ import annotations

import json
import os
import time
import uuid

from app import atomic
from app.domain.projects import ProjectError

ISSUES_FILE = os.path.join(".studio", "issues.jsonl")


def _path(project) -> str:
    return os.path.join(project.dir, ISSUES_FILE)


def list_issues(project) -> list[dict]:
    p = _path(project)
    if not os.path.isfile(p):
        return []
    out = []
    with open(p, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return sorted(out, key=lambda r: (r.get("status") == "resolved", -r.get("created_at", 0)))


def add_issue(project, message: str, file: str | None = None, line: int | None = None) -> dict:
    message = (message or "").strip()
    if not message:
        raise ProjectError("Issue 内容不能为空", 422)
    row = {
        "id": uuid.uuid4().hex[:12],
        "file": (file or "").strip() or None,
        "line": int(line) if line else None,
        "message": message[:2000],
        "status": "open",
        "created_at": time.time(),
        "resolved_at": None,
    }
    os.makedirs(os.path.dirname(_path(project)), exist_ok=True)
    with atomic.studio_lock(project.dir, "issues"):
        with open(_path(project), "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    return row


def set_resolved(project, issue_id: str, resolved: bool) -> dict:
    with atomic.studio_lock(project.dir, "issues"):
        rows = []
        hit = None
        p = _path(project)
        if os.path.isfile(p):
            with open(p, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    row = json.loads(line)
                    if row.get("id") == issue_id:
                        row["status"] = "resolved" if resolved else "open"
                        row["resolved_at"] = time.time() if resolved else None
                        hit = row
                    rows.append(row)
        if hit is None:
            raise ProjectError("Issue 不存在", 404)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8", newline="") as f:
            for row in rows:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        os.replace(tmp, p)
        return hit


def delete_issue(project, issue_id: str) -> None:
    with atomic.studio_lock(project.dir, "issues"):
        rows = []
        p = _path(project)
        found = False
        if os.path.isfile(p):
            with open(p, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    row = json.loads(line)
                    if row.get("id") == issue_id:
                        found = True
                        continue
                    rows.append(row)
        if not found:
            raise ProjectError("Issue 不存在", 404)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8", newline="") as f:
            for row in rows:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        os.replace(tmp, p)
