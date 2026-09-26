// The slur mask (src/mask.js), the record-time scrub (scripts/scrub.js) and a hygiene check that fails
// if any recorded name or symbol in data/, test/fixtures/ or bench/ matches the mask list, and (when the
// repo's app/ is present) if the app's recorded data or any string/comment in the source spells a slur.
// Offensive test inputs are written ROT13 (the same encoding src/mask.js keeps its list in).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract } from '../src/extract.js';
import { b58decode, u32le } from '../src/bytes.js';
import { MASK, isOffensive, maskText, isMasked, placeholder, rot13 } from '../src/mask.js';
import { scrubTx, rewriteBytes, b58encode } from '../scripts/scrub.js';
import { fixture, clone } from './helpers.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bad = (enc) => rot13(enc);

test('masks slurs and their evasions (case, leetspeak, spacing, stretching, homoglyphs, fullwidth, zero-width)', () => {
  const inputs = ['snt', 'SNT', '$SNT', 's n t', 'S.N.T', 's@t', 'avttn', 'A!TT4', 'avvvvttnnn', 'avt tre', 'FNAQAVTTRE', 'cbepu_zbaxrl', 'Xvxrf', 'PUVAX', 'Ergneqvvb', 'ERGNEQVB', 'Ergneqvb Fgengrtl']
    .map(bad);
  inputs.push('F\u0430g' /* Cyrillic a */, 'n\u200b' + bad('vttn') /* zero-width */, '\uff4e\uff49\uff47\uff47\uff41' /* fullwidth */);
  for (const s of inputs) assert.equal(maskText(s), MASK, JSON.stringify(rot13(s)));
});

test('no false positives on ordinary coin names', () => {
  const clean = ['Cigarette', 'Niger', 'Nigeria', 'nigiri', 'Minigame', 'Leaf Agent', 'Spicy', 'Pure Tardigrade', 'Porch', 'Monkey', 'Snig', 'MCAT',
    'RTSTR', 'TIMELESS', 'Mumbling Seagull', '🚀', 'ハム', '', '   ', null, undefined];
  clean.push(bad('fver ergneqnag'), bad('favttre'));
  for (const s of clean) assert.equal(isOffensive(s), false, String(s));
});

test('placeholder() keeps the UTF-8 byte length and is recognised as masked', () => {
  for (let n = 0; n <= 40; n++) assert.equal(Buffer.byteLength(placeholder(n), 'utf8'), n);
  assert.ok(isMasked(placeholder(17)) && isMasked(MASK));
  assert.equal(maskText(placeholder(8)), MASK);
  assert.equal(isMasked('▇ coin'), false);
});

test('extract() masks an offensive name by default, keeps every striation, and mask:false gives the raw bytes', () => {
  const f = fixture('wrapper-cpi'); // name "real laptop" (11 bytes), symbol "lpt"
  const raw = extract(f.tx, { mask: false });
  const tx = clone(f.tx);
  const slur = bad('erny snttbg'); // 11 bytes
  assert.ok(rewriteBytes(tx, [[raw.meta.name, slur]]) >= 1);
  const masked = extract(tx);
  assert.equal(extract(tx, { mask: false }).meta.name, slur);
  assert.equal(masked.meta.name, MASK);
  assert.equal(masked.meta.masked, true);
  assert.equal(masked.meta.symbol, raw.meta.symbol, 'only the offending field is masked');
  assert.deepEqual(masked.striations, raw.striations);
  assert.equal(extract(f.tx).meta.masked, undefined, 'clean creates carry no masked flag');
});

test('scrubTx() replaces the name in every instruction with a same-length placeholder, striations unchanged', () => {
  const f = fixture('wrapper-cpi');
  const before = extract(f.tx, { mask: false });
  const tx = clone(f.tx);
  rewriteBytes(tx, [[before.meta.name, bad('erny snttbg')]]);
  assert.deepEqual(scrubTx(tx), [bad('erny snttbg')]);
  const after = extract(tx, { mask: false });
  assert.equal(after.meta.name, placeholder(11));
  assert.equal(after.meta.symbol, before.meta.symbol);
  assert.deepEqual(after.striations, before.striations);
  assert.deepEqual(after.stamps, before.stamps);
  assert.deepEqual(scrubTx(tx), [], 'idempotent');
  const u8 = Uint8Array.from([0, 0, 1, 2, 255, 58, 0]);
  assert.deepEqual(b58decode(b58encode(u8)), u8, 'base58 round trip keeps leading zeros');
});

// ---- hygiene: recorded data carries no name that matches the mask list ----------------------------

const td = new TextDecoder('utf-8', { fatal: true });
/** Every plausible Borsh string (u32 length 3..200, valid printable UTF-8) inside instruction bytes. */
function borshStrings(u8) {
  const out = [];
  for (let o = 0; o + 4 <= u8.length; o++) {
    const n = u32le(u8, o);
    if (n < 3 || n > 200 || o + 4 + n > u8.length) continue;
    let s;
    try { s = td.decode(u8.subarray(o + 4, o + 4 + n)); } catch { continue; }
    if (!/[\x00-\x1f\x7f]/.test(s)) out.push(s);
  }
  return out;
}

