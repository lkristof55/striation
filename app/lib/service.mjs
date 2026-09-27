// The site's backend logic on top of the striae library (the repo root: src/, data/, bench/). I/O goes through lib/sources.mjs
// and lib/store.mjs; the scoring itself is the library.
import bundled from '../../data/reference.json' with { type: 'json' };
import benchResults from '../../bench/results.json' with { type: 'json' };
import fixtureFeatured from './featured-fixture.json' with { type: 'json' };
import { findCreate, verdictFor, pollCreates, inputKind } from '../../src/classify.js';
import { stampsFromMetadata, StriaeError } from '../../src/extract.js';
import { toInstance, tokenList, barrelId } from '../../src/match.js';
import { summarizeBarrels } from '../../src/barrels.js';
import { TOOL_NAMES } from '../../src/tables.js';
import { helius, fetchMetadata } from './sources.mjs';
import { getStore } from './store.mjs';
import { TTLCache } from './http.mjs';
import { shouldMask, maskDeep } from './mask.mjs';

export const WINDOW_SECONDS = 30 * 60;
export const RECENT_CAP = 600;
export const REF_LIVE_CAP = 600;
export const FEED_STALE_SECONDS = 30;
export const METADATA_BUDGET_MS = 2500;

/**
 * Runtime knobs. Netlify and `npm run dev` use these defaults; app/worker.mjs switches to the Cloudflare
 * ones (configureRuntime) before any handler runs.
 *  - scheduledOnly: /api/feed only serves the stored snapshot (never a refresh, inline or in waitUntil),
 *    the cron is the only refresh, and /api/barrels caches its body per snapshot in the store.
 *  - refreshSeconds: the cron period; sent to the site as feed.refreshSeconds when scheduledOnly.
 *  - refreshMax: creates classified per refresh (each costs about 0.7 ms CPU and 1 to 3 fetches).
 *  - refLiveCap: stamped live creates kept in the reference next to the bundled 487 (every match and
 *    every barrels summary scans all of them).
 */
export const runtime = { scheduledOnly: false, refreshSeconds: null, refreshMax: 18, refLiveCap: REF_LIVE_CAP };
export function configureRuntime(opts = {}) { Object.assign(runtime, opts); }

const mem = new TTLCache(1000);

// ---------- pure helpers (tested offline) ----------

/** Validate /api/match query → { kind, value } or throws BAD_INPUT. */
export function parseMatchQuery(params) {
  const mint = params.get('mint')?.trim() || '';
  const sig = params.get('sig')?.trim() || '';
  if (!!mint === !!sig) throw new StriaeError('pass exactly one of ?mint= or ?sig=', 'BAD_INPUT');
  if (mint && inputKind(mint) !== 'mint') throw new StriaeError('mint must be a base58 address (32–44 chars)', 'BAD_INPUT');
  if (sig && inputKind(sig) !== 'sig') throw new StriaeError('sig must be a base58 signature (64–88 chars)', 'BAD_INPUT');
  return mint ? { kind: 'mint', value: mint } : { kind: 'sig', value: sig };
}

/** Validate /api/feed ?limit= (1–40, default 24). */
export function parseLimit(raw) {
  if (raw == null || raw === '') return 24;
  if (!/^\d{1,3}$/.test(raw)) throw new StriaeError('limit must be an integer 1–40', 'BAD_INPUT');
  const n = Number(raw);
  if (n < 1 || n > 40) throw new StriaeError('limit must be an integer 1–40', 'BAD_INPUT');
  return n;
}

/** Merge the bundled reference with stamped live instances (dedupe by mint). */
export function mergeReference(base, live = []) {
  const seen = new Set(base.instances.map((i) => i.mint));
  const extra = live.filter((i) => i && i.label && !seen.has(i.mint) && seen.add(i.mint));
  const instances = extra.length ? [...base.instances, ...extra] : base.instances;
  const labels = {};
  for (const i of instances) if (i.label) labels[i.label] = (labels[i.label] || 0) + 1;
  const stamped = instances.filter((i) => i.label).length;
  return { ...base, instances, size: instances.length, stamped, unlabelled: instances.length - stamped, labels, liveAdded: extra.length };
}

