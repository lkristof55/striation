// Offline tests of the D1 backend of lib/store.mjs (the Cloudflare store) against test/fake-d1.mjs, which runs
// the real SQL on node:sqlite. The same behaviour suite runs against the local file store, so the three
// backends (Netlify Blobs, files, D1) answer get / setJSON / delete / list({ prefix }) alike.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeD1 } from './fake-d1.mjs';
import { useD1, useStoreDir, getStore, D1_MAX_VALUE_BYTES } from '../lib/store.mjs';

const schema = fs.readFileSync(new URL('../migrations/0001_kv.sql', import.meta.url), 'utf8');
const bundled = JSON.parse(fs.readFileSync(new URL('../../data/reference.json', import.meta.url)));
const fileBackend = () => { useD1(null); useStoreDir(fs.mkdtempSync(path.join(os.tmpdir(), 'striation-store-'))); };
const d1Backend = (opts) => { const db = createFakeD1(schema); useD1(db, opts); return db; };

async function behaviour() {
  const s = await getStore('extractions');
  assert.equal(await s.get('by-mint/none'), null, 'missing key → null');
  await s.setJSON('by-mint/a', { at: 1, ex: { name: 'é ▇▇▇', n: [1, 2] } });
  assert.deepEqual(await s.get('by-mint/a'), { at: 1, ex: { name: 'é ▇▇▇', n: [1, 2] } });
  await s.setJSON('by-mint/a', [3]);
  assert.deepEqual(await s.get('by-mint/a'), [3], 'setJSON overwrites');
  assert.equal(await (await getStore('recent')).get('by-mint/a'), null, 'stores are separate namespaces');
  for (const k of ['by-mint/b', 'by-sig/a', 'by_mint/x', 'by%mint/y', 'byXmint/z', '100%/a', '100x/a']) await s.setJSON(k, 1);
  const keys = async (o) => (await s.list(o)).blobs.map((b) => b.key).sort();
  assert.deepEqual(await keys({ prefix: 'by-mint/' }), ['by-mint/a', 'by-mint/b']);
  assert.deepEqual(await keys({ prefix: 'by_mint/' }), ['by_mint/x'], '_ is not a wildcard');
  assert.deepEqual(await keys({ prefix: 'by%' }), ['by%mint/y'], '% is not a wildcard');
  assert.deepEqual(await keys({ prefix: '100%' }), ['100%/a']);
  assert.equal((await keys({ prefix: '' })).length, 8);
  assert.equal((await keys()).length, 8);
  assert.deepEqual((await (await getStore('ref-live')).list()).blobs, []);
  await s.delete('by-mint/a');
  await s.delete('never-set');
  assert.equal(await s.get('by-mint/a'), null);
  assert.deepEqual(await keys({ prefix: 'by-mint/' }), ['by-mint/b']);
}

test('file store: get / setJSON / delete / list({ prefix })', async () => { fileBackend(); await behaviour(); });

test('D1 store: the same semantics through prepare().bind().first()/all()/run()', async () => {
  const db = d1Backend();
  await behaviour();
  assert.ok(db.calls.every((sql) => !/\bLIKE\b/i.test(sql)), 'prefix listing never uses LIKE');
  const row = db.sqlite.prepare('SELECT store, key, typeof(value) AS t, updated_at FROM kv WHERE key = ?').get('by-mint/b');
  assert.equal(row.store, 'extractions');
  assert.equal(row.t, 'text');
  assert.ok(row.updated_at > 1_700_000_000_000);
});

test('D1 store: a value over the D1 limit is rejected (TOO_LARGE), counted in UTF-8 bytes', async () => {
  d1Backend({ maxValueBytes: 1000 });
  const s = await getStore('recent');
  await s.setJSON('ok', 'x'.repeat(900));
  await assert.rejects(s.setJSON('big', 'x'.repeat(1200)), { code: 'TOO_LARGE' });
  await assert.rejects(s.setJSON('wide', '▇'.repeat(400)), { code: 'TOO_LARGE' }, '400 chars but 1,200 bytes');
  assert.equal(await s.get('big'), null);
  assert.equal(D1_MAX_VALUE_BYTES <= 2_000_000, true);
});

test('setBounded keeps the newest entries of a list the store rejects as too large', async () => {
  d1Backend({ maxValueBytes: 5000 });
  const svc = await import('../lib/service.mjs');
  const s = await getStore('ref-live');
  const list = Array.from({ length: 100 }, (_, i) => ({ i, pad: 'x'.repeat(90) }));
  const warn = console.warn; console.warn = () => {};
  try { await svc.setBounded(s, 'instances', list); } finally { console.warn = warn; }
  const kept = await s.get('instances');
  assert.ok(kept.length > 0 && kept.length < 100 && JSON.stringify(kept).length <= 5000);
  assert.deepEqual(kept.map((x) => x.i), list.slice(0, kept.length).map((x) => x.i), 'newest first, oldest dropped');
  await svc.setBounded(s, 'state', list.slice(0, 3), (items) => ({ updatedAt: 'now', items }));
  assert.deepEqual((await s.get('state')).items.map((x) => x.i), [0, 1, 2]);
});

test('the documents the app stores stay below the D1 value limit at their caps (setBounded guards the rest)', async () => {
  const svc = await import('../lib/service.mjs');
  const bytes = (v) => Buffer.byteLength(JSON.stringify(v));
  const biggest = [...bundled.instances].sort((a, b) => bytes(b) - bytes(a))[0];
  // ref-live: REF_LIVE_CAP stamped instances, every one as big as the biggest recorded instance
  assert.ok(bytes(Array(svc.REF_LIVE_CAP).fill(biggest)) < D1_MAX_VALUE_BYTES / 2);
  // recent/state: RECENT_CAP feed items with the biggest token list and 32-char names, plus a featured MatchResult
  const j7 = JSON.parse(fs.readFileSync(new URL('./fixtures/match-j7tracker.json', import.meta.url)));
  const item = { ...svc.feedItem(j7), name: 'n'.repeat(32), symbol: 's'.repeat(10), tokens: biggest.tokens };
  // (≈ 1.0 MB at the 600-item cap; on Cloudflare the window holds ≤ refreshMax × 7 items, ≤ 126)
  assert.ok(bytes({ updatedAt: j7.recordedAt, items: Array(svc.RECENT_CAP).fill(item), featured: j7 }) < D1_MAX_VALUE_BYTES * 0.6);
  // one extraction and the barrels view are single small documents
  assert.ok(bytes(j7) < 100_000);
});
