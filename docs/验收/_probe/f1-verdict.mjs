// F1 复验判据汇总：读最新一份 f1f2-v2-*.json → 出 J1–J7 PASS/FAIL 表
//   node docs/验收/_probe/f1-verdict.mjs [产物路径]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

let file = process.argv[2];
if (!file) {
  const dir = join('docs', '验收', '_probe');
  const files = readdirSync(dir).filter((f) => f.startsWith('f1f2-v2-') && f.endsWith('.json')).sort();
  if (!files.length) { console.error('找不到 f1f2-v2-*.json 产物'); process.exit(2); }
  file = join(dir, files[files.length - 1]);
}
const j = JSON.parse(readFileSync(file, 'utf8'));
const v = j.verdict ?? j;
const api = j.apiRes ?? { status: v.apiStatus, elapsedMs: v.apiElapsedMs, body: v.apiBody };
const hostLast = v.hostLast ?? null;
const audit = j.chatReadAudit ?? [];
const executed = audit.filter((a) => a.outcome === 'executed').length;
const failed = audit.filter((a) => a.outcome !== 'executed').length;
const post = v.j7_post ?? {};

// 三态判定：true→PASS，false→FAIL，**证据缺失(undefined/null)→待测**（绝不当成通过）
const PASS = 'PASS', FAIL = 'FAIL', NA = '待测';
// norm 必须**幂等**：已归一化的 'PASS'/'FAIL'/'待测'/'N/A' 再过一次不能变成「待测」
// （此前踩过：rows 里放的是已归一化字符串，normRows 又过一遍 → 全变待测）
const norm = (x) => (x === true ? PASS : x === false ? FAIL
  : (x === 'N/A' || x === PASS || x === FAIL || x === NA) ? x : NA);
// PM 补充：模型不照做时，J2/J5 会假 FAIL —— 用「页面上真实答案里有没有大写标记」分三档：
//   pageAnswerHasUpper=true  → 模型照做了 → J2/J5 可判
//   pageAnswerHasUpper=false → 模型没服从指令 → 本轮 J2/J5 记「待测」，换一轮重跑（不算实现 FAIL）
//   undefined                 → 证据缺失 → 待测
//
// P10 修正（第四轮踩到、已记入报告）：`pageAnswerHasUpper` 来自 `domUpperHits`，而那条扫描只走
// `#root *` 且带 bbox 过滤；Studio 注入层镜像（`.ds-sc-message-list` / `.ds-sc-msg-assistant`）
// 挂在 document.body 下、在 `#root` 之外 → domUpperHits 恒空 → 得出「模型没照做」的**假阴性**，
// 会把真 FAIL 洗成「待测」。这里改成多源取证：显式扫描 / 宽选择器末节点 / 任一 DOM 采样的
// `wideLastHasUpper`，任一为 true 即认定「模型照做了」（并记录来源，供报告引用）。
const wideSaysUpper = (v.domLast ?? v.domFirst ?? {}).wideLastHasUpper === true
  || (Array.isArray(j.domSamples) && j.domSamples.some((s) => s?.wideLastHasUpper === true));
const modelComplied = v.pageAnswerHasUpper === true || wideSaysUpper ? true
  : (v.pageAnswerHasUpper === false && !wideSaysUpper) ? false : undefined;
const modelCompliedSource = v.pageAnswerHasUpper === true ? 'domUpperHits(document.body 扫描)'
  : wideSaysUpper ? 'wideLastHasUpper(宽选择器，含 Studio 镜像)' : '证据缺失';
// 注意：J2/J4/J5 一律先 norm 成字符串再比较（此前踩过坑：拿布尔值和 'PASS' 字符串比，
//       导致 ssePath 恒 false、SSE 路径永远走不到 N/A 分支，会把 SSE 实现误判成 FAIL）
const J2 = modelComplied === false ? NA
  : norm(v.answerContainsMarker != null ? (v.apiStatus === 200 && v.answerContainsMarker === true) : null);
