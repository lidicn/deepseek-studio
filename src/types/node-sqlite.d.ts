/**
 * node:sqlite 最小类型声明（shim）。
 *
 * 背景：运行时是 Node 24（node:sqlite 内置且编译启用 FTS5），
 * 但 devDependency @types/node 是 20.x，尚未包含 node:sqlite 声明。
 * 这里只声明本项目用到的 API 面（DatabaseSync + StatementSync），
 * 避免为拿类型而升级 @types/node（避免无关 churn）。
 * 待 @types/node 升级到 >=22 后可整文件删除。
 */

declare module 'node:sqlite' {
  export type SQLInputValue = null | number | bigint | string | Uint8Array;

  export interface StatementResultingChanges {
    changes: number | bigint;
  }

  export interface StatementSync {
    run(...params: SQLInputValue[]): StatementResultingChanges;
    all(...params: SQLInputValue[]): Record<string, unknown>[];
    get(...params: SQLInputValue[]): Record<string, unknown> | undefined;
  }

  export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
  }

  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
