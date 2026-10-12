# 项目健康度审计报告

**审计时间**: 2026-10-12T09:29:39
**项目目录**: `E:\NAS\deepseek-studio`

## 1. 项目信息

| 项目 | 值 |
|------|-----|
| 名称 | deepseek-studio |
| 版本 | 0.4.0 |
| 包管理 | npm |
| 配置文件 | package.json |
| 依赖数 | 11 |

## 2. 代码统计

- **总文件数**: 1229
- **总行数**: 232,362

| 语言 | 文件数 | 代码行 | 注释行 | 空行 |
|------|--------|--------|--------|------|
| TypeScript | 796 | 137,749 | 3,252 | 14,264 |
| Markdown | 345 | 28,625 | 0 | 9,071 |
| JSON | 24 | 18,321 | 0 | 0 |
| TypeScript-React | 44 | 10,512 | 29 | 725 |
| JavaScript | 3 | 4,981 | 61 | 74 |
| CSS | 3 | 1,985 | 0 | 270 |
| HTML | 5 | 851 | 0 | 66 |
| Python | 3 | 658 | 31 | 140 |
| Rust | 3 | 557 | 44 | 60 |
| TOML | 1 | 23 | 0 | 4 |
| Batch | 1 | 5 | 0 | 0 |
| YAML | 1 | 4 | 0 | 0 |

## 3. Git 状态

- **分支**: `master`
- **最近提交**: 830a26e feat: 新增 dir-scan.py 目录扫描脚本（端到端验证用） (7 minutes ago)
- **提交者**: lidicn
- **总提交数**: 22
- **未提交变更**: 3 个文件
- **远程**: none

**变更文件**:
  - `?? scripts/phase2-verify-output.txt`
  - `?? scripts/project-audit.py`
  - `?? src/inject/pow-wasm-base64.txt`

## 4. 测试覆盖

- **测试目录数**: 2
- **测试文件数**: 275

**测试文件**:
  - `deepseek-pp\src\tests\artifact-indexeddb-compatibility.test.ts`
  - `deepseek-pp\src\tests\artifact.test.ts`
  - `deepseek-pp\src\tests\auto-activation.test.ts`
  - `deepseek-pp\src\tests\automation-delete-terminal.test.ts`
  - `deepseek-pp\src\tests\automation-execution.test.ts`
  - `deepseek-pp\src\tests\automation-lease-restart.test.ts`
  - `deepseek-pp\src\tests\automation-page-storage-errors.test.ts`
  - `deepseek-pp\src\tests\automation-runner-execution.test.ts`
  - `deepseek-pp\src\tests\automation-runner-pow.test.ts`
  - `deepseek-pp\src\tests\automation-schedule-failure.test.ts`
  - `deepseek-pp\src\tests\automation-schedule.test.ts`
  - `deepseek-pp\src\tests\automation-storage-contract.test.ts`
  - `deepseek-pp\src\tests\automation-store-reconcile.test.ts`
  - `deepseek-pp\src\tests\background-automation-wake-alarm.test.ts`
  - `deepseek-pp\src\tests\background-deepseek-auth-refresh.test.ts`
  - `deepseek-pp\src\tests\background-deepseek-runtime-handlers.test.ts`
  - `deepseek-pp\src\tests\background-persistence-handlers.test.ts`
  - `deepseek-pp\src\tests\background-persistence-recovery-integration.test.ts`
  - `deepseek-pp\src\tests\background-runtime-handlers.test.ts`
  - `deepseek-pp\src\tests\background-runtime-message-context.test.ts`
  - `deepseek-pp\src\tests\background-tool-authorization-integration.test.ts`
  - `deepseek-pp\src\tests\background-tool-runtime-handlers.test.ts`
  - `deepseek-pp\src\tests\bridge-schema.test.ts`
  - `deepseek-pp\src\tests\browser-control-codec.test.ts`
  - `deepseek-pp\src\tests\browser-control-page.test.ts`
  - `deepseek-pp\src\tests\browser-control.test.ts`
  - `deepseek-pp\src\tests\bundled-skill-assets.test.ts`
  - `deepseek-pp\src\tests\bundled-skill-compatibility.test.ts`
  - `deepseek-pp\src\tests\bundled-skill-initial-path.test.ts`
  - `deepseek-pp\src\tests\bundled-skill-loader.test.ts`
  - ... 还有 245 个

## 5. 健康度评估

**综合评分**: 70/100

- ✅ 代码量充足（>1000行）
- ❌ 注释率过低（1.6%）
- ✅ 有测试文件（275个）
- ✅ 使用 git 版本控制
- ⚠️ 有 3 个未提交变更
- ✅ 有项目配置文件
