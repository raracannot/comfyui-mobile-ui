"""ComfyUI Mobile UI - a touch-first node editor served at /mobile/.

Design rules, in order of importance
------------------------------------
1. This package must not be able to affect the desktop editor. Therefore it
   ships **no WEB_DIRECTORY**: custom-node front-end extensions are injected
   into every page load, including ComfyUI's own; a syntax error there breaks
   the desktop UI. This package instead serves a completely separate page.
2. Every route lives under /mobile/ so it cannot shadow a ComfyUI route.
3. Route registration is defensive: any failure logs and returns, it never
   prevents ComfyUI from starting.
4. File access is confined to ComfyUI's workflows directory, and writes are
   only ever allowed inside the `_mobile` sub-folder. Existing workflows are
   never overwritten.
5. Reverse-proxy friendly: the page computes its API root from the request
   path (and honours X-Forwarded-Prefix), so it can be mounted at
   https://example.com/comfy/mobile/ without code changes.

Removing this folder restores ComfyUI exactly as it was.
"""

import collections
import gzip
import hashlib
import json
import logging
import os
import time
import urllib.request

from aiohttp import client as aiohttp_client
from aiohttp import web

LOG = logging.getLogger("mobile_ui")

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__version__ = "1.0.0"

HERE = os.path.dirname(os.path.abspath(__file__))
ASSET_DIR = os.path.join(HERE, "web")
INDEX_FILE = os.path.join(ASSET_DIR, "index.html")

# Optional shared token. Unset = open (the normal LAN case).
TOKEN = os.environ.get("COMFYUI_MOBILE_TOKEN", "").strip()


# --------------------------------------------------------------------------- paths

def _user_dir() -> str:
    try:
        import folder_paths
        d = folder_paths.get_user_directory()
        if d:
            return d
    except Exception:
        pass
    return os.path.join(os.path.dirname(os.path.dirname(HERE)), "user")


WORKFLOW_DIR = os.path.join(_user_dir(), "default", "workflows")
MOBILE_DIR = os.path.join(WORKFLOW_DIR, "_mobile")


def _confine(root: str, rel: str) -> str:
    """Join `rel` onto `root`, refusing anything that escapes it."""
    rel = (rel or "").replace("\\", "/").strip("/")
    if not rel:
        raise ValueError("empty path")
    full = os.path.normpath(os.path.join(root, rel))
    rootn = os.path.normpath(root)
    if full != rootn and not full.startswith(rootn + os.sep):
        raise ValueError("path escapes root")
    return full


def _api_root(request) -> str:
    """Where ComfyUI's own endpoints (/prompt, /view, ...) live, as seen by the client."""
    prefix = request.headers.get("X-Forwarded-Prefix", "").strip()
    if prefix:
        return "/" + prefix.strip("/") + "/"
    path = request.path or "/"
    if path.endswith("/mobile/"):
        return path[: -len("mobile/")]
    if path.endswith("/mobile"):
        return path[: -len("mobile")]
    return "/"


# --------------------------------------------------------------------------- handlers

def _guard(request):
    """Return a 403 response when a token is configured and missing, else None."""
    if not TOKEN:
        return None
    given = request.query.get("t") or request.cookies.get("mui_token") or ""
    if given == TOKEN:
        return None
    return web.Response(
        status=403,
        text="需要一个访问令牌：/mobile/?t=<token>",
        content_type="text/plain",
        charset="utf-8",
    )


async def index(request):
    bad = _guard(request)
    if bad is not None:
        return bad
    try:
        with open(INDEX_FILE, "r", encoding="utf-8") as f:
            html = f.read()
    except Exception as exc:  # pragma: no cover
        LOG.exception("mobile_ui: cannot read index.html")
        return web.Response(status=500, text=f"index.html 读取失败: {exc}")

    boot = {
        "apiRoot": _api_root(request),
        "version": __version__,
        "token": TOKEN or "",
        "debug": DEBUG,
        "workflowDir": WORKFLOW_DIR,
        "mobileDir": MOBILE_DIR,
    }
    html = html.replace(
        "<!--MUI_BOOT-->",
        "<script>window.__MUI_BOOT__=" + json.dumps(boot, ensure_ascii=False) + ";</script>",
    )
    resp = web.Response(text=html, content_type="text/html", charset="utf-8")
    resp.headers["Cache-Control"] = "no-store"
    if TOKEN:
        resp.set_cookie("mui_token", TOKEN, max_age=86400 * 30, samesite="Lax")
    return resp


async def redirect_index(request):
    raise web.HTTPFound(_api_root(request) + "mobile/")


async def list_workflows(request):
    bad = _guard(request)
    if bad is not None:
        return bad
    items = []
    if os.path.isdir(WORKFLOW_DIR):
        for root, dirs, files in os.walk(WORKFLOW_DIR):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            rel_root = os.path.relpath(root, WORKFLOW_DIR).replace("\\", "/")
            if rel_root == ".":
                rel_root = ""
            for name in files:
                if not name.lower().endswith(".json") or name.startswith("."):
                    continue
                full = os.path.join(root, name)
                rel = (rel_root + "/" + name) if rel_root else name
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                items.append({
                    "path": rel,
                    "name": name[:-5],
                    "dir": rel_root,
                    "size": st.st_size,
                    "mtime": int(st.st_mtime),
                })
    items.sort(key=lambda x: (-x["mtime"], x["path"]))
    return _json_ok(request, {"workflows": items})


