# -*- coding: utf-8 -*-
"""客户免登录审阅链接（docs/plan/21 §1.3 A6 / §2.1 R-REV-05 / R-CHK-08）。share-confirm-backend 所有。

- 链接行在 SQLite `public_share_links`（auth/models.PublicShareLink；跨案数据进库，B5）。AUTH=off 无库 ⇒ 不能建链接，
  /api/public/* 一律 404 not_found。
- 有效权限 = 链接 ∧ 案级协作设置（access.get_settings）：allow_download / allow_comment 只能收紧不能放宽；
  allow_copy 现只有案级开关（链接表无此列）。
- 访问记录：链接行 visits / last_visit_at + 案内 `.studio/public_access.jsonl`（{ts, token, path, ip, ua}，随案迁移）。
- 基线（W9 domain-02）：链接列 baseline original|final 决定客户看到的正文 = critic.resolve(源码, baseline)；
  缺省 original（撰写人已定正文，未决修订不当定稿出现）。layout-ast 按此解析；PDF 在正文含未决修订时
  找 content.md 与之一致的构建，没有就按 baseline 构建一次；无未决修订时同下。
- PDF：最新成功构建的 out.pdf（不改 DOCX / 源码），pypdf 逐页叠加页脚「审阅版 · <token 前 6 位> · <日期>」；
  页脚文字由 matplotlib（已是依赖）用首个可用的开源 CJK 字体渲染成透明单页 PDF 再 merge。任何一步失败 ⇒ 原 PDF +
  响应头 X-Watermark: unavailable。P1-4：LaTeX 取 latex-builds 最新成功构建产物；Word 取与 state sha 一致的
  exports/{sha}.pdf（未导出即 pdf_ready=False）；两者无 critic 未决修订概念（pending_revisions 恒 0、仅 PDF 审阅）。
- 确认定稿 → case.json.confirmations[]（cases.Confirmation：version/sha/name/note/confirmed_at/actor/ip/ua/token）
  + emit share.confirmed；时间线从 confirmations 派生，不另存。
"""

from __future__ import annotations

import glob
import io
import json
import logging
import os
import secrets
import time
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import select

from app import atomic, config
from app.auth import access
from app.domain import cases, events, history, latex_build, word_documents
from app.errors import kind_error

log = logging.getLogger("paper_studio.public")

ACCESS_LOG = "public_access.jsonl"
FONT_CANDIDATES = (
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/truetype/arphic/uming.ttc",
)
FONT_PATH = next((p for p in FONT_CANDIDATES if os.path.isfile(p)), "")
WATERMARK_FONT_PT = 9
WATERMARK_BOTTOM_PT = 24


# ---------------- 链接 ----------------


def _ts(dt: datetime | None) -> float | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.timestamp()


def link_out(row, creator) -> dict:
    """schemas.PublicShareLink 形状。"""
    return {
        "token": row.token,
        "pid": row.project_id,
        "scope": row.scope,
        "baseline": baseline_of(row),
        "allow_download": bool(row.allow_download),
        "expires_at": _ts(row.expires_at),
        "revoked": bool(row.revoked),
        "created_by": (
            events.actor_of(creator) if creator is not None else {"id": str(row.created_by), "display_name": "?"}
        ),
        "created_at": _ts(row.created_at) or 0.0,
        "visits": row.visits or 0,
        "last_visit_at": _ts(row.last_visit_at),
    }


async def effective_settings(pid: str) -> dict:
    """案级协作设置（缺行 ⇒ DEFAULT_SETTINGS）；off 时同默认。"""
    if not config.AUTH_ON:
        return dict(access.DEFAULT_SETTINGS)
    return await access.get_settings(pid)


def baseline_of(row) -> str:
    return row.baseline if row.baseline in ("original", "final") else "original"


