// The CT bench: gantry ring, couch with a table-position ruler, the engraved bullet (solid on the
// reconstructed side of the slice plane, radiograph before it), the CT section cap, the scan-cyan laser.
//
//   const bench = createBench(renderer, { tokens, env, mobile, micro });
//   bench.state.table / gantry / clip / spin / capOn / family   (mutate, then update())
//   bench.update(t) ; renderer.render(bench.scene, bench.camera)
//
// Imports 'three' only; no page DOM. brand-kit renders the same module.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { B, buildBullet, striaeTexture, sectionMesh, xrayMaterial, profile, twistAt } from './bullet.js';

export const PAL = { film: '#E3E5E2', lightbox: '#F2F3F0', graphite: '#15181A', lead: '#4A5155', bone: '#A3AAAC', scan: '#0889AB', scanInk: '#056A85' };
export const G = { ri: 0.86, ro: 1.2, depth: 0.3 };

// FNV-1a → [0, 2π). The same token lands at the same angle on every bullet.
export function tokenAngle(id) {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h / 4294967296) * Math.PI * 2;
}
export function seedOf(s = '') { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return (h % 100000) + 1; }
export const toTokens = (striations = []) => striations.map((s) => ({ id: s.id, family: s.family, weight: s.weight, matched: s.matched, angle: tokenAngle(s.id) }));

