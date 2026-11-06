/**
 * tests/desktop/config-write-guard.test.ts
 *
 * **静态守卫**（PM 裁定二十四 ③ / 三十三 三）：`config.json` 的写入必须经过
 * 原子写 helper；**第三处裸写必须被机器拦住**。
 *
 * 为什么要这条：批 1 只做「原子化」、不做「合并 writer」（PM 裁定二十四 ③ 采纳），
 * 于是 `config.json` 有两处写法（`src/api/config-loader.ts` / `src/host/workspace.ts`）。
 * 两套写法并存就是漂移源——但合并会动 `workspace.ts` 的测试注入接口，所以先不动；
 * **代价是必须有一条断言保证「不会有第三处裸写出现」**。这正是本仓门禁策略：
 * 针对具体缺陷的回归用例，不做通用 lint。
 *
 * 判定口径（**按调用放行，不按文件放行**）：
 *   命中 `writeFileSync(`，且其**同处**（前后文窗口）出现 `config.json` 字面量或
 *   `cfgPath` / `configPath` 这类配置路径标识符，而该窗口内**没有** helper 引用
 *   （`writeFileAtomic`），即判红。
 *
 * 这样 `config-loader` 自己哪天退回裸写也照样被抓——按文件白名单则会放行未来。
 *
 * **局限（明确写死，别假装完备）**：文本级启发式，抓不到 `writeFileSync` 的别名、
 * 动态属性访问、或把路径拼进另一个模块再传入的间接写入。它拦的是「同一处直接裸写」
 * 这个已经出现过两次的具体形状，不是通用规则。
 *
 * **已知洞（PM 裁定三十七 ①，2026-11-06 —— 明写以免被当成完备）**：
 * `ATOMIC_HINTS` 含 `'renameSync('`，判定窗口是 `writeFileSync(` 前后各 ±400 字符
 * ⇒ **不校验 `renameSync` 是否出现在该 `writeFileSync` 【之后】，也不校验它 rename 的
 * 目标是否与这次写入的落点【同源】** ⇒ 一处真裸写只要 400 字符内存在**任何无关的**
 * `renameSync(` 就会被免罪。这个洞正打在「抓第三处裸写」的靶心上。
 * 收紧口径已立 P2 卡（不在本批）：要求 `renameSync(` 出现在该 `writeFileSync` **之后**、
 * 且其第二实参与写入落点标识符同源，窗口收紧到 ±200。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

/** 单个写调用周围的判定窗口（字符数）：足够覆盖多行 `fs.writeFileSync(\n  cfgPath,`）。 */
const WINDOW_BEFORE = 400;
const WINDOW_AFTER = 400;

/** 出现这些标识符/字面量即认为「这个写落点是配置文件」。 */
const CONFIG_TARGET_HINTS = [
  'config.json',
  'cfgPath',
  'configPath',
  'this.configPath',
  'defaultConfigPath(',
  'resolveConfigDir(',
];

/** 有这些即认为「已走原子写」。 */
const ATOMIC_HINTS = [
  'writeFileAtomic',
  'writeJsonAtomic',
  // 仓内既有的另一套原子写形状（temp 变量 + renameSync，如 desktop-host 的 projects.json）：
  // 它同样不留半截，不该被守卫误报。
  'renameSync(',
];

/**
 * 扫描一组源码文本，返回**疑似对配置文件裸写**的调用。
 *
 * 纯函数：输入是 `{path, text}` 数组，不读盘 —— 便于用假源码做负控。
 */
export function scanSourceForRawConfigWrites(files: readonly SourceFile[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    const text = f.text;
    const re = /\bwriteFileSync\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const at = m.index;
      const before = text.slice(Math.max(0, at - WINDOW_BEFORE), at);
      const after = text.slice(at, Math.min(text.length, at + WINDOW_AFTER));
      const window = before + after;

      // 已经走 helper：放行
      if (ATOMIC_HINTS.some((h) => window.includes(h))) continue;
      // 不是写配置文件：放行
      if (!CONFIG_TARGET_HINTS.some((h) => window.includes(h))) continue;

      const line = text.slice(0, at).split('\n').length;
      const lineStart = text.lastIndexOf('\n', at) + 1;
      const lineEnd = text.indexOf('\n', at);
      const snippet = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
      out.push({ file: f.path, line, snippet });
    }
  }
  return out;
}

