# -*- coding: utf-8 -*-
"""结构化论文导出：jcip 子集 LaTeX → pandoc（reference/numbering/layout）→ DOCX → 公式编号版式。

- 转换器：复用镜像内 pandoc + docx_export_assets（jcip-reference.docx / numbering.lua / layout.lua），
  与 jcip LaTeX 导出同一运行方式（local runtime：pandoc 在同容器内）。
- 门禁：structured.validate 不过（失效引用/不支持命令/空公式）→ 422 阻断，不产文件。
- 编号版式：docx_post.apply_eq_layout（tab=制表位：公式居中+编号靠右；table=无边框 1×2 表格）。
- manifest：内容 sha、版本 vid、资源摘要、profile、pandoc 版本、eqnum 模式与段数。
- 失败不留产物：workdir 在临时目录，成功后才复制进 artifacts。
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile

from app import config
from app.domain import structured

ASSETS = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                      "..", "docx_export_assets"))

PROFILE = "jcip"
LAYOUT_PARAMS = {"w": 11419, "h": 15600, "l": 907, "r": 907, "t": 623, "b": 284, "cs": 424}


def _resource_files(project_dir: str, content: dict) -> tuple[dict, dict]:
    """返回 (rid→figs 内文件名, rid→sha256)。仅收集被 figure 块引用的资源。"""
    files, digests = {}, {}
    rdir = os.path.join(project_dir, "resources")
    for b in content.get("body", []):
        if b.get("type") != "figure" or not b.get("resource"):
            continue
        rid = b["resource"]
        for ext in (".png", ".jpg", ".jpeg", ".gif"):
            p = os.path.join(rdir, rid + ext)
            if os.path.exists(p):
                fname = rid + ext
                files[rid] = fname
                with open(p, "rb") as f:
                    digests[fname] = hashlib.sha256(f.read()).hexdigest()
                break
    return files, digests


def _pandoc_version() -> str:
    try:
        r = subprocess.run([config.DOCX_EXPORT_PANDOC or "pandoc", "--version"],
                           capture_output=True, text=True, timeout=30)
        return (r.stdout.splitlines() or ["?"])[0].strip()
    except Exception as e:
        return f"unavailable: {e}"


def _local_pandoc() -> tuple[str, str]:
    binary = config.DOCX_EXPORT_PANDOC or "pandoc"
    version = _pandoc_version()
    parsed = re.search(r"\bpandoc(?:\.exe)?\s+(\d+)\.(\d+)", version)
    if not parsed or tuple(map(int, parsed.groups())) < (3, 1):
        raise StructExportUnavailable(
            f"旧稿转为 Word 需要 Pandoc 3.1 或更高版本（当前：{version}）。"
            "请通过 PATENT_STUDIO_DOCX_PANDOC 配置受支持的 Pandoc 可执行文件；原稿已保留。")
    return binary, version


def export_docx(project_dir: str, content: dict, content_sha: str, content_vid: str,
                mode: str = "tab") -> dict:
    """校验 → 生成 LaTeX → pandoc → 编号版式 → manifest。返回产物 dict（docx 路径/manifest）。"""
    gate = structured.validate(content)
    if not gate["ok"]:
        raise StructExportBlocked(gate["errors"])

    runtime = getattr(config, "DOCX_EXPORT_RUNTIME", "local")
    binary, pandoc_version = _local_pandoc() if runtime != "docker" else ("pandoc", "pandoc/latex:3.6.4")

    workdir = tempfile.mkdtemp(prefix="struct-export-")
    try:
        src = os.path.join(workdir, "src")
        figs = os.path.join(src, "figs")
        assets = os.path.join(workdir, "assets")
        os.makedirs(figs, exist_ok=True)
        os.makedirs(assets, exist_ok=True)
        for fn in os.listdir(ASSETS):
            shutil.copy2(os.path.join(ASSETS, fn), os.path.join(assets, fn))

        res_files, res_digests = _resource_files(project_dir, content)
        for _rid, fname in res_files.items():
            shutil.copy2(os.path.join(project_dir, "resources", fname),
                         os.path.join(figs, fname))

        latex = structured.gen_latex(content, resource_files=res_files)
        tex_path = os.path.join(src, "main.tex")
        with open(tex_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(latex)

        env = dict(os.environ)
        env.update({f"LAYOUT_{k}": str(v) for k, v in LAYOUT_PARAMS.items()})
        env["PANDOC_NUMBERING_REPORT"] = os.path.join(workdir, "numbering.json")

        docx = os.path.join(workdir, "paper.docx")
        if runtime == "docker":
            # Windows 开发态：宿主 docker 起 pandoc/latex 镜像（只挂导出运行目录）——
            # 与 docx_export.py 的 docker 运行时同一模式（本机已实测）。
            env_pairs = []
            for k in ("PANDOC_NUMBERING_REPORT",):
                env_pairs += [f"-e {k}={env[k]}"]
            for k, v in LAYOUT_PARAMS.items():
                env_pairs += [f"-e LAYOUT_{k}={v}"]
            cmd = (
                "pandoc --from=latex --to=docx --standalone --number-sections --wrap=auto "
                "--reference-doc=/proj/assets/jcip-reference.docx "
                "--lua-filter=/proj/assets/numbering.lua "
                "--lua-filter=/proj/assets/layout.lua "
                "--resource-path=/proj/src "
                "--output=/proj/paper.docx /proj/src/main.tex"
            )
            proc = subprocess.run(
                ["docker", "run", "--rm", "--entrypoint", "sh",
                 "-v", workdir.replace(os.sep, "/") + ":/proj",
                 *env_pairs, "pandoc/latex:3.6.4", "-c", cmd],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300,
            )
            if proc.returncode != 0 or not os.path.exists(docx):
                raise RuntimeError(f"pandoc(docker) 转换失败 rc={proc.returncode}\n{proc.stderr[-1200:]}")
        else:
            args = [
                binary, "--from=latex", "--to=docx", "--standalone", "--number-sections",
                "--wrap=auto",
                "--reference-doc", os.path.join(assets, "jcip-reference.docx"),
                "--lua-filter", os.path.join(assets, "numbering.lua"),
                "--lua-filter", os.path.join(assets, "layout.lua"),
                "--resource-path", src,
                "--output", os.path.join(workdir, "paper.docx"),
                tex_path,
            ]
            proc = subprocess.run(args, capture_output=True, text=True,
                                  encoding="utf-8", errors="replace", timeout=300, env=env)
            if proc.returncode != 0 or not os.path.exists(docx):
                raise RuntimeError(f"pandoc 转换失败 rc={proc.returncode}\n{proc.stderr[-1200:]}")

        report = {}
        if os.path.exists(env["PANDOC_NUMBERING_REPORT"]):
            with open(env["PANDOC_NUMBERING_REPORT"], encoding="utf-8") as f:
                report = json.load(f)
        if report.get("fatal"):
            raise StructExportBlocked(["编号门禁：" + x for x in report["fatal"]])

        from app.domain import docx_post
        n = docx_post.apply_eq_layout(docx, mode=mode)
        docx_post.apply_meta_layout(docx, affil=content.get("affil", ""))

        sha = hashlib.sha256(open(docx, "rb").read()).hexdigest()
        manifest = {
            "profile": PROFILE,
            "mode": mode,
            "content_sha256": content_sha,
            "content_version": content_vid,
            "resource_digests": res_digests,
            "docx_sha256": sha,
            "latex_sha256": hashlib.sha256(latex.encode()).hexdigest(),
            "numbering": {k: report.get(k) for k in ("equations", "figures", "tables")},
            "eqnum_paragraphs": n,
            "pandoc": pandoc_version,
        }
        with open(os.path.join(workdir, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=1)
        return {"workdir": workdir, "docx": docx, "manifest": manifest,
                "latex_sha256": manifest["latex_sha256"]}
    except Exception:
        shutil.rmtree(workdir, ignore_errors=True)
        raise


class StructExportBlocked(RuntimeError):
    """导出门禁阻断（失效引用/不支持命令/编号冲突）。携带 errors 列表。"""

    def __init__(self, errors: list):
        self.errors = errors
        super().__init__("导出阻断：\n" + "\n".join("- " + e for e in errors))


class StructExportUnavailable(RuntimeError):
    """The configured local converter cannot execute this project's filters."""
