"""LaTeX 工程 → 中文期刊 DOCX 实验性导出（jcip profile）。

状态：**实验性**——由 PATENT_STUDIO_DOCX_EXPORT=on 显式开启（默认关）。
管线（venue-proto 原型验证后固化，证据链见 docs/design/w21-latex-compat-verification.md
§六A 第十三/十四/十五轮）：
  源码快照 → docker pandoc（reference.docx + GB/T 7714 CSL + 编号/版式 Lua 过滤器）
  → 布局安全化（图片缩栏宽/表格限宽）→ 一致性校验 → manifest（输入 SHA/警告/降级）。

硬边界：
  - 编号校验 fatal（未解析引用/重复 label/多编号公式环境）→ 无 DOCX 产出，manifest=blocked；
  - 产物恒标记实验性（未经 Word 人工逐项版式检查完成，版式符合性 L3 留人工）；
  - 仅支持 jcip profile（supported_commands 内的工程形态），不泛化；
  - 不替换 PDF 编译管线，不做双向同步。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
import zipfile
import xml.etree.ElementTree as ET

from app import config
from app.domain import latex_build, task_runner
from app.domain.projects import ProjectError

ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docx_export_assets")
EXPORTS_DIR = os.path.join(".studio", "docx-exports")
MANIFEST = "manifest.json"
ARTIFACT_NAMES = ("paper.docx", "report.json", "manifest.json")
VENUE = "jcip"

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(pid: str) -> threading.Lock:
    with _locks_guard:
        if pid not in _locks:
            _locks[pid] = threading.Lock()
        return _locks[pid]


def enabled() -> bool:
    return config.DOCX_EXPORT_ON


def exports_dir(project) -> str:
    return os.path.join(project.dir, EXPORTS_DIR)


def _docker_image() -> str:
    return config.DOCX_EXPORT_IMAGE


# --- 产物结构分析（自足实现，避免依赖 lab 脚本） ---

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_M = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"


def _analyze_docx(docx_path: str) -> dict:
    out: dict = {}
    try:
        with zipfile.ZipFile(docx_path) as z:
            doc_bytes = z.read("word/document.xml")
            names = z.namelist()
    except Exception as e:
        return {"wellformed": False, "error": f"zip 读取失败: {e}"}
    try:
        root = ET.fromstring(doc_bytes)
        out["wellformed"] = True
    except ET.ParseError as e:
        return {"wellformed": False, "error": f"document.xml 非良构: {e}"}
    text = "".join(t.text or "" for t in root.iter(f"{_W}t"))
    out.update({
        "oMath": sum(1 for _ in root.iter(f"{_M}oMath")),
        "oMathPara": sum(1 for _ in root.iter(f"{_M}oMathPara")),
        "tables": doc_bytes.count(b"<w:tbl>"),
        "images": len([n for n in names if n.startswith("word/media/")]),
        "chars": len(text),
    })
    residues = {c: text.count(c) for c in ("\\cite{", "\\ref{", "\\label{", "\\begin{", "\\includegraphics") if c in text}
    out["latex_residues"] = residues
    bookmarks = [b.get(f"{_W}name") for b in root.iter(f"{_W}bookmarkStart")]
    out["dup_bookmarks"] = sorted({b for b in bookmarks if bookmarks.count(b) > 1})
    anchors = [h.get(f"{_W}anchor") for h in root.iter(f"{_W}hyperlink") if h.get(f"{_W}anchor")]
    out["broken_links"] = sorted({a for a in anchors if a not in bookmarks})
    return out


def _verify_numbering(docx_path: str, numbering: dict) -> list[str]:
    """与 venue-proto 同语义的转换后一致性校验（编号/引用/书签在产物本体核对）。"""
    issues: list[str] = []
    with zipfile.ZipFile(docx_path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    text = "".join(t.text or "" for t in root.iter(f"{_W}t"))
    for pat, name in ((r"\[eq:[^\]\s]+\]", "公式引用残留"), (r"\[fig:[^\]\s]+\]", "图引用残留"),
                      (r"\[tab:[^\]\s]+\]", "表引用残留")):
        hits = re.findall(pat, text)
        if hits:
            issues.append(f"{name}: {', '.join(sorted(set(hits)))}")
    fig_n = {f["n"] for f in numbering.get("figures", [])}
    tab_n = {t["n"] for t in numbering.get("tables", [])}
    eq_n = {e["n"] for e in numbering.get("equations", [])}
    seen_fig, seen_tab = set(), set()
    for p in root.iter(f"{_W}p"):
        st = p.find(f"{_W}pPr/{_W}pStyle")
        sv = st.get(f"{_W}val") if st is not None else ""
        pt = "".join(t.text or "" for t in p.iter(f"{_W}t")).strip()
        if sv == "ImageCaption":
            m = re.match(r"^图(\d+) ", pt)
            if m:
                seen_fig.add(int(m.group(1)))
        elif sv == "TableCaption":
            m = re.match(r"^表(\d+) ", pt)
            if m:
                seen_tab.add(int(m.group(1)))
    if fig_n and seen_fig != fig_n:
        issues.append(f"图题注编号集合不一致: {sorted(seen_fig)} vs {sorted(fig_n)}")
    if tab_n and seen_tab != tab_n:
        issues.append(f"表题注编号集合不一致: {sorted(seen_tab)} vs {sorted(tab_n)}")
    expect = {f"({n})" for n in eq_n}
    found = {f"({int(x)})" for x in re.findall(r"\((\d+)\)", text)}
    miss = expect - found
    if miss:
        issues.append(f"公式编号引用缺失于正文: {sorted(miss)}")
    eq_label_n = {e["label"]: e["n"] for e in numbering.get("equations", [])}
    seen_labels = set()
    children = list(root.find(f"{_W}body"))
    pending: list[str] = []
    for idx, child in enumerate(children):
        if child.tag == f"{_W}bookmarkStart":
            nm = child.get(f"{_W}name")
            if nm:
                pending.append(nm)
        elif child.tag == f"{_W}p":
            names = pending + [b.get(f"{_W}name") for b in child.iter(f"{_W}bookmarkStart")]
            pending = []
            ptext = "".join(t.text or "" for t in child.iter(f"{_W}t"))
            nxt = ""
            if idx + 1 < len(children) and children[idx + 1].tag == f"{_W}p":
                nxt = "".join(t.text or "" for t in children[idx + 1].iter(f"{_W}t"))
            for nm in [n for n in names if n]:
                if nm in eq_label_n:
                    seen_labels.add(nm)
                    want = f"({eq_label_n[nm]})"
                    if want not in ptext and want not in nxt:
                        issues.append(f"公式对象段落缺少编号 {want}（{nm}）")
        elif child.tag == f"{_W}tbl":
            pending = []
    unprinted = set(eq_label_n) - seen_labels
    if unprinted:
        issues.append(f"带编号公式未找到宿主段落: {sorted(unprinted)}")
    return issues


def _layout_safe(docx_path: str) -> None:
    """图片缩栏宽 + 表格限 100% 栏宽（与 venue-proto 报告模块同语义，含良构校验）。"""
    TWIP_TO_EMU = 635
    with zipfile.ZipFile(docx_path) as z:
        others = {n: z.read(n) for n in z.namelist() if n != "word/document.xml"}
        doc = z.read("word/document.xml").decode("utf-8")
    pg = re.search(r"<w:pgSz[^>]*>", doc)
    text_w = 9360
    if pg:
        mw = re.search(r'w:w="(\d+)"', pg.group(0))
        if mw:
            text_w = int(mw.group(1))
            ml = re.search(r'<w:pgMar[^>]*w:left="(\d+)"', doc)
            mr = re.search(r'<w:pgMar[^>]*w:right="(\d+)"', doc)
            if ml and mr:
                text_w -= int(ml.group(1)) + int(mr.group(1))
    col_w = (text_w - 424) // 2 * TWIP_TO_EMU

    def scale_pair(m: "re.Match[str]") -> str:
        cx, cy = int(m.group(2)), int(m.group(3))
        if cx > col_w:
            r = col_w / cx
            return f'<{m.group(1)} cx="{int(cx * r)}" cy="{int(cy * r)}"/>'
        return m.group(0)

    doc = re.sub(r"<(wp:extent|a:ext)\s+cx=\"(\d+)\"\s+cy=\"(\d+)\"\s*/>", scale_pair, doc)

    def fit_tbl(m: "re.Match[str]") -> str:
        block = m.group(0)
        if "<w:tblW" in block:
            block = re.sub(r"<w:tblW [^>]*/>", '<w:tblW w:type="pct" w:w="5000"/>', block, count=1)
        else:
            block = block.replace("<w:tblPr>", '<w:tblPr><w:tblW w:type="pct" w:w="5000"/>', 1)
        return block

    doc = re.sub(r"<w:tbl>.*?</w:tbl>", fit_tbl, doc, flags=re.S)
    ET.fromstring(doc.encode("utf-8"))  # 良构校验
    tmp = docx_path + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for n, data in others.items():
            zout.writestr(n, data)
        zout.writestr("word/document.xml", doc)
    os.replace(tmp, docx_path)


def export_docx(store, pid: str) -> dict:
    """同步执行导出（路由 asyncio.to_thread 调用）。返回 manifest 摘要。"""
    latex_build._require_latex_project(store, pid)
    lock = _lock_for(pid)
    if not lock.acquire(blocking=False):
        raise ProjectError("该案已有导出在进行", 409)
    slot = task_runner.docx_slot()
    if not slot.acquire():  # 有限排队（TASK_QUEUE_WAIT_S），满载超时才 429
        lock.release()
        raise ProjectError(str(task_runner.Busy("DOCX 导出")), 429)
    try:
        project = store.get(pid)
        cfg = project.settings.get("latex") or {}
        main = str(cfg.get("main") or "")
        src_root = latex_build.source_root(project)
        if not main or not os.path.isfile(os.path.join(src_root, main)):
            raise ProjectError(f"主文件不存在：{main}", 422)
        if config.DOCX_EXPORT_RUNTIME == "docker" and not shutil.which("docker"):
            raise ProjectError("导出运行时为 docker，但当前环境不可用（或改用 PATENT_STUDIO_DOCX_EXPORT_RUNTIME=local）", 503)
        if config.DOCX_EXPORT_RUNTIME == "local" and not shutil.which(config.DOCX_EXPORT_PANDOC):
            raise ProjectError("导出运行时为 local，但镜像内未找到 pandoc（部署镜像应内置）", 503)

        digest = latex_build.digest_source(project)
        eid = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
        e_dir = os.path.join(exports_dir(project), eid)
        src_dir = os.path.join(e_dir, "src")
        os.makedirs(src_dir, exist_ok=True)
        for rel in digest:
            dst = os.path.join(src_dir, rel)
            os.makedirs(os.path.dirname(dst) or src_dir, exist_ok=True)
            shutil.copy2(os.path.join(src_root, rel), dst)
        # 管线资产（reference/csl/lua 过滤器）随运行目录进入容器
        assets_dir = os.path.join(e_dir, "assets")
        os.makedirs(assets_dir, exist_ok=True)
        for fn in os.listdir(ASSETS):
            shutil.copy2(os.path.join(ASSETS, fn), os.path.join(assets_dir, fn))

        bib_rel = _bib_of(src_root)
        bib_abs = os.path.join(src_root, bib_rel)
        if not os.path.isfile(bib_abs):
            raise ProjectError(
                "jcip 导出要求工程内存在 .bib 引用库（当前工程无 .bib）。"
                "引用策略为 citeproc+refs.bib 单路径，不支持 thebibliography 手写文献表。",
                422,
            )

        main_rel = f"src/{main.replace(os.sep, '/')}"
        numbering_rel = "numbering.json"
        pg = {"w": 11419, "h": 15600, "l": 907, "r": 907, "t": 623, "b": 284, "cs": 424}
        env = dict(os.environ)
        env.update({
            "PANDOC_NUMBERING_REPORT": numbering_rel,
            "LAYOUT_PAGE_W": str(pg["w"]), "LAYOUT_PAGE_H": str(pg["h"]),
            "LAYOUT_MAR_L": str(pg["l"]), "LAYOUT_MAR_R": str(pg["r"]),
            "LAYOUT_MAR_T": str(pg["t"]), "LAYOUT_MAR_B": str(pg["b"]),
            "LAYOUT_COL_SPACE": str(pg["cs"]), "LAYOUT_TITLE_PG": "1",
        })
        pandoc_args = [
            "--from=latex", "--to=docx", "--standalone", "--number-sections", "--wrap=auto",
            "--reference-doc", os.path.join("assets", "jcip-reference.docx"),
            "--citeproc", "--csl", os.path.join("assets", "gb7714-2015-numeric.csl"),
            "--bibliography", os.path.join("src", bib_rel),
            "--lua-filter", os.path.join("assets", "numbering.lua"),
            "--lua-filter", os.path.join("assets", "layout.lua"),
            "--resource-path", "src",
            "--output", "paper.docx", main_rel.replace("/", os.sep),
        ]
        t0 = time.perf_counter()
        if config.DOCX_EXPORT_RUNTIME == "docker":
            # Windows 开发态：宿主 docker 起 pandoc/latex 镜像（只挂导出运行目录）
            cmd = (
                "pandoc --version | head -1; "
                "pandoc --from=latex --to=docx --standalone --number-sections --wrap=auto "
                "--reference-doc=/proj/assets/jcip-reference.docx "
                "--citeproc --csl=/proj/assets/gb7714-2015-numeric.csl "
                f"--bibliography=/proj/src/{bib_rel} "
                "--lua-filter=/proj/assets/numbering.lua "
                "--lua-filter=/proj/assets/layout.lua "
                "--resource-path=/proj/src "
                f"--output=/proj/paper.docx /proj/{main_rel}"
            )
            proc = subprocess.run(
                ["docker", "run", "--rm", "--entrypoint", "sh",
                 "-v", f"{e_dir.replace(os.sep, '/')}:/proj", "-w", "/proj/src",
                 "-e", f"PANDOC_NUMBERING_REPORT=/proj/{numbering_rel}",
                 "-e", f"LAYOUT_PAGE_W={pg['w']}", "-e", f"LAYOUT_PAGE_H={pg['h']}",
                 "-e", f"LAYOUT_MAR_L={pg['l']}", "-e", f"LAYOUT_MAR_R={pg['r']}",
                 "-e", f"LAYOUT_MAR_T={pg['t']}", "-e", f"LAYOUT_MAR_B={pg['b']}",
                 "-e", f"LAYOUT_COL_SPACE={pg['cs']}", "-e", "LAYOUT_TITLE_PG=1",
                 _docker_image(), "-c", cmd],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=config.DOCX_EXPORT_TIMEOUT_S,
            )
            rc, out, err = proc.returncode, proc.stdout, proc.stderr
        else:
            # local：pandoc 在本容器内直接运行（试用部署形态；无 docker 依赖/无 socket）。
            # cwd 必须是 src/（\input 相对主文件目录解析；pandoc 3.1 对 resource-path 的
            # include 解析与 3.6 不同——实测 cwd=导出根目录时 \input 不被内联）。
            src_cwd = os.path.join(e_dir, "src")
            local_args = [
                "--from=latex", "--to=docx", "--standalone", "--number-sections", "--wrap=auto",
                "--reference-doc", os.path.join("..", "assets", "jcip-reference.docx"),
                "--citeproc", "--csl", os.path.join("..", "assets", "gb7714-2015-numeric.csl"),
                "--bibliography", bib_rel,
                "--lua-filter", os.path.join("..", "assets", "numbering.lua"),
                "--lua-filter", os.path.join("..", "assets", "layout.lua"),
                "--output", os.path.join("..", "paper.docx"),
                os.path.basename(main_rel),
            ]
            lenv = {k: v for k, v in env.items()}
            lenv["PANDOC_NUMBERING_REPORT"] = os.path.join("..", "numbering.json")
            rc = task_runner.run_task(
                [config.DOCX_EXPORT_PANDOC, *local_args],
                cwd=src_cwd,
                timeout_s=config.DOCX_EXPORT_TIMEOUT_S,
                env=lenv,
            )
            out, err = "", ""
        elapsed_ms = round((time.perf_counter() - t0) * 1000)
        pandoc_version = ""
        if config.DOCX_EXPORT_RUNTIME == "docker":
            pandoc_version = out.strip().splitlines()[0] if out.strip() else ""
        docx_path = os.path.join(e_dir, "paper.docx")

        numbering = None
        n_path = os.path.join(e_dir, "numbering.json")
        if os.path.isfile(n_path):
            with open(n_path, encoding="utf-8") as f:
                numbering = json.load(f)

        status, reasons = "pass", []
        if rc != 0:
            status = "blocked"
            reasons.append(f"pandoc 退出码 {rc}")
            if numbering and numbering.get("fatal"):
                reasons.append("编号校验失败（阻断）: " + "; ".join(numbering["fatal"]))
            if err:
                reasons.append("stderr: " + err.strip()[:400])
        else:
            # citeproc 未解析引用（引用键不在 .bib 中）→ 降级而非放行
            nf = re.findall(r"Citeproc: citation (\S+) not found", err or "")
            if nf:
                status = "degraded"
                reasons.append("citeproc 未解析引用: " + ", ".join(sorted(set(nf))))
        dx: dict = {}
        if os.path.isfile(docx_path):
            try:
                _layout_safe(docx_path)
            except Exception as e:  # noqa: BLE001
                status, reasons = "blocked", reasons + [f"布局安全化失败: {e}"]
            dx = _analyze_docx(docx_path)
            if dx.get("wellformed"):
                if dx.get("chars", 0) == 0:
                    status, reasons = "blocked", reasons + ["产物正文为空"]
                if dx.get("latex_residues"):
                    status = "degraded" if status == "pass" else status
                    reasons.append("LaTeX 残留: " + json.dumps(dx["latex_residues"], ensure_ascii=False))
                if dx.get("broken_links"):
                    status, reasons = "blocked", reasons + [f"断链: {dx['broken_links']}"]
                if dx.get("dup_bookmarks"):
                    status, reasons = "blocked", reasons + [f"重复书签: {dx['dup_bookmarks']}"]
                if numbering and numbering.get("fatal"):
                    status, reasons = "blocked", reasons + ["编号校验失败（阻断）: " + "; ".join(numbering["fatal"])]
                issues = _verify_numbering(docx_path, numbering or {})
                if issues:
                    status, reasons = "blocked", reasons + ["编号一致性: " + "; ".join(issues)]
                if status == "blocked" and os.path.isfile(docx_path):
                    # blocked 不得留下可下载的"成功产物"；报告/manifest 仍保留供诊断
                    os.remove(docx_path)
        elif status != "blocked":
            status, reasons = "blocked", reasons + ["产物不存在"]

        manifest = {
            "schema": "paper-studio/docx-export@1",
            "export_id": eid,
            "pid": pid,
            "venue": VENUE,
            "venue_display": "中文信息学报",
            "main": main,
            "digest": digest,
            "status": status,  # pass | degraded | blocked
            "export_status": "EXPERIMENTAL — 实验性导出；未经 Microsoft Word 人工逐项版式检查完成，"
                             "不得对外交付或声称符合期刊投稿要求",
            "degrades": reasons,
            "numbering": numbering,
            "docx": dx,
                        "tool": {"pandoc": pandoc_version, "runtime": config.DOCX_EXPORT_RUNTIME,
                     "image": _docker_image() if config.DOCX_EXPORT_RUNTIME == "docker" else None,
                     "exit_code": rc, "duration_ms": elapsed_ms,
                     "stderr": err.strip()[:2000]},
            "artifacts": {},  # 写盘后统计（report.json 由 manifest 派生）
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "finished_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        with open(os.path.join(e_dir, MANIFEST), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
        # report.json（面向下载的转换报告 = manifest 同构副本，文件名对用户语义更直白）
        shutil.copy2(os.path.join(e_dir, MANIFEST), os.path.join(e_dir, "report.json"))
        manifest["artifacts"] = {n: n for n in ARTIFACT_NAMES if os.path.isfile(os.path.join(e_dir, n))}
        # 同步回 report.json 副本
        with open(os.path.join(e_dir, "report.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
        with open(os.path.join(e_dir, MANIFEST), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
        task_runner.prune_dirs(exports_dir(project), config.ARTIFACT_KEEP)
        manifest["export_id"] = eid
        return manifest
    finally:
        slot.sem.release()
        lock.release()


def _bib_of(src_root: str) -> str:
    """找工程内第一个 .bib（jcip 策略要求引用走 refs.bib 单路径）。"""
    for root, _dirs, files in os.walk(src_root):
        for fn in files:
            if fn.endswith(".bib"):
                rel = os.path.relpath(os.path.join(root, fn), src_root)
                return rel.replace(os.sep, "/")
    return "refs.bib"


def list_exports(project) -> list[dict]:
    out = []
    base = exports_dir(project)
    if not os.path.isdir(base):
        return out
    cur = latex_build.digest_source(project)
    for eid in sorted(os.listdir(base), reverse=True):
        mp = os.path.join(base, eid, MANIFEST)
        if not os.path.isfile(mp):
            continue
        with open(mp, encoding="utf-8") as f:
            m = json.load(f)
        m["stale"] = m.get("digest") != cur
        m["export_id"] = eid
        out.append(m)
    return out


def load_export(project, eid: str) -> dict:
    mp = os.path.join(exports_dir(project), eid, MANIFEST)
    if not os.path.isfile(mp):
        raise ProjectError("导出记录不存在", 404)
    with open(mp, encoding="utf-8") as f:
        return json.load(f)


def artifact_file(project, eid: str, name: str) -> str:
    if name not in ARTIFACT_NAMES:
        raise ProjectError("非法产物名", 400)
    p = os.path.join(exports_dir(project), eid, name)
    if not os.path.isfile(p):
        raise ProjectError("产物不存在", 404)
    return p
