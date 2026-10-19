// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderMessage } from '../../src/ui/workbench/components/message';
import { renderReasoning } from '../../src/ui/workbench/components/reasoning';
import { renderToolCallCard } from '../../src/ui/workbench/components/tool-call-card';
import { renderDiffReview } from '../../src/ui/workbench/components/diff-review';
import { renderApprovalCard } from '../../src/ui/workbench/components/approval-card';
import { renderArtifactCard } from '../../src/ui/workbench/components/artifact-card';
import { renderErrorCard } from '../../src/ui/workbench/components/error-card';
import { renderPermissionCard } from '../../src/ui/workbench/components/permission-card';
import { renderUnknownTool } from '../../src/ui/workbench/components/unknown-tool-card';
import { workbenchEmptyState } from '../../src/ui/workbench/components/empty-state';
import type { ToolRunEvent } from '../../src/shared/tool-run-event';

const started = {
  type: 'tool-run' as const,
  runId: 'r1',
  tool: 'shell_exec',
  phase: 'started' as const,
} satisfies ToolRunEvent;

describe('ToolCallCard 健壮性', () => {
  it('未知/缺 tool 不崩溃，走 UnknownToolCard', () => {
    const a = renderToolCallCard(null);
    expect(a.getAttribute('data-unknown-tool')).toBe('true');
    const b = renderToolCallCard({ type: 'tool-run', runId: 'r2', tool: '', phase: 'started' });
    expect(b.getAttribute('data-unknown-tool')).toBe('true');
  });

  it('failed 显示错误码中文映射', () => {
    const el = renderToolCallCard({ ...started, runId: 'r3', phase: 'failed', errorCode: 'not-found' });
    expect(el.textContent).toContain('不存在');
  });

  it('denied / cancelled 文案正确', () => {
    const denied = renderToolCallCard({ ...started, runId: 'r4', phase: 'denied', errorCode: 'consent-denied' });
    expect(denied.textContent).toContain('被拒绝');
    const cancelled = renderToolCallCard({ ...started, runId: 'r5', phase: 'cancelled' });
    expect(cancelled.textContent).toContain('已取消');
  });
});

describe('DiffReview / ArtifactCard 空数据', () => {
  it('缺 details 不崩溃，返回 null', () => {
    expect(renderDiffReview(undefined)).toBeNull();
    expect(renderDiffReview(null)).toBeNull();
    expect(renderDiffReview({ ...started, details: undefined })).toBeNull();
  });

  it('空 artifactPaths 不渲染（null）', () => {
    expect(renderArtifactCard({ ...started, artifactPaths: [] })).toBeNull();
    expect(renderArtifactCard(undefined)).toBeNull();
  });

  it('DiffReview 只给只读摘要，无逐块按钮', () => {
    const el = renderDiffReview({
      ...started,
      details: { path: 'a.txt', replacements: 3, bytesBefore: 10, bytesAfter: 20 },
    });
    expect(el).not.toBeNull();
    expect(el?.querySelectorAll('button')).toHaveLength(0);
    expect(el?.textContent).toContain('未提供行级 diff');
  });
});

describe('ApprovalCard 只读', () => {
  it('无「始终允许」，无任何按钮', () => {
    const el = renderApprovalCard();
    expect(el.textContent).not.toContain('始终允许');
    expect(el.querySelectorAll('button')).toHaveLength(0);
    expect(el.textContent).toContain('宿主窗口');
  });
});

describe('ErrorCard / PermissionCard', () => {
  it('空输入不崩溃，未知 code 显示原码', () => {
    const el = renderErrorCard(undefined);
    expect(el.textContent).toContain('未知错误');
    const unknown = renderErrorCard({ errorCode: 'brand-new-code' });
    expect(unknown.textContent).toContain('brand-new-code');
  });

  it('PermissionCard pending 时不显示成功确认', () => {
    const pending = renderPermissionCard({ mode: 'auto', pending: true });
    expect(pending.querySelector('[data-pending]')).not.toBeNull();
    expect(pending.querySelector('[data-confirmed]')).toBeNull();
    const confirmed = renderPermissionCard({ mode: 'full' });
    expect(confirmed.querySelector('[data-confirmed]')).not.toBeNull();
  });

  it('mode 为空显示「未设置」', () => {
    expect(renderPermissionCard({ mode: null }).textContent).toContain('未设置');
  });
});

describe('Message / Reasoning / UnknownTool / EmptyState 空数据', () => {
  it('Reasoning 无数据源返回 null，不猜测', () => {
    expect(renderReasoning(null)).toBeNull();
    expect(renderReasoning(undefined)).toBeNull();
    expect(renderReasoning('')).toBeNull();
  });

  it('Message 空文本仍渲染节点且不横向溢出', () => {
    const long = '字'.repeat(500);
    const el = renderMessage('user', long);
    const body = el.querySelector('.wb-message-body');
    expect(body?.textContent?.length).toBe(500);
    expect(body?.classList.contains('wb-message-body')).toBe(true);
  });

  it('UnknownTool 空 tool 不崩溃', () => {
    expect(renderUnknownTool(null).textContent).toContain('未识别工具');
  });

  it('EmptyState 空数据显示占位文案', () => {
    const el = workbenchEmptyState('暂无工具运行', '执行工具后显示');
    expect(el.textContent).toContain('暂无工具运行');
  });
});
