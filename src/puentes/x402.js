// Nyx5/1 — Adaptador x402 (transporte HTTP v2).
//
// x402 es el estándar de "402 Payment Required" para agentes: el servidor responde 402 con lo que
// cuesta el recurso, el cliente vuelve con la prueba de pago, el servidor responde 200 con el
// recibo de liquidación. Todo el protocolo viaja en CABECERAS, en base64; el cuerpo es asunto de
// cada implementación.
//
// Qué hace este módulo y qué NO hace:
//   SÍ  habla el cable de x402 v2: arma `PAYMENT-REQUIRED`, lee `PAYMENT-SIGNATURE`, arma
//       `PAYMENT-RESPONSE`, y declara capacidades en /x402/supported.
//   NO  inventa dinero nuevo. El pago sigue ocurriendo en el Libro, con un sobre firmado, como
//       siempre. x402 es el ANUNCIO del precio y el RECIBO de la liquidación, no una vía paralela
//       para mover tokens sin firma (eso rompería el invariante 2).
//
// Por qué `nyx5:1` y no `nyx5:<casa>`: CAIP-2 exige `namespace:reference` con
// namespace [-a-z0-9]{3,8} y reference [-_a-zA-Z0-9]{1,32}. Un dominio lleva puntos, y el punto
// NO es legal en una reference. Así que la red es el protocolo y la casa viaja en `payTo`, que ya
// es `agente@dominio`. Poner `nyx5:nyx5-com` sería una reference inventada que nadie sabe deshacer.
//
// Precedente de que esto es conforme sin blockchain: `cloudflare:402` en el repo oficial de x402
// liquida en fiat, firma con Ed25519, no emite hash de transacción y no usa facilitador externo.
// Ver docs/interop/x402.md, que dice también qué NO reclamamos.

export const X402_VERSION = 2;
export const RED = 'nyx5:1';
export const ACTIVO = 'NYX';           // el token de la casa: ni contrato ni ISO-4217, y se dice
export const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
const deB64 = (s) => JSON.parse(Buffer.from(String(s), 'base64').toString('utf8'));

// El importe va como CADENA de unidades atómicas. Un number aquí es un defecto: 2^53 y los
// decimales de coma flotante no son opinables cuando lo que se transporta es plata.
const monto = (n) => {
  if (!Number.isInteger(n) || n < 0) throw new Error(`x402: amount must be a non-negative integer, got ${n}`);
  return String(n);
};

// ---- lo que el servidor anuncia: 402 + PAYMENT-REQUIRED ----
export function requisitos({ url, amount, payTo, description, mimeType = 'application/json', flow = 'authorization', method = 'nyx5-envelope', error, serviceName, tags }) {
  if (!url) throw new Error('x402: resource.url is required');
  if (!payTo) throw new Error('x402: payTo is required');
  const pr = {
    x402Version: X402_VERSION,
    error: error || 'PAYMENT-SIGNATURE header is required',
    resource: { url, mimeType, ...(description ? { description } : {}), ...(serviceName ? { serviceName: serviceName.slice(0, 32) } : {}), ...(tags?.length ? { tags: tags.slice(0, 5).map((t) => String(t).slice(0, 32)) } : {}) },
    accepts: [{
      scheme: 'exact',
      network: RED,
      amount: monto(amount),
      asset: ACTIVO,
      payTo,
      maxTimeoutSeconds: 60,
      // `paymentFlow` y `assetTransferMethod` son claves RESERVADAS por el protocolo dentro de
      // `extra`; el resto de `extra` es del scheme. No inventar ahí.
      extra: { paymentFlow: flow, assetTransferMethod: method, house: payTo.split('@')[1] || null },
    }],
    extensions: {},
  };
  validarRequisitos(pr);
  return pr;
}

