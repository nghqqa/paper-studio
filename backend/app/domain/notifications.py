# -*- coding: utf-8 -*-
"""站内通知事件订阅器：监听协作/审阅/批注事件并写入 notifications 表。"""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import config
from app.auth.models import Notification, ProjectAcl, User
from app.domain import db_sink as sink
from app.domain import events

_ROLE_ZH = {
    "owner": "所有者",
    "editor": "编辑者",
    "reviewer": "审阅者",
    "viewer": "只读访客",
    "agent": "智能体",
}


def _uuid(raw: object) -> uuid.UUID | None:
    if not raw:
        return None
    if isinstance(raw, uuid.UUID):
        return raw
    try:
        return uuid.UUID(str(raw))
    except (ValueError, TypeError):
        return None


def _project_title(pid: str | None) -> str:
    if not pid:
        return "论文项目"
    studio_path = os.path.join(config.PROJECTS_DIR, pid, "studio.json")
    try:
        with open(studio_path, encoding="utf-8") as f:
            data = json.load(f)
        title = str(data.get("title") or "").strip()
        return title or pid
    except (OSError, ValueError):
        return pid


def _actor_name(ev: events.Event, fallback: str = "协作者") -> str:
    if ev.actor and ev.actor.get("display_name"):
        return str(ev.actor["display_name"])
    return fallback


def _actor_uuid(ev: events.Event) -> uuid.UUID | None:
    return _uuid(ev.actor.get("id")) if ev.actor else None


def _project_recipients(pid: str, *, exclude_ids: set[str] | None = None) -> list[uuid.UUID]:
    exclude = exclude_ids or set()
    with Session(sink.engine()) as s:
        acl_rows = s.execute(
            select(ProjectAcl.user_id, ProjectAcl.role).where(
                ProjectAcl.project_id == pid,
                ProjectAcl.role.in_(("owner", "editor")),
            )
        ).all()
        uids = [uid for uid, _role in acl_rows]
        if not any(role == "owner" for _uid, role in acl_rows):
            su_ids = (
                s.execute(select(User.id).where(User.is_superuser.is_(True), User.is_active.is_(True)))
                .scalars()
                .all()
            )
            uids.extend(su_ids)
    out: list[uuid.UUID] = []
    seen: set[uuid.UUID] = set()
    for uid in uids:
        if str(uid) in exclude or uid in seen:
            continue
        seen.add(uid)
        out.append(uid)
    return out


def _on_member_changed(ev: events.Event) -> None:
    if not config.AUTH_ON or not ev.pid:
        return
    role = ev.data.get("role")
    target_uid = _uuid(ev.data.get("user_id"))
    actor_uid = _actor_uuid(ev)
    if not role or target_uid is None or (actor_uid is not None and target_uid == actor_uid):
        return
    title = _project_title(ev.pid)
    role_zh = _ROLE_ZH.get(str(role), str(role))
    sink.write(
        Notification,
        [
            {
                "id": sink.new_id(),
                "user_id": target_uid,
                "kind": "invite",
                "title": f"已加入论文项目：{title}"[:200],
                "body": f"{_actor_name(ev)} 将你设为「{role_zh}」",
                "href": f"#/p/{ev.pid}",
                "project_id": ev.pid,
                "actor_user_id": actor_uid,
                "read_at": None,
                "created_at": sink.ts_of(ev.ts),
            }
        ],
    )


def _on_comment_mention(ev: events.Event) -> None:
    if not config.AUTH_ON or not ev.pid:
        return
    raw_ids = ev.data.get("user_ids") or []
    actor_uid = _actor_uuid(ev)
    actor_str = str(actor_uid) if actor_uid else None
    cid = ev.data.get("cid") or ""
    title = _project_title(ev.pid)
    href = f"#/p/{ev.pid}?c={cid}" if cid else f"#/p/{ev.pid}"
    created_at = sink.ts_of(ev.ts)
    rows: list[dict] = []
    seen: set[uuid.UUID] = set()
    for raw in raw_ids:
        uid = _uuid(raw)
        if uid is None or (actor_str and str(uid) == actor_str) or uid in seen:
            continue
        seen.add(uid)
        rows.append(
            {
                "id": sink.new_id(),
                "user_id": uid,
                "kind": "mention",
                "title": f"{_actor_name(ev)} 在《{title}》中提到了你"[:200],
                "body": str(ev.data.get("file") or ""),
                "href": href[:300],
                "project_id": ev.pid,
                "actor_user_id": actor_uid,
                "read_at": None,
                "created_at": created_at,
            }
        )
    if rows:
        sink.write(Notification, rows)


