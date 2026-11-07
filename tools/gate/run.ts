#!/usr/bin/env tsx
/**
 * tools/gate/run.ts — 一键闸门（S5）
 *
 * DCD 裁定 §1.4（20261017）：gate 分两级。
 *
 * 阻塞级（红了必合）：typecheck → vitest → eval-golden → boundary → contract →
 *   coverage → empty-files → doc-drift → e2e-replay。任一步失败立即停止。
 *   20261031 门禁接线：eval-golden（40 条契约 golden）、doc-drift（文档↔代码引用校验，
 *   重写版）、e2e-replay（带断言的离线回放）入闸；CI（.github/workflows/ci.yml）自此
 *   只跑 npm run gate，不再维护平行步骤清单。
 *
 * 信息级（红了照常合，但输出进日志留档）：symbols → m3-clean → security
 *   M3 未完、面板 innerHTML 历史债，这些尺红是真实待办，不是噪音。
 *   失败不 process.exit(1)，输出追加到 logs/gate-info.log。
 *
 * 用法：npm run gate
 */

import { execSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface Step {
  name: string;
  cmd: string;
}

/** 阻塞级：红了必合。 */
const blockingSteps: Step[] = [
  { name: 'typecheck', cmd: 'npx tsc --noEmit' },
  { name: 'vitest', cmd: 'npx vitest run' },
  // 门禁接线（20261031）：40 条契约 golden 入闸（纯函数、离线、确定性 100%）
  { name: 'eval-golden', cmd: 'npx tsx tools/eval/run.ts' },
  { name: 'boundary-audit', cmd: 'npx tsx tools/audit/boundary.ts' },
  { name: 'contract-guard', cmd: 'npx tsx tools/contract/check.ts' },
  { name: 'coverage-check', cmd: 'npx tsx tools/coverage/check.ts' },
  { name: 'empty-files', cmd: 'npx tsx tools/audit/empty-files.ts' },
  // 门禁接线（20261031）：原 CI 独有的两步并入 gate（CI 自此只跑 npm run gate）
  { name: 'doc-drift', cmd: 'npx tsx tools/audit/doc-drift.ts' },
  { name: 'e2e-replay', cmd: 'npx tsx tools/e2e/runner.ts tools/e2e/fixtures/simple-task.json' },
  // UI 展示值真实性门禁（20261105）：发行版 UI 展示的静态值必须为真——
  // 写死开发机路径 / 假版本号 / 不存在目录 / 硬编码默认项目条目 → 阻塞（用户肉眼发现过三次）。
  // 精确字符串清单零误报，见 tools/audit/ui-display-truth.ts 头注释。
  { name: 'ui-display-truth', cmd: 'npx tsx tools/audit/ui-display-truth.ts' },
  // entry.js 新鲜度机械闸（20261105 PM 派卡）：产物落后于源码今天人工发现过三次——
  // 重建到临时文件 → sha256 比对跟踪的 src-tauri/inject/entry.js → 不一致就 exit 1。
  // esbuild 构建确定性（锁版本 + 同参数 → 字节级复现）是前提，已实测为证。
  { name: 'entry-freshness', cmd: 'node tools/audit/entry-freshness.cjs' },
  // 行尾断言（20261106 第三件）：index 侧 i/crlf|i/mixed 判红（读 .gitattributes 豁免 eol=crlf/binary，
  // 不硬编码扩展名）。终结「PowerShell 写文件默认 CRLF → 内容没变却显示 M」的行尾伪影。
  { name: 'lineend-guard', cmd: 'npx tsx tools/audit/lineend-guard.ts' },
  // Rust 侧配置路径硬编码断言（P0 卡 (B) 判据，20261106）：src-tauri/src 里 .join(".config")
  // 只许出现在 resolve_config_dir 函数体（唯一入口）/ 注释 / 单测断言——P1 路径漂移（grant 脚本
  // 硬编码旧路径逃出 env 注入）的回归守卫。先红后绿已证：b147ca5 红 3 处 / HEAD 绿。
  { name: 'rust-path-guard', cmd: 'npx tsx tools/audit/rust-path-guard.ts' },
  // bundle.resources ↔ main.ts 契约一致性（C 卡，20261106）：main.ts 里 resourceRoot 派生的
  // 字面量 join 必须全部出现在 tauri.conf.json bundle.resources——缺条目 = dev 能跑、装版 500
  // （与 P0 竞态同族：两形态路径解析不同）。先红已证：当前树红 3 条（mcp-settings 壳三件）。
  { name: 'resource-contract-guard', cmd: 'npx tsx tools/audit/resource-contract-guard.ts' },
  // generate_handler! ↔ capabilities ACL 一致性（v0.14.8 P0，20261106）：main.rs 注册的每条
  // 命令必须在 capabilities/*.json permissions 里有对应 allow-<kebab>——ACL 只由真实 Tauri
  // runtime 强制，mock-invoke 测试与 cargo test 都不校验。先红：当前树缺 2 条（studio_open_mcp_settings + studio_request_grant）。
  { name: 'acl-contract-guard', cmd: 'npx tsx tools/audit/acl-contract-guard.ts' },
];

/** 信息级：红了照常合，输出进 logs/gate-info.log。 */
const infoSteps: Step[] = [
  { name: 'symbols', cmd: 'npx tsx tools/audit/symbols.ts' },
  { name: 'm3-clean', cmd: 'npx tsx tools/audit/m3-clean.ts' },
  { name: 'security', cmd: 'npx tsx tools/audit/security.ts' },
  // E3：漂移检测此前存在但从未被任何流程调用——它判定「漂移超阈值」的红色结论永不送达。
  // 先以信息级接入（移植文件与上游有意分叉，红是真实待办而非噪音）；待 7 个移植文件
  // 与上游对齐后再升阻塞级。需能读到 E:\NAS\deepseek-pp，缺失时脚本自行 exit 1 不崩闸门。
  { name: 'upstream-drift', cmd: 'node scripts/check-upstream-drift.mjs' },
  // docs 脱敏信息级闸（20261105 PM 裁定）：只报新增/改动 docs 文件的四条口径违规，
  // 历史 190 处审计记录不进红灯（watermark 圈范围）；豁免 github.com/lidicn/…（§19.7 保留项）。
  { name: 'docs-sanitize', cmd: 'npx tsx tools/audit/ui-display-truth.ts --docs' },
  // 原文入库守卫（20261102）：抓包/postData 类会话原文不得进仓库（20261031 net-memsel 事件教训）。
  // 信息级：红了不阻塞，点名文件与规则进 logs/gate-info.log，提交前人工处置（移 logs/** 或脱敏）。
  { name: 'private-leak', cmd: 'npx tsx tools/audit/private-leak.ts' },
];

function main(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = resolve(__dirname, '..', '..');
  const startedAt = Date.now();

  // 每步进度即时落盘（20261106 PM 派卡）：闸跑到一半看不出卡在哪 → 每步完成即追加一行到
  // logs/gate-progress.log（步名 + 结果 + 耗时 + 时刻）。tail 此文件即可定位当前在哪一步。
  const logDir = join(root, 'logs');
  mkdirSync(logDir, { recursive: true });
  const progressFile = join(logDir, 'gate-progress.log');
  const progress = (line: string) => appendFileSync(progressFile, line + '\n', 'utf8');
  progress(`=== gate START @ ${new Date().toISOString()} pid=${process.pid} ===`);

  const stepElapsed = (t0: number) => ((Date.now() - t0) / 1000).toFixed(1);

  // 阻塞级
  for (const step of blockingSteps) {
    console.log(`\n=== [阻塞] ${step.name} ===`);
    const t0 = Date.now();
    try {
      execSync(step.cmd, { cwd: root, stdio: 'inherit' });
      console.log(`✅ [${step.name}] 通过`);
      progress(`[PASS] ${step.name}  ${stepElapsed(t0)}s`);
    } catch {
      console.error(`\n❌ [阻塞] [${step.name}] 失败：请检查上方输出`);
      progress(`[FAIL] ${step.name}  ${stepElapsed(t0)}s  —— 阻塞，闸终止`);
      process.exit(1);
    }
  }

  // 信息级
  const logFile = join(logDir, 'gate-info.log');
  const stamp = new Date().toISOString();
  const infoLines: string[] = [`\n=== gate info @ ${stamp} ===`];

  for (const step of infoSteps) {
    console.log(`\n=== [信息] ${step.name} ===`);
    const t0 = Date.now();
    let out = '';
    try {
      out = execSync(step.cmd, { cwd: root, encoding: 'utf8' });
      console.log(`ℹ️ [${step.name}] 通过`);
      infoLines.push(`[${step.name}] PASS\n${out}`);
      progress(`[PASS] ${step.name}  ${stepElapsed(t0)}s  (信息级)`);
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      out = (err.stdout || '') + (err.stderr || '');
      console.log(`ℹ️ [${step.name}] 红（信息级，不阻塞）：见 logs/gate-info.log`);
      infoLines.push(`[${step.name}] FAIL\n${out}`);
      progress(`[FAIL] ${step.name}  ${stepElapsed(t0)}s  (信息级，不阻塞)`);
    }
  }

  appendFileSync(logFile, infoLines.join('\n'), 'utf8');

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  // 信息级红名单固定一行（PM 20261107：判断 symbols/upstream-drift 等是在收敛还是在漂）
  // 从步头解出名字，不依赖 infoSteps/infoLines 下标配对（防 continue 跳步导致静默错位）
  const infoReds = infoLines.slice(1)
    .map((l) => /^\[([^\]]+)\] FAIL/.exec(l)?.[1])
    .filter((n): n is string => !!n);
  const infoSummary = infoReds.length > 0
    ? `信息级红 ${infoReds.length} 枚：${infoReds.join(' / ')}`
    : '信息级全过';
  console.log(`\n✅ 阻塞级全过（${blockingSteps.length} 步阻塞 + ${infoSteps.length} 步信息，${elapsed}s）`);
  console.log(`📊 ${infoSummary}`);
  progress(`=== gate END @ ${new Date().toISOString()} exit=0 total=${elapsed}s ===  ${infoSummary}`);
  process.exit(0);
}

main();

