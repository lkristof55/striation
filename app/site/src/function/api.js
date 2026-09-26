// The API contract (app/README.md, Endpoints). Every call returns { ok, data } or { ok:false, error, code, status }.
import { SAMPLE_FEED } from '../data/sample.js';

async function get(path, { timeout = 15000, fresh = false } = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(path, { signal: ctl.signal, headers: { accept: 'application/json' }, ...(fresh ? { cache: 'no-store' } : {}) });
    let body = null; try { body = await r.json(); } catch { /* not json */ }
    if (!r.ok) return { ok: false, status: r.status, code: body?.code || (r.status === 404 ? 'NO_ENDPOINT' : 'UPSTREAM'), error: body?.error || `http ${r.status}`, retryAfter: Number(r.headers.get('retry-after')) || null };
    return { ok: true, data: body };
  } catch (e) {
    return { ok: false, status: 0, code: e.name === 'AbortError' ? 'UPSTREAM' : 'OFFLINE', error: e.message };
  } finally { clearTimeout(t); }
}

// /api/feed. When the endpoint doesn't answer at all, the hero falls back to the SAMPLE fixture (labelled on the page).
export async function feed(limit = 24, { fresh = false } = {}) {
  const r = await get(`/api/feed?limit=${limit}`, { fresh });
  if (r.ok && r.data?.featured) return r.data;
  return { ...SAMPLE_FEED, offline: true, error: r.error };
}
export const match = (q) => get(`/api/match?${q.kind}=${encodeURIComponent(q.value)}`, { timeout: 30000 });
export const barrels = () => get('/api/barrels');
export const stats = () => get('/api/stats');

// Input validation, same rule as the backend: base58 32–44 = mint, 64–88 = signature.
const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
export function parseEvidence(s) {
  const v = (s || '').trim();
  if (!v) return null;
  if (!B58.test(v)) return { bad: true };
  if (v.length >= 32 && v.length <= 44) return { kind: 'mint', value: v };
  if (v.length >= 64 && v.length <= 88) return { kind: 'sig', value: v };
  return { bad: true };
}
