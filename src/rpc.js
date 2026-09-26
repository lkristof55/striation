// Minimal JSON-RPC client and the three reads striae needs. Isomorphic: uses the global fetch
// (or one you inject), no node: imports. Every call has a timeout and retries HTTP 429 with backoff.

export const PUMP_MINT_AUTHORITY = 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';

/** Credits per method on Helius (docs, 2026-09): used by bench/credits and the README budget. */
export const HELIUS_CREDITS = { getTransactionsForAddress: 10, getTransaction: 1, getSignaturesForAddress: 1 };

export class RpcError extends Error {
  constructor(message, code, status) { super(message); this.code = code; this.status = status; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * createRpc(url, { fetch, timeoutMs = 8000, retries = 2, onCall })
 * onCall(method, n) is called once per JSON-RPC method invocation (for credit accounting).
 */
export function createRpc(url, opts = {}) {
  const f = opts.fetch || globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const retries = opts.retries ?? 2;
  const onCall = opts.onCall || (() => {});
  let id = 0;

  async function post(body) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await f(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        if (attempt < retries && e?.name !== 'TimeoutError') { await sleep(400 * 2 ** attempt); continue; }
        throw new RpcError(e?.name === 'TimeoutError' ? `RPC timeout after ${timeoutMs} ms` : 'RPC unreachable', 'UPSTREAM', 502);
      }
      if (res.status === 429) {
        if (attempt < retries) { await sleep(600 * 2 ** attempt + Math.random() * 200); continue; }
        throw new RpcError('RPC rate limited (HTTP 429)', 'RATE_LIMITED', 429);
      }
      if (!res.ok) {
        if (res.status >= 500 && attempt < retries) { await sleep(400 * 2 ** attempt); continue; }
        throw new RpcError(`RPC HTTP ${res.status}`, 'UPSTREAM', 502);
      }
      try { return await res.json(); } catch { throw new RpcError('RPC returned non-JSON', 'UPSTREAM', 502); }
    }
  }

  async function call(method, params) {
    onCall(method, 1);
    const j = await post({ jsonrpc: '2.0', id: ++id, method, params });
    if (j.error) throw new RpcError(`${method}: ${j.error.message || 'RPC error'}`, j.error.code === -32601 ? 'METHOD_NOT_FOUND' : 'UPSTREAM', 502);
    return j.result;
  }

  /** batch([[method, params], ...]) → results in order (null for per-item errors). */
  async function batch(calls) {
    if (!calls.length) return [];
    for (const [m] of calls) onCall(m, 1);
    const base = id;
    const j = await post(calls.map(([method, params], i) => ({ jsonrpc: '2.0', id: base + i + 1, method, params })));
    id += calls.length;
    if (!Array.isArray(j)) throw new RpcError('RPC batch returned no array', 'UPSTREAM', 502);
    const byId = new Map(j.map((r) => [r.id, r]));
    return calls.map((_, i) => { const r = byId.get(base + i + 1); return r && !r.error ? r.result : null; });
  }

  return { call, batch };
}

const TX_OPTS = { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' };

export function getTransaction(rpc, signature) {
  return rpc.call('getTransaction', [signature, TX_OPTS]);
}

/**
 * Fetch many transactions in JSON-RPC batches (default 10 per batch, 400 ms apart: a batch of 40
 * got HTTP 429 on a shared Helius key).
 */
export async function getTransactions(rpc, signatures, { batchSize = 10, gapMs = 400 } = {}) {
  const out = [];
  for (let i = 0; i < signatures.length; i += batchSize) {
    if (i) await sleep(gapMs);
    out.push(...(await rpc.batch(signatures.slice(i, i + batchSize).map((s) => ['getTransaction', [s, TX_OPTS]]))));
  }
  return out;
}

/**
 * The first transactions of a mint, oldest first: the create tx plus its same-slot followers.
 * Helius getTransactionsForAddress (10 credits, one call). Falls back to standard RPC
 * (getSignaturesForAddress paged to the oldest signature, max `maxPages` pages, then getTransaction).
 * Returns an array of full transactions (may be empty).
 */
export async function firstTransactions(rpc, address, { limit = 8, maxPages = 5 } = {}) {
  try {
    const r = await rpc.call('getTransactionsForAddress', [address, { transactionDetails: 'full', sortOrder: 'asc', limit, ...TX_OPTS }]);
    return r?.data || [];
  } catch (e) {
    if (e.code !== 'METHOD_NOT_FOUND') throw e;
  }
  let before;
  let oldest = [];
  for (let p = 0; p < maxPages; p++) {
    const page = await rpc.call('getSignaturesForAddress', [address, { limit: 1000, ...(before ? { before } : {}) }]);
    if (!page?.length) break;
    oldest = page;
    before = page[page.length - 1].signature;
    if (page.length < 1000) break;
  }
  const sigs = oldest.slice(-limit).reverse().map((s) => s.signature);
  return (await getTransactions(rpc, sigs)).filter(Boolean);
}

/** Newest signatures that touched the pump.fun mint authority: a create-only feed (1 credit). */
export function recentCreateSignatures(rpc, { limit = 40, before, until } = {}) {
  return rpc.call('getSignaturesForAddress', [PUMP_MINT_AUTHORITY, { limit, ...(before ? { before } : {}), ...(until ? { until } : {}) }]);
}

/** Off-chain metadata JSON at a create uri. Fails soft (returns null). */
export async function fetchMetadata(uri, { fetch: f = globalThis.fetch, timeoutMs = 5000 } = {}) {
  if (!uri || typeof uri !== 'string') return null;
  let u = uri.trim();
  if (u.startsWith('ipfs://')) u = 'https://ipfs.io/ipfs/' + u.slice(7);
  if (!/^https:\/\//.test(u)) return null;
  try {
    const r = await f(u, { headers: { 'user-agent': 'Mozilla/5.0 (striae metadata reader)', accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const text = await r.text();
    if (text.length > 64_000) return null;
    const j = JSON.parse(text);
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}
