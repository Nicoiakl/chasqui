// node --test test/
// Adaptador x402 (transporte HTTP v2): que la casa hable el cable del estándar de "402 Payment
// Required" para agentes, y que lo que anuncia coincida con lo que el Libro hace de verdad.
//
// Lo que estas pruebas cuidan, y por qué:
//   - `amount` viaja como CADENA de unidades atómicas. Un number ahí es plata en coma flotante.
//   - `network` es un identificador CAIP-2 válido. Un dominio con puntos NO lo es, y por eso la
//     red es `nyx5:1` y la casa viaja en `payTo`.
//   - El 402 que anuncia un precio y el 202 que lo cobra dicen el MISMO número, y el recibo lleva
//     el id del asiento real: si el anuncio y el libro se separan, el adaptador está mintiendo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { signObject, uuid } from '../src/nucleo/crypto.js';
import * as x402 from '../src/puentes/x402.js';

// Puerto propio de esta suite (npm test corre los archivos en paralelo). Lo cuida test/puertos.test.js.
const P = 4221;
const H = 'x402.test';
const hosts = { [H]: { url: `http://127.0.0.1:${P}` } };
let tmp, casa, caro, gratis, pagador;

const sobre = (from, to, keys, extra = {}) => signObject({ nyx5: '1', id: uuid(), from, to: [to], created: new Date().toISOString(), type: 'message', content: { media: 'text/plain', body: 'x' }, ...extra }, keys);
const post = async (e) => {
  const r = await fetch(`${hosts[H].url}/inbound`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(e) });
  return { status: r.status, headers: r.headers, body: await r.json() };
};
const abrir = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-x402-'));
  casa = await new Estafeta({ domain: H, port: P, dataDir: path.join(tmp, H), adminToken: 't', hosts, workerIntervalMs: 120, libro: { welcome: 0, feeBps: 0 }, log: () => {} }).start();
  caro = Agent.create(`caro@${H}`, hosts[H].url, { hosts });
  gratis = Agent.create(`gratis@${H}`, hosts[H].url, { hosts });
  pagador = Agent.create(`pagador@${H}`, hosts[H].url, { hosts });
  await caro.register({ adminToken: 't', inbox: { policy: 'stamp', price: 7 } });
  await gratis.register({ adminToken: 't' });
  await pagador.register({ adminToken: 't' });
  await casa.libro.topup(pagador.address, 100, 'carga');
});
after(async () => { await casa.stop(); });

// ---------- el cable ----------

test('el importe viaja como cadena de unidades atómicas, nunca como número', () => {
  const pr = x402.requisitos({ url: 'https://x/y', amount: 250, payTo: `caro@${H}` });
  assert.equal(pr.accepts[0].amount, '250');
  assert.equal(typeof pr.accepts[0].amount, 'string');
  assert.throws(() => x402.requisitos({ url: 'https://x/y', amount: 2.5, payTo: 'a@b' }), /non-negative integer/);
  assert.throws(() => x402.validarRequisitos({ ...pr, accepts: [{ ...pr.accepts[0], amount: 250 }] }), /string of atomic units/);
});

test('la red es un identificador CAIP-2 válido y un dominio con puntos no lo sería', () => {
  assert.match(x402.RED, x402.CAIP2);
  assert.ok(!x402.CAIP2.test('nyx5:x402.test'), 'un punto no es legal en una reference CAIP-2');
  const pr = x402.requisitos({ url: 'https://x/y', amount: 1, payTo: `caro@${H}` });
  assert.throws(() => x402.validarRequisitos({ ...pr, accepts: [{ ...pr.accepts[0], network: `nyx5:${H}` }] }), /not a CAIP-2/);
  // La casa no se pierde: viaja en payTo, que ya es agente@dominio.
  assert.equal(pr.accepts[0].payTo.split('@')[1], H);
});

