// node --test test/
// Los tres defectos críticos que la revisión adversarial reprodujo, escritos contra el defecto
// REAL (dos instancias de Libro sobre la misma base, como dos isolates de Workers), más el
// bloqueo de auto-resolución que dejó el E2E de producción pegado en la cola.
import { test as _test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Libro } from '../src/libro/libro.js';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { D1Store } from '../src/nucleo/almacen-d1.js';
import { openLocalD1, sqliteAvailable } from '../src/nucleo/d1-local.js';
// Si node:sqlite no está (Node <22 sin flag), toda la suite D1 salta limpio en vez de reventar.
const test = (name, ...rest) => { const fn = rest.pop(); const opts = (rest[0] && typeof rest[0] === 'object') ? rest[0] : {}; return _test(name, sqliteAvailable ? opts : { ...opts, skip: 'node:sqlite no disponible (Node 22+)' }, fn); };
import { FileStore } from '../src/nucleo/almacen.js';
import { generateKeys, signObject, uuid } from '../src/nucleo/crypto.js';
import { MIGRACIONES } from './_migraciones.js';

const d1store = () => { const db = openLocalD1(); db._raw.exec(MIGRACIONES); return new D1Store(db); };

// Un sobre de operación del Libro, firmado por quien opera.
const KA = generateKeys();
const opEnv = (from, house, body, keys = KA) => signObject({
  nyx5: '1', id: uuid(), from, to: [`libro@${house}`], created: new Date().toISOString(),
  expires: null, thread: null, in_reply_to: null, type: 'task',
  content: { media: 'application/nyx5.libro+json', body },
}, keys);

// Dos Libros sobre la MISMA base = dos isolates de Workers atendiendo requests en paralelo.
function dosIsolates(store, keys, domain = 'iso.test') {
  const mk = () => new Libro({ domain, store, keys, resolver: null, feeBps: 0 });
  return [mk(), mk()];
}

test('CRÍTICO: dos cobros concurrentes NO pueden superar el tope del mandato', async () => {
  const store = d1store();
  const keys = generateKeys();
  const [A, B] = dosIsolates(store, keys);
  await A.topup('u@iso.test', 1000, 'carga');
  // mandato de u@ a g@ con tope 100
  const m = (await A.handle(opEnv('u@iso.test', 'iso.test', { op: 'mandate', grantee: 'g@iso.test', cap: 100 }), null)).result.mandate;

  // g@ cobra 100 dos veces a la vez, en dos isolates: uno debe ganar, el otro fallar cerrado.
  const cobro = (L) => L.handle(opEnv('g@iso.test', 'iso.test', { op: 'charge', mandate: m.id, amount: 100, concept: 'x' }), null);
  const [r1, r2] = await Promise.allSettled([cobro(A), cobro(B)]);
  const oks = [r1, r2].filter((r) => r.status === 'fulfilled' && r.value.ok);
  assert.equal(oks.length, 1, 'exactamente un cobro entra');

  const mf = await store.libroGetMandate(m.id);
  assert.equal(mf.spent, 100, 'el mandato registra exactamente lo gastado');
  assert.equal(await B.balance('g@iso.test'), 100, 'g@ recibió 100, no 200');
  assert.equal(await B.balance('u@iso.test'), 900, 'u@ pagó 100, no 200');
  const suma = Object.values((await store.libroState()).balances).reduce((s, v) => s + v, 0);
  assert.equal(suma, 0);
});

test('CRÍTICO: una revocación concurrente no puede ser borrada por un cobro en vuelo', async () => {
  const store = d1store();
  const keys = generateKeys();
  const [A, B] = dosIsolates(store, keys);
  await A.topup('u@iso.test', 1000, 'carga');
  const m = (await A.handle(opEnv('u@iso.test', 'iso.test', { op: 'mandate', grantee: 'g@iso.test', cap: 500 }), null)).result.mandate;

  // El mandatario cobra y el mandante revoca a la vez, en isolates distintos.
  const [rc, rv] = await Promise.allSettled([
    A.handle(opEnv('g@iso.test', 'iso.test', { op: 'charge', mandate: m.id, amount: 40, concept: 'x' }), null),
    B.handle(opEnv('u@iso.test', 'iso.test', { op: 'revoke', mandate: m.id }), null),
  ]);
  const gano = (r) => r.status === 'fulfilled' && r.value.ok;
  assert.ok(gano(rc) !== gano(rv) || !gano(rc), 'las dos no pueden cometer a la vez');

  const mf = await store.libroGetMandate(m.id);
  if (gano(rv)) {
    assert.equal(mf.state, 'revoked', 'la revocación NO puede quedar borrada por el cobro');
    assert.ok(mf.revoked, 'y conserva su rastro');
    // tras la revocación, ningún cobro nuevo pasa
    const post = await A.handle(opEnv('g@iso.test', 'iso.test', { op: 'charge', mandate: m.id, amount: 1, concept: 'x' }), null);
    assert.equal(post.ok, false);
  }
});

