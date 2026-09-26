// SAMPLE data. Used only when /api/* does not answer (the engineer's backend is down or not deployed).
// Every screen that shows it carries the SAMPLE chip. The rows are two recorded pump.fun create txs
// (recorded 2026-09-25); the tokens come from the design's throwaway tokenizer, not the library,
// so the similarity and counts here are illustrative, never presented as a real /api/match result.
import rows from './probe-rows.json';

const W = {
  version: 1, 'cu.limit': 2, 'cu.price': 3, 'cu.source': 1, 'ix.seq': 3, 'ix.shingle': 0.5, alt: 4,
  'tip.relay': 2, 'tip.lamports': 1.5, 'tip.position': 1, 'xfer.count': 1, 'xfer.dest': 2,
  'create.variant': 1, 'buy.variant': 1.5, 'mint.suffix': 1.5, signers: 0.5, wrapper: 4, 'followers.adjacent': 1,
};
const le = (n, bytes) => { let h = ''; let v = BigInt(n); for (let i = 0; i < bytes; i++) { h += (v & 0xffn).toString(16).padStart(2, '0'); v >>= 8n; } return h; };
const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58hex = (s) => { let n = 0n; for (const c of s) n = n * 58n + BigInt(ALPH.indexOf(c)); let h = n.toString(16); if (h.length % 2) h = '0' + h; return h.padStart(64, '0'); };
const short = (k) => `${k.slice(0, 4)}…${k.slice(-4)}`;

function tokenize(row) {
  const t = [];
  const add = (family, value, display, hex = null, where = 'ix', ixIndex = null) =>
    t.push({ id: `${family}=${value}`, family, value: String(value), display, weight: W[family], matched: false, source: { where, ixIndex, hex } });
  const seq = row.ixSequence;
  add('version', row.version, `tx version ${row.version === 0 ? 'v0' : row.version === 1 ? 'v1' : 'legacy'}`, null, 'meta');
  const cb = row.computeBudgetIx; const v1 = row.v1Config;
  const lim = cb?.limit ?? v1?.computeUnitLimit; const price = cb?.price ?? v1?.priorityFee;
  if (lim) add('cu.limit', lim, `CU limit ${lim.toLocaleString('en-US')}`, cb ? '02' + le(lim, 4) : null, cb ? 'ix' : 'config', seq.indexOf('cb.limit'));
  if (price) add('cu.price', price, `CU price ${price.toLocaleString('en-US')} µλ`, cb ? '03' + le(price, 8) : null, cb ? 'ix' : 'config', seq.indexOf('cb.price'));
  add('cu.source', cb ? 'ix' : v1 ? 'v1-config' : 'none', `budget lives in ${cb ? 'ix' : v1 ? 'v1 config' : 'none'}`, null, 'meta');
  add('ix.seq', seq.join('>'), seq.join(' › '), null, 'meta');
  for (let i = 0; i < seq.length - 1; i++) add('ix.shingle', `${seq[i]}>${seq[i + 1]}`, `${seq[i]} › ${seq[i + 1]}`, null, 'meta');
  for (const a of row.alt || []) add('alt', a, `lookup table ${short(a)}`, b58hex(a), 'key');
  const createAt = seq.findIndex((s) => s.startsWith('pump.create'));
  let other = 0; let xi = -1;
  row.transfers.forEach((x) => {
    xi = seq.indexOf('sys.transfer', xi + 1);
    if (x.relay !== 'unknown') {
      add('tip.relay', x.relay, `tip relay ${x.relay}`, b58hex(x.to), 'key', xi);
      add('tip.lamports', x.lamports, `tip ${(x.lamports / 1e9).toFixed(4)} sol`, '02000000' + le(x.lamports, 8), 'ix', xi);
      add('tip.position', xi > createAt ? 'after-create' : 'before-create', `tip ${xi > createAt ? 'after' : 'before'} create`, null, 'meta');
    } else { other++; add('xfer.dest', x.to, `transfer → ${short(x.to)}`, b58hex(x.to), 'key', xi); }
  });
  add('xfer.count', other, `other transfers ${other}`, null, 'meta');
  add('create.variant', 'create_v2', 'create_v2', 'd6904cec5f8b31b4', 'args', createAt);
  const buy = seq.find((s) => s.startsWith('pump.buy'));
  add('buy.variant', buy ? buy.replace('pump.', '') : 'none', `same-tx ${buy ? buy.replace('pump.', '') : 'none'}`, buy === 'pump.buy' ? '66063d1201daebea' : null, 'args', buy ? seq.indexOf(buy) : null);
  add('mint.suffix', row.mintSuffixPump ? 'pump' : 'other', `mint suffix ${row.mintSuffixPump ? '…pump' : 'not ground'}`, null, 'meta');
  add('signers', row.numSigners, `signers ${row.numSigners}`, null, 'meta');
  return t;
}

const jw = (a, b) => {
  const wb = new Map(b.map((x) => [x.id, x.weight])); let i = 0; let u = 0;
  for (const x of a) { if (wb.has(x.id)) i += x.weight; u += x.weight; }
  const ia = new Set(a.map((x) => x.id)); for (const x of b) if (!ia.has(x.id)) u += x.weight;
  return u ? i / u : 0;
};

const ex = rows.find((r) => r.role === 'exemplar');
const nb = rows.find((r) => r.role === 'neighbour');
const exT = tokenize(ex); const nbT = tokenize(nb);
const nbIds = new Set(nbT.map((t) => t.id));
for (const t of exT) t.matched = nbIds.has(t.id);
for (const t of nbT) t.matched = exT.some((e) => e.id === t.id);
exT.sort((a, b) => b.weight - a.weight); nbT.sort((a, b) => b.weight - a.weight);
const sim = Math.round(jw(exT, nbT) * 1000) / 1000;

export const SAMPLE_FEATURED = {
  mint: ex.mint, signature: ex.signature, slot: ex.slot, blockTime: null, version: ex.version,
  name: 'CHILL', symbol: 'CHILL', uri: '', via: 'top-level',
  verdict: 'match', label: 'j7tracker', displayName: 'j7tracker', confidence: sim, margin: 0,
  barrelId: 'B-SAMPLE', stamp: null, stampAgrees: null, striations: exT,
  neighbours: [{ mint: nb.mint, signature: nb.signature, symbol: null, label: 'j7tracker', similarity: sim, barrelId: 'B-SAMPLE' }],
  followers: null, barrelMates: { reference: 0, recent: 0, windowMinutes: 30, sample: [] },
  source: 'fixture', cached: true, ms: 0, sample: true, _txIndex: ex.txIndex,
};
export const SAMPLE_NEIGHBOUR = { ...SAMPLE_FEATURED, mint: nb.mint, signature: nb.signature, slot: nb.slot, symbol: null, name: '', striations: nbT, sample: true };
export const SAMPLE_FEED = {
  updatedAt: new Date(0).toISOString(), source: 'fixture', windowSeconds: 0, ratePerMin: 0, stampedShare: 0,
  items: [], barrels: [], featured: SAMPLE_FEATURED, sample: true,
};
