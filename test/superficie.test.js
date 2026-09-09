// node --test test/
// La superficie pública del sitio: lo que ve un navegador, un rastreador y quien comparte un
// enlace. Nació de una auditoría externa que encontró cinco cosas rotas a la vez — HEAD daba 404
// (rompe las vistas previas de enlaces y los monitores de uptime), no había una sola cabecera de
// seguridad, ni caché, ni favicon, ni sitemap. Ninguna de ellas rompe una prueba de dominio: solo
// se ven desde fuera.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const worker = fs.readFileSync(path.join(raiz, 'src/plataformas/worker.js'), 'utf8');
const estafeta = fs.readFileSync(path.join(raiz, 'src/correo/estafeta.js'), 'utf8');

test('HEAD se atiende como GET y vuelve sin cuerpo', () => {
  assert.match(worker, /const esHead = request\.method === 'HEAD'/);
  assert.match(worker, /method: esHead \? 'GET' : request\.method/, 'HEAD debe entrar por la misma ruta que GET');
  assert.match(worker, /esHead \? null : cuerpo/, 'una respuesta a HEAD no lleva cuerpo');
});

test('toda respuesta lleva las cabeceras de seguridad, no solo algunas', () => {
  for (const h of ['strict-transport-security', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'content-security-policy']) {
    assert.match(worker, new RegExp(`'${h}'`), `falta la cabecera ${h}`);
  }
  // Se aplican en la única puerta de salida: repartidas por ruta, alguna se queda fuera y no se nota.
  assert.match(worker, /\.\.\.SEGURIDAD,/);
  assert.match(worker, /nosniff/);
  assert.match(worker, /frame-ancestors 'none'/);
});

test('lo autenticado no se cachea nunca, y lo público sí', () => {
  const m = worker.match(/function cacheDe\([\s\S]*?\n\}/);
  assert.ok(m, 'falta la política de caché');
  const fn = m[0];
  assert.match(fn, /return 'no-store'/, 'lo que no es GET/HEAD no se cachea');
  assert.match(fn, /\/\.well-known\/nyx5\.json/, 'la tarjeta del dominio es estable y se cachea');
  // Un buzón o el Libro compartidos entre dos agentes sería una fuga: deben caer al no-store final.
  for (const ruta of ['/mailbox/x', '/libro/cuenta/a@b', '/outbox/x']) {
    assert.ok(!new RegExp(`'${ruta}'`).test(fn), `${ruta} no puede aparecer como cacheable`);
  }
});

test('el sitio responde lo que un navegador y un rastreador piden siempre', () => {
  assert.match(estafeta, /path === '\/favicon\.ico'/, 'sin favicon el navegador se lleva un 404 en cada visita');
  assert.match(estafeta, /path === '\/robots\.txt'/);
  assert.match(estafeta, /path === '\/sitemap\.xml'/);
  // robots debe apuntar al sitemap y cerrar lo que exige firma.
  assert.match(estafeta, /Sitemap: https:\/\/\$\{this\.domain\}\/sitemap\.xml/);
  for (const priv of ['/mailbox/', '/libro/', '/outbox/']) assert.match(estafeta, new RegExp(`Disallow: ${priv}`));
});

test('la tarjeta del dominio se firma una vez, no en cada arranque', () => {
  // El defecto: cada instancia del Worker firmaba la suya, así que el mismo contenido salía con
  // otro `issued` y otra firma según a qué instancia cayeras. Ahora se compara el contenido.
  assert.match(estafeta, /const guardada = rec\.card/);
  assert.match(estafeta, /canonical\(previo\) === canonical\(cuerpo\)/, 'debe comparar el contenido sin issued ni firma');
  assert.match(estafeta, /await this\.store\.putDomain\(\{ \.\.\.rec, card \}\)/, 'la tarjeta firmada se persiste');
  assert.match(estafeta, /no se pudo guardar la tarjeta del dominio/, 'si no se puede guardar, se sirve igual');
});

test('el endpoint de trabajo habla el mismo idioma que el resto de lo público', () => {
  const bloque = estafeta.slice(estafeta.indexOf("path === '/tareas'"), estafeta.indexOf("path === '/tareas'") + 900);
  for (const es of ['mostrador:', 'arbitro:', 'por_agente_dia:', 'como:', 'tareas:']) {
    assert.ok(!bloque.includes(es), `/tareas devuelve "${es}" en español y lo lee un agente`);
  }
  for (const en of ['desk:', 'arbiter:', 'per_agent_per_day:', 'how:', 'tasks:']) assert.ok(bloque.includes(en), `falta ${en}`);
});

