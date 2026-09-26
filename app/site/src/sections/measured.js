// Beat 6: every number here is /api/stats (bench/results.json at the repo root), as-is. 503 → PLANNED.
import { gsap } from 'gsap';
import { $, esc, REDUCED } from '../util.js';

const pct = (x) => (x == null ? '—' : (x * 100).toFixed(1));

export function renderStats(res) {
  const el = $('#stats');
  if (!res.ok) {
    el.innerHTML = `<div class="planned-box"><span class="chip planned">planned</span><p class="mono-lc"> ${res.code === 'NOT_MEASURED' ? 'numbers appear when `npm run bench` has run on this machine.' : "the stats endpoint isn't answering. no number is shown rather than a made-up one."}</p></div>`;
    return null;
  }
  const s = res.data; const a = s.accuracy || {};
  const labels = (a.perLabel || []).map((p) => p.label);
  const cols = [...labels, 'unknown'];
  const conf = a.confusion || {};
  const rowsHTML = (a.perLabel || []).map((p) => `<tr><td>${esc(p.label)}</td><td class="n">${p.n}</td><td class="n">${pct(p.recall)}%</td><td class="n">${pct(p.precision)}%</td></tr>`).join('');
  // axes on the grid itself: predicted tools across the top (read bottom-up), true tools down the side
  let matrix = `<span class="ax corner">true ↓ · predicted →</span>${cols.map((c) => `<span class="ax axc${c === 'unknown' ? ' unk' : ''}">${esc(c)}</span>`).join('')}`;
  for (const t of labels) {
    const row = conf[t] || {}; const n = Object.values(row).reduce((x, y) => x + y, 0) || 1;
    matrix += `<span class="ax axr">${esc(t)}</span>`;
    for (const c of cols) { const v = (row[c] || 0) / n; matrix += `<i class="${t === c ? 'diag' : ''}" title="${esc(t)} → ${esc(c)}: ${row[c] || 0}"><b style="transform:scale(1,${v.toFixed(3)})"></b></i>`; }
  }
  const bench = (s.bench || []).map((b) => `<div class="bench-row"><div><div class="mono">${esc(b.name)}</div><div class="cmd">${esc(b.command || s.command)}</div></div><div class="v"><span data-count="${b.value}">${fmt(b.value)}</span> <span class="u8">${esc(b.unit)}</span></div></div>`).join('');
  el.innerHTML = `
    <div class="cmp">
      <div><div class="mono">top-1, ${esc(a.method || '')} · n ${a.n}</div><div class="big-n"><span data-count="${pct(a.top1)}" data-dec="1">${pct(a.top1)}</span><small>%</small></div></div>
      <div class="base"><div class="mono">majority baseline</div><div class="big-n" style="font-size:60px"><span data-count="${pct(a.majorityBaseline)}" data-dec="1">${pct(a.majorityBaseline)}</span><small style="font-size:28px">%</small></div></div>
      <div class="base"><div class="mono">macro recall</div><div class="big-n" style="font-size:60px"><span data-count="${pct(a.macroRecall)}" data-dec="1">${pct(a.macroRecall)}</span><small style="font-size:28px">%</small></div></div>
    </div>
    <p class="mono-lc" style="margin:14px 0 26px">${a.withoutXferDest ? `without the xfer.dest family: top-1 ${pct(a.withoutXferDest.top1)}%, macro recall ${pct(a.withoutXferDest.macroRecall)}%. ` : ''}${a.abstained != null ? `abstained (said unknown): ${pct(a.abstained)}%, counted as wrong. ` : ''}${esc(a.note || '')}</p>
    <div class="statgrid">
      <div><div class="mono">per label · stamps hidden</div><table class="tbl"><thead><tr><th>label</th><th>n</th><th>recall</th><th>precision</th></tr></thead><tbody>${rowsHTML}</tbody></table></div>
      <div><div class="mono">confusion · share of each true tool's creates</div><div class="matrix" style="grid-template-columns:var(--axw) repeat(${cols.length},1fr)">${matrix}</div></div>
    </div>
    <div style="margin-top:34px"><div class="mono">bench · ${esc(s.machine || '')} · node ${esc(s.node || '')} · ${esc((s.measuredAt || '').slice(0, 16).replace('T', ' '))} utc</div>${bench}</div>
    <p class="mono-lc" style="margin-top:12px">reference: ${s.reference?.size ?? '—'} creates, ${Object.entries(s.reference?.labels || {}).map(([k, v]) => `${esc(k)} ${v}`).join(' · ')} · reproduce: <span class="cmd">${esc(s.command || 'npm run bench')}</span></p>`;
  return s;
}
function fmt(v) { const n = Number(v); if (!Number.isFinite(n)) return esc(v); return n >= 100 ? Math.round(n).toLocaleString('en-US') : n >= 10 ? n.toFixed(1) : n.toFixed(2); }

// counters count up once (600 ms settle), the matrix fills row by row (40 ms stagger)
export function animateStats() {
  if (REDUCED) return;
  const el = $('#stats');
  el.querySelectorAll('[data-count]').forEach((s) => {
    const to = parseFloat(s.dataset.count); if (!Number.isFinite(to)) return;
    const dec = s.dataset.dec ? Number(s.dataset.dec) : null; const o = { v: 0 };
    gsap.to(o, { v: to, duration: 0.6, ease: 'expo.out', onUpdate: () => (s.textContent = dec != null ? o.v.toFixed(dec) : fmt(o.v)) });
  });
  gsap.from(el.querySelectorAll('.matrix i b'), { scaleY: 0, duration: 0.28, ease: 'expo.out', stagger: 0.04 / 3 });
}
