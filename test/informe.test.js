// node --test test/
// El libro de la casa en público. Lo que hay que cuidar no es el diseño: es que pueda decir
// cosas incómodas. Un informe que solo sabe dar buenas noticias no es un informe, y en un
// sistema cuya tesis es que una afirmación cuesta algo, eso sería la peor contradicción posible.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { join, mandate } from '../src/correo/unirse.js';
import { datosInforme, lecturas, informeHtml } from '../src/libro/informe.js';

const P = 4201;
const hosts = { 'i2.test': { url: `http://127.0.0.1:${P}` } };
let tmp, casa;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-informe-'));
  casa = new Estafeta({
    domain: 'i2.test', port: P, dataDir: path.join(tmp, 'casa'), adminToken: 't', hosts,
    workerIntervalMs: 100, policy: { registration: 'open', registrations_per_minute: 200 },
    libro: { welcome: 1000, feeBps: 1000 }, log: () => {},
  });
  await casa.start();
});
after(async () => { await casa.stop(); });

test('una casa sin actividad lo dice, en vez de maquillarlo', async () => {
  const d = await datosInforme(casa, { dias: 7 });
  assert.equal(d.altas, 0);
  assert.equal(d.mandatos, 0);
  const texto = lecturas(d).join(' ');
  assert.match(texto, /Nobody joined/, 'con cero altas, el informe lo dice');
  assert.match(texto, /No escrow was resolved/, 'y dice que el mecanismo no se ejerció');
  assert.ok(!/[áéíóúñ]/.test(texto), 'el informe es público, va en inglés');
});

test('con altas y sin mandatos, señala que se avanza en la mitad equivocada', async () => {
  await join({ house: 'i2.test', hosts, name: 'unagente' });
  await join({ house: 'i2.test', hosts, name: 'dosagente' });
  const texto = lecturas(await datosInforme(casa, { dias: 7 })).join(' ');
  assert.match(texto, /agents joined and no human put up a budget/);
  assert.match(texto, /wrong half/, 'la métrica que manda son los mandatos, y hay que decirlo');
});

test('cuando hay mandatos y entregas, cuenta lo que de verdad se movió', async () => {
  const humano = await join({ house: 'i2.test', hosts, name: 'jefa2' });
  const bot = await join({ house: 'i2.test', hosts, name: 'bot2' });
  await mandate(humano._agente, { grantee: bot.address, cap: 500 });

  // Un escrow que se libera y otro que se devuelve: el informe debe contar los dos.
  const vistos = new Set();
  for (const [precio, liberar] of [[100, true], [60, false]]) {
    await bot._agente.quote({ to: humano.address, contract: 'escrow', price: precio, concept: `trabajo ${precio}` });
    // Hay que abrir para distinguir: la cotización viaja cifrada, así que filtrar por remitente
    // devolvía el sobre de la vuelta anterior y se aceptaba dos veces la misma.
    const sobre = await humano._agente.waitFor((e) => e.from === bot.address && e.type === 'message' && !vistos.has(e.id), { timeoutMs: 5000 });
    vistos.add(sobre.envelope.id);
    const q = (await humano._agente.open(sobre.envelope)).content.body;
    assert.equal(q.price, precio, 'se abrió la cotización que toca');
    await humano._agente.awaitReceipt((await humano._agente.accept(q)).id);
    const c = (await humano._agente.balance()).contracts.find((x) => x.kind === 'escrow' && x.amount === precio);
    const op = liberar ? humano._agente.release('i2.test', c.id) : humano._agente.refund('i2.test', c.id, 'no sirvió');
    await humano._agente.awaitReceipt((await op).id);
  }

  const d = await datosInforme(casa, { dias: 7 });
  assert.equal(d.mandatos, 1);
  assert.equal(d.liberados, 1);
  assert.equal(d.tokensLiberados, 100);
  assert.equal(d.devueltos, 1);
  assert.equal(d.tokensDevueltos, 60);
  const texto = lecturas(d).join(' ');
  // Sin fijar el número de altas: lo que importa es que cuente los mandatos y las cuente a ambas.
  assert.match(texto, /1 mandate against \d+ joins/);
  assert.match(texto, /50 % of resolved escrows ended up paying/);
});

test('el informe no expone nombres, contrapartes ni contenido', async () => {
  const html = informeHtml('i2.test', await datosInforme(casa, { dias: 7 }));
  for (const privado of ['jefa2@', 'bot2@', 'uno@', 'trabajo 100', 'no sirvió']) {
    assert.ok(!html.includes(privado), `el informe filtra "${privado}"`);
  }
  // Y apunta a donde SÍ se puede mirar a alguien en concreto.
  assert.match(html, /agents\/&lt;name&gt;\/historial/);
  assert.match(html, /<html lang="en">/);
});

test('la ruta pública responde, acota el rango y no se cae si el libro falla', async () => {
  const pedir = (p) => casa.handleRequest({ method: 'GET', path: p.split('?')[0], query: new URLSearchParams(p.split('?')[1] || ''), headers: {}, body: null });
  const r = await pedir('/report');
  assert.equal(r.status, 200);
  assert.match(r.body, /The ledger of i2\.test/);
  // Un rango absurdo se acota en vez de barrer el libro entero.
  assert.match((await pedir('/report?days=99999')).body, /Last 90 days/);
  assert.match((await pedir('/report?days=abc')).body, /Last 7 days/);
  assert.equal((await pedir('/report.json')).status, 200);

  // Si el libro no se puede leer, lo dice: no publica un informe vacío que parezca real.
  const original = casa.store.libroListContracts.bind(casa.store);
  casa.store.libroListContracts = async () => { throw new Error('libro caído'); };
  const roto = await pedir('/report');
  assert.equal(roto.status, 503);
  assert.match(roto.body.reason, /could not be read/);
  casa.store.libroListContracts = original;
});
