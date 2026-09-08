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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-email-'));
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
    assert.match(r.reason, /provider/);
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
    assert.match(captured.subject, /new message/i);
  } finally { await e.stop(); }
});

// El pie de la carta que sale hacia un humano. La regla que prueba este test no es de estilo:
// un correo que le dice a un agente "corre esto" es exactamente lo que parece una inyección de
// prompt, y el canal de distribución del sistema no puede enseñar esa costumbre.
test('el pie informa y no instruye, y solo sale si la casa lo enciende', async () => {
  const { outboundPayload, pieDeCarta } = await import('../src/puentes/email.js');
  const pie = pieDeCarta({ fromAgent: 'ana@nyx5.com', domain: 'nyx5.com' });
  // Dice qué es y qué pasa si respondes.
  assert.match(pie, /ana@nyx5\.com/);
  assert.match(pie, /reply to this email/);
  assert.match(pie, /https:\/\/nyx5\.com/);
  // No manda hacer nada: ni comandos, ni imperativos de instalación, ni urgencia.
  for (const prohibido of [/npx /, /npm i/, /corre /i, /ejecuta/i, /instala/i, /haz clic/i, /urgente/i, /debes /i, /ahora mismo/i]) {
    assert.ok(!prohibido.test(pie), `el pie instruye o presiona: ${prohibido}`);
  }
  // Apagado por defecto: el texto que ve un tercero lo decide el operador, no el código.
  const sin = outboundPayload({ fromAgent: 'ana@nyx5.com', to: 'x@gmail.com', subject: 's', text: 'hola' });
  assert.equal(sin.text, 'hola');
  const con = outboundPayload({ fromAgent: 'ana@nyx5.com', to: 'x@gmail.com', subject: 's', text: 'hola', footer: true });
  assert.match(con.text, /^hola\n/);
  assert.match(con.text, /open protocol/);
  // Y el Reply-To sigue siendo el agente, con o sin pie: la respuesta vuelve a su buzón.
  assert.equal(con.reply_to, 'ana@nyx5.com');
});

// Nació de un rebote real: Nicholas respondió un correo de un agente y le volvió
// "555 5.7.1 agente inexistente", porque el From era no-reply@ (un nombre reservado) y su cliente
// respondió al From en vez de al Reply-To. Depender del Reply-To no basta: el From tiene que ser
// una dirección que la casa sepa recibir.
test('el remitente es el agente, no la dirección reservada, así responder llega a su buzón', async () => {
  const { resendProvider, outboundPayload } = await import('../src/puentes/email.js');
  let enviado = null;
  const proveedor = resendProvider({
    apiKey: 'k', sender: 'no-reply@nyx5.com',
    fetchImpl: async (_u, o) => { enviado = JSON.parse(o.body); return { ok: true, json: async () => ({ id: 'x' }) }; },
  });
  await proveedor(outboundPayload({ fromAgent: 'ana@nyx5.com', to: 'x@gmail.com', subject: 's', text: 't' }));
  assert.equal(enviado.from, 'ana@nyx5.com', 'quien responda al From llega al agente');
  assert.deepEqual(enviado.reply_to, 'ana@nyx5.com');
  // El nombre reservado nunca puede quedar como remitente de un agente de la misma casa.
  assert.ok(!/no-reply/.test(enviado.from));

  // Un agente de OTRA casa no puede usurpar el remitente verificado: cae a la dirección de la casa.
  await proveedor(outboundPayload({ fromAgent: 'ajeno@otracasa.test', to: 'x@gmail.com', subject: 's', text: 't' }));
  assert.equal(enviado.from, 'no-reply@nyx5.com', 'solo el dominio verificado puede firmar el From');
  assert.equal(enviado.reply_to, 'ajeno@otracasa.test', 'pero la respuesta sigue apuntando a quien escribió');
});
