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
