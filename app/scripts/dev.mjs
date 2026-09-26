// Local server: the built site plus every Netlify function, the way production runs them.
//
//   npm run dev                      (= node scripts/dev.mjs; run `npm run build` first)
//   node scripts/dev.mjs [--port 8888] [--watch] [--cron]
//
// - Static files come from site/dist (--watch rebuilds on change and reloads the functions).
// - Each netlify/functions/*.mjs (or <name>/index.mjs) is a Netlify Functions v2 handler:
//     export default async (req, context) => Response
//     export const config = { path: '/api/thing' }     (string or array; default /.netlify/functions/<name>)
//   context has { params, ip, geo, site, waitUntil, cookies }.
// - Env: app/.env (see .env.example); variables already set in the shell win.
// - STRIATION_STORE_DIR=app/.data, which lib/store.mjs uses instead of Netlify Blobs.
// - --cron runs the functions that export config.schedule once at start and then every minute
//   (production runs them on their own schedule, e.g. feed-refresh every 5 minutes).
import http from 'node:http';
import fs from 'node:fs/promises';
import { watch as fsWatch } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_DIR, build } from './build.mjs';

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const port = Number(flag('--port') || process.env.PORT || 8888);
const watch = argv.includes('--watch');
const cron = argv.includes('--cron');

/** Load KEY=VALUE lines into process.env without overriding what is already set. */
async function loadEnv(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

await loadEnv(path.join(APP_DIR, '.env'));
process.env.STRIATION_STORE_DIR ||= path.join(APP_DIR, '.data');
process.env.URL ||= `http://localhost:${port}`;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.glb': 'model/gltf-binary',
  '.hdr': 'application/octet-stream', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
};

/** '/api/thing/:id' → { re, keys } (the subset of Netlify path syntax these functions use). */
function compilePath(p) {
  const keys = [];
  const src = p.split('/').map((seg) => {
    if (seg === '*') return '.*';
    if (seg.startsWith(':')) { keys.push(seg.slice(1).replace(/\?$/, '')); return '([^/]+)'; }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { path: p, re: new RegExp(`^${src}/?$`), keys };
}

async function loadFunctions() {
  const fdir = path.join(APP_DIR, 'netlify', 'functions');
  const out = [];
  let names = [];
  try { names = await fs.readdir(fdir); } catch { return out; }
  for (const n of names) {
    let file = path.join(fdir, n);
    if ((await fs.stat(file)).isDirectory()) file = path.join(file, 'index.mjs');
    else if (!/\.(mjs|js)$/.test(n)) continue;
    const name = n.replace(/\.(mjs|js)$/, '');
    try {
      const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
      const cfg = mod.config || {};
      const paths = cfg.path ? [].concat(cfg.path) : [`/.netlify/functions/${name}`];
      out.push({ name, handler: mod.default, schedule: cfg.schedule, routes: paths.map(compilePath) });
    } catch (e) {
      console.error(`function ${name} failed to load: ${e.stack || e.message}`);
    }
  }
  return out;
}

let fns = await loadFunctions();
if (watch) {
  await build(APP_DIR, { watch: true, log: (m) => console.log(`[build] ${m}`) });
  let t;
  fsWatch(path.join(APP_DIR, 'netlify', 'functions'), { recursive: true }, () => {
    clearTimeout(t);
    t = setTimeout(async () => { fns = await loadFunctions(); console.log('[functions] reloaded'); }, 200);
  });
}

async function readBody(req) {
  if (['GET', 'HEAD'].includes(req.method)) return undefined;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

async function runFunction(f, route, m, req, res, url) {
  const started = Date.now();
  const request = new Request(url, { method: req.method, headers: req.headers, body: await readBody(req), duplex: 'half' });
  const waits = [];
  const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  const context = {
    params, ip: req.socket.remoteAddress, geo: {}, site: { url: process.env.URL },
    waitUntil: (p) => waits.push(p), cookies: { get: () => undefined, set() {}, delete() {} },
  };
  let r;
  try {
    r = await f.handler(request, context);
    if (!(r instanceof Response)) r = Response.json(r ?? null);
  } catch (e) {
    console.error(`[${f.name}] ${e.stack || e.message}`);
    r = Response.json({ error: 'function crashed' }, { status: 500 });
  }
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
  Promise.allSettled(waits);
  console.log(`${req.method} ${url.pathname}${url.search} → ${r.status} ${Date.now() - started}ms [${f.name}]`);
}

const dist = path.join(APP_DIR, 'site', 'dist');
async function staticFile(pathname) {
  const root = path.resolve(dist);
  const f = path.resolve(root, '.' + path.sep + decodeURIComponent(pathname));
  if (f !== root && !f.startsWith(root + path.sep)) return null; // no ../ escapes
  const candidates = pathname.endsWith('/') ? [path.join(f, 'index.html')] : [f];
  if (!path.extname(f)) candidates.push(f + '.html', path.join(f, 'index.html'));
  for (const c of candidates) {
    try { if ((await fs.stat(c)).isFile()) return c; } catch { /* next */ }
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    for (const f of fns) {
      for (const route of f.routes) {
        const m = route.re.exec(url.pathname);
        if (m) return await runFunction(f, route, m, req, res, url);
      }
    }
    const file = await staticFile(url.pathname);
    if (file) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
      return res.end(await fs.readFile(file));
    }
    const notFound = await staticFile('/404.html');
    res.writeHead(404, { 'content-type': notFound ? TYPES['.html'] : 'text/plain' });
    res.end(notFound ? await fs.readFile(notFound) : `not found: ${url.pathname}`);
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('server error: ' + e.message);
  }
});

await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', ok); });

if (cron) {
  const tick = async () => {
    for (const f of fns.filter((x) => x.schedule)) {
      try {
        await f.handler(new Request(`${process.env.URL}/.netlify/functions/${f.name}`, { method: 'POST', body: JSON.stringify({ next_run: null }) }), {});
        console.log(`[cron] ${f.name} ok`);
      } catch (e) { console.error(`[cron] ${f.name}: ${e.message}`); }
    }
  };
  tick();
  setInterval(tick, 60_000);
}

try { await fs.access(path.join(dist, 'index.html')); } catch { console.warn('site/dist/index.html is missing: run `npm run build` first'); }
if (!process.env.HELIUS_API_KEY) console.warn('HELIUS_API_KEY is not set: /api/match and the feed refresh will answer 502 (copy .env.example to .env)');
const routes = fns.flatMap((f) => f.routes.map((r) => `${r.path} [${f.name}${f.schedule ? `, schedule ${f.schedule}` : ''}]`));
console.log(`striation on http://localhost:${port}${routes.length ? '\n  ' + routes.join('\n  ') : ''}`);
