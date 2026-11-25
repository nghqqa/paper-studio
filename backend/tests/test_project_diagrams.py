"""科研方法图（diagram）B1 回归：场景持久化 / 版本并发 / 发布 LaTeX / Word 快照链。

复用 test_project_figures 的 client 形态（tmp_path + 模块 reload 链）；不连接外部服务。
"""
import base64
import hashlib
import importlib
import io
import json
import os
import sys
import urllib.parse

import pytest
from fastapi.testclient import TestClient
from PIL import Image


@pytest.fixture(scope="module")
def matrix(tmp_path_factory):
    base = tmp_path_factory.mktemp("project-diagrams")
    projects = base / "projects"
    projects.mkdir()
    env = {
        "PATENT_STUDIO_AUTH": "on",
        "PATENT_STUDIO_SECRET": "project-diagram-tests-only-secret",
        "PATENT_PROJECTS_DIR": str(projects),
        "PATENT_STUDIO_LEGACY_DATABASE_URL": f"sqlite:///{base}/studio.db",
        "PATENT_STUDIO_WORD_EDITOR": "on",
        "PATENT_STUDIO_ONLYOFFICE_JWT_SECRET": "diagram-tests-only",
        "PATENT_STUDIO_ONLYOFFICE_URL": "http://localhost:9980",
        "PATENT_STUDIO_ONLYOFFICE_INTERNAL_URL": "http://onlyoffice:80",
        "PATENT_STUDIO_ONLYOFFICE_PUBLIC_URL": "http://studio:8000",
    }
    previous = {key: os.environ.get(key) for key in env}
    os.environ.update(env)
    try:
        for name in ("app.config", "app.auth.db", "app.auth.users", "app.auth.acl", "app.auth.router", "app.main"):
            if name in sys.modules:
                importlib.reload(sys.modules[name])
            else:
                importlib.import_module(name)
        from app.main import app

        def register(name):
            client = TestClient(app)
            email = f"{name}@diagrams.example.com"
            result = client.post("/api/auth/register", json={"email": email, "password": "Diagram-test-pw!"})
            assert result.status_code == 201, result.text
            login = client.post("/api/auth/cookie/login", data={"username": email, "password": "Diagram-test-pw!"})
            assert login.status_code == 204
            return client

        register("bootstrap")
        clients = {role: register(role) for role in ("owner", "editor", "reviewer", "viewer", "outsider")}
        yield {"app": app, "clients": clients, "projects": projects}
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def new_project(matrix, kind="word"):
    owner = matrix["clients"]["owner"]
    if kind == "latex":
        response = owner.post("/api/projects/latex-demo", json={"template": "blank"})
    else:
        response = owner.post("/api/projects/word/create", json={"title": "Diagram acceptance", "template": "blank"})
    assert response.status_code == 200, response.text
    return response.json()["id"]


def tiny_png(width=8, height=6) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color=(10, 20, 30)).save(buf, format="PNG")
    return buf.getvalue()


