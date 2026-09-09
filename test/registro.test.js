// node --test test/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { generateKeys, signObject } from '../src/nucleo/crypto.js';

const P1 = 4121, P2 = 4122, P3 = 4123;
const hosts = { 'cerrada.test': { url: `http://127.0.0.1:${P1}` }, 'invitada.test': { url: `http://127.0.0.1:${P2}` }, 'abierta.test': { url: `http://127.0.0.1:${P3}` } };
let tmp, cerrada, invitada, abierta;
const mk = (domain, port, registration, extra = {}) => new Estafeta({ domain, port, dataDir: path.join(tmp, domain), adminToken: 't', hosts, workerIntervalMs: 150, policy: { registration }, log: () => {}, ...extra });
const post = async (port, body, headers = {}) => { const r = await fetch(`http://127.0.0.1:${port}/agents`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-reg-'));
  cerrada = await mk('cerrada.test', P1, 'admin').start();
  invitada = await mk('invitada.test', P2, 'invite', { libro: { welcome: 50 } }).start();
  // Tope alto: esta suite hace muchas altas seguidas y el límite por IP (10/min) las cortaba,
  // devolviendo 429 donde el test esperaba el 409 de la regla que estaba comprobando.
  abierta = await mk('abierta.test', P3, 'open', { policy: { registration: 'open', registrations_per_minute: 500 } }).start();
});
after(async () => { await cerrada.stop(); await invitada.stop(); await abierta.stop(); });

test('la tarjeta del dominio publica el modo de registro', async () => {
  const a = Agent.create('libre2@abierta.test', hosts['abierta.test'].url, { hosts });
  assert.equal((await a.resolver.domainCard('abierta.test')).policy.registration, 'open');
  assert.equal((await a.resolver.domainCard('cerrada.test')).policy.registration, 'admin');
});

test('casa cerrada: sin token de la casa no hay alta, ni con cuerpo firmado', async () => {
  const a = Agent.create('intruso@cerrada.test', hosts['cerrada.test'].url, { hosts });
  await assert.rejects(() => a.register(), /does not accept self-registration/);
  const b = Agent.create('legit@cerrada.test', hosts['cerrada.test'].url, { hosts });
  assert.equal((await b.register({ adminToken: 't' })).address, 'legit@cerrada.test');
});

test('casa abierta: alta con prueba de posesión; sin firma o con firma ajena se rechaza; nombres reservados', async () => {
  const a = Agent.create('libre@abierta.test', hosts['abierta.test'].url, { hosts });
  const card = await a.register();
  assert.equal(card.registered_via, 'open'); assert.equal(card.certification.kid, abierta.keys.sig);
  // cuerpo sin firmar
  assert.equal((await post(P3, { local: 'otro', sig: generateKeys().sig })).status, 401);
  // cuerpo firmado con una clave distinta a la que inscribe
  const k1 = generateKeys(), k2 = generateKeys();
  assert.equal((await post(P3, signObject({ local: 'otro', sig: k1.sig, ts: new Date().toISOString() }, k2))).status, 401);
  // ts viejo
  assert.equal((await post(P3, signObject({ local: 'otro', sig: k1.sig, ts: '2020-01-01T00:00:00Z' }, k1))).status, 401);
  // reservado
  const c = Agent.create('admin@abierta.test', hosts['abierta.test'].url, { hosts });
  await assert.rejects(() => c.register(), /reserved/);
  const d = Agent.create('casa@abierta.test', hosts['abierta.test'].url, { hosts });
  await assert.rejects(() => d.register(), /reserved/);
});

test('un nombre tomado no se puede pisar desde afuera; su dueño sí lo actualiza y rota claves', async () => {
  const a = Agent.create('dueno@abierta.test', hosts['abierta.test'].url, { hosts });
  await a.register();
  const usurpador = Agent.create('dueno@abierta.test', hosts['abierta.test'].url, { hosts });
  await assert.rejects(() => usurpador.register(), /name is taken/);
  const oldSig = a.keys.sig;
  await a.rotateKeys();
  const card = await usurpador.resolver.agentCard('dueno@abierta.test');
  assert.notEqual(card.sig, oldSig); assert.equal(card.previous[0].sig, oldSig);
  await a.register({ inbox: { policy: 'allowlist', allowlist: [] } });
  assert.equal((await a.resolver.agentCard('dueno@abierta.test')).inbox.policy, 'allowlist');
});

