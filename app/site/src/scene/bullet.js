// Striation: the bullet is the feature vector made physical.
//   axis  = +X (base at x=0, nose at x=L)
//   angle = tokenAngle(token.id)  (the same token lands at the same angle on every bullet)
//   depth = token.weight          (heavier striation, deeper groove)
//   twist = 5.5° right-hand helix (the rifling twist; also the skew of the display type)
// site-builder: copy this file to site/src/scene/bullet.js and feed it featured.striations from /api/feed.
import * as THREE from 'three';

export const B = {
  r0: 0.5, L: 3.7, tailEnd: 0.45, bearingEnd: 1.75, baseR: 0.4, meplat: 0.035,
  twistDeg: 5.5, lands: 6, landWidth: 0.26, landDepth: 0.011, jacket: 0.055, cannelure: [1.38, 1.46],
};
const TW = Math.tan((B.twistDeg * Math.PI) / 180) / B.r0; // radians of twist per unit of x
export const twistAt = (x) => (x - B.tailEnd) * TW;

const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Outer radius along the axis (no grooves).
export function profile(x) {
  const { r0, L, tailEnd, bearingEnd, baseR, meplat } = B;
  if (x <= 0) return baseR - 0.02;
  if (x < 0.02) return baseR - 0.02 + x; // base chamfer
  if (x < tailEnd) return baseR + (r0 - baseR) * sstep(0.02, tailEnd, x) ** 0.9;
  if (x <= bearingEnd) {
    const [c0, c1] = B.cannelure; // crimp groove, a real cannelure
    const cg = x > c0 && x < c1 ? 0.014 * Math.sin(((x - c0) / (c1 - c0)) * Math.PI) : 0;
    return r0 - cg;
  }
  const Lo = L - bearingEnd; const rho = (r0 * r0 + Lo * Lo) / (2 * r0); // tangent ogive
  const s = L - x; // distance from the tip
  return Math.max(meplat * (x < L ? 1 : 0), Math.sqrt(Math.max(0, rho * rho - (Lo - s) ** 2)) + r0 - rho);
}
export const coreProfile = (x) => (x < 0.07 || x > 3.05 ? 0 : Math.max(0, profile(x) - B.jacket) * (x > 2.6 ? 1 - sstep(2.6, 3.05, x) * 0.999 : 1));

// Depth of engraving at angle theta and axial x.
export function grooveFn(tokens, { micro = 0 } = {}) {
  const g = tokens.map((t) => ({ a: t.angle, hw: 0.007 + 0.0028 * t.weight, d: 0.0021 * t.weight }));
  const rnd = mulberry(micro || 1); const m = micro ? Array.from({ length: 90 }, () => ({ a: rnd() * Math.PI * 2, hw: 0.002 + rnd() * 0.004, d: 0.0003 + rnd() * 0.0008 })) : [];
  const wrap = (a) => { a %= Math.PI * 2; if (a > Math.PI) a -= Math.PI * 2; if (a < -Math.PI) a += Math.PI * 2; return a; };
  return (theta, x) => {
    const fade = sstep(B.tailEnd - 0.02, B.tailEnd + 0.1, x) * (1 - sstep(B.bearingEnd + 0.05, B.bearingEnd + 0.45, x));
    if (fade <= 0) return 0;
    const phi = theta - twistAt(x);
    let d = 0;
    for (let k = 0; k < B.lands; k++) { // land impressions: flat-bottomed, soft shoulders
      const da = Math.abs(wrap(phi - (k / B.lands) * Math.PI * 2 - 0.3));
      d = Math.max(d, B.landDepth * (1 - sstep(B.landWidth / 2 - 0.025, B.landWidth / 2 + 0.01, da)));
    }
    for (const s of g) { const da = Math.abs(wrap(phi - s.a)); if (da < s.hw) d += s.d * Math.cos((da / s.hw) * Math.PI * 0.5) ** 2; }
    for (const s of m) { const da = Math.abs(wrap(phi - s.a)); if (da < s.hw) d += s.d * (1 - da / s.hw); }
    return d * fade;
  };
}

function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function axialSamples(dense = 1) {
  const xs = [0, 0, 0.02];
  const push = (a, b, n) => { for (let i = 1; i <= n; i++) xs.push(a + ((b - a) * i) / n); };
  push(0.02, B.tailEnd, Math.round(14 * dense));
  push(B.tailEnd, B.bearingEnd + 0.5, Math.round(150 * dense));
  push(B.bearingEnd + 0.5, B.L - 0.002, Math.round(70 * dense));
  xs.push(B.L, B.L);
  return xs;
}

