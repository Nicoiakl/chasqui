// node --test test/
// Adaptador x402 (transporte HTTP v2): que la casa hable el cable del estándar de "402 Payment
// Required" para agentes, y que lo que anuncia coincida con lo que el Libro hace de verdad.
//
// Lo que estas pruebas cuidan, y por qué:
//   - `amount` viaja como CADENA de unidades atómicas. Un number ahí es plata en coma flotante.
//   - `network` es un identificador CAIP-2 válido. Un dominio con puntos NO lo es, y por eso la
//     red es `nyx5:1` y la casa viaja en `payTo`.
//   - El 402 que anuncia un precio y el 202 que lo cobra dicen el MISMO número, y el recibo lleva
//     el id del asiento real: si el anuncio y el libro se separan, el adaptador está mintiendo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { signObject, uuid } from '../src/nucleo/crypto.js';
import * as x402 from '../src/puentes/x402.js';

// Puerto propio de esta suite (npm test corre los archivos en paralelo). Lo cuida test/puertos.test.js.
const P = 4221;
const H = 'x402.test';
const hosts = { [H]: { url: `http://127.0.0.1:${P}` } };
let tmp, casa, caro, gratis, pagador;

const sobre = (from, to, keys, extra = {}) => signObject({ nyx5: '1', id: uuid(), from, to: [to], created: new Date().toISOString(), type: 'message', content: { media: 'text/plain', body: 'x' }, ...extra }, keys);
const post = async (e) => {
  const r = await fetch(`${hosts[H].url}/inbound`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(e) });
  return { status: r.status, headers: r.headers, body: await r.json() };
};
const abrir = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-x402-'));
  casa = await new Estafeta({ domain: H, port: P, dataDir: path.join(tmp, H), adminToken: 't', hosts, workerIntervalMs: 120, libro: { welcome: 0, feeBps: 0 }, log: () => {} }).start();
  caro = Agent.create(`caro@${H}`, hosts[H].url, { hosts });
  gratis = Agent.create(`gratis@${H}`, hosts[H].url, { hosts });
  pagador = Agent.create(`pagador@${H}`, hosts[H].url, { hosts });
  await caro.register({ adminToken: 't', inbox: { policy: 'stamp', price: 7 } });
  await gratis.register({ adminToken: 't' });
  await pagador.register({ adminToken: 't' });
  await casa.libro.topup(pagador.address, 100, 'carga');
});
after(async () => { await casa.stop(); });

// ---------- el cable ----------

test('el importe viaja como cadena de unidades atómicas, nunca como número', () => {
  const pr = x402.requisitos({ url: 'https://x/y', amount: 250, payTo: `caro@${H}` });
  assert.equal(pr.accepts[0].amount, '250');
  assert.equal(typeof pr.accepts[0].amount, 'string');
  assert.throws(() => x402.requisitos({ url: 'https://x/y', amount: 2.5, payTo: 'a@b' }), /non-negative integer/);
  assert.throws(() => x402.validarRequisitos({ ...pr, accepts: [{ ...pr.accepts[0], amount: 250 }] }), /string of atomic units/);
});

test('la red es un identificador CAIP-2 válido y un dominio con puntos no lo sería', () => {
  assert.match(x402.RED, x402.CAIP2);
  assert.ok(!x402.CAIP2.test('nyx5:x402.test'), 'un punto no es legal en una reference CAIP-2');
  const pr = x402.requisitos({ url: 'https://x/y', amount: 1, payTo: `caro@${H}` });
  assert.throws(() => x402.validarRequisitos({ ...pr, accepts: [{ ...pr.accepts[0], network: `nyx5:${H}` }] }), /not a CAIP-2/);
  // La casa no se pierde: viaja en payTo, que ya es agente@dominio.
  assert.equal(pr.accepts[0].payTo.split('@')[1], H);
});

test('leer PAYMENT-SIGNATURE separa "no pagaste" (402) de "no se entiende" (400)', () => {
  assert.deepEqual(x402.leerPago(undefined), { ok: false, code: 402, reason: 'PAYMENT-SIGNATURE header is required' });
  assert.equal(x402.leerPago('no-es-base64-json').code, 400);
  const malaRed = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { network: 'eip155:1' }, payload: {} })).toString('base64');
  assert.match(x402.leerPago(malaRed).reason, /settles on nyx5:1/);
  const bueno = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { network: x402.RED }, payload: { envelope: 'x' } })).toString('base64');
  assert.equal(x402.leerPago(bueno).ok, true);
});

test('la liquidación lleva los tres campos obligatorios aunque no haya cadena', () => {
  const s = x402.liquidacion({ transaction: '', payer: `pagador@${H}` });
  for (const campo of ['success', 'transaction', 'network']) assert.ok(campo in s, `falta ${campo}`);
  assert.equal(s.transaction, '');
  assert.equal(s.network, x402.RED);
});

