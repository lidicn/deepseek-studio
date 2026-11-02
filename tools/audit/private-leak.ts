#!/usr/bin/env tsx
/**
 * tools/audit/private-leak.ts — 原文入库守卫（信息级）
 *
 * 背景（20261031 net-memsel 事件）：docs/验收/_probe/ 下的抓包 JSON（含完整 chat
 * completion postData、记忆注入块全文=用户会话原文）险些进仓库，靠人工复查拦下。
 * 本守卫在 gate 里对 git 可见文件（已跟踪 + 未忽略 untracked）的数据类文件做静态
 * 标记扫描，命中「抓包/注入原文形态」即点名，红了信息级不阻塞，留档 logs/gate-info.log。
 *
 * 判据（Studio-PM 20261102 批准）：
 *   字段键形态："postData": / "chat_session_id": / "prompt":   （JSON 键带冒号，散文提及不算）
 *   注入标记：  【Studio Agent】 / [studio-tool-capability(-end)]
 *   路径型：    .agents\skills（注入块携带的技能路径）；E:\NAS\ 仅非散文档计红
 *              （docs 正文合法大量含本机绝对路径，散文提及不判）
 *
 * 代码文件（.ts/.js/.mjs/.rs 等）整体豁免：源码合法引用这些标识符
 * （src+tests 实测 80+ 处，如 main-world-interceptor.ts:743、agent-loop.ts:20）；
 * 抓包原文的真实载体是数据文件（json/har/md/txt 等），与 20261031 事件形态一致。
 *
 * 只输出文件路径、规则 id 与形态计数，绝不输出命中内容本身（避免原文二次落日志）。
 *
 * 用法：npx tsx tools/audit/private-leak.ts
 * 退出码：0=未命中  1=有疑似原文（信息级，gate 不阻塞）
 */

import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- 类型

export interface LeakFinding {
  file: string;
  rules: string[];
  evidence: string; // 只描述形态与计数，不含原文
}

// ---------------------------------------------------------------- 标记与判据

/** 字段键形态：JSON 键带冒号才算（散文里写 `postData 字段` 不算） */
const KEY_POSTDATA = /"postData"\s*:/;
const KEY_SESSION = /"chat_session_id"\s*:/;
const KEY_PROMPT = /"prompt"\s*:/;

/** 注入标记：记忆/能力前导块的哨兵 */
const SENTINEL_AGENT = /【Studio Agent】/g;
const SENTINEL_CAP = /\[studio-tool-capability(?:-end)?\]/g;

/** 路径型：注入块携带的技能路径（散文档也计）；本机绝对路径（仅非散文档计） */
const PATH_SKILLS = /\.agents[\\/]skills/i;
const PATH_LOCAL = /E:\\NAS\\/i;

/** 散文档：正文合法大量引用字段名与本机路径，判据收窄 */
const PROSE_EXT = new Set(['.md', '.markdown']);

/** 扫描的数据类扩展名；不在表内的（源码/图片/锁文件等）一律豁免 */
const SCAN_EXT = new Set([
  '.json', '.jsonl', '.ndjson', '.har', '.txt', '.log', '.csv', '.tsv',
  '.xml', '.yaml', '.yml', '.html', '.htm', '.md', '.markdown',
]);

const MAX_BYTES = 4 * 1024 * 1024; // 超大文件跳过（防 OOM），留档跳过数

// ---------------------------------------------------------------- 纯函数判定