async def get_workflow(request):
    bad = _guard(request)
    if bad is not None:
        return bad
    try:
        full = _confine(WORKFLOW_DIR, request.query.get("path", ""))
    except ValueError:
        return web.json_response({"error": "非法路径"}, status=400)
    if not os.path.isfile(full):
        return web.json_response({"error": "工作流不存在"}, status=404)
    try:
        with open(full, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as exc:
        return web.json_response({"error": f"解析失败: {exc}"}, status=400)
    rel_path = os.path.relpath(full, WORKFLOW_DIR).replace("\\", "/")
    try:
        _note_workflow(rel_path, data)
    except Exception:
        pass
    return _json_ok(request, {"path": rel_path, "workflow": data})


async def get_bootstrap(request):
    """Everything the canvas needs to paint, in one small response.

    The full node table is 320 KB gzipped (2655 types); a workflow uses a few
    dozen of them. Sending the last workflow together with just the specs it
    needs makes the first paint a fraction of that, and the full table follows
    in the background for the node picker.
    """
    bad = _guard(request)
    if bad is not None:
        return bad

    hist = _read_history()
    want = request.query.get("path") or hist.get("last") or ""
    doc, rel_path = None, ""
    if want:
        try:
            full = _confine(WORKFLOW_DIR, want)
            if os.path.isfile(full):
                with open(full, "r", encoding="utf-8") as f:
                    doc = json.load(f)
                rel_path = os.path.relpath(full, WORKFLOW_DIR).replace("\\", "/")
        except Exception:
            doc = None

    if not doc or not isinstance(doc.get("nodes"), list):
        return web.json_response({"error": "没有可用的工作流", "path": ""}, status=404)

    types = sorted({str(n.get("type")) for n in doc["nodes"] if n.get("type")})
    table = _oi_cache.get("data") or {}
    if not table:
        # the prewarm thread has not finished; let the client take the slow path
        return web.json_response({"error": "节点表尚未就绪", "path": rel_path}, status=503)

    oi = {t: table[t] for t in types if t in table}
    missing = [t for t in types if t not in table]

    try:
        _note_workflow(rel_path, doc)
    except Exception:
        pass
    hist = _read_history()
    recent = sorted(hist["workflows"].items(), key=lambda kv: kv[1].get("openedAt", 0), reverse=True)[:20]

    return _json_ok(request, {
        "path": rel_path,
        "workflow": doc,
        "types": types,
        "oi": oi,
        "missing": missing,
        "total": len(table),
        "recent": [{"path": p, "openedAt": v.get("openedAt", 0), "count": v.get("count", 0)}
                   for p, v in recent],
    })


async def save_workflow(request):
    """Save into workflows/_mobile only - never overwrite an existing file."""
    bad = _guard(request)
    if bad is not None:
        return bad
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求体不是 JSON"}, status=400)

    name = (body.get("name") or "").strip()
    data = body.get("workflow")
    if not name or not isinstance(data, dict):
        return web.json_response({"error": "缺少 name / workflow"}, status=400)
    if "/" in name or "\\" in name:
        name = os.path.basename(name)
    if not name.lower().endswith(".json"):
        name += ".json"

    os.makedirs(MOBILE_DIR, exist_ok=True)
    full = _confine(MOBILE_DIR, name)
    if os.path.exists(full):
        return web.json_response({"error": f"{name} 已存在"}, status=409)
    try:
        with open(full, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
    except Exception as exc:
        return web.json_response({"error": f"写入失败: {exc}"}, status=500)
    return web.json_response({"ok": True, "path": "_mobile/" + name})


# --- object_info -----------------------------------------------------------------
# The slim index exists because /object_info is ~4.7 MB on this install and a
# phone should not have to download and parse all of it to draw a graph. It is
# built from the public endpoint (an internal loopback call) rather than from
# ComfyUI internals, so it keeps working across ComfyUI versions.

_oi_cache = {"at": 0.0, "data": None, "gz": None}


def _slim_template(t):
    """The shape of a dynamic-slot input (COMFY_AUTOGROW_V3), trimmed.

    Without this the client cannot name new slots or know the allowed range, and
    the template carries tooltips that would bloat the payload for no gain.
    """
    if not isinstance(t, dict):
        return None
    out = {}
    for k in ("prefix", "min", "max"):
        if k in t:
            out[k] = t[k]
    if isinstance(t.get("names"), (list, tuple)):
        out["names"] = list(t["names"])[:64]
    inp = t.get("input")
    if isinstance(inp, dict):
        sec = {}
        for s in ("required", "optional"):
            d = inp.get(s) or {}
            if d:
                sec[s] = {k: _slim_spec(v) for k, v in d.items()}
        out["input"] = sec
    return out


def _slim_spec(spec):
    if not isinstance(spec, list) or not spec:
        return ["*", {}]
    typ = spec[0]
    opts = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
    if isinstance(typ, list):          # legacy combo: type is the option list
        opts = dict(opts, options=typ)
        typ = "COMBO"
    keep = {}
    for k in ("default", "min", "max", "step", "round", "multiline",
              "control_after_generate", "forceInput", "dynamicPrompts",
              "image_upload", "video_upload", "audio_upload", "socketless"):
        if k in opts:
            keep[k] = opts[k]
    if "template" in opts:
        tpl = _slim_template(opts["template"])
        if tpl:
            keep["template"] = tpl
    if "options" in opts:
        vals = opts["options"]
        if isinstance(vals, (list, tuple)):
            if len(vals) > 300:
                keep["options"] = list(vals[:300])
                keep["_more"] = len(vals) - 300
            else:
                keep["options"] = list(vals)
    return [typ, keep]


def _oi_response(request):
    """Serve the cached slim node index, gzipped when the client accepts it.

    ComfyUI's cache middleware only sets Cache-Control via setdefault, so the
    headers below win. With an ETag the phone revalidates instead of pulling the
    ~320 KB payload again on every page load.
    """
    enc = (request.headers.get("Accept-Encoding", "") or "").lower()
    extra = {}
    if "gzip" in enc and _oi_cache.get("gz"):
        body = _oi_cache["gz"]
        extra = {"Content-Encoding": "gzip", "Vary": "Accept-Encoding"}
    else:
        body = json.dumps(_oi_cache["data"], ensure_ascii=False).encode("utf-8")

    etag = '"%s"' % hashlib.sha1(body).hexdigest()[:20]
    headers = dict(extra)
    headers["ETag"] = etag
    headers["Cache-Control"] = "private, max-age=300"
    if request.headers.get("If-None-Match") == etag:
        return web.Response(status=304, headers=headers)
    return web.Response(body=body, content_type="application/json", headers=headers)


def _prewarm_oi():
    """Build the slim node table in the background right after startup.

    It costs ~2.5 s (the raw /object_info is 4.7 MB and has to be parsed and
    trimmed), and paying it on the first phone request makes the page feel
    broken. Doing it while nobody is looking is free.
    """
    LOG.info("mobile_ui: prewarm scheduled")

    def worker():
        # PromptServer.instance.port is only meaningful once the server object
        # exists, so read it here rather than at schedule time.
        port = None
        for attempt in range(40):
            try:
                from server import PromptServer
                port = getattr(PromptServer.instance, "port", None)
            except Exception:
                port = None
            if port:
                break
            time.sleep(0.5)
        if not port:
            LOG.warning("mobile_ui: prewarm could not find the server port")
            return

        for attempt in range(30):
            time.sleep(2)
            try:
                with urllib.request.urlopen(
                        "http://127.0.0.1:%d/object_info" % port, timeout=120) as r:
                    raw = json.loads(r.read().decode("utf-8"))
            except Exception as exc:
                if attempt % 5 == 0:
                    LOG.info("mobile_ui: prewarm attempt %d: %s", attempt + 1, exc)
                continue
            if not isinstance(raw, dict) or len(raw) < 50:
                continue
            slim = {c: _slim_node(i) for c, i in raw.items() if isinstance(i, dict)}
            if not slim:
                continue
            _oi_cache["data"] = slim
            _oi_cache["gz"] = gzip.compress(
                json.dumps(slim, ensure_ascii=False).encode("utf-8"), 6)
            _oi_cache["at"] = time.time()
            LOG.info("mobile_ui: node table prewarmed (%d types, %.0f KB gz)",
                     len(slim), len(_oi_cache["gz"]) / 1024)
            return
        LOG.warning("mobile_ui: prewarm gave up; the table will be built on first request")

    import threading
    threading.Thread(target=worker, name="mobile_ui_prewarm", daemon=True).start()


def _slim_node(info):
    inp = info.get("input") or {}
    return {
        "dn": info.get("display_name") or "",
        "cat": (info.get("category") or "").split("/")[0],
        "in": {
            "required": {k: _slim_spec(v) for k, v in (inp.get("required") or {}).items()},
            "optional": {k: _slim_spec(v) for k, v in (inp.get("optional") or {}).items()},
        },
        "out": info.get("output") or [],
        "outn": info.get("output_name") or [],
        "pyd": info.get("python_module") or "",
    }


async def object_info(request):
    bad = _guard(request)
    if bad is not None:
        return bad

    refresh = request.query.get("refresh") == "1"
    now = time.time()
    if not refresh and _oi_cache["data"] is not None and now - _oi_cache["at"] < 1800:
        return _oi_response(request)

    # Where to fetch /object_info from. The process port is the right answer
    # almost always; the request's own origin is the fallback for the odd launch
    # where that attribute is unset, so this never depends on one guess.
    bases = []
    try:
        from server import PromptServer
        srv = PromptServer.instance
        port = getattr(srv, "port", None)
        if port:
            bases.append("http://127.0.0.1:" + str(port))
    except Exception:
        pass
    try:
        origin = str(request.url.origin())
        if origin and origin not in bases:
            bases.append(origin)
    except Exception:
        pass

    raw = None
    last_err = "no address to reach ComfyUI on"
    for base in bases:
        try:
            async with aiohttp_client.ClientSession(
                    timeout=aiohttp_client.ClientTimeout(total=30)) as sess:
                async with sess.get(base.rstrip("/") + "/object_info") as r:
                    if r.status != 200:
                        last_err = base + " -> HTTP " + str(r.status)
                        continue
                    raw = await r.json(content_type=None)
            if isinstance(raw, dict) and raw:
                break
        except Exception as exc:
            last_err = base + " -> " + str(exc)
            raw = None

    if not isinstance(raw, dict) or not raw:
        LOG.warning("mobile_ui: cannot read /object_info: %s", last_err)
        return web.json_response({"error": "读取 object_info 失败: " + last_err}, status=502)

    slim = {cls: _slim_node(info) for cls, info in raw.items() if isinstance(info, dict)}
    if not slim:
        return web.json_response({"error": "object_info 是空的"}, status=502)
    _oi_cache["data"] = slim
    _oi_cache["gz"] = gzip.compress(json.dumps(slim, ensure_ascii=False).encode("utf-8"), 6)
    _oi_cache["at"] = now
    return _oi_response(request)


_VIRTUAL_NIC = ("vEthernet", "Loopback", "VirtualBox", "VMware", "Hyper-V",
                "Bluetooth", "Docker", "WSL", "TAP-", "Tailscale", "ZeroTier",
                "Radmin", "NordLynx", "WireGuard")


def _lan_addresses():
    """IPv4 addresses a phone on the same network could actually use.

    Virtual adapters (Hyper-V switches, VM host-only nets) hand out addresses
    that look like LAN addresses and lead nowhere from a phone, so they are
    dropped when psutil can tell which interface owns them. The default-route
    address comes first, because that is the one that works.
    """
    out = []

    def add(ip):
        if not ip or ip.startswith("127.") or ip.startswith("169.254."):
            return
        if ip not in out:
            out.append(ip)

    try:
        import psutil
        stats = psutil.net_if_stats()
        for name, addrs in psutil.net_if_addrs().items():
            if any(bad.lower() in name.lower() for bad in _VIRTUAL_NIC):
                continue
            st = stats.get(name)
            if st is not None and not st.isup:
                continue
            for a in addrs:
                if getattr(a, "family", None) == 2:  # AF_INET
                    add(a.address)
    except Exception:
        pass

    try:
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            if ip and not ip.startswith("127.") and not ip.startswith("169.254."):
                if ip in out:
                    out.remove(ip)
                out.insert(0, ip)
        finally:
            s.close()
    except Exception:
        pass

    if not out:
        try:
            import socket
            for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
                add(info[4][0])
        except Exception:
            pass
    return out


async def meta(request):
    bad = _guard(request)
    if bad is not None:
        return bad
    comfy_version = ""
    try:
        import comfyui_version
        comfy_version = getattr(comfyui_version, "__version__", "")
    except Exception:
        pass
    port = 8188
    listening = ""
    try:
        from server import PromptServer
        srv = PromptServer.instance
        port = getattr(srv, "port", 8188) or 8188
        listening = getattr(srv, "address", "") or ""
    except Exception:
        pass
    prefix = (request.headers.get("X-Forwarded-Prefix", "") or "").strip().strip("/")
    tail = "/mobile/" if not prefix else "/" + prefix + "/mobile/"
    return web.json_response({
        "mobile_ui": __version__,
        "comfyui": comfy_version,
        "workflow_dir": WORKFLOW_DIR,
        "mobile_dir": MOBILE_DIR,
        "exists": os.path.isdir(WORKFLOW_DIR),
        "port": port,
        "listen": listening,
        "lan": ["http://" + ip + ":" + str(port) + tail for ip in _lan_addresses()],
        "token_required": bool(TOKEN),
    })


# --------------------------------------------------------------------------- gallery

# ComfyUI's /view?preview=jpeg re-encodes but keeps the resolution, so a 2K
# output is still megabytes over a phone connection. These thumbnails are
# actually resized, cached on disk, and served with a long cache header.

def _thumb_dir() -> str:
    d = os.path.join(os.path.dirname(HERE), "temp", "mobile_thumbs")
    os.makedirs(d, exist_ok=True)
    return d


def _resolve_media(kind: str, subfolder: str, filename: str) -> str:
    import folder_paths
    base = folder_paths.get_directory_by_type(kind)
    if not base:
        raise ValueError("未知类型: " + kind)
    full = os.path.normpath(os.path.join(base, subfolder or "", filename))
    base_n = os.path.normpath(base)
    if not full.startswith(base_n + os.sep):
        raise ValueError("路径越界")
    return full


def _video_frame(path: str):
    """First video frame as a PIL image, or None. PyAV ships with ComfyUI's
    video nodes; if it is absent the client just shows a placeholder tile."""
    try:
        import av
        with av.open(path) as c:
            for frame in c.decode(video=0):
                return frame.to_image()
    except Exception:
        return None
    return None


async def thumb(request):
    try:
        filename = request.query.get("filename", "")
        subfolder = request.query.get("subfolder", "")
        kind = request.query.get("type", "output")
        width = int(request.query.get("w", "320"))
    except Exception:
        return web.Response(status=400)
    width = max(64, min(width, 640))

    try:
        src = _resolve_media(kind, subfolder, filename)
    except ValueError as exc:
        return web.Response(status=400, text=str(exc))
    if not os.path.isfile(src):
        return web.Response(status=404)

    st = os.stat(src)
    key = "%s|%d|%d" % (src, int(st.st_mtime), width)
    import hashlib
    name = hashlib.sha1(key.encode("utf-8", "ignore")).hexdigest() + ".webp"
    out = os.path.join(_thumb_dir(), name)
    if not os.path.isfile(out):
        try:
            img = None
            if st.st_size and os.path.splitext(src)[1].lower() not in (
                    ".mp4", ".webm", ".mov", ".mkv", ".avi"):
                from PIL import Image
                with Image.open(src) as im:
                    im.draft("RGB", (width, width))
                    img = im.convert("RGB")
            if img is None:
                img = _video_frame(src)
            if img is None:
                return web.Response(status=415)
            img.thumbnail((width, width))
            img.save(out, "WEBP", quality=78, method=2)
        except Exception as exc:
            LOG.warning("mobile_ui: thumbnail failed for %s: %s", src, exc)
            return web.Response(status=415)

    resp = web.FileResponse(out, headers={
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=604800, immutable",
    })
    return resp


def _to_recycle_bin(paths):
    """Delete via the Windows shell so the files land in the Recycle Bin.

    os.remove is permanent, and a gallery with a "select all" button must not be
    able to destroy a folder irreversibly in one tap. Returns True when the
    shell accepted the operation.
    """
    if os.name != "nt":
        return False
    try:
        import ctypes
        from ctypes import wintypes

        class SHFILEOPSTRUCTW(ctypes.Structure):
            _fields_ = [
                ("hwnd", wintypes.HWND),
                ("wFunc", wintypes.UINT),
                ("pFrom", wintypes.LPCWSTR),
                ("pTo", wintypes.LPCWSTR),
                ("fFlags", ctypes.c_uint16),
                ("fAnyOperationsAborted", wintypes.BOOL),
                ("hNameMappings", ctypes.c_void_p),
                ("lpszProgressTitle", wintypes.LPCWSTR),
            ]

        FO_DELETE = 3
        FOF_ALLOWUNDO = 0x0040
        FOF_NOCONFIRMATION = 0x0010
        FOF_SILENT = 0x0004
        FOF_NOERRORUI = 0x0400

        src = "\0".join(paths) + "\0\0"
        op = SHFILEOPSTRUCTW(
            None, FO_DELETE, src, None,
            FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI,
            False, None, None,
        )
        rc = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
        return rc == 0 and not op.fAnyOperationsAborted
    except Exception as exc:
        LOG.warning("mobile_ui: recycle failed (%s), falling back", exc)
        return False


async def delete_media(request):
    """Move gallery files to the Recycle Bin. Only inside output/ and temp/,
    only by exact path, never the input/ folder."""
    bad = _guard(request)
    if bad is not None:
        return bad
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)

    items = body.get("items") or []
    if not isinstance(items, list) or not items:
        return web.json_response({"error": "没有要删除的文件"}, status=400)

    paths, meta, failed = [], [], []
    for it in items[:500]:
        try:
            kind = it.get("type") or "output"
            if kind not in ("output", "temp"):
                raise ValueError("只允许删除 output / temp 里的文件")
            path = _resolve_media(kind, it.get("subfolder", ""), it.get("filename", ""))
            if not os.path.isfile(path):
                raise ValueError("文件不存在")
            paths.append(path)
            meta.append(it)
        except Exception as exc:
            failed.append({"filename": it.get("filename"), "error": str(exc)})

    if not paths:
        return web.json_response({"deleted": 0, "failed": failed, "recycled": False})

    if _to_recycle_bin(paths):
        LOG.info("mobile_ui: recycled %d files", len(paths))
        return web.json_response({"deleted": len(paths), "failed": failed,
                                  "recycled": True})

    # No shell (or it refused): permanent, as before, but say so.
    deleted = 0
    for p, it in zip(paths, meta):
        try:
            os.remove(p)
            deleted += 1
        except Exception as exc:
            failed.append({"filename": it.get("filename"), "error": str(exc)})
    LOG.warning("mobile_ui: permanently deleted %d files", deleted)
    return web.json_response({"deleted": deleted, "failed": failed, "recycled": False})


MEDIA_EXT = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp",
             ".mp4", ".webm", ".mov", ".mkv", ".avi",
             ".flac", ".wav", ".mp3", ".ogg")


