// Demo store-and-forward: el destino está apagado cuando se envía; la estafeta emisora guarda,
// reintenta con backoff y entrega cuando el destino vuelve. Nada se pierde.
//
//   node demo/offline.js

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chasqui-off-'));
const hosts = { 'alfa.local': { url: 'http://127.0.0.1:4001' }, 'beta.local': { url: 'http://127.0.0.1:4002' } };
const mk = (domain, port, token) => new Estafeta({ domain, port, dataDir: path.join(tmp, domain), adminToken: token, hosts, workerIntervalMs: 300, retry: { baseMs: 300, maxMs: 1500 }, log: () => {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (n, t) => console.log(`\n[${n}] ${t}`);

step(1, 'Levantando ambas estafetas y registrando agentes');
const alfa = await mk('alfa.local', 4001, 'a').start();
let beta = await mk('beta.local', 4002, 'b').start();
const nicolas = Agent.create('nicolas@alfa.local', 'http://127.0.0.1:4001', { hosts });
const asistente = Agent.create('asistente@beta.local', 'http://127.0.0.1:4002', { hosts });
await nicolas.register({ adminToken: 'a' });
await asistente.register({ adminToken: 'b' });
await nicolas.resolver.agentCard('asistente@beta.local'); // tarjeta en caché, como pasaría en uso normal

step(2, 'Apagando la estafeta de beta.local');
await beta.stop();

step(3, 'nicolas envía igual: su estafeta acepta el sobre y lo encola');
const sent = await nicolas.send({ to: 'asistente@beta.local', body: 'Hola, te escribo mientras estás apagado.' });
await sleep(1500);
for (const s of await nicolas.outbox()) console.log(`    ${s.id.slice(0, 8)} : ${s.status}, ${s.attempts} intento/s, próximo ${s.next_attempt.slice(11, 19)}`);
console.log('    trabajos en cola de alfa:', alfa.store.listQueue().length);

step(4, 'beta.local vuelve a la vida');
beta = await mk('beta.local', 4002, 'b').start();

step(5, 'La estafeta de alfa reintenta y entrega');
const m = await asistente.waitFor((e) => e.id === sent.id, { timeoutMs: 15_000 });
console.log('    recibido en beta:', (await asistente.open(m.envelope)).content.body);
for (const s of await nicolas.outbox()) console.log(`    ${s.id.slice(0, 8)} : ${s.status}, ${s.attempts} intento/s`);
console.log('    trabajos en cola de alfa:', alfa.store.listQueue().length);

await alfa.stop(); await beta.stop();
console.log('\nListo.');
