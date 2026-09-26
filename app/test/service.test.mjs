// Offline tests of the backend logic in lib/ (the scoring itself is tested in the library, test/ at the repo root).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useStoreDir } from '../lib/store.mjs';

useStoreDir(fs.mkdtempSync(path.join(os.tmpdir(), 'striation-test-')));
const svc = await import('../lib/service.mjs');
const { errorResponse } = await import('../lib/http.mjs');
const bundled = JSON.parse(fs.readFileSync(new URL('../../data/reference.json', import.meta.url)));
const fx = (n) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url)));
const j7 = fx('match-j7tracker');
const MINT = 'A8mrJuGwfX2qxk8cSBiREqe2wLW9JBdSW12kpL48vR69';
const SIG = '28mKmvSnueMAdJksU2BtxiEKLsQHskd5oNfevcYQ7msgAuecH74wKBTN1piUsXxZtVbKWfaFuiLE34gbp1TjJEKP';

test('parseMatchQuery: exactly one of mint | sig, base58 only', () => {
  const p = (q) => svc.parseMatchQuery(new URLSearchParams(q));
  assert.deepEqual(p(`mint=${MINT}`), { kind: 'mint', value: MINT });
  assert.deepEqual(p(`sig=${SIG}`), { kind: 'sig', value: SIG });
  for (const q of ['', `mint=${MINT}&sig=${SIG}`, 'mint=0xabc', 'mint=' + 'l'.repeat(40), `sig=${MINT}`, `mint=${SIG}`, 'mint=%20']) {
    assert.throws(() => p(q), { code: 'BAD_INPUT' }, q);
  }
});

test('parseLimit: 1–40, default 24', () => {
  assert.equal(svc.parseLimit(null), 24);
  assert.equal(svc.parseLimit('1'), 1);
  assert.equal(svc.parseLimit('40'), 40);
  for (const v of ['0', '41', '-1', 'abc', '1.5', '9999']) assert.throws(() => svc.parseLimit(v), { code: 'BAD_INPUT' });
});

test('mergeReference adds stamped live instances once', () => {
  const inst = bundled.instances.find((i) => i.label);
  const extra = { ...inst, mint: 'NewMint1111111111111111111111111111111111', signature: 'x' };
  const m = svc.mergeReference(bundled, [extra, extra, { ...extra, mint: 'U', label: null }, inst]);
  assert.equal(m.size, bundled.size + 1);
  assert.equal(m.stamped, bundled.stamped + 1);
  assert.equal(svc.mergeReference(bundled, []).size, bundled.size);
});

test('barrelMates counts reference + recent window, excludes itself and old items', () => {
  const now = 2_000_000_000;
  const recent = [
    { mint: 'a', barrelId: j7.barrelId, blockTime: now - 60 },
    { mint: 'b', barrelId: j7.barrelId, blockTime: now - 3600 },
    { mint: j7.mint, barrelId: j7.barrelId, blockTime: now },
    { mint: 'c', barrelId: 'B-OTHER0', blockTime: now },
  ];
  const bm = svc.barrelMates(j7, bundled, recent, now);
  assert.equal(bm.recent, 1);
  assert.equal(bm.windowMinutes, 30);
  assert.equal(bm.reference, bundled.instances.filter((i) => i.barrelId === j7.barrelId && i.mint !== j7.mint).length);
  assert.ok(bm.sample.length <= 8 && bm.sample[0].mint === 'a');
});

test('barrelMates sample lists each mint once (recent and reference overlap)', () => {
  const now = 2_000_000_000;
  const refMate = bundled.instances.find((i) => i.barrelId === j7.barrelId && i.mint !== j7.mint);
  assert.ok(refMate, 'fixture has a reference mate');
  const recent = [
    { mint: 'a', barrelId: j7.barrelId, blockTime: now - 60 },
    { mint: 'a', barrelId: j7.barrelId, blockTime: now - 60 },
    { mint: refMate.mint, barrelId: j7.barrelId, blockTime: now - 30 },
  ];
  const mints = svc.barrelMates(j7, bundled, recent, now).sample.map((x) => x.mint);
  assert.equal(new Set(mints).size, mints.length, `duplicates in ${mints.join(',')}`);
  assert.equal(mints[0], 'a');
});

