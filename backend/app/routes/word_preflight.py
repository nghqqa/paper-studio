# -*- coding: utf-8 -*-
"""Word 投稿前检查（多规则集）：

- POST /api/projects/{pid}/word/preflight（editor）：对**当前已保存**的 document.docx
  快照生成只读检查报告并落盘。请求体可选 `{ruleset?, blind_terms?}`：
  - ruleset 缺省/空 body = jcip-preflight（完全兼容既有调用与验收脚本）；
  - 报告按规则集分文件：jcip 仍写 `.studio/word/preflight-report.json`（旧路径不变），
    其它规则集写 `.studio/word/preflight-<ruleset>.json`；
  - blind_terms 缺省取项目设置 studio.json 的 `blind_terms`（请求传入优先），
    仅 double-blind 规则集使用。
  - 快照原子性：state 与文件字节在同一个 word flock 内读取（本轮审查问题 3——
    分开读会出现"报告标 v2、实际检查 v1 字节"的错配）；锁内纯同步，不跨 await。
  - saving=true → 409（避免把旧快照报告当作当前稿件结果）。
  - 写报告前在同一锁内核对当前快照：报告对应旧快照 → expired=true 如实返回；
    已存在与当前快照一致的较新报告时，不用旧结果覆盖（并发检查序不回退）。
- GET 同路径（editor）：`?ruleset=` 返回对应规则集最近报告；不传兼容返回旧默认
  preflight-report.json + 过期判定（当前快照 vs 报告快照）。
检查本身只读：不修改 document.docx，不自动接受修订，不调用外部 AI。
规则集与判定来源见 docs/preflight-jcip-mvp.md 与 domain/word_preflight.py 模块注释。
"""
import asyncio
import hashlib
import json
import os
import time

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app import atomic, auth
from app.domain import word_documents, word_preflight

router = APIRouter(prefix="/api/projects/{pid}", tags=["word-preflight"])

REPORT_REL = os.path.join(".studio", "word", "preflight-report.json")

BLIND_TERMS_MAX = 50       # 屏蔽词条数上限
BLIND_TERM_MAX_LEN = 80    # 单个屏蔽词长度上限


class PreflightIn(BaseModel):
    """可选请求体：空 body / 不传 = 默认 jcip-preflight（兼容既有测试与脚本）。"""
    ruleset: str | None = None
    blind_terms: list[str] | None = None


def _project_dir(request: Request, pid: str) -> tuple[object, str]:
    project = request.app.state.store.get(pid)
    if project.settings.get("source_format") != "docx":
        raise HTTPException(422, {"kind": "content", "message": "投稿前检查仅支持原生 Word 项目"})
    return project, project.dir


def _report_rel(ruleset_id: str) -> str:
    """按规则集分文件；jcip 保持 MVP 旧路径（既有 GET 不带参数与预置报告测试都依赖它）。"""
    if ruleset_id == word_preflight.DEFAULT_RULESET:
        return REPORT_REL
    return os.path.join(".studio", "word", f"preflight-{ruleset_id}.json")


def _sanitize_terms(raw) -> list[str]:
    return [t.strip()[:BLIND_TERM_MAX_LEN] for t in (raw or []) if t and str(t).strip()
            ][:BLIND_TERMS_MAX]


def _snapshot(project_dir: str) -> tuple[dict, bytes, str]:
    """word 锁内原子读取：state 原始 JSON + document.docx 字节（同一份不可变版本）。"""
    with atomic.studio_lock(project_dir, "word"):
        with open(word_documents._state_path(project_dir), encoding="utf-8") as f:
            state = json.load(f)
        docx_path = os.path.join(project_dir, "document.docx")
        if not os.path.isfile(docx_path):
            raise HTTPException(422, {"kind": "content", "message": "项目没有已保存的 document.docx 快照"})
        with open(docx_path, "rb") as f:
            data = f.read()
    return state, data, docx_path


