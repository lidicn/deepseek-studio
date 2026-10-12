#!/usr/bin/env python3
"""project-audit.py - 项目健康度综合审计器。

用法:
    python project-audit.py <项目目录> [--output <输出目录>]

功能:
    1. 读取 package.json / Cargo.toml 提取项目元信息
    2. 扫描源码，按扩展名统计文件数/代码行/注释行
    3. 检查 git 状态（最近提交、分支、未提交变更）
    4. 统计测试文件
    5. 生成 Markdown + JSON 审计报告
"""
import argparse
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

# 代码文件扩展名映射
CODE_EXTENSIONS = {
    ".py": "Python",
    ".ts": "TypeScript",
    ".tsx": "TypeScript-React",
    ".js": "JavaScript",
    ".jsx": "JavaScript-React",
    ".rs": "Rust",
    ".go": "Go",
    ".java": "Java",
    ".cpp": "C++",
    ".c": "C",
    ".h": "C/C++ Header",
    ".md": "Markdown",
    ".json": "JSON",
    ".yaml": "YAML",
    ".yml": "YAML",
    ".toml": "TOML",
    ".sh": "Shell",
    ".bat": "Batch",
    ".css": "CSS",
    ".html": "HTML",
    ".sql": "SQL",
}

# 注释前缀
COMMENT_PREFIXES = {
    ".py": "#",
    ".ts": "//",
    ".tsx": "//",
    ".js": "//",
    ".jsx": "//",
    ".rs": "//",
    ".go": "//",
    ".java": "//",
    ".cpp": "//",
    ".c": "//",
    ".h": "//",
    ".sh": "#",
    ".bat": "REM",
    ".sql": "--",
}

# 忽略目录
IGNORE_DIRS = {".git", "node_modules", "target", "dist", "build", "__pycache__", ".venv", "venv", "out"}


def read_project_config(project_dir: Path) -> dict:
    """读取项目配置文件。"""
    config = {"name": project_dir.name, "version": "unknown", "dependencies": {}}

    # package.json
    pkg_path = project_dir / "package.json"
    if pkg_path.exists():
        try:
            with open(pkg_path, "r", encoding="utf-8") as f:
                pkg = json.load(f)
            config["name"] = pkg.get("name", config["name"])
            config["version"] = pkg.get("version", "unknown")
            config["package_manager"] = "npm"
            deps = {}
            deps.update(pkg.get("dependencies", {}))
            deps.update(pkg.get("devDependencies", {}))
            config["dependencies"] = deps
            config["config_file"] = "package.json"
            return config
        except Exception as e:
            config["config_error"] = str(e)

    # Cargo.toml
    cargo_path = project_dir / "src-tauri" / "Cargo.toml"
    if not cargo_path.exists():
        cargo_path = project_dir / "Cargo.toml"
    if cargo_path.exists():
        try:
            import tomllib
            with open(cargo_path, "rb") as f:
                cargo = tomllib.load(f)
            package = cargo.get("package", {})
            config["name"] = package.get("name", config["name"])
            config["version"] = package.get("version", "unknown")
            config["package_manager"] = "cargo"
            config["dependencies"] = list(cargo.get("dependencies", {}).keys())
            config["config_file"] = str(cargo_path.relative_to(project_dir))
        except Exception as e:
            config["config_error"] = str(e)

    return config


def scan_source_code(project_dir: Path) -> dict:
    """扫描源码目录，统计代码行数。"""
    stats = {}  # ext -> {files, code_lines, comment_lines, blank_lines}
    total_files = 0
    total_lines = 0

    for root, dirs, files in os.walk(project_dir):
        # 过滤忽略目录
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
        rel_root = Path(root).relative_to(project_dir)

        for fname in files:
            fpath = Path(root) / fname
            ext = fpath.suffix.lower()
            if ext not in CODE_EXTENSIONS:
                continue

            try:
                with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                    lines = f.readlines()
            except Exception:
                continue

            if ext not in stats:
                stats[ext] = {"files": 0, "code_lines": 0, "comment_lines": 0, "blank_lines": 0}

            stats[ext]["files"] += 1
            total_files += 1

            comment_prefix = COMMENT_PREFIXES.get(ext, "")
            for line in lines:
                stripped = line.strip()
                if not stripped:
                    stats[ext]["blank_lines"] += 1
                elif comment_prefix and stripped.startswith(comment_prefix):
                    stats[ext]["comment_lines"] += 1
                else:
                    stats[ext]["code_lines"] += 1
                total_lines += 1

    # 转换为语言名
    by_language = {}
    for ext, s in stats.items():
        lang = CODE_EXTENSIONS.get(ext, ext)
        by_language[lang] = s

    return {
        "total_files": total_files,
        "total_lines": total_lines,
        "by_language": by_language,
    }


