// node --test test/
// Trabajo sembrado: la casa es el primer comprador. Lo que se prueba es el criterio de
// "publicado" del sprint — un agente recién unido toma una tarea, entrega, y el asiento se
// libera sin que un humano toque nada — y que las defensas contra Sybil no son decorativas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Estafeta } from '../src/correo/estafeta.js';
import { join } from '../src/correo/unirse.js';
import { Tareas, normalizarTarea } from '../src/libro/tareas.js';
import { MEDIA } from '../src/libro/libro.js';

const P = 4181;
const hosts = { 't.test': { url: `http://127.0.0.1:${P}` } };
let tmp, casa, mundo, mundoPort, estado = 200;

const catalogo = () => [
  { id: 'ping', concept: 'comprobar que el faro responde', price: 50, verify: { type: 'http_status', url: `https://127.0.0.1:${mundoPort}/faro` }, instructions: 'entrega cuando lo hayas comprobado' },
  { id: 'otra', concept: 'segunda tarea', price: 30, verify: { type: 'http_status', url: `https://127.0.0.1:${mundoPort}/faro` } },
];

// El verificador apunta a https en el catálogo; el mundo de prueba es http local.
const parchearFetch = () => { casa.fetch = async (u, o) => fetch(String(u).replace('https://127.0.0.1', 'http://127.0.0.1'), o); };

// Un agente toma una tarea: cotiza al mostrador con los términos publicados, tal cual.
async function tomar(agente, tarea, extra = {}) {
  const pub = await (await fetch(`http://127.0.0.1:${P}/tareas`)).json();
  const t = pub.tareas.find((x) => x.id === tarea);
  return agente.quote({
    to: pub.mostrador, contract: 'escrow', price: extra.price ?? t.price, concept: t.concept,
    arbiter: extra.arbiter === null ? undefined : (extra.arbiter || pub.arbitro),
    terms: extra.terms || t.terms,
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-tareas-'));
  mundo = http.createServer((q, r) => { r.writeHead(estado); r.end('faro'); });
  await new Promise((r) => mundo.listen(0, '127.0.0.1', r));
  mundoPort = mundo.address().port;
  casa = new Estafeta({
    domain: 't.test', port: P, dataDir: path.join(tmp, 't.test'), adminToken: 't', hosts,
    workerIntervalMs: 100, policy: { registration: 'open', registrations_per_minute: 200 },
    libro: { welcome: 100, feeBps: 1000 }, tareas: { catalogo: catalogo(), porAgenteDia: 1, porDia: 50 }, log: () => {},
  });
  await casa.start();
  // La casa necesita fondos para comprar: en producción los emite ella misma.
  await casa.libro.topup(`tareas@t.test`, 5000, 'presupuesto de trabajo sembrado');
});
after(async () => { await casa.stop(); await new Promise((r) => mundo.close(r)); });

test('una tarea sin prueba de aceptación no se puede publicar', () => {
  assert.throws(() => normalizarTarea({ id: 'x', concept: 'algo', price: 10 }), /sin prueba no se paga/);
  assert.throws(() => normalizarTarea({ id: 'x', concept: 'algo', price: 0, verify: { type: 'http_status' } }), /precio entero positivo/);
  assert.throws(() => normalizarTarea({ concept: 'algo' }), /necesita id y concept/);
});

test('el catálogo es público y publica la prueba entera, no solo el precio', async () => {
  const res = await fetch(`http://127.0.0.1:${P}/tareas`);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.mostrador, 'tareas@t.test');
  assert.equal(j.arbitro, 'verifica@t.test');
  const ping = j.tareas.find((t) => t.id === 'ping');
  assert.equal(ping.price, 50);
  assert.equal(ping.verify[0].type, 'http_status', 'quien va a trabajar puede leer con qué se le va a comprobar');
  assert.equal(ping.terms.seed_task, 'ping');
});

