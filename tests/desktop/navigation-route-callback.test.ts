// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createNavigationObserver } from '../../src/inject/navigation';

describe('导航观察器的 UI 路由回调', () => {
  it('关闭重注入时仍通知路由变化，不增加注入计数', () => {
    const seen: string[] = [];
    const observer = createNavigationObserver({
      reinjectOnRouteChange: false,
      onRouteChange: (pathname) => seen.push(pathname),
    });
    observer.start();
    history.pushState({}, '', '/chat/session-a');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(seen).toEqual(['/chat/session-a', '/chat/session-a']);
    expect(observer.reinjectionCount).toBe(0);
    observer.stop();
  });
});
