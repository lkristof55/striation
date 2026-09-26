// Beat 5: the live function. Evidence input → /api/match → exhibit tag, striation strip, microscope.
// The live feed of pump.fun creates from /api/feed, with the top barrels as a stacked bar.
import * as api from './api.js';
import { createScope } from './scope.js';
import { $, $$, esc, symOf, short, n2, pad, plural, famName, hexParts, fillTag, toolName, utc, ago, typeText, REDUCED, EXHIBIT_MINT, MOBILE } from '../util.js';
import { SAMPLE_NEIGHBOUR } from '../data/sample.js';

const ERR = {
  BAD_INPUT: () => "that isn't a mint. base58, 32–44 characters, no 0, O, I or l.",
  NOT_FOUND: () => 'no transactions for this address. wrong cluster, or too fresh. try again in a few seconds.',
  NOT_PUMP_CREATE: () => "no pump.fun create in this mint's first transactions. striation only reads pump.fun launches.",
  RATE_LIMITED: (s) => `the bench is busy. the rpc said 429. retrying in ${s} s.`,
  UPSTREAM: () => "the rpc didn't answer in 8 s. nothing was guessed. try again.",
  OFFLINE: () => "the bench isn't answering from here. nothing was guessed. check the connection and try again.",
  NO_ENDPOINT: () => "the match endpoint isn't deployed on this host yet. nothing was guessed.",
};