// ---------- red real: USDC sobre una cadena EVM ----------

test('los requisitos en USDC llevan el dominio del token, que cambia entre redes', () => {
  const pr = x402.requisitosEvm({
    url: 'https://casa/x', amount: 1000, payTo: '0x000000000000000000000000000000000000dEaD',
    network: 'eip155:84532', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    tokenName: 'USDC', tokenVersion: '2',
  });
  const a = pr.accepts[0];
  assert.equal(a.amount, '1000');            // cadena, no número: son unidades atómicas
  assert.equal(a.extra.assetTransferMethod, 'eip3009');
  // `name` y `version` son el dominio EIP-712 del CONTRATO. En Base Sepolia el USDC se llama
  // "USDC" y en Base mainnet "USD Coin": ponerlo mal invalida la firma del pagador sin decir por qué.
  assert.equal(a.extra.name, 'USDC');
  assert.equal(a.extra.version, '2');
  x402.validarRequisitos(pr);
  // Falla cerrado si falta cualquier pieza del dominio del token.
  assert.throws(() => x402.requisitosEvm({ url: 'u', amount: 1, payTo: 'p', network: 'eip155:1', asset: 'a', tokenVersion: '2' }), /tokenName/);
});

test('una respuesta 402 puede ofrecer el token de la casa Y dólares reales, y el cliente elige', () => {
  // El array `accepts` del estándar es una LISTA de formas de pago aceptables. Un cliente Nyx5
  // toma la primera; uno genérico descarta la red que no conoce y paga en USDC. Nadie falla.
  const casa = x402.requisitos({ url: 'https://casa/x', amount: 25, payTo: 'caro@casa.test' });
  const usdc = x402.requisitosEvm({ url: 'https://casa/x', amount: 1000, payTo: '0x000000000000000000000000000000000000dEaD', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', tokenName: 'USD Coin', tokenVersion: '2' });
  const mixto = { ...casa, accepts: [...casa.accepts, ...usdc.accepts] };
  x402.validarRequisitos(mixto);
  assert.equal(mixto.accepts.length, 2);
  assert.equal(mixto.accepts[0].network, x402.RED);
  assert.equal(mixto.accepts[1].network, 'eip155:8453');
});

test('la clave de deduplicación sale del nonce, y sin nonce dice que no hay', () => {
  // El servidor de referencia de x402 NO deduplica: dos peticiones con la MISMA firma ejecutan las
  // dos el trabajo y sólo una liquida, así que entregas dos veces y cobras una. Aquí nombramos la
  // clave para poder usar el candado que ya tenemos (invariante 4).
  const pago = { accepted: { network: 'eip155:84532' }, payload: { authorization: { nonce: '0xABCDEF' } } };
  assert.equal(x402.claveDePago(pago), 'x402:eip155:84532:0xabcdef');
  assert.equal(x402.claveDePago({ accepted: { network: 'eip155:1' }, payload: {} }), null);
  assert.equal(x402.claveDePago({}), null);
});

test('el cliente del facilitador manda el sobre que el estándar pide, y no inventa el resultado', async () => {
  const vistas = [];
  const falso = async (url, opts) => {
    vistas.push({ url, cuerpo: opts?.body ? JSON.parse(opts.body) : null });
    if (url.endsWith('/verify')) return new Response(JSON.stringify({ isValid: true, payer: '0xabc' }), { status: 200 });
    return new Response(JSON.stringify({ success: true, transaction: '0xdead', network: 'eip155:84532' }), { status: 200 });
  };
  const f = x402.facilitador('https://facilitador.test/', { fetchImpl: falso });
  const req = { scheme: 'exact', network: 'eip155:84532' };
  const pago = { x402Version: 2, accepted: req, payload: {} };
  const v = await f.verificar(pago, req);
  assert.equal(v.body.isValid, true);
  const s = await f.liquidar(pago, req);
  assert.equal(s.body.transaction, '0xdead');
  // El sobre lleva las tres piezas que el spec exige, y la barra final de la base no se duplica.
  assert.deepEqual(Object.keys(vistas[0].cuerpo).sort(), ['paymentPayload', 'paymentRequirements', 'x402Version']);
  assert.equal(vistas[0].url, 'https://facilitador.test/verify');
});

test('un facilitador que responde basura no se confunde con un pago bueno', async () => {
  const falso = async () => new Response('<html>502</html>', { status: 502 });
  const f = x402.facilitador('https://facilitador.test', { fetchImpl: falso });
  const r = await f.verificar({}, {});
  assert.equal(r.status, 502);
  assert.ok(!r.body.isValid, 'nunca se debe leer un fallo como válido');
});

// ---------- la casa ----------

test('GET /x402/supported declara el scheme y la red de esta casa', async () => {
  const r = await fetch(`${hosts[H].url}/x402/supported`);
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.x402Version, 2);
  assert.equal(b.kinds[0].scheme, 'exact');
  assert.equal(b.kinds[0].network, x402.RED);
  assert.equal(b.kinds[0].extra.house, H);
  assert.ok(b.signers[x402.RED].length, 'la casa publica con qué clave firma');
});

test('un buzón con estampilla contesta 402 con el precio en la cabecera', async () => {
  const r = await fetch(`${hosts[H].url}/x402/inbox/caro`);
  assert.equal(r.status, 402);
  const pr = abrir(r.headers.get('payment-required'));
  assert.equal(pr.accepts[0].amount, '7');
  assert.equal(pr.accepts[0].payTo, `caro@${H}`);
  assert.equal(pr.resource.url, `https://${H}/x402/inbox/caro`);
  x402.validarRequisitos(pr); // lo que publicamos tiene que pasar nuestra propia validación
});

test('un buzón gratis lo dice, no da error: "no hay nada que pagar" es una respuesta', async () => {
  const r = await fetch(`${hosts[H].url}/x402/inbox/gratis`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).free, true);
  assert.equal((await fetch(`${hosts[H].url}/x402/inbox/nadie`)).status, 404);
});

