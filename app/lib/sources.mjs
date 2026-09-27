// Upstream I/O. One wrapper per upstream; every call has an 8 s timeout and 429 retries with backoff
// (implemented in the library, src/rpc.js at the repo root, which the functions share with the library). Keys come from env.
// Every fetch goes through budgetFetch (lib/budget.mjs): plain fetch on Netlify, counted against the
// invocation's subrequest budget on Cloudflare.
import { createRpc, fetchMetadata as fetchMetadataRaw, RpcError } from '../../src/rpc.js';
import { budgetFetch } from './budget.mjs';

let heliusRpc = null;
let heliusKey = null;

/** Helius mainnet RPC (getTransactionsForAddress, getTransaction, getSignaturesForAddress). */
export function helius() {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new RpcError('HELIUS_API_KEY is not set on the server', 'UPSTREAM', 502);
  if (!heliusRpc || key !== heliusKey) {
    heliusKey = key;
    heliusRpc = createRpc(`https://mainnet.helius-rpc.com/?api-key=${key}`, { timeoutMs: 8000, retries: 2, fetch: budgetFetch });
  }
  return heliusRpc;
}

/** Off-chain token metadata JSON (no key). Short timeout: stamps are optional, fail soft. */
export function fetchMetadata(uri, timeoutMs = 3500) {
  return fetchMetadataRaw(uri, { timeoutMs, fetch: budgetFetch });
}
