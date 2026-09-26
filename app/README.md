# Striation: the live app

The site and backend that run [`striae`](../README.md) (the library at the repo root) on live pump.fun creates at **https://striation.netlify.app**. Paste a mint or a create signature and it names the launch tool that fired the coin from how the create transaction is built; the hero shows the newest creates classified every few minutes.

- `netlify/functions/`: Netlify Functions v2, one file per endpoint, plus the scheduled `feed-refresh`.
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
- Feed counts are over the sampled creates: each refresh classifies at most 18 of the newest creates (`ratePerMin` counts all of them). Every recent count uses one window, the 30 min ending at the store snapshot (`updatedAt`).
- Token names and symbols are attacker-controlled. Every `symbol`/`name` in the responses passes the library's slur mask (`src/mask.js`, used through `lib/mask.mjs`): a hit becomes `▇▇▇` with `masked: true`, the mint is untouched, and a masked create is never the featured hero. Recorded fixtures are scrubbed with same-byte-length placeholders, and `test/mask.test.mjs` fails if any recorded name, symbol or account handle slips back in.

## Env vars

See [`.env.example`](.env.example).

| var | needed | what |
|---|---|---|
| `HELIUS_API_KEY` | yes | mainnet RPC: `getTransactionsForAddress`, `getTransaction`, `getSignaturesForAddress` |
| `BIRDEYE_API_KEY` | no | not used for data; `/api/health` only reports whether it is set |
| `STRIATION_STORE_DIR` | local only | set by `scripts/dev.mjs` to `app/.data`; unset on Netlify, where the stores are Netlify Blobs |

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

A typical page view (the hero plus one pasted mint) costs about 10 credits. Under continuous traffic, a page view that finds the feed older than 30 s triggers a background refresh, so the ceiling is about 38 credits a minute per function instance; with no traffic only the schedule runs.

## Deploy your own copy to Netlify

1. Fork or clone this repo and create a Netlify site from it. The repo-root [`netlify.toml`](../netlify.toml) sets `base = "app"`, `command = "npm run build"`, `publish = "site/dist"` and `functions = "netlify/functions"` (esbuild bundler); there is nothing to set in the UI.
2. Add the env var `HELIUS_API_KEY` (Site configuration → Environment variables), then deploy.
3. Scheduled function: `feed-refresh` declares `schedule: '*/5 * * * *'` in its own `config` and starts running after the first production deploy. Nothing else to enable.
4. Webhooks: none needed. A Helius webhook on the mint-authority PDA could push creates instead of polling (PLANNED; it needs the deployed URL).
5. Check `https://<your-site>.netlify.app/api/health`, then run `node test/smoke.mjs https://<your-site>.netlify.app`.

## Licenses

Code: MIT (the repo's [LICENSE](../LICENSE)). Site assets (HDRI CC0, fonts SIL OFL 1.1, Draco decoder Apache-2.0, the bench model MIT) are listed with their sources in [`site/public/CREDITS.md`](site/public/CREDITS.md); each font's license text ships in `site/public/fonts/`.