test('feedItem, pruneWindow, barrelCounts', () => {
  const it = svc.feedItem(j7);
  assert.deepEqual(Object.keys(it).sort(), ['barrelId', 'blockTime', 'confidence', 'displayName', 'label', 'mint', 'name', 'signature', 'stamp', 'stampAgrees', 'symbol', 'top', 'verdict'].sort());
  assert.ok(it.top.length <= 3);
  const now = 2_000_000_000;
  const items = [{ signature: 's1', blockTime: now - 10, barrelId: 'B-1', label: 'j7tracker' }, { signature: 's1', blockTime: now - 10, barrelId: 'B-1' }, { signature: 's2', blockTime: now - 5000, barrelId: 'B-2' }, { signature: 's3', blockTime: now - 5, barrelId: 'B-1' }];
  const w = svc.pruneWindow(items, now);
  assert.deepEqual(w.map((i) => i.signature), ['s3', 's1']);
  const bc = svc.barrelCounts(w);
  assert.deepEqual(bc, [{ barrelId: 'B-1', label: 'j7tracker', displayName: 'j7tracker', count: 2, share: 1 }]);
  assert.deepEqual(svc.barrelCounts([]), []);
});

test('featured: only a match whose stamp is absent or agrees, highest confidence wins', () => {
  assert.equal(svc.betterFeatured({ verdict: 'family', confidence: 0.9 }, null), false);
  assert.equal(svc.betterFeatured({ verdict: 'match', confidence: 0.9, stampAgrees: false }, null), false);
  assert.equal(svc.betterFeatured({ verdict: 'match', confidence: 0.8, stampAgrees: null }, null), true);
  assert.equal(svc.betterFeatured({ verdict: 'match', confidence: 0.8 }, { confidence: 0.9 }), false);
  assert.equal(svc.betterFeatured({ verdict: 'match', confidence: 0.8 }, { source: 'fixture', confidence: 1 }), true);
});

test('feedResponse: empty store still has a hero (fixture, labelled)', () => {
  const r = svc.feedResponse({ updatedAt: '2026-09-25T00:00:00Z', items: [], featured: null }, 24);
  assert.equal(r.source, 'fixture');
  assert.equal(r.featured.source, 'fixture');
  assert.ok(r.featured.striations.length > 0);
  assert.deepEqual(r.items, []);
  const withItems = svc.feedResponse({ updatedAt: new Date(j7.blockTime * 1000 + 60_000).toISOString(), items: [{ ...svc.feedItem(j7), tokens: ['a'] }], featured: j7, ratePerMin: 20 }, 24, { code: 'RATE_LIMITED' });
  assert.equal(withItems.source, 'live');
  assert.equal(withItems.stale, true);
  assert.equal(withItems.items[0].tokens, undefined, 'tokens stay server-side');
});

test('stats serves the measured bench results', () => {
  const s = svc.stats();
  for (const k of ['measuredAt', 'machine', 'node', 'command', 'reference', 'accuracy', 'bench']) assert.ok(k in s, k);
  assert.equal(s.accuracy.method, 'leave-one-out, stamps hidden');
});

test('barrelsView works from the bundled reference with an empty store', async () => {
  const b = await svc.barrelsView();
  assert.equal(b.reference.size, bundled.size);
  assert.ok(b.barrels.length > 0 && b.barrels.length <= 16);
  assert.ok(b.reference.labels.every((l) => l.label && l.displayName && l.count > 0));
});

