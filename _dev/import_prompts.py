#!/usr/bin/env python3
"""把一份提示词 JSON 合并进手机端的词库。

支持两种来源格式，靠字段自动识别，不用转换：

  本项目格式      name / text / group / tags
  Wanvas 导出     title / content / category / tags

合并规则
  - 按 text 精确去重：已有的条目跳过，不会产生重复
  - 新条目放在最前，原有顺序不变
  - rev 自增，写入走临时文件 + os.replace，中途断电不会写坏
  - 改动前自动备份为 prompts.json.bak

用法
  python import_prompts.py <来源.json>            # 合并
  python import_prompts.py <来源.json> --dry-run  # 只看会加什么

路径
  词库固定是 <ComfyUI>/user/default/mobile_ui/prompts.json，
  相对本脚本位置推导，不依赖当前工作目录。
"""
import json
import os
import shutil
import sys
import time
from pathlib import Path


def library_path() -> Path:
    comfy = Path(__file__).resolve().parents[3]      # _dev -> mobile_ui -> custom_nodes -> ComfyUI
    return comfy / "user" / "default" / "mobile_ui" / "prompts.json"


def normalise(entry: dict, seq: int) -> dict:
    """Map either source shape onto the library's fields."""
    name = entry.get("name") or entry.get("title") or ""
    text = entry.get("text") or entry.get("content") or ""
    group = entry.get("group") or entry.get("category") or "未分组"
    tags = entry.get("tags") or []
    return {
        "id": str(entry.get("id") or f"imp-{seq}")[:64],
        "name": str(name)[:120],
        "text": str(text).strip(),
        "group": str(group)[:60],
        "tags": [str(t)[:40] for t in tags][:12],
        "created": int(time.time() * 1000) + seq,
        "used": 0,
    }


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry-run" in sys.argv
    if not args:
        print(__doc__)
        return 2

    src_path = Path(args[0])
    src = json.loads(src_path.read_text(encoding="utf-8"))
    entries = src.get("prompts") or src.get("items") or src
    if not isinstance(entries, list):
        print("来源文件里没有 prompts / items 数组")
        return 2

    dst = library_path()
    lib = {"rev": 0, "items": []}
    if dst.exists():
        lib = json.loads(dst.read_text(encoding="utf-8"))

    seen_text = {str(it.get("text", "")).strip() for it in lib["items"]}
    seen_ids = {it.get("id") for it in lib["items"]}

    added, skipped = [], []
    for i, raw in enumerate(entries):
        item = normalise(raw, i)
        if not item["text"]:
            continue
        if item["text"] in seen_text:
            skipped.append(item["name"])
            continue
        pid = item["id"]
        n = 2
        while pid in seen_ids:
            pid = f"{item['id']}-{n}"
            n += 1
        item["id"] = pid
        seen_ids.add(pid)
        seen_text.add(item["text"])
        added.append(item)

    print(f"来源 {len(entries)} 条 → 新增 {len(added)} 条，跳过重复 {len(skipped)} 条")
    by_group = {}
    for it in added:
        by_group.setdefault(it["group"], []).append(it["name"])
    for g, names in by_group.items():
        print(f"  [{g}] " + " / ".join(names))

    if dry:
        print("\n--dry-run：没有写入")
        return 0

    lib["items"] = added + lib["items"]
    lib["rev"] = int(lib.get("rev", 0)) + 1

    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        shutil.copy2(dst, dst.with_suffix(".json.bak"))
    tmp = dst.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(lib, f, ensure_ascii=False, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, dst)

    print(f"\n已写入 {dst}")
    print(f"词库共 {len(lib['items'])} 条，rev={lib['rev']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
