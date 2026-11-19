# -*- coding: utf-8 -*-
"""Step 2 回归测试：参考文献真实性核验（Citation Fact-Check / 防 AI 幻觉）。"""
from __future__ import annotations

import importlib
import sys

from fastapi.testclient import TestClient


def _boot(tmp_path, monkeypatch):
    proj = tmp_path / "projects"
    proj.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("PAPER_STUDIO_PROJECTS_DIR", str(proj))
    monkeypatch.setenv("PAPER_STUDIO_AUTH", "on")
    monkeypatch.setenv("PAPER_STUDIO_SECRET", "citation-verify-test-secret-32-chars!!")
    monkeypatch.setenv("PAPER_STUDIO_PRODUCT", "paper")
    monkeypatch.setenv("PAPER_STUDIO_LIBRARY_SOURCES", "on")

    for name in list(sys.modules):
        if name == "app" or name.startswith("app."):
            del sys.modules[name]
    import app.main as main_mod
    importlib.reload(main_mod)
    return main_mod.app


def _reg_login(app, email: str) -> TestClient:
    c = TestClient(app)
    r = c.post("/api/auth/register", json={"email": email, "password": "password1234", "display_name": "tester"})
    assert r.status_code in (200, 201), r.text
    r2 = c.post("/api/auth/cookie/login", data={"username": email, "password": "password1234"})
    assert r2.status_code in (200, 204), r2.text
    return c


def test_citation_fact_check_all_verdicts_and_permissions(tmp_path, monkeypatch):
    app = _boot(tmp_path, monkeypatch)
    owner = _reg_login(app, "cv-owner@example.com")
    pid = owner.post("/api/projects/showcase-demo", json={}).json()["id"]

    # 覆写 refs.bib 为 5 种典型核验场景
    bib_text = """@article{real2016,
  title={Deep Residual Learning for Image Recognition},
  author={He, Kaiming and Zhang, Xiangyu},
  year={2016},
  doi={10.1109/CVPR.2016.90}
}
@article{mismatch2020,
  title={Deep Residual Learning for Image Recognition},
  author={Smith, Alice},
  year={2020},
  doi={10.1109/CVPR.2016.90}
}
@article{retracted2021,
  title={Retracted Study on Something},
  author={Doe, Jane},
  year={2021},
  doi={10.1000/retracted.1}
}
@article{hallucinated2025,
  title={Completely Fabricated Quantum Paper by LLM},
  author={Nobody, Fake},
  year={2025}
}
@article{neterr2024,
  title={Timeout Paper During Verification},
  author={Net, Timeout},
  year={2024},
  doi={10.1000/timeout.1}
}
"""
    r_put = owner.put(f"/api/projects/{pid}/latex/files/refs.bib", json={"content": bib_text})
    assert r_put.status_code == 200, r_put.text

    from app.domain import library_sources as ls

    async def fake_lookup_doi(doi: str):
        d = doi.lower()
        if d == "10.1109/cvpr.2016.90":
            return {
                "source": "crossref",
                "matched": True,
                "fields": {
                    "title": "Deep Residual Learning for Image Recognition",
                    "authors": ["Kaiming He", "Xiangyu Zhang"],
                    "year": "2016",
                    "doi": doi,
                },
                "retraction": {"status": "unknown", "source": "crossref"},
            }
        if d == "10.1000/retracted.1":
            return {
                "source": "crossref",
                "matched": True,
                "fields": {
                    "title": "Retracted Study on Something",
                    "authors": ["Jane Doe"],
                    "year": "2021",
                    "doi": doi,
                },
                "retraction": {"status": "retracted", "source": "crossref"},
            }
        if d == "10.1000/timeout.1":
            raise ls.SourceError(504, "上游超时")
        raise ls.SourceError(404, "未找到")

    async def fake_search_openalex(query: str, limit: int = 5):
        return []

    monkeypatch.setattr(ls, "lookup_doi", fake_lookup_doi)
    monkeypatch.setattr(ls, "lookup_doi_openalex", fake_lookup_doi)
    monkeypatch.setattr(ls, "search_openalex", fake_search_openalex)

    # 1. 执行批量核验
    r = owner.post(f"/api/projects/{pid}/library/verify", json={})
    assert r.status_code == 200, r.text
    rep = r.json()
    assert rep["counts"] == {"verified": 1, "mismatch": 1, "retracted": 1, "unverified": 1, "error": 1}
    by_key = {it["citation_key"]: it for it in rep["items"]}
    assert by_key["real2016"]["status"] == "verified"
    assert by_key["mismatch2020"]["status"] == "mismatch"
    assert {d["field"] for d in by_key["mismatch2020"]["diffs"]} == {"year", "first_author"}
    assert by_key["retracted2021"]["status"] == "retracted"
    assert by_key["hallucinated2025"]["status"] == "unverified"
    assert by_key["neterr2024"]["status"] == "error"

    # 2. GET 读取缓存秒出且一致
    r_cached = owner.get(f"/api/projects/{pid}/library/verify")
    assert r_cached.status_code == 200
    assert r_cached.json()["counts"] == rep["counts"]

    # 3. 权限矩阵：匿名 401 / 外人 404 / viewer 200
    assert TestClient(app).get(f"/api/projects/{pid}/library/verify").status_code == 401
    outsider = _reg_login(app, "cv-out@example.com")
    assert outsider.post(f"/api/projects/{pid}/library/verify", json={}).status_code == 404
    viewer = _reg_login(app, "cv-view@example.com")
    owner.post(f"/api/projects/{pid}/invites", json={"email": "cv-view@example.com", "role": "viewer"})
    assert viewer.get(f"/api/projects/{pid}/library/verify").status_code == 200
