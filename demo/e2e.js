// Demo end-to-end: dos dominios (alfa.local y beta.local), cada uno con su estafeta,
// un agente en cada uno, un envío cifrado y firmado, y la respuesta de vuelta.
//
//   node demo/e2e.js

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-'));
const hosts = { 'alfa.local': { url: 'http://127.0.0.1:4001' }, 'beta.local': { url: 'http://127.0.0.1:4002' } };
const step = (n, t) => console.log(`\n[${n}] ${t}`);

step(1, 'Levantando las estafetas de alfa.local (4001) y beta.local (4002)');
const alfa = await new Estafeta({ domain: 'alfa.local', port: 4001, dataDir: path.join(tmp, 'alfa'), adminToken: 'admin-alfa', hosts, workerIntervalMs: 300, log: () => {} }).start();
const beta = await new Estafeta({ domain: 'beta.local', port: 4002, dataDir: path.join(tmp, 'beta'), adminToken: 'admin-beta', hosts, workerIntervalMs: 300, log: () => {} }).start();
console.log('    clave pública de alfa.local:', alfa.keys.sig.slice(0, 16) + '…');
console.log('    clave pública de beta.local:', beta.keys.sig.slice(0, 16) + '…');

step(2, 'Registrando nicolas@alfa.local y asistente@beta.local (cada uno genera sus claves, el dominio las certifica)');
const nicolas = Agent.create('nicolas@alfa.local', 'http://127.0.0.1:4001', { hosts });
const asistente = Agent.create('asistente@beta.local', 'http://127.0.0.1:4002', { hosts });
await nicolas.register({ adminToken: 'admin-alfa' });
await asistente.register({ adminToken: 'admin-beta', capabilities: { accepts: ['application/json'], mcp: 'http://127.0.0.1:4010/mcp' } });
console.log('    tarjeta de asistente certificada por', (await nicolas.resolver.agentCard('asistente@beta.local')).certification.kid.slice(0, 16) + '…');

step(3, 'nicolas envía una tarea cifrada extremo a extremo a asistente');
const sent = await nicolas.send({ to: 'asistente@beta.local', type: 'task', body: { skill: 'resumir', input: 'Resume en una frase qué es Nyx5.' }, receipt: 'delivered' });
console.log('    id del sobre:', sent.id);
console.log('    el sobre viaja cifrado; la estafeta ve esto:', JSON.stringify(sent.envelope.encrypted).slice(0, 80) + '…');

step(4, 'La estafeta de beta verifica la cadena dominio -> agente -> sobre, aplica política y guarda en el buzón');
const recibido = await asistente.waitFor((e) => e.id === sent.id);
console.log('    en buzón. from_verified =', recibido.from_verified, '| relay_verified =', recibido.relay_verified);

step(5, 'asistente abre el sobre (verifica firma y descifra), procesa, confirma (ack) y responde');
const abierto = await asistente.open(recibido.envelope);
console.log('    contenido descifrado:', JSON.stringify(abierto.content.body));
await asistente.ack(abierto.id);
const respuesta = await asistente.reply(recibido.envelope, { output: 'Nyx5 es el correo de los agentes: direcciones agente@dominio, buzón, firma y cifrado.' });
console.log('    respuesta enviada:', respuesta.id, '(mismo thread:', respuesta.envelope.thread === sent.id, ')');

step(6, 'nicolas recibe la respuesta y el acuse de entrega del postmaster');
const resp = await nicolas.waitFor((e) => e.id === respuesta.id);
const abiertaResp = await nicolas.open(resp.envelope);
console.log('    resultado:', abiertaResp.content.body.output);
const acuse = await nicolas.waitFor((e) => e.type === 'receipt' && e.from === 'postmaster@alfa.local');
console.log('    acuse postmaster:', JSON.stringify((await nicolas.open(acuse.envelope)).content.body));
await nicolas.ack([resp.envelope.id, acuse.envelope.id]);

step(7, 'Estado de la bandeja de salida de nicolas');
for (const s of await nicolas.outbox()) console.log(`    ${s.id.slice(0, 8)} -> ${s.to.join(',')} : ${s.status} (${s.attempts} intento/s)`);

console.log(`\nListo. Datos en ${tmp} (revisa mailbox/, archive/, outbox/, queue/ de cada dominio).`);
await alfa.stop(); await beta.stop();
