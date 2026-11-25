"""科研图表 HTTP 回归：真实渲染、磁盘存储与项目 ACL；不连接外部服务。"""

import base64
import hashlib
import importlib
import io
import json
import os
import sys
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient
from PIL import Image


@pytest.fixture(scope="module")
def matrix(tmp_path_factory):
    base = tmp_path_factory.mktemp("project-figures")
    projects = base / "projects"
    projects.mkdir()
    env = {
        "PATENT_STUDIO_AUTH": "on",
        "PATENT_STUDIO_SECRET": "project-figures-tests-only-secret",
        "PATENT_PROJECTS_DIR": str(projects),
        "PATENT_STUDIO_LEGACY_DATABASE_URL": f"sqlite:///{base}/studio.db",
        "PATENT_STUDIO_WORD_EDITOR": "on",
        "PATENT_STUDIO_ONLYOFFICE_JWT_SECRET": "figure-tests-only",
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
            email = f"{name}@figures.example.com"
            result = client.post("/api/auth/register", json={"email": email, "password": "Figure-test-pw!"})
            assert result.status_code == 201, result.text
            login = client.post("/api/auth/cookie/login", data={"username": email, "password": "Figure-test-pw!"})
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


def new_project(matrix):
    owner = matrix["clients"]["owner"]
    response = owner.post("/api/projects/word/create", json={"title": "Chart acceptance", "template": "blank"})
    assert response.status_code == 200, response.text
    return response.json()["id"]


def chart(**changes):
    return {
        "name": "Experiment", "type": "line", "title": "Results", "x_label": "Condition", "y_label": "Score",
        "categories": [" A ", "B"], "series": [{"name": "Method", "values": [1, 2.5]}], **changes,
    }


@pytest.mark.parametrize("kind", ["line", "bar", "scatter", "pie"])
def test_create_list_download_delete_real_png(matrix, kind):
    client, pid = matrix["clients"]["owner"], new_project(matrix)
    url = f"/api/project-figures/{pid}"
    response = client.post(url, json=chart(type=kind))
    assert response.status_code == 200, response.text
    figure = response.json()["figure"]
    assert figure["series"] == [{"name": "Method", "values": [1.0, 2.5]}]
    assert figure["categories"] == ["A", "B"]
    assert client.get(url).json() == {"figures": [figure]}
    folder = matrix["projects"] / pid / "figures"
    assert json.loads((folder / "index.json").read_text(encoding="utf-8")) == [figure]
    image = client.get(f"{url}/{figure['id']}/png")
    assert image.status_code == 200 and image.headers["content-type"] == "image/png"
    assert len(image.content) == figure["bytes"]
    assert image.content == (folder / f"{figure['id']}.png").read_bytes()
    with Image.open(io.BytesIO(image.content)) as decoded:
        assert decoded.format == "PNG" and decoded.width > 0 and decoded.height > 0
        decoded.verify()
    assert client.delete(f"{url}/{figure['id']}").status_code == 200
    assert client.get(url).json() == {"figures": []}
    assert client.get(f"{url}/{figure['id']}/png").status_code == 404
    assert not list(folder.glob("*.png"))


@pytest.mark.parametrize("changes", [
    {"series": [{}]},
    {"series": [{"name": "Method", "values": [1]}]},
    {"categories": [], "series": [{"name": "Method", "values": []}]},
    {"categories": ["", "B"]},
    {"series": [{"name": "Method", "values": ["nan", 2]}]},
    {"series": [{"name": "Method", "values": [1e13, 2]}]},
    {"type": "pie", "series": [{"name": "Method", "values": [-1, 2]}]},
    {"type": "pie", "series": [{"name": "Method", "values": [0, 0]}]},
    {"type": "pie", "series": [{"name": "A", "values": [1, 2]}, {"name": "B", "values": [2, 3]}]},
])
def test_invalid_data_is_422_before_any_figure_is_written(matrix, changes):
    pid = new_project(matrix)
    result = matrix["clients"]["owner"].post(f"/api/project-figures/{pid}", json=chart(**changes))
    assert result.status_code == 422, result.text
    assert not (matrix["projects"] / pid / "figures").exists()


def test_project_access_and_cross_project_isolation(matrix):
    clients, pid = matrix["clients"], new_project(matrix)
    owner, url = clients["owner"], f"/api/project-figures/{pid}"
    for role in ("editor", "reviewer", "viewer"):
        result = owner.put(f"/api/projects/{pid}/members", json={"email": f"{role}@figures.example.com", "role": role})
        assert result.status_code == 200, result.text
    created = clients["editor"].post(url, json=chart())
    assert created.status_code == 200, created.text
    fid = created.json()["figure"]["id"]
    for role in ("viewer", "reviewer"):
        assert clients[role].get(url).status_code == 200
        assert clients[role].get(f"{url}/{fid}/png").status_code == 200
        assert clients[role].post(url, json=chart()).status_code == 403
        assert clients[role].delete(f"{url}/{fid}").status_code == 403
    for client, allowed_codes in ((TestClient(matrix["app"]), (401,)), (clients["outsider"], (403, 404))):
        assert client.get(url).status_code in allowed_codes
        assert client.get(f"{url}/{fid}/png").status_code in allowed_codes
        assert client.post(url, json=chart()).status_code in allowed_codes
        assert client.delete(f"{url}/{fid}").status_code in allowed_codes
    other = new_project(matrix)
    assert owner.get(f"/api/project-figures/{other}/{fid}/png").status_code == 404
    assert clients["editor"].get(f"/api/project-figures/{other}").status_code in (403, 404)
    assert len(owner.get(url).json()["figures"]) == 1
    assert clients["editor"].delete(f"{url}/{fid}").status_code == 200


def test_ids_cannot_escape_project_figures(matrix, monkeypatch):
    from app import config

    # AUTH=off 也必须约束磁盘路径，而不是依赖 ACL 拒绝非法 pid。
    monkeypatch.setattr(config, "AUTH_ON", False)
    client, pid = matrix["clients"]["owner"], new_project(matrix)
    bad_pid = quote("..\\outside", safe="")
    assert client.get(f"/api/project-figures/{bad_pid}").status_code == 400
    bad_fid = quote("..\\outside", safe="")
    assert client.get(f"/api/project-figures/{pid}/{bad_fid}/png").status_code == 422
    assert client.delete(f"/api/project-figures/{pid}/{bad_fid}").status_code == 422


def test_failed_index_write_does_not_leave_unlisted_png(matrix, monkeypatch):
    from app.routes import project_figures

    pid = new_project(matrix)
    def fail(*args):
        raise OSError("simulated index write failure")
    monkeypatch.setattr(project_figures, "_save_meta", fail)
    with pytest.raises(OSError, match="simulated index"):
        matrix["clients"]["owner"].post(f"/api/project-figures/{pid}", json=chart())
    assert not list((matrix["projects"] / pid / "figures").glob("*.png"))


def word_figure(matrix):
    client, pid = matrix["clients"]["owner"], new_project(matrix)
    result = client.post(f"/api/project-figures/{pid}", json=chart())
    assert result.status_code == 200, result.text
    figure = result.json()["figure"]
    state = client.get(f"/api/projects/{pid}/word/state").json()
    return client, pid, figure, state["doc_key"]


def image_url(pid, fid, key):
    return f"/api/project-figures/{pid}/{fid}/word-image?doc_key={quote(key)}"


def test_word_image_returns_real_png_snapshot_without_changing_document_or_session(matrix):
    client, pid, figure, key = word_figure(matrix)
    project = matrix["projects"] / pid
    state_path = project / ".studio" / "word" / "state.json"
    state_before = state_path.read_bytes()
    doc_before = client.get(f"/api/projects/{pid}/word/download").content
    png = (project / "figures" / f"{figure['id']}.png").read_bytes()
    result = client.get(image_url(pid, figure["id"], key))
    assert result.status_code == 200, result.text
    assert result.headers["cache-control"] == "no-store"
    body = result.json()
    assert body["id"] == figure["id"] and body["name"] == figure["name"]
    assert body["data_url"].startswith("data:image/png;base64,")
    assert base64.b64decode(body["data_url"].split(",", 1)[1], validate=True) == png
    assert body["sha256"] == hashlib.sha256(png).hexdigest()
    assert body["bytes"] == len(png)
    with Image.open(io.BytesIO(png)) as image:
        assert (body["width_px"], body["height_px"]) == image.size
    assert state_path.read_bytes() == state_before
    assert client.get(f"/api/projects/{pid}/word/download").content == doc_before


def test_word_image_requires_editor_even_with_known_session_key(matrix):
    client, pid, figure, key = word_figure(matrix)
    for role in ("editor", "reviewer", "viewer"):
        result = client.put(f"/api/projects/{pid}/members", json={"email": f"{role}@figures.example.com", "role": role})
        assert result.status_code == 200, result.text
    url = image_url(pid, figure["id"], key)
    assert matrix["clients"]["editor"].get(url).status_code == 200
    for role in ("reviewer", "viewer"):
        assert matrix["clients"][role].get(url).status_code == 403
    assert matrix["clients"]["outsider"].get(url).status_code in (403, 404)
    assert TestClient(matrix["app"]).get(url).status_code == 401


def test_word_image_rejects_stale_and_closed_sessions_without_rotating(matrix):
    client, pid, figure, key = word_figure(matrix)
    state_path = matrix["projects"] / pid / ".studio" / "word" / "state.json"
    initial = state_path.read_bytes()
    result = client.get(image_url(pid, figure["id"], "stale-key-12345678"))
    assert result.status_code == 409 and result.json()["detail"]["kind"] == "stale"
    assert state_path.read_bytes() == initial
    state = json.loads(initial)
    state["closed"] = True
    state_path.write_text(json.dumps(state), encoding="utf-8")
    closed = state_path.read_bytes()
    result = client.get(image_url(pid, figure["id"], key))
    assert result.status_code == 409, result.text
    assert state_path.read_bytes() == closed


def test_word_image_rejects_non_word_and_project_archive(matrix):
    client, pid, figure, key = word_figure(matrix)
    settings_path = matrix["projects"] / pid / "studio.json"
    settings = json.loads(settings_path.read_text(encoding="utf-8"))
    url = image_url(pid, figure["id"], key)
    settings_path.write_text(json.dumps({**settings, "source_format": "latex"}), encoding="utf-8")
    assert client.get(url).status_code == 400
    settings_path.write_text(json.dumps(settings), encoding="utf-8")
    result = client.put(f"/api/projects/{pid}/case", json={"archived": True})
    assert result.status_code == 200, result.text
    assert client.get(url).status_code == 403


@pytest.mark.parametrize("state", ["archived", "trashed"])
def test_word_image_rejects_projects_hidden_by_current_user(matrix, state):
    client, pid, figure, key = word_figure(matrix)
    result = client.post(f"/api/projects/{pid}/list-state", json={"state": state})
    assert result.status_code == 200, result.text
    assert client.get(image_url(pid, figure["id"], key)).status_code == 403
    assert client.post(f"/api/projects/{pid}/list-state", json={"state": "active"}).status_code == 200
    assert client.get(image_url(pid, figure["id"], key)).status_code == 200


def test_word_image_requires_project_index_membership_and_existing_png(matrix):
    client, pid, figure, key = word_figure(matrix)
    other_pid = new_project(matrix)
    other_key = client.get(f"/api/projects/{other_pid}/word/state").json()["doc_key"]
    assert client.get(image_url(other_pid, figure["id"], other_key)).status_code == 404
    folder = matrix["projects"] / pid / "figures"
    png_path = folder / f"{figure['id']}.png"
    index_path = folder / "index.json"
    index = index_path.read_bytes()
    index_path.write_text("[]", encoding="utf-8")
    assert png_path.is_file()
    assert client.get(image_url(pid, figure["id"], key)).status_code == 404
    index_path.write_bytes(index)
    png_path.unlink()
    assert client.get(image_url(pid, figure["id"], key)).status_code == 404


@pytest.mark.parametrize("kind", ["damaged", "jpeg", "too-large", "too-many-pixels"])
def test_word_image_rejects_invalid_or_oversized_images(matrix, monkeypatch, kind):
    from app.routes import project_figures

    client, pid, figure, key = word_figure(matrix)
    png_path = matrix["projects"] / pid / "figures" / f"{figure['id']}.png"
    expected = 422
    if kind == "damaged":
        png_path.write_bytes(b"not a valid PNG")
    elif kind == "jpeg":
        out = io.BytesIO()
        Image.new("RGB", (4, 3)).save(out, format="JPEG")
        png_path.write_bytes(out.getvalue())
    elif kind == "too-large":
        png_path.write_bytes(b"x" * (project_figures.MAX_WORD_IMAGE_BYTES + 1))
        expected = 413
    else:
        monkeypatch.setattr(project_figures, "MAX_WORD_IMAGE_PIXELS", 1)
        expected = 413
    result = client.get(image_url(pid, figure["id"], key))
    assert result.status_code == expected, result.text