// The engraved bullet. radial 720 on desktop, 360 on mobile.
export function buildBullet(tokens, { radial = 720, dense = 1, micro = 0, core = false } = {}) {
  const gf = grooveFn(tokens, { micro });
  const xs = axialSamples(dense);
  const rows = xs.length; const cols = radial + 1;
  const pos = new Float32Array(rows * cols * 3); const uv = new Float32Array(rows * cols * 2);
  for (let i = 0; i < rows; i++) {
    const x = xs[i];
    let r = core ? coreProfile(x) : profile(x);
    if (i === 0 || i === rows - 1) r = 0; // closed ends
    for (let j = 0; j < cols; j++) {
      const th = (j / radial) * Math.PI * 2;
      const rr = core ? r : Math.max(0, r - gf(th, x));
      const o = (i * cols + j) * 3;
      pos[o] = core ? Math.min(Math.max(x, 0.07), 3.05) : x; pos[o + 1] = rr * Math.cos(th); pos[o + 2] = rr * Math.sin(th);
      uv[(i * cols + j) * 2] = j / radial - twistAt(x) / (Math.PI * 2); uv[(i * cols + j) * 2 + 1] = x / B.L;
    }
  }
  const idx = [];
  for (let i = 0; i < rows - 1; i++) for (let j = 0; j < radial; j++) {
    const a = i * cols + j; const b = a + cols; const c = b + 1; const d = a + 1;
    idx.push(a, d, b, b, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const n = geo.attributes.normal; // weld the seam normals
  for (let i = 0; i < rows; i++) {
    const a = i * cols; const b = a + radial;
    const v = new THREE.Vector3(n.getX(a) + n.getX(b), n.getY(a) + n.getY(b), n.getZ(a) + n.getZ(b)).normalize();
    n.setXYZ(a, v.x, v.y, v.z); n.setXYZ(b, v.x, v.y, v.z);
  }
  geo.userData.grooveFn = gf;
  return geo;
}

// Height map of the striae for bumpMap (u = unwrapped angle, twist already in the UVs).
export function striaeTexture(tokens, { width = 4096, micro = 0 } = {}) {
  const gf = grooveFn(tokens, { micro });
  const c = document.createElement('canvas'); c.width = width; c.height = 4;
  const ctx = c.getContext('2d'); const img = ctx.createImageData(width, 4);
  const x = (B.tailEnd + B.bearingEnd) / 2; const tw = twistAt(x);
  for (let i = 0; i < width; i++) {
    const d = gf((i / width) * Math.PI * 2 + tw, x);
    const v = Math.round(255 * (1 - Math.min(1, d / 0.02)));
    for (let r = 0; r < 4; r++) { const o = (r * width + i) * 4; img.data[o] = img.data[o + 1] = img.data[o + 2] = v; img.data[o + 3] = 255; }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.NoColorSpace; t.anisotropy = 8;
  return t;
}

// Cross-section at x: [outer ring points, core points] in the (y, z) plane.
export function section(gf, x, n = 1440) {
  const outer = []; const inner = []; const r = profile(x); const rc = coreProfile(x);
  for (let j = 0; j < n; j++) {
    const th = (j / n) * Math.PI * 2; const rr = r - gf(th, x);
    outer.push(new THREE.Vector2(rr * Math.cos(th), rr * Math.sin(th)));
    inner.push(new THREE.Vector2(rc * Math.cos(th), rc * Math.sin(th)));
  }
  return { outer, inner, r, rc };
}

// The CT slice cap: jacket ring + lead core, drawn with a CT-noise shader, facing -X.
export function sectionMesh(gf, x, { ink = '#15181A', jacket = '#474E52', grainSeed = 1 } = {}) {
  const { outer, inner, rc } = section(gf, x);
  const shape = new THREE.Shape(outer);
  const geo = new THREE.ShapeGeometry(shape, 1);
  const m = new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1); // (sx,sy,0) -> (0,sx,sy)
  geo.applyMatrix4(m); geo.translate(x - 0.0005, 0, 0);
  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { uCore: { value: rc }, uR: { value: profile(x) }, uInk: { value: new THREE.Color(ink) }, uJacket: { value: new THREE.Color(jacket) }, uSeed: { value: grainSeed } },
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `varying vec3 vP; uniform float uCore; uniform float uR; uniform vec3 uInk; uniform vec3 uJacket; uniform float uSeed;
      float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)) + uSeed) * 43758.5453); }
      void main(){
        float rho = length(vP.yz);
        float core = 1.0 - smoothstep(uCore - 0.004, uCore + 0.004, rho);
        vec3 c = mix(uJacket, uInk, core);
        float n = h(floor(gl_FragCoord.xy / 1.0)) - 0.5;
        c += n * 0.045;
        c *= 1.0 - 0.18 * smoothstep(uR * 0.82, uR, rho) * (1.0 - core); // beam hardening at the rim
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  return new THREE.Mesh(geo, mat);
}

// Radiograph (inverted LUT: dense = dark) material for the unscanned part.
export function xrayMaterial({ ink = '#15181A', density = 0.5, clip = [], edge = false, power = 1.6 } = {}) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, clippingPlanes: clip, clipping: true,
    uniforms: { uInk: { value: new THREE.Color(ink) }, uDensity: { value: density }, uEdge: { value: edge ? 1 : 0 }, uPow: { value: power } },
    vertexShader: `#include <clipping_planes_pars_vertex>
      varying vec3 vN; varying vec3 vV;
      void main(){ vec4 mvPosition = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mvPosition.xyz);
        gl_Position = projectionMatrix * mvPosition;
        #include <clipping_planes_vertex>
      }`,
    fragmentShader: `#include <clipping_planes_pars_fragment>
      varying vec3 vN; varying vec3 vV; uniform vec3 uInk; uniform float uDensity; uniform float uEdge; uniform float uPow;
      void main(){
        #include <clipping_planes_fragment>
        float f = abs(dot(normalize(vN), normalize(vV)));
        float a = uEdge > 0.5 ? uDensity * pow(1.0 - f, 3.0) : uDensity * (0.06 + 0.94 * pow(f, uPow));
        gl_FragColor = vec4(uInk, a);
        #include <colorspace_fragment>
      }`,
  });
}
