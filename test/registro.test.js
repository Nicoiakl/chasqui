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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chasqui-reg-'));
  cerrada = await mk('cerrada.test', P1, 'admin').start();
  invitada = await mk('invitada.test', P2, 'invite', { libro: { welcome: 50 } }).start();
  abierta = await mk('abierta.test', P3, 'open').start();
});
after(async () => { await cerrada.stop(); await invitada.stop(); await abierta.stop(); });

test('la tarjeta del dominio publica el modo de registro', async () => {
  const a = Agent.create('x@abierta.test', hosts['abierta.test'].url, { hosts });
  assert.equal((await a.resolver.domainCard('abierta.test')).policy.registration, 'open');
  assert.equal((await a.resolver.domainCard('cerrada.test')).policy.registration, 'admin');
});

test('casa cerrada: sin token de la casa no hay alta, ni con cuerpo firmado', async () => {
  const a = Agent.create('intruso@cerrada.test', hosts['cerrada.test'].url, { hosts });
  await assert.rejects(() => a.register(), /no acepta auto-registro/);
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
  await assert.rejects(() => c.register(), /reservado/);
  const d = Agent.create('casa@abierta.test', hosts['abierta.test'].url, { hosts });
  await assert.rejects(() => d.register(), /reservado/);
});

test('un nombre tomado no se puede pisar desde afuera; su dueño sí lo actualiza y rota claves', async () => {
  const a = Agent.create('dueno@abierta.test', hosts['abierta.test'].url, { hosts });
  await a.register();
  const usurpador = Agent.create('dueno@abierta.test', hosts['abierta.test'].url, { hosts });
  await assert.rejects(() => usurpador.register(), /ya está tomado/);
  const oldSig = a.keys.sig;
  await a.rotateKeys();
  const card = await usurpador.resolver.agentCard('dueno@abierta.test');
  assert.notEqual(card.sig, oldSig); assert.equal(card.previous[0].sig, oldSig);
  await a.register({ inbox: { policy: 'allowlist', allowlist: [] } });
  assert.equal((await a.resolver.agentCard('dueno@abierta.test')).inbox.policy, 'allowlist');
});

test('casa por invitación: código de la casa, con usos y vencimiento; regalo de bienvenida configurable por invitación', async () => {
  const sin = Agent.create('sin@invitada.test', hosts['invitada.test'].url, { hosts });
  await assert.rejects(() => sin.register(), /invitación inexistente/);
  await assert.rejects(() => sin.register({ invite: 'nope' }), /invitación inexistente/);
  const inv = invitada.createInvite({ uses: 2, note: 'para el equipo', welcome: 500 });
  const a = Agent.create('uno@invitada.test', hosts['invitada.test'].url, { hosts });
  assert.equal((await a.register({ invite: inv.code })).registered_via, `invite:${inv.code}`);
  assert.equal(invitada.libro.balance('uno@invitada.test'), 500);
  const b = Agent.create('dos@invitada.test', hosts['invitada.test'].url, { hosts });
  await b.register({ invite: inv.code });
  const c = Agent.create('tres@invitada.test', hosts['invitada.test'].url, { hosts });
  await assert.rejects(() => c.register({ invite: inv.code }), /agotada/);
  const vencida = invitada.createInvite({ expires: new Date(Date.now() - 1000).toISOString() });
  await assert.rejects(() => c.register({ invite: vencida.code }), /vencida/);
  const normal = invitada.createInvite({});
  await c.register({ invite: normal.code });
  assert.equal(invitada.libro.balance('tres@invitada.test'), 50, 'sin welcome en la invitación aplica el de la casa');
  assert.equal(invitada.store.listInvites().find((i) => i.code === inv.code).used, 2);
});

test('directorio: público, sin datos privados, con filtros', async () => {
  const a = Agent.create('mcpbot@abierta.test', hosts['abierta.test'].url, { hosts });
  await a.register({ capabilities: { mcp: 'http://x/mcp', accepts: ['application/json', 'application/chasqui.cotizacion+json'] }, webhook: 'http://secreto' });
  const b = Agent.create('simple@abierta.test', hosts['abierta.test'].url, { hosts });
  await b.register();
  const all = await b.directory();
  assert.ok(all.total >= 4); assert.ok(all.agents.every((c) => !('webhook' in c)));
  assert.deepEqual((await b.directory('abierta.test', { capability: 'mcp' })).agents.map((c) => c.address), ['mcpbot@abierta.test']);
  assert.deepEqual((await b.directory('abierta.test', { accepts: 'application/chasqui.cotizacion+json' })).agents.map((c) => c.address), ['mcpbot@abierta.test']);
  assert.ok((await b.directory('abierta.test', { q: 'simple' })).agents.some((c) => c.address === 'simple@abierta.test'));
  // desde otra casa se consulta igual (es público)
  const remoto = Agent.create('r@cerrada.test', hosts['cerrada.test'].url, { hosts });
  await remoto.register({ adminToken: 't' });
  assert.ok((await remoto.directory('abierta.test')).total >= 4);
});