// One rolling window for every "recent" count (barrelMates.recent, feed barrels, /api/barrels recentCount):
// the sampled creates with blockTime in the 30 min that end at the store snapshot (state.updatedAt), so
// two endpoints that read the same snapshot always agree, however late they are read.

/** End of the recent window (unix s): the snapshot time of the `recent` store, else now. */
export function windowEnd(state, nowSec = Date.now() / 1000) {
  const t = state?.updatedAt ? Date.parse(state.updatedAt) : NaN;
  return Math.floor(Number.isFinite(t) ? t / 1000 : nowSec);
}

/** Is a stored create inside the window that ends at endSec? */
export const inWindow = (i, endSec) => i.blockTime == null || endSec - i.blockTime <= WINDOW_SECONDS;

/** The sampled creates of the snapshot that count as recent. */
export const windowItems = (state) => { const end = windowEnd(state); return (state?.items || []).filter((i) => inWindow(i, end)); };

/**
 * barrelMates block of a MatchResult: the OTHER creates of the same barrel (the match itself excluded),
 * in the reference and in the recent window ending at endSec.
 */
export function barrelMates(result, reference, recent, endSec = Date.now() / 1000) {
  const same = (i) => i.barrelId === result.barrelId && i.mint !== result.mint;
  const refMates = reference.instances.filter(same);
  const recentMates = recent.filter((i) => same(i) && inWindow(i, endSec));
  const sample = [...new Map([...recentMates, ...refMates].map((i) => [i.mint, i])).values()].slice(0, 8).map((i) => ({ mint: i.mint, symbol: i.symbol ?? null, blockTime: i.blockTime ?? null }));
  return { reference: refMates.length, recent: recentMates.length, windowMinutes: WINDOW_SECONDS / 60, asOf: new Date(Math.floor(endSec) * 1000).toISOString(), sample };
}

/** A FeedItem from a verdict (plus tokens + barrel for the store). */
export function feedItem(v) {
  const top = (v.striations || []).filter((s) => s.matched).slice(0, 3).map((s) => s.display);
  return {
    mint: v.mint, signature: v.signature, blockTime: v.blockTime ?? null, name: v.name, symbol: v.symbol,
    verdict: v.verdict, label: v.label, displayName: v.displayName, confidence: v.confidence, barrelId: v.barrelId,
    stamp: v.stamp ? { label: v.stamp.label, kind: v.stamp.kind } : null, stampAgrees: v.stampAgrees, top,
  };
}

/** Prune a list of stored items to the window and cap, newest first. */
export function pruneWindow(items, nowSec, cap = RECENT_CAP) {
  const seen = new Set();
  return items
    .filter((i) => inWindow(i, nowSec) && !seen.has(i.signature) && seen.add(i.signature))
    .sort((a, b) => (b.blockTime || 0) - (a.blockTime || 0))
    .slice(0, cap);
}

/** Top barrels among window items: { barrelId, label, displayName, count, share }. */
export function barrelCounts(items, max = 8) {
  const g = new Map();
  for (const i of items) {
    const e = g.get(i.barrelId) || { barrelId: i.barrelId, count: 0, labels: {} };
    e.count++;
    if (i.label) e.labels[i.label] = (e.labels[i.label] || 0) + 1;
    g.set(i.barrelId, e);
  }
  return [...g.values()].sort((a, b) => b.count - a.count).slice(0, max).map((e) => {
    const [label] = Object.entries(e.labels).sort((a, b) => b[1] - a[1])[0] || [null];
    return { barrelId: e.barrelId, label, displayName: label ? TOOL_NAMES[label] || label : null, count: e.count, share: items.length ? Math.round((e.count / items.length) * 1000) / 1000 : 0 };
  });
}

/** Is this verdict a better hero than the current one? (a 'match' whose stamp is absent or agrees) */
export function betterFeatured(cand, cur) {
  if (cand?.verdict !== 'match' || cand.stampAgrees === false) return false;
  if (shouldMask(cand.symbol) || shouldMask(cand.name)) return false; // never a slur as the hero
  if (!cur || cur.source === 'fixture') return true;
  return cand.confidence > cur.confidence || (cand.confidence === cur.confidence && (cand.blockTime || 0) > (cur.blockTime || 0));
}

