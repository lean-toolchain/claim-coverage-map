import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { CoverageFile } from "../schemas/index.js";

const require = createRequire(import.meta.url);

function katexAssets(): { css: string; js: string; autoRender: string } {
  const dist = dirname(require.resolve("katex/dist/katex.min.js"));
  let css = readFileSync(join(dist, "katex.min.css"), "utf8");
  // inline woff2 fonts, drop woff/ttf fallbacks
  css = css.replace(/src:([^;}]*)/g, (_m, srcs: string) => {
    const w2 = /url\((fonts\/[^)]+\.woff2)\)/.exec(srcs);
    if (!w2) return `src:${srcs}`;
    const b64 = readFileSync(join(dist, w2[1]!)).toString("base64");
    return `src:url(data:font/woff2;base64,${b64}) format("woff2")`;
  });
  return {
    css,
    js: readFileSync(join(dist, "katex.min.js"), "utf8"),
    autoRender: readFileSync(join(dist, "contrib/auto-render.min.js"), "utf8"),
  };
}

const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const safeScript = (s: string) => s.replace(/<\/script/gi, "<\\/script");

export function renderHtml(cov: CoverageFile, opts: { inlineKatex?: boolean } = {}): string {
  const k = opts.inlineKatex === false ? null : katexAssets();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claim Coverage Map</title>
${k ? `<style>${k.css}</style>` : ""}
<style>${CSS}</style>
</head><body>
<header><h1>Claim Coverage Map</h1><p id="inputs"></p><p id="summary" class="summary"></p></header>
<main>
<div class="toolbar">
  <label><input type="checkbox" id="judgeMode"> Judgment mode</label>
  <label>Filter <select id="filter"><option value="">all</option></select></label>
  <label><input type="checkbox" id="mainOnly"> main results only</label>
  <button id="download" hidden>Download judgments.json</button>
  <span id="draftInfo" class="muted"></span>
</div>
<table id="claims"><thead><tr><th>Result</th><th>Main</th><th>Status</th><th>Lean declaration</th></tr></thead><tbody></tbody></table>
</main>
<footer id="footer"></footer>
<script type="application/json" id="ccm-data">${safeJson(cov)}</script>
${k ? `<script>${safeScript(k.js)}</script><script>${safeScript(k.autoRender)}</script>` : ""}
<script>${safeScript(APP_JS)}</script>
</body></html>
`;
}

const CSS = `
:root{--bg:#fff;--fg:#1d1d1f;--muted:#6b6b70;--line:#e3e3e6;--panel:#f6f6f8;--hl:#fff1a8;
--verified:#1a7f37;--weakened:#9a6700;--corollary_only:#8250df;--assumed:#cf222e;--missing:#cf222e;--needs_review:#0969da}
@media (prefers-color-scheme: dark){:root{--bg:#121214;--fg:#e8e8ea;--muted:#9a9aa0;--line:#2c2c30;--panel:#1b1b1f;--hl:#5c4d00;
--verified:#3fb950;--weakened:#d29922;--corollary_only:#a371f7;--assumed:#f85149;--missing:#f85149;--needs_review:#58a6ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif}
header,main,footer{max-width:1100px;margin:0 auto;padding:12px 16px}
h1{font-size:22px;margin:8px 0}.muted,#inputs,footer{color:var(--muted);font-size:13px}
.summary{font-size:16px;font-weight:600}.toolbar{display:flex;flex-wrap:wrap;gap:16px;align-items:center;margin-bottom:8px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}
tr.row{cursor:pointer}tr.row:hover{background:var(--panel)}
.st{font-weight:600;white-space:nowrap}.by{font-weight:400;color:var(--muted);font-size:12px;margin-left:4px}
${["verified", "weakened", "corollary_only", "assumed", "missing", "needs_review"].map((s) => `.st-${s}{color:var(--${s})}`).join("")}
.detail td{background:var(--panel)}.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width:720px){.cols{grid-template-columns:1fr}th:nth-child(2),td:nth-child(2){display:none}}
pre{white-space:pre-wrap;word-break:break-word;font:13px/1.45 ui-monospace,Menlo,monospace;margin:4px 0}
mark{background:var(--hl);color:inherit}code{font:13px ui-monospace,Menlo,monospace;word-break:break-all}
.judge{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.judge textarea{flex:1;min-width:240px;min-height:48px}
h4{margin:8px 0 4px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.uncertain{font-size:12px;color:var(--needs_review)}a{color:var(--needs_review)}
`;

// Plain browser JS (no framework): render table, details, judgment mode.
const APP_JS = String.raw`
(function(){
var cov = JSON.parse(document.getElementById('ccm-data').textContent);
var LABEL = {verified:'verified',weakened:'weakened',corollary_only:'corollary only',assumed:'assumed (sorry/axiom)',missing:'missing',needs_review:'needs review'};
var KIND = {theorem:'Theorem',lemma:'Lemma',proposition:'Proposition',corollary:'Corollary'};
var STATUSES = Object.keys(LABEL);
var DRAFT_KEY = 'ccm-draft:' + cov.inputs.paper + ':' + cov.inputs.commit;
var draft = {};
try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}') || {}; } catch (e) { draft = {}; }
function saveDraft(){ try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch (e) {} updateDraftInfo(); }
function updateDraftInfo(){ var n = Object.keys(draft).length; document.getElementById('draftInfo').textContent = n ? n + ' unsaved judgment(s) in draft' : ''; }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function name(c){ return KIND[c.kind] + ' ' + (c.number || '(unnumbered)') + (c.title ? ' (' + c.title + ')' : ''); }

var s = cov.summary;
document.getElementById('summary').textContent = s.total + ' results: ' + STATUSES.map(function(k){ return LABEL[k] + ' ' + s[k]; }).join(' · ');
document.getElementById('inputs').textContent = cov.inputs.paper + ' · ' + cov.inputs.repo + ' @ ' + cov.inputs.commit;
var j = cov.inputs.judge;
document.getElementById('footer').textContent = 'commit ' + cov.inputs.commit + ' · toolchain ' + cov.inputs.toolchain + ' · ' + cov.tool.name + ' ' + cov.tool.version +
  ' · judge ' + (j ? j.provider + '/' + j.model + ' (votes ' + j.votes + ', prompt ' + j.prompt_version + ')' : 'none') +
  (cov.usage ? ' · tokens in ' + cov.usage.inputTokens + ' / out ' + cov.usage.outputTokens + (cov.usage.costUsd != null ? ' · $' + cov.usage.costUsd.toFixed(2) : '') : '') +
  ' · generated ' + cov.generated_at;
var filter = document.getElementById('filter');
STATUSES.forEach(function(k){ var o = document.createElement('option'); o.value = k; o.textContent = LABEL[k]; filter.appendChild(o); });

function highlight(text, diffs){
  var out = esc(text);
  (diffs || []).forEach(function(d){
    if (!d.lean) return;
    var needle = esc(d.lean);
    var idx = out.indexOf(needle);
    if (idx < 0) { var m = /^[^:]+:\s*(.+)$/.exec(d.lean); if (m) { needle = esc(m[1]); idx = out.indexOf(needle); } }
    if (idx >= 0) out = out.slice(0, idx) + '<mark>' + needle + '</mark>' + out.slice(idx + needle.length);
  });
  return out;
}

function detail(c){
  var lean = c.evidence.lean.map(function(l){
    return '<div><code>' + (l.url ? '<a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.decl) + '</a>' : esc(l.decl)) + '</code> <span class="muted">' + esc(l.file) + ':' + l.line + '</span>' +
      '<pre>' + highlight(l.type_pp, c.evidence.differences) + '</pre></div>';
  }).join('') || '<p class="muted">No corresponding Lean declaration.</p>';
  var diffs = c.evidence.differences.length ? '<h4>Differences</h4><ul>' + c.evidence.differences.map(function(d){
    return '<li><b>' + esc(d.kind.replace(/_/g,' ')) + '</b>' + (d.lean ? ': <code>' + esc(d.lean) + '</code>' : '') + ' — ' + esc(d.note) + '</li>'; }).join('') + '</ul>' : '';
  var rej = c.evidence.rejected_candidates.length ? '<h4>Rejected candidates</h4><ul>' + c.evidence.rejected_candidates.map(function(r){
    return '<li><code>' + esc(r.decl) + '</code> — ' + esc(r.reason) + '</li>'; }).join('') + '</ul>' : '';
  var ax = (c.evidence.uses_sorry || c.evidence.axioms.length) ? '<h4>Assumptions</h4><p>' + (c.evidence.uses_sorry ? '<code>sorry</code> ' : '') + c.evidence.axioms.map(function(a){ return '<code>' + esc(a) + '</code>'; }).join(' ') + '</p>' : '';
  var human = c.human.status ? '<h4>Human judgment' + (c.human.stale ? ' (stale: paper text changed, not applied)' : '') + '</h4><p>' + esc(c.human.status) + ' — ' + esc(c.human.note || '') + ' <span class="muted">' + esc(c.human.by || '') + ' ' + esc(c.human.at || '') + '</span></p>' : '';
  var d = draft[c.claim_id] || {};
  var judge = '<div class="judge" data-judge="' + esc(c.claim_id) + '"><select><option value="">— judge —</option><option value="confirm"' + (d.status === 'confirm' ? ' selected' : '') + '>confirm automatic (' + LABEL[c.auto_status] + ')</option>' +
    STATUSES.map(function(k){ return '<option value="' + k + '"' + (d.status === k ? ' selected' : '') + '>' + LABEL[k] + '</option>'; }).join('') +
    '</select><textarea placeholder="note">' + esc(d.note || '') + '</textarea></div>';
  return '<h4>Why</h4><p>' + esc(c.reason) + '</p>' +
    '<div class="cols"><div><h4>Paper <span class="muted">' + esc(c.evidence.paper.file) + ':' + c.evidence.paper.line + '</span></h4><div class="tex">' + esc(c.text_tex.replace(/\\label\{[^}]*\}\s*/g, '')) + '</div></div>' +
    '<div><h4>Lean</h4>' + lean + '</div></div>' + diffs + ax + rej + human +
    (judgeMode() ? judge : '');
}

function judgeMode(){ return document.getElementById('judgeMode').checked; }
var open = {};
function render(){
  var tb = document.querySelector('#claims tbody');
  var f = filter.value, mainOnly = document.getElementById('mainOnly').checked;
  tb.innerHTML = '';
  cov.claims.forEach(function(c){
    if (f && c.status !== f) return;
    if (mainOnly && !c.is_main) return;
    var tr = document.createElement('tr'); tr.className = 'row';
    var by = c.decided_by === 'human' ? 'confirmed' : c.decided_by === 'rule' ? 'rule' : 'auto';
    tr.innerHTML = '<td>' + esc(name(c)) + (c.extraction === 'uncertain' ? ' <span class="uncertain">extraction uncertain</span>' : '') + '</td><td>' + (c.is_main ? 'main' : '') + '</td>' +
      '<td class="st st-' + c.status + '">' + LABEL[c.status] + '<span class="by">' + by + '</span></td>' +
      '<td>' + (c.decls.map(function(d){ return '<code>' + esc(d) + '</code>'; }).join(', ') || '—') + '</td>';
    tr.onclick = function(){ open[c.claim_id] = !open[c.claim_id]; render(); };
    tb.appendChild(tr);
    if (open[c.claim_id]) {
      var dr = document.createElement('tr'); dr.className = 'detail';
      var td = document.createElement('td'); td.colSpan = 4; td.innerHTML = detail(c); dr.appendChild(td); tb.appendChild(dr);
      if (window.renderMathInElement) renderMathInElement(td.querySelector('.tex'), {delimiters:[{left:'$$',right:'$$',display:true},{left:'\\[',right:'\\]',display:true},{left:'$',right:'$',display:false},{left:'\\(',right:'\\)',display:false}], throwOnError:false});
      var jd = td.querySelector('[data-judge]');
      if (jd) {
        var sel = jd.querySelector('select'), ta = jd.querySelector('textarea');
        var upd = function(){ if (!sel.value && !ta.value) delete draft[c.claim_id]; else draft[c.claim_id] = {status: sel.value || null, note: ta.value || null}; saveDraft(); };
        sel.onchange = upd; ta.oninput = upd; jd.onclick = function(e){ e.stopPropagation(); };
      }
    }
  });
  document.getElementById('download').hidden = !judgeMode();
}
document.getElementById('download').onclick = function(){
  var who = prompt('Your name or reviewer id (saved as "by")', '') || null;
  var today = new Date().toISOString().slice(0, 10);
  var out = {};
  cov.claims.forEach(function(c){
    var d = draft[c.claim_id];
    if (!d || !d.status) return;
    out[c.claim_id] = {status: d.status, note: d.note || null, by: who, at: today, claim_text_sha256: c.claim_text_sha256};
  });
  var blob = new Blob([JSON.stringify(out, null, 2)], {type: 'application/json'});
  var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'judgments.json'; a.click();
};
filter.onchange = render; document.getElementById('mainOnly').onchange = render; document.getElementById('judgeMode').onchange = render;
updateDraftInfo(); render();
})();
`;
