/**
 * UI 展示值真实性门禁（tools/audit/ui-display-truth.ts）单测：
 * 注入式破坏对照——把今天用户肉眼发现的三行假数据塞回去必须红；合法文案必须放行。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFile, scanDocsForNewLeaks, FORBIDDEN_PATTERNS, RE_HARDCODED_PROJECT_ENTRY } from '../../tools/audit/ui-display-truth';

const ROOT = '/fake/repo';

describe('ui-display-truth · 注入式破坏（今天的三行塞回去必须红）', () => {
  it('假版本号 v1.0.0 → 红', () => {
    const v = checkFile('src/ui/studio-settings-panel.ts', "text: '版本 v1.0.0'", ROOT);
    expect(v.some((x) => x.pattern === 'v1.0.0')).toBe(true);
  });

  it('写死日志路径 E:\\NAS\\deepseek-studio\\tauri-real.log → 红', () => {
    // 源码字面量里是双反斜杠（E:\\NAS），命中双写形态的禁止字符串
    const v = checkFile('src/ui/studio-settings-panel.ts', "text: 'E:\\\\NAS\\\\deepseek-studio\\\\tauri-real.log'", ROOT);
    expect(v.some((x) => x.pattern === 'E:\\\\NAS')).toBe(true); // 双写形态
    expect(v.some((x) => x.pattern === 'tauri-real.log')).toBe(true);
  });

  it('写死归档位置 archive/legacy → 红', () => {
    const v = checkFile('src/ui/studio-settings-panel.ts', "text: '归档位置：archive/legacy/'", ROOT);
    expect(v.some((x) => x.pattern === 'archive/legacy')).toBe(true);
  });

  it('本机用户名 lidicn → 红', () => {
    const v = checkFile('src/ui/anything.ts', "const p = 'C:/Users/lidicn/.config';", ROOT);
    expect(v.some((x) => x.pattern === 'lidicn')).toBe(true);
    expect(v.some((x) => x.pattern === 'C:/Users')).toBe(true);
  });

  it('结构判据：写死的默认项目条目（path: 盘符路径字面量）→ 红', () => {
    const v = checkFile('src/ui/studio-project-picker.ts', "{ id: 'x', path: 'D:\\\\other\\\\tree' }", ROOT);
    expect(v.some((x) => x.pattern === 'hardcoded-project-entry')).toBe(true);
  });
});

describe('ui-display-truth · 放行侧（合法文案零误伤）', () => {
  it('运行时版本注入 + 真实目录表述 + 端口 → 绿', () => {
    const content = [
      "data-settings-version></span> // runtimeAppVersion 读 __STUDIO_APP_VERSION__",
      "text: '运行时数据目录：~/.config/deepseek-studio/'",
      "text: '宿主端口 8760'",
    ].join('\n');
    expect(checkFile('src/ui/studio-settings-panel.ts', content, ROOT)).toHaveLength(0);
  });

  it('注释里的禁止字符串不命中（stripComments 先剥）', () => {
    // 用真正的块注释包裹——裸 `*` 行不在 /* */ 内，stripComments 不剥
    const content = [
      '/* 此前写死的 E:\\\\NAS\\\\deepseek-studio\\\\tauri-real.log 已删',
      ' * 原值 v1.0.0 是假的',
      ' * archive/legacy 也不该出现 */',
      "const real = 'fine';",
    ].join('\n');
    expect(checkFile('src/ui/studio-settings-panel.ts', content, ROOT)).toHaveLength(0);
  });

  it('placeholder 示例用中性路径（不含盘符/用户名）→ 绿', () => {
    const content = "attrs: { placeholder: '工作区根目录路径，如 /path/to/project' }";
    expect(checkFile('src/ui/studio-settings-panel.ts', content, ROOT)).toHaveLength(0);
  });

  it('inject 侧正则注释里的 E:/NAS 示例不命中（注释剥离覆盖 src/inject）', () => {
    // 用 JSDoc 块注释包裹（与真实源码形态一致）
    const content = [
      '/**',
      ' * 这样 E:/NAS/deepseek-pp、模型却自行读取别的 SKILL.md。',
      ' */',
      "const real = 'fine';",
    ].join('\n');
    expect(checkFile('src/inject/main-world-interceptor.ts', content, ROOT)).toHaveLength(0);
  });
});

describe('ui-display-truth · 清单完整性', () => {
  it('FORBIDDEN_PATTERNS 覆盖今天三行 + 用户名 + 结构判据存在', () => {
    for (const p of ['lidicn', 'E:\\\\NAS', 'E:/NAS', 'C:\\\\Users', 'C:/Users', 'tauri-real.log', 'archive/legacy', 'v1.0.0']) {
      expect(FORBIDDEN_PATTERNS).toContain(p.replace('\\\\', '\\'));
    }
    expect(RE_HARDCODED_PROJECT_ENTRY.test("path: 'D:\\\\tree'")).toBe(true);
    expect(RE_HARDCODED_PROJECT_ENTRY.test("path: runtimeValue")).toBe(false); // 运行时值不命中
    expect(RE_HARDCODED_PROJECT_ENTRY.test("placeholder: '如 /path/to/x'")).toBe(false); // 中性示例不命中
  });
});

