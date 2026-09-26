// extract(): one pass over a create transaction (RPC JSON: legacy, v0 or v1) → striations + stamps.
// Striations are how the transaction is built (the gun). Stamps are what a tool writes about itself
// (metadata host, description, createdOn, cited fee collector): they become labels, never features.
import { b58decode, hex, u32le, u64le, borshString } from './bytes.js';
import { PROGRAMS, PUMP_IX, CREATE_NAMES, BUY_NAMES, FAMILIES, STAMP_HOSTS, STAMP_DESC, STAMP_CREATED_ON, FEE_WALLETS } from './tables.js';
import { TIP_TABLE } from './tips.js';
import { maskText } from './mask.js';

export class StriaeError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// sha256('anchor:event')[0..8]: Anchor's self-CPI event log, not an instruction a tool chose.
const ANCHOR_EVENT = 'e445a52e51cb9a1d';
const fmt = (n) => Number(n).toLocaleString('en-US');
const log2Bucket = (v) => (v > 0 ? Math.floor(Math.log2(v)) : -1);
const keyHex = (k) => { try { return hex(b58decode(k), 32); } catch { return null; } };

function normalize(tx) {
  if (!tx || typeof tx !== 'object') throw new StriaeError('no transaction', 'BAD_INPUT');
  const message = tx.transaction?.message ?? tx.message;
  const signatures = tx.transaction?.signatures ?? tx.signatures ?? [];
  const meta = tx.meta ?? {};
  if (!message?.accountKeys || !Array.isArray(message.instructions)) {
    throw new StriaeError('not an RPC transaction in json encoding', 'BAD_INPUT');
  }
  const keys = [
    ...message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey)),
    ...(meta.loadedAddresses?.writable || []),
    ...(meta.loadedAddresses?.readonly || []),
  ];
  return { message, signatures, meta, keys };
}

function decodeIx(ix, keys) {
  let data;
  try { data = b58decode(ix.data || ''); } catch { data = new Uint8Array(0); }
  return { program: keys[ix.programIdIndex] || '?', accounts: (ix.accounts || []).map((a) => keys[a]), data, stackHeight: ix.stackHeight ?? null };
}

/** Short stable name of an instruction: cb.limit, sys.transfer, pump.create_v2, ata.create_idempotent, prog.6Vo324… */
export function ixName(ix) {
  const d = ix.data;
  switch (ix.program) {
    case PROGRAMS.computeBudget:
      return ({ 1: 'cb.heap', 2: 'cb.limit', 3: 'cb.price', 4: 'cb.data_limit' })[d[0]] || `cb.${d[0]}`;
    case PROGRAMS.system: {
      const t = d.length >= 4 ? u32le(d, 0) : -1;
      return ({ 0: 'sys.create_account', 2: 'sys.transfer', 3: 'sys.create_with_seed', 8: 'sys.allocate', 11: 'sys.transfer_with_seed' })[t] || `sys.${t}`;
    }
    case PROGRAMS.pump: return 'pump.' + (PUMP_IX[hex(d, 8)] || hex(d, 8));
    case PROGRAMS.ata: return d.length === 0 || d[0] === 0 ? 'ata.create' : d[0] === 1 ? 'ata.create_idempotent' : `ata.${d[0]}`;
    case PROGRAMS.memo: case PROGRAMS.memoV1: return 'memo';
    case PROGRAMS.token: case PROGRAMS.token2022: return `spl.${d[0]}`;
    default: return `prog.${ix.program.slice(0, 6)}`;
  }
}

/** Stamps from the off-chain metadata JSON ({ description, website, createdOn }). */
export function stampsFromMetadata(md) {
  const out = [];
  if (!md || typeof md !== 'object') return out;
  const text = `${md.description || ''} ${md.website || ''}`;
  for (const [re, label] of STAMP_DESC) {
    const m = text.match(re);
    if (m) { out.push({ label, kind: 'desc', evidence: m[0].slice(0, 120) }); break; }
  }
  const on = String(md.createdOn || '').trim();
  if (on && !/^(https?:\/\/)?(www\.)?pump\.fun\/?$/i.test(on)) {
    for (const [re, label] of STAMP_CREATED_ON) if (re.test(on)) { out.push({ label, kind: 'createdOn', evidence: on.slice(0, 120) }); break; }
  }
  return out;
}

