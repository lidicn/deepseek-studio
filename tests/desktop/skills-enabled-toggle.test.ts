// @vitest-environment node
/**
 * ㊿-c ②：技能开关落盘（宿主半）。
 *
 * 卡面口径（Studio-PM 裁定 2026-11-20）：
 *   - `skill.list` 每枚带 `enabled`（config.json 的 `disabledSkills` 派生；缺省＝全开）；
 *   - 新 RPC `skill.enabled.set`（仅 UI 面，不在 SUPPORTED_INVOCATION_NAMES）：
 *     落盘到 `config.json` 的 `disabledSkills`（persistConfigPatch 原子写＋0600）；
 *     **空清单 ⇒ 整键删除**（不留空数组）；
 *   - 未知 id 落盘无害（孤儿 id 与目录扫描求交天然为空）——**卡面原写「未知 id 回
 *     skill-not-found」，PM 事后裁定采纳 Core 口径（面板与宿主扫描天然有竞态，
 *     按 id 集合落盘对两边都安全），按裁定执行**；
 *   - 缺参回 missing-argument；
 *   - 变更后广播 `skills-changed`（hub 用例另打；页端消费属 UI 半）。
 *
 * 配置路径取向：`defaultConfigPath` 认 **STUDIO_CONFIG_DIR** 为唯一覆盖入口
 * （homedir 参数只在 env 未设时兜底）⇒ 测试同 v09 口径用 env 驱动，不靠 homedir 参数。
 *
 * 断言全部打真实入口：真 `persistDisabledSkills`/`readDisabledSkills` + 真磁盘回读。
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { persistDisabledSkills, readDisabledSkills, readConfiguredSkillsDir } from '../../src/host/skill-store';

const tmpDirs: string[] = [];
let prevConfigDir: string | undefined;
let prevHome: string | undefined;

function mkConfigDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-enabled-'));
  tmpDirs.push(d);
  return d;
}

function writeConfig(dir: string, bag: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(bag, null, 2), 'utf8');
}

function useConfigDir(dir: string): void {
  prevConfigDir = process.env.STUDIO_CONFIG_DIR;
  prevHome = process.env.HOME;
  process.env.STUDIO_CONFIG_DIR = dir;
  // 双保险：homedir 参数缺省时读 os.homedir()，测试进程的真实用户目录里可能有
  // 真配置——指向临时目录后仍不许它被读到。
  process.env.USERPROFILE = dir;
  process.env.HOME = dir;
}

function restoreEnv(): void {
  if (prevConfigDir === undefined) delete process.env.STUDIO_CONFIG_DIR;
  else process.env.STUDIO_CONFIG_DIR = prevConfigDir;
  if (prevHome === undefined) {
    delete process.env.USERPROFILE;
    delete process.env.HOME;
  } else {
    process.env.USERPROFILE = prevHome;
    process.env.HOME = prevHome;
  }
}

afterEach(() => {
  restoreEnv();
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    fs.rmSync(d as string, { recursive: true, force: true });
  }
});

describe('㊿-c ② · disabledSkills 读写（config.json 通道）', () => {
  it('persistDisabledSkills 落盘 → readDisabledSkills 回读一致；重复 id 去重、trim', () => {
    const dir = mkConfigDir();
    useConfigDir(dir);
    const r = persistDisabledSkills(['skill-b', 'skill-a', 'skill-b', '  skill-c  ']);
    expect(r.ok).toBe(true);
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as {
      disabledSkills?: string[];
    };
    expect(disk.disabledSkills?.sort()).toEqual(['skill-a', 'skill-b', 'skill-c']);
    const set = readDisabledSkills();
    expect(set.has('skill-a')).toBe(true);
    expect(set.has('skill-c')).toBe(true);
    expect(set.size).toBe(3);
  });

  it('空清单 ⇒ 整键删除（不留空数组）；同批其他键不受影响', () => {
    const dir = mkConfigDir();
    useConfigDir(dir);
    writeConfig(dir, { skillsDir: 'E:/x', disabledSkills: ['old'] });
    const r = persistDisabledSkills([]);
    expect(r.ok).toBe(true);
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as {
      skillsDir?: string;
      disabledSkills?: string[];
    };
    expect('disabledSkills' in disk).toBe(false);
    expect(disk.skillsDir).toBe('E:/x');
    // 读侧：无键 ⇒ 全开
    expect(readDisabledSkills().size).toBe(0);
  });

  it('配置不存在 / 非法 JSON / 字段非数组 ⇒ 读侧视为全开（不隐藏任何技能）', () => {
    const dirMissing = mkConfigDir();
    useConfigDir(dirMissing);
    expect(readDisabledSkills().size).toBe(0);

    const dirBad = mkConfigDir();
    useConfigDir(dirBad);
    fs.writeFileSync(path.join(dirBad, 'config.json'), '{not json', 'utf8');
    expect(readDisabledSkills().size).toBe(0);

    const dirWrong = mkConfigDir();
    useConfigDir(dirWrong);
    writeConfig(dirWrong, { disabledSkills: 'skill-a' });
    expect(readDisabledSkills().size).toBe(0);

    // 数组里混入非字符串 ⇒ 只收字符串
    const dirMixed = mkConfigDir();
    useConfigDir(dirMixed);
    writeConfig(dirMixed, { disabledSkills: ['skill-a', 42, null, 'skill-b'] });
    const mixed = readDisabledSkills();
    expect(mixed.size).toBe(2);
    expect(mixed.has('skill-a')).toBe(true);
  });

  it('既有配置读取不受影响（skillsDir 键同批共存）', () => {
    const dir = mkConfigDir();
    useConfigDir(dir);
    writeConfig(dir, { skillsDir: 'E:/NAS/skills', disabledSkills: ['a'] });
    expect(readConfiguredSkillsDir()).toBe('E:/NAS/skills');
    expect(readDisabledSkills().has('a')).toBe(true);
  });
});
