import { describe, expect, it } from 'vitest';
import {
  DeepSeekSseFrameDecoder,
  framesSignalStreamCompletion,
} from '../../src/inject/deepseek-sse-frame-decoder';

/**
 * QD-R4-03 完成哨兵判定。
 *
 * 实测依据：`logs/cdp-chat-capture/` 下 20 份真实 chat/completion 抓包，
 * `data: [DONE]` 出现 0 次（DONE=False）。通用 SSE 惯例在这里是错的，
 * 照抄会把每一条正常完成的流误判成「被截断」。
 */
describe('framesSignalStreamCompletion', () => {
  it('response/status = FINISHED 视为完成', () => {
    const dec = new DeepSeekSseFrameDecoder();
    const frames = dec.push('data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n');
    expect(framesSignalStreamCompletion(frames)).toBe(true);
  });

  it('response BATCH 里的 quasi_status = FINISHED 视为完成', () => {
    const dec = new DeepSeekSseFrameDecoder();
    const frames = dec.push(
      'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":8741},{"p":"quasi_status","v":"FINISHED"}]}\n\n',
    );
    expect(framesSignalStreamCompletion(frames)).toBe(true);
  });

  it('event: close 视为完成', () => {
    const dec = new DeepSeekSseFrameDecoder();
    const frames = dec.push('event: close\ndata: {"click_behavior":"none"}\n\n');
    expect(framesSignalStreamCompletion(frames)).toBe(true);
  });

  it('普通文本增量帧不是完成哨兵', () => {
    const dec = new DeepSeekSseFrameDecoder();
    const frames = dec.push('data: {"v":"hello"}\n\ndata: {"v":" world"}\n\n');
    expect(framesSignalStreamCompletion(frames)).toBe(false);
  });

  it('quasi_status 非 FINISHED 不算完成', () => {
    const dec = new DeepSeekSseFrameDecoder();
    const frames = dec.push(
      'data: {"p":"response","o":"BATCH","v":[{"p":"quasi_status","v":"WORKING"}]}\n\n',
    );
    expect(framesSignalStreamCompletion(frames)).toBe(false);
  });

  it('空批次 / 无 data 帧不算完成', () => {
    const dec = new DeepSeekSseFrameDecoder();
    expect(framesSignalStreamCompletion(dec.push('event: update_session\ndata: {"updated_at":1}\n\n'))).toBe(false);
    expect(framesSignalStreamCompletion([])).toBe(false);
  });
});
