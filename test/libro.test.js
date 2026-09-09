// node --test test/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { Libro, LibroError } from '../src/libro/libro.js';
import { sha256hex } from '../src/nucleo/crypto.js';

const P1 = 4111, P2 = 4112, H = 'alfa.test';
const hosts = { 'alfa.test': { url: `http://127.0.0.1:${P1}` }, 'beta.test': { url: `http://127.0.0.1:${P2}` } };
let tmp, alfa, beta, nicolas, vendedor, verifica, foraneo;
const mk = (domain, port, token, libro) => new Estafeta({ domain, port, dataDir: path.join(tmp, domain), adminToken: token, hosts, workerIntervalMs: 120, retry: { baseMs: 120, maxMs: 500 }, libro, log: () => {} });
const bal = (acc) => alfa.libro.balance(acc);
const bounce = async (agent, sentId) => (await agent.open((await agent.waitFor((e) => e.type === 'receipt' && e.from === `postmaster@${H}` && e.in_reply_to === sentId, { timeoutMs: 6000 })).envelope)).content.body;
const receiveQuote = async (buyer, q) => (await buyer.open((await buyer.waitFor((e) => e.id === q.id)).envelope)).content.body;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-libro-test-'));
  alfa = await mk(H, P1, 'a', { feePct: 0.10, welcome: 0 }).start();
  beta = await mk('beta.test', P2, 'b').start();
  nicolas = Agent.create(`nicolas@${H}`, hosts[H].url, { hosts });
  vendedor = Agent.create(`vendedor@${H}`, hosts[H].url, { hosts });
  verifica = Agent.create(`verifica@${H}`, hosts[H].url, { hosts });
  foraneo = Agent.create('foraneo@beta.test', hosts['beta.test'].url, { hosts });
  for (const a of [nicolas, vendedor, verifica]) await a.register({ adminToken: 'a' });
  await foraneo.register({ adminToken: 'b' });
  await alfa.libro.topup(nicolas.address, 1000, 'carga');
});
after(async () => { await alfa.stop(); await beta.stop(); });

test('kernel: los asientos cuadran, nadie salvo la casa queda en negativo, todo está firmado', async () => {
  await assert.rejects(() => alfa.libro.post('mal', [{ account: nicolas.address, delta: -5 }]), /descuadrado/);
  await assert.rejects(() => alfa.libro.transfer(vendedor.address, nicolas.address, 10, 'sin saldo'), LibroError);
  const a = await alfa.libro.transfer(nicolas.address, vendedor.address, 100, 'prueba');
  assert.equal(a.lines.find((l) => l.account === `casa@${H}`).delta, 10);
  assert.equal(await bal(vendedor.address), 90);
  assert.ok(a.signature?.kid === alfa.keys.sig);
  const suma = Object.values((await alfa.store.libroState()).balances).reduce((s, v) => s + v, 0);
  assert.equal(suma, 0);
  // el fee es aritmética entera (basis points): sin punto flotante en el dinero
  assert.equal(new (alfa.libro.constructor)({ domain: H, store: alfa.store, keys: alfa.keys, feeBps: 2900 }).fee(100), 29);
});

test('spot: cotización firmada, aceptación ejecuta el asiento, recibos con ambos hashes, reuso rechazado', async () => {
  const before = await bal(nicolas.address);
  const q = await vendedor.quote({ to: nicolas.address, contract: 'spot', price: 50, concept: 'dato' });
  assert.ok(q.envelope.encrypted, 'la cotización viaja cifrada');
  const cot = await receiveQuote(nicolas, q);
  assert.equal(cot.signature.kid, vendedor.keys.sig);
  const acc = await nicolas.accept(cot);
  const r = await nicolas.awaitReceipt(acc.id);
  assert.equal(r.from, `libro@${H}`); assert.equal(r.receipt.contract.state, 'settled');
  assert.equal(r.receipt.cotizacion_sha256.length, 64); assert.equal(r.receipt.op_sha256.length, 64);
  assert.equal(await bal(nicolas.address), before - 50);
  // el vendedor también recibe el recibo
  const rv = await vendedor.waitFor((e) => e.type === 'receipt' && e.in_reply_to === acc.id);
  assert.equal((await vendedor.open(rv.envelope)).content.body.contract.id, r.receipt.contract.id);
  // misma cotización otra vez -> 409, y llega como rebote del postmaster
  const again = await nicolas.accept(cot);
  assert.match((await bounce(nicolas, again.id)).reason, /409/);
  assert.equal(await bal(nicolas.address), before - 50);
});

