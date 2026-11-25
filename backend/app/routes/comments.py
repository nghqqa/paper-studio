# -*- coding: utf-8 -*-
"""POST /api/projects/{pid}/critic（修订标记）+ /comments CRUD/replies/resolve/reopen（07 §4.2，W5 R-REV-02）。

author 来自 auth.current_user：off ⇒ {id:null, name:"本机"}；on ⇒ {id:str(user.id), name:display_name|email}。
GET /comments 在返回前按当前 AST 重锚（结构不成立时原样返回）；筛选参数 author / status / source / mention。
正文含 `@名字` ⇒ 解析 mentions；AUTH=on 时对成员 display_name / email / user_id 匹配，命中 ⇒ emit comment.mention
（events.py 的枚举名；规格 R-REV-03 写作 comment.mentioned）；off 时无成员表，只记 mentions 不发事件。
"""

import logging
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app import config
from app.auth import CurrentUser, forbidden, my_role, role_at_least
from app.domain import comments as store_mod
from app.domain import events, latex_build
from app.domain.comments import Anchor, Author, Comment

router = APIRouter(prefix="/api/projects/{pid}", tags=["review"])
log = logging.getLogger("paper_studio.review")


class AnchorIn(BaseModel):
    """{block_id, line, quote} | {book, block_id, line_start, line_end?, quote?} | {file}。"""

    block_id: str = ""
    line: int | None = None
    quote: str = ""
    book: Literal["abstract", "claims", "description"] | None = None
    line_start: int | None = None
    line_end: int | None = None
    file: str | None = None
    # LaTeX 文件锚点：创建时的服务器文件 sha；服务端据此做版本校验（不匹配 409）
    sha: str | None = None

    def to_anchor(self) -> Anchor:
        if self.file is None and not self.block_id:
            raise HTTPException(422, "锚点需要 block_id 或 file")
        return store_mod.anchor_from_dict(self.model_dump(exclude_none=True))


class CommentIn(BaseModel):
    anchor: AnchorIn
    # 与 schemas.PublicCommentIn/NoteIn 同口径（4000）：站内批注此前无上限，客户端批注早就有
    body: str = Field(min_length=1, max_length=4000)
    source: Literal["human", "ai"] = "human"


class CommentPatch(BaseModel):
    body: str | None = Field(default=None, max_length=4000)
    anchor: AnchorIn | None = None


class ReplyIn(BaseModel):
    body: str = Field(min_length=1, max_length=4000)
    source: Literal["human", "ai"] = "human"


class ResolveIn(BaseModel):
    resolved: bool = True


def _author(user) -> Author:
    if user is None:
        return store_mod.LOCAL_AUTHOR
    return Author(id=str(user.id), name=user.display_name or user.email)


def _project_dir(request: Request, pid: str) -> str:
    return request.app.state.store.get(pid).dir


def _validate_latex_anchor(request: Request, pid: str, anchor: AnchorIn) -> None:
    """LaTeX 文件锚点（带 sha）创建校验（w21）：
    项目须为 latex 档案；file 必须是工程内可编辑文本文件；行号界内；
    客户端 sha 与当前服务器 sha 不一致 ⇒ 409（提示刷新定位）。不匹配即拒绝，绝不静默落锚。"""
    if anchor.sha is None:
        return  # 非 LaTeX 锚点（patent/file 旧形状）走原有路径
    store = request.app.state.store
    project = store.get(pid)
    if project.settings.get("source_format") != "latex":
        raise HTTPException(422, "带 sha 的文件锚点仅适用于 LaTeX 工程")
    if not anchor.file:
        raise HTTPException(422, "LaTeX 锚点必须带文件路径")
    latex_build._require_latex_project(store, pid)
    text = latex_build.read_source_file(project, anchor.file)  # 路径/扩展名/存在性校验
    line_count = text.count(chr(10)) + 1
    lo = anchor.line_start if anchor.line_start is not None else anchor.line
    hi = anchor.line_end if anchor.line_end is not None else lo
    if lo is None or lo < 1 or hi is None or hi < lo or hi > line_count:
        raise HTTPException(422, f"行号越界：文件共 {line_count} 行")
    current = latex_build.source_file_sha(project, anchor.file)
    if current != anchor.sha:
        raise HTTPException(
            409,
            {"kind": "stale", "message": "文件已在批注创建后被修改（版本不一致）。请刷新文件后重新定位创建。"},
        )