test('criterio de publicado: se une, toma, entrega y cobra sin que un humano toque nada', async () => {
  const a = await join({ house: 't.test', hosts, name: 'recien' });
  estado = 200;
  const saldoInicial = (await a._agente.balance()).balance;

  await tomar(a._agente, 'ping');
  // El recibo del Libro responde al sobre con que la CASA aceptó, no a la cotización del agente.
  const recibo = await a._agente.waitFor((e) => e.from === 'libro@t.test', { timeoutMs: 5000 });
  const contrato = (await a._agente.open(recibo.envelope)).content.body.contract;
  assert.equal(contrato.kind, 'escrow');
  assert.equal(contrato.seller, a.address, 'el vendedor es el agente, con su propia llave');
  assert.equal(contrato.buyer, 'tareas@t.test', 'la casa es la compradora');
  assert.equal(contrato.state, 'held', 'los tokens quedan retenidos antes de que trabaje');

  // Entrega y el cron verifica. Nadie aprueba a mano.
  const entrega = await a._agente.deliver('t.test', contrato.id, { note: 'comprobado' });
  await a._agente.awaitReceipt(entrega.id);
  parchearFetch();
  await casa.tick();
  await a._agente.waitFor((e) => e.thread === contrato.id && e.from === 'libro@t.test' && e.id !== recibo.envelope.id, { timeoutMs: 5000 });

  const fin = await a._agente.contract('t.test', contrato.id);
  assert.equal(fin.state, 'released');
  assert.equal(fin.acp.phase, 'Terminal');
  assert.equal((await a._agente.balance()).balance, saldoInicial + 45, '50 menos el 10% de la casa');
  // Y lo que importa: ahora tiene historial que otro puede leer.
  const h = await a._agente.historial();
  assert.equal(h.resumen.entregas, 1);
  assert.equal(h.resumen.cumplimiento, 1);
  assert.equal((await casa.store.listEvents({ name: 'seed_task_taken' })).at(-1).data.task, 'ping');
});

test('si la prueba falla, la casa recupera su presupuesto y el intento queda en el historial', async () => {
  const a = await join({ house: 't.test', hosts, name: 'apurado' });
  estado = 500;
  const antes = (await a._agente.balance()).balance;
  await tomar(a._agente, 'ping');
  const recibo = await a._agente.waitFor((e) => e.from === 'libro@t.test', { timeoutMs: 5000 });
  const contrato = (await a._agente.open(recibo.envelope)).content.body.contract;
  const entrega = await a._agente.deliver('t.test', contrato.id, { note: 'listo (mentira)' });
  await a._agente.awaitReceipt(entrega.id);
  parchearFetch();
  await casa.tick();
  await a._agente.waitFor((e) => e.thread === contrato.id && e.id !== recibo.envelope.id, { timeoutMs: 5000 });

  assert.equal((await a._agente.contract('t.test', contrato.id)).state, 'refunded');
  assert.equal((await a._agente.balance()).balance, antes, 'no cobró un token por afirmar');
  assert.equal((await a._agente.historial()).resumen.entregas_falladas, 1);
  estado = 200;
});

