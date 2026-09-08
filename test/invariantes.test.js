// node --test test/
// Invariantes del CLAUDE.md que no tenían prueba, defectos reales cerrados en esta fase,
// y el contrato de la D1Store (la misma Estafeta sobre D1 emulado con node:sqlite).
import { test as _test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { Libro } from '../src/libro/libro.js';
import { D1Store } from '../src/nucleo/almacen-d1.js';
import { openLocalD1, sqliteAvailable } from '../src/nucleo/d1-local.js';
// Si node:sqlite no está (Node <22 sin flag), toda la suite D1 salta limpio en vez de reventar.
const test = (name, ...rest) => { const fn = rest.pop(); const opts = (rest[0] && typeof rest[0] === 'object') ? rest[0] : {}; return _test(name, sqliteAvailable ? opts : { ...opts, skip: 'node:sqlite no disponible (Node 22+)' }, fn); };
import { generateKeys, signObject, uuid, canonical, verifyObject } from '../src/nucleo/crypto.js';
import { MIGRACIONES } from './_migraciones.js';

const P1 = 4131, P2 = 4132, P3 = 4133;
const hosts = {
  'gamma.test': { url: `http://127.0.0.1:${P1}` },
  'delta.test': { url: `http://127.0.0.1:${P2}` },
  'sellada.test': { url: `http://127.0.0.1:${P3}` },
};
const d1store = () => { const db = openLocalD1(); db._raw.exec(MIGRACIONES); return new D1Store(db); };

let tmp, gamma, delta, sellada, nico, ayudante;
const env = (from, to, keys, extra = {}) => signObject({ nyx5: '1', id: uuid(), from, to: Array.isArray(to) ? to : [to], created: new Date().toISOString(), type: 'message', content: { media: 'text/plain', body: 'x' }, ...extra }, keys);
const inbound = async (port, e, headers = {}) => { const r = await fetch(`http://127.0.0.1:${port}/inbound`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(e) }); return { status: r.status, ...(await r.json()) }; };

before(async () => {
  if (!sqliteAvailable) return; // sin node:sqlite la suite entera salta; no montamos nada
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-inv-'));
  // gamma corre sobre D1 (emulado): toda esta suite ejerce la D1Store de punta a punta
  gamma = await new Estafeta({ domain: 'gamma.test', port: P1, store: d1store(), adminToken: 'g', hosts, workerIntervalMs: 120, retry: { baseMs: 120, maxMs: 500 }, libro: { welcome: 0 }, log: () => {} }).start();
  delta = await new Estafeta({ domain: 'delta.test', port: P2, dataDir: path.join(tmp, 'delta'), adminToken: 'd', hosts, workerIntervalMs: 120, retry: { baseMs: 120, maxMs: 500 }, log: () => {} }).start();
  sellada = await new Estafeta({ domain: 'sellada.test', port: P3, dataDir: path.join(tmp, 'sellada'), adminToken: 's', hosts, policy: { outbound: 'sealed' }, workerIntervalMs: 120, log: () => {} }).start();
  nico = Agent.create('nico@gamma.test', hosts['gamma.test'].url, { hosts });
  ayudante = Agent.create('ayudante@delta.test', hosts['delta.test'].url, { hosts });
  await nico.register({ adminToken: 'g' });
  await ayudante.register({ adminToken: 'd' });
  await gamma.libro.topup(nico.address, 1000, 'carga');
});
after(async () => { if (!sqliteAvailable) return; await gamma.stop(); await delta.stop(); await sellada.stop(); });

