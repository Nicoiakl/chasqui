// Genera el sitio de la spec DESDE docs/SPEC.md (el documento no pasa por ninguna mano ni por
// el contexto de un modelo: se lee del disco y se convierte). Produce:
//   docs/site/index.html   — la spec en una página, indexable (meta + JSON-LD para LLMs)
//   docs/site/llms.txt      — pista para rastreadores LLM
//   src/plataformas/spec-html.js — el mismo HTML embebido, para que la casa lo sirva en GET /spec
//
//   node scripts/build-spec-site.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const md = fs.readFileSync(path.join(root, 'docs/SPEC.md'), 'utf8');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`);

// Conversor markdown -> HTML acotado al subconjunto que usa la spec: encabezados, tablas, code
// fences, listas, citas, párrafos. Sin dependencias.
function toHtml(src) {
  const lines = src.split('\n');
  const out = [];
  let i = 0;
  const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^(\s*)```(.*)$/.exec(line);                 // code fence (aun indentado bajo una lista)
    if (fence) {
      const indent = fence[1].length; const lang = fence[2].trim();
      const buf = []; i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(esc(lines[i].slice(indent))); i++; }
      i++;
      out.push(`<pre class="lang-${lang || 'text'}"><code>${buf.join('\n')}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { const n = h[1].length; const t = h[2]; out.push(`<h${n} id="${slug(t)}">${inline(t)}</h${n}>`); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) { // tabla
      const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(line); i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { body.push(row(lines[i])); i++; }
      out.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        body.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {                            // lista con viñetas
      const buf = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { buf.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`); i++; }
      out.push(`<ul>${buf.join('')}</ul>`); continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {                           // lista numerada
      const buf = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { buf.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`); i++; }
      out.push(`<ol>${buf.join('')}</ol>`); continue;
    }
    if (/^\s*>\s?/.test(line)) { out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`); i++; continue; }
    if (line.trim() === '') { i++; continue; }
    const buf = [line];                                        // párrafo (hasta línea en blanco)
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6}\s|```|\s*[-*]\s|\s*\d+\.\s|\s*\|)/.test(lines[i])) { buf.push(lines[i]); i++; }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

// Título y descripción para <meta> y JSON-LD, tomados del propio documento.
const titulo = (/^#\s+(.*)$/m.exec(md) || [, 'Nyx5/1'])[1].trim();
// Descripción para <meta>/JSON-LD/llms: el primer párrafo de contenido, tomado DESPUÉS del primer
// encabezado de sección (así se salta el "Estado:" y el "Implementación de referencia:" del preámbulo).
const _ls = md.split('\n');
const _desde = _ls.findIndex((l) => /^##\s/.test(l));
const primerParrafo = (_ls.slice(_desde + 1).find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('-')) || 'Correo y libro para agentes de IA.').trim();
const desc = primerParrafo.replace(/[`*]/g, '').replace(/[:\s]+$/, '.').slice(0, 300);
const body = toHtml(md);

const jsonld = JSON.stringify({
  '@context': 'https://schema.org', '@type': 'TechArticle',
  name: titulo, headline: titulo, description: desc,
  inLanguage: 'es', url: 'https://nyx5.com/spec', license: 'https://www.apache.org/licenses/LICENSE-2.0',
  about: ['agent communication protocol', 'signed messaging', 'double-entry ledger for AI agents'],
});

// La cáscara (estilos + meta) es código de esta herramienta, no contenido del documento.
const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)} — la especificación</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="https://nyx5.com/spec">
<meta property="og:title" content="${esc(titulo)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="article">
<meta property="og:url" content="https://nyx5.com/spec">
<script type="application/ld+json">${jsonld}</script>
<style>
  :root { --ink:#1a1a1a; --dim:#666; --bg:#fff; --soft:#f6f6f4; --line:#e5e5e0; --accent:#7a4d1d; --code:#f0efe9; }
  @media (prefers-color-scheme: dark) { :root { --ink:#e8e6e0; --dim:#9a978f; --bg:#151513; --soft:#1e1e1b; --line:#33322d; --accent:#d6a86a; --code:#222220; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 48px 22px 120px; }
  h1 { font-size: 2.1rem; line-height:1.15; margin: 0 0 .2em; letter-spacing:-.01em; }
  h2 { font-size: 1.45rem; margin: 2.4em 0 .5em; padding-top:.4em; border-top:1px solid var(--line); }
  h3 { font-size: 1.12rem; margin: 1.8em 0 .4em; }
  h2:first-of-type { border-top:none; }
  a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
  code { background: var(--code); padding: .1em .35em; border-radius: 4px; font: .88em ui-monospace,SFMono-Regular,Menlo,monospace; }
  pre { background: var(--soft); border:1px solid var(--line); border-radius: 8px; padding: 14px 16px; overflow-x:auto; }
  pre code { background:none; padding:0; font-size:.82rem; line-height:1.5; }
  table { border-collapse: collapse; width:100%; margin: 1.2em 0; font-size:.92rem; display:block; overflow-x:auto; }
  th, td { border:1px solid var(--line); padding: 7px 11px; text-align:left; vertical-align:top; }
  th { background: var(--soft); }
  blockquote { margin:1em 0; padding:.2em 1em; border-left:3px solid var(--accent); color:var(--dim); }
  ul, ol { padding-left: 1.3em; }
  li { margin:.25em 0; }
  .tag { display:inline-block; margin-top:14px; color:var(--dim); font-size:.85rem; }
  footer { max-width:760px; margin:0 auto; padding: 0 22px 60px; color:var(--dim); font-size:.85rem; border-top:1px solid var(--line); padding-top:22px; }
</style>
</head>
<body>
<main>
${body}
</main>
<footer>
Nyx5/1 · implementación de referencia bajo <a href="https://www.apache.org/licenses/LICENSE-2.0">Apache-2.0</a>.
Esta página se genera desde <code>docs/SPEC.md</code>. El estándar y el código dicen lo mismo.
</footer>
</body>
</html>
`;

const llms = `# Nyx5/1

> ${desc}

Nyx5 es un protocolo de comunicación entre agentes de IA: direcciones agente@dominio, buzón
store-and-forward, sobres firmados (Ed25519) y cifrados (X25519+AES-GCM), y un ledger de doble
entrada por casa con contratos (escrow, fianza, medido) y mandatos en cadena.

- Especificación: https://nyx5.com/spec
- Licencia: Apache-2.0
- Sin dependencias. Implementación de referencia en Node y Cloudflare Workers.
`;

const outDir = path.join(root, 'docs/site');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'index.html'), html);
fs.writeFileSync(path.join(outDir, 'llms.txt'), llms);

// El módulo que sirve la casa: el HTML embebido como string (tampoco pasa por el chat).
const mod = `// GENERADO por scripts/build-spec-site.mjs desde docs/SPEC.md — no editar a mano.\n` +
  `export const SPEC_HTML = ${JSON.stringify(html)};\n` +
  `export const LLMS_TXT = ${JSON.stringify(llms)};\n`;
fs.writeFileSync(path.join(root, 'src/plataformas/spec-html.js'), mod);

console.log(`sitio generado: ${(html.length / 1024).toFixed(1)} KB · título "${titulo}" · ${body.match(/<h2/g)?.length || 0} secciones`);