def check_git_status(project_dir: Path) -> dict:
    """检查 git 状态。"""
    result = {"available": False}
    git_dir = project_dir / ".git"
    if not git_dir.exists():
        return result

    result["available"] = True

    def run_git(args):
        try:
            r = subprocess.run(
                ["git"] + args,
                cwd=str(project_dir),
                capture_output=True,
                text=True,
                timeout=10,
            )
            return r.stdout.strip()
        except Exception:
            return ""

    result["branch"] = run_git(["rev-parse", "--abbrev-ref", "HEAD"])
    result["last_commit"] = run_git(["log", "-1", "--format=%h %s (%ar)"])
    result["last_commit_author"] = run_git(["log", "-1", "--format=%an"])
    result["last_commit_date"] = run_git(["log", "-1", "--format=%ai"])
    result["total_commits"] = run_git(["rev-list", "--count", "HEAD"])

    # 未提交变更
    status = run_git(["status", "--porcelain"])
    changed = [line for line in status.split("\n") if line.strip()]
    result["uncommitted_changes"] = len(changed)
    result["changed_files"] = changed[:20]  # 最多显示20个

    # 远程
    result["remote"] = run_git(["remote", "-v"]).split("\n")[0] if run_git(["remote", "-v"]) else "none"

    return result


def count_tests(project_dir: Path) -> dict:
    """统计测试文件。"""
    test_files = []
    test_dirs = []

    for root, dirs, files in os.walk(project_dir):
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
        rel_root = Path(root).relative_to(project_dir)

        # 测试目录
        dir_name = Path(root).name.lower()
        if dir_name in {"tests", "test", "__tests__", "spec"}:
            test_dirs.append(str(rel_root))

        for fname in files:
            lower = fname.lower()
            if (lower.startswith("test_") or lower.endswith("_test.py") or
                    lower.endswith(".test.ts") or lower.endswith(".test.js") or
                    lower.endswith(".spec.ts") or lower.endswith(".spec.js") or
                    lower.endswith("_test.go")):
                test_files.append(str(rel_root / fname))

    return {
        "test_directories": test_dirs,
        "test_files": test_files,
        "test_file_count": len(test_files),
        "test_dir_count": len(test_dirs),
    }


