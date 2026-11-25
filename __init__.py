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
import json
import logging
import os
import time

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
    return web.json_response({"workflows": items})


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
    return web.json_response({
        "path": os.path.relpath(full, WORKFLOW_DIR).replace("\\", "/"),
        "workflow": data,
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

    ~2.7 MB raw and a few hundred KB gzipped; the compressed copy is built once
    alongside the dict so repeat loads cost nothing.
    """
    enc = (request.headers.get("Accept-Encoding", "") or "").lower()
    if "gzip" in enc and _oi_cache.get("gz"):
        return web.Response(
            body=_oi_cache["gz"],
            content_type="application/json",
            headers={"Content-Encoding": "gzip", "Vary": "Accept-Encoding"},
        )
    return web.Response(
        body=json.dumps(_oi_cache["data"], ensure_ascii=False).encode("utf-8"),
        content_type="application/json",
    )


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


async def list_outputs(request):
    """Everything in ComfyUI's output folder, newest first.

    /history only knows about runs since the process started, so after any
    restart the gallery would look empty while the files are all still there.
    """
    try:
        import folder_paths
        root = folder_paths.get_directory_by_type("output")
        limit = max(1, min(int(request.query.get("limit", "300")), 2000))
    except Exception:
        return web.json_response({"items": [], "total": 0})

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
    return web.json_response({"items": items[:limit], "total": len(items)})


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
    routes.post("/mobile/api/workflow")(save_workflow)
    routes.get("/mobile/api/object_info")(object_info)
    routes.get("/mobile/api/meta")(meta)
    routes.get("/mobile/api/thumb")(thumb)
    routes.post("/mobile/api/delete")(delete_media)
    routes.get("/mobile/api/outputs")(list_outputs)

    routes.post("/mobile/api/debug/report")(debug_report)
    routes.get("/mobile/api/debug/state")(debug_state)
    routes.post("/mobile/api/debug/cmd")(debug_push)
    routes.get("/mobile/api/debug/poll")(debug_poll)

    if os.path.isdir(ASSET_DIR):
        routes.static("/mobile/a", ASSET_DIR, name="mobile_ui_assets")

    LOG.info("mobile_ui %s ready at /mobile/  (workflows: %s)", __version__, WORKFLOW_DIR)


try:
    _register()
except Exception:  # pragma: no cover - never take ComfyUI down with us
    LOG.exception("mobile_ui: route registration failed; the mobile UI is unavailable "
                  "but ComfyUI itself is unaffected")
