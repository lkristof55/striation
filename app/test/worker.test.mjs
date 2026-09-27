// Offline tests of app/worker.mjs (the Cloudflare entry): every /api path reaches its Netlify handler, other
// paths go to the static assets, scheduled() runs the feed refresh into D1 within the Workers Free budgets, and
// /api/feed only serves the stored snapshot. The RPC is a stub that answers from the library's recorded
// corpus (data/corpus.json.gz, scrubbed); metadata hosts answer 404. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createFakeD1 } from './fake-d1.mjs';
import { withFetchBudget, budgetFetch, fetchBudget, MAX_REDIRECTS } from '../lib/budget.mjs';

process.env.HELIUS_API_KEY = 'test-key-not-real';
const schema = fs.readFileSync(new URL('../migrations/0001_kv.sql', import.meta.url), 'utf8');
const corpus = JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL('../../data/corpus.json.gz', import.meta.url))));

// ---- network stub: Helius JSON-RPC from the corpus (block times moved to now), everything else 404 ----
const net = { rpc: {}, other: 0, total: 0 };
let now = Math.floor(Date.now() / 1000);
const live = corpus.live.slice(0, 30).map((l, i) => ({ sig: { ...l.sig, blockTime: now - 5 * i }, tx: { ...l.tx, blockTime: now - 5 * i } }));
const bySig = new Map(live.map((l) => [l.sig.signature, l.tx]));
globalThis.fetch = async (url, init = {}) => {
  net.total++;
  if (!String(url).startsWith('https://mainnet.helius-rpc.com/')) { net.other++; return new Response('not found', { status: 404 }); }
  const body = JSON.parse(init.body);
  const one = (r) => {
    net.rpc[r.method] = (net.rpc[r.method] || 0) + 1;
    if (r.method === 'getSignaturesForAddress') return { jsonrpc: '2.0', id: r.id, result: live.map((l) => l.sig).slice(0, r.params[1]?.limit ?? 1000) };
    if (r.method === 'getTransaction') return { jsonrpc: '2.0', id: r.id, result: bySig.get(r.params[0]) ?? null };
    return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'Method not found' } };
  };
  return Response.json(Array.isArray(body) ? body.map(one) : one(body));
};
const resetNet = () => { net.rpc = {}; net.other = 0; net.total = 0; };

const { default: worker, routes, scheduledFunctions } = await import('../worker.mjs');
const svc = await import('../lib/service.mjs');
const { getStore } = await import('../lib/store.mjs');

const assets = [];
const waits = [];
const env = {
  DB: createFakeD1(schema),
  ASSETS: { fetch: async (req) => { assets.push(new URL(req.url).pathname); return new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }); } },
  CF_FREE_PLAN: '1',
};
const ctx = { waitUntil: (p) => waits.push(p), passThroughOnException() {} };
const get = async (path) => { const r = await worker.fetch(new Request(`https://striation.example${path}`, { headers: { 'cf-connecting-ip': '203.0.113.7' } }), env, ctx); return { r, j: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }; };

test('every /api path reaches its handler (cold store, no network)', async () => {
  resetNet();
  const reached = {};
  let x = await get('/api/health');
  assert.equal(x.r.status, 200); assert.equal(x.j.project, 'striation'); assert.equal(x.j.keys.helius, true); reached['/api/health'] = 1;
  x = await get('/api/health/');
  assert.equal(x.j.project, 'striation', 'trailing slash, as on Netlify');
  x = await get('/api/stats');
  assert.equal(x.r.status, 200); assert.ok(x.j.accuracy && x.j.bench); reached['/api/stats'] = 1;
  x = await get('/api/barrels');
  assert.equal(x.r.status, 200); assert.equal(x.j.reference.size, 487); assert.ok(x.j.barrels.length > 0); reached['/api/barrels'] = 1;
  x = await get('/api/feed?limit=12');
  assert.equal(x.r.status, 200);
  assert.equal(x.j.warming, true, 'an empty store answers warming up');
  assert.equal(x.j.source, 'fixture');
  assert.equal(x.j.stale, true);
  assert.equal(x.j.refreshSeconds, 300);
  assert.equal(x.j.featured.source, 'fixture');
  assert.deepEqual(x.j.items, []);
  reached['/api/feed'] = 1;
  x = await get('/api/feed?limit=99');
  assert.equal(x.r.status, 400); assert.equal(x.j.code, 'BAD_INPUT');
  x = await get('/api/match');
  assert.equal(x.r.status, 400); assert.equal(x.j.code, 'BAD_INPUT'); reached['/api/match'] = 1;
  const post = await worker.fetch(new Request('https://striation.example/api/match?mint=x', { method: 'POST' }), env, ctx);
  assert.equal(post.status, 405);
  assert.deepEqual(Object.keys(reached).sort(), routes.map((r) => r.path).sort(), 'every function with a config.path is routed and tested');
  assert.equal(net.total, 0, 'no endpoint above calls upstream');
  assert.equal(waits.length, 0, '/api/feed never refreshes in waitUntil');
});

