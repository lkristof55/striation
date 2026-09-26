// The slur mask (src/mask.js), the record-time scrub (scripts/scrub.js) and hygiene checks that fail
// if any recorded name or symbol in data/, test/fixtures/ or bench/ matches the mask list, if any
// @handle, profile link or e-mail (a real person's identifier) is left in data/, test/fixtures/, bench/
// or app/ data, including inside instruction bytes, and (when the repo's app/ is present) if the app's
// recorded data or any string/comment in the source spells a slur.
// Offensive test inputs are written ROT13 (the same encoding src/mask.js keeps its list in). Handles in
// the tests below are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract, stampsFromMetadata } from '../src/extract.js';
import { b58decode, u32le } from '../src/bytes.js';
import { MASK, isOffensive, maskText, isMasked, placeholder, rot13 } from '../src/mask.js';
import { scrubTx, rewriteBytes, b58encode, scrubIds, scrubTxIds, scrubIdsDeep, personalIds } from '../scripts/scrub.js';
import { PROGRAMS } from '../src/tables.js';
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

// ---- personal identifiers: @handles, profile links, e-mails -------------------------------------
// Synthetic identifiers only: H is longer than any X handle (max 15), P longer than any platform's
// username limit, and e-mails use the reserved example.com domain.
const H = 'fake_handle_000000';
const P = 'fake-profile-path-no-platform-allows-000000000';
const pad = (s) => 'x'.repeat(s.length);

test('scrubIds() pads handles, profile links and e-mails with x, same UTF-8 byte length, tool stamps kept', () => {
  const cases = [
    [`Fees to @${H} via UsePaid`, `Fees to @${pad(H)} via UsePaid`],
    [`Created on https://rapidlaunch.io @${H}`, `Created on https://rapidlaunch.io @${pad(H)}`],
    [`https://x.com/${P}/status/123`, `https://x.com/${pad(`${P}/status/123`)}`],
    [`https://twitter.com/${P}`, `https://twitter.com/${pad(P)}`],
    [`see github.com/${P}/repo`, `see github.com/${pad(`${P}/repo`)}`],
    [`https://www.tiktok.com/@${P}/video/1`, `https://www.tiktok.com/${pad(`@${P}/video/1`)}`],
    [`t.me/${P}`, `t.me/${pad(P)}`],
    [`https://x.com/search?q=%40${H}&f=top`, `https://x.com/${pad(`search?q=%40${H}&f=top`)}`],
    [`q=%40${H}`, `q=%40${pad(H)}`],
    [`mail ${P}@example.com`, `mail ${pad(P)}@xxxxxxx.com`],
    ['Launched on discord.gg/uxento', 'Launched on discord.gg/uxento'],
    ['https://usepaid.app/t/7pm3vwf7 backpack.app/download', 'https://usepaid.app/t/7pm3vwf7 backpack.app/download'],
    ['inbox.com/a netflix.com/b', 'inbox.com/a netflix.com/b'],
    ['', ''],
  ];
  for (const [input, want] of cases) {
    const got = scrubIds(input);
    assert.equal(got, want, input);
    assert.equal(Buffer.byteLength(got), Buffer.byteLength(input), `byte length of ${input}`);
    assert.equal(scrubIds(got), got, 'idempotent');
    assert.deepEqual(personalIds(got), []);
  }
  assert.deepEqual(personalIds(`Fees to @${H} via UsePaid`), [`@${H}`]);
  assert.equal(scrubIds(null), null);
});

test('scrubbed descriptions still carry their tool stamp (labels never depend on a handle)', () => {
  for (const [description, label] of [[`Fees to @${H} via UsePaid`, 'usepaid'], [`Created on https://rapidlaunch.io @${H}`, 'rapidlaunch'], ['Launched on discord.gg/uxento', 'uxento']]) {
    assert.deepEqual(stampsFromMetadata({ description: scrubIds(description) }).map((s) => s.label), stampsFromMetadata({ description }).map((s) => s.label));
    assert.equal(stampsFromMetadata({ description: scrubIds(description) })[0].label, label);
  }
});

