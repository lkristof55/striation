// match(): weighted-Jaccard k-NN of one extraction against the reference instances.
//   J_w(A,B) = Σ_{t∈A∩B} w_t / Σ_{t∈A∪B} w_t
//   score(L) = (Σ sims of label L in the k nearest / Σ all k sims) × (best sim of label L)
// Unlabelled reference instances vote as their own class (null): a barrel that is mostly unstamped
// pushes the verdict to 'unknown' instead of borrowing a label from one stamped member.
import { tokensOf } from './extract.js';
import { FAMILIES, DEFAULT_WEIGHTS, TOOL_NAMES } from './tables.js';
import { sha256, crockford } from './bytes.js';

export const THRESHOLDS = { match: 0.7, margin: 0.15, family: 0.5 };

const familyOf = (t) => { const i = t.search(/[=~]/); return i < 0 ? t : t.slice(0, i); };
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;

/** Token list of an extraction or of a reference instance. */
export function tokenList(x) {
  if (Array.isArray(x)) return x;
  if (Array.isArray(x?.tokens)) return x.tokens;
  return tokensOf(x).map(([t]) => t);
}

function prepare(tokens, weights) {
  const m = new Map(), o = new Map();
  let total = 0, opt = 0;
  for (const t of tokens) {
    const f = familyOf(t);
    let w = weights[f] ?? 0;
    if (!w || m.has(t) || o.has(t)) continue;
    if (FAMILIES[f]?.numeric) w /= 2;
    if (FAMILIES[f]?.optional) { o.set(t, w); opt += w; } else { m.set(t, w); total += w; }
  }
  return { m, o, total, opt };
}

function simPrepared(a, b) {
  const both = a.opt > 0 && b.opt > 0;
  let inter = 0;
  const [s, l] = a.m.size <= b.m.size ? [a.m, b.m] : [b.m, a.m];
  for (const [t, w] of s) if (l.has(t)) inter += w;
  let union = a.total + b.total;
  if (both) {
    for (const [t, w] of a.o) if (b.o.has(t)) inter += w;
    union += a.opt + b.opt;
  }
  union -= inter;
  return union > 0 ? inter / union : 0;
}

/** similarity(a, b, weights?) → weighted Jaccard in [0, 1]. a, b: extraction, instance or token list. */
export function similarity(a, b, weights = DEFAULT_WEIGHTS) {
  return simPrepared(prepare(tokenList(a), weights), prepare(tokenList(b), weights));
}

const cache = new WeakMap();
function preparedReference(reference, weights) {
  const insts = reference.instances || reference;
  let byW = cache.get(insts);
  if (!byW) { byW = new Map(); cache.set(insts, byW); }
  const key = JSON.stringify(weights);
  if (!byW.has(key)) byW.set(key, insts.map((i) => prepare(i.tokens, weights)));
  return byW.get(key);
}

const exactValues = (tokens, fam) => tokens.filter((t) => t.startsWith(fam + '=')).map((t) => t.slice(fam.length + 1)).sort();

/**
 * barrelId(x) → 'B-' + 6 Crockford base32 chars of sha256 over a coarse key:
 * version | ALTs | cu.limit | cu.price | relay classes | other-transfer count | ix order | wrapper | mint-suffix class.
 */
export function barrelKey(x) {
  const t = tokenList(x);
  return ['version', 'alt', 'cu.limit', 'cu.price', 'tip.relay', 'xfer.count', 'ix.seq', 'wrapper', 'mint.suffix']
    .map((f) => exactValues(t, f).join(',') || '-').join('|');
}
export function barrelId(x) {
  return 'B-' + crockford(sha256(barrelKey(x)), 6);
}

/**
 * match(x, reference, { k = 5, weights, exclude }) →
 *   { verdict, label, displayName, confidence, margin, barrelId, closest, scores, neighbours, striations? }
 * exclude: mints/signatures to skip (the query itself when it is in the reference).
 */