test('cotización dirigida a otro comprador se rechaza', async () => {
  const q = await vendedor.quote({ to: verifica.address, contract: 'spot', price: 10, concept: 'x' });
  const cot = await receiveQuote(verifica, q);
  const acc = await nicolas.accept(cot);
  assert.match((await bounce(nicolas, acc.id)).reason, /403/);
});

test('escrow: retener, entregar, liberar con fee; devolver sin fee; partes incorrectas rechazadas', async () => {
  const q = await vendedor.quote({ to: nicolas.address, contract: 'escrow', price: 200, concept: 'obra', arbiter: verifica.address });
  const cot = await receiveQuote(nicolas, q);
  const before = await bal(nicolas.address);
  const r = await nicolas.awaitReceipt((await nicolas.accept(cot)).id);
  const c = r.receipt.contract.id;
  assert.equal(r.receipt.contract.state, 'held'); assert.equal(await bal(`escrow:${c}`), 200); assert.equal(await bal(nicolas.address), before - 200);
  // el comprador no puede "entregar"; el vendedor sí
  assert.match((await bounce(nicolas, (await nicolas.deliver(H, c)).id)).reason, /403/);
  const d = await vendedor.awaitReceipt((await vendedor.deliver(H, c, { evidence_sha256: sha256hex('ok') })).id);
  assert.equal(d.receipt.contract.state, 'delivered');
  // entregado: el comprador ya no puede devolver por su cuenta
  assert.match((await bounce(nicolas, (await nicolas.refund(H, c)).id)).reason, /403/);
  // el vendedor no libera; el comprador sí
  assert.match((await bounce(vendedor, (await vendedor.release(H, c)).id)).reason, /403/);
  const vb = await bal(vendedor.address);
  const rel = await nicolas.awaitReceipt((await nicolas.release(H, c)).id);
  assert.equal(rel.receipt.contract.state, 'released'); assert.equal(await bal(vendedor.address), vb + 180); assert.equal(await bal(`escrow:${c}`), 0);
  // segundo escrow: el árbitro devuelve, sin fee
  const q2 = await vendedor.quote({ to: nicolas.address, contract: 'escrow', price: 100, concept: 'obra 2', arbiter: verifica.address });
  const c2 = (await nicolas.awaitReceipt((await nicolas.accept(await receiveQuote(nicolas, q2))).id)).receipt.contract.id;
  const nb = await bal(nicolas.address);
  const rf = await verifica.awaitReceipt((await verifica.refund(H, c2, 'no cumplió')).id);
  assert.equal(rf.receipt.contract.state, 'refunded'); assert.equal(await bal(nicolas.address), nb + 100);
});

test('fianza: deposita el que afirma; el verificador ejecuta o libera; el afianzado no puede liberarla antes de vencer', async () => {
  await alfa.libro.topup(vendedor.address, 100, 'x');
  const vb = await bal(vendedor.address);
  const b = await vendedor.awaitReceipt((await vendedor.bond(H, { amount: 60, claim: 'desplegado', verifier: verifica.address, expires: new Date(Date.now() + 3600e3).toISOString() })).id);
  const c = b.receipt.contract.id;
  assert.equal(await bal(vendedor.address), vb - 60);
  assert.match((await bounce(vendedor, (await vendedor.release(H, c)).id)).reason, /403/);
  assert.match((await bounce(nicolas, (await nicolas.forfeit(H, c)).id)).reason, /403/);
  const f = await verifica.awaitReceipt((await verifica.forfeit(H, c, 'falso')).id);
  assert.equal(f.receipt.contract.state, 'forfeited'); assert.equal(await bal(`escrow:${c}`), 0);
  // otra fianza, esta vez el verificador la libera: vuelve entera al afianzado
  const b2 = await vendedor.awaitReceipt((await vendedor.bond(H, { amount: 10, claim: 'ok', verifier: verifica.address })).id);
  const vb2 = await bal(vendedor.address);
  const r2 = await verifica.awaitReceipt((await verifica.release(H, b2.receipt.contract.id)).id);
  assert.equal(r2.receipt.contract.state, 'released'); assert.equal(await bal(vendedor.address), vb2 + 10);
});

