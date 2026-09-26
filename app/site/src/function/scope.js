// "Index the barrel": the comparison microscope you operate. One controller per field on the page.
import { gsap } from 'gsap';
import { createMicroscope } from '../scene/microscope.js';
import { toTokens, seedOf } from '../scene/bench.js';
import { esc, short, n2, REDUCED, toolName } from '../util.js';

const DEG = Math.PI / 180;

export function createScope(el, { renderer, env, mobile, onShare, sound }) {
  el.innerHTML = `
    <div class="field-ring" tabindex="0" role="slider" aria-label="reference bullet phase" aria-valuemin="-180" aria-valuemax="180" aria-valuenow="0"></div>
    <div class="seam"></div>
    <svg aria-hidden="true"></svg>
    <span class="side l">evidence</span><span class="side r">reference</span>
    <div class="stampd" aria-hidden="true">same barrel.</div>
    <div class="ctl">
      <div class="wheel" role="presentation" data-lenis-prevent></div>
      <span><button type="button" class="btn ghost" data-a="auto">auto-index</button>${onShare ? ' <button type="button" class="btn ghost" data-a="share">post the bench</button>' : ''}</span>
    </div>
    <div class="ro mono" aria-live="polite"></div>
    <div class="note mono-lc"></div>`;
  el.querySelector('.field-ring').title = 'drag, or click then scroll, to turn the reference';
  const ring = el.querySelector('.field-ring'); const svg = el.querySelector('svg'); const ro = el.querySelector('.ro');
  const stampEl = el.querySelector('.stampd'); const note = el.querySelector('.note'); const wheel = el.querySelector('.wheel');
  let mic = null; let pair = null;
  const st = { phase: 30, vel: 0, drag: false, user: false, locked: false, lockable: true, start: 30, dirty: true, lastKey: '' };

  function ensureMic() { if (!mic) mic = createMicroscope(renderer, { env, mobile }); return mic; }

  // evidence: a MatchResult; reference: striations of the neighbour (or null → matched-only).
  function setPair(evidence, refStriations, { refLabel = 'reference', refMint = '' } = {}) {
    const ev = toTokens(evidence.striations);
    const refOnlyMatched = !refStriations;
    const ref = refStriations ? toTokens(refStriations) : ev.filter((t) => t.matched);
    pair = { evidence, ev, ref, refOnlyMatched, refMint };
    ensureMic().setPair(ev, ref, { evSeed: seedOf(evidence.mint), refSeed: seedOf(refMint || evidence.mint + 'ref') });
    const { shared, total } = mic.sharedCount();
    st.lockable = evidence.verdict !== 'unknown' && shared >= 3;
    const s = seedOf(evidence.mint); st.start = (20 + (s % 3000) / 100) * (s % 2 ? 1 : -1); // 20°–50°, seeded from the mint
    st.phase = st.start; st.user = false; st.locked = false; st.vel = 0; st.dirty = true;
    el.querySelector('.side.r').textContent = refLabel;
    note.innerHTML = refOnlyMatched ? 'reference drawn from the shared striations only (the neighbour\'s own tx was not loaded).' : '';
    if (evidence.stampAgrees === false && evidence.stamp) note.innerHTML += `${note.innerHTML ? '<br>' : ''}stamp says ${esc(evidence.stamp.label)}. striations say ${esc(toolName(evidence) || 'unknown')}.`;
    stampEl.className = 'stampd'; stampEl.textContent = st.lockable ? 'same barrel.' : 'unknown barrel.';
    pair.shared = shared; pair.total = total; // total = evidence striations; shared = present on both bullets
    if (REDUCED) setPhase(st.lockable ? 0 : st.start, true);
  }

  function setPhase(deg, fromUser = false) {
    if (fromUser) st.user = true;
    st.phase = Math.max(-180, Math.min(180, deg)); st.dirty = true;
  }
  // scroll brings the phase toward register but stops at 6°; the lock is always an action.
  function scrollPhase(t) { if (st.user || st.drag) return; const target = 6 * Math.sign(st.start || 1); setPhase(st.start + (target - st.start) * t); }

  function detent() {
    if (!st.lockable || Math.abs(st.phase) > 4 || Math.abs(st.phase) < 0.01) return;
    gsap.to(st, { phase: 0, duration: REDUCED ? 0 : 0.24, ease: 'back.out(2)', onUpdate: () => (st.dirty = true) });
    sound?.click();
  }
  function autoIndex({ duration = 0.9 } = {}) {
    st.user = true; st.vel = 0; gsap.killTweensOf(st);
    const target = st.lockable ? 0 : bestPhase();
    gsap.to(st, { phase: target, duration: REDUCED ? 0 : duration, ease: 'power3.inOut', onUpdate: () => (st.dirty = true) });
  }
  // for an unknown verdict: the phase with the most shared grooves close together (never locks)
  function bestPhase() { return 0.0001 + (st.start > 0 ? 2.5 : -2.5); }

  // input: drag (desktop), wheel, keys, thumbwheel (mobile)
  let lastY = 0; let lastX = 0;
  ring.addEventListener('pointerdown', (e) => { if (mobile && e.pointerType === 'touch') return; st.drag = true; st.user = true; lastY = e.clientY; ring.focus({ preventScroll: true }); ring.setPointerCapture(e.pointerId); gsap.killTweensOf(st); });
  ring.addEventListener('pointermove', (e) => { if (!st.drag) return; const dy = e.clientY - lastY; lastY = e.clientY; st.vel = dy * 0.25; setPhase(st.phase + dy * 0.25, true); });
  const up = () => { if (!st.drag) return; st.drag = false; };
  ring.addEventListener('pointerup', up); ring.addEventListener('pointercancel', up);
  ring.addEventListener('wheel', (e) => { if (document.activeElement !== ring) return; e.preventDefault(); e.stopPropagation(); gsap.killTweensOf(st); setPhase(st.phase + Math.sign(e.deltaY) * 1.5, true); st.vel = 0; clearTimeout(st.wt); st.wt = setTimeout(detent, 160); }, { passive: false });
  ring.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 5 : 0.5;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { setPhase(st.phase - step, true); e.preventDefault(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { setPhase(st.phase + step, true); e.preventDefault(); }
    else if (e.key === 'Enter' || e.key === ' ') { autoIndex(); e.preventDefault(); }
    else return;
    clearTimeout(st.wt); st.wt = setTimeout(detent, 200);
  });
  wheel.addEventListener('pointerdown', (e) => { st.drag = true; st.user = true; lastX = e.clientX; wheel.setPointerCapture(e.pointerId); gsap.killTweensOf(st); });
  wheel.addEventListener('pointermove', (e) => { if (!st.drag) return; const dx = e.clientX - lastX; lastX = e.clientX; st.vel = dx * 0.35; setPhase(st.phase + dx * 0.35, true); wheel.style.backgroundPositionX = `${(parseFloat(wheel.style.backgroundPositionX) || 0) + dx}px`; });
  wheel.addEventListener('pointerup', up); wheel.addEventListener('pointercancel', up);
  el.querySelector('[data-a="auto"]').addEventListener('click', autoIndex);
  el.querySelector('[data-a="share"]')?.addEventListener('click', () => onShare?.(api));

  // per frame: glide after release (velocity × 0.9 per frame), detent, lock state, overlay
  function frame() {
    if (!pair) return false;
    if (!st.drag && Math.abs(st.vel) > 0.02) { st.vel *= 0.9; setPhase(st.phase + st.vel); if (Math.abs(st.vel) <= 0.02) detent(); }
    else if (!st.drag && st.user && !gsap.isTweening(st) && Math.abs(st.phase) <= 4 && Math.abs(st.phase) > 0.01 && Math.abs(st.vel) <= 0.02) detent();
    if (!st.dirty) return false;
    st.dirty = false;
    const near = Math.abs(st.phase) <= 4; const locked = st.lockable && Math.abs(st.phase) < 0.05;
    el.classList.toggle('near', near && st.lockable);
    if (locked !== st.locked) {
      st.locked = locked;
      if (locked) {
        stampEl.className = 'stampd on'; el.classList.add('flash'); requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('flash')));
        if (navigator.vibrate && mobile) try { navigator.vibrate(12); } catch { /* not allowed */ }
        sound?.thunk();
      } else stampEl.className = 'stampd';
    }
    if (!st.lockable && st.user && Math.abs(st.phase) < 6) stampEl.className = 'stampd unknown on';
    ring.setAttribute('aria-valuenow', st.phase.toFixed(1));
    const inReg = inRegister();
    ring.setAttribute('aria-valuetext', `phase ${Math.abs(st.phase).toFixed(1)} degrees, ${inReg} of ${pair.total} striae in register`);
    const e = pair.evidence;
    ro.innerHTML = !st.lockable && st.user && Math.abs(st.phase) < 6
      ? 'no consistent phase. <b>unknown barrel.</b>'
      : `phase <b>${Math.abs(st.phase).toFixed(1)}°</b> · <b>${inReg}/${pair.total}</b> striae in register${locked ? ` · <b>${n2(e.neighbours?.[0]?.similarity)}</b> · barrel <b>${esc(e.barrelId)}</b>` : ''}`;
    drawLines(locked, near);
    return true;
  }
  // a shared groove is in register when the phase is inside its own half-width (0.007 + 0.0028·w rad, as engraved)
  function inRegister() {
    const ids = new Set(pair.ref.map((t) => t.id)); const p = Math.abs(st.phase) * DEG;
    return pair.ev.filter((t) => ids.has(t.id) && p < 0.007 + 0.0028 * t.weight).length;
  }

  function drawLines(locked, near) {
    const r = el.clientWidth / 2; if (!mic || !r) return;
    const L = mic.lines(st.phase * DEG, r);
    const sw = near ? 2.75 : 2;
    let h = `<defs><clipPath id="cl-${el.id}"><rect x="0" y="0" width="${r}" height="${2 * r}"/></clipPath><clipPath id="cr-${el.id}"><rect x="${r}" y="0" width="${r}" height="${2 * r}"/></clipPath><clipPath id="cc-${el.id}"><circle cx="${r}" cy="${r}" r="${r - 2}"/></clipPath></defs><g clip-path="url(#cc-${el.id})">`;
    for (const l of L) {
      const col = l.matched ? (locked ? '#0889AB' : '#15181A') : '#A3AAAC';
      const ext = l.side === 'L' ? { x1: 0, x2: r } : { x1: r, x2: 2 * r };
      const k = (l.b.y - l.a.y) / (l.b.x - l.a.x || 1);
      const y1 = l.a.y + k * (ext.x1 - l.a.x); const y2 = l.a.y + k * (ext.x2 - l.a.x);
      h += `<line x1="${ext.x1}" y1="${y1.toFixed(1)}" x2="${ext.x2}" y2="${y2.toFixed(1)}" stroke="${col}" stroke-width="${l.matched ? sw : 1.2}" clip-path="url(#c${l.side === 'L' ? 'l' : 'r'}-${el.id})" opacity="${l.matched ? 1 : 0.75}"/>`;
    }
    h += '</g>';
    svg.innerHTML = h;
  }

  const api = {
    el, st, setPair, scrollPhase, frame, autoIndex,
    get pair() { return pair; },
    get mic() { return mic; },
    rect() { const b = el.getBoundingClientRect(); return { cx: b.left + b.width / 2, cy: b.top + b.height / 2, r: b.width / 2 - 2, b }; },
    render(W, H, field) { if (mic && pair) mic.render(field || api.rect(), st.phase * DEG, { W, H }); },
    reset() { st.user = false; },
    dispose() { mic?.dispose(); },
  };
  return api;
}
