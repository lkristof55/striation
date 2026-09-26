#!/usr/bin/env node
// Scrub recorded data in place (offline, idempotent): offensive token names, and personal identifiers.
//
//   npm run scrub                # data/corpus.json.gz, data/labelled-graduates.json, test/fixtures/*.json, app/ data
//   npm run build:ref            # then rebuild data/reference.json from the scrubbed corpus
//
// 1. Offensive names. A create's name and symbol are Borsh strings inside the base58 instruction data:
//    the pump.fun create args, the Metaplex / Token-2022 metadata CPI and Anchor's event CPI all carry
//    them. When either one is offensive (src/mask.js), every copy of its UTF-8 bytes in every
//    instruction becomes placeholder() of the same byte length.
// 2. Personal identifiers. Launch metadata quotes real accounts ("Fees to @<handle> via UsePaid", a
//    website that is an x.com status link). Every @handle, %40handle, e-mail address and path on a
//    social host (x.com, twitter.com, github.com, t.me, instagram, tiktok, youtube, ...) becomes 'x'
//    padding of the same UTF-8 byte length: "@<handle>" -> "@xxxxxxxx", "https://x.com/<handle>/status/1"
//    -> "https://x.com/xxxxxxxxxxxxxxxxx". This runs on every recorded text field (descriptions, websites,
//    evidence, memos) and on the create's name / symbol / uri bytes, their CPI copies, memo data and
//    logs. Tool stamps that are labels (discord.gg/uxento) are kept.
// Either way length prefixes, offsets, mints, signatures, lamports and every striation stay identical,
// and the tool stamps ("via UsePaid", "Created on https://rapidlaunch.io") still match. record.js runs
// both before it writes the corpus.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { b58decode } from '../src/bytes.js';
import { extract } from '../src/extract.js';
import { isOffensive, maskText, placeholder } from '../src/mask.js';
import { PROGRAMS } from '../src/tables.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Uint8Array → base58 (the inverse of b58decode). */
export function b58encode(u8) {
  const digits = []; // little-endian base-58 accumulator
  for (const byte of u8) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (let i = 0; i < u8.length && u8[i] === 0; i++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

function replaceAll(u8, pairs) {
  let n = 0;
  for (const [from, to] of pairs) {
    for (let i = u8.indexOf(from); i >= 0; i = u8.indexOf(from, i + to.length)) { to.copy(u8, i); n++; }
  }
  return n;
}

/** Mask the offensive words of a free-text field (description, snippet); tool stamps survive. */
export const maskWords = (s) => (typeof s === 'string' && isOffensive(s) ? s.split(/(\s+)/).map((w) => (/\s/.test(w) ? w : maskText(w))).join('') : s);

/**
 * rewriteBytes(tx, pairs) → copies replaced. pairs: [fromString, toString][] of equal UTF-8 byte length.
 * Rewrites outer and inner instruction data and, when a recorder kept them, log lines and base64
 * `Program data:` events. Mutates tx.
 */
export function rewriteBytes(tx, pairs) {
  const bufs = pairs.map(([from, to]) => {
    const [a, b] = [Buffer.from(from, 'utf8'), Buffer.from(to, 'utf8')];
    if (a.length !== b.length) throw new Error('rewriteBytes: replacement must keep the byte length');
    return [a, b];
  });
  const message = tx.transaction?.message ?? tx.message;
  const ixs = [...(message?.instructions || []), ...(tx.meta?.innerInstructions || []).flatMap((g) => g.instructions || [])];
  let n = 0;
  for (const ix of ixs) {
    if (!ix.data) continue;
    let u8;
    try { u8 = Buffer.from(b58decode(ix.data)); } catch { continue; }
    const k = replaceAll(u8, bufs);
    if (k) { ix.data = b58encode(u8); n += k; }
  }
  if (Array.isArray(tx.meta?.logMessages)) {
    tx.meta.logMessages = tx.meta.logMessages.map((line) => {
      const m = /^(Program data: )(.+)$/.exec(line);
      if (m) { const u8 = Buffer.from(m[2], 'base64'); const k = replaceAll(u8, bufs); n += k; return k ? m[1] + u8.toString('base64') : line; }
      let out = line;
      for (const [from, to] of pairs) { const parts = out.split(from); n += parts.length - 1; out = parts.join(to); }
      return out;
    });
  }
  return n;
}

/** scrubTx(tx) → the offensive name/symbol strings it replaced with placeholder() (mutates tx). */
export function scrubTx(tx) {
  let ex;
  try { ex = extract(tx, { mask: false }); } catch { return []; }
  const bad = [...new Set([ex.meta.name, ex.meta.symbol].filter(isOffensive))].sort((a, b) => Buffer.byteLength(b) - Buffer.byteLength(a));
  if (!bad.length) return [];
  const n = rewriteBytes(tx, bad.map((s) => [s, placeholder(Buffer.byteLength(s, 'utf8'))]));
  if (!n) throw new Error(`scrub: ${ex.meta.mint} has an offensive name but no bytes were replaced`);
  return bad;
}


// ---- personal identifiers ------------------------------------------------------------------------

/** Hosts whose URL path names an account, a profile or a post by one. */
export const SOCIAL_HOSTS = [
  'x.com', 'twitter.com', 'github.com', 'gist.github.com', 't.me', 'telegram.me', 'instagram.com', 'tiktok.com',
  'youtube.com', 'youtu.be', 'facebook.com', 'fb.com', 'twitch.tv', 'kick.com', 'linktr.ee', 'threads.net',
  'threads.com', 'bsky.app', 'warpcast.com', 'farcaster.xyz', 'reddit.com', 'medium.com', 'substack.com',
  'linkedin.com', 'snapchat.com', 'truthsocial.com', 'discord.gg', 'discord.com', 'patreon.com',
];
/** Tool stamps on a social host that are labels, not people (src/tables.js STAMP_DESC). */
export const TOOL_LINKS = new Set(['discord.gg/uxento']);

const esc = (h) => h.replace(/\./g, '\\.');
const LINK_RE = new RegExp(`(?<![\\w.-])((?:https?:\\/\\/)?(?:[a-z0-9-]+\\.)*?(${SOCIAL_HOSTS.map(esc).join('|')})\\/)([^\\s"'<>()\\[\\]\\\\]+)`, 'gi');
const EMAIL_RE = /(?<![\w.+-])([\w.+-]+)@((?:[a-z0-9-]+\.)+)([a-z]{2,})(?![\w-])/gi;
const PCT_AT_RE = /%40([A-Za-z0-9_]+)/g;
const AT_RE = /(?<![\w.%+-])@([A-Za-z0-9_]+)/g;
const pad = (s) => 'x'.repeat(Buffer.byteLength(s, 'utf8'));
const isPad = (s) => /^x+$/.test(s);

/**
 * scrubIds(s) → s with every @handle, %40handle, e-mail and social-host path replaced by 'x' padding of
 * the same UTF-8 byte length (idempotent; non-strings pass through).
 */
export function scrubIds(s) {
  if (typeof s !== 'string' || !/[@.%]/.test(s)) return s;
  return s
    .replace(LINK_RE, (m, prefix, host, rest) => (TOOL_LINKS.has(`${host}/${rest.replace(/\/$/, '')}`.toLowerCase()) ? m : prefix + pad(rest)))
    .replace(EMAIL_RE, (m, local, domain, tld) => `${pad(local)}@${domain.split('.').map((d) => (d ? pad(d) : '')).join('.')}${tld}`)
    .replace(PCT_AT_RE, (m, h) => `%40${pad(h)}`)
    .replace(AT_RE, (m, h) => `@${pad(h)}`);
}

/** The non-placeholder personal identifiers scrubIds() would replace in s. */
export function personalIds(s) {
  if (typeof s !== 'string') return [];
  const out = [];
  const t = scrubIds(s);
  if (t === s) return out;
  for (const re of [LINK_RE, EMAIL_RE, PCT_AT_RE, AT_RE]) for (const m of s.matchAll(re)) if (scrubIds(m[0]) !== m[0]) out.push(m[0]);
  return [...new Set(out)];
}

/**
 * scrubTxIds(tx) → the name/symbol/uri/memo strings it rewrote (mutates tx). The create's Borsh strings
 * are rewritten in every instruction that carries them (create args, metadata CPI, event CPI) and in
 * logs; memo instructions (raw UTF-8) are scrubbed as text. Byte lengths never change.
 */
export function scrubTxIds(tx) {
  const done = [];
  let ex = null;
  try { ex = extract(tx, { mask: false }); } catch { /* not a create: memos and logs only */ }
  if (ex) {
    const pairs = [...new Set([ex.meta.name, ex.meta.symbol, ex.meta.uri])]
      .filter((s) => s && scrubIds(s) !== s)
      .sort((a, b) => Buffer.byteLength(b) - Buffer.byteLength(a))
      .map((s) => [s, scrubIds(s)]);
    if (pairs.length) {
      if (!rewriteBytes(tx, pairs)) throw new Error(`scrub: ${ex.meta.mint} has a personal identifier but no bytes were replaced`);
      done.push(...pairs.map(([s]) => s));
    }
  }
  const message = tx.transaction?.message ?? tx.message;
  const keys = [...(message?.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey)), ...(tx.meta?.loadedAddresses?.writable || []), ...(tx.meta?.loadedAddresses?.readonly || [])];
  const ixs = [...(message?.instructions || []), ...(tx.meta?.innerInstructions || []).flatMap((g) => g.instructions || [])];
  for (const ix of ixs) {
    const program = keys[ix.programIdIndex];
    if ((program !== PROGRAMS.memo && program !== PROGRAMS.memoV1) || !ix.data) continue;
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(b58decode(ix.data)); } catch { continue; }
    const t = scrubIds(text);
    if (t !== text) { ix.data = b58encode(Buffer.from(t, 'utf8')); done.push(text); }
  }
  if (Array.isArray(tx.meta?.logMessages)) tx.meta.logMessages = tx.meta.logMessages.map((l) => (/^Program data: /.test(l) ? l : scrubIds(l)));
  return done;
}

