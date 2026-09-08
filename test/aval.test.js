// node --test test/
// D6: aval de presentación con fianza. Un desconocido entra a un buzón con lista blanca solo si un
// tercero de la allowlist lo avala respaldándolo con una fianza que el receptor ejecuta si fue basura.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';

let puerto = 4230;
async function casa() {
  const p = puerto++;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-aval-'));
  const dom = `d${p}.test`;
  const e = new Estafeta({ domain: dom, port: p, dataDir: path.join(tmp, dom), adminToken: 't', publicUrl: `http://127.0.0.1:${p}`, hosts: { [dom]: { url: `http://127.0.0.1:${p}` } }, workerIntervalMs: 60, retry: { baseMs: 60, maxMs: 200 }, libro: { feePct: 0, welcome: 0 }, log: () => {} });
  await e.start();
  return { e, p, dom, url: `http://127.0.0.1:${p}` };
}
const bounce = (agent, sentId) => agent.waitFor((x) => x.type === 'receipt' && x.from.startsWith('postmaster@') && x.in_reply_to === sentId, { timeoutMs: 4000, everyMs: 100 });

test('D6 · un desconocido NO entra a un buzón con lista blanca sin aval', async () => {
  const { e, url, dom } = await casa();
  try {
    const alice = Agent.create(`alice@${dom}`, url, { hosts: { [dom]: { url } } });
    const carol = Agent.create(`carol@${dom}`, url, { hosts: { [dom]: { url } } });
    await alice.register({ adminToken: 't', inbox: { policy: 'allowlist', allowlist: [`bob@${dom}`] } });
    await carol.register({ adminToken: 't' });
    const s = await carol.send({ to: alice.address, body: 'hola, no me conoces' });
    const b = await bounce(carol, s.id);
    assert.match((await carol.open(b.envelope)).content.body.reason, /allowlist|aval/);
    assert.equal((await alice.inbox()).length, 0, 'no llegó nada al buzón de alice');
  } finally { await e.stop(); }
});

test('D6 · con un aval respaldado por fianza, el desconocido entra; y el receptor puede ejecutar la fianza', async () => {
  const { e, url, dom } = await casa();
  try {
    const alice = Agent.create(`alice@${dom}`, url, { hosts: { [dom]: { url } } });
    const bob = Agent.create(`bob@${dom}`, url, { hosts: { [dom]: { url } } });
    const carol = Agent.create(`carol@${dom}`, url, { hosts: { [dom]: { url } } });
    await alice.register({ adminToken: 't', inbox: { policy: 'allowlist', allowlist: [bob.address] } });
    await bob.register({ adminToken: 't' });
    await carol.register({ adminToken: 't' });
    await e.libro.topup(bob.address, 500, 'fondos para avalar');

    // Bob avala a Carol ante Alice, con 100 de fianza. Recibe el id del contrato de fianza.
    const v = await bob.vouch(dom, { forAddress: carol.address, receiver: alice.address, amount: 100, claim: 'respondo por Carol' });
    const bondId = (await bob.awaitReceipt(v.id)).receipt.contract.id;
    assert.equal(await e.libro.balance(bob.address), 400, 'la fianza retuvo 100 de Bob');

    // Carol se presenta ante Alice adjuntando el aval. Ahora sí entra.
    const s = await carol.send({ to: alice.address, body: 'me presenta Bob', extensions: { 'urn:nyx5:ext:aval': { voucher: bob.address, bond: bondId } } });
    const m = await alice.waitFor((x) => x.id === s.id, { timeoutMs: 4000, everyMs: 100 });
    assert.equal(m.vouched_by, bob.address, 'el buzón marca quién avaló');
    assert.equal((await alice.open(m.envelope)).content.body, 'me presenta Bob');

    // La presentación fue basura: Alice ejecuta la fianza. Los 100 de Bob pasan a Alice.
    const f = await alice.forfeit(dom, bondId, 'spam');
    await alice.awaitReceipt(f.id);
    assert.equal(await e.libro.balance(alice.address), 100, 'Alice cobró la fianza');
    assert.equal(await e.libro.balance(bob.address), 400, 'Bob no recupera lo afianzado');
  } finally { await e.stop(); }
});

test('D6 · un aval que apunta a una fianza de otro avalado se rechaza', async () => {
  const { e, url, dom } = await casa();
  try {
    const alice = Agent.create(`alice@${dom}`, url, { hosts: { [dom]: { url } } });
    const bob = Agent.create(`bob@${dom}`, url, { hosts: { [dom]: { url } } });
    const carol = Agent.create(`carol@${dom}`, url, { hosts: { [dom]: { url } } });
    const dave = Agent.create(`dave@${dom}`, url, { hosts: { [dom]: { url } } });
    await alice.register({ adminToken: 't', inbox: { policy: 'allowlist', allowlist: [bob.address] } });
    for (const a of [bob, carol, dave]) await a.register({ adminToken: 't' });
    await e.libro.topup(bob.address, 500, 'fondos');
    // Bob avala a Dave, no a Carol.
    const v = await bob.vouch(dom, { forAddress: dave.address, receiver: alice.address, amount: 100 });
    const bondId = (await bob.awaitReceipt(v.id)).receipt.contract.id;
    // Carol intenta colarse con la fianza de Dave.
    const s = await carol.send({ to: alice.address, body: 'me cuelo', extensions: { 'urn:nyx5:ext:aval': { voucher: bob.address, bond: bondId } } });
    const b = await bounce(carol, s.id);
    assert.match((await carol.open(b.envelope)).content.body.reason, /aval inválido|no avala a este remitente/);
  } finally { await e.stop(); }
});
