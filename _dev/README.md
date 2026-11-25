# _dev — 测试与开发工具

运行时**不会**加载这里的任何东西。它们只在开发、验证、排障时手动运行。

## 环境变量

所有脚本都从环境变量读配置，默认值由此文件所在位置推导，所以 clone 下来就能用：

| 变量 | 默认 | 说明 |
|---|---|---|
| `MUI_BASE` | `http://127.0.0.1:8188` | ComfyUI 地址 |
| `COMFYUI_DIR` | 本目录往上三层 | ComfyUI 根目录 |
| `MUI_WORKFLOWS` | `<COMFYUI_DIR>/user/default/workflows` | 工作流目录 |
| `MUI_SHOTS` | `_dev/shots` | 截图输出目录 |

## 依赖

只需要 Node.js 18+（用到了内置 `fetch` 和 `WebSocket`）。**没有任何 npm 包**。

浏览器相关脚本需要一个开了调试端口的 Chrome：

```bash
# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --headless=new --remote-debugging-port=9222 ^
  --user-data-dir=%TEMP%\mui-cdp about:blank

# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/mui-cdp about:blank
```

## 脚本

### smoke.mjs — 冒烟测试

```bash
node _dev/smoke.mjs
MUI_BASE=http://192.168.1.10:8188 node _dev/smoke.mjs
```

检查：页面能起、节点渲染出来、节点能点开、参数面板有字段、返回键只关闭面板、没有 JS 异常。
输出一张截图到 `_dev/shots/smoke.png`。

### scan_workflows.js — 工作流体检

```bash
node _dev/scan_workflows.js
node _dev/scan_workflows.js "D:/workflows" _dev/object_info.json
```

离线评估 ComfyUI 在排队时会检查的东西：节点类型存在吗、必填输入接了吗、文件类选项在列表里吗。
**不会排队，不占 GPU。** 有 `_dev/object_info.json` 就用本地的，否则在线拉。

### fetch_object_info.mjs — 刷新节点表快照

```bash
node _dev/fetch_object_info.mjs
node _dev/fetch_object_info.mjs http://127.0.0.1:8188
```

下载 `/object_info` 存成 `_dev/object_info.json`（约 4 MB，已被 `.gitignore` 排除）。

### test_convert.js — 转换器回归

```bash
node _dev/test_convert.js _dev/object_info.json <ui工作流> <api工作流> [...]
```

把 UI 格式工作流转成 API 格式，和真实导出逐字段比对，**任何差异都会以非零码退出**，
可以直接当发布门禁。需要成对的同名 UI / API 文件。

### cdp.mjs — 浏览器驱动

不是测试，是给上面几个脚本用的极简 CDP 客户端（约 130 行）：`goto / eval / waitFor /
tap / touchTap / touchDrag / shot`。用真实触摸事件而不是合成鼠标事件，因为手机走的是另一条手势路径。
