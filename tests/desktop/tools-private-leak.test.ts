/**
 * 原文入库守卫（tools/audit/private-leak.ts）单测。
 * 全部用合成样本，不含任何真实会话内容。
 */

import { describe, it, expect } from 'vitest';
import { scanPrivateLeak } from '../../tools/audit/private-leak';

describe('原文入库守卫 · 判红', () => {
  it('R1：JSON 抓包含 "postData": 键 → 红', () => {
    const cap = '{"postData": {"prompt": "任务", "chat_session_id": "abc"}}';
    const f = scanPrivateLeak('docs/验收/_probe/cap.json', cap);
    expect(f).not.toBeNull();
    expect(f!.rules).toContain('R1-postData键');
  });

  it('R2（散文档）：md 含注入哨兵 + prompt 键 → 红', () => {
    const md = '# 取证报告\n【Studio Agent】做任务\n请求体片段："prompt": "用户输入原文"';
    const f = scanPrivateLeak('docs/验收/报告.md', md);
    expect(f).not.toBeNull();
    expect(f!.rules).toContain('R2-注入原文');
  });

  it('R2（非散文档）：txt 含哨兵 + 本机路径 → 红', () => {
    const txt = '【Studio Agent】启动\n技能路径 E:\\NAS\\deepseek-studio\\.agents\\skills\\foo';
    const f = scanPrivateLeak('notes/dump.txt', txt);
    expect(f).not.toBeNull();
    expect(f!.rules).toContain('R2-注入原文');
  });

  it('R3（非散文档）：哨兵 ≥3 且 ≥4KB、无 JSON 键 → 红', () => {
    const txt = `${'x'.repeat(4200)}\n【Studio Agent】a\n【Studio Agent】b\n[studio-tool-capability] c`;
    const f = scanPrivateLeak('dumps/blocks.txt', txt);
    expect(f).not.toBeNull();
    expect(f!.rules).toContain('R3-注入块批量');
  });

  it('R4（非散文档）：session键 + prompt键 + ≥4KB、无哨兵 → 红', () => {
    const body = `{"messages": [{"role": "user", "content": "${'y'.repeat(4200)}"}], "chat_session_id": "s1", "prompt": "p"}`;
    const f = scanPrivateLeak('dumps/body.json', body);
    expect(f).not.toBeNull();
    expect(f!.rules).toContain('R4-请求体原文');
  });
});

describe('原文入库守卫 · 误报防护（负例必须绿）', () => {
  it('散文档散文提及字段名与哨兵（无键形态）→ 不红', () => {
    const md = '审计报告： postData 字段与 chat_session_id 字段是抓包关键键，注入哨兵为【Studio Agent】。';
    expect(scanPrivateLeak('docs/审计报告/某报告.md', md)).toBeNull();
  });

  it('散文档含本机绝对路径（E:\\NAS\\）但无哨兵 → 不红', () => {
    const md = '项目根目录 E:\\NAS\\deepseek-studio，配置见 docs/。';
    expect(scanPrivateLeak('docs/说明.md', md)).toBeNull();
  });

  it('源码文件（.ts/.mjs）整体豁免：即使含全部标记也不扫', () => {
    const code = `const M = '[studio-tool-capability]';\nconst b = {"chat_session_id": "s", "prompt": "${'z'.repeat(4200)}"};`;
    expect(scanPrivateLeak('src/inject/interceptor.ts', code)).toBeNull();
    expect(scanPrivateLeak('docs/验收/_probe/listen.mjs', code)).toBeNull();
  });

  it('干净数据文件 → 不红', () => {
    expect(scanPrivateLeak('package.json', '{"name": "studio", "version": "1.0"}')).toBeNull();
  });

  it('非散文档但只有 1 个哨兵、无键无路径 → 不红', () => {
    expect(scanPrivateLeak('notes/short.txt', '【Studio Agent】')).toBeNull();
  });

  it('散文档哨兵密集但无键形态 → 不红（R3 只对非散文档生效）', () => {
    const md = `# 复盘\n${'【Studio Agent】'.repeat(4)}\n${'内容'.repeat(2100)}`;
    expect(scanPrivateLeak('docs/审计报告/复盘.md', md)).toBeNull();
  });
});
