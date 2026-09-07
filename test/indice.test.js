// node --test test/
// Índice federado (urn:nyx5:ext:indice): registro de casas verificables, rastreo del
// directorio público, búsqueda entre casas, y la respuesta firmada por la casa del índice.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { verifyObject } from '../src/nucleo/crypto.js';

const P1 = 4141, P2 = 4142, P3 = 4143;
const hosts = {
  'indice.test': { url: `http://127.0.0.1:${P1}` },
  'uno.test': { url: `http://127.0.0.1:${P2}` },
  'dos.test': { url: `http://127.0.0.1:${P3}` },
};
let tmp, indice, uno, dos;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chasqui-idx-'));
  const mk = (domain, port, extra = {}) => new Estafeta({ domain, port, dataDir: path.join(tmp, domain), adminToken: 't', hosts, workerIntervalMs: 120, log: () => {}, ...extra });
  indice = await mk('indice.test', P1, { index: { enabled: true, crawlMinutes: 999 } }).start();
  uno = await mk('uno.test', P2).start();
  dos = await mk('dos.test', P3).start();
  const a = Agent.create('traductor@uno.test', hosts['uno.test'].url, { hosts });
  await a.register({ adminToken: 't', capabilities: { listed: true, mcp: 'http://uno/mcp', accepts: ['application/json'] } });
  const b = Agent.create('verificador@dos.test', hosts['dos.test'].url, { hosts });
  await b.register({ adminToken: 't', capabilities: { listed: true, libro: true, accepts: ['application/nyx5.libro+json'] } });
});
after(async () => { await indice.stop(); await uno.stop(); await dos.stop(); });

test('la casa del índice lo declara como extensión en su tarjeta', async () => {
  const a = Agent.create('x@uno.test', hosts['uno.test'].url, { hosts });
  const dc = await a.resolver.domainCard('indice.test');
  assert.ok(dc.extensions.includes('urn:nyx5:ext:indice'));
  const dcUno = await a.resolver.domainCard('uno.test');
  assert.ok(!dcUno.extensions.includes('urn:nyx5:ext:indice'), 'una casa sin índice no lo declara');
});

test('solo se listan casas verificables; una casa inexistente se rechaza con 422', async () => {
  const r = await fetch(`http://127.0.0.1:${P1}/index/houses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: 'no-existe.test' }) });
  assert.equal(r.status, 422);
  for (const d of ['uno.test', 'dos.test']) {
    const ok = await fetch(`http://127.0.0.1:${P1}/index/houses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: d }) });
    assert.equal(ok.status, 201, `${d} verificable se lista`);
  }
  const casas = await (await fetch(`http://127.0.0.1:${P1}/index/houses`)).json();
  assert.deepEqual(casas.houses.map((h) => h.domain).sort(), ['dos.test', 'uno.test']);
  assert.ok(casas.houses.every((h) => h.last_ok), 'el alta rastrea de inmediato');
});

test('búsqueda entre casas: por capacidad, media y texto; el índice responde firmado', async () => {
  const buscador = Agent.create('buscador@uno.test', hosts['uno.test'].url, { hosts });
  const porCapacidad = await buscador.search('indice.test', { capability: 'mcp' });
  assert.deepEqual(porCapacidad.agents.map((c) => c.address), ['traductor@uno.test']);
  assert.equal(porCapacidad.agents[0]._house, 'uno.test');
  const porMedia = await buscador.search('indice.test', { accepts: 'application/nyx5.libro+json' });
  assert.ok(porMedia.agents.some((c) => c.address === 'verificador@dos.test'));
  const porTexto = await buscador.search('indice.test', { q: 'verificador' });
  assert.ok(porTexto.agents.some((c) => c.address === 'verificador@dos.test'));
  const porCasa = await buscador.search('indice.test', { house: 'uno.test' });
  assert.ok(porCasa.agents.every((c) => c._house === 'uno.test'));
  // la respuesta viene firmada por la casa del índice: otro índice puede ingerirla verificada
  assert.equal(porCapacidad.index, 'indice.test');
  assert.ok(verifyObject(porCapacidad, indice.keys.sig), 'firma del índice verifica');
});

test('el rastreo re-verifica cada tarjeta: lo que el dominio no certificó no entra al índice', async () => {
  // agente nuevo en dos.test, y un rastreo nuevo lo recoge
  const c = Agent.create('nuevo@dos.test', hosts['dos.test'].url, { hosts });
  await c.register({ adminToken: 't', capabilities: { listed: true } });
  // Y uno que NO pidió figurar: por más que se rastree, no entra al índice (opt-in, D7).
  const priv = Agent.create('privado@dos.test', hosts['dos.test'].url, { hosts });
  await priv.register({ adminToken: 't' });
  indice._lastCrawl = 0;
  await indice._indexCrawlIfDue();
  const buscador = Agent.create('b2@uno.test', hosts['uno.test'].url, { hosts });
  const r = await buscador.search('indice.test', { q: 'nuevo' });
  assert.ok(r.agents.some((x) => x.address === 'nuevo@dos.test'));
  const priva = await buscador.search('indice.test', { q: 'privado' });
  assert.ok(!priva.agents.some((x) => x.address === 'privado@dos.test'), 'quien no pidió listed nunca entra al índice');
  // todas las tarjetas indexadas conservan su certificación del dominio de origen (verificable)
  for (const card of r.agents) assert.ok(card.certification?.kid, 'la tarjeta viaja con su certificación');
});

test('el índice rastrea su PROPIA casa sin salir a la red (el 522 del auto-fetch en Workers)', async () => {
  // En Node una estafeta puede llamarse a sí misma por HTTP, así que un test ingenuo pasa en
  // verde con el defecto vivo. Aquí el fetch REPRODUCE lo que hace Cloudflare: cortar cualquier
  // llamada del Worker a su propia URL pública. Sólo pasa si el rastreo del índice resuelve local.
  const propia = `http://127.0.0.1:${P1 + 10}`;
  const fetchComoCloudflare = async (url, opts) => {
    if (String(url).startsWith(propia)) throw new Error('522 connection timed out (el Worker no puede pedirse a sí mismo)');
    return globalThis.fetch(url, opts);
  };
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'chasqui-idx-self-'));
  const solo = await new Estafeta({
    domain: 'solo.test', port: P1 + 10, dataDir: path.join(tmp2, 'solo'), adminToken: 't',
    publicUrl: propia, hosts: { ...hosts, 'solo.test': { url: propia } },
    fetchImpl: fetchComoCloudflare, index: { enabled: true, crawlMinutes: 999 },
    workerIntervalMs: 999_999, log: () => {},
  }).start();
  try {
    const propio = Agent.create('local@solo.test', propia, { hosts: { 'solo.test': { url: propia } } });
    await propio.register({ adminToken: 't', capabilities: { listed: true, a2a: 'http://x/a2a' } });
    const casa = await solo.indexAddHouse('solo.test');
    assert.ok(casa.last_ok, 'el rastreo de la propia casa termina bien, sin salir a la red');
    const hit = await solo.indexSearch({ q: 'local@solo.test' });
    assert.equal(hit.total, 1, 'sus propios agentes quedan buscables');
    assert.equal(hit.agents[0]._house, 'solo.test');
  } finally { await solo.stop(); }
});