// ── docs 负控固化（PM 20261105：塞中文路径必红 / 还原转绿 / git 编码回归断言）──────────
// 用真实临时 git 仓验证 scanDocsForNewLeaks 的 -z 编码 / watermark / 范围圈定，
// 不污染主仓。中文路径是关键：若 -z 被去掉 → git 输出八进制转义 → join(root, escaped)
// 必然 ENOENT → 文件不被扫到 → 测试红（git 编码回归断言）。

let tmpRepo: string;

beforeAll(() => {
  tmpRepo = mkdtempSync(join(tmpdir(), 'docs-gate-test-'));
  const opts = { cwd: tmpRepo, encoding: 'utf8' } as const;
  // 初始化 git 仓 + 提交一条已知干净的 docs 文件
  execSync('git init', opts);
  execSync('git config user.email test@test', opts);
  execSync('git config user.name test', opts);
  mkdirSync(join(tmpRepo, 'docs', '验收'), { recursive: true });
  writeFileSync(join(tmpRepo, 'docs', '验收', '已有-干净文件.md'), '# 干净文档\n无本机路径。\n', 'utf8');
  execSync('git add -A', opts);
  execSync('git commit -m "init: clean baseline"', opts);
});

afterAll(() => {
  if (tmpRepo) rmSync(tmpRepo, { recursive: true, force: true });
});

describe('docs 负控固化（中文路径 + -z 编码回归）', () => {
  it('① 中文路径文件含 E:\\NAS → scanDocsForNewLeaks 必须报红（-z 编码回归断言）', () => {
    // 塞：中文路径 + 真路径内容
    writeFileSync(
      join(tmpRepo, 'docs', '验收', '负控-塞入-中文路径.md'),
      '# 负控\n审计对象 E:\\NAS\\deepseek-studio 的日志路径。\n',
      'utf8',
    );
    const findings = scanDocsForNewLeaks(tmpRepo);
    const hit = findings.find((f) => f.file.includes('负控-塞入-中文路径'));
    expect(hit).toBeDefined();
    expect(hit!.suggestion).toBe('<repo-root>');
    // 还原
    rmSync(join(tmpRepo, 'docs', '验收', '负控-塞入-中文路径.md'));
  });

  it('② 还原后 → 零命中（转绿）', () => {
    const findings = scanDocsForNewLeaks(tmpRepo);
    const hits = findings.filter((f) => f.file.includes('负控'));
    expect(hits).toHaveLength(0);
  });

  it('③ 已提交的干净文件不重复报（watermark 圈定有效）', () => {
    // 已有-干净文件.md 在 beforeAll 里已提交、无本机路径 → 不应出现在结果里
    const findings = scanDocsForNewLeaks(tmpRepo);
    const hits = findings.filter((f) => f.file.includes('已有-干净文件'));
    expect(hits).toHaveLength(0);
  });

  it('④ 未跟踪新文件也被捞到（ls-files --others 通路上 -z 编码不断）', () => {
    writeFileSync(
      join(tmpRepo, 'docs', '验收', '负控-未跟踪-中文.md'),
      '上游仓根 E:/NAS/deepseek-pp 的对照记录。\n',
      'utf8',
    );
    const findings = scanDocsForNewLeaks(tmpRepo);
    const hit = findings.find((f) => f.file.includes('负控-未跟踪-中文'));
    expect(hit).toBeDefined();
    expect(hit!.suggestion).toBe('<upstream-repo>');
    rmSync(join(tmpRepo, 'docs', '验收', '负控-未跟踪-中文.md'));
  });

  it('⑤ git 编码回归断言：-z 模式下中文文件名不被八进制转义', () => {
    // ① 造中文路径文件（内容含 E:\NAS 触发规则匹配）
    writeFileSync(
      join(tmpRepo, 'docs', '验收', '编码回归-中文.md'),
      '审计对象 E:\\NAS\\deepseek-studio。\n',
      'utf8',
    );
    // ② intent-to-add：让未跟踪文件出现在 git diff 输出（PM 修法）
    execSync('git add -N -- docs/', { cwd: tmpRepo });
    // ③ 断言：-z 输出含中文真名、不含八进制转义
    const out = execSync('git diff -z --name-only -- docs/', { cwd: tmpRepo, encoding: 'utf8' }).split('\0').filter(Boolean);
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((f) => f.includes('编码回归-中文'))).toBe(true);
    for (const f of out) {
      expect(f).not.toMatch(/\\\d{3}/);
    }
    // ④ 清理：reset（撤 index 里的 intent-to-add 条目，用具体文件路径避免目录折叠）+ 删文件
    execSync('git reset -- "docs/验收/编码回归-中文.md"', { cwd: tmpRepo });
    rmSync(join(tmpRepo, 'docs', '验收', '编码回归-中文.md'), { force: true });
  });
});
