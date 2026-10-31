// 分析抓到的 chat/completion 请求体：抽取「## 已有记忆」块，核对行数/token 预算与信封。
// 用法：node analyze-memsel.mjs <net-capture.json>
import fs from 'node:fs';

const file = process.argv[2];
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
const cap = (j.captures || []).at(-1);
if (!cap || !cap.postData) {
  console.log('NO_POSTDATA');
  process.exit(2);
}
let body;
try {
  body = JSON.parse(cap.postData);
} catch (e) {
  console.log('POSTDATA_NOT_JSON: ' + e.message);
  process.exit(3);
}

// 找到包含记忆块的字符串字段（prompt / messages[].content）
const texts = [];
const walk = (v, path) => {
  if (typeof v === 'string') {
    if (v.includes('已有记忆')) texts.push({ path, text: v });
    return;
  }
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], `${path}.${k}`);
};
walk(body, '$');

// estimateTokens 同口径复刻（src/capabilities/token-cost.ts）
const estimateTokens = (t) => {
  let cjk = 0;
  let other = 0;
  for (const ch of t) {
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
};

const OPEN = '[[STUDIO_UNTRUSTED_MEMORY_OPEN]]';
const CLOSE = '[[STUDIO_UNTRUSTED_MEMORY_CLOSE]]';

const out = { postDataLen: cap.postData.length, wallTime: cap.wallTime, fields: [] };
for (const t of texts) {
  const i = t.text.indexOf('已有记忆');
  const o = t.text.indexOf(OPEN);
  const c = t.text.indexOf(CLOSE);
  const inner = o >= 0 && c > o ? t.text.slice(o + OPEN.length, c) : '';
  const memLines = inner.split('\n').filter((l) => l.startsWith('- #'));
  const lineTokens = memLines.map((l) => ({ tokens: estimateTokens(l), chars: l.length }));
  const totalTokens = lineTokens.reduce((a, b) => a + b.tokens, 0);
  out.fields.push({
    path: t.path,
    hasBlockHeader: i >= 0,
    openAt: o,
    closeAt: c,
    envelopeWellFormed: o >= 0 && c > o,
    memoryLines: memLines.length,
    lineTokens,
    totalTokens,
    rowLimitOk: memLines.length <= 40,
    tokenBudgetOk: totalTokens <= 1800,
    blockHead: t.text.slice(i, Math.min(t.text.length, i + 260)),
  });
}
out.summary = {
  fieldsWithBlock: out.fields.length,
  maxLines: Math.max(0, ...out.fields.map((f) => f.memoryLines)),
  maxTokens: Math.max(0, ...out.fields.map((f) => f.totalTokens)),
};
console.log(JSON.stringify(out, null, 2));
