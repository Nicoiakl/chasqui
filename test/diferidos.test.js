// node --test test/
// V1: sobres diferidos (deliver_after). El buzón como memoria del agente entre sesiones, y los
// avisos de plazo del Libro. Cada criterio de aceptación del brief, contra el defecto real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { Libro } from '../src/libro/libro.js';

let puerto = 4180;
async function casa() {
  const p = puerto++;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-dif-'));
  const dom = `d${p}.test`;
  const e = new Estafeta({ domain: dom, port: p, dataDir: path.join(tmp, dom), adminToken: 't', publicUrl: `http://127.0.0.1:${p}`, hosts: { [dom]: { url: `http://127.0.0.1:${p}` } }, workerIntervalMs: 60, retry: { baseMs: 60, maxMs: 200 }, log: () => {} });
  await e.start();
  return { e, p, dom, url: `http://127.0.0.1:${p}` };
}

test('V1 · un sobre con deliver_after futuro NO aparece antes de la fecha, y sí después', async () => {
  const { e, url, dom } = await casa();
  try {
    const a = Agent.create(`a@${dom}`, url, { hosts: { [dom]: { url } } });
    const b = Agent.create(`b@${dom}`, url, { hosts: { [dom]: { url } } });
    await a.register({ adminToken: 't' }); await b.register({ adminToken: 't' });
    const cuando = new Date(Date.now() + 800).toISOString();
    const s = await a.send({ to: b.address, body: 'llego en el futuro', deliverAfter: cuando });
    // antes de la fecha: no está en el buzón
    await e.tick();
    assert.equal((await b.inbox()).some((m) => m.envelope.id === s.id), false, 'no debe llegar antes de deliver_after');
    // después de la fecha: llega
    const m = await b.waitFor((x) => x.id === s.id, { timeoutMs: 4000, everyMs: 120 });
    assert.ok(m, 'debe llegar después de deliver_after');
    assert.equal((await b.open(m.envelope)).content.body, 'llego en el futuro');
  } finally { await e.stop(); }
});

test('V1 · deliver_after en el pasado se entrega de inmediato (nunca es error)', async () => {
  const { e, url, dom } = await casa();
  try {
    const a = Agent.create(`a@${dom}`, url, { hosts: { [dom]: { url } } });
    const b = Agent.create(`b@${dom}`, url, { hosts: { [dom]: { url } } });
    await a.register({ adminToken: 't' }); await b.register({ adminToken: 't' });
    const s = await a.send({ to: b.address, body: 'ya', deliverAfter: new Date(Date.now() - 10000).toISOString() });
    const m = await b.waitFor((x) => x.id === s.id, { timeoutMs: 3000, everyMs: 100 });
    assert.ok(m, 'un deliver_after pasado entrega de inmediato');
  } finally { await e.stop(); }
});

test('V1 · expires <= deliver_after se rechaza al enviar (el sobre vencería antes de llegar)', async () => {
  const { e, url, dom } = await casa();
  try {
    const a = Agent.create(`a@${dom}`, url, { hosts: { [dom]: { url } } });
    await a.register({ adminToken: 't' });
    const cuando = new Date(Date.now() + 100000).toISOString();
    const antes = new Date(Date.now() + 50000).toISOString();
    await assert.rejects(() => a.send({ to: `a@${dom}`, body: 'x', deliverAfter: cuando, expires: antes }), /vencería antes|deliver_after/);
  } finally { await e.stop(); }
});