// Falla cerrado: si el objeto que vamos a publicar no cumple las reglas duras del spec, mejor
// romper aquí que emitir un 402 que un cliente conforme rechaza sin decir por qué.
export function validarRequisitos(pr) {
  if (pr.x402Version !== X402_VERSION) throw new Error(`x402: x402Version must be ${X402_VERSION}`);
  if (!pr.resource?.url) throw new Error('x402: resource.url is required');
  if (!Array.isArray(pr.accepts) || !pr.accepts.length) throw new Error('x402: accepts must be a non-empty array');
  for (const a of pr.accepts) {
    for (const campo of ['scheme', 'network', 'amount', 'asset', 'payTo']) if (!a[campo]) throw new Error(`x402: accepts[].${campo} is required`);
    if (typeof a.amount !== 'string' || !/^\d+$/.test(a.amount)) throw new Error('x402: amount must be a string of atomic units');
    if (!CAIP2.test(a.network)) throw new Error(`x402: network "${a.network}" is not a CAIP-2 identifier`);
    if (!Number.isFinite(a.maxTimeoutSeconds)) throw new Error('x402: maxTimeoutSeconds is required');
  }
  return pr;
}

export const cabeceraRequerido = (pr) => b64(validarRequisitos(pr));

// ---- lo que el cliente manda: PAYMENT-SIGNATURE ----
// Devuelve { ok, payload } o { ok:false, code, reason }. 400 (no 402) cuando el sobre x402 está
// malformado: el spec separa "no pagaste" de "lo que mandaste no se entiende".
export function leerPago(cabecera) {
  if (!cabecera) return { ok: false, code: 402, reason: 'PAYMENT-SIGNATURE header is required' };
  let p;
  try { p = deB64(cabecera); } catch { return { ok: false, code: 400, reason: 'PAYMENT-SIGNATURE is not base64-encoded JSON' }; }
  if (p?.x402Version !== X402_VERSION) return { ok: false, code: 400, reason: `unsupported x402Version (this house speaks ${X402_VERSION})` };
  if (!p.accepted || typeof p.accepted !== 'object') return { ok: false, code: 400, reason: 'accepted (the chosen PaymentRequirements) is required' };
  if (!p.payload || typeof p.payload !== 'object') return { ok: false, code: 400, reason: 'payload is required' };
  if (p.accepted.network !== RED) return { ok: false, code: 400, reason: `this house settles on ${RED}, not ${p.accepted.network}` };
  return { ok: true, payload: p };
}

// ---- lo que el servidor devuelve al liquidar: PAYMENT-RESPONSE ----
// `transaction` y `network` son OBLIGATORIOS aunque no haya cadena: cuando no hay hash, va cadena
// vacía. Aquí sí hay algo mejor que una cadena vacía — el id del asiento del Libro, que cualquiera
// puede pedir. Es la pieza que un explorador on-chain resuelve por hash.
export function liquidacion({ success = true, transaction = '', payer, amount, errorReason }) {
  const s = { success: !!success, transaction: String(transaction || ''), network: RED };
  if (payer) s.payer = payer;
  if (amount != null) s.amount = monto(amount);
  if (errorReason) s.errorReason = String(errorReason);
  return s;
}
export const cabeceraLiquidacion = (s) => b64(s);

// ---- declaración de capacidades (el `GET /supported` del facilitador, auto-alojado) ----
// La casa es su propio facilitador: verifica y liquida contra su propio Libro. El spec lo permite
// explícitamente ("or host the endpoints themselves").
export function soportado(dominio, clavesCasa = []) {
  return {
    x402Version: X402_VERSION,
    kinds: [{ x402Version: X402_VERSION, scheme: 'exact', network: RED, extra: { asset: ACTIVO, house: dominio, assetTransferMethod: 'nyx5-envelope' } }],
    extensions: [],
    signers: { [RED]: clavesCasa },
  };
}