test('CRÍTICO: un choque de concurrencia se rebota como TRANSITORIO, no como fallo permanente', async () => {
  const store = d1store();
  const keys = generateKeys();
  const [A, B] = dosIsolates(store, keys);
  await A.topup('u@iso.test', 1000, 'carga');
  const t = (L, n) => L.transfer('u@iso.test', `d${n}@iso.test`, 10, `p${n}`);
  // Forzamos el choque: ambas abren, ambas comprometen.
  const [r1, r2] = await Promise.allSettled([
    (async () => { A._begin && await A._begin(); return t(A, 1); })(),
    (async () => { B._begin && await B._begin(); return t(B, 2); })(),
  ]);
  const fallo = [r1, r2].find((r) => r.status === 'rejected');
  if (fallo) {
    const code = fallo.reason?.code;
    assert.ok([421, 429, 503].includes(code), `un conflicto de concurrencia debe ser transitorio (RETRYABLE), no ${code}`);
  }
});

test('la casa resuelve su PROPIA tarjeta sin salir a la red (el 522 que colgó el E2E)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-self-'));
  // fetch que explota: si la casa intenta pedirse la tarjeta a sí misma por internet, falla.
  const fetchQueExplota = async (url) => { throw new Error(`SALIÓ A LA RED hacia ${url}`); };
  const e = new Estafeta({
    domain: 'sola.test', port: 4151, dataDir: path.join(tmp, 'sola'), adminToken: 't',
    publicUrl: 'https://sola.test', fetchImpl: fetchQueExplota, workerIntervalMs: 999_999, log: () => {},
  });
  await e.init();
  const dc = await e.resolver.domainCard('sola.test');
  assert.equal(dc.domain, 'sola.test', 'la tarjeta del dominio propio se sirve local');
  const a = Agent.create('yo@sola.test', 'https://sola.test');
  await e.registerAgent({ local: 'yo', sig: a.keys.sig, enc: a.keys.enc });
  const ac = await e.resolver.agentCard('yo@sola.test');
  assert.equal(ac.sig, a.keys.sig, 'la tarjeta de un agente propio también');
  assert.equal(ac._domain.domain, 'sola.test');
});

test('la resolución local NO exime de verificar: una delegación falsa de la propia casa se rechaza', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-selfdel-'));
  const e = new Estafeta({ domain: 'casa.test', port: 4152, dataDir: path.join(tmp, 'c'), adminToken: 't', publicUrl: 'https://casa.test', fetchImpl: async () => { throw new Error('no debe salir a la red'); }, workerIntervalMs: 999_999, log: () => {} });
  await e.init();
  const padre = generateKeys(), hijo = generateKeys(), impostor = generateKeys();
  await e.registerAgent({ local: 'padre', sig: padre.sig, enc: padre.enc });
  // delegación firmada por un impostor, no por el padre: la casa la certifica sólo si el padre firmó
  const falsa = signObject({ by: 'padre@casa.test', address: 'bot.padre@casa.test', sig: hijo.sig, scope: { cap: 999 }, valid_until: null, issued: new Date().toISOString() }, impostor);
  await assert.rejects(
    () => e.registerAgent({ local: 'bot.padre', sig: hijo.sig, enc: hijo.enc, delegation: falsa }),
    /delegación inválida/);
  // y la buena sí resuelve local, con su padre verificado
  const buena = signObject({ by: 'padre@casa.test', address: 'bot.padre@casa.test', sig: hijo.sig, scope: { cap: 50 }, valid_until: null, issued: new Date().toISOString() }, padre);
  await e.registerAgent({ local: 'bot.padre', sig: hijo.sig, enc: hijo.enc, delegation: buena });
  const card = await e.resolver.agentCard('bot.padre@casa.test');
  assert.equal(card.delegation.by, 'padre@casa.test');
  assert.equal(card.delegation._parent.address, 'padre@casa.test', 'la cadena del padre se verificó también en local');
  assert.equal(card.delegation.scope.cap, 50);
});
