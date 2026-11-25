/* End-to-end smoke test: does the page come up, and does a node open?
 *
 *   node _dev/smoke.mjs
 *   MUI_BASE=http://192.168.1.10:8188 node _dev/smoke.mjs
 *
 * Needs a running ComfyUI and a headless Chrome started with
 * --remote-debugging-port=9222 (see _dev/README.md). Writes one screenshot.
 */
import { connect, sleep } from "./cdp.mjs";
import { BASE, SHOT_DIR, ensureShotDir } from "./paths.mjs";

const b = await connect();
await b.viewport(390, 844, 2);

let fails = 0;
const ok = (cond, label, extra = "") => {
  console.log((cond ? "  OK   " : "  FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) fails++;
};

const t0 = Date.now();
await b.goto(BASE + "/mobile/");
try {
  await b.waitFor("document.querySelectorAll('.node').length > 0", 40000);
} catch (_) {
  console.error("画布没有渲染出节点。" + BASE + "/mobile/ 是否可达？ComfyUI 是否在运行？");
  process.exit(1);
}
const bootMs = Date.now() - t0;

const s = await b.eval(`(() => ({
  nodes: document.querySelectorAll('.node').length,
  links: document.querySelectorAll('#linkLayer path').length,
  types: Object.keys(window.__MUI__.S.oi || {}).length,
  zoom: +window.__MUI__.S.view.z.toFixed(3),
  wf: (document.querySelector('#wfName') || {}).textContent
}))()`);
console.log("画布: " + JSON.stringify(s) + "  首屏 " + bootMs + "ms");

ok(s.nodes > 0, "节点已渲染", s.nodes + " 个");
ok(s.types > 100, "节点表已加载", s.types + " 种");
ok(s.zoom > 0, "视口已定位", "z=" + s.zoom);

console.log("\n--- 点开一个节点 ---");
/* Pick a node that is actually on screen and below the top bar: the first one
 * in document order may be scrolled out of the viewport. */
const box = await b.eval(`(() => {
  const S = window.__MUI__.S;
  const skip = /Note|Reroute|PrimitiveNode/;
  let fallback = null;
  for (const [id, n] of S.nodes) {
    if (skip.test(n.type)) continue;
    const el = document.querySelector('.node[data-id="' + id + '"]');
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const onScreen = r.x > 8 && r.y > 70 && r.x + 40 < innerWidth && r.y + 30 < innerHeight - 80;
    if (!onScreen) continue;
    const cand = { x: r.x + 30, y: r.y + 14, id, type: n.type };
    if ((n.inputs || []).length) return cand;
    if (!fallback) fallback = cand;
  }
  return fallback;
})()`);
if (!box) {
  console.error("视口里没有可点击的节点");
  process.exit(1);
}
console.log("  目标节点 #" + box.id + " " + box.type);
await b.touchTap(box.x, box.y);
await sleep(600);

const sheet = await b.eval(`(() => ({
  open: document.querySelector('#sheet').classList.contains('open'),
  fields: document.querySelectorAll('#sheetBody .field').length,
  wires: document.querySelectorAll('#sheetBody .wirebox').length,
  buttons: [...document.querySelectorAll('#sheetBody .btn-row button')].map(x => x.textContent),
  title: (document.querySelector('#sheetHead') || {}).textContent
}))()`);
console.log("参数面板: " + JSON.stringify(sheet));
ok(sheet.open, "参数面板已打开");
ok(sheet.fields > 0, "有可编辑参数", sheet.fields + " 个字段");
ok(sheet.buttons.indexOf("删除") >= 0, "底部有节点操作", sheet.buttons.join("/"));

console.log("\n--- 返回键只关闭面板 ---");
await b.eval("history.back()");
await sleep(600);
const after = await b.eval(`(() => ({
  open: document.querySelector('#sheet').classList.contains('open'),
  alive: document.querySelectorAll('.node').length,
  url: location.href
}))()`);
ok(!after.open, "面板已关闭");
ok(after.alive > 0 && after.url.indexOf("/mobile/") >= 0, "仍停在画布");

ensureShotDir();
const shot = SHOT_DIR + "/smoke.png";
await b.shot(shot);
console.log("\n截图: " + shot);

const errs = b.consoleLines.filter((l) => /EXCEPTION|Uncaught/i.test(l));
ok(errs.length === 0, "无 JS 异常", errs.slice(0, 3).join(" | "));

console.log("\n" + (fails ? "FAILED " + fails : "ALL PASS"));
process.exit(fails ? 1 : 0);
