/* Offline health-check for every workflow in a folder.
 *
 * Evaluates what ComfyUI checks at queue time, without queueing anything:
 *   - every node type exists in /object_info
 *   - every required socket is wired or carries a widget value
 *   - every file-backed combo value is in its option list
 *
 *   node _dev/scan_workflows.js [workflowDir] [objectInfoPath]
 *
 * Uses _dev/object_info.json when present (offline, reproducible), otherwise
 * fetches it from the live server.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { BASE, WORKFLOW_DIR, FIXTURE } from "./paths.mjs";

const require = createRequire(import.meta.url);
const conv = require("../web/conv.js");

const dir = process.argv[2] || WORKFLOW_DIR;
const fixturePath = process.argv[3] || FIXTURE;

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.toLowerCase().endsWith(".json")) out.push(p);
  }
  return out;
}

async function loadObjectInfo() {
  if (fs.existsSync(fixturePath)) {
    console.log("节点表: " + fixturePath + "（离线）");
    return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  }
  console.log("节点表: " + BASE + "/object_info（在线）");
  const res = await fetch(BASE + "/object_info");
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

if (!fs.existsSync(dir)) {
  console.error("工作流目录不存在: " + dir);
  process.exit(2);
}

const oi = await loadObjectInfo();
const files = walk(dir);
let bad = 0;

for (const f of files) {
  const rel = path.relative(dir, f);
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    console.log("PARSE  " + rel + "  " + e.message);
    bad++;
    continue;
  }
  if (!doc || !Array.isArray(doc.nodes) || !doc.nodes.length) continue;

  let result;
  try {
    result = conv.convert(doc, oi, { randomize: false });
  } catch (e) {
    console.log("THROW  " + rel + "  " + e.message);
    bad++;
    continue;
  }

  const problems = (result.errors || []).slice();
  for (const [id, n] of Object.entries(result.prompt || {})) {
    if (!oi[n.class_type]) problems.push("未知节点类型 " + n.class_type + " (#" + id + ")");
  }

  if (problems.length) {
    bad++;
    console.log("FAIL   " + rel + "  (" + doc.nodes.length + " 节点)");
    [...new Set(problems)].slice(0, 8).forEach((p) => console.log("         " + p));
  } else {
    console.log("ok     " + rel + "  (" + doc.nodes.length + " 节点 → " +
      Object.keys(result.prompt || {}).length + " 个 API 节点)");
  }
}

console.log("\n" + (bad ? bad + " 个文件有问题" : "全部通过") + " / 共 " + files.length + " 个文件");
process.exit(bad ? 1 : 0);