test('mandato en cadena: sub-mandato acotado por el padre, cobro descuenta toda la cadena, revocación en cascada', async () => {
  const m = (await nicolas.awaitReceipt((await nicolas.mandate(H, { grantee: vendedor.address, cap: 100 })).id)).receipt.mandate;
  const tooBig = await vendedor.mandate(H, { grantee: verifica.address, cap: 150, parent: m.id });
  assert.match((await bounce(vendedor, tooBig.id)).reason, /exceeds/);
  const sub = (await vendedor.awaitReceipt((await vendedor.mandate(H, { grantee: verifica.address, cap: 40, parent: m.id })).id)).receipt.mandate;
  assert.deepEqual(sub.chain, [m.id, sub.id]); assert.equal(sub.root, nicolas.address);
  const nb = await bal(nicolas.address);
  const chOp = await verifica.charge(H, { mandate: sub.id, amount: 30, concept: 'uso' });
  const ch = await verifica.awaitReceipt(chOp.id);
  assert.equal(ch.receipt.asiento.lines.find((l) => l.delta === -30).account, nicolas.address); assert.equal(await bal(nicolas.address), nb - 30);
  assert.deepEqual(ch.receipt.chain.map((x) => x.spent), [30, 30]);
  // el mandante raíz también recibió el recibo del cobro
  await nicolas.waitFor((e) => e.type === 'receipt' && e.from === `libro@${H}` && e.in_reply_to === chOp.id);
  assert.match((await bounce(verifica, (await verifica.charge(H, { mandate: sub.id, amount: 20, concept: 'uso' })).id)).reason, /10 left/);
  // solo el mandatario cobra
  assert.match((await bounce(nicolas, (await nicolas.charge(H, { mandate: sub.id, amount: 1, concept: 'uso' })).id)).reason, /403/);
  // el raíz revoca el padre: cae también el hijo
  const rv = await nicolas.awaitReceipt((await nicolas.revoke(H, m.id)).id);
  assert.deepEqual(rv.receipt.revoked.sort(), [m.id, sub.id].sort());
  assert.match((await bounce(verifica, (await verifica.charge(H, { mandate: sub.id, amount: 1, concept: 'uso' })).id)).reason, /is not active/);
});

test('el alcance de un mandato es vocabulario cerrado: lo que el Libro no sabe aplicar, no lo guarda', async () => {
  // Defecto real del 9-sep-2026: el Libro guardaba y FIRMABA `max_per_charge` y una lista de
  // destinatarios, y después dejaba pasar un cobro único que las violaba. La restricción se veía
  // al leer el mandato y no hacía nada. Ahora se niega, y dice qué sí sabe aplicar.
  const r = await bounce(nicolas, (await nicolas.mandate(H, { grantee: vendedor.address, cap: 1000, scope: { allowed_payees: ['alguien@x.test'] } })).id);
  assert.match(r.reason, /cannot enforce "allowed_payees"/);
  assert.match(r.reason, /concepts, max_per_charge/, 'el rechazo tiene que decir qué SÍ se aplica');
  // Y las formas mal escritas de lo que sí conocemos tampoco entran.
  assert.match((await bounce(nicolas, (await nicolas.mandate(H, { grantee: vendedor.address, cap: 1000, scope: { max_per_charge: 0 } })).id)).reason, /positive integer/);
  assert.match((await bounce(nicolas, (await nicolas.mandate(H, { grantee: vendedor.address, cap: 100, scope: { max_per_charge: 500 } })).id)).reason, /cannot exceed the mandate cap/);
});

test('tope por cobro: el presupuesto ya no se puede vaciar de un solo golpe, ni por un nieto', async () => {
  const m = (await nicolas.awaitReceipt((await nicolas.mandate(H, { grantee: vendedor.address, cap: 1000, scope: { max_per_charge: 100 } })).id)).receipt.mandate;
  assert.equal(m.scope.max_per_charge, 100);
  // Un cobro por encima del tope se rechaza aunque quede saldo de sobra en el total.
  assert.match((await bounce(vendedor, (await vendedor.charge(H, { mandate: m.id, amount: 900, concept: 'de un golpe' })).id)).reason, /caps a single charge at 100/);
  // Uno por debajo pasa.
  await vendedor.awaitReceipt((await vendedor.charge(H, { mandate: m.id, amount: 100, concept: 'ok' })).id);
  // El tope del padre acota al hijo: el sub-mandato no puede saltárselo cobrando más de una vez.
  const sub = (await vendedor.awaitReceipt((await vendedor.mandate(H, { grantee: verifica.address, cap: 500, parent: m.id })).id)).receipt.mandate;
  assert.match((await bounce(verifica, (await verifica.charge(H, { mandate: sub.id, amount: 400, concept: 'saltándome al padre' })).id)).reason, /caps a single charge at 100/);
  await verifica.awaitReceipt((await verifica.charge(H, { mandate: sub.id, amount: 60, concept: 'dentro' })).id);
});