// La spec se renderiza desde markdown con un conversor propio. Dos defectos que una auditoría
// externa encontró y ninguna prueba veía: una celda de tabla partida por un `\|` escapado, y una
// lista numerada que se reiniciaba en 1 porque un bloque de código la cortaba en dos. En un
// documento con pasos ordenados, una numeración que vuelve a empezar dice algo falso.
test('el conversor respeta los pipes escapados y no parte las listas numeradas', async () => {
  const { SPEC_HTML } = await import('../src/plataformas/spec-html.js');
  // La celda con alternancia queda entera, sin backticks a la vista ni celdas de más.
  const fila = SPEC_HTML.match(/<tr><td>escrow<\/td>.*?<\/tr>/s);
  assert.ok(fila, 'falta la fila escrow de la tabla de contratos');
  assert.equal((fila[0].match(/<td>/g) || []).length, 3, 'la celda con `\\|` se partió en dos');
  assert.match(fila[0], /held → delivered → released \| refunded/);
  assert.ok(!/`/.test(fila[0]), 'quedaron backticks literales en la tabla');
  // La lista de descubrimiento es UNA sola, con sus tres pasos.
  const i = SPEC_HTML.indexOf('discovery-and-trust-anchor');
  const seccion = SPEC_HTML.slice(i, SPEC_HTML.indexOf('<h2', i + 10));
  assert.equal((seccion.match(/<ol/g) || []).length, 1, 'la lista numerada se partió en varias');
  assert.equal((seccion.match(/<li>/g) || []).length, 3);
});

test('ninguna referencia cruzada de la spec apunta a una sección que no existe', () => {
  const md = fs.readFileSync(path.join(raiz, 'docs/SPEC.md'), 'utf8');
  const existen = new Set([...md.matchAll(/^## (\d+)[.b]/gm)].map((m) => Number(m[1])));
  assert.ok(existen.size > 20, `se esperaban las secciones de la spec, se vieron ${existen.size}`);
  const rotas = [];
  for (const m of md.matchAll(/sections? (\d+)(?: to (\d+))?/g)) {
    for (const n of [m[1], m[2]]) if (n && !existen.has(Number(n))) rotas.push(`"${m[0]}" apunta a §${n}, que no existe`);
  }
  assert.deepEqual(rotas, [], rotas.join('\n  '));
});

// Un enlace compartido sin imagen se ve pelado y convierte peor. La imagen se genera y se sirve
// desde la casa, no desde un CDN: si dependiera de un tercero, el día que ese tercero falle el
// enlace se comparte roto y nadie se entera.
test('la vista previa al compartir está completa y la imagen la sirve la casa', async () => {
  const { HOME_HTML } = await import('../src/plataformas/home-html.js');
  const { SPEC_HTML } = await import('../src/plataformas/spec-html.js');
  for (const [nombre, h] of [['portada', HOME_HTML], ['spec', SPEC_HTML]]) {
    for (const etiqueta of ['og:title', 'og:description', 'og:image', 'og:url', 'twitter:card', 'twitter:image']) {
      assert.ok(h.includes(etiqueta), `${nombre} no declara ${etiqueta}`);
    }
    assert.match(h, /content="https:\/\/nyx5\.com\/og\.png"/, `${nombre} debe servir la imagen desde la casa`);
    assert.match(h, /twitter:card" content="summary_large_image"/);
  }
  // Y la casa la sirve de verdad, como PNG del tamaño que declara.
  const { OG_PNG_B64 } = await import('../src/plataformas/og-png.js');
  const png = Buffer.from(OG_PNG_B64, 'base64');
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'no es un PNG');
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  assert.match(estafeta, /path === '\/og\.png'/, 'la casa debe servir la imagen');
});

// La portada muestra cuántos agentes hay y cuánto trabajo está abierto, leído del libro en el
// momento. Convierte mejor que una promesa, pero solo si es verdad: un número inventado se
// vería igual y sería mentira. Y si no se puede leer, la línea desaparece en vez de tumbar
// la portada por un adorno.
test('la prueba de vida de la portada sale del libro y no rompe si falla', async () => {
  const { Estafeta } = await import('../src/correo/estafeta.js');
  const os = await import('node:os');
  const P2 = 4164;
  const casa = new Estafeta({
    domain: 'v2.test', port: P2, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-vivo-')),
    adminToken: 't', hosts: { 'v2.test': { url: `http://127.0.0.1:${P2}` } }, workerIntervalMs: 5000,
    policy: { registration: 'open' }, log: () => {},
  });
  await casa.start();
  try {
    const leer = async () => (await casa.handleRequest({ method: 'GET', path: '/', query: new URLSearchParams(), headers: {}, body: null })).body;
    // Sin agentes propios (solo los de sistema, que no cuentan): dice 0 y no revienta.
    assert.match(await leer(), /<b>0<\/b> agents in this house/);
    assert.ok(!/<!--VIVO-->/.test(await leer()), 'el hueco debe quedar sustituido siempre');
    // Con uno, concuerda en singular: un contador que dice "1 agents" delata que es de adorno.
    const { join } = await import('../src/correo/unirse.js');
    await join({ house: 'v2.test', hosts: { 'v2.test': { url: `http://127.0.0.1:${P2}` } }, name: 'solo' });
    assert.match(await leer(), /<b>1<\/b> agent in this house/);
    // Si el almacén falla, la portada se sirve igual y sin la línea.
    const original = casa.store.listAgents.bind(casa.store);
    casa.store.listAgents = async () => { throw new Error('almacén caído'); };
    const rota = await leer();
    assert.match(rota, /Your agent has no address/, 'la portada se sirve aunque el libro no responda');
    assert.ok(!/agent in this house/.test(rota), 'sin datos, no se inventa la línea');
    casa.store.listAgents = original;
  } finally { await casa.stop(); }
});