export function uriHost(uri) {
  try { return new URL(uri).host.toLowerCase(); } catch { return null; }
}

/**
 * extract(tx, { mint?, followers?, metadata?, tipTable?, feeWallets? })
 *  - tx: getTransaction / getTransactionsForAddress item (encoding json, maxSupportedTransactionVersion 1)
 *  - mint: only accept a create of this mint
 *  - followers: other txs of the mint (full txs or { slot, transactionIndex, signature, feePayer })
 *  - metadata: the JSON at the create uri, for desc / createdOn stamps
 *  - mask: false keeps raw name/symbol (default: slurs become '▇▇▇' and meta.masked is true)
 * → { striations, stamps, meta, followers }
 */
export function extract(tx, opts = {}) {
  const { message, signatures, meta, keys } = normalize(tx);
  const tipTable = opts.tipTable || TIP_TABLE;
  const feeWallets = opts.feeWallets || FEE_WALLETS;
  if (meta.err) throw new StriaeError('the transaction failed on chain', 'NOT_PUMP_CREATE');

  const top = message.instructions.map((ix) => decodeIx(ix, keys));
  const inner = new Map();
  for (const g of meta.innerInstructions || []) inner.set(g.index, g.instructions.map((ix) => decodeIx(ix, keys)));

  // 1. The bullet: a pump.fun create / create_v2, top-level or a CPI under a wrapper program.
  let create = null, createTop = -1, createName = null, via = 'top-level';
  for (let i = 0; i < top.length && !create; i++) {
    const cands = [[top[i], false], ...(inner.get(i) || []).map((ix) => [ix, true])];
    for (const [ix, isInner] of cands) {
      if (ix.program !== PROGRAMS.pump) continue;
      const n = PUMP_IX[hex(ix.data, 8)];
      if (!CREATE_NAMES.has(n)) continue;
      if (opts.mint && ix.accounts[0] !== opts.mint) continue;
      create = ix; createTop = i; createName = n; via = isInner ? top[i].program : 'top-level';
      break;
    }
  }
  if (!create) throw new StriaeError('no pump.fun create for this mint in the transaction', 'NOT_PUMP_CREATE');

  let name = '', symbol = '', uri = '';
  try {
    let o = 8;
    [name, o] = borshString(create.data, o);
    [symbol, o] = borshString(create.data, o);
    [uri] = borshString(create.data, o);
  } catch { /* malformed args: keep empty strings */ }
  // Names are attacker-controlled text and never a striation: mask slurs before anything emits them.
  let masked = false;
  if (opts.mask !== false) {
    const [n, sy] = [maskText(name), maskText(symbol)];
    masked = n !== name || sy !== symbol;
    [name, symbol] = [n, sy];
  }
  const mint = create.accounts[0];
  const version = tx.version === undefined || tx.version === 'legacy' ? 'legacy' : Number(tx.version);

  const S = [];
  const add = (family, value, display, where, ixIndex = null, h = null) => {
    const s = { id: `${family}=${value}`, family, value: String(value), display, weight: FAMILIES[family].weight, matched: false, source: { where, ixIndex, hex: h } };
    if (FAMILIES[family].numeric) s.bucket = `${family}~2^${log2Bucket(Number(value))}`;
    S.push(s);
    return s;
  };

  // 2. Wire version and compute budget (ComputeBudget ixs, or the v1 message.transactionConfig).
  add('version', version, `tx version ${version}`, 'meta');
  let cuSource = 'none';
  top.forEach((ix, i) => {
    if (ix.program !== PROGRAMS.computeBudget) return;
    if (ix.data[0] === 2 && ix.data.length >= 5) { cuSource = 'ix'; const v = u32le(ix.data, 1); add('cu.limit', v, `CU limit ${fmt(v)}`, 'ix', i, hex(ix.data)); }
    if (ix.data[0] === 3 && ix.data.length >= 9) { cuSource = 'ix'; const v = u64le(ix.data, 1); add('cu.price', v, `CU price ${fmt(v)} µλ`, 'ix', i, hex(ix.data)); }
  });
  const cfg = message.transactionConfig;
  if (cuSource === 'none' && cfg && (cfg.computeUnitLimit != null || cfg.priorityFee != null)) {
    cuSource = 'v1-config';
    if (cfg.computeUnitLimit != null) add('cu.limit', cfg.computeUnitLimit, `CU limit ${fmt(cfg.computeUnitLimit)} (v1 config)`, 'config');
    if (cfg.priorityFee != null) add('cu.price', cfg.priorityFee, `priority fee ${fmt(cfg.priorityFee)} (v1 config)`, 'config');
  }
  add('cu.source', cuSource, `budget lives in ${cuSource}`, cuSource === 'v1-config' ? 'config' : cuSource === 'ix' ? 'ix' : 'meta');

  // 3. Instruction order and its adjacent pairs.
  const names = top.map(ixName);
  add('ix.seq', names.join('>'), names.join(' > '), 'ix');
  for (let i = 0; i + 1 < names.length; i++) add('ix.shingle', `${names[i]}>${names[i + 1]}`, `${names[i]} → ${names[i + 1]}`, 'ix', i);

  // 4. Address lookup tables (v0).
  for (const l of message.addressTableLookups || []) add('alt', l.accountKey, `lookup table ${l.accountKey.slice(0, 6)}…`, 'key', null, keyHex(l.accountKey));

  // 5. System transfers: relay tips, cited fee collectors (stamps), other destinations.
  const transfers = [];
  const pushTransfer = (ix, i) => {
    if (ix.program !== PROGRAMS.system || ix.data.length < 12 || u32le(ix.data, 0) !== 2) return;
    transfers.push({ from: ix.accounts[0], to: ix.accounts[1], lamports: u64le(ix.data, 4), ixIndex: i, hex: hex(ix.data) });
  };
  const noTips = new Set([PROGRAMS.pump, PROGRAMS.ata, PROGRAMS.system, PROGRAMS.computeBudget, PROGRAMS.token, PROGRAMS.token2022]);
  top.forEach((ix, i) => {
    pushTransfer(ix, i);
    if (!noTips.has(ix.program)) for (const c of inner.get(i) || []) if (c.stackHeight === 2) pushTransfer(c, i);
  });
  const stamps = [];
  const relays = new Map();
  const others = [];
  const positions = new Set();
  for (const t of transfers) {
    if (feeWallets[t.to]) { stamps.push({ label: feeWallets[t.to], kind: 'fee.wallet', evidence: t.to }); continue; }
    const relay = tipTable[t.to];
    if (relay) {
      if (!relays.has(relay)) relays.set(relay, t);
      add('tip.lamports', t.lamports, `${relay} tip ${(t.lamports / 1e9).toLocaleString('en-US', { maximumFractionDigits: 6 })} SOL`, 'ix', t.ixIndex, t.hex);
      positions.add(t.ixIndex < createTop ? 'before-create' : 'after-create');
    } else others.push(t);
  }
  for (const [relay, t] of relays) add('tip.relay', relay, `tip relay ${relay}`, 'key', t.ixIndex, keyHex(t.to));
  for (const p of positions) add('tip.position', p, `tip ${p}`, 'ix');
  add('xfer.count', others.length, `${others.length} other transfer${others.length === 1 ? '' : 's'}`, 'ix');
  for (const t of others) add('xfer.dest', t.to, `transfer to ${t.to.slice(0, 6)}…`, 'key', t.ixIndex, keyHex(t.to));

  // 6. Which create and which same-tx buy.
  const pumpNames = [];
  top.forEach((ix, i) => {
    if (ix.program === PROGRAMS.pump) pumpNames.push(ixName(ix));
    else if (i === createTop && via !== 'top-level') for (const c of inner.get(i) || []) if (c.program === PROGRAMS.pump && c.stackHeight === 2 && hex(c.data, 8) !== ANCHOR_EVENT) pumpNames.push(ixName(c));
  });
  const extend = pumpNames.includes('pump.extend_account');
  add('create.variant', createName + (extend ? '+extend' : ''), `${createName}${extend ? ' + extend_account' : ''}`, 'args', createTop, hex(create.data, 8));
  const buy = pumpNames.map((n) => n.slice(5)).find((n) => BUY_NAMES.has(n) || (!CREATE_NAMES.has(n) && n !== 'extend_account' && /^[0-9a-f]{16}$/.test(n)));
  const buyIx = buy ? top.findIndex((ix) => ix.program === PROGRAMS.pump && ixName(ix) === `pump.${buy}`) : -1;
  add('buy.variant', buy || 'none', buy ? `same-tx ${buy}` : 'no same-tx buy', buy ? 'ix' : 'meta', buyIx >= 0 ? buyIx : null, buyIx >= 0 ? hex(top[buyIx].data, 8) : null);

  // 7. Mint suffix, signer count, wrapper program.
  const ground = mint.endsWith('pump');
  add('mint.suffix', ground ? 'pump' : 'other', ground ? 'mint …pump (ground vanity)' : 'mint not ground', 'key', null, keyHex(mint));
  add('signers', message.header?.numRequiredSignatures ?? 0, `${message.header?.numRequiredSignatures ?? 0} signers`, 'meta');
  if (via !== 'top-level') add('wrapper', via, `wrapper ${via.slice(0, 6)}…`, 'key', createTop, keyHex(via));

  // 8. Same-slot followers (only when fetched with the create).
  const txIndex = tx.transactionIndex ?? null;
  let followers = null;
  if (Array.isArray(opts.followers)) {
    const fs = opts.followers.map((f) => ({
      slot: f.slot, txIndex: f.transactionIndex ?? f.txIndex ?? null,
      signature: f.signature || f.transaction?.signatures?.[0] || f.signatures?.[0],
      feePayer: f.feePayer || (f.transaction?.message || f.message)?.accountKeys?.[0],
    })).filter((f) => f.signature && f.signature !== signatures[0]);
    const same = fs.filter((f) => f.slot === tx.slot);
    const adjacent = txIndex == null ? [] : same.filter((f) => f.txIndex != null && f.txIndex > txIndex && f.txIndex <= txIndex + 4);
    followers = {
      sameSlot: same.length, adjacent: adjacent.length,
      sample: same.slice(0, 5).map((f) => ({ signature: f.signature, txIndex: f.txIndex, feePayer: f.feePayer || null })),
    };
    if (txIndex != null) {
      const b = adjacent.length >= 3 ? '3+' : String(adjacent.length);
      add('followers.adjacent', b, `${b} adjacent same-slot tx${b === '1' ? '' : 's'}`, 'followers');
    }
  }

  // 9. Stamps (labels only).
  const host = uriHost(uri);
  if (host && STAMP_HOSTS[host]) stamps.push({ label: STAMP_HOSTS[host], kind: 'uri.host', evidence: host });
  stamps.push(...stampsFromMetadata(opts.metadata));

  S.sort((a, b) => b.weight - a.weight);
  return {
    striations: S,
    stamps,
    meta: {
      mint, signature: signatures[0], slot: tx.slot ?? null, blockTime: tx.blockTime ?? null, txIndex, version,
      name, symbol, uri, uriHost: host, via, feePayer: keys[0], ...(masked ? { masked: true } : {}),
    },
    followers,
  };
}

/** Weighted tokens of an extraction: [token, weight][]; numeric families split into exact + log2 bucket. */
export function tokensOf(ex) {
  const out = [];
  for (const s of ex.striations) {
    if (s.bucket) { out.push([s.id, s.weight / 2], [s.bucket, s.weight / 2]); } else out.push([s.id, s.weight]);
  }
  return out;
}
