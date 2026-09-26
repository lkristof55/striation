// Real mainnet: classify one pump.fun mint.
//   STRIAE_RPC_URL=https://mainnet.helius-rpc.com/?api-key=... node examples/classify-mint.js <mint>
import { createRpc, classify, loadReference } from '../src/index.js';

const mint = process.argv[2];
if (!mint || !process.env.STRIAE_RPC_URL) { console.error('usage: STRIAE_RPC_URL=... node examples/classify-mint.js <mint>'); process.exit(1); }
const r = await classify(createRpc(process.env.STRIAE_RPC_URL), mint, loadReference());
console.log({ symbol: r.symbol, verdict: r.verdict, label: r.label, confidence: r.confidence, margin: r.margin, barrelId: r.barrelId, stamp: r.stamp, stampAgrees: r.stampAgrees });
console.log('nearest:', r.neighbours.map((n) => `${n.similarity} ${n.label ?? '-'} ${n.symbol}`).join(' | '));