export function match(x, reference, opts = {}) {
  const k = opts.k ?? 5;
  const weights = opts.weights || DEFAULT_WEIGHTS;
  const insts = reference.instances || reference;
  const prepped = preparedReference(reference, weights);
  const q = prepare(tokenList(x), weights);
  const excl = new Set([].concat(opts.exclude || []).filter(Boolean));
  if (x?.meta) { excl.add(x.meta.mint); excl.add(x.meta.signature); }
  if (x?.mint) excl.add(x.mint);
  if (x?.signature) excl.add(x.signature);

  // Top-k by similarity (insertion into a small sorted array: O(n·k), n ≤ 10k).
  const top = [];
  for (let i = 0; i < insts.length; i++) {
    const inst = insts[i];
    if (excl.has(inst.mint) || excl.has(inst.signature)) continue;
    const s = simPrepared(q, prepped[i]);
    if (top.length === k && s <= top[k - 1].s) continue;
    let j = top.length < k ? top.length : k - 1;
    top[j] = { i, s };
    while (j > 0 && top[j - 1].s < top[j].s) { [top[j - 1], top[j]] = [top[j], top[j - 1]]; j--; }
  }

  const total = top.reduce((a, b) => a + b.s, 0);
  const by = new Map();
  for (const { i, s } of top) {
    const L = insts[i].label ?? null;
    const e = by.get(L) || { sum: 0, max: 0 };
    e.sum += s; e.max = Math.max(e.max, s);
    by.set(L, e);
  }
  const scores = [...by].map(([label, e]) => ({ label, score: total > 0 ? (e.sum / total) * e.max : 0 })).sort((a, b) => b.score - a.score);
  const real = scores.filter((s) => s.label !== null);
  const nullScore = scores.find((s) => s.label === null)?.score ?? 0;
  const best = real[0] || null;
  const second = Math.max(real[1]?.score ?? 0, nullScore);
  const margin = best ? Math.max(0, best.score - second) : 0;

  let verdict = 'unknown';
  if (best && best.score >= THRESHOLDS.match && margin >= THRESHOLDS.margin) verdict = 'match';
  else if (best && best.score >= THRESHOLDS.family && best.score > nullScore) verdict = 'family';
  const label = verdict === 'unknown' ? null : best.label;

  const neighbours = top.map(({ i, s }) => ({
    mint: insts[i].mint, signature: insts[i].signature, symbol: insts[i].symbol ?? null,
    label: insts[i].label ?? null, similarity: r3(s), barrelId: insts[i].barrelId || barrelId(insts[i]),
  }));

  const out = {
    verdict, label, displayName: label ? TOOL_NAMES[label] || label : null,
    confidence: r2(best?.score ?? 0), margin: r2(margin), barrelId: barrelId(x),
    closest: best ? { label: best.label, displayName: TOOL_NAMES[best.label] || best.label, score: r2(best.score) } : null,
    scores: scores.map((s) => ({ label: s.label, score: r3(s.score) })),
    neighbours,
  };

  // Mark which striations also appear in the reference barrel we compare against: the nearest
  // neighbour with the predicted label (or the nearest neighbour when the verdict is unknown).
  if (Array.isArray(x?.striations)) {
    const ref = top.find(({ i }) => (insts[i].label ?? null) === label) || top[0];
    const set = new Set(ref ? insts[ref.i].tokens : []);
    out.striations = x.striations.map((s) => {
      const matched = set.has(s.id);
      const partial = !matched && !!s.bucket && set.has(s.bucket);
      return partial ? { ...s, matched, partial } : { ...s, matched };
    });
    out.comparedWith = ref ? { mint: insts[ref.i].mint, signature: insts[ref.i].signature, symbol: insts[ref.i].symbol ?? null, label: insts[ref.i].label ?? null } : null;
  }
  return out;
}

/** A compact reference instance from an extraction and its stamp-derived label. */
export function toInstance(ex, { label = null, stamp = null } = {}) {
  const tokens = tokensOf(ex).map(([t]) => t);
  return {
    mint: ex.meta.mint, signature: ex.meta.signature, symbol: ex.meta.symbol || null, blockTime: ex.meta.blockTime ?? null,
    label, stamp, barrelId: barrelId(tokens), tokens,
  };
}

/** buildReference(instances, info?) → the reference object match() and loadReference() use. */
export function buildReference(instances, info = {}) {
  const labels = {};
  for (const i of instances) if (i.label) labels[i.label] = (labels[i.label] || 0) + 1;
  const stamped = instances.filter((i) => i.label).length;
  return {
    format: 'striae-reference/1', builtAt: info.builtAt || new Date().toISOString(), source: info.source || null,
    size: instances.length, stamped, unlabelled: instances.length - stamped, labels, instances,
  };
}
