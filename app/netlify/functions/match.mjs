// GET /api/match?mint=<base58> | ?sig=<base58 signature> → MatchResult (see app/README.md)
import { parseMatchQuery, matchInput } from '../../lib/service.mjs';
import { json, errorResponse } from '../../lib/http.mjs';

export default async (req) => {
  if (req.method !== 'GET') return json({ error: 'GET only', code: 'BAD_INPUT' }, { status: 405 });
  try {
    const q = parseMatchQuery(new URL(req.url).searchParams);
    return json(await matchInput(q), { maxAge: 300 });
  } catch (e) {
    return errorResponse(e);
  }
};

export const config = { path: '/api/match' };
