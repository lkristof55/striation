#!/usr/bin/env node
// data/corpus.json.gz → data/reference.json (offline, deterministic).
//   node scripts/build-reference.js
// Labels come only from stamps: a cited fee collector or a tool metadata host (on the create itself),
// else the description stamp recorded for the graduate / fetched for the live create.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract, stampsFromMetadata } from '../src/extract.js';
import { toInstance, buildReference } from '../src/match.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function loadCorpus() {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, 'data/corpus.json.gz'))).toString('utf8'));
}

export function corpusItems(corpus) {
  const items = [];
  const seen = new Set();
  const stats = { skipped: 0, conflicts: [], hosts: {} };
  for (const g of corpus.graduates) {
    let ex;
    try { ex = extract(g.tx, { mint: g.row.mint, followers: g.followers }); } catch { stats.skipped++; continue; }
    const desc = { label: g.row.label, kind: 'desc', evidence: (g.row.descSnippet || (g.row.label === 'axiom' ? 'axiom.trade/t/' : g.row.label)).slice(0, 120) };
    const onchain = ex.stamps.find((s) => s.kind === 'fee.wallet' || s.kind === 'uri.host');
    if (onchain && onchain.label !== desc.label) stats.conflicts.push(`${g.row.mint} desc=${desc.label} ${onchain.kind}=${onchain.label}`);
    ex.stamps.push(desc);
    const stamp = onchain || desc;
    items.push({ ex, tx: g.tx, followers: g.followers, origin: 'graduate', label: stamp.label, stamp });
    seen.add(ex.meta.mint);
  }
  for (const l of corpus.live) {
    let ex;
    try { ex = extract(l.tx, { metadata: l.metadata }); } catch { stats.skipped++; continue; }
    if (seen.has(ex.meta.mint)) continue;
    seen.add(ex.meta.mint);
    const h = ex.meta.uriHost || 'none';
    stats.hosts[h] = (stats.hosts[h] || 0) + 1;
    const stamp = ex.stamps.find((s) => s.kind === 'fee.wallet') || ex.stamps.find((s) => s.kind === 'uri.host') || ex.stamps[0] || null;
    items.push({ ex, tx: l.tx, metadata: l.metadata, origin: 'live', label: stamp?.label ?? null, stamp });
  }
  return { items, stats };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const corpus = loadCorpus();
  const { items, stats } = corpusItems(corpus);
  const ref = buildReference(items.map((i) => toInstance(i.ex, { label: i.label, stamp: i.stamp })), {
    builtAt: corpus.recordedAt,
    source: `data/corpus.json.gz: ${corpus.graduates.length} description-labelled graduates (create + same-slot followers) and ${corpus.live.length} live creates from the pump.fun mint-authority feed, recorded ${corpus.recordedAt}`,
  });
  fs.writeFileSync(path.join(root, 'data/reference.json'), JSON.stringify(ref));
  console.log(`reference: ${ref.size} instances, ${ref.stamped} stamped, ${ref.unlabelled} unlabelled; labels ${JSON.stringify(ref.labels)}; skipped ${stats.skipped}`);
  console.log(`stamp conflicts (desc vs on-chain/host): ${stats.conflicts.length}`, stats.conflicts.slice(0, 10));
  console.log('live uri hosts:', Object.entries(stats.hosts).sort((a, b) => b[1] - a[1]).slice(0, 12));
}
