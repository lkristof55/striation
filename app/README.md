# Striation: the live app

The site and backend that run [`striae`](../README.md) (the library at the repo root) on live pump.fun creates at **https://striation.anyfee.workers.dev** (Cloudflare Workers, free plan; the Netlify copy at striation.netlify.app is paused). Paste a mint or a create signature and it names the launch tool that fired the coin from how the create transaction is built; the hero shows the newest creates classified every few minutes.

- `netlify/functions/`: Netlify Functions v2, one file per endpoint, plus the scheduled `feed-refresh`. The same files run on Cloudflare through `worker.mjs`.
- `worker.mjs`, `wrangler.jsonc`, `migrations/`: the Cloudflare Workers entry, its config and the D1 table (see [Deploy to Cloudflare Workers](#deploy-to-cloudflare-workers)).
- `lib/`: the backend logic on top of the library (validation, caching, the rolling feed window, the slur mask). It imports the library from the repo root (`../../src/*`, `../../data/reference.json`, `../../bench/results.json`), so the live demo is the library.
- `site/`: the page (three.js, GSAP, Lenis), bundled by esbuild. The code beat imports the library's `src/match.js` as text at build time.
- `test/`: offline unit tests, the recorded fixtures, `smoke.mjs` (real mainnet requests) and `record.mjs` (re-records the fixtures).
- `scripts/`: `build.mjs` (site → `site/dist`) and `dev.mjs` (serves `site/dist` and every function locally, like Netlify).

## Run it locally

Node ≥ 22.

```bash
cd app
npm ci
cp .env.example .env          # then put your Helius key in .env
npm test                      # offline unit tests
npm run build                 # site → site/dist
npm run dev                   # → http://localhost:8888 (site + every /api/* function)
npm run smoke                 # in a second shell: one real mainnet request per endpoint
```

`npm run dev -- --cron` also runs the scheduled `feed-refresh` once at start and then every minute (production: every 5 minutes). Without it, the first `/api/feed` request refreshes the feed inline. Locally, the Blobs stores are JSON files in `app/.data/`. `npm run watch` rebuilds the site and reloads the functions on change.

## Endpoints

| method + path | returns | cache |
|---|---|---|
| `GET /api/match?mint=<base58>` or `?sig=<base58 signature>` | `MatchResult`: verdict, label, confidence, margin, barrelId, stamp + stampAgrees, striations with their real bytes, 5 neighbours, same-slot followers, barrelMates | 300 s response, 24 h extraction |
| `GET /api/feed?limit=1..40` | the newest creates classified, top barrels in the last 30 min, and a `featured` MatchResult for the hero | 30 s |
| `GET /api/barrels` | the reference set summary, `recentWindow`, and up to 16 barrels with their defining striations | 30 s |
| `GET /api/stats` | the library's `bench/results.json` unchanged (leave-one-out accuracy, baseline, speed) | 3600 s |
| `GET /api/health` | `{ ok, project, time, keys }` (which keys are set, never their values) | none |

```bash
curl 'http://localhost:8888/api/match?mint=A1yVYYRthWz4EcjWLUmKb2uAgjCFNzHKzEkgVrjqpump'
curl 'http://localhost:8888/api/match?sig=<create signature>'
curl 'http://localhost:8888/api/feed?limit=12'
curl 'http://localhost:8888/api/barrels'
curl 'http://localhost:8888/api/stats'
```

Errors are `{ error, code }`: 400 `BAD_INPUT`, 404 `NOT_FOUND` (no transactions, e.g. a brand-new address), 422 `NOT_PUMP_CREATE`, 429 `RATE_LIMITED` (Helius 429 after 2 retries), 502 `UPSTREAM` (8 s timeout or a bad response), 503 `NOT_MEASURED` (stats before the bench ran).

What the fields mean:
- `verdict: 'unknown'` has `label: null`; `closest` says how near the best tool was. Most live creates carry no stamp and come back `unknown`: that is the honest result, not a bug.
- `stampAgrees` is `null` when the create has no stamp, and `false` when the stamp names a tool the striations don't. A match is a signal about how a transaction was built, not an accusation about anyone.
- `/api/feed` returns `source: 'fixture'` only when the store is empty and Helius fails; the site labels it SAMPLE. `stale: true` means the last stored feed is served because upstream failed.
- On Cloudflare the feed only comes from the scheduled refresh, so `/api/feed` adds `refreshSeconds: 300` (the schedule's period; the page words its "updated … ago" line from it). Before the first scheduled run it answers the recorded fixture hero with `source: 'fixture'`, `stale: true` and `warming: true`. When the schedule is more than two periods late it serves the stored feed with `stale: true` and a note saying since when.
- Feed counts are over the sampled creates: each refresh classifies at most 18 of the newest creates (`ratePerMin` counts all of them). Every recent count uses one window, the 30 min ending at the store snapshot (`updatedAt`).
- Token names and symbols are attacker-controlled. Every `symbol`/`name` in the responses passes the library's slur mask (`src/mask.js`, used through `lib/mask.mjs`): a hit becomes `▇▇▇` with `masked: true`, the mint is untouched, and a masked create is never the featured hero. Recorded fixtures are scrubbed with same-byte-length placeholders, and `test/mask.test.mjs` fails if any recorded name, symbol or account handle slips back in.

## Env vars

See [`.env.example`](.env.example).

| var | needed | what |
|---|---|---|
| `HELIUS_API_KEY` | yes | mainnet RPC: `getTransactionsForAddress`, `getTransaction`, `getSignaturesForAddress` |
| `BIRDEYE_API_KEY` | no | not used for data; `/api/health` only reports whether it is set |
| `STRIATION_STORE_DIR` | local only | set by `scripts/dev.mjs` to `app/.data`; unset on Netlify, where the stores are Netlify Blobs |
| `CF_FREE_PLAN` | Cloudflare only | `"1"` (default, set in `wrangler.jsonc`) = the Workers Free budgets below; `"0"` = Workers Paid, which runs the Netlify numbers |
| `FEED_REFRESH_MAX`, `REF_LIVE_CAP`, `FETCH_BUDGET` | Cloudflare only, optional | override one budget: creates classified per scheduled run (Free 6, Paid 18), stamped live creates kept in the reference (Free 300, Paid 600), external fetches per invocation (Free 45, Paid 900) |

Keys are only read on the server through `process.env`; the browser only talks to `/api/*`.

## Data sources and limits

- **Helius RPC** (`mainnet.helius-rpc.com`): `getTransactionsForAddress(mint, asc, limit 8)` finds the create and its same-slot followers in one call. `getSignaturesForAddress` on the pump.fun mint-authority PDA `TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM` is a create-only feed. `getTransaction` goes in JSON-RPC batches of at most 10, 400 ms apart. Every call has an 8 s timeout and 2 retries on 429 with backoff.
- **Token metadata JSON** at the create's uri (no key): used for stamps only, with a 2.5 s budget; it fails soft.
- **Reference**: the library's `data/reference.json` (487 creates recorded 2026-09-25), plus stamped live creates the feed adds to the `ref-live` store (cap 600).
- **Stores** (Netlify Blobs): `recent` (rolling 30-min window, cap 600 items), `ref-live`, `extractions` (per mint/signature, 24 h).

## Costs (Helius credits)

| action | credits |
|---|---|
| `/api/match?mint=` (uncached) | 10 |
| `/api/match?sig=` (uncached) | 1 |
| the same mint again within 24 h | 0 (extraction cached) |
| `/api/feed`, `/api/barrels`, `/api/stats` | 0 (served from the store) |
| one feed refresh (scheduled or background) | ≤ 19 (1 + ≤ 18) |
| scheduled refresh every 5 min | ≤ 5,472 a day (≈ 164k a month) |
| Cloudflare, Workers Free: scheduled refresh every 5 min (1 + ≤ 6), nothing else refreshes | ≤ 2,016 a day (≈ 60k a month) |

A typical page view (the hero plus one pasted mint) costs about 10 credits. Under continuous traffic, a page view that finds the feed older than 30 s triggers a background refresh, so the ceiling is about 38 credits a minute per function instance; with no traffic only the schedule runs.

## Deploy your own copy to Netlify

1. Fork or clone this repo and create a Netlify site from it. The repo-root [`netlify.toml`](../netlify.toml) sets `base = "app"`, `command = "npm run build"`, `publish = "site/dist"` and `functions = "netlify/functions"` (esbuild bundler); there is nothing to set in the UI.
2. Add the env var `HELIUS_API_KEY` (Site configuration → Environment variables), then deploy.
3. Scheduled function: `feed-refresh` declares `schedule: '*/5 * * * *'` in its own `config` and starts running after the first production deploy. Nothing else to enable.
4. Webhooks: none needed. A Helius webhook on the mint-authority PDA could push creates instead of polling (PLANNED; it needs the deployed URL).
5. Check `https://<your-site>.netlify.app/api/health`, then run `node test/smoke.mjs https://<your-site>.netlify.app`.

## Deploy to Cloudflare Workers

The live copy runs on Cloudflare as the Worker `striation` (https://striation.anyfee.workers.dev) on the Workers Free plan. The Netlify setup above is unchanged; Cloudflare is a second target. `worker.mjs` runs the same `netlify/functions/*.mjs` files: each function's `config.path` becomes a route, `context.waitUntil` / `context.ip` / `context.params` map to `ctx.waitUntil`, the `cf-connecting-ip` header and the path params, and every other path is served from `site/dist` by Workers Static Assets (`404.html` for a miss). The Netlify Blobs stores become one D1 table (`migrations/0001_kv.sql`), and the cron trigger in `wrangler.jsonc` runs `feed-refresh` every 5 minutes.

```bash
cd app
npm ci && npm test && npm run build                          # site → site/dist (the Worker's assets)
npx wrangler@4 d1 create striation-store                     # put the database_id it prints into wrangler.jsonc
npx wrangler@4 d1 migrations apply striation-store --remote  # creates the kv table
npx wrangler@4 secret put HELIUS_API_KEY                     # required
npx wrangler@4 secret put BIRDEYE_API_KEY                    # optional: /api/health only reports whether it is set
npx wrangler@4 deploy
```

Then check `https://<worker>.workers.dev/api/health` (`keys.helius` must be `true`: `nodejs_compat` puts vars and secrets into `process.env`, where `lib/` reads them). `/api/feed` answers `warming: true` until the first scheduled run, at most 5 minutes later; after that, `node test/smoke.mjs https://<worker>.workers.dev` runs the same checks as on Netlify.

Locally, with no Cloudflare account involved:

```bash
npx wrangler@4 d1 migrations apply striation-store --local
printf 'HELIUS_API_KEY=...\n' > .dev.vars                    # gitignored, like .env
npx wrangler@4 dev --local --test-scheduled                 # → http://localhost:8787
curl 'http://localhost:8787/cdn-cgi/handler/scheduled?cron=*%2F5+*+*+*+*'   # run the scheduled refresh once
node test/smoke.mjs http://localhost:8787
```

(With static assets configured, a browser-style request to `/__scheduled` is answered by the asset router; the `/cdn-cgi/handler/scheduled` route always reaches the Worker.)

### Workers Free plan: what applies and what degrades

The Free plan gives each invocation, HTTP request or cron run alike, **10 ms of CPU** and **50 external subrequests** (every retry and every redirect counts, and work handed to `ctx.waitUntil` counts toward the same invocation). The account shares 100,000 requests a day (static assets are free), 5M D1 rows read and 100k D1 rows written a day, and 5 cron triggers. So on Cloudflare:

- **HTTP endpoints never refresh.** `/api/feed`, `/api/barrels` and `/api/stats` only read the store; on Netlify a page view that finds the feed older than 30 s refreshes it in the background. The feed is at most one schedule period old (5 minutes, plus the run itself), and the page says so.
- **Each scheduled run classifies 6 creates, not 18** (`FEED_REFRESH_MAX`). Classifying a create costs CPU for decoding and matching it, so the feed samples fewer of the newest creates: about 36 to 42 in the 30-minute window, where Netlify's schedule alone keeps about 108 (and page views add more). `ratePerMin` still counts all creates; `sampled.note` states the number.
- **The live reference keeps the newest 300 stamped creates, not 600** (`REF_LIVE_CAP`), next to the bundled 487. Every match and every barrels summary scans the whole reference, and a cold isolate prepares all of it once.
- **At most 45 external fetches per invocation** (`FETCH_BUDGET`, `lib/budget.mjs`), counted per hop: redirects are followed by hand, at most 2 per metadata fetch. A scheduled run needs 8 in the normal case (1 signature page, 1 batch of 6 transactions, 6 metadata JSONs) and 24 at worst (every RPC call retried twice, every metadata URL redirected twice). `/api/match` needs 2, and 22 at worst if the RPC lacks `getTransactionsForAddress` and it falls back to paging signatures. When the budget runs out, metadata stamps are skipped (they are optional) and an RPC call fails with 502 `UPSTREAM`.
- **`/api/barrels` is summarized once per snapshot** and kept in D1 (`recent/barrels-view`), so later requests, from any isolate, only read it. Only the 16 barrels it returns are described (`summarizeTop` in `lib/service.mjs`, which returns exactly what the library's `summarizeBarrels` returns; `test/barrels-top.test.mjs` checks it).
- **D1 values are capped at 2 MB.** The largest documents are `recent/state` and `ref-live/instances`, both far below that at their caps; `lib/store.mjs` refuses a larger value and `setBounded` then drops the oldest entries.
- Daily use at the 5-minute schedule: 288 cron runs, 288 to 576 D1 rows written by the refresh plus at most 288 barrels views, and 1 row per uncached `/api/match`.

`CF_FREE_PLAN=0` (Workers Paid) restores 18 creates per run, 600 live reference creates and a 900-fetch budget; the endpoints still serve the snapshot only.

## Licenses

Code: MIT (the repo's [LICENSE](../LICENSE)). Site assets (HDRI CC0, fonts SIL OFL 1.1, Draco decoder Apache-2.0, the bench model MIT) are listed with their sources in [`site/public/CREDITS.md`](site/public/CREDITS.md); each font's license text ships in `site/public/fonts/`.