def png_url(png: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def scene(elements=None) -> str:
    return json.dumps({"type": "excalidraw", "version": 2, "source": "paper-studio",
                       "elements": elements if elements is not None else [{"id": "e1", "type": "rectangle"}],
                       "files": {}})


def diagram(**changes):
    body = {"kind": "diagram", "name": "Method overview",
            "scene": scene(), "png_data_url": png_url(tiny_png())}
    body.update(changes)
    return body


def fig_dir(matrix, pid):
    return matrix["projects"] / pid / "figures"


def create_diagram(matrix, pid, **changes):
    r = matrix["clients"]["owner"].post(f"/api/project-figures/{pid}", json=diagram(**changes))
    assert r.status_code == 200, r.text
    return r.json()["figure"]


def chart_payload():
    return {"name": "Experiment", "type": "line", "title": "", "x_label": "", "y_label": "",
            "categories": ["A"], "series": [{"name": "S", "values": [1.0]}]}


def test_diagram_create_keeps_chart_rows_untouched(matrix):
    client, pid = matrix["clients"]["owner"], new_project(matrix)
    fig = create_diagram(matrix, pid)
    assert fig["kind"] == "diagram" and fig["version"] == 1
    assert fig["bytes"] == len(tiny_png()) and fig["width_px"] == 8 and fig["height_px"] == 6
    assert (fig_dir(matrix, pid) / f"{fig['id']}.png").is_file()
    assert (fig_dir(matrix, pid) / f"{fig['id']}.excalidraw").read_text(encoding="utf-8") == scene()
    # 数据图行保持 v0.3 原样（无 kind/version 等新键），两种 kind 同库共存。
    chart = client.post(f"/api/project-figures/{pid}", json=chart_payload()).json()["figure"]
    assert "kind" not in chart and "version" not in chart
    rows = {r["id"]: r for r in client.get(f"/api/project-figures/{pid}").json()["figures"]}
    assert rows[fig["id"]]["kind"] == "diagram" and "kind" not in rows[chart["id"]]


def test_scene_endpoint_returns_truth_source(matrix):
    client, pid = matrix["clients"]["owner"], new_project(matrix)
    fig = create_diagram(matrix, pid, name="架构总览")
    chart = client.post(f"/api/project-figures/{pid}", json=chart_payload()).json()["figure"]
    r = client.get(f"/api/project-figures/{pid}/{fig['id']}/scene")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    body = r.json()
    assert body["scene"] == scene() and body["version"] == 1 and body["name"] == "架构总览"
    assert client.get(f"/api/project-figures/{pid}/{chart['id']}/scene").status_code == 404
    assert client.get(f"/api/project-figures/{pid}/fig-1-abcdef/scene").status_code == 404


def test_update_diagram_version_flow_and_conflict(matrix):
    client, pid = matrix["clients"]["owner"], new_project(matrix)
    fig = create_diagram(matrix, pid)
    url = f"/api/project-figures/{pid}/{fig['id']}"
    png2 = tiny_png(9, 7)
    r = client.put(url, json={"name": "Method v2", "scene": scene([{"id": "e2", "type": "ellipse"}]),
                              "png_data_url": png_url(png2), "expected_version": 1})
    assert r.status_code == 200, r.text
    row = r.json()["figure"]
    assert row["version"] == 2 and row["name"] == "Method v2"
    assert row["bytes"] == len(png2) and row["width_px"] == 9 and row["height_px"] == 7
    assert json.loads((fig_dir(matrix, pid) / f"{fig['id']}.excalidraw").read_text(encoding="utf-8"))["elements"][0]["id"] == "e2"
    conflict = client.put(url, json={"scene": scene(), "png_data_url": png_url(tiny_png()),
                                     "expected_version": 1})
    assert conflict.status_code == 409 and conflict.json()["detail"]["kind"] == "version_conflict"
    assert conflict.json()["detail"]["current_version"] == 2
    assert client.get(f"{url}/scene").json()["version"] == 2
    r3 = client.put(url, json={"scene": scene(), "png_data_url": png_url(tiny_png(5, 5)),
                               "expected_version": 2})
    assert r3.status_code == 200 and r3.json()["figure"]["version"] == 3


def test_update_rejects_chart_and_missing_figure(matrix):
    client, pid = matrix["clients"]["owner"], new_project(matrix)
    create_diagram(matrix, pid)
    chart = client.post(f"/api/project-figures/{pid}", json=chart_payload()).json()["figure"]
    url = f"/api/project-figures/{pid}/{chart['id']}"
    body = {"scene": scene(), "png_data_url": png_url(tiny_png()), "expected_version": 1}
    assert client.put(url, json=body).status_code == 422
    assert client.put(f"/api/project-figures/{pid}/fig-1-abcdef", json=body).status_code == 404


def test_update_rollback_restores_previous_bytes_on_index_failure(matrix, monkeypatch):
    from app.routes import project_figures

    client, pid = matrix["clients"]["owner"], new_project(matrix)
    fig = create_diagram(matrix, pid)
    scene_path = fig_dir(matrix, pid) / f"{fig['id']}.excalidraw"
    png_path = fig_dir(matrix, pid) / f"{fig['id']}.png"
    index_before = (fig_dir(matrix, pid) / "index.json").read_bytes()
    scene_before = scene_path.read_bytes()
    png_before = png_path.read_bytes()

    def fail(*args):
        raise OSError("simulated index failure")
    monkeypatch.setattr(project_figures, "_save_meta", fail)
    with pytest.raises(OSError, match="simulated index"):
        client.put(f"/api/project-figures/{pid}/{fig['id']}",
                   json={"scene": scene([{"id": "e9"}]), "png_data_url": png_url(tiny_png(4, 4)),
                         "expected_version": 1})
    assert scene_path.read_bytes() == scene_before
    assert png_path.read_bytes() == png_before
    assert (fig_dir(matrix, pid) / "index.json").read_bytes() == index_before


@pytest.mark.parametrize("changes,expected", [
    ({"scene": "not json"}, 422),
    ({"scene": json.dumps({"type": "application", "elements": []})}, 422),
    ({"scene": json.dumps({"type": "excalidraw", "elements": "nope"})}, 422),
    ({"scene": json.dumps({"type": "excalidraw", "elements": [{"id": i} for i in range(5001)]})}, 422),
    ({"png_data_url": "data:image/jpeg;base64,AAAA"}, 422),
    ({"png_data_url": "not-a-data-url"}, 422),
])
def test_invalid_diagram_create_is_rejected_before_any_write(matrix, changes, expected):
    pid = new_project(matrix)
    r = matrix["clients"]["owner"].post(f"/api/project-figures/{pid}", json=diagram(**changes))
    assert r.status_code == expected, r.text
    assert not fig_dir(matrix, pid).exists() or not list(fig_dir(matrix, pid).glob("fig-*"))


def test_oversized_scene_or_png_is_413(matrix, monkeypatch):
    from app.routes import project_figures

    pid = new_project(matrix)
    monkeypatch.setattr(project_figures, "MAX_SCENE_BYTES", 8)
    r = matrix["clients"]["owner"].post(f"/api/project-figures/{pid}", json=diagram())
    assert r.status_code == 413, r.text
    monkeypatch.setattr(project_figures, "MAX_SCENE_BYTES", 10 * 1024 * 1024)
    monkeypatch.setattr(project_figures, "MAX_WORD_IMAGE_BYTES", 4)
    r = matrix["clients"]["owner"].post(f"/api/project-figures/{pid}", json=diagram())
    assert r.status_code == 413, r.text
    assert not fig_dir(matrix, pid).exists() or not list(fig_dir(matrix, pid).glob("fig-*"))


def test_png_etag_changes_after_update_and_supports_304(matrix):
    client, pid = matrix["clients"]["owner"], new_project(matrix)
    fig = create_diagram(matrix, pid)
    url = f"/api/project-figures/{pid}/{fig['id']}/png"
    first = client.get(url)
    assert first.headers["cache-control"] == "no-cache"
    etag = first.headers["etag"]
    assert etag == '"' + hashlib.sha256(first.content).hexdigest()[:16] + '"'
    assert client.get(url, headers={"if-none-match": etag}).status_code == 304
    client.put(f"/api/project-figures/{pid}/{fig['id']}",
               json={"scene": scene(), "png_data_url": png_url(tiny_png(12, 9)), "expected_version": 1})
    second = client.get(url)
    assert second.headers["etag"] != etag and len(second.content) != len(first.content)


def test_delete_removes_scene_and_png(matrix):
    client, pid = matrix["clients"]["owner"], new_project(matrix)
    fig = create_diagram(matrix, pid)
    assert client.delete(f"/api/project-figures/{pid}/{fig['id']}").status_code == 200
    assert not list(fig_dir(matrix, pid).glob(f"{fig['id']}.*"))


def test_word_image_snapshot_tracks_diagram_updates(matrix):
    client, pid = matrix["clients"]["owner"], new_project(matrix)
    fig = create_diagram(matrix, pid)
    key = client.get(f"/api/projects/{pid}/word/state").json()["doc_key"]

    def word_image():
        r = client.get(f"/api/project-figures/{pid}/{fig['id']}/word-image?doc_key={urllib.parse.quote(key)}")
        assert r.status_code == 200, r.text
        return r.json()

    png1 = (fig_dir(matrix, pid) / f"{fig['id']}.png").read_bytes()
    snap1 = word_image()
    assert snap1["sha256"] == hashlib.sha256(png1).hexdigest()
    # PUT 原地更新 → word-image sha 随 PNG 变化：插件 sha16 比对失配 → 原位替换链路生效。
    png2 = tiny_png(15, 11)
    assert client.put(f"/api/project-figures/{pid}/{fig['id']}",
                      json={"scene": scene(), "png_data_url": png_url(png2),
                            "expected_version": 1}).status_code == 200
    snap2 = word_image()
    assert snap2["sha256"] != snap1["sha256"]
    assert snap2["sha256"] == hashlib.sha256(png2).hexdigest()
    assert base64.b64decode(snap2["data_url"].split(",", 1)[1], validate=True) == png2


def test_publish_latex_flow_and_overwrite(matrix):
    client, pid = matrix["clients"]["owner"], new_project(matrix, kind="latex")
    fig = create_diagram(matrix, pid, name="Method overview")
    url = f"/api/project-figures/{pid}/{fig['id']}/publish-latex"
    r = client.post(url, json={})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["path"] == "figures/Method-overview.png"
    assert body["stem"] == "Method-overview"
    target = matrix["projects"] / pid / "figures" / "Method-overview.png"
    assert target.read_bytes() == tiny_png()
    assert "\\includegraphics[width=0.8\\linewidth]{figures/Method-overview}" in body["snippet"]
    assert "\\caption{Method overview}" in body["snippet"] and "\\label{fig:Method-overview}" in body["snippet"]
    assert client.post(url, json={}).status_code == 409
    # 更新图表后 overwrite 重发布：LaTeX 侧文件字节跟随新 PNG。
    png2 = tiny_png(21, 13)
    assert client.put(f"/api/project-figures/{pid}/{fig['id']}",
                      json={"scene": scene(), "png_data_url": png_url(png2),
                            "expected_version": 1}).status_code == 200
    assert client.post(url, json={"overwrite": True}).status_code == 200
    assert target.read_bytes() == png2
    # 自定义 stem；白名单外字符被清洗。
    r = client.post(url, json={"stem": "../evil name!", "overwrite": True})
    assert r.status_code == 200 and r.json()["stem"] == "evil-name"


def test_publish_latex_chinese_name_falls_back_to_fid(matrix):
    pid = new_project(matrix, kind="latex")
    fig = create_diagram(matrix, pid, name="方法总览图")
    r = matrix["clients"]["owner"].post(f"/api/project-figures/{pid}/{fig['id']}/publish-latex", json={})
    assert r.status_code == 200, r.text
    assert r.json()["stem"] == fig["id"]
    assert (matrix["projects"] / pid / "figures" / f"{fig['id']}.png").is_file()
    assert f"\\caption{{方法总览图}}" in r.json()["snippet"]


def test_publish_latex_caption_escapes_tex_specials(matrix):
    pid = new_project(matrix, kind="latex")
    fig = create_diagram(matrix, pid, name="A_100% 加速 #1")
    r = matrix["clients"]["owner"].post(f"/api/project-figures/{pid}/{fig['id']}/publish-latex",
                                        json={"stem": "spec", "overwrite": True})
    assert r.status_code == 200, r.text
    caption = r.json()["snippet"].split("\\caption{", 1)[1].split("}", 1)[0]
    assert caption == r"A\_100\% 加速 \#1"


def test_publish_latex_guards(matrix):
    client = matrix["clients"]["owner"]
    word_pid = new_project(matrix)
    fig = create_diagram(matrix, word_pid)
    # 非 LaTeX 工程：格式守卫（400）先于图表查找。
    assert client.post(f"/api/project-figures/{word_pid}/{fig['id']}/publish-latex", json={}).status_code == 400
    latex_pid = new_project(matrix, kind="latex")
    assert client.post(f"/api/project-figures/{latex_pid}/fig-1-abcdef/publish-latex", json={}).status_code == 404


def test_diagram_access_control(matrix):
    clients, pid = matrix["clients"], new_project(matrix)
    owner, url = clients["owner"], f"/api/project-figures/{pid}"
    for role in ("editor", "reviewer", "viewer"):
        assert owner.put(f"/api/projects/{pid}/members",
                         json={"email": f"{role}@diagrams.example.com", "role": role}).status_code == 200
    fig = create_diagram(matrix, pid)
    fid = fig["id"]
    assert clients["viewer"].get(f"{url}/{fid}/scene").status_code == 200
    assert clients["reviewer"].get(f"{url}/{fid}/scene").status_code == 200
    put_body = {"scene": scene(), "png_data_url": png_url(tiny_png()), "expected_version": 1}
    for role in ("viewer", "reviewer"):
        assert clients[role].put(f"{url}/{fid}", json=put_body).status_code == 403
        assert clients[role].post(f"{url}/{fid}/publish-latex", json={}).status_code == 403
    assert TestClient(matrix["app"]).get(f"{url}/{fid}/scene").status_code == 401
    assert clients["outsider"].get(f"{url}/{fid}/scene").status_code in (403, 404)
