// Cloudflare Workers entry (wrangler.jsonc). It runs the same Netlify Functions v2 handlers as Netlify:
//   fetch():     each netlify/functions/*.mjs with a config.path, matched on the URL path, gets (Request, context)
//                with context = { params, ip (cf-connecting-ip), waitUntil (ctx.waitUntil), site };
//                every other path goes to the static site (env.ASSETS: site/dist, 404.html for misses).
//   scheduled(): the functions with a config.schedule (feed-refresh, the cron trigger in wrangler.jsonc).
// Before any handler runs: the D1 binding becomes the store (lib/store.mjs) and the Workers Free budgets apply.
//   CF_FREE_PLAN      "1" (default) = Workers Free budgets, "0" = Workers Paid (the Netlify numbers)
//   FEED_REFRESH_MAX  creates classified per cron run (Free 6, Paid 18)
//   REF_LIVE_CAP      stamped live creates kept in the reference (Free 300, Paid 600)
//   FETCH_BUDGET      external fetches per invocation, retries and redirects included (Free 45, Paid 900)
import { useD1 } from './lib/store.mjs';
import { configureRuntime } from './lib/service.mjs';
import { withFetchBudget } from './lib/budget.mjs';
import * as barrels from './netlify/functions/barrels.mjs';
import * as feed from './netlify/functions/feed.mjs';
import * as feedRefresh from './netlify/functions/feed-refresh.mjs';
import * as health from './netlify/functions/health.mjs';
import * as match from './netlify/functions/match.mjs';
import * as stats from './netlify/functions/stats.mjs';

const FUNCTIONS = { barrels, feed, 'feed-refresh': feedRefresh, health, match, stats };

/** '/api/thing/:id' → { re, keys } (the subset of Netlify path syntax these functions use, as in scripts/dev.mjs). */
function compilePath(p) {
  const keys = [];
  const src = p.split('/').map((seg) => {
    if (seg === '*') return '.*';
    if (seg.startsWith(':')) { keys.push(seg.slice(1).replace(/\?$/, '')); return '([^/]+)'; }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { path: p, re: new RegExp(`^${src}/?$`), keys };
}

export const routes = Object.entries(FUNCTIONS)
  .filter(([, m]) => m.config?.path)
  .flatMap(([name, m]) => [].concat(m.config.path).map((p) => ({ name, handler: m.default, ...compilePath(p) })));

export const scheduledFunctions = Object.entries(FUNCTIONS)
  .filter(([, m]) => m.config?.schedule)
  .map(([name, m]) => ({ name, handler: m.default, schedule: m.config.schedule }));

/** '*\/5 * * * *' → 300 (the period the site shows); null for other schedules. */
const periodSeconds = (cron) => { const m = /^\*\/(\d+) \* \* \* \*$/.exec(cron || ''); return m ? Number(m[1]) * 60 : null; };
const intVar = (v, dflt) => (/^\d+$/.test(String(v ?? '')) && Number(v) > 0 ? Number(v) : dflt);

let fetchLimit = 45;
let configuredFor = null;
function setup(env) {
  if (env.DB) useD1(env.DB);
  if (configuredFor === env) return;
  const free = String(env.CF_FREE_PLAN ?? '1') !== '0';
  configureRuntime({
    scheduledOnly: true,
    refreshSeconds: periodSeconds(feedRefresh.config.schedule) || 300,
    refreshMax: intVar(env.FEED_REFRESH_MAX, free ? 6 : 18),
    refLiveCap: intVar(env.REF_LIVE_CAP, free ? 300 : 600),
  });
  fetchLimit = intVar(env.FETCH_BUDGET, free ? 45 : 900);
  configuredFor = env;
}

export default {
  async fetch(request, env, ctx) {
    setup(env);
    const url = new URL(request.url);
    for (const r of routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const context = {
        params,
        ip: request.headers.get('cf-connecting-ip'),
        waitUntil: (p) => ctx.waitUntil(p),
        site: { url: url.origin },
      };
      try {
        return await withFetchBudget(fetchLimit, () => r.handler(request, context));
      } catch (e) {
        console.error(`[${r.name}] ${e?.stack || e}`);
        return Response.json({ error: 'function crashed', code: 'UPSTREAM' }, { status: 500 });
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    setup(env);
    const due = scheduledFunctions.filter((f) => f.schedule === controller.cron);
    await withFetchBudget(fetchLimit, async () => {
      for (const f of due.length ? due : scheduledFunctions) {
        await f.handler(new Request(`https://worker.invalid/.netlify/functions/${f.name}`, { method: 'POST', body: JSON.stringify({ next_run: null }) }), { waitUntil: (p) => ctx.waitUntil(p) });
      }
    });
  },
};