const J4val = norm(v.ev1_chatReadPayloadShape?.hasSessionField != null ? (v.ev1_chatReadPayloadShape.hasSessionField === true) : null);
// 第五轮新增：镜像是否**增长**（本轮答案的渲染信号）。Core 的判停改成「看 mirrorCount 增量」，
// 所以这里要有对照数：发送前基线（正控那一次）vs 轮询末尾。
const mirrorDelta = (hostLast?.mirrorCount != null && v.positiveControl?.mirrorCount != null)
  ? hostLast.mirrorCount - v.positiveControl.mirrorCount : null;
const J5 = modelComplied === false ? NA
  : norm(hostLast ? (hostLast.ok === true && (hostLast.count ?? 0) > 0 && (hostLast.anyMsgHasUpper === true || hostLast.lastTextHasUpper === true)) : null);
// J6：按 PM 的措辞「不再**连片** execution-failed」判定：
//   → 出现 ≥3 次**连续**失败，或全程 0 次成功，判 FAIL；
//   → 零星失败（不连续）不算「连片」，判 PASS。
//   （原先用 failed===0 严于 PM 的措辞，会把 50 次里偶发 2 次失败判成 FAIL）
// 注意：产物里的 chatReadAudit 已经是**只含 chat-read** 的数组，且条目里没有 tool 字段
// （repro2 落盘时 map 成 {origin,durationMs,outcome}）→ 这里不能再按 tool 过滤，否则恒为空
const chatReadSeq = audit.map((a) => (a.outcome === 'executed' ? 'ok' : 'bad'));
let maxRun = 0, run = 0;
for (const s of chatReadSeq) { if (s === 'bad') { run += 1; maxRun = Math.max(maxRun, run); } else run = 0; }
const J6 = chatReadSeq.length === 0 ? NA : (executed === 0 ? FAIL : (maxRun >= 3 ? FAIL : PASS));
// J7（Studio-PM 2026-10-31 裁定，第五轮起生效）：**数据层为主路径 → J7 记 N/A**
//   裁定依据：正控过；chat-read 采样带 mirrorHasUpper=true；DeepSeek 虚拟列表在该会话只挂
//   3 条注入前导块且 scrollHeight==clientHeight（无占位高度）→ DOM 挂载结构不可行；J4 已 PASS。
//   → 判据：DOM 挂载到本轮标记 = PASS；否则若「数据层可达（mirror 有内容）」且 J4 过 = N/A；
//     数据层不可达 = FAIL。附注（PM）：DOM 挂载能力若是另一条产品需求，另开卡，不在 F1 范围。
const dataLayerAvailable = v.ev1_chatReadPayloadShape?.mirrorInPayload === true
  && (v.ev1_chatReadPayloadShape?.mirrorAssistantTextCount ?? 0) > 0;
const J7 = (post.markerMounted ?? null) != null
  ? (post.markerMounted > 0 ? PASS
     : (dataLayerAvailable && J4val === PASS ? 'N/A' : FAIL))
  : NA;
