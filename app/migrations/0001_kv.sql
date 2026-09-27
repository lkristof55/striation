-- The key-value table behind lib/store.mjs on Cloudflare D1: one row per (store, key), the value is JSON text.
-- Stores: recent (state, barrels-view), ref-live (instances), extractions (by-mint/<mint>, by-sig/<signature>).
CREATE TABLE IF NOT EXISTS kv (
  store TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (store, key)
);
