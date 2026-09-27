// summarizeTop (lib/service.mjs) must return exactly what the library's summarizeBarrels returns: same rows,
// same order, same bytes. It only skips describing the barrels that do not make the cut. Random windows
// over the bundled reference plus synthetic live instances, with a seeded PRNG so a failure reproduces.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useStoreDir } from '../lib/store.mjs';
import { summarizeBarrels } from '../../src/barrels.js';

useStoreDir(fs.mkdtempSync(path.join(os.tmpdir(), 'striation-top-')));
const { summarizeTop } = await import('../lib/service.mjs');
const bundled = JSON.parse(fs.readFileSync(new URL('../../data/reference.json', import.meta.url)));

function prng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }
const LABELS = ['j7tracker', 'uxento', 'rapidlaunch', 'usepaid', 'axiom', null, null];

function windowCase(rand) {
  const insts = bundled.instances.filter(() => rand() < 0.2 + rand() * 0.8);
  const live = Array.from({ length: Math.floor(rand() * 300) }, (_, k) => {
    const b = bundled.instances[Math.floor(rand() * bundled.instances.length)];
    const fresh = rand() < 0.3; // a barrel the reference has never seen
    return { ...b, mint: `live-${k}`, signature: `sig-live-${k}`, label: LABELS[Math.floor(rand() * LABELS.length)] ?? 'j7tracker', barrelId: fresh ? `B-NEW${k % 17}` : b.barrelId };
  });
  const noId = rand() < 0.3 ? insts.slice(0, 3).map(({ barrelId, ...i }) => ({ ...i, mint: `${i.mint}-x` })) : [];
  const pool = [...insts, ...live];
  const recent = Array.from({ length: Math.floor(rand() * 130) }, (_, k) => {
    const b = pool[Math.floor(rand() * pool.length)] || bundled.instances[0];
    const only = rand() < 0.2; // a barrel only the live window has
    return { mint: `r-${k}`, signature: `sig-r-${k}`, symbol: 'R', label: LABELS[Math.floor(rand() * LABELS.length)], barrelId: only ? `B-RCNT${k % 5}` : b.barrelId, ...(rand() < 0.9 ? { tokens: b.tokens } : {}) };
  });
  return { instances: [...insts, ...noId, ...live], recent, max: [16, 16, 16, 8, 3, 40][Math.floor(rand() * 6)] };
}

test('summarizeTop equals the library summarizeBarrels on 300 random windows', () => {
  const rand = prng(20260927);
  for (let c = 0; c < 300; c++) {
    const { instances, recent, max } = windowCase(rand);
    const want = summarizeBarrels(instances, { recent, max });
    const got = summarizeTop(instances, { recent, max });
    assert.equal(JSON.stringify(got), JSON.stringify(want), `case ${c}: ${instances.length} instances, ${recent.length} recent, max ${max}`);
  }
});

test('summarizeTop equals the library on the edges: empty window, empty reference, everything', () => {
  for (const [instances, recent] of [[bundled.instances, []], [[], []], [[], bundled.instances.slice(0, 20)], [bundled.instances, bundled.instances.slice(0, 50)]]) {
    assert.equal(JSON.stringify(summarizeTop(instances, { recent, max: 16 })), JSON.stringify(summarizeBarrels(instances, { recent, max: 16 })));
  }
});
