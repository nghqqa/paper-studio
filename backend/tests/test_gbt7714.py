# -*- coding: utf-8 -*-
"""GB/T 7714-2015 国标渲染器测试（P1-0-A）。"""
import importlib
import os
import sys

import pytest
from fastapi.testclient import TestClient

PW = "gbt-pw!"


def _entry(**kw):
    from app.domain.library import LibraryEntry

    base = {"reference_id": "ref_000000000001", "citation_key": "k2026", "title": "默认题名"}
    base.update(kw)
    return LibraryEntry.model_validate(base)


# ---- 作者规范 ----


def test_authors_cn_basic():
    from app.domain import gbt7714

    assert gbt7714.format_authors_gbt(["张三", "李四", "王五"]) == "张三, 李四, 王五"


def test_authors_cn_over_three():
    from app.domain import gbt7714

    assert gbt7714.format_authors_gbt(["张三", "李四", "王五", "赵六"]) == "张三, 李四, 王五, 等"


def test_authors_western_last_first():
    from app.domain import gbt7714

    assert gbt7714.format_western_person("Vaswani, Ashish") == "Vaswani A"
    assert gbt7714.format_western_person("Ashish Vaswani") == "Vaswani A"
    assert gbt7714.format_western_person("Shazeer, Noam") == "Shazeer N"


def test_authors_western_over_three():
    from app.domain import gbt7714

    a = ["Vaswani, Ashish", "Shazeer, Noam", "Parmar, Niki", "Uszkoreit, Jakob"]
    assert gbt7714.format_authors_gbt(a) == "Vaswani A, Shazeer N, Parmar N, et al"


def test_authors_mixed():
    from app.domain import gbt7714

    out = gbt7714.format_authors_gbt(["张三", "李四", "王五", "Vaswani, Ashish"])
    assert out == "张三, 李四, 王五, 等"
    out2 = gbt7714.format_authors_gbt(["Vaswani, Ashish", "Shazeer, Noam", "Parmar, Niki", "张三"])
    assert out2 == "Vaswani A, Shazeer N, Parmar N, et al"


def test_authors_empty_and_literal():
    from app.domain import gbt7714

    assert gbt7714.format_authors_gbt([]) == ""
    assert gbt7714.format_western_person("{McDonald's}") == "McDonald's"
    assert gbt7714.format_western_person("张三") == "张三"


# ---- 类型标识 ----


def test_type_markers():
    from app.domain import gbt7714

    cases = {
        "article": "J", "inproceedings": "C", "conference": "C", "proceedings": "C",
        "phdthesis": "D", "mastersthesis": "D", "book": "M", "inbook": "M", "incollection": "M",
        "techreport": "R", "misc": "Z",
    }
    for t, marker in cases.items():
        assert gbt7714.type_marker(_entry(entry_type=t)) == marker, t
    assert gbt7714.type_marker(_entry(entry_type="misc", url="https://example.com/a")) == "EB/OL"
    assert gbt7714.type_marker(_entry(entry_type="whatever")) == "Z"


# ---- 条目格式 ----


def test_entry_cn_journal_full():
    from app.domain import gbt7714

    e = _entry(
        entry_type="article", title="基于大模型的学术写作助手研究",
        authors=["张三", "李四", "王五"],
        year="2026", venue="中文信息学报", volume="52", number="6", pages="1234-1245",
    )
    got = gbt7714.format_gbt7714_entry(e, 1)
    assert got == "[1] 张三, 李四, 王五. 基于大模型的学术写作助手研究[J]. 中文信息学报, 2026, 52(6): 1234-1245."


def test_entry_cn_journal_missing_fields():
    from app.domain import gbt7714

    e = _entry(entry_type="article", title="缺失期号页码", authors=["张三"], year="2025", venue="计算机学报", volume="48")
    got = gbt7714.format_gbt7714_entry(e, 2)
    assert got == "[2] 张三. 缺失期号页码[J]. 计算机学报, 2025, 48."


def test_entry_cn_journal_year_only():
    from app.domain import gbt7714

    e = _entry(entry_type="article", title="仅年份", authors=["张三"], year="2024", venue="XX 学报")
    got = gbt7714.format_gbt7714_entry(e, 3)
    assert got == "[3] 张三. 仅年份[J]. XX 学报, 2024."


def test_entry_conference_western():
    from app.domain import gbt7714

    e = _entry(
        entry_type="inproceedings", title="Attention Is All You Need",
        authors=["Vaswani, Ashish", "Shazeer, Noam", "Parmar, Niki", "Uszkoreit, Jakob"],
        year="2017", venue="Advances in Neural Information Processing Systems", pages="5998--6008",
    )
    got = gbt7714.format_gbt7714_entry(e, 4)
    assert got == (
        "[4] Vaswani A, Shazeer N, Parmar N, et al. Attention Is All You Need[C]"
        "//Advances in Neural Information Processing Systems, 2017: 5998-6008."
    )


