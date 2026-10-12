#!/usr/bin/env python3
"""dir-scan.py - 扫描目录下所有 .md 文件，输出统计报告 JSON。

用法:
    python dir-scan.py <目录路径>

输出:
    JSON 格式到 stdout，包含每个 .md 文件的行数、字数、修改时间，以及汇总。
"""
import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path


def scan_md_files(directory: Path) -> list[dict]:
    """扫描目录下所有 .md 文件，返回统计列表。"""
    results = []
    if not directory.exists():
        print(json.dumps({"error": f"目录不存在: {directory}", "ok": False}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
    if not directory.is_dir():
        print(json.dumps({"error": f"不是目录: {directory}", "ok": False}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)

    for root, _dirs, files in os.walk(directory):
        for fname in files:
            if not fname.lower().endswith(".md"):
                continue
            fpath = Path(root) / fname
            try:
                stat = fpath.stat()
                with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
                lines = content.count("\n") + (1 if content and not content.endswith("\n") else 0)
                # 中文字数：按非空白字符计数
                chars = len([c for c in content if not c.isspace()])
                results.append({
                    "path": str(fpath),
                    "name": fname,
                    "lines": lines,
                    "chars": chars,
                    "bytes": stat.st_size,
                    "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
                })
            except PermissionError:
                results.append({
                    "path": str(fpath),
                    "name": fname,
                    "error": "permission-denied",
                })
            except Exception as e:
                results.append({
                    "path": str(fpath),
                    "name": fname,
                    "error": str(e),
                })
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description="扫描目录下 .md 文件并输出统计 JSON")
    parser.add_argument("directory", help="要扫描的目录路径")
    args = parser.parse_args()

    directory = Path(args.directory).resolve()
    files = scan_md_files(directory)

    total_lines = sum(f.get("lines", 0) for f in files)
    total_chars = sum(f.get("chars", 0) for f in files)
    errors = [f for f in files if "error" in f]

    report = {
        "ok": True,
        "directory": str(directory),
        "scanned_at": datetime.now().isoformat(timespec="seconds"),
        "total_files": len(files),
        "total_lines": total_lines,
        "total_chars": total_chars,
        "error_count": len(errors),
        "files": sorted(files, key=lambda f: f.get("chars", 0), reverse=True),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
