// Beats 2–4: the bullet (one groove per striation), the slices (one CT stop per family, real bytes),
// the comparison microscope. Scroll progress in, bench state + camera pose out.
import * as THREE from 'three';
import { B, profile } from '../scene/bullet.js';
import { lerpPose } from '../scene/bench.js';
import { $, esc, short, pad, famName, FAMILY, typeHex, decodeLine, MOBILE, REDUCED } from '../util.js';

export const SCAN_ORDER = ['version', 'cu.limit', 'cu.price', 'tip.relay', 'tip.lamports', 'alt', 'ix.seq', 'xfer.dest', 'buy.variant', 'mint.suffix', 'signers'];
const WHY = {
  version: 'legacy, v0 or v1. v1 went live on 09-15, so a tool that already writes v1 was updated this month. a reader that only knows v0 breaks on it.',
  'cu.limit': 'the compute budget the tool asks for. most set it once in a config file and never touch it again.',
  'cu.price': 'the priority fee per compute unit, in micro-lamports. deployers rotate wallets. this number stays.',
  'tip.relay': 'which landing service gets the tip, looked up in the published tip-account table. a tool picks a relay once.',
  'tip.lamports': 'how much it tips. exact, plus a log2 bucket, so near amounts still half-match.',
  alt: 'the address lookup table the tx loads. tools build their own and reuse it on every shot. weight 4, the heaviest mark.',
  'ix.seq': 'the order of the instructions, by name. the order is code, and code doesn\'t rotate.',
  'xfer.dest': 'where the other transfers go. a fee wallet repeats across every create one tool fires.',
  'buy.variant': 'whether the dev buy rides in the same tx, and which buy instruction it uses.',
  'mint.suffix': 'a mint ground to end in …pump costs work. some tools grind, some don\'t.',
  signers: 'how many keys sign: the mint keypair and the payer, or more.',
};

const smooth = (t) => t * t * (3 - 2 * t);
const scanE = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2); // ≈ cubic-bezier(.65,0,.35,1)
const clamp01 = (x) => Math.max(0, Math.min(1, x));

export function poses(mobile) {
  return mobile ? {
    hero: { target: [1.68, 0.05, 0], offset: [-8.0, 4.7, 17.4], fov: 26, shift: [6, 196] },
    side: (tb) => ({ target: [tb + 1.85, 0.0, 0], offset: [0, 0.5, 27], fov: 18, shift: [0, -40] }),
    slice: { target: [0.8, 0, 0], offset: [-5.6, 2.8, 11.2], fov: 26, shift: [0, 150] },
    park: { target: [1.68, 0.05, 0], offset: [-9.6, 5.6, 21], fov: 26, shift: [0, 60] },
  } : {
    hero: { target: [1.5, 0.05, 0], offset: [-5.4, 2.9, 10.6], fov: 23, shift: [-300, 84] },
    side: (tb) => ({ target: [tb + 1.85, 0.0, 0], offset: [0, 0.45, 12.5], fov: 18, shift: [-250, 10] }),
    slice: { target: [0.8, 0, 0], offset: [-3.2, 1.6, 6.4], fov: 23, shift: [-230, 40] },
    park: { target: [1.5, 0.05, 0], offset: [-7.6, 4.1, 14.8], fov: 23, shift: [-330, 30] },
  };
}

