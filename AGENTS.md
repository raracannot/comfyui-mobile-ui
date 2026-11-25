# AGENTS.md

Instructions for an automated agent installing or modifying this project.
Everything here is non-interactive and verified on Windows; Linux/macOS commands are given
where they differ.

---

## 1. What this is

A ComfyUI custom node that serves a **second, touch-first frontend** at `/mobile/`.
It is not an injection into the desktop UI. It consists of:

- `__init__.py` — registers `/mobile/*` routes on ComfyUI's `PromptServer` at import time
- `web/` — the entire frontend (no build step, no npm, no third-party JS)
- `_dev/` — test harness, never loaded at runtime

Requires ComfyUI with `aiohttp` (any modern version; developed on 0.41.0, aiohttp 3.13).
`Pillow` is used for thumbnails and `av` (PyAV) optionally for video thumbnails — both
usually ship with ComfyUI already.

---

## 2. Install

```bash
# 1. clone into custom_nodes (folder name becomes the node folder)
cd <COMFYUI_ROOT>/custom_nodes
git clone https://github.com/raracannot/comfyui-mobile-ui.git mobile_ui

# 2. restart ComfyUI with --listen so other devices can reach it
python main.py --listen 0.0.0.0 --port 8188
```

Windows launcher equivalent — edit the `.bat` that calls `main.py` and add `--listen 0.0.0.0`.

There is nothing to `pip install` and nothing to build.

---

## 3. Verify the install

```bash
# the page answers (200) and the slim node table is served as gzip
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8188/mobile/
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8188/mobile/api/meta
curl -s -H "Accept-Encoding: gzip" http://127.0.0.1:8188/mobile/api/object_info | wc -c
```

Expected: `200`, `200`, and a body of a few hundred KB (gzip). If the first returns 404 the
custom node did not load — check the ComfyUI console for `mobile_ui: failed to register`.

Runtime check with a real browser (optional, needs Chrome):

```bash
node _dev/smoke.mjs
```

---

## 4. Configure

Environment variables read **once at import time** — restart after changing them.

| Variable | Default | Effect |
|---|---|---|
| `COMFYUI_MOBILE_TOKEN` | unset | If set, `/mobile/` requires `?t=<token>`; sets a cookie on success |
| `COMFYUI_MOBILE_DEBUG` | `1` | Remote diagnostics channel. `0` disables it |

---

## 5. Invariants — do not break these

1. **Never add a `WEB_DIRECTORY`** to `__init__.py`. It makes ComfyUI inject this project's
   JS into *every* page including the desktop UI; one syntax error whitens the screen for
   the user's normal workflow. The page is served by this node's own routes instead.
2. **Keep every route under `/mobile/`**. `/manager`, `/prompt`, `/view` belong to others.
3. **Writes only into `workflows/_mobile/`**, and refuse to overwrite (return 409).
4. **Route registration must stay inside `try/except`** so a failure can never prevent
   ComfyUI from starting.
5. **No third-party JS dependencies.** The frontend is hand-written ES5-ish JavaScript.
   Adding a bundler or a framework breaks the "clone and it works" property.
6. **Bump `?v=` in `web/index.html`** whenever `app.js` / `app.css` / `conv.js` changes,
   or phones will keep the cached copy.

---

## 6. Code map

| File | Responsibility | Notes |
|---|---|---|
| `__init__.py` | routes, slim `/object_info`, thumbnails, delete, debug channel | ~700 lines, all server logic |
| `web/conv.js` | UI workflow JSON → API prompt JSON | pure functions, UMD, unit-testable in Node |
| `web/app.js` | canvas gestures, sheet, panels, gallery, upload, crop picker, history stack | the bulk of the UI |
| `web/app.css` | mobile-first dark theme, safe-area insets | |
| `web/index.html` | shell + boot injection `<!--MUI_BOOT-->` | asset URLs carry `?v=` |

Key server behaviours worth knowing before editing:

- `/mobile/api/object_info` is a **trimmed** copy (`_slim_node` / `_slim_spec`): tooltips are
  dropped, combo options are capped at 300 with a `_more` key, `template` is kept (dynamic
  slots need `prefix`/`min`/`max`). The raw table is 4.7 MB; the slim one gzips to ~240 KB
  and is cached in-process for 30 minutes.
- `/mobile/api/thumb` resizes with Pillow, caches WebP on disk under `temp/mobile_thumbs`,
  and falls back to a PyAV first frame for videos. It is the only reason the gallery is
  usable on mobile data.
- `/mobile/api/delete` only touches `output/` and `temp/`, and on Windows uses
  `SHFileOperationW` with `FOF_ALLOWUNDO` so files land in the Recycle Bin.

---

## 7. Tests

```bash
node _dev/smoke.mjs                        # end-to-end against a running server
node _dev/scan_workflows.js [dir] [oi.json]  # offline validation of workflow folders
node _dev/fetch_object_info.mjs            # refresh the object_info fixture
node _dev/test_convert.js _dev/object_info.json <ui.json> <api.json> [...]
```

`smoke.mjs` needs a headless Chrome on port 9222 — see `_dev/README.md`.

Exit codes are meaningful: `0` pass, non-zero fail. Use them as gates.

---

## 8. Known traps

| Trap | What happens | Do this |
|---|---|---|
| Editing `app.js` while headless Chrome runs | `ReplaceFileW EIO (Win32 32)` on save | kill Chrome first |
| Reading/writing these files with PowerShell text cmdlets | UTF-8 becomes mojibake | use a proper editor / `[IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)` |
| `@(...)` nested arrays in PowerShell | PowerShell flattens them; `$pair[0]` becomes a *character* and silently corrupts files | build pairs as `,[array]` or use a different language |
| `/view?preview=jpeg` on a video | ComfyUI raises `PIL.UnidentifiedImageError` | only request preview for images |
| Assuming "input has a default ⇒ it is a widget" | 132 socket inputs on a real install carry defaults; they would be dropped from the prompt | use the explicit type list in `conv.js` |
| `?v=` not bumped | phone shows the old UI and reports phantom bugs | bump it |
| Testing with a stale `S.oi` | freshly added files look "missing" | the preflight verifies against `/view` HEAD; the sheet refreshes options after upload |

---

## 9. If something goes wrong

The node is self-contained: **delete `custom_nodes/mobile_ui/` and restart** to return to a
stock ComfyUI. Nothing outside that folder is modified at install time.
