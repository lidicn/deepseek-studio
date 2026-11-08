/**
 * tests/desktop/high-risk-consent.test.ts
 *
 * `isHighRiskConsent` 的**行为级**真值表（2026-11-08 语义挪用修复，用户拍板）。
 *
 * 为什么要有独立文件：Gate 那枚 `authorization-contract.test.ts` 用的是源码文本抠函数体
 * （结构断言），只能证「写的是什么」；本文件直接调纯函数，证「判出来是什么」。
 *
 * 本卡修的是：`hideAllowSession === false`（UI 按钮显隐开关）被当成「要不要走原生框」的判据，
 * 而 shell.exec / python.exec 的 grantScopes 恒含 `session` ⇒ 该字段恒 false ⇒ 全部受治理调用
 * 恒判高风险 ⇒ 长时效授权被误当成风险。**长时效授权只决定「这次同意给多久」，不构成高风险。**
 *
 * 四条事实判据：outside / hardRule / allowConversation / riskFlags。
 * 两条负控（交卷里给了 RED 原文）：加回 hideAllowSession 判据 ⇒ 「工具能力不构成风险」那条红；
 * 删掉 riskFlags 判据 ⇒ 「命中风险模式」那条红。
 */
import { describe, expect, it } from 'vitest';
import { isHighRiskConsentForTest as isHighRiskConsent } from '../../src/host/desktop-host';

describe('isHighRiskConsent · 四条事实判据', () => {
  it('装置自检：被测函数可达（防 import 解析错导致全绿空跑）', () => {
    expect(typeof isHighRiskConsent).toBe('function');
    // 拿一个必然为真的输入做正控，确认函数不是恒 false 的空壳
    expect(isHighRiskConsent({ outside: true })).toBe(true);
  });

  it('① 无任何事实命中 ⇒ 不是高风险（区内、无风险、非硬拒）', () => {
    expect(isHighRiskConsent({})).toBe(false);
    expect(isHighRiskConsent(undefined)).toBe(false);
  });

  it('② 越界（outside）⇒ 高风险', () => {
    expect(isHighRiskConsent({ outside: true })).toBe(true);
  });

  it('③ 命中硬拒（hardRule 非空）⇒ 高风险；空串不算', () => {
    expect(isHighRiskConsent({ hardRule: 'deny-rm-rf' })).toBe(true);
    expect(isHighRiskConsent({ hardRule: '' })).toBe(false);
  });

  it('④ 要发对话级放行（allowConversation）⇒ 高风险', () => {
    expect(isHighRiskConsent({ allowConversation: true })).toBe(true);
  });

  it('⑤ 命中风险模式（riskFlags 非空）⇒ 高风险；空数组不算', () => {
    expect(isHighRiskConsent({ riskFlags: ['recursive-delete'] })).toBe(true);
    expect(isHighRiskConsent({ riskFlags: [] })).toBe(false);
  });
});

describe('isHighRiskConsent · 形态/时效/展示字段不得当判据（本卡修的缺陷）', () => {
  it('⑥ 旧缺陷回归：hideAllowSession=false 本身不构成高风险', () => {
    // 该字段对特权工具恒为 false（grantScopes 恒含 session）⇒ 旧判据恒真 ⇒ 全部受治理调用被
    // 恒判高风险、框型被恒定升级成原生框。**现象层面的归因（用户那次 full 档弹框）留给台账
    // 第⑤件写"待重测"**——full 档在 policy 层是 allow、不进 ask 分支，本判据不参与"弹不弹"。
    expect(isHighRiskConsent({ hideAllowSession: false })).toBe(false);
  });

  it('⑦ 工具「支持会话级放行」不构成高风险（scope 名不是风险事实）', () => {
    // 长时效授权只决定「这次同意给多久」；且该判据恒真（特权工具恒含 session）⇒ 必须不判高风险。
    expect(isHighRiskConsent({ allowedGrantScopes: ['once', 'session', 'temporary'] })).toBe(false);
    expect(isHighRiskConsent({ allowedGrantScopes: ['session'] })).toBe(false);
  });

  it('⑧ 展示字段（riskLabel / riskFlagLabels）不得影响判定', () => {
    expect(isHighRiskConsent({ riskLabel: '特权级' })).toBe(false);
    expect(isHighRiskConsent({ riskFlagLabels: ['递归删除'] })).toBe(false);
  });

  it('⑨ 真实形态回归：特权工具在区内、无风险模式 ⇒ 不是高风险', () => {
    // shell.exec 的实际 meta 形态（hideAllowSession=false + 含 session 的 scope）
    expect(
      isHighRiskConsent({
        riskLabel: '特权级',
        hideAllowSession: false,
        allowedGrantScopes: ['once', 'session', 'temporary'],
        riskFlagLabels: [],
        riskFlags: [],
      }),
    ).toBe(false);
  });

  it('⑩ 但同一条特权调用命中风险模式 ⇒ 仍是高风险（安全面不被本卡放宽）', () => {
    expect(
      isHighRiskConsent({
        riskLabel: '特权级',
        hideAllowSession: false,
        allowedGrantScopes: ['once', 'session', 'temporary'],
        riskFlags: ['recursive-delete'],
        riskFlagLabels: ['递归删除'],
      }),
    ).toBe(true);
  });
});
