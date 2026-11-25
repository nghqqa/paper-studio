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
from datetime import UTC, datetime
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

ACTION_LABELS_EN = {
    "polish": "language polishing",
    "academic": "academic style refinement",
    "condense": "conciseness editing",
    "expand": "explanatory expansion",
    "custom": "custom revision",
    "deai": "natural phrasing refinement",
    "writing": "draft assistance",
}

PROTECTION_LABELS = {
    "numbers": "数值改动",
    "units": "单位改动",
    "citations": "引用键改动",
    "math": "公式改动",
    "refs": "ref/label 改动",
}

PROTECTION_LABELS_EN = {
    "numbers": "numerical values",
    "units": "measurement units",
    "citations": "citation keys",
    "math": "mathematical formulas",
    "refs": "cross-references/labels",
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


# ---------------------------------------------------------------- AI 使用披露声明（只读确定性汇总） ----


_LATEX_SPECIAL = str.maketrans({
    "\\": r"\textbackslash{}",
    "&": r"\&",
    "%": r"\%",
    "$": r"\$",
    "#": r"\#",
    "_": r"\_",
    "{": r"\{",
    "}": r"\}",
    "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
})


def _escape_latex(text: str) -> str:
    return (text or "").translate(_LATEX_SPECIAL)


def _iso_date(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=UTC).strftime("%Y-%m-%d")


def build_disclosure(
    project_dir: str,
    pid: str,
    *,
    title: str = "",
    venue: str = "",
    lang: str = "zh",
    fmt: str = "markdown",
) -> dict:
    """基于 `.studio/paper-proposals/<pid>.jsonl` 生成确定性 AI 使用披露声明。

    红线：只读、零模型调用、零虚构、不输出个人邮箱等 PII；仅依据真实落盘台账汇总。
    """
    if lang not in ("zh", "en"):
        raise kind_error("validation", f"不支持的语言：{lang}（仅支持 zh / en）", detail=lang)
    if fmt not in ("markdown", "latex"):
        raise kind_error("validation", f"不支持的格式：{fmt}（仅支持 markdown / latex）", detail=fmt)

    props = load(project_dir, pid)
    by_status: dict[str, int] = {}
    for p in props:
        by_status[p.status] = by_status.get(p.status, 0) + 1

    applied = [p for p in props if p.status == "applied"]
    by_action: dict[str, int] = {}
    protected_by_flag: dict[str, int] = {}
    human_edited_count = 0
    protected_applied_count = 0
    models_seen: list[str] = []
    files_seen: list[str] = []
    timestamps: list[float] = []

    for p in applied:
        by_action[p.action] = by_action.get(p.action, 0) + 1
        if p.applied_text is not None and p.applied_text.strip() != p.suggested_text.strip():
            human_edited_count += 1
        if p.protection_flags:
            protected_applied_count += 1
            for flag in p.protection_flags:
                protected_by_flag[flag] = protected_by_flag.get(flag, 0) + 1
        m = (p.model or "").strip()
        if m and m not in models_seen:
            models_seen.append(m)
        fn = (p.anchor.file or "").strip()
        if fn and fn not in files_seen:
            files_seen.append(fn)
        ts = p.applied_at or p.updated_at or p.created_at
        if ts:
            timestamps.append(float(ts))

    time_range = None
    if timestamps:
        time_range = {"start": _iso_date(min(timestamps)), "end": _iso_date(max(timestamps))}

    generated_at = datetime.now(tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    summary = {
        "used_ai": len(applied) > 0,
        "total_proposals": len(props),
        "applied_count": len(applied),
        "human_edited_count": human_edited_count,
        "rejected_count": by_status.get("rejected", 0),
        "undone_count": by_status.get("undone", 0),
        "pending_count": by_status.get("pending", 0),
        "protected_applied_count": protected_applied_count,
        "protected_by_flag": protected_by_flag,
        "by_action": by_action,
        "models": models_seen,
        "files": files_seen,
        "time_range": time_range,
        "generated_at": generated_at,
    }

    action_order = ("polish", "academic", "condense", "expand", "deai", "writing", "custom")
    if lang == "zh":
        action_parts = [f"{ACTION_LABELS[a]}（{by_action[a]} 条）" for a in action_order if by_action.get(a)]
        model_str = "、".join(models_seen) if models_seen else "未记录模型名称"
        flag_parts = [f"{PROTECTION_LABELS.get(k, k)} {v} 次" for k, v in protected_by_flag.items()]
        if not applied:
            statement = (
                "经 Paper Studio 平台提案审计台账核验，本稿件正文未采纳任何 AI 生成的修改或写作提案。"
                f"（台账累计记录提案 {len(props)} 条，其中有效采纳 0 条，已拒绝 {summary['rejected_count']} 条，"
                f"已撤销 {summary['undone_count']} 条。）稿件全部学术观点、实验数据与正文表述均由作者独立完成并承担全部学术责任。"
            )
        else:
            date_clause = (
                f"在 {time_range['start']} 至 {time_range['end']}（UTC）期间，"
                if time_range and time_range["start"] != time_range["end"]
                else (f"于 {time_range['start']}（UTC），" if time_range else "")
            )
            prot_clause = (
                f"其中涉及受保护要素变更的 {protected_applied_count} 条提案（{'；'.join(flag_parts)}）"
                "均触发了平台自动保护提示，并经作者逐条显式复核确认。"
                if protected_applied_count
                else "所有已采纳提案均未触发数值、单位、公式或引用键变更告警。"
            )
            statement = (
                f"{date_clause}作者在稿件撰写与修订过程中借助 Paper Studio 的「提案-确认」辅助流程使用了 AI 工具"
                f"（记录模型：{model_str}），具体用途限于{'、'.join(action_parts)}。"
                f"平台台账累计生成提案 {len(props)} 条，经作者人工逐条审阅后最终有效采纳 {len(applied)} 条"
                f"（其中 {human_edited_count} 条经作者二次人工改写后采纳；另拒绝 {summary['rejected_count']} 条、"
                f"撤销 {summary['undone_count']} 条）。{prot_clause}"
                "平台 AI 从未静默覆盖正文；全部研究设计、实验结果、逻辑论证与最终定稿均由作者核验并承担完整学术责任。"
            )
        if fmt == "markdown":
            lines = ["## 人工智能使用声明（AI Usage Disclosure）", ""]
            if title:
                lines.append(f"- **稿件题目**：{title}")
            if venue:
                lines.append(f"- **目标期刊/会议**：{venue}")
            lines.append(f"- **核验时间（UTC）**：{generated_at}")
            lines.append(f"- **有效采纳 AI 提案**：{len(applied)} / {len(props)} 条（人工二次编辑 {human_edited_count} 条）")
            if models_seen:
                lines.append(f"- **涉及模型**：{model_str}")
            lines.extend(["", statement, ""])
            content = "\n".join(lines)
        else:
            meta_note = f"% Generated by Paper Studio on {generated_at} (applied={len(applied)}, total={len(props)})\n"
            content = (
                meta_note
                + "\\section*{人工智能使用声明}\n"
                + _escape_latex(statement)
                + "\n"
            )
    else:
        action_parts = [f"{ACTION_LABELS_EN[a]} ({by_action[a]})" for a in action_order if by_action.get(a)]
        model_str = ", ".join(models_seen) if models_seen else "unspecified model"
        flag_parts = [f"{PROTECTION_LABELS_EN.get(k, k)} ({v})" for k, v in protected_by_flag.items()]
        if not applied:
            statement = (
                "Verified against the Paper Studio proposal audit log, no AI-generated revision or drafting "
                f"proposals were accepted into this manuscript (total logged proposals: {len(props)}; "
                f"accepted: 0; rejected: {summary['rejected_count']}; undone: {summary['undone_count']}). "
                "All research ideas, data, analysis, and text were authored independently by the authors, "
                "who take full responsibility for the content of the manuscript."
            )
        else:
            date_clause = (
                f"Between {time_range['start']} and {time_range['end']} (UTC), "
                if time_range and time_range["start"] != time_range["end"]
                else (f"On {time_range['start']} (UTC), " if time_range else "")
            )
            prot_clause = (
                f"Of the accepted proposals, {protected_applied_count} triggered automated protection warnings "
                f"({', '.join(flag_parts)}) and were explicitly reviewed and confirmed by the authors. "
                if protected_applied_count
                else "None of the accepted proposals triggered protection warnings for numbers, units, formulas, or citations. "
            )
            statement = (
                f"{date_clause}the authors used AI-assisted editing tools ({model_str}) through Paper Studio's "
                f"proposal-confirmation workflow strictly for {', '.join(action_parts)}. "
                f"Out of {len(props)} generated proposals, {len(applied)} were accepted after human review "
                f"({human_edited_count} further edited by the authors prior to acceptance; "
                f"{summary['rejected_count']} rejected; {summary['undone_count']} undone). "
                f"{prot_clause}"
                "No AI output was applied silently without explicit human confirmation. The authors reviewed, "
                "verified, and take full responsibility for all scientific claims, data, and final text."
            )
        if fmt == "markdown":
            lines = ["## AI Usage Disclosure", ""]
            if title:
                lines.append(f"- **Manuscript**: {title}")
            if venue:
                lines.append(f"- **Target Venue**: {venue}")
            lines.append(f"- **Audit Timestamp (UTC)**: {generated_at}")
            lines.append(
                f"- **Accepted AI Proposals**: {len(applied)} / {len(props)} "
                f"(human-edited before acceptance: {human_edited_count})"
            )
            if models_seen:
                lines.append(f"- **Models Recorded**: {model_str}")
            lines.extend(["", statement, ""])
            content = "\n".join(lines)
        else:
            meta_note = f"% Generated by Paper Studio on {generated_at} (applied={len(applied)}, total={len(props)})\n"
            content = (
                meta_note
                + "\\section*{AI Usage Disclosure}\n"
                + _escape_latex(statement)
                + "\n"
            )

    ext = "tex" if fmt == "latex" else "md"
    filename = f"ai-disclosure-{lang}.{ext}"
    return {
        "lang": lang,
        "format": fmt,
        "filename": filename,
        "summary": summary,
        "content": content,
    }
