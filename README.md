# striae

**Ballistics for Solana launches: fingerprint a pump.fun create transaction and name the tool that fired it.**

Every pump.fun coin is fired by some gun: the pump.fun site, a tweet-sniping deployer, a Discord launch bot, a bundler kit. Deployers rotate wallets, tickers and metadata hosts. They almost never change the gun, and the gun leaves the same marks on every create transaction: the compute budget, which relay it tips and how much, its lookup table, the instruction order, whether the mint is vanity-ground, a buy in the same tx, a wrapper program. `striae` reads those marks (striations) from the RPC JSON of a create, turns them into a weighted token set, and finds the nearest reference creates with weighted Jaccard k-NN. The reference is labelled by the tools themselves: their metadata host, their description line, their fee collector. Those stamps are labels only and never features, so a tool that scrubs its stamp still gets named, and an unfamiliar gun gets `unknown barrel` instead of a guess.

Zero runtime dependencies. The core in `src/` is isomorphic ESM (no `node:` imports), so it runs in Node ≥ 20.10, in edge functions and in the browser. Reads legacy, v0 and v1 transactions.

## 30 seconds

A real run on 2026-09-25 against mainnet. This create carries no stamp striae recognizes (IPFS metadata, no tool host, no cited fee collector). It is named from how it was built: the lookup table, the instruction order, the lunarlander tip, and a transfer to `uxtoRP…`, an uncited address that the stamped uxento creates in the reference also pay (switching the `xfer.dest` family off leaves the accuracy below unchanged):

```
$ striae A1yVYYRthWz4EcjWLUmKb2uAgjCFNzHKzEkgVrjqpump
uxento         1.00  B-CY4PJC  (no stamp)
$MLSSTR · Madlads Strategy · match · margin 1.00
mint A1yVYYRthWz4EcjWLUmKb2uAgjCFNzHKzEkgVrjqpump · create 4GbGvF7yDmLnYcL6… · slot 450368683 · tx 0 · via top-level · 269 ms

striations  ● same in PUMPY (uxento)   ◐ same bucket   ○ different
  ● alt                lookup table HQ4G6F…                        f3a30925a2b5b5043d4563f6
  ● ix.seq             sys.transfer > sys.transfer > pump.create_v2 > pump.extend_account > …
  ● tip.relay          tip relay lunarlander                       0b7a7ada563b0a71b4236eaf
  …
```

And one where the stamp exists, is hidden from the matcher, and the striations agree with it:

```
$ striae 4pkWxhi6jNcXKUo6j4nTdQZTmapkTANWJQ8MbFgoYfHQ
j7tracker      0.75  B-W9Q009  (stamp uri.host=metadata.j7tracker.io agrees, hidden from the matcher)
$MIC · Mystery Income Cat · match · margin 0.68
mint 4pkWxhi6jNcXKUo6j4nTdQZTmapkTANWJQ8MbFgoYfHQ · create 3jrFxWij18jZHihD… · slot 450363595 · tx 1 · via top-level · 570 ms

neighbours (weighted Jaccard, k=5)
  1.000  j7tracker    B-W9Q009  Gorbagana    3x68hiFFHHiuJo1mCHPSd2hvrBQDZuvx5HmfkdGmuzw3
  0.395  j7tracker    B-S10M6D  HODL         BnsFg9FuuM3Tu75UBoHoTMnNVEDzVJqKWijiyp1J3yCx
  0.395  j7tracker    B-S10M6D  BTP          8CSk8APLet8pGKQcmu3518CpfWu24rG3yfaPNvh1QreF
  0.298  rapidlaunch  B-VSB3D1  OBIE         8ipUAsxRE1ngXjtjwmyV9MAwGPSbikHTgro4TAxUpump
  0.298  rapidlaunch  B-VSB3D1  CAT          6Q5RWig45d2kSoxy7zwKSihwsNAVcBoAJWYum383pump
```

## How it works

```
 mint ──► getTransactionsForAddress(asc, limit 8)          (Helius, 10 credits; std-RPC fallback)
            │  create tx + same-slot followers
            ▼
 ┌──────────────────────── extract() ─────────────────────────┐
 │ keys = static ‖ loaded.writable ‖ loaded.readonly          │
 │ find pump create/create_v2 (top-level or CPI under wrapper)│
 │ borsh args → name, symbol, uri ──────────► STAMPS (labels) │
 │ System transfer to cited fee wallet ─────► STAMPS          │
 │ metadata JSON description / createdOn ───► STAMPS          │
 │ ComputeBudget / v1 transactionConfig ─┐                    │
 │ ALTs, ix order, tips, transfers ──────┼──► STRIATIONS      │
 │ create/buy variant, mint suffix, ... ─┘   (weighted tokens)│
 └────────────────────────────────────────────────────────────┘
            │ ~19 tokens                        stamps never enter here
            ▼
 match(): weighted Jaccard vs every reference instance ─► top k=5
            │ score(L) = (Σ sims of L / Σ all k sims) × max sim of L
            ▼        unlabelled neighbours vote "unknown"
 verdict: match (≥0.70, margin ≥0.15) · family (≥0.50) · unknown
 barrelId: 'B-' + crockford32(sha256(coarse key))[0..6]
```

