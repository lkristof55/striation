#!/usr/bin/env node
// npm run bench → bench/results.json (+ a markdown table on stdout). Offline: uses data/corpus.json.gz
// and data/reference.json only.
//  1. accuracy: leave-one-out over every stamped reference instance, stamps hidden (they are never
//     tokens), k = 5, next to the majority-class baseline; again with the xfer.dest family off.
//  2. speed: extract() over the recorded create txs; match() against the reference and a 10k replica.
//  3. credits: the Helius calls classify() and pollCreates() make, counted through a stub RPC.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extract } from '../src/extract.js';
import { match, tokenList } from '../src/match.js';
import { DEFAULT_WEIGHTS } from '../src/tables.js';
import { createRpc, HELIUS_CREDITS } from '../src/rpc.js';
import { findCreate, pollCreates } from '../src/classify.js';
import { loadCorpus, corpusItems } from '../scripts/build-reference.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const reference = JSON.parse(fs.readFileSync(path.join(root, 'data/reference.json'), 'utf8'));
const corpus = loadCorpus();
const { items } = corpusItems(corpus);
const r3 = (x) => Math.round(x * 1000) / 1000;

function looAccuracy(weights) {
  const labelled = reference.instances.filter((i) => i.label);
  const confusion = {};
  let correct = 0;
  for (const inst of labelled) {
    const r = match(inst, reference, { weights, exclude: [inst.mint, inst.signature] });
    const pred = r.label ?? 'unknown';
    (confusion[inst.label] ||= {})[pred] = (confusion[inst.label][pred] || 0) + 1;
    if (pred === inst.label) correct++;
  }
  const labels = [...new Set(labelled.map((i) => i.label))].sort();
  const perLabel = labels.map((label) => {
    const n = labelled.filter((i) => i.label === label).length;
    const tp = confusion[label]?.[label] || 0;
    const predicted = Object.values(confusion).reduce((s, row) => s + (row[label] || 0), 0);
    return { label, n, recall: r3(tp / n), precision: predicted ? r3(tp / predicted) : 0 };
  });
  const counts = labels.map((l) => labelled.filter((i) => i.label === l).length);
  const abstained = Object.values(confusion).reduce((s, row) => s + (row.unknown || 0), 0);
  return {
    n: labelled.length, top1: r3(correct / labelled.length),
    macroRecall: r3(perLabel.reduce((s, p) => s + p.recall, 0) / perLabel.length),
    majorityBaseline: r3(Math.max(...counts) / labelled.length),
    abstained: r3(abstained / labelled.length),
    perLabel, confusion,
  };
}

function time(fn, minMs = 1000) {
  let n = 0; const t0 = performance.now();
  while (performance.now() - t0 < minMs) { fn(); n++; }
  return (performance.now() - t0) / n;
}

// 1. accuracy
const acc = looAccuracy(DEFAULT_WEIGHTS);
const accNoDest = looAccuracy({ ...DEFAULT_WEIGHTS, 'xfer.dest': 0 });

// 2. speed
const txs = items.map((i) => ({ tx: i.tx, followers: i.followers }));
for (let w = 0; w < 3; w++) for (const t of txs) extract(t.tx, { followers: t.followers });
const perPass = time(() => { for (const t of txs) extract(t.tx, { followers: t.followers }); }, 2000);
const extractPerSec = Math.round(txs.length / (perPass / 1000));
const queries = items.slice(0, 200).map((i) => i.ex);
for (const q of queries.slice(0, 20)) match(q, reference);
const matchUs = (time(() => { for (const q of queries) match(q, reference); }, 2000) / queries.length) * 1000;
const big = { instances: [] };
while (big.instances.length < 10000) big.instances.push(...reference.instances.map((i, k) => ({ ...i, mint: `${i.mint}#${big.instances.length + k}` })));
big.instances.length = 10000;
const qs = queries.slice(0, 50);
match(qs[0], big);
const matchBigUs = (time(() => { for (const q of qs) match(q, big); }, 3000) / qs.length) * 1000;
const tokensPer = reference.instances.reduce((s, i) => s + tokenList(i).length, 0) / reference.size;

