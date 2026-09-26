// classify(): the full read path for one mint or signature (I/O through an injected RPC client).
import { extract, stampsFromMetadata, StriaeError } from './extract.js';
import { match } from './match.js';
import { firstTransactions, getTransaction, fetchMetadata, getTransactions, recentCreateSignatures } from './rpc.js';
import { BASE58_ADDRESS, BASE58_SIGNATURE } from './bytes.js';

/** 'mint' | 'sig' | null for a user-supplied string. */
export function inputKind(s) {
  if (typeof s !== 'string') return null;
  if (BASE58_ADDRESS.test(s)) return 'mint';
  if (BASE58_SIGNATURE.test(s)) return 'sig';
  return null;
}

/**
 * Find the create transaction: for a mint, the first successful tx (oldest first) that holds a
 * pump.fun create of this mint; the rest are its followers. For a signature, that one transaction.
 * → { ex, followers } (throws StriaeError NOT_FOUND / NOT_PUMP_CREATE / BAD_INPUT)
 */
export async function findCreate(rpc, input, { metadata = true, fetch } = {}) {
  const kind = inputKind(input);
  if (!kind) throw new StriaeError('not a base58 mint address or transaction signature', 'BAD_INPUT');
  let ex;
  if (kind === 'sig') {
    const tx = await getTransaction(rpc, input);
    if (!tx) throw new StriaeError('no transaction with this signature', 'NOT_FOUND');
    ex = extract(tx);
  } else {
    const txs = await firstTransactions(rpc, input, { limit: 8 });
    if (!txs.length) throw new StriaeError('no transactions for this address', 'NOT_FOUND');
    for (const tx of txs) {
      if (tx?.meta?.err) continue;
      try { ex = extract(tx, { mint: input, followers: txs.filter((t) => t !== tx) }); break; } catch { /* not the create */ }
    }
    if (!ex) throw new StriaeError('the first transactions of this address hold no pump.fun create for it', 'NOT_PUMP_CREATE');
  }
  if (metadata) {
    const md = await fetchMetadata(ex.meta.uri, fetch ? { fetch } : {});
    if (md) ex.stamps.push(...stampsFromMetadata(md));
  }
  return ex;
}

/** Match an extraction and fold in the stamp check: stampAgrees is null when there is no stamp. */
export function verdictFor(ex, reference, opts = {}) {
  const m = match(ex, reference, opts);
  const agreeing = ex.stamps.find((s) => s.label === m.label);
  const stamp = agreeing || ex.stamps[0] || null;
  return {
    ...ex.meta,
    verdict: m.verdict, label: m.label, displayName: m.displayName, confidence: m.confidence, margin: m.margin,
    barrelId: m.barrelId, closest: m.closest,
    stamp, stampAgrees: stamp ? stamp.label === m.label : null,
    striations: m.striations, neighbours: m.neighbours, comparedWith: m.comparedWith,
    followers: ex.followers,
  };
}

/** classify(rpc, mintOrSignature, reference, opts) → verdict object (see verdictFor). */
export async function classify(rpc, input, reference, opts = {}) {
  const ex = await findCreate(rpc, input, opts);
  return verdictFor(ex, reference, opts);
}

/**
 * pollCreates(rpc, { limit = 40, max = 18, known }) → one refresh of the create-only feed:
 * 1 getSignaturesForAddress on the pump.fun mint authority + at most `max` getTransaction
 * (batches of 10, 400 ms apart). `known` is a Set of signatures already processed.
 * → { signatures, fresh: [{ sig, ex | null, error? }], ratePerMin, windowSeconds, failed }
 */
export async function pollCreates(rpc, { limit = 40, max = 18, known = new Set(), batchSize = 10, gapMs = 400 } = {}) {
  const sigs = (await recentCreateSignatures(rpc, { limit })) || [];
  const ok = sigs.filter((s) => !s.err);
  const times = sigs.map((s) => s.blockTime).filter(Boolean);
  const windowSeconds = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0;
  const ratePerMin = windowSeconds > 0 ? Math.round((ok.length / windowSeconds) * 60 * 10) / 10 : 0;
  const todo = ok.filter((s) => !known.has(s.signature)).slice(0, max);
  const txs = await getTransactions(rpc, todo.map((s) => s.signature), { batchSize, gapMs });
  const fresh = todo.map((sig, i) => {
    const tx = txs[i];
    if (!tx) return { sig, ex: null, error: 'NOT_FOUND' };
    try { return { sig, ex: extract({ ...tx, transactionIndex: tx.transactionIndex ?? sig.transactionIndex }) }; } catch (e) { return { sig, ex: null, error: e.code || 'NOT_PUMP_CREATE' }; }
  });
  return { signatures: sigs, fresh, ratePerMin, windowSeconds, failed: sigs.length - ok.length };
}
