import test from 'node:test';
import assert from 'node:assert/strict';
import { extract } from '../src/extract.js';
import { match, similarity, barrelId, barrelKey, toInstance, buildReference } from '../src/match.js';
import { summarizeBarrels, describeToken } from '../src/barrels.js';
import { loadReference } from '../src/reference.js';
import { fixture } from './helpers.js';

const j7 = extract(fixture('j7tracker-v0').tx);
const ux = extract(fixture('uxento-followers').tx);
const rl = extract(fixture('rapidlaunch-v1').tx);

test('weighted Jaccard: identity, symmetry, bounds', () => {
  assert.equal(similarity(j7, j7), 1);
  assert.equal(similarity(j7, ux), similarity(ux, j7));
  const s = similarity(j7, rl);
  assert.ok(s >= 0 && s < 1);
  assert.equal(similarity(['cu.limit=1'], ['alt=x']), 0);
  assert.equal(similarity([], []), 0);
});

test('numeric families half-match through the log2 bucket', () => {
  const a = ['cu.limit=300000', 'cu.limit~2^18'];
  const b = ['cu.limit=300001', 'cu.limit~2^18'];
  assert.ok(Math.abs(similarity(a, b) - 1 / 3) < 1e-9);
});

test('optional followers family only counts when both sides have it', () => {
  const a = ['alt=x', 'followers.adjacent=2'];
  assert.equal(similarity(a, ['alt=x']), 1);
  assert.equal(similarity(a, ['alt=x', 'followers.adjacent=0']), 4 / 6);
});

test('barrel id: format, deterministic, coarse', () => {
  const id = barrelId(j7);
  assert.match(id, /^B-[0-9A-HJKMNP-TV-Z]{6}$/);
  assert.equal(barrelId(j7), barrelId(toInstance(j7)));
  assert.notEqual(barrelId(j7), barrelId(ux));
  assert.equal(barrelKey(['version=0', 'xfer.dest=abc']), barrelKey(['version=0', 'xfer.dest=def']), 'destinations are not in the coarse key');
});

test('match against the bundled reference names j7tracker with the stamp hidden', () => {
  const ref = loadReference();
  const r = match(j7, ref);
  assert.equal(r.label, 'j7tracker');
  assert.ok(['match', 'family'].includes(r.verdict));
  assert.ok(r.confidence > 0.5);
  assert.equal(r.neighbours.length, 5);
  assert.ok(!r.neighbours.some((n) => n.mint === j7.meta.mint), 'the query itself is excluded');
  assert.ok(r.striations.some((s) => s.matched));
  for (let i = 1; i < r.neighbours.length; i++) assert.ok(r.neighbours[i - 1].similarity >= r.neighbours[i].similarity);
});

test('unknown when the neighbours are unlabelled, and on an empty reference', () => {
  const unl = buildReference([toInstance(j7), toInstance(ux)].map((i) => ({ ...i, mint: i.mint + 'x', signature: 'x' })));
  assert.equal(match(j7, unl).verdict, 'unknown');
  assert.equal(match(j7, unl).label, null);
  const empty = match(j7, buildReference([]));
  assert.equal(empty.verdict, 'unknown');
  assert.deepEqual(empty.neighbours, []);
});

test('a 10k-instance reference still answers (O(n·t))', () => {
  const ref = loadReference();
  const big = [];
  while (big.length < 10000) big.push(...ref.instances.map((i, k) => ({ ...i, mint: `${i.mint}#${big.length + k}` })));
  const t0 = performance.now();
  const r = match(rl, { instances: big.slice(0, 10000) });
  assert.ok(performance.now() - t0 < 2000);
  assert.equal(r.neighbours.length, 5);
});

test('summarizeBarrels groups by barrel and describes the defining striations', () => {
  const ref = loadReference();
  const rows = summarizeBarrels(ref.instances, { max: 16 });
  assert.ok(rows.length > 0 && rows.length <= 16);
  assert.ok(rows.some((r) => r.label));
  for (const r of rows) {
    assert.match(r.barrelId, /^B-/);
    assert.ok(r.signature.length <= 6);
    assert.ok(r.exemplar?.mint);
  }
  assert.equal(describeToken('cu.price=3333333'), 'CU price 3,333,333 µλ');
  assert.equal(describeToken('tip.lamports=1000000'), 'tip 0.001 SOL');
});
