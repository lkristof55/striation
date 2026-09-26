// Comparison microscope: two engraved bullets rendered side-on under a raking light into one circular
// field, evidence in the left half, reference in the right. Same token → same angle on both bullets
// (tokenAngle), so registration is real. The circle is a stencil; the halves are scissor viewports.
//
//   const mic = createMicroscope(renderer, { env, mobile });
//   mic.setPair(evidenceTokens, referenceTokens, { evSeed, refSeed });
//   mic.render({ cx, cy, r }, phaseRad, { W, H, grow: 0..1 })   // CSS px, after the main scene render
//   mic.lines(phaseRad) → per-token screen lines for the DOM overlay
// Imports 'three' only.
import * as THREE from 'three';
import { buildBullet, striaeTexture, profile, twistAt } from './bullet.js';
import { tokenAngle } from './bench.js';

export const X0 = 1.1; // the seam sits at this axial position on both bullets

export function createMicroscope(renderer, { env = null, mobile = false } = {}) {
  const STENCIL = { stencilWrite: true, stencilRef: 1, stencilFunc: THREE.EqualStencilFunc, stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp };
  const mkScene = () => {
    const s = new THREE.Scene();
    if (env) { s.environment = env; s.environmentIntensity = 0.22; s.environmentRotation.set(0, 1.9, 0); } // dim env: grooves, not softbox reflections
    const key = new THREE.DirectionalLight('#ffffff', 3.6); key.position.set(X0 - 0.6, 4.0, 1.1); key.target.position.set(X0, 0, 0); // ~15° raking
    const fill = new THREE.DirectionalLight('#ffffff', 0.35); fill.position.set(X0, -2, 3);
    s.add(key, key.target, fill);
    return s;
  };
  const sA = mkScene(); const sB = mkScene();
  const mat = () => new THREE.MeshPhysicalMaterial({ color: '#AEB5B6', metalness: 0.6, roughness: 0.46, clearcoat: 0.1, clearcoatRoughness: 0.5, bumpScale: 2.2, ...STENCIL });
  const mA = mat(); const mB = mat();
  let bA = null; let bB = null; let tA = []; let tB = [];
  let rotA = 0;

  // The field: a stencil disc, filled with the lightbox of a microscope stage.
  const ortho = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
  const fieldScene = new THREE.Scene();
  const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 128), new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false, side: THREE.DoubleSide, stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
    uniforms: {}, vertexShader: 'varying vec2 vUv; void main(){ vUv = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'varying vec2 vUv; void main(){ float r = length(vUv); vec3 c = mix(vec3(0.925,0.93,0.918), vec3(0.80,0.815,0.81), smoothstep(0.35,1.0,r)); gl_FragColor = vec4(c,1.0);\n#include <colorspace_fragment>\n}',
  }));
  fieldScene.add(disc);

  // The bullet (r0 0.5, seen from 2.35) subtends ±12.3° vertically; a 23° field keeps its silhouette
  // just outside the disc, so the barrel fills the circle edge to edge (no film-coloured caps).
  const cam = new THREE.PerspectiveCamera(23, 1, 0.1, 50);
  cam.position.set(X0, 0, 2.35); cam.lookAt(X0, 0, 0);

  function bullet(tokens, m, seed) {
    const geo = buildBullet(tokens, { radial: mobile ? 540 : 900, dense: mobile ? 0.8 : 1, micro: seed });
    m.bumpMap?.dispose(); m.bumpMap = striaeTexture(tokens, { micro: seed, width: mobile ? 2048 : 4096 });
    // the same engraving as a color map, contrast-curved: groove floors go dark like engraved lines
    m.map?.dispose(); m.map = grooveInk(tokens, mobile ? 2048 : 4096); m.needsUpdate = true;
    return new THREE.Mesh(geo, m);
  }

  function setPair(ev, ref, { evSeed = 3, refSeed = 11 } = {}) {
    tA = ev.map((t) => ({ ...t, angle: t.angle ?? tokenAngle(t.id) }));
    tB = ref.map((t) => ({ ...t, angle: t.angle ?? tokenAngle(t.id) }));
    if (bA) { sA.remove(bA); bA.geometry.dispose(); }
    if (bB) { sB.remove(bB); bB.geometry.dispose(); }
    bA = bullet(tA, mA, evSeed); bB = bullet(tB, mB, refSeed);
    sA.add(bA); sB.add(bB);
    // Evidence rotation: face as many shared grooves to the camera as possible.
    const refIds = new Set(tB.map((t) => t.id)); const shared = tA.filter((t) => refIds.has(t.id));
    const tw = twistAt(X0); let best = 0; let bestN = -1;
    for (let i = 0; i < 360; i++) {
      const R = (i / 360) * Math.PI * 2; let n = 0;
      for (const t of shared) { const a = wrap(t.angle + tw + R - Math.PI / 2); if (Math.abs(a) < 1.0) n += t.weight; }
      if (n > bestN) { bestN = n; best = R; }
    }
    rotA = best;
    bA.rotation.x = rotA;
  }

  function render(field, phase, { W, H, grow = 1 } = {}) {
    if (!bA) return;
    const { cx, cy, r } = field;
    const ac = renderer.autoClear; renderer.autoClear = false;
    renderer.clearStencil();
    // stencil disc (fills the field)
    ortho.left = 0; ortho.right = W; ortho.top = 0; ortho.bottom = H; ortho.updateProjectionMatrix();
    disc.position.set(cx, cy, 0); disc.scale.set(r, -r, 1);
    renderer.setViewport(0, 0, W, H); renderer.setScissorTest(false);
    renderer.render(fieldScene, ortho);
    // halves
    bB.rotation.x = rotA + phase;
    const x = cx - r; const y = H - (cy + r); const s = 2 * r;
    renderer.setScissorTest(true);
    renderer.setViewport(x, y, s, s);
    renderer.setScissor(x, y, r, s); renderer.clearDepth(); renderer.render(sA, cam);
    renderer.setScissor(x + r, y, r, s); renderer.clearDepth(); renderer.render(sB, cam);
    renderer.setScissorTest(false); renderer.setViewport(0, 0, W, H);
    renderer.autoClear = ac;
  }

  // Screen-space lines for every token on each half, in field-local px (0..2r), for the SVG overlay.
  const _p = new THREE.Vector3();
  function lines(phase, r) {
    const out = [];
    const refIds = new Set(tB.map((t) => t.id)); const evIds = new Set(tA.map((t) => t.id));
    const proj = (x, th) => {
      const rr = profile(x); _p.set(x, rr * Math.cos(th), rr * Math.sin(th)).project(cam);
      return { x: (_p.x * 0.5 + 0.5) * 2 * r, y: (-_p.y * 0.5 + 0.5) * 2 * r, z: Math.sin(th) };
    };
    const run = (toks, rot, side, other) => {
      for (const t of toks) {
        const xs = side === 'L' ? [X0 - 0.62, X0] : [X0, X0 + 0.62];
        const pts = xs.map((x) => proj(x, t.angle + twistAt(x) + rot));
        if (pts.some((p) => p.z < 0.28)) continue; // groove on the far side of the bullet
        out.push({ id: t.id, side, matched: other.has(t.id), weight: t.weight, a: pts[0], b: pts[1] });
      }
    };
    run(tA, rotA, 'L', refIds); run(tB, rotA + phase, 'R', evIds);
    return out;
  }

  const sharedCount = () => { const ids = new Set(tB.map((t) => t.id)); return { shared: tA.filter((t) => ids.has(t.id)).length, total: tA.length }; };

  return {
    setPair, render, lines, sharedCount, camera: cam,
    dispose() { for (const b of [bA, bB]) b?.geometry.dispose(); mA.dispose(); mB.dispose(); mA.bumpMap?.dispose(); mB.bumpMap?.dispose(); mA.map?.dispose(); mB.map?.dispose(); disc.geometry.dispose(); disc.material.dispose(); },
  };
}
// Ink map in the same u-space as the bump texture (u·2π = angle minus twist): only the striation
// grooves darken, heavier = darker; the rifling lands and micro-scratches stay metal.
function grooveInk(tokens, width) {
  const c = document.createElement('canvas'); c.width = width; c.height = 4;
  const g = c.getContext('2d'); const img = g.createImageData(width, 4); const d = img.data;
  const gr = tokens.map((t) => ({ a: t.angle, hw: 0.007 + 0.0028 * t.weight, k: Math.min(0.88, 0.3 * t.weight + 0.12) }));
  for (let i = 0; i < width; i++) {
    const phi = (i / width) * Math.PI * 2; let ink = 0;
    for (const s of gr) { const da = Math.abs(wrap(phi - s.a)); if (da < s.hw * 1.15) ink = Math.max(ink, s.k * Math.cos(Math.min(1, da / (s.hw * 1.15)) * Math.PI * 0.5) ** 1.5); }
    const v = Math.round(255 * (1 - ink));
    for (let r = 0; r < 4; r++) { const o = (r * width + i) * 4; d[o] = d[o + 1] = d[o + 2] = v; d[o + 3] = 255; }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
const wrap = (a) => { a %= Math.PI * 2; if (a > Math.PI) a -= Math.PI * 2; if (a < -Math.PI) a += Math.PI * 2; return a; };