export function scanPrivateLeak(relPath: string, content: string): LeakFinding | null {
  const ext = extname(relPath).toLowerCase();
  if (!SCAN_EXT.has(ext)) return null;
  const prose = PROSE_EXT.has(ext);
  const size = Buffer.byteLength(content, 'utf8');

  const agentHits = content.match(SENTINEL_AGENT)?.length ?? 0;
  const capHits = content.match(SENTINEL_CAP)?.length ?? 0;
  const sentinel = agentHits + capHits;
  const hasPostData = KEY_POSTDATA.test(content);
  const hasSessionKey = KEY_SESSION.test(content);
  const hasPromptKey = KEY_PROMPT.test(content);
  const hasSkillsPath = PATH_SKILLS.test(content);
  const hasLocalPath = PATH_LOCAL.test(content);
  const fieldKey = hasPostData || hasSessionKey || hasPromptKey;

  const rules: string[] = [];
  const evidence: string[] = [];

  // R1：postData 抓包封装键（CDP/HAR 抓包形态，任何数据文件命中即点名）
  if (hasPostData) {
    rules.push('R1-postData键');
    evidence.push('"postData": 抓包封装键');
  }
  // R2：注入原文（哨兵 + 任一字段键/技能路径；散文档不含本机路径判据）
  const pathHit = hasSkillsPath || (!prose && hasLocalPath);
  if (sentinel >= 1 && (fieldKey || pathHit)) {
    rules.push('R2-注入原文');
    evidence.push(
      `注入标记×${sentinel} + ${[
        hasPostData && 'postData键',
        hasSessionKey && 'session键',
        hasPromptKey && 'prompt键',
        hasSkillsPath && '.agents/skills路径',
        !prose && hasLocalPath && '本机路径',
      ]
        .filter(Boolean)
        .join('+')}`,
    );
  }
  // R3：注入块批量（非散文档：哨兵密集出现且体积可观，即使无 JSON 键）
  if (!prose && sentinel >= 3 && size >= 4096) {
    rules.push('R3-注入块批量');
    evidence.push(`注入标记×${sentinel}（≥3）且 ≥4KB`);
  }
  // R4：无哨兵的请求体原文（会话键 + prompt 键 + 体积；仅非散文档，md 引用键形态不判）
  if (!prose && hasSessionKey && hasPromptKey && size >= 4096) {
    rules.push('R4-请求体原文');
    evidence.push('"chat_session_id":+"prompt": 键且 ≥4KB');
  }

  if (rules.length === 0) return null;
  return { file: relPath, rules, evidence: evidence.join('；') };
}

// ---------------------------------------------------------------- CLI

function main(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = resolve(__dirname, '..', '..');

  // git 可见 = 已跟踪 + 未忽略的未跟踪（抓包原文正是以后者形态险些入库）
  let out: string;
  try {
    out = execSync('git ls-files -co --exclude-standard', { cwd: root, encoding: 'utf8' });
  } catch {
    console.error('[private-leak] 无法枚举 git 文件（不在 git 仓内？），守卫跳过');
    process.exit(0);
  }

  const files = out.split(/\r?\n/).filter(Boolean);
  const findings: LeakFinding[] = [];
  let scanned = 0;
  let skipped = 0;

  for (const rel of files) {
    if (!SCAN_EXT.has(extname(rel).toLowerCase())) continue;
    const p = join(root, rel);
    try {
      if (statSync(p).size > MAX_BYTES) {
        skipped++;
        continue;
      }
      const f = scanPrivateLeak(rel, readFileSync(p, 'utf8'));
      if (f) findings.push(f);
      scanned++;
    } catch {
      // 并发删除等竞态：跳过该文件
    }
  }

  if (findings.length > 0) {
    console.error('=== 原文入库守卫：疑似会话原文/抓包 ===');
    for (const f of findings) {
      console.error(`  [${f.rules.join(',')}] ${f.file} — ${f.evidence}`);
    }
    console.error(
      `共 ${findings.length} 个文件疑似原文。处置：移出仓库到 logs/**（gitignored）或脱敏后再入库；信息级不阻塞。`,
    );
    if (skipped > 0) console.error(`（另有 ${skipped} 个 >4MB 文件跳过未扫）`);
    process.exit(1);
  }

  console.log(`原文入库守卫：通过（扫描 ${scanned} 个数据类文件，0 命中）`);
  process.exit(0);
}

// 仅直接执行时跑 main
const isDirectRun = typeof process.argv[1] === 'string' && process.argv[1].endsWith('private-leak.ts');
if (isDirectRun) {
  main();
}
