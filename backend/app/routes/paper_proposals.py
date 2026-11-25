# -*- coding: utf-8 -*-
"""论文 AI 修改提案路由（v0.4）：生成（机构 AI 配置）→ 待审阅 → 编辑器内采纳/拒绝/撤销。

- 生成走与 /api/ai/polish 完全相同的接入链：机构开关 → 用户自建接入 > org.ai_provider（base_url/key/模型）→ AiClient。
  明确外发范围：**仅选区原文 + 各 ≤400 字上下文 + 用户指令**——不发整篇论文、不发文献库。
- 提案落地在编辑器（前端 CodeMirror 事务 / Word 插件桥）；服务端只记账，不写源文件。
- 状态流转幂等：同状态重放返回现值（防重复点击/重试重复写入）。
- 数值/引用保护：服务端 diff 分析 protection_flags，前端显著标识 + 采纳需显式确认。
"""

from __future__ import annotations

import asyncio
import re
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app import auth, config
from app.ai.client import AiError
from app.domain import paper_proposals as pp
from app.domain import user_ai
from app.domain.org import require_org_ai
from app.domain.projects import ProjectError
from app.errors import error_detail, kind_error

router = APIRouter(prefix="/api/projects/{pid}", tags=["paper-proposals"])

MAX_ORIGINAL = 8000
MAX_CONTEXT = 400
MAX_INSTRUCTION = 500

ACTION_PROMPTS = {
    "polish": "优化句子流畅度、用词准确性与学术表达；保持原意、术语与事实，不新增观点。",
    "academic": "改写为更严谨的学术论文表达：客观语气、规范术语、逻辑连接清晰；不改变事实与结论。",
    "condense": "凝练压缩至约一半篇幅，保留全部关键信息、结论与数据。",
    "expand": "在忠实原意的前提下适度扩写：补充过渡与解释性语句；不编造数据与引用。",
    "custom": "按用户给出的修改指令执行。",
    "deai": (
        "去除文本中的 AI 生成痕迹：消除模板化句式、过度对仗的排比、空洞总结句与冗余连接词；"
        "改为自然的学术行文，句式长短结合、用具体表述替代空泛形容。保持原意、术语、数据与引用完全不变，不增删事实。"
    ),
    "writing": (
        "根据指令撰写一段学术论文正文：规范的学术语气、清晰的逻辑推进；"
        "如需引用文献只能使用上下文中已给出的引用键，禁止编造文献、数据与实验结果；"
        "只输出指令要求的一段正文，不输出标题、解释或寒暄。"
    ),
}

_PROTECT_RULES = (
    "保护清单（除非用户指令明确要求，否则必须逐字保留）："
    "实验数字与百分比、单位、数学公式（$...$、\\(...\\)、equation 环境）、"
    "引用命令（\\cite、\\citep 等及其键名）、\\ref/\\label 引用、统计显著性表述、作者结论。"
    "输出必须是纯正文文本：禁止 Markdown 标记（**加粗**、#、- 列表、`）、禁止 CriticMarkup（{~~ ~~}）、禁止 diff 标记。"
)


class GenerateIn(BaseModel):
    mode: str = Field(default="latex")
    file: str = Field(min_length=1, max_length=400)
    base_sha: str = Field(min_length=8, max_length=64)
    # 写作（action=writing）为插入型：original_text 允许为空（在光标处插入）
    original_text: str = Field(default="", max_length=MAX_ORIGINAL)
    context_before: str = Field(default="", max_length=MAX_CONTEXT)
    context_after: str = Field(default="", max_length=MAX_CONTEXT)
    action: str = Field(default="polish")
    instruction: str | None = Field(default=None, max_length=MAX_INSTRUCTION)
    # 修复闭环（可选）：从编译错误发起的提案记录目标错误与关联 Issue，供 verify-fix 对照
    error_context: pp.ErrorContext | None = None
    linked_issue_id: str | None = Field(default=None, max_length=32)


def _ai_client(user=None):
    """用户自建接入 > 机构接入（解析、回退与报错文案统一在 user_ai）。"""
    return user_ai.resolve_ai_client(user)