// 3. credits, counted from the calls the code makes (stub RPC returns recorded data)
function stubRpc(counter) {
  const g = corpus.graduates[0];
  const live = corpus.live.slice(0, 40);
  const fakeFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const one = (req) => {
      const res = (result) => ({ jsonrpc: '2.0', id: req.id, result });
      if (req.method === 'getTransactionsForAddress') return res({ data: [g.tx] });
      if (req.method === 'getSignaturesForAddress') return res(live.map((l) => l.sig));
      if (req.method === 'getTransaction') return res(live.find((l) => l.sig.signature === req.params[0])?.tx || corpus.live[0].tx);
      return res(null);
    };
    const out = Array.isArray(body) ? body.map(one) : one(body);
    return { ok: true, status: 200, json: async () => out };
  };
  return createRpc('http://stub', { fetch: fakeFetch, onCall: (m, n) => { counter[m] = (counter[m] || 0) + n; } });
}
const credits = (c) => Object.entries(c).reduce((s, [m, n]) => s + n * (HELIUS_CREDITS[m] ?? 1), 0);
const cMatch = {}; await findCreate(stubRpc(cMatch), corpus.graduates[0].row.mint, { metadata: false });
const cSig = {}; await findCreate(stubRpc(cSig), corpus.live[0].sig.signature, { metadata: false });
const cFeed = {}; await pollCreates(stubRpc(cFeed), { limit: 40, max: 18, gapMs: 0 });

let machine = `${os.cpus()[0]?.model || os.arch()} · ${os.cpus().length} cores · ${Math.round(os.totalmem() / 2 ** 30)} GB`;
try { machine = `${execSync('sysctl -n hw.model', { encoding: 'utf8' }).trim()} · ${machine}`; } catch {}

const cmd = 'npm run bench';
const results = {
  measuredAt: new Date().toISOString(),
  machine, node: process.version, command: cmd,
  reference: { size: reference.size, stamped: reference.stamped, unlabelled: reference.unlabelled, builtAt: reference.builtAt, labels: reference.labels },
  accuracy: {
    method: 'leave-one-out, stamps hidden',
    k: 5,
    note: 'Queries are the stamped reference instances; neighbours include unlabelled instances, which vote as unknown. A prediction of unknown counts as wrong.',
    ...acc,
    withoutXferDest: { top1: accNoDest.top1, macroRecall: accNoDest.macroRecall, abstained: accNoDest.abstained },
  },
  bench: [
    { name: 'extract() create txs per second', value: extractPerSec, unit: 'tx/s', command: cmd, detail: `${txs.length} recorded create txs, legacy + v0 + v1` },
    { name: `match() per query, reference n=${reference.size}`, value: Math.round(matchUs * 10) / 10, unit: 'µs', command: cmd },
    { name: 'match() per query, 10k-instance replica', value: Math.round(matchBigUs), unit: 'µs', command: cmd },
    { name: 'tokens per instance (mean)', value: Math.round(tokensPer * 10) / 10, unit: 'tokens', command: cmd },
    { name: 'Helius credits per /api/match (mint)', value: credits(cMatch), unit: 'credits', command: cmd, detail: JSON.stringify(cMatch) },
    { name: 'Helius credits per /api/match (signature)', value: credits(cSig), unit: 'credits', command: cmd, detail: JSON.stringify(cSig) },
    { name: 'Helius credits per feed refresh (max)', value: credits(cFeed), unit: 'credits', command: cmd, detail: JSON.stringify(cFeed) },
  ],
};
fs.writeFileSync(path.join(root, 'bench/results.json'), JSON.stringify(results, null, 2) + '\n');

const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log(`machine: ${machine} · node ${process.version}`);
console.log(`reference: n=${reference.size} (${reference.stamped} stamped) ${JSON.stringify(reference.labels)}\n`);
console.log('| metric | value |\n|---|---|');
console.log(`| leave-one-out top-1 (stamps hidden, n=${acc.n}) | ${pct(acc.top1)} |`);
console.log(`| macro recall | ${pct(acc.macroRecall)} |`);
console.log(`| majority-class baseline | ${pct(acc.majorityBaseline)} |`);
console.log(`| abstained (unknown) | ${pct(acc.abstained)} |`);
console.log(`| top-1 without xfer.dest | ${pct(accNoDest.top1)} |`);
console.log(`| macro recall without xfer.dest | ${pct(accNoDest.macroRecall)} |`);
for (const b of results.bench) console.log(`| ${b.name} | ${b.value.toLocaleString('en-US')} ${b.unit} |`);
console.log('\n| label | n | recall | precision |\n|---|---|---|---|');
for (const p of acc.perLabel) console.log(`| ${p.label} | ${p.n} | ${pct(p.recall)} | ${pct(p.precision)} |`);
console.log('\nconfusion:', JSON.stringify(acc.confusion));
