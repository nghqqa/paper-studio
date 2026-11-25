"""Platform administrators publish Word/LaTeX assets; ordinary authors only read."""
import asyncio
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, Field, ValidationError

from app import auth, config
from app.domain import events, paper_templates
from app.domain.projects import ProjectError


async def require_admin(user: auth.CurrentUser):
    if not config.AUTH_ON:
        raise ProjectError("请先启用账号系统并使用平台管理员登录，再管理模板库", 503)
    if user is None:
        raise auth.login_required()
    if not user.is_superuser:
        raise auth.forbidden_superuser()


router = APIRouter(prefix="/api/admin/paper-templates", tags=["paper-templates"], dependencies=[Depends(require_admin)])

# 作者端只读路由（缩略图）：登录态保护（AUTH off 放行），与 main.py 的 /api/paper-templates 目录同语义。
author_router = APIRouter(prefix="/api/paper-templates", tags=["paper-templates"],
                          dependencies=[Depends(auth.require_login)])


class TemplateIn(BaseModel):
    format: Literal["docx", "latex"]
    name: str = Field(min_length=1, max_length=120)
    desc: str = Field(default="", max_length=500)
    language: str = Field(default="中文", max_length=40)
    kind: str = Field(default="期刊", max_length=40)
    venue: str = Field(default="", max_length=200)
    year: str = Field(default="", max_length=20)
    main: str = Field(default="", max_length=240)
    engine: Literal["pdflatex", "xelatex"] = "xelatex"


class TemplatePatchIn(BaseModel):
    """PATCH 部分更新：全部可选，None/缺省 = 不修改；兼容旧 {"enabled": bool} 体。"""
    name: str | None = Field(default=None, min_length=1, max_length=120)
    desc: str | None = Field(default=None, max_length=500)
    language: str | None = Field(default=None, max_length=40)
    kind: str | None = Field(default=None, max_length=40)
    venue: str | None = Field(default=None, max_length=200)
    year: str | None = Field(default=None, max_length=20)
    main: str | None = Field(default=None, max_length=240)
    engine: Literal["pdflatex", "xelatex"] | None = None
    enabled: bool | None = None


class ReplaceMetaIn(BaseModel):
    """PUT 替换版本的可选元数据：缺省沿用现值；main 传 "" = 对新包自动检测。"""
    main: str | None = Field(default=None, max_length=240)
    engine: Literal["pdflatex", "xelatex"] | None = None


@router.get("")
async def list_templates():
    rows = await asyncio.to_thread(paper_templates.all_templates)
    # verify_log_tail（编译日志尾部）只在管理端可见：作者目录的 public() 白名单不含它。
    items = [{**paper_templates.public(t), "verify_log_tail": t.get("verify_log_tail")} for t in rows]
    return {"items": items, "auto_accept": config.PAPER_TEMPLATE_AUTO_ACCEPT}


@router.post("", status_code=201)
async def upload(user: auth.CurrentUser, metadata: Annotated[str, Form()], file: Annotated[UploadFile, File()]):
    try:
        meta = TemplateIn.model_validate_json(metadata)
        if not meta.name.strip():
            raise ProjectError("模板名称不能为空", 422)
        payload = bytearray()
        while chunk := await file.read(1024 * 1024):
            payload.extend(chunk)
            if len(payload) > config.IMPORT_MAX_UPLOAD_MB * 1024 * 1024:
                raise ProjectError("模板上传大小超过上限", 413)
        row = await asyncio.to_thread(paper_templates.add, {**meta.model_dump(), "name": meta.name.strip()},
                                      file.filename or "", bytes(payload))
    except ValidationError as e:
        raise HTTPException(422, {"kind": "validation", "message": "模板信息不完整，请检查名称、格式和编译设置"}) from e
    finally:
        await file.close()
    events.emit("template.created", actor=events.actor_of(user), data={"id": row["id"], "name": row["name"], "format": row["format"]})
    if config.PAPER_TEMPLATE_AUTO_ACCEPT:
        paper_templates.schedule_auto_accept(row["format"], row["id"])
    return row