async def create_link(
    pid: str,
    user,
    *,
    scope: str,
    ttl_days: int | None,
    allow_download: bool,
    allow_comment: bool | None = None,
    baseline: str = "original",
) -> dict:
    """链接不得放宽案级设置：案级禁下载 ⇒ allow_download=False；案级禁批注或 allow_comment=False ⇒ scope=read。"""
    from app.auth.db import SessionLocal, init_db
    from app.auth.models import PublicShareLink

    st = await effective_settings(pid)
    allow_download = allow_download and bool(st["allow_download"])
    if allow_comment is False or not st["allow_comment"]:
        scope = "read"
    now = datetime.now(UTC)
    await init_db()
    async with SessionLocal() as s:
        row = PublicShareLink(
            token=secrets.token_urlsafe(24),
            project_id=pid,
            scope=scope,
            baseline=baseline,
            allow_download=allow_download,
            expires_at=now + timedelta(days=ttl_days) if ttl_days else None,
            revoked=False,
            created_by=user.id,
            created_at=now,
            visits=0,
        )
        s.add(row)
        await s.commit()
        await s.refresh(row)
        out = link_out(row, user)
    events.emit(
        "share.created",
        pid=pid,
        actor=events.actor_of(user),
        data={"token": row.token, "scope": scope, "baseline": baseline, "expires_at": out["expires_at"]},
    )
    return out


async def list_links(pid: str) -> list[dict]:
    from app.auth.db import SessionLocal, init_db
    from app.auth.models import PublicShareLink, User

    await init_db()
    async with SessionLocal() as s:
        rows = await s.execute(
            select(PublicShareLink, User)
            .join(User, User.id == PublicShareLink.created_by, isouter=True)
            .where(PublicShareLink.project_id == pid)
            .order_by(PublicShareLink.created_at.desc())
        )
        return [link_out(r, u) for r, u in rows]


async def revoke_link(pid: str, token: str, user) -> bool:
    from app.auth.db import SessionLocal, init_db
    from app.auth.models import PublicShareLink

    await init_db()
    async with SessionLocal() as s:
        row = await s.get(PublicShareLink, token)
        if row is None or row.project_id != pid:
            return False
        row.revoked = True
        await s.commit()
    events.emit("share.revoked", pid=pid, actor=events.actor_of(user), data={"token": token})
    return True


class Grant:
    """一次 token 校验的结果：pid / scope / allow_download / allow_copy / allow_comment / expires_at。"""

    def __init__(self, row, settings: dict):
        self.token: str = row.token
        self.pid: str = row.project_id
        self.scope: str = row.scope if settings["allow_comment"] else "read"
        self.baseline: str = baseline_of(row)
        self.allow_download: bool = bool(row.allow_download) and bool(settings["allow_download"])
        self.allow_copy: bool = bool(settings["allow_copy"])
        self.expires_at: float | None = _ts(row.expires_at)

    @property
    def allow_comment(self) -> bool:
        return self.scope in ("comment", "confirm")

    @property
    def allow_confirm(self) -> bool:
        return self.scope == "confirm"


def _not_found():
    return kind_error("not_found", "审阅链接不存在")


async def resolve(token: str, *, path: str, ip: str | None, ua: str | None, store) -> Grant:
    """校验 token（不存在 404 / 撤销 410 share.revoked / 过期 410 share.expired），记访问，返回 Grant。"""
    if not config.AUTH_ON:
        raise _not_found()
    from app.auth.db import SessionLocal, init_db
    from app.auth.models import PublicShareLink

    await init_db()
    now = datetime.now(UTC)
    async with SessionLocal() as s:
        row = await s.get(PublicShareLink, token)
        if row is None:
            raise _not_found()
        if row.revoked:
            raise kind_error("share.revoked", "审阅链接已撤销")
        exp = row.expires_at
        if exp is not None and (exp if exp.tzinfo else exp.replace(tzinfo=UTC)) <= now:
            raise kind_error("share.expired", "审阅链接已过期")
        row.visits = (row.visits or 0) + 1
        row.last_visit_at = now
        await s.commit()
        pid = row.project_id
        grant_row = row
    try:
        project_dir = store.get(pid).dir
    except Exception:  # noqa: BLE001 — 案子已删：链接失效
        raise _not_found() from None
    record_access(project_dir, token, path, ip, ua)
    return Grant(grant_row, await effective_settings(pid))


def access_log_path(project_dir: str) -> str:
    return os.path.join(project_dir, ".studio", ACCESS_LOG)


def record_access(project_dir: str, token: str, path: str, ip: str | None, ua: str | None) -> None:
    p = access_log_path(project_dir)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "a", encoding="utf-8") as f:
        f.write(json.dumps({"ts": time.time(), "token": token, "path": path, "ip": ip, "ua": ua}, ensure_ascii=False))
        f.write("\n")