def generate_markdown_report(audit: dict, output_path: Path) -> None:
    """生成 Markdown 报告。"""
    lines = []
    lines.append(f"# 项目健康度审计报告")
    lines.append("")
    lines.append(f"**审计时间**: {audit['audit_time']}")
    lines.append(f"**项目目录**: `{audit['project_dir']}`")
    lines.append("")

    # 项目信息
    lines.append("## 1. 项目信息")
    lines.append("")
    lines.append(f"| 项目 | 值 |")
    lines.append(f"|------|-----|")
    lines.append(f"| 名称 | {audit['config']['name']} |")
    lines.append(f"| 版本 | {audit['config']['version']} |")
    lines.append(f"| 包管理 | {audit['config'].get('package_manager', 'unknown')} |")
    lines.append(f"| 配置文件 | {audit['config'].get('config_file', 'none')} |")
    lines.append(f"| 依赖数 | {len(audit['config'].get('dependencies', {}))} |")
    lines.append("")

    # 代码统计
    lines.append("## 2. 代码统计")
    lines.append("")
    lines.append(f"- **总文件数**: {audit['code']['total_files']}")
    lines.append(f"- **总行数**: {audit['code']['total_lines']:,}")
    lines.append("")
    lines.append("| 语言 | 文件数 | 代码行 | 注释行 | 空行 |")
    lines.append("|------|--------|--------|--------|------|")
    for lang, s in sorted(audit["code"]["by_language"].items(), key=lambda x: -x[1]["code_lines"]):
        lines.append(f"| {lang} | {s['files']} | {s['code_lines']:,} | {s['comment_lines']:,} | {s['blank_lines']:,} |")
    lines.append("")

    # Git 状态
    lines.append("## 3. Git 状态")
    lines.append("")
    git = audit["git"]
    if git["available"]:
        lines.append(f"- **分支**: `{git['branch']}`")
        lines.append(f"- **最近提交**: {git['last_commit']}")
        lines.append(f"- **提交者**: {git['last_commit_author']}")
        lines.append(f"- **总提交数**: {git['total_commits']}")
        lines.append(f"- **未提交变更**: {git['uncommitted_changes']} 个文件")
        lines.append(f"- **远程**: {git['remote']}")
        if git["changed_files"]:
            lines.append("")
            lines.append("**变更文件**:")
            for f in git["changed_files"]:
                lines.append(f"  - `{f}`")
    else:
        lines.append("- 非 git 仓库")
    lines.append("")

    # 测试覆盖
    lines.append("## 4. 测试覆盖")
    lines.append("")
    tests = audit["tests"]
    lines.append(f"- **测试目录数**: {tests['test_dir_count']}")
    lines.append(f"- **测试文件数**: {tests['test_file_count']}")
    if tests["test_files"]:
        lines.append("")
        lines.append("**测试文件**:")
        for f in tests["test_files"][:30]:
            lines.append(f"  - `{f}`")
        if len(tests["test_files"]) > 30:
            lines.append(f"  - ... 还有 {len(tests['test_files']) - 30} 个")
    lines.append("")

    # 健康度评分
    lines.append("## 5. 健康度评估")
    lines.append("")
    score = 0
    feedback = []

    # 代码量
    if audit["code"]["total_lines"] > 1000:
        score += 20
        feedback.append("✅ 代码量充足（>1000行）")
    elif audit["code"]["total_lines"] > 100:
        score += 10
        feedback.append("⚠️ 代码量一般（100-1000行）")
    else:
        feedback.append("❌ 代码量过少（<100行）")

    # 注释率
    total_code = sum(s["code_lines"] for s in audit["code"]["by_language"].values())
    total_comment = sum(s["comment_lines"] for s in audit["code"]["by_language"].values())
    if total_code > 0:
        comment_ratio = total_comment / (total_code + total_comment) * 100
        if comment_ratio > 10:
            score += 20
            feedback.append(f"✅ 注释率良好（{comment_ratio:.1f}%）")
        elif comment_ratio > 5:
            score += 10
            feedback.append(f"⚠️ 注释率一般（{comment_ratio:.1f}%）")
        else:
            feedback.append(f"❌ 注释率过低（{comment_ratio:.1f}%）")

    # 测试
    if tests["test_file_count"] > 0:
        score += 20
        feedback.append(f"✅ 有测试文件（{tests['test_file_count']}个）")
    else:
        feedback.append("❌ 无测试文件")

    # Git
    if git["available"]:
        score += 20
        feedback.append("✅ 使用 git 版本控制")
        if git["uncommitted_changes"] == 0:
            score += 10
            feedback.append("✅ 工作区干净")
        else:
            feedback.append(f"⚠️ 有 {git['uncommitted_changes']} 个未提交变更")
    else:
        feedback.append("❌ 非 git 仓库")

    # 配置
    if audit["config"].get("config_file"):
        score += 10
        feedback.append("✅ 有项目配置文件")
    else:
        feedback.append("❌ 未找到配置文件")

    lines.append(f"**综合评分**: {score}/100")
    lines.append("")
    for fb in feedback:
        lines.append(f"- {fb}")
    lines.append("")

    output_path.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="项目健康度综合审计器")
    parser.add_argument("project_dir", help="要审计的项目目录")
    parser.add_argument("--output", default=".", help="报告输出目录（默认当前目录）")
    args = parser.parse_args()

    project_dir = Path(args.project_dir).resolve()
    if not project_dir.exists():
        print(json.dumps({"error": f"项目目录不存在: {project_dir}", "ok": False}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)

    output_dir = Path(args.output).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"[*] 开始审计: {project_dir}", file=sys.stderr)

    # 1. 读取配置
    print("[*] 读取项目配置...", file=sys.stderr)
    config = read_project_config(project_dir)

    # 2. 扫描代码
    print("[*] 扫描源码...", file=sys.stderr)
    code = scan_source_code(project_dir)

    # 3. Git 状态
    print("[*] 检查 git 状态...", file=sys.stderr)
    git = check_git_status(project_dir)

    # 4. 测试统计
    print("[*] 统计测试文件...", file=sys.stderr)
    tests = count_tests(project_dir)

    # 汇总
    audit = {
        "ok": True,
        "audit_time": datetime.now().isoformat(timespec="seconds"),
        "project_dir": str(project_dir),
        "config": config,
        "code": code,
        "git": git,
        "tests": tests,
    }

    # 写 JSON
    json_path = output_dir / f"audit-{project_dir.name}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    json_path.write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[+] JSON 报告: {json_path}", file=sys.stderr)

    # 写 Markdown
    md_path = output_dir / f"audit-{project_dir.name}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.md"
    generate_markdown_report(audit, md_path)
    print(f"[+] Markdown 报告: {md_path}", file=sys.stderr)

    print(f"[+] 审计完成: {code['total_files']} 个文件, {code['total_lines']:,} 行代码", file=sys.stderr)
    print(json.dumps({"ok": True, "json_report": str(json_path), "md_report": str(md_path)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
