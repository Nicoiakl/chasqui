// node --test test/
// El sprint "join · mandate · verifica · libro como reputación": lo que hace que un agente
// entre solo, reciba presupuesto acotado, y quede con un historial que otro pueda leer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { join, mandate, nombreSugerido, bloqueMcp } from '../src/correo/unirse.js';
import { MEDIA } from '../src/libro/libro.js';

// Puerto propio de esta suite. `npm test` corre los archivos EN PARALELO: dos suites con el
// mismo puerto se cuelgan sin decir por qué. Lo cuida test/puertos.test.js.
const P = 4191;
const hosts = { 'casa.test': { url: `http://127.0.0.1:${P}` } };
let tmp, casa;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-join-'));
  casa = new Estafeta({
    domain: 'casa.test', port: P, dataDir: path.join(tmp, 'casa.test'), adminToken: 't', hosts,
    workerIntervalMs: 100, policy: { registration: 'open', registrations_per_minute: 200 }, libro: { welcome: 500, feeBps: 1000 }, log: () => {},
  });
  await casa.start();
});
after(async () => { await casa.stop(); });

test('join: un agente entra en un paso, sin humano y sin cuenta', async () => {
  const r = await join({ house: 'casa.test', hosts });
  assert.match(r.address, /^agente-[0-9a-f]{8}@casa\.test$/);
  // La tarjeta la certifica el dominio y la llave privada nunca salió de aquí.
  assert.equal(r.card.address, r.address);
  assert.ok(r.card.certification, 'la tarjeta viene certificada por la casa');
  assert.ok(r.keys.sig && r.keys.enc);
  // Saldo de bienvenida y buzón vivo: el primer sobre está entregado, no prometido.
  assert.equal(r.balance.balance, 500);
  const buzon = await r._agente.inbox();
  assert.equal(buzon.length, 1, 'el sobre de bienvenida llegó al buzón');
  const abierto = await r._agente.open(buzon[0].envelope);
  assert.equal(abierto.from, r.address);
  assert.match(abierto.content.body, /Esta es tu dirección/);
});

test('join: no aparece en el directorio salvo que lo pida (opt-in)', async () => {
  const callado = await join({ house: 'casa.test', hosts, name: 'callado' });
  const visible = await join({ house: 'casa.test', hosts, name: 'visible', listed: true });
  const dir = await callado._agente.directory();
  const nombres = dir.agents.map((a) => a.address);
  assert.ok(nombres.includes(visible.address), 'el que pidió ser listado aparece');
  assert.ok(!nombres.includes(callado.address), 'el que no lo pidió, no');
});

test('join: el nombre pedido falla ruidoso si está tomado; el sugerido reintenta', async () => {
  await join({ house: 'casa.test', hosts, name: 'unico' });
  await assert.rejects(() => join({ house: 'casa.test', hosts, name: 'unico' }), (e) => e.status === 409);
  // Un nombre reservado por el protocolo se rechaza antes de salir a la red.
  await assert.rejects(() => join({ house: 'casa.test', hosts, name: 'libro' }), /reservado/);
  await assert.rejects(() => join({ house: 'casa.test', hosts, name: 'MAYUS' }), /inválido/);
});

test('el bloque MCP que emite join es el que un cliente puede pegar', () => {
  const b = bloqueMcp({ address: 'x@casa.test', keyfile: '/tmp/x.json' });
  assert.deepEqual(b.mcpServers.nyx5.args, ['-y', '@nyx5/nyx5', 'mcp', '--agent', '/tmp/x.json']);
  assert.equal(b.mcpServers.nyx5.command, 'npx');
  assert.notEqual(nombreSugerido('claude'), nombreSugerido('claude'));
});

test('mandate: el agente contrata dentro del tope y la casa rechaza fuera', async () => {
  const humano = await join({ house: 'casa.test', hosts, name: 'humano' });
  const bot = await join({ house: 'casa.test', hosts, name: 'bot' });
  const r = await mandate(humano._agente, { grantee: bot.address, cap: 300 });
  assert.ok(r.mandate?.id, 'el mandato vuelve confirmado por el recibo del Libro, no por optimismo');
  assert.equal(r.mandate.cap, 300);
  assert.equal(r.mandate.grantor, humano.address);
  assert.equal(r.mandate.grantee, bot.address);

  // Dentro del tope: cobra y paga el mandante.
  const antes = (await humano._agente.balance()).balance;
  const cobro = await bot._agente.charge('casa.test', { mandate: r.mandate.id, amount: 120, concept: 'un informe' });
  await bot._agente.awaitReceipt(cobro.id);
  assert.equal((await humano._agente.balance()).balance, antes - 120, 'el que paga es el mandante, no el agente');

  // Fuera del tope: la casa rechaza y el rebote del postmaster dice por qué, con el monto exacto.
  const exceso = await bot._agente.charge('casa.test', { mandate: r.mandate.id, amount: 500, concept: 'de más' });
  const rebote = await bot._agente.waitFor((e) => e.in_reply_to === exceso.id && e.from.startsWith('postmaster@'), { timeoutMs: 5000 });
  const cuerpo = (await bot._agente.open(rebote.envelope)).content.body;
  assert.equal(cuerpo.status, 'failed');
  assert.match(cuerpo.reason, /quedan 180, se piden 500/);
  assert.equal((await humano._agente.balance()).balance, antes - 120, 'el intento fuera de tope no movió nada');
});

