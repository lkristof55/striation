// A small in-memory stand-in for a Cloudflare D1 binding (env.DB): the calls lib/store.mjs makes
// (prepare → bind → first / all / run) over node:sqlite, so the SQL runs on SQLite, as it does on D1.
// Used by test/store-d1.test.mjs and test/worker.test.mjs. Not a test file itself (no .test. in the name).
import { DatabaseSync } from 'node:sqlite';

export function createFakeD1(schemaSql = '') {
  const db = new DatabaseSync(':memory:');
  if (schemaSql) db.exec(schemaSql);
  const calls = [];
  const plain = (row) => (row ? { ...row } : null);
  const statement = (sql, params = []) => ({
    bind: (...values) => statement(sql, values),
    async first(column) {
      calls.push(sql);
      const row = plain(db.prepare(sql).get(...params));
      return column ? (row?.[column] ?? null) : row;
    },
    async all() {
      calls.push(sql);
      return { success: true, results: db.prepare(sql).all(...params).map(plain), meta: {} };
    },
    async run() {
      calls.push(sql);
      const r = db.prepare(sql).run(...params);
      return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return { prepare: (sql) => statement(sql), async exec(sql) { db.exec(sql); return { count: 1 }; }, calls, sqlite: db };
}
