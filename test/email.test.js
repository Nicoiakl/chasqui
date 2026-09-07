// node --test test/
// D3: puente de correo (urn:nyx5:ext:email). Entrada: un email real entra al buzón como sobre
// SIN FIRMA, marcado no verificado, sin disfrazarse. Salida: el agente le escribe a un humano;
// sin proveedor configurado queda pendiente (no se inventa canal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { extractText } from '../src/puentes/email.js';

let puerto = 4260;
async function casa(email = {}) {
  const p = puerto++;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chasqui-email-'));
  const dom = `d${p}.test`;
  const e = new Estafeta({ domain: dom, port: p, dataDir: path.join(tmp, dom), adminToken: 't', publicUrl: `http://127.0.0.1:${p}`, hosts: { [dom]: { url: `http://127.0.0.1:${p}` } }, workerIntervalMs: 60, email, log: () => {} });
  await e.start();
  return { e, p, dom, url: `http://127.0.0.1:${p}` };
}

test('D3 · un email entrante cae al buzón como sobre SIN FIRMA, marcado no verificado', async () => {
  const { e, url, dom } = await casa();
  try {
    const bot = Agent.create(`bot@${dom}`, url, { hosts: { [dom]: { url } } });
    await bot.register({ adminToken: 't' });
    const r = await e.receiveEmail({ from: 'alice@gmail.com', to: `bot@${dom}`, subject: 'hola', text: 'te escribo desde el correo de siempre', messageId: 'msg-abc-123' });
    assert.equal(r.code, 202);
    const inbox = await bot.inbox();
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].from_verified, false, 'el buzón marca que NO viene verificado');
    assert.equal(inbox[0].via, 'email');
    const abierto = await bot.open(inbox[0].envelope);
    assert.equal(abierto.verified, false, 'open() no lo disfraza de firmado');
    assert.equal(abierto.via, 'email');
    assert.equal(abierto.from, 'alice@gmail.com', 'el remitente real es legible');
    assert.equal(abierto.subject, 'hola');
    assert.equal(abierto.content.body, 'te escribo desde el correo de siempre');
    // dedupe por message-id: reentregar no duplica
    const dup = await e.receiveEmail({ from: 'alice@gmail.com', to: `bot@${dom}`, text: 'otra vez', messageId: 'msg-abc-123' });
    assert.ok(dup.duplicate);
    assert.equal((await bot.inbox()).length, 1);
  } finally { await e.stop(); }
});

test('D3 · un email a un agente inexistente o de un remitente inválido se rechaza', async () => {
  const { e, dom } = await casa();
  try {
    assert.equal((await e.receiveEmail({ from: 'x@y.com', to: `nadie@${dom}`, text: 'x' })).code, 404);
    assert.equal((await e.receiveEmail({ from: 'no-es-email', to: `nadie@${dom}`, text: 'x' })).code, 400);
  } finally { await e.stop(); }
});

test('D3 · salida SIN proveedor queda pendiente (no se inventa canal)', async () => {
  const { e, url, dom } = await casa();
  try {
    const bot = Agent.create(`bot@${dom}`, url, { hosts: { [dom]: { url } } });
    await bot.register({ adminToken: 't' });
    const r = await bot.email({ to: 'humano@ejemplo.com', subject: 'hey', body: 'primer contacto' });
    assert.equal(r.pending, true);
    assert.match(r.reason, /proveedor/);
  } finally { await e.stop(); }
});

test('D3 · salida CON proveedor envía, con Reply-To = la dirección del agente', async () => {
  let captured = null;
  const provider = async (payload) => { captured = payload; return { id: 'prov-1' }; };
  const { e, url, dom } = await casa({ provider });
  try {
    const bot = Agent.create(`bot@${dom}`, url, { hosts: { [dom]: { url } } });
    await bot.register({ adminToken: 't' });
    const r = await bot.email({ to: 'humano@ejemplo.com', subject: 'hey', body: 'primer contacto' });
    assert.equal(r.ok, true);
    assert.equal(r.provider, 'prov-1');
    assert.deepEqual(captured.to, ['humano@ejemplo.com']);
    assert.equal(captured.reply_to, `bot@${dom}`, 'la respuesta del humano vuelve al buzón del agente');
    assert.equal(captured.text, 'primer contacto');
  } finally { await e.stop(); }
});

test('D3 · extractText saca el texto de multipart, quoted-printable y base64', () => {
  const mp = ['Content-Type: multipart/alternative; boundary="B"', '', '--B', 'Content-Type: text/plain', 'Content-Transfer-Encoding: quoted-printable', '', 'Hola=20mundo=3D caf=C3=A9', '--B', 'Content-Type: text/html', '', '<p>ignorar</p>', '--B--'].join('\r\n');
  assert.equal(extractText(mp), 'Hola mundo= café');
  const b64 = ['Content-Type: text/plain', 'Content-Transfer-Encoding: base64', '', Buffer.from('cuerpo en base64', 'utf8').toString('base64')].join('\r\n');
  assert.equal(extractText(b64), 'cuerpo en base64');
  const plain = ['Content-Type: text/plain', '', 'texto simple'].join('\n');
  assert.equal(extractText(plain), 'texto simple');
});

test('D3 · decodeMimeWords y addressFromHeader limpian header y remitente', async () => {
  const { decodeMimeWords, addressFromHeader } = await import('../src/puentes/email.js');
  assert.equal(decodeMimeWords('=?UTF-8?Q?Prueba_de_ENTRADA_=C2=B7_ok?='), 'Prueba de ENTRADA · ok');
  assert.equal(decodeMimeWords('=?UTF-8?B?' + Buffer.from('café','utf8').toString('base64') + '?='), 'café');
  assert.equal(decodeMimeWords('asunto simple'), 'asunto simple');
  assert.equal(addressFromHeader('Nicholas <nicholasiakl@gmail.com>'), 'nicholasiakl@gmail.com');
  assert.equal(addressFromHeader('bot@nyx5.com'), 'bot@nyx5.com');
  assert.equal(addressFromHeader('sin direccion'), null);
});

test('D3 · notify_email: quien registró un correo recibe un aviso cuando le escriben (no por recibos)', async () => {
  let captured = null;
  const provider = async (p) => { captured = p; return { id: 'n1' }; };
  const { e, url, dom } = await casa({ provider });
  try {
    const a = Agent.create(`a@${dom}`, url, { hosts: { [dom]: { url } } });
    const b = Agent.create(`b@${dom}`, url, { hosts: { [dom]: { url } } });
    await a.register({ adminToken: 't', notify_email: 'nicholas@gmail.test' });
    await b.register({ adminToken: 't' });
    await b.send({ to: a.address, body: 'hola a' });
    const until = Date.now() + 6000;
    while (!captured && Date.now() < until) await new Promise((r) => setTimeout(r, 150));
    assert.ok(captured, 'se disparó el aviso por email');
    assert.deepEqual(captured.to, ['nicholas@gmail.test']);
    assert.match(captured.subject, /mensaje nuevo/i);
  } finally { await e.stop(); }
});
