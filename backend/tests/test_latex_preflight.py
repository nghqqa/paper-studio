# -*- coding: utf-8 -*-
"""LaTeX 投稿前检查（latex-general/1 与 double-blind/1）只读体检回归。

覆盖：非注释 \\author 触发 warn、被 % 注释的 \\author 不误报（含 \\% 转义）、
TODO/\\hl/?? 残留、未定义 \\cite/\\ref（工程索引对账）、未解决 Issue、
源文件修改后 expired=true、viewer 权限 403、未知规则集 422、空 body 默认 latex-general。
全部为隔离探针（TestClient + latex-demo blank 种子，无真实编译器依赖）。
"""
import importlib
import json
import os
import sys

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def matrix(tmp_path_factory):
    base = tmp_path_factory.mktemp("latex-preflight")
    projects = base / "projects"
    projects.mkdir()
    env = {"PATENT_STUDIO_AUTH": "on", "PATENT_STUDIO_SECRET": "latex-pf-tests-secret-at-least-32-bytes",
           "PATENT_PROJECTS_DIR": str(projects),
           "PATENT_STUDIO_LEGACY_DATABASE_URL": f"sqlite:///{base}/studio.db",
           "PATENT_STUDIO_WORD_EDITOR": "on", "PATENT_STUDIO_ONLYOFFICE_JWT_SECRET": "word-test-secret",
           "PATENT_STUDIO_ONLYOFFICE_URL": "http://localhost:9980",
           "PATENT_STUDIO_ONLYOFFICE_INTERNAL_URL": "http://onlyoffice:80",
           "PATENT_STUDIO_PUBLIC_ORIGIN": "",
           "PATENT_STUDIO_ONLYOFFICE_PUBLIC_URL": "http://studio:8000"}
    previous = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    try:
        for name in ("app.config", "app.auth.db", "app.auth.users", "app.auth.acl", "app.auth.router", "app.main"):
            if name in sys.modules:
                importlib.reload(sys.modules[name])
            else:
                importlib.import_module(name)
        from patent_studio.asgi import create_app

        app = create_app()

        def register(name):
            c = TestClient(app)
            email = name + "@lpf.example.com"
            r = c.post("/api/auth/register", json={"email": email, "password": "Lpf-test-pw!"})
            assert r.status_code == 201, r.text
            r = c.post("/api/auth/cookie/login", data={"username": email, "password": "Lpf-test-pw!"})
            assert r.status_code == 204, r.text
            return c

        register("bootstrap")
        users = {k: register(k) for k in ("owner", "viewer", "outsider")}
        owner = users["owner"]
        r = owner.post("/api/projects/latex-demo", json={"template": "blank"})
        assert r.status_code == 200, r.text
        pid = r.json()["id"]
        for name in ("reviewer", "viewer"):
            r = owner.put(f"/api/projects/{pid}/members",
                          json={"email": name + "@lpf.example.com", "role": name})
            assert r.status_code in (200, 201), r.text
        return {"app": app, "users": users, "pid": pid, "root": projects}
    finally:
        for k, v in previous.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def put_main(matrix, content: str, rel: str = "main.tex"):
    r = matrix["users"]["owner"].put(
        f"/api/projects/{matrix['pid']}/latex/files/{rel}", json={"content": content})
    assert r.status_code == 200, r.text


def run_pf(matrix, body=None):
    return matrix["users"]["owner"].post(
        f"/api/projects/{matrix['pid']}/latex/preflight", json=body)


def get_pf(matrix, ruleset: str | None = None):
    url = f"/api/projects/{matrix['pid']}/latex/preflight"
    if ruleset:
        url += f"?ruleset={ruleset}"
    return matrix["users"]["owner"].get(url)


def statuses(report):
    return {it["rule_id"]: it["status"] for it in report["items"]}


def evidence(report, rule_id: str) -> str:
    return next(it["evidence"] for it in report["items"] if it["rule_id"] == rule_id)


MAIN_DIRTY = r"""\documentclass{ctexart}
\author{张三}
\thanks{国家自然科学基金资助（Grant No. 12345）}
\begin{document}
\section{引言}
TODO 补充实验细节
本方法引用已有工作\cite{nosuch2024}，如??。
如图\ref{fig:missing}所示。
完成度 50\% \hl{草稿高亮}
\section*{Acknowledgments}
% \author{李四}（被注释的作者行，不误报）
% TODO 注释掉的待办，不误报
\end{document}"""

