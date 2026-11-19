# -*- coding: utf-8 -*-
"""per-user 每日 AI token 配额（实验室多账号共用机构 key 的护栏；v0.6.7）。

背景：案级日预算（agent/budget.py）只护单案 heavy 场景；论文线的润色/提案/审稿/修复
走 user_ai.resolve_ai_client（用户自建 > 机构接入），多账号共用机构 key 时一个人能把
全组额度烧光。本模块在 resolve_ai_client 这个单一咽喉上加闸与记账：

- 计数文件 `<PROJECTS_DIR>/.studio/ai-quota/<user_key>.json`：{"day","used","updated_at"}，
  本地日历日不匹配即自动归零（跨天首调重置）；add 由 AiClient._record 钩子逐次调用
  （含失败尝试 tokens=0 的行，不重复计），事件循环单线程内读改写，无 await ⇒ 无竞态。
- 上限 `org.ai_user_daily_tokens`（0=不限，缺省关——管理员显式开启才生效）；BYOK
  （source=user）天然不占机构额度，闸与记账都只作用于机构接入。
- check 超限 429 kind=budget（与案级预算同 kind，前端已有语义）；reset 由管理端调用。

auth=off 时 uid 落 "anon" 单桶（同 user_ai 口径）——只用于本地开发，不影响生产语义。
"""

import json
import os
import time

from app import atomic, config
from app.errors import kind_error
from app.domain.org import load_org
from app.domain.user_ai import user_key

QUOTA_DIR = os.path.join(".studio", "ai-quota")


def _day_now(now: float | None = None) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(now if now is not None else time.time()))


def quota_path(uid: str | None) -> str:
    return os.path.join(config.PROJECTS_DIR, QUOTA_DIR, f"{user_key(uid)}.json")


def limit() -> int:
    """per-user 每日上限（org.ai_user_daily_tokens）；0=不限。"""
    return max(0, int(getattr(load_org(), "ai_user_daily_tokens", 0) or 0))


def _load(uid: str | None, now: float | None = None) -> dict:
    day = _day_now(now)
    p = quota_path(uid)
    if os.path.isfile(p):
        try:
            with open(p, encoding="utf-8") as f:
                row = json.load(f)
            if row.get("day") == day:
                return row
        except Exception:  # noqa: BLE001 — 损坏按新一天从零计
            pass
    return {"day": day, "used": 0, "updated_at": 0}


def used_today(uid: str | None, now: float | None = None) -> int:
    return int(_load(uid, now).get("used") or 0)


def add(uid: str | None, tokens: int, now: float | None = None) -> None:
    """累计今日用量（负数/0 也允许——失败尝试不记；文件损坏自然归零重开）。"""
    t = max(0, int(tokens or 0))
    if t <= 0:
        return
    row = _load(uid, now)
    row["used"] = int(row.get("used") or 0) + t
    row["updated_at"] = time.time() if now is None else now
    atomic.write_json(quota_path(uid), row)


def check(uid: str | None, now: float | None = None) -> None:
    """机构接入的 AI 调用前闸：超限 429 budget（与案级预算同 kind）。"""
    cap = limit()
    if cap <= 0:
        return
    used = used_today(uid, now)
    if used >= cap:
        raise kind_error(
            "budget",
            f"你的今日 AI 用量已达上限（{used}/{cap} tokens）。自带 API Key（账户 → AI 接入）不受此限，"
            "或明日再试／联系管理员调整。",
            detail={"used": used, "quota": cap},
        )


_INFLIGHT_ESTIMATE = 2000  # 在途请求的预留估值：上游 usage 未知前，按典型调用预留一档


def reserve(uid: str | None, est: int = _INFLIGHT_ESTIMATE, now: float | None = None) -> int:
    """请求时预留（check+扣减在同一 flock 内，封住「上游调用在途时排队请求继续放行」的超额窗口）。
    返回实际预留值（不限额时 0）。落账用 settle(actual, cushion) 多退少补；
    上游失败未回调 on_record 的极端路径会滞留预留值（≤est，跨日自然归零）。"""
    cap = limit()
    if cap <= 0:
        return 0
    est = max(1, int(est))
    with atomic.studio_lock(config.PROJECTS_DIR, "ai-quota"):
        row = _load(uid, now)
        used = int(row.get("used") or 0)
        if used >= cap:
            raise kind_error(
                "budget",
                f"你的今日 AI 用量已达上限（{used}/{cap} tokens）。自带 API Key（账户 → AI 接入）不受此限，"
                "或明日再试／联系管理员调整。",
                detail={"used": used, "quota": cap},
            )
        grant = min(est, max(0, cap - used))
        row["used"] = used + grant
        row["updated_at"] = time.time() if now is None else now
        atomic.write_json(quota_path(uid), row)
        return grant


def today(now: float | None = None) -> str:
    """当前计数日（预留与结算绑定同日：跨日完成的请求不冲减新一天用量）。"""
    return _day_now(now)


def settle(uid: str | None, actual: int, grant: int, now: float | None = None,
           day: str | None = None) -> None:
    """落账结算（净额）：used = used - grant + actual。grant = 当时 reserve 返回的预留值；
    后续上游尝试以 grant=0 结算（纯累加实际用量）。actual 与 grant 同时为 0 时不动作。
    day=预留发生日：当前计数日已跨天时静默跳过——旧预留不冲减新一天的用量。"""
    actual, grant = int(actual or 0), int(grant or 0)
    if actual <= 0 and grant <= 0:
        return
    with atomic.studio_lock(config.PROJECTS_DIR, "ai-quota"):
        row = _load(uid, now)
        if day is not None and row.get("day") != day:
            return
        row["used"] = max(0, int(row.get("used") or 0) - grant + actual)
        row["updated_at"] = time.time() if now is None else now
        atomic.write_json(quota_path(uid), row)


def overview() -> list[dict]:
    """全部用户的今日用量行 [{uid, day, used, updated_at}]（管理端视图；含跨天残留，展示层按 day 过滤）。"""
    root = os.path.join(config.PROJECTS_DIR, QUOTA_DIR)
    rows: list[dict] = []
    if not os.path.isdir(root):
        return rows
    for fn in os.listdir(root):
        if not fn.endswith(".json"):
            continue
        p = os.path.join(root, fn)
        try:
            with open(p, encoding="utf-8") as f:
                row = json.load(f)
            rows.append({
                "uid": fn[:-5],
                "day": row.get("day", ""),
                "used": int(row.get("used") or 0),
                "updated_at": float(row.get("updated_at") or 0),
            })
        except Exception:  # noqa: BLE001 — 单文件损坏跳过，不影响整体视图
            continue
    return rows


def reset(uid: str | None) -> bool:
    p = quota_path(uid)
    if os.path.isfile(p):
        os.remove(p)
        return True
    return False
