# -*- coding: utf-8 -*-
"""公开链接管理 + 免登录客户审阅（docs/plan/21 §1.4 B6 / R-REV-05 / R-CHK-08）。share-confirm-backend 所有。

/api/projects/{pid}/public-links  GET / POST / DELETE {token}   门槛 auth.ROUTE_ROLE（owner）；AUTH=off ⇒ 501。
/api/public/{token}/…             不带 pid，不经 project_access；每个路由先 public_share.resolve(token)：
    不存在 404 not_found · 撤销 410 share.revoked · 过期 410 share.expired · 记访问（visits + public_access.jsonl）。
    GET meta              PublicShareMeta（+ allow_copy / allow_comment / baseline / pending_revisions）
    GET pdf               按链接 baseline 的 PDF（public_share.baseline_pdf）+ 页脚水印；
                          禁下载 ⇒ Content-Disposition: inline（否则 attachment）
    GET layout-ast | ast  块 AST（同 /api/projects/{pid}/ast，但正文先 critic.resolve(baseline)：
                          original 不把未决修订当定稿）；非 markdown 工程 ⇒ 400 validation（P1-4 仅 PDF 审阅）
    GET layout-css        版面 CSS（同 /api/projects/{pid}/style.css）
    GET / POST comments   批注（source=client，author {id:null, name:<访客名>}）；POST 需 scope ≥ comment
    POST confirm          需 scope=confirm → case.json.confirmations[] + emit share.confirmed
不暴露 export / docx / attachments / 源码。
"""

import asyncio
from urllib.parse import quote

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field

from app import config
from app.auth import CurrentUser
from app.domain import comments as comments_mod
from app.domain import events, latex_diff, latex_history, org, public_share, word_documents
from app.errors import ProjectError, kind_error, not_implemented
from app.routes.comments import load_reanchored
from app.schemas import PublicAnchor, PublicShareLink, PublicShareLinkIn, PublicShareMeta

UNIT = "share-confirm-backend"
ORG_NAME = "研稿"
router = APIRouter(tags=["public"])


def _org_name(project) -> str:
    try:
        configured = org.load_org().name.strip()
    except Exception:  # noqa: BLE001 — org.json 异常不挡公开审阅
        configured = ""
    if configured:
        return configured
    if public_share.document_type_of(project) == "paper" or config.PRODUCT == "paper":
        return "研稿"
    return ORG_NAME


class PublicLinkIn(PublicShareLinkIn):
    """schemas.PublicShareLinkIn + allow_comment（False ⇒ scope 收为 read）。"""

    allow_comment: bool | None = None


class PublicMetaOut(PublicShareMeta):
    allow_copy: bool = True
    allow_comment: bool = False


QUOTE_MAX = 120  # 通知正文里的批注摘录长度


class PublicCommentIn(BaseModel):
    """{name, anchor, body}；guest_name 为 schemas.PublicCommentIn 的同义字段。"""

    anchor: PublicAnchor
    body: str = Field(min_length=1, max_length=4000)
    name: str | None = Field(default=None, min_length=1, max_length=64)
    guest_name: str | None = Field(default=None, min_length=1, max_length=64)

    def guest(self) -> str:
        n = self.name or self.guest_name
        if not n:
            raise kind_error("validation", "缺少访客姓名 name")
        return n.strip()


class PublicConfirmIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    note: str | None = Field(default=None, max_length=2000)


def _off():
    return not_implemented("C1-auth", "公开链接需要开启账号（PAPER_STUDIO_AUTH=on）")


def _client(request: Request) -> tuple[str | None, str | None]:
    fwd = request.headers.get("x-forwarded-for")
    ip = fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else None)
    return ip, request.headers.get("user-agent")


async def _grant(token: str, request: Request) -> public_share.Grant:
    ip, ua = _client(request)
    return await public_share.resolve(token, path=request.url.path, ip=ip, ua=ua, store=request.app.state.store)


# ---------------- 链接管理 ----------------


@router.get("/api/projects/{pid}/public-links", response_model=list[PublicShareLink])
async def list_public_links(pid: str, request: Request):
    if not config.AUTH_ON:
        raise _off()
    request.app.state.store.get(pid)
    return await public_share.list_links(pid)


@router.post("/api/projects/{pid}/public-links", status_code=201, response_model=PublicShareLink)
async def create_public_link(pid: str, body: PublicLinkIn, request: Request, user: CurrentUser):
    if not config.AUTH_ON or user is None:
        raise _off()
    request.app.state.store.get(pid)
    return await public_share.create_link(
        pid,
        user,
        scope=body.scope,
        ttl_days=body.ttl_days,
        allow_download=body.allow_download,
        allow_comment=body.allow_comment,
        baseline=body.baseline,
    )


@router.delete("/api/projects/{pid}/public-links/{token}", status_code=204)
async def revoke_public_link(pid: str, token: str, request: Request, user: CurrentUser):
    if not config.AUTH_ON or user is None:
        raise _off()
    if not await public_share.revoke_link(pid, token, user):
        raise kind_error("not_found", "审阅链接不存在")
    return Response(status_code=204)


# ---------------- 免登录审阅 ----------------


@router.get("/api/public/{token}/meta", response_model=PublicMetaOut)
async def public_meta(token: str, request: Request):
    g = await _grant(token, request)
    store = request.app.state.store
    project = store.get(g.pid)
    return public_share.meta(project, g, _org_name(project), "")


