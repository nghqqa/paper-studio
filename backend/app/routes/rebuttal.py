# -*- coding: utf-8 -*-
"""P1-1 审稿回复信（Response Letter）路由：/api/projects/{pid}/rebuttal。

GET  /rebuttal                        状态查看（viewer；非 paper 项目 ⇒ 400）
POST /rebuttal/parse                  确定性拆条（editor）：JSON {text, mode?} 或 multipart {file, mode?}
                                      .txt/.md UTF-8 直解；.pdf 走 pypdf 文字层，扫描件 ⇒ 422 no_text（不 OCR）
PUT  /rebuttal/items/{item_id}        更新 status / location / response / edits_summary（editor）
POST /rebuttal/items/{item_id}/draft  AI 起草建议存 ai_draft（editor；require_org_ai + user_ai；绝不覆盖用户 response）
GET  /rebuttal/export?format=         导出 Response Letter（viewer；无条目/无回复 ⇒ 409）

权限：main.py 的 ACL 依赖按方法判定（GET viewer / 写 editor），本文件不另设；
服务在 app.domain.rebuttal；RebuttalError → HTTP {status} {detail: {kind, message, detail}}。
"""

import asyncio
import json
import os
import urllib.parse

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ValidationError

from app import auth, config
from app.ai import client as ai_client
from app.domain import rebuttal as rb
from app.domain import user_ai
from app.domain.org import require_org_ai
from app.domain.projects import ATTACHMENT_MAX_BYTES, ProjectError
from app.errors import error_detail
from app.routes import read_bounded

router = APIRouter(prefix="/api/projects/{pid}", tags=["rebuttal"])
UNIT = "P1-1-rebuttal"
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
_MIME = {"docx": DOCX_MIME, "md": "text/markdown; charset=utf-8", "tex": "application/x-tex; charset=utf-8"}
_TEXT_SUFFIXES = (".txt", ".md", ".markdown")


class RebuttalParseIn(BaseModel):
    text: str
    mode: str = "replace"


class RebuttalItemPatch(BaseModel):
    status: str | None = None
    location: dict | None = None
    response: str | None = None
    edits_summary: str | None = None
    # B3 锚点（可选）：平台批注 id 列表 + 已保存版本快照；显式传 null 表示清除
    comment_ids: list[str] | None = None
    snapshot: dict | None = None


class RebuttalDraftIn(BaseModel):
    context: str | None = None


