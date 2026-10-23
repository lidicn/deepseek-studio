import { readFileSync, existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DeepSeekSseFrameDecoder,
  framesSignalStreamCompletion,
  type DeepSeekSseFrame,
} from '../../src/inject/deepseek-sse-frame-decoder';

/**
 * QD-R7-01 §8.1 验收判据：真实 body × 四档切片 → 组合必须全部判出哨兵。
 *
 * 定案报告要的是「11 份真实 body 按 1/7/64/1024 字节切片，44 个组合全部判出哨兵」。
 * 真实 body 取自 `logs/cdp-chat-capture/*-response-body.txt`（11 份含 `event: close`）。
 * logs/ 不入库，故仓库内固定夹带两份最小样本（tests/fixtures/real-sse/），
 * 保证 CI 上这条判据也真在跑；本地若存在抓包目录，自动把 11 份全跑一遍。
 *
 * 关键点：喂法必须与修复后的拦截器一致 —— 除最后一片外只 push，EOF 时调 finish()。
 * 这既是 F1 的验收，也是它的负控（去掉 finish() 至少要有一个组合漏判）。
 */

const SLICES = [1, 7, 64, 1024] as const;

function fixtureDir(): string {
  // vitest 的 cwd 就是仓库根；不用 __dirname（本仓 "type": "module"，ESM 下没有它）。
  return path.resolve(process.cwd(), 'tests', 'fixtures', 'real-sse');
}

function captureDir(): string {
  return path.resolve(process.cwd(), 'logs', 'cdp-chat-capture');
}

/** 仓库内固定样本 + 本地抓包目录里含 event: close 的真实流。 */
function realBodies(): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const dir = fixtureDir();
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.txt')) out.push({ name: `fixture/${f}`, body: readFileSync(path.join(dir, f), 'utf8') });
    }
  }
  const cap = captureDir();
  if (existsSync(cap)) {
    for (const f of readdirSync(cap)) {
      if (!f.endsWith('-response-body.txt')) continue;
      const text = readFileSync(path.join(cap, f), 'utf8');
      if (text.includes('event: close')) out.push({ name: `capture/${f}`, body: text });
    }
  }
  return out;
}

/** 按 size 字节切片喂进解码器；eofFlush 控制 EOF 时是否调 finish()（负控用）。 */
function feedInSlices(body: string, size: number, eofFlush: boolean): DeepSeekSseFrame[] {
  const dec = new DeepSeekSseFrameDecoder();
  const frames: DeepSeekSseFrame[] = [];
  for (let i = 0; i < body.length; i += size) {
    frames.push(...dec.push(body.slice(i, i + size)));
  }
  if (eofFlush) frames.push(...dec.finish());
  return frames;
}

describe('QD-R7-01 §8.1：真实 body 的哨兵判定', () => {
  const bodies = realBodies();

  it('样本集非空（真实 body 至少 2 份，含 event: close）', () => {
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    for (const { name, body } of bodies) {
      expect(body.includes('event: close'), `${name} 不是真实完成流`).toBe(true);
    }
  });

  it(`全部真实 body × 切片 {${SLICES.join(',')}} 组合都判出完成哨兵`, () => {
    let combos = 0;
    for (const { name, body } of bodies) {
      for (const size of SLICES) {
        combos += 1;
        const frames = feedInSlices(body, size, true);
        expect(
          framesSignalStreamCompletion(frames),
          `${name} 切片=${size}B 未判出哨兵（帧数=${frames.length}）`,
        ).toBe(true);
      }
    }
    // 固定样本 2 份 × 4 档 = 8；本地 11 份时 13 份 × 4 = 52。数量必须与样本数一致。
    expect(combos).toBe(bodies.length * SLICES.length);
  });

  it('这 11 份抓包本身不需要 finish()（读数登记，不用它证明 F1）', () => {
    // 都是「正常完成」的流：末帧带结尾空行，且哨兵出现在**中段**
    // （实测样本：quasi_status@750 / response_status FINISHED@764,822 / event: close@941，
    //  而 body 长 1007 —— 哨兵帧后面还有 update_session / title / close 三帧）。
    // 所以 drain() 单独就能判出哨兵，这组数据**不能**证明 F1 的必要性。
    // 如实登记这个读数，避免把 F1 说成「已被真实数据证实」。
    let missed = 0;
    for (const { body } of bodies) {
      for (const size of SLICES) {
        if (!framesSignalStreamCompletion(feedInSlices(body, size, false))) missed += 1;
      }
    }
    expect(missed).toBe(0);
  });

  it('负控（F1）：真实字节构造「流停在哨兵帧且无结尾空行」→ 不 flush 漏判、flush 判出', () => {
    // 取真实 body，**截到第一个哨兵帧那一行结束**、且不带结尾空行。
    // 这是 F1 真正要挡的形态：连接在最后一帧数据后立刻关闭，或 readystatechange
    // 3→4 的字节边界正好落在这里 —— 此时那一帧永远出不来，正常完成的流被误判截断。
    // 注意必须切在「第一个」哨兵帧上：真实流的哨兵出现在中段，切晚了前面那帧就把哨兵带出来了。
    const body = bodies[0].body;
    const lines = body.split('\n');
    const sentinelLine = lines.findIndex(
      (l) => l.includes('quasi_status') || l.includes('response/status') || l.startsWith('event: close'),
    );
    expect(sentinelLine).toBeGreaterThan(0);
    const withoutBlank = lines.slice(0, sentinelLine + 1).join('\n');
    expect(withoutBlank.includes('event: close')).toBe(false);
    expect(withoutBlank.endsWith('\n')).toBe(false);
    for (const size of SLICES) {
      // 不 flush：漏判（红）。这一条就是 F1 修复前的行为。
      expect(framesSignalStreamCompletion(feedInSlices(withoutBlank, size, false))).toBe(false);
      // flush：判出（绿）。这一条是 F1 修复后的行为。
      expect(framesSignalStreamCompletion(feedInSlices(withoutBlank, size, true))).toBe(true);
    }
  });

  it('切片放大不产生假阳性：把非完成流判成完成是不可能的', () => {
    // 截断样本：在**第一个**哨兵 token 之前切断，确保样本里一个哨兵都不剩
    // （真实流同时带 response/status=FINISHED、quasi_status=FINISHED、event: close 三处，
    //  只砍掉 event: close 是砍不干净的）。
    const cutAt = Math.min(
      ...['FINISHED', 'event: close'].map((token) => {
        const i = bodies[0].body.indexOf(token);
        return i === -1 ? bodies[0].body.length : i;
      }),
    );
    const truncated = bodies[0].body.slice(0, cutAt);
    expect(truncated.length).toBeGreaterThan(0);
    expect(truncated.includes('FINISHED')).toBe(false);
    expect(truncated.includes('event: close')).toBe(false);
    for (const size of SLICES) {
      expect(framesSignalStreamCompletion(feedInSlices(truncated, size, true))).toBe(false);
    }
  });
});
