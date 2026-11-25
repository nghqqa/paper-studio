# -*- coding: utf-8 -*-
"""公共 Pandoc 运行原语单元测试：环境变量过滤、版式参数、运行时检查、超时处理、路径穿越阻断。"""

from __future__ import annotations

import subprocess
from types import SimpleNamespace

import pytest

from app.domain import pandoc_runner
from app.domain.projects import ProjectError


def test_clean_local_env_strips_secrets(monkeypatch):
    monkeypatch.setenv("PATH", "/usr/bin")
    monkeypatch.setenv("PATENT_STUDIO_SECRET", "super-secret-value")
    monkeypatch.setenv("DATABASE_URL", "postgresql://secret")

    env = pandoc_runner.clean_local_env({"PANDOC_DOC_LANG": "zh"})
    assert env["PATH"] == "/usr/bin"
    assert env["PANDOC_DOC_LANG"] == "zh"
    assert "PATENT_STUDIO_SECRET" not in env
    assert "DATABASE_URL" not in env


def test_jcip_layout_env():
    env = pandoc_runner.jcip_layout_env(title_pg=False)
    assert env["LAYOUT_PAGE_W"] == str(pandoc_runner.JCIP_LAYOUT_PARAMS["w"])
    assert env["LAYOUT_COL_SPACE"] == str(pandoc_runner.JCIP_LAYOUT_PARAMS["cs"])
    assert env["LAYOUT_TITLE_PG"] == "0"


def test_ensure_runtime_ready_missing_503():
    with pytest.raises(ProjectError) as exc_docker:
        pandoc_runner.ensure_runtime_ready("docker", which_fn=lambda _: None)
    assert exc_docker.value.status == 503

    with pytest.raises(ProjectError) as exc_local:
        pandoc_runner.ensure_runtime_ready("local", which_fn=lambda _: None)
    assert exc_local.value.status == 503

    assert pandoc_runner.ensure_runtime_ready("local", which_fn=lambda _: "/usr/bin/pandoc") == "local"


def test_run_pandoc_local_timeout_and_success(tmp_path):
    def fake_timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd="pandoc", timeout=1)

    rc, out, err = pandoc_runner.run_pandoc_local(
        ["--version"],
        cwd=str(tmp_path),
        timeout_s=1,
        env={},
        subprocess_run=fake_timeout,
    )
    assert (rc, out, err) == (-1, "", "转换超时")

    def fake_ok(*args, **kwargs):
        return SimpleNamespace(returncode=0, stdout="ok", stderr="")

    rc2, out2, err2 = pandoc_runner.run_pandoc_local(
        ["--version"],
        cwd=str(tmp_path),
        timeout_s=10,
        env={},
        subprocess_run=fake_ok,
    )
    assert (rc2, out2, err2) == (0, "ok", "")


def test_resolve_export_artifact_blocks_traversal_and_bad_name(tmp_path):
    eid_dir = tmp_path / "exp-1"
    eid_dir.mkdir()
    target = eid_dir / "paper.docx"
    target.write_bytes(b"PK")

    assert pandoc_runner.resolve_export_artifact(str(tmp_path), "exp-1", "paper.docx", ("paper.docx",)) == str(target)

    with pytest.raises(ProjectError) as bad_eid:
        pandoc_runner.resolve_export_artifact(str(tmp_path), "../evil", "paper.docx", ("paper.docx",))
    assert bad_eid.value.status == 400

    with pytest.raises(ProjectError) as bad_name:
        pandoc_runner.resolve_export_artifact(str(tmp_path), "exp-1", "secret.txt", ("paper.docx",))
    assert bad_name.value.status == 400

    with pytest.raises(ProjectError) as missing:
        pandoc_runner.resolve_export_artifact(str(tmp_path), "exp-2", "paper.docx", ("paper.docx",))
    assert missing.value.status == 404
