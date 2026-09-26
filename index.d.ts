// Type declarations for striae (hand-written; the source is plain ESM JavaScript).

export type StriationFamily =
  | 'version' | 'cu.limit' | 'cu.price' | 'cu.source' | 'ix.seq' | 'ix.shingle' | 'alt'
  | 'tip.relay' | 'tip.lamports' | 'tip.position' | 'xfer.count' | 'xfer.dest'
  | 'create.variant' | 'buy.variant' | 'mint.suffix' | 'signers' | 'wrapper' | 'followers.adjacent';

export interface Striation {
  id: string;               // 'cu.price=3333333'
  family: StriationFamily;
  value: string;
  display: string;          // 'CU price 3,333,333 µλ'
  weight: number;
  matched: boolean;         // also present in the reference instance it was compared with
  partial?: boolean;        // only the log2 bucket matched
  bucket?: string;          // 'cu.price~2^21' for numeric families
  source: { where: 'ix' | 'key' | 'config' | 'args' | 'followers' | 'meta'; ixIndex: number | null; hex: string | null };
}

export interface Stamp { label: string; kind: 'uri.host' | 'desc' | 'createdOn' | 'fee.wallet'; evidence: string }

export interface Extraction {
  striations: Striation[];
  stamps: Stamp[];
  meta: {
    mint: string; signature: string; slot: number | null; blockTime: number | null; txIndex: number | null;
    version: 'legacy' | 0 | 1; name: string; symbol: string; uri: string; uriHost: string | null; masked?: true;
    via: 'top-level' | string; feePayer: string;
  };
  followers: { sameSlot: number; adjacent: number; sample: { signature: string; txIndex: number | null; feePayer: string | null }[] } | null;
}

export interface Instance {
  mint: string; signature: string; symbol: string | null; blockTime: number | null;
  label: string | null; stamp: Stamp | null; barrelId: string; tokens: string[];
}

export interface Reference {
  format: 'striae-reference/1'; builtAt: string; source: string | null;
  size: number; stamped: number; unlabelled: number; labels: Record<string, number>; instances: Instance[];
}

export interface Neighbour { mint: string; signature: string; symbol: string | null; label: string | null; similarity: number; barrelId: string }

export interface MatchResult {
  verdict: 'match' | 'family' | 'unknown';
  label: string | null;
  displayName: string | null;
  confidence: number;
  margin: number;
  barrelId: string;
  closest: { label: string; displayName: string; score: number } | null;
  scores: { label: string | null; score: number }[];
  neighbours: Neighbour[];
  striations?: Striation[];
  comparedWith?: { mint: string; signature: string; symbol: string | null; label: string | null } | null;
}

export type Weights = Partial<Record<StriationFamily, number>>;

export interface ExtractOptions {
  mint?: string;
  followers?: unknown[];
  metadata?: { description?: string; website?: string; createdOn?: string } | null;
  tipTable?: Record<string, string>;
  feeWallets?: Record<string, string>;
  /** false keeps the raw on-chain name/symbol; default masks slurs to MASK and sets meta.masked */
  mask?: boolean;
}

export function extract(tx: unknown, opts?: ExtractOptions): Extraction;
export function tokensOf(ex: Extraction): [string, number][];
export function stampsFromMetadata(md: unknown): Stamp[];
export function match(x: Extraction | Instance | string[], reference: Reference | Instance[], opts?: { k?: number; weights?: Weights; exclude?: string | string[] }): MatchResult;
export function similarity(a: Extraction | Instance | string[], b: Extraction | Instance | string[], weights?: Weights): number;
export function barrelId(x: Extraction | Instance | string[]): string;
export function barrelKey(x: Extraction | Instance | string[]): string;
export function toInstance(ex: Extraction, opts?: { label?: string | null; stamp?: Stamp | null }): Instance;
export function buildReference(instances: Instance[], info?: { builtAt?: string; source?: string }): Reference;
export function loadReference(): Reference;
export function describeToken(token: string): string;
export function summarizeBarrels(instances: Instance[], opts?: { recent?: { barrelId: string; tokens?: string[] }[]; max?: number }): unknown[];