export function createBench(renderer, { tokens = [], env = null, mobile = false, micro = 7, rulerFont = '"Atkinson Hyperlegible Mono", monospace' } = {}) {
  const scene = new THREE.Scene();
  if (env) { scene.environment = env; scene.environmentIntensity = 0.85; scene.environmentRotation.set(0, 1.9, 0); }
  const disposables = [];
  const track = (o) => { disposables.push(o); return o; };

  const key = new THREE.DirectionalLight('#ffffff', 2.4);
  key.position.set(-2.2, 3.2, 3.4); key.target.position.set(1.2, 0, 0);
  key.castShadow = true; key.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048); key.shadow.radius = 6; key.shadow.bias = -0.0004;
  Object.assign(key.shadow.camera, { left: -4, right: 4, top: 3, bottom: -3, near: 0.5, far: 12 });
  scene.add(key, key.target);
  const rim = new THREE.DirectionalLight('#ffffff', 0.9); rim.position.set(3, 1.5, -3); scene.add(rim);

  // World-space reconstruction plane: solid for x >= clip, radiograph for x < clip.
  const clipSolid = new THREE.Plane(new THREE.Vector3(1, 0, 0), -0.8);
  const clipGhost = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0.8);

  // table = couch + bullet (travels along +x); bullet spins about its own axis inside it.
  const table = new THREE.Group(); scene.add(table);
  const spinner = new THREE.Group(); table.add(spinner);

  const solidMat = track(new THREE.MeshPhysicalMaterial({
    color: '#AEB5B6', metalness: 0.7, roughness: 0.24, clearcoat: 0.3, clearcoatRoughness: 0.35,
    bumpScale: 1.2, clippingPlanes: [clipSolid], clipShadows: true,
  }));
  const ghostMat = track(xrayMaterial({ ink: PAL.graphite, density: 0.36, clip: [clipGhost], power: 2.4 }));
  const coreMat = track(xrayMaterial({ ink: PAL.graphite, density: 0.62, clip: [clipGhost], power: 1.2 }));
  const coreGeo = track(buildBullet([], { radial: 96, dense: 0.4, core: true }));
  const core = new THREE.Mesh(coreGeo, coreMat); core.renderOrder = 3;
  let solid = null; let ghost = null; let gf = null; let toks = [];
  spinner.add(core);

  function setTokens(next, seed = micro) {
    toks = next.map((t) => ({ ...t, angle: t.angle ?? tokenAngle(t.id) }));
    if (solid) { spinner.remove(solid, ghost); solid.geometry.dispose(); solidMat.bumpMap?.dispose(); }
    const geo = buildBullet(toks, { radial: mobile ? 480 : 900, dense: mobile ? 0.7 : 1, micro: seed });
    gf = geo.userData.grooveFn;
    solidMat.bumpMap = striaeTexture(toks, { micro: seed, width: mobile ? 2048 : 4096 }); solidMat.needsUpdate = true;
    solid = new THREE.Mesh(geo, solidMat); solid.castShadow = true;
    ghost = new THREE.Mesh(geo, ghostMat); ghost.renderOrder = 2;
    spinner.add(solid, ghost);
    caps.forEach((c) => { c.cap.geometry.dispose(); c.cap.material.dispose(); c.laser.geometry.dispose(); });
    caps.clear(); ticks.clear(); lastFamily = null; lastCapKey = null;
  }

  // Section caps + laser rings, built per slice position on demand and cached.
  const caps = new Map();
  const laserMat = track(new THREE.MeshBasicMaterial({ color: PAL.scan, toneMapped: false }));
  const capHolder = new THREE.Group(); spinner.add(capHolder);
  function capAt(x) {
    const k = x.toFixed(3);
    if (!caps.has(k)) {
      const cap = sectionMesh(gf, x, { ink: '#2A3033', jacket: '#737B7F' });
      const pts = []; const r = profile(x); const n = mobile ? 360 : 540;
      for (let j = 0; j <= n; j++) { const th = (j / n) * Math.PI * 2; const rr = r - gf(th, x) + 0.004; pts.push(new THREE.Vector3(x, rr * Math.cos(th), rr * Math.sin(th))); }
      const laser = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), n, 0.0045, 5, true), laserMat);
      caps.set(k, { cap, laser, x });
    }
    return caps.get(k);
  }
  let lastCapKey = null;

  // Index ticks at the angles of the family being read.
  const ticks = new THREE.Group(); spinner.add(ticks);
  const tickGeo = track(new THREE.BoxGeometry(0.012, 0.13, 0.022));
  let lastFamily = null;
  function markFamily(family, x) {
    const k = `${family}@${x.toFixed(3)}`; if (k === lastFamily) return; lastFamily = k;
    ticks.clear(); if (!family) return;
    const r0 = profile(x);
    for (const t of toks.filter((t) => t.family === family)) {
      const th = t.angle + twistAt(x);
      const m = new THREE.Mesh(tickGeo, laserMat);
      const dir = new THREE.Vector3(0, Math.cos(th), Math.sin(th));
      m.position.copy(dir.clone().multiplyScalar(r0 + 0.1)).setX(x - 0.004);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      ticks.add(m);
    }
  }

  // Gantry: the camera-facing half as an edge radiograph, the far half as matte shell.
  const gantry = new THREE.Group(); scene.add(gantry);
  const prof = []; const ri = G.ri; const ro = G.ro; const hd = G.depth / 2; const rr2 = 0.05;
  const arc = (cx, cy, a0, a1) => { for (let i = 0; i <= 8; i++) { const a = a0 + ((a1 - a0) * i) / 8; prof.push(new THREE.Vector2(cx + rr2 * Math.cos(a), cy + rr2 * Math.sin(a))); } };
  arc(ri + rr2, -hd + rr2, Math.PI, Math.PI * 1.5); arc(ro - rr2, -hd + rr2, -Math.PI / 2, 0);
  arc(ro - rr2, hd - rr2, 0, Math.PI / 2); arc(ri + rr2, hd - rr2, Math.PI / 2, Math.PI); prof.push(prof[0].clone());
  const shellGeo = track(new THREE.LatheGeometry(prof, 200)); shellGeo.rotateZ(-Math.PI / 2);
  const backClip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0); const frontClip = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const shell = new THREE.Mesh(shellGeo, track(new THREE.MeshStandardMaterial({ color: '#EEF0EC', roughness: 0.6, metalness: 0, side: THREE.DoubleSide, clippingPlanes: [backClip], clipShadows: true })));
  shell.castShadow = true; shell.receiveShadow = true;
  const shellGhost = new THREE.Mesh(shellGeo, track(xrayMaterial({ ink: PAL.lead, density: 0.55, clip: [frontClip], edge: true }))); shellGhost.renderOrder = 5;
  const loc = new THREE.Mesh(track(new THREE.TorusGeometry((ri + ro) / 2, 0.0055, 8, 200).rotateY(Math.PI / 2)), laserMat);
  loc.position.x = -hd - 0.002;
  const nT = mobile ? 120 : 240;
  const tiles = new THREE.InstancedMesh(track(new THREE.BoxGeometry(G.depth * 0.72, (0.026 * 240) / nT, 0.01)), track(new THREE.MeshStandardMaterial({ color: '#2B3134', roughness: 0.5, clippingPlanes: [backClip] })), nT);
  { const m4 = new THREE.Matrix4(); const q = new THREE.Quaternion();
    for (let i = 0; i < nT; i++) {
      const a = ((i + 0.5) / nT) * Math.PI * 2; const dir = new THREE.Vector3(0, Math.cos(a), Math.sin(a));
      q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir); m4.compose(dir.clone().multiplyScalar(ri - 0.004), q, new THREE.Vector3(1, 1, 1)); tiles.setMatrixAt(i, m4);
    } }
  const plane = new THREE.Mesh(track(new THREE.CircleGeometry(G.ri - 0.02, 96).rotateY(Math.PI / 2)), track(new THREE.MeshBasicMaterial({ color: PAL.scan, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })));
  plane.renderOrder = 4;
  gantry.add(shell, shellGhost, loc, tiles, plane);

  // Couch + ruler + cradle pads travel with the table.
  const couch = new THREE.Mesh(track(new RoundedBoxGeometry(5.2, 0.07, 0.9, 4, 0.025)), track(new THREE.MeshStandardMaterial({ color: '#F4F5F2', roughness: 0.75 })));
  couch.position.set(1.75, -B.r0 - 0.035 - 0.004, 0); couch.receiveShadow = true; table.add(couch);
  const rulerTex = track(rulerTexture(5.0, rulerFont));
  const ruler = new THREE.Mesh(track(new THREE.PlaneGeometry(5.0, 0.2).rotateX(-Math.PI / 2)), track(new THREE.MeshBasicMaterial({ map: rulerTex, transparent: true, toneMapped: false, depthWrite: false })));
  ruler.position.set(1.75, -B.r0 + 0.0005, 0.33); table.add(ruler);
  const padMat = track(new THREE.MeshStandardMaterial({ color: '#A3AAAC', roughness: 0.9 })); const padGeo = track(new RoundedBoxGeometry(0.34, 0.06, 0.5, 3, 0.02));
  for (const x of [0.75, 2.05]) { const pad = new THREE.Mesh(padGeo, padMat); pad.position.set(x, -B.r0 - 0.005, 0); pad.castShadow = pad.receiveShadow = true; table.add(pad); }

  const camera = new THREE.PerspectiveCamera(23, 16 / 9, 0.1, 100);

  // state: table travel (+x), gantry world x, reconstruction plane world x, spin about the axis,
  // capOn (show the section cap + laser at the plane), family (ticks), breathe (idle ±x on the plane).
  const state = { table: 0, gantry: 0.8, clip: 0.8, spin: 0, capOn: true, family: 'cu.price', gantryOn: true };
  const _v = new THREE.Vector3();

  function update() {
    table.position.x = state.table;
    spinner.rotation.x = state.spin;
    gantry.position.x = state.gantry; gantry.visible = state.gantryOn;
    clipSolid.constant = -state.clip; clipGhost.constant = state.clip;
    // split the gantry shell by the plane through the axis facing the camera
    _v.set(0, camera.position.y, camera.position.z).normalize();
    backClip.normal.copy(_v).negate(); frontClip.normal.copy(_v);
    const local = state.clip - state.table;
    capHolder.clear();
    if (state.capOn && gf && local > 0.05 && local < B.L - 0.05) {
      const c = capAt(local); capHolder.add(c.cap, c.laser); lastCapKey = local;
      markFamily(state.family, local);
      ticks.visible = true;
    } else ticks.visible = false;
  }

  // Screen-space helpers (for DOM leaders): a point on the groove of token t at local x, in world space.
  function groovePoint(t, x = 1.1, lift = 0.01) {
    const th = t.angle + twistAt(x); const r = profile(x) + lift;
    const p = new THREE.Vector3(x, r * Math.cos(th), r * Math.sin(th));
    p.applyAxisAngle(new THREE.Vector3(1, 0, 0), state.spin); p.x += state.table; return p;
  }
  // Is the groove's surface normal facing the camera?
  function facing(t, x = 1.1) {
    const th = t.angle + twistAt(x) + state.spin;
    const n = new THREE.Vector3(0, Math.cos(th), Math.sin(th));
    const p = groovePoint(t, x, 0);
    return n.dot(camera.position.clone().sub(p).normalize());
  }

  if (tokens.length) setTokens(tokens);

  return {
    scene, camera, state, update, setTokens, groovePoint, facing, gantry, table,
    get tokens() { return toks; }, capAt: (x) => capAt(x),
    dispose() {
      disposables.forEach((d) => d.dispose?.());
      caps.forEach((c) => { c.cap.geometry.dispose(); c.cap.material.dispose(); c.laser.geometry.dispose(); });
      solid?.geometry.dispose(); solidMat.bumpMap?.dispose(); tiles.dispose();
    },
  };
}