_OUTPUTS_CACHE = {"at": 0.0, "items": []}
OUTPUTS_TTL = 4.0


def _scan_outputs():
    """Walk the output folder, newest first, cached for a few seconds.

    The walk is what costs; paging through the result afterwards is free, which
    is what lets the gallery paint the newest dozen while the rest is on its way.
    """
    now = time.time()
    if now - _OUTPUTS_CACHE["at"] < OUTPUTS_TTL and _OUTPUTS_CACHE["items"]:
        return _OUTPUTS_CACHE["items"]

    try:
        import folder_paths
        root = folder_paths.get_directory_by_type("output")
    except Exception:
        return []

    items = []
    if root and os.path.isdir(root):
        for dirpath, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            rel = os.path.relpath(dirpath, root).replace("\\", "/")
            if rel == ".":
                rel = ""
            for f in files:
                if f.startswith(".") or not f.lower().endswith(MEDIA_EXT):
                    continue
                p = os.path.join(dirpath, f)
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                items.append({
                    "filename": f, "subfolder": rel, "type": "output",
                    "mtime": int(st.st_mtime), "size": st.st_size,
                })

    items.sort(key=lambda x: -x["mtime"])
    _OUTPUTS_CACHE["at"] = now
    _OUTPUTS_CACHE["items"] = items
    return items


