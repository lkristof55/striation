// Mask slurs in on-chain token symbols/names before they reach the site (pure, no I/O).
// Launch metadata is attacker-controlled text; the brand's own page and its "post the bench" export
// must not reprint slurs. The mint, signature and every forensic field stay untouched: only the
// `symbol` / `name` strings become MASK, and the object gets `masked: true`.
//
// Normalisation defeats the usual evasions: case, diacritics and fullwidth forms (NFKD), zero-width
// characters, Cyrillic/Greek look-alikes, leetspeak (digits and symbols for letters, '$' as s), letters
// spaced out one by one and stretched letters. The list is deliberately small and aimed at slurs, not
// profanity; it is stored ROT13 in the library so no file here spells a slur.

// The rules live in the striae library (src/mask.js at the repo root), which also masks names in extract()
// by default: one list, one normalisation, for the library, the API and the site.
import { MASK, normalizeWords, isOffensive, isMasked } from '../../src/mask.js';

export { MASK, normalizeWords, isOffensive, isMasked };

/** true when a symbol/name must not be shown: a listed slur, or already masked by the library ('▇▇▇'). */
export const shouldMask = (s) => isOffensive(s) || isMasked(s);

/** MASK when offensive or already masked, else the input unchanged. */
export const maskText = (s) => (shouldMask(s) ? MASK : s);

const MASK_KEYS = new Set(['symbol', 'name']);

/**
 * Deep copy of an API body with every offensive `symbol` / `name` string replaced by MASK and
 * `masked: true` set on the object that held it. Mints, signatures and numbers are never changed.
 */
export function maskDeep(v) {
  if (Array.isArray(v)) return v.map(maskDeep);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  let masked = false;
  for (const [k, x] of Object.entries(v)) {
    if (MASK_KEYS.has(k) && typeof x === 'string' && shouldMask(x)) { out[k] = MASK; masked = true; }
    else out[k] = maskDeep(x);
  }
  if (masked) out.masked = true;
  return out;
}