def test_entry_thesis():
    from app.domain import gbt7714

    e = _entry(
        entry_type="phdthesis", title="基于知识图谱的问答系统研究",
        authors=["李四"], year="2021", fields={"school": "清华大学", "address": "北京"},
    )
    got = gbt7714.format_gbt7714_entry(e, 5)
    assert got == "[5] 李四. 基于知识图谱的问答系统研究[D]. 北京: 清华大学, 2021."


def test_entry_book():
    from app.domain import gbt7714

    e = _entry(
        entry_type="book", title="计量经济学", authors=["伍德里奇"],
        year="2020", publisher="机械工业出版社",
    )
    e.fields["address"] = "北京"
    got = gbt7714.format_gbt7714_entry(e, 6)
    assert got == "[6] 伍德里奇. 计量经济学[M]. 北京: 机械工业出版社, 2020."


def test_entry_book_with_pages():
    from app.domain import gbt7714

    e = _entry(
        entry_type="book", title="统计学", authors=["贾俊平"], year="2018",
        publisher="中国人民大学出版社", pages="12--20",
    )
    got = gbt7714.format_gbt7714_entry(e, 7)
    assert got == "[7] 贾俊平. 统计学[M]. 中国人民大学出版社, 2018: 12-20."


def test_entry_online_misc():
    from app.domain import gbt7714

    e = _entry(
        entry_type="misc", title="开放原子开源基金会年报",
        authors=["开放原子开源基金会"], year="2025", url="https://www.openatom.org/report",
    )
    got = gbt7714.format_gbt7714_entry(e, 8)
    assert got == "[8] 开放原子开源基金会. 开放原子开源基金会年报[EB/OL]. (2025) https://www.openatom.org/report."


def test_entry_online_no_author_no_year():
    from app.domain import gbt7714

    e = _entry(entry_type="misc", title="某网页资料", url="https://example.com/x")
    got = gbt7714.format_gbt7714_entry(e, 9)
    assert got == "[9] 某网页资料[EB/OL]. https://example.com/x."


def test_entry_no_authors_uses_title():
    from app.domain import gbt7714

    e = _entry(entry_type="article", title="无作者条目", year="2023", venue="学报")
    got = gbt7714.format_gbt7714_entry(e, 10)
    assert got == "[10] 无作者条目[J]. 学报, 2023."


def test_bibliography_dict_shape():
    from app.domain import gbt7714

    e1 = _entry(entry_type="article", title="甲", authors=["张三"], year="2024", venue="学报")
    e2 = _entry(reference_id="ref_000000000002", entry_type="book", title="乙", authors=["李四"], year="2023", publisher="出版社")
    out = gbt7714.format_gbt7714_bibliography([e1, e2])
    assert out["style"] == "gb-t-7714-2015"
    assert out["labels"] == {"ref_000000000001": "[1]", "ref_000000000002": "[2]"}
    assert len(out["bibliography"]) == 2
    assert out["bibliography"][0].startswith("[1] ")
    assert "非 Word 原生" in out["note"]


# ---- 范围压缩 / 括号解析 ----


def test_compress_number_ranges():
    from app.domain import gbt7714

    assert gbt7714.compress_number_ranges([1, 2]) == "1,2"
    assert gbt7714.compress_number_ranges([1, 2, 3]) == "1-3"
    assert gbt7714.compress_number_ranges([1, 2, 3, 5]) == "1-3,5"
    assert gbt7714.compress_number_ranges([3, 1, 2]) == "1-3"
    assert gbt7714.compress_number_ranges([7]) == "7"
    assert gbt7714.compress_number_ranges([]) == ""
    assert gbt7714.compress_number_ranges([1, 2, 3, 4, 8, 9]) == "1-4,8,9"  # 2 连号不压缩


def test_parse_citation_numbers():
    from app.domain import gbt7714

    assert gbt7714.parse_citation_numbers("1") == [1]
    assert gbt7714.parse_citation_numbers("1, 3-5") == [1, 3, 4, 5]
    assert gbt7714.parse_citation_numbers("1-3") == [1, 2, 3]
    assert gbt7714.parse_citation_numbers("1，3") == [1, 3]
    # 年份/非法区间不展开
    assert gbt7714.parse_citation_numbers("2020") == []
    assert gbt7714.parse_citation_numbers("2020-2024") == []
    assert gbt7714.parse_citation_numbers("5-3") == []
    assert gbt7714.parse_citation_numbers("99-200") == []  # 跨度 >100 放弃
    # 非常规 token 整括号放弃
    assert gbt7714.parse_citation_numbers("1, 甲") == []


