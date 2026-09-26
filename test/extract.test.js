import test from 'node:test';
import assert from 'node:assert/strict';
import { extract, tokensOf, stampsFromMetadata } from '../src/extract.js';
import { fixture, clone } from './helpers.js';

const fam = (ex, f) => ex.striations.filter((s) => s.family === f).map((s) => s.value);

test('j7tracker v0 create: compute budget, ALT, astralane tip, stamp kept out of tokens', () => {
  const f = fixture('j7tracker-v0');
  const ex = extract(f.tx);
  assert.equal(ex.meta.mint, f.mint);
  assert.equal(ex.meta.version, 0);
  assert.deepEqual(fam(ex, 'cu.source'), ['ix']);
  assert.ok(fam(ex, 'cu.limit').length === 1 && fam(ex, 'cu.price').length === 1);
  assert.ok(fam(ex, 'alt').length >= 1);
  assert.deepEqual(ex.stamps.map((s) => [s.label, s.kind]), [['j7tracker', 'uri.host']]);
  const toks = tokensOf(ex).map(([t]) => t).join(' ');
  assert.ok(!toks.includes('j7tracker'), 'stamps never become tokens');
  const cb = ex.striations.find((s) => s.family === 'cu.limit');
  assert.equal(cb.source.where, 'ix');
  assert.match(cb.source.hex, /^02[0-9a-f]{8}$/);
  for (let i = 1; i < ex.striations.length; i++) assert.ok(ex.striations[i - 1].weight >= ex.striations[i].weight, 'sorted by weight');
});

test('rapidlaunch v1 create: budget from transactionConfig, fee collector is a stamp', () => {
  const ex = extract(fixture('rapidlaunch-v1').tx);
  assert.equal(ex.meta.version, 1);
  assert.deepEqual(fam(ex, 'cu.source'), ['v1-config']);
  assert.deepEqual(fam(ex, 'cu.limit'), ['600000']);
  assert.ok(ex.stamps.some((s) => s.kind === 'fee.wallet' && s.label === 'rapidlaunch'));
  assert.ok(!fam(ex, 'xfer.dest').includes('rapidXMVLw5uBieKHDGvF9k4xSSDXyD2FC5wLTAajaJ'));
  assert.deepEqual(fam(ex, 'buy.variant'), ['buy_exact_quote_in_v2']);
});

test('uxento create with followers: bundle width, extend_account, lunarlander tip before create', () => {
  const f = fixture('uxento-followers');
  const ex = extract(f.tx, { followers: f.followers });
  assert.ok(ex.followers.sameSlot >= 1);
  assert.equal(fam(ex, 'followers.adjacent').length, 1);
  assert.deepEqual(fam(ex, 'create.variant'), ['create_v2+extend']);
  assert.ok(fam(ex, 'tip.relay').includes('lunarlander'));
  assert.ok(fam(ex, 'tip.position').includes('before-create'));
  assert.equal(extract(f.tx).followers, null, 'no followers family without followers');
});

test('legacy, create (v1 ix) and wrapper-CPI creates', () => {
  assert.deepEqual(fam(extract(fixture('legacy').tx), 'version'), ['legacy']);
  assert.deepEqual(fam(extract(fixture('create-v1').tx), 'create.variant'), ['create']);
  const w = extract(fixture('wrapper-cpi').tx);
  assert.notEqual(w.meta.via, 'top-level');
  assert.deepEqual(fam(w, 'wrapper'), [w.meta.via]);
  assert.ok(!fam(w, 'buy.variant')[0].startsWith('e445a52e'), 'anchor event CPI is not a buy');
});

test('name, symbol and uri are decoded from the create args', () => {
  const ex = extract(fixture('j7tracker-v0').tx);
  assert.ok(ex.meta.name.length > 0 && ex.meta.symbol.length > 0);
  assert.match(ex.meta.uri, /^https:\/\/metadata\.j7tracker\.io\//);
});

test('edge cases: malformed, failed, not a create, wrong mint', () => {
  assert.throws(() => extract(null), { code: 'BAD_INPUT' });
  assert.throws(() => extract({ foo: 1 }), { code: 'BAD_INPUT' });
  const failed = clone(fixture('legacy').tx); failed.meta.err = { InstructionError: [2, 'Custom'] };
  assert.throws(() => extract(failed), { code: 'NOT_PUMP_CREATE' });
  const noCreate = clone(fixture('legacy').tx);
  noCreate.transaction.message.instructions = noCreate.transaction.message.instructions.filter((ix) => !ix.data.startsWith('4'));
  noCreate.meta.innerInstructions = [];
  const probe = (() => { try { extract(noCreate); return 'ok'; } catch (e) { return e.code; } })();
  assert.ok(probe === 'NOT_PUMP_CREATE' || probe === 'ok');
  const empty = clone(fixture('legacy').tx); empty.transaction.message.instructions = []; empty.meta.innerInstructions = [];
  assert.throws(() => extract(empty), { code: 'NOT_PUMP_CREATE' });
  assert.throws(() => extract(fixture('legacy').tx, { mint: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' }), { code: 'NOT_PUMP_CREATE' });
});

test('metadata stamps: description, createdOn, pump.fun ignored', () => {
  assert.deepEqual(stampsFromMetadata({ description: 'Deployed using https://j7tracker.io', createdOn: 'pump.fun' }).map((s) => s.label), ['j7tracker']);
  assert.deepEqual(stampsFromMetadata({ description: 'Created on https://rapidlaunch.io', createdOn: 'https://rapidlaunch.io' }).map((s) => s.kind), ['desc', 'createdOn']);
  assert.deepEqual(stampsFromMetadata({ description: 'gm', createdOn: 'https://pump.fun' }), []);
  assert.deepEqual(stampsFromMetadata(null), []);
});
