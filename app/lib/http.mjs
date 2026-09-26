// Small HTTP helpers shared by the functions: TTL cache, JSON responses, error mapping.

const STATUS = { BAD_INPUT: 400, NOT_FOUND: 404, NOT_PUMP_CREATE: 422, RATE_LIMITED: 429, UPSTREAM: 502, METHOD_NOT_FOUND: 502, NOT_MEASURED: 503 };

export function json(body, { status = 200, maxAge = 0 } = {}) {
  return Response.json(body, {
    status,
    headers: { 'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store', 'access-control-allow-origin': '*' },
  });
}

/** Map a thrown error to { error, code } with the right status; never leaks a stack. */
export function errorResponse(e) {
  const code = STATUS[e?.code] ? (e.code === 'METHOD_NOT_FOUND' ? 'UPSTREAM' : e.code) : 'UPSTREAM';
  const status = STATUS[code];
  const error = STATUS[e?.code] ? e.message : 'upstream failure';
  if (!STATUS[e?.code]) console.error('[striation]', e?.message);
  return json({ error, code }, { status });
}

export function badInput(message) {
  return json({ error: message, code: 'BAD_INPUT' }, { status: 400 });
}

/** In-memory TTL cache (per function instance). */
export class TTLCache {
  constructor(max = 500) { this.m = new Map(); this.max = max; }
  get(k) {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (Date.now() > e.exp) { this.m.delete(k); return undefined; }
    return e.v;
  }
  set(k, v, seconds) {
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value);
    this.m.set(k, { v, exp: Date.now() + seconds * 1000 });
    return v;
  }
}