async def list_outputs(request):
    """A page of ComfyUI's output folder, newest first.

    /history only knows about runs since the process started, so after any
    restart the gallery would look empty while the files are all still there.
    """
    try:
        limit = max(1, min(int(request.query.get("limit", "12")), 2000))
        offset = max(0, int(request.query.get("offset", "0")))
    except Exception:
        limit, offset = 12, 0

    items = _scan_outputs()
    return _json_ok(request, {
        "items": items[offset:offset + limit],
        "total": len(items),
        "offset": offset,
    })


# --------------------------------------------------------------------------- prompts
# Snippet library. Fragments are combined by inserting at the caret, so the file
# is a plain list rather than a tree of templates. The file lives under user/ so
# it survives plugin updates and can be edited by hand.

PROMPT_DIR = os.path.join(_user_dir(), "default", "mobile_ui")

# History of what the phone actually opened. Keeping it server side means a
# second device benefits from the first one, and it is what lets /bootstrap
# send only the node specs a workflow needs instead of all 2655.
HISTORY_FILE = os.path.join(PROMPT_DIR, "history.json")
HISTORY_MAX = 300


def _read_history():
    try:
        with open(HISTORY_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict) and isinstance(d.get("workflows"), dict):
            return d
    except Exception:
        pass
    return {"workflows": {}, "last": None}


