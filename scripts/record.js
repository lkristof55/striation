#!/usr/bin/env node
// Record the corpus the reference set is built from (needs an RPC URL; Helius recommended).
//
//   STRIAE_RPC_URL=https://mainnet.helius-rpc.com/?api-key=... node scripts/record.js [--live 400]
//
// 1. Description-labelled graduates (data/labelled-graduates.json): getTransactionsForAddress asc,
//    limit 8 → the create tx plus same-slot followers (10 credits each).
// 2. Live creates: getSignaturesForAddress on the pump.fun mint authority (create-only feed), then
//    getTransaction in batches of 10, then the metadata JSON at each create uri (no key).
// Output: data/corpus.json.gz (trimmed txs: no logs, no balances; offensive names scrubbed to same-length
// placeholders). Credits are printed at the end.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRpc, firstTransactions, getTransactions, recentCreateSignatures, fetchMetadata, HELIUS_CREDITS } from '../src/rpc.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const url = process.env.STRIAE_RPC_URL;
if (!url) { console.error('set STRIAE_RPC_URL'); process.exit(1); }
const liveN = Number(process.argv[process.argv.indexOf('--live') + 1]) || 400;

const calls = {};
const rpc = createRpc(url, { retries: 6, onCall: (m, n) => { calls[m] = (calls[m] || 0) + n; } });
const partialFile = path.join(root, 'data/.record-partial.json');
const partial = fs.existsSync(partialFile) ? JSON.parse(fs.readFileSync(partialFile, 'utf8')) : {};

export function trimTx(tx) {
  if (!tx) return null;
  const m = tx.transaction?.message || tx.message;
  return {
    slot: tx.slot, blockTime: tx.blockTime ?? null, transactionIndex: tx.transactionIndex ?? null, version: tx.version,
    transaction: { signatures: tx.transaction?.signatures || tx.signatures, message: m },
    meta: tx.meta && {
      err: tx.meta.err ?? null, fee: tx.meta.fee, computeUnitsConsumed: tx.meta.computeUnitsConsumed,
      loadedAddresses: tx.meta.loadedAddresses, innerInstructions: tx.meta.innerInstructions || [],
    },
  };
}
const summary = (tx) => ({
  slot: tx.slot, transactionIndex: tx.transactionIndex ?? null, version: tx.version, err: tx.meta?.err ?? null,
  signature: (tx.transaction?.signatures || tx.signatures)?.[0], feePayer: (tx.transaction?.message || tx.message)?.accountKeys?.[0],
});
const isCreate = (tx) => !tx.meta?.err && (tx.meta?.logMessages || []).some((l) => /Instruction: Create(V2)?$/.test(l));

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

const grads = JSON.parse(fs.readFileSync(path.join(root, 'data/labelled-graduates.json'), 'utf8')).rows;
console.log(`graduates: ${grads.length}`);
const done = new Map((partial.graduates || []).map((g) => [g.row.mint, g]));
const graduates = (await pool(grads, 2, async (row) => {
  if (done.has(row.mint)) return done.get(row.mint);
  try {
    const txs = await firstTransactions(rpc, row.mint, { limit: 8 });
    const c = txs.find(isCreate);
    if (!c) { console.log(`  no create found for ${row.mint}`); return null; }
    return { row, tx: trimTx(c), followers: txs.filter((t) => t !== c).map(summary) };
  } catch (e) { console.log(`  ${row.mint}: ${e.message}`); return null; }
})).filter(Boolean);
console.log(`graduates recorded: ${graduates.length}`);
fs.writeFileSync(partialFile, JSON.stringify({ graduates }));

const sigs = [];
let before;
while (sigs.length < liveN * 1.3) {
  const page = await recentCreateSignatures(rpc, { limit: 1000, before });
  if (!page?.length) break;
  sigs.push(...page);
  before = page[page.length - 1].signature;
}
const ok = sigs.filter((s) => !s.err).slice(0, liveN);
console.log(`live sigs: ${sigs.length} (${sigs.length - sigs.filter((s) => !s.err).length} failed), fetching ${ok.length}`);
const txs = [];
for (let i = 0; i < ok.length; i += 10) {
  const part = ok.slice(i, i + 10).map((s) => s.signature);
  try { txs.push(...(await getTransactions(rpc, part))); } catch (e) { console.log(`  batch ${i / 10}: ${e.message}`); txs.push(...part.map(() => null)); await new Promise((r) => setTimeout(r, 3000)); }
  await new Promise((r) => setTimeout(r, 400));
}
const live = [];
for (let i = 0; i < ok.length; i++) if (txs[i]) live.push({ sig: ok[i], tx: trimTx({ ...txs[i], transactionIndex: ok[i].transactionIndex ?? txs[i].transactionIndex }) });
console.log(`live txs: ${live.length}`);

// metadata uri: borsh string args of the create ix are decoded later; here we only need the uri.
const { extract } = await import('../src/extract.js');
await pool(live, 8, async (item) => {
  let uri = null;
  try { uri = extract(item.tx).meta.uri; } catch { return; }
  const j = await fetchMetadata(uri, { timeoutMs: 6000 });
  if (j) item.metadata = { description: String(j.description || '').slice(0, 240), createdOn: String(j.createdOn || '').slice(0, 120), website: String(j.website || '').slice(0, 160) };
});
console.log(`metadata fetched: ${live.filter((l) => l.metadata).length}/${live.length}`);

// Scrub offensive names (same-byte-length placeholders, see scripts/scrub.js) before anything is written.
const { scrubTx, maskWords } = await import('./scrub.js');
const { maskText } = await import('../src/mask.js');
let scrubbed = 0;
for (const g of graduates) { scrubbed += scrubTx(g.tx).length ? 1 : 0; g.row.symbol = maskText(g.row.symbol); g.row.descSnippet = maskWords(g.row.descSnippet); }
for (const l of live) { scrubbed += scrubTx(l.tx).length ? 1 : 0; if (l.metadata) l.metadata.description = maskWords(l.metadata.description); }
console.log(`scrubbed offensive names in ${scrubbed} creates`);

const corpus = { recordedAt: new Date().toISOString(), calls, graduates, live };
fs.writeFileSync(path.join(root, 'data/corpus.json.gz'), zlib.gzipSync(JSON.stringify(corpus), { level: 9 }));
const credits = Object.entries(calls).reduce((s, [m, n]) => s + n * (HELIUS_CREDITS[m] ?? 1), 0);
console.log(`calls ${JSON.stringify(calls)} ≈ ${credits} Helius credits → data/corpus.json.gz`);
