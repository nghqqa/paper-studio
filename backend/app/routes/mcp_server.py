# -*- coding: utf-8 -*-
"""Paper Studio 原生 MCP Server（POST /api/mcp，JSON-RPC 2.0 Streamable HTTP）。

核心安全红线（Proposal-Only Contract）：
- 鉴权复用 auth.CurrentUser（Cookie 或 `Authorization: Bearer ps_pat_...`），AUTH=on 未认证一律 401；
- 所有项目级工具与资源内部强制调用 `auth.check_access(request, user, pid, role)` 校验成员权限；
- MCP 工具绝不静默改写 `.tex` / `.docx` 稿件文件；所有文本改写建议一律通过
  `paper_proposals.append(..., status="pending")` 进入人工 diff 确认队列。
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from app import auth, config
from app.domain import comments as comments_mod
from app.domain import events, latex_build, latex_preflight
from app.domain import glossary as glossary_mod
from app.domain import library as library_mod
from app.domain import paper_proposals as pp
from app.domain import rebuttal as rebuttal_mod
from app.domain.projects import ProjectError

router = APIRouter(tags=["mcp"])

_PROTOCOL_VERSION = "2025-03-26"

_TOOLS: list[dict[str, Any]] = [
    {
        "name": "paper_list_projects",
        "description": "列出当前账号可见的论文项目（含标题、格式、写作阶段与投稿目标）。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "paper_list_files",
        "description": "列出 LaTeX 论文工程的源文件目录结构。",
        "inputSchema": {
            "type": "object",
            "required": ["pid"],
            "properties": {"pid": {"type": "string", "description": "项目 ID"}},
        },
    },
    {
        "name": "paper_read_file",
        "description": "读取 LaTeX 工程中的文本文件内容及最新 SHA 校验码（只读）。",
        "inputSchema": {
            "type": "object",
            "required": ["pid", "path"],
            "properties": {
                "pid": {"type": "string"},
                "path": {"type": "string", "description": "相对工程根目录的文件路径，如 main.tex"},
            },
        },
    },
    {
        "name": "paper_get_library",
        "description": "获取项目文献库索引与 citation_key 列表（只读）。",
        "inputSchema": {
            "type": "object",
            "required": ["pid"],
            "properties": {"pid": {"type": "string"}},
        },
    },
    {
        "name": "paper_get_glossary",
        "description": "获取项目术语表、符号规范与禁止别名表（只读）。",
        "inputSchema": {
            "type": "object",
            "required": ["pid"],
            "properties": {"pid": {"type": "string"}},
        },
    },
    {
        "name": "paper_get_rebuttal",
        "description": "获取项目审稿意见拆条与回复信状态列表（只读）。",
        "inputSchema": {
            "type": "object",
            "required": ["pid"],
            "properties": {"pid": {"type": "string"}},
        },
    },
    {
        "name": "paper_run_preflight",
        "description": "对 LaTeX 工程执行确定性投稿前检查（latex-general / double-blind / submission-readiness）。",
        "inputSchema": {
            "type": "object",
            "required": ["pid"],
            "properties": {
                "pid": {"type": "string"},
                "ruleset": {
                    "type": "string",
                    "enum": ["latex-general", "double-blind", "submission-readiness"],
                    "default": "latex-general",
                },
            },
        },
    },
    {
        "name": "paper_list_proposals",
        "description": "列出论文待审阅或已处理的 AI/Agent 修改提案（只读）。",
        "inputSchema": {
            "type": "object",
            "required": ["pid"],
            "properties": {
                "pid": {"type": "string"},
                "status": {"type": "string"},
            },
        },
    },
    {
        "name": "paper_create_proposal",
        "description": "向指定论文提交一条待人工确认的修改提案（严禁直接覆盖源码；必须由作者在工作台 Diff 面板点击采纳）。",
        "inputSchema": {
            "type": "object",
            "required": ["pid", "file", "original_text", "suggested_text"],
            "properties": {
                "pid": {"type": "string"},
                "file": {"type": "string", "description": "如 main.tex 或 document.docx"},
                "mode": {"type": "string", "enum": ["latex", "word"], "default": "latex"},
                "action": {
                    "type": "string",
                    "enum": ["polish", "academic", "condense", "expand", "custom", "deai", "writing", "translate_en", "translate_zh"],
                    "default": "custom",
                },
                "original_text": {"type": "string"},
                "suggested_text": {"type": "string"},
                "rationale": {"type": "string"},
                "instruction": {"type": "string"},
                "insert": {"type": "boolean", "default": False},
            },
        },
    },
    {
        "name": "paper_add_comment",
        "description": "向论文文件指定行或段落添加一条审阅批注。",
        "inputSchema": {
            "type": "object",
            "required": ["pid", "file", "body"],
            "properties": {
                "pid": {"type": "string"},
                "file": {"type": "string"},
                "line": {"type": "integer"},
                "quote": {"type": "string"},
                "body": {"type": "string"},
            },
        },
    },
    {
        "name": "paper_upsert_glossary",
        "description": "新增或更新项目术语表/符号表条目。",
        "inputSchema": {
            "type": "object",
            "required": ["pid", "term"],
            "properties": {
                "pid": {"type": "string"},
                "term": {"type": "string"},
                "category": {"type": "string", "enum": ["term", "notation", "acronym"], "default": "term"},
                "symbol": {"type": "string"},
                "aliases": {"type": "array", "items": {"type": "string"}},
                "definition": {"type": "string"},
                "enforce": {"type": "boolean", "default": True},
            },
        },
    },
]


def _ok(req_id: Any, result: dict) -> JSONResponse:
    return JSONResponse({"jsonrpc": "2.0", "id": req_id, "result": result})


def _err(req_id: Any, code: int, message: str, data: Any = None) -> JSONResponse:
    err: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return JSONResponse({"jsonrpc": "2.0", "id": req_id, "error": err})


def _tool_result(payload: Any, is_error: bool = False) -> dict:
    return {
        "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False, indent=2)}],
        "structuredContent": payload if isinstance(payload, dict) else {"data": payload},
        "isError": is_error,
    }


def _list_projects(store) -> list[dict]:
    out: list[dict] = []
    for pid in store.list_ids():
        try:
            p = store.get(pid)
        except Exception:  # noqa: BLE001
            continue
        out.append({
            "id": p.id,
            "title": p.title,
            "source_format": p.settings.get("source_format", "markdown"),
        })
    return out


def _check_pat_scope(request: Request, need_scope: str) -> None:
    scopes = getattr(request.state, "pat_scopes", None)
    if scopes is not None and need_scope not in scopes:
        raise auth.forbidden(need_scope)


async def _call_tool(request: Request, user, name: str, args: dict[str, Any]) -> dict:
    store = request.app.state.store

    if name == "paper_list_projects":
        _check_pat_scope(request, "read")
        all_projects = await asyncio.to_thread(_list_projects, store)
        allowed = set(await auth.visible_pids(user, [p["id"] for p in all_projects]))
        items = [p for p in all_projects if p["id"] in allowed]
        return _tool_result({"projects": items})

    pid = str(args.get("pid") or "").strip()
    if not pid:
        return _tool_result({"error": "缺少必填参数 pid"}, is_error=True)

    if name == "paper_list_files":
        _check_pat_scope(request, "read")
        await auth.check_access(request, user, pid, "viewer")
        proj = store.get(pid)
        files = await asyncio.to_thread(latex_build.list_source_files, proj)
        return _tool_result({"files": files})

    if name == "paper_read_file":
        _check_pat_scope(request, "read")
        await auth.check_access(request, user, pid, "viewer")
        proj = store.get(pid)
        rel = str(args.get("path") or "").strip()
        content = await asyncio.to_thread(latex_build.read_source_file, proj, rel)
        sha = await asyncio.to_thread(latex_build.source_file_sha, proj, rel)
        return _tool_result({"path": rel, "sha": sha, "content": content})

    if name == "paper_get_library":
        _check_pat_scope(request, "read")
        await auth.check_access(request, user, pid, "viewer")
        proj = store.get(pid)
        idx = await asyncio.to_thread(library_mod.load_index, proj.dir)
        return _tool_result({"entries": [e.model_dump(mode="json") for e in idx.entries]})

    if name == "paper_get_glossary":
        _check_pat_scope(request, "read")
        await auth.check_access(request, user, pid, "viewer")
        proj = store.get(pid)
        entries = await asyncio.to_thread(glossary_mod.list_entries, proj.dir)
        return _tool_result({"entries": entries})

    if name == "paper_get_rebuttal":
        _check_pat_scope(request, "read")
        await auth.check_access(request, user, pid, "viewer")
        proj = store.get(pid)
        state = await asyncio.to_thread(rebuttal_mod.load_state, proj.dir)
        return _tool_result(state)

    if name == "paper_run_preflight":
        _check_pat_scope(request, "read")
        await auth.check_access(request, user, pid, "viewer")
        proj = store.get(pid)
        ruleset = str(args.get("ruleset") or "latex-general")
        rid, entry = latex_preflight.resolve_ruleset(ruleset)
        fn = getattr(latex_preflight, entry["run"])
        terms = tuple(proj.settings.get("blind_terms") or ()) if rid == "double-blind" else ()
        res = await asyncio.to_thread(fn, proj, terms)
        return _tool_result({"ruleset_id": rid, "report": res})

    if name == "paper_list_proposals":
        _check_pat_scope(request, "read")
        await auth.check_access(request, user, pid, "viewer")
        proj = store.get(pid)
        status = args.get("status")
        props = await asyncio.to_thread(pp.load, proj.dir, pid, status=status)
        return _tool_result({"proposals": [p.model_dump(mode="json") for p in props]})

    if name == "paper_create_proposal":
        _check_pat_scope(request, "propose")
        await auth.check_access(request, user, pid, "editor")
        proj = store.get(pid)
        file_path = str(args.get("file") or "").strip()
        mode = str(args.get("mode") or ("word" if proj.settings.get("source_format") == "docx" else "latex"))
        if mode not in ("latex", "word"):
            return _tool_result({"error": f"不支持的 mode：{mode}（仅支持 latex / word）"}, is_error=True)
        action = str(args.get("action") or "custom")
        if action not in pp.ACTION_LABELS:
            action = "custom"
        orig = str(args.get("original_text") or "")
        sug = str(args.get("suggested_text") or "").strip()
        instr = str(args.get("instruction") or "")
        if not file_path or not sug:
            return _tool_result({"error": "file 与 suggested_text 不能为空"}, is_error=True)
        if len(file_path) > 400 or len(orig) > 8000 or len(sug) > 10000 or len(instr) > 500:
            return _tool_result({"error": "file / original_text / suggested_text / instruction 长度超限"}, is_error=True)
        insert_mode = bool(args.get("insert", False)) or (action == "writing")
        if mode == "latex":
            base_sha = await asyncio.to_thread(latex_build.source_file_sha, proj, file_path)
            if base_sha is None:
                return _tool_result({"error": f"文件不存在或路径非法：{file_path}"}, is_error=True)
        else:
            base_sha = ""
        who = getattr(user, "email", None) or (str(getattr(user, "id", "")) if user else "mcp-agent")
        flags = pp.analyze_changes(orig, sug)
        prop = pp.Proposal(
            proposal_id=pp.new_id(),
            mode=mode,  # type: ignore[arg-type]
            action=action,  # type: ignore[arg-type]
            instruction=instr or None,
            anchor=pp.Anchor(
                file=file_path,
                base_sha=base_sha,
                original_text=orig,
                insert=insert_mode,
            ),
            suggested_text=sug,
            rationale=str(args.get("rationale") or "由外部 MCP Agent 提交的待确认修改提案")[:600],
            model="mcp-agent",
            created_by=who,
            status="pending",
            protection_flags=flags,
            updated_at=time.time(),
        )
        await asyncio.to_thread(pp.append, proj.dir, pid, prop, by=who)
        return _tool_result({
            "proposal": prop.model_dump(mode="json"),
            "contract": "proposal_only: pending human review in workbench diff panel",
        })

    if name == "paper_add_comment":
        _check_pat_scope(request, "propose")
        await auth.check_access(request, user, pid, "viewer")
        proj = store.get(pid)
        file_path = str(args.get("file") or "").strip()
        body_text = str(args.get("body") or "").strip()
        if not file_path or not body_text:
            return _tool_result({"error": "file 与 body 不能为空"}, is_error=True)
        if len(file_path) > 400 or len(body_text) > 4000:
            return _tool_result({"error": "file 或 body 长度超限（body 上限 4000 字）"}, is_error=True)
        try:
            line_val = int(args["line"]) if args.get("line") is not None else 0
        except (TypeError, ValueError):
            return _tool_result({"error": "line 必须是整数"}, is_error=True)
        if line_val < 0:
            return _tool_result({"error": "line 不能为负数"}, is_error=True)
        quote_val = str(args.get("quote") or "")[:400]
        anchor_sha: str | None = None
        if proj.settings.get("source_format") == "latex":
            resolved = latex_build.resolve_source_path(proj, file_path)
            if not os.path.isfile(resolved):
                return _tool_result({"error": f"文件不存在：{file_path}"}, is_error=True)
            anchor_sha = await asyncio.to_thread(latex_build.source_file_sha, proj, file_path)
        author = (
            comments_mod.LOCAL_AUTHOR
            if user is None
            else comments_mod.Author(id=str(user.id), name=user.display_name or user.email)
        )
        anchor = comments_mod.Anchor(file=file_path, line=line_val, quote=quote_val, sha=anchor_sha)
        comment = comments_mod.create(anchor, body_text, author, source="ai")

        def _append_comment() -> None:
            with comments_mod.file_lock(proj.dir):
                lst = comments_mod.load(proj.dir)
                lst.append(comment)
                comments_mod.save(proj.dir, lst)

        async with comments_mod.ledger_lock(proj.dir):
            await asyncio.to_thread(_append_comment)
        events.emit(
            "comment.created",
            pid=pid,
            actor=events.actor_of(user),
            data={"cid": comment.id, "reply_id": None, "is_reply": False, "snippet": body_text[:120], "mentioned_ids": []},
        )
        return _tool_result({"comment": comment.to_dict()})

    if name == "paper_upsert_glossary":
        _check_pat_scope(request, "propose")
        await auth.check_access(request, user, pid, "editor")
        proj = store.get(pid)
        saved, _all = await asyncio.to_thread(glossary_mod.upsert_entry, proj.dir, args)
        return _tool_result({"entry": saved})

    return _tool_result({"error": f"未知 MCP 工具：{name}"}, is_error=True)


@router.post("/api/mcp")
async def mcp_endpoint(request: Request, user: auth.CurrentUser = None):
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    try:
        msg = await request.json()
    except (ValueError, UnicodeError):
        return _err(None, -32700, "Invalid JSON payload")
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or "method" not in msg:
        return _err(msg.get("id") if isinstance(msg, dict) else None, -32600, "Invalid JSON-RPC 2.0 request")

    if "id" not in msg:
        return Response(status_code=202)
    req_id = msg.get("id")
    method = str(msg["method"])
    params = msg.get("params") if isinstance(msg.get("params"), dict) else {}

    if method == "initialize":
        return _ok(
            req_id,
            {
                "protocolVersion": _PROTOCOL_VERSION,
                "capabilities": {"tools": {}, "resources": {}},
                "serverInfo": {"name": "paper-studio-mcp", "version": "1.0.0"},
            },
        )
    if method in ("notifications/initialized", "ping"):
        return _ok(req_id, {})
    if method == "tools/list":
        _check_pat_scope(request, "read")
        return _ok(req_id, {"tools": _TOOLS})
    if method == "tools/call":
        t_name = str(params.get("name") or "")
        t_args = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        try:
            res = await _call_tool(request, user, t_name, t_args)
            return _ok(req_id, res)
        except Exception as exc:  # noqa: BLE001
            detail = getattr(exc, "detail", None)
            err_msg = detail.get("message") if isinstance(detail, dict) else str(getattr(exc, "message", exc))
            if getattr(exc, "status_code", None) in (401, 403, 404):
                raise
            return _ok(req_id, _tool_result({"error": err_msg}, is_error=True))
    if method == "resources/list":
        _check_pat_scope(request, "read")
        return _ok(
            req_id,
            {
                "resources": [
                    {
                        "uri": "paper://projects",
                        "name": "visible-paper-projects",
                        "description": "当前账号可访问的论文项目清单",
                        "mimeType": "application/json",
                    }
                ]
            },
        )
    if method == "resources/read":
        _check_pat_scope(request, "read")
        uri = str(params.get("uri") or "")
        if uri == "paper://projects":
            store = request.app.state.store
            all_projects = await asyncio.to_thread(_list_projects, store)
            allowed = set(await auth.visible_pids(user, [p["id"] for p in all_projects]))
            data = [p for p in all_projects if p["id"] in allowed]
            return _ok(
                req_id,
                {"contents": [{"uri": uri, "mimeType": "application/json", "text": json.dumps(data, ensure_ascii=False)}]},
            )
        if uri.startswith("paper://project/"):
            rest = uri[len("paper://project/") :]
            if "/files/" in rest:
                pid, rel = rest.split("/files/", 1)
                await auth.check_access(request, user, pid, "viewer")
                try:
                    proj = request.app.state.store.get(pid)
                    content = await asyncio.to_thread(latex_build.read_source_file, proj, rel)
                except ProjectError as exc:
                    return _err(req_id, -32002, str(exc))
                return _ok(
                    req_id,
                    {"contents": [{"uri": uri, "mimeType": "text/plain; charset=utf-8", "text": content}]},
                )
        return _err(req_id, -32602, f"Unsupported resource URI: {uri}")

    return _err(req_id, -32601, f"Method not found: {method}")
