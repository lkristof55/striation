// Real mainnet: classify the newest pump.fun creates as they land (create-only feed on the mint authority).
//   STRIAE_RPC_URL=... node examples/watch-creates.js [rounds=3]
// Each round: 1 getSignaturesForAddress + up to 10 getTransaction (≈ 11 Helius credits).
import { createRpc, pollCreates, match, loadReference } from '../src/index.js';

if (!process.env.STRIAE_RPC_URL) { console.error('set STRIAE_RPC_URL'); process.exit(1); }
const rpc = createRpc(process.env.STRIAE_RPC_URL);
const reference = loadReference();
const known = new Set();
const rounds = Number(process.argv[2] || 3);
for (let round = 0; round < rounds; round++) {
  const { fresh, ratePerMin } = await pollCreates(rpc, { limit: 40, max: 10, known });
  console.log(`-- round ${round + 1}: ${fresh.length} new creates, ~${ratePerMin}/min on pump.fun`);
  for (const f of fresh) {
    known.add(f.sig.signature);
    if (!f.ex) continue;
    const r = match(f.ex, reference);
    console.log(`${(f.ex.meta.symbol || '').slice(0, 12).padEnd(12)} ${r.verdict.padEnd(8)} ${(r.label ?? '-').padEnd(12)} ${r.confidence.toFixed(2)} ${r.barrelId}`);
  }
  if (round + 1 < rounds) await new Promise((res) => setTimeout(res, 20000));
}
