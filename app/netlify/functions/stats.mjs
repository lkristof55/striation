// GET /api/stats → bench/results.json (repo root) unchanged (503 NOT_MEASURED until `npm run bench` at the repo root)
import { stats } from '../../lib/service.mjs';
import { json, errorResponse } from '../../lib/http.mjs';

export default async () => {
  try {
    return json(stats(), { maxAge: 3600 });
  } catch (e) {
    return errorResponse(e);
  }
};

export const config = { path: '/api/stats' };
