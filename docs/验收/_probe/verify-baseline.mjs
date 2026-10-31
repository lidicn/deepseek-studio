// 清理后只读复核：与取证前备份逐行比对 memories / memories_fts，并查 integrity_check。
import { DatabaseSync } from 'node:sqlite';

const livePath = process.argv[2];
const bakPath = process.argv[3];
const live = new DatabaseSync(livePath, { readOnly: true });
const bak = new DatabaseSync(bakPath, { readOnly: true });

const rows = (db, sql) => db.prepare(sql).all();

const memSql = 'SELECT id, name, type, pinned, tags_json, content, updated_at FROM memories ORDER BY id';
const liveRows = rows(live, memSql);
const bakRows = rows(bak, memSql);

const key = (r) => JSON.stringify(r);
const liveSet = new Set(liveRows.map(key));
const bakSet = new Set(bakRows.map(key));

const onlyLive = liveRows.filter((r) => !bakSet.has(key(r)));
const onlyBak = bakRows.filter((r) => !liveSet.has(key(r)));

const count = (db, sql) => db.prepare(sql).all()[0].n;

const out = {
  integrity: live.prepare('PRAGMA integrity_check').all(),
  live: {
    memories: count(live, 'SELECT COUNT(*) AS n FROM memories'),
    pinned: count(live, 'SELECT COUNT(*) AS n FROM memories WHERE pinned = 1'),
    fts: count(live, 'SELECT COUNT(*) AS n FROM memories_fts'),
    ftsOrphans: count(live, 'SELECT COUNT(*) AS n FROM memories_fts WHERE rowid NOT IN (SELECT rowid FROM memories)'),
    ftsMissing: count(live, 'SELECT COUNT(*) AS n FROM memories WHERE rowid NOT IN (SELECT rowid FROM memories_fts)'),
    memoryLog: count(live, 'SELECT COUNT(*) AS n FROM memory_log'),
    candidates: count(live, 'SELECT COUNT(*) AS n FROM memory_candidates'),
  },
  backup: {
    memories: count(bak, 'SELECT COUNT(*) AS n FROM memories'),
    pinned: count(bak, 'SELECT COUNT(*) AS n FROM memories WHERE pinned = 1'),
    fts: count(bak, 'SELECT COUNT(*) AS n FROM memories_fts'),
    memoryLog: count(bak, 'SELECT COUNT(*) AS n FROM memory_log'),
    candidates: count(bak, 'SELECT COUNT(*) AS n FROM memory_candidates'),
  },
  diff: {
    rowsOnlyInLive: onlyLive.length,
    rowsOnlyInBackup: onlyBak.length,
    onlyLiveSample: onlyLive.slice(0, 3),
    onlyBackupSample: onlyBak.slice(0, 3),
  },
};
console.log(JSON.stringify(out, null, 2));
live.close();
bak.close();