def _write_history(d):
    try:
        os.makedirs(PROMPT_DIR, exist_ok=True)
        tmp = HISTORY_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=1)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, HISTORY_FILE)
    except Exception as exc:
        LOG.warning("mobile_ui: cannot write history: %s", exc)


def _note_workflow(path, doc):
    """Remember that this workflow was opened, and which node types it needs."""
    types = sorted({str(n.get("type")) for n in (doc.get("nodes") or []) if n.get("type")})
    h = _read_history()
    h["workflows"][path] = {
        "openedAt": int(time.time()),
        "count": len(doc.get("nodes") or []),
        "types": types,
    }
    h["last"] = path
    if len(h["workflows"]) > HISTORY_MAX:
        drop = sorted(h["workflows"].items(), key=lambda kv: kv[1].get("openedAt", 0))
        for k, _ in drop[: len(h["workflows"]) - HISTORY_MAX]:
            h["workflows"].pop(k, None)
    _write_history(h)


def _json_ok(request, obj, max_age=0):
    """json_response with gzip and unescaped UTF-8.

    The cache middleware only sets Cache-Control via setdefault, so headers
    set here win. Chinese text now stays UTF-8 instead of escaped code points,
    which alone was doubling the prompt library on the wire.
    """
    raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    headers = {}
    enc = (request.headers.get("Accept-Encoding", "") or "").lower()
    if "gzip" in enc and len(raw) > 1024:
        raw = gzip.compress(raw, 6)
        headers["Content-Encoding"] = "gzip"
        headers["Vary"] = "Accept-Encoding"
    if max_age:
        headers["Cache-Control"] = "private, max-age=%d" % max_age
    return web.Response(body=raw, content_type="application/json", headers=headers)