test('scrubTxIds() rewrites a handle in the create name and uri bytes, memos and logs; striations unchanged', () => {
  const f = fixture('wrapper-cpi'); // name "real laptop" (11 bytes)
  const raw = extract(f.tx, { mask: false });
  const tx = clone(f.tx);
  const uri2 = `${raw.meta.uri.slice(0, -(H.length + 2))}/@${H}`;
  assert.ok(rewriteBytes(tx, [[raw.meta.name, '@0000000000'], [raw.meta.uri, uri2]]) >= 2);
  tx.meta.logMessages = [`Program log: fees to @${H}`, 'Program data: AAAA'];
  assert.deepEqual(scrubTxIds(tx).sort(), ['@0000000000', uri2].sort());
  const after = extract(tx, { mask: false });
  assert.equal(after.meta.name, '@xxxxxxxxxx');
  assert.equal(after.meta.uri, `${raw.meta.uri.slice(0, -(H.length + 2))}/@${pad(H)}`);
  assert.equal(after.meta.uriHost, raw.meta.uriHost);
  assert.equal(after.meta.mint, raw.meta.mint);
  assert.deepEqual(after.striations, raw.striations);
  assert.deepEqual(after.stamps, raw.stamps);
  assert.deepEqual(tx.meta.logMessages, [`Program log: fees to @${pad(H)}`, 'Program data: AAAA']);
  assert.deepEqual(scrubTxIds(tx), [], 'idempotent');

  const memoTx = { transaction: { signatures: [], message: { accountKeys: [PROGRAMS.memo], instructions: [{ programIdIndex: 0, accounts: [], data: b58encode(Buffer.from(`gm @${H}`)) }] } }, meta: {} };
  assert.equal(scrubIdsDeep({ tx: memoTx }), 1);
  assert.equal(Buffer.from(b58decode(memoTx.transaction.message.instructions[0].data)).toString('utf8'), `gm @${pad(H)}`);
});

