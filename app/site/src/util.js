// Small shared helpers: formatting, the exhibit tag, hex byte rendering, typing.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
// masked (the backend blanks offensive on-chain symbols): still reads as a token, never as a glitch
export const symOf = (o) => (o?.masked ? `▇▇▇ · ${short(o.mint)}` : o?.symbol || short(o?.mint));
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const short = (k = '', n = 4) => (k && k.length > n * 2 + 1 ? `${k.slice(0, n)}…${k.slice(-n)}` : k || '');
export const n2 = (x) => (x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(2));
export const pad = (n, w = 2) => String(n).padStart(w, '0');
export const plural = (n, one, many = `${one}s`) => (Number(n) === 1 ? one : many); // '1 create', '3 creates'
export const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
export const MOBILE = () => innerWidth <= 768;
export const REPO_URL = 'https://github.com/lkristof55/striation'; // public on GitHub since 2026-09-26
export const PKG = 'striae';
export const EXHIBIT_MINT = '5DqSbDmD9YTN28kTG318WpDxVkHYJMVZyKsMhL69n6Vm'; // recorded fixture create (2026-09-25)

export const toolName = (r) => (r?.label || r?.displayName || null); // tools write themselves lowercase
export const utc = (unix) => { if (!unix) return null; const d = new Date(unix * 1000); return d.toISOString().replace('T', ' ').slice(0, 19) + ' utc'; };
export const ago = (unix) => { if (!unix) return ''; const s = Math.max(0, Math.round(Date.now() / 1000 - unix)); return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
export const verStr = (v) => (v === 'legacy' ? 'legacy' : `v${v}`);

// The family names as the lab calls them.
export const FAMILY = {
  version: { name: 'tx version', ix: 'message header' },
  'cu.limit': { name: 'cu limit', ix: 'computebudget' },
  'cu.price': { name: 'cu price', ix: 'computebudget' },
  'cu.source': { name: 'budget lives in', ix: 'message' },
  'ix.seq': { name: 'instruction order', ix: 'message' },
  'ix.shingle': { name: 'instruction pair', ix: 'message' },
  alt: { name: 'lookup table', ix: 'addresstablelookups' },
  'tip.relay': { name: 'tip relay', ix: 'system transfer' },
  'tip.lamports': { name: 'tip amount', ix: 'system transfer' },
  'tip.position': { name: 'tip position', ix: 'message' },
  'xfer.count': { name: 'other transfers', ix: 'system transfer' },
  'xfer.dest': { name: 'transfer dest', ix: 'system transfer' },
  'create.variant': { name: 'create variant', ix: 'pump.fun' },
  'buy.variant': { name: 'same-tx buy', ix: 'pump.fun' },
  'mint.suffix': { name: 'mint suffix', ix: 'account keys' },
  signers: { name: 'signers', ix: 'message header' },
  wrapper: { name: 'wrapper program', ix: 'outer ix' },
  'followers.adjacent': { name: 'followers', ix: 'same slot' },
};
export const famName = (f) => FAMILY[f]?.name || f;

// Which bytes are the value: ComputeBudget (op byte + LE value), System transfer (u32 tag + u64), Anchor disc, key.
export function hexParts(s) {
  const hex = s?.source?.hex; if (!hex) return null;
  const b = hex.match(/../g) || [];
  let op = 0;
  if (s.family === 'cu.limit' || s.family === 'cu.price') op = 1;
  else if (s.family === 'tip.lamports' || (s.source.where === 'ix' && hex.startsWith('02000000'))) op = 4;
  let last = b.length - 1; // little-endian: trailing zero bytes are padding, not value
  if (op) while (last > op && b[last] === '00') last--;
  return b.map((x, i) => ({ x, cls: i < op ? 'op' : (op ? i <= last : true) ? 'v' : '' }));
}
export function decodeLine(s) {
  const hex = s?.source?.hex; const w = `weight ${s.weight}`; const m = s.matched ? 'matched' : 'not in the neighbour';
  const le = (h) => { let v = 0n; const b = h.match(/../g) || []; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(parseInt(b[i], 16)); return v; };
  if (hex && (s.family === 'cu.price')) return `u64 le = ${Number(le(hex.slice(2))).toLocaleString('en-US')} µλ · ${w} · ${m}`;
  if (hex && (s.family === 'cu.limit')) return `u32 le = ${Number(le(hex.slice(2))).toLocaleString('en-US')} cu · ${w} · ${m}`;
  if (hex && s.family === 'tip.lamports' && hex.length >= 24) return `u64 le = ${(Number(le(hex.slice(8, 24))) / 1e9).toFixed(4)} sol · ${w} · ${m}`;
  if (hex && hex.length === 64) return `32-byte key · ${w} · ${m}`;
  if (hex && hex.length === 16) return `anchor discriminator · ${w} · ${m}`;
  return `${s.source?.where === 'config' ? 'v1 transactionConfig' : 'read from the message'} · ${w} · ${m}`;
}
export function hexHTML(s, { max = 9 } = {}) {
  const parts = hexParts(s);
  // text values (ix.seq) may only break after '>', never inside an instruction name
  if (!parts) return `<span class="val">${esc(s?.value ?? s?.display ?? '').replace(/&gt;/g, '&gt;<wbr>')}</span>`;
  const cut = parts.length > max ? parts.slice(0, max) : parts;
  return cut.map((p) => `<span class="${p.cls}">${p.x}</span>`).join('') + (parts.length > max ? '<span class="op">…</span>' : '');
}
// Bytes arrive left to right, 18 ms apart (no fades).
export function typeHex(el, s, opts) {
  el.innerHTML = hexHTML(s, opts);
  if (REDUCED) return;
  const spans = [...el.children]; spans.forEach((x) => (x.style.visibility = 'hidden'));
  spans.forEach((x, i) => setTimeout(() => (x.style.visibility = ''), 18 * i));
}
export function typeText(el, text, cps = 12) {
  if (REDUCED) { el.textContent = text; return Promise.resolve(); }
  return new Promise((ok) => { let i = 0; el.textContent = ''; const t = setInterval(() => { el.textContent = text.slice(0, ++i); if (i >= text.length) { clearInterval(t); ok(); } }, cps); });
}

// The exhibit tag, filled from a MatchResult (featured or a scan).
export function fillTag(root, r, { context = '' } = {}) {
  if (!root || !r) return;
  const q = (k) => root.querySelector(`[data-t="${k}"]`);
  const tool = toolName(r);
  const st = r.striations || [];
  const matched = st.filter((s) => s.matched).length;
  const sim = r.neighbours?.[0]?.similarity;
  const sample = r.source === 'fixture' || r.sample;
  const chip = sample ? ' <span class="chip">sample</span>' : '';
  const head = q('head');
  if (head) head.innerHTML = `exhibit <b>${esc(r.masked ? '▇▇▇' : r.symbol || '—')}</b> · <span class="b58">${esc(short(r.mint))}</span><br>verdict <b>${esc(r.verdict)}</b> · ${r.stamp ? (r.stampAgrees === false ? 'stamp disagrees' : 'stamp hidden') : 'no stamp'}${context ? ` · ${context}` : ''}`;
  root.querySelectorAll('[data-t="who"]').forEach((who) => {
    who.textContent = r.verdict === 'unknown' ? 'unknown barrel' : tool || 'unknown barrel';
    who.className = `who ${r.verdict === 'match' ? '' : r.verdict}`;
  });
  const bar = q('barrel');
  if (bar) bar.innerHTML = `barrel <b>${esc(r.barrelId)}</b> · ${r.neighbours?.[0] ? `nearest <span class="b58">${esc(short(r.neighbours[0].mint))}</span>` : 'no neighbour'}`;
  const meter = q('meter');
  if (meter) {
    meter.innerHTML = '';
    for (const s of [...st].sort((a, b) => b.weight - a.weight)) { const i = document.createElement('i'); i.className = s.matched ? (s.family === 'cu.price' ? 'm' : 'on') : ''; i.style.flex = s.weight; meter.appendChild(i); }
  }
  root.querySelectorAll('[data-t="foot"]').forEach((f) => {
    f.innerHTML = root.classList.contains('mtag')
      ? `<b>${n2(sim)}</b> · ${matched}/${st.length} striae${chip}`
      : `<b>${n2(sim)}</b> similarity · <b>${matched}/${st.length}</b> striae${chip}`;
  });
}