def _parse_model_json(text: str) -> dict:
    """模型输出 → {text, rationale}。容错：剥代码围栏；JSON 形态但 text 空白 ⇒ 空结果（按失败处理）；
    完全不是 JSON 时整段视为建议文本。"""
    import json

    raw = (text or "").strip()
    fenced = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.MULTILINE).strip()
    try:
        obj = json.loads(fenced)
    except Exception:  # noqa: BLE001 — 非 JSON 按纯文本处理
        obj = None
    if isinstance(obj, dict):
        t = obj.get("text")
        if isinstance(t, str) and t.strip():
            return {"text": t.strip(), "rationale": str(obj.get("rationale") or "").strip()[:600]}
        return {"text": "", "rationale": ""}
    return {"text": raw, "rationale": ""}


@router.post("/paper-proposals/generate", dependencies=[Depends(require_org_ai)])
async def generate(pid: str, body: GenerateIn, request: Request, user: auth.CurrentUser = None):
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    if body.mode not in ("latex", "word"):
        raise kind_error("validation", f"不支持的模式：{body.mode}（结构化写作已停止新功能）", detail=body.mode)
    if body.action not in ACTION_PROMPTS:
        raise kind_error("validation", f"未知修改类型：{body.action}", detail=body.action)
    if body.action == "custom" and not (body.instruction or "").strip():
        raise kind_error("validation", "自定义修改必须填写指令")
    insert_mode = body.action == "writing"
    if not insert_mode and len(body.original_text.strip()) < 2:
        raise kind_error("validation", "请先在编辑器中选中要修改的文字", detail="original_text")
    if insert_mode and not (body.instruction or "").strip():
        raise kind_error("validation", "写作必须填写写作指令（写什么、多长、给谁看）")
    project = request.app.state.store.get(pid)
    client, _provider = _ai_client(user)
    who = getattr(user, "email", None) or (str(getattr(user, "id", "")) if user else None)
    placeholder = pp.Proposal(
        proposal_id=pp.new_id(), mode=body.mode,  # type: ignore[arg-type]
        action=body.action,  # type: ignore[arg-type]
        instruction=body.instruction,
        anchor=pp.Anchor(file=body.file, base_sha=body.base_sha, original_text=body.original_text,
                         context_before=body.context_before, context_after=body.context_after,
                         insert=insert_mode),
        suggested_text="", model="", created_by=who, status="generating",
        error_context=body.error_context, linked_issue_id=body.linked_issue_id,
    )
    pp.append(project.dir, pid, placeholder, by=who)
    action_text = ACTION_PROMPTS[body.action]
    if body.instruction and body.action not in ("custom", "writing"):
        action_text += f"\n用户附加要求：{body.instruction}"
    user_content = (
        (f"写作指令：{body.instruction}\n" if insert_mode and body.instruction else "")
        + (f"修改指令：{body.instruction}\n" if body.action == "custom" and body.instruction else "")
        + (f"修改要求：{body.instruction}\n" if body.action not in ("custom", "writing") and body.instruction else "")
        + (f"【前文（仅供理解语境）】\n{body.context_before}\n" if body.context_before else "")
        + (f"【待修改原文】\n{body.original_text}\n" if not insert_mode else "")
        + (f"【后文（仅供理解语境）】\n{body.context_after}\n" if body.context_after else "")
        + "\n请只输出 JSON：{\"text\": \"<修改后的正文>\", \"rationale\": \"<不超过两句话的修改理由>\"}"
    )
    try:
        result = await client.chat(
            [
                {"role": "system", "content": f"你是学术论文修改助手。任务：{action_text}\n{_PROTECT_RULES}"},
                {"role": "user", "content": user_content},
            ],
            "interactive", max_tokens=4096, temperature=0.4,
        )
    except AiError as e:
        failed = placeholder.model_copy(update={"status": "failed", "error": str(e), "updated_at": time.time()})
        pp.append(project.dir, pid, failed, by=who)
        raise HTTPException(e.status or 502, error_detail("ai", str(e)))
    parsed = _parse_model_json(result.text)
    if not parsed["text"].strip():
        failed = placeholder.model_copy(update={
            "status": "failed", "error": "模型返回了空内容，未生成提案", "updated_at": time.time()})
        pp.append(project.dir, pid, failed, by=who)
        raise HTTPException(502, error_detail("ai", "模型返回了空内容，未生成提案"))
    flags = pp.analyze_changes(body.original_text, parsed["text"])
    prop = placeholder.model_copy(update={
        "suggested_text": parsed["text"],
        "rationale": parsed["rationale"],
        "model": result.model,
        "protection_flags": flags,
        "status": "pending",
        "updated_at": time.time(),
    })
    pp.append(project.dir, pid, prop, by=who)
    return {"proposal": prop.model_dump(mode="json")}