export function createBenchUI({ renderer, env, mobile, onLoading, onResult, scrollTo, sound, share }) {
  const resultEl = $('#result'); const statusEl = $('#status');
  let scope = null; let busy = false; let refSize = null; let lastFeed = null;

  // inputs: validate as you type, submit on Enter
  for (const form of $$('[data-evidence]')) {
    const input = form.querySelector('input'); const msg = form.querySelector('.msg');
    input.addEventListener('input', () => {
      const v = api.parseEvidence(input.value);
      msg.innerHTML = v?.bad ? `<span>${ERR.BAD_INPUT()}</span>` : '';
      stale(!!v?.bad);
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = api.parseEvidence(input.value);
      if (!v || v.bad) { msg.innerHTML = `<span>${ERR.BAD_INPUT()}</span>`; stale(true); input.focus(); return; }
      msg.innerHTML = ''; stale(false);
      if (form.closest('#bench')) scrollTo('#match');
      run(v);
    });
    form.querySelector('[data-try]')?.addEventListener('click', () => { input.value = EXHIBIT_MINT; input.dispatchEvent(new Event('input')); input.focus(); });
  }

  // bad input in either field: the last exhibit and its 'done in' line step back; they don't answer this input
  function stale(on) {
    const shown = !!resultEl.children.length && !resultEl.querySelector('.tag.none');
    resultEl.classList.toggle('stale', on && shown); statusEl.classList.toggle('stale', on && shown);
  }

  async function run(q, tries = 0) {
    if (busy) return; busy = true;
    $$('[data-evidence] button[type=submit]').forEach((b) => (b.disabled = true));
    onLoading(true);
    // the previous exhibit steps back while this one is read; it never sits next to a new verdict
    resultEl.classList.add('running'); stale(false);
    statusEl.innerHTML = '<p></p><p></p><p></p>';
    const ls = [...statusEl.children];
    const t0 = performance.now();
    const req = api.match(q);
    // the three lines run beside the request (about 100 ms each), they never hold the result back
    const lines = [`finding the bullet · ${q.kind === 'mint' ? 'getTransactionsForAddress' : 'getTransaction'}`, 'reading striations · 17 families', `comparing against ${refSize ?? 'the'} reference creates`];
    let typing = true;
    (async () => { for (let i = 0; i < 3 && typing; i++) await typeText(ls[i], lines[i], Math.max(2, Math.round(100 / lines[i].length))); })();
    const r = await req; const ms = Math.round(performance.now() - t0);
    typing = false;
    onLoading(false); busy = false;
    $$('[data-evidence] button[type=submit]').forEach((b) => (b.disabled = false));
    if (!r.ok) {
      clearResult(r.code);
      if (r.code === 'RATE_LIMITED' && tries < 1) {
        const s = r.retryAfter || 5;
        statusEl.innerHTML = `<div class="err"><span>${ERR.RATE_LIMITED(s)}</span></div>`;
        setTimeout(() => run(q, tries + 1), s * 1000); return;
      }
      statusEl.innerHTML = `<div class="err"><span>${esc((ERR[r.code] || ERR.UPSTREAM)(0))}</span></div>`;
      return;
    }
    statusEl.innerHTML = `<p>done in ${ms} ms · ${r.data.cached ? 'cached' : 'fresh'} · source ${esc(r.data.source)}</p>`;
    await show(r.data);
  }

  // after a failed scan the bench is empty: the old verdict would read as this input's answer
  function clearResult(code) {
    scope?.dispose(); scope = null; io?.disconnect(); onResult(null);
    resultEl.classList.remove('running');
    const why = code === 'NOT_PUMP_CREATE' ? 'not a pump.fun create' : code === 'BAD_INPUT' ? 'not a mint' : code === 'RATE_LIMITED' ? 'the rpc is busy' : 'no answer from the rpc';
    resultEl.innerHTML = `<div class="tag none"><span class="hole" aria-hidden="true"></span><div class="mono">exhibit <b>none</b> · ${esc(why)}</div><div class="who">nothing on the bench</div><div class="mono" style="text-transform:none">no verdict for this input. nothing was guessed.</div></div>`;
  }

  async function show(m, { context = '' } = {}) {
    const tool = toolName(m); const st = m.striations || [];
    const matched = st.filter((s) => s.matched).length;
    const bm = m.barrelMates || {}; const nb = m.neighbours?.[0];
    const sample = m.source === 'fixture' || m.sample;
    const verdictCopy = m.verdict === 'match'
      ? `exhibit ${symOf(m)}. ${tool}, ${n2(m.confidence)}. barrel ${m.barrelId}. ${matched}/${st.length} striations matched. ${m.stamp ? 'stamp hidden.' : 'no stamp; named from striations only.'}`
      : m.verdict === 'family'
        ? `family resemblance. ${tool}, ${n2(m.confidence)}. not enough to call it.`
        : `unknown barrel. nothing in the reference within 0.50.${bm.recent > 1 ? ` barrel ${m.barrelId} fired ${bm.recent} ${plural(bm.recent, 'create')} in the last ${bm.windowMinutes || 30} min.` : ''}`;
    const stampLine = m.stamp ? (m.stampAgrees === false ? `stamp says ${esc(m.stamp.label)}. striations say ${esc(tool || 'unknown')}.` : `stamp agrees (${esc(m.stamp.kind)}: ${esc(m.stamp.evidence)})`) : 'no stamp on this create.';
    resultEl.classList.remove('running');
    resultEl.innerHTML = `
      <div class="tag">
        <span class="hole" aria-hidden="true"></span>
        <div class="mono">exhibit <b>${esc(m.masked ? '▇▇▇' : m.symbol || '—')}</b> · <span class="b58">${esc(short(m.mint))}</span> · ${esc(utc(m.blockTime) || 'time n/a')}${sample ? ' <span class="chip">sample</span>' : ''}</div>
        <div class="who ${m.verdict === 'match' ? '' : m.verdict}">${esc(m.verdict === 'unknown' ? 'unknown barrel' : tool || 'unknown barrel')}</div>
        <div class="mono">barrel <b>${esc(m.barrelId)}</b> · confidence <b>${n2(m.confidence)}</b> · margin <b>${n2(m.margin)}</b></div>
        <div class="mono">same barrel as <b>${bm.recent ?? 0}</b> ${plural(bm.recent ?? 0, 'create')} in the last ${bm.windowMinutes ?? 30} min · <b>${bm.reference ?? 0}</b> in the reference</div>
        <div class="meter" aria-hidden="true">${[...st].sort((a, b) => b.weight - a.weight).map((s) => `<i class="${s.matched ? 'on' : ''}" style="flex:${s.weight}"></i>`).join('')}</div>
        <div class="mono">${m.verdict === 'match' ? '' : ''}${stampLine ? `<span style="text-transform:none">${stampLine}</span>` : ''}</div>
      </div>
      <p class="verdict-line mono-lc">${esc(verdictCopy)}</p>
      <div class="actions">
        <button type="button" class="btn" data-a="copy">copy verdict</button>
        <a class="btn ghost" href="https://solscan.io/tx/${encodeURIComponent(m.signature)}" target="_blank" rel="noopener">view tx ↗</a>
      </div>
      <div class="scope" id="scope5" data-scope></div>
      <table class="strip"><thead><tr><th>family</th><th>striation</th><th>bytes</th><th>w</th><th>match</th></tr></thead><tbody>
      ${st.map((s) => `<tr class="${s.matched ? 'm' : ''}"><td>${esc(famName(s.family))}</td><td>${esc(s.display)}</td><td class="hx">${hexCell(s)}</td><td>${s.weight}</td><td>${s.matched ? '✓' : '—'}</td></tr>`).join('')}
      </tbody></table>
      ${m.followers ? `<p class="mono-lc">followers in the same slot: ${m.followers.sameSlot} · adjacent ${m.followers.adjacent}</p>` : ''}
      ${bm.sample?.length ? `<p class="mono-lc">barrel mates: ${bm.sample.map((x) => esc(symOf(x))).join(' · ')}</p>` : ''}`;
    resultEl.querySelector('[data-a="copy"]').addEventListener('click', async (e) => {
      try { await navigator.clipboard.writeText(verdictCopy); } catch { /* clipboard blocked */ }
      e.target.textContent = 'copied.'; setTimeout(() => (e.target.textContent = 'copy verdict'), 1200);
    });
    scope?.dispose(); io?.disconnect();
    const sc = createScope($('#scope5'), { renderer, env, mobile, onShare: share, sound }); scope = sc;
    // build the two bullets only when the field comes near the viewport
    const arm = async () => { const ref = await reference(m); if (scope !== sc) return; sc.setPair(m, ref.striations, { refLabel: ref.label, refMint: nb?.mint }); onResult(sc, m); };
    if (context === 'featured') {
      io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); arm(); } }, { rootMargin: '60% 0px' });
      io.observe(sc.el);
    } else await arm();
  }
  let io = null;

  // the right half of the microscope: the nearest neighbour's own striations (one more /api/match, cached 24 h)
  async function reference(m) {
    const nb = m.neighbours?.[0];
    if (m.sample || m.source === 'fixture') return { striations: SAMPLE_NEIGHBOUR.striations, label: `reference ${short(SAMPLE_NEIGHBOUR.mint)}` };
    if (!nb) return { striations: null, label: 'reference' };
    const r = await api.match({ kind: 'mint', value: nb.mint });
    return r.ok ? { striations: r.data.striations, label: `reference ${symOf(nb)}` } : { striations: null, label: `reference ${short(nb.mint)}` };
  }

  // the feed
  function renderFeed(f) {
    if (f.items?.length > 24) f = { ...f, items: f.items.slice(0, 24) };
    lastFeed = f;
    const rows = $('#rows'); const prev = new Set($$('#rows li').map((li) => li.dataset.m));
    $('#feedRate').textContent = f.sample ? 'sample, the feed endpoint is not answering' : `${f.items.length} ${plural(f.items.length, 'create')} · ${f.ratePerMin ?? '—'}/min · ${Math.round((f.stampedShare || 0) * 100)}% stamped · ${f.source}`;
    const age = f.updatedAt ? Math.round((Date.now() - Date.parse(f.updatedAt)) / 1000) : null;
    $('#feedAge').textContent = f.sample ? '' : age != null && age > 300 ? `stored feed from ${new Date(f.updatedAt).toISOString().slice(11, 16)} utc · refreshing` : age != null && age > 120 ? `feed from ${new Date(f.updatedAt).toISOString().slice(11, 16)} utc, stored. the rpc is slow right now.` : `updated ${age ?? '—'} s ago`;
    if (!f.items?.length) { rows.innerHTML = `<li class="empty">${f.sample ? 'the feed endpoint is not answering. nothing is shown rather than something made up.' : 'no creates in the window. the feed refreshes every 30 s.'}</li>`; $('#barbar').innerHTML = ''; return; }
    let fresh = 0;
    rows.innerHTML = f.items.map((it) => {
      const isNew = prev.size && !prev.has(it.mint); if (isNew) fresh++;
      const t = it.blockTime ? new Date(it.blockTime * 1000).toISOString().slice(11, 19) : '—';
      const tool = it.verdict === 'unknown' ? 'unknown' : it.label || it.displayName || 'unknown';
      return `<li tabindex="0" role="button" data-m="${esc(it.mint)}" class="${isNew ? 'new' : ''}" aria-label="scan ${esc(it.masked ? `masked symbol ${short(it.mint)}` : it.symbol)}"><span class="t">${t}</span><span class="sym">${esc(it.masked ? symOf(it) : (it.symbol || '—').slice(0, 12))}</span><span class="mint">${esc(short(it.mint))}</span><span class="tool ${it.verdict === 'match' ? '' : 'unk'}">${esc(tool)}${it.verdict === 'family' ? ' ~' : ''}</span><span>${n2(it.confidence)}</span><span class="bar">${esc(it.barrelId)}</span></li>`;
    }).join('');
    if (fresh) { const d = $('#liveDot'); d.classList.remove('blink'); void d.offsetWidth; d.classList.add('blink'); }
    const bars = f.barrels || []; const rest = Math.max(0, 1 - bars.reduce((a, b) => a + (b.share || 0), 0));
    $('#barbar').innerHTML = bars.map((b, i) => `<i class="${i === 0 ? 'on' : ''}" style="flex:${b.share}" title="${esc(b.barrelId)} ${esc(b.displayName || b.label || 'unlabelled')} ${b.count}"></i>`).join('') + (rest > 0.001 ? `<i class="rest" style="flex:${rest}" title="other barrels"></i>` : '');
    let leg = $('.barlegend'); if (!leg) { leg = document.createElement('div'); leg.className = 'barlegend mono'; $('#barbar').after(leg); }
    leg.innerHTML = bars.slice(0, 8).map((b) => `<span><b>${esc(b.barrelId)}</b> <span class="b58">${esc(b.label || b.displayName || 'unlabelled')}</span> ${b.count} · ${Math.round((b.share || 0) * 100)}%</span>`).join('');
  }
  $('#rows').addEventListener('click', (e) => { const li = e.target.closest('li[data-m]'); if (li) { $('#q2').value = li.dataset.m; run({ kind: 'mint', value: li.dataset.m }); } });
  $('#rows').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const li = e.target.closest('li[data-m]'); if (li) { $('#q2').value = li.dataset.m; run({ kind: 'mint', value: li.dataset.m }); } } });

  // Empty state: before any scan, the result shows the featured create from the live feed.
  function showFeatured(f) {
    if (resultEl.dataset.user) return;
    show(f.featured, { context: 'featured' }).then(() => {
      const head = resultEl.querySelector('.tag .mono');
      if (head) head.insertAdjacentHTML('beforeend', `<br>${f.sample || f.featured.source === 'fixture' ? 'recorded fixture, not the live feed' : `latest match on the live feed · ${ago(f.featured.blockTime)}`}`);
    });
  }
  const origRun = run;
  run = (q, t) => { resultEl.dataset.user = '1'; return origRun(q, t); };

  function hexCell(s) {
    const p = hexParts(s); if (!p) return '<span style="color:#7F878A">—</span>';
    const max = MOBILE() ? 8 : 12;
    return p.slice(0, max).map((b) => (b.cls === 'v' ? `<span class="v">${b.x}</span>` : b.x)).join(' ') + (p.length > max ? ' …' : '');
  }

  return {
    renderFeed, showFeatured, run: (q) => run(q),
    setRefSize(n) { refSize = n; },
    get scope() { return scope; },
  };
}
