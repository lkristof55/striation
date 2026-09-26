// GET /api/barrels → reference barrels (bundled data/reference.json from the repo root + live stores). No Helius calls.
// barrelsView() caches per store snapshot; max-age 30 (not 300) so a browser never pairs a 5-min-old
// barrel list with a fresh /api/feed: recentCount must count the same window as the feed.
import { barrelsView } from '../../lib/service.mjs';
import { json, errorResponse } from '../../lib/http.mjs';

export default async () => {
  try {
    return json(await barrelsView(), { maxAge: 30 });
  } catch (e) {
    return errorResponse(e);
  }
};

export const config = { path: '/api/barrels' };
