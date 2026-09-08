// node --test test/
// verifica@: el evaluador de referencia. Tres pruebas deterministas atadas a la liberación
// del escrow. Lo que se prueba aquí es que el dinero se mueve por lo que la prueba devolvió,
// nunca por lo que alguien afirmó — y que cuando la prueba no puede correr, NADIE decide.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Estafeta } from '../src/correo/estafeta.js';
import { join } from '../src/correo/unirse.js';
import { correrPrueba, veredicto, pruebasDe, pruebasDisponibles } from '../src/libro/verifica.js';
import { sha256hex } from '../src/nucleo/crypto.js';

const P = 4161;
const hosts = { 'v.test': { url: `http://127.0.0.1:${P}` } };
let tmp, casa;

// Un servidor de mentira que responde lo que se le pida: es el "mundo" que la prueba mira.
let mundo, mundoPort, estado = 200, cuerpo = 'ok';
const url = (p = '/health') => `http://127.0.0.1:${mundoPort}${p}`;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-verifica-'));
  mundo = http.createServer((req, res) => { res.writeHead(estado, { 'content-type': 'text/plain' }); res.end(cuerpo); });
  await new Promise((r) => mundo.listen(0, '127.0.0.1', r));
  mundoPort = mundo.address().port;
  casa = new Estafeta({
    domain: 'v.test', port: P, dataDir: path.join(tmp, 'v.test'), adminToken: 't', hosts,
    workerIntervalMs: 100, policy: { registration: 'open', registrations_per_minute: 200 },
    libro: { welcome: 1000, feeBps: 1000 }, verifica: { enabled: true }, log: () => {},
  });
  await casa.start();
});
after(async () => { await casa.stop(); await new Promise((r) => mundo.close(r)); });

// La prueba pura, sin protocolo alrededor.
test('http_status: pasa con el código esperado y falla con otro, diciendo cuál vio', async () => {
  const ok = await correrPrueba({ type: 'http_status', url: 'https://ejemplo.invalid/x' }, {
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(ok.pasa, true);
  const mal = await correrPrueba({ type: 'http_status', url: 'https://ejemplo.invalid/x' }, {
    fetchImpl: async () => ({ status: 500 }),
  });
  assert.equal(mal.pasa, false);
  assert.match(mal.razon, /respondió 500, se esperaba 200/);
  // http, no https: no se verifica contra un canal que cualquiera puede alterar.
  const inseguro = await correrPrueba({ type: 'http_status', url: 'http://ejemplo.invalid/x' });
  assert.equal(inseguro.pasa, false);
  assert.match(inseguro.razon, /https/);
});

test('sha256: compara el hash del contenido entregado y no acepta un expect mal formado', async () => {
  const texto = 'el informe entregado';
  const bien = await correrPrueba({ type: 'sha256', expect: sha256hex(texto) }, { entregado: texto });
  assert.equal(bien.pasa, true);
  const mal = await correrPrueba({ type: 'sha256', expect: sha256hex('otra cosa') }, { entregado: texto });
  assert.equal(mal.pasa, false);
  assert.match(mal.razon, /el hash no coincide/);
  const basura = await correrPrueba({ type: 'sha256', expect: 'no-es-un-hash' }, { entregado: texto });
  assert.equal(basura.pasa, false);
  assert.match(basura.razon, /sha256 en hexadecimal/);
});

test('exit_0: corre un comando real, exige argv y no acepta una línea de shell', async () => {
  assert.ok(pruebasDisponibles().includes('exit_0'), 'en Node sí hay shell');
  const ok = await correrPrueba({ type: 'exit_0', argv: ['node', '-e', 'process.exit(0)'] });
  assert.equal(ok.pasa, true);
  const mal = await correrPrueba({ type: 'exit_0', argv: ['node', '-e', 'process.exit(3)'] });
  assert.equal(mal.pasa, false);
  assert.match(mal.razon, /salió con 3/);
  // Una línea de shell abriría inyección de comandos: se rechaza de plano.
  const shell = await correrPrueba({ type: 'exit_0', argv: 'echo hola && rm -rf /' });
  assert.equal(shell.pasa, false);
  assert.match(shell.razon, /no se acepta una línea de shell/);
});

test('veredicto: exige que TODAS pasen, y una prueba que no pudo correr deja indeciso', async () => {
  const t = 'x';
  const todas = await veredicto([{ type: 'sha256', expect: sha256hex(t) }, { type: 'exit_0', argv: ['node', '-e', ''] }], { entregado: t });
  assert.equal(todas.pasa, true);
  const una = await veredicto([{ type: 'sha256', expect: sha256hex(t) }, { type: 'exit_0', argv: ['node', '-e', 'process.exit(1)'] }], { entregado: t });
  assert.equal(una.pasa, false);
  // Red caída: no es "la afirmación es falsa", es "no se pudo verificar".
  const caida = await veredicto([{ type: 'http_status', url: 'https://ejemplo.invalid/x' }], {
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
  });
  assert.equal(caida.indeciso, true);
  assert.equal(caida.pasa, false);
  assert.match(caida.razon, /no se pudo verificar/);
  // Sin pruebas declaradas no hay nada que decidir.
  assert.equal((await veredicto([])).indeciso, true);
  assert.equal(pruebasDe({ terms: {} }), null);
  assert.deepEqual(pruebasDe({ terms: { verify: { type: 'http_status', url: 'https://x/' } } }).length, 1);
});

test('verifica@ existe como agente de sistema y declara qué puede correr', async () => {
  const card = await casa.agentCard('verifica');
  assert.ok(card, 'la casa levanta verifica@ sola');
  assert.deepEqual(card.capabilities.verifica.pruebas, pruebasDisponibles());
  // Es de sistema: nadie más puede tomar ese nombre.
  const usurpador = await fetch(`http://127.0.0.1:${P}/agents`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ local: 'verifica', sig: 'x' }),
  });
  assert.equal(usurpador.status, 409);
});