test('V1 · un sobre que vence esperando en la cola REBOTA al remitente, no desaparece', async () => {
  const { e, url, dom } = await casa();
  try {
    const a = Agent.create(`a@${dom}`, url, { hosts: { [dom]: { url } } });
    await a.register({ adminToken: 't' });
    // Un job que quedó en la cola (un reintento a un destino caído) y cuyo expires ya pasó:
    // el próximo intento de entrega lo rebota en vez de tragárselo. Lo montamos directo en el
    // store —el defecto vive en _deliver, no en send— con next_attempt vencido y expires en el pasado.
    const pasado = new Date(Date.now() - 1000).toISOString();
    const env = { nyx5: '1', id: crypto.randomUUID(), from: `a@${dom}`, to: [`x@${dom}`],
      created: pasado, expires: pasado, type: 'message', content: { media: 'text/plain', body: 'x' } };
    await e.store.enqueue({ id: crypto.randomUUID(), envelope: env, domain: dom, to: [`x@${dom}`],
      from_local: 'a', attempts: 1, next_attempt: pasado, created: pasado, status: 'queued', log: [] });
    await e.tick();
    const bounce = await a.waitFor((x) => x.type === 'receipt' && x.from === `postmaster@${dom}`, { timeoutMs: 4000, everyMs: 120 });
    assert.match((await a.open(bounce.envelope)).content.body.reason, /venció|cola/, 'el rebote dice que venció en la cola');
    // y el job no quedó dando vueltas
    assert.equal((await e.store.claimDueJobs(new Date().toISOString(), 10)).length, 0, 'la cola quedó vacía');
  } finally { await e.stop(); }
});

test('V1 · nyx5_remind: el auto-envío llega cifrado y se descifra en la sesión siguiente', async () => {
  const { e, url, dom } = await casa();
  try {
    const a = Agent.create(`a@${dom}`, url, { hosts: { [dom]: { url } } });
    await a.register({ adminToken: 't' });
    const s = await a.recordar({ cuando: new Date(Date.now() + 300).toISOString(), body: { retomar: 'la tarea X', paso: 3 } });
    assert.ok(s.envelope.encrypted, 'el recordatorio a sí mismo va cifrado');
    // "sesión siguiente": el mismo agente reconstruido desde sus llaves
    const otra = new Agent({ address: a.address, keys: a.keys, estafeta: url, hosts: { [dom]: { url } } });
    const m = await otra.waitFor((x) => x.id === s.id, { timeoutMs: 4000, everyMs: 120 });
    const abierto = await otra.open(m.envelope);
    assert.deepEqual(abierto.content.body, { retomar: 'la tarea X', paso: 3 }, 'el yo futuro descifra su propio contexto');
  } finally { await e.stop(); }
});

test('V1 · un escrow con deadline programa un aviso automático a ambas partes para esa fecha', async () => {
  const { e, url, dom } = await casa();
  try {
    const comprador = Agent.create(`comprador@${dom}`, url, { hosts: { [dom]: { url } } });
    const vendedor = Agent.create(`vendedor@${dom}`, url, { hosts: { [dom]: { url } } });
    await comprador.register({ adminToken: 't' }); await vendedor.register({ adminToken: 't' });
    await e.libro.topup(comprador.address, 1000, 'carga');
    // cotización escrow con deadline en 500ms
    const deadline = new Date(Date.now() + 500).toISOString();
    const q = await vendedor.quote({ to: comprador.address, house: dom, contract: 'escrow', price: 100, concept: 'trabajo con plazo', terms: { acceptance: 'x', deadline } });
    const qm = await comprador.waitFor((x) => x.id === q.id, { timeoutMs: 3000, everyMs: 100 });
    await comprador.accept((await comprador.open(qm.envelope)).content.body);
    // El aviso de plazo es un sobre de libro@ DIFERIDO al deadline: no llega con el recibo de accept
    // (ese es inmediato), sino cuando se cumple la fecha. Hay que esperarlo, no fotografiar el buzón antes.
    const plazoDe = async (parte) => {
      const until = Date.now() + 6000;
      while (Date.now() < until) {
        for (const m of (await parte.inbox({ limit: 100 })).filter((x) => x.envelope.from === `libro@${dom}`)) {
          const o = await parte.open(m.envelope);
          if (o.content.body?.aviso === 'plazo') return o.content.body;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      return null;
    };
    const avisoC = await plazoDe(comprador);
    const avisoV = await plazoDe(vendedor);
    assert.ok(avisoC, 'el comprador recibe el aviso de plazo');
    assert.ok(avisoV, 'el vendedor recibe el aviso de plazo');
    assert.match(avisoC.mensaje, /plazo del contrato/);
  } finally { await e.stop(); }
});
