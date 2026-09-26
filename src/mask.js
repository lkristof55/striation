// Slur mask for on-chain token names and symbols (pure, no I/O).
// Launch metadata is attacker-controlled text. extract() runs name and symbol through maskText(), so
// nothing striae emits (meta, instances, verdicts, the CLI) reprints a slur. The mint, the signature and
// every striation stay the same: only the `name` / `symbol` strings become MASK.
//
// Normalisation defeats the usual evasions: case, diacritics and fullwidth forms (NFKD), zero-width
// characters, Cyrillic/Greek look-alikes, leetspeak (n1gg4, f@g, $ as s), separators ("n.i.g", "f a g")
// and stretched letters ("niiigga"). The list is deliberately small and aimed at slurs, not profanity.

export const MASK = '▇▇▇';
const BLOCK = '▇'; // U+2587, 3 bytes in UTF-8

const HOMOGLYPH = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', і: 'i', ј: 'j', ѕ: 's', к: 'k', м: 'm', т: 't', н: 'h', в: 'b', г: 'r',
  α: 'a', ε: 'e', ο: 'o', ι: 'i', κ: 'k', ν: 'v', τ: 't', ρ: 'p', υ: 'u', γ: 'y', ı: 'i', ɡ: 'g',
};
const LEET = { 0: 'o', 1: 'i', '!': 'i', '|': 'i', 3: 'e', 4: 'a', '@': 'a', 5: 's', $: 's', 7: 't', 9: 'g', '+': 't' };

// The term lists are stored ROT13-encoded (rot13() undoes it at load) so the source itself never
// spells a slur; decode one with `node -e "import('./src/mask.js').then(m => console.log(m.rot13('...')))"`.
export const rot13 = (s) => s.replace(/[a-z]/gi, (c) => { const b = c <= 'Z' ? 65 : 97; return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b); });
const terms = (enc) => rot13(enc).split(' ');

// Each term matches with stretched letters: a doubled letter needs 2+ ("niger" and "Niger" do not match).
const stretch = (t) => t.replace(/(.)\1*/g, (run, c) => (run.length > 1 ? `${c}{${run.length},}` : `${c}+`));
const re = (list, wrap) => new RegExp(wrap(list.map(stretch).join('|')));

/** Slurs matched in the letters of the whole string joined (catches a two-word slur written with spaces). */
const JOINED = re(terms('avttre avttn avtte avtthu snttbg cbepuzbaxrl whatyrohaal qvaqhahssva fvrturvy urvyuvgyre'), (s) => `(?:${s})`);
/** Slurs matched inside a single word (a slur with a suffix glued on), never across words ("Pure Tardigrade"). */
const IN_WORD = re(terms('sntbg wvtnobb jrgonpx gbjryurnq enturnq mvccreurnq ergneq genaal'), (s) => `(?:${s})`);
/** Short slurs matched only as a whole word (optionally plural) so "Leaf Agent" or "Spicy" never match. */
const WORD = re(terms('snt stg xvxr fcvp puvax puvaxl tbbx qlxr avt cnxv jbt ornare'), (s) => `^(?:${s})(?:s|z|es)?$`);
/** Word starts that are only ever the n-word ("Niger", "Nigeria", "nigiri" do not match). */
const START = /^n+i+g+(?:a|g+)/;
/** Innocent words that contain a listed term (kept apart before the IN_WORD / START tests). */
const ALLOW = new RegExp(terms('favttyr favttre avttyr avttneq ergneqnag ergneqngvba').join('|'), 'g');

/** Lower-case letters-only words of a string, after undoing the evasions above. */
export function normalizeWords(s) {
  const t = String(s ?? '')
    .normalize('NFKD')
    .replace(/\p{M}|\p{Cf}/gu, '')
    .toLowerCase()
    .replace(/(^|[^\p{L}\p{N}])\$+(?=[\p{L}\p{N}])/gu, '$1') // ticker prefix: "$ABC" → "abc"
    .replace(/./gsu, (c) => HOMOGLYPH[c] || LEET[c] || c);
  const raw = t.split(/[^a-z]+/).filter(Boolean);
  // Letters spaced out one by one ("F A G", "n.i.g.g.a") are one word.
  const words = [];
  for (const w of raw) {
    const last = words.length - 1;
    if (w.length === 1 && last >= 0 && words[last].single) { words[last].w += w; continue; }
    words.push({ w, single: w.length === 1 });
  }
  return words.map((x) => x.w);
}

/** true when a name/symbol contains a listed slur (after normalisation). */
export function isOffensive(s) {
  if (s == null || s === '') return false;
  const words = normalizeWords(s);
  if (!words.length) return false;
  const clean = words.map((w) => w.replace(ALLOW, '_'));
  if (JOINED.test(clean.join(''))) return true;
  return clean.some((w) => IN_WORD.test(w) || WORD.test(w) || START.test(w));
}

/**
 * A same-byte-length stand-in for a scrubbed Borsh string: '▇' blocks padded with '_' to exactly
 * `byteLength` UTF-8 bytes, so length prefixes and every later offset in the instruction stay put.
 */
export function placeholder(byteLength) {
  const n = Math.max(0, byteLength | 0);
  return BLOCK.repeat(Math.floor(n / 3)) + '_'.repeat(n % 3);
}

/** true for MASK or a placeholder() (a name that was already masked or scrubbed at record time). */
export const isMasked = (s) => typeof s === 'string' && /^▇+_{0,2}$/u.test(s);

/** MASK when offensive or already masked/scrubbed, else the input unchanged. */
export const maskText = (s) => (isOffensive(s) || isMasked(s) ? MASK : s);