test('entregar sin estampilla devuelve 402 y anuncia el mismo precio que cobra el Libro', async () => {
  const r = await post(sobre(pagador.address, caro.address, pagador.keys));
  assert.equal(r.status, 402);
  const pr = abrir(r.headers.get('payment-required'));
  assert.equal(pr.accepts[0].amount, '7', 'el 402 anuncia el precio real del buzón');
  assert.equal(pr.accepts[0].payTo, caro.address);
});

test('entregar con estampilla liquida y el recibo lleva el asiento real del Libro', async () => {
  const antes = await casa.libro.balance(caro.address);
  const r = await post(sobre(pagador.address, caro.address, pagador.keys, { stamp: { house: H, amount: 7 } }));
  assert.equal(r.status, 202);
  const s = abrir(r.headers.get('payment-response'));
  assert.equal(s.success, true);
  assert.equal(s.amount, '7');
  assert.equal(s.payer, pagador.address);
  assert.equal(s.network, x402.RED);
  // El id que publicamos como `transaction` tiene que existir en el diario: si no, es adorno.
  const diario = await casa.store.libroStatement(caro.address, 50);
  assert.ok(diario.some((e) => e.id === s.transaction), `el asiento ${s.transaction} no está en el diario`);
  assert.equal(await casa.libro.balance(caro.address), antes + 7);
});

test('un buzón cobra en tokens de la casa Y en dólares reales, y el que paga elige', async () => {
  // Esto es lo que vuelve el dinero real parte del flujo en vez de un experimento aparte: el
  // mismo buzón que cobra en tokens anuncia también un precio en dólares, si su dueño declaró a
  // qué dirección cobrarlos. La casa no controla esa dirección ni puede mover nada de ella.
  const dual = Agent.create(`dual@${H}`, hosts[H].url, { hosts });
  await dual.register({
    adminToken: 't',
    inbox: { policy: 'stamp', price: 25, price_usd: 10000 },      // 25 tok, o US$0,01
    wallet: { network: 'eip155:84532', address: '0x70A62bEC198672e2baD675Cd58fAA733c3566a5D' },
  });
  const r = await fetch(`${hosts[H].url}/x402/inbox/dual`);
  assert.equal(r.status, 402);
  const pr = abrir(r.headers.get('payment-required'));
  assert.equal(pr.accepts.length, 2, 'se ofrecen las dos monedas');

  const [casa, dolar] = pr.accepts;
  assert.equal(casa.network, x402.RED);
  assert.equal(casa.amount, '25');
  assert.equal(casa.payTo, dual.address);

  assert.equal(dolar.network, 'eip155:84532');
  assert.equal(dolar.amount, '10000');
  assert.equal(dolar.payTo, '0x70A62bEC198672e2baD675Cd58fAA733c3566a5D');
  // El nombre del token sale de la tabla leída del contrato, no de una constante escrita a mano.
  assert.equal(dolar.extra.name, x402.TOKEN_USD['eip155:84532'].name);
  assert.equal(dolar.asset, x402.TOKEN_USD['eip155:84532'].asset);
  x402.validarRequisitos(pr);

  // La billetera es pública y viaja en la tarjeta, para que quien vaya a pagar la pueda leer.
  const card = await (await fetch(`${hosts[H].url}/agents/dual`)).json();
  assert.deepEqual(card.wallets, [{ network: 'eip155:84532', address: '0x70A62bEC198672e2baD675Cd58fAA733c3566a5D' }]);
});