PROMPT_FILE = os.path.join(PROMPT_DIR, "prompts.json")


def _read_prompts():
    if not os.path.isfile(PROMPT_FILE):
        return {"rev": 0, "items": []}
    try:
        with open(PROMPT_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as exc:
        LOG.warning("mobile_ui: prompts.json unreadable (%s), starting empty", exc)
        return {"rev": 0, "items": []}
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        return {"rev": 0, "items": []}
    data["rev"] = int(data.get("rev") or 0)
    return data


def _write_prompts(data):
    """Write via a temp file and rename: two phones saving at once would
    otherwise truncate the file mid-write."""
    os.makedirs(PROMPT_DIR, exist_ok=True)
    tmp = PROMPT_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, PROMPT_FILE)


def _clean_item(it):
    if not isinstance(it, dict):
        return None
    text = str(it.get("text") or "")[:20000]
    if not text.strip():
        return None
    tags = it.get("tags")
    if not isinstance(tags, list):
        tags = []
    return {
        "id": str(it.get("id") or "")[:64] or ("p%x" % int(time.time() * 1000)),
        "name": str(it.get("name") or "")[:120],
        "text": text,
        "group": str(it.get("group") or "未分组")[:60],
        "tags": [str(t)[:40] for t in tags[:12]],
        "created": int(it.get("created") or 0),
        "used": int(it.get("used") or 0),
        "updatedAt": int(it.get("updatedAt") or 0),
    }