// ---------- red real: USDC sobre una cadena EVM ----------
// La casa NO custodia nada. En el esquema `exact` el pagador firma una autorización EIP-3009 y el
// facilitador la difunde: el dinero va del pagador al que cobra, directo, y el facilitador ni
// siquiera puede cambiar el monto ni el destino. Nosotros sólo anunciamos el precio, preguntamos
// si la firma sirve, y pedimos que se liquide. Cero criptografía de cadena de nuestro lado.
//
// Por eso esto cabe en un módulo sin dependencias: todo lo que hace falta es base64, JSON y fetch.
export function requisitosEvm({ url, amount, payTo, network, asset, tokenName, tokenVersion, description, flow = 'authorization' }) {
  for (const [k, v] of Object.entries({ url, payTo, network, asset, tokenName, tokenVersion })) {
    if (!v) throw new Error(`x402 evm: falta ${k}`);
  }
  const pr = {
    x402Version: X402_VERSION,
    error: 'PAYMENT-SIGNATURE header is required',
    resource: { url, mimeType: 'application/json', ...(description ? { description } : {}) },
    accepts: [{
      scheme: 'exact', network, amount: monto(amount), asset, payTo, maxTimeoutSeconds: 60,
      // `name` y `version` son el dominio EIP-712 del CONTRATO del token, y cambian entre redes:
      // en Base Sepolia el USDC de Circle se llama "USDC" y en Base mainnet "USD Coin". Ponerlo
      // mal hace que la firma del pagador no valide, y el error no dice por qué.
      extra: { paymentFlow: flow, assetTransferMethod: 'eip3009', name: tokenName, version: tokenVersion },
    }],
    extensions: {},
  };
  validarRequisitos(pr);
  return pr;
}

// Cliente del facilitador. Es todo el "código de cadena" que necesita un servidor de recurso.
export function facilitador(base, { fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  const raiz = String(base).replace(/\/$/, '');
  const llamar = async (ruta, cuerpo) => {
    const r = await fetchImpl(`${raiz}${ruta}`, {
      method: cuerpo ? 'POST' : 'GET',
      headers: cuerpo ? { 'content-type': 'application/json' } : {},
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const txt = await r.text();
    let json; try { json = JSON.parse(txt); } catch { json = { _raw: txt.slice(0, 300) }; }
    return { status: r.status, body: json };
  };
  const sobre = (paymentPayload, paymentRequirements) => ({ x402Version: X402_VERSION, paymentPayload, paymentRequirements });
  return {
    soportado: () => llamar('/supported'),
    // `verify` es SOLO LECTURA por el spec: un isValid:true NO es dinero. Entre verificar y
    // liquidar el saldo puede gastarse. Se usa para rechazar temprano, nunca como garantía.
    verificar: (pago, req) => llamar('/verify', sobre(pago, req)),
    liquidar: (pago, req) => llamar('/settle', sobre(pago, req)),
  };
}

// Clave de deduplicación de un pago. El servidor de referencia de x402 NO deduplica: dos
// peticiones simultáneas con la MISMA firma pasan las dos por `verify` (que es de solo lectura),
// ejecutan las dos el trabajo, y sólo una liquida. O sea, entregas dos veces y cobras una.
// Aquí ya tenemos el candado que hace falta (`markSeenIfNew`, invariante 4); esto sólo nombra la
// clave. La red pone el nonce justamente para esto: es único por autorización.
export function claveDePago(pago) {
  const a = pago?.payload?.authorization;
  const red = pago?.accepted?.network;
  if (!red) return null;
  if (a?.nonce) return `x402:${red}:${String(a.nonce).toLowerCase()}`;
  // Sin nonce no hay antirreplay posible: mejor decirlo que fingir que se dedujo algo.
  return null;
}

// Dónde vive el dólar digital en cada red. Los valores de `name`/`version` son el dominio EIP-712
// del CONTRATO y NO se recuerdan: están leídos del contrato (`name()` y `version()`), porque
// cambian entre redes y equivocarse hace que ninguna firma valide sin decir por qué.
// Comprobado el 9-sep-2026 contra ambas cadenas.
export const TOKEN_USD = Object.freeze({
  'eip155:8453':  { asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', name: 'USD Coin', version: '2', decimals: 6, red: 'Base' },
  'eip155:84532': { asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', name: 'USDC',     version: '2', decimals: 6, red: 'Base Sepolia' },
});

// Una billetera declarada en una tarjeta. Es sólo una dirección a la que cobrar: la casa no la
// controla, no la custodia y no puede mover nada de ella. Falla cerrado ante una red que no
// conocemos, porque anunciar un precio en una red que no sabemos liquidar es prometer de gratis.
export function validarBilletera(w) {
  if (w == null) return null;
  if (typeof w !== 'object' || Array.isArray(w)) throw new Error('wallet must be an object');
  const { network, address } = w;
  if (!TOKEN_USD[network]) throw new Error(`this house cannot settle on ${network}; it knows: ${Object.keys(TOKEN_USD).join(', ')}`);
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('wallet.address must be a 0x EVM address');
  return { network, address };
}