test('el agente ofrece TODAS las redes que declaró, y el que paga elige la suya', async () => {
  // No excluir mecanismos: quien sólo puede pagar en una cadena tiene que encontrar la suya en la
  // misma respuesta. `accepts` es una lista justamente para esto.
  const dir = '0x70A62bEC198672e2baD675Cd58fAA733c3566a5D';
  const multi = Agent.create(`multi@${H}`, hosts[H].url, { hosts });
  await multi.register({
    adminToken: 't',
    inbox: { policy: 'stamp', price: 25, price_usd: 10000 },
    wallets: [
      { network: 'eip155:8453', address: dir },     // Base, la barata
      { network: 'eip155:1', address: dir },        // Ethereum, la cara
      { network: 'eip155:42161', address: dir },    // Arbitrum
    ],
  });
  const pr = abrir((await fetch(`${hosts[H].url}/x402/inbox/multi`)).headers.get('payment-required'));
  assert.equal(pr.accepts.length, 4, 'el token de la casa más las tres redes');
  const redes = pr.accepts.map((a) => a.network);
  assert.deepEqual(redes, [x402.RED, 'eip155:8453', 'eip155:1', 'eip155:42161']);
  // Cada una lleva el contrato y el dominio de SU red, no el de la primera.
  for (const a of pr.accepts.slice(1)) {
    const t = x402.TOKEN_USD[a.network];
    assert.equal(a.asset, t.asset);
    assert.equal(a.extra.name, t.name);
    assert.equal(a.amount, '10000', 'un dólar es un dólar en cualquier red');
  }
  x402.validarRequisitos(pr);
});

test('dos billeteras para la misma red se rechazan: eso es ambigüedad, no opción', () => {
  const dir = '0x70A62bEC198672e2baD675Cd58fAA733c3566a5D';
  assert.throws(() => x402.validarBilleteras([
    { network: 'eip155:8453', address: dir },
    { network: 'eip155:8453', address: '0x0000000000000000000000000000000000000001' },
  ]), /same network/);
  // Una sola sigue funcionando, y se normaliza a lista.
  assert.deepEqual(x402.validarBilleteras({ network: 'eip155:1', address: dir }), [{ network: 'eip155:1', address: dir }]);
  assert.equal(x402.validarBilleteras([]), null);
});

test('no se inventa una conversión a dólares, y una red que no sabemos liquidar se rechaza', () => {
  // Convertir tokens de la casa a dólares exigiría un tipo de cambio que nadie fijó. Inventarlo
  // sería la cifra sin respaldo que este protocolo existe para encarecer: si el dueño no puso
  // precio en dólares, simplemente no hay opción en dólares.
  // BSC existe y es una red seria; simplemente no la sabemos liquidar, y por eso se rechaza. Esta
  // prueba YA falló dos veces al agregar redes nuevas (primero Ethereum, después Polygon), y las
  // dos veces tenía razón: la lista de redes que sabemos liquidar es una decisión, no un detalle,
  // y agregar una tiene que obligar a mirar aquí.
  assert.throws(() => x402.validarBilletera({ network: 'eip155:56', address: '0x70A62bEC198672e2baD675Cd58fAA733c3566a5D' }), /cannot settle on eip155:56/);
  assert.throws(() => x402.validarBilletera({ network: 'eip155:8453', address: 'no-es-una-direccion' }), /0x EVM address/);
  assert.equal(x402.validarBilletera(null), null);
});

test('el 402 se declara catalogable, y describe lo que de verdad se vende', async () => {
  // Un agente no navega, consulta directorios. La extensión `bazaar` es cómo un facilitador nos
  // publica en el suyo. Lo declarado tiene que ser lo que se vende: entregar un sobre en un buzón
  // que cobra, no una promesa más grande.
  const r = await fetch(`${hosts[H].url}/x402/inbox/caro`);
  const pr = abrir(r.headers.get('payment-required'));
  const b = pr.extensions?.bazaar;
  assert.ok(b, 'el 402 declara la extensión bazaar');
  assert.equal(b.info.input.method, 'POST');
  assert.deepEqual(b.info.input.body.to, [caro.address], 'describe el buzón real, no un ejemplo');
  assert.equal(b.info.output.example.code, 202);
  // El propio spec exige que `info` valide contra `schema`: si no, el facilitador lo descarta.
  assert.ok(b.schema.$schema && b.schema.required.includes('input'));
  for (const k of b.schema.properties.input.required) assert.ok(k in b.info.input, `info.input no trae ${k}`);
});

test('el 402 no se cuela en un buzón normal: sin precio no hay cabecera de pago', async () => {
  const r = await post(sobre(pagador.address, gratis.address, pagador.keys));
  assert.equal(r.status, 202);
  assert.equal(r.headers.get('payment-required'), null);
  assert.equal(r.headers.get('payment-response'), null);
});
