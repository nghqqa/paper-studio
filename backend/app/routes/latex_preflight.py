# -*- coding: utf-8 -*-
"""LaTeX 工程投稿前检查路由（只读 MVP）：

- POST /api/projects/{pid}/latex/preflight（editor）：基于**当前工程源文件**生成只读
  检查报告并落盘 `.studio/latex/preflight-<ruleset>.json`。请求体可选
  `{ruleset?, blind_terms?}`（缺省 latex-general；blind_terms 缺省取项目设置）。
  报告绑定全部被扫描 .tex/.bib 的内容哈希（digest/digest_sha）——写盘前重新核对
  当前指纹，源文件在检查期间变化 → expired=true 如实返回（旧指纹结果不覆盖
  与当前一致的较新报告，与 word/preflight 同款并发语义）。
- GET 同路径（editor）：`?ruleset=` 返回对应规则集最近报告 + 过期判定
  （当前指纹 vs 报告指纹；无历史报告 404，前端显示"未运行"）。
检查只读：不修改任何 .tex/.bib 源文件，不调用外部 AI。规则集见 domain/latex_preflight.py。
"""
import asyncio
import json
import os
import time

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app import atomic, auth
from app.domain import latex_build, latex_preflight
from app.domain.projects import ProjectError

router = APIRouter(prefix="/api/projects/{pid}", tags=["latex-preflight"])

BLIND_TERMS_MAX = 50       # 屏蔽词条数上限
BLIND_TERM_MAX_LEN = 80    # 单个屏蔽词长度上限


class PreflightIn(BaseModel):
    """可选请求体：空 body / 不传 = 默认 latex-general。"""
    ruleset: str | None = None
    blind_terms: list[str] | None = None


def _project(request: Request, pid: str):
    store = request.app.state.store
    try:
        return latex_build._require_latex_project(store, pid)
    except ProjectError as e:
        raise HTTPException(e.status, {"kind": "content", "message": str(e)})


def _report_path(project_dir: str, ruleset_id: str) -> str:
    return os.path.join(project_dir, ".studio", "latex", f"preflight-{ruleset_id}.json")


def _sanitize_terms(raw) -> list[str]:
    return [t.strip()[:BLIND_TERM_MAX_LEN] for t in (raw or []) if t and str(t).strip()
            ][:BLIND_TERMS_MAX]


def _current_fingerprint(project, ruleset_id: str) -> str:
    """当前源码指纹——必须与报告绑定同一范围口径（规则集 scope），
    否则 double-blind（只扫 .tex）的报告会被 .bib 变化误判为恒过期。"""
    import hashlib

    scope = latex_preflight.RULESETS[ruleset_id]["scope"]
    digest, _lines, _error = latex_preflight._scan_files(project, scope)
    if ruleset_id in ("latex-general", "submission-readiness"):
        gl_path = os.path.join(project.dir, ".studio", "glossary.json")
        if os.path.isfile(gl_path):
            try:
                with open(gl_path, "rb") as f:
                    digest[".studio/glossary.json"] = hashlib.sha256(f.read()).hexdigest()
            except OSError:
                pass
    return latex_preflight.digest_fingerprint(digest)


def _read_report(project_dir: str, ruleset_id: str) -> dict | None:
    path = _report_path(project_dir, ruleset_id)
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@router.post("/latex/preflight")
async def run_latex_preflight(pid: str, request: Request, body: PreflightIn | None = None,
                              user: auth.CurrentUser = None):
    await auth.check_access(request, user, pid, "editor")
    project = _project(request, pid)
    try:
        ruleset_id, entry = latex_preflight.resolve_ruleset(
            body.ruleset if body is not None else None)
    except ValueError as e:
        raise HTTPException(422, {"kind": "content", "message": str(e)})
    # 屏蔽词：请求传入优先；缺省回退项目设置（double-blind 使用，其它规则集忽略）
    terms = _sanitize_terms(body.blind_terms if body is not None else None)
    if not terms and ruleset_id == "double-blind":
        terms = _sanitize_terms(project.settings.get("blind_terms"))

    # ---- 锁外执行检查（纯读源文件，不持锁跨 await；latex 源文件无 word 级 flock） ----
    # 按模块属性名解析检查函数：测试 monkeypatch 模块属性时不被绕过
    check_fn = getattr(latex_preflight, entry["run"])
    try:
        result = await asyncio.to_thread(check_fn, project, tuple(terms))
    except ValueError as e:
        raise HTTPException(422, {"kind": "content", "message": str(e)})
    report = {
        "schema": "paper-studio/latex-preflight@1",
        "project_id": project.id,
        "ruleset_id": ruleset_id,
        "ruleset_version": entry["version"],
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        **result,
    }

    # ---- 写盘前核对当前指纹：检查期间源码变化 → expired=true 如实返回 ----
    cur_fingerprint = await asyncio.to_thread(_current_fingerprint, project, ruleset_id)
    expired_now = cur_fingerprint != report.get("digest_sha")
    report_path = _report_path(project.dir, ruleset_id)
    existing = _read_report(project.dir, ruleset_id)
    superseded = False
    if expired_now and existing and existing.get("digest_sha") == cur_fingerprint:
        # 已有与当前源码一致的较新报告——保留它，不用旧结果回退覆盖
        superseded = True
    else:
        os.makedirs(os.path.dirname(report_path), exist_ok=True)
        atomic.write_json(report_path, report)
    return {"report": report, "expired": expired_now, "superseded": superseded,
            "current": {"digest_sha": cur_fingerprint}}


@router.get("/latex/preflight")
async def get_latex_preflight(pid: str, request: Request, ruleset: str | None = None,
                              user: auth.CurrentUser = None):
    await auth.check_access(request, user, pid, "editor")
    project = _project(request, pid)
    try:
        ruleset_id, _entry = latex_preflight.resolve_ruleset(ruleset)
    except ValueError as e:
        raise HTTPException(422, {"kind": "content", "message": str(e)})
    report = _read_report(project.dir, ruleset_id)
    if report is None:
        raise HTTPException(404, {"kind": "not_found", "message": "尚未运行投稿前检查"})
    cur_fingerprint = await asyncio.to_thread(_current_fingerprint, project, ruleset_id)
    expired = cur_fingerprint != report.get("digest_sha")
    return {"report": report, "expired": expired, "current": {"digest_sha": cur_fingerprint}}
