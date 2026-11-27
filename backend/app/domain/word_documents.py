"""Native DOCX storage and the narrowly scoped ONLYOFFICE server boundary.

The uploaded/saved DOCX is the source of truth. No Markdown/HTML round trip is
performed. A session key is shared by all collaborators, survives force-save,
and is replaced after the last editor's final-save callback.
"""

import base64
import difflib
import hashlib
import hmac
import io
import json
import os
import secrets
import time
import zipfile
from datetime import UTC, datetime
from urllib.parse import quote, urlsplit, urlunsplit
from xml.etree import ElementTree

import httpx
from docx import Document
from docx.shared import Cm

from app import atomic, config
from app.domain.projects import SETTINGS_FILE, ProjectError

DOCX_MEDIA = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PLUGIN_GUID = "asc.{A9E36E21-B3F6-4D8D-B19A-61CF0E853725}"
NUMBERING_GUID = "asc.{684716C2-40E8-4F30-9B97-28321F0D7E84}"
AI_POLISH_GUID = "asc.{C4D8E2F1-A3B5-4C6D-8E9F-0A1B2C3D4E5F}"
REFS_GUID = "asc.{B7E1F4C2-8D3A-4E5F-9A6B-1C2D3E4F5A6B}"  # v0.4 文献引用桥


def ready() -> bool:
    return bool(config.WORD_EDITOR_ON and config.ONLYOFFICE_JWT_SECRET
                and all(_valid_base(u) for u in (config.ONLYOFFICE_URL,
                            config.ONLYOFFICE_INTERNAL_URL, config.ONLYOFFICE_PUBLIC_URL)))


def _valid_base(url: str) -> bool:
    try:
        p = urlsplit(url)
        _ = p.port
        return p.scheme in ("http", "https") and bool(p.hostname) and not (
            p.username or p.password or p.query or p.fragment)
    except ValueError:
        return False


def require_ready() -> None:
    if not config.WORD_EDITOR_ON:
        raise ProjectError("Word 编辑器未开启", 404)
    if not ready():
        raise ProjectError("Word 服务尚未配置：请启动 ONLYOFFICE 并配置 PATENT_STUDIO_ONLYOFFICE_JWT_SECRET", 503)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def sign(payload: dict) -> str:
    if not config.ONLYOFFICE_JWT_SECRET:
        raise ProjectError("Word 服务未配置签名密钥", 503)
    header = _b64(b'{"alg":"HS256","typ":"JWT"}')
    body = _b64(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode())
    msg = f"{header}.{body}"
    signature = hmac.new(config.ONLYOFFICE_JWT_SECRET.encode(), msg.encode(), hashlib.sha256).digest()
    return f"{msg}.{_b64(signature)}"


def verify(token: str, max_bytes=65536) -> dict:
    try:
        if not config.ONLYOFFICE_JWT_SECRET or not isinstance(token, str) or len(token) > max_bytes:
            raise ValueError()
        head, body, sig = token.split(".")
        def decode(x):
            return base64.urlsafe_b64decode(x + "=" * (-len(x) % 4))
        if json.loads(decode(head)).get("alg") != "HS256":
            raise ValueError()
        expected = hmac.new(config.ONLYOFFICE_JWT_SECRET.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(decode(sig), expected):
            raise ValueError()
        payload = json.loads(decode(body))
        if not isinstance(payload, dict) or ("exp" in payload and float(payload["exp"]) <= time.time()):
            raise ValueError()
        return payload
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError, UnicodeError, json.JSONDecodeError):
        raise ProjectError("Word 服务签名无效或已过期", 403) from None


def capability(pid: str, key: str, purpose: str) -> str:
    return sign({"aud": "studio-word-cap", "pid": pid, "key": key, "purpose": purpose,
                 "exp": int(time.time()) + 7 * 86400})


def check_capability(token: str, pid: str, key: str, purpose: str) -> None:
    p = verify(token)
    if any(p.get(k) != v for k, v in {"aud": "studio-word-cap", "pid": pid,
                                     "key": key, "purpose": purpose}.items()):
        raise ProjectError("Word 服务访问凭据不匹配", 403)


