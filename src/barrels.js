// Group reference instances into barrels (same coarse barrel key) and describe each barrel.
import { FAMILIES, TOOL_NAMES } from './tables.js';
import { barrelId } from './match.js';

const fmt = (n) => Number(n).toLocaleString('en-US');

/** Human text for one token, e.g. 'cu.price=3333333' → 'CU price 3,333,333 µλ'. */
export function describeToken(t) {
  const i = t.search(/[=~]/);
  if (i < 0) return t;
  const f = t.slice(0, i), v = t.slice(i + 1);
  if (t[i] === '~') return `${FAMILIES[f]?.display || f} ≈ ${v}`;
  switch (f) {
    case 'cu.limit': return `CU limit ${fmt(v)}`;
    case 'cu.price': return `CU price ${fmt(v)} µλ`;
    case 'cu.source': return `budget lives in ${v}`;
    case 'tip.lamports': return `tip ${(Number(v) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 6 })} SOL`;
    case 'tip.relay': return `tip relay ${v}`;
    case 'tip.position': return `tip ${v}`;
    case 'alt': return `lookup table ${v.slice(0, 6)}…`;
    case 'ix.seq': return v.split('>').join(' > ');
    case 'ix.shingle': return v.split('>').join(' → ');
    case 'version': return `tx version ${v}`;
    case 'xfer.count': return `${v} other transfer${v === '1' ? '' : 's'}`;
    case 'xfer.dest': return `transfer to ${v.slice(0, 6)}…`;
    case 'create.variant': return v.replace('+extend', ' + extend_account');
    case 'buy.variant': return v === 'none' ? 'no same-tx buy' : `same-tx ${v}`;
    case 'mint.suffix': return v === 'pump' ? 'mint …pump (ground vanity)' : 'mint not ground';
    case 'signers': return `${v} signers`;
    case 'wrapper': return `wrapper ${v.slice(0, 6)}…`;
    case 'followers.adjacent': return `${v} adjacent same-slot txs`;
    default: return `${f} ${v}`;
  }
}

const SIGNATURE_SKIP = new Set(['ix.shingle', 'xfer.dest', 'followers.adjacent']);

/**
 * summarizeBarrels(instances, { recent = [], max = 16 }) → barrel rows:
 * { barrelId, label, displayName, referenceCount, recentCount, share, signature, exemplar }
 * recent: items with { barrelId, tokens?, mint, signature, symbol, label? } from a live window.
 * label: the most common stamp label if it covers at least half of the barrel's reference members.
 */
export function summarizeBarrels(instances, { recent = [], max = 16 } = {}) {
  const groups = new Map();
  const get = (id) => { if (!groups.has(id)) groups.set(id, { barrelId: id, members: [], recent: [] }); return groups.get(id); };
  for (const inst of instances) get(inst.barrelId || barrelId(inst)).members.push(inst);
  for (const r of recent) get(r.barrelId).recent.push(r);
  const recentTotal = recent.length;
  const size = instances.length;

  const rows = [...groups.values()].map((g) => {
    const counts = {};
    for (const m of g.members) if (m.label) counts[m.label] = (counts[m.label] || 0) + 1;
    const [top, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [null, 0];
    const label = top && n >= g.members.length / 2 ? top : null;
    const pool = g.members.length ? g.members : g.recent.filter((r) => r.tokens);
    const freq = new Map();
    for (const m of pool) for (const t of new Set(m.tokens || [])) if (t.includes('=')) freq.set(t, (freq.get(t) || 0) + 1);
    const signature = [...freq]
      .filter(([t, c]) => c >= 0.8 * pool.length && !SIGNATURE_SKIP.has(t.slice(0, t.indexOf('='))))
      .map(([t]) => ({ t, family: t.slice(0, t.indexOf('=')) }))
      .sort((a, b) => (FAMILIES[b.family]?.weight || 0) - (FAMILIES[a.family]?.weight || 0))
      .slice(0, 6)
      .map(({ t, family }) => ({ family, display: describeToken(t) }));
    const ex = g.members.find((m) => m.label === label && m.stamp) || g.members[0] || g.recent[0];
    return {
      barrelId: g.barrelId, label, displayName: label ? TOOL_NAMES[label] || label : null,
      referenceCount: g.members.length, recentCount: g.recent.length,
      share: Math.round((recentTotal ? g.recent.length / recentTotal : g.members.length / (size || 1)) * 1000) / 1000,
      signature,
      exemplar: ex ? { mint: ex.mint, signature: ex.signature, symbol: ex.symbol ?? null } : null,
    };
  });

  const labelled = rows.filter((r) => r.label).sort((a, b) => (b.recentCount + b.referenceCount) - (a.recentCount + a.referenceCount));
  const unlabelled = rows.filter((r) => !r.label).sort((a, b) => b.recentCount - a.recentCount || b.referenceCount - a.referenceCount);
  const pickL = labelled.slice(0, Math.min(labelled.length, Math.ceil(max * 0.625)));
  return [...pickL, ...unlabelled.slice(0, max - pickL.length)];
}