def _run(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except rb.RebuttalError as e:
        raise HTTPException(e.status, error_detail(e.kind, str(e), detail=UNIT))


def _paper_project(request: Request, pid: str):
    """项目取用 + paper 门槛：document_type != "paper" ⇒ 400 project（patent/未设置一律拒绝）。"""
    try:
        p = request.app.state.store.get(pid)
    except ProjectError as e:
        raise HTTPException(e.status, error_detail("project", str(e)))
    if p.settings.get("document_type") != "paper":
        raise HTTPException(
            400, error_detail("project", "审稿回复信仅支持论文（paper）项目，当前项目不是 paper 类型", detail=UNIT)
        )
    return p


def _disposition(filename: str) -> str:
    """ASCII 兜底 + RFC 5987 双写法（attachments 同口径），浏览器与 downloadFile 都能稳定解析。"""
    ascii_name = filename if filename.isascii() else "response-letter" + os.path.splitext(filename)[1]
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{urllib.parse.quote(filename)}"


async def _review_text(request: Request) -> tuple[str, str]:
    """→ (审稿意见文本, mode)：multipart 走 {file, mode}，其余按 JSON {text, mode}。"""
    if request.headers.get("content-type", "").startswith("multipart/form-data"):
        form = await request.form()
        f = form.get("file")
        if f is None or isinstance(f, str):
            raise HTTPException(422, error_detail("validation", "缺少审稿意见文件字段 file", detail=UNIT))
        mode = form.get("mode") if isinstance(form.get("mode"), str) and form.get("mode") else "replace"
        suffix = os.path.splitext(f.filename or "")[1].lower()
        data = await read_bounded(f, "rebuttal", ATTACHMENT_MAX_BYTES)
        if suffix == ".pdf":
            try:
                return rb.pdf_text(data), mode
            except rb.NoTextLayer as e:
                raise HTTPException(
                    422,
                    error_detail("no_text", f"{e}，请上传带文字层的 PDF 或直接粘贴审稿意见文本", detail=UNIT),
                )
        if suffix in _TEXT_SUFFIXES:
            try:
                return data.decode("utf-8"), mode
            except UnicodeDecodeError as e:
                raise HTTPException(
                    422, error_detail("validation", "审稿意见文本文件需为 UTF-8 编码", detail=UNIT)
                ) from e
        raise HTTPException(422, error_detail("validation", "仅支持 .txt / .md / .pdf 审稿意见文件", detail=UNIT))
    try:
        body = RebuttalParseIn.model_validate(await request.json())
    except ValidationError as e:
        raise RequestValidationError(e.errors())
    return body.text, body.mode


@router.get("/rebuttal")
def get_rebuttal(pid: str, request: Request):
    """→ {updated_at, round, items[], warnings[]}；无记录返回空状态。"""
    p = _paper_project(request, pid)
    return _run(rb.load_state, p.dir)


@router.post("/rebuttal/parse")
async def rebuttal_parse(pid: str, request: Request):
    """确定性拆条（不需 AI）：replace ⇒ round+1 整表替换；append ⇒ 按当前 round 追加。"""
    p = _paper_project(request, pid)
    text, mode = await _review_text(request)
    parsed, warnings = rb.parse_review_comments(text)
    st = _run(rb.import_comments, p.dir, parsed, warnings, mode)
    return {"round": st["round"], "items": st["items"], "warnings": st["warnings"], "updated_at": st["updated_at"]}


@router.put("/rebuttal/items/{item_id}")
def rebuttal_update(pid: str, item_id: str, body: RebuttalItemPatch, request: Request):
    """局部更新条目；location/comment_ids/snapshot 显式传 null 表示清除。→ 更新后的条目。"""
    p = _paper_project(request, pid)
    return _run(rb.update_item, p.dir, item_id, body.model_dump(exclude_unset=True))


@router.get("/rebuttal/rounds")
def rebuttal_rounds(pid: str, request: Request):
    """历史轮只读清单（B3 多轮归档；不含当前活跃轮）。"""
    p = _paper_project(request, pid)
    return _run(rb.list_rounds, p.dir)


@router.get("/rebuttal/rounds/{n}")
def rebuttal_round_detail(pid: str, n: int, request: Request):
    """单轮归档只读详情（严格只读，不做 restore）。"""
    p = _paper_project(request, pid)
    return _run(rb.load_round, p.dir, n)


@router.post("/rebuttal/items/{item_id}/draft", dependencies=[Depends(require_org_ai)])
async def rebuttal_draft(
    pid: str, item_id: str, body: RebuttalDraftIn, request: Request, user: auth.CurrentUser = None
):
    """AI 起草单条回复建议 → {item, warnings}；只写 ai_draft，用户 response 不动，稿件零接触。"""
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    store = request.app.state.store
    _paper_project(request, pid)
    provider, _source = user_ai.resolve_provider(getattr(user, "id", None))
    if provider is not None and provider.api_key:
        ai_cli, _ = user_ai.resolve_ai_client(user)
    elif config.AI_PROVIDER == "mock":
        ai_cli = request.app.state.ai
    else:
        ai_cli, _ = user_ai.resolve_ai_client(user)
    try:
        item, warnings = await rb.generate_draft(store, pid, ai_cli, item_id, body.context)
    except rb.RebuttalError as e:
        raise HTTPException(e.status, error_detail(e.kind, str(e), detail=UNIT))
    return {"item": item, "warnings": warnings}


@router.post("/rebuttal/items/{item_id}/draft/stream", dependencies=[Depends(require_org_ai)])
async def rebuttal_draft_stream(
    pid: str, item_id: str, body: RebuttalDraftIn, request: Request, user: auth.CurrentUser = None
):
    """AI 起草单条回复建议（SSE 流式输出）；只写 ai_draft，绝不覆盖用户 response。"""
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    store = request.app.state.store
    _paper_project(request, pid)
    provider, _source = user_ai.resolve_provider(getattr(user, "id", None))
    if provider is not None and provider.api_key:
        ai_cli, _ = user_ai.resolve_ai_client(user)
    elif config.AI_PROVIDER == "mock":
        ai_cli = request.app.state.ai
    else:
        ai_cli, _ = user_ai.resolve_ai_client(user)
    try:
        project_dir, messages, expected_round = rb.prepare_draft_context_with_round(store, pid, item_id, body.context)
    except rb.RebuttalError as e:
        raise HTTPException(e.status, error_detail(e.kind, str(e), detail=UNIT))

    try:
        try:
            res = await ai_cli.chat(messages, "interactive", stream=True, project_dir=project_dir)
        except TypeError:
            res = await ai_cli.chat(messages, "interactive", project_dir=project_dir)
    except ai_client.AiError as e:
        raise HTTPException(e.status or 502, error_detail(f"ai_{e.kind}", str(e), detail=UNIT))

    def _ev(name: str, data: dict) -> str:
        return f"event: {name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

    async def event_iter():
        try:
            parts: list[str] = []
            if hasattr(res, "__aiter__"):
                async for chunk in res:
                    if chunk:
                        parts.append(chunk)
                        yield _ev("delta", {"text": chunk})
                chat_res = getattr(res, "result", None)
                full_text = chat_res.text if chat_res is not None and getattr(chat_res, "text", None) else "".join(parts)
            else:
                full_text = str(getattr(res, "text", "") or "")
                if full_text:
                    yield _ev("delta", {"text": full_text})
            resp, summ, warnings = rb._parse_draft_response(full_text)
            item = rb.save_draft_result(project_dir, item_id, resp, summ, expected_round=expected_round)
            yield _ev("done", {"item": item, "warnings": warnings})
        except (ai_client.AiError, rb.RebuttalError) as e:
            yield _ev("error", {"message": str(e)})
        except HTTPException as e:
            detail = e.detail if isinstance(e.detail, dict) else {}
            yield _ev("error", {"message": str(detail.get("message") or e.detail or "生成失败")})
        except Exception as e:  # noqa: BLE001
            yield _ev("error", {"message": str(e)})
        finally:
            aclose = getattr(res, "aclose", None)
            if aclose is not None:
                try:
                    await aclose()
                except Exception:  # noqa: BLE001
                    pass

    return StreamingResponse(
        event_iter(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.get("/rebuttal/export")
async def rebuttal_export(pid: str, request: Request, fmt: str = Query("docx", alias="format")):
    """导出 Response Letter；Content-Disposition 双写法（ASCII 兜底 + RFC 5987）。"""
    p = _paper_project(request, pid)
    st = _run(rb.load_state, p.dir)
    data = await asyncio.to_thread(_run, rb.export_letter, {"title": p.title}, st, fmt)
    name = f"回复信-{p.title}.{fmt}" if (p.title or "").strip() else f"response-letter.{fmt}"
    return Response(
        data,
        media_type=_MIME[fmt],
        headers={"Content-Disposition": _disposition(name), "Cache-Control": "no-store"},
    )