def verify_callback(body: dict, authorization: str = "") -> dict:
    token = body.get("token") or authorization.removeprefix("Bearer ")
    signed = verify(token, max_bytes=8 * 1024 * 1024)
    if signed.get("operation") not in (None, "callback"):
        raise ProjectError("Word 回调令牌用途不匹配", 403)
    signed = signed.get("payload", signed)
    # DS may truncate HTTP history/changesurl to keep its Authorization header
    # below 7 KB AFTER minting the full body JWT. We use no history metadata:
    # authenticate only the fields this integration actually consumes.
    fields = ("key", "status", "url", "userdata", "forcesavetype", "lastsave", "notmodified")
    if not isinstance(signed, dict) or any(k in body and body[k] != signed.get(k) for k in fields):
        raise ProjectError("Word 回调内容与签名不符", 403)
    return {k: signed[k] for k in fields if k in signed}


def verify_download(authorization: str, url: str) -> None:
    """校验 DS 下载请求的 JWT（同 secret 签名，payload.url 必须等于本次请求的 URL）。

    注意：DS 10.0 的下载 JWT **不带 operation 字段**（operation 只出现在 callback JWT），
    不能据此拒绝——签名不可伪造 + payload.url 逐一比对已足够防「复制 document.url 绕过下载策略」。"""
    signed = verify(authorization.removeprefix("Bearer "))
    if signed.get("payload", {}).get("url") != url:
        raise ProjectError("Word 文件请求需要 ONLYOFFICE 下载签名", 403)


def validate_docx(data: bytes) -> None:
    if not data or len(data) > config.WORD_MAX_BYTES:
        raise ProjectError("Word 文件为空或超过 50 MB", 413)
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            infos = z.infolist()
            if len(infos) > 10000 or sum(i.file_size for i in infos) > 250 * 1024 * 1024:
                raise ValueError("解压后的文件过大")
            names = [i.filename for i in infos]
            if len(names) != len(set(names)) or any(i.flag_bits & 1 for i in infos):
                raise ValueError("不支持加密或重名 ZIP 条目")
            if any(n.startswith(("/", "\\")) or ".." in n.replace("\\", "/").split("/") for n in names):
                raise ValueError("文件路径不合法")
            if "word/document.xml" not in names or "[Content_Types].xml" not in names:
                raise ValueError("缺少 DOCX 文档内容")
            if any(n.lower().endswith("vbaproject.bin") for n in names):
                raise ValueError("不接受含宏的文档，请另存为 DOCX")
            types = ElementTree.fromstring(z.read("[Content_Types].xml"))
            valid = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
            if not any(e.attrib.get("PartName") == "/word/document.xml"
                       and e.attrib.get("ContentType") == valid for e in types):
                raise ValueError("请上传普通 DOCX 文件")
            root = ElementTree.fromstring(z.read("word/document.xml"))
            if root.tag != "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}document":
                raise ValueError("文档 XML 类型不合法")
            bad = z.testzip()
            if bad:
                raise ValueError("压缩包内容损坏")
    except (zipfile.BadZipFile, KeyError, ValueError, RuntimeError, ElementTree.ParseError) as e:
        raise ProjectError(f"无法读取 DOCX：{e}", 422) from e


def make_document(title: str, template: str) -> bytes:
    from app.domain import paper_templates

    tpl = paper_templates.get("docx", template)
    if template != "blank":
        # A journal template is a document, not a bag of paragraph styles.
        # Keep every section, header, drawing, field and run intact. The project
        # title is metadata; it must not replace the template's formatted title.
        path = tpl["document"]
        with open(path, "rb") as f:
            return f.read()
    d = Document()
    d.core_properties.title = title
    d.add_paragraph(title, style="Title")
    d.sections[0].page_width, d.sections[0].page_height = Cm(21), Cm(29.7)
    d.add_paragraph("")
    out = io.BytesIO()
    d.save(out)
    return out.getvalue()


def _base(project_dir: str) -> str:
    return os.path.join(project_dir, ".studio", "word")


def document_path(project_dir: str) -> str:
    return os.path.join(project_dir, "document.docx")


def _state_path(project_dir: str) -> str:
    return os.path.join(_base(project_dir), "state.json")


