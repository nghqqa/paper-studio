#!/usr/bin/env python3
"""Paper Studio — Open-source clean export & hygiene audit gate.

Usage:
  1) Audit current repository (or exported directory) for secrets / private artifacts:
       python scripts/export_oss.py --audit-only
       python scripts/export_oss.py --audit-only --root ../paper-studio-oss

  2) Export a clean open-source tree to a target directory (optionally init fresh git repo):
       python scripts/export_oss.py --out ../paper-studio-oss --init-git
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

# Directories completely excluded from the public open-source distribution
EXCLUDE_DIRS: tuple[str, ...] = (
    ".git",
    ".oss-release",
    ".agents",
    ".impeccable",
    ".import-staging",
    ".lo_profile",
    ".venv-cache",
    ".pytest_cache",
    ".ruff_cache",
    "node_modules",
    ".venv",
    "__pycache__",
    ".zcode",
    "latex-lab",
    "deploy/vps",
    "deploy/paper",
    "deploy/e2e/reports",
    "deploy/e2e/tests",
    "docs/text-corpus",
    "docs/figure-library",
    "docs/design",
    "docs/design-system",
    "examples/latex-demo-2",
    "examples/latex-demo-3",
    "examples/latex-demo-4",
    "examples/latex-accept",
    "examples/latex-trial",
    "examples/latex-mentoring",
    "examples/struct-paper",
    "examples/struct-paper-2",
    "examples/struct-paper-3",
    "frontend/dist",
    "docker/struct-pdf-svc",
)

# Specific files (relative POSIX paths) excluded from the public distribution
EXCLUDE_FILES: set[str] = {
    "CLAUDE.md",
    "TRANSFORM.md",
    "design-qa.md",
    "fix_dashboard.py",
    "e2e-state.json",
    "e2e-import-state.json",
    "studio.db",
    "backend/repro_create.py",
    "backend/mx.log",
    "backend/mx2.log",
    "backend/mx3.log",
    "frontend/_probe_ssr.py.txt",
    "backend/app/word_templates/jcip/provided-original.doc",
    # Private operational / machine-bound E2E & release scripts
    "deploy/e2e/audit_prod_history.py",
    "deploy/e2e/audit_ro_inner.py",
    "deploy/e2e/bib-acceptance.py",
    "deploy/e2e/cdn-editor-diag.py",
    "deploy/e2e/cleanup_accounts_inner.py",
    "deploy/e2e/cleanup_prod_inner.py",
    "deploy/e2e/cleanup_prod_v071.py",
    "deploy/e2e/cleanup_prod_v081_accounts.py",
    "deploy/e2e/deploy-v066.py",
    "deploy/e2e/deploy-v067.py",
    "deploy/e2e/deploy-v068.py",
    "deploy/e2e/deploy-v069.py",
    "deploy/e2e/deploy-v0610.py",
    "deploy/e2e/deploy-v0611.py",
    "deploy/e2e/deploy-v0614.py",
    "deploy/e2e/full-test.workflow.ts",
    "deploy/e2e/known-failures.json",
    "deploy/e2e/last-vitest.log",
    "deploy/e2e/lp-leak-cleanup.py",
    "deploy/e2e/lp-reshoot4.py",
    "deploy/e2e/perf_baseline.py",
    "deploy/e2e/preflight-acceptance.py",
    "deploy/e2e/purge_leftover_e2e.py",
    "deploy/e2e/release-v081.py",
    "deploy/e2e/run_e2e.py",
    "deploy/e2e/viewport-acceptance.py",
    "deploy/e2e/wf-backend-tests.cmd",
    "deploy/e2e/wf-e2e.cmd",
    "deploy/e2e/wf-frontend-build.cmd",
    "deploy/e2e/wf-frontend-test.cmd",
    "deploy/e2e/wf-perf.cmd",
    # Internal historical handoff / patent-era docs
    "docs/E2E.md",
    "docs/cnipa-xml-research.md",
    "docs/competitive-landscape.md",
    "docs/competitive-landscape-v2.md",
    "docs/next-round-20261024.md",
    "docs/perf-baseline-20261024.md",
    "docs/project-intro.md",
    "docs/team-handoff.md",
    "docs/user-manual.md",
    "docs/v04-acceptance.md",
    "docs/v041-closeout.md",
    "docs/word-figures-handoff-20261023.md",
}

EXCLUDE_SUFFIXES: tuple[str, ...] = (
    ".pyc",
    ".pyo",
    ".log",
    ".db",
    ".db-shm",
    ".db-wal",
    ".tar.gz",
    ".bak",
)

# Forbidden filenames/patterns that must NEVER exist in the public tree
FORBIDDEN_FILE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(^|/)\.env(\.[^/]+)?$"),  # .env (allow .env.example via explicit check)
    re.compile(r"(^|/)\.ssh-local\.json$"),
    re.compile(r"incident-.*\.md$"),
    re.compile(r"provided-original\.doc$"),
    re.compile(r"\.(ttf|otf|ttc)$", re.IGNORECASE),
)

# Allowed open-source vendored font prefixes (MIT-licensed KaTeX math fonts)
ALLOWED_FONT_PREFIXES: tuple[str, ...] = (
    "backend/app/office_plugin/vendor/katex/fonts/",
)

# Sensitive content patterns (checked across all text files in public tree)
SENSITIVE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("private-vps-ip", re.compile(r"159\.75\.42\.106")),
    ("private-lab-ip", re.compile(r"10\.13\.2\.23")),
    ("private-domain", re.compile(r"(?:ds|ds-cdn)\.nghqqa\.cn")),
    ("personal-qq-email", re.compile(r"2801511808@qq\.com", re.IGNORECASE)),
    ("personal-gmail", re.compile(r"q2801511808@gmail\.com", re.IGNORECASE)),
    ("personal-wechat", re.compile(r"x2801511808", re.IGNORECASE)),
    ("real-user-email", re.compile(r"(?:202541600233@jxnu\.edu\.cn|lihui_drizzle@163\.com)", re.IGNORECASE)),
    ("legacy-domain", re.compile(r"patent\.zalize\.com", re.IGNORECASE)),
    ("private-server-home", re.compile(r"/home/dell/")),
    ("local-win-user-path", re.compile(r"[Cc]:[/\\]Users[/\\](?:ngh|12851)[/\\]")),
    ("local-win-repo-path", re.compile(r"[Ee]:[/\\]paper-studio(?:-team)?")),
    ("openai-like-key", re.compile(r"\bsk-[A-Za-z0-9]{24,}\b")),
    ("github-pat", re.compile(r"\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b")),
)

# Sanitize hardcoded private defaults in retained E2E scripts during export
EXPORT_TEXT_PATCHES: dict[str, list[tuple[str, str]]] = {
    "deploy/e2e/browser_smoke.py": [
        ("http://10.13.2.23:8011", "http://127.0.0.1:8011"),
    ],
    "deploy/e2e/run_e2e.py": [
        ("http://10.13.2.23:8011", "http://127.0.0.1:8011"),
        ("http://10.13.2.23:9981", "http://127.0.0.1:9981"),
        ("10.13.2.23", "127.0.0.1"),
        ("/home/dell/paper-studio/deploy", "/opt/paper-studio"),
    ],
    "deploy/e2e/e2e_suite.py": [
        ("http://10.13.2.23:8011", "http://127.0.0.1:8011"),
        ("https://paper.nghqqa.cn", "http://127.0.0.1:8000"),
    ],
}

TEXT_EXTENSIONS: set[str] = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".cjs", ".mjs", ".json", ".yml", ".yaml",
    ".md", ".txt", ".sh", ".html", ".css", ".toml", ".ini", ".cfg", ".conf",
    ".xml", ".csl", ".lua", ".tex", ".bib", ".example", ".gitignore", ".dockerignore",
}

REQUIRED_OSS_FILES: tuple[str, ...] = (
    "LICENSE",
    "NOTICE",
    "README.md",
    "README.zh-CN.md",
    "Dockerfile",
    "docker-compose.yml",
    ".env.example",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "backend/app/word_templates/jcip/template.docx",
    "backend/app/csl/README.md",
)

# Files allowed to mention sensitive patterns as detector definitions (this script itself)
AUDIT_SELF_EXEMPT: set[str] = {
    "scripts/export_oss.py",
}


def _rel_posix(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def _is_excluded(rel: str, is_dir: bool) -> bool:
    parts = rel.split("/")
    for ex in EXCLUDE_DIRS:
        if "/" in ex:
            if rel == ex or rel.startswith(ex + "/"):
                return True
        else:
            if ex in parts:
                return True
    if not is_dir:
        if rel in EXCLUDE_FILES:
            return True
        if rel.endswith(EXCLUDE_SUFFIXES):
            return True
        name = parts[-1]
        if name.startswith(".env") and name != ".env.example":
            return True
        if name == ".ssh-local.json":
            return True
    return False


def _is_text_file(path: Path) -> bool:
    if path.name in ("Dockerfile", "Makefile", "LICENSE", "NOTICE", "Caddyfile.example"):
        return True
    return path.suffix.lower() in TEXT_EXTENSIONS


def audit_tree(root: Path, *, respect_excludes: bool = False) -> list[str]:
    """Run all open-source release gates on `root`. Returns list of findings."""
    findings: list[str] = []

    for req in REQUIRED_OSS_FILES:
        if not (root / req).is_file():
            findings.append(f"[MISSING_REQUIRED] {req}")

    for dirpath, dirnames, filenames in os.walk(root):
        d_path = Path(dirpath)
        # Always skip .git internals during walk
        dirnames[:] = [d for d in dirnames if d != ".git"]
        if respect_excludes:
            kept: list[str] = []
            for d in dirnames:
                rel_d = _rel_posix(d_path / d, root)
                if not _is_excluded(rel_d, True):
                    kept.append(d)
            dirnames[:] = kept

        for fname in filenames:
            fpath = d_path / fname
            rel = _rel_posix(fpath, root)
            if respect_excludes and _is_excluded(rel, False):
                continue

            # Gate 1: Forbidden file patterns
            if not rel.endswith(".env.example"):
                for pat in FORBIDDEN_FILE_PATTERNS:
                    if pat.search(rel):
                        if pat.pattern.startswith(r"\.(ttf") and rel.startswith(ALLOWED_FONT_PREFIXES):
                            continue
                        findings.append(f"[FORBIDDEN_FILE] {rel} (matched {pat.pattern})")

            # Gate 2: Sensitive content scan
            if rel in AUDIT_SELF_EXEMPT or not _is_text_file(fpath):
                continue
            try:
                content = fpath.read_text(encoding="utf-8", errors="ignore")
            except OSError as exc:
                findings.append(f"[READ_ERROR] {rel}: {exc}")
                continue
            for label, pat in SENSITIVE_PATTERNS:
                for m in pat.finditer(content):
                    line_no = content.count("\n", 0, m.start()) + 1
                    findings.append(f"[SENSITIVE:{label}] {rel}:{line_no} -> {m.group(0)!r}")

    return findings


def _handle_remove_readonly(func, path, _exc) -> None:
    os.chmod(path, stat.S_IWRITE)
    func(path)


def export_clean_tree(src: Path, dst: Path, *, init_git: bool = False, force: bool = False) -> int:
    if dst.exists():
        if not force:
            raise SystemExit(f"Target directory already exists: {dst} (pass --force to replace)")
        shutil.rmtree(dst, onexc=_handle_remove_readonly)
    dst.mkdir(parents=True, exist_ok=True)

    copied = 0
    for dirpath, dirnames, filenames in os.walk(src):
        d_path = Path(dirpath)
        kept: list[str] = []
        for d in sorted(dirnames):
            rel_d = _rel_posix(d_path / d, src)
            if not _is_excluded(rel_d, True):
                kept.append(d)
        dirnames[:] = kept

        for fname in sorted(filenames):
            fpath = d_path / fname
            rel = _rel_posix(fpath, src)
            if _is_excluded(rel, False):
                continue
            out_path = dst / rel
            out_path.parent.mkdir(parents=True, exist_ok=True)
            if rel in EXPORT_TEXT_PATCHES:
                text = fpath.read_text(encoding="utf-8")
                for old, new in EXPORT_TEXT_PATCHES[rel]:
                    text = text.replace(old, new)
                out_path.write_text(text, encoding="utf-8", newline="\n")
            else:
                shutil.copy2(fpath, out_path)
            copied += 1

    if init_git:
        subprocess.run(["git", "init", "-b", "main"], cwd=dst, check=True)
        subprocess.run(["git", "config", "core.autocrlf", "false"], cwd=dst, check=True)
        subprocess.run(["git", "add", "-A"], cwd=dst, check=True)
        subprocess.run(
            ["git", "commit", "-m", "chore: initial open-source release of Paper Studio"],
            cwd=dst,
            check=True,
        )
    return copied


def main() -> int:
    parser = argparse.ArgumentParser(description="Export and audit Paper Studio open-source tree.")
    parser.add_argument("--audit-only", action="store_true", help="Audit without exporting.")
    parser.add_argument("--root", type=Path, default=REPO_ROOT, help="Root directory to audit.")
    parser.add_argument("--out", type=Path, help="Destination directory for clean open-source export.")
    parser.add_argument("--init-git", action="store_true", help="Initialize a fresh single-commit git repo in --out.")
    parser.add_argument("--git-author-name", default="Paper Studio Maintainers", help="Git author name for --init-git.")
    parser.add_argument("--git-author-email", default="paper-studio@users.noreply.github.com", help="Git author email for --init-git.")
    parser.add_argument("--force", action="store_true", help="Overwrite --out if it already exists.")
    args = parser.parse_args()

    if args.audit_only:
        respect_excludes = args.root.resolve() == REPO_ROOT.resolve()
        findings = audit_tree(args.root.resolve(), respect_excludes=respect_excludes)
        if findings:
            print(f"AUDIT FAILED ({len(findings)} finding(s)):", file=sys.stderr)
            for item in findings[:80]:
                print(f"  - {item}", file=sys.stderr)
            if len(findings) > 80:
                print(f"  ... and {len(findings) - 80} more", file=sys.stderr)
            return 1
        print(f"AUDIT PASSED: 0 findings in {args.root.resolve()}")
        return 0

    if not args.out:
        parser.error("Provide --out <dir> or --audit-only")

    dst = args.out.resolve()
    copied = export_clean_tree(REPO_ROOT, dst, init_git=False, force=args.force)
    print(f"Exported {copied} files to {dst}")

    findings = audit_tree(dst, respect_excludes=False)
    if findings:
        print(f"EXPORT AUDIT FAILED ({len(findings)} finding(s)):", file=sys.stderr)
        for item in findings[:80]:
            print(f"  - {item}", file=sys.stderr)
        if len(findings) > 80:
            print(f"  ... and {len(findings) - 80} more", file=sys.stderr)
        return 1

    print("EXPORT AUDIT PASSED: 0 findings.")
    if args.init_git:
        subprocess.run(["git", "init", "-b", "main"], cwd=dst, check=True)
        subprocess.run(["git", "config", "core.autocrlf", "false"], cwd=dst, check=True)
        subprocess.run(["git", "config", "user.name", args.git_author_name], cwd=dst, check=True)
        subprocess.run(["git", "config", "user.email", args.git_author_email], cwd=dst, check=True)
        subprocess.run(["git", "add", "-A"], cwd=dst, check=True)
        subprocess.run(
            ["git", "commit", "-q", "-m", "chore: initial open-source release of Paper Studio"],
            cwd=dst,
            check=True,
        )
        print(f"Initialized clean git repository at {dst}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
