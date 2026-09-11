// node --test test/
// LA CASA NO CUSTODIA. Es el invariante que separa a Nyx5 de un negocio financiero regulado, y
// hasta hoy era el único que no tenía ningún guardia: se cumplía por ausencia (nadie había
// escrito una billetera de la casa) y nada habría fallado si alguien la agregaba.
//
// Lo que se cuida, y por qué cada cosa:
//   - Un `payTo` de cadena SIEMPRE es una dirección que declaró el AGENTE. Si la casa pudiera
//     poner la suya, aunque fuese como respaldo, estaría recibiendo fondos de terceros.
//   - Sin billetera declarada NO hay opción en dólares. El silencio es la respuesta correcta;
//     un respaldo de la casa sería la custodia entrando por la puerta de atrás.
//   - Pasarle una billetera a la Estafeta no hace nada. Que la casa no tenga dónde guardar una
//     dirección de cobro es lo que vuelve el invariante estructural en vez de una costumbre.
//   - Ninguna dirección EVM del código fuente es un destinatario: todas son contratos de token.
//     Este barrido es el que caza el día que alguien pegue una dirección nuestra en el código.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import * as x402 from '../src/puentes/x402.js';

// Puerto propio de esta suite (npm test corre los archivos en paralelo). Lo cuida test/puertos.test.js.
const P = 4231;
const H = 'custodia.test';
const hosts = { [H]: { url: `http://127.0.0.1:${P}` } };
const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let tmp, casa;

const abrir = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
const cadena = (pr) => pr.accepts.filter((a) => a.network.startsWith('eip155:'));

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-custodia-'));
  // Se le pasa una billetera A PROPÓSITO: la casa tiene que ignorarla, no adoptarla.
  casa = await new Estafeta({
    domain: H, port: P, dataDir: path.join(tmp, H), adminToken: 't', hosts,
    workerIntervalMs: 120, libro: { welcome: 0, feeBps: 0 }, log: () => {},
    wallet: { network: 'eip155:8453', address: '0x000000000000000000000000000000000000c454' },
    wallets: [{ network: 'eip155:8453', address: '0x000000000000000000000000000000000000c454' }],
  }).start();
});
after(async () => { await casa?.stop?.(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('sin billetera declarada no hay opción en dólares: la casa no pone la suya de respaldo', async () => {
  const huerfano = Agent.create(`huerfano@${H}`, hosts[H].url, { hosts });
  // Precio en dólares SIN billetera: el caso exacto en que sería tentador poner un respaldo.
  await huerfano.register({ adminToken: 't', inbox: { policy: 'stamp', price: 25, price_usd: 10000 } });

  const r = await fetch(`${hosts[H].url}/x402/inbox/huerfano`);
  assert.equal(r.status, 402);
  const pr = abrir(r.headers.get('payment-required'));
  assert.deepEqual(cadena(pr), [], 'se anunció una red real sin que el agente declarara dónde cobrar');
  assert.equal(pr.accepts.length, 1, 'sólo queda el token de la casa');
  assert.equal(pr.accepts[0].network, x402.RED);
});

test('todo payTo de cadena es una dirección que declaró el agente, nunca una de la casa', async () => {
  const suyas = [
    { network: 'eip155:8453', address: '0x70A62bEC198672e2baD675Cd58fAA733c3566a5D' },
    { network: 'eip155:137', address: '0x48C2635eB66A04a58bDdEd1633df3E7583dFe72A' },
  ];
  const duena = Agent.create(`duena@${H}`, hosts[H].url, { hosts });
  await duena.register({ adminToken: 't', inbox: { policy: 'stamp', price: 25, price_usd: 10000 }, wallets: suyas });

  const pr = abrir((await fetch(`${hosts[H].url}/x402/inbox/duena`)).headers.get('payment-required'));
  const entradas = cadena(pr);
  assert.equal(entradas.length, suyas.length, 'una entrada por red declarada');

  const declaradas = new Set(suyas.map((w) => w.address.toLowerCase()));
  for (const a of entradas) {
    assert.ok(declaradas.has(String(a.payTo).toLowerCase()),
      `payTo ${a.payTo} en ${a.network} no es una dirección que el agente haya declarado`);
  }
  // Y la de la casa que se le pasó al constructor no aparece por ninguna parte.
  const crudo = JSON.stringify(pr).toLowerCase();
  assert.ok(!crudo.includes('c454'), 'la billetera pasada a la Estafeta se coló en el anuncio');
});

test('la tarjeta del dominio no lleva dirección de cobro: la casa no tiene dónde guardarla', async () => {
  const tarjeta = await casa.domainCard();
  const texto = JSON.stringify(tarjeta);
  const evm = texto.match(/0x[0-9a-fA-F]{40}/g) || [];
  assert.deepEqual(evm, [], `la tarjeta de la casa publica una dirección EVM: ${evm.join(', ')}`);
  for (const k of ['wallet', 'wallets', 'payTo', 'feeRecipient']) {
    assert.ok(!(k in tarjeta), `la tarjeta del dominio expone "${k}"`);
  }
});

test('ninguna dirección EVM del código fuente es un destinatario: todas son contratos de token', () => {
  const contratos = new Set(Object.values(x402.TOKEN_USD).map((t) => t.asset.toLowerCase()));
  const archivos = [];
  const recorrer = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) recorrer(p);
      else if (e.name.endsWith('.js')) archivos.push(p);
    }
  };
  recorrer(path.join(raiz, 'src'));
  recorrer(path.join(raiz, 'bin'));

  const ajenas = [];
  for (const f of archivos) {
    for (const dir of fs.readFileSync(f, 'utf8').match(/0x[0-9a-fA-F]{40}/g) || []) {
      if (!contratos.has(dir.toLowerCase())) ajenas.push(`${path.relative(raiz, f)}: ${dir}`);
    }
  }
  assert.deepEqual(ajenas, [], `direcciones EVM que no son contratos de token en TOKEN_USD:\n  ${ajenas.join('\n  ')}`);
  // Si este barrido deja de ver las que sí conocemos, alguien lo desarmó sin darse cuenta.
  assert.ok(contratos.size >= 7, `se esperaban al menos 7 contratos en TOKEN_USD, hay ${contratos.size}`);
});
