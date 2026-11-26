# -*- coding: utf-8 -*-
"""A+B+C 组后端增强单测与集成测试（投稿打包、返修套件、体检新规则、PDF 抽提文献、科研新图型/误差棒/PDF 发布）。"""

from __future__ import annotations

import io
import json
import os
import zipfile

import pytest
from fastapi.testclient import TestClient

from app import config
from app.domain import latex_build, latex_diff, latex_preflight, latex_submission, library_pdf, library_sources, rebuttal
from app.main import app


def _make_pdf_bytes(text: str, title: str | None = None) -> bytes:
    """构造最小有效单页可读 PDF（含可选 /Title 元数据与文字层文本）。"""
    safe = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    stream = f"BT\n/F1 12 Tf\n72 720 Td\n({safe}) Tj\nET\n".encode("latin-1", errors="replace")
    objs: list[bytes] = []
    objs.append(b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")
    objs.append(b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n")
    objs.append(
        b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n"
    )
    objs.append(b"4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n")
    objs.append(
        f"5 0 obj\n<< /Length {len(stream)} >>\nstream\n".encode("ascii") + stream + b"\nendstream\nendobj\n"
    )
    if title:
        stitle = title.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        objs.append(f"6 0 obj\n<< /Title ({stitle}) >>\nendobj\n".encode("latin-1", errors="replace"))

    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = [0]
    for obj in objs:
        offsets.append(len(out))
        out.extend(obj)
    xref_pos = len(out)
    out.extend(f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode("ascii"))
    for off in offsets[1:]:
        out.extend(f"{off:010d} 00000 n \n".encode("ascii"))
    info_ref = f" /Info {len(objs)} 0 R" if title else ""
    out.extend(
        f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R{info_ref} >>\nstartxref\n{xref_pos}\n%%EOF\n".encode("ascii")
    )
    return bytes(out)


def test_strip_tex_comments_preserves_escapes_and_verbatim():
    src = (
        "% full line comment should go\n"
        "  % indented comment should go\n"
        "50\\% discount and 100\\% valid % trailing note\n"
        "line break\\\\ % comment after double backslash\n"
        "\\begin{verbatim}\n"
        "% keep verbatim comment!\n"
        "\\end{verbatim}\n"
        "\\begin{lstlisting}\n"
        "% keep code listing comment!\n"
        "\\end{lstlisting}\n"
        "\\section{Real} % secret todo\n"
    )
    cleaned = latex_submission.strip_tex_comments(src)
    assert "full line comment" not in cleaned
    assert "indented comment" not in cleaned
    assert "trailing note" not in cleaned
    assert "secret todo" not in cleaned
    assert "50\\% discount and 100\\% valid\n" in cleaned
    assert "line break\\\\\n" in cleaned
    assert "% keep verbatim comment!" in cleaned
    assert "% keep code listing comment!" in cleaned
    assert "\\section{Real}\n" in cleaned


@pytest.fixture()
def sandbox(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "AUTH_ON", False)
    monkeypatch.setattr(config, "PROJECTS_DIR", str(tmp_path / "projects"))
    os.makedirs(config.PROJECTS_DIR, exist_ok=True)
    with TestClient(app) as client:
        yield client, tmp_path


def test_submission_packager_and_revision_kit(sandbox):
    c, _tmp = sandbox
    pid = c.post("/api/projects/latex-demo", json={"template": "blank", "title": "PkgPaper"}).json()["id"]
    proj = app.state.store.get(pid)

    c.put(
        f"/api/projects/{pid}/latex/files/main.tex",
        json={
            "content": (
                "\\documentclass{article}\n"
                "\\usepackage{graphicx}\n"
                "\\graphicspath{{figures/}}\n"
                "% top secret note\n"
                "\\begin{document}\n"
                "See Fig.~\\ref{fig:used} for 90\\% accuracy. % draft remark\n"
                "\\begin{figure}\\includegraphics{arch}\\caption{A}\\label{fig:used}\\end{figure}\n"
                "\\begin{verbatim}\n% keep in verb\n\\end{verbatim}\n"
                "\\cite{smith2024}\n"
                "\\end{document}\n"
            )
        },
    )
    png_1x1 = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc```\x00\x00\x00\x04\x00\x01\xf6\x178U"
        b"\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    c.post(f"/api/projects/{pid}/latex/upload", data={"rel": "figures/arch.png", "overwrite": "true"}, files={"file": ("arch.png", png_1x1, "image/png")})
    c.post(f"/api/projects/{pid}/latex/upload", data={"rel": "figures/orphan.png", "overwrite": "true"}, files={"file": ("orphan.png", png_1x1, "image/png")})

    bdir = os.path.join(latex_build.builds_dir(proj), "20261126-000001-000000001")
    os.makedirs(bdir, exist_ok=True)
    fake_pdf = _make_pdf_bytes("Clean Manuscript Page 1", "Clean")
    with open(os.path.join(bdir, "main.pdf"), "wb") as f:
        f.write(fake_pdf)
    with open(os.path.join(bdir, "main.bbl"), "wb") as f:
        f.write(b"\\begin{thebibliography}{1}\\bibitem{smith2024}Smith.\\end{thebibliography}\n")
    with open(os.path.join(bdir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "build_id": "20261126-000001-000000001",
                "main": "main.tex",
                "status": "ok",
                "digest": latex_build.digest_source(proj),
            },
            f,
        )

    ddir = os.path.join(latex_diff.diffs_dir(proj), "20261126-000002-000000002")
    os.makedirs(ddir, exist_ok=True)
    with open(os.path.join(ddir, "diff.pdf"), "wb") as f:
        f.write(_make_pdf_bytes("Diff Highlight Page", "Diff"))
    with open(os.path.join(ddir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "diff_id": "20261126-000002-000000002",
                "status": "ok",
                "base_label": "v1",
                "target_label": "work",
            },
            f,
        )

    rebuttal._write(
        proj.dir,
        {
            "updated_at": "2026-11-26T00:00:00Z",
            "round": 1,
            "items": [
                {
                    "id": "r1c1",
                    "reviewer": "Reviewer 1",
                    "category": "major",
                    "text": "Please clarify Table 1.",
                    "status": "addressed",
                    "location": None,
                    "response": "We have clarified Table 1 in Section 3.",
                    "edits_summary": "Updated Section 3.",
                    "ai_draft": None,
                    "updated_at": None,
                    "round": 1,
                    "comment_ids": [],
                    "snapshot": None,
                }
            ],
            "warnings": [],
        },
    )

    prev = c.post(f"/api/projects/{pid}/latex/export-submission/preview", json={})
    assert prev.status_code == 200, prev.text
    pdata = prev.json()
    assert "figures/arch.png" in pdata["kept_media"]
    assert "figures/orphan.png" in pdata["pruned_media"]
    assert pdata["bbl_file"] == "main.bbl"
    assert "main.tex" in pdata["included_files"]

    zres = c.post(f"/api/projects/{pid}/latex/export-submission", json={})
    assert zres.status_code == 200
    with zipfile.ZipFile(io.BytesIO(zres.content)) as zf:
        names = set(zf.namelist())
        assert "figures/arch.png" in names
        assert "figures/orphan.png" not in names
        assert "main.bbl" in names
        tex_out = zf.read("main.tex").decode("utf-8")
        assert "top secret note" not in tex_out
        assert "draft remark" not in tex_out
        assert "90\\% accuracy" in tex_out
        assert "% keep in verb" in tex_out

    rk = c.post(f"/api/projects/{pid}/latex/export-revision-kit", json={})
    assert rk.status_code == 200, rk.text
    with zipfile.ZipFile(io.BytesIO(rk.content)) as rzf:
        rnames = set(rzf.namelist())
        assert {
            "01-manuscript-clean.pdf",
            "02-manuscript-marked-up-diff.pdf",
            "03-response-letter.md",
            "03-response-letter.tex",
            "03-response-letter.docx",
            "README-revision-kit.txt",
        } <= rnames


def test_preflight_new_rules_and_submission_readiness(sandbox):
    c, _tmp = sandbox
    pid = c.post("/api/projects/latex-demo", json={"template": "blank", "title": "PreChk"}).json()["id"]
    c.put(
        f"/api/projects/{pid}/latex/files/main.tex",
        json={
            "content": (
                "\\documentclass{article}\n"
                "\\begin{document}\n"
                "The XYZ model improves fine-tuning. Also XYZ supports fine tuning.\n"
                "\\begin{figure}\\caption{C}\\label{fig:orphanlbl}\\end{figure}\n"
                "\\cite{used2024}\n"
                "\\bibliography{refs}\n"
                "\\end{document}\n"
            )
        },
    )
    c.post(
        f"/api/projects/{pid}/latex/files/refs.bib",
        json={
            "content": (
                "@article{used2024, title={Used}, author={Doe, Jane}, year={2024}}\n"
                "@article{unused2023, title={Unused}, author={Roe, John}, year={2023}}\n"
            )
        },
    )
    png_1x1 = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc```\x00\x00\x00\x04\x00\x01\xf6\x178U"
        b"\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    c.post(f"/api/projects/{pid}/latex/upload", data={"rel": "figures/unused_img.png"}, files={"file": ("unused_img.png", png_1x1, "image/png")})

    gen = c.post(f"/api/projects/{pid}/latex/preflight", json={"ruleset": "latex-general"})
    assert gen.status_code == 200
    gitems = {it["rule_id"]: it["status"] for it in gen.json()["report"]["items"]}
    assert gitems["latex-unused-figures"] == "warn"
    assert gitems["latex-acronym-consistency"] == "warn"

    assert "submission-readiness" in latex_preflight.RULESETS
    sub = c.post(f"/api/projects/{pid}/latex/preflight", json={"ruleset": "submission-readiness"})
    assert sub.status_code == 200, sub.text
    sitems = {it["rule_id"]: it["status"] for it in sub.json()["report"]["items"]}
    assert sitems["sub-pdf-pages"] == "warn"
    assert sitems["sub-bbl-ready"] == "warn"
    assert sitems["sub-unused-figures"] == "warn"
    assert sitems["sub-uncited-bib"] == "warn"
    assert sitems["sub-acronym-consistency"] == "warn"


def test_library_extract_pdf_endpoint(sandbox, monkeypatch):
    c, _tmp = sandbox
    pid = c.post("/api/projects/latex-demo", json={"template": "blank", "title": "PdfBib"}).json()["id"]

    async def fake_doi(doi: str):
        return {
            "source": "crossref",
            "matched": True,
            "query": f"doi:{doi}",
            "fields": {
                "entry_type": "inproceedings",
                "title": "Neural Test Fixtures in Practice",
                "authors": ["Alice Smith", "Bob Jones"],
                "year": "2024",
                "venue": "NeurIPS",
                "doi": doi,
            },
            "retraction": {"status": "unknown", "source": "crossref", "checked_at": 0},
        }

    async def fake_arxiv(ident: str):
        return {
            "source": "arxiv",
            "matched": True,
            "query": f"arxiv:{ident}",
            "fields": {
                "entry_type": "article",
                "title": "Sparse Transformers at Scale",
                "authors": ["Carol Lin"],
                "year": "2025",
                "venue": "arXiv preprint",
                "arxiv_id": ident,
            },
            "retraction": {"status": "unknown", "source": "arxiv", "checked_at": 0},
        }

    monkeypatch.setattr(library_sources, "lookup_doi", fake_doi)
    monkeypatch.setattr(library_sources, "lookup_arxiv", fake_arxiv)

    pdf1 = _make_pdf_bytes("Available via doi: 10.1145/1234567.8901234", "Neural Test Fixtures")
    pdf2 = _make_pdf_bytes("Preprint arXiv:2501.01234v1", "Sparse Transformers")

    info1 = library_pdf.extract_identifiers_from_pdf(pdf1, "p1.pdf")
    assert info1["doi"] == "10.1145/1234567.8901234"
    info2 = library_pdf.extract_identifiers_from_pdf(pdf2, "p2.pdf")
    assert info2["arxiv_id"] == "2501.01234v1"

    resp = c.post(
        f"/api/projects/{pid}/library/extract-pdf",
        files=[
            ("files", ("p1.pdf", pdf1, "application/pdf")),
            ("files", ("p2.pdf", pdf2, "application/pdf")),
        ],
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["entries"]) == 2
    assert body["files"][0]["status"] == "matched"
    assert body["files"][1]["status"] == "matched"
    titles = {e["title"] for e in body["entries"]}
    assert "Neural Test Fixtures in Practice" in titles
    assert "Sparse Transformers at Scale" in titles


def test_charts_new_types_errors_values_and_pdf_publish(sandbox):
    c, _tmp = sandbox
    pid = c.post("/api/projects/latex-demo", json={"template": "blank", "title": "ChartPlus"}).json()["id"]

    fig_res = c.post(
        f"/api/project-figures/{pid}",
        json={
            "name": "acc-cmp",
            "type": "bar",
            "title": "Model Accuracy",
            "x_label": "Dataset",
            "y_label": "Acc (%)",
            "categories": ["C10", "C100"],
            "series": [
                {"name": "Ours", "values": [92.5, 76.1], "errors": [0.4, 0.8]},
                {"name": "Base", "values": [88.0, 71.2], "errors": [0.5, 0.9]},
            ],
            "palette": "academic",
            "show_values": True,
        },
    )
    assert fig_res.status_code == 200, fig_res.text
    fid = fig_res.json()["figure"]["id"]

    exp_pdf = c.get(f"/api/project-figures/{pid}/{fid}/export?format=pdf")
    assert exp_pdf.status_code == 200
    assert exp_pdf.content.startswith(b"%PDF")

    pub_pdf = c.post(f"/api/project-figures/{pid}/{fid}/publish-latex", json={"stem": "acc-cmp", "format": "pdf"})
    assert pub_pdf.status_code == 200, pub_pdf.text
    pdata = pub_pdf.json()
    assert pdata["path"] == "figures/acc-cmp.pdf"
    assert pdata["format"] == "pdf"
    assert "\\includegraphics[width=0.8\\linewidth]{figures/acc-cmp}" in pdata["snippet"]

    hm = c.post(
        f"/api/project-figures/{pid}",
        json={
            "name": "ablation-grid",
            "type": "heatmap",
            "categories": ["lr=1e-3", "lr=1e-4", "lr=1e-5"],
            "series": [
                {"name": "Layer 4", "values": [0.81, 0.88, 0.84]},
                {"name": "Layer 8", "values": [0.83, 0.91, 0.87]},
            ],
            "show_values": True,
        },
    )
    assert hm.status_code == 200, hm.text

    bp = c.post(
        f"/api/project-figures/{pid}",
        json={
            "name": "seed-spread",
            "type": "boxplot",
            "categories": ["S1", "S2", "S3", "S4", "S5"],
            "series": [
                {"name": "Baseline", "values": [81.0, 82.5, 80.2, 83.1, 81.9]},
                {"name": "Ours", "values": [86.0, 87.2, 85.9, 88.1, 86.5]},
            ],
            "palette": "colorblind",
            "show_values": True,
        },
    )
    assert bp.status_code == 200, bp.text

    # 中文标签在 Windows / Linux 环境均可渲染且矢量 PDF / PNG 正常导出
    hm_cjk = c.post(
        f"/api/project-figures/{pid}",
        json={
            "name": "heatmap-cjk",
            "type": "heatmap",
            "categories": ["lr=1e-3", "lr=1e-4"],
            "series": [
                {"name": "4层", "values": [0.81, 0.88]},
                {"name": "8层", "values": [0.83, 0.91]},
            ],
            "show_values": True,
        },
    )
    assert hm_cjk.status_code == 200, hm_cjk.text
    hm_fid = hm_cjk.json()["figure"]["id"]
    hm_pdf = c.get(f"/api/project-figures/{pid}/{hm_fid}/export?format=pdf")
    assert hm_pdf.status_code == 200
    assert hm_pdf.content.startswith(b"%PDF")
