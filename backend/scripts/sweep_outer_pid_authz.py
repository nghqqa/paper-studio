# -*- coding: utf-8 -*-
"""一次性审计（v0.1.2）：外层 ASGI 上全部含 {pid} 的 legacy 路由匿名探针。

性质判定：匿名请求命中任一 {pid} 路由应得到 401（project_access 在 handler 前拦截，
user=None 恒 401）。出现 2xx ⇒ 越权；出现 403/404 ⇒ 鉴权依赖缺失（handler 直接执行）；
422/400 允许（仅当鉴权依赖已先执行、死在 body 校验——矩阵测试已单独覆盖这些路由的行为语义）。
"""
import importlib
import os
import shutil
import sys
import tempfile

os.environ.update(
    {
        "PATENT_STUDIO_AUTH": "on",
        "PATENT_STUDIO_SECRET": "sweep-secret-test-0123456789abcdef",
    }
)
base = tempfile.mkdtemp(prefix="sweep-")
os.environ["PATENT_PROJECTS_DIR"] = os.path.join(base, "projects")
os.environ["PATENT_STUDIO_LEGACY_DATABASE_URL"] = "sqlite:///" + os.path.join(base, "studio.db")
os.makedirs(os.environ["PATENT_PROJECTS_DIR"])

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND)

for name in ("app.config", "app.auth.db", "app.auth.acl", "app.auth.router", "app.main"):
    mod = sys.modules.get(name)
    if mod is not None:
        importlib.reload(mod)

from fastapi.routing import APIRoute  # noqa: E402

from app.main import app as legacy_app  # noqa: E402
from patent_studio.asgi import create_app  # noqa: E402

# 1) legacy 内全部 {pid} 模板（这是 mount 路径 + 外层直挂路径的并集来源）
templates = {}
for r in legacy_app.routes:
    if isinstance(r, APIRoute) and "{pid}" in r.path:
        for m in r.methods - {"OPTIONS", "HEAD"}:
            templates.setdefault(r.path, set()).add(m)

outer = create_app()

# 2) 外层 app 直挂（非 mount）的路由面
outer_direct = set()
for r in outer.router.routes:
    p = getattr(r, "path", None)
    if p and "{pid}" in p:
        outer_direct.add((p, tuple(sorted(getattr(r, "methods", []) or []))))

from fastapi.testclient import TestClient  # noqa: E402

c = TestClient(outer, raise_server_exceptions=False)
pid = "sweep-probe"
bad = []
checked = 0
for path, methods in sorted(templates.items()):
    url = path.replace("{pid}", pid)
    for m in sorted(methods):
        r = c.request(m, url, json={} if m in ("POST", "PUT", "PATCH") else None)
        checked += 1
        if 200 <= r.status_code < 300 or r.status_code in (403, 404):
            bad.append((m, path, r.status_code, r.text[:100]))
        flag = "OK " if r.status_code == 401 else "422" if r.status_code == 422 else "BAD"
        if flag != "OK ":
            print(f"{flag} {m:6} {path} -> {r.status_code}")

print(f"== checked {checked} (method,path) probes over {len(templates)} templates")
print(f"== outer-app direct pid routes: {sorted(outer_direct)}")
print(f"== BAD: {len(bad)}")
for b in bad:
    print("  ", b)
shutil.rmtree(base, ignore_errors=True)
sys.exit(1 if bad else 0)
