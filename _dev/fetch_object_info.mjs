/* Download the live /object_info into _dev/object_info.json.
 *
 * The converter regression test runs offline against this fixture, so it needs
 * one snapshot from the machine the workflows came from.
 *
 *   node _dev/fetch_object_info.mjs [url]
 */
import fs from "node:fs";
import path from "node:path";
import { BASE, DEV_DIR } from "./paths.mjs";

const url = (process.argv[2] || BASE) + "/object_info";
const out = path.join(DEV_DIR, "object_info.json");

const res = await fetch(url);
if (!res.ok) {
  console.error("HTTP " + res.status + " from " + url);
  process.exit(1);
}
const text = await res.text();
fs.writeFileSync(out, text);
let n = 0;
try { n = Object.keys(JSON.parse(text)).length; } catch (_) {}
console.log("saved " + (text.length / 1024 / 1024).toFixed(2) + " MB, " + n + " node types → " + out);
