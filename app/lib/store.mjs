// Key-value JSON store: Netlify Blobs on Netlify, Cloudflare D1 on Workers, a folder of JSON files locally.
// scripts/dev.mjs sets STRIATION_STORE_DIR=app/.data; tests can call useStoreDir(tmp). On Netlify it is unset.
// app/worker.mjs calls useD1(env.DB) before any handler runs (table: migrations/0001_kv.sql).
//   const s = await getStore('scans'); await s.setJSON('k', v); await s.get('k'); await s.list({ prefix: 'a/' })
const stores = new Map();
let baseDir = process.env.STRIATION_STORE_DIR || null;
let d1 = null;
let d1MaxBytes = 0;

export function useStoreDir(dir) { baseDir = dir; stores.clear(); }

/** D1's limit is 2,000,000 bytes per row; key, store name and timestamp share the row with the value. */
export const D1_MAX_VALUE_BYTES = 1_990_000;

/** Use a D1 binding (env.DB) for every store. maxValueBytes is only lowered by tests. */
export function useD1(db, { maxValueBytes = D1_MAX_VALUE_BYTES } = {}) {
  if (db === d1 && maxValueBytes === d1MaxBytes) return;
  d1 = db;
  d1MaxBytes = maxValueBytes;
  stores.clear();
}

export class StoreError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// A UTF-8 string is at most 3 bytes per UTF-16 unit, so only long values need the exact byte count.
const byteLength = (text, max) => (text.length * 3 <= max ? text.length : new TextEncoder().encode(text).length);

function d1Store(db, name, maxBytes) {
  return {
    maxValueBytes: maxBytes,
    async get(k) {
      const v = await db.prepare('SELECT value FROM kv WHERE store = ?1 AND key = ?2').bind(name, k).first('value');
      return v == null ? null : JSON.parse(v);
    },
    async setJSON(k, v) {
      const text = JSON.stringify(v);
      const bytes = byteLength(text, maxBytes);
      if (bytes > maxBytes) throw new StoreError(`${name}/${k}: ${bytes} bytes is over the D1 value limit (${maxBytes})`, 'TOO_LARGE');
      await db.prepare('INSERT INTO kv (store, key, value, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (store, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .bind(name, k, text, Date.now()).run();
    },
    async delete(k) {
      await db.prepare('DELETE FROM kv WHERE store = ?1 AND key = ?2').bind(name, k).run();
    },
    async list({ prefix = '' } = {}) {
      // substr() compare, not LIKE: '%' and '_' in a prefix are plain characters
      const { results } = await db.prepare('SELECT key FROM kv WHERE store = ?1 AND substr(key, 1, length(?2)) = ?2 ORDER BY key').bind(name, prefix).all();
      return { blobs: (results || []).map((r) => ({ key: r.key })) };
    },
  };
}

function fileStore(dir) {
  const ready = (async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.mkdir(dir, { recursive: true });
    return { fs, path };
  })();
  const file = async (k) => { const { path } = await ready; return path.join(dir, encodeURIComponent(k) + '.json'); };
  return {
    async get(k) { const { fs } = await ready; try { return JSON.parse(await fs.readFile(await file(k), 'utf8')); } catch { return null; } },
    async setJSON(k, v) { const { fs } = await ready; const f = await file(k); await fs.writeFile(f + '.tmp', JSON.stringify(v)); await fs.rename(f + '.tmp', f); },
    async delete(k) { const { fs } = await ready; await fs.rm(await file(k), { force: true }); },
    async list({ prefix = '' } = {}) {
      const { fs } = await ready;
      const names = await fs.readdir(dir);
      return { blobs: names.filter((n) => n.endsWith('.json')).map((n) => ({ key: decodeURIComponent(n.slice(0, -5)) })).filter((b) => b.key.startsWith(prefix)) };
    },
  };
}

export async function getStore(name) {
  if (stores.has(name)) return stores.get(name);
  let s;
  if (d1) {
    s = d1Store(d1, name, d1MaxBytes);
  } else if (baseDir) {
    const path = await import('node:path');
    s = fileStore(path.join(baseDir, name));
  } else {
    const { getStore: blobs } = await import('@netlify/blobs');
    const b = blobs({ name, consistency: 'strong' });
    s = { get: (k) => b.get(k, { type: 'json' }), setJSON: (k, v) => b.setJSON(k, v), delete: (k) => b.delete(k), list: (o) => b.list(o) };
  }
  stores.set(name, s);
  return s;
}
