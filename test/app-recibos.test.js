// node --test test/
// El botón de tokens convierte un recibo en una frase ("X sent you 1,000 tokens"). Defecto
// encontrado en la revisión del 11-sep-2026, ANTES de publicar: la app lo hacía con cualquier
// mensaje que tuviera forma de recibo, así que un extraño podía fingir un pago y pedir algo a
// cambio. Esta prueba corre la función REAL de la app, extraída de web/app.html, no una copia.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../web/app.html', import.meta.url), 'utf8');
const ini = html.indexOf('function textoDe(c, de) {');
const fin = html.indexOf('\n}\n', ini);
const textoDe = ini > 0 && fin > ini
  ? new Function('ID', 'DOMINIO', `${html.slice(ini, fin + 2)}; return textoDe;`)({ address: 'pauli@nyx5.com' }, 'nyx5.com')
  : null;
const recibo = { media: 'application/nyx5.recibo+json', body: { pay: { from: 'nico@nyx5.com', to: 'pauli@nyx5.com', amount: 1000 } } };

test('app: textoDe(c, de) existe en web/app.html (sin ella esta prueba no protege nada)', () => {
  assert.equal(typeof textoDe, 'function');
});

test('app: un recibo que firmó libro@ de la casa se lee como pago', () => {
  assert.match(textoDe(recibo, 'libro@nyx5.com'), /^nico@nyx5\.com sent you 1[.,]?000 tokens\.$/);
});

test('app: el mismo recibo escrito por cualquier otro NO se lee como pago, ni como rechazo, ni como orden', () => {
  for (const de of ['extrano@nyx5.com', 'nico@nyx5.com', 'libro@otra.casa', 'libro@nyx5.com.evil', undefined]) {
    assert.doesNotMatch(textoDe(recibo, de), /sent you|You sent/, `${de} pudo fingir un pago`);
  }
  const rechazo = { body: { reason: 'rejected (402): insufficient balance' } };
  assert.match(textoDe(rechazo, 'postmaster@nyx5.com'), /^Not done: /);
  assert.doesNotMatch(textoDe(rechazo, 'extrano@nyx5.com'), /^Not done: /);
  const orden = { body: { op: 'pay', to: 'x@nyx5.com', amount: 5 } };
  assert.match(textoDe(orden, 'pauli@nyx5.com'), /^Payment order: /, 'la orden propia se lee como orden');
  assert.doesNotMatch(textoDe(orden, 'extrano@nyx5.com'), /^Payment order: /);
});
