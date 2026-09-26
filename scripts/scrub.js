#!/usr/bin/env node
// Scrub offensive token names out of recorded data, in place (offline, idempotent).
//
//   node scripts/scrub.js        # data/corpus.json.gz, data/labelled-graduates.json, test/fixtures/*.json
//   npm run build:ref            # then rebuild data/reference.json from the scrubbed corpus
//
// A create's name and symbol are Borsh strings inside the base58 instruction data: the pump.fun create
// args, the Metaplex / Token-2022 metadata CPI and Anchor's event CPI all carry them. When either one is
// offensive (src/mask.js), every copy of its UTF-8 bytes in every instruction becomes placeholder() of
// the same byte length, so length prefixes, offsets, mints, signatures, lamports and every striation
// stay identical. record.js runs scrubTx() on each transaction before it writes the corpus.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { b58decode } from '../src/bytes.js';
import { extract } from '../src/extract.js';
import { isOffensive, maskText, placeholder } from '../src/mask.js';

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

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const writeJson1 = (file, j) => fs.writeFileSync(file, JSON.stringify(j, null, 1));

if (import.meta.url === `file://${process.argv[1]}`) {
  const log = [];
  const note = (where, mint, bad) => { if (bad.length) log.push(`${where} ${mint}: ${bad.length} string${bad.length > 1 ? 's' : ''} → placeholder`); };

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
  fs.writeFileSync(corpusFile, zlib.gzipSync(JSON.stringify(corpus), { level: 9 }));

  const gradsFile = path.join(root, 'data/labelled-graduates.json');
  const grads = JSON.parse(fs.readFileSync(gradsFile, 'utf8'));
  for (const r of grads.rows) { r.symbol = maskText(r.symbol); r.descSnippet = maskWords(r.descSnippet); }
  writeJson1(gradsFile, grads);

  const fxDir = path.join(root, 'test/fixtures');
  for (const f of fs.readdirSync(fxDir).filter((x) => x.endsWith('.json'))) {
    const file = path.join(fxDir, f);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bad = j.tx ? scrubTx(j.tx) : [];
    if (j.metadata) j.metadata.description = maskWords(j.metadata.description);
    note(`fixture ${f}`, j.mint, bad);
    if (bad.length) writeJson1(file, j);
  }
  console.log(log.length ? log.join('\n') : 'nothing to scrub');
}
