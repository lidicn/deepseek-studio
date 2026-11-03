/**
 * 组 D · TD-07：端口解析的 fail-safe 校验。
 *
 * 缺陷（基线）：`config-loader.ts` 用 `Number(env ?? stored.port ?? 8760)` 直算 ——
 * `'abc'`（NaN）/`'0'`/`'99999'` 全部直通到 `listen()` 才炸。
 *
 * 修法：`parsePort(raw, fallback = 8760)` —— 非有限数 / 非整数 / `<1` / `>65535` 回落 fallback。
 * 与同函数 `isPolicyMode` 的 fail-safe 风格一致。
 *
 * ⚠️ 边界：`sidecar.rs` 的 `HEALTH_PORT` 是 DCD 契约常量（8760），本卡/本测试不涉及。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parsePort, loadConfig } from '../../src/api/config-loader';

/** 每个用例一个独立临时配置目录，绝不碰用户真实的 ~/.config。 */
function tmpCfgDir(): string {
  const dir = path.join(os.tmpdir(), 'studio-td07-' + process.pid + '-' + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('TD-07 parsePort: 非法值一律回落 8760', () => {
  it("'abc' → 8760（NaN 不得直通）", () => {
    expect(parsePort('abc')).toBe(8760);
  });

  it("'' → 8760（空串走缺省）", () => {
    expect(parsePort('')).toBe(8760);
  });

  it("'0' → 8760（端口 0 = 随机，不允许）", () => {
    expect(parsePort('0')).toBe(8760);
  });

  it("'-1' → 8760（负数非法）", () => {
    expect(parsePort('-1')).toBe(8760);
  });

  it("'99999' → 8760（>65535 越界）", () => {
    expect(parsePort('99999')).toBe(8760);
  });

  it("'65536' → 8760（刚好越上界）", () => {
    expect(parsePort('65536')).toBe(8760);
  });

  it("'12.5' → 8760（非整数）", () => {
    expect(parsePort('12.5')).toBe(8760);
  });

  it('null / undefined / NaN → 8760', () => {
    expect(parsePort(null)).toBe(8760);
    expect(parsePort(undefined)).toBe(8760);
    expect(parsePort(NaN)).toBe(8760);
    expect(parsePort(Infinity)).toBe(8760);
  });
});

describe('TD-07 parsePort: 合法值原样通过', () => {
  it("'8080' → 8080（字符串数字）", () => {
    expect(parsePort('8080')).toBe(8080);
  });

  it('8080（number）→ 8080', () => {
    expect(parsePort(8080)).toBe(8080);
  });

  it("' 9000 '（带空白）→ 9000", () => {
    expect(parsePort(' 9000 ')).toBe(9000);
  });

  it('边界 1 与 65535 合法', () => {
    expect(parsePort('1')).toBe(1);
    expect(parsePort('65535')).toBe(65535);
  });

  it('缺省 fallback 可定制', () => {
    expect(parsePort('abc', 5000)).toBe(5000);
  });
});

/**
 * 真实入口断言：`loadConfig` 必须**通过 parsePort** 解析端口。
 *
 * 存在的意义（验收纪律）：上面那些 `parsePort(...)` 直调用例只证明这个函数本身正确，
 * **不能抓住「调用点又退回 Number() 直算」的回归**——把 loadConfig 里的调用改回去，
 * 直调用例全绿。所以必须有一条打真实入口的断言：
 *   - 非法 env 端口 → loadConfig().config.port 必须回落 8760；
 *   - 合法 env 端口 → 原样透传。
 */
describe('TD-07 真实入口：loadConfig 必须走 parsePort', () => {
  function withPortEnv<T>(value: string | undefined, fn: () => T): T {
    const saved = process.env.DEEPSEEK_STUDIO_PORT;
    if (value === undefined) delete process.env.DEEPSEEK_STUDIO_PORT;
    else process.env.DEEPSEEK_STUDIO_PORT = value;
    try {
      return fn();
    } finally {
      if (saved === undefined) delete process.env.DEEPSEEK_STUDIO_PORT;
      else process.env.DEEPSEEK_STUDIO_PORT = saved;
    }
  }

  it("env='abc' → loadConfig 端口回落 8760（旧实现会得到 NaN）", () => {
    const cfg = withPortEnv('abc', () => loadConfig({ cfgDir: tmpCfgDir() }));
    expect(cfg.config.port).toBe(8760);
  });

  it("env='99999' → 回落 8760（旧实现会直通 99999）", () => {
    const cfg = withPortEnv('99999', () => loadConfig({ cfgDir: tmpCfgDir() }));
    expect(cfg.config.port).toBe(8760);
  });

  it("env='0' → 回落 8760（旧实现会直通 0）", () => {
    const cfg = withPortEnv('0', () => loadConfig({ cfgDir: tmpCfgDir() }));
    expect(cfg.config.port).toBe(8760);
  });

  it("env='8080' → 原样透传 8080", () => {
    const cfg = withPortEnv('8080', () => loadConfig({ cfgDir: tmpCfgDir() }));
    expect(cfg.config.port).toBe(8080);
  });

  it('无 env 时默认 8760', () => {
    const cfg = withPortEnv(undefined, () => loadConfig({ cfgDir: tmpCfgDir() }));
    expect(cfg.config.port).toBe(8760);
  });
});