def read_access_log(project_dir: str) -> list[dict]:
    p = access_log_path(project_dir)
    if not os.path.isfile(p):
        return []
    with open(p, encoding="utf-8") as f:
        return [json.loads(ln) for ln in f if ln.strip()]


# ---------------- 版本 / 元信息 ----------------

SOURCE_FORMATS = ("markdown", "structured", "latex", "docx")


def source_format_of(project) -> str:
    """studio.json source_format；缺省 / 未知值回退 markdown（旧专利工程无此键）。"""
    fmt = project.settings.get("source_format")
    return fmt if fmt in SOURCE_FORMATS else "markdown"


def document_type_of(project) -> str:
    """paper（缺省）/ patent；异常值不挡审阅，回退 paper。"""
    v = str(project.settings.get("document_type") or "").strip()
    return v if v in ("paper", "patent") else "paper"


def _word_version_of(project_dir: str) -> tuple[int, str]:
    """Word 真实版本在 .studio/word/state.json（只读，不轮换会话 key）；读不到 ⇒ (0, "")。"""
    try:
        s = word_documents.state(project_dir)
        return int(s.get("version") or 0), str(s.get("sha") or "")
    except Exception:  # noqa: BLE001 — state.json 缺失 / 损坏不挡审阅页
        return 0, ""


def version_of(project) -> tuple[int, str]:
    """(版本号, HEAD sha)。markdown / structured / latex 看 git 提交数；docx 看 Word 状态（P1-4）。"""
    if source_format_of(project) == "docx":
        return _word_version_of(project.dir)
    versions = history.log(project.dir)
    return len(versions), (versions[0]["sha"] if versions else "")


def _build_dirs(project) -> list[str]:
    return sorted(glob.glob(os.path.join(project.studio_dir, "builds", "*")), key=os.path.getmtime, reverse=True)


def _latex_latest_pdf(project) -> str | None:
    """LaTeX：按新→旧扫 latex-builds，取首个 status=ok 且实际产物 PDF 存在的构建。"""
    root = latex_build.builds_dir(project)
    if not os.path.isdir(root):
        return None
    for manifest in latex_build.list_builds(project):
        if manifest.get("status") != "ok":
            continue
        bid = str(manifest.get("build_id") or "")
        if not bid or not bid.replace("-", "").isalnum():
            continue
        main = manifest.get("main") or "main.tex"
        pdf, _gz = latex_build._build_artifact_pair(os.path.join(root, bid), main)
        if pdf and os.path.isfile(pdf):
            return pdf
    return None


def _word_export_pdf(project) -> str | None:
    """Word：只认与当前 state sha 严格一致的导出 PDF（.studio/word/exports/{sha}.pdf）；
    未导出 ⇒ None（客户页如实提示，不现场触发 ONLYOFFICE）。"""
    _version, sha = _word_version_of(project.dir)
    if not sha:
        return None
    p = os.path.join(project.studio_dir, "word", "exports", sha + ".pdf")
    return p if os.path.isfile(p) else None


def latest_pdf(project) -> str | None:
    """最新一次可用的审阅 PDF（构建可能因无 LibreOffice 只有 docx）。"""
    fmt = source_format_of(project)
    if fmt == "latex":
        return _latex_latest_pdf(project)
    if fmt == "docx":
        return _word_export_pdf(project)
    for d in _build_dirs(project):
        p = os.path.join(d, "out.pdf")
        if os.path.isfile(p):
            return p
    return None


def pending_revisions(_content: str = "") -> int:
    return 0


def baseline_pdf(store, project, baseline: str = "original") -> str | None:
    """客户端 PDF：直接取最新可用 PDF（LaTeX 构建产物 / Word 导出 PDF）。"""
    return latest_pdf(project)


def confirmation_out(c: cases.Confirmation) -> dict:
    """schemas.Confirmation 形状。"""
    return {"version": c.version, "sha": c.sha, "name": c.name, "note": c.note, "confirmed_at": c.confirmed_at}