const rows = [
  ['J1', '不再 120s 超时（短答 < 30s）', v.apiElapsedMs != null ? v.apiElapsedMs < 30000 : NA,
    `status=${v.apiStatus} elapsed=${v.apiElapsedMs}ms  速度线(PM: 短答 ≤15s)=${v.apiElapsedMs != null ? (v.apiElapsedMs <= 15000 ? '达' : '未达') : '-'}`],
  ['J2', 'HTTP 200 且 answer 含本轮答案标记（大写形）', J2,
    `answerContainsMarker=${v.answerContainsMarker} markerUpper=${v.markerUpper ?? '-'} modelComplied=${modelComplied ?? '-'}(${modelCompliedSource}) answerIsUserBubbleOnly=${v.answerIsUserBubbleOnly ?? '-'} mirrorDelta=${mirrorDelta ?? '-'}`],
  ['J3', '不得返回上一轮旧答案', v.answerEqualsPreTurnText != null ? v.answerEqualsPreTurnText !== true : NA,
    `answerEqualsPreTurnText=${v.answerEqualsPreTurnText}`],
  ['J4', 'chat-read 返回带 session/消息标识', J4val,
    `payloadKeys=${JSON.stringify(v.ev1_chatReadPayloadShape?.payloadKeys ?? null)} messageKeys=${JSON.stringify(v.ev1_chatReadPayloadShape?.messageKeys ?? null)}`],
  ['J5', '宿主 chat-read 读到的是 assistant 答案（含大写标记），不是用户气泡', J5,
    hostLast ? `ok=${hostLast.ok} reason=${hostLast.reason ?? '-'} count=${hostLast.count ?? '-'} lastLen=${hostLast.lastTextLen ?? '-'} anyMsgHasUpper=${hostLast.anyMsgHasUpper ?? '-'} lastTextHasUpper=${hostLast.lastTextHasUpper ?? '-'}` : '无采样'],
  ['J6', 'audit 中 chat-read 不再连片 execution-failed', J6,
    `executed=${executed} failed=${failed} 最长连续失败=${maxRun} outcomes=${JSON.stringify(v.chatReadOutcomes ?? {})}`],
  ['J7', '本轮最新消息当时已挂载进 DOM（虚拟列表不挡路）', J7,
    `mountedItems=${post.mountedItems ?? '-'} markerMounted=${post.markerMounted ?? '-'} atBottom=${post.atBottom ?? '-'} scrollTop=${post.vlistScrollTop ?? '-'}/${post.vlistScrollHeight ?? '-'}`],
];

const pad = (s, n) => String(s).padEnd(n);
const normRows = rows.map(([id, name, res, ev]) => [id, name, norm(res), ev]);
console.log('F1 复验判据（' + file + '）');
console.log('------------------------------------------------------------------------------');
for (const [id, name, res, ev] of normRows) console.log(`${pad(id, 4)} ${pad(res, 4)}  ${pad(name, 44)} ${ev}`);
const nFail = normRows.filter((r) => r[2] === FAIL).length;
const nNa = normRows.filter((r) => r[2] === NA).length;
const nPass = normRows.filter((r) => r[2] === PASS).length;
const nNAx = normRows.filter((r) => r[2] === 'N/A').length;
console.log('------------------------------------------------------------------------------');
console.log(`总计 ${rows.length} 项：PASS ${nPass} / FAIL ${nFail} / 待测 ${nNa} / N/A ${nNAx}`);
// 签收线（Studio-PM 钉死）：6 项 PASS + J7「PASS 或 N/A」= 通过；任何 FAIL 或待测都不签
const j7res = normRows.find((r) => r[0] === 'J7')?.[2];
const others = normRows.filter((r) => r[0] !== 'J7');
const othersOk = others.every((r) => r[2] === PASS);
const j7Ok = j7res === PASS || j7res === 'N/A';
const signoff = othersOk && j7Ok;
console.log(`签收线：6 项（除 J7）全 PASS = ${othersOk ? '是' : '否'}；J7 ∈ {PASS, N/A} = ${j7Ok ? '是' : '否'} → **${signoff ? '通过（可签收）' : '不通过（不签收）'}**`);
const bad = normRows.filter((r) => r[2] !== PASS && r[2] !== 'N/A').map((r) => `${r[0]}(${r[2]})`);
if (bad.length) console.log('未达成：' + bad.join(', '));
console.log('整体：' + (signoff ? 'PASS' : 'FAIL'));
console.log('宿主 chat-read 采样（去重后的状态集合）：');
console.log(JSON.stringify(v.hostDistinctStates ?? null));
console.log('页内预取 memory.select：' + JSON.stringify(v.mselSamples ?? null));
console.log('API body：' + String(api.body ?? '').slice(0, 300));
process.exitCode = (nFail === 0 && nNa === 0) ? 0 : 1;
