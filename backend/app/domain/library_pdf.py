# -*- coding: utf-8 -*-
"""学术 PDF 文献元数据与标识符提取：用于文献库 PDF 拖拽建条（只解析文本层，不做 OCR）。"""

from __future__ import annotations

import io
import json
import os
import re
import time

from pypdf import PdfReader
from pypdf.errors import PdfReadError

from app import atomic

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


PDF_MAX_BYTES = 25 * 1024 * 1024
_PDF_DIR = os.path.join(".studio", "library", "pdfs")


def _pdf_base(project_dir: str) -> str:
    return os.path.join(project_dir, _PDF_DIR)


def _manifest_path(project_dir: str) -> str:
    return os.path.join(_pdf_base(project_dir), "index.json")


def _load_manifest(project_dir: str) -> dict[str, dict]:
    p = _manifest_path(project_dir)
    if not os.path.isfile(p):
        return {}
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return dict(data) if isinstance(data, dict) else {}


def attached_map(project_dir: str) -> dict[str, dict]:
    with atomic.studio_lock(project_dir, "library-pdfs"):
        return _load_manifest(project_dir)


def attach_pdf(project_dir: str, rid: str, raw: bytes, filename: str = "paper.pdf") -> dict:
    if not raw or not raw.startswith(b"%PDF-"):
        raise ValueError("上传文件不是有效的 PDF 文档")
    if len(raw) > PDF_MAX_BYTES:
        raise ValueError("PDF 文件不能超过 25 MB")
    try:
        reader = PdfReader(io.BytesIO(raw))
        pages = len(reader.pages)
    except (PdfReadError, Exception) as exc:  # noqa: BLE001
        raise ValueError(f"无法读取 PDF「{filename}」：{exc}") from exc

    text_parts: list[str] = []
    for idx, page in enumerate(reader.pages[:12], 1):
        try:
            txt = (page.extract_text() or "").strip()
            if txt:
                text_parts.append(f"[Page {idx}]\n{txt}")
        except Exception:  # noqa: BLE001
            continue
    extracted = "\n\n".join(text_parts)[:40000]

    base = _pdf_base(project_dir)
    os.makedirs(base, exist_ok=True)
    safe_name = os.path.basename(filename or f"{rid}.pdf") or f"{rid}.pdf"
    if not safe_name.lower().endswith(".pdf"):
        safe_name += ".pdf"

    with atomic.studio_lock(project_dir, "library-pdfs"):
        atomic.write_bytes(os.path.join(base, f"{rid}.pdf"), raw)
        atomic.write_text(os.path.join(base, f"{rid}.txt"), extracted)
        manifest = _load_manifest(project_dir)
        meta = {
            "has_pdf": True,
            "filename": safe_name,
            "pages": pages,
            "size": len(raw),
            "text_chars": len(extracted),
            "uploaded_at": time.time(),
        }
        manifest[rid] = meta
        atomic.write_json(_manifest_path(project_dir), manifest)
        return meta


def get_pdf_path(project_dir: str, rid: str) -> tuple[str, str]:
    with atomic.studio_lock(project_dir, "library-pdfs"):
        manifest = _load_manifest(project_dir)
        meta = manifest.get(rid)
    pdf_path = os.path.join(_pdf_base(project_dir), f"{rid}.pdf")
    if not os.path.isfile(pdf_path):
        raise FileNotFoundError("该文献尚未附加 PDF 原文")
    return pdf_path, str((meta or {}).get("filename") or f"{rid}.pdf")


def get_pdf_text(project_dir: str, rid: str) -> dict:
    with atomic.studio_lock(project_dir, "library-pdfs"):
        manifest = _load_manifest(project_dir)
        meta = manifest.get(rid)
    txt_path = os.path.join(_pdf_base(project_dir), f"{rid}.txt")
    if not meta and not os.path.isfile(txt_path):
        raise FileNotFoundError("该文献尚未附加 PDF 原文")
    text = ""
    if os.path.isfile(txt_path):
        with open(txt_path, encoding="utf-8") as f:
            text = f.read()
    return {
        "filename": str((meta or {}).get("filename") or f"{rid}.pdf"),
        "pages": int((meta or {}).get("pages") or 0),
        "text": text,
    }


def delete_pdf(project_dir: str, rid: str) -> bool:
    with atomic.studio_lock(project_dir, "library-pdfs"):
        manifest = _load_manifest(project_dir)
        existed = rid in manifest
        manifest.pop(rid, None)
        atomic.write_json(_manifest_path(project_dir), manifest)
        for ext in (".pdf", ".txt"):
            p = os.path.join(_pdf_base(project_dir), f"{rid}{ext}")
            if os.path.isfile(p):
                os.remove(p)
                existed = True
        return existed