def meta(project, grant: Grant, org_name: str, content: str = "") -> dict:
    fmt = source_format_of(project)
    case = cases.ensure_case(project.dir)
    version, sha = version_of(project)
    last = case.confirmations[-1] if case.confirmations else None
    return {
        "org_name": org_name,
        "title": project.title,
        "case_no": case.case_no or None,
        "status": case.status,
        "version": version,
        "sha": sha,
        "scope": grant.scope,
        "baseline": grant.baseline,
        "pending_revisions": 0,
        "allow_download": grant.allow_download,
        "sub_except": [],
        "allow_copy": grant.allow_copy,
        "allow_comment": grant.allow_comment,
        "expires_at": grant.expires_at,
        "confirmation": confirmation_out(last) if last else None,
        "pdf_ready": latest_pdf(project) is not None,
        "source_format": fmt,
        "document_type": document_type_of(project),
        "layout_supported": False,
    }


# ---------------- 确认定稿 ----------------


def confirm(project, grant: Grant, name: str, note: str | None, ip: str | None, ua: str | None) -> cases.Confirmation:
    """追加 case.json.confirmations[] 并 emit share.confirmed（actor 为访客：client:<name>，无用户 id）。
    同链同人同版本重复提交（双击/重试）幂等返回既有记录，不重复落账/发事件。"""
    version, sha = version_of(project)
    with atomic.studio_lock(project.dir, "case"):
        case = cases.ensure_case(project.dir)
        for c in reversed(case.confirmations):
            if c.token == grant.token and c.version == version and c.sha == sha and c.name == name:
                return c
        rec = cases.Confirmation(
            version=version,
            sha=sha,
            name=name,
            note=note,
            confirmed_at=time.time(),
            actor=f"client:{name}",
            ip=ip,
            ua=ua,
            token=grant.token,
        )
        case.confirmations.append(rec)
        cases.save_case(project.dir, case)
    events.emit(
        "share.confirmed",
        pid=project.id,
        actor=None,
        data={"token": grant.token, "name": name, "version": version, "sha": sha, "note": note},
    )
    return rec


# ---------------- PDF 水印 ----------------


def watermark_text(token: str, today: date | None = None) -> str:
    return f"审阅版 · {token[:6]} · {(today or cases.local_today()).isoformat()}"


def _stamp_page(width_pt: float, height_pt: float, text: str) -> bytes:
    """透明单页 PDF：页脚居中一行 text（simhei 缺失时退到 fontconfig 里的中文字体）。"""
    import matplotlib
    from matplotlib.backends.backend_pdf import FigureCanvasPdf
    from matplotlib.figure import Figure
    from matplotlib.font_manager import FontProperties

    fp = (
        FontProperties(fname=FONT_PATH)
        if os.path.isfile(FONT_PATH)
        else FontProperties(family=["SimHei", "Noto Sans CJK SC", "Noto Serif CJK SC", "sans-serif"])
    )
    fig = Figure(figsize=(width_pt / 72, height_pt / 72), dpi=72)
    FigureCanvasPdf(fig)
    fig.text(
        0.5,
        WATERMARK_BOTTOM_PT / height_pt,
        text,
        ha="center",
        va="bottom",
        fontsize=WATERMARK_FONT_PT,
        color="0.45",
        fontproperties=fp,
    )
    buf = io.BytesIO()
    with matplotlib.rc_context({"pdf.fonttype": 42}):
        fig.savefig(buf, format="pdf", transparent=True)
    return buf.getvalue()


def watermark(pdf_bytes: bytes, text: str) -> bytes:
    """每页叠加页脚；页面尺寸不同各自生成一张 stamp。失败抛异常，由调用方退回原 PDF。"""
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(io.BytesIO(pdf_bytes))
    writer = PdfWriter()
    stamps: dict[tuple[int, int], bytes] = {}
    for page in reader.pages:
        w, h = float(page.mediabox.width), float(page.mediabox.height)
        key = (round(w), round(h))
        if key not in stamps:
            stamps[key] = _stamp_page(w, h, text)
        page.merge_page(PdfReader(io.BytesIO(stamps[key])).pages[0])
        writer.add_page(page)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def watermarked_pdf(path: str, token: str) -> tuple[bytes, bool]:
    """→ (bytes, ok)。ok=False ⇒ 原 PDF（响应头 X-Watermark: unavailable）。"""
    with open(path, "rb") as f:
        raw = f.read()
    try:
        return watermark(raw, watermark_text(token)), True
    except Exception:  # noqa: BLE001 — 水印是派生物，失败不能挡住审阅
        log.exception("公开 PDF 水印失败：%s", path)
        return raw, False
