// GET /api/health — liveness plus which keys the backend can see (names only, never values).
export default async () => Response.json({
  ok: true,
  project: 'striation',
  time: new Date().toISOString(),
  keys: { helius: !!process.env.HELIUS_API_KEY, birdeye: !!process.env.BIRDEYE_API_KEY },
});

export const config = { path: '/api/health' };
