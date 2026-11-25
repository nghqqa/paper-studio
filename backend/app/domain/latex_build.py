# -*- coding: utf-8 -*-
"""LaTeX 工程构建执行器（w21 批 A 最小闭环）。

与 Markdown 构建队列（domain/build.py）分开的原因：run_build 硬绑 critic.resolve + patent/paper 内核 +
lint + LibreOffice PDF；LaTeX 的输入是文件集合而非 content.md，产物由 latexmk 生成——强行塞进公共队列
需要拆掉它的每个阶段假设。本项目级并发控制、产物目录、计时口径与其对齐，但实现独立、互不影响。

隔离口径（本轮边界）：
- 编译输入 = 已保存源文件复制到 `.studio/latex-builds/<id>/` 的独立快照；编译器不写回源目录；
- 每次 build 一个项目级锁：同项目并发请求直接 409 job_busy（不做排队合并）；
- 子进程环境只保留白名单变量（不含应用密钥/其他项目数据）；`-no-shell-escape` 显式禁用；
- 超时 `PATENT_STUDIO_LATEX_TIMEOUT`（默认 240s）；引擎白名单 pdflatex/xelatex（与验证镜像一致）；
- 编译离线：不访问网络（依赖与字体全部本地）。
- 资源限制：开发态为宿主进程 + timeout（Windows 无 cgroups）；容器部署时由容器上限承担——
  本轮不改生产 Dockerfile（应用镜像尚未内置 texlive，见 w21 报告 §五）。
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time

from app import config
from app.domain import latex_history, task_runner
from app.domain.projects import (
    LATEX_INTERNAL_FILES,
    LATEX_SOURCE_EXCLUDE_DIRS,
    LATEX_TEXT_EXTS,
    ProjectError,
    _is_latex_dir,
)

BUILDS_DIR = os.path.join(".studio", "latex-builds")
MANIFEST = "manifest.json"
ARTIFACT_NAMES = ("out.pdf", "build.log", "manifest.json")

# 同项目并发防护：单 worker 进程内 per-pid 锁（与 build.py 的全局 _build_lock 同一假设）
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()

# 进行中的编译（per-pid 至多一个，_lock_for 保证）：取消端点据此定位进程句柄
class _RunState:
    __slots__ = ("proc", "canceled")

    def __init__(self):
        self.proc: subprocess.Popen | None = None
        self.canceled = False

    def attach(self, proc: subprocess.Popen) -> None:
        """run_task 的 on_proc 回调：登记进程句柄；登记前已被取消 ⇒ 立即终止。"""
        self.proc = proc
        if self.canceled:
            task_runner.terminate(proc)


_running: dict[str, _RunState] = {}
_running_guard = threading.Lock()


def _lock_for(pid: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(pid, threading.Lock())


def _require_latex_project(store, pid):
    project = store.get(pid)
    if not _is_latex_dir(project.dir):
        raise ProjectError("该案不是 LaTeX 工程（source_format != latex）", 400)
    return project


def source_root(project) -> str:
    """源文件根 = 工程目录本体（源文件与 .studio/ 内部配置、attachments/ 天然分离）。"""
    return project.dir


def _is_source_rel(rel: str) -> bool:
    if rel in LATEX_INTERNAL_FILES:
        return False
    first = rel.replace("\\", "/").split("/")[0]
    if first in LATEX_SOURCE_EXCLUDE_DIRS or first == "reviews":
        return False
    return True


def _safe_rel(rel: str) -> str:
    """路径安全：拒绝绝对路径、盘符、反斜杠、`..` 段、空段、首尾空白。"""
    if not rel or rel != rel.strip() or "\\" in rel or ":" in rel:
        raise ProjectError("非法文件路径", 400)
    parts = rel.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise ProjectError("非法文件路径（拒绝路径穿越）", 400)
    return "/".join(parts)


def resolve_source_path(project, rel: str) -> str:
    """工程内相对路径 → 绝对路径；realpath 兜底拒绝符号链接越界与不存在文件。"""
    rel = _safe_rel(rel)
    if not _is_source_rel(rel):
        # 内部区（.studio 配置与产物、attachments、docs 等）不通过文件端点暴露
        raise ProjectError("路径指向内部目录或配置，不在可编辑源文件范围内", 400)
    root = os.path.realpath(source_root(project))
    p = os.path.realpath(os.path.join(root, rel))
    if p != root and not p.startswith(root + os.sep):
        raise ProjectError("路径越界：文件不在工程目录内", 400)
    return p


def list_source_files(project) -> list[dict]:
    """工程文件清单（相对路径、升序）；.studio/attachments/docs 等内部目录与配置不在列。
    editable 按扩展名白名单（本轮仅文本文件可打开/保存）。"""
    root = source_root(project)
    out = []
    for base, dirs, files in os.walk(root):
        rel_base = os.path.relpath(base, root).replace(os.sep, "/")
        dirs[:] = [d for d in dirs if d not in LATEX_SOURCE_EXCLUDE_DIRS]
        for fn in files:
            rel = fn if rel_base == "." else f"{rel_base}/{fn}"
            if not _is_source_rel(rel):
                continue
            p = os.path.join(base, fn)
            if os.path.islink(p):
                continue
            ext = os.path.splitext(fn)[1].lower()
            out.append(
                {
                    "path": rel,
                    "size": os.path.getsize(p),
                    "editable": ext in LATEX_TEXT_EXTS,
                }
            )
    return sorted(out, key=lambda x: x["path"])


def read_source_file(project, rel: str) -> str:
    p = resolve_source_path(project, rel)
    if not os.path.isfile(p):
        raise ProjectError(f"文件不存在：{rel}", 404)
    ext = os.path.splitext(p)[1].lower()
    if ext not in LATEX_TEXT_EXTS:
        raise ProjectError(f"本轮仅支持文本文件编辑（{', '.join(LATEX_TEXT_EXTS)}）", 415)
    with open(p, encoding="utf-8") as f:
        return f.read()


def save_source_file(project, rel: str, content: str) -> None:
    p = resolve_source_path(project, rel)
    if not os.path.isfile(p):
        raise ProjectError("本轮不支持新建文件：目标必须已存在", 404)
    ext = os.path.splitext(p)[1].lower()
    if ext not in LATEX_TEXT_EXTS:
        raise ProjectError(f"本轮仅支持文本文件编辑（{', '.join(LATEX_TEXT_EXTS)}）", 415)
    tmp = p + ".w21tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(content)
    os.replace(tmp, p)


# --- SyncTeX 正反向跳转（v0.4.2）：源码行 ⇄ PDF 位置 ---

def _build_artifact_pair(build_dir: str, main: str) -> tuple[str, str]:
    """返回 (pdf_path, synctex_gz_path)。
    坑：源 ZIP 可能自带与主文件同名的旧 PDF（随快照进构建目录），而编译器把新产物写在
    构建根（texlive）或源旁（MiKTeX）——按 mtime 取「刚产出的那份」，不能按路径优先级。"""
    stem = os.path.splitext(main)[0]

    def newest(paths):
        best, best_t = None, -1.0
        for cand in paths:
            if os.path.isfile(cand):
                m = os.path.getmtime(cand)
                if m > best_t:
                    best, best_t = cand, m
        return best

    pdf_cands = (
        os.path.join(build_dir, f"{stem}.pdf"),
        os.path.join(build_dir, f"{os.path.basename(stem)}.pdf"),
    )
    gz_cands = [cand[:-4] + ".synctex.gz" for cand in pdf_cands]
    # 以 gz 为锚：synctex -o 指定的 PDF 必须与 .synctex.gz 同目录（编译器实际输出目录），
    # 否则 synctex 找不到关联数据、静默只打 banner（两处 PDF 并存时按路径挑会踩中）
    gz = newest(gz_cands)
    if gz:
        base = os.path.basename(gz)[: -len(".synctex.gz")]
        pdf = os.path.join(os.path.dirname(gz), base + ".pdf")
        if os.path.isfile(pdf):
            return pdf, gz
    return newest(pdf_cands), None


def _run_synctex(args: list[str]) -> str:
    try:
        r = subprocess.run(["synctex", *args], capture_output=True, text=True, timeout=10)
    except FileNotFoundError as e:
        raise ProjectError("编译环境缺少 synctex 工具，无法定位", 503) from e
    except subprocess.TimeoutExpired as e:
        raise ProjectError("synctex 查询超时，请重试", 503) from e
    # synctex 把结果打印到 stderr（1.5 实测），stdout 为空——两路合并后再找结果标记
    out = (r.stdout or "") + "\n" + (r.stderr or "")
    if "SyncTeX result begin" not in out:
        return ""
    return out


def synctex_view(project, build_id: str, file: str, line: int) -> dict:
    """正向：源码文件+行 → {page, x, y}（72dpi PDF 坐标，供预览滚动定位）。"""
    resolve_source_path(project, file)  # 路径安全与内部目录守卫
    build_dir = os.path.join(builds_dir(project), build_id)
    manifest = load_manifest(project, build_id)
    main = manifest.get("main") or "main.tex"
    pdf, gz = _build_artifact_pair(build_dir, main)
    if not pdf or not gz:
        raise ProjectError("该构建没有 SyncTeX 数据，请重新编译", 404)
    out = _run_synctex(["view", "-i", f"{int(line)}:0:{file}", "-o", pdf])
    page = x = y = None
    for ln in out.splitlines():
        if page is None and ln.startswith("Page:"):
            page = int(float(ln.split(":", 1)[1]))
        elif x is None and ln.startswith("x:"):
            x = float(ln.split(":", 1)[1])
        elif y is None and ln.startswith("y:"):
            y = float(ln.split(":", 1)[1])
        if page is not None and x is not None and y is not None:
            break
    if page is None:
        raise ProjectError("该行在 PDF 中没有对应位置（可能是注释或导言区）", 404)
    return {"page": page, "x": x or 0.0, "y": y or 0.0}


def synctex_edit(project, build_id: str, page: int, x: float, y: float) -> dict:
    """反向：PDF 页+72dpi 坐标 → {file, line}。"""
    build_dir = os.path.join(builds_dir(project), build_id)
    manifest = load_manifest(project, build_id)
    main = manifest.get("main") or "main.tex"
    pdf, gz = _build_artifact_pair(build_dir, main)
    if not pdf or not gz:
        raise ProjectError("该构建没有 SyncTeX 数据，请重新编译", 404)
    out = _run_synctex(["edit", "-o", f"{int(page)}:{x}:{y}:{pdf}"])
    input_path = line = None
    for ln in out.splitlines():
        if input_path is None and ln.startswith("Input:"):
            input_path = ln.split(":", 1)[1]
        elif line is None and ln.startswith("Line:"):
            line = int(float(ln.split(":", 1)[1]))
        if input_path and line is not None:
            break
    if not input_path or line is None:
        raise ProjectError("点击位置在 PDF 中没有对应源码", 404)
    rel = os.path.relpath(os.path.realpath(input_path), os.path.realpath(build_dir)).replace(os.sep, "/")
    while rel.startswith("./"):
        rel = rel[2:]
    resolve_source_path(project, rel)  # 回落工程内与源范围校验
    return {"file": rel, "line": line}


def source_file_sha(project, rel: str) -> str | None:
    """单文件 sha256（LaTeX 批注锚点的创建时版本）；文件不存在 ⇒ None。"""
    try:
        p = resolve_source_path(project, rel)
    except ProjectError:
        return None
    if not os.path.isfile(p):
        return None
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def digest_source(project) -> dict[str, str]:
    """全部源文件 sha256（构建输入指纹；状态端点据此给出 stale 判定）。"""
    out = {}
    for item in list_source_files(project):
        p = os.path.join(source_root(project), item["path"])
        with open(p, "rb") as f:
            out[item["path"]] = hashlib.sha256(f.read()).hexdigest()
    return out


# -file-line-error 行：`./main.tex:37: Undefined control sequence.`（Windows 可能 `main.tex:37: ...`）
_DIAG_RE = re.compile(r"^\.?[/\\]?([^:\s][^:\n]*?\.(?:tex|bib|cls|sty|bst)):(\d+): (.+)$")


def parse_diagnostics(log_text: str) -> list[dict]:
    """构建日志 → 结构化诊断（file/line/message，按出现序，去重上限 50 条）。"""
    out = []
    for line in log_text.splitlines():
        m = _DIAG_RE.match(line)
        if m:
            item = {"file": m.group(1).replace("\\", "/"), "line": int(m.group(2)), "message": m.group(3).strip()}
            if item not in out:
                out.append(item)
            if len(out) >= 50:
                break
    return out


def builds_dir(project) -> str:
    return os.path.join(project.studio_dir, "latex-builds")


def _write_manifest(build_dir, manifest):
    with open(os.path.join(build_dir, MANIFEST), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)


def load_manifest(project, build_id: str) -> dict:
    if not build_id.replace("-", "").isalnum():
        raise ProjectError("非法构建 ID", 400)
    p = os.path.join(builds_dir(project), build_id, MANIFEST)
    if not os.path.isfile(p):
        raise ProjectError("构建不存在（可能已被清理）", 404)
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def list_builds(project) -> list[dict]:
    root = builds_dir(project)
    out = []
    if os.path.isdir(root):
        for bid in sorted(os.listdir(root)):
            mp = os.path.join(root, bid, MANIFEST)
            if os.path.isfile(mp):
                try:
                    with open(mp, encoding="utf-8") as f:
                        out.append(json.load(f))
                except ValueError:
                    continue
    return list(reversed(out))  # 新的在前


def latest_build(project, ok_only=False) -> dict | None:
    for b in list_builds(project):
        if not ok_only or b.get("status") == "ok":
            return b
    return None


# 构建子进程环境白名单：不含应用密钥（AI key 等只在 os.environ，不会带进去）、不含其他项目数据
def _build_env(build_dir: str) -> dict[str, str]:
    env: dict[str, str] = {}
    for k in ("PATH", "SystemRoot", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LANG", "LC_ALL"):
        v = os.environ.get(k)
        if v:
            env[k] = v
    if config.LATEX_EXTRA_PATH:
        env["PATH"] = config.LATEX_EXTRA_PATH + os.pathsep + env.get("PATH", "")
    # TeX 缓存/字体配置指向构建目录，不写回源码区、不读用户级配置
    env["HOME"] = build_dir
    env["USERPROFILE"] = build_dir
    env["TEXMFVAR"] = os.path.join(build_dir, ".texmf-var")
    env["TEXMFHOME"] = os.path.join(build_dir, ".texmf-home")
    env["SOURCE_DATE_EPOCH"] = "0"
    # 主文件可能位于子目录（官方模板包常态，如 els-cas 的 els-cas-templates/cas-sc-sample.tex），
    # 其同目录的 cls/sty 不在 CWD 搜索路径上 → 递归搜索整个构建快照目录；
    # 尾随分隔符 = 追加默认路径，// = 递归子目录（kpathsea/MiKTeX 语义一致）
    env["TEXINPUTS"] = build_dir + "//" + os.pathsep
    return env


def run_build(store, pid: str, engine: str | None = None) -> dict:
    """手动触发 LaTeX 编译（同步，供路由 asyncio.to_thread 调用）。返回 manifest + 诊断 + 产物 URL。
    全局并发上限（默认单任务）满载 → 429 busy；子进程受 rlimit + 进程组超时清理约束（task_runner）；
    可被 POST /latex/builds/cancel 中止（status=canceled）。"""
    _require_latex_project(store, pid)
    lock = _lock_for(pid)
    if not lock.acquire(blocking=False):
        raise ProjectError("该案已有编译在进行", 409)
    slot = task_runner.latex_slot()
    if not slot.acquire():  # 有限排队（TASK_QUEUE_WAIT_S），满载超时才 429
        lock.release()
        raise ProjectError(str(task_runner.Busy("LaTeX 编译")), 429)
    state = _RunState()
    with _running_guard:
        _running[pid] = state
    try:
        project = store.get(pid)
        cfg = project.settings.get("latex") or {}
        eng = engine or cfg.get("engine") or "pdflatex"
        if eng not in config.LATEX_ENGINES:
            raise ProjectError(f"未知 LaTeX 引擎：{eng}（允许：{'、'.join(config.LATEX_ENGINES)}）", 422)
        main = str(cfg.get("main") or "")
        src_root = source_root(project)
        if not main or not os.path.isfile(os.path.join(src_root, main)):
            raise ProjectError(f"主文件不存在：{main}", 422)

        # 编译前快照（防丢稿）：编译过的状态必在版本历史里；git 缺失静默跳过。
        # force=True：编译不受保存 90s 合并窗口约束（连续重编译每次都是独立快照点）
        latex_history.commit(src_root, "build", force=True)

        digest = digest_source(project)
        # 同秒内多次构建须保序（字典序=创建序），否则 list_builds 顺序随机翻转——
        # 用纳秒余数替代随机 hex，秒级前缀不变
        build_id = time.strftime("%Y%m%d-%H%M%S") + "-" + f"{time.time_ns() % 1_000_000_000:09d}"
        build_dir = os.path.join(builds_dir(project), build_id)
        os.makedirs(build_dir, exist_ok=True)
        # 源文件快照：复制到构建目录（保留相对结构），编译器只见快照
        for rel in digest:
            dst = os.path.join(build_dir, rel)
            os.makedirs(os.path.dirname(dst) or build_dir, exist_ok=True)
            shutil.copy2(os.path.join(src_root, rel), dst)

        manifest = {
            "build_id": build_id,
            "pid": pid,
            "engine": eng,
            "main": main,
            "latexmk": config.LATEX_LATEXMK,
            "digest": digest,
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "status": "running",
        }
        _write_manifest(build_dir, manifest)

        stem = os.path.splitext(main)[0]
        cmd = [
            config.LATEX_LATEXMK,
            f"-{eng}",
            # -norc：不读 .latexmkrc/~/.latexmkrc（用户 ZIP 可携带 Perl 配置，绝不可执行）
            "-norc",
            "-synctex=1",
            "-interaction=nonstopmode",
            "-halt-on-error",
            "-file-line-error",
            "-no-shell-escape",
            main,
        ]
        t0 = time.perf_counter()
        log_path = os.path.join(build_dir, "build.log")
        status, err = "ok", None
        try:
            rc = task_runner.run_task(
                cmd,
                cwd=build_dir,
                timeout_s=config.LATEX_TIMEOUT_S,
                log_file=log_path,
                env=_build_env(build_dir),
                on_proc=state.attach,
            )
            if state.canceled:
                status, err = "canceled", "已手动取消编译"
            elif rc != 0:
                status, err = "error", f"latexmk 退出码 {rc}"
        except subprocess.TimeoutExpired:
            status = "error"
            err = f"编译超时（>{config.LATEX_TIMEOUT_S}s），已终止整组子进程"
        except FileNotFoundError:
            status = "error"
            err = (
                f"找不到 latexmk（{config.LATEX_LATEXMK}）："
                "开发态需要宿主安装 TeX 工具链（本机已验证 MiKTeX 26.5）；容器部署需镜像内置 texlive"
            )
        elapsed = round((time.perf_counter() - t0) * 1000)

        # tex 日志在 <stem>.log（latexmk 的 stdout 在 build.log）。主文件在子目录时，
        # TeX 家族把输出写在 CWD（构建根）的裸 basename 下（Linux texlive 实测）；
        # MiKTeX 默认写在源文件旁。两处都找，取存在者。
        tex_log = ""
        _stem_log = os.path.join(build_dir, f"{stem}.log")
        _base_log = os.path.join(build_dir, f"{os.path.basename(stem)}.log")
        tex_log_path = _stem_log if os.path.isfile(_stem_log) else _base_log
        if os.path.isfile(tex_log_path):
            with open(tex_log_path, encoding="utf-8", errors="replace") as f:
                tex_log = f.read()
        if status == "error" and err and "超时" in err:
            diagnostics = [{"file": main, "line": None, "message": err}]
        elif status == "canceled":
            diagnostics = [{"file": main, "line": None, "message": err or "已手动取消编译"}]
        elif status == "error":
            diagnostics = parse_diagnostics(tex_log) or parse_diagnostics(
                open(log_path, encoding="utf-8", errors="replace").read()
            )
            if not diagnostics:
                build_log = open(log_path, encoding="utf-8", errors="replace").read()
                if "script engine 'perl'" in build_log or "Can't locate" in build_log and "perl" in build_log.lower():
                    err = "编译环境缺少 Perl，latexmk 无法启动。请配置 Perl 路径后重新编译。"
                diagnostics = [{"file": main, "line": None, "message": err or "编译失败（见 build.log）"}]
        else:
            diagnostics = []
            canonical_pdf = os.path.join(build_dir, f"{stem}.pdf")
            produced = canonical_pdf
            if not os.path.isfile(produced):
                relocated = os.path.join(build_dir, f"{os.path.basename(stem)}.pdf")
                if os.path.isfile(relocated):
                    # 子目录主文件：产物在构建根的裸 basename 处 → 复制到规范 stem 路径（产物接口按 stem 读）
                    shutil.copy2(relocated, canonical_pdf)
                else:
                    produced = None
            if produced is None:
                status, err = "error", "latexmk 成功退出但未产出 PDF"
                diagnostics = [{"file": main, "line": None, "message": err}]

        manifest.update(
            {
                "status": status,
                "error": err,
                "duration_ms": elapsed,
                "finished_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "diagnostics": diagnostics[:20],
            }
        )
        _write_manifest(build_dir, manifest)
        task_runner.prune_dirs(builds_dir(project), config.ARTIFACT_KEEP)
        base = f"/api/projects/{pid}/latex/builds/{build_id}/artifacts"
        return {
            **manifest,
            "pdf_url": f"{base}/out.pdf" if status == "ok" else None,
            "log_url": f"{base}/build.log",
            "stale": False,
        }
    finally:
        with _running_guard:
            _running.pop(pid, None)
        slot.sem.release()
        lock.release()


def cancel_build(store, pid: str) -> dict:
    """中止进行中的编译：置取消标记并终止进程组（run_task 的 wait 随即返回，
    run_build 以 status=canceled 收尾落 manifest）。没有进行中的编译 ⇒ 409。"""
    _require_latex_project(store, pid)
    with _running_guard:
        state = _running.get(pid)
    if state is None or (state.proc is not None and state.proc.poll() is not None):
        raise ProjectError("没有进行中的编译", 409)
    state.canceled = True
    if state.proc is not None:
        task_runner.terminate(state.proc)
    return {"ok": True}