@router.get("/paper-proposals")
async def list_proposals(pid: str, request: Request, status: str | None = None, file: str | None = None):
    project = request.app.state.store.get(pid)
    props = pp.load(project.dir, pid, status=status, file=file)
    return {"proposals": [p.model_dump(mode="json") for p in props]}


@router.get("/paper-proposals/disclosure")
async def get_disclosure(pid: str, request: Request, lang: str = "zh", format: str = "markdown"):
    """只读导出 AI 使用披露声明（严格依据提案落盘台账，不调用 AI，不依赖机构 AI 开关）。"""
    project = request.app.state.store.get(pid)
    settings = project.settings if isinstance(project.settings, dict) else {}
    sub = settings.get("submission") if isinstance(settings.get("submission"), dict) else {}
    title = str(getattr(project, "title", "") or settings.get("title") or "").strip()
    venue = str((sub or {}).get("venue") or "").strip()
    return pp.build_disclosure(project.dir, pid, title=title, venue=venue, lang=lang, fmt=format)


@router.get("/paper-proposals/{proposal_id}")
async def get_proposal(pid: str, proposal_id: str, request: Request):
    project = request.app.state.store.get(pid)
    return {"proposal": pp.get(project.dir, pid, proposal_id).model_dump(mode="json")}


class StatusIn(BaseModel):
    status: str
    applied_text: str | None = Field(default=None, max_length=MAX_ORIGINAL + 2000)


ALLOWED_STATUS = ("applied", "rejected", "stale", "undone")


@router.post("/paper-proposals/{proposal_id}/status")
async def set_status(pid: str, proposal_id: str, body: StatusIn, request: Request, user: auth.CurrentUser = None):
    if body.status not in ALLOWED_STATUS:
        raise kind_error("validation", f"未知状态：{body.status}", detail=body.status)
    project = request.app.state.store.get(pid)
    who = getattr(user, "email", None) or (str(getattr(user, "id", "")) if user else None)
    prop = pp.transition(  # type: ignore[arg-type]
        project.dir, pid, proposal_id, body.status, applied_text=body.applied_text, who=who)
    return {"proposal": prop.model_dump(mode="json")}


# ---------------------------------------------------------------- 修复验证闭环 ----


def _base_name(path: str) -> str:
    return re.split(r"[/\\]", path or "")[-1]


def _diag_hits(diag: dict, before: list[dict]) -> bool:
    """新诊断是否命中「修复前」的某条错误：同文件 + 行号±3 + 消息前缀/包含一致。
    编译器同源错误一般逐字重现；行号允许小漂移（修复本身可能增删行）。"""
    for b in before:
        bf, bl = _base_name(b.get("file") or ""), b.get("line")
        df, dl = _base_name(diag.get("file") or ""), diag.get("line")
        if bf and df and bf != df:
            continue
        try:
            if bl and dl and abs(int(bl) - int(dl)) > 3:
                continue
        except (TypeError, ValueError):
            pass
        bm = (b.get("message") or "").strip().lower()
        dm = (diag.get("message") or "").strip().lower()
        if bm and dm and (dm[:48] != bm[:48] and dm not in bm and bm not in dm):
            continue
        return True
    return False


