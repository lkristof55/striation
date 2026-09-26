// Offline: extract a recorded create tx and match it against the bundled reference.
//   node examples/offline.js
import fs from 'node:fs';
import { extract, match, loadReference } from '../src/index.js';

const { tx, followers } = JSON.parse(fs.readFileSync(new URL('../test/fixtures/uxento-followers.json', import.meta.url), 'utf8'));
const ex = extract(tx, { followers });
const r = match(ex, loadReference());
console.log(`${ex.meta.symbol}: ${r.verdict} ${r.label ?? 'unknown barrel'} ${r.confidence} ${r.barrelId}`);
console.log('stamps (never used as features):', ex.stamps);
for (const s of r.striations.slice(0, 8)) console.log(`  ${s.matched ? '●' : '○'} ${s.family.padEnd(18)} ${s.display}`);
