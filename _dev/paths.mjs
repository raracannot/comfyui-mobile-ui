/* Where the test harness looks for things.
 *
 * Everything is overridable by environment variable and every default is derived
 * from this file's own location, so a fresh clone works on any machine with no
 * editing:
 *
 *   MUI_BASE       base URL of the running ComfyUI      default http://127.0.0.1:8188
 *   COMFYUI_DIR    ComfyUI root                         default ../../../ from here
 *   MUI_WORKFLOWS  folder holding workflow .json files  default <COMFYUI_DIR>/user/default/workflows
 *   MUI_SHOTS      where screenshots are written        default ./shots beside this file
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEV_DIR = path.dirname(fileURLToPath(import.meta.url));

/** custom_nodes/mobile_ui/_dev → the ComfyUI root three levels up. */
export const COMFY_DIR = process.env.COMFYUI_DIR || path.resolve(DEV_DIR, "..", "..", "..");

export const BASE = process.env.MUI_BASE || "http://127.0.0.1:8188";

export const WORKFLOW_DIR = process.env.MUI_WORKFLOWS ||
  path.join(COMFY_DIR, "user", "default", "workflows");

export const INPUT_DIR = path.join(COMFY_DIR, "input");
export const OUTPUT_DIR = path.join(COMFY_DIR, "output");

export const SHOT_DIR = process.env.MUI_SHOTS || path.join(DEV_DIR, "shots");

/** object_info fixture used by the offline converter test; regenerate with
 *  `node _dev/fetch_object_info.mjs` (or curl /object_info). */
export const FIXTURE = path.join(DEV_DIR, "object_info.json");

export function ensureShotDir() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  return SHOT_DIR;
}
