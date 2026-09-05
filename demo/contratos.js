// Demo del Libro: una casa (alfa.local) con su ledger, y agentes que cotizan, aceptan, entregan,
// afianzan, delegan y pagan estampillas. Un agente de otra casa (beta.local) también participa:
// su identidad viene verificada por el Correo, así que puede tener cuenta aquí sin login.
//
//   node demo/contratos.js

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { sha256hex } from '../src/nucleo/crypto.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chasqui-libro-'));
const hosts = { 'alfa.local': { url: 'http://127.0.0.1:4001' }, 'beta.local': { url: 'http://127.0.0.1:4002' } };
const mk = (domain, port, token, libro) => new Estafeta({ domain, port, dataDir: path.join(tmp, domain), adminToken: token, hosts, workerIntervalMs: 200, libro, log: () => {} });
const step = (n, t) => console.log(`\n[${n}] ${t}`);
const H = 'alfa.local';

const alfa = await mk('alfa.local', 4001, 'a', { feePct: 0.10, welcome: 100 }).start();
const beta = await mk('beta.local', 4002, 'b').start();
const nicolas = Agent.create('nicolas@alfa.local', 'http://127.0.0.1:4001', { hosts });
const verifica = Agent.create('verifica@alfa.local', 'http://127.0.0.1:4001', { hosts });
const constructor = Agent.create('constructor@alfa.local', 'http://127.0.0.1:4001', { hosts });
const foraneo = Agent.create('foraneo@beta.local', 'http://127.0.0.1:4002', { hosts });
for (const a of [nicolas, verifica, constructor]) await a.register({ adminToken: 'a' });
await foraneo.register({ adminToken: 'b' });
const saldos = async () => console.log('    saldos:', Object.entries(await alfa.store.libroState().balances).map(([k, v]) => `${k.replace('@alfa.local', '')}=${v}`).join('  '));

step(1, 'La casa carga saldo a nicolas (1000). Los demás recibieron 100 de bienvenida al registrarse');
await alfa.libro.topup('nicolas@alfa.local', 1000, 'presupuesto mensual Sigo');
await saldos();

step(2, 'SPOT: verifica cotiza a nicolas una verificación por 40; nicolas acepta; el asiento se ejecuta con 10 % para la casa');
const q1 = await verifica.quote({ to: 'nicolas@alfa.local', contract: 'spot', price: 40, concept: 'verificación de despliegue' });
const m1 = await nicolas.waitFor((e) => e.id === q1.id);
const cot = (await nicolas.open(m1.envelope)).content.body;
console.log('    cotización recibida (cifrada en tránsito), firmada por', cot.seller, '->', cot.price, 'tok');
const acc = await nicolas.accept(cot);
const r1 = await nicolas.awaitReceipt(acc.id);
console.log('    recibo de libro@:', r1.receipt.contract.state, '| asiento', r1.receipt.asiento.n, r1.receipt.asiento.lines.map((l) => `${l.account.replace('@alfa.local', '')}:${l.delta}`).join(' '));
console.log('    el recibo lleva hash de la cotización y de la aceptación:', r1.receipt.cotizacion_sha256.slice(0, 12) + '…', r1.receipt.op_sha256.slice(0, 12) + '…');
await saldos();

step(3, 'ESCROW: nicolas encarga a constructor por 300 con criterio de aceptación; los tokens quedan retenidos');
const q2 = await constructor.quote({ to: 'nicolas@alfa.local', contract: 'escrow', price: 300, concept: 'landing Drake Review', terms: { acceptance: 'lighthouse >= 90 en móvil', deadline: '2026-09-15' }, arbiter: 'verifica@alfa.local' });
const cot2 = (await nicolas.open((await nicolas.waitFor((e) => e.id === q2.id)).envelope)).content.body;
const acc2 = await nicolas.accept(cot2);
const r2 = await nicolas.awaitReceipt(acc2.id);
const contrato = r2.receipt.contract.id;
console.log('    contrato', contrato.slice(0, 8), 'estado', r2.receipt.contract.state);
await saldos();
console.log('    constructor entrega con hash de la evidencia');
const evidencia = sha256hex('reporte lighthouse: performance 94');
const del = await constructor.deliver(H, contrato, { evidence_sha256: evidencia, note: 'lighthouse 94 móvil' });
await constructor.awaitReceipt(del.id);
console.log('    nicolas libera: constructor recibe 270, la casa 30');
const rel = await nicolas.release(H, contrato);
const r3 = await nicolas.awaitReceipt(rel.id);
console.log('    estado', r3.receipt.contract.state, '| historial:', r3.receipt.contract.history.map((h) => h.op).join(' -> '));
await saldos();

step(4, 'FIANZA: constructor afirma "desplegado y verificado" y deposita 50; verifica lo derriba y la fianza va a la casa');
const b = await constructor.bond(H, { amount: 50, claim: 'sigo.uk desplegado y verificado en producción', verifier: 'verifica@alfa.local', evidence_sha256: sha256hex('log de deploy') });
const rb = await constructor.awaitReceipt(b.id);
console.log('    fianza', rb.receipt.contract.id.slice(0, 8), 'estado', rb.receipt.contract.state);
const ff = await verifica.forfeit(H, rb.receipt.contract.id, 'el endpoint /health responde 500');
const rf = await verifica.awaitReceipt(ff.id);
console.log('    verifica ejecuta la fianza:', rf.receipt.contract.state, '| razón registrada:', rf.receipt.contract.history.at(-1).reason);
await saldos();