def _load(request: Request, pid: str) -> tuple[str, list[Comment]]:
    d = _project_dir(request, pid)
    return d, store_mod.load(d)


def _get(comments: list[Comment], cid: str) -> Comment:
    c = store_mod.find(comments, cid)
    if c is None:
        raise HTTPException(404, "批注不存在")
    return c


async def _comment_perm(pid: str, user, c: Comment, need: str) -> None:
    """批注写操作权属：作者本人，或本案 need 及以上角色；客户批注（author.id=None）只能角色管。
    AUTH off / 匿名 ⇒ 本机单人态放行；成员身份已由 project_access 兜过底。"""
    if not config.AUTH_ON or user is None or user.is_superuser:
        return
    if c.author.id is not None and c.author.id == str(user.id):
        return
    if not role_at_least(await my_role(pid, user), need):
        raise forbidden(need)


async def mentioned_user_ids(pid: str, mentions: list[str]) -> list[str]:
    """成员表里 display_name / email / user_id / email 本地段与 @名字 相同者；off 或无匹配 ⇒ []。
    @名字 命中多个不同成员（重名 / 本地段撞名）⇒ 该条跳过，不盲发。"""
    if not mentions or not config.AUTH_ON:
        return []
    from app.auth import acl

    candidates = {
        m["user_id"]: {m["display_name"], m["email"], m["user_id"], m["email"].split("@", 1)[0]}
        for m in await acl.list_members(pid)
    }
    out: list[str] = []
    for name in mentions:
        hits = [uid for uid, tokens in candidates.items() if name in tokens]
        if len(hits) == 1 and hits[0] not in out:
            out.append(hits[0])
    return out


def emit_mentions_for(pid: str, user, data: dict) -> None:
    events.emit("comment.mention", pid=pid, actor=events.actor_of(user), data=data)


async def emit_mentions(pid: str, user, c: Comment, body_mentions: list[str], reply_id: str | None = None) -> list[str]:
    ids = await mentioned_user_ids(pid, body_mentions)
    if ids:
        # cid 是 notify 契约键（notify docstring comment.mention {cid,...}）；comment_id 保留做台账/调试可读
        emit_mentions_for(
            pid,
            user,
            {
                "cid": c.id,
                "comment_id": c.id,
                "reply_id": reply_id,
                "mentions": body_mentions,
                "user_ids": ids,
                "block_id": c.anchor.block_id,
                "file": c.anchor.file,
            },
        )
    return ids


def load_reanchored(store, pid: str) -> list[Comment]:
    project = store.get(pid)
    comments = store_mod.load(project.dir)
    if project.settings.get("source_format") == "latex":
        for c in comments:
            a = c.anchor
            if a.sha is not None and a.file:
                cur = latex_build.source_file_sha(project, a.file)
                a.stale = cur != a.sha
    return comments


@router.get("/comments")
async def list_comments(
    pid: str,
    request: Request,
    author: str | None = None,
    status: Literal["open", "resolved", "all"] = "all",
    source: Literal["human", "ai", "client"] | None = None,
    mention: str | None = None,
):
    comments = load_reanchored(request.app.state.store, pid)
    return [
        c.to_dict() for c in store_mod.select(comments, author=author, status=status, source=source, mention=mention)
    ]


