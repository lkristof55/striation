// Capture real mainnet responses once (needs HELIUS_API_KEY; `set -a; . ./.env; set +a` inside app/):
//   node test/record.mjs [mint ...]
// Writes lib/featured-fixture.json (the /api/feed hero fallback, labelled source:'fixture' → SAMPLE on
// the site) and test/fixtures/match-*.json (MatchResults used by the offline tests).
// Token names are attacker-controlled: matchInput() already masks name/symbol (lib/mask.mjs); a result
// that still carries a slur or an account handle in any text field is not written (see test/mask.test.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useStoreDir } from '../lib/store.mjs';
import { isOffensive } from '../lib/mask.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
useStoreDir(fs.mkdtempSync(path.join(os.tmpdir(), 'striation-record-')));
const { matchInput } = await import('../lib/service.mjs');

const TEXT_KEYS = /^(name|symbol|evidence|label|displayName)$/;
const HANDLE = /(?<![\w.])@[A-Za-z0-9_]{2,15}\b|(?:x|twitter)\.com\//;
/** The key of the first string in v that is a slur (text fields) or holds an account handle, else null. */
function unsafeKey(v) {
  let bad = null;
  JSON.stringify(v, (k, x) => {
    if (!bad && typeof x === 'string' && ((TEXT_KEYS.test(k) && isOffensive(x)) || HANDLE.test(x))) bad = k;
    return x;
  });
  return bad;
}

// Default candidates: stamped live creates from the recorded corpus (j7tracker fast mode, uxento, rapidlaunch).
const ref = JSON.parse(fs.readFileSync(path.join(root, '../data/reference.json'), 'utf8'));
const byLabel = (l) => ref.instances.filter((i) => i.label === l).slice(-3).map((i) => i.mint);
const mints = process.argv.slice(2).length ? process.argv.slice(2) : [...byLabel('j7tracker'), ...byLabel('uxento'), ...byLabel('rapidlaunch')];

let featured = null;
for (const mint of mints) {
  try {
    const r = await matchInput({ kind: 'mint', value: mint });
    console.log(`${mint} → ${r.verdict} ${r.label} ${r.confidence} ${r.barrelId} stamp=${r.stamp?.label ?? '-'} agrees=${r.stampAgrees} ${r.ms}ms`);
    const bad = unsafeKey(r);
    if (bad) { console.log(`  not written: unsafe text in ${bad}`); continue; }
    const name = `match-${r.label || 'unknown'}`;
    if (!fs.existsSync(path.join(root, `test/fixtures/${name}.json`))) fs.writeFileSync(path.join(root, `test/fixtures/${name}.json`), JSON.stringify(r, null, 1));
    if (!featured && r.verdict === 'match' && r.stampAgrees !== false) featured = r;
  } catch (e) {
    console.log(`${mint} → ${e.code}: ${e.message}`);
  }
}
if (featured) {
  fs.writeFileSync(path.join(root, 'lib/featured-fixture.json'), JSON.stringify({ recordedAt: new Date().toISOString(), input: featured.mint, result: { ...featured, source: 'fixture', cached: true } }, null, 1));
  console.log(`featured fixture: ${featured.symbol} ${featured.label} ${featured.confidence}`);
}
