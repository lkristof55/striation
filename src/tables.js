// Program ids, pump.fun discriminators, striation families and the stamp rules.

export const PROGRAMS = {
  pump: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  computeBudget: 'ComputeBudget111111111111111111111111111111',
  system: '11111111111111111111111111111111',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  memo: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  memoV1: 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
  pumpFees: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
  pumpAmm: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
};

/** Anchor discriminators of the pump.fun program: sha256('global:<name>')[0..8], hex. */
export const PUMP_IX = {
  '181ec828051c0777': 'create',
  d6904cec5f8b31b4: 'create_v2',
  ea66c2cb96483ee5: 'extend_account',
  '66063d1201daebea': 'buy',
  b817ee6167c5d33d: 'buy_v2',
  '38fc74089edfcd5f': 'buy_exact_sol_in',
  '5e8fa6989876182a': 'buy_exact_sol_in_v2',
  c62e1552b4d9e870: 'buy_exact_quote_in',
  c2ab1c46684d5b2f: 'buy_exact_quote_in_v2',
  '33e685a4017f83ad': 'sell',
  '5df6823ce7e940b2': 'sell_v2',
  '5e06ca73ff60e8b7': 'init_user_volume_accumulator',
};
export const CREATE_NAMES = new Set(['create', 'create_v2']);
export const BUY_NAMES = new Set(['buy', 'buy_v2', 'buy_exact_sol_in', 'buy_exact_sol_in_v2', 'buy_exact_quote_in', 'buy_exact_quote_in_v2']);

/**
 * Striation families and default weights. `numeric` families emit an exact token and a log2-bucket
 * token (each half the weight), so near values half-match. `optional` families only count when both
 * sides have them (followers are known only when the create was fetched with its same-slot followers).
 */
export const FAMILIES = {
  version: { display: 'tx version', weight: 1 },
  'cu.limit': { display: 'CU limit', weight: 2, numeric: true },
  'cu.price': { display: 'CU price', weight: 3, numeric: true },
  'cu.source': { display: 'budget lives in', weight: 1 },
  'ix.seq': { display: 'instruction order', weight: 3 },
  'ix.shingle': { display: 'instruction pair', weight: 0.5 },
  alt: { display: 'lookup table', weight: 4 },
  'tip.relay': { display: 'tip relay', weight: 2 },
  'tip.lamports': { display: 'tip amount', weight: 1.5, numeric: true },
  'tip.position': { display: 'tip position', weight: 1 },
  'xfer.count': { display: 'other transfers', weight: 1 },
  'xfer.dest': { display: 'transfer destination', weight: 2 },
  'create.variant': { display: 'create variant', weight: 1 },
  'buy.variant': { display: 'same-tx buy', weight: 1.5 },
  'mint.suffix': { display: 'mint suffix', weight: 1.5 },
  signers: { display: 'signers', weight: 0.5 },
  wrapper: { display: 'wrapper program', weight: 4 },
  'followers.adjacent': { display: 'bundle width', weight: 1, optional: true },
};
export const DEFAULT_WEIGHTS = Object.fromEntries(Object.entries(FAMILIES).map(([k, v]) => [k, v.weight]));

/** Tool ids → display names. Labels are the tools' own public stamps; names only, no logos. */
export const TOOL_NAMES = {
  j7tracker: 'j7tracker', uxento: 'uxento', rapidlaunch: 'Rapid Launch', usepaid: 'UsePaid',
  stonkfun: 'StonkFun', clawpump: 'clawpump', axiom: 'Axiom',
};

/** Stamp rules (ground truth for labels; never used as features). */
export const STAMP_HOSTS = {
  'metadata.j7tracker.io': 'j7tracker',
  'meta.uxento.io': 'uxento',
  'm.rapidlaunch.io': 'rapidlaunch',
};
export const STAMP_DESC = [
  [/Deployed using https?:\/\/(www\.)?j7tracker/i, 'j7tracker'],
  [/Created on https?:\/\/(www\.)?rapidlaunch/i, 'rapidlaunch'],
  [/Launched on discord\.gg\/uxento/i, 'uxento'],
  [/via UsePaid/i, 'usepaid'],
  [/stonkfun\.xyz/i, 'stonkfun'],
  [/clawpump\.tech/i, 'clawpump'],
  [/axiom\.trade\/t\//i, 'axiom'],
];
export const STAMP_CREATED_ON = [
  [/rapidlaunch\.io/i, 'rapidlaunch'],
  [/j7tracker\.io/i, 'j7tracker'],
  [/uxento/i, 'uxento'],
  [/usepaid/i, 'usepaid'],
  [/stonkfun/i, 'stonkfun'],
  [/clawpump/i, 'clawpump'],
];
/** Publicly cited fee collectors. rapidX…: DefiLlama dimension-adapters fees/rapid-launch.ts. */
export const FEE_WALLETS = {
  rapidXMVLw5uBieKHDGvF9k4xSSDXyD2FC5wLTAajaJ: 'rapidlaunch',
};
