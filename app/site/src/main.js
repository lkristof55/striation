// Striation: boot. Lenis + GSAP ScrollTrigger drive one fixed WebGL stage (the CT bench) and the
// comparison microscope; the function UI talks to /api/* (app/README.md).
import Lenis from 'lenis';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { createBench, applyPose, lerpPose, toTokens, seedOf } from './scene/bench.js';
import { B, profile } from './scene/bullet.js';
import { createMechanism, poses } from './sections/mechanism.js';
import { createScope } from './function/scope.js';
import { createBenchUI } from './function/bench-ui.js';
import * as api from './function/api.js';
import { renderStats, animateStats } from './sections/measured.js';
import { renderRepo } from './sections/repo.js';
import { $, $$, fillTag, typeHex, decodeLine, famName, FAMILY, pad, short, utc, verStr, REDUCED, MOBILE, esc, toolName, symOf } from './util.js';
import { SAMPLE_FEATURED, SAMPLE_NEIGHBOUR } from './data/sample.js';

gsap.registerPlugin(ScrollTrigger);
if (document.body.dataset.page === '404') import('./page404.js').then((m) => m.run());
else boot().catch((e) => { console.warn('stage failed, text stays readable:', e?.message); window.__ready = true; });

async function boot() {
  let mobile = MOBILE(); let P = poses(mobile);
  const canvas = $('#stage');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, stencil: true, powerPreference: 'high-performance' });
  const dpr = () => Math.min(devicePixelRatio, mobile ? 1.5 : 2);
  renderer.setPixelRatio(dpr()); renderer.setSize(innerWidth, innerHeight, false);
  renderer.setClearColor(0x000000, 0); renderer.localClippingEnabled = true;
  renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;

  // data + environment in parallel
  const feedP = api.feed(24);
  const statsP = api.stats();
  const barrelsP = api.barrels();
  const envP = new HDRLoader().loadAsync('/tex/monochrome_studio_02_1k.hdr').then((t) => {
    t.mapping = THREE.EquirectangularReflectionMapping; const pm = new THREE.PMREMGenerator(renderer);
    const env = pm.fromEquirectangular(t).texture; t.dispose(); pm.dispose(); return env;
  }).catch(() => null);
  const first = await Promise.race([feedP, new Promise((r) => setTimeout(() => r(null), 2200))]);
  let feed = first || { featured: SAMPLE_FEATURED, sample: true, items: [], barrels: [] };
  let featured = feed.featured;
  const [env] = await Promise.all([envP, document.fonts.ready]);

  // the bench, engraved from the featured create's striations
  const bench = createBench(renderer, { tokens: toTokens(featured.striations), env, mobile, micro: seedOf(featured.mint) });
  const mech = createMechanism({ bench });
  const sound = makeSound();

  // dim layer (the stage parks at 30% after the microscope)
  const dimScene = new THREE.Scene(); const dimCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const dimMat = new THREE.MeshBasicMaterial({ color: '#E3E5E2', transparent: true, opacity: 0, depthTest: false, depthWrite: false, toneMapped: false });
  dimScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), dimMat));
  // the result microscope steps back with its exhibit (scan running, or the input isn't a mint):
  // the same film veil, drawn only inside the field's stencil disc
  const veilScene = new THREE.Scene();
  veilScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ color: '#E3E5E2', transparent: true, opacity: 0.72, depthTest: false, depthWrite: false, toneMapped: false, stencilWrite: true, stencilRef: 1, stencilFunc: THREE.EqualStencilFunc, stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp })));
  const resultBox = $('#result');

  // beat 4 microscope
  const scope4 = createScope($('#scope4'), { renderer, env, mobile, sound });
  async function prepScope4(f) {
    let ref = null; let label = 'reference';
    if (f.sample || f.source === 'fixture') { ref = SAMPLE_NEIGHBOUR.striations; label = `reference ${short(SAMPLE_NEIGHBOUR.mint)}`; }
    else if (f.neighbours?.[0]) {
      const r = await api.match({ kind: 'mint', value: f.neighbours[0].mint });
      label = `reference ${symOf(f.neighbours[0])}`;
      if (r.ok) ref = r.data.striations;
    }
    scope4.setPair(f, ref, { refLabel: label, refMint: f.neighbours?.[0]?.mint });
    auto4 = false;
  }
  let auto4 = false; // beat 4 indexes itself into the lock once per pair, when the field has opened

  // function UI
  let loading = false; let resultScope = null;
  const ui = createBenchUI({
    renderer, env, mobile, sound, share: shareCard,
    onLoading: (v) => { loading = v; },
    onResult: (sc) => { resultScope = sc; },
    scrollTo: (sel) => (lenis ? lenis.scrollTo(sel, { duration: 1.2 }) : $(sel).scrollIntoView()),
  });

  // hero fill: tag, slice readout, DICOM corners
  let heroStriation = null; let brA = null;
  function heroFill(f, { typed = false } = {}) {
    fillTag($('#heroTag'), f); fillTag($('#mTag'), f);
    const st = f.striations || [];
    heroStriation = st.find((s) => s.family === 'cu.price' && s.source?.hex) || st.find((s) => s.source?.hex && s.source.hex.length <= 26) || st.find((s) => s.source?.hex) || st[0];
    const idx = mech.stops.findIndex((x) => x.s === heroStriation);
    const s = heroStriation; if (!s) return;
    bench.state.family = s.family;
    $('#roHead').innerHTML = `slice <b>${pad(idx + 1)}</b> / ${pad(mech.stops.length)} · ix <b>${s.source?.ixIndex ?? '—'}</b> · ${esc(FAMILY[s.family]?.ix || '')}`;
    $('#roKey').textContent = famName(s.family);
    typeHex($('#roHex'), s, { max: 9 });
    $('#roEq').textContent = decodeLine(s);
    $('#dSlot').textContent = f.slot ?? '—'; $('#dVer').textContent = verStr(f.version); $('#dVerS').textContent = verStr(f.version);
    const sample = f.sample || f.source === 'fixture';
    $('#dTime').textContent = sample ? 'recorded fixture (sample)' : utc(f.blockTime) || 'time n/a';
    $('#dTimeS').textContent = sample ? 'sample' : (utc(f.blockTime) || '').slice(11, 16) + ' utc';
    $('#series').textContent = sample ? 'recorded fixture' : 'live feed';
    brA = null;
  }
  mech.setFeatured(featured);
  heroFill(featured);
  ui.renderFeed(feed); ui.showFeatured(feed);
  if (!first) feedP.then((f) => { if (f.featured && !f.sample) swapFeatured(f); });
  // First load after an idle stretch: the store can be hours old (the endpoint refreshes it in the
  // background on this very request). Re-poll right after that refresh instead of waiting 30 s; a
  // different limit skips both the browser cache and the function's per-limit cache. Rows stay at 24.
  const ageS = (f) => (f?.updatedAt ? (Date.now() - Date.parse(f.updatedAt)) / 1000 : 0);
  async function catchUp(k = 0) {
    if (feed.sample || ageS(feed) <= api.feedTiming(feed).old || k > 3) return;
    await new Promise((r) => setTimeout(r, [3000, 5000, 8000, 14000][k]));
    const f = await api.feed(25 + k, { fresh: true });
    if (!f.sample && Date.parse(f.updatedAt) > Date.parse(feed.updatedAt || 0)) swapFeatured(f);
    catchUp(k + 1);
  }
  feedP.then(() => catchUp());

  function swapFeatured(f) {
    feed = f; ui.renderFeed(f);
    const changed = f.featured?.mint !== featured.mint && scrollY < innerHeight * 0.6;
    if (changed) {
      featured = f.featured;
      bench.setTokens(toTokens(featured.striations), seedOf(featured.mint));
      mech.setFeatured(featured); heroFill(featured, { typed: true });
      prepScope4(featured); if (!$('#result').dataset.user) ui.showFeatured(f);
    }
    dirty = true;
  }
  // poll the feed every 30 s (the endpoint caches 30 s); pause when hidden
  setInterval(async () => { if (document.hidden) return; const f = await api.feed(24); if (!f.sample) swapFeatured(f); }, 30000);

  statsP.then((r) => { const s = renderStats(r); renderRepo(s); if (s?.reference?.size) { $('#refN').textContent = s.reference.size; ui.setRefSize(s.reference.size); } });
  barrelsP.then((r) => { if (r.ok && r.data?.reference?.size) { $('#refN').textContent = r.data.reference.size; ui.setRefSize(r.data.reference.size); } });

  // scroll
  let lenis = null; let p2 = 0; let p3 = 0; let p4 = 0; let flowT = 0; let pageT = 0; let dirty = true;
  if (!REDUCED) {
    lenis = new Lenis({ lerp: 0.1, smoothWheel: true });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add((t) => lenis.raf(t * 1000)); gsap.ticker.lagSmoothing(0);
    const mk = (id, set) => ScrollTrigger.create({ trigger: id, start: 'top top', end: 'bottom top', onUpdate: (s) => { set(s.progress); dirty = true; }, onLeave: () => set(1), onLeaveBack: () => set(0) });
    mk('#m2', (v) => (p2 = v)); mk('#m3', (v) => (p3 = v)); mk('#m4', (v) => (p4 = v));
    ScrollTrigger.create({ trigger: '#match', start: 'top bottom', end: 'top 30%', onUpdate: (s) => { flowT = s.progress; dirty = true; }, onLeave: () => (flowT = 1), onLeaveBack: () => (flowT = 0) });
    ScrollTrigger.create({ trigger: '#measured', start: 'top 70%', once: true, onEnter: () => animateStats() });
    ScrollTrigger.create({ start: 0, end: 'max', onUpdate: (s) => { pageT = s.progress; } });
    $$('a[href^="#"]').forEach((a) => a.addEventListener('click', (e) => { const id = a.getAttribute('href'); if (id.length > 1 && $(id)) { e.preventDefault(); $('#menu').hidden = true; lenis.scrollTo(id, { duration: 1.4 }); } }));
  } else {
    // reduced motion: no scroll-jacking; each beat is a normal section with its key pose, rendered on scroll so it stays aligned
    const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { rmBeat = e.target.dataset.rm; dirty = true; } }, { threshold: 0.45 });
    [['#bench', 'hero'], ['.b2', '2'], ['.b3', '3'], ['.b4', '4'], ['#match', 'flow'], ['#measured', 'flow'], ['#repo', 'flow']].forEach(([s, k]) => { const el = $(s); el.dataset.rm = k; io.observe(el); });
    addEventListener('scroll', () => { dirty = true; pageT = scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight); }, { passive: true });
  }
  let rmBeat = 'hero';
  const trackEl = $('#mechanism'); let banded = null;
  function band() {
    const y = scrollY; const a = trackEl.offsetTop; const b = a + trackEl.offsetHeight - innerHeight;
    const on = y > 24 && (REDUCED || y < a - 1 || y > b + 1);
    if (on !== banded) { banded = on; document.documentElement.classList.toggle('banded', on); }
  }
  addEventListener('scroll', band, { passive: true }); addEventListener('resize', band); band();
  // nav + DICOM second voice per beat
  const navFor = [['#bench', 'bench'], ['#mechanism', 'mechanism'], ['#match', 'match'], ['#measured', 'measured'], ['#repo', 'repo']];
  const navIO = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { const k = navFor.find(([s]) => $(s) === e.target)?.[1]; $$('nav a').forEach((a) => a.classList.toggle('on', a.dataset.nav === k)); } }, { rootMargin: '-45% 0px -50% 0px' });
  navFor.forEach(([s]) => navIO.observe($(s)));
  $('#menuBtn').addEventListener('click', () => { const m = $('#menu'); m.hidden = !m.hidden; $('#menuBtn').setAttribute('aria-expanded', String(!m.hidden)); });
  $('#menu').addEventListener('click', (e) => { if (e.target.tagName === 'A') { $('#menu').hidden = true; if (lenis) { e.preventDefault(); lenis.scrollTo(e.target.getAttribute('href'), { duration: 1.2 }); } } });

  // page-load sequence: radiograph → the slice plane sweeps from the nose back to 0.8 → detent
  const sweep = { clip: REDUCED ? 0.8 : B.L, done: REDUCED };
  const readyP = new Promise((ok) => {
    if (REDUCED) return ok();
    gsap.timeline({ delay: 0.2, onComplete: () => { sweep.done = true; ok(); } })
      .to(sweep, { clip: 0.8 - 0.03, duration: 0.9, ease: 'none', onUpdate: () => (dirty = true) })
      .to(sweep, { clip: 0.8, duration: 0.12, ease: 'back.out(2)' });
    setTimeout(() => typeHex($('#roHex'), heroStriation, { max: 9 }), 700);
  });

  // resize
  let W = innerWidth; let H = innerHeight;
  addEventListener('resize', () => {
    W = innerWidth; H = innerHeight; const m = MOBILE();
    if (m !== mobile) { mobile = m; P = poses(mobile); }
    renderer.setPixelRatio(dpr()); renderer.setSize(W, H, false); placed = false; dirty = true; mech.setFeatured(featured);
  });

  // hero readout placement + leader
  let placed = false;
  const _v = new THREE.Vector3();
  const proj = (x, y, z) => { _v.set(x, y, z).project(bench.camera); return { x: (_v.x * 0.5 + 0.5) * W, y: (-_v.y * 0.5 + 0.5) * H }; };
  function overlays(beat, stop) {
    let svg = '';
    const ro = $('#readout');
    if (beat === 1 && scrollY < H * 1.1) {
      const top = proj(0.8, profile(0.8) + 0.02, -0.12);
      if (!placed && !mobile) { ro.style.left = `${Math.min(W - 400, top.x + 150)}px`; ro.style.top = '128px'; placed = true; }
      const b = ro.getBoundingClientRect();
      if (bench.state.capOn) {
        const ly = mobile ? b.top + b.height / 2 : b.bottom + 8; const lx = mobile ? b.left - 10 : b.left - 10;
        svg += `<path d="M${top.x.toFixed(1)} ${top.y.toFixed(1)} L${top.x.toFixed(1)} ${ly.toFixed(1)} L${lx.toFixed(1)} ${ly.toFixed(1)}" fill="none" stroke="#0889AB" stroke-width="2"/><rect x="${(top.x - 5).toFixed(1)}" y="${(top.y - 5).toFixed(1)}" width="10" height="10" fill="#0889AB"/>`;
      }
    }
    svg += mech.leaders(W, H, beat === 2);
    $('#leaders').innerHTML = svg;
    // BR corner: slice, table position from the ruler (0400 mm at the couch's left end), twist
    const S = bench.state; const mm = 400 + (S.gantry - S.table + 0.75) * 100;
    const n = mech.stops.length; const si = stop ?? Math.max(0, mech.stops.findIndex((x) => x.s === heroStriation));
    const a = `slice <b>${pad(si + 1)}</b>/${pad(n)} · table <b>${beat === 2 || !S.gantryOn || S.gantry < 0 ? 'out of the bore' : `${mm.toFixed(1)} mm`}</b> · twist 5.5°`;
    if (a !== brA) { $('#brA').innerHTML = a; brA = a; }
  }

  // share card: the locked frame at 1080×1080
  async function shareCard(sc) {
    if (!sc.st.locked && sc.st.lockable) { sc.autoIndex(); await new Promise((r) => setTimeout(r, 1000)); }
    render(true);
    const r = sc.rect(); const d = renderer.getPixelRatio();
    const c = document.createElement('canvas'); c.width = 1080; c.height = 1080; const g = c.getContext('2d');
    g.fillStyle = '#E3E5E2'; g.fillRect(0, 0, 1080, 1080);
    const R = 440; const cx = 540; const cy = 500;
    g.save(); g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();
    g.drawImage(renderer.domElement, (r.cx - r.r) * d, (r.cy - r.r) * d, 2 * r.r * d, 2 * r.r * d, cx - R, cy - R, 2 * R, 2 * R);
    const k = R / r.r;
    for (const l of sc.mic.lines(sc.st.phase * Math.PI / 180, r.r)) {
      if (!l.matched) continue; g.strokeStyle = sc.st.locked ? '#0889AB' : '#15181A'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(cx - R + (l.side === 'L' ? 0 : R), cy - R + l.a.y * k); g.lineTo(cx - R + (l.side === 'L' ? R : 2 * R), cy - R + l.b.y * k); g.stroke();
    }
    g.restore();
    g.strokeStyle = '#15181A'; g.lineWidth = 4; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#15181A'; g.fillRect(cx - 2, cy - R, 4, 2 * R);
    const ev = sc.pair.evidence; const locked = sc.st.locked;
    g.save(); g.translate(700, 900); g.transform(1, 0, Math.tan(-5.5 * Math.PI / 180), 1, 0, 0);
    g.font = '700 96px Mohave'; const txt = locked ? 'same barrel.' : 'unknown barrel.'; const tw = g.measureText(txt).width;
    g.fillStyle = '#F2F3F0'; g.fillRect(-12, -84, tw + 24, 104); g.fillStyle = locked ? '#15181A' : '#4A5155'; g.fillText(txt, 0, 0);
    if (locked) { g.fillStyle = '#0889AB'; g.fillRect(-12, 16, tw + 24, 6); }
    g.restore();
    g.font = '500 22px "Atkinson Hyperlegible Mono"'; g.fillStyle = '#4A5155';
    g.fillText(`EXHIBIT ${symOf(ev)} · ${(toolName(ev) || 'unknown').toUpperCase()} ${ev.confidence?.toFixed?.(2) ?? ''} · ${ev.barrelId}${ev.sample || ev.source === 'fixture' ? ' · SAMPLE' : ''}`, 40, 1050);
    g.fillText('STRIATION · $STRIAE', 40, 50);
    const a = document.createElement('a'); a.download = `striation-${ev.masked ? short(ev.mint).replace('…', '-') : (ev.symbol || 'exhibit').replace(/[^\w-]+/g, '') || 'exhibit'}-bench.png`; a.href = c.toDataURL('image/png'); a.click();
  }

  // the frame
  let lastKey = ''; let flowing = false;
  function render(force = false) {
    if (document.hidden) return;
    const S = bench.state; const t = performance.now() / 1000;
    // hero defaults
    S.table = 0; S.gantry = 0.8; S.spin = 0; S.gantryOn = true;
    S.clip = sweep.done ? 0.8 + (REDUCED ? 0 : 0.015 * Math.sin((t * Math.PI * 2) / 4)) : sweep.clip;
    S.capOn = sweep.done; if (heroStriation) S.family = heroStriation.family;
    let res;
    if (REDUCED) {
      const q = { hero: [0, 0, 0], 2: [1, 0, 0], 3: [1, 0.1 + 0.9 * (2 / Math.max(1, mech.stops.length - 1 + 0.6)), 0], 4: [1, 1, 1], flow: [1, 1, 1] }[rmBeat] || [0, 0, 0];
      res = mech.apply(P, ...q);
      if (rmBeat === '2') S.spin = 0.4;
    } else res = mech.apply(P, p2, p3, p4);
    let { pose, dim, grow } = res;
    const beat = p4 > 0.001 ? 4 : p3 > 0.001 ? 3 : p2 > 0.02 ? 2 : 1;
    const rmFlow = REDUCED && rmBeat === 'flow';
    // exit: in the last 16% of beat 4 the microscope field irises shut and the bench dissolves into
    // the film, so beats 5–7 (match, measured, repo) sit on a clean field; only the result's own
    // microscope draws there.
    const x = REDUCED ? 0 : Math.max(0, Math.min(1, (p4 - 0.84) / 0.16)); const exit4 = x * x * (3 - 2 * x);
    if (exit4 > 0) dim = Math.max(dim, 0.72 + 0.28 * exit4);
    if (flowT > 0 || rmFlow) { dim = 1; if (REDUCED) grow = 0; }
    // one-time auto-index: starts as the section cap begins to open (tail of beat 3), lands in the lock as the field fills
    if (!REDUCED && ((beat === 4 && p4 < 0.95) || (beat === 3 && p3 > 0.96)) && !auto4 && scope4.pair && !scope4.st.user) { auto4 = true; scope4.autoIndex({ duration: 0.9 }); }
    if (loading) { const k = (t % 1.2) / 1.2; S.clip = B.L - k * (B.L - 0.1); S.capOn = false; }
    // beat classes
    if (!REDUCED) $$('.beat').forEach((b) => b.classList.toggle('on', Number(b.dataset.beat) === beat));
    const s4 = beat === 4 && scope4.pair ? scope4.rect() : null; const s4on = !!s4 && s4.b.bottom > 0;
    $('#scope4').style.visibility = (REDUCED || (beat === 4 && grow > 0.97)) ? 'visible' : 'hidden';
    if (!REDUCED && beat === 4) scope4.scrollPhase(Math.max(0, Math.min(1, (p4 - 0.25) / 0.75)));
    const d4 = scope4.frame(); const d5 = resultScope ? resultScope.frame() : false;
    const veil5 = resultBox.classList.contains('stale') || resultBox.classList.contains('running');
    const key = `${veil5}|${W}|${H}|${pose.target}|${pose.offset}|${pose.fov}|${pose.shift}|${S.table.toFixed(4)}|${S.gantry.toFixed(4)}|${S.clip.toFixed(4)}|${S.spin.toFixed(4)}|${S.capOn}|${S.family}|${dim.toFixed(3)}|${grow.toFixed(3)}|${exit4.toFixed(3)}|${scrollY}`;
    if (!force && !d4 && !d5 && !dirty && key === lastKey) return;
    lastKey = key; dirty = false;
    const fl = flowT > 0.05 || (REDUCED && rmBeat === 'flow'); if (fl !== flowing) { flowing = fl; document.documentElement.classList.toggle('flowing', fl); }
    applyPose(bench.camera, pose, W, H);
    bench.update();
    renderer.setViewport(0, 0, W, H);
    if (dim >= 0.995) renderer.clear(); // the bench has left: nothing to draw under the flow sections
    else {
      renderer.render(bench.scene, bench.camera);
      if (dim > 0.002) { dimMat.opacity = dim; renderer.autoClear = false; renderer.render(dimScene, dimCam); renderer.autoClear = true; }
    }
    if ((beat === 4 || (REDUCED && rmBeat === '4')) && grow > 0.001 && scope4.pair && (REDUCED || s4on)) {
      const to = scope4.rect(); const from = mech.capCircle(W, H); const e = grow;
      const field = { cx: from.cx + (to.cx - from.cx) * e, cy: from.cy + (to.cy - from.cy) * e, r: from.r + (to.r - from.r) * e };
      scope4.render(W, H, REDUCED ? to : field);
    }
    if (resultScope?.pair && (flowT > 0 || REDUCED)) {
      const r = resultScope.rect();
      if (r.b.bottom > 0 && r.b.top < H) {
        resultScope.render(W, H, r);
        if (veil5) { renderer.autoClear = false; renderer.render(veilScene, dimCam); renderer.autoClear = true; }
      }
    }
    overlays(beat, res.stop);
    $('#scaleTick').style.top = `${(pageT * 558).toFixed(1)}px`;
  }
  gsap.ticker.add(() => render());
  if (REDUCED) addEventListener('scroll', () => requestAnimationFrame(() => render()), { passive: true });
  document.addEventListener('visibilitychange', () => { dirty = true; });

  // after the hero is final: build the microscope (two bullets), then tell QA/renders we're ready
  await readyP;
  await prepScope4(featured).catch(() => {});
  if (REDUCED) render(true);
  window.__ready = true;
}

