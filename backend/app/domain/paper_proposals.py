# -*- coding: utf-8 -*-
"""论文 AI 修改提案领域层（v0.4）——从复制粘贴升级为安全审阅闭环。

与专利线 agent/proposals.py 的关系：**完全独立**。专利线是块级 CriticMarkup 协议（content.md 三书），
论文线是「选区原文 → 建议文本」的纯文本替换提案，落地在**编辑器内**（LaTeX=CodeMirror 事务、
Word=ONLYOFFICE 插件桥），服务端只做生成与状态台账，**从不直接改写源文件**——
正文写入一律走既有保存/并发链（LaTeX base-sha 409；Word DS 回调）。

存储：`.studio/paper-proposals/<pid>.jsonl` 追加日志（同 agent/proposals 模式）：
每次新建/状态变化追加一整行，读取时同 id 取最后一行；重启可续；跨项目天然隔离（按项目目录分文件）。

状态机：generating → pending → applied|rejected；applied → undone → applied；
pending → stale（原文变化）。transitions 之外的迁移 409；同状态重放幂等（不重复写行）。

数值/引用保护：生成后服务端 diff 分析产出 protection_flags（numbers/units/citations/math/refs），
前端在差异中显著标识并要求显式确认；这不阻止采纳，但绝不允许静默当作普通润色。
"""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from typing import Literal

from pydantic import BaseModel, Field

from app import atomic
from app.errors import kind_error

DIR = os.path.join(".studio", "paper-proposals")
PID_RE = re.compile(r"^pp_[0-9a-f]{12}$")

ProposalStatus = Literal["generating", "pending", "applied", "rejected", "stale", "failed", "undone"]
Action = Literal["polish", "academic", "condense", "expand", "custom", "deai", "writing"]

# 合法迁移表（from → 允许的 to 集合）
TRANSITIONS: dict[str, set[str]] = {
    "generating": {"pending", "failed"},
    "pending": {"applied", "rejected", "stale"},
    "applied": {"undone"},
    "undone": {"applied", "rejected"},
    "rejected": set(),
    "stale": set(),
    "failed": set(),
}

ACTION_LABELS = {
    "polish": "润色",
    "academic": "学术化",
    "condense": "凝练",
    "expand": "扩写",
    "custom": "自定义修改",
    "deai": "去AI味",
    "writing": "写作",
}

PROTECTION_LABELS = {
    "numbers": "数值改动",
    "units": "单位改动",
    "citations": "引用键改动",
    "math": "公式改动",
    "refs": "ref/label 改动",
}


class Anchor(BaseModel):
    file: str
    base_sha: str
    offset: int | None = None
    context_before: str = ""
    context_after: str = ""
    original_text: str
    # 写作（插入型）提案：original_text 为空、insert=True——落地=在光标处插入建议文本
    insert: bool = False


class ErrorContext(BaseModel):
    """提案关联的编译错误快照（从 Issues/诊断条「AI 修复提案」入口带入）。

    verify-fix 闭环用它做对照：接受修改后重编译，按 file+line±3+消息前缀匹配
    判断目标错误是否消失。快照在生成时固化——后续重编译行号漂移也能对照。"""
    file: str
    line: int | None = None
    message: str = Field(default="", max_length=2000)


class FixVerification(BaseModel):
    """一次修复验证记录（append 追加，可回看历史；不改状态机）。"""
    at: float = Field(default_factory=time.time)
    build_id: str = ""
    build_status: str = ""
    before: list[dict] = Field(default_factory=list)  # 对照口径的错误快照
    after: list[dict] = Field(default_factory=list)  # 本次重编译诊断
    resolved: bool = False
    issue_resolved: bool = False  # 联动把关联 Issue 置为已解决


class Proposal(BaseModel):
    proposal_id: str
    mode: Literal["latex", "word"]
    action: Action
    instruction: str | None = None
    anchor: Anchor
    suggested_text: str
    rationale: str = ""
    model: str = ""
    created_by: str | None = None
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)
    status: ProposalStatus = "pending"
    protection_flags: list[str] = Field(default_factory=list)
    error: str | None = None
    applied_at: float | None = None
    applied_text: str | None = None  # 实际写入口径（用户编辑建议后采纳时 ≠ suggested_text）
    applied_by: str | None = None
    # 修复闭环（可选；旧记录无这些字段，默认值前向兼容）
    error_context: ErrorContext | None = None
    linked_issue_id: str | None = None
    verifications: list[FixVerification] = Field(default_factory=list)


# ---------------------------------------------------------------- 存储 ----


def path(project_dir: str, pid: str) -> str:
    return os.path.join(project_dir, DIR, f"{pid}.jsonl")


def new_id() -> str:
    return "pp_" + uuid.uuid4().hex[:12]