### The striations (bytes read)

| family | read from | weight |
|---|---|---|
| `version` | `tx.version`: legacy, 0, 1 | 1 |
| `cu.limit` | ComputeBudget `0x02` + u32 LE, or v1 `message.transactionConfig.computeUnitLimit` | 2 (exact ½ + log2 bucket ½) |
| `cu.price` | ComputeBudget `0x03` + u64 LE (µlamports), or v1 `priorityFee` | 3 (exact ½ + bucket ½) |
| `cu.source` | `ix` / `v1-config` / `none` | 1 |
| `ix.seq` | top-level instruction names joined by `>` | 3 |
| `ix.shingle` | each adjacent pair of `ix.seq` | 0.5 each |
| `alt` | `message.addressTableLookups[].accountKey` | 4 |
| `tip.relay` | System transfer (`02000000` + u64 lamports) to a known relay tip account | 2 |
| `tip.lamports` | the u64 of each tip | 1.5 (exact ½ + bucket ½) |
| `tip.position` | tip before or after the create | 1 |
| `xfer.count` | System transfers to non-relay, non-stamp destinations | 1 |
| `xfer.dest` | each such destination | 2 |
| `create.variant` | Anchor discriminator `sha256("global:create_v2")[0..8]` = `d6904cec5f8b31b4`, `create` = `181ec828051c0777`, `+extend` if `extend_account` (`ea66c2cb96483ee5`) | 1 |
| `buy.variant` | first pump buy: `buy` `66063d1201daebea`, `buy_v2` `b817ee6167c5d33d`, `buy_exact_sol_in` `38fc74089edfcd5f`, `buy_exact_quote_in_v2` `c2ab1c46684d5b2f`, … or `none` | 1.5 |
| `mint.suffix` | mint ends in `pump` (ground vanity) or not | 1.5 |
| `signers` | `message.header.numRequiredSignatures` | 0.5 |
| `wrapper` | top-level program when the create is a CPI | 4 |
| `followers.adjacent` | same-slot txs at transaction index +1..+4 (0, 1, 2, 3+); only compared when both sides have followers | 1 |

Instruction names: `cb.limit`, `cb.price`, `sys.transfer`, `pump.<ix>` (discriminator hex when unnamed), `ata.create_idempotent`, `memo`, `spl.<n>`, else `prog.<first 6 chars of the program id>`. Anchor's self-CPI event (`e445a52e51cb9a1d`) is ignored.

### The score

For token sets A and B with weights w: `J_w(A,B) = Σ_{t∈A∩B} w_t / Σ_{t∈A∪B} w_t`. Numeric values emit an exact token and a `~2^⌊log2 v⌋` token, so 300000 vs 300001 half-match. `match()` scores the query against all n instances (O(n·t), no index; t ≈ 19), keeps the 5 nearest, and scores each label `(Σ sims of L / Σ all k sims) × (best sim of L)`. Unlabelled reference creates count as their own class, so a public-SDK barrel that is mostly unstamped cannot borrow a tool name from one stamped member. `barrelId()` hashes a coarse key (version | ALTs | CU limit | CU price | relay classes | other-transfer count | ix order | wrapper | mint-suffix class), so identical guns group even when nobody has labelled them.

## Install and use

`npm i striae` is **PLANNED** (not published yet). Today:

```bash
git clone https://github.com/lkristof55/striation && cd striation && npm i && npm test
export STRIAE_RPC_URL="https://mainnet.helius-rpc.com/?api-key=<key>"
node bin/striae.js <mint|signature> [--json] [--no-metadata]
```

```js
import { createRpc, classify, extract, match, loadReference } from 'striae';

const rpc = createRpc(process.env.STRIAE_RPC_URL);
const r = await classify(rpc, 'A1yVYYRthWz4EcjWLUmKb2uAgjCFNzHKzEkgVrjqpump', loadReference());
console.log(r.verdict, r.label, r.confidence, r.barrelId, r.stampAgrees);

// Already have the tx (indexer, Geyser, your bot)? Skip the RPC:
const ex = extract(tx, { followers });           // tx = getTransaction JSON (encoding json, maxSupportedTransactionVersion 1)
const m = match(ex, loadReference());            // { verdict, label, confidence, margin, barrelId, neighbours, striations }
```