// The guard is deliberately independent of scripts/scrub.js: its own patterns, a wider net.
const SOCIAL = /(?<![\w-])(?:[\w-]+\.)*(?:x|twitter|github|t|telegram|instagram|tiktok|youtube|youtu|facebook|fb|twitch|kick|linktr|threads|bsky|warpcast|farcaster|reddit|medium|substack|linkedin|snapchat|truthsocial|discord|patreon)\.(?:com|me|ee|gg|tv|be|net|app|xyz)\/([^\s"'<>()[\]\\]+)/gi;
const AT = /(?<![\w.%+-])@([A-Za-z0-9_]+)/g;
const PCT_AT = /%40([A-Za-z0-9_]+)/gi;
const EMAIL = /[\w.+-]+@(?:[\w-]+\.)+[a-z]{2,}/gi;
/** Links on a social host that are a launch tool's own stamp (a label), not a person. */
const ALLOWED_LINKS = new Set(['discord.gg/uxento']);
const placeholderId = (s) => /^x+$/.test(s);

/** Non-placeholder personal identifiers in s. */
function idsIn(s) {
  if (typeof s !== 'string' || !/[@.%]/.test(s)) return [];
  const out = [];
  for (const m of s.matchAll(SOCIAL)) {
    const bare = m[0].replace(/^(?:https?:\/\/)?(?:www\.|m\.|mobile\.)?/i, '').replace(/\/$/, '').toLowerCase();
    if (!placeholderId(m[1]) && !ALLOWED_LINKS.has(bare)) out.push(m[0]);
  }
  const noLinks = s.replace(SOCIAL, ' ');
  for (const m of noLinks.matchAll(EMAIL)) if (!/^x+@(?:x+\.)+[a-z]{2,}$/i.test(m[0])) out.push(m[0]);
  for (const re of [AT, PCT_AT]) for (const m of noLinks.replace(EMAIL, ' ').matchAll(re)) if (!placeholderId(m[1])) out.push(m[0]);
  return out;
}

/** Every text a recorded transaction carries: Borsh strings in instruction data, memo text, logs, events. */
function txTexts(tx) {
  const m = tx.transaction?.message ?? tx.message;
  const keys = [...(m?.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey)), ...(tx.meta?.loadedAddresses?.writable || []), ...(tx.meta?.loadedAddresses?.readonly || [])];
  const ixs = [...(m?.instructions || []), ...(tx.meta?.innerInstructions || []).flatMap((g) => g.instructions || [])];
  const out = [];
  try { const ex = extract(tx, { mask: false }); out.push(ex.meta.name, ex.meta.symbol, ex.meta.uri); } catch { /* not a create */ }
  for (const ix of ixs) {
    let u8;
    try { u8 = b58decode(ix.data || ''); } catch { continue; }
    out.push(...borshStrings(u8));
    if (keys[ix.programIdIndex] === PROGRAMS.memo || keys[ix.programIdIndex] === PROGRAMS.memoV1) { try { out.push(td.decode(u8)); } catch { /* binary */ } }
  }
  for (const l of tx.meta?.logMessages || []) {
    const pd = /^Program data: (.+)$/.exec(l);
    out.push(...(pd ? borshStrings(Buffer.from(pd[1], 'base64')) : [l]));
  }
  return out;
}

/** Findings in a parsed JSON tree: every string value, and every transaction's bytes. */
function idFindings(v, where, out = []) {
  const walk = (x, p) => {
    if (typeof x === 'string') { for (const id of idsIn(x)) out.push(`${where}${p}: ${id}`); return; }
    if (Array.isArray(x)) { x.forEach((y, i) => walk(y, `${p}[${i}]`)); return; }
    if (!x || typeof x !== 'object') return;
    if (x.transaction?.message || (x.message?.accountKeys && x.meta)) for (const t of txTexts(x)) for (const id of idsIn(t)) out.push(`${where}${p} tx bytes: ${id}`);
    for (const [k, y] of Object.entries(x)) walk(y, `${p}.${k}`);
  };
  walk(v, '');
  return out;
}

/**
 * Every file in a directory (not recursive): .json / .json.gz parsed, other text files as one string.
 * jsonOnly: a directory that mixes code and data (app/lib) contributes only its data files.
 */
function scanDir(dir, out, stats, { jsonOnly = false } = {}) {
  if (!fs.existsSync(path.join(root, dir))) return;
  for (const n of fs.readdirSync(path.join(root, dir))) {
    const f = path.join(root, dir, n);
    if (fs.statSync(f).isDirectory() || n.startsWith('.') || (jsonOnly && !/\.json(\.gz)?$/.test(n))) continue;
    stats.files++;
    if (n.endsWith('.json.gz')) idFindings(JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8')), `${dir}/${n}`, out);
    else if (n.endsWith('.json')) idFindings(JSON.parse(fs.readFileSync(f, 'utf8')), `${dir}/${n}`, out);
    else if (/\.(m?js|md|txt|csv)$/.test(n)) for (const id of idsIn(fs.readFileSync(f, 'utf8'))) out.push(`${dir}/${n}: ${id}`);
  }
}

test('hygiene: the identifier guard sees handles, links and e-mails in text and in instruction bytes', () => {
  assert.deepEqual(idsIn(`Fees to @${H} via UsePaid`), [`@${H}`]);
  assert.deepEqual(idsIn(`https://www.x.com/${P}/status/1 and ${P}@example.com`), [`www.x.com/${P}/status/1`, `${P}@example.com`]);
  assert.deepEqual(idsIn(`x.com/search?q=%40${H}`), [`x.com/search?q=%40${H}`]);
  assert.deepEqual(idsIn(`q=%40${H}`), [`%40${H}`]);
  assert.deepEqual(idsIn(scrubIds(`Fees to @${H} via @${P}, x.com/${P}, ${P}@example.com, Launched on discord.gg/uxento`)), []);
  const f = fixture('wrapper-cpi');
  const tx = clone(f.tx);
  const raw = extract(tx, { mask: false });
  rewriteBytes(tx, [[raw.meta.name, '@0000000000']]);
  assert.ok(idFindings({ tx }, 'probe').length >= 1, 'a handle inside the create args is found');
});

test('hygiene: no @handle, profile link or e-mail in data/, test/fixtures/, bench/ or app/ data', () => {
  const found = [];
  const stats = { files: 0 };
  for (const d of ['data', 'test/fixtures', 'bench']) scanDir(d, found, stats);
  if (hasApp) for (const d of ['app/test/fixtures', 'app/lib', 'app/site/src/data']) scanDir(d, found, stats, { jsonOnly: d === 'app/lib' });
  assert.ok(stats.files >= (hasApp ? 18 : 12), `scanned ${stats.files} files`);
  assert.deepEqual(found, [], 'run `npm run scrub && npm run build:ref` (same-byte-length x padding, scripts/scrub.js)');
});
