import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const fixture = (name) => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
export const clone = (x) => JSON.parse(JSON.stringify(x));

/** A JSON-RPC stub: handlers[method](params) → result; counts calls. */
export function stubFetch(handlers, calls = {}) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const one = (req) => {
      calls[req.method] = (calls[req.method] || 0) + 1;
      const h = handlers[req.method];
      if (!h) return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } };
      return { jsonrpc: '2.0', id: req.id, result: h(req.params) };
    };
    const out = Array.isArray(body) ? body.map(one) : one(body);
    return { ok: true, status: 200, json: async () => out };
  };
}