// ---------- store-backed state ----------

let refCache = null;
/**
 * The bundled reference merged with the stamped live instances. Cached for 60 s, or, when the caller passes
 * the state's refRev (the revision refreshFeed stamps whenever it rewrites ref-live), until that changes.
 */
export async function reference(rev) {
  if (refCache && (rev != null ? refCache.rev === rev : Date.now() - refCache.at < 60_000)) return refCache.ref;
  let live = [];
  try { live = (await (await getStore('ref-live')).get('instances')) || []; } catch { /* bundled only */ }
  if (live.length > runtime.refLiveCap) live = live.slice(0, runtime.refLiveCap);
  const ref = mergeReference(bundled, live);
  refCache = { at: Date.now(), rev: rev ?? null, ref, live };
  return ref;
}

async function readState() {
  try { return (await (await getStore('recent')).get('state')) || null; } catch { return null; }
}

/** The state and the merged reference. Scheduled mode reads the state first so its refRev can skip ref-live. */
async function stateAndReference() {
  if (!runtime.scheduledOnly) { const [ref, state] = await Promise.all([reference(), readState()]); return { ref, state }; }
  const state = await readState();
  return { ref: await reference(state?.refRev), state };
}

/**
 * setJSON of a newest-first list (or a document wrapping one) that drops the oldest entries while the store
 * rejects the value as too large (D1: 2 MB per value). Netlify Blobs and the file store never reject.
 */
export async function setBounded(store, key, list, wrap = (l) => l) {
  for (let n = list.length; ; n = Math.floor(n * 0.75)) {
    try { return await store.setJSON(key, wrap(n === list.length ? list : list.slice(0, n))); } catch (e) {
      if (e?.code !== 'TOO_LARGE' || n === 0) throw e;
      console.warn(`[store] ${key}: ${n} entries are over the value limit, keeping the newest ${Math.floor(n * 0.75)}`);
    }
  }
}

export function finishMatch(v, ref, recent, extra, endSec) {
  return {
    mint: v.mint, signature: v.signature, slot: v.slot, blockTime: v.blockTime, version: v.version,
    name: v.name, symbol: v.symbol, uri: v.uri, via: v.via,
    verdict: v.verdict, label: v.label, displayName: v.displayName, confidence: v.confidence, margin: v.margin,
    barrelId: v.barrelId, stamp: v.stamp, stampAgrees: v.stampAgrees,
    striations: v.striations, neighbours: v.neighbours, followers: v.followers ?? null,
    barrelMates: barrelMates(v, ref, recent, endSec),
    closest: v.closest, comparedWith: v.comparedWith,
    ...extra,
  };
}

