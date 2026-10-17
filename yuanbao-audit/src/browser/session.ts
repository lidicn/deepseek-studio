/**
 * 元宝审计 · 可见浏览器会话（方案 A）
 *
 * 用 Playwright launchPersistentContext 起一个【有头、可见】的 Chromium 窗口：
 *   - userDataDir 持久化登录态 → 扫码一次，下次免扫
 *   - 窗口始终可见，用户能随时切过去看进度/异常
 *   - 导航到元宝，未登录则停在扫码页等待，登录后才开始审计循环
 *
 * 与旧 inject-yuanbao 的区别：
 *   - 不再是无头后端 + 手动粘脚本；窗口是我们自己拉起的、用户全程可见
 *   - 监控/发"继续"由 Node 侧通过 Playwright API 驱动（page.evaluate / page.keyboard）
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import path from 'node:path';

export const YUANBOO_URL = 'https://yuanbao.tencent.com/';

export interface BrowserSessionOptions {
  /** 持久化用户目录（登录态保存处） */
  userDataDir: string;
  /** 目标 URL，默认元宝 */
  startUrl?: string;
  /** 是否有头（默认 true，必须可见） */
  headless?: boolean;
  /**
   * 用系统已装的浏览器内核，不下载 Playwright 自带 Chromium：
   *   'chrome' → 系统 Google Chrome
   *   'msedge' → 系统 Microsoft Edge（Windows 必装）
   *   undefined → 回退 bundled chromium（需另装，不推荐）
   */
  channel?: 'chrome' | 'msedge';
}

export interface BrowserSessionHandle {
  context: BrowserContext;
  page: Page;
  /** 当前可见页面文本 */
  readText(): Promise<string>;
  /** 是否已登录（能找到输入框） */
  isLoggedIn(): Promise<boolean>;
  /** 是否正在生成（发送按钮变成停止） */
  isGenerating(): Promise<boolean>;
  /** 发送一段文字到输入框并点发送 */
  sendText(text: string): Promise<{ ok: boolean; reason?: string }>;
  /** 截图 PNG buffer */
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
}

// 输入框候选（元宝用 contenteditable / textarea）
const EDITOR_SELECTORS = [
  'div[contenteditable="true"]',
  'div[role="textbox"]',
  'textarea[class*="input"]',
  'textarea',
  '.ql-editor',
];

// 发送按钮候选
const SEND_BTN_SELECTORS = [
  'div[class*="send"]',
  'button[class*="send"]',
  'button[class*="Send"]',
  'div[class*="Send"]',
  '[aria-label*="发送"]',
];

function first<T>(arr: T[]): T | undefined {
  return arr[0];
}

/** 起一个有头可见窗口并导航到元宝。 */
export async function launchYuanbaoSession(opts: BrowserSessionOptions): Promise<BrowserSessionHandle> {
  const context = await chromium.launchPersistentContext(opts.userDataDir, {
    headless: opts.headless ?? false, // 默认有头，必须可见
    viewport: { width: 1280, height: 860 },
    channel: opts.channel ?? 'chrome', // 用系统 Chrome，不下载 bundled chromium
    args: ['--disable-blink-features=AutomationControlled'],
  });

  let page = first(context.pages()) ?? (await context.newPage());
  await page.goto(opts.startUrl ?? YUANBOO_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const handle: BrowserSessionHandle = {
    context,
    page,

    async readText(): Promise<string> {
      try {
        return await page.evaluate(() => document.body.innerText || '');
      } catch {
        return '';
      }
    },

    async isLoggedIn(): Promise<boolean> {
      // 已登录的标志：页面里能找到输入框
      for (const sel of EDITOR_SELECTORS) {
        const el = await page.$(sel).catch(() => null);
        if (el) {
          const visible = await el.isVisible().catch(() => false);
          if (visible) return true;
        }
      }
      return false;
    },

    async isGenerating(): Promise<boolean> {
      // 生成中：出现停止按钮
      const stopSelectors = ['div[class*="stop"]', 'button[class*="stop"]', 'button[class*="Stop"]'];
      for (const sel of stopSelectors) {
        const el = await page.$(sel).catch(() => null);
        if (el && (await el.isVisible().catch(() => false))) return true;
      }
      return false;
    },

    async sendText(text: string): Promise<{ ok: boolean; reason?: string }> {
      try {
        // 找可见输入框聚焦
        let editor: Page | BrowserSessionHandle['page'] = page;
        for (const sel of EDITOR_SELECTORS) {
          const el = await page.$(sel).catch(() => null);
          if (el && (await el.isVisible().catch(() => false))) {
            await el.click();
            await el.fill(text).catch(async () => {
              // contenteditable fill 不支持，用 keyboard 输入
              await page.keyboard.type(text);
            });
            editor = el as unknown as Page;
            break;
          }
        }

        // 点发送按钮
        for (const sel of SEND_BTN_SELECTORS) {
          const btn = await page.$(sel).catch(() => null);
          if (btn && (await btn.isVisible().catch(() => false))) {
            await btn.click();
            return { ok: true };
          }
        }
        // fallback：回车发送
        await page.keyboard.press('Enter');
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },

    async screenshot(): Promise<Buffer> {
      return await page.screenshot({ type: 'png' });
    },

    async close(): Promise<void> {
      await context.close().catch(() => {});
    },
  };

  return handle;
}

export function defaultBrowserProfileDir(configDir: string): string {
  return path.join(configDir, 'browser-profile');
}
