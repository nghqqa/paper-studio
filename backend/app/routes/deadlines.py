# -*- coding: utf-8 -*-
"""投稿截稿日历汇总、RFC 5545 .ics 导出与临近截稿站内提醒。"""
from __future__ import annotations

import re
from datetime import UTC, date, datetime, timedelta

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import auth, config
from app.domain import db_sink as sink
from app.errors import ProjectError

router = APIRouter(tags=["deadlines"])

_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _ics_escape(value: str) -> str:
    clean = _CTRL_RE.sub("", value)
    return (
        clean.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\r\n", "\\n")
        .replace("\r", "\\n")
        .replace("\n", "\\n")
    )


def _ics_fold(line: str, limit: int = 75) -> str:
    raw = line.encode("utf-8")
    if len(raw) <= limit:
        return line
    out: list[str] = []
    cur = bytearray()
    first = True
    for ch in line:
        b = ch.encode("utf-8")
        cap = limit if first else limit - 1
        if cur and len(cur) + len(b) > cap:
            out.append(cur.decode("utf-8"))
            cur = bytearray(b)
            first = False
        else:
            cur.extend(b)
    if cur:
        out.append(cur.decode("utf-8"))
    return "\r\n ".join(out)


async def _collect_deadlines(request: Request, user) -> tuple[list[dict], date]:
    store = request.app.state.store
    pids = await auth.visible_pids(user, store.list_ids())
    today = datetime.now(config.TZ).date()
    items: list[dict] = []
    for pid in pids:
        try:
            p = store.get(pid)
        except ProjectError:
            continue
        sub = p.settings.get("submission")
        sub_dict = sub if isinstance(sub, dict) else {}
        venue = str(sub_dict.get("venue") or "").strip()
        stage = str(sub_dict.get("stage") or "drafting")
        dl_raw = str(sub_dict.get("deadline") or "").strip()
        notes = str(sub_dict.get("notes") or "").strip()
        url = str(sub_dict.get("url") or "").strip()
        days_left: int | None = None
        status = "unscheduled"
        valid_deadline = ""
        if dl_raw:
            try:
                dl_date = date.fromisoformat(dl_raw[:10])
                days_left = (dl_date - today).days
                valid_deadline = dl_date.isoformat()
                if days_left < 0:
                    status = "overdue"
                elif days_left <= 7:
                    status = "soon"
                else:
                    status = "upcoming"
            except ValueError:
                valid_deadline = ""
        if not valid_deadline and not venue:
            continue
        items.append({
            "pid": p.id,
            "title": p.title,
            "source_format": p.settings.get("source_format", "markdown"),
            "venue": venue,
            "stage": stage,
            "deadline": valid_deadline,
            "days_left": days_left,
            "status": status,
            "url": url,
            "notes": notes,
        })
    items.sort(key=lambda it: (it["days_left"] is None, it["days_left"] if it["days_left"] is not None else 10**9, it["pid"]))
    return items, today


@router.get("/api/deadlines", dependencies=[Depends(auth.require_login)])
async def list_deadlines(request: Request, user: auth.CurrentUser):
    items, today = await _collect_deadlines(request, user)
    return {"items": items, "today": today.isoformat()}


@router.get("/api/deadlines/calendar.ics", dependencies=[Depends(auth.require_login)])
async def export_deadlines_ics(request: Request, user: auth.CurrentUser):
    items, _today = await _collect_deadlines(request, user)
    dtstamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Paper Studio//Submission Deadlines//ZH",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
    ]
    for it in items:
        dl_str = it["deadline"]
        if not dl_str:
            continue
        dl_date = date.fromisoformat(dl_str)
        dtstart = dl_date.strftime("%Y%m%d")
        dtend = (dl_date + timedelta(days=1)).strftime("%Y%m%d")
        summary = f"[{it['venue']}] {it['title']}" if it["venue"] else it["title"]
        desc_parts = [f"项目: {it['title']} ({it['pid']})", f"阶段: {it['stage']}"]
        if it["url"]:
            desc_parts.append(f"投稿链接: {it['url']}")
        if it["notes"]:
            desc_parts.append(it["notes"])
        desc = "\n".join(desc_parts)
        lines.extend([
            "BEGIN:VEVENT",
            f"UID:deadline-{_ics_escape(it['pid'])}@paper-studio.local",
            f"DTSTAMP:{dtstamp}",
            f"DTSTART;VALUE=DATE:{dtstart}",
            f"DTEND;VALUE=DATE:{dtend}",
            f"SUMMARY:{_ics_escape(summary)}",
            f"DESCRIPTION:{_ics_escape(desc)}",
            "BEGIN:VALARM",
            "ACTION:DISPLAY",
            "DESCRIPTION:距论文投稿截稿还有 7 天",
            "TRIGGER:-P7D",
            "END:VALARM",
            "BEGIN:VALARM",
            "ACTION:DISPLAY",
            "DESCRIPTION:论文投稿将于明日截稿",
            "TRIGGER:-P1D",
            "END:VALARM",
            "END:VEVENT",
        ])
    lines.append("END:VCALENDAR")
    payload = "\r\n".join(_ics_fold(ln) for ln in lines) + "\r\n"
    return Response(
        payload,
        media_type="text/calendar; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="paper-deadlines.ics"'},
    )


@router.post("/api/deadlines/remind-check", dependencies=[Depends(auth.require_login)])
async def remind_deadlines(request: Request, user: auth.CurrentUser):
    items, _today = await _collect_deadlines(request, user)
    due_soon = [
        it for it in items
        if it["days_left"] is not None and -7 <= it["days_left"] <= 7
    ]
    notified = 0
    if config.AUTH_ON and user is not None and due_soon:
        from app.auth.models import Notification

        local_today = datetime.now(config.TZ).date()
        today_start = datetime.combine(local_today, datetime.min.time(), tzinfo=config.TZ).astimezone(UTC)
        with Session(sink.engine()) as sess:
            existing = set(
                sess.scalars(
                    select(Notification.project_id).where(
                        Notification.user_id == user.id,
                        Notification.kind == "deadline",
                        Notification.created_at >= today_start,
                    )
                ).all()
            )
        rows = []
        now_dt = datetime.now(UTC)
        for it in due_soon:
            if it["pid"] in existing:
                continue
            dl = it["deadline"]
            days = it["days_left"]
            label = f"已逾期 {abs(days)} 天" if days < 0 else ("今日截稿" if days == 0 else f"还有 {days} 天截稿")
            venue_tag = f"（{it['venue']}）" if it["venue"] else ""
            rows.append({
                "id": sink.new_id(),
                "user_id": user.id,
                "kind": "deadline",
                "title": f"截稿提醒：《{it['title']}》{label}"[:200],
                "body": f"目标刊会{venue_tag}，截稿日期 {dl}",
                "href": f"#/p/{it['pid']}"[:300],
                "project_id": it["pid"],
                "actor_user_id": None,
                "read_at": None,
                "created_at": now_dt,
            })
        if rows:
            notified = sink.write(Notification, rows)
    return {"checked": len(items), "due_soon": due_soon, "notified": notified}
