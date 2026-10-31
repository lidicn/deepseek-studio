import { DatabaseSync } from "node:sqlite";
const dbPath = process.argv[2];
const sql = process.argv[3];
const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare(sql).all();
console.log(JSON.stringify(rows, null, 0));
db.close();
