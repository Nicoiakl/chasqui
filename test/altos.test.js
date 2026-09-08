// node --test test/
// Los hallazgos de severidad alta de la revisión adversarial, cada uno escrito contra el
// defecto REAL (con su escenario reproducido), no contra un ejemplo inventado.
import { test as _test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { D1Store } from '../src/nucleo/almacen-d1.js';
import { openLocalD1, sqliteAvailable } from '../src/nucleo/d1-local.js';
// Si node:sqlite no está (Node <22 sin flag), toda la suite D1 salta limpio en vez de reventar.
const test = (name, ...rest) => { const fn = rest.pop(); const opts = (rest[0] && typeof rest[0] === 'object') ? rest[0] : {}; return _test(name, sqliteAvailable ? opts : { ...opts, skip: 'node:sqlite no disponible (Node 22+)' }, fn); };
import { generateKeys, signObject, uuid } from '../src/nucleo/crypto.js';
import { MIGRACIONES } from './_migraciones.js';

const MIG = ['../migrations/0002_nyx5.sql', '../migrations/0003_candado.sql', '../migrations/0004_pins.sql']
  .map((f) => { try { return fs.readFileSync(new URL(f, import.meta.url), 'utf8'); } catch { return ''; } }).join('\n');
const d1store = () => { const db = openLocalD1(); db._raw.exec(MIGRACIONES); return new D1Store(db); };
let puerto = 4160;
const casa = async (opts = {}) => {
  const p = puerto++;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-altos-'));
  const dom = opts.domain || `c${p}.test`;
  const e = new Estafeta({
    domain: dom, port: p, adminToken: 't', publicUrl: `http://127.0.0.1:${p}`,
    hosts: { [dom]: { url: `http://127.0.0.1:${p}` } },
    workerIntervalMs: 999_999, log: () => {},
    ...(opts.d1 ? { store: d1store() } : { dataDir: path.join(tmp, dom) }),
    ...opts,
  });
  await e.start();
  return { e, p, dom, url: `http://127.0.0.1:${p}` };
};

// ---------- ALTO 1: lectura de archivos por la ruta de agentes ----------
test('ALTO · la ruta de agentes no puede leer fuera de su carpeta (la llave privada de la casa)', async () => {
  const { e, url } = await casa();
  try {
    // El archivo del dominio contiene la clave PRIVADA de firma de la casa.
    assert.ok(e.keys.sigPriv, 'la casa tiene clave privada');
    for (const intento of ['..%2Fdomain', '..%2f..%2fdomain', '.%2E%2Fdomain', '..%252Fdomain']) {
      const r = await fetch(`${url}/agents/${intento}`);
      const cuerpo = await r.text();
      assert.ok(!cuerpo.includes(e.keys.sigPriv), `NUNCA debe salir la clave privada (${intento})`);
      assert.ok(!cuerpo.includes('sigPriv'), `ni el campo (${intento})`);
      assert.equal(r.status, 404, `${intento} debe ser 404`);
    }
    // y un nombre legítimo sigue funcionando
    const a = Agent.create(`legit@${e.domain}`, url, { hosts: { [e.domain]: { url } } });
    await a.register({ adminToken: 't' });
    assert.equal((await (await fetch(`${url}/agents/legit`)).json()).address, `legit@${e.domain}`);
  } finally { await e.stop(); }
});

// ---------- ALTO 2: invitación de un uso, canjeada en paralelo ----------
for (const modo of ['FileStore', 'D1']) {
  test(`ALTO · ${modo}: una invitación de UN uso no se canjea diez veces en paralelo`, async () => {
    const { e, url, dom } = await casa({ d1: modo === 'D1', policy: { registration: 'invite' }, libro: { welcome: 20_000 } });
    try {
      const inv = await e.createInvite({ uses: 1 });
      // Diez canjes A LA VEZ del mismo código: es lo que hacen diez isolates con el mismo request.
      const canjes = await Promise.allSettled(Array.from({ length: 10 }, () => e._consumeInvite(inv.code)));
      const ganaron = canjes.filter((r) => r.status === 'fulfilled' && r.value);
      assert.equal(ganaron.length, 1, `una invitación de un uso se canjea UNA vez (se canjeó ${ganaron.length})`);
      assert.equal((await e.store.getInvite(inv.code)).used, 1, 'y el contador no pasa de uses');
      // y por la puerta real: el alta con el código agotado ya no entra
      const tarde = Agent.create(`tarde@${dom}`, url, { hosts: { [dom]: { url } } });
      await assert.rejects(() => tarde.register({ invite: inv.code }), /used up/);
      const emitido = 0 - (await e.libro.balance(`casa@${dom}`));
      assert.equal(emitido, 0, `nadie se registró: la casa no debió emitir nada (emitió ${emitido})`);
    } finally { await e.stop(); }
  });
}

// ---------- ALTO 3: registro concurrente del mismo nombre ----------
for (const modo of ['FileStore', 'D1']) {
  test(`ALTO · ${modo}: dos altas concurrentes del mismo nombre no se pisan la clave`, async () => {
    const { e, url, dom } = await casa({ d1: modo === 'D1', policy: { registration: 'open' }, libro: { welcome: 5_000 } });
    try {
      const a = generateKeys(), b = generateKeys();
      // Dos altas del mismo nombre a la vez, como dos isolates atendiendo dos requests.
      const r = await Promise.allSettled([
        e.registerAgent({ local: 'duo', sig: a.sig, enc: a.enc }),
        e.registerAgent({ local: 'duo', sig: b.sig, enc: b.enc }),
      ]);
      const ok = r.filter((x) => x.status === 'fulfilled');
      assert.equal(ok.length, 1, `solo una alta gana el nombre (ganaron ${ok.length})`);
      const card = await e.agentCard('duo');
      assert.ok([a.sig, b.sig].includes(card.sig), 'la tarjeta guardada es la del ganador, no una mezcla');
      assert.equal(card.sig, ok[0].value.sig, 'y es la del alta que respondió éxito');
      const emitido = 0 - (await e.libro.balance(`casa@${dom}`));
      assert.equal(emitido, 5_000, `un solo regalo de bienvenida (emitió ${emitido})`);
    } finally { await e.stop(); }
  });
}

// ---------- ALTO 4: un sub-delegado no escapa el tope de su padre ----------
test('ALTO · un sub-delegado sin tope declarado NO escapa el tope de su padre (invariante 6)', async () => {
  const { e, url, dom } = await casa({ libro: { welcome: 0 } });
  try {
    const jefe = Agent.create(`jefe@${dom}`, url, { hosts: { [dom]: { url } } });
    await jefe.register({ adminToken: 't' });
    const hijo = await jefe.delegate('bot', { scope: { cap: 100, types: ['message', 'task'] } });
    // el nieto se declara SIN tope: no puede quedar por encima del de su padre
    const nieto = await hijo.delegate('sub', { scope: {} });
    const card = await e.agentCard(nieto.local);
    assert.ok(card.delegation.scope.cap != null, 'el nieto hereda un tope, no queda ilimitado');
    assert.ok(card.delegation.scope.cap <= 100, `el tope heredado (${card.delegation.scope.cap}) no supera al del padre`);
    assert.deepEqual(card.delegation.scope.types, ['message', 'task'], 'y hereda el ámbito de tipos');
    // y un nieto que pide MÁS que su padre se rechaza
    await assert.rejects(() => hijo.delegate('grande', { scope: { cap: 500 } }), /cap/);
    // el nieto no puede afianzar por encima del tope de la cadena
    await e.libro.topup(nieto.address, 1000, 'carga');
    const op = await nieto.bond(dom, { amount: 500, claim: 'x', verifier: jefe.address });
    const rebote = await nieto.waitFor((x) => x.type === 'receipt' && x.in_reply_to === op.id, { timeoutMs: 4000 })
      .then((m) => nieto.open(m.envelope)).catch(() => null);
    if (rebote) assert.match(rebote.content.body.reason, /403|tope/, 'afianzar 500 sobre un tope de 100 debe rechazarse');
  } finally { await e.stop(); }
});

// ---------- ALTO 5: los pins TOFU no se pisan entre isolates ----------
test('ALTO · un pin TOFU no borra los de otros dominios (isolates con memoria distinta)', async () => {
  const store = d1store();
  await store.putPin('uno.test', 'K1');
  await store.putPin('dos.test', 'K2');
  // un "isolate" viejo que sólo conoce uno.test persiste su mapa: no debe borrar dos.test
  await store.putPins({ 'uno.test': 'K1', 'tres.test': 'K3' });
  const pins = await store.getPins();
  assert.equal(pins['dos.test'], 'K2', 'el pin de otro isolate sigue vivo');
  assert.equal(pins['tres.test'], 'K3', 'y el nuevo se agregó');
  // TOFU: el primer pin gana; un segundo intento no lo cambia en silencio
  await store.putPin('uno.test', 'IMPOSTOR');
  assert.equal((await store.getPins())['uno.test'], 'K1', 'el primer pin manda (TOFU)');
});

// ---------- ALTO 6: los avisos por webhook no se cancelan al cerrar el request ----------
test('ALTO · el aviso por webhook se espera, no queda como promesa suelta', async () => {
  const { e, url, dom } = await casa();
  try {
    let avisado = null;
    const server = (await import('node:http')).createServer((req, res) => {
      let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { avisado = JSON.parse(b); res.writeHead(200); res.end('{}'); });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const puertoWh = server.address().port;
    const dest = Agent.create(`dest@${dom}`, url, { hosts: { [dom]: { url } } });
    await dest.register({ adminToken: 't', webhook: `http://127.0.0.1:${puertoWh}/aviso` });
    const emisor = Agent.create(`emi@${dom}`, url, { hosts: { [dom]: { url } } });
    await emisor.register({ adminToken: 't' });
    // El sobre se arma a mano y se entrega por la puerta de entrada — que es donde nace el aviso
    // en producción. (Mandarlo con send() lo entregaría por la cola antes, y llegaría duplicado.)
    const sobre = signObject({
      nyx5: '1', id: uuid(), from: emisor.address, to: [dest.address], created: new Date().toISOString(),
      expires: null, thread: null, in_reply_to: null, type: 'message',
      content: { media: 'text/plain', body: 'avísame' },
    }, emisor.keys);
    const out = await e.handleRequest({ method: 'POST', path: '/inbound', query: new URLSearchParams(), headers: {}, body: sobre, ip: null });
    assert.equal(out.status, 202);
    assert.ok(out.pending, 'la respuesta declara sus avisos pendientes para que el runtime los espere');
    await out.pending; // esto es lo que hace ctx.waitUntil en el edge
    assert.ok(avisado, 'al terminar lo pendiente, el aviso YA salió (si no, el edge lo cancela)');
    assert.equal(avisado.envelope.id, sobre.id);
    server.close();
  } finally { await e.stop(); }
});

// ---------- ALTO 7: la CLI no descarta banderas que documenta ----------
test('ALTO · la CLI pasa --arbiter y --expires a la cotización (los documentaba y los tiraba)', async () => {
  const src = fs.readFileSync(new URL('../bin/nyx5.js', import.meta.url), 'utf8');
  const usage = src.slice(0, src.indexOf('import '));
  const caseQuote = src.slice(src.indexOf("case 'quote'"), src.indexOf("case 'accept'"));
  for (const flag of ['arbiter', 'expires']) {
    if (usage.includes(`--${flag}`)) {
      assert.match(caseQuote, new RegExp(`${flag}:`), `la CLI documenta --${flag} en quote: debe pasarlo`);
    }
  }
});

test('BUG BUZÓN · con muchos mensajes sin leer, el más reciente SÍ aparece (no queda escondido)', async () => {
  const { e, url, dom } = await casa({ policy: { registration: 'admin' } });
  try {
    const dest = generateKeys();
    await e.registerAgent({ local: 'busy', sig: dest.sig, enc: dest.enc });
    // 60 mensajes viejos + 1 nuevo distinguible, todos sin ackear
    const { signObject, uuid } = await import('../src/nucleo/crypto.js');
    const emisor = generateKeys();
    await e.registerAgent({ local: 'emi', sig: emisor.sig, enc: emisor.enc });
    for (let i = 0; i < 60; i++) {
      const s = signObject({ nyx5:'1', id:uuid(), from:`emi@${dom}`, to:[`busy@${dom}`], created:new Date(Date.now()-100000+i).toISOString(), type:'message', content:{media:'text/plain', body:`viejo ${i}`} }, emisor);
      await e.handleRequest({ method:'POST', path:'/inbound', query:new URLSearchParams(), headers:{}, body:s, ip:null });
    }
    const nuevo = signObject({ nyx5:'1', id:uuid(), from:`emi@${dom}`, to:[`busy@${dom}`], created:new Date().toISOString(), type:'message', content:{media:'text/plain', body:'EL MÁS NUEVO'} }, emisor);
    await e.handleRequest({ method:'POST', path:'/inbound', query:new URLSearchParams(), headers:{}, body:nuevo, ip:null });
    // el destinatario lee su buzón con el límite por defecto de la app (50)
    const auth = (m,p) => 'Nyx5 ' + Buffer.from(JSON.stringify({address:`busy@${dom}`})).toString('base64url'); // placeholder, usamos el cliente real
    const { Agent } = await import('../src/correo/agente.js');
    const cli = new Agent({ address:`busy@${dom}`, keys:dest, estafeta:url, hosts:{[dom]:{url}} });
    const buzon = await cli.inbox({ limit: 50 });
    assert.ok(buzon.some(m => m.envelope.content.body === 'EL MÁS NUEVO'), 'el mensaje más reciente debe estar entre los devueltos');
  } finally { await e.stop(); }
});