export function createMechanism({ bench }) {
  let stops = []; let labels = []; let lastStop = -1; let featured = null;
  const labelsEl = $('#labels'); const topoLines = $('#topoLines');

  function setFeatured(r) {
    featured = r;
    const st = r.striations || [];
    // one stop per family in scan order: its exact token (prefer the one with bytes)
    stops = [];
    for (const f of SCAN_ORDER) {
      const c = st.filter((s) => s.family === f); if (!c.length) continue;
      const pick = c.find((s) => s.source?.hex && !/[~]/.test(s.id)) || c.find((s) => !/[~]/.test(s.id)) || c[0];
      stops.push(pick);
    }
    const n = stops.length;
    stops = stops.map((s, i) => ({ s, x: 0.55 + (n > 1 ? (1.15 * i) / (n - 1) : 0) }));
    // six heaviest striations, one per family, for the beat-2 leaders
    const seen = new Set(); labels = [];
    for (const s of [...st].sort((a, b) => b.weight - a.weight)) { if (seen.has(s.family) || /~/.test(s.id)) continue; seen.add(s.family); labels.push(s); if (labels.length === 6) break; }
    labelsEl.innerHTML = labels.map((s, i) => `<span class="lbl" data-i="${i}"><small>${esc(s.family)}</small>${esc(labelText(s))}</span>`).join('');
    lastStop = -1;
    drawTopogram();
    if (REDUCED) staticStops();
  }
  const labelText = (s) => {
    const v = s.value ?? '';
    if (s.family === 'alt' || s.family === 'xfer.dest') return short(v);
    if (s.family === 'ix.seq') { const parts = String(v).split('>').map((p) => p.replace(/^pump\./, '')); return parts.length > 4 ? `${parts.slice(0, 3).join(' › ')} …` : parts.join(' › '); }
    if (s.family === 'cu.price' || s.family === 'cu.limit') return Number(v).toLocaleString('en-US');
    return String(v).length > 22 ? short(String(v), 6) : String(v);
  };

  // Scout radiograph of the whole bullet, computed from the profile (path length through jacket and core).
  function drawTopogram() {
    const cv = $('#topoCv'); const w = cv.clientWidth || 800; const h = cv.clientHeight || 72; const d = Math.min(devicePixelRatio, 2);
    cv.width = Math.round(w * d); cv.height = Math.round(h * d);
    const g = cv.getContext('2d'); const img = g.createImageData(cv.width, cv.height);
    const x0 = -0.1; const x1 = B.L + 0.1; const yr = 0.62;
    for (let i = 0; i < cv.width; i++) {
      const x = x0 + ((x1 - x0) * i) / cv.width; const r = profile(x); const rc = Math.max(0, r - B.jacket) * (x > 0.07 && x < 3.05 ? 1 : 0);
      for (let j = 0; j < cv.height; j++) {
        const y = (j / cv.height - 0.5) * 2 * yr;
        const to = y * y < r * r ? 2 * Math.sqrt(r * r - y * y) : 0; const tc = y * y < rc * rc ? 2 * Math.sqrt(rc * rc - y * y) : 0;
        const a = 1 - Math.exp(-(1.3 * (to - tc) + 2.6 * tc));
        const o = (j * cv.width + i) * 4; img.data[o] = 21; img.data[o + 1] = 24; img.data[o + 2] = 26; img.data[o + 3] = Math.round(a * 235);
      }
    }
    g.putImageData(img, 0, 0);
    topoLines.innerHTML = stops.map((st, i) => `<i style="left:${(((st.x - x0) / (x1 - x0)) * 100).toFixed(2)}%"><span>${pad(i + 1)}</span></i>`).join('');
  }

  function showStop(i) {
    if (i === lastStop || !stops[i]) return; lastStop = i;
    const { s } = stops[i]; const n = stops.length;
    $('#s3Head').innerHTML = `slice <b>${pad(i + 1)}</b> / ${pad(n)} · ix <b>${s.source?.ixIndex ?? '—'}</b> · ${esc(FAMILY[s.family]?.ix || s.source?.where || '')}`;
    $('#s3Name').textContent = famName(s.family);
    typeHex($('#s3Hex'), s, { max: MOBILE() ? 9 : 12 });
    $('#s3Eq').textContent = decodeLine(s);
    $('#s3Why').textContent = WHY[s.family] || '';
    topoLines.querySelectorAll('i').forEach((el, k) => { el.classList.toggle('on', k === i); el.classList.toggle('adj', Math.abs(k - i) === 1); });
    bench.state.family = s.family;
    return true;
  }

  function staticStops() {
    const el = $('.b3 .stop');
    el.innerHTML = stops.map(({ s }, i) => `<div style="margin:0 0 22px"><div class="mono">slice <b>${pad(i + 1)}</b> / ${pad(stops.length)} · ${esc(FAMILY[s.family]?.ix || '')}</div><div class="stopname" style="font-size:28px">${esc(famName(s.family))}</div><div class="hex">${''}</div><div class="eq mono-lc">${esc(decodeLine(s))}</div></div>`).join('');
    el.querySelectorAll('.hex').forEach((h, i) => typeHex(h, stops[i].s));
  }

  // p2, p3, p4 ∈ [0,1]; returns { pose, dim, grow, stop }
  function apply(P, p2, p3, p4) {
    const S = bench.state; let pose = P.hero; let dim = 0; let grow = 0; let stop = null;
    if (p2 <= 0) return { pose, dim, grow, stop };
    // beat 2: table slides out, gantry exits left, one full turn, camera to side elevation
    const a = scanE(clamp01(p2));
    S.table = 1.6 * a; const ga = scanE(clamp01(p2 / 0.45)); S.gantry = 0.8 - 7 * ga; S.clip = Math.max(-1, S.gantry); S.spin = Math.PI * 2 * clamp01(p2); S.capOn = false; S.gantryOn = S.gantry > -6;
    pose = lerpPose(P.hero, P.side(S.table), smooth(clamp01(p2 * 1.15)));
    if (p3 <= 0) return { pose, dim, grow, stop };
    // beat 3: gantry returns, table steps the bullet through the fixed slice plane
    const n = Math.max(1, stops.length);
    const enter = clamp01(p3 / 0.1); const e = scanE(enter);
    const first = stops[0]?.x ?? 0.8;
    S.spin = 0; S.gantryOn = true;
    if (enter < 1) {
      S.gantry = -3.4 + (0.8 + 3.4) * e; S.table = 1.6 + (0.8 - first - 1.6) * e; S.clip = S.gantry; S.capOn = false;
      pose = lerpPose(P.side(1.6), P.slice, e);
    } else {
      const q = clamp01((p3 - 0.1) / 0.9) * (n - 1 + 0.6); // last stop holds a little longer
      const i = Math.min(n - 1, Math.floor(q)); const f = q - i;
      const hold = 0.7; const tr = f <= hold || i >= n - 1 ? 0 : scanE((f - hold) / (1 - hold));
      const x = stops[i] ? stops[i].x + ((stops[Math.min(n - 1, i + 1)]?.x ?? stops[i].x) - stops[i].x) * tr : 0.8;
      S.gantry = 0.8; S.clip = 0.8; S.table = 0.8 - x; S.capOn = tr === 0;
      stop = i; showStop(i);
      pose = P.slice;
    }
    if (p4 <= 0) return { pose, dim, grow, stop };
    // beat 4: the section cap opens into the microscope field
    grow = smooth(clamp01(p4 / 0.25)); dim = 0.72 * grow;
    return { pose, dim, grow, stop };
  }

  // DOM leaders from label to groove for beat 2 (fixed SVG overlay)
  const _p = new THREE.Vector3();
  function project(v, W, H) { _p.copy(v).project(bench.camera); return { x: (_p.x * 0.5 + 0.5) * W, y: (-_p.y * 0.5 + 0.5) * H }; }
  function leaders(W, H, on) {
    if (!on || !labels.length) return '';
    const S = bench.state; let svg = '';
    const top = project(new THREE.Vector3(S.table + 1.2, 0.95, 0), W, H).y; const bot = project(new THREE.Vector3(S.table + 1.2, -0.95, 0), W, H).y;
    const toks = bench.tokens;
    const mob = MOBILE();
    labels.forEach((s, i) => {
      const t = toks.find((k) => k.id === s.id); if (!t) return;
      const gx = 0.62 + i * 0.22; const p = project(bench.groovePoint(t, gx), W, H); const f = bench.facing(t, gx) > 0.05;
      const el = labelsEl.children[i]; if (!el) return;
      const up = !mob && i % 2 === 0; const w = el.offsetWidth; const lvl = mob ? i : i >> 1; // each label on its own level: no collisions
      const lx = Math.max(mob ? 8 : 600, Math.min(W - 50 - w, p.x - 24));
      const ly = up ? top - 40 - lvl * 34 : bot + 18 + lvl * (mob ? 30 : 34);
      el.style.transform = `translate(${lx.toFixed(1)}px, ${ly.toFixed(1)}px)`; el.classList.toggle('back', !f);
      const ay = up ? ly + el.offsetHeight : ly;
      svg += `<path d="M${(lx + 24).toFixed(1)} ${ay.toFixed(1)} L${p.x.toFixed(1)} ${p.y.toFixed(1)}" fill="none" stroke="${f ? '#15181A' : '#A3AAAC'}" stroke-width="1.5" ${f ? '' : 'stroke-dasharray="3 3"'}/>` +
        `<rect x="${(p.x - 3).toFixed(1)}" y="${(p.y - 3).toFixed(1)}" width="6" height="6" fill="${f ? '#0889AB' : '#A3AAAC'}"/>`;
    });
    return svg;
  }

  function capCircle(W, H) {
    const c = project(new THREE.Vector3(0.8, 0, 0), W, H); const e = project(new THREE.Vector3(0.8, profile(0.8 - bench.state.table), 0), W, H);
    return { cx: c.x, cy: c.y, r: Math.max(8, Math.hypot(e.x - c.x, e.y - c.y)) };
  }

  return { setFeatured, apply, leaders, capCircle, get stops() { return stops; }, showStop, get featured() { return featured; } };
}
