# -*- coding: utf-8 -*-
"""站内通知读写接口（/api/notifications）：off 模式返回空列表，on 模式按登录用户隔离。"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func, select, update

from app import config
from app.auth import CurrentUser, login_required
from app.auth.models import Notification
from app.errors import error_detail

router = APIRouter(prefix="/api", tags=["notifications"])


def _ts(dt: datetime | None) -> float:
    if dt is None:
        return 0.0
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.timestamp()


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.isoformat()


def _item_out(row: Notification) -> dict:
    return {
        "id": row.id,
        "kind": row.kind,
        "title": row.title,
        "body": row.body or "",
        "href": row.href,
        "project_id": row.project_id,
        "read_at": _iso(row.read_at),
        "created_at": _ts(row.created_at),
    }


async def _unread_count(session, user_id) -> int:
    count = await session.scalar(
        select(func.count())
        .select_from(Notification)
        .where(Notification.user_id == user_id, Notification.read_at.is_(None))
    )
    return int(count or 0)


@router.get("/notifications")
async def list_notifications(
    user: CurrentUser,
    limit: int = Query(30, ge=1, le=100),
    unread_only: bool = False,
):
    if not config.AUTH_ON:
        return {"items": [], "unread_count": 0}
    if user is None:
        raise login_required()

    from app.auth.db import SessionLocal, init_db

    await init_db()
    async with SessionLocal() as session:
        stmt = select(Notification).where(Notification.user_id == user.id)
        if unread_only:
            stmt = stmt.where(Notification.read_at.is_(None))
        stmt = stmt.order_by(Notification.created_at.desc(), Notification.id.desc()).limit(limit)
        rows = (await session.execute(stmt)).scalars().all()
        unread = await _unread_count(session, user.id)
    return {"items": [_item_out(r) for r in rows], "unread_count": unread}


@router.post("/notifications/read-all")
async def mark_all_read(user: CurrentUser):
    if not config.AUTH_ON:
        return {"ok": True, "updated": 0, "unread_count": 0}
    if user is None:
        raise login_required()

    from app.auth.db import SessionLocal, init_db

    await init_db()
    now = datetime.now(UTC)
    async with SessionLocal() as session:
        res = await session.execute(
            update(Notification)
            .where(Notification.user_id == user.id, Notification.read_at.is_(None))
            .values(read_at=now)
        )
        await session.commit()
    return {"ok": True, "updated": int(res.rowcount or 0), "unread_count": 0}


@router.post("/notifications/{nid}/read")
async def mark_read(nid: str, user: CurrentUser):
    if not config.AUTH_ON:
        return {"ok": True, "unread_count": 0}
    if user is None:
        raise login_required()

    from app.auth.db import SessionLocal, init_db

    await init_db()
    async with SessionLocal() as session:
        row = (
            await session.execute(select(Notification).where(Notification.id == nid, Notification.user_id == user.id))
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(404, error_detail("not_found", "通知不存在"))
        if row.read_at is None:
            row.read_at = datetime.now(UTC)
            await session.commit()
        unread = await _unread_count(session, user.id)
    return {"ok": True, "unread_count": unread}
