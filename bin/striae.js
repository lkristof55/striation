#!/usr/bin/env node
// striae <mint|signature> [--rpc URL] [--json] [--no-metadata]
// RPC: --rpc or STRIAE_RPC_URL (Helius recommended: getTransactionsForAddress finds the create in one call).
import { createRpc } from '../src/rpc.js';
import { classify, inputKind } from '../src/classify.js';
import { loadReference } from '../src/reference.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const input = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--rpc');

if (!input || flag('--help') || flag('-h')) {
  console.log('usage: striae <mint|signature> [--rpc URL] [--json] [--no-metadata]\n  RPC URL from --rpc or STRIAE_RPC_URL');
  process.exit(input ? 0 : 1);
}
if (!inputKind(input)) { console.error('striae: not a base58 mint address or signature'); process.exit(2); }
const url = opt('--rpc') || process.env.STRIAE_RPC_URL;
if (!url) { console.error('striae: set STRIAE_RPC_URL or pass --rpc <url>'); process.exit(2); }

const reference = loadReference();
const t0 = performance.now();
let r;
try {
  r = await classify(createRpc(url), input, reference, { metadata: !flag('--no-metadata') });
} catch (e) {
  console.error(`striae: ${e.message}${e.code ? ` (${e.code})` : ''}`);
  process.exit(e.code === 'BAD_INPUT' ? 2 : 1);
}
const ms = Math.round(performance.now() - t0);

if (flag('--json')) { console.log(JSON.stringify({ ...r, ms }, null, 2)); process.exit(0); }

const tty = process.stdout.isTTY;
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const who = r.label ? r.label : 'unknown barrel';
const stampNote = r.stamp ? `stamp ${r.stamp.kind}=${r.stamp.evidence} ${r.stampAgrees ? 'agrees' : 'disagrees'}, hidden from the matcher` : 'no stamp';
console.log(`${bold(who.padEnd(14))} ${r.confidence.toFixed(2)}  ${r.barrelId}  (${stampNote})`);
console.log(dim(`$${r.symbol} · ${r.name} · ${r.verdict} · margin ${r.margin.toFixed(2)}${r.closest && !r.label ? ` · closest ${r.closest.label} ${r.closest.score.toFixed(2)}` : ''}`));
console.log(dim(`mint ${r.mint} · create ${r.signature.slice(0, 16)}… · slot ${r.slot} · tx ${r.version} · via ${r.via} · ${ms} ms`));
console.log('');
const cmp = r.comparedWith ? `${r.comparedWith.symbol ?? r.comparedWith.mint.slice(0, 8)}${r.comparedWith.label ? ` (${r.comparedWith.label})` : ''}` : '-';
console.log(`striations  ● same in ${cmp}   ◐ same bucket   ○ different`);
for (const s of r.striations) {
  const mark = s.matched ? '●' : s.partial ? '◐' : '○';
  console.log(`  ${mark} ${s.family.padEnd(18)} ${s.display.slice(0, 60).padEnd(60)} ${dim((s.source.hex || '').slice(0, 24))}`);
}
console.log('\nneighbours (weighted Jaccard, k=5)');
for (const n of r.neighbours) console.log(`  ${n.similarity.toFixed(3)}  ${(n.label || '-').padEnd(12)} ${n.barrelId}  ${(n.symbol || '').slice(0, 12).padEnd(12)} ${n.mint}`);
if (r.followers) console.log(dim(`\nfollowers: ${r.followers.sameSlot} same-slot txs, ${r.followers.adjacent} at tx index +1..+4`));
