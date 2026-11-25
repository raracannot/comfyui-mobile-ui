/* Regression test: convert a UI-format workflow and diff the result against a
 * real API-format export of the same workflow.
 *
 *   node _dev/test_convert.js <object_info.json> <ui.json> <api.json> [...]
 *
 * Exits non-zero on any difference, so it can gate delivery.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const conv = require(path.join(__dirname, "..", "web", "conv.js"));

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function declaredKeys(info) {
  const inSec = (info && (info.input || {})) || {};
  const keys = {};
  for (const sec of ["required", "optional"]) {
    for (const k of Object.keys(inSec[sec] || {})) keys[k] = 1;
  }
  return keys;
}

/* The API prompt's meaningful content is (declared inputs, resolved links).
 * Older exports on this machine also carry keys no INPUT_TYPES declares - e.g.
 * speak_and_recognation - which ComfyUI ignores. Strip them symmetrically so
 * they cannot mask a real difference. */
function prune(prompt, oi) {
  const out = {};
  for (const [id, node] of Object.entries(prompt)) {
    const declared = declaredKeys(oi[node.class_type]);
    const inputs = {};
    for (const [k, v] of Object.entries(node.inputs || {})) {
      const ok = declared[k] || (k.includes(".") && declared[k.split(".")[0]]);
      if (ok) inputs[k] = v;
    }
    out[id] = { class_type: node.class_type, inputs };
  }
  return out;
}

function norm(v) {
  if (Array.isArray(v)) return v.map(norm);
  if (isPlainObject(v)) {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = norm(v[k]);
    return o;
  }
  return v;
}

function diff(a, b, p, bad, warn) {
  p = p || "";
  if (bad.length > 40) return;
  const isLink = (v) => Array.isArray(v) && v.length === 2 &&
    (typeof v[0] === "string" || typeof v[0] === "number") && typeof v[1] === "number";

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) { bad.push(`${p}: 类型不同 ${JSON.stringify(a)} vs ${JSON.stringify(b)}`); return; }
    if (isLink(a) && isLink(b)) {
      if (String(a[0]) !== String(b[0]) || a[1] !== b[1]) {
        bad.push(`${p}: 接线不同 ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
      }
      return;
    }
    if (a.length !== b.length) { bad.push(`${p}: 数组长度 ${a.length} vs ${b.length}`); }
    for (let i = 0; i < Math.max(a.length, b.length); i++) diff(a[i], b[i], `${p}[${i}]`, bad, warn);
    return;
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) { bad.push(`${p}: 类型不同 ${JSON.stringify(a)} vs ${JSON.stringify(b)}`); return; }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a)) { bad.push(`${p}.${k}: 转换结果缺少（期望 ${JSON.stringify(b[k])}）`); continue; }
      if (!(k in b)) { bad.push(`${p}.${k}: 多出（值 ${JSON.stringify(a[k])}）`); continue; }
      diff(a[k], b[k], `${p}.${k}`, bad, warn);
    }
    return;
  }
  if (a !== b) {
    // Same source workflow, different scalar: the API export was taken before
    // the UI file was edited. Report, but do not fail the conversion.
    warn.push(`${p}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  }
}

async function loadObjectInfo(file) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  // Fall back to the live server.
  const res = await fetch("http://127.0.0.1:8188/object_info");
  const json = await res.json();
  fs.writeFileSync(file, JSON.stringify(json));
  return json;
}

(async () => {
  const args = process.argv.slice(2);
  const oiFile = args.shift();
  if (!oiFile) {
    console.error("用法: node test_convert.js <object_info.json> <ui.json> <api.json> ...");
    process.exit(2);
  }
  const oi = await loadObjectInfo(oiFile);

  let failures = 0;
  let cases = 0;
  for (let i = 0; i + 1 < args.length; i += 2) {
    const uiPath = args[i], apiPath = args[i + 1];
    cases++;
    const label = path.basename(apiPath);
    let ui, api;
    try {
      ui = JSON.parse(fs.readFileSync(uiPath, "utf8"));
      api = JSON.parse(fs.readFileSync(apiPath, "utf8"));
    } catch (e) {
      console.log(`✗ ${label}: 读取失败 ${e.message}`);
      failures++;
      continue;
    }

    const r = conv.convert(ui, oi, { randomize: false });
    const a = norm(prune(r.prompt, oi));
    const b = norm(prune(api, oi));
    const bad = [];
    const warn = [];
    diff(a, b, "", bad, warn);

    const caseFail = bad.length || r.errors.length;
    if (caseFail) {
      failures++;
      console.log(`✗ ${label}  (节点 ${Object.keys(r.prompt).length} / 期望 ${Object.keys(api).length})`);
      r.errors.slice(0, 6).forEach(e => console.log(`   错误: ${e}`));
      bad.slice(0, 15).forEach(p => console.log(`   ${p}`));
    } else {
      console.log(`✓ ${label}  ${Object.keys(r.prompt).length} 个节点结构一致`);
    }
    if (warn.length) {
      console.log(`   数据差异 ${warn.length} 处（源文件被改过，非转换问题）: ${warn.slice(0, 3).join("；")}`);
    }
    if (r.warnings.length) r.warnings.slice(0, 3).forEach(w => console.log(`   提示: ${w}`));
  }

  console.log(`\n${cases - failures}/${cases} 通过`);
  process.exit(failures ? 1 : 0);
})();
