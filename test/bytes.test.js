import test from 'node:test';
import assert from 'node:assert/strict';
import { b58decode, hex, sha256, crockford, borshString, u64le, BASE58_ADDRESS, BASE58_SIGNATURE } from '../src/bytes.js';

test('base58 decodes ComputeBudget and System ix data', () => {
  assert.equal(hex(b58decode('Kq1GWK')), '02e0930400'); // SetComputeUnitLimit 300000
  assert.equal(hex(b58decode('3qEGrGUXVibh')), '03d5dc320000000000'); // SetComputeUnitPrice 3333333
  assert.equal(hex(b58decode('3Bxs4d289AHpW9rF')), '02000000d834980000000000'); // transfer 9,975,000
  assert.equal(hex(b58decode('11111111111111111111111111111111')), '00'.repeat(32));
  assert.equal(b58decode('').length, 0);
  assert.throws(() => b58decode('0OIl'));
});

test('little-endian u64 and borsh strings', () => {
  assert.equal(u64le(b58decode('3Bxs4d289AHpW9rF'), 4), 9975000);
  const s = new Uint8Array([3, 0, 0, 0, 0x31, 0x30, 0x4d]);
  assert.deepEqual(borshString(s, 0), ['10M', 7]);
  assert.throws(() => borshString(new Uint8Array([255, 255, 0, 0]), 0));
});

test('sha256 matches FIPS vectors', () => {
  assert.equal(hex(sha256('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(hex(sha256('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(hex(sha256('global:create_v2'), 8), 'd6904cec5f8b31b4');
});

test('crockford base32 alphabet and length', () => {
  const c = crockford(sha256('x'), 6);
  assert.match(c, /^[0-9A-HJKMNP-TV-Z]{6}$/);
  assert.equal(crockford(new Uint8Array([0, 0, 0, 0]), 6), '000000');
  assert.equal(crockford(new Uint8Array([255, 255, 255, 255]), 6), 'ZZZZZZ');
});

test('address and signature patterns', () => {
  assert.ok(BASE58_ADDRESS.test('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'));
  assert.ok(!BASE58_ADDRESS.test('0xdeadbeef'));
  assert.ok(!BASE58_ADDRESS.test('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'.replace('6', 'l')));
  assert.ok(BASE58_SIGNATURE.test('28mKmvSnueMAdJksU2BtxiEKLsQHskd5oNfevcYQ7msgAuecH74wKBTN1piUsXxZtVbKWfaFuiLE34gbp1TjJEKP'));
});
