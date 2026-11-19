/**
 * 卡㉚（群PM 派卡，2026-11-16）：发布两枚 workflow 的**锚点锁**——判定逻辑在 yml 内联块里，
 * CI 真正执行的是这段文本，抽出 TS 复制品测不到生产路径（群PM 裁定：不抽件）。所以本套件
 * 直接读两枚 yml 原文，断不可改名的字符串锚在位；锚缺＝判定段被改没＝红。
 * 锚清单与 ㉗-b 交卷的四格真跑（logs/gate27-probe.ps1，gitignored）互为表里：CI 内联本体由
 * 本套件锁字面，行为三格（PASS／SELFHEAL_WARN_CONTINUE／FAIL_SELFHEAL_PATCH_4XX／
 * FALLBACK_TAG_ASSET）作发布前人工判据进核对表，不进 CI。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUB = readFileSync(join(REAL_ROOT, '.github', 'workflows', 'release-published.yml'), 'utf8');
const REL = readFileSync(join(REAL_ROOT, '.github', 'workflows', 'release.yml'), 'utf8');

describe('release workflow 锚点锁（卡㉚）', () => {
  it('release-published.yml：Latest 硬判定＋自愈 PATCH 的七枚锚在位', () => {
    // 注入参数（有界重试参数化——卡㉗② 可注入形态）
    expect(PUB).toContain('LATEST_RETRIES');
    expect(PUB).toContain('LATEST_WAIT_SECS');
    // 自愈 PATCH 端点（CI 缺省＝真 API；注入仅供本地真跑）
    expect(PUB).toContain('RELEASE_API_URL');
    // 自愈动作本体：PATCH make_latest=true（AGENTS 发版硬判据② 的机制牙）
    expect(PUB).toContain(`make_latest = 'true'`);
    // 三格 verdict 对应的文案锚
    expect(PUB).toContain('self-heal ok');
    expect(PUB).toContain('make_latest not effective');
    expect(PUB).toContain('falling back to this tag');
  });

  it('release.yml：发布指引两形态（gh api ＋ Invoke-RestMethod）锚在位（含 make_latest=true）', () => {
    expect(REL).toContain('[publish-guide] gh api');
    // 卡㉚-b：curl.exe 被 G-e（release-compose 契约）拦——runner 侧统一 IRM，锚随形态换
    expect(REL).toContain('[publish-guide] Invoke-RestMethod');
    expect(REL).toContain('-F make_latest=true');
  });

  it('release.yml：卡㊱ job 末有界重读步骤在位（拦发版窗口内的绑定翻转，只加格不放宽）', () => {
    // 步本体在位（卡㊿：步名随自愈形态更新，群PM 批准 2026-11-19）
    expect(REL).toContain('Re-assert draft binding at job end (bounded, with self-heal)');
    // 有界参数与判定串（步被删/参数被改即红）
    expect(REL).toContain('[re-assert-bind] attempt');
    expect(REL).toContain('[re-assert-bind] draft tag_name flipped after creation');
    expect(REL).toContain('draft binding re-asserted at job end');
    // 卡㊿ 正向锁（群PM 批准，2026-11-19）：自愈前移后步内**必须**有——
    // ① 重绑 PATCH 本体；② 回读确认；③ fail-closed throw（回读不等照旧撤稿）。
    // 不是删护栏放水：方向从「禁 PATCH」翻成「必须有 PATCH＋必须回读＋必须保兜底」。
    const stepBody = REL.slice(REL.indexOf('Re-assert draft binding at job end'));
    const bodyUptoNext = stepBody.slice(0, stepBody.indexOf('# G3：闸失败必须删掉 draft'));
    expect(bodyUptoNext, '自愈前移后本步必须含重绑 PATCH').toMatch(/-Method Patch/);
    expect(bodyUptoNext, '重绑后必须回读确认').toContain('self-heal verify');
    expect(bodyUptoNext, '回读不等必须 fail-closed throw').toContain('self-heal re-read mismatch');
    // 合成名按前缀形态识别（不按具体 hash——两发合成名不同）
    expect(bodyUptoNext).toContain("-like 'untagged-*'");
    // PATCH 前提：target_commitish 必须校验（target 不对＝真异常，不许自愈）
    expect(bodyUptoNext).toContain('target_commitish -eq $env:COMMIT_SHA');
    // 原有 fail-fast 断言未被放宽（卡㉚-c 定性：判据本身没错，只加格）
    expect(REL).toContain("throw \"draft tag_name '$($rel.tag_name)' != expected '$env:TAG_NAME' — release not bound to git tag, must delete and investigate\"");
  });

  it('漂移锁：make_latest 出现次数为非零（防判定段整体被删后仍被泛匹配放行）', () => {
    const countPub = PUB.split('make_latest').length - 1;
    const countRel = REL.split('make_latest').length - 1;
    expect(countPub, '发布后闸至少含自愈 PATCH 的 make_latest 本体').toBeGreaterThan(0);
    expect(countRel, '发布指引至少含 make_latest=true 一次').toBeGreaterThan(0);
  });
});
