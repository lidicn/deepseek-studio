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
# 暂存区非空 ⇒ 控制面台账须有本执行方未销锁的 CLAIM commit。
# 卡⑱（群PM 派卡，20261116）：**判据单一真相**——钩不再自己 awk 解析台账（旧 awk 判
#   "同行含 RELEASE 字样＋任意 7 位 hex 即销锁"，一句叙述带 HEAD=sha 就能假装锁不存在，
#   群PM 15:40 合法提交被误拦＝活案例），改调 tools/gate/lock-pairing.ts --check-claim
#   （严格 A/B 两型收口＋结构式前缀，叙述行不得销锁）。窗口＝自最近真收口行起（不是末 40 行，
#   CLAIM 被挤到窗口外的第二个绕过面已消除）。--no-verify 可应急绕过，须写日志。
staged=$(git diff --cached --name-only | head -n 1)
if [ -z "$staged" ]; then
  exit 0
fi
actor="\${GATE_ACTOR:-}"
if [ -z "$actor" ]; then
  actorNote="未设 GATE_ACTOR——按任一在册执行方（群PM／私聊PM）的未还锁 CLAIM 判"
else
  actorNote="按执行方 $actor 精确隔离"
fi
top=$(git rev-parse --show-toplevel)
log="$top/PM-LOG.md"
if [ ! -f "$log" ]; then
  echo "pre-commit 拦下：PM-LOG.md 不存在（仓根唯一协调日志）。$actorNote" >&2
  echo "   落一行：CLAIM commit <执行方> <时刻> <范围一句话>（执行方＝群PM 或 私聊PM）——然后重试。" >&2
  echo "   应急可用 --no-verify，但按 AGENTS 必须写日志。" >&2
  exit 1
fi
if [ -z "$actor" ]; then
  verdict=$(npx tsx tools/gate/lock-pairing.ts --pmlog "$log" --check-claim "" 2>&1 >/dev/null; echo "EXIT=$?")
else
  verdict=$(npx tsx tools/gate/lock-pairing.ts --pmlog "$log" --check-claim "$actor" 2>&1 >/dev/null; echo "EXIT=$?")
fi
case "$verdict" in
  *EXIT=0*)
    exit 0
    ;;
  *)
    echo "pre-commit 拦下：PM-LOG.md 内没有未销锁的 CLAIM commit 记录。$actorNote" >&2
    echo "$verdict" | sed 's/^/   /' >&2
    echo "   应急可用 --no-verify，但按 AGENTS 必须写日志。" >&2
    exit 1
    ;;
esac
`;

const top = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const hookPath = join(top, '.git', 'hooks', 'pre-commit');
writeFileSync(hookPath, HOOK_SH, { encoding: 'utf8', mode: 0o755 });
console.log(`pre-commit hook installed: ${hookPath}`);