test('leer PAYMENT-SIGNATURE separa "no pagaste" (402) de "no se entiende" (400)', () => {
  assert.deepEqual(x402.leerPago(undefined), { ok: false, code: 402, reason: 'PAYMENT-SIGNATURE header is required' });
  assert.equal(x402.leerPago('no-es-base64-json').code, 400);
  const malaRed = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { network: 'eip155:1' }, payload: {} })).toString('base64');
  assert.match(x402.leerPago(malaRed).reason, /settles on nyx5:1/);
  const bueno = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { network: x402.RED }, payload: { envelope: 'x' } })).toString('base64');
  assert.equal(x402.leerPago(bueno).ok, true);
});

test('la liquidación lleva los tres campos obligatorios aunque no haya cadena', () => {
  const s = x402.liquidacion({ transaction: '', payer: `pagador@${H}` });
  for (const campo of ['success', 'transaction', 'network']) assert.ok(campo in s, `falta ${campo}`);
  assert.equal(s.transaction, '');
  assert.equal(s.network, x402.RED);
});

// ---------- la casa ----------

test('GET /x402/supported declara el scheme y la red de esta casa', async () => {
  const r = await fetch(`${hosts[H].url}/x402/supported`);
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.x402Version, 2);
  assert.equal(b.kinds[0].scheme, 'exact');
  assert.equal(b.kinds[0].network, x402.RED);
  assert.equal(b.kinds[0].extra.house, H);
  assert.ok(b.signers[x402.RED].length, 'la casa publica con qué clave firma');
});

test('un buzón con estampilla contesta 402 con el precio en la cabecera', async () => {
  const r = await fetch(`${hosts[H].url}/x402/inbox/caro`);
  assert.equal(r.status, 402);
  const pr = abrir(r.headers.get('payment-required'));
  assert.equal(pr.accepts[0].amount, '7');
  assert.equal(pr.accepts[0].payTo, `caro@${H}`);
  assert.equal(pr.resource.url, `https://${H}/x402/inbox/caro`);
  x402.validarRequisitos(pr); // lo que publicamos tiene que pasar nuestra propia validación
});

test('un buzón gratis lo dice, no da error: "no hay nada que pagar" es una respuesta', async () => {
  const r = await fetch(`${hosts[H].url}/x402/inbox/gratis`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).free, true);
  assert.equal((await fetch(`${hosts[H].url}/x402/inbox/nadie`)).status, 404);
});

test('entregar sin estampilla devuelve 402 y anuncia el mismo precio que cobra el Libro', async () => {
  const r = await post(sobre(pagador.address, caro.address, pagador.keys));
  assert.equal(r.status, 402);
  const pr = abrir(r.headers.get('payment-required'));
  assert.equal(pr.accepts[0].amount, '7', 'el 402 anuncia el precio real del buzón');
  assert.equal(pr.accepts[0].payTo, caro.address);
});

test('entregar con estampilla liquida y el recibo lleva el asiento real del Libro', async () => {
  const antes = await casa.libro.balance(caro.address);
  const r = await post(sobre(pagador.address, caro.address, pagador.keys, { stamp: { house: H, amount: 7 } }));
  assert.equal(r.status, 202);
  const s = abrir(r.headers.get('payment-response'));
  assert.equal(s.success, true);
  assert.equal(s.amount, '7');
  assert.equal(s.payer, pagador.address);
  assert.equal(s.network, x402.RED);
  // El id que publicamos como `transaction` tiene que existir en el diario: si no, es adorno.
  const diario = await casa.store.libroStatement(caro.address, 50);
  assert.ok(diario.some((e) => e.id === s.transaction), `el asiento ${s.transaction} no está en el diario`);
  assert.equal(await casa.libro.balance(caro.address), antes + 7);
});

test('el 402 no se cuela en un buzón normal: sin precio no hay cabecera de pago', async () => {
  const r = await post(sobre(pagador.address, gratis.address, pagador.keys));
  assert.equal(r.status, 202);
  assert.equal(r.headers.get('payment-required'), null);
  assert.equal(r.headers.get('payment-response'), null);
});
