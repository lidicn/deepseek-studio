/**
 * tests/desktop/cli-args.test.ts
 *
 * 宿主 CLI 参数解析回归（2026-11-06 引入 `dev-main.ts` 入口后补）。
 *
 * **喂显式 argv 数组，不依赖真实 `process.argv`**（Chief 建议）：否则 tsx 换版改了
 * argv 形态，测试会假绿。两种真实形态都要覆盖：
 *   shape B（**实测形态**）`[node, 脚本, ...参数]`
 *   shape A（tsx 若带 loader）`[node, loader, 脚本, ...参数]`
 *
 * 守住的三件事：
 * ① 脚本路径（`main.ts` / **`dev-main.ts`**）不得混进用户参数 —— 否则 `--help` 判不出来，
 *    宿主会被真的拉起来（`main.ts` 注释里那个 20261023 孤儿进程场景）；
 * ② `--help/-h/--version/-V` 单独出现 → 只查询；
 * ③ **用户位置参数即使以 `main.ts` 结尾也不得被吞**（旧 `endsWith('main.ts')` 会误吞，
 *    这正是本次改动的真实价值）。
 */
import { describe, it, expect } from 'vitest';
import { extractCliArgs, isQueryOnly, HOST_SCRIPT_NAMES, QUERY_FLAGS } from '../../src/api/cli-args';

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const LOADER = 'E:\\repo\\node_modules\\tsx\\dist\\cli.mjs';
const MAIN = 'E:\\repo\\src\\api\\main.ts';
const DEV_MAIN = 'E:\\repo\\src\\api\\dev-main.ts';

describe('extractCliArgs：脚本路径被剔除，用户参数保留', () => {
  it('shape B（实测形态）：[node, 脚本, --help] → [--help]', () => {
    expect(extractCliArgs([NODE, MAIN, '--help'])).toEqual(['--help']);
    expect(extractCliArgs([NODE, DEV_MAIN, '--help'])).toEqual(['--help']);
  });

  it('shape A（带 loader）：[node, loader, 脚本, --help] → [--help]', () => {
    expect(extractCliArgs([NODE, LOADER, MAIN, '--help'])).toEqual(['--help']);
    expect(extractCliArgs([NODE, LOADER, DEV_MAIN, '--version'])).toEqual(['--version']);
  });

  it('无参数 → 空数组（正常启动，不得判成查询）', () => {
    expect(extractCliArgs([NODE, MAIN])).toEqual([]);
    expect(extractCliArgs([NODE, DEV_MAIN])).toEqual([]);
  });

  it('**用户位置参数以 main.ts 结尾也不被吞**（旧 endsWith 口径会误吞）', () => {
    const foobar = 'E:\\work\\foo-main.ts';
    expect(extractCliArgs([NODE, MAIN, '--workspace', foobar])).toEqual(['--workspace', foobar]);
    // 旧口径对照：endsWith('main.ts') 会把 foobar 当成脚本路径吃掉
    expect(foobar.endsWith('main.ts')).toBe(true);
  });

  it('入口名用白名单精确匹配（大小写敏感，不做模糊结尾匹配）', () => {
    expect(HOST_SCRIPT_NAMES.has('main.ts')).toBe(true);
    expect(HOST_SCRIPT_NAMES.has('dev-main.ts')).toBe(true);
    expect(HOST_SCRIPT_NAMES.has('foo-main.ts')).toBe(false);
  });
});

describe('isQueryOnly：只有查询开关才算「只查询」', () => {
  it('单个查询开关 → true（main / dev-main 两种入口都成立）', () => {
    for (const flag of QUERY_FLAGS) {
      expect(isQueryOnly([NODE, MAIN, flag])).toBe(true);
      expect(isQueryOnly([NODE, DEV_MAIN, flag])).toBe(true);
      expect(isQueryOnly([NODE, LOADER, DEV_MAIN, flag])).toBe(true);
    }
  });

  it('查询开关 + 其它实参 → false（必须真的起宿主）', () => {
    expect(isQueryOnly([NODE, MAIN, '--help', '--foo'])).toBe(false);
    expect(isQueryOnly([NODE, DEV_MAIN, '--version', 'x'])).toBe(false);
  });

  it('无参数 → false（正常启动）', () => {
    expect(isQueryOnly([NODE, MAIN])).toBe(false);
    expect(isQueryOnly([NODE, DEV_MAIN])).toBe(false);
  });

  it('回归护栏：dev 入口下 --help 仍必须判成查询（防再退回「按文件名结尾猜」）', () => {
    // 若有人把实现改回 `basename === 'main.ts'` 且用 slice(1)，dev-main 会漏过 → 本条红。
    expect(isQueryOnly([NODE, DEV_MAIN, '--help'])).toBe(true);
  });
});