/**
 * scrubIdsDeep(v) → how many strings changed. Every string value in a JSON tree goes through
 * scrubIds() (base58, hex and base64 values cannot match), and every `tx` object through scrubTxIds().
 */
export function scrubIdsDeep(v) {
  let n = 0;
  const walk = (x) => {
    if (Array.isArray(x)) { for (let i = 0; i < x.length; i++) { if (typeof x[i] === 'string') { const t = scrubIds(x[i]); if (t !== x[i]) { x[i] = t; n++; } } else walk(x[i]); } return; }
    if (!x || typeof x !== 'object') return;
    if (x.transaction?.message || (x.message?.accountKeys && x.meta)) n += scrubTxIds(x).length;
    for (const [k, y] of Object.entries(x)) {
      if (typeof y === 'string') { const t = scrubIds(y); if (t !== y) { x[k] = t; n++; } } else walk(y);
    }
  };
  walk(v);
  return n;
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const writeJson1 = (file, j) => fs.writeFileSync(file, JSON.stringify(j, null, 1));

if (import.meta.url === `file://${process.argv[1]}`) {
  const log = [];
  const note = (where, mint, bad) => { if (bad.length) log.push(`${where} ${mint}: ${bad.length} string${bad.length > 1 ? 's' : ''} → placeholder`); };
  const noteIds = (where, n) => { if (n) log.push(`${where}: ${n} personal identifier${n > 1 ? 's' : ''} → x padding`); };

  const corpusFile = path.join(root, 'data/corpus.json.gz');
  const corpus = JSON.parse(zlib.gunzipSync(fs.readFileSync(corpusFile)).toString('utf8'));
  for (const g of corpus.graduates) {
    note('corpus graduate', g.row.mint, scrubTx(g.tx));
    g.row.symbol = maskText(g.row.symbol);
    g.row.descSnippet = maskWords(g.row.descSnippet);
  }
  for (const l of corpus.live) {
    note('corpus live', l.sig?.signature?.slice(0, 12), scrubTx(l.tx));
    if (l.metadata) l.metadata.description = maskWords(l.metadata.description);
  }
  noteIds('data/corpus.json.gz', scrubIdsDeep(corpus));
  fs.writeFileSync(corpusFile, zlib.gzipSync(JSON.stringify(corpus), { level: 9 }));

  const gradsFile = path.join(root, 'data/labelled-graduates.json');
  const grads = JSON.parse(fs.readFileSync(gradsFile, 'utf8'));
  for (const r of grads.rows) { r.symbol = maskText(r.symbol); r.descSnippet = maskWords(r.descSnippet); }
  noteIds('data/labelled-graduates.json', scrubIdsDeep(grads));
  writeJson1(gradsFile, grads);

  const fxDir = path.join(root, 'test/fixtures');
  for (const f of fs.readdirSync(fxDir).filter((x) => x.endsWith('.json'))) {
    const file = path.join(fxDir, f);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bad = j.tx ? scrubTx(j.tx) : [];
    if (j.metadata) j.metadata.description = maskWords(j.metadata.description);
    note(`fixture ${f}`, j.mint, bad);
    const ids = scrubIdsDeep(j);
    noteIds(`fixture ${f}`, ids);
    if (bad.length || ids) writeJson1(file, j);
  }

  // The app's recorded data (when app/ is checked out): fixtures, the feed fallback, the site's SAMPLE rows.
  for (const d of ['app/test/fixtures', 'app/lib', 'app/site/src/data']) {
    const dir = path.join(root, d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const file = path.join(dir, f);
      const raw = fs.readFileSync(file, 'utf8');
      const j = JSON.parse(raw);
      const ids = scrubIdsDeep(j);
      noteIds(`${d}/${f}`, ids);
      if (ids) fs.writeFileSync(file, JSON.stringify(j, null, /\n {2}"/.test(raw) ? 2 : 1));
    }
  }
  console.log(log.length ? log.join('\n') : 'nothing to scrub');
}
