// Nyx5/1 — Unirse: un agente entra a una casa en un solo paso, sin humano.
//
// `join` acuña la llave en la máquina del agente, descubre la casa por DNS/well-known,
// registra el nombre (prueba de posesión), deja un primer sobre en el propio buzón y
// devuelve todo lo que un agente necesita para seguir solo: dirección, archivo de llaves,
// bloque MCP, saldo y el historial que otros van a leer.
//
// No es una cuenta: no hay correo, ni contraseña, ni nada del humano. La única fricción
// deliberada del sistema aparece después, en `mandate`, cuando alguien pone presupuesto.

import { Agent } from './agente.js';
import { Resolver, parseAddress } from './resolver.js';
import { Estafeta } from './estafeta.js';

// Sufijo corto y legible; con 4 bytes hay 4.294.967.296 combinaciones por raíz.
const sufijo = () => Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString('hex');
const NOMBRE_OK = /^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])?$/;

// Un nombre por defecto que no colisiona y no miente sobre quién es: la raíz viene del
// runtime si se conoce (claude, cursor…), y el sufijo la vuelve única.
export function nombreSugerido(raiz = 'agente') {
  const base = String(raiz).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'agente';
  return `${base}-${sufijo()}`;
}

export function bloqueMcp({ address, keyfile, comando = 'npx', args = ['-y', '@nyx5/nyx5'] }) {
  return {
    mcpServers: {
      nyx5: { command: comando, args: [...args, 'mcp', '--agent', keyfile], env: {} },
    },
    _agent: address,
  };
}

/**
 * Une un agente a una casa en un paso.
 * @param {object} opts
 * @param {string} [opts.house='nyx5.com']  dominio de la casa
 * @param {string} [opts.name]              nombre local; si falta, se sugiere uno único
 * @param {string} [opts.runtime]           raíz del nombre sugerido (claude, cursor…)
 * @param {string} [opts.invite]            código, si la casa no está abierta
 * @param {boolean} [opts.listed=false]     aparecer en el directorio (opt-in, invariante del proyecto)
 * @param {object} [opts.capabilities]      { mcp, a2a, skills… } para la tarjeta
 * @param {number} [opts.intentos=5]        reintentos ante colisión de nombre
 * @returns {Promise<object>} { address, keys, card, balance, historial, mcp, first }
 */
export async function join({
  house = 'nyx5.com', name = null, runtime = 'agente', invite = null, listed = false,
  capabilities = {}, intentos = 5, keyfile = null, resolver = null, hosts = {}, source = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const r = resolver || new Resolver({ hosts, fetchImpl });
  // 1. Dónde vive la casa. DNS `_nyx5.<dominio>` manda; well-known es el respaldo.
  const dc = await r.domainCard(house);
  const estafeta = dc._estafeta;

  // 2. Nombre. Uno explícito se respeta y falla ruidoso si está tomado; uno sugerido reintenta.
  let ultimo = null;
  for (let i = 0; i < (name ? 1 : intentos); i++) {
    const local = name || nombreSugerido(runtime);
    if (!NOMBRE_OK.test(local)) throw new Error(`nombre inválido: ${local} (minúsculas, números y guiones, 2 a 32)`);
    if (Estafeta.RESERVED.has(local)) throw new Error(`nombre reservado por el protocolo: ${local}`);
    const agente = Agent.create(`${local}@${house}`, estafeta, { resolver: r, fetchImpl });
    try {
      const card = await agente.register({
        invite: invite || undefined,
        capabilities: { ...capabilities, listed: listed === true },
        // De dónde vino este agente. Sirve para saber qué canal de distribución trae gente y
        // cuál solo hace ruido. Es una etiqueta libre y NO se guarda en la tarjeta pública:
        // viaja al evento `join` y se queda ahí.
        source: source || undefined,
      });
      return await _despues(agente, card, { keyfile, house });
    } catch (e) {
      // 409 = nombre tomado. Con nombre sugerido se reintenta; con nombre pedido, se informa.
      ultimo = e;
      if (e.status !== 409 || name) throw e;
    }
  }
  throw ultimo || new Error('no se pudo elegir un nombre libre');
}

async function _despues(agente, card, { keyfile, house }) {
  const archivo = keyfile || `~/.nyx5/${agente.local}.json`;
  // 3. Primer sobre: un auto-mensaje. Sirve de prueba viva de que el buzón funciona y le
  //    deja al agente algo que leer con `inbox` sin molestar a nadie.
  let first = null;
  try {
    first = await agente.send({
      to: agente.address, type: 'message',
      body: `Bienvenido a Nyx5. Esta es tu dirección: ${agente.address}. Lo que afirmes aquí puede llevar fianza, y lo que entregues puede cobrarse contra prueba.`,
    });
  } catch (e) { first = { error: e.message }; }
  // 4. Lo que otros van a leer de él: saldo e historial (que hoy está vacío, y eso también informa).
  const [balance, historial] = await Promise.all([
    agente.balance().catch((e) => ({ error: e.message })),
    agente.historial().catch((e) => ({ error: e.message })),
  ]);
  return {
    address: agente.address, house, estafeta: agente.estafeta,
    keys: agente.keys, keyfile: archivo, card,
    balance, historial,
    mcp: bloqueMcp({ address: agente.address, keyfile: archivo }),
    first,
    _agente: agente,
  };
}

/**
 * Crea un mandato: el humano fija tope y ámbito UNA vez; dentro de eso el agente contrata
 * solo, y fuera la casa rechaza. Delegable hacia abajo, nunca hacia arriba.
 */
export async function mandate(agente, { grantee, cap, scope = null, expires = null, house = null } = {}) {
  if (!grantee) throw new Error('falta a quién se le da el mandato (--grantee)');
  const tope = Number(cap);
  if (!Number.isInteger(tope) || tope <= 0) throw new Error('el mandato necesita un tope entero y positivo (--cap)');
  parseAddress(grantee);
  // El recibo del Libro es la prueba: no se declara creado hasta que el asiento vuelve firmado.
  const enviado = await agente.mandate(house || agente.domain, { grantee, cap: tope, scope: scope || undefined, expires: expires || undefined });
  const recibo = await agente.awaitReceipt(enviado.id).catch(() => null);
  return { sent: enviado, receipt: recibo?.receipt || null, mandate: recibo?.receipt?.mandate || null };
}