def _on_comment_created(ev: events.Event) -> None:
    if not config.AUTH_ON or not ev.pid:
        return
    actor_uid = _actor_uuid(ev)
    exclude = {str(x) for x in (ev.data.get("mentioned_ids") or []) if x}
    if actor_uid is not None:
        exclude.add(str(actor_uid))
    recipients = _project_recipients(ev.pid, exclude_ids=exclude)
    if not recipients:
        return
    cid = ev.data.get("cid") or ""
    title = _project_title(ev.pid)
    action = "回复了批注" if ev.data.get("is_reply") else "发表了新批注"
    href = f"#/p/{ev.pid}?c={cid}" if cid else f"#/p/{ev.pid}"
    created_at = sink.ts_of(ev.ts)
    snippet = str(ev.data.get("snippet") or "")
    rows = [
        {
            "id": sink.new_id(),
            "user_id": uid,
            "kind": "comment",
            "title": f"{_actor_name(ev)} 在《{title}》{action}"[:200],
            "body": snippet,
            "href": href[:300],
            "project_id": ev.pid,
            "actor_user_id": actor_uid,
            "read_at": None,
            "created_at": created_at,
        }
        for uid in recipients
    ]
    sink.write(Notification, rows)


def _on_share_commented(ev: events.Event) -> None:
    if not config.AUTH_ON or not ev.pid:
        return
    recipients = _project_recipients(ev.pid)
    if not recipients:
        return
    cid = ev.data.get("cid") or ""
    guest = str(ev.data.get("name") or "外部审阅者")
    title = _project_title(ev.pid)
    href = f"#/p/{ev.pid}?c={cid}" if cid else f"#/p/{ev.pid}"
    created_at = sink.ts_of(ev.ts)
    quote = str(ev.data.get("quote") or "")
    rows = [
        {
            "id": sink.new_id(),
            "user_id": uid,
            "kind": "comment",
            "title": f"外部审阅者 {guest} 在《{title}》留下了批注"[:200],
            "body": quote,
            "href": href[:300],
            "project_id": ev.pid,
            "actor_user_id": None,
            "read_at": None,
            "created_at": created_at,
        }
        for uid in recipients
    ]
    sink.write(Notification, rows)


def _on_share_confirmed(ev: events.Event) -> None:
    if not config.AUTH_ON or not ev.pid:
        return
    recipients = _project_recipients(ev.pid)
    if not recipients:
        return
    guest = str(ev.data.get("name") or "审阅者")
    title = _project_title(ev.pid)
    version = ev.data.get("version") or ""
    note = str(ev.data.get("note") or "").strip()
    body = note or (f"确认版本 v{version}" if version else "")
    created_at = sink.ts_of(ev.ts)
    rows = [
        {
            "id": sink.new_id(),
            "user_id": uid,
            "kind": "confirm",
            "title": f"{guest} 已确认《{title}》定稿"[:200],
            "body": body,
            "href": f"#/p/{ev.pid}"[:300],
            "project_id": ev.pid,
            "actor_user_id": None,
            "read_at": None,
            "created_at": created_at,
        }
        for uid in recipients
    ]
    sink.write(Notification, rows)


def install() -> Callable[[], None]:
    """注册全部站内通知订阅者（幂等），返回退订函数。"""
    unsubs = [
        events.subscribe("member.changed", _on_member_changed),
        events.subscribe("comment.mention", _on_comment_mention),
        events.subscribe("comment.created", _on_comment_created),
        events.subscribe("share.commented", _on_share_commented),
        events.subscribe("share.confirmed", _on_share_confirmed),
    ]

    def uninstall() -> None:
        for fn in unsubs:
            fn()

    return uninstall