MAIN_CLEAN = r"""\documentclass{ctexart}
\author{}
\begin{document}
\section{引言}\label{sec:intro}
本方法效果良好\cite{key21}，见图\ref{fig:one}。
\begin{figure}
\caption{示意图}\label{fig:one}
\end{figure}
\bibliography{refs}
\end{document}"""

REFS_BIB = """@article{key21,
  title = {某论文},
  author = {某作者},
  year = {2024},
}
"""


def test_latex_general_ruleset(matrix):
    """latex-general/1：残留/未定义引用/Issue 命中；bib 条目对账；干净稿全 pass。"""
    put_main(matrix, MAIN_DIRTY)
    r = run_pf(matrix)  # 空 body = 默认 latex-general
    assert r.status_code == 200, r.text
    report = r.json()["report"]
    assert report["ruleset_id"] == "latex-general" and report["ruleset_version"] == "1"
    st = statuses(report)
    # 残留：TODO / ?? / \hl 命中；注释行不出现在证据里
    assert st["latex-todo-residue"] == "warn"
    ev = evidence(report, "latex-todo-residue")
    assert "TODO" in ev and "\\hl" in ev
    assert "注释掉的待办" not in ev
    # 未定义引用：cite nosuch2024 + ref fig:missing；带 file:line
    assert st["latex-undefined-refs"] == "warn"
    ev = evidence(report, "latex-undefined-refs")
    assert "nosuch2024" in ev and "fig:missing" in ev
    # 无 Issue → pass
    assert st["latex-open-issues"] == "pass"
    # 报告绑定扫描文件哈希（main.tex）
    assert "main.tex" in report["digest"] and report["digest_sha"]

    # refs.bib 条目键参与对账：key21 定义后仍未覆盖 nosuch2024
    r = matrix["users"]["owner"].post(
        f"/api/projects/{matrix['pid']}/latex/files/refs.bib", json={"content": REFS_BIB})
    assert r.status_code == 200, r.text
    st = statuses(run_pf(matrix).json()["report"])
    assert st["latex-undefined-refs"] == "warn"
    assert "nosuch2024" in evidence(run_pf(matrix).json()["report"], "latex-undefined-refs")
    assert "key21" not in evidence(run_pf(matrix).json()["report"], "latex-undefined-refs")

    # 干净稿（cite key21 落在 refs.bib，ref fig:one 有 \label）→ 全 pass
    put_main(matrix, MAIN_CLEAN)
    report = run_pf(matrix, {}).json()["report"]
    st = statuses(report)
    assert set(st.values()) == {"pass"}, st
    # 报告分文件落盘；digest 含 .tex 与 .bib（latex-general 扫描口径）
    assert (matrix["root"] / matrix["pid"] / ".studio" / "latex" / "preflight-latex-general.json").is_file()
    assert "refs.bib" in report["digest"] and "main.tex" in report["digest"]

    # 手动 Issue → open-issues warn；解决后恢复 pass
    r = matrix["users"]["owner"].post(
        f"/api/projects/{matrix['pid']}/latex/issues", json={"message": "引言需要补相关工作对比"})
    assert r.status_code == 200, r.text
    issue_id = r.json()["id"]
    st = statuses(run_pf(matrix, {}).json()["report"])
    assert st["latex-open-issues"] == "warn"
    assert "引言需要补相关工作对比" in evidence(run_pf(matrix, {}).json()["report"], "latex-open-issues")
    r = matrix["users"]["owner"].patch(
        f"/api/projects/{matrix['pid']}/latex/issues/{issue_id}", json={"resolved": True})
    assert r.status_code == 200, r.text
    st = statuses(run_pf(matrix, {}).json()["report"])
    assert st["latex-open-issues"] == "pass"


