/**
 * atomic-write.ts — 原子写（temp + rename），PM 裁定二十二 ③ 的共享 helper
 *
 * **为什么必须有**：`writeFileSync` 直接写目标文件时，磁盘满 / 进程被杀 / 断电会留下
 * **半截文件**。对本仓的后果不是「文件坏了」这么笼统 —— 它接上 `loadMcpServers` 的
 * catch 会把半截 JSON 读成 `{}`（「一台都没有」），用户随后保存一台，`saveServer`
 * 又从空表起写 → **其余配置全部静默丢失**（2026-11-06 串起来的那条链）。
 *
 * 判据（PM 定稿）：
 *   1. **关键文件写入必须原子**：先写同目录临时文件，再 `rename` 覆盖目标；
 *   2. `rename` 是**单文件系统操作**，要么看到旧文件、要么看到新文件，**没有半截态**。
 *
 * 三条实现细节（每条都有对应单测）：
 *   - **临时文件必须与目标同目录**：跨卷/跨设备 `rename` 会 `EXDEV` 失败；
 *   - **临时文件用同一 `mode` 创建**：`rename` 保留临时文件的权限位，否则 `0o600`
 *     的密钥文件会变成默认权限（安全回退）；
 *   - **失败必须清理临时文件**：否则崩溃几轮后在用户目录留下一堆 `.tmp-*` 垃圾
 *     （装版「首启干净」的反面）。
 *
 * Windows 说明：`fs.renameSync` 在 Windows 上走 `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`，
 * **可以覆盖已存在的目标**，所以不需要「先 unlink 再 rename」——那反而制造了一个
 * 「删掉了但没写成功」的危险窗口。
 *
 * **`mode` 的三条免责说明（PM 裁定二十四 ④，2026-11-06）**：
 *   1. 这里的 `mode` 只用于**对齐 POSIX 语义**（同目录临时文件以同一 mode 创建，
 *      `rename` 保留其权限位，避免 `0600` 的密钥文件回落成默认权限）；
 *   2. **Windows 上 `mode` 基本不生效，不得把它当作权限边界**——本仓 CI 与目标平台
 *      都是 `windows-latest`/Windows，据此认为「文件已被保护」是错的；
 *   3. 密钥类文件的真实保护手段是**不落明文副本 + 目录 ACL**，与 `mode` 无关。
 *      （对应的 `mode 0600` 断言在单测里按平台跳过，跳过行注明「本仓任何 runner
 *      都不会执行此断言」，避免下一个人以为 Linux 上有覆盖。）
 */

import fs from 'node:fs';
import path from 'node:path';

export interface AtomicWriteOptions {
  /** 目标文件权限（POSIX 语义；Windows 上仅部分生效）。默认 `0o600`（配置类文件）。 */
  mode?: number;
  encoding?: BufferEncoding;
}

/** 进程内自增，保证并发写同一目标时临时名不撞。 */
let tmpCounter = 0;

/** 目标对应的临时文件路径（同目录、隐藏前缀、带 pid 与序号）。 */
export function tmpPathFor(filePath: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  tmpCounter += 1;
  return path.join(dir, `.${base}.tmp-${process.pid}-${tmpCounter}`);
}

/**
 * 原子写字符串/字节到文件。
 *
 * 失败时：**清理临时文件并抛出**（调用方据此决定「拒绝覆写」还是降级），
 * 目标文件保持原样 —— 「写失败」永远不会让目标变成半截。
 */
export function writeFileAtomicSync(
  filePath: string,
  data: string | Buffer,
  opts: AtomicWriteOptions = {},
): void {
  const mode = opts.mode ?? 0o600;
  const tmp = tmpPathFor(filePath);
  let tmpCreated = false;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // 同目录 + 同 mode 创建（rename 保留权限位）
    fs.writeFileSync(tmp, data, { mode, encoding: opts.encoding ?? 'utf8' });
    tmpCreated = true;
    fs.renameSync(tmp, filePath);
    tmpCreated = false;
  } catch (e) {
    if (tmpCreated) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // 清理失败不能掩盖原始错误；残留的 .tmp-* 由专项清理负责
      }
    }
    throw e;
  }
}

/** JSON 原子写（2 空格缩进，与仓内既有配置文件格式一致）。 */
export function writeJsonAtomicSync(
  filePath: string,
  value: unknown,
  opts: AtomicWriteOptions = {},
): void {
  writeFileAtomicSync(filePath, `${JSON.stringify(value, null, 2)}\n`, opts);
}