test('mandate: un tope no entero o no positivo se rechaza antes de salir', async () => {
  const a = await join({ house: 'casa.test', hosts, name: 'validador' });
  await assert.rejects(() => mandate(a._agente, { grantee: 'x@casa.test', cap: 0 }), /tope entero y positivo/);
  await assert.rejects(() => mandate(a._agente, { grantee: 'x@casa.test', cap: 1.5 }), /tope entero y positivo/);
  await assert.rejects(() => mandate(a._agente, { cap: 10 }), /--grantee/);
});

test('historial: es público, empieza vacío, y solo cuenta lo que movió tokens', async () => {
  const vendedor = await join({ house: 'casa.test', hosts, name: 'vendedor' });
  const comprador = await join({ house: 'casa.test', hosts, name: 'comprador' });

  // Vacío no miente: cumplimiento null, no 100 %.
  const cero = await vendedor._agente.historial();
  assert.equal(cero.resumen.entregas, 0);
  assert.equal(cero.resumen.cumplimiento, null, 'cero de cero no es cumplimiento perfecto');
  assert.equal(cero.total_movido, 0);

  // Un escrow abierto NO cuenta como entrega: cuenta cuando el asiento se libera.
  // La cotización viaja CIFRADA (invariante 8): no se puede filtrar desde fuera, hay que abrirla.
  const cot = await vendedor._agente.quote({ to: comprador.address, contract: 'escrow', price: 100, concept: 'un trabajo', terms: { acceptance: 'endpoint 200' } });
  const enviado = await comprador._agente.waitFor((e) => e.from === vendedor.address && e.type === 'message', { timeoutMs: 5000 });
  const abierta = await comprador._agente.open(enviado.envelope);
  assert.equal(abierta.content.media, MEDIA.cotizacion);
  const aceptada = await comprador._agente.accept(abierta.content.body);
  await comprador._agente.awaitReceipt(aceptada.id);
  assert.ok(cot.id);

  const enVuelo = await vendedor._agente.historial();
  assert.equal(enVuelo.resumen.entregas, 0, 'retenido no es entregado');
  assert.equal(enVuelo.abiertos.n, 1);

  // Se libera: recién ahí cuenta, y con el monto.
  const contrato = (await comprador._agente.balance()).contracts.find((c) => c.kind === 'escrow');
  const rel = await comprador._agente.release('casa.test', contrato.id);
  await comprador._agente.awaitReceipt(rel.id);

  const final = await vendedor._agente.historial();
  assert.equal(final.resumen.entregas, 1);
  assert.equal(final.vendiendo.entregas_aceptadas.tokens, 100);
  assert.equal(final.resumen.cumplimiento, 1);
  assert.equal(final.resumen.total_movido, 100);

  // Público: un desconocido lo lee sin autenticarse. Ese es el punto entero.
  const res = await fetch(`http://127.0.0.1:${P}/agents/vendedor/historial`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).resumen.entregas, 1);
  assert.equal((await fetch(`http://127.0.0.1:${P}/agents/fantasma/historial`)).status, 404);
});

test('historial: una fianza ejecutada queda registrada como afirmación derribada', async () => {
  const afirmante = await join({ house: 'casa.test', hosts, name: 'afirmante' });
  const verificador = await join({ house: 'casa.test', hosts, name: 'verificador' });
  const puesta = await afirmante._agente.bond('casa.test', { amount: 50, claim: 'desplegado y verificado', verifier: verificador.address });
  const rec = await afirmante._agente.awaitReceipt(puesta.id);
  const id = rec.receipt.contract.id;

  const enPie = await afirmante._agente.historial();
  assert.equal(enPie.resumen.tokens_en_juego_ahora, 50, 'la fianza vigente se ve como tokens en juego');
  assert.equal(enPie.resumen.afirmaciones_con_fianza, 0, 'todavía no es historial: no se resolvió');

  const caida = await verificador._agente.forfeit('casa.test', id, 'el endpoint /health responde 500');
  await verificador._agente.awaitReceipt(caida.id);

  const h = await afirmante._agente.historial();
  assert.equal(h.resumen.fianzas_perdidas, 1);
  assert.equal(h.afirmando.fianzas_ejecutadas.tokens, 50);
  assert.equal(h.resumen.veracidad, 0, 'una de una derribada es veracidad 0');
  assert.equal(h.resumen.tokens_en_juego_ahora, 0);
});