def _current_sha(project_dir: str, docx_path: str) -> str:
    """word 锁内读取当前快照 SHA（state.sha 与文件字节一致性由保存流程保证）。"""
    with atomic.studio_lock(project_dir, "word"):
        if not os.path.isfile(docx_path):
            return ""
        with open(docx_path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()


def _read_report(project_dir: str, ruleset_id: str = word_preflight.DEFAULT_RULESET) -> dict | None:
    path = os.path.join(project_dir, _report_rel(ruleset_id))
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@router.post("/word/preflight")
async def run_preflight(pid: str, request: Request, body: PreflightIn | None = None,
                        user: auth.CurrentUser = None):
    await auth.check_access(request, user, pid, "editor")
    project, project_dir = _project_dir(request, pid)
    docx_path = os.path.join(project_dir, "document.docx")

    try:
        ruleset_id, entry = word_preflight.resolve_ruleset(
            body.ruleset if body is not None else None)
    except ValueError as e:
        raise HTTPException(422, {"kind": "content", "message": str(e)})
    # 屏蔽词：请求传入优先；缺省回退项目设置（double-blind 使用，其它规则集忽略）
    terms = _sanitize_terms(body.blind_terms if body is not None else None)
    if not terms and ruleset_id == "double-blind":
        terms = _sanitize_terms(project.settings.get("blind_terms"))

    # ---- 锁内原子快照：state + 字节同一份版本（锁内纯同步，不跨 await） ----
    with atomic.studio_lock(project_dir, "word"):
        if not os.path.isfile(docx_path):
            raise HTTPException(422, {"kind": "content", "message": "项目没有已保存的 document.docx 快照"})
        with open(word_documents._state_path(project_dir), encoding="utf-8") as f:
            state = json.load(f)
        with open(docx_path, "rb") as f:
            data = f.read()
    if state.get("saving"):
        raise HTTPException(409, {"kind": "conflict",
                                  "message": "文档服务正在回传文件，请等保存完成后再运行检查（避免对旧快照出报告）"})
    version = state.get("version", 0)
    sha = hashlib.sha256(data).hexdigest()

    # ---- 锁外执行检查（纯计算，不持锁跨 await）----
    # 按模块属性名解析检查函数：测试 monkeypatch word_preflight.run_checks 等模块属性时
    # 不会被注册表里的旧引用绕过。jcip 保持原始单参调用形态（既有用例的 fake 兼容）；
    # cn-general 不需要屏蔽词；仅 double-blind 接收 blind_terms。
    check_fn = getattr(word_preflight, entry["run"])
    try:
        if ruleset_id == "double-blind":
            result = await asyncio.to_thread(check_fn, data, tuple(terms))
        else:
            result = await asyncio.to_thread(check_fn, data)
    except ValueError as e:
        raise HTTPException(422, {"kind": "content", "message": str(e)})
    report = {
        "schema": "paper-studio/word-preflight@1",
        "project_id": project.id,
        "version": version,
        "sha256": sha,
        "ruleset_id": ruleset_id,
        "ruleset_version": entry["version"],
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        **result,
    }

    # ---- 锁内：新鲜度核对 + 落盘（旧快照结果不覆盖与当前快照一致的较新报告） ----
    with atomic.studio_lock(project_dir, "word"):
        cur_sha = ""
        if os.path.isfile(docx_path):
            with open(docx_path, "rb") as f:
                cur_sha = hashlib.sha256(f.read()).hexdigest()
        expired_now = cur_sha != sha
        report_rel = _report_rel(ruleset_id)
        existing = _read_report(project_dir, ruleset_id)
        superseded = False
        skip_write = False
        if expired_now and existing and existing.get("sha256") == cur_sha:
            # 已有与当前快照一致的较新报告——保留它，不用旧快照结果回退覆盖
            superseded = True
            skip_write = True
        if not skip_write:
            atomic.write_json(os.path.join(project_dir, report_rel), report)
    return {"report": report, "expired": expired_now, "superseded": superseded,
            "current": {"version": version, "sha256": cur_sha}}


@router.get("/word/preflight")
async def get_preflight(pid: str, request: Request, ruleset: str | None = None,
                        user: auth.CurrentUser = None):
    await auth.check_access(request, user, pid, "editor")
    _, project_dir = _project_dir(request, pid)
    try:
        ruleset_id, _entry = word_preflight.resolve_ruleset(ruleset)
    except ValueError as e:
        raise HTTPException(422, {"kind": "content", "message": str(e)})
    report = _read_report(project_dir, ruleset_id)
    if report is None:
        raise HTTPException(404, {"kind": "not_found", "message": "尚未运行投稿前检查"})
    docx_path = os.path.join(project_dir, "document.docx")
    cur_sha = ""
    if os.path.isfile(docx_path):
        with open(docx_path, "rb") as f:
            cur_sha = hashlib.sha256(f.read()).hexdigest()
    with atomic.studio_lock(project_dir, "word"):
        state = json.load(open(word_documents._state_path(project_dir), encoding="utf-8"))
    current = {"version": state.get("version", 0), "sha256": cur_sha, "saving": bool(state.get("saving"))}
    expired = current["sha256"] != report.get("sha256") or current["version"] != report.get("version")
    return {"report": report, "expired": expired, "current": current}