def test_latex_double_blind_ruleset(matrix):
    """double-blind/1：非注释 \\author/\\thanks/Acknowledgments warn；请求屏蔽词命中；无词 unknown。"""
    put_main(matrix, MAIN_DIRTY)
    # 无屏蔽词：结构标记与基金词给确定结论，屏蔽词条目如实 unknown
    report = run_pf(matrix, {"ruleset": "double-blind"}).json()["report"]
    assert report["ruleset_id"] == "double-blind" and report["ruleset_version"] == "1"
    st = statuses(report)
    assert st["blind-author-block"] == "warn"
    ev = evidence(report, "blind-author-block")
    assert "\\author" in ev and "\\thanks" in ev and "Acknowledgments" in ev
    assert "李四" not in ev  # 被注释的 \author{李四} 不误报
    assert st["blind-author-terms"] == "unknown"
    assert st["blind-funding-terms"] == "warn"
    assert "国家自然科学基金" in evidence(report, "blind-funding-terms")
    # double-blind 报告只绑定 .tex（.bib 不参与匿名扫描）
    assert set(report["digest"]) == {"main.tex"}

    # 请求屏蔽词命中正文作者词
    report = run_pf(matrix, {"ruleset": "double-blind", "blind_terms": ["张三"]}).json()["report"]
    st = statuses(report)
    assert st["blind-author-terms"] == "warn"
    assert "张三" in evidence(report, "blind-author-terms")

    # 干净匿名稿（\author{} 为空、无标记）→ 结构标记 pass；项目设置屏蔽词生效
    r = matrix["users"]["owner"].put(
        f"/api/projects/{matrix['pid']}/settings", json={"blind_terms": ["张三", "某大学"]})
    assert r.status_code == 200, r.text
    put_main(matrix, MAIN_CLEAN)
    report = run_pf(matrix, {"ruleset": "double-blind"}).json()["report"]
    st = statuses(report)
    assert st["blind-author-block"] == "pass"
    assert st["blind-author-terms"] == "pass"
    assert st["blind-funding-terms"] == "pass"
    # 请求词优先：换未命中词 → pass
    report = run_pf(matrix, {"ruleset": "double-blind", "blind_terms": ["王五"]}).json()["report"]
    assert statuses(report)["blind-author-terms"] == "pass"


def test_latex_comment_only_markers_not_flagged(matrix):
    """整行 % 注释的标记一律跳过：TODO / \\author / 基金词 都不误报；\\% 转义不截断正文。"""
    put_main(matrix, r"""\documentclass{ctexart}
\begin{document}
\section{引言}
% TODO 补充实验
% \author{李四}
% 基金项目：国家自然科学（Grant No. 1）
正文完成度 50\% 保持扫描连续。
\end{document}""")
    report = run_pf(matrix, {"ruleset": "double-blind"}).json()["report"]
    st = statuses(report)
    assert st["blind-author-block"] == "pass"
    assert st["blind-funding-terms"] == "pass"
    report = run_pf(matrix, {"ruleset": "latex-general"}).json()["report"]
    st = statuses(report)
    assert st["latex-todo-residue"] == "pass"


def test_latex_preflight_expired(matrix):
    """源文件修改后：GET expired=true（指纹绑定）；重跑后恢复 false；分规则集报告互不串扰。"""
    put_main(matrix, MAIN_CLEAN)
    run_pf(matrix, {})  # 先生成与当前源码一致的报告
    assert get_pf(matrix).json()["expired"] is False
    put_main(matrix, MAIN_CLEAN + "\n% 修改一行\n")
    body = get_pf(matrix).json()
    assert body["expired"] is True
    assert body["report"]["digest"]["main.tex"] != body["current"]["digest_sha"]  # 指纹口径不同即过期
    run_pf(matrix, {})  # 重跑绑定新指纹
    assert get_pf(matrix).json()["expired"] is False
    # 分规则集指纹口径独立：改 refs.bib 只让 latex-general 过期（double-blind 只绑 .tex）
    put_main(matrix, REFS_BIB + "\n% 追加注释\n", rel="refs.bib")
    assert get_pf(matrix).json()["expired"] is True
    run_pf(matrix, {"ruleset": "double-blind"})
    assert get_pf(matrix, "double-blind").json()["expired"] is False


def test_latex_preflight_permissions_and_validation(matrix):
    """viewer 403（GET/POST 同 editor 门槛）；未知规则集 422；非 LaTeX 工程 4xx。"""
    pid = matrix["pid"]
    viewer = matrix["users"]["viewer"]
    outsider = matrix["users"]["outsider"]
    assert viewer.post(f"/api/projects/{pid}/latex/preflight").status_code == 403
    assert viewer.get(f"/api/projects/{pid}/latex/preflight").status_code == 403
    assert outsider.get(f"/api/projects/{pid}/latex/preflight").status_code in (403, 404)
    assert run_pf(matrix, {"ruleset": "nope"}).status_code == 422
    assert get_pf(matrix, "nope").status_code == 422

    # 非 LaTeX 工程（word 项目）明确拒绝
    owner = matrix["users"]["owner"]
    r = owner.post("/api/projects/word/create", json={"title": "非LaTeX", "template": "blank"})
    assert r.status_code == 200, r.text
    wpid = r.json()["id"]
    r = owner.post(f"/api/projects/{wpid}/latex/preflight")
    assert r.status_code in (400, 422)