def _load(project_dir: str) -> dict:
    try:
        with open(_state_path(project_dir), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        raise ProjectError("Word 保存记录无法读取，请保留原稿并联系管理员", 500) from e


def _now() -> str:
    return datetime.now(UTC).isoformat()


def create(store, title: str, data: bytes, submission=None, source="import"):
    validate_docx(data)
    pid = store.unique_pid("word-paper-" + secrets.token_hex(4))
    d = os.path.join(store.root, pid)
    os.makedirs(d, exist_ok=False)
    settings = {"document_type": "paper", "source_format": "docx", "title": title, "style": {}}
    if submission:
        settings["submission"] = {k: str(v)[:200] for k, v in submission.items() if v}
    atomic.write_json(os.path.join(d, SETTINGS_FILE), settings)
    state = {"version": 0, "versions": [], "key": secrets.token_hex(20), "closed": False,
             "saving": False, "receipts": []}
    with atomic.studio_lock(d, "word"):
        _persist(d, state, data, source)
    return store.get(pid)


def _persist(d: str, state: dict, data: bytes, source: str, complete_save=True) -> dict:
    sha = hashlib.sha256(data).hexdigest()
    if sha != state.get("sha"):
        version = state["version"] + 1
        vid = f"v{version:06d}-{sha[:12]}"
        created = _now()
        atomic.write_bytes(os.path.join(_base(d), "versions", vid + ".docx"), data)
        atomic.write_bytes(document_path(d), data)
        state.update(sha=sha, version=version, updated_at=created)
        state["versions"].append({"id": vid, "sha": sha, "created_at": created, "source": source})
    if complete_save:
        state["saving"] = False
    state["updated_at"] = _now()
    state.pop("last_error", None)
    atomic.write_json(_state_path(d), state)
    return state


def _public_state(s: dict) -> dict:
    """state.json → 前端快照的统一投影（upload_version 与 GET /word/state 必须同形）。"""
    return {k: s[k] for k in ("sha", "version", "updated_at", "saving", "versions")} | {
        "last_error": s.get("last_error"), "last_saved_request_id": s.get("last_saved_request_id"),
        "doc_key": s.get("key")}


def state(d: str) -> dict:
    with atomic.studio_lock(d, "word"):
        return _public_state(_load(d))


def upload_version(d: str, data: bytes, expected_sha: str = "") -> dict:
    """桌面 Word 往返闭环：上传本地修改稿为新版本。全部判定与落盘在锁内完成。

    内容有变化时轮换 DS 会话键并清空保存凭据：旧浏览器页签的延迟回调带着旧 key，
    在 callback 处因 key 不匹配被 409 拒绝，不会覆写刚上传的 DOCX；浏览器端随后
    用新 doc_key 重开编辑器，从服务端拉取最新文件。"""
    validate_docx(data)
    expected = (expected_sha or "").strip().lower()
    with atomic.studio_lock(d, "word"):
        s = _load(d)
        if s.get("saving"):
            raise ProjectError("文档服务正在回传保存，请等待保存完成后再上传本地修改稿", 409)
        if expected and expected != s.get("sha"):
            raise ProjectError("服务器在此期间已有他人保存新版本，请刷新核对最新版本后再上传", 409)
        unchanged = hashlib.sha256(data).hexdigest() == s.get("sha")
        if not unchanged:
            s.update(key=secrets.token_hex(20), closed=False)
            for field in ("save_nonce", "last_saved_request_id", "ds_lastsave", "ds_last_save_was_manual"):
                s.pop(field, None)
            s = _persist(d, s, data, "upload-version")
        out = {"version": s["version"], "sha": s["sha"], "doc_key": s.get("key"),
               "unchanged": unchanged, "state": _public_state(s)}
        return out


def renumber_citations(d: str, *, expected_sha: str = "", transform_fn) -> dict:
    """服务端确定性重排正文引用编号（P1-0-B）。全部判定与落盘在锁内完成。

    transform_fn(data) -> (new_data, payload)：new_data 为重排后 DOCX 字节（无变化时为原字节）；
    payload 为业务返回段（mapping / order / warnings / rebuilt_block）。fail-closed 校验失败以
    ProjectError(409/422) 抛出，绝不半途改写正文。内容有变化时轮换 DS 会话键并清空保存凭据
    （与 upload-version 同语义）：旧浏览器页签的延迟回调带着旧 key 在 callback 处被 409 拒绝，
    不会覆写刚重排的 DOCX；浏览器端随后用新 doc_key 重开编辑器，从服务端拉取最新文件。"""
    expected = (expected_sha or "").strip().lower()
    with atomic.studio_lock(d, "word"):
        s = _load(d)
        if s.get("saving"):
            raise ProjectError("文档服务正在回传保存，请等待保存完成后再重排引用", 409)
        if expected and expected != s.get("sha"):
            raise ProjectError("服务器在此期间已有他人保存新版本，请刷新核对最新版本后再重排", 409)
        with open(document_path(d), "rb") as f:
            data = f.read()
        new_data, payload = transform_fn(data)
        unchanged = new_data == data
        if not unchanged:
            validate_docx(new_data)
            s.update(key=secrets.token_hex(20), closed=False)
            for field in ("save_nonce", "last_saved_request_id", "ds_lastsave", "ds_last_save_was_manual"):
                s.pop(field, None)
            s = _persist(d, s, new_data, "renumber-citations")
        out = {"changed": not unchanged, "doc_key": s.get("key"), "state": _public_state(s)}
        out.update(payload)
        return out


def session(d: str, rotate_if_closed: bool = True) -> dict:
    """当前 DS 会话状态。rotate_if_closed=False 为只读读取（任务箱校验/页面自愈用，
    不产生轮换副作用——v0.4.1 实测：查询路径 rotate 会让插件 iframe 的固定 key 永不匹配）。"""
    with atomic.studio_lock(d, "word"):
        s = _load(d)
        if s.get("closed") and rotate_if_closed:
            s.update(key=secrets.token_hex(20), closed=False, saving=False)
            s.pop("save_nonce", None)
            s.pop("last_saved_request_id", None)
            s.pop("ds_lastsave", None)
            s.pop("ds_last_save_was_manual", None)
            atomic.write_json(_state_path(d), s)
        return s


def session_file(d: str, key: str) -> str:
    with atomic.studio_lock(d, "word"):
        s = _load(d)
        if key != s["key"] or s.get("closed"):
            raise ProjectError("Word 编辑会话已结束，请重新打开文档", 409)
        return document_path(d)


def version_path(d: str, vid: str) -> str:
    s = _load(d)
    if not any(v["id"] == vid for v in s["versions"]):
        raise ProjectError("Word 版本不存在", 404)
    return os.path.join(_base(d), "versions", vid + ".docx")


def _origin(p):
    return p.scheme, p.hostname, p.port or (443 if p.scheme == "https" else 80)


def server_download_url(url: str) -> str:
    """Accept only configured DS cache URLs; redirect following is always disabled."""
    try:
        p = urlsplit(url)
        targets = [urlsplit(config.ONLYOFFICE_INTERNAL_URL), urlsplit(config.ONLYOFFICE_URL)]
        match = next((t for t in targets if _origin(p) == _origin(t)), None)
        if match is None or p.username or p.password or p.fragment or "\\" in p.path:
            raise ValueError()
        prefix = match.path.rstrip("/") + "/cache/"
        if not p.path.startswith(prefix) or any(x in p.path.lower() for x in ("%2f", "%5c", "%2e", "/../")):
            raise ValueError()
        internal = urlsplit(config.ONLYOFFICE_INTERNAL_URL)
        path = internal.path.rstrip("/") + p.path[len(match.path.rstrip("/")):]
        return urlunsplit((internal.scheme, internal.netloc, path, p.query, ""))
    except (ValueError, TypeError):
        raise ProjectError("拒绝下载非配置 ONLYOFFICE 服务的文件地址", 400) from None


def fetch_document(url: str, pdf=False) -> bytes:
    target = server_download_url(url)
    try:
        with httpx.Client(timeout=config.WORD_NETWORK_TIMEOUT_S, follow_redirects=False, trust_env=False) as c:
            with c.stream("GET", target) as r:
                if r.status_code != 200:
                    raise ProjectError(f"ONLYOFFICE 文件下载失败（HTTP {r.status_code}）", 502)
                data = bytearray()
                for chunk in r.iter_bytes():
                    data.extend(chunk)
                    if len(data) > config.WORD_MAX_BYTES:
                        raise ProjectError("ONLYOFFICE 返回文件超过 50 MB", 413)
    except httpx.HTTPError as e:
        raise ProjectError("ONLYOFFICE 文件下载失败或超时，原稿保持已保存版本", 502) from e
    result = bytes(data)
    if pdf:
        if not result.startswith(b"%PDF-"):
            raise ProjectError("ONLYOFFICE 返回的文件不是有效 PDF", 502)
    else:
        validate_docx(result)
    return result


def server_request(path: str, body: dict) -> dict:
    payload = dict(body)
    operation = "converter" if path.split("?", 1)[0] == "/converter" else "command"
    payload["token"] = sign({**body, "operation": operation})
    try:
        with httpx.Client(timeout=config.WORD_NETWORK_TIMEOUT_S, follow_redirects=False, trust_env=False) as client:
            r = client.post(config.ONLYOFFICE_INTERNAL_URL + path, json=payload,
                            headers={"Accept": "application/json",
                                     "Authorization": "Bearer " + sign({"payload": body, "operation": operation})})
            r.raise_for_status()
            response = r.json()
            if not isinstance(response, dict):
                raise ValueError()
            return response
    except (httpx.HTTPError, ValueError) as e:
        raise ProjectError("无法连接 ONLYOFFICE，请检查文档服务与 JWT 配置", 502) from e


def request_save(d: str) -> dict:
    with atomic.studio_lock(d, "word"):
        s = _load(d)
        if s.get("closed"):
            return {"pending": False, "unchanged": True}
        if s.get("saving"):
            requested = datetime.fromisoformat(s.get("save_requested_at", _now()))
            if (datetime.now(UTC) - requested).total_seconds() < 90:
                raise ProjectError("已有 Word 保存正在进行，请等待完成后重试", 409)
        key, nonce = s["key"], secrets.token_hex(12)
        previous_nonce = s.get("save_nonce")
        s.update(saving=True, save_nonce=nonce, save_requested_at=_now())
        s.pop("last_error", None)
        atomic.write_json(_state_path(d), s)
    try:
        result = server_request("/command", {"c": "forcesave", "key": key, "userdata": nonce})
        error = result.get("error", -1)
        if error not in (0, 4):
            raise ProjectError(f"ONLYOFFICE 无法保存（错误 {error}），请稍后重试", 502)
    except Exception:
        with atomic.studio_lock(d, "word"):
            s = _load(d)
            if s["key"] == key and s.get("save_nonce") == nonce:
                s["saving"] = False
                # Keep the nonce: an accepted DS command may finish after an
                # HTTP timeout. That callback can still safely save its data.
                atomic.write_json(_state_path(d), s)
        raise
    if error == 4:
        with atomic.studio_lock(d, "word"):
            s = _load(d)
            if s["key"] == key and s.get("save_nonce") == nonce:
                s["saving"] = False
                if previous_nonce:
                    s["save_nonce"] = previous_nonce
                else:
                    s.pop("save_nonce", None)
                # NotModified also covers an existing DS save in progress. It
                # does not mean the stored DOCX is damaged: report this attempt
                # as unconfirmed without poisoning future clean downloads.
                atomic.write_json(_state_path(d), s)
        raise ProjectError(
            "文档服务没有启动新的保存任务，尚未确认本次保存。请保留编辑页面并稍后重试；"
            "如需取回文件，可从「版本」下载服务器已保存版本（不包含尚未回传的修改）。", 409)
    return {"pending": True, "request_id": nonce}


def callback(d: str, key: str, payload: dict) -> dict:
    if payload.get("key") != key:
        raise ProjectError("Word 回调文档标识不匹配", 403)
    status = payload.get("status")
    receipt = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    with atomic.studio_lock(d, "word"):
        s = _load(d)
        if receipt in s.get("receipts", []):
            return {"error": 0}
        if key != s["key"] or s.get("closed"):
            raise ProjectError("已拒绝过期 Word 会话保存", 409)
        if status in (3, 7):
            userdata = payload.get("userdata")
            if (status == 3 or (userdata and userdata == s.get("save_nonce"))
                    or (not userdata and not s.get("saving"))):
                s.update(saving=False, last_error="ONLYOFFICE 保存失败，请保留编辑器并重试")
            atomic.write_json(_state_path(d), s)
            return {"error": 0}
        if status not in (2, 6):
            if status == 4:
                s.update(closed=True, saving=False)
                s["receipts"] = (s.get("receipts", []) + [receipt])[-100:]
                atomic.write_json(_state_path(d), s)
            return {"error": 0}
        # Manual force-save callbacks carry our nonce. A late command response
        # must never finish a newer explicit save request.
        if status == 6 and payload.get("userdata") and payload["userdata"] != s.get("save_nonce"):
            raise ProjectError("已拒绝过期 Word 保存请求", 409)
    try:
        data = fetch_document(payload.get("url", ""))
    except ProjectError:
        with atomic.studio_lock(d, "word"):
            s = _load(d)
            if key == s["key"] and (status == 2 or not s.get("saving")
                                    or payload.get("userdata") == s.get("save_nonce")):
                s.update(saving=False, last_error="Word 保存文件接收失败，原稿保持上次保存版本，请重试保存")
                atomic.write_json(_state_path(d), s)
        raise
    with atomic.studio_lock(d, "word"):
        s = _load(d)
        if receipt in s.get("receipts", []):
            return {"error": 0}
        if key != s["key"] or s.get("closed"):
            raise ProjectError("已拒绝过期 Word 会话保存", 409)
        if status == 6 and payload.get("userdata") and payload["userdata"] != s.get("save_nonce"):
            raise ProjectError("已拒绝过期 Word 保存请求", 409)
        s["receipts"] = (s.get("receipts", []) + [receipt])[-100:]
        if status == 2:
            s["closed"] = True
        manual_ack = status == 6 and bool(payload.get("userdata")) and payload["userdata"] == s.get("save_nonce")
        if manual_ack:
            s["last_saved_request_id"] = payload["userdata"]
        def saved_time(value):
            try:
                return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
            except (ValueError, TypeError):
                return None
        previous_time = saved_time(s.get("ds_lastsave"))
        incoming_time = saved_time(payload.get("lastsave"))
        older = (previous_time is not None and incoming_time is not None and incoming_time < previous_time)
        # DS lastsave may have second precision. At an equal timestamp retain
        # an already acknowledged manual snapshot over a delayed auto-save.
        older_auto = (status == 6 and not payload.get("userdata") and s.get("ds_last_save_was_manual")
                      and (incoming_time is None or (previous_time is not None and incoming_time <= previous_time)))
        if older or older_auto:
            if status == 2 or manual_ack:
                s["saving"] = False
            atomic.write_json(_state_path(d), s)
            return {"error": 0}
        if incoming_time is not None:
            s["ds_lastsave"] = payload["lastsave"]
        s["ds_last_save_was_manual"] = manual_ack
        # An earlier auto-save snapshot can update versions while a newer
        # manual save is pending, but must never acknowledge that request.
        _persist(d, s, data, "onlyoffice-final" if status == 2 else "onlyoffice-forcesave",
                 complete_save=status == 2 or manual_ack or not s.get("saving"))
    return {"error": 0}


def editor_config(project, role: str | None, user: dict, browser_base: str,
                  permissions: dict) -> dict:
    require_ready()
    s = session(project.dir)
    pid, key = project.id, s["key"]
    public = config.ONLYOFFICE_PUBLIC_URL
    path = f"{quote(pid)}/{key}"
    can_edit = role in (None, "owner", "agent", "editor")
    review = role == "reviewer"
    doc_permissions = {"edit": can_edit, "review": can_edit or review,
                       "comment": bool(permissions.get("allow_comment", True)),
                       "download": bool(permissions.get("allow_download", True)),
                       "copy": bool(permissions.get("allow_copy", True)),
                       "print": bool(permissions.get("allow_download", True)),
                       "modifyContentControl": can_edit, "modifyFilter": can_edit}
    cfg = {"documentType": "word", "type": "desktop", "width": "100%", "height": "100%",
           "document": {"title": project.title + ".docx", "fileType": "docx", "key": key,
               "url": f"{public}/api/office/document/{path}?cap={capability(pid, key, 'document')}",
               "permissions": doc_permissions},
           "editorConfig": {"lang": "zh-CN", "mode": "edit" if can_edit or review else "view", "user": user,
               "callbackUrl": f"{public}/api/office/callback/{path}?cap={capability(pid, key, 'callback')}",
               "coEditing": {"mode": "fast", "change": False},
               "customization": {"forcesave": True, "autosave": True,
                   "review": {"trackChanges": review}},
               "plugins": {"autostart": ([NUMBERING_GUID, AI_POLISH_GUID, REFS_GUID] if can_edit else []),
                   "pluginsData": [browser_base.rstrip("/") + "/api/office-plugin/config.json",
                                   browser_base.rstrip("/") + "/api/office-plugin/native/config.json",
                                   browser_base.rstrip("/") + "/api/office-plugin-ai/config.json",
                                   browser_base.rstrip("/") + "/api/office-plugin-refs/config.json",
                                   browser_base.rstrip("/") + "/api/office-charts/config.json"]}}}
    cfg["token"] = sign(cfg)
    return {"document_server_url": config.ONLYOFFICE_URL, "config": cfg}


def export_pdf(project) -> dict:
    require_ready()
    with atomic.studio_lock(project.dir, "word"):
        s = _load(project.dir)
        if s.get("saving"):
            raise ProjectError("Word 正在保存，请等待保存完成后导出 PDF", 409)
        version, sha = s["versions"][-1], s["sha"]
    path = os.path.join(_base(project.dir), "exports", sha + ".pdf")
    if not os.path.isfile(path):
        vid = version["id"]
        cap = capability(project.id, vid, "version")
        url = (config.ONLYOFFICE_PUBLIC_URL + f"/api/office/version/{quote(project.id)}/{vid}?cap={cap}")
        result = server_request("/converter", {"async": False, "filetype": "docx", "outputtype": "pdf",
            "key": "pdf-" + sha[:48], "url": url, "title": project.title + ".docx"})
        if result.get("error") or not result.get("endConvert") or not result.get("fileUrl"):
            raise ProjectError(f"ONLYOFFICE PDF 转换失败（错误 {result.get('error', 'unknown')}）", 502)
        atomic.write_bytes(path, fetch_document(result["fileUrl"], pdf=True))
    return {"url": f"/api/projects/{quote(project.id)}/word/pdf/{sha}.pdf", "sha": sha}


def label_version(d: str, vid: str, label: str) -> dict:
    """为指定已保存 Word 版本设置或清空里程碑标签（<=80 字符）。"""
    clean = str(label or "").strip()[:80]
    with atomic.studio_lock(d, "word"):
        s = _load(d)
        target = next((v for v in s["versions"] if v["id"] == vid), None)
        if target is None:
            raise ProjectError("Word 版本不存在", 404)
        if clean:
            target["label"] = clean
        else:
            target.pop("label", None)
        atomic.write_json(_state_path(d), s)
        return _public_state(s)


def restore_version(d: str, vid: str, *, expected_sha: str | None = None) -> dict:
    """非破坏式恢复历史版本为最新当前稿（生成新版本 + 轮换 doc_key + 乐观锁校验）。"""
    with atomic.studio_lock(d, "word"):
        s = _load(d)
        if s.get("saving"):
            raise ProjectError("Word 正在保存，请等待保存完成后再恢复版本", 409)
        if expected_sha and s.get("sha") != expected_sha:
            raise ProjectError("文档已更新，当前快照已过期（409），请刷新后重试", 409)
        target = next((v for v in s["versions"] if v["id"] == vid), None)
        if target is None:
            raise ProjectError("Word 版本不存在", 404)
        vpath = os.path.join(_base(d), "versions", vid + ".docx")
        if not os.path.isfile(vpath):
            raise ProjectError("Word 版本文件缺失", 404)
        with open(vpath, "rb") as f:
            data = f.read()
        validate_docx(data)
        s.update(key=secrets.token_hex(20), closed=False)
        s = _persist(d, s, data, f"restore:{vid}")
        src_label = target.get("label") or vid[:12]
        s["versions"][-1]["label"] = f"恢复自 {src_label}"[:80]
        atomic.write_json(_state_path(d), s)
        return _public_state(s)


def _extract_docx_lines(path: str) -> list[str]:
    doc = Document(path)
    out = [p.text for p in doc.paragraphs]
    for table in doc.tables:
        for row in table.rows:
            cells = [c.text.replace("\n", " ").strip() for c in row.cells]
            out.append("[表格] " + " | ".join(cells))
    return out


def diff_versions(d: str, base_vid: str, target_vid: str) -> dict:
    """比较两个已保存 Word 版本的正文与表格文本差异，输出 unified diff。"""
    with atomic.studio_lock(d, "word"):
        s = _load(d)
        base_v = next((v for v in s["versions"] if v["id"] == base_vid), None)
        target_v = next((v for v in s["versions"] if v["id"] == target_vid), None)
        if base_v is None or target_v is None:
            raise ProjectError("指定的对比 Word 版本不存在", 404)
    base_path = os.path.join(_base(d), "versions", base_vid + ".docx")
    target_path = os.path.join(_base(d), "versions", target_vid + ".docx")
    if not os.path.isfile(base_path) or not os.path.isfile(target_path):
        raise ProjectError("Word 版本文件缺失", 404)

    base_lines = _extract_docx_lines(base_path)
    target_lines = _extract_docx_lines(target_path)
    from_lbl = str(base_v.get("label") or base_vid)
    to_lbl = str(target_v.get("label") or target_vid)
    raw_diff = list(difflib.unified_diff(base_lines, target_lines, fromfile=from_lbl, tofile=to_lbl, lineterm="", n=3))
    added = sum(1 for ln in raw_diff if ln.startswith("+") and not ln.startswith("+++"))
    removed = sum(1 for ln in raw_diff if ln.startswith("-") and not ln.startswith("---"))
    max_lines = 3000
    truncated = len(raw_diff) > max_lines
    shown = raw_diff[:max_lines]
    return {
        "base_vid": base_vid,
        "target_vid": target_vid,
        "base_sha": base_v.get("sha"),
        "target_sha": target_v.get("sha"),
        "added": added,
        "removed": removed,
        "truncated": truncated,
        "unified_diff": "\n".join(shown),
    }


def build_word_revision_kit_zip(project, *, base_vid: str | None = None, target_vid: str | None = None) -> tuple[bytes, str]:
    """打包 Word 返修包 ZIP（当前终稿 .docx / 版本文本对比 diff / 审稿回复信 / README）。"""
    import re

    from app.domain import rebuttal

    with atomic.studio_lock(project.dir, "word"):
        s = _load(project.dir)
        if s.get("saving"):
            raise ProjectError("Word 正在保存，请等待保存完成后再导出返修包", 409)
        versions = list(s.get("versions") or [])
    if not versions:
        raise ProjectError("当前工程尚无已保存 Word 版本，无法生成返修包", 409)

    entries: list[tuple[str, bytes]] = []
    included: list[str] = []
    notes: list[str] = []

    latest = versions[-1]
    latest_path = version_path(project.dir, latest["id"])
    with open(latest_path, "rb") as f:
        entries.append(("01-manuscript-current.docx", f.read()))
    included.append(f"01-manuscript-current.docx (version {len(versions)}, id {latest['id']})")

    b_vid, t_vid = base_vid, target_vid
    if (not b_vid or not t_vid) and len(versions) >= 2:
        b_vid, t_vid = versions[-2]["id"], versions[-1]["id"]
    if b_vid and t_vid:
        dres = diff_versions(project.dir, b_vid, t_vid)
        diff_body = dres["unified_diff"] or "两个版本段落与表格文本完全一致，无差异。"
        entries.append(("02-version-diff.txt", (diff_body + "\n").encode("utf-8")))
        included.append(f"02-version-diff.txt ({b_vid} -> {t_vid}, +{dres['added']}/-{dres['removed']})")
    else:
        notes.append("02-version-diff.txt：当前仅有单个版本且未指定对比范围")

    project_dict = {"id": project.id, "title": project.title, "dir": project.dir}
    try:
        reb_state = rebuttal.load_state(project.dir)
        items = reb_state.get("items") or []
        if items and rebuttal._has_exportable(items):
            round_no = max(int(reb_state.get("round") or 0), 1)
            for fmt in ("md", "docx"):
                content = rebuttal.export_letter(project_dict, reb_state, fmt)
                arcname = f"03-response-letter.{fmt}"
                entries.append((arcname, content))
                included.append(f"{arcname} (round {round_no})")
        else:
            notes.append("03-response-letter.*：审稿回复信暂无已撰写内容")
    except rebuttal.RebuttalError as exc:
        notes.append(f"03-response-letter.*：{exc}")

    readme_lines = [
        f"Paper Studio Word Revision Kit - {project.title or project.id}",
        f"Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        "Included files:",
        *[f"  - {line}" for line in included],
    ]
    if notes:
        readme_lines.extend(["", "Skipped / Notes:", *[f"  - {line}" for line in notes]])
    entries.append(("README-revision-kit.txt", ("\n".join(readme_lines) + "\n").encode("utf-8")))

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, content in entries:
            zf.writestr(name, content)

    base = re.sub(r"[^A-Za-z0-9._-]+", "-", project.title or project.id).strip("-") or project.id
    return buf.getvalue(), quote(f"{base}-word-revision-kit.zip")
