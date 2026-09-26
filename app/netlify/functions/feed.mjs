// GET /api/feed?limit=1..40 → live create feed + featured MatchResult (the hero's first load)
// No per-instance body cache: every response is built from the current store snapshot (one Blobs read),
// so /api/feed and /api/barrels read at the same moment always count the same window.
import { parseLimit, feed } from '../../lib/service.mjs';
import { json, errorResponse } from '../../lib/http.mjs';

export default async (req, context) => {
  try {
    const limit = parseLimit(new URL(req.url).searchParams.get('limit'));
    const body = await feed(limit, context?.waitUntil ? (p) => context.waitUntil(p) : null);
    return json(body, { maxAge: body.stale ? 5 : 30 });
  } catch (e) {
    return errorResponse(e);
  }
};

export const config = { path: '/api/feed' };