function rulerTexture(len, font) {
  const pxPerUnit = 400; const c = document.createElement('canvas'); c.width = Math.round(len * pxPerUnit); c.height = 104;
  const g = c.getContext('2d');
  g.fillStyle = '#4A5155'; g.font = `500 22px ${font}`; g.textBaseline = 'top';
  for (let mm = 0; mm <= len * 100; mm += 5) {
    const x = (mm / 100) * pxPerUnit; const major = mm % 50 === 0; const mid = mm % 10 === 0;
    g.fillRect(x, 0, major ? 3 : 2, major ? 40 : mid ? 26 : 14);
    if (major) g.fillText(String(400 + mm).padStart(4, '0'), x + 8, 50);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}

// Camera pose: { target:[x,y,z], offset:[x,y,z], fov, shift:[x,y] } → camera (with a view offset).
export function applyPose(camera, pose, W, H) {
  camera.fov = pose.fov; camera.aspect = W / H;
  camera.position.set(pose.target[0] + pose.offset[0], pose.target[1] + pose.offset[1], pose.target[2] + pose.offset[2]);
  camera.lookAt(pose.target[0], pose.target[1], pose.target[2]);
  camera.setViewOffset(W, H, pose.shift[0], pose.shift[1], W, H);
  camera.updateProjectionMatrix();
}
export function lerpPose(a, b, t) {
  const l = (x, y) => x + (y - x) * t; const v = (p, q) => p.map((x, i) => l(x, q[i]));
  return { target: v(a.target, b.target), offset: v(a.offset, b.offset), fov: l(a.fov, b.fov), shift: v(a.shift, b.shift) };
}