test('un mandato viejo con una restricción que no sabemos aplicar no cobra: falla cerrado', async () => {
  // Los mandatos creados ANTES del candado pueden llevar cualquier cosa en el alcance. El Libro no
  // puede rehacerlos, pero sí puede negarse a cobrar contra un límite que no sabe aplicar.
  const m = (await nicolas.awaitReceipt((await nicolas.mandate(H, { grantee: vendedor.address, cap: 1000 })).id)).receipt.mandate;
  const viejo = { ...m, scope: { daily_limit: 10 } };            // como si viniera del disco de ayer
  await alfa.store.libroPutMandate(viejo);
  assert.match((await bounce(vendedor, (await vendedor.charge(H, { mandate: m.id, amount: 5, concept: 'x' })).id)).reason, /cannot enforce/);
});

test('metered: aceptar una cotización medida crea un mandato con tope = precio', async () => {
  const q = await vendedor.quote({ to: nicolas.address, contract: 'metered', price: 90, concept: 'verificaciones', terms: { scope: { concepts: ['verificación'] } } });
  const r = await nicolas.awaitReceipt((await nicolas.accept(await receiveQuote(nicolas, q))).id);
  assert.equal(r.receipt.contract.state, 'active'); assert.equal(r.receipt.mandate.cap, 90);
  assert.match((await bounce(vendedor, (await vendedor.charge(H, { mandate: r.receipt.mandate.id, amount: 5, concept: 'otra cosa' })).id)).reason, /scope/);
  const nb = await bal(nicolas.address);
  await vendedor.awaitReceipt((await vendedor.charge(H, { mandate: r.receipt.mandate.id, amount: 5, concept: 'verificación' })).id);
  assert.equal(await bal(nicolas.address), nb - 5);
});

test('agente delegado: cadena de firmas verificable, ámbito de tipos y tope de tokens', async () => {
  const sub = await vendedor.delegate('bot', { scope: { types: ['message', 'task', 'receipt'], cap: 20 } });
  const card = await nicolas.resolver.agentCard(sub.address);
  assert.equal(card.delegation.by, vendedor.address); assert.equal(card.certification.kid, alfa.keys.sig);
  await assert.rejects(() => sub.send({ to: nicolas.address, type: 'intro', body: 'x' }), /solo puede enviar type/);
  const s = await sub.send({ to: nicolas.address, body: 'hola' });
  assert.equal((await nicolas.open((await nicolas.waitFor((e) => e.id === s.id)).envelope)).sender.delegation.by, vendedor.address);
  await alfa.libro.topup(sub.address, 100, 'x');
  const q = await verifica.quote({ to: sub.address, contract: 'spot', price: 50, concept: 'caro' });
  assert.match((await bounce(sub, (await sub.accept(await receiveQuote(sub, q))).id)).reason, /cap of 20/);
  // un delegado no puede tener más tope que su padre
  const nieto = await sub.delegate('nieto', { scope: { cap: 10 } });
  await assert.rejects(() => sub.delegate('nieto2', { scope: { cap: 50 } }), /higher cap/);
  assert.equal(nieto.address, `nieto.bot.vendedor@${H}`);
});