@router.get("/api/public/{token}/pdf")
async def public_pdf(token: str, request: Request):
    g = await _grant(token, request)
    store = request.app.state.store
    project = store.get(g.pid)
    path = await asyncio.to_thread(public_share.baseline_pdf, store, project, g.baseline)
    if path is None:
        raise kind_error("not_found", "PDF 尚未生成，请稍后再试")
    data, ok = await asyncio.to_thread(public_share.watermarked_pdf, path, token)
    disposition = "attachment" if g.allow_download else "inline"
    headers = {
        "Content-Disposition": f"{disposition}; filename*=UTF-8''{quote(project.title + '.pdf')}",
        "Cache-Control": "no-store",
        "X-Watermark": "footer" if ok else "unavailable",
    }
    return Response(data, media_type="application/pdf", headers=headers)


def _sanitize_public_comment(raw: dict) -> dict:
    d = dict(raw)
    d.pop("linked_issue_id", None)
    d.pop("linked_rebuttal_id", None)
    d.pop("mentions", None)
    anchor = dict(d.get("anchor") or {})
    anchor.pop("file", None)
    anchor.pop("sha", None)
    d["anchor"] = anchor
    clean_replies = []
    for rep in d.get("replies") or []:
        r = dict(rep)
        r.pop("mentions", None)
        author = dict(r.get("author") or {})
        author["id"] = None
        r["author"] = author
        clean_replies.append(r)
    d["replies"] = clean_replies
    return d


@router.get("/api/public/{token}/comments")
async def public_comments(token: str, request: Request):
    g = await _grant(token, request)
    comments = [
        _sanitize_public_comment(c.to_dict())
        for c in load_reanchored(request.app.state.store, g.pid)
        if c.source == "client"
    ]
    return comments


@router.post("/api/public/{token}/comments", status_code=201)
async def add_public_comment(token: str, body: PublicCommentIn, request: Request):
    g = await _grant(token, request)
    if not g.allow_comment:
        raise kind_error("share.scope", "此链接仅可阅读，不能批注")
    d = request.app.state.store.get(g.pid).dir
    async with comments_mod.ledger_lock(d):
        with comments_mod.file_lock(d):  # R92：跨进程写锁（见 comments.file_lock）
            comments = comments_mod.load(d)
            c = comments_mod.create(
                comments_mod.anchor_from_dict(body.anchor.model_dump()),
                body.body,
                comments_mod.Author(id=None, name=body.guest()),
                source="client",
            )
            comments.append(c)
            comments_mod.save(d, comments)
    events.emit(
        "share.commented",
        pid=g.pid,
        actor=None,
        data={"token": g.token, "cid": c.id, "name": body.guest(), "quote": body.body[:QUOTE_MAX]},
    )
    return c.to_dict()


@router.post("/api/public/{token}/confirm")
async def public_confirm(token: str, body: PublicConfirmIn, request: Request):
    g = await _grant(token, request)
    if not g.allow_confirm:
        raise kind_error("share.scope", "此链接不能确认定稿")
    ip, ua = _client(request)
    project = request.app.state.store.get(g.pid)
    rec = public_share.confirm(project, g, body.name.strip(), body.note, ip, ua)
    return public_share.confirmation_out(rec)


@router.get("/api/public/{token}/revisions")
async def public_revisions(token: str, request: Request):
    """公开审阅链接的脱敏版本演进与修订差异摘要（绝不返回 .tex/.docx 原始源码下载）。"""
    g = await _grant(token, request)
    project = request.app.state.store.get(g.pid)
    fmt = str(project.settings.get("source_format") or "markdown")
    if fmt == "docx":
        try:
            st = await asyncio.to_thread(word_documents.state, project.dir)
            raw_versions = list(st.get("versions") or [])
        except ProjectError:
            raw_versions = []
        versions = [
            {
                "id": v.get("id"),
                "created_at": v.get("created_at"),
                "label": v.get("label"),
                "source": v.get("source"),
            }
            for v in reversed(raw_versions[-10:])
        ]
        latest_diff = None
        if len(raw_versions) >= 2:
            try:
                d = await asyncio.to_thread(
                    word_documents.diff_versions,
                    project.dir,
                    raw_versions[-2]["id"],
                    raw_versions[-1]["id"],
                )
                diff_text = d["unified_diff"][:12000] if g.allow_copy else ""
                latest_diff = {
                    "kind": "word",
                    "base_vid": d["base_vid"],
                    "target_vid": d["target_vid"],
                    "added": d["added"],
                    "removed": d["removed"],
                    "unified_diff": diff_text,
                    "truncated": (d["truncated"] or len(d["unified_diff"]) > 12000) if g.allow_copy else False,
                    **({"redacted": True} if not g.allow_copy else {}),
                }
            except ProjectError:
                latest_diff = None
        return {"source_format": fmt, "versions": versions, "latest_diff": latest_diff}

    if fmt == "latex":
        commits = await asyncio.to_thread(latex_history.log, project.dir, 10)
        versions = [
            {
                "id": c["sha"][:8],
                "created_at": c["at"],
                "message": c["message"],
                "added": c["added"],
                "deleted": c["deleted"],
                "milestones": c.get("milestones", []),
            }
            for c in commits
        ]
        diffs = await asyncio.to_thread(latex_diff.list_diffs, project)
        ok_diff = next((row for row in diffs if row.get("status") == "ok"), None)
        latest_diff = (
            {
                "kind": "latexdiff",
                "id": ok_diff.get("id"),
                "base_ref": ok_diff.get("base_ref"),
                "target_ref": ok_diff.get("target_ref"),
                "created_at": ok_diff.get("created_at"),
            }
            if ok_diff
            else None
        )
        return {"source_format": fmt, "versions": versions, "latest_diff": latest_diff}

    return {"source_format": fmt, "versions": [], "latest_diff": None}