# ---------------------------------------------------------------- 端点 ----


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    base = tmp_path_factory.mktemp("gbt7714")
    env = {
        "PATENT_STUDIO_AUTH": "on",
        "PATENT_STUDIO_SECRET": "gbt-secret",
        "PATENT_PROJECTS_DIR": str(base / "projects"),
        "PATENT_STUDIO_LEGACY_DATABASE_URL": f"sqlite:///{base}/studio.db",
    }
    old = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    (base / "projects").mkdir()
    try:
        for name in ("app.config", "app.auth.db", "app.auth.users", "app.auth.acl", "app.auth.router", "app.main"):
            mod = sys.modules.get(name)
            if mod is not None:
                importlib.reload(mod)
            else:
                importlib.import_module(name)
        from patent_studio.asgi import create_app

        app = create_app()

        def register(email):
            cc = TestClient(app)
            st = cc.post("/api/auth/register", json={"email": email, "password": PW})
            assert st.status_code in (200, 201), st.text
            st = cc.post("/api/auth/cookie/login", data={"username": email, "password": PW},
                         headers={"Content-Type": "application/x-www-form-urlencoded"})
            assert st.status_code == 204, st.status_code
            return cc

        yield {"app": app, "register": register}
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


_PROJ_CACHE: dict = {}


def _project_with_entries(env):
    if _PROJ_CACHE:
        return _PROJ_CACHE["c"], _PROJ_CACHE["pid"], _PROJ_CACHE["rids"]
    c = env["register"]("gbt@endpoint.example.com")
    r = c.post("/api/projects/latex-demo", json={"template": "jcip"})
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    files = c.get(f"/api/projects/{pid}/library").json()["bib_files"]
    if "refs.bib" not in files:
        r = c.post(f"/api/projects/{pid}/library/bib-file", json={"name": "refs.bib"})
        assert r.status_code == 200, r.text
    entries = [
        {
            "citation_key": "zhang2026", "entry_type": "article",
            "title": "基于大模型的学术写作助手研究",
            "authors": ["张三", "李四", "王五"],
            "year": "2026", "venue": "中文信息学报", "volume": "52", "number": "6", "pages": "1234-1245",
            "fields": {"title": "基于大模型的学术写作助手研究", "author": "张三 and 李四 and 王五",
                       "journal": "中文信息学报", "year": "2026", "volume": "52", "number": "6", "pages": "1234-1245"},
        },
        {
            "citation_key": "vaswani2017", "entry_type": "inproceedings",
            "title": "Attention Is All You Need",
            "authors": ["Vaswani, Ashish", "Shazeer, Noam", "Parmar, Niki", "Uszkoreit, Jakob"],
            "year": "2017", "venue": "NeurIPS", "pages": "5998--6008",
            "fields": {"title": "Attention Is All You Need", "author": "Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob",
                       "booktitle": "NeurIPS", "year": "2017", "pages": "5998--6008"},
        },
    ]
    r = c.post(f"/api/projects/{pid}/library/commit", json={"entries": entries, "target_bib": "refs.bib"})
    assert r.status_code == 200, r.text
    rids = r.json()["reference_ids"]
    _PROJ_CACHE.update({"c": c, "pid": pid, "rids": rids})
    return c, pid, rids


def test_bibliography_endpoint_gb_style(env):
    c, pid, rids = _project_with_entries(env)
    r = c.post(f"/api/projects/{pid}/library/bibliography",
               json={"order": rids, "style": "gb-t-7714-2015"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["style"] == "gb-t-7714-2015"
    assert body["labels"][rids[0]] == "[1]"
    assert body["labels"][rids[1]] == "[2]"
    assert body["bibliography"][0] == "[1] 张三, 李四, 王五. 基于大模型的学术写作助手研究[J]. 中文信息学报, 2026, 52(6): 1234-1245."
    assert body["bibliography"][1] == (
        "[2] Vaswani A, Shazeer N, Parmar N, et al. Attention Is All You Need[C]"
        "//NeurIPS, 2017: 5998-6008."
    )
    assert "非 Word 原生" in body["note"]


def test_bibliography_endpoint_ieee_style_unchanged(env):
    c, pid, rids = _project_with_entries(env)
    r = c.post(f"/api/projects/{pid}/library/bibliography", json={"order": [rids[1]], "style": "ieee"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["style"] == "ieee"
    assert body["labels"][rids[1]] == "[1]"
    assert any("Vaswani" in item for item in body["bibliography"])
    assert "非 Word 原生" in body["note"]


def test_bibliography_endpoint_default_stays_ieee(env):
    c, pid, rids = _project_with_entries(env)
    r = c.post(f"/api/projects/{pid}/library/bibliography", json={"order": [rids[0]]})
    assert r.status_code == 200, r.text
    assert r.json()["style"] == "ieee"


def test_bibliography_endpoint_invalid_style_422(env):
    c, pid, rids = _project_with_entries(env)
    r = c.post(f"/api/projects/{pid}/library/bibliography", json={"order": [rids[0]], "style": "apa"})
    assert r.status_code == 422, r.text
    assert "暂不支持引用样式" in r.json()["detail"]["message"]


def test_bibliography_endpoint_missing_rid_404(env):
    c, pid, rids = _project_with_entries(env)
    r = c.post(f"/api/projects/{pid}/library/bibliography",
               json={"order": ["ref_nonexistent00"], "style": "gb-t-7714-2015"})
    assert r.status_code == 404, r.text