test('estampilla: se cobra al llegar; sin saldo rebota; un agente de otra casa paga con su cuenta aquí', async () => {
  const caro = Agent.create(`caro@${H}`, hosts[H].url, { hosts });
  await caro.register({ adminToken: 'a', inbox: { policy: 'stamp', price: 7 } });
  const cb = await bal(caro.address);
  const s = await nicolas.send({ to: caro.address, body: 'x' });
  assert.deepEqual(s.envelope.stamp, { house: H, amount: 7 });
  const m = await caro.waitFor((e) => e.id === s.id);
  assert.ok(m.stamp); assert.equal(await bal(caro.address), cb + 7);
  const s2 = await foraneo.send({ to: caro.address, body: 'sin saldo' });
  assert.match((await foraneo.open((await foraneo.waitFor((e) => e.type === 'receipt' && e.in_reply_to === s2.id, { timeoutMs: 6000 })).envelope)).content.body.reason, /insufficient balance in foraneo@beta\.test \(has 0, needs 7\)/);
  await alfa.libro.topup(foraneo.address, 10, 'x');
  const s3 = await foraneo.send({ to: caro.address, body: 'ahora sí' });
  await caro.waitFor((e) => e.id === s3.id);
  assert.equal(await bal(foraneo.address), 3);
});

test('idempotencia: reentregar el mismo sobre de operación no repite el asiento', async () => {
  const nb = await bal(nicolas.address);
  const q = await vendedor.quote({ to: nicolas.address, contract: 'spot', price: 10, concept: 'una vez' });
  const acc = await nicolas.accept(await receiveQuote(nicolas, q));
  await nicolas.awaitReceipt(acc.id);
  const r = await fetch(`http://127.0.0.1:${P1}/inbound`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(acc.envelope) });
  assert.equal((await r.json()).duplicate, true);
  assert.equal(await bal(nicolas.address), nb - 10);
});

test('lecturas directas: cuenta y contrato solo para las partes', async () => {
  const acc = await nicolas.balance();
  assert.equal(acc.balance, await bal(nicolas.address)); assert.ok(acc.contracts.length > 0);
  const c = acc.contracts[0];
  assert.equal((await nicolas.contract(H, c.id)).id, c.id);
  const outsider = Agent.create(`ajeno@${H}`, hosts[H].url, { hosts }); await outsider.register({ adminToken: 'a' });
  await assert.rejects(() => outsider.contract(H, c.id), /not a party/);
  const remote = await foraneo.balance(H);
  assert.equal(remote.account, foraneo.address);
});

test('D5 · comisión de referido: el asiento pasa a 4 líneas, cuadra en cero, y la paga el vendedor', async () => {
  // vendedor cotiza a nicolas 200 con 15% (1500 bps) para verifica, que trajo el trato. Fee de la casa 10%.
  const q = await vendedor.quote({ to: nicolas.address, house: H, contract: 'spot', price: 200,
    concept: 'dato con referido', referrer: { address: verifica.address, share: 1500 } });
  const cot = await receiveQuote(nicolas, q);
  const acc = await nicolas.accept(cot);
  const { asiento } = (await nicolas.awaitReceipt(acc.id)).receipt;
  const linea = (a) => asiento.lines.find((l) => l.account === a)?.delta ?? 0;
  // comprador -200 · casa +20 (10%) · referidor +30 (15%) · vendedor +150 (200-20-30). El comprador paga igual.
  assert.equal(linea(nicolas.address), -200);
  assert.equal(linea(`casa@${H}`), 20);
  assert.equal(linea(verifica.address), 30);
  assert.equal(linea(vendedor.address), 150);
  assert.equal(asiento.lines.length, 4, 'cuatro líneas: comprador, vendedor, casa, referidor');
  assert.equal(asiento.lines.reduce((s, l) => s + l.delta, 0), 0, 'el asiento cuadra en cero');
  assert.equal(asiento.meta.commission, 30);
  assert.equal(asiento.meta.referrer, verifica.address);
});

test('D5 · el fee de la casa más la comisión no pueden superar el 100% del precio', async () => {
  const mala = Libro.buildQuote({ seller: vendedor.address, buyer: nicolas.address, house: H, contract: 'spot',
    price: 100, concept: 'x', referrer: { address: verifica.address, share: 9500 } }, vendedor.keys); // 1000 + 9500 > 10000
  await assert.rejects(() => alfa.libro.verifyQuote(mala, nicolas.address), /supera el 100%/);
  // y una comisión no entera o <= 0 se rechaza ya al construir la cotización
  assert.throws(() => Libro.buildQuote({ seller: vendedor.address, buyer: nicolas.address, house: H, contract: 'spot',
    price: 100, concept: 'x', referrer: { address: verifica.address, share: 0 } }, vendedor.keys), /basis points/);
});
