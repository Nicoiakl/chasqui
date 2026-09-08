// node --test test/
// Los cinco eventos del sprint y el vocabulario ACP. Sin instrumentación la distribución es
// ciega; con instrumentación que mide lo que no pasó, es peor. Aquí se prueba que cada evento
// se emite por el HECHO (el asiento que se movió), no por la intención.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { join, mandate } from '../src/correo/unirse.js';
import { estadoACP, contratoPublico, ACP } from '../src/libro/contratos.js';

const P = 4171;
const hosts = { 'i.test': { url: `http://127.0.0.1:${P}` } };
let tmp, casa;
const eventos = async (name) => (await casa.store.listEvents({ name })) || [];

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-instr-'));
  casa = new Estafeta({
    domain: 'i.test', port: P, dataDir: path.join(tmp, 'i.test'), adminToken: 't', hosts,
    workerIntervalMs: 100, policy: { registration: 'open', registrations_per_minute: 200 },
    libro: { welcome: 1000, feeBps: 1000 }, log: () => {},
  });
  await casa.start();
});
after(async () => { await casa.stop(); });

test('ACP: cada estado interno tiene fase pública, y el desenlace no se pierde', () => {
  assert.equal(estadoACP({ state: 'accepted' }).phase, 'Open');
  assert.equal(estadoACP({ state: 'held' }).phase, 'Funded');
  assert.equal(estadoACP({ state: 'delivered' }).phase, 'Submitted');
  assert.equal(estadoACP({ state: 'released' }).phase, 'Terminal');
  assert.equal(estadoACP({ state: 'released' }).outcome, 'accepted');
  assert.equal(estadoACP({ state: 'refunded' }).outcome, 'returned');
  assert.equal(estadoACP({ state: 'forfeited' }).outcome, 'forfeited');
  // Ningún estado interno del Libro puede quedar sin fase: si se agrega uno, esto falla.
  const internos = ['accepted', 'held', 'delivered', 'released', 'refunded', 'settled', 'posted', 'forfeited', 'active'];
  for (const e of internos) assert.ok(ACP[e], `el estado interno "${e}" no tiene fase ACP`);
  // La vista pública agrega el vocabulario sin borrar lo que ya había.
  const c = contratoPublico({ id: 'x', state: 'held', amount: 10 });
  assert.equal(c.amount, 10);
  assert.equal(c.acp.phase, 'Funded');
});

test('join emite un evento por agente que entró, y ninguno por un delegado', async () => {
  const antes = (await eventos('join')).length;
  const a = await join({ house: 'i.test', hosts, name: 'medido' });
  const ahora = await eventos('join');
  assert.equal(ahora.length, antes + 1);
  const e = ahora.at(-1);
  assert.equal(e.actor, a.address);
  assert.equal(e.data.via, 'open');
  assert.equal(e.data.listed, false);
  // Un subagente delegado no es un agente que llegó a la casa: no infla la métrica.
  await a._agente.delegate('bot', { scope: { cap: 10 } });
  assert.equal((await eventos('join')).length, antes + 1, 'un delegado no cuenta como join');
});

test('mandate_created se emite con el tope real, y solo cuando el Libro lo confirmó', async () => {
  const humano = await join({ house: 'i.test', hosts, name: 'jefa' });
  const bot = await join({ house: 'i.test', hosts, name: 'ayudante' });
  const antes = (await eventos('mandate_created')).length;
  const r = await mandate(humano._agente, { grantee: bot.address, cap: 400 });
  const e = (await eventos('mandate_created')).at(-1);
  assert.equal((await eventos('mandate_created')).length, antes + 1);
  assert.equal(e.actor, humano.address);
  assert.equal(e.data.cap, 400);
  assert.equal(e.data.mandate, r.mandate.id);

  // Un mandato es una FACULTAD, no una reserva: se crea aunque el mandante no tenga saldo, y
  // el tope se comprueba al cobrar. Lo que sí rechaza el Libro es sub-delegar más de lo propio.
  const sub = await bot._agente.mandate('i.test', { grantee: humano.address, cap: 900, parent: r.mandate.id });
  const rebote = await bot._agente.waitFor((x) => x.in_reply_to === sub.id && x.from.startsWith('postmaster@'), { timeoutMs: 5000 });
  assert.match((await bot._agente.open(rebote.envelope)).content.body.reason, /supera lo disponible del padre/);
  assert.equal((await eventos('mandate_created')).length, antes + 1, 'lo rechazado no se cuenta');
});

test('escrow_released y bond_forfeited salen del asiento, con quién decidió', async () => {
  const vendedor = await join({ house: 'i.test', hosts, name: 'prov' });
  const comprador = await join({ house: 'i.test', hosts, name: 'cli' });
  await vendedor._agente.quote({ to: comprador.address, contract: 'escrow', price: 120, concept: 'trabajo' });
  const sobre = await comprador._agente.waitFor((e) => e.from === vendedor.address && e.type === 'message', { timeoutMs: 5000 });
  const aceptada = await comprador._agente.accept((await comprador._agente.open(sobre.envelope)).content.body);
  await comprador._agente.awaitReceipt(aceptada.id);
  assert.equal((await eventos('first_quote')).at(-1).data.amount, 120);

  const contrato = (await comprador._agente.balance()).contracts.find((c) => c.kind === 'escrow' && c.amount === 120);
  assert.equal(contrato.acp.phase, 'Funded', 'la cuenta también habla ACP');
  const rel = await comprador._agente.release('i.test', contrato.id);
  await comprador._agente.awaitReceipt(rel.id);
  const e = (await eventos('escrow_released')).at(-1);
  assert.equal(e.actor, vendedor.address, 'el actor del cobro es quien cobró');
  assert.equal(e.data.amount, 120);
  assert.equal(e.data.by, comprador.address);
  assert.equal(e.data.arbitrado, false, 'lo liberó una parte, no el verificador');

  // Fianza ejecutada.
  const puesta = await vendedor._agente.bond('i.test', { amount: 40, claim: 'está listo', verifier: comprador.address });
  const rec = await vendedor._agente.awaitReceipt(puesta.id);
  const caida = await comprador._agente.forfeit('i.test', rec.receipt.contract.id, 'no estaba listo');
  await comprador._agente.awaitReceipt(caida.id);
  const f = (await eventos('bond_forfeited')).at(-1);
  assert.equal(f.actor, vendedor.address, 'el actor es quien perdió la fianza');
  assert.equal(f.data.amount, 40);
  assert.equal(f.data.by, comprador.address);
});

test('los eventos son de la casa, no públicos; el historial de un agente sí es público', async () => {
  const sinToken = await fetch(`http://127.0.0.1:${P}/eventos`);
  assert.equal(sinToken.status, 401);
  const conToken = await fetch(`http://127.0.0.1:${P}/eventos`, { headers: { authorization: 'Bearer t' } });
  assert.equal(conToken.status, 200);
  const j = await conToken.json();
  assert.ok(j.conteo.join >= 1 && j.conteo.mandate_created >= 1 && j.conteo.escrow_released >= 1);
  // Ningún evento guarda contenido de sobres ni datos del humano.
  const texto = JSON.stringify(j.eventos);
  assert.ok(!/notify_email|"body"|"content"/.test(texto), 'los eventos no llevan contenido');
  assert.equal((await fetch(`http://127.0.0.1:${P}/agents/prov/historial`)).status, 200);
});
