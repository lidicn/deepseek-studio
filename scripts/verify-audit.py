import json
import os
import sys

# ⑦（20261115 PM 派卡）：路径可覆盖——**CLI 第 1 参数 ＞ env VERIFY_AUDIT_PATH ＞ 默认**
# （⑦-补 统一口径：argv > env，与本仓 bom-drift 的 ⑥-补5 定论一致）。
# 默认射程与历史逐字不变（改默认＝改用法，不算修）。
AUDIT_PATH = (
    (sys.argv[1] if len(sys.argv) > 1 else None)
    or os.environ.get("VERIFY_AUDIT_PATH")
    or r"E:\NAS\deepseek-studio\docs\审计报告\audit-deepseek-studio-20261012-092939.json"
)
with open(AUDIT_PATH, "r", encoding="utf-8") as f:
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
