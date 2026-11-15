/**
 * scripts/install-pre-commit-hook.mjs — 安装 pre-commit CLAIM 校验钩（⑤，20261115 PM 派卡）
 *
 * 把「PM-LOG 末 40 行内必须有本执行方（$GATE_ACTOR）未 RELEASE 的 CLAIM commit」
 * 写进 .git/hooks/pre-commit。暂存区为空（如 tag 类空提交）直接放行；`--no-verify`
 * 可应急绕过，但按 AGENTS 规约必须事后写日志。幂等：重复安装覆盖同路径。
 * 用法：node scripts/install-pre-commit-hook.mjs
 */

import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const HOOK_SH = `#!/bin/sh
# ⑤ pre-commit CLAIM 校验（20261115 PM 派卡，由 scripts/install-pre-commit-hook.mjs 安装）：
# 暂存区非空 ⇒ PM-LOG.md 末 40 行内必须有本执行方（$GATE_ACTOR）未 RELEASE 的 CLAIM commit 行。
# ⑤ 回炉（20261115 群PM 实弹裁定）：解析必须与**真实人口**同构——真行形态
#   「## @HH:mm CLAIM commit+push 群PM｜…」（前缀＋动作词带 +push＋执行方在 CLAIM 后第 2 token
#   且以「｜」连范围）与合成形态「CLAIM commit <actor> …」都要认；RELEASE 真行
#   「…｜RELEASE <sha> CI run <id> …」用「RELEASE token＋hex 锚（sha/run id）」判，
#   叙述行里的裸 "RELEASE" 三连字（无 hex）不会把锁还上。--no-verify 可应急绕过，须写日志。
staged=$(git diff --cached --name-only | head -n 1)
if [ -z "$staged" ]; then
  exit 0
fi
actor="\${GATE_ACTOR:-unclaimed}"
top=$(git rev-parse --show-toplevel)
log="$top/PM-LOG.md"
if [ ! -f "$log" ]; then
  echo "pre-commit 拦下：PM-LOG.md 不存在（仓根唯一协调日志）。" >&2
  echo "   缺：CLAIM commit $actor（未 RELEASE）。落行后重试；应急 --no-verify 但必须写日志。" >&2
  exit 1
fi
verdict=$(tail -n 40 "$log" | awk -v actor="$actor" '
  {
    hit = 0
    for (i = 1; i <= NF; i++) {
      if ($i == "CLAIM") {
        act = $(i+1); who = $(i+2)
        if (act ~ /^commit/ && index(who, actor) == 1) { hit = 1 }
      }
    }
    if (hit) { claimed = NR; released = 0 }
    if (claimed && NR > claimed && $0 ~ /(^|[^A-Za-z0-9])RELEASE([^A-Za-z0-9]|$)/ && $0 ~ /[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]/) { released = 1 }
  }
  END { if (claimed && !released) print "OK"; else print "BLOCK" }')
if [ "$verdict" != "OK" ]; then
  echo "pre-commit 拦下：PM-LOG.md 末 40 行内没有「CLAIM commit $actor」的未 RELEASE 记录。" >&2
  echo "   落一行：CLAIM commit $actor <时刻> <范围一句话> ——然后重试。" >&2
  echo "   应急可用 --no-verify，但按 AGENTS 必须写日志。" >&2
  exit 1
fi
exit 0
`;

const top = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const hookPath = join(top, '.git', 'hooks', 'pre-commit');
writeFileSync(hookPath, HOOK_SH, { encoding: 'utf8', mode: 0o755 });
console.log(`pre-commit hook installed: ${hookPath}`);
