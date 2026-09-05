// Chasqui/1 — Validación de sobres y política de entrada (anti-spam y anti-abuso).
//
// Toda estafeta receptora aplica, en este orden:
//   1. forma del sobre (schema mínimo) y tamaño
//   2. vigencia (expires) y duplicados (id)
//   3. cadena de firma: dominio -> agente -> sobre   (obligatoria; sin firma no hay entrega)
//   4. política del agente destino: open | allowlist | pow | stamp (+ límite de tasa por dominio emisor)

import { checkPow } from '../nucleo/crypto.js';
import { parseAddress } from './resolver.js';

export const TYPES = new Set(['message', 'task', 'result', 'receipt', 'intro']);

export function validateEnvelope(env, { maxBytes = 1_048_576 } = {}) {
  const fail = (reason) => ({ ok: false, code: 400, reason });
  if (!env || typeof env !== 'object') return fail('sobre no es un objeto');
  if (env.chasqui !== '1') return fail('versión no soportada (se espera chasqui="1")');
  if (typeof env.id !== 'string' || env.id.length < 8 || env.id.length > 128) return fail('id inválido');
  try { parseAddress(env.from); } catch { return fail('from inválido'); }
  if (!Array.isArray(env.to) || env.to.length < 1 || env.to.length > 50) return fail('to debe ser una lista de 1 a 50 direcciones');
  for (const t of env.to) { try { parseAddress(t); } catch { return fail(`destinatario inválido: ${t}`); } }
  if (!TYPES.has(env.type)) return fail(`type inválido: ${env.type}`);
  if (Number.isNaN(Date.parse(env.created))) return fail('created debe ser ISO-8601');
  if (env.expires != null && Number.isNaN(Date.parse(env.expires))) return fail('expires debe ser ISO-8601');
  const hasPlain = env.content && typeof env.content === 'object' && typeof env.content.media === 'string';
  const hasEnc = env.encrypted && typeof env.encrypted === 'object' && typeof env.encrypted.ct === 'string';
  if (!hasPlain && !hasEnc) return fail('el sobre necesita content o encrypted');
  if (hasPlain && hasEnc) return fail('content y encrypted son excluyentes');
  if (env.attachments != null) {
    if (!Array.isArray(env.attachments)) return fail('attachments debe ser lista');
    for (const a of env.attachments) if (!a?.name || !a?.media || !a?.sha256 || !a?.url) return fail('adjunto incompleto (name, media, sha256, url)');
  }
  if (!env.signature || env.signature.alg !== 'Ed25519' || !env.signature.kid || !env.signature.value) return fail('sobre sin firma');
  const bytes = Buffer.byteLength(JSON.stringify(env));
  if (bytes > maxBytes) return { ok: false, code: 413, reason: `sobre de ${bytes} bytes supera el máximo ${maxBytes}` };
  return { ok: true };
}

// Limitador de tasa por clave (dominio emisor), ventana deslizante simple.
export class RateLimiter {
  constructor({ perMinute = 120 } = {}) { this.perMinute = perMinute; this.hits = new Map(); }
  allow(key) {
    const now = Date.now();
    const arr = (this.hits.get(key) || []).filter((t) => now - t < 60_000);
    if (arr.length >= this.perMinute) { this.hits.set(key, arr); return false; }
    arr.push(now); this.hits.set(key, arr); return true;
  }
}

// Política del agente destino sobre un sobre ya verificado criptográficamente.
export function applyInboxPolicy(env, agentRecord, senderDomain) {
  const inbox = agentRecord.inbox || { policy: 'open' };
  const { domain: fromDomain } = parseAddress(env.from);
  const permanent = (reason) => ({ ok: false, code: 403, reason });

  if (inbox.blocklist?.some((x) => x === env.from || x === fromDomain)) return permanent('remitente bloqueado');

  switch (inbox.policy) {
    case 'open':
      break;
    case 'allowlist': {
      const ok = inbox.allowlist?.some((x) => x === env.from || x === fromDomain);
      // Con allowlist, un desconocido solo puede presentarse con un "intro" pequeño.
      if (!ok && !(env.type === 'intro' && Buffer.byteLength(JSON.stringify(env)) <= 4096)) {
        return permanent('remitente no está en la allowlist (solo se aceptan sobres type=intro de hasta 4 KB)');
      }
      break;
    }
    case 'pow': {
      const bits = inbox.pow_bits ?? 16;
      const exempt = inbox.allowlist?.some((x) => x === env.from || x === fromDomain);
      if (!exempt && !checkPow(env.id, env.pow, bits)) return { ok: false, code: 402, reason: `se requiere proof-of-work de ${bits} bits`, pow_bits: bits };
      break;
    }
    case 'stamp': {
      // Estampilla pagada en el Libro de la casa del receptor. La cobra la estafeta al aceptar.
      const exempt = inbox.allowlist?.some((x) => x === env.from || x === fromDomain);
      if (!exempt) return { ok: true, stamp: { price: inbox.price ?? 1, house: inbox.house } };
      break;
    }
    default:
      return permanent(`política de buzón desconocida: ${inbox.policy}`);
  }
  if (senderDomain?.policy?.outbound === 'sealed' && !env.encrypted) return permanent('el dominio emisor exige cifrado y el sobre viene en claro');
  return { ok: true };
}
