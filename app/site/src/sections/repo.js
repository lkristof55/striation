// Beat 7: real code from the library's src/ (imported as text at build time, so it can't drift from the library),
// the repo block and the install command. npm publish is PLANNED until the user publishes.
import matchSrc from '../../../../src/match.js' with { type: 'text' };
import { $, esc, REPO_URL, PKG } from '../util.js';

const KW = /\b(export|function|const|let|for|of|if|else|return|continue|new|import|from)\b/g;

function highlight(line) {
  // comments, strings, numbers, keywords; tokenised left to right so spans never nest
  const out = []; let i = 0;
  const re = /(\/\/.*$|\/\*.*?\*\/|^\s*\*.*$)|('(?:[^'\\]|\\.)*'|`[^`]*`)|(\b\d+(?:\.\d+)?\b)|(\b(?:export|function|const|let|for|of|if|else|return|continue|new|import|from)\b)/g;
  let m;
  while ((m = re.exec(line))) {
    out.push(esc(line.slice(i, m.index)));
    const cls = m[1] ? 'com' : m[2] ? 'str' : m[3] ? 'num' : 'kw';
    out.push(`<span class="${cls}">${esc(m[0])}</span>`);
    i = m.index + m[0].length;
  }
  out.push(esc(line.slice(i)));
  return out.join('');
}

export function renderRepo(stats) {
  const lines = matchSrc.split('\n');
  const from = lines.findIndex((l) => l.startsWith('function prepare('));
  const simAt = lines.findIndex((l) => l.startsWith('export function similarity('));
  let to = simAt; while (to < lines.length && lines[to] !== '}') to++;
  const a = Math.max(0, from); const b = Math.min(lines.length - 1, to);
  const body = lines.slice(a, b + 1).map((l, k) => {
    const hot = /inter \/ union|inter \+= w/.test(l);
    return `<span class="l${hot ? ' hot' : ''}"><span class="no">${a + k + 1}</span>${highlight(l)}</span>`;
  }).join('');
  void KW;
  $('#code').innerHTML = `<div class="path mono"><span>src/match.js · l${a + 1}–${b + 1}</span><span>J<sub>w</sub>(A,B) = Σ<sub>A∩B</sub> w / Σ<sub>A∪B</sub> w</span></div><pre>${body}</pre>`;

  const bench = stats?.bench || [];
  const acc = stats?.accuracy;
  const install = `git clone ${REPO_URL}\ncd striation && npm i && npm test\nSTRIAE_RPC_URL=<your rpc> node bin/striae.js <mint>`;
  $('#repoBlock').innerHTML = `
    <div class="r mono"><span>repository</span><span><b><a class="u" href="${esc(REPO_URL)}" target="_blank" rel="noopener">${esc(REPO_URL.replace('https://', ''))}</a></b></span></div>
    <div class="r mono"><span>package</span><span><b>${PKG}</b> · npm i ${PKG} <span class="chip">planned</span></span></div>
    <div class="r mono"><span>license</span><span><b>MIT</b> · zero runtime dependencies · node ≥ 20</span></div>
    ${acc ? `<div class="r mono"><span>leave-one-out top-1</span><span><b>${(acc.top1 * 100).toFixed(1)}%</b> vs baseline ${(acc.majorityBaseline * 100).toFixed(1)}%</span></div>` : '<div class="r mono"><span>benchmarks</span><span><span class="chip planned">planned</span></span></div>'}
    ${bench.slice(0, 3).map((x) => `<div class="r mono"><span>${esc(x.name)}</span><span><b>${esc(String(x.value))}</b> <span class="b58">${esc(x.unit)}</span></span></div>`).join('')}
    <div class="install"><pre>${esc(install)}</pre><button type="button" class="btn" id="copyInstall">copy</button></div>
    <p class="mono-lc" style="margin-top:10px">the repo is not public yet; the url is where it will live. nothing on npm until then.</p>`;
  $('#copyInstall').addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText(install); } catch { /* blocked */ }
    e.target.textContent = 'copied.'; setTimeout(() => (e.target.textContent = 'copy'), 1200);
  });
}
