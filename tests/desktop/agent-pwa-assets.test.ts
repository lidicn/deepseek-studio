// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

let html: string;
let manifest: Record<string, unknown>;
let sw: string;

beforeAll(() => {
  html = read('src/ui/agent.html');
  manifest = JSON.parse(read('src/ui/agent.webmanifest')) as Record<string, unknown>;
  sw = read('src/ui/agent-sw.js');
});

describe('PWA · manifest 结构（P2）', () => {
  it('name / short_name / display=standalone', () => {
    expect(manifest.name).toBe('DeepSeek Studio 工作台');
    expect(manifest.short_name).toBe('Studio');
    expect(manifest.display).toBe('standalone');
  });

  it('start_url 与 scope 限制在 /agent，不把整个域变 PWA', () => {
    expect(manifest.start_url).toBe('/agent');
    expect(manifest.scope).toBe('/agent');
  });

  it('声明 192 与 512 两个图标', () => {
    const icons = manifest.icons as Array<{ sizes: string; src: string }>;
    expect(icons.map((i) => i.sizes)).toEqual(['192x192', '512x512']);
    expect(icons.every((i) => i.src.startsWith('/agent-icon-'))).toBe(true);
  });

  it('背景色与浅色主题一致（避免启动白屏闪烁）', () => {
    expect(manifest.background_color).toBe('#F7F8FA');
    expect(manifest.theme_color).toBe('#4D6BFE');
  });
});

describe('PWA · agent.html 接线（P2）', () => {
  it('link rel=manifest 指向 /agent.webmanifest', () => {
    expect(html).toContain('<link rel="manifest" href="/agent.webmanifest" />');
  });

  it('viewport 含 viewport-fit=cover（刘海屏）', () => {
    expect(html).toMatch(/name="viewport"[^>]*viewport-fit=cover/);
  });

  it('注册 Service Worker 且失败静默降级', () => {
    expect(html).toContain("navigator.serviceWorker.register('/agent-sw.js')");
    expect(html).toContain('.catch(function () {');
  });

  it('apple-touch-icon 存在（iOS 主屏）', () => {
    expect(html).toContain('rel="apple-touch-icon"');
  });
});

describe('PWA · Service Worker 缓存策略（P2 令牌安全）', () => {
  it('显式不拦截 /agent（含令牌，绝不缓存）', () => {
    expect(sw).toMatch(/if \(path === '\/agent'\) return;/);
  });

  it('只缓存白名单静态壳，不做通配缓存', () => {
    expect(sw).toContain("'/agent.css'");
    expect(sw).toContain("'/agent.js'");
    expect(sw).toContain("'/agent.webmanifest'");
    // 白名单是封闭集合：除了这四个前缀，不得再 put 任何东西。
    const putCalls = Array.from(sw.matchAll(/c\.put\(req,/g));
    expect(putCalls).toHaveLength(2); // 仅 agent.css/agent.js 与 manifest/图标两条分支
  });

  it('非 GET 请求直接放行', () => {
    expect(sw).toContain("if (req.method !== 'GET') return;");
  });

  it('跨源请求不拦截', () => {
    expect(sw).toContain('url.origin !== self.location.origin');
  });

  it('activate 清理旧版本缓存', () => {
    expect(sw).toContain('caches.delete(k)');
  });
});

describe('PWA · 图标文件真实存在且尺寸正确', () => {
  it('192 与 512 PNG 非空', () => {
    for (const rel of ['src/ui/icon-192.png', 'src/ui/icon-512.png']) {
      const buf = readFileSync(path.join(repoRoot, rel));
      expect(buf.length).toBeGreaterThan(1000);
      // PNG magic
      expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    }
  });

  it('manifest 引用的路径与磁盘文件一一对应', () => {
    const icons = manifest.icons as Array<{ src: string }>;
    for (const icon of icons) {
      const rel = `src/ui/${icon.src.replace('/agent-icon-', 'icon-')}`;
      expect(() => readFileSync(path.join(repoRoot, rel))).not.toThrow();
    }
  });
});
