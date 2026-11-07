/**
 * tools/gate/step-line.ts — 闸门 progress 行统一产出函数（0.14.11 卡 C）
 *
 * 用户口径（20261107）：「同一解析式只对同一产出函数保证一致」。
 * 此前 run.ts 里阻塞 PASS/FAIL、信息级 PASS/FAIL 四处 progress 文案是各自手写的
 * 模板串，形似而非同源 ⇒ 共用一个正则不构成任何保证（PM 第 43 枚）。
 *
 * 现统一经此函数产出，形态 `[name] KIND  secs[  tail]`：
 *  - 解析式 /^\[([^\]]+)\] FAIL/ 对 FAIL 行 round-trip 成立（名字可解回）；
 *  - PASS 行不被 FAIL 正则误命中；
 *  - 源码里 `[PASS]`/`[FAIL]` 字面手写模板串只许出现在这一处（守卫测试断言第二处即红）。
 *
 * 注意：infoLines 的 `[${step.name}] PASS\n${out}` 是另一条产出面（数据载荷、非 progress 行），
 * 不经此函数；解析式对它的保证由"同一段代码里写、同一段代码里读"的局部性给，不跨函数承诺。
 */
export type StepKind = 'PASS' | 'FAIL';

export function stepLine(kind: StepKind, name: string, secs: string, tail: string): string {
  const base = `[${name}] ${kind}  ${secs}s`;
  return tail ? `${base}  ${tail}` : base;
}