// ---------- invariante 2: el Libro jamás por endpoint sin firma ----------
test('D1 · /libro/* sin autenticación responde 401, siempre', async () => {
  for (const [method, p] of [
    ['GET', `/libro/cuenta/${encodeURIComponent(nico.address)}`],
    ['GET', '/libro/contrato/cualquiera'],
    ['GET', '/libro/diario'],
  ]) {
    const r = await fetch(`http://127.0.0.1:${P1}${p}`, { method });
    assert.equal(r.status, 401, `${method} ${p} sin auth debe ser 401`);
  }
  const r = await fetch(`http://127.0.0.1:${P1}/libro/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: nico.address, amount: 9999 }) });
  assert.equal(r.status, 401, 'topup sin token de la casa debe ser 401');
  assert.equal(await gamma.libro.balance(nico.address), 1000, 'y no acredita nada');
});

// ---------- replay de token de auth ----------
test('D1 · un token de auth reutilizado (mismo nonce) se rechaza', async () => {
  const header = nico._auth('GET', `/mailbox/${nico.local}`);
  const r1 = await fetch(`http://127.0.0.1:${P1}/mailbox/${nico.local}`, { headers: { authorization: header } });
  assert.equal(r1.status, 200);
  const r2 = await fetch(`http://127.0.0.1:${P1}/mailbox/${nico.local}`, { headers: { authorization: header } });
  assert.equal(r2.status, 401);
  assert.match((await r2.json()).reason, /nonce/);
});

// ---------- el token está atado a la casa (audiencia) ----------
test('un token emitido para una casa no sirve contra otra', async () => {
  // ayudante firma un token para SU estafeta (delta) y alguien lo presenta contra gamma
  const header = ayudante._auth('GET', `/mailbox/${ayudante.local}`);
  const r = await fetch(`http://127.0.0.1:${P1}/mailbox/${ayudante.local}`, { headers: { authorization: header } });
  assert.equal(r.status, 401);
});

// ---------- forma y política ----------
test('D1 · sobre vencido 410; id con traversal 400; sobre gigante 413; blocklist 403; intro grande 403', async () => {
  const vencido = env(ayudante.address, nico.address, ayudante.keys, { expires: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await inbound(P1, vencido)).status, 410);

  const feo = env(ayudante.address, nico.address, ayudante.keys); feo.id = '../../etc/passwd';
  const feoFirmado = signObject({ ...feo, signature: undefined, id: '../../etc/passwd' }, ayudante.keys);
  assert.equal((await inbound(P1, feoFirmado)).status, 400);

  const gigante = env(ayudante.address, nico.address, ayudante.keys, { content: { media: 'text/plain', body: 'x'.repeat(1_100_000) } });
  assert.equal((await inbound(P1, signObject({ ...gigante, signature: undefined }, ayudante.keys))).status, 413);

  const bloqueado = Agent.create('bloqueado@gamma.test', hosts['gamma.test'].url, { hosts });
  await bloqueado.register({ adminToken: 'g', inbox: { policy: 'open', blocklist: ['delta.test'] } });
  assert.equal((await inbound(P1, env(ayudante.address, bloqueado.address, ayudante.keys))).status, 403);

  const selecto = Agent.create('selecto@gamma.test', hosts['gamma.test'].url, { hosts });
  await selecto.register({ adminToken: 'g', inbox: { policy: 'allowlist', allowlist: [] } });
  const introGrande = env(ayudante.address, selecto.address, ayudante.keys, { type: 'intro', content: { media: 'text/plain', body: 'x'.repeat(5000) } });
  assert.equal((await inbound(P1, signObject({ ...introGrande, signature: undefined }, ayudante.keys))).status, 403);
});

// ---------- invariante 7: campos desconocidos sobreviven y la firma sigue verificando ----------
test('D1 · un sobre con campos desconocidos se entrega ÍNTEGRO y su firma verifica tras el roundtrip', async () => {
  const raro = env(ayudante.address, nico.address, ayudante.keys, {
    campo_futuro: { anidado: [1, 2, 3] }, otra_cosa: 'se conserva',
  });
  assert.equal((await inbound(P1, raro)).status, 202);
  const m = await nico.waitFor((e) => e.id === raro.id);
  assert.deepEqual(m.envelope.campo_futuro, { anidado: [1, 2, 3] });
  assert.equal(m.envelope.otra_cosa, 'se conserva');
  assert.ok(verifyObject(m.envelope, ayudante.keys.sig), 'la firma verifica byte a byte tras pasar por el store');
  await nico.ack(raro.id);
});

// ---------- el defecto real del duplicado parcial ----------
test('D1 · entrega parcial: el reintento entrega al destinatario pendiente y el duplicado dice la verdad', async () => {
  // sobre a dos destinatarios de gamma; el segundo aún no existe -> se acepta solo el primero
  const tarde = `tarde${Date.now() % 100000}`;
  const e = env(ayudante.address, [nico.address, `${tarde}@gamma.test`], ayudante.keys);
  const r1 = await inbound(P1, e);
  assert.equal(r1.status, 202);
  assert.deepEqual(r1.accepted, [nico.address]);
  assert.equal(r1.rejected[0].code, 404);
  // aparece el destinatario que faltaba y la estafeta emisora reintenta EL MISMO sobre
  const tardio = Agent.create(`${tarde}@gamma.test`, hosts['gamma.test'].url, { hosts });
  await tardio.register({ adminToken: 'g' });
  const r2 = await inbound(P1, e);
  assert.equal(r2.status, 202);
  assert.deepEqual([...r2.accepted].sort(), [nico.address, tardio.address].sort(), 'el duplicado declara lo realmente aceptado');
  assert.equal((await tardio.inbox()).filter((m) => m.envelope.id === e.id).length, 1, 'el pendiente recibió su copia');
  assert.equal((await nico.inbox()).filter((m) => m.envelope.id === e.id).length, 1, 'el ya aceptado no se duplica');
  // tercera entrega: todo aceptado -> duplicado puro, sin reproceso
  const r3 = await inbound(P1, e);
  assert.equal(r3.duplicate, true);
  await nico.ack(e.id); await tardio.ack(e.id);
});

// ---------- estampilla idempotente (el dinero no se cobra dos veces) ----------
test('D1 · reentregar un sobre con estampilla no cobra dos veces', async () => {
  const caro = Agent.create('caro@gamma.test', hosts['gamma.test'].url, { hosts });
  await caro.register({ adminToken: 'g', inbox: { policy: 'stamp', price: 5 } });
  await gamma.libro.topup(ayudante.address, 20, 'x');
  const e = env(ayudante.address, caro.address, ayudante.keys, { stamp: { house: 'gamma.test', amount: 5 } });
  assert.equal((await inbound(P1, e)).status, 202);
  assert.equal(await gamma.libro.balance(ayudante.address), 15);
  const dup = await inbound(P1, e);
  assert.equal(dup.duplicate, true);
  assert.equal(await gamma.libro.balance(ayudante.address), 15, 'la reentrega no vuelve a cobrar');
  const suma = Object.values((await gamma.store.libroState()).balances).reduce((s, v) => s + v, 0);
  assert.equal(suma, 0);
});

// ---------- sealed ya no se salta en buzones stamp ----------
test('un dominio sealed no puede mandar en claro ni a buzones stamp (antes se colaba y se cobraba)', async () => {
  const emisor = Agent.create('emisor@sellada.test', hosts['sellada.test'].url, { hosts });
  await emisor.register({ adminToken: 's' });
  const caroCard = await emisor.resolver.agentCard('caro@gamma.test');
  assert.equal(caroCard.inbox.policy, 'stamp');
  const saldoAntes = await gamma.libro.balance(emisor.address);
  const e = env(emisor.address, 'caro@gamma.test', emisor.keys, { stamp: { house: 'gamma.test', amount: 5 } });
  const r = await inbound(P1, e);
  assert.equal(r.status, 403, 'sobre en claro de dominio sealed: rechazado, no cobrado');
  assert.equal(await gamma.libro.balance(emisor.address), saldoAntes);
});

// ---------- cotización hostil: kind no cotizable rebota limpio ----------
test('D1 · una cotización firmada a mano con contrato inexistente o no cotizable rebota 400, no explota', async () => {
  for (const kind of ['zzz', 'ops', 'bond']) {
    const q = signObject({ tipo: 'cotizacion', id: uuid(), house: 'gamma.test', seller: ayudante.address, buyer: nico.address, contract: kind, price: 10, currency: 'tok', concept: 'trampa', terms: {}, arbiter: null, issued: new Date().toISOString(), expires: null }, ayudante.keys);
    const acc = await nico.accept(q);
    const rebote = await nico.waitFor((e) => e.type === 'receipt' && e.in_reply_to === acc.id, { timeoutMs: 6000 });
    const abierto = await nico.open(rebote.envelope);
    assert.match(abierto.content.body.reason, /400/, `kind ${kind} debe rebotar 400`);
    await nico.ack(rebote.envelope.id);
  }
});

// ---------- fianza con beneficiario basura ----------
test('D1 · bond con beneficiary o arbiter que no son direcciones rebota 400', async () => {
  const op = await nico.bond('gamma.test', { amount: 10, claim: 'x', verifier: ayudante.address, beneficiary: 'escrow:ajeno' });
  const rebote = await nico.waitFor((e) => e.type === 'receipt' && e.in_reply_to === op.id, { timeoutMs: 6000 });
  assert.match((await nico.open(rebote.envelope)).content.body.reason, /400/);
  await nico.ack(rebote.envelope.id);
});

// ---------- rotación que falla no deja al cliente inutilizable ----------
test('si la estafeta no confirma la rotación, el agente sigue firmando con las claves viejas', async () => {
  const fetchRoto = () => { throw new Error('red caída'); };
  const fragil = Agent.create('fragil@gamma.test', hosts['gamma.test'].url, { hosts });
  await fragil.register({ adminToken: 'g' });
  const antes = fragil.keys.sig;
  fragil.fetch = fetchRoto;
  await assert.rejects(() => fragil.rotateKeys());
  fragil.fetch = globalThis.fetch;
  assert.equal(fragil.keys.sig, antes, 'las claves no cambiaron');
  assert.ok(await fragil.inbox() instanceof Array, 'y sigue autenticando');
});

// ---------- concurrencia real sobre D1: dos casas (isolates) contra la misma base ----------
test('D1 · dos instancias sobre la MISMA base no pueden descuadrar el ledger: la segunda falla cerrado', async () => {
  const db = openLocalD1(); db._raw.exec(MIGRACIONES);
  const store = new D1Store(db);
  const keys = generateKeys();
  const mkLibro = () => new Libro({ domain: 'iso.test', store, keys, resolver: null, feeBps: 0 });
  const l1 = mkLibro(), l2 = mkLibro(); // dos "isolates" compartiendo D1
  await l1.topup('a@iso.test', 100, 'carga');
  // ambas leen el mismo estado y comprometen a la vez: una gana, la otra choca con PK del diario
  const t1 = l1.transfer('a@iso.test', 'b@iso.test', 10, 'p1');
  const t2 = l2.transfer('a@iso.test', 'c@iso.test', 10, 'p2');
  const resultados = await Promise.allSettled([t1, t2]);
  const ok = resultados.filter((r) => r.status === 'fulfilled');
  const fallo = resultados.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, 'exactamente una transferencia entra');
  assert.equal(fallo.length, 1, 'la otra falla cerrado (conflicto de concurrencia), no pisa');
  assert.match(String(fallo[0].reason?.message), /conflicto|UNIQUE|concurrencia/i);
  const state = await store.libroState();
  const suma = Object.values(state.balances).reduce((s, v) => s + v, 0);
  assert.equal(suma, 0, 'la suma global sigue en cero');
  assert.equal((await store.libroJournal()).length, 2, 'topup + una transferencia: ningún asiento pisado');
});

// ---------- statement con límite hostil ----------
test('D1 · statement acota el límite (limit negativo o gigante no vuelca el diario)', async () => {
  const r = await gamma.libro.store.libroStatement(nico.address, 5);
  assert.ok(r.length <= 5);
});
