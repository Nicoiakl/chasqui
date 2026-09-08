// node --test test/
// Las descripciones del conector MCP son lo único que el modelo lee para decidir si usa Nyx5.
// No son documentación: son la capacidad + la garantía + el momento de uso (brief D1).
// Este test es la guardia que impide que vuelvan a ser "documentación de API".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/puentes/mcp.js', import.meta.url), 'utf8');
// extrae { name, description } de cada herramienta
const tools = [...src.matchAll(/\{ name: '([a-z0-9_]+)', description: '((?:[^'\\]|\\.)*)'/g)]
  .map((m) => ({ name: m[1], description: m[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\') }));

// una garantía del sistema que un modelo no obtiene de otra forma
const GARANTIA = /firma|firmad|buzón|asiento|recibo|reteni|retén|verific|certific|cifr|descifr|irreversible|hash|negar/i;
// palabra que ancla el MOMENTO de uso o la capacidad (no el mecanismo)
const CAPACIDAD = /úsalo|cuando|encuentra|delega|ofréce|acepta|comprueba|mueve|aunque|no sabes|no conoces|antes de|revísa|revisa|consúlta|consulta/i;

test('D1 · hay 17 herramientas y ninguna description quedó como la vieja documentación de API', () => {
  assert.equal(tools.length, 17, `se esperaban 17 herramientas, hay ${tools.length}`);
  // ninguna debe empezar describiendo el mecanismo ("Envía un sobre...", "Operación genérica...")
  for (const t of tools) {
    assert.ok(!/^(Envía un sobre|Operación genérica del Libro|Lee los sobres pendientes)/.test(t.description),
      `${t.name} sigue describiendo el mecanismo, no la capacidad`);
  }
});

test('D1 · cada description declara una garantía del sistema', () => {
  for (const t of tools) {
    assert.ok(GARANTIA.test(t.description), `${t.name} no menciona ninguna garantía (firma/buzón/asiento/recibo/retención/verificación/hash)`);
  }
});

test('D1 · cada description nombra el momento de uso o la capacidad, no solo el mecanismo', () => {
  for (const t of tools) {
    assert.ok(CAPACIDAD.test(t.description), `${t.name} no nombra cuándo usarla ni qué desbloquea`);
  }
});

test('D1 · las descripciones son cortas (presupuesto de atención); libro es la única router', () => {
  for (const t of tools) {
    const tope = t.name === 'nyx5_libro' ? 650 : 340; // libro lleva la lista de ops
    assert.ok(t.description.length <= tope, `${t.name}: ${t.description.length} chars supera ${tope}`);
  }
});

test('D1 · instructions describe el sistema en pocas frases con capacidad y garantía, sin listar herramientas', () => {
  const m = src.match(/instructions: `([^`]*)`/);
  assert.ok(m, 'falta instructions');
  const inst = m[1];
  assert.ok(GARANTIA.test(inst), 'instructions no menciona una garantía');
  assert.ok(CAPACIDAD.test(inst) || /necesites/.test(inst), 'instructions no dice cuándo conviene usarlo');
  assert.ok(!/nyx5_send|nyx5_inbox|tools\/list/.test(inst), 'instructions no debe listar herramientas (eso lo hace tools/list)');
  assert.ok(inst.length <= 700, `instructions demasiado largo: ${inst.length}`);
});

// La spec pública en dos idiomas, con el inglés como canónico (decisión de Nicholas, 8-sep-2026).
// El guard existe porque el fallo sería invisible: /es sirviendo inglés se ve igual de bien.
test('la spec se sirve en inglés (canónica) y en español, y cada una enlaza a la otra', async () => {
  const { SPEC_HTML, SPEC_HTML_ES, LLMS_TXT } = await import('../src/plataformas/spec-html.js');
  assert.match(SPEC_HTML, /<html lang="en">/);
  assert.match(SPEC_HTML_ES, /<html lang="es">/);
  assert.match(SPEC_HTML, /Mail and Libro for agents/);
  assert.match(SPEC_HTML_ES, /Correo y Libro para agentes/);
  // La canónica de cada página apunta a SU url, no las dos a la misma.
  assert.match(SPEC_HTML, /<link rel="canonical" href="https:\/\/nyx5\.com\/spec">/);
  assert.match(SPEC_HTML_ES, /<link rel="canonical" href="https:\/\/nyx5\.com\/es">/);
  // hreflang en ambas, con el inglés como x-default.
  for (const h of [SPEC_HTML, SPEC_HTML_ES]) {
    assert.match(h, /hreflang="en" href="https:\/\/nyx5\.com\/spec"/);
    assert.match(h, /hreflang="es" href="https:\/\/nyx5\.com\/es"/);
    assert.match(h, /hreflang="x-default" href="https:\/\/nyx5\.com\/spec"/);
  }
  assert.match(SPEC_HTML, /href="\/es"/);
  assert.match(SPEC_HTML_ES, /href="\/spec"/);
  // Ninguna puede haber quedado con el nombre viejo.
  for (const h of [SPEC_HTML, SPEC_HTML_ES, LLMS_TXT]) assert.ok(!/chasqui/i.test(h), 'quedó una mención al nombre viejo');
  // Y las dos tienen que traer el sprint: si alguien regenera desde una spec vieja, esto falla.
  assert.match(SPEC_HTML, /reputation is a query on the ledger/);
  assert.match(SPEC_HTML_ES, /la reputación es una consulta al libro/);
});

// La portada tiene UN trabajo: que un agente se una. El guard cuida lo que no se ve a simple
// vista — que cada idioma sirva el suyo, que el comando prometido exista, y que no se llene de
// cosas. Una portada que crece deja de convertir y nadie se entera.
test('la portada apunta a que un agente se una, en los dos idiomas', async () => {
  const { HOME_HTML, HOME_HTML_ES } = await import('../src/plataformas/home-html.js');
  assert.match(HOME_HTML, /<html lang="en">/);
  assert.match(HOME_HTML_ES, /<html lang="es">/);
  assert.match(HOME_HTML, /<link rel="canonical" href="https:\/\/nyx5\.com\/">/);
  assert.match(HOME_HTML_ES, /<link rel="canonical" href="https:\/\/nyx5\.com\/es-home">/);
  // Cada idioma dice lo suyo y no el del otro.
  assert.match(HOME_HTML, /Your agent has no address/);
  assert.match(HOME_HTML_ES, /Tu agente no tiene dirección/);
  assert.ok(!/Tu agente no tiene/.test(HOME_HTML), 'la inglesa no puede traer texto español');
  assert.ok(!/Your agent has no/.test(HOME_HTML_ES), 'la española no puede traer texto inglés');

  const fs = await import('node:fs');
  const cli = fs.readFileSync(new URL('../bin/nyx5.js', import.meta.url), 'utf8');
  for (const h of [HOME_HTML, HOME_HTML_ES]) {
    // El comando es lo único que la portada pide hacer, y tiene que existir de verdad.
    assert.match(h, /npx @nyx5\/nyx5 join/);
    assert.ok(!/chasqui/i.test(h), 'quedó una mención al nombre viejo');
    // Minimalista de verdad, medido: una sola llamada a la acción y una portada que cabe.
    assert.equal((h.match(/npx @nyx5\/nyx5/g) || []).length, 1, 'un solo comando; dos ya es un menú');
    assert.ok(h.length < 9000, `la portada pesa ${h.length} bytes: está creciendo`);
    assert.equal((h.match(/<h1/g) || []).length, 1);
    assert.ok(!/<h2|<h3/.test(h), 'sin secciones: si necesita subtítulos, ya no es una portada');
  }
  assert.match(cli, /case 'join':/, 'el CLI implementa lo que la portada promete');
  // Cada portada apunta a la spec en SU idioma.
  assert.match(HOME_HTML, /href="\/spec"/);
  assert.match(HOME_HTML_ES, /href="\/es"/);
});