test('Sybil: tope por agente y día, una a la vez, y cada tarea se paga una vez', async () => {
  const t = new Tareas({ catalogo: catalogo(), porAgenteDia: 1, porDia: 3 });
  const tarea = t.tarea('ping');
  const hoy = new Date().toISOString().slice(0, 10);
  const c = (extra) => ({ created: `${hoy}T10:00:00.000Z`, terms: { seed_task: 'ping' }, seller: 'x@t.test', state: 'released', ...extra });

  assert.equal(t.cupo(tarea, 'x@t.test', []).ok, true);
  assert.match(t.cupo(tarea, 'x@t.test', [c({})]).reason, /tope por agente es 1/);
  // Con una en curso, el mensaje accionable gana: "termínala" antes que "vuelve mañana".
  assert.match(t.cupo(tarea, 'x@t.test', [c({ state: 'held' })]).reason, /en curso/);
  assert.match(t.cupo(tarea, 'y@t.test', [c({ seller: 'a@t.test' }), c({ seller: 'b@t.test' }), c({ seller: 'c@t.test' })]).reason, /ya sembró 3 tareas hoy/);
  // Lo de ayer no consume el cupo de hoy (con OTRA tarea: la misma ya estaría pagada).
  assert.equal(t.cupo(tarea, 'x@t.test', [c({ created: '2020-01-01T00:00:00.000Z', terms: { seed_task: 'otra' } })]).ok, true);
  // Y cada tarea se paga UNA vez por agente, aunque el cupo diario sobre y cambie el día.
  const holgado = new Tareas({ catalogo: catalogo(), porAgenteDia: 5, porDia: 0 });
  assert.match(holgado.cupo(tarea, 'x@t.test', [c({ created: '2020-01-01T00:00:00.000Z' })]).reason, /ya cobraste la tarea ping/);
});

test('el tope diario se aplica de verdad en la casa, no solo en la clase', async () => {
  const a = await join({ house: 't.test', hosts, name: 'insistente' });
  await tomar(a._agente, 'ping');
  await a._agente.waitFor((e) => e.from === 'libro@t.test', { timeoutMs: 5000 });
  // Segunda tarea el mismo día: el mostrador la rechaza y dice por qué.
  const segunda = await tomar(a._agente, 'otra');
  const rebote = await a._agente.waitFor((e) => e.in_reply_to === segunda.id && e.from.startsWith('postmaster@'), { timeoutMs: 5000 });
  const cuerpo = (await a._agente.open(rebote.envelope)).content.body;
  assert.equal(cuerpo.status, 'failed');
  assert.match(cuerpo.reason, /tarea .* en curso|tope por agente/);
});

test('no se negocia: precio inflado, prueba cambiada o árbitro ajeno se rechazan', async () => {
  const a = await join({ house: 't.test', hosts, name: 'vivo' });
  const casos = [
    [{ price: 5000 }, /el precio de ping es 50/],
    [{ terms: { seed_task: 'ping', verify: [{ type: 'http_status', url: 'https://siempre-ok.invalid/' }] } }, /no es la publicada/],
    [{ arbiter: a.address }, /el árbitro de una tarea sembrada es verifica@t\.test/],
    // Sin seed_task no hay a qué tarea referirse: la casa lo dice y apunta al catálogo.
    [{ terms: { acceptance: 'algo' } }, /no hay una tarea sembrada con id undefined/],
  ];
  for (const [extra, esperado] of casos) {
    const enviada = await tomar(a._agente, 'ping', extra);
    const rebote = await a._agente.waitFor((e) => e.in_reply_to === enviada.id && e.from.startsWith('postmaster@'), { timeoutMs: 5000 });
    const cuerpo = (await a._agente.open(rebote.envelope)).content.body;
    assert.match(cuerpo.reason, esperado);
  }
  // Y el saldo de la casa sigue intacto: ningún intento movió tokens.
  assert.equal((await a._agente.historial()).total_movido, 0);
});

test('tareas@ es de sistema y solo acepta cotizaciones, no cualquier sobre', async () => {
  const a = await join({ house: 't.test', hosts, name: 'curioso' });
  const suelto = await a._agente.send({ to: 'tareas@t.test', type: 'message', body: 'hola, quiero trabajar', encrypt: false });
  const rebote = await a._agente.waitFor((e) => e.in_reply_to === suelto.id && e.from.startsWith('postmaster@'), { timeoutMs: 5000 });
  assert.match((await a._agente.open(rebote.envelope)).content.body.reason, new RegExp(MEDIA.cotizacion.replace(/[.+]/g, '\\$&')));
  const usurpador = await fetch(`http://127.0.0.1:${P}/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ local: 'tareas', sig: 'x' }) });
  assert.equal(usurpador.status, 409);
});
