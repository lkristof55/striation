// 404: the mark as a slowly turning radiograph.
import * as THREE from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import { xrayMaterial } from './scene/bullet.js';
import markSvg from '../public/logo.svg';

export function run() {
  const canvas = document.getElementById('stage');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setClearColor(0, 0);
  const scene = new THREE.Scene(); const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100); camera.position.set(0, 0, 9);
  const g = new THREE.Group(); scene.add(g);
  const data = new SVGLoader().parse(markSvg);
  data.paths.forEach((p, i) => {
    for (const sh of SVGLoader.createShapes(p)) {
      const geo = new THREE.ExtrudeGeometry(sh, { depth: 6, bevelEnabled: true, bevelSize: 0.6, bevelThickness: 0.8, bevelSegments: 3, curveSegments: 48 });
      geo.translate(-50, -50, -3); geo.scale(0.04, -0.04, 0.04);
      const m = new THREE.Mesh(geo, xrayMaterial({ ink: i === 1 ? '#056A85' : '#15181A', density: 0.55, power: 1.4 }));
      g.add(m);
    }
  });
  const fit = () => { const w = innerWidth; const h = innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.setViewOffset(w, h, w > 768 ? -w * 0.22 : 0, w > 768 ? 0 : h * 0.18, w, h); camera.updateProjectionMatrix(); };
  fit(); addEventListener('resize', fit);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tick = (t) => { g.rotation.y = reduce ? 0.5 : t / 4000; g.rotation.x = 0.12; renderer.render(scene, camera); if (!reduce) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  window.__ready = true;
}