async def get_prompts(request):
    data = _read_prompts()
    return _json_ok(request, {
        "rev": data.get("rev", 0),
        "items": data.get("items", []),
        "file": PROMPT_FILE,
    })




def _dedupe_ids(items):
    """Item-level operations address entries by id, so ids must be unique.

    A hand-edited file or a pasted library can carry duplicates; the second
    occurrence would be unreachable by any operation, so give it a fresh id.
    """
    seen = set()
    changed = False
    for it in items:
        pid = str(it.get("id") or "")
        if not pid or pid in seen:
            new = "fix-%x" % int(time.time() * 1000000 + len(seen))
            while new in seen:
                new += "x"
            it["id"] = new
            pid = new
            changed = True
        seen.add(pid)
    return changed


def _apply_prompt_ops(cur, ops):
    """Merge item-level operations into the stored list.

    Each operation names one item by id, so two devices editing different
    entries both survive - which a whole-array PUT can never express. Ops are
    idempotent (add replaces, delete of a missing id succeeds) so a retried
    request cannot double-apply.
    """
    items = list(cur.get("items") or [])
    index = {}
    for i, it in enumerate(items):
        pid = it.get("id")
        if pid and pid not in index:
            index[pid] = i

    applied = 0
    skipped = []

    for op in ops[:2000]:
        if not isinstance(op, dict):
            skipped.append("bad op")
            continue
        kind = op.get("op")

        if kind == "delete":
            pid = str(op.get("id") or "")
            at = index.get(pid)
            if at is not None:
                items[at] = None
                index.pop(pid, None)
            applied += 1          # already absent is the same end state
            continue

        if kind in ("add", "update"):
            item = _clean_item(op.get("item") or {})
            if not item:
                skipped.append("bad item")
                continue
            at = index.get(item["id"])
            if at is not None:
                old = items[at] or {}
                # same item edited twice: the newer timestamp wins, and an
                # obvious rollback cannot clobber a fresher edit
                if item["updatedAt"] and (item["updatedAt"] < int(old.get("updatedAt") or 0)):
                    skipped.append(item["id"])
                    continue
                items[at] = item
            else:
                items.insert(0, item)   # newest first, matching the library order
                index = {it["id"]: n for n, it in enumerate(items) if it}
            applied += 1
            continue

        skipped.append("unknown op")

    return [it for it in items if it], applied, skipped


async def prompt_ops(request):
    """Apply per-item operations; no base revision needed because nothing is
    overwritten wholesale."""
    bad = _guard(request)
    if bad is not None:
        return bad
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)

    ops = body.get("ops")
    if not isinstance(ops, list):
        return web.json_response({"error": "ops 必须是数组"}, status=400)

    cur = _read_prompts()
    _dedupe_ids(cur.get("items") or [])
    items, applied, skipped = _apply_prompt_ops(cur, ops)
    data = {"rev": int(cur.get("rev", 0)) + 1, "items": items}
    try:
        _write_prompts(data)
    except Exception as exc:
        LOG.error("mobile_ui: cannot write prompts: %s", exc)
        return web.json_response({"error": "写入失败: %s" % exc}, status=500)

    return _json_ok(request, {
        "rev": data["rev"],
        "items": items,
        "applied": applied,
        "skipped": skipped,
    })

async def save_prompts(request):
    bad = _guard(request)
    if bad is not None:
        return bad
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)

    items = body.get("items")
    if not isinstance(items, list):
        return web.json_response({"error": "items 必须是数组"}, status=400)

    cur = _read_prompts()
    base = body.get("rev")
    if base is not None and int(base) != int(cur.get("rev", 0)):
        # another device wrote first; hand back its version so the client can
        # reload instead of silently overwriting it
        return web.json_response({
            "error": "conflict",
            "rev": cur.get("rev", 0),
            "items": cur.get("items", []),
        }, status=409)

    clean = [c for c in (_clean_item(it) for it in items[:5000]) if c]
    data = {"rev": int(cur.get("rev", 0)) + 1, "items": clean}
    try:
        _write_prompts(data)
    except Exception as exc:
        LOG.error("mobile_ui: cannot write prompts: %s", exc)
        return web.json_response({"error": "写入失败: %s" % exc}, status=500)

    return web.json_response({"rev": data["rev"], "items": clean})


