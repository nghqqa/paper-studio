# -*- coding: utf-8 -*-
"""学术 PDF 文献元数据与标识符提取：用于文献库 PDF 拖拽建条（只解析文本层，不做 OCR）。"""

from __future__ import annotations

import io
import re

from pypdf import PdfReader
from pypdf.errors import PdfReadError

_ARXIV_RE = re.compile(
    r"(?:arXiv\s*:\s*|arxiv\.org/(?:abs|pdf)/)([a-z\-]+(?:\.[A-Z]{2})?/\d{7}(?:v\d+)?|\d{4}\.\d{4,5}(?:v\d+)?)",
    re.IGNORECASE,
)
_DOI_RE = re.compile(r"\b(10\.\d{4,9}/[^\s\]\)>,;\"'<>]+)", re.IGNORECASE)
_JUNK_META_RE = re.compile(r"(?:microsoft\s+word|untitled|\.pdf$|\.docx?$|slide\b|presentation)", re.IGNORECASE)
_SKIP_LINE_RE = re.compile(
    r"^(?:arxiv:|https?://|doi:|proceedings|preprint|published|accepted|copyright|©|page\s+\d+|\d+$)",
    re.IGNORECASE,
)


def _clean_doi(raw: str) -> str:
    return raw.rstrip(".,;:)]}'\"")


def _guess_title(meta_title: str | None, first_page: str) -> str | None:
    if meta_title:
        mt = re.sub(r"\s+", " ", meta_title).strip()
        if len(mt) >= 6 and not _JUNK_META_RE.search(mt):
            return mt[:240]
    lines = [re.sub(r"\s+", " ", ln).strip() for ln in first_page.splitlines()]
    cands: list[str] = []
    for ln in lines[:40]:
        if not ln:
            if cands:
                break
            continue
        if re.match(r"^(?:abstract|introduction|keywords)\b", ln, re.IGNORECASE):
            break
        if _SKIP_LINE_RE.search(ln) or "@" in ln:
            continue
        if len(ln) >= 12 or cands:
            cands.append(ln)
            if len(" ".join(cands)) >= 40:
                break
    if cands:
        title = " ".join(cands).strip()
        if len(title) >= 8:
            return title[:240]
    return None


def extract_identifiers_from_pdf(raw: bytes, filename: str = "paper.pdf") -> dict:
    """从 PDF 前 3 页文本层与文档元数据提取 DOI / arXiv ID / 候选标题。"""
    if not raw:
        raise ValueError(f"{filename} 内容为空")
    try:
        reader = PdfReader(io.BytesIO(raw))
    except (PdfReadError, Exception) as exc:  # noqa: BLE001
        raise ValueError(f"无法解析 PDF「{filename}」（可能损坏或加密）：{exc}") from exc

    meta = reader.metadata or {}
    meta_parts = [
        str(meta.get(k) or "")
        for k in ("/Title", "/Subject", "/Keywords", "/Author")
        if meta.get(k)
    ]
    page_texts: list[str] = []
    for page in reader.pages[:3]:
        try:
            page_texts.append(page.extract_text() or "")
        except Exception:  # noqa: BLE001
            continue
    combined = "\n".join(meta_parts + page_texts)[:24000]
    first_page = page_texts[0] if page_texts else ""

    doi: str | None = None
    if dm := _DOI_RE.search(combined):
        doi = _clean_doi(dm.group(1))

    arxiv_id: str | None = None
    if am := _ARXIV_RE.search(combined):
        arxiv_id = am.group(1)

    title = _guess_title(str(meta.get("/Title") or "") or None, first_page)
    return {
        "filename": filename,
        "doi": doi,
        "arxiv_id": arxiv_id,
        "title": title,
        "pages": len(reader.pages),
        "text_chars": sum(len(t) for t in page_texts),
    }
