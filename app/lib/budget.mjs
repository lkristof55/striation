// Per-invocation budget of external fetches. Cloudflare Workers Free allows 50 subrequests per invocation and
// counts every retry and every redirect, work in ctx.waitUntil included. app/worker.mjs runs each request and
// each cron run inside withFetchBudget(n, fn); lib/sources.mjs sends every upstream call through budgetFetch.
// Outside a budget (Netlify, `npm run dev`, tests) budgetFetch is plain fetch.
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

/** Hops followed per request before the redirect response itself is returned (a non-ok response). */
export const MAX_REDIRECTS = 2;

export class BudgetError extends Error {
  constructor(message) { super(message); this.name = 'BudgetError'; this.code = 'UPSTREAM'; }
}

/** Run fn with a fresh budget of `limit` external fetches; the count survives awaits (AsyncLocalStorage). */
export function withFetchBudget(limit, fn) {
  return als.run({ limit, used: 0 }, fn);
}

/** { limit, used } of the running invocation, or null outside a budget. */
export const fetchBudget = () => als.getStore() || null;

/**
 * fetch() that charges every hop to the running budget. Redirects are followed by hand (at most MAX_REDIRECTS)
 * so each one is counted; when the budget is spent it throws BudgetError without calling fetch.
 */
export async function budgetFetch(url, init = {}) {
  const b = als.getStore();
  if (!b) return globalThis.fetch(url, init);
  let target = String(url);
  let opts = init;
  for (let hop = 0; ; hop++) {
    if (b.used >= b.limit) throw new BudgetError(`the budget of ${b.limit} external fetches for this invocation is spent`);
    b.used++;
    const res = await globalThis.fetch(target, { ...opts, redirect: 'manual' });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!loc || init.redirect === 'manual' || hop >= MAX_REDIRECTS) return res;
    try { await res.body?.cancel(); } catch { /* already consumed */ }
    target = new URL(loc, target).href;
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && opts.method === 'POST')) opts = { ...opts, method: 'GET', body: undefined };
  }
}
