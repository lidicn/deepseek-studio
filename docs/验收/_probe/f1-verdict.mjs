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
const rows = [
  ['J1', '不再 120s 超时（短答 < 30s）', v.apiElapsedMs != null ? v.apiElapsedMs < 30000 : NA,
    `status=${v.apiStatus} elapsed=${v.apiElapsedMs}ms`],
  ['J2', 'HTTP 200 且 answer 含本轮答案标记（大写形）', v.answerContainsMarker != null ? (v.apiStatus === 200 && v.answerContainsMarker === true) : NA,
    `answerContainsMarker=${v.answerContainsMarker} markerUpper=${v.markerUpper ?? '-'} answerIsUserBubbleOnly=${v.answerIsUserBubbleOnly ?? '-'}`],
  ['J3', '不得返回上一轮旧答案', v.answerEqualsPreTurnText != null ? v.answerEqualsPreTurnText !== true : NA,
    `answerEqualsPreTurnText=${v.answerEqualsPreTurnText}`],
  ['J4', 'chat-read 返回带 session/消息标识', v.ev1_chatReadPayloadShape?.hasSessionField != null ? v.ev1_chatReadPayloadShape.hasSessionField === true : NA,
    `payloadKeys=${JSON.stringify(v.ev1_chatReadPayloadShape?.payloadKeys ?? null)} messageKeys=${JSON.stringify(v.ev1_chatReadPayloadShape?.messageKeys ?? null)}`],
  ['J5', '宿主 chat-read 读到的是 assistant 答案（含大写标记），不是用户气泡', hostLast
    ? (hostLast.ok === true && (hostLast.count ?? 0) > 0 && (hostLast.anyMsgHasUpper === true || hostLast.lastTextHasUpper === true))
    : NA,
    hostLast ? `ok=${hostLast.ok} reason=${hostLast.reason ?? '-'} count=${hostLast.count ?? '-'} lastLen=${hostLast.lastTextLen ?? '-'} anyMsgHasUpper=${hostLast.anyMsgHasUpper ?? '-'} lastTextHasUpper=${hostLast.lastTextHasUpper ?? '-'}` : '无采样'],
  ['J6', 'audit 中 chat-read 不再连片 execution-failed', (executed + failed) > 0 ? (executed > 0 && failed === 0) : NA,
    `executed=${executed} failed=${failed} outcomes=${JSON.stringify(v.chatReadOutcomes ?? {})}`],
  ['J7', '本轮最新消息当时已挂载进 DOM（虚拟列表不挡路）', post.markerMounted != null ? post.markerMounted > 0 : NA,
    `mountedItems=${post.mountedItems ?? '-'} markerMounted=${post.markerMounted ?? '-'} atBottom=${post.atBottom ?? '-'} scrollTop=${post.vlistScrollTop ?? '-'}/${post.vlistScrollHeight ?? '-'}`],
];

const pad = (s, n) => String(s).padEnd(n);
const norm = (x) => (x === true ? PASS : x === false ? FAIL : NA);
const normRows = rows.map(([id, name, res, ev]) => [id, name, norm(res), ev]);
console.log('F1 复验判据（' + file + '）');
console.log('------------------------------------------------------------------------------');
for (const [id, name, res, ev] of normRows) console.log(`${pad(id, 4)} ${pad(res, 4)}  ${pad(name, 44)} ${ev}`);
const nFail = normRows.filter((r) => r[2] === FAIL).length;
const nNa = normRows.filter((r) => r[2] === NA).length;
const nPass = normRows.filter((r) => r[2] === PASS).length;
console.log('------------------------------------------------------------------------------');
console.log(`总计 ${rows.length} 项：PASS ${nPass} / FAIL ${nFail} / 待测 ${nNa}`);
const bad = normRows.filter((r) => r[2] !== PASS).map((r) => `${r[0]}(${r[2]})`);
if (bad.length) console.log('未达成：' + bad.join(', '));
console.log('整体：' + (nFail === 0 && nNa === 0 ? 'PASS' : (nFail > 0 ? 'FAIL' : '待测（证据不全，不可判 PASS）')));
console.log('宿主 chat-read 采样（去重后的状态集合）：');
console.log(JSON.stringify(v.hostDistinctStates ?? null));
console.log('页内预取 memory.select：' + JSON.stringify(v.mselSamples ?? null));
console.log('API body：' + String(api.body ?? '').slice(0, 300));
process.exitCode = (nFail === 0 && nNa === 0) ? 0 : 1;