function readSrcFiles(dir: string = SRC_ROOT): SourceFile[] {
  const out: SourceFile[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...readSrcFiles(p));
      continue;
    }
    if (!p.endsWith('.ts')) continue;
    out.push({ path: path.relative(REPO_ROOT, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
  }
  return out;
}

describe('config.json 直写静态守卫（第三处裸写必须被拦住）', () => {
  it('真实源码里没有「对 config.json 的裸写」', () => {
    const violations = scanSourceForRawConfigWrites(readSrcFiles());
    const detail = violations.map((v) => `${v.file}:${v.line}  ${v.snippet}`).join('\n');
    expect(violations, `发现对配置文件的裸写（必须改走 writeFileAtomicSync）：\n${detail}`).toEqual([]);
  });

  it('扫描器本身有效：真实源码至少被扫到（防止空目录/路径写错导致假绿）', () => {
    const files = readSrcFiles();
    expect(files.length).toBeGreaterThan(100);
    // config-loader 与 workspace 是两处已知的 config.json 写点，必须都在扫描集里
    const paths = files.map((f) => f.path);
    expect(paths).toContain('src/api/config-loader.ts');
    expect(paths).toContain('src/host/workspace.ts');
  });

  /** 负控：假源码必须红 —— 否则这条断言永远是绿的，等于没写。 */
  it('负控：裸写 config.json 的假源码必须被判红', () => {
    const fake: SourceFile[] = [
      {
        path: 'src/fake/bad.ts',
        text: [
          'function save(cfgPath: string, data: string) {',
          "  fs.writeFileSync(cfgPath, data, { mode: 0o600 });",
          '}',
        ].join('\n'),
      },
    ];
    const v = scanSourceForRawConfigWrites(fake);
    expect(v).toHaveLength(1);
    expect(v[0].file).toBe('src/fake/bad.ts');
    expect(v[0].line).toBe(2);
  });

  it('负控二：字面量 config.json 的裸写同样判红', () => {
    const fake: SourceFile[] = [
      { path: 'src/fake/literal.ts', text: `fs.writeFileSync(path.join(dir, 'config.json'), data);` },
    ];
    expect(scanSourceForRawConfigWrites(fake)).toHaveLength(1);
  });

  it('正控：走 helper 的同形状调用不判红', () => {
    const fake: SourceFile[] = [
      {
        path: 'src/fake/good.ts',
        text: `function save(cfgPath: string, data: string) {\n  writeFileAtomicSync(cfgPath, data, { mode: 0o600 });\n}`,
      },
    ];
    expect(scanSourceForRawConfigWrites(fake)).toEqual([]);
  });

  it('正控二：写非配置文件（如 projects.json）的裸写不误报', () => {
    const fake: SourceFile[] = [
      { path: 'src/fake/other.ts', text: `fs.writeFileSync(projectsPath, JSON.stringify(list, null, 2), 'utf8');` },
    ];
    expect(scanSourceForRawConfigWrites(fake)).toEqual([]);
  });

  it('正控三：自建 tmp + rename 的同样式原子写不误报', () => {
    const fake: SourceFile[] = [
      {
        path: 'src/fake/tmprename.ts',
        text: [
          'function save(cfgPath: string, data: string) {',
          '  const tmp = cfgPath + ".tmp";',
          "  fs.writeFileSync(tmp, data, 'utf8');",
          '  fs.renameSync(tmp, cfgPath);',
          '}',
        ].join('\n'),
      },
    ];
    expect(scanSourceForRawConfigWrites(fake)).toEqual([]);
  });
});

/**
 * 追加守卫（PM 裁定三十九 四 → 升级为机器判据，2026-11-06）：
 * `src-tauri/src/main.rs` 的 `grant_log` 函数体必须**逐次 O_APPEND**。
 *
 * 为什么够格立回归用例：Core 实跑判别实验证明「按偏移定位 / 带缓冲的写方」与
 * node 的 `'a'` 并发时会**整段覆盖**对方行（实测丢 236 / 1143 行）；两个 O_APPEND
 * 写方并发则 4000/4000 零污染。一旦有人把 `append(true)` 改成 `set_len` / `seek` /
 * 先取 `metadata().len()` 再写，共用同一份 sidecar 日志就不再安全 —— 这条守卫把
 * 那个形态钉死。
 */
export function scanAppendOnlyWriter(source: string, fnName: string): string[] {
  const problems: string[] = [];
  const start = source.indexOf(`fn ${fnName}(`);
  if (start < 0) return [`找不到函数 ${fnName}`];
  // 函数体：从签名后的第一个 '{' 起，按大括号配平截取
  const braceStart = source.indexOf('{', start);
  if (braceStart < 0) return [`${fnName} 没有函数体`];
  let depth = 0;
  let end = braceStart;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = source.slice(braceStart, end + 1);
  if (body.trim().length < 20) problems.push(`${fnName} 函数体为空（守卫读错位置会假绿）`);
  if (!body.includes('.append(true)')) problems.push(`${fnName} 未使用 .append(true)（必须逐次 O_APPEND）`);
  for (const bad of ['set_len', '.seek(', 'metadata()', 'len()']) {
    if (body.includes(bad)) problems.push(`${fnName} 出现定位/截断写法 ${bad} —— 会退化成覆盖并发行`);
  }
  return problems;
}

describe('grant_log 必须逐次 O_APPEND（裁定三十九 四）', () => {
  const MAIN_RS = path.join(REPO_ROOT, 'src-tauri', 'src', 'main.rs');

  it('真实源码：grant_log 只用 append(true)，无 set_len/seek/len 定位写法', () => {
    const src = fs.readFileSync(MAIN_RS, 'utf8');
    expect(src.length).toBeGreaterThan(10_000); // 反假绿：确实读到了文件
    expect(scanAppendOnlyWriter(src, 'grant_log')).toEqual([]);
  });

  it('负控：改成定位写法的假源码必须红', () => {
    const fake = [
      'fn grant_log(line: &str) {',
      '    let mut f = std::fs::OpenOptions::new().open(p).unwrap();',
      '    let cur = f.metadata().unwrap().len();',
      '    f.seek(std::io::SeekFrom::Start(cur)).unwrap();',
      '    writeln!(f, "{}", line).unwrap();',
      '}',
    ].join('\n');
    const problems = scanAppendOnlyWriter(fake, 'grant_log');
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain('.append(true)');
  });

  it('负控二：只 set_len 截断也必须红', () => {
    const fake = ['fn grant_log(line: &str) {', '    f.set_len(0).ok();', '    write!(f, "{}", line);', '}'].join('\n');
    expect(scanAppendOnlyWriter(fake, 'grant_log').length).toBeGreaterThan(0);
  });

  it('正控：只 append(true) 的假源码通过', () => {
    const fake = [
      'fn grant_log(line: &str) {',
      '    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(p)?;',
      '    writeln!(f, "{}", line)?;',
      '}',
    ].join('\n');
    expect(scanAppendOnlyWriter(fake, 'grant_log')).toEqual([]);
  });
});