@router.post("/paper-proposals/{proposal_id}/verify-fix")
async def verify_fix(pid: str, proposal_id: str, request: Request, user: auth.CurrentUser = None):
    """修复验证闭环：接受修改后重编译，确认目标编译错误是否消失，记录可回看。

    - 对照口径：提案的 error_context（从编译错误发起时固化）；未关联错误时取最近一次
      失败构建的诊断（此时语义为整库级「编译通过」验证）。
    - resolved 判定从宽到严只认一件事：重编译 status=ok（且无诊断）——错误消失=编译通过。
    - 成功且提案关联了 Issue 时联动置为已解决（Issues 页签闭环）。
    """
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    project = request.app.state.store.get(pid)
    who = getattr(user, "email", None) or (str(getattr(user, "id", "")) if user else None)
    prop = pp.get(project.dir, pid, proposal_id)
    if prop.mode != "latex":
        raise kind_error("validation", "只有 LaTeX 工程有编译验证（Word 无编译环节）")
    if prop.status != "applied":
        raise kind_error("conflict", f"仅已采纳（applied）的提案可验证修复，当前状态 {prop.status}")
    from app.domain import latex_build

    if prop.error_context is not None:
        before = [prop.error_context.model_dump()]
    else:
        latest = latex_build.latest_build(project)
        before = list((latest or {}).get("diagnostics") or []) if latest else []
        if not before:
            raise kind_error("validation", "没有可对照的编译错误（提案未关联错误，且最近一次构建没有失败记录）")
    try:
        outcome = await asyncio.to_thread(latex_build.run_build, request.app.state.store, pid)
    except ProjectError as e:
        kind = "job_busy" if e.status in (409, 429) else "validation"
        raise HTTPException(e.status, error_detail(kind, str(e)))
    after = list(outcome.get("diagnostics") or [])
    resolved = outcome.get("status") == "ok" and not any(_diag_hits(d, before) for d in after)
    issue_resolved = False
    if resolved and prop.linked_issue_id:
        try:
            from app.domain import latex_issues

            latex_issues.set_resolved(project, prop.linked_issue_id, True)
            issue_resolved = True
        except ProjectError:
            issue_resolved = False  # Issue 已被删除等——验证结论本身不受影响
    ver = pp.FixVerification(
        build_id=str(outcome.get("build_id") or ""), build_status=str(outcome.get("status") or ""),
        before=before, after=after, resolved=resolved, issue_resolved=issue_resolved)
    prop = pp.record_verification(project.dir, pid, proposal_id, ver, who=who)
    return {"verification": ver.model_dump(mode="json"), "proposal": prop.model_dump(mode="json")}


# ---------------------------------------------------------------- 论文精读（论文助手·只读分析）


class ReadIn(BaseModel):
    mode: str = Field(default="latex")
    file: str = Field(min_length=1, max_length=400)
    text: str = Field(min_length=2, max_length=20000)
    question: str | None = Field(default=None, max_length=300)


READ_SYSTEM = (
    "你是论文精读助手。对给定论文片段做深入分析：核心论点与方法、论证结构、"
    "关键术语解释、潜在的逻辑或表述问题、与相关工作的关系。只基于给定文本与通识，"
    "不虚构外部文献与数据。输出为结构化中文分析（可用短标题+要点），不输出修改建议。"
)


@router.post("/paper-assistant/read", dependencies=[Depends(require_org_ai)])
async def assistant_read(pid: str, body: ReadIn, request: Request, user: auth.CurrentUser = None):
    """论文精读：只读分析，不产生提案、不修改文档。范围仅限选中文字（≤2 万字）。"""
    if config.AUTH_ON and user is None:
        raise auth.login_required()
    request.app.state.store.get(pid)
    client, _provider = _ai_client(user)
    user_content = f"【待精读片段】\n{body.text}\n"
    if body.question:
        user_content += f"\n【读者提问】{body.question}"
    try:
        result = await client.chat(
            [
                {"role": "system", "content": READ_SYSTEM},
                {"role": "user", "content": user_content},
            ],
            "interactive", max_tokens=4096, temperature=0.3,
        )
    except AiError as e:
        raise HTTPException(e.status or 502, error_detail("ai", str(e)))
    answer = result.text.strip()
    if not answer:
        raise HTTPException(502, error_detail("ai", "模型返回了空内容"))
    return {"answer": answer, "model": result.model, "chars": len(body.text)}