test('errors map to status + code without stacks', async () => {
  const r = errorResponse(Object.assign(new Error('bad'), { code: 'NOT_PUMP_CREATE' }));
  assert.equal(r.status, 422);
  assert.deepEqual(await r.json(), { error: 'bad', code: 'NOT_PUMP_CREATE' });
  const u = errorResponse(new Error('secret internals at /x/y.js:1'));
  assert.equal(u.status, 502);
  assert.deepEqual(await u.json(), { error: 'upstream failure', code: 'UPSTREAM' });
  assert.equal(errorResponse({ code: 'RATE_LIMITED', message: 'slow down' }).status, 429);
});

test('recorded MatchResult has the contract shape', () => {
  for (const k of ['mint', 'signature', 'slot', 'blockTime', 'version', 'name', 'symbol', 'uri', 'via', 'verdict', 'label', 'displayName', 'confidence', 'margin', 'barrelId', 'stamp', 'stampAgrees', 'striations', 'neighbours', 'followers', 'barrelMates', 'source', 'cached', 'ms']) assert.ok(k in j7, k);
  const s = j7.striations[0];
  for (const k of ['id', 'family', 'value', 'display', 'weight', 'matched', 'source']) assert.ok(k in s, k);
  assert.ok(['ix', 'key', 'config', 'args', 'followers', 'meta'].includes(s.source.where));
});

test('one window: /api/barrels recentCount, feed barrels and featured barrelMates agree on the same snapshot', async () => {
  // The 16:34Z bug: /api/barrels said 3 recent creates for a barrel while the featured match of that barrel said 0.
  const end = 1_790_350_000;
  const X = j7.barrelId;
  const item = (mint, ago, barrelId = X) => ({ ...svc.feedItem({ ...j7, mint, signature: `sig-${mint}` }), barrelId, blockTime: end - ago, tokens: j7.striations.map((s) => s.id) });
  const featured = { ...j7, mint: 'F', blockTime: end - 10, source: 'live' };
  const items = [item('F', 10), item('a', 60), item('b', 29 * 60), item('old', 31 * 60), item('c', 120, 'B-OTHER0')];
  const state = { updatedAt: new Date(end * 1000).toISOString(), items, featured };
  const ref = svc.mergeReference(bundled, []);

  const feed = svc.feedResponse(state, 40, null, ref);
  const barrels = svc.barrelsFromState(ref, state);
  const row = barrels.barrels.find((b) => b.barrelId === X);
  const feedCount = feed.barrels.find((b) => b.barrelId === X).count;
  assert.equal(row.recentCount, 3, 'F, a, b; the 31-min-old create is outside the window');
  assert.equal(feedCount, row.recentCount, 'feed barrel bar = /api/barrels');
  assert.equal(feed.featured.barrelMates.recent, row.recentCount - 1, 'barrelMates excludes the match itself');
  assert.equal(feed.featured.barrelMates.windowMinutes, barrels.recentWindow.minutes);
  assert.equal(feed.featured.barrelMates.asOf, barrels.recentWindow.endsAt);
  assert.ok(!feed.items.some((i) => i.mint === 'old'));

  // A stale stored featured (older code, or computed before new mates arrived) is recomputed from the snapshot.
  const staleFeatured = svc.feedResponse({ ...state, featured: { ...featured, barrelMates: { reference: 0, recent: 0, windowMinutes: 30, sample: [] } } }, 40, null, ref);
  assert.equal(staleFeatured.featured.barrelMates.recent, 2);

  // Reading the same snapshot much later gives the same counts (the window ends at updatedAt, not at read time).
  assert.equal(svc.windowEnd(state, end + 3 * 3600), end);
  assert.deepEqual(svc.barrelsFromState(ref, state).barrels, barrels.barrels);

  // barrelsView (the endpoint) reads the stored snapshot and matches too.
  const { getStore } = await import('../lib/store.mjs');
  await (await getStore('recent')).setJSON('state', state);
  const view = await svc.barrelsView();
  assert.equal(view.barrels.find((b) => b.barrelId === X).recentCount, 3);
  assert.equal(view.recentWindow.endsAt, feed.featured.barrelMates.asOf);
  await (await getStore('recent')).delete('state');
});