step(5, 'MANDATO EN CADENA: nicolas da mandato 200 a constructor; constructor sub-delega 80 a un subagente; el subagente cobra y paga nicolas');
const md = await nicolas.mandate(H, { grantee: 'constructor@alfa.local', cap: 200, scope: { concepts: ['tokens de modelo', 'hosting'] } });
const mandato = (await nicolas.awaitReceipt(md.id)).receipt.mandate;
console.log('    mandato raíz', mandato.id.slice(0, 8), 'cap', mandato.cap);
const tester = await constructor.delegate('tester', { scope: { types: ['message', 'task', 'result', 'receipt'], cap: 100 } });
console.log('    subagente delegado:', tester.address, '| tarjeta certificada por el dominio y firmada por constructor');
const sub = await constructor.mandate(H, { grantee: tester.address, cap: 80, parent: mandato.id });
const submandato = (await constructor.awaitReceipt(sub.id)).receipt.mandate;
console.log('    sub-mandato', submandato.id.slice(0, 8), 'cap', submandato.cap, 'cadena', submandato.chain.map((x) => x.slice(0, 8)).join(' > '));
const ch = await tester.charge(H, { mandate: submandato.id, amount: 30, concept: 'tokens de modelo' });
const rc = await tester.awaitReceipt(ch.id);
console.log('    cobro de 30: paga', rc.receipt.asiento.lines[0].account, '| cadena descontada:', rc.receipt.chain.map((x) => `${x.spent}/${x.cap}`).join(', '));
const over = await tester.charge(H, { mandate: submandato.id, amount: 70, concept: 'tokens de modelo' });
const bounce = await tester.waitFor((e) => e.type === 'receipt' && e.from === 'postmaster@alfa.local' && e.in_reply_to === over.id);
console.log('    cobro de 70 (supera lo que queda):', (await tester.open(bounce.envelope)).content.body.reason);
await saldos();

step(6, 'AGENTE DELEGADO CON ÁMBITO: tester solo puede enviar ciertos tipos y aceptar hasta 100');
try { await tester.send({ to: 'nicolas@alfa.local', type: 'intro', body: 'hola' }); } catch (e) { console.log('    intro bloqueado por la estafeta:', e.message); }
const q3 = await verifica.quote({ to: tester.address, contract: 'spot', price: 150, concept: 'auditoría' });
const cot3 = (await tester.open((await tester.waitFor((e) => e.id === q3.id)).envelope)).content.body;
const acc3 = await tester.accept(cot3);
const b3 = await tester.waitFor((e) => e.type === 'receipt' && e.from === 'postmaster@alfa.local' && e.in_reply_to === acc3.id);
console.log('    aceptar 150 con tope 100:', (await tester.open(b3.envelope)).content.body.reason);

step(7, 'ESTAMPILLA: caro@ cobra 5 tok por escribirle; un agente de otra casa paga desde su cuenta aquí; uno sin saldo rebota');
const caro = Agent.create('caro@alfa.local', 'http://127.0.0.1:4001', { hosts });
await caro.register({ adminToken: 'a', inbox: { policy: 'stamp', price: 5 } });
await alfa.libro.topup('foraneo@beta.local', 20, 'cuenta de un agente de otra casa');
const st = await foraneo.send({ to: 'caro@alfa.local', body: 'hola desde beta, con estampilla' });
const got = await caro.waitFor((e) => e.id === st.id);
console.log('    llegó con estampilla, asiento', got.stamp.slice(0, 8), '| stamp en el sobre:', JSON.stringify(st.envelope.stamp));
const pobre = Agent.create('pobre@beta.local', 'http://127.0.0.1:4002', { hosts });
await pobre.register({ adminToken: 'b' });
const st2 = await pobre.send({ to: 'caro@alfa.local', body: 'sin saldo' });
const b4 = await pobre.waitFor((e) => e.type === 'receipt' && e.in_reply_to === st2.id);
console.log('    sin saldo:', (await pobre.open(b4.envelope)).content.body.reason);
await saldos();

step(8, 'El diario: cada asiento firmado por la casa, con referencias a los sobres que lo causaron');
for (const a of await alfa.libro.journal()) console.log(`    #${a.n} ${a.concept.slice(0, 48).padEnd(48)} ${a.lines.map((l) => `${l.account.replace('@alfa.local', '').replace('@beta.local', '@beta')}:${l.delta > 0 ? '+' : ''}${l.delta}`).join(' ')}`);
const total = Object.values(await alfa.store.libroState().balances).reduce((s, v) => s + v, 0);
console.log('    suma de todos los saldos (debe ser 0):', total);

await alfa.stop(); await beta.stop();
console.log(`\nListo. Datos en ${tmp}/alfa.local/libro`);