Examples: `examples/offline.js` (recorded fixture, no network), `examples/classify-mint.js` and `examples/watch-creates.js` (mainnet via `STRIAE_RPC_URL`).

## API

| function | returns |
|---|---|
| `extract(tx, { mint?, followers?, metadata?, tipTable?, feeWallets?, mask = true })` | `{ striations, stamps, meta, followers }`; throws `NOT_PUMP_CREATE` / `BAD_INPUT`. Slurs in `meta.name` / `meta.symbol` come back as `'▇▇▇'` with `meta.masked: true`; `mask: false` returns the raw on-chain strings |
| `match(x, reference, { k = 5, weights?, exclude? })` | `{ verdict, label, displayName, confidence, margin, barrelId, closest, scores, neighbours, striations, comparedWith }` |
| `similarity(a, b, weights?)` | weighted Jaccard in [0, 1] |
| `barrelId(x)` / `barrelKey(x)` | `'B-XXXXXX'` / the coarse key |
| `toInstance(ex, { label, stamp })`, `buildReference(instances)` | build your own reference |
| `loadReference()` | the bundled `data/reference.json` |
| `classify(rpc, mintOrSig, reference)` | find the create + extract + match + stamp check |
| `pollCreates(rpc, { limit, max, known })` | one pass of the create-only feed (pump.fun mint authority `TSLvdd1p…`) |
| `createRpc(url, { fetch?, timeoutMs = 8000, retries = 2, onCall? })` | JSON-RPC client with 429 backoff and batching |
| `maskText(s)`, `isOffensive(s)`, `MASK` | the name mask `extract()` uses: a short slur list (stored ROT13 in `src/mask.js`) matched after undoing case, leetspeak, spacing, stretched letters, homoglyphs, fullwidth and zero-width tricks |

Types: `index.d.ts`.

## Benchmarks

Measured 2026-09-25 on a Mac17,3 (Apple M5, 10 cores, 16 GB), Node v26.8.1. Reproduce with `npm run bench` (offline; writes `bench/results.json`).

| metric | value |
|---|---|
| `extract()` throughput over 487 recorded create txs (legacy + v0 + v1) | 4,967 tx/s |
| `match()` per query, bundled reference n = 487 | 77.6 µs |
| `match()` per query, 10,000-instance replica | 1,114 µs |
| tokens per instance (mean) | 18.8 |
| Helius credits: classify a mint / a signature / one feed pass | 10 / 1 / ≤ 19 |

### Accuracy, stamps hidden

Leave-one-out over the 153 stamped reference creates (each query is removed from the reference; stamps are never tokens), k = 5. A prediction of `unknown` counts as wrong.

| | value |
|---|---|
| top-1 | 79.7 % |
| majority-class baseline (always "j7tracker") | 46.4 % |
| macro recall | 48.9 % |
| abstained (`unknown`) | 15.0 % |
| top-1 / macro recall with the `xfer.dest` family switched off | 79.7 % / 48.9 % |

| label | n | recall | precision |
|---|---|---|---|
| j7tracker | 71 | 95.8 % | 91.9 % |
| uxento | 34 | 85.3 % | 100 % |
| rapidlaunch | 17 | 88.2 % | 100 % |
| usepaid | 18 | 44.4 % | 80.0 % |
| stonkfun | 7 | 28.6 % | 100 % |
| axiom | 3 | 0 % | 0 % |
| clawpump | 3 | 0 % | 0 % |

Read it honestly: the three tools with the most examples and a distinctive gun (j7tracker, uxento, Rapid Launch) are named reliably. The others mostly come back `unknown` rather than as a wrong tool, which is the intended failure mode; with 3–18 examples each, their numbers are too small to claim much.

## The reference set

`data/reference.json` (487 creates: 153 stamped, 334 unlabelled) is built offline from `data/corpus.json.gz`:

- 88 graduates whose description carries a strict tool line (from meta-scanner snapshots of 2026-09-24/25), with their create tx and same-slot followers;
- 400 consecutive successful signatures from the pump.fun mint-authority feed on 2026-09-25 (399 decode as creates; one touched the authority without a create), labelled only when their metadata host (`metadata.j7tracker.io`, `meta.uxento.io`, `m.rapidlaunch.io`), description or a cited fee collector (`rapidXMVL…`, from DefiLlama `fees/rapid-launch.ts`) stamps them.