/** GET /api/match core. Extraction cached 24 h (create txs are immutable), response 300 s. */
export async function matchInput({ kind, value }) {
  const t0 = Date.now();
  const hit = mem.get(`match:${value}`);
  if (hit) {
    // The verdict is immutable; the barrel-mate counts follow the current snapshot of the recent store.
    const { ref, state } = await stateAndReference();
    return maskDeep({ ...hit, barrelMates: barrelMates(hit, ref, state?.items || [], windowEnd(state)), cached: true, ms: Date.now() - t0 });
  }

  const exStore = await getStore('extractions').catch(() => null);
  const exKey = `${kind === 'mint' ? 'by-mint' : 'by-sig'}/${value}`;
  let ex = null;
  try { const c = await exStore?.get(exKey); if (c && Date.now() - c.at < 86_400_000) ex = c.ex; } catch { /* miss */ }
  let cached = !!ex;
  if (!ex) {
    ex = await findCreate(helius(), value, { metadata: false });
    const md = await fetchMetadata(ex.meta.uri, METADATA_BUDGET_MS);
    if (md) ex.stamps.push(...stampsFromMetadata(md));
    if (kind === 'sig') ex.followers = null;
    try { await exStore?.setJSON(exKey, { at: Date.now(), ex }); } catch { /* cache is best effort */ }
  }
  const { ref, state } = await stateAndReference();
  const v = verdictFor(ex, ref);
  const out = finishMatch(v, ref, state?.items || [], { source: 'live' }, windowEnd(state));
  mem.set(`match:${value}`, out, 300);
  return maskDeep({ ...out, cached, ms: Date.now() - t0 });
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

/**
 * One feed refresh: 1 getSignaturesForAddress + ≤ `max` getTransaction (batches of 10, 400 ms apart; max is
 * runtime.refreshMax, 18 by default), metadata stamps for the new creates, verdicts, then `ref-live` and the
 * rolling `recent` window (in that order, so a reader that sees the new refRev finds the new instances).
 */
export async function refreshFeed({ max = runtime.refreshMax } = {}) {
  const store = await getStore('recent');
  const prev = (await store.get('state')) || { items: [] };
  const known = new Set((prev.items || []).map((i) => i.signature));
  const poll = await pollCreates(helius(), { limit: 40, max, known });
  const ref = await reference(prev.refRev);
  const fresh = poll.fresh.filter((f) => f.ex);
  // Metadata stamps are optional: one shared 2.5 s budget so a slow IPFS gateway never stalls the feed.
  const got = new Map();
  await Promise.race([
    pool(fresh, 8, async (f) => { const md = await fetchMetadata(f.ex.meta.uri, 2500); if (md) got.set(f, md); }),
    new Promise((r) => setTimeout(r, METADATA_BUDGET_MS)),
  ]);
  for (const [f, md] of got) f.ex.stamps.push(...stampsFromMetadata(md));
  const nowSec = Math.floor(Date.now() / 1000); // the snapshot time: updatedAt below is exactly this second
  let featured = prev.featured && prev.featured.blockTime && nowSec - prev.featured.blockTime <= WINDOW_SECONDS
    && !shouldMask(prev.featured.symbol) && !shouldMask(prev.featured.name) ? prev.featured : null;
  const newItems = [];
  const newRef = [];
  for (const f of fresh) {
    const v = verdictFor(f.ex, ref);
    const inst = toInstance(f.ex, { label: f.ex.stamps[0]?.label ?? null, stamp: f.ex.stamps[0] || null });
    newItems.push({ ...feedItem(v), tokens: inst.tokens });
    if (inst.label) newRef.push(inst);
    if (betterFeatured(v, featured)) featured = finishMatch(v, ref, [], { source: 'live', cached: false, ms: 0 }, nowSec);
  }
  const items = pruneWindow([...newItems, ...(prev.items || [])], nowSec);
  if (featured) featured.barrelMates = barrelMates(featured, ref, items, nowSec);
  let refRev = prev.refRev ?? null;
  if (newRef.length) {
    const rl = await getStore('ref-live');
    const cur = (prev.refRev != null && refCache?.rev === prev.refRev ? refCache.live : await rl.get('instances')) || [];
    await setBounded(rl, 'instances', [...newRef, ...cur].slice(0, runtime.refLiveCap));
    refCache = null;
    refRev = `${nowSec}.${Math.random().toString(36).slice(2, 8)}`;
  }
  const state = {
    updatedAt: new Date(nowSec * 1000).toISOString(),
    ratePerMin: poll.ratePerMin || prev.ratePerMin || 0,
    sigWindowSeconds: poll.windowSeconds,
    items, featured,
    ...(refRev ? { refRev } : {}),
  };
  await setBounded(store, 'state', items, (kept) => (kept === items ? state : { ...state, items: kept }));
  return { state, fetched: poll.fresh.length, added: newItems.length };
}

let refreshing = null;
/** One refresh at a time per function instance. */
export function refreshOnce() {
  if (!refreshing) refreshing = refreshFeed().finally(() => { refreshing = null; });
  return refreshing;
}

/**
 * GET /api/feed core. The scheduled function keeps the store warm; a page view that finds it older than
 * 30 s serves it at once and refreshes in the background (defer = context.waitUntil). Only an empty
 * store refreshes inline. When upstream fails the stored items are served, never an empty hero.
 */
export async function feed(limit, defer) {
  let state = await readState();
  if (runtime.scheduledOnly) return scheduledFeed(state, limit);
  const age = state ? (Date.now() - Date.parse(state.updatedAt)) / 1000 : Infinity;
  let upstreamError = null;
  if (state && age > FEED_STALE_SECONDS && defer) {
    defer(refreshOnce().catch((e) => console.error('[feed] background refresh:', e.code || e.message)));
  } else if (age > FEED_STALE_SECONDS) {
    try { state = (await refreshOnce()).state; } catch (e) { upstreamError = e; }
  }
  if (!state) {
    return feedResponse({ updatedAt: fixtureFeatured.recordedAt || new Date().toISOString(), items: [], ratePerMin: 0, featured: null }, limit, upstreamError || { code: 'UPSTREAM' });
  }
  return feedResponse(state, limit, upstreamError, await reference());
}

/**
 * /api/feed on Cloudflare: the stored snapshot only, whatever its age (the cron is the only refresh). The body
 * is the Netlify one plus `refreshSeconds` (the cron period). A cron that is two periods late shows as
 * `stale: true` with a note; an empty store (before the first cron run) answers with the recorded fixture hero,
 * `source: 'fixture'`, `stale: true` and `warming: true`.
 */
async function scheduledFeed(state, limit) {
  const every = runtime.refreshSeconds || 300;
  if (!state) {
    const body = feedResponse({ updatedAt: fixtureFeatured.recordedAt || new Date().toISOString(), items: [], ratePerMin: 0, featured: null }, limit, { code: 'WARMING_UP' });
    return { ...body, warming: true, note: `warming up: no feed is stored yet; the scheduled refresh stores one every ${Math.round(every / 60)} minutes`, refreshSeconds: every };
  }
  const age = (Date.now() - Date.parse(state.updatedAt)) / 1000;
  const late = age > every * 2 + 60;
  const body = feedResponse(state, limit, late ? { code: 'LATE' } : null, await reference(state.refRev));
  return { ...body, ...(late ? { note: `the scheduled refresh has not stored a newer feed since ${state.updatedAt}; serving the last stored feed` } : {}), refreshSeconds: every };
}

/**
 * The /api/feed body for one snapshot. Items, barrels and featured.barrelMates all count over the same
 * window (windowItems), and symbols/names pass the slur mask. `ref` (optional) recomputes the live
 * featured's barrelMates from this snapshot.
 */
export function feedResponse(state, limit, upstreamError = null, ref = null) {
  const items = windowItems(state);
  const times = items.map((i) => i.blockTime).filter(Boolean);
  let featured = state.featured || { ...fixtureFeatured.result, source: 'fixture', cached: true };
  if (ref && state.featured && featured.source !== 'fixture') featured = { ...featured, barrelMates: barrelMates(featured, ref, items, windowEnd(state)) };
  return maskDeep({
    updatedAt: state.updatedAt,
    source: items.length ? 'live' : 'fixture',
    windowSeconds: times.length > 1 ? Math.max(...times) - Math.min(...times) : 0,
    ratePerMin: state.ratePerMin || 0,
    stampedShare: items.length ? Math.round((items.filter((i) => i.stamp).length / items.length) * 1000) / 1000 : 0,
    sampled: { items: items.length, note: `each refresh classifies at most ${runtime.refreshMax} of the newest creates; counts are over the sampled creates` },
    items: items.slice(0, limit).map(({ tokens, ...i }) => i),
    barrels: barrelCounts(items),
    featured,
    ...(upstreamError ? { stale: true, note: `upstream: ${upstreamError.code || 'UPSTREAM'}; serving the last stored feed` } : {}),
  });
}

const barrelsCache = new TTLCache(4);
/**
 * GET /api/barrels core (no Helius calls). Cached per snapshot, so it never lags the feed's store. In
 * scheduled mode the body is also kept in the store (`recent/barrels-view`), so each snapshot is summarized
 * once, by the first request that reads it, instead of once per isolate.
 */
export async function barrelsView() {
  if (runtime.scheduledOnly) return storedBarrels(await readState());
  const [ref, state] = await Promise.all([reference(), readState()]);
  const key = `${state?.updatedAt || '-'}|${ref.size}`;
  return barrelsCache.get(key) || barrelsCache.set(key, barrelsFromState(ref, state), 300);
}

async function storedBarrels(state) {
  const key = `${state?.updatedAt || '-'}|${state?.refRev ?? '-'}`;
  const hit = barrelsCache.get(key);
  if (hit) return hit;
  const store = await getStore('recent');
  const saved = await store.get('barrels-view').catch(() => null);
  if (saved?.key === key) return barrelsCache.set(key, saved.body, 300);
  const body = barrelsFromState(await reference(state?.refRev), state);
  await store.setJSON('barrels-view', { key, body }).catch((e) => console.error('[barrels] store:', e.message));
  return barrelsCache.set(key, body, 300);
}

/**
 * /api/barrels body for one snapshot. recentCount counts every sampled create of the barrel in the same
 * window as the feed (so it equals feed.barrels[].count, and barrelMates.recent + 1 for a match that is
 * itself in the window).
 */
export function barrelsFromState(ref, state) {
  const recent = windowItems(state);
  const end = windowEnd(state);
  return maskDeep({
    updatedAt: state?.updatedAt || ref.builtAt,
    recentWindow: {
      minutes: WINDOW_SECONDS / 60, endsAt: new Date(end * 1000).toISOString(), sampled: recent.length,
      note: 'recentCount = sampled creates of this barrel in the 30 min ending at endsAt; a MatchResult.barrelMates.recent counts the other creates of its barrel in the same window (itself excluded)',
    },
    reference: {
      size: ref.size, stamped: ref.stamped, unlabelled: ref.unlabelled, builtAt: ref.builtAt, liveAdded: ref.liveAdded || 0,
      labels: Object.entries(ref.labels).sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, displayName: TOOL_NAMES[label] || label, count })),
    },
    barrels: summarizeTop(ref.instances, { recent, max: 16 }),
  });
}

