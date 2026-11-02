/**
 * 审计日志快照加密（M10-10 收口）。
 *
 * 背景：审计表 memory_log 的 before_json / after_json / note 存的是**完整行快照**，
 * 其中包含记忆正文明文。于是「彻底删除记忆」只删了 memories 表的一行，
 * 审计快照却把正文原样留在 .db 文件里 —— 用户删了还能翻出来。
 *
 * 方案：快照落盘前用 AES-256-GCM 加密（前缀 enc1:），密钥存数据库同目录的
 * <db名>.audit.key（32 字节 hex，0600）。读时解密，rollback 依旧可用，
 * 但 .db 文件里只有密文。密钥不可用时降级为明文并 warn（不阻断宿主）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/** 密文前缀。带此前缀 = 密文；不带 = 历史明文（兼容读取）。 */
export const AUDIT_SEAL_PREFIX = 'enc1:';

/**
 * 「解密失败」哨兵（C1 P0-1 / BUG-017）。
 *
 * 背景：原实现在解密失败时 `return null`，与「本来就没有内容」**不可区分**。
 * 后果：`memory/audit.ts` 的 rollback 分支 `if (entry.before) {...} else { deleteMemoryRow(...) }`
 * 会把「before 存在但解不开」误判成「本来就没有 before」→ **本该恢复的操作变成静默删除**，
 * 而且还返回 `{ok:true}`，用户完全看不出发生了什么。
 *
 * 现在：解密失败返回本哨兵，调用方必须显式识别并**拒绝操作**（fail-closed）。
 */
export const AUDIT_DECRYPT_FAILED = Symbol('audit-decrypt-failed');

/** 该值是否为「解密失败」哨兵。 */
export function isAuditDecryptFailed(v: unknown): boolean {
  return v === AUDIT_DECRYPT_FAILED;
}

export interface AuditCrypto {
  /** 密钥是否可用（false 时降级明文）。 */
  readonly available: boolean;
  /** 加密任意可 JSON 序列化的值。 */
  seal(value: unknown): string;
  /**
   * 解密；历史明文按 JSON 解析，解析失败则原样返回字符串。
   * **解密失败返回 `AUDIT_DECRYPT_FAILED` 哨兵**（不是 null）——调用方据此拒绝操作。
   */
  open(text: unknown): unknown;
}

/** 密钥文件路径：与数据库同目录，按库文件名派生（每个 workspace 库一把钥匙）。 */
export function auditKeyPath(dbPath: string): string {
  return path.join(path.dirname(dbPath), `${path.basename(dbPath)}.audit.key`);
}

/**
 * 读取（或创建）审计密钥。
 *
 * C1 P0-1 / BUG-017：**坏钥绝不覆盖**。
 * 原实现遇到格式不对的密钥文件时直接 `writeFileSync` 覆盖写入新钥 ——
 * 旧钥一旦被覆盖，库里所有历史密文就**永久解不开**（不可逆数据丢失），
 * 而且没有任何提示，用户直到某次 rollback 才发现自己回不去了。
 *
 * 现在：坏钥**改名备份为 `<path>.bad`**（保留原始字节供人工恢复），
 * 并**拒绝在本进程内生成新钥顶替**（返回 null → 降级为明文快照并告警），
 * 让历史密文保持原样、不被新的错误密钥污染。
 */
function readOrCreateKey(dbPath: string): Buffer | null {
  const keyPath = auditKeyPath(dbPath);
  try {
    if (fs.existsSync(keyPath)) {
      const hex = fs.readFileSync(keyPath, 'utf8').trim();
      if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
      // 坏钥：改名备份，绝不覆盖。旧密文仍可能用旧钥解开（备份文件保留）。
      const backup = `${keyPath}.bad`;
      console.warn(
        '[memory] audit key file malformed, backing up (NOT overwriting) so history stays recoverable:',
        keyPath,
        '->',
        backup,
      );
      try {
        fs.renameSync(keyPath, backup);
      } catch (e) {
        console.warn(
          '[memory] audit key backup rename failed, refusing to overwrite original:',
          e instanceof Error ? e.message : String(e),
        );
        return null;
      }
      return null;
    }
    const key = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, key.toString('hex'), { mode: 0o600 });
    try {
      fs.chmodSync(keyPath, 0o600);
    } catch {
      /* Windows 上 chmod 有限，忽略 */
    }
    return key;
  } catch (e) {
    console.warn(
      '[memory] audit key unavailable, falling back to plaintext snapshots:',
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

/** 加载（或创建）某个库的审计加密器。 */
export function loadAuditCrypto(dbPath: string): AuditCrypto {
  const key = readOrCreateKey(dbPath);
  if (!key) {
    return {
      available: false,
      seal: (value: unknown) => JSON.stringify(value ?? null),
      open: (text: unknown) => {
        if (typeof text !== 'string' || !text) return null;
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      },
    };
  }
  return {
    available: true,
    seal(value: unknown): string {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const cipherText = Buffer.concat([
        cipher.update(JSON.stringify(value ?? null), 'utf8'),
        cipher.final(),
      ]);
      const packed = Buffer.concat([iv, cipher.getAuthTag(), cipherText]);
      return AUDIT_SEAL_PREFIX + packed.toString('base64');
    },
    open(text: unknown): unknown {
      if (typeof text !== 'string' || !text) return null;
      if (!text.startsWith(AUDIT_SEAL_PREFIX)) {
        // 历史明文：能当 JSON 解析就解析，解析不了当普通文本（note 可能是 "rollback 12"）。
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }
      try {
        const packed = Buffer.from(text.slice(AUDIT_SEAL_PREFIX.length), 'base64');
        const iv = packed.subarray(0, 12);
        const tag = packed.subarray(12, 28);
        const cipherText = packed.subarray(28);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8');
        return JSON.parse(plain);
      } catch (e) {
        console.warn(
          '[memory] audit snapshot decrypt failed:',
          e instanceof Error ? e.message : String(e),
        );
        // C1 P0-1 / BUG-017：返回**哨兵**而不是 null —— 调用方要能区分
        // 「本来就没有内容」与「有内容但解不开」，后者必须拒绝写操作（fail-closed）。
        return AUDIT_DECRYPT_FAILED;
      }
    },
  };
}