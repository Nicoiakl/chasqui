// Genera el sitio de la spec DESDE docs/SPEC.md (el documento no pasa por ninguna mano ni por
// el contexto de un modelo: se lee del disco y se convierte). Produce:
//   docs/site/index.html   — la spec EN INGLÉS (canónica), indexable (meta + JSON-LD para LLMs)
//   docs/site/es/index.html — la misma spec en español
//   docs/site/llms.txt      — pista para rastreadores LLM
//   src/plataformas/spec-html.js — ambos HTML embebidos, para GET /spec y GET /es
//
// El inglés es la versión primaria porque es donde busca quien integra un protocolo; el español
// no es una traducción de cortesía sino el idioma en que se escribió y se piensa el sistema.
//
//   node scripts/build-spec-site.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fuentes = {
  en: { md: 'docs/SPEC.en.md', lang: 'en', url: 'https://nyx5.com/spec', otro: { href: '/es', texto: 'Leer en español' },
        pie: 'Nyx5/1 · reference implementation under <a href="https://www.apache.org/licenses/LICENSE-2.0">Apache-2.0</a>. This page is generated from <code>docs/SPEC.en.md</code>. The standard and the code say the same thing.',
        sufijo: 'the specification' },
  es: { md: 'docs/SPEC.md', lang: 'es', url: 'https://nyx5.com/es', otro: { href: '/spec', texto: 'Read in English' },
        pie: 'Nyx5/1 · implementación de referencia bajo <a href="https://www.apache.org/licenses/LICENSE-2.0">Apache-2.0</a>. Esta página se genera desde <code>docs/SPEC.md</code>. El estándar y el código dicen lo mismo.',
        sufijo: 'la especificación' },
};

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
function construir(clave) {
  const cfg = fuentes[clave];
  const md = fs.readFileSync(path.join(root, cfg.md), 'utf8');
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
<html lang="${cfg.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)} — ${cfg.sufijo}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${cfg.url}">
<link rel="alternate" hreflang="en" href="https://nyx5.com/spec">
<link rel="alternate" hreflang="es" href="https://nyx5.com/es">
<link rel="alternate" hreflang="x-default" href="https://nyx5.com/spec">
<meta property="og:title" content="${esc(titulo)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${cfg.url}">
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
  .lang { margin:0 0 26px; font-size:.85rem; }
  .tag { display:inline-block; margin-top:14px; color:var(--dim); font-size:.85rem; }
  footer { max-width:760px; margin:0 auto; padding: 0 22px 60px; color:var(--dim); font-size:.85rem; border-top:1px solid var(--line); padding-top:22px; }
</style>
</head>
<body>
<main>
<p class="lang"><a href="${cfg.otro.href}">${cfg.otro.texto}</a></p>
${body}
</main>
<footer>
${cfg.pie}
</footer>
</body>
</html>
`;

  return { html, desc, titulo, body };
}

const en = construir('en');
const es = construir('es');

// llms.txt en inglés: es lo que lee un rastreador, y el inglés es la versión canónica.
const llms = `# Nyx5/1

> ${en.desc}

Nyx5 is a communication protocol for AI agents: agent@domain addresses, a store-and-forward
mailbox, signed (Ed25519) and encrypted (X25519+AES-GCM) envelopes, and a per-house double-entry
ledger with contracts (escrow, bond, metered) and chained mandates.

What makes it different from every other agent protocol: **a claim costs something**. Escrow is
released only when a deterministic check passes, a false assertion forfeits its bond, and an
agent's reputation is not a score but a public query on the ledger — every point of it cost tokens
and is tied to a verified delivery.

- Specification (English, canonical): https://nyx5.com/spec
- Especificación (español): https://nyx5.com/es
- Join in one command: \`npx @nyx5/nyx5 join\`
- Package: https://www.npmjs.com/package/@nyx5/nyx5
- Source: https://github.com/Nicoiakl/nyx5
- License: Apache-2.0
- No dependencies. Reference implementation on Node and Cloudflare Workers.
`;

const outDir = path.join(root, 'docs/site');
fs.mkdirSync(path.join(outDir, 'es'), { recursive: true });
fs.writeFileSync(path.join(outDir, 'index.html'), en.html);
fs.writeFileSync(path.join(outDir, 'es/index.html'), es.html);
fs.writeFileSync(path.join(outDir, 'llms.txt'), llms);

// El módulo que sirve la casa: los HTML embebidos como string (tampoco pasan por el chat).
const mod = `// GENERADO por scripts/build-spec-site.mjs desde docs/SPEC.en.md y docs/SPEC.md — no editar a mano.\n` +
  `export const SPEC_HTML = ${JSON.stringify(en.html)};\n` +
  `export const SPEC_HTML_ES = ${JSON.stringify(es.html)};\n` +
  `export const LLMS_TXT = ${JSON.stringify(llms)};\n`;
fs.writeFileSync(path.join(root, 'src/plataformas/spec-html.js'), mod);

console.log(`sitio generado — EN: ${(en.html.length / 1024).toFixed(1)} KB, ${en.body.match(/<h2/g)?.length || 0} secciones · ES: ${(es.html.length / 1024).toFixed(1)} KB, ${es.body.match(/<h2/g)?.length || 0} secciones`);
