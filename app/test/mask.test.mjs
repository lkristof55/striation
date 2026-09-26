// Offline tests of the slur mask on symbols/names (lib/mask.mjs) and where it is applied, plus a hygiene
// check on the app's recorded data. Offensive test inputs are written ROT13 (the same encoding the
// library's src/mask.js keeps its list in), so this file never spells a slur.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useStoreDir } from '../lib/store.mjs';
import { isOffensive, maskText, maskDeep, MASK } from '../lib/mask.mjs';
import { rot13, isMasked } from '../../src/mask.js';

useStoreDir(fs.mkdtempSync(path.join(os.tmpdir(), 'striation-mask-')));
const svc = await import('../lib/service.mjs');
const j7 = JSON.parse(fs.readFileSync(new URL('./fixtures/match-j7tracker.json', import.meta.url)));
const bad = (enc) => rot13(enc);
const app = (p) => new URL(`../${p}`, import.meta.url);

// Real pump.fun create symbols/names seen in the live feed on 2026-09-25 (16:34Z–16:39Z), ROT13.
const LIVE_SYMBOL = bad('SNT');
const LIVE_SYMBOL_2 = bad('Avtnalnuh');
const LIVE_NAME_2 = bad('Orawnzva Avttnalnuh');
const LIVE_NAME_3 = bad('Obbgf Gur Cbepu Zbaxrl');

test('masks the slurs seen in the live feed on 2026-09-25', () => {
  for (const s of [LIVE_SYMBOL, LIVE_SYMBOL_2, LIVE_NAME_2, LIVE_NAME_3]) assert.equal(maskText(s), MASK, rot13(s));
  assert.equal(maskText('Cigarette'), 'Cigarette', 'only the offending field is masked');
});

test('normalisation defeats case, leetspeak, spacing, stretching, homoglyphs, fullwidth and zero-width', () => {
  const evasions = ['snt', 'SNT', '$SNT', 's n t', 'S.N.T', 's@t', 'avttn', 'a1ttn', 'A!TT4', 'a v t t n', 'avvvvttnnnn',
    'avt tre', 'FNAQAVTTRE', 'S N T T B G', 'cbepu_zbaxrl', 'C0EPU Z0AXRL', 'Xvxrf', 'PUVAX'].map(bad);
  evasions.push(
    bad('S') + 'а' + bad('t') /* Cyrillic a */,
    bad('a') + '​' + bad('vttn') /* zero-width space */,
    [...bad('avttn')].map((c) => String.fromCodePoint(c.codePointAt(0) + 0xfee0)).join('') /* fullwidth */,
  );
  for (const s of evasions) assert.equal(isOffensive(s), true, JSON.stringify(rot13(s)));
});

test('no false positives on ordinary coin names (Scunthorpe cases)', () => {
  const clean = ['Cigarette', 'Niger', 'Nigeria', 'nigiri', 'Minigame', 'mini game', 'Leaf Agent', 'Spicy', 'Pure Tardigrade',
    'Porch', 'Monkey', 'Shitting Puppy', 'CATSHIT', 'Goonlings', 'Snig', 'MCAT', 'Muscular Cat', '🚀', 'ハム', 'Sakuragami 桜神',
    '', '   ', null, undefined, 'DOG '];
  clean.push(bad('favttre'), bad('sver ergneqnag'));
  for (const s of clean) assert.equal(isOffensive(s), false, String(s));
});

test('maskDeep masks symbol/name at any depth, keeps mints and flags the object', () => {
  const body = {
    items: [{ mint: 'MintA', symbol: LIVE_SYMBOL, name: 'Cigarette', confidence: 0.9 }, { mint: 'MintB', symbol: 'MCAT', name: 'Miner Cat' }],
    featured: { mint: 'MintC', symbol: LIVE_SYMBOL_2, name: LIVE_NAME_2, neighbours: [{ mint: 'MintD', symbol: 'Boots', name: LIVE_NAME_3 }], barrelMates: { sample: [{ mint: 'MintE', symbol: LIVE_SYMBOL }] } },
  };
  const out = maskDeep(body);
  assert.deepEqual(out.items[0], { mint: 'MintA', symbol: MASK, name: 'Cigarette', confidence: 0.9, masked: true });
  assert.deepEqual(out.items[1], body.items[1], 'clean rows unchanged, no masked flag');
  assert.equal(out.featured.symbol, MASK);
  assert.equal(out.featured.name, MASK);
  assert.equal(out.featured.mint, 'MintC');
  assert.equal(out.featured.neighbours[0].name, MASK);
  assert.equal(out.featured.neighbours[0].symbol, 'Boots');
  assert.equal(out.featured.barrelMates.sample[0].symbol, MASK);
  assert.equal(body.items[0].symbol, LIVE_SYMBOL, 'input is not mutated');
  assert.equal(maskDeep(null), null);
  assert.deepEqual(maskDeep([]), []);
});