test('casa por invitación: código de la casa, con usos y vencimiento; regalo de bienvenida configurable por invitación', async () => {
  const sin = Agent.create('sincodigo@invitada.test', hosts['invitada.test'].url, { hosts });
  await assert.rejects(() => sin.register(), /no such invitation/);
  await assert.rejects(() => sin.register({ invite: 'nope' }), /no such invitation/);
  const inv = await invitada.createInvite({ uses: 2, note: 'para el equipo', welcome: 500 });
  const a = Agent.create('unode@invitada.test', hosts['invitada.test'].url, { hosts });
  assert.equal((await a.register({ invite: inv.code })).registered_via, `invite:${inv.code}`);
  assert.equal(await invitada.libro.balance('unode@invitada.test'), 500);
  const b = Agent.create('dosde@invitada.test', hosts['invitada.test'].url, { hosts });
  await b.register({ invite: inv.code });
  const c = Agent.create('tres@invitada.test', hosts['invitada.test'].url, { hosts });
  await assert.rejects(() => c.register({ invite: inv.code }), /used up/);
  const vencida = await invitada.createInvite({ expires: new Date(Date.now() - 1000).toISOString() });
  await assert.rejects(() => c.register({ invite: vencida.code }), /expired/);
  const normal = await invitada.createInvite({});
  await c.register({ invite: normal.code });
  assert.equal(await invitada.libro.balance('tres@invitada.test'), 50, 'sin welcome en la invitación aplica el de la casa');
  assert.equal((await invitada.store.listInvites()).find((i) => i.code === inv.code).used, 2);
});

test('directorio: opt-in (listed), público, sin datos privados, con filtros', async () => {
  const a = Agent.create('mcpbot@abierta.test', hosts['abierta.test'].url, { hosts });
  await a.register({ capabilities: { listed: true, mcp: 'http://x/mcp', accepts: ['application/json', 'application/nyx5.cotizacion+json'] }, webhook: 'http://secreto' });
  const b = Agent.create('simple@abierta.test', hosts['abierta.test'].url, { hosts });
  await b.register({ capabilities: { listed: true } });
  // Un agente que NO pidió figurar: default false, no aparece en el directorio ni en el índice.
  const oculto = Agent.create('oculto@abierta.test', hosts['abierta.test'].url, { hosts });
  await oculto.register();
  const all = await b.directory();
  const addrs = all.agents.map((c) => c.address);
  assert.ok(addrs.includes('mcpbot@abierta.test') && addrs.includes('simple@abierta.test'), 'los que pidieron listed aparecen');
  assert.ok(!addrs.includes('oculto@abierta.test'), 'quien no pidió listed NO aparece');
  assert.ok(all.agents.every((c) => !('webhook' in c)), 'el directorio no filtra datos privados');
  assert.deepEqual((await b.directory('abierta.test', { capability: 'mcp' })).agents.map((c) => c.address), ['mcpbot@abierta.test']);
  assert.deepEqual((await b.directory('abierta.test', { accepts: 'application/nyx5.cotizacion+json' })).agents.map((c) => c.address), ['mcpbot@abierta.test']);
  assert.ok((await b.directory('abierta.test', { q: 'simple' })).agents.some((c) => c.address === 'simple@abierta.test'));
  // No listar no es esconderse: el lookup directo por dirección sigue resolviendo al oculto.
  assert.equal((await b.resolver.agentCard('oculto@abierta.test')).address, 'oculto@abierta.test');
  // desde otra casa se consulta igual (es público), y ve exactamente a los listados
  const remoto = Agent.create('remoto@cerrada.test', hosts['cerrada.test'].url, { hosts });
  await remoto.register({ adminToken: 't' });
  const desdeAfuera = (await remoto.directory('abierta.test')).agents.map((c) => c.address);
  assert.ok(desdeAfuera.includes('mcpbot@abierta.test') && !desdeAfuera.includes('oculto@abierta.test'));
});

// Nombres cortos reservados: en una casa de registro abierto son lo primero que alguien acapara
// para revender o suplantar (a@casa se confunde con cualquiera). Pedido por Nicholas el 9-sep-2026.
test('los nombres de 1 a 3 caracteres están reservados, y los delegados no cuentan', async () => {
  for (const corto of ['a', 'ab', 'abc', 'x1', '123']) {
    const a = Agent.create(`${corto}@abierta.test`, hosts['abierta.test'].url, { hosts });
    await assert.rejects(() => a.register(), (e) => {
      assert.equal(e.status, 409, `"${corto}": se esperaba 409 y vino ${e.status} (${e.message})`);
      assert.match(e.message, /shorter than 4 characters/, `"${corto}": ${e.message}`);
      return true;
    });
  }
  // Cuatro sí entra: el límite es exactamente donde se dijo.
  const ok = Agent.create('abcd@abierta.test', hosts['abierta.test'].url, { hosts });
  assert.equal((await ok.register()).address, 'abcd@abierta.test');

  // Un subagente hereda el nombre del padre (`bot.abcd`), así que la regla no puede bloquearlo
  // por el trozo corto: se mide el nombre completo y además los delegados quedan exentos.
  const sub = await ok.delegate('bo', { scope: { types: ['message'] } });
  assert.equal(sub.address, 'bo.abcd@abierta.test');

  // Y una casa puede aflojar la regla si quiere: es política suya, no del protocolo.
  const suelta = new Estafeta({ domain: 'corta.test', port: 4128, dataDir: path.join(tmp, 'corta.test'), adminToken: 't', hosts, workerIntervalMs: 5000, policy: { registration: 'open', min_name_length: 1 }, log: () => {} });
  await suelta.start();
  try {
    const b = Agent.create('a@corta.test', `http://127.0.0.1:4128`, { hosts: { ...hosts, 'corta.test': { url: 'http://127.0.0.1:4128' } } });
    assert.equal((await b.register()).address, 'a@corta.test');
  } finally { await suelta.stop(); }
});