test('el escrow se libera SOLO si la prueba pasa, y el recibo dice por qué', async () => {
  const vendedor = await join({ house: 'v.test', hosts, name: 'obrero' });
  const comprador = await join({ house: 'v.test', hosts, name: 'jefe' });
  estado = 200;

  const saldoAntes = (await vendedor._agente.balance()).balance;
  await vendedor._agente.quote({
    to: comprador.address, contract: 'escrow', price: 200, concept: 'levantar el endpoint',
    arbiter: `verifica@v.test`,
    terms: { acceptance: 'el endpoint responde 200', verify: { type: 'http_status', url: url('/health').replace('http://', 'https://') } },
  });
  const sobre = await comprador._agente.waitFor((e) => e.from === vendedor.address && e.type === 'message', { timeoutMs: 5000 });
  const cot = (await comprador._agente.open(sobre.envelope)).content.body;
  const aceptada = await comprador._agente.accept(cot);
  await comprador._agente.awaitReceipt(aceptada.id);

  const contrato = (await comprador._agente.balance()).contracts.find((c) => c.kind === 'escrow' && c.amount === 200);
  assert.equal(contrato.state, 'held');
  const entrega = await vendedor._agente.deliver('v.test', contrato.id, { note: 'listo' });
  await vendedor._agente.awaitReceipt(entrega.id);

  // Nadie libera a mano: el cron corre la prueba y decide. La URL es https y no resuelve
  // desde el edge de mentira, así que la prueba se sustituye por el mundo local.
  casa.fetch = async (u, o) => fetch(String(u).replace('https://127.0.0.1', 'http://127.0.0.1'), o);
  await casa.tick();
  await vendedor._agente.waitFor((e) => e.thread === contrato.id && e.from === 'libro@v.test', { timeoutMs: 5000 });

  const fin = await vendedor._agente.contract('v.test', contrato.id);
  assert.equal(fin.state, 'released', 'la prueba pasó, el escrow se liberó');
  assert.equal((await vendedor._agente.balance()).balance, saldoAntes + 180, '200 menos 10% de la casa');
  const paso = fin.history.find((h) => h.op === 'release');
  assert.equal(paso.by, 'verifica@v.test', 'quien liberó fue el verificador, no una parte');

  // Y queda en el historial como entrega aceptada: reputación = el libro.
  assert.equal((await vendedor._agente.historial()).resumen.entregas, 1);
});