// Sound: off by default. One dry detent click, one low thunk on lock.
function makeSound() {
  const tr = $('.tr'); const b = document.createElement('button'); b.className = 'menu snd mono'; b.style.display = 'inline-block'; b.style.marginTop = '6px'; b.textContent = 'sound off'; b.setAttribute('aria-pressed', 'false');
  tr.appendChild(b);
  let ctx = null; let on = false;
  b.addEventListener('click', () => { on = !on; b.textContent = on ? 'sound on' : 'sound off'; b.setAttribute('aria-pressed', String(on)); if (on && !ctx) ctx = new AudioContext(); });
  const click = () => {
    if (!on || !ctx) return; const n = ctx.createBufferSource(); const buf = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.03), ctx.sampleRate);
    const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.004)) * (i < ctx.sampleRate * 0.002 ? 1 : 0.6);
    n.buffer = buf; const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2400; f.Q.value = 6; const g = ctx.createGain(); g.gain.value = 0.125;
    n.connect(f).connect(g).connect(ctx.destination); n.start();
  };
  const thunk = () => {
    if (!on || !ctx) return; const o = ctx.createOscillator(); o.frequency.value = 80; const g = ctx.createGain(); const t = ctx.currentTime;
    g.gain.setValueAtTime(0.2, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.04); o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.05);
  };
  return { click, thunk };
}
