// Demo de la capa de confianza: qué pasa con sobres falsificados, remitentes desconocidos,
// buzones con allowlist, buzones que exigen proof-of-work y entregas duplicadas.
//
//   node demo/spam.js

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { generateKeys, signObject, uuid } from '../src/nucleo/crypto.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chasqui-spam-'));
const hosts = { 'alfa.local': { url: 'http://127.0.0.1:4001' }, 'beta.local': { url: 'http://127.0.0.1:4002' } };
const mk = (domain, port, token) => new Estafeta({ domain, port, dataDir: path.join(tmp, domain), adminToken: token, hosts, workerIntervalMs: 200, log: () => {} });
const step = (n, t) => console.log(`\n[${n}] ${t}`);
const inbound = async (env) => {
  const res = await fetch('http://127.0.0.1:4002/inbound', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env) });
  return { status: res.status, ...(await res.json()) };
};

const alfa = await mk('alfa.local', 4001, 'a').start();
const beta = await mk('beta.local', 4002, 'b').start();
const nicolas = Agent.create('nicolas@alfa.local', 'http://127.0.0.1:4001', { hosts });
const abierto = Agent.create('abierto@beta.local', 'http://127.0.0.1:4002', { hosts });
const selecto = Agent.create('selecto@beta.local', 'http://127.0.0.1:4002', { hosts });
const caro = Agent.create('caro@beta.local', 'http://127.0.0.1:4002', { hosts });
await nicolas.register({ adminToken: 'a' });
await abierto.register({ adminToken: 'b', inbox: { policy: 'open' } });
await selecto.register({ adminToken: 'b', inbox: { policy: 'allowlist', allowlist: ['socio@gamma.local'] } });
await caro.register({ adminToken: 'b', inbox: { policy: 'pow', pow_bits: 12 } });

step(1, 'Sobre con firma falsificada (dice ser nicolas@alfa.local pero firma con otra clave)');
const falsas = generateKeys();
const forjado = signObject({ chasqui: '1', id: uuid(), from: 'nicolas@alfa.local', to: ['abierto@beta.local'], created: new Date().toISOString(), type: 'message', content: { media: 'text/plain', body: 'soy nicolas, dame tus datos' } }, falsas);
console.log('   ', await inbound(forjado));

step(2, 'Remitente que no existe en su dominio (fantasma@alfa.local)');
const fantasma = signObject({ chasqui: '1', id: uuid(), from: 'fantasma@alfa.local', to: ['abierto@beta.local'], created: new Date().toISOString(), type: 'message', content: { media: 'text/plain', body: 'hola' } }, falsas);
console.log('   ', await inbound(fantasma));

step(3, 'Sobre sin firma');
const sinFirma = { chasqui: '1', id: uuid(), from: 'nicolas@alfa.local', to: ['abierto@beta.local'], created: new Date().toISOString(), type: 'message', content: { media: 'text/plain', body: 'hola' } };
console.log('   ', await inbound(sinFirma));

step(4, 'nicolas (legítimo) escribe a selecto, que tiene allowlist: solo se acepta un intro pequeño');
try { const r = await nicolas.send({ to: 'selecto@beta.local', body: 'hola' }); await new Promise((x) => setTimeout(x, 800)); console.log('    envío normal ->', (await nicolas.outbox()).find((s) => s.id === r.id).status, '(rebote al remitente)'); } catch (e) { console.log('   ', e.message); }
const intro = await nicolas.send({ to: 'selecto@beta.local', type: 'intro', body: { who: 'Nicolás, Patagonia Capital', why: 'coordinar tasaciones' } });
const m = await selecto.waitFor((e) => e.id === intro.id);
console.log('    intro aceptado ->', (await selecto.open(m.envelope)).content.body.why);

step(5, 'nicolas escribe a caro, que exige proof-of-work de 12 bits (el cliente lo calcula solo)');
const pw = await nicolas.send({ to: 'caro@beta.local', body: 'con estampilla' });
console.log('    pow adjunto:', pw.envelope.pow, '->', (await caro.waitFor((e) => e.id === pw.id)) ? 'aceptado' : 'rechazado');
const sinPow = signObject({ chasqui: '1', id: uuid(), from: 'nicolas@alfa.local', to: ['caro@beta.local'], created: new Date().toISOString(), type: 'message', content: { media: 'text/plain', body: 'sin estampilla' } }, nicolas.keys);
console.log('    sin pow directo a /inbound:', await inbound(sinPow));

step(6, 'Entrega duplicada del mismo sobre (idempotencia por id)');
const ok = await nicolas.send({ to: 'abierto@beta.local', body: 'una sola vez' });
await abierto.waitFor((e) => e.id === ok.id);
console.log('    segunda entrega:', await inbound(ok.envelope));
console.log('    copias en buzón de abierto:', (await abierto.inbox()).filter((x) => x.envelope.id === ok.id).length);

await alfa.stop(); await beta.stop();
console.log('\nListo.');