# --------------------------------------------------------------------------- debug
# A phone is hard to develop against: no console, no inspector. This channel
# lets the page report what it is actually showing, and lets a bounded set of
# named actions be pushed back to it.
#
# It is deliberately NOT remote code execution: the client executes a fixed
# whitelist of commands, so the worst a caller can do is reload the page, open a
# workflow, open a node's sheet, or show a toast. Set COMFYUI_MOBILE_DEBUG=0 to
# turn it off entirely - worth doing before exposing this to the internet.

DEBUG = os.environ.get("COMFYUI_MOBILE_DEBUG", "1").strip().lower() not in ("0", "false", "no", "off")

_reports = collections.deque(maxlen=12)
_commands = collections.deque(maxlen=20)


async def debug_report(request):
    if not DEBUG:
        return web.json_response({"error": "debug disabled"}, status=404)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)
    body["_server_ts"] = time.time()
    _reports.appendleft(body)
    return web.json_response({"ok": True})


async def debug_state(request):
    if not DEBUG:
        return web.json_response({"error": "debug disabled"}, status=404)
    info = {}
    try:
        from server import PromptServer
        srv = PromptServer.instance
        info = {"port": getattr(srv, "port", None), "address": getattr(srv, "address", None)}
    except Exception:
        pass
    return web.json_response({
        "debug": DEBUG,
        "reports": list(_reports),
        "pending_commands": list(_commands),
        "server": info,
        "lan": _lan_addresses(),
    })


async def debug_push(request):
    if not DEBUG:
        return web.json_response({"error": "debug disabled"}, status=404)
    bad = _guard(request)
    if bad is not None:
        return bad
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)
    action = (body.get("action") or "").strip()
    if action not in ("reload", "open", "sheet", "fit", "toast", "probe", "repair"):
        return web.json_response({"error": "unknown action: " + action}, status=400)
    cmd = {"id": str(int(time.time() * 1000)), "action": action, "arg": body.get("arg")}
    _commands.append(cmd)
    return web.json_response({"ok": True, "queued": cmd})


async def debug_poll(request):
    if not DEBUG:
        return web.json_response({"commands": []})
    out = list(_commands)
    _commands.clear()
    return web.json_response({"commands": out})


# --------------------------------------------------------------------------- wiring

def _register():
    from server import PromptServer
    routes = PromptServer.instance.routes

    routes.get("/mobile")(redirect_index)
    routes.get("/mobile/")(index)

    routes.get("/mobile/api/workflows")(list_workflows)
    routes.get("/mobile/api/workflow")(get_workflow)
    routes.get("/mobile/api/bootstrap")(get_bootstrap)
    routes.post("/mobile/api/workflow")(save_workflow)
    routes.get("/mobile/api/object_info")(object_info)
    routes.get("/mobile/api/meta")(meta)
    routes.get("/mobile/api/thumb")(thumb)
    routes.post("/mobile/api/delete")(delete_media)
    routes.get("/mobile/api/outputs")(list_outputs)
    routes.get("/mobile/api/prompts")(get_prompts)
    routes.post("/mobile/api/prompts")(save_prompts)
    routes.post("/mobile/api/prompts/ops")(prompt_ops)

    routes.post("/mobile/api/debug/report")(debug_report)
    routes.get("/mobile/api/debug/state")(debug_state)
    routes.post("/mobile/api/debug/cmd")(debug_push)
    routes.get("/mobile/api/debug/poll")(debug_poll)

    # Assets are versioned by ?v= in index.html, so they can be cached forever.
    # routes.static would leave them to ComfyUI's default no-store, which means
    # re-downloading 160 KB of JS/CSS on every single page load.
    asset_types = {
        ".js": "application/javascript", ".css": "text/css", ".html": "text/html",
        ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
        ".json": "application/json", ".woff2": "font/woff2",
    }

    async def asset(request):
        try:
            path = _confine(ASSET_DIR, request.match_info.get("name", ""))
        except ValueError:
            return web.Response(status=400)
        if not os.path.isfile(path):
            return web.Response(status=404)
        ext = os.path.splitext(path)[1].lower()
        with open(path, "rb") as f:
            body = f.read()
        headers = {"Cache-Control": "public, max-age=31536000, immutable"}
        enc = (request.headers.get("Accept-Encoding", "") or "").lower()
        if "gzip" in enc and len(body) > 1024 and ext in (".js", ".css", ".html", ".svg", ".json"):
            body = gzip.compress(body, 6)
            headers["Content-Encoding"] = "gzip"
            headers["Vary"] = "Accept-Encoding"
        return web.Response(body=body,
                            content_type=asset_types.get(ext, "application/octet-stream"),
                            headers=headers)

    routes.get("/mobile/a/{name}")(asset)

    try:
        _prewarm_oi()
    except Exception as exc:
        LOG.debug("mobile_ui: prewarm not started: %s", exc)

    LOG.info("mobile_ui %s ready at /mobile/  (workflows: %s)", __version__, WORKFLOW_DIR)


try:
    _register()
except Exception:  # pragma: no cover - never take ComfyUI down with us
    LOG.exception("mobile_ui: route registration failed; the mobile UI is unavailable "
                  "but ComfyUI itself is unaffected")
