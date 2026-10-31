// 清理 C1 探针记忆（主表 + FTS 同步删），只删 name LIKE 'C1-PM-20261031%' 的行。
// 与 src/host/memory-store.ts 的 purge 语义一致：先按 rowid 删 FTS，再删主表。
import { DatabaseSync } from 'node:sqlite';

const dbPath = process.argv[2];
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 8000');

const rows = db.prepare("SELECT rowid AS rid, id, name, pinned FROM memories WHERE name LIKE 'C1-PM-20261031%'").all();
console.log('TARGETS=' + JSON.stringify(rows));
if (rows.length === 0) {
  console.log('NOTHING_TO_DELETE');
} else {
  const delFts = db.prepare('DELETE FROM memories_fts WHERE rowid = ?');
  const delMem = db.prepare('DELETE FROM memories WHERE id = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of rows) {
      delFts.run(r.rid);
      delMem.run(r.id);
    }
    db.exec('COMMIT');
    console.log('DELETED=' + rows.length);
  } catch (e) {
    db.exec('ROLLBACK');
    console.log('ROLLBACK: ' + e.message);
    process.exitCode = 1;
  }
}

const q = (sql) => db.prepare(sql).all();
console.log(
  JSON.stringify({
    memories: q('SELECT COUNT(*) AS n FROM memories')[0].n,
    pinned: q('SELECT COUNT(*) AS n FROM memories WHERE pinned = 1')[0].n,
    fts: q('SELECT COUNT(*) AS n FROM memories_fts')[0].n,
    ftsOrphans: q('SELECT COUNT(*) AS n FROM memories_fts WHERE rowid NOT IN (SELECT rowid FROM memories)')[0].n,
    ftsMissing: q('SELECT COUNT(*) AS n FROM memories WHERE rowid NOT IN (SELECT rowid FROM memories_fts)')[0].n,
    leftover: q("SELECT COUNT(*) AS n FROM memories WHERE name LIKE 'C1-PM-20261031%'")[0].n,
  }),
);
db.close();
