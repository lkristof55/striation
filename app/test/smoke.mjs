// Smoke test against a running server: npm run smoke (= node test/smoke.mjs http://localhost:8888)
// One real mainnet request per endpoint, with inputs that are live today (the newest pump.fun creates
// from /api/feed, plus a DexScreener-boosted pump.fun mint). Checks shapes and timing, not only status.
const base = (process.argv[2] || process.env.SMOKE_URL || 'http://localhost:8888').replace(/\/$/, '');
import { isOffensive } from '../lib/mask.mjs';
/** Every symbol/name in a body passed the slur mask. */
function noSlurs(body, where) {
  const bad = [];
  (function walk(v) {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) (k === 'symbol' || k === 'name') && typeof x === 'string' ? isOffensive(x) && bad.push(x) : walk(x);
  })(body);
  if (bad.length) throw new Error(`${where}: unmasked slur in symbol/name (${bad.length})`);
}
const ctx = {};

async function get(path, { status = 200, maxMs = 12000 } = {}) {
  const t = Date.now();
  const r = await fetch(base + path);
  const ms = Date.now() - t;
  const j = await r.json();
  if (r.status !== status) throw new Error(`${path} → HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  if (ms > maxMs) throw new Error(`${path} took ${ms} ms (> ${maxMs})`);
  return j;
}
const has = (o, keys, where) => { for (const k of keys) if (!(k in o)) throw new Error(`${where}: missing ${k}`); };
const MATCH_KEYS = ['mint', 'signature', 'slot', 'blockTime', 'version', 'name', 'symbol', 'uri', 'via', 'verdict', 'label', 'displayName', 'confidence', 'margin', 'barrelId', 'stamp', 'stampAgrees', 'striations', 'neighbours', 'followers', 'barrelMates', 'source', 'cached', 'ms'];
function checkMatch(m, where) {
  has(m, MATCH_KEYS, where);
  if (!/^B-[0-9A-HJKMNP-TV-Z]{6}$/.test(m.barrelId)) throw new Error(`${where}: bad barrelId ${m.barrelId}`);
  if (!['match', 'family', 'unknown'].includes(m.verdict)) throw new Error(`${where}: bad verdict`);
  if (!m.striations.length) throw new Error(`${where}: no striations`);
  has(m.striations[0], ['id', 'family', 'value', 'display', 'weight', 'matched', 'source'], `${where}.striations[0]`);
  has(m.barrelMates, ['reference', 'recent', 'windowMinutes', 'sample'], `${where}.barrelMates`);
  if (m.neighbours.length > 5) throw new Error(`${where}: > 5 neighbours`);
}

const checks = [
  ['GET /api/health', async () => { const j = await get('/api/health'); if (!j.ok || !j.keys.helius) throw new Error(JSON.stringify(j)); }],
  ['GET /api/feed?limit=12', async () => {
    const j = await get('/api/feed?limit=12', { maxMs: 20000 });
    has(j, ['updatedAt', 'source', 'windowSeconds', 'ratePerMin', 'stampedShare', 'items', 'barrels', 'featured'], 'feed');
    if (j.source !== 'live' || !j.items.length) throw new Error(`feed not live: ${j.source} ${j.note || ''}`);
    if (j.items.length > 12) throw new Error('limit ignored');
    has(j.items[0], ['mint', 'signature', 'blockTime', 'name', 'symbol', 'verdict', 'label', 'displayName', 'confidence', 'barrelId', 'stamp', 'stampAgrees', 'top'], 'feed.items[0]');
    checkMatch(j.featured, 'feed.featured');
    noSlurs(j, 'feed');
    ctx.items = j.items;
    return `${j.items.length} items, ${j.ratePerMin}/min, featured ${j.featured.symbol} ${j.featured.label} ${j.featured.confidence} (${j.featured.source})`;
  }],
  ['GET /api/match?mint=<newest create>', async () => {
    const it = ctx.items[0];
    const j = await get(`/api/match?mint=${it.mint}`);
    checkMatch(j, 'match');
    noSlurs(j, 'match');
    if (j.mint !== it.mint) throw new Error('wrong mint');
    if (j.followers === undefined) throw new Error('followers missing');
    return `$${j.symbol} ${j.verdict} ${j.label ?? '-'} ${j.confidence} ${j.barrelId} ${j.ms}ms`;
  }],
  ['GET /api/match?sig=<a create signature>', async () => {
    const it = ctx.items[1] || ctx.items[0];
    const j = await get(`/api/match?sig=${it.signature}`);
    checkMatch(j, 'match(sig)');
    if (j.followers !== null) throw new Error('followers should be null for sig input');
    return `$${j.symbol} ${j.verdict} ${j.ms}ms`;
  }],
  ['GET /api/match?mint=<DexScreener-boosted pump.fun mint>', async () => {
    const boosts = await (await fetch('https://api.dexscreener.com/token-boosts/latest/v1', { signal: AbortSignal.timeout(8000) })).json();
    const b = (Array.isArray(boosts) ? boosts : []).find((x) => x.chainId === 'solana' && /pump$/.test(x.tokenAddress));
    if (!b) return 'no pump.fun mint in boosts right now (skipped)';
    const r = await fetch(`${base}/api/match?mint=${b.tokenAddress}`);
    const j = await r.json();
    if (r.status === 200) { checkMatch(j, 'match(boost)'); return `${b.tokenAddress.slice(0, 8)}… $${j.symbol} ${j.verdict} ${j.label ?? '-'} ${j.confidence}`; }
    if (r.status === 422 && j.code === 'NOT_PUMP_CREATE') return `${b.tokenAddress.slice(0, 8)}… 422 NOT_PUMP_CREATE (not a pump.fun create)`;
    throw new Error(`HTTP ${r.status} ${JSON.stringify(j)}`);
  }],
  ['GET /api/match bad input → 400', async () => {
    const a = await get('/api/match?mint=0xnotbase58', { status: 400 });
    const b = await get('/api/match', { status: 400 });
    if (a.code !== 'BAD_INPUT' || b.code !== 'BAD_INPUT' || !a.error) throw new Error(JSON.stringify(a));
  }],
  ['GET /api/feed?limit=99 → 400', async () => { const j = await get('/api/feed?limit=99', { status: 400 }); if (j.code !== 'BAD_INPUT') throw new Error(JSON.stringify(j)); }],
  ['GET /api/barrels', async () => {
    const j = await get('/api/barrels');
    has(j, ['updatedAt', 'reference', 'barrels'], 'barrels');
    has(j.reference, ['size', 'stamped', 'unlabelled', 'builtAt', 'labels'], 'barrels.reference');
    if (!j.barrels.length || j.barrels.length > 16) throw new Error('barrels count');
    has(j.barrels[0], ['barrelId', 'label', 'displayName', 'referenceCount', 'recentCount', 'share', 'signature', 'exemplar'], 'barrels[0]');
    return `${j.reference.size} reference, ${j.barrels.length} barrels`;
  }],
  ['GET /api/feed + /api/barrels at the same moment: one window', async () => {
    const [f, b] = await Promise.all([get('/api/feed?limit=40', { maxMs: 20000 }), get('/api/barrels')]);
    noSlurs(b, 'barrels');
    if (f.updatedAt !== b.updatedAt) return `different snapshots (${f.updatedAt} vs ${b.updatedAt}, a refresh landed in between): skipped`;
    has(b, ['recentWindow'], 'barrels');
    const rows = new Map(b.barrels.map((r) => [r.barrelId, r.recentCount]));
    let compared = 0;
    for (const x of f.barrels) if (rows.has(x.barrelId)) { compared++; if (rows.get(x.barrelId) !== x.count) throw new Error(`${x.barrelId}: feed count ${x.count} vs barrels recentCount ${rows.get(x.barrelId)}`); }
    const fe = f.featured;
    if (fe.source === 'live' && rows.has(fe.barrelId)) {
      const self = f.items.some((i) => i.mint === fe.mint) ? 1 : 0;
      if (fe.barrelMates.recent + self !== rows.get(fe.barrelId)) throw new Error(`featured ${fe.barrelId}: barrelMates.recent ${fe.barrelMates.recent} + self ${self} ≠ recentCount ${rows.get(fe.barrelId)}`);
      if (fe.barrelMates.asOf !== b.recentWindow.endsAt) throw new Error('featured window end ≠ barrels window end');
    }
    return `snapshot ${f.updatedAt}, ${compared} barrels compared, featured ${fe.barrelId} mates ${fe.barrelMates.recent}`;
  }],
  ['GET /api/stats', async () => {
    const j = await get('/api/stats');
    has(j, ['measuredAt', 'machine', 'node', 'command', 'reference', 'accuracy', 'bench'], 'stats');
    has(j.accuracy, ['method', 'n', 'top1', 'macroRecall', 'majorityBaseline', 'withoutXferDest', 'perLabel', 'confusion'], 'stats.accuracy');
    return `top1 ${j.accuracy.top1} vs baseline ${j.accuracy.majorityBaseline}`;
  }],
];

let failed = 0;
for (const [name, fn] of checks) {
  const t = Date.now();
  try { const note = await fn(); console.log(`ok   ${name} ${Date.now() - t}ms${note ? ` · ${note}` : ''}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}
process.exit(failed ? 1 : 0);