export interface Rpc { call(method: string, params: unknown[]): Promise<any>; batch(calls: [string, unknown[]][]): Promise<any[]> }
export function createRpc(url: string, opts?: { fetch?: typeof fetch; timeoutMs?: number; retries?: number; onCall?: (method: string, n: number) => void }): Rpc;
export function getTransaction(rpc: Rpc, signature: string): Promise<any>;
export function getTransactions(rpc: Rpc, signatures: string[], opts?: { batchSize?: number; gapMs?: number }): Promise<any[]>;
export function firstTransactions(rpc: Rpc, address: string, opts?: { limit?: number; maxPages?: number }): Promise<any[]>;
export function recentCreateSignatures(rpc: Rpc, opts?: { limit?: number; before?: string; until?: string }): Promise<any[]>;
export function fetchMetadata(uri: string, opts?: { fetch?: typeof fetch; timeoutMs?: number }): Promise<Record<string, unknown> | null>;
export function inputKind(s: string): 'mint' | 'sig' | null;
export function findCreate(rpc: Rpc, input: string, opts?: { metadata?: boolean; fetch?: typeof fetch }): Promise<Extraction>;
export function verdictFor(ex: Extraction, reference: Reference, opts?: { k?: number; weights?: Weights }): Extraction['meta'] & MatchResult & { stamp: Stamp | null; stampAgrees: boolean | null; followers: Extraction['followers'] };
export function classify(rpc: Rpc, input: string, reference: Reference, opts?: { metadata?: boolean; k?: number; weights?: Weights }): Promise<ReturnType<typeof verdictFor>>;
export function pollCreates(rpc: Rpc, opts?: { limit?: number; max?: number; known?: Set<string>; batchSize?: number; gapMs?: number }): Promise<{
  signatures: any[]; fresh: { sig: any; ex: Extraction | null; error?: string }[]; ratePerMin: number; windowSeconds: number; failed: number;
}>;

export class StriaeError extends Error { code: 'BAD_INPUT' | 'NOT_FOUND' | 'NOT_PUMP_CREATE' }
export class RpcError extends Error { code: 'UPSTREAM' | 'RATE_LIMITED' | 'METHOD_NOT_FOUND'; status: number }

export const FAMILIES: Record<StriationFamily, { display: string; weight: number; numeric?: boolean; optional?: boolean }>;
export const DEFAULT_WEIGHTS: Record<StriationFamily, number>;
export const THRESHOLDS: { match: number; margin: number; family: number };
export const TOOL_NAMES: Record<string, string>;
export const PROGRAMS: Record<string, string>;
export const PUMP_IX: Record<string, string>;
export const STAMP_HOSTS: Record<string, string>;
export const STAMP_DESC: [RegExp, string][];
export const FEE_WALLETS: Record<string, string>;
export const TIP_ACCOUNTS: Record<string, string[]>;
export const TIP_TABLE: Record<string, string>;
export const HELIUS_CREDITS: Record<string, number>;
export const PUMP_MINT_AUTHORITY: string;

/** '▇▇▇': what extract() puts in place of an offensive name or symbol. */
export const MASK: string;
/** true when a name/symbol contains a listed slur after undoing case, leetspeak, spacing, homoglyph and zero-width evasions. */
export function isOffensive(s: string | null | undefined): boolean;
/** MASK when offensive or already masked, else the input. */
export function maskText<T extends string | null | undefined>(s: T): T | string;
/** true for MASK or a same-byte-length placeholder written by scripts/scrub.js. */
export function isMasked(s: unknown): boolean;
/** A string of exactly `byteLength` UTF-8 bytes ('▇' blocks padded with '_'), used to scrub Borsh strings in place. */
export function placeholder(byteLength: number): string;
export function normalizeWords(s: string | null | undefined): string[];
export function rot13(s: string): string;
