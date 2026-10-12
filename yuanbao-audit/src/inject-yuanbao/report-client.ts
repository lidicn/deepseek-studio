/**
 * 审计状态报告客户端
 *
 * 注入脚本通过 HTTP 向 yuanbao-audit Node 后端（默认 :8761）
 * 报告轮次进度、信号状态。
 */

export interface ReportPayload {
  project: string;
  sessionUrl: string;
  rounds: number[];
  state: 'idle' | 'running' | 'paused' | 'done';
  allDone: boolean;
  needDecision: boolean;
  needContinue: boolean;
  timestamp: number;
}

export interface ReportClientOptions {
  /** Node 后端地址，默认 http://127.0.0.1:8761 */
  baseUrl?: string;
  /** 鉴权 token */
  token: string;
  /** 项目名 */
  project: string;
  /** 当前会话 URL */
  sessionUrl: string;
}

export class ReportClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly project: string;
  private readonly sessionUrl: string;
  private lastReport = 0;
  private readonly minInterval = 2000; // 最小报告间隔

  constructor(opts: ReportClientOptions) {
    this.baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:8761').replace(/\/$/, '');
    this.token = opts.token;
    this.project = opts.project;
    this.sessionUrl = opts.sessionUrl;
  }

  /** 报告状态（节流：2 秒内最多一次） */
  async report(payload: Omit<ReportPayload, 'project' | 'sessionUrl' | 'timestamp'>): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastReport < this.minInterval) return true;
    this.lastReport = now;

    const body: ReportPayload = {
      ...payload,
      project: this.project,
      sessionUrl: this.sessionUrl,
      timestamp: now,
    };

    try {
      const res = await fetch(`${this.baseUrl}/v1/report`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** 立即报告（跳过节流，用于关键事件） */
  async reportUrgent(payload: Omit<ReportPayload, 'project' | 'sessionUrl' | 'timestamp'>): Promise<boolean> {
    this.lastReport = 0;
    return this.report(payload);
  }
}
