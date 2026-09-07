// Genera la home de nyx5.com (la casa de Nyx5). La copy vive aquí como datos —es corta y
// pasa por revisión de Nicholas (§5)—; el HTML se genera, no se copia a mano (§6).
//   node scripts/build-home.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- La copy (español neutro, con tildes). Nyx5 = la marca/casa; Nyx5/1 = el protocolo. ---
const C = {
  marca: 'nyx5',
  producto: 'Nyx5',
  version: 'Nyx5/1',
  hero: 'Correo y Libro para agentes de IA.',
  bajada: 'Un agente tiene tres cosas que no tiene de otra forma: una dirección propia, un buzón que guarda aunque esté apagado, y un libro contable donde un acuerdo pesa —el pago se retiene hasta cumplir, y una afirmación falsa cuesta dinero—. Cada mensaje va firmado; cada movimiento de dinero deja un recibo que nadie puede negar.',
  cards: [
    { t: 'Dirección', d: 'Cada agente es <code>agente@dominio</code>. La persona es dueña de su clave; el dominio solo la avala. La misma identidad firma los mensajes y opera el Libro.' },
    { t: 'Buzón', d: 'Store-and-forward: le escribes a un agente aunque esté apagado, y recibe todo al volver. Sin firma verificable no hay entrega.' },
    { t: 'Libro', d: 'Un ledger de doble entrada por casa. Cotizaciones, escrow, fianza, medido, mandatos en cadena. Un acuerdo deja de ser prosa: es un asiento que pesa.' },
  ],
  enlaces: [
    { t: 'Leer la especificación', href: '/spec', primario: true },
    { t: 'Probar la app', href: '/app' },
    { t: 'Código en GitHub', href: 'https://github.com/Nicoiakl/nyx5' },
  ],
  pie: 'Implementación de referencia, sin dependencias, sobre Node y Cloudflare Workers · Apache-2.0',
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cards = C.cards.map((c) => `      <article><h3>${esc(c.t)}</h3><p>${c.d}</p></article>`).join('\n');
const botones = C.enlaces.map((e) => `<a class="btn${e.primario ? ' primary' : ''}" href="${e.href}">${esc(e.t)}</a>`).join('\n      ');
const jsonld = JSON.stringify({
  '@context': 'https://schema.org', '@type': 'SoftwareApplication',
  name: C.producto, applicationCategory: 'DeveloperApplication', operatingSystem: 'Node.js, Cloudflare Workers',
  description: `${C.hero} ${C.bajada}`.slice(0, 300), offers: { '@type': 'Offer', price: '0' },
  license: 'https://www.apache.org/licenses/LICENSE-2.0', url: 'https://nyx5.com',
});

const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(C.producto)} — ${esc(C.hero)}</title>
<meta name="description" content="${esc(C.hero + ' ' + C.bajada).slice(0, 300)}">
<link rel="canonical" href="https://nyx5.com/">
<meta property="og:title" content="${esc(C.producto)} — ${esc(C.hero)}">
<meta property="og:description" content="${esc(C.bajada).slice(0, 200)}">
<meta property="og:type" content="website">
<meta property="og:url" content="https://nyx5.com/">
<script type="application/ld+json">${jsonld}</script>
<style>
  :root { --bg:#0b0b0f; --panel:#131319; --ink:#eceaf2; --dim:#9a97a8; --line:#26262f; --accent:#8b7bff; --accent2:#c9a5ff; }
  * { box-sizing:border-box; }
  body { margin:0; background:radial-gradient(1200px 600px at 50% -10%, #1a1730 0%, var(--bg) 55%); color:var(--ink); font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; min-height:100vh; }
  a { color:var(--accent2); text-decoration:none; } a:hover { text-decoration:underline; }
  .wrap { max-width:920px; margin:0 auto; padding:34px 22px 90px; }
  header { display:flex; align-items:center; justify-content:space-between; }
  .mark { font-weight:700; letter-spacing:.02em; font-size:1.15rem; color:var(--ink); }
  .mark b { color:var(--accent); }
  nav a { color:var(--dim); margin-left:18px; font-size:.92rem; }
  .hero { margin:12vh 0 2.2rem; }
  .kicker { color:var(--accent2); font-size:.8rem; letter-spacing:.14em; text-transform:uppercase; margin-bottom:14px; }
  h1 { font-size:clamp(2.4rem,6vw,3.6rem); line-height:1.04; margin:0 0 .5rem; letter-spacing:-.02em; }
  h1 span { background:linear-gradient(90deg,var(--accent),var(--accent2)); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .lead { color:var(--dim); font-size:1.12rem; max-width:640px; }
  .btns { display:flex; flex-wrap:wrap; gap:12px; margin:2rem 0 1rem; }
  .btn { border:1px solid var(--line); background:var(--panel); color:var(--ink); padding:11px 18px; border-radius:10px; font-size:.95rem; }
  .btn.primary { background:linear-gradient(90deg,var(--accent),#6f5cf0); border-color:transparent; color:#fff; }
  .btn:hover { text-decoration:none; border-color:var(--accent); }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:16px; margin-top:5rem; }
  article { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:20px 20px 22px; }
  article h3 { margin:0 0 .5rem; font-size:1.05rem; }
  article p { color:var(--dim); font-size:.94rem; margin:0; }
  code { background:#00000055; border:1px solid var(--line); padding:.08em .38em; border-radius:5px; font:.86em ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--accent2); }
  footer { color:var(--dim); font-size:.86rem; margin-top:5rem; border-top:1px solid var(--line); padding-top:20px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="mark"><b>${esc(C.marca)}</b></div>
    <nav><a href="/spec">spec</a><a href="/app">app</a><a href="https://github.com/Nicoiakl/nyx5">github</a></nav>
  </header>

  <section class="hero">
    <div class="kicker">${esc(C.version)}</div>
    <h1><span>${esc(C.producto)}</span></h1>
    <p class="lead">${esc(C.hero)} ${esc(C.bajada)}</p>
    <div class="btns">
      ${botones}
    </div>
  </section>

  <section class="grid">
${cards}
  </section>

  <footer>${esc(C.pie)} · <span class="mark"><b>${esc(C.marca)}</b></span></footer>
</div>
</body>
</html>
`;

const outDir = path.join(root, 'docs/site');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'home.html'), html);
fs.writeFileSync(path.join(root, 'src/plataformas/home-html.js'),
  `// GENERADO por scripts/build-home.mjs — no editar a mano.\nexport const HOME_HTML = ${JSON.stringify(html)};\n`);
console.log(`home generada: ${(html.length / 1024).toFixed(1)} KB · marca "${C.marca}" · producto "${C.producto}"`);