test('paths that are not functions go to the static assets', async () => {
  assets.length = 0;
  for (const p of ['/', '/index.html', '/404', '/app.js', '/api/nope', '/apix/health', '/api']) await get(p);
  assert.deepEqual(assets, ['/', '/index.html', '/404', '/app.js', '/api/nope', '/apix/health', '/api']);
});

test('scheduled() runs the feed refresh into D1 with the Workers Free budgets', async () => {
  assert.deepEqual(scheduledFunctions.map((f) => [f.name, f.schedule]), [['feed-refresh', '*/5 * * * *']]);
  const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.match(wrangler, /"crons": \["\*\/5 \* \* \* \*"\]/, 'wrangler.jsonc has the same, single schedule');
  resetNet();
  await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, env, ctx);
  const state = await (await getStore('recent')).get('state');
  assert.ok(state, 'the cron stored a snapshot');
  assert.equal(svc.runtime.refreshMax, 6);
  assert.equal(svc.runtime.refLiveCap, 300);
  assert.equal(svc.runtime.scheduledOnly, true);
  assert.equal(state.items.length, 6, 'CF_FREE_PLAN=1 classifies 6 creates per run');
  assert.equal(net.rpc.getSignaturesForAddress, 1);
  assert.equal(net.rpc.getTransaction, 6);
  assert.ok(net.total <= 45, `${net.total} external fetches`);
  assert.equal(net.other, 6, 'one metadata fetch per create (404 here, so no stamps)');

  // a second run classifies the next 6 newest unknown creates and keeps the window
  resetNet();
  await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, env, ctx);
  const state2 = await (await getStore('recent')).get('state');
  assert.equal(state2.items.length, 12);
  assert.equal(new Set(state2.items.map((i) => i.signature)).size, 12);

  // /api/feed and /api/barrels now serve that snapshot, with no upstream call
  resetNet();
  const f = (await get('/api/feed?limit=40')).j;
  assert.equal(f.source, 'live');
  assert.equal(f.items.length, 12);
  assert.equal(f.stale, undefined);
  assert.equal(f.warming, undefined);
  assert.equal(f.updatedAt, state2.updatedAt);
  assert.match(f.sampled.note, /at most 6 of the newest creates/);
  for (const k of ['updatedAt', 'source', 'windowSeconds', 'ratePerMin', 'stampedShare', 'sampled', 'items', 'barrels', 'featured']) assert.ok(k in f, k);
  const b = (await get('/api/barrels')).j;
  assert.equal(b.updatedAt, state2.updatedAt, 'barrels and feed read the same snapshot');
  assert.equal(b.recentWindow.sampled, 12);
  const view = await (await getStore('recent')).get('barrels-view');
  assert.equal(view.key.split('|')[0], state2.updatedAt, 'the barrels body is stored once per snapshot');
  assert.deepEqual((await get('/api/barrels')).j, b);
  assert.equal(net.total, 0);
});

test('a late cron: /api/feed serves the old snapshot as stale and still never refreshes', async () => {
  const s = await getStore('recent');
  const state = await s.get('state');
  await s.setJSON('state', { ...state, updatedAt: new Date(Date.now() - 3600_000).toISOString() });
  resetNet(); waits.length = 0;
  const f = (await get('/api/feed')).j;
  assert.equal(f.stale, true);
  assert.match(f.note, /has not stored a newer feed since/);
  assert.equal(net.total, 0);
  assert.equal(waits.length, 0);
});

test('the fetch budget counts every hop, redirects included, and stops at the limit', async () => {
  const real = globalThis.fetch;
  let calls = 0;
  const modes = [];
  globalThis.fetch = async (u, init = {}) => {
    calls++;
    modes.push(init.redirect);
    return String(u).endsWith('/final') ? new Response('{}', { status: 200 }) : new Response(null, { status: 302, headers: { location: String(u) + 'x' } });
  };
  try {
    await withFetchBudget(2 * (MAX_REDIRECTS + 1), async () => {
      const r = await budgetFetch('https://gw.example/a');
      assert.equal(r.status, 302, `gives up after ${MAX_REDIRECTS} redirects`);
      assert.equal(fetchBudget().used, MAX_REDIRECTS + 1, 'each redirect is one more fetch');
      await budgetFetch('https://gw.example/b');
      await assert.rejects(budgetFetch('https://gw.example/final'), { name: 'BudgetError' });
    });
    assert.equal(calls, 2 * (MAX_REDIRECTS + 1), 'nothing is fetched once the budget is spent');
    assert.ok(modes.every((m) => m === 'manual'), 'redirects are followed by hand, so each is counted');
    calls = 0;
    const outside = await budgetFetch('https://gw.example/final');
    assert.equal(outside.status, 200);
    assert.equal(fetchBudget(), null, 'no budget outside an invocation');
  } finally { globalThis.fetch = real; }
});