@router.post("/comments", status_code=201)
async def create_comment(pid: str, body: CommentIn, request: Request, user: CurrentUser):
    _validate_latex_anchor(request, pid, body.anchor)
    d = _project_dir(request, pid)
    async with store_mod.ledger_lock(d):
        with store_mod.file_lock(d):  # R92：跨进程（stdio MCP）同写 comments.json——锁内重读+改写
            comments = store_mod.load(d)
            c = store_mod.create(body.anchor.to_anchor(), body.body, _author(user), source=body.source)
            comments.append(c)
            store_mod.save(d, comments)
    mentioned = await emit_mentions(pid, user, c, c.mentions)
    events.emit(
        "comment.created",
        pid=pid,
        actor=events.actor_of(user),
        data={"cid": c.id, "reply_id": None, "is_reply": False, "snippet": body.body[:120], "mentioned_ids": mentioned},
    )
    return c.to_dict()


@router.patch("/comments/{cid}")
async def update_comment(pid: str, cid: str, body: CommentPatch, request: Request, user: CurrentUser):
    d = _project_dir(request, pid)
    async with store_mod.ledger_lock(d):
        comments = store_mod.load(d)
        c = _get(comments, cid)
        await _comment_perm(pid, user, c, "editor")
        before = set(c.mentions)
        with store_mod.file_lock(d):  # R92：perm 检查过后锁内重读——他进程删/改不丢
            comments = store_mod.load(d)
            c = _get(comments, cid)
            store_mod.update(c, body.body, body.anchor.to_anchor() if body.anchor else None)
            store_mod.save(d, comments)
    await emit_mentions(pid, user, c, [m for m in c.mentions if m not in before])
    return c.to_dict()


@router.delete("/comments/{cid}", status_code=204)
async def delete_comment(pid: str, cid: str, request: Request, user: CurrentUser):
    d = _project_dir(request, pid)
    async with store_mod.ledger_lock(d):
        comments = store_mod.load(d)
        c = _get(comments, cid)
        await _comment_perm(pid, user, c, "editor")
        with store_mod.file_lock(d):
            comments = store_mod.load(d)
            _get(comments, cid)  # 锁外窗内他进程已删 → 404
            store_mod.save(d, [x for x in comments if x.id != cid])
    return None


@router.post("/comments/{cid}/replies")
async def reply_comment(pid: str, cid: str, body: ReplyIn, request: Request, user: CurrentUser):
    d = _project_dir(request, pid)
    async with store_mod.ledger_lock(d):
        with store_mod.file_lock(d):
            comments = store_mod.load(d)
            c = store_mod.reply(_get(comments, cid), body.body, _author(user), source=body.source)
            store_mod.save(d, comments)
    r = c.replies[-1]
    mentioned = await emit_mentions(pid, user, c, r.mentions, reply_id=r.id)
    events.emit(
        "comment.created",
        pid=pid,
        actor=events.actor_of(user),
        data={"cid": c.id, "reply_id": r.id, "is_reply": True, "snippet": body.body[:120], "mentioned_ids": mentioned},
    )
    return c.to_dict()


@router.post("/comments/{cid}/resolve")
async def resolve_comment(pid: str, cid: str, body: ResolveIn, request: Request, user: CurrentUser):
    d = _project_dir(request, pid)
    async with store_mod.ledger_lock(d):
        comments = store_mod.load(d)
        c = _get(comments, cid)
        await _comment_perm(pid, user, c, "reviewer")
        with store_mod.file_lock(d):
            comments = store_mod.load(d)
            c = _get(comments, cid)
            store_mod.resolve(c, body.resolved, by=_author(user))
            store_mod.save(d, comments)
    return c.to_dict()


@router.post("/comments/{cid}/reopen")
async def reopen_comment(pid: str, cid: str, request: Request, user: CurrentUser):
    d = _project_dir(request, pid)
    async with store_mod.ledger_lock(d):
        comments = store_mod.load(d)
        c = _get(comments, cid)
        await _comment_perm(pid, user, c, "reviewer")
        with store_mod.file_lock(d):
            comments = store_mod.load(d)
            c = _get(comments, cid)
            store_mod.resolve(c, False, by=_author(user))
            store_mod.save(d, comments)
    return c.to_dict()