On-chain and host stamps win over description stamps: 14 graduates carried a description line for one tool while their metadata host or fee transfer named another (mostly a UsePaid line on a j7tracker-hosted create). Rebuild: `STRIAE_RPC_URL=… npm run record` (≈ 1,300 Helius credits), then `npm run build:ref`.

Token names are attacker-controlled text, so the recorded data is scrubbed: 3 live creates had an offensive name or symbol. `scripts/scrub.js` (also run by `npm run record` before it writes) replaces every copy of those strings in the instruction bytes (the pump.fun create args, the metadata CPI and Anchor's event CPI) with a placeholder of the same UTF-8 byte length, so Borsh length prefixes, offsets, mints, signatures and every striation are unchanged; the rebuilt reference differs from the unscrubbed one only in 2 symbols, now `'▇▇▇'`, and the accuracy numbers above are identical. `test/mask.test.js` fails if any name or symbol in `data/`, `test/fixtures/` or `bench/` matches the mask list, including every Borsh string inside instruction data.

Launch metadata also quotes real accounts ("Fees to @&lt;handle&gt; via UsePaid", a website that is an x.com status link). The same script pads every @handle, `%40`handle, e-mail address and path on a social host (x.com, twitter.com, github.com, t.me, instagram, tiktok, youtube, ...) with `x` to the same UTF-8 byte length (`Fees to @xxxxxx via UsePaid`), in every recorded text field and in the create's name / symbol / uri bytes, memos and logs. A tool's own stamp that is a label (`discord.gg/uxento`) is kept. The tool stamps still match, so labels, the reference and the accuracy numbers above are identical (only 18 `stamp.evidence` strings in `data/reference.json` changed). `test/mask.test.js` fails on any handle, profile link or e-mail left in `data/`, `test/fixtures/`, `bench/` or the app's data, including inside instruction bytes.

## Limits

- It names **tools**, never people. A match is a signal about how a transaction was built, not proof of anything about a deployer.
- Barrels drift when a tool changes settings; the reference is a dated snapshot. One tool can own several barrels (j7tracker has at least three here) and public SDKs share barrels.
- Stamps can be copied; `stampAgrees: false` reports when the stamp and the striations disagree.
- `getTransactionsForAddress` is Helius-only; other RPCs fall back to paging `getSignaturesForAddress` (max 5 pages), which fails soft with `NOT_FOUND` on very busy mints.
- **PLANNED:** a Yellowstone gRPC stream classifier; bonk.fun / LetsBonk and Raydium LaunchLab creates; a signed, dated reference release; an opt-in "claim your barrel" memo flow for tools.

## Prior art

- [0xfnzero/sol-trade-sdk](https://github.com/0xfnzero/sol-trade-sdk) (MIT): the relay tip-account table in `src/tips.js` comes from its `swqos.rs`. It sends transactions; it does not classify them.
- DefiLlama dimension-adapters `fees/rapid-launch.ts`: attributes Rapid Launch revenue through its collector wallet (per tool, not per coin).
- Hand-written address→platform maps (e.g. Marzel7/flex) fail as soon as a tool uses a fresh wallet.
- Axiom, GMGN and Bubblemaps cluster wallets and holders. striae classifies how the create transaction is built, so a fresh wallet does not hide the gun.

GitHub searches for "launch tool fingerprint solana", "transaction fingerprint solana" and "pump.fun deployer detection" returned no repos on 2026-09-25.

## The live app

[`app/`](app/README.md) is the complete source of the live app at **https://striation.anyfee.workers.dev** (Cloudflare Workers, free plan; the Netlify copy at striation.netlify.app is paused): the Netlify Functions that run this library on live pump.fun creates (`/api/match`, `/api/feed`, `/api/barrels`, `/api/stats`, `/api/health`, plus a scheduled feed refresh every 5 minutes), and the site. The functions import `src/`, `data/reference.json` and `bench/results.json` from this repo, so the demo is the library; the library never imports from `app/`.

```bash
cd app && npm ci && cp .env.example .env   # put a Helius key in .env
npm test && npm run build && npm run dev   # → http://localhost:8888
```

Deploy your own copy: create a Netlify site from this repo (the root `netlify.toml` builds `app/`) and set `HELIUS_API_KEY`, or deploy `app/` as a Cloudflare Worker (`app/wrangler.jsonc`: the same functions, a D1 table instead of Netlify Blobs, and a cron trigger; on the Workers Free plan each scheduled refresh classifies 6 creates instead of 18). Details, endpoints, costs, the free-plan budgets and asset credits: [`app/README.md`](app/README.md).

## License

MIT © 2026 Striation contributors. This library is the engine of the Striation project site.
