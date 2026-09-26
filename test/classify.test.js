import test from 'node:test';
import assert from 'node:assert/strict';
import { createRpc } from '../src/rpc.js';
import { classify, findCreate, pollCreates, inputKind } from '../src/classify.js';
import { loadReference } from '../src/reference.js';
import { fixture, stubFetch } from './helpers.js';

const ux = fixture('uxento-followers');
const j7 = fixture('j7tracker-v0');

test('inputKind validates mints and signatures', () => {
  assert.equal(inputKind(ux.mint), 'mint');
  assert.equal(inputKind(j7.tx.transaction.signatures[0]), 'sig');
  assert.equal(inputKind('not-an-address'), null);
  assert.equal(inputKind(''), null);
  assert.equal(inputKind(undefined), null);
});

test('mint path: one getTransactionsForAddress call finds the create and its followers', async () => {
  const calls = {};
  const rpc = createRpc('http://stub', { fetch: stubFetch({ getTransactionsForAddress: () => ({ data: [ux.tx] }) }, calls) });
  const r = await classify(rpc, ux.mint, loadReference(), { metadata: false });
  assert.equal(r.mint, ux.mint);
  assert.deepEqual(calls, { getTransactionsForAddress: 1 });
  assert.ok(['match', 'family', 'unknown'].includes(r.verdict));
  assert.equal(typeof r.stampAgrees, 'boolean');
});

test('standard-RPC fallback when getTransactionsForAddress is missing', async () => {
  const sig = j7.tx.transaction.signatures[0];
  const rpc = createRpc('http://stub', { fetch: stubFetch({
    getSignaturesForAddress: () => [{ signature: sig, err: null }],
    getTransaction: () => j7.tx,
  }) });
  const ex = await findCreate(rpc, j7.mint, { metadata: false });
  assert.equal(ex.meta.signature, sig);
});

test('errors: brand-new mint with no txs, malformed input, not a create', async () => {
  const empty = createRpc('http://stub', { fetch: stubFetch({ getTransactionsForAddress: () => ({ data: [] }) }) });
  await assert.rejects(findCreate(empty, ux.mint, { metadata: false }), { code: 'NOT_FOUND' });
  await assert.rejects(findCreate(empty, 'xyz', { metadata: false }), { code: 'BAD_INPUT' });
  const other = createRpc('http://stub', { fetch: stubFetch({ getTransactionsForAddress: () => ({ data: [j7.tx] }) }) });
  await assert.rejects(findCreate(other, ux.mint, { metadata: false }), { code: 'NOT_PUMP_CREATE' });
  const none = createRpc('http://stub', { fetch: stubFetch({ getTransaction: () => null }) });
  await assert.rejects(findCreate(none, j7.tx.transaction.signatures[0], { metadata: false }), { code: 'NOT_FOUND' });
});

test('429 is retried, then reported as RATE_LIMITED', async () => {
  let n = 0;
  const f = async () => { n++; return { ok: false, status: 429, json: async () => ({}) }; };
  const rpc = createRpc('http://stub', { fetch: f, retries: 1 });
  await assert.rejects(rpc.call('getTransaction', []), { code: 'RATE_LIMITED' });
  assert.equal(n, 2);
});

test('pollCreates: skips failed and known signatures, caps new txs, batches of 10', async () => {
  const sigs = Array.from({ length: 40 }, (_, i) => ({ signature: `sig${i}`, err: i % 10 === 9 ? { x: 1 } : null, blockTime: 1000 + 40 - i }));
  const calls = {};
  const rpc = createRpc('http://stub', { fetch: stubFetch({ getSignaturesForAddress: () => sigs, getTransaction: () => ux.tx }, calls) });
  const r = await pollCreates(rpc, { limit: 40, max: 18, known: new Set(['sig0', 'sig1']), gapMs: 0 });
  assert.equal(r.fresh.length, 18);
  assert.ok(!r.fresh.some((f) => f.sig.signature === 'sig0' || f.sig.err));
  assert.equal(calls.getTransaction, 18);
  assert.equal(r.failed, 4);
  assert.ok(r.ratePerMin > 0);
});
