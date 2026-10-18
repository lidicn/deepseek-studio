import { afterAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { grepFiles, listFiles, type ListedEntry } from '../../src/capabilities/search-files';

interface ListData {
  root: string;
  entries: Array<{ path: string; type: 'file' | 'dir'; size?: number }>;
  total: number;
  truncated: boolean;
}

interface GrepData {
  root: string;
  matches: Array<{ file: string; line: number; text: string }>;
  truncated: boolean;
}

const roots: string[] = [];

function mkRoot(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'search-files-'));
  roots.push(r);
  return r;
}

/** 建一棵固定测试树：
 *  root/a.txt            'hello world\nsecond line\n'
 *  root/ignored.log      'hello log\n'
 *  root/sub/b.ts         'export const x = 42;\n'
 *  root/sub/deep/c.md    '# Title\nhello again\n'
 */
function makeTree(): string {
  const root = mkRoot();
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello world\nsecond line\n');
  fs.writeFileSync(path.join(root, 'ignored.log'), 'hello log\n');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'b.ts'), 'export const x = 42;\n');
  fs.mkdirSync(path.join(root, 'sub', 'deep'));
  fs.writeFileSync(path.join(root, 'sub', 'deep', 'c.md'), '# Title\nhello again\n');
  return root;
}