@router.put("/{fmt}/{tid}/file")
async def replace_file(fmt: str, tid: str, user: auth.CurrentUser,
                       file: Annotated[UploadFile, File()],
                       metadata: Annotated[str | None, Form()] = None):
    """替换上传模板版本（仅 origin=upload）：tid 不变、version 自增、verify 重置，
    失败完整回滚；已建工程副本不受影响。成功且自动验收开启时后台重新验收 + 重产缩略图。"""
    try:
        meta = ReplaceMetaIn.model_validate_json(metadata) if metadata else ReplaceMetaIn()
        payload = bytearray()
        while chunk := await file.read(1024 * 1024):
            payload.extend(chunk)
            if len(payload) > config.IMPORT_MAX_UPLOAD_MB * 1024 * 1024:
                raise ProjectError("模板上传大小超过上限", 413)
        row = await asyncio.to_thread(paper_templates.replace_assets, fmt, tid, file.filename or "",
                                      bytes(payload), meta.model_dump())
    except ValidationError as e:
        raise HTTPException(422, {"kind": "validation", "message": "模板替换信息不完整，请检查主文件与编译设置"}) from e
    finally:
        await file.close()
    events.emit("template.replaced", actor=events.actor_of(user),
                data={"id": tid, "format": fmt, "name": row["name"], "version": row.get("version")})
    if config.PAPER_TEMPLATE_AUTO_ACCEPT:
        paper_templates.schedule_auto_accept(fmt, tid)
    return row


async def _enabled(fmt: str, tid: str, enabled: bool, user):
    row = await asyncio.to_thread(paper_templates.set_enabled, fmt, tid, enabled)
    events.emit("template.restored" if enabled else "template.removed", actor=events.actor_of(user),
                data={"id": tid, "format": fmt, "name": row["name"]})
    return row


@router.delete("/{fmt}/{tid}")
async def remove(fmt: str, tid: str, user: auth.CurrentUser):
    return await _enabled(fmt, tid, False, user)


@router.patch("/{fmt}/{tid}")
async def patch_template(fmt: str, tid: str, body: TemplatePatchIn, user: auth.CurrentUser):
    """元信息部分更新 + 启用/停用。展示字段 builtin/upload 均可改；main/engine 仅上传 LaTeX。
    启用态变化沿用既有 restored/removed 事件；字段修改发 template.updated（含 changes 明细）。"""
    changes = body.model_dump(exclude_unset=True)
    result = await asyncio.to_thread(paper_templates.update_meta, fmt, tid, changes)
    row = result["row"]
    if changes.get("enabled") is not None:
        events.emit("template.restored" if row["enabled"] else "template.removed",
                    actor=events.actor_of(user), data={"id": tid, "format": fmt, "name": row["name"]})
    meta_changes = {k: v for k, v in result["changes"].items() if k != "enabled"}
    if meta_changes:
        events.emit("template.updated", actor=events.actor_of(user),
                    data={"id": tid, "format": fmt, "name": row["name"], "changes": meta_changes})
    return row


@router.post("/{fmt}/{tid}/verify")
async def verify_template(fmt: str, tid: str, user: auth.CurrentUser):
    """管理端「验证编译」：真实跑一遍 latexmk；成功 ⇒ 模板自动注册为「已验证编译」并生成缩略图，
    失败 ⇒ 保持「编译待验证」并记录失败原因（目录与管理面板可见）。Word 模板不适用（422）。"""
    result = await asyncio.to_thread(paper_templates.verify_compile, fmt, tid)
    events.emit("template.verified" if result["status"] == "ok" else "template.verify_failed",
                actor=events.actor_of(user),
                data={"id": tid, "format": fmt, "duration_ms": result.get("duration_ms")})
    return result


@router.post("/{fmt}/{tid}/preview")
async def preview_template(fmt: str, tid: str, user: auth.CurrentUser):
    """Word 模板「生成预览」：ONLYOFFICE /converter 转换验收 + 首页 PNG 缩略图。
    服务不可用/转换失败时返回 status=error 与可读原因（不阻塞模板使用），verify 既有值不动。"""
    result = await asyncio.to_thread(paper_templates.word_preview, fmt, tid)
    events.emit("template.verified" if result["status"] == "ok" else "template.verify_failed",
                actor=events.actor_of(user),
                data={"id": tid, "format": fmt, "duration_ms": result.get("duration_ms")})
    return result


@author_router.get("/{fmt}/{tid}/thumbnail")
async def template_thumbnail(fmt: str, tid: str, request: Request):
    """模板首页缩略图（登录态可读，仅启用模板）。只输出栅格 PNG；ETag 弱缓存对标 project_figures。"""
    data, etag = await asyncio.to_thread(paper_templates.thumbnail_png, fmt, tid)
    headers = {"ETag": etag, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(content=data, media_type="image/png", headers=headers)