function txFindings(tx, where) {
  const found = [];
  try {
    const ex = extract(tx, { mask: false });
    for (const k of ['name', 'symbol']) if (isOffensive(ex.meta[k])) found.push(`${where} meta.${k}`);
  } catch { /* not a create: still scan its bytes */ }
  const m = tx.transaction?.message ?? tx.message;
  const ixs = [...(m?.instructions || []), ...(tx.meta?.innerInstructions || []).flatMap((g) => g.instructions || [])];
  for (const ix of ixs) {
    let u8;
    try { u8 = b58decode(ix.data || ''); } catch { continue; }
    if (borshStrings(u8).some(isOffensive)) found.push(`${where} borsh string in ix data`);
  }
  for (const l of tx.meta?.logMessages || []) if (isOffensive(l)) found.push(`${where} log`);
  return found;
}

const TEXT_KEYS = new Set(['name', 'symbol', 'descSnippet', 'description', 'evidence', 'website', 'createdOn']);
function textFindings(v, where, key = null, out = []) {
  if (typeof v === 'string') { if (TEXT_KEYS.has(key) && isOffensive(v)) out.push(`${where} ${key}`); }
  else if (Array.isArray(v)) v.forEach((x) => textFindings(x, where, key, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) textFindings(x, where, k, out);
  return out;
}

test('hygiene: no recorded name or symbol in data/, test/fixtures/ or bench/ matches the mask list', () => {
  const found = [];
  const corpus = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, 'data/corpus.json.gz'))).toString('utf8'));
  let txs = 0;
  for (const g of corpus.graduates) { found.push(...txFindings(g.tx, `corpus graduate ${g.row.mint}`)); txs++; }
  for (const l of corpus.live) { found.push(...txFindings(l.tx, `corpus live ${l.sig?.signature}`)); txs++; }
  textFindings(corpus, 'corpus', null, found);
  for (const f of ['data/reference.json', 'data/labelled-graduates.json', 'bench/results.json']) {
    textFindings(JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')), f, null, found);
  }
  const fx = fs.readdirSync(path.join(root, 'test/fixtures')).filter((f) => f.endsWith('.json'));
  for (const f of fx) {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures', f), 'utf8'));
    if (j.tx) { found.push(...txFindings(j.tx, `fixture ${f}`)); txs++; }
    textFindings(j, `fixture ${f}`, null, found);
  }
  assert.ok(txs >= 480, `scanned ${txs} recorded transactions`);
  assert.deepEqual(found, [], 'run `node scripts/scrub.js && npm run build:ref`');
});

test('hygiene: the scrubbed creates still extract, masked', () => {
  const f = fixture('create-v1');
  const ex = extract(f.tx);
  assert.equal(ex.meta.mint, f.mint);
  assert.equal(ex.meta.name, MASK);
  assert.equal(ex.meta.masked, true);
  const ref = JSON.parse(fs.readFileSync(path.join(root, 'data/reference.json'), 'utf8'));
  assert.equal(ref.instances.filter((i) => i.symbol === MASK).length, 2, 'the two scrubbed reference symbols read MASK');
});

// ---- hygiene: the live app in app/ (its fixtures, the feed fallback, the site's SAMPLE rows) and the
// source text of the library and the app. Reads files only; the library never imports from app/.

const appDir = path.join(root, 'app');
const hasApp = fs.existsSync(path.join(appDir, 'package.json'));

test('hygiene: no recorded name or symbol in app/ data matches the mask list', { skip: !hasApp && 'no app/ in this checkout' }, () => {
  const jsonIn = (d) => (fs.existsSync(path.join(appDir, d)) ? fs.readdirSync(path.join(appDir, d)).filter((f) => f.endsWith('.json')).map((f) => `${d}/${f}`) : []);
  const files = [...jsonIn('test/fixtures'), ...jsonIn('lib'), ...jsonIn('site/src/data')];
  const found = [];
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(appDir, f), 'utf8'));
    if (j.tx) found.push(...txFindings(j.tx, `app/${f}`));
    textFindings(j, `app/${f}`, null, found);
  }
  assert.ok(files.length >= 5, `scanned ${files.length} app data files`);
  assert.deepEqual(found, [], 'scrub with placeholder() of the same UTF-8 byte length (see app/test/record.mjs)');
});

// Every string literal and comment in .js/.mjs/.ts, and every sentence of the docs, config and pages.
const LITERALS = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.data', '.git', 'data', 'fixtures']);
function sourceFindings(dir, out = []) {
  for (const n of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(n)) continue;
    const f = path.join(dir, n);
    if (fs.statSync(f).isDirectory()) { sourceFindings(f, out); continue; }
    if (!/\.(m?js|ts|html|md|css|ya?ml|toml|example)$/.test(n)) continue;
    const t = fs.readFileSync(f, 'utf8');
    const pieces = /\.(m?js|ts)$/.test(n) ? t.match(LITERALS) || [] : t.split(/\n|(?<=[.;:!?])\s+/);
    if (pieces.some(isOffensive)) out.push(path.relative(root, f));
  }
  return out;
}

test('hygiene: no string or comment in the library or app/ source spells a slur', () => {
  const probe = `const name = '${bad('snt')}'; // ${bad('avttn')}`;
  assert.equal(probe.match(LITERALS).filter(isOffensive).length, 2, 'the scanner sees literals and comments');
  const found = [];
  for (const d of ['src', 'bin', 'bench', 'examples', 'scripts', 'test', ...(hasApp ? ['app'] : [])]) {
    if (fs.existsSync(path.join(root, d))) sourceFindings(path.join(root, d), found);
  }
  for (const f of ['README.md', 'index.d.ts']) if (fs.readFileSync(path.join(root, f), 'utf8').split(/\n|(?<=[.;:!?])\s+/).some(isOffensive)) found.push(f);
  assert.deepEqual(found, [], 'write offensive test inputs ROT13 (src/mask.js rot13)');
});