def append(project_dir: str, pid: str, proposal: Proposal, by: str | None = None) -> None:
    p = path(project_dir, pid)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    row = proposal.model_dump(mode="json")
    row["by"] = by
    row["ts"] = time.time()
    with atomic.studio_lock(project_dir, "paper-proposals"):
        with open(p, "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def load(project_dir: str, pid: str, status: str | None = None, file: str | None = None) -> list[Proposal]:
    p = path(project_dir, pid)
    if not os.path.isfile(p):
        return []
    last: dict[str, Proposal] = {}
    with open(p, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue  # 半行（进程中断）跳过，不炸整库
            row.pop("by", None)
            row.pop("ts", None)
            try:
                prop = Proposal.model_validate(row)
            except Exception:
                continue
            last[prop.proposal_id] = prop
    out = sorted(last.values(), key=lambda x: x.created_at)
    return [
        x for x in out
        if (status is None or x.status == status) and (file is None or x.anchor.file == file)
    ]


def get(project_dir: str, pid: str, proposal_id: str) -> Proposal:
    if not PID_RE.match(proposal_id or ""):
        raise kind_error("validation", "proposal_id 不合法", detail=proposal_id)
    for prop in load(project_dir, pid):
        if prop.proposal_id == proposal_id:
            return prop
    raise kind_error("not_found", f"提案不存在：{proposal_id}", detail=proposal_id)


def transition(project_dir: str, pid: str, proposal_id: str, to: ProposalStatus, *,
               applied_text: str | None = None, who: str | None = None) -> Proposal:
    """状态迁移（幂等：同状态重放返回现值不追加）。非法迁移 409。"""
    cur = get(project_dir, pid, proposal_id)
    if cur.status == to:
        return cur
    if to not in TRANSITIONS.get(cur.status, set()):
        raise kind_error("conflict", f"提案状态 {cur.status} 不能变更为 {to}", detail=proposal_id)
    upd: dict = {"status": to, "updated_at": time.time()}
    if to == "applied":
        upd["applied_at"] = time.time()
        upd["applied_text"] = applied_text if applied_text is not None else cur.suggested_text
        upd["applied_by"] = who
    if to in ("rejected", "stale"):
        upd["applied_text"] = None
    prop = cur.model_copy(update=upd)
    append(project_dir, pid, prop, by=who)
    return prop


def record_verification(project_dir: str, pid: str, proposal_id: str,
                        verification: FixVerification, who: str | None = None) -> Proposal:
    """追加一条修复验证记录（不改状态——状态仍是 applied；历史验证全部保留可回看）。"""
    cur = get(project_dir, pid, proposal_id)
    prop = cur.model_copy(update={
        "verifications": [*cur.verifications, verification],
        "updated_at": time.time(),
    })
    append(project_dir, pid, prop, by=who)
    return prop


# ---------------------------------------------------------------- 保护分析 ----

_NUM_RE = re.compile(r"\d+(?:\.\d+)?%?")
_UNIT_RE = re.compile(
    r"\d+(?:\.\d+)?\s?(?:km|m|cm|mm|μm|um|kg|g|mg|s|ms|μs|us|min|h|Hz|kHz|MHz|GHz|GB|MB|KB|bps|%|°C|K\b)")


def _multiset_diff(a: list[str], b: list[str]) -> bool:
    from collections import Counter

    return Counter(a) != Counter(b)


def _math_segments(text: str) -> list[str]:
    segs: list[str] = []
    for m in re.finditer(r"\$\$.*?\$\$|\\\[.*?\\\]|\\\(.*?\\\)|\$[^$\n]+\$", text, re.DOTALL):
        segs.append(re.sub(r"\s+", "", m.group(0)))
    return segs


def _cite_keys(text: str) -> list[str]:
    keys: list[str] = []
    for m in re.finditer(
        r"\\(?:[a-zA-Z]*[cC]ite[a-zA-Z]{0,6}|autocite|parencite|textcite|footcite)"
        r"\*?(?:\[[^\]]*\]){0,2}\{([^{}]*)\}", text):
        for k in m.group(1).split(","):
            if k.strip():
                keys.append(k.strip())
    return keys


def _ref_label_keys(text: str) -> list[str]:
    keys: list[str] = []
    for m in re.finditer(r"\\(?:ref|eqref|label|autoref|cref|Cref)\{([^{}]*)\}", text):
        keys.append(m.group(1).strip())
    return keys


def analyze_changes(original: str, suggested: str) -> list[str]:
    """润色默认不得改动的内容发生变化时打标（显著标识，不静默）。"""
    flags: list[str] = []
    if _multiset_diff(_NUM_RE.findall(original), _NUM_RE.findall(suggested)):
        flags.append("numbers")
    if _multiset_diff(_UNIT_RE.findall(original), _UNIT_RE.findall(suggested)):
        flags.append("units")
    if _multiset_diff(_cite_keys(original), _cite_keys(suggested)):
        flags.append("citations")
    if _multiset_diff(_math_segments(original), _math_segments(suggested)):
        flags.append("math")
    if _multiset_diff(_ref_label_keys(original), _ref_label_keys(suggested)):
        flags.append("refs")
    return flags


# ---------------------------------------------------------------- 定位辅助（服务端校验用） ----


def locate(text: str, anchor: Anchor) -> dict:
    """锚点定位（与前端同语义，供服务端校验/测试）：唯一命中，或上下文消歧后仍唯一。
    返回 {ok, start, end, reason}；歧义/失配 ok=False。"""
    orig = anchor.original_text
    if not orig:
        return {"ok": False, "reason": "empty"}
    positions = [m.start() for m in re.finditer(re.escape(orig), text)]
    if len(positions) == 1:
        s = positions[0]
        return {"ok": True, "start": s, "end": s + len(orig), "reason": "unique"}
    if len(positions) > 1:
        matched = []
        for s in positions:
            before = text[max(0, s - len(anchor.context_before)):s]
            after = text[s + len(orig): s + len(orig) + len(anchor.context_after)]
            if before.endswith(anchor.context_before) and after.startswith(anchor.context_after):
                matched.append(s)
        if len(matched) == 1:
            s = matched[0]
            return {"ok": True, "start": s, "end": s + len(orig), "reason": "context"}
        return {"ok": False, "reason": "ambiguous"}
    return {"ok": False, "reason": "not_found"}