/**
 * The library's summarizeBarrels(instances, { recent, max }), computed only for the rows it returns. The
 * library ranks every barrel (label, reference and recent counts, cheap), then describes every barrel (token
 * frequencies, the striation signature, number formatting: most of its CPU), and returns `max` rows. This ranks
 * with the same rules, describes only the winners through the library, and restores `share` over the whole
 * window: the same rows, byte for byte (test/barrels-top.test.mjs compares both on many random windows).
 */
export function summarizeTop(instances, { recent = [], max = 16 } = {}) {
  const ids = instances.map((i) => i.barrelId || barrelId(i));
  const groups = new Map();
  const get = (id) => { let g = groups.get(id); if (!g) groups.set(id, (g = { id, members: [], recent: 0 })); return g; };
  instances.forEach((inst, k) => get(ids[k]).members.push(inst));
  for (const r of recent) get(r.barrelId).recent++;
  const ranked = [...groups.values()].map((g) => {
    const counts = {};
    for (const m of g.members) if (m.label) counts[m.label] = (counts[m.label] || 0) + 1;
    const [top, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [null, 0];
    return { id: g.id, label: top && n >= g.members.length / 2 ? top : null, referenceCount: g.members.length, recentCount: g.recent };
  });
  const labelled = ranked.filter((r) => r.label).sort((a, b) => (b.recentCount + b.referenceCount) - (a.recentCount + a.referenceCount));
  const unlabelled = ranked.filter((r) => !r.label).sort((a, b) => b.recentCount - a.recentCount || b.referenceCount - a.referenceCount);
  const pickL = labelled.slice(0, Math.min(labelled.length, Math.ceil(max * 0.625)));
  const picked = new Set([...pickL, ...unlabelled.slice(0, max - pickL.length)].map((r) => r.id));
  const rows = summarizeBarrels(instances.filter((_, k) => picked.has(ids[k])), { recent: recent.filter((r) => picked.has(r.barrelId)), max });
  const total = recent.length;
  const size = instances.length;
  return rows.map((row) => {
    const g = groups.get(row.barrelId);
    return { ...row, share: Math.round((total ? g.recent / total : g.members.length / (size || 1)) * 1000) / 1000 };
  });
}

/** GET /api/stats core: bench/results.json (repo root) unchanged. */
export function stats() {
  if (!benchResults?.accuracy) throw new StriaeError('benchmarks not measured yet: run `npm run bench` at the repo root', 'NOT_MEASURED');
  return benchResults;
}

export { tokenList };