afterAll(() => {
  for (const r of roots) {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

describe('listFiles', () => {
  it('递归列出匹配 pattern 的文件，相对路径用 / 分隔', async () => {
    const root = makeTree();
    const res = await listFiles({ root, pattern: '*.txt' });
    expect(res.ok).toBe(true);
    const data = res.data as ListData;
    expect(data.truncated).toBe(false);
    const paths = data.entries.map((e) => e.path);
    expect(paths).toContain('a.txt');
    expect(paths).not.toContain('sub/b.ts'); // .ts 不匹配 *.txt
    expect(paths).not.toContain('ignored.log');
    const a = data.entries.find((e) => e.path === 'a.txt');
    expect(a).toBeDefined();
    expect(a?.type).toBe('file');
    expect(typeof a?.size).toBe('number');
    expect((a as ListedEntry).size).toBeGreaterThan(0);
  });

  it('递归默认会下钻，sub/deep/c.md 可被列出', async () => {
    const root = makeTree();
    const res = await listFiles({ root, pattern: '*.md' });
    expect(res.ok).toBe(true);
    const paths = (res.data as ListData).entries.map((e) => e.path);
    expect(paths).toContain('sub/deep/c.md');
  });

  it('非递归只列顶层，不进入子目录', async () => {
    const root = makeTree();
    const res = await listFiles({ root, recursive: false });
    expect(res.ok).toBe(true);
    const data = res.data as ListData;
    const paths = data.entries.map((e) => e.path);
    expect(paths).toContain('a.txt');
    expect(paths).toContain('ignored.log');
    expect(paths).toContain('sub');
    expect(paths).not.toContain('sub/b.ts');
    expect(paths).not.toContain('sub/deep/c.md');
  });

  it('超 limit → truncated=true，且只返回 limit 条', async () => {
    const root = mkRoot();
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(root, `f${i}.txt`), `content-${i}`);
    }
    const res = await listFiles({ root, limit: 3 });
    expect(res.ok).toBe(true);
    const data = res.data as ListData;
    expect(data.entries.length).toBe(3);
    expect(data.truncated).toBe(true);
    expect(data.total).toBe(3);
  });

  it('空目录返回空 entries，不报错', async () => {
    const root = mkRoot();
    const res = await listFiles({ root });
    expect(res.ok).toBe(true);
    const data = res.data as ListData;
    expect(data.entries).toEqual([]);
    expect(data.total).toBe(0);
    expect(data.truncated).toBe(false);
  });
});

describe('grepFiles', () => {
  it('子串命中返回 file/line/text', async () => {
    const root = makeTree();
    const res = await grepFiles({ root, query: 'hello' });
    expect(res.ok).toBe(true);
    const data = res.data as GrepData;
    expect(data.truncated).toBe(false);
    const files = data.matches.map((m) => m.file);
    expect(files).toContain('a.txt');
    expect(files).toContain('ignored.log');
    expect(files).toContain('sub/deep/c.md');
    const hit = data.matches.find((m) => m.file === 'a.txt');
    expect(hit?.line).toBe(1);
    expect(hit?.text).toBe('hello world');
  });

  it('regex=true 按正则命中', async () => {
    const root = makeTree();
    const res = await grepFiles({ root, query: '^second\\s+line$', regex: true });
    expect(res.ok).toBe(true);
    const data = res.data as GrepData;
    const hit = data.matches.find((m) => m.file === 'a.txt');
    expect(hit?.line).toBe(2);
    expect(hit?.text).toBe('second line');
  });

  it('caseInsensitive 生效', async () => {
    const root = makeTree();
    // 默认大小写敏感：'Title' 中的 'Title'，查 'title' 不应命中
    const sensitive = await grepFiles({ root, query: 'title' });
    expect((sensitive.data as GrepData).matches.some((m) => m.file === 'sub/deep/c.md')).toBe(false);
    // 忽略大小写后应命中
    const insensitive = await grepFiles({ root, query: 'title', caseInsensitive: true });
    const data = insensitive.data as GrepData;
    expect(data.matches.some((m) => m.file === 'sub/deep/c.md' && m.line === 1)).toBe(true);
  });

  it('glob 过滤只在匹配文件名的文件内检索', async () => {
    const root = makeTree();
    const res = await grepFiles({ root, query: 'const', glob: '*.ts' });
    expect(res.ok).toBe(true);
    const data = res.data as GrepData;
    expect(data.matches.length).toBe(1);
    expect(data.matches[0].file).toBe('sub/b.ts');
  });

  it('单行文本截断到 200 字符', async () => {
    const root = mkRoot();
    const long = 'x'.repeat(500);
    fs.writeFileSync(path.join(root, 'long.txt'), `match-${long}\n`);
    const res = await grepFiles({ root, query: 'match-' });
    const data = res.data as GrepData;
    expect(data.matches.length).toBe(1);
    expect(data.matches[0].text.length).toBe(200);
  });

  it('空目录返回空 matches，不报错', async () => {
    const root = mkRoot();
    const res = await grepFiles({ root, query: 'anything' });
    expect(res.ok).toBe(true);
    expect((res.data as GrepData).matches).toEqual([]);
    expect((res.data as GrepData).truncated).toBe(false);
  });
});

describe('错误路径', () => {
  it('缺 root → missing-argument', async () => {
    // @ts-expect-error 故意缺参
    const res = await listFiles({});
    expect(res.ok).toBe(false);
    expect(res.error).toBe('missing-argument');
  });

  it('grep 缺 query → missing-argument', async () => {
    const root = makeTree();
    // @ts-expect-error 故意缺 query
    const res = await grepFiles({ root });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('missing-argument');
  });

  it('root 不是绝对路径 → invalid-argument', async () => {
    const res = await listFiles({ root: 'relative/path' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('invalid-argument');
  });

  it('非法 regex → invalid-argument', async () => {
    const root = makeTree();
    const res = await grepFiles({ root, query: '(unclosed', regex: true });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('invalid-argument');
  });

  it('root 不存在 → io-error', async () => {
    const res = await listFiles({ root: path.join(os.tmpdir(), 'no-such-dir-ord001-xyz', 'nested') });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('io-error');
  });
});

describe('安全边界：符号链接不逃逸', () => {
  it('不跟随指向 root 外部的符号链接，不读到外部内容', async () => {
    const root = makeTree();
    const outside = mkRoot();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET_PASSWORD=12345');
    const linkPath = path.join(root, 'evil-link');
    try {
        fs.symlinkSync(outside, linkPath, 'dir');
    } catch {
      // Windows 无开发者模式/管理员权限时无法建 symlink：跳过该用例
      return;
    }

    // grep 不应命中外部 secret
    const g = await grepFiles({ root, query: 'SECRET_PASSWORD' });
    expect(g.ok).toBe(true);
    expect((g.data as GrepData).matches.length).toBe(0);

    // listFiles 中链接本身可作为条目出现，但不得下钻列出其内容
    const l = await listFiles({ root });
    expect(l.ok).toBe(true);
    const paths = (l.data as ListData).entries.map((e) => e.path);
    expect(paths).toContain('evil-link');
    expect(paths).not.toContain('evil-link/secret.txt');
  });
});
