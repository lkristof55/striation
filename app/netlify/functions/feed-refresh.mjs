// Scheduled: refresh the live create feed every 5 minutes so the hero never waits on a cold refresh.
// Cost: ≤ 19 Helius credits per run (1 getSignaturesForAddress + ≤ 18 getTransaction).
import { refreshFeed } from '../../lib/service.mjs';

export default async () => {
  try {
    const { fetched, added, state } = await refreshFeed();
    console.log(`[feed-refresh] fetched ${fetched}, added ${added}, window ${state.items.length}`);
  } catch (e) {
    console.error(`[feed-refresh] ${e.code || 'ERROR'}: ${e.message}`);
  }
  return new Response(null, { status: 204 });
};

export const config = { schedule: '*/5 * * * *' };