test('feed and barrels responses are masked; a slur never becomes the featured hero', () => {
  const now = 1_790_350_000;
  const badItem = { ...svc.feedItem({ ...j7, symbol: LIVE_SYMBOL, name: 'Cigarette' }), blockTime: now - 30, tokens: [] };
  const badFeatured = { ...j7, symbol: LIVE_SYMBOL_2, name: LIVE_NAME_2, blockTime: now - 30, source: 'live' };
  const r = svc.feedResponse({ updatedAt: new Date(now * 1000).toISOString(), items: [badItem], featured: badFeatured }, 24);
  assert.equal(r.items[0].symbol, MASK);
  assert.equal(r.items[0].mint, j7.mint, 'the mint stays');
  assert.equal(r.featured.symbol, MASK);
  assert.equal(r.featured.name, MASK);
  const body = JSON.stringify(r);
  for (const s of [LIVE_SYMBOL, LIVE_SYMBOL_2, LIVE_NAME_2]) assert.ok(!body.includes(s), 'no raw slur in the body');
  assert.equal(svc.betterFeatured({ verdict: 'match', confidence: 1, symbol: LIVE_SYMBOL, name: 'Cigarette' }, null), false);
  assert.equal(svc.betterFeatured({ verdict: 'match', confidence: 1, symbol: 'OK', name: LIVE_NAME_3 }, null), false);
  const ref = svc.mergeReference(JSON.parse(fs.readFileSync(new URL('../../data/reference.json', import.meta.url))), []);
  const b = svc.barrelsFromState(ref, { updatedAt: new Date(now * 1000).toISOString(), items: [{ ...badItem, barrelId: 'B-ZZZZZZ' }] });
  assert.ok(!JSON.stringify(b).includes(`"${LIVE_SYMBOL}"`));
});

test('names the striae library already masked (extract() default) stay masked, flagged, and never featured', async () => {
  const { extract } = await import('../../src/extract.js');
  const fx = JSON.parse(fs.readFileSync(new URL('../../test/fixtures/create-v1.json', import.meta.url)));
  const ex = extract(fx.tx); // a create whose on-chain name was scrubbed at record time
  assert.equal(ex.meta.name, MASK);
  assert.equal(ex.meta.masked, true);
  assert.equal(isOffensive(MASK), false, 'MASK is not itself a slur');
  assert.deepEqual(maskDeep({ mint: 'MintA', name: ex.meta.name, symbol: ex.meta.symbol }), { mint: 'MintA', name: MASK, symbol: ex.meta.symbol, masked: true });
  assert.equal(svc.betterFeatured({ verdict: 'match', confidence: 1, symbol: ex.meta.symbol, name: ex.meta.name }, null), false);
  // the bundled reference carries the two scrubbed symbols as MASK; /api/barrels flags them
  const ref = JSON.parse(fs.readFileSync(new URL('../../data/reference.json', import.meta.url)));
  const masked = ref.instances.filter((i) => i.symbol === MASK);
  assert.equal(masked.length, 2);
  assert.ok(maskDeep(masked).every((i) => i.masked === true && i.mint));
});

// ---- hygiene: the app's recorded data (fixtures, the feed fallback, the site's SAMPLE rows) ---------

const TEXT_KEYS = new Set(['name', 'symbol', 'description', 'descSnippet', 'evidence', 'website', 'createdOn', 'label', 'displayName']);
const HANDLE = /(?<![\w.])@[A-Za-z0-9_]{2,15}\b|(?:x|twitter)\.com\/[A-Za-z0-9_]{2,15}/;
function findings(v, where, key = null, out = []) {
  if (typeof v === 'string') {
    if (TEXT_KEYS.has(key) && isOffensive(v)) out.push(`${where} ${key}: slur`);
    if (HANDLE.test(v)) out.push(`${where} ${key}: account handle`);
  } else if (Array.isArray(v)) v.forEach((x) => findings(x, where, key, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) findings(x, where, k, out);
  return out;
}

test('hygiene: no recorded name/symbol in app data matches the mask list, and no account handle ships', () => {
  const files = [
    ...fs.readdirSync(app('test/fixtures')).filter((f) => f.endsWith('.json')).map((f) => `test/fixtures/${f}`),
    'lib/featured-fixture.json',
    ...fs.readdirSync(app('site/src/data')).filter((f) => f.endsWith('.json')).map((f) => `site/src/data/${f}`),
  ];
  const found = [];
  let scrubbed = 0;
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(app(f), 'utf8'));
    findings(j, f, null, found);
    JSON.stringify(j, (k, v) => { if ((k === 'symbol' || k === 'name') && isMasked(v)) scrubbed++; return v; });
  }
  assert.ok(files.length >= 5, `scanned ${files.length} files`);
  assert.ok(scrubbed >= 6, 'the record-time placeholders are still in place');
  assert.deepEqual(found, [], 'scrub with a same-byte-length placeholder (src/mask.js placeholder())');
});

test('hygiene: scrubbed fixture names are served as MASK with masked: true', () => {
  const fx = JSON.parse(fs.readFileSync(app('lib/featured-fixture.json'), 'utf8'));
  const r = svc.feedResponse({ updatedAt: fx.recordedAt, items: [], featured: null }, 24);
  assert.equal(r.featured.source, 'fixture');
  const masked = [r.featured.comparedWith, ...r.featured.neighbours, ...r.featured.barrelMates.sample].filter((x) => x?.masked);
  assert.ok(masked.length >= 3 && masked.every((x) => x.symbol === MASK));
});
