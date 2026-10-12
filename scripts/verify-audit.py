import json
with open(r"E:\NAS\deepseek-studio\docs\审计报告\audit-deepseek-studio-20261012-092939.json", "r", encoding="utf-8") as f:
    data = json.load(f)
print("JSON 验证:")
print("  ok:", data["ok"])
print("  项目:", data["config"]["name"], "v" + data["config"]["version"])
print("  文件数:", data["code"]["total_files"])
print("  代码行:", f"{data['code']['total_lines']:,}")
print("  语言数:", len(data["code"]["by_language"]))
print("  Git可用:", data["git"]["available"])
print("  分支:", data["git"]["branch"])
print("  测试文件:", data["tests"]["test_file_count"])
print("  顶层字段:", list(data.keys()))
print("JSON 结构完整 ✓")