test('si la prueba falla, el escrow se DEVUELVE y nadie cobra por haber dicho que entregó', async () => {
  const vendedor = await join({ house: 'v.test', hosts, name: 'mentiroso' });
  const comprador = await join({ house: 'v.test', hosts, name: 'clienta' });
  estado = 500; // el endpoint está caído, aunque el vendedor diga lo contrario

  const antesV = (await vendedor._agente.balance()).balance;
  const antesC = (await comprador._agente.balance()).balance;
  await vendedor._agente.quote({
    to: comprador.address, contract: 'escrow', price: 150, concept: 'arreglar el sitio',
    arbiter: `verifica@v.test`,
    terms: { acceptance: 'el endpoint responde 200', verify: { type: 'http_status', url: url('/health').replace('http://', 'https://') } },
  });
  const sobre = await comprador._agente.waitFor((e) => e.from === vendedor.address && e.type === 'message', { timeoutMs: 5000 });
  const aceptada = await comprador._agente.accept((await comprador._agente.open(sobre.envelope)).content.body);
  await comprador._agente.awaitReceipt(aceptada.id);
  const contrato = (await comprador._agente.balance()).contracts.find((c) => c.kind === 'escrow' && c.amount === 150);

  // El vendedor AFIRMA que entregó. Afirmar sigue siendo gratis; cobrar, no.
  const entrega = await vendedor._agente.deliver('v.test', contrato.id, { note: 'desplegado y verificado' });
  await vendedor._agente.awaitReceipt(entrega.id);

  casa.fetch = async (u, o) => fetch(String(u).replace('https://127.0.0.1', 'http://127.0.0.1'), o);
  await casa.tick();
  await comprador._agente.waitFor((e) => e.thread === contrato.id && e.from === 'libro@v.test', { timeoutMs: 5000 });

  const fin = await comprador._agente.contract('v.test', contrato.id);
  assert.equal(fin.state, 'refunded');
  assert.equal((await vendedor._agente.balance()).balance, antesV, 'el que afirmó en falso no cobró un token');
  assert.equal((await comprador._agente.balance()).balance, antesC, 'y el comprador recuperó todo, sin fee');
  const paso = fin.history.find((h) => h.op === 'refund');
  assert.match(paso.note, /respondió 500, se esperaba 200/, 'la razón queda escrita en el contrato');

  const h = await vendedor._agente.historial();
  assert.equal(h.resumen.entregas_falladas, 1);
  assert.equal(h.resumen.cumplimiento, 0);
});

test('sin árbitro verifica@ o sin prueba declarada, la casa no toca el escrow', async () => {
  const vendedor = await join({ house: 'v.test', hosts, name: 'ajeno' });
  const comprador = await join({ house: 'v.test', hosts, name: 'ajena' });
  estado = 500;
  // Mismo contrato, pero sin nombrar árbitro: es un trato entre dos, la casa no se mete.
  await vendedor._agente.quote({
    to: comprador.address, contract: 'escrow', price: 90, concept: 'sin árbitro',
    terms: { verify: { type: 'http_status', url: url('/health').replace('http://', 'https://') } },
  });
  const sobre = await comprador._agente.waitFor((e) => e.from === vendedor.address && e.type === 'message', { timeoutMs: 5000 });
  const aceptada = await comprador._agente.accept((await comprador._agente.open(sobre.envelope)).content.body);
  await comprador._agente.awaitReceipt(aceptada.id);
  const contrato = (await comprador._agente.balance()).contracts.find((c) => c.kind === 'escrow' && c.amount === 90);
  const entrega = await vendedor._agente.deliver('v.test', contrato.id, {});
  await vendedor._agente.awaitReceipt(entrega.id);

  casa.fetch = async (u, o) => fetch(String(u).replace('https://127.0.0.1', 'http://127.0.0.1'), o);
  await casa.tick();
  await casa.tick();
  assert.equal((await comprador._agente.contract('v.test', contrato.id)).state, 'delivered', 'la casa no decide donde no la llamaron');
});
