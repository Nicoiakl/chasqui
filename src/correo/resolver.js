// Chasqui/1 — Resolver: de una dirección agente@dominio a una tarjeta verificada.
//
// Orden de resolución del dominio (equivalente al registro MX del correo):
//   1. Override local (hosts.json / opción hosts)    -> pruebas y redes privadas
//   2. DNS TXT en _chasqui.<dominio>                  -> ancla pública de confianza
//   3. https://<dominio>/.well-known/chasqui.json     -> fallback sin DNS
//
// Cadena de confianza: clave del dominio (anclada en DNS o pineada) -> certifica la tarjeta
// del agente -> la clave del agente firma cada sobre.

import dns from 'node:dns/promises';
import { verifyObject } from '../nucleo/crypto.js';

export function parseAddress(address) {
  const m = /^([a-z0-9][a-z0-9._-]{0,63})@([a-z0-9.-]+)$/i.exec(String(address || ''));
  if (!m) throw new Error(`dirección inválida: ${address}`);
  return { local: m[1].toLowerCase(), domain: m[2].toLowerCase() };
}

export function parseTxtRecord(txt) {
  const out = {};
  for (const part of txt.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k && rest.length) out[k.trim()] = rest.join('=').trim();
  }
  return out;
}

export class Resolver {
  constructor({ hosts = {}, fetchImpl = globalThis.fetch, cacheTtlMs = 5 * 60 * 1000, pins = {}, timeoutMs = 5000 } = {}) {
    this.hosts = { ...hosts };          // { "beta.local": { url: "http://localhost:4002", sig?: "<pub>" } }
    this.fetch = fetchImpl;
    this.cacheTtlMs = cacheTtlMs;
    this.pins = { ...pins };            // dominio -> clave pública pineada (TOFU o DNS)
    this.timeoutMs = timeoutMs;
    this.cache = new Map();
  }

  setHost(domain, entry) { this.hosts[domain] = entry; this.cache.clear(); }
  invalidate(key) { if (key) this.cache.delete(key); else this.cache.clear(); }

  _cached(key) {
    const hit = this.cache.get(key);
    if (hit && hit.until > Date.now()) return hit.value;
    return null;
  }
  _remember(key, value) { this.cache.set(key, { value, until: Date.now() + this.cacheTtlMs }); }

  async _get(url) {
    const res = await this.fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw Object.assign(new Error(`GET ${url} -> ${res.status}`), { permanent: res.status === 404 || res.status === 410 });
    return res.json();
  }

  // Devuelve { url, sig? } donde vive la estafeta del dominio.
  async locate(domain) {
    domain = domain.toLowerCase();
    if (this.hosts[domain]) return { source: 'override', ...this.hosts[domain] };
    try {
      const records = await dns.resolveTxt(`_chasqui.${domain}`);
      for (const chunks of records) {
        const rec = parseTxtRecord(chunks.join(''));
        if (rec.v === 'chasqui1' && rec.url) return { source: 'dns', url: rec.url, sig: rec.sig };
      }
    } catch { /* sin registro DNS: seguimos al fallback */ }
    return { source: 'well-known', url: `https://${domain}` };
  }

  // Tarjeta del dominio, verificada y (si corresponde) contrastada con la clave anclada.
  async domainCard(domain) {
    domain = domain.toLowerCase();
    const cached = this._cached(`domain:${domain}`);
    if (cached) return cached;

    const loc = await this.locate(domain);
    const card = await this._get(`${loc.url.replace(/\/$/, '')}/.well-known/chasqui.json`);
    if (card.chasqui !== '1' || card.domain !== domain) throw Object.assign(new Error(`tarjeta de dominio inválida para ${domain}`), { permanent: true });
    const keyIds = (card.keys || []).map((k) => k.sig);
    if (!keyIds.includes(card.signature?.kid) || !verifyObject(card, card.signature.kid)) {
      throw Object.assign(new Error(`firma de dominio inválida para ${domain}`), { permanent: true });
    }
    // Ancla: DNS/override dice qué clave debe tener el dominio. Si no hay ancla, TOFU (pin en primer uso).
    const anchor = loc.sig || this.pins[domain];
    if (anchor && !keyIds.includes(anchor)) throw Object.assign(new Error(`la clave del dominio ${domain} no coincide con la anclada`), { permanent: true });
    if (!anchor) this.pins[domain] = card.signature.kid;

    const value = { ...card, _estafeta: loc.url.replace(/\/$/, ''), _source: loc.source };
    this._remember(`domain:${domain}`, value);
    return value;
  }

  // Tarjeta del agente, certificada por la clave del dominio.
  async agentCard(address) {
    const { local, domain } = parseAddress(address);
    const key = `agent:${local}@${domain}`;
    const cached = this._cached(key);
    if (cached) return cached;

    const dc = await this.domainCard(domain);
    const card = await this._get(`${dc._estafeta}/agents/${encodeURIComponent(local)}`);
    if (card.chasqui !== '1' || card.address !== `${local}@${domain}`) throw Object.assign(new Error(`tarjeta de agente inválida: ${address}`), { permanent: true });
    const domainKeys = dc.keys.map((k) => k.sig);
    if (!domainKeys.includes(card.certification?.kid) || !verifyObject(card, card.certification.kid, 'certification')) {
      throw Object.assign(new Error(`certificación inválida para ${address}`), { permanent: true });
    }
    if (card.valid_until && Date.parse(card.valid_until) < Date.now()) throw Object.assign(new Error(`tarjeta vencida: ${address}`), { permanent: true });
    if (card.delegation) {
      // Cadena de delegación: el padre (ya certificado por el dominio) firmó esta tarjeta.
      const d = card.delegation;
      const { local: parentLocal, domain: parentDomain } = parseAddress(d.by);
      if (parentDomain !== domain || !local.endsWith(`.${parentLocal}`) || d.address !== card.address || d.sig !== card.sig) throw Object.assign(new Error(`delegación inconsistente en ${address}`), { permanent: true });
      const parent = await this.agentCard(d.by);
      if (!Resolver.acceptedKids(parent).includes(d.signature?.kid) || !verifyObject(d, d.signature.kid)) throw Object.assign(new Error(`delegación no firmada por ${d.by}`), { permanent: true });
      card.delegation = { ...d, _parent: parent };
    }

    const value = { ...card, _estafeta: dc._estafeta, _domain: dc };
    this._remember(key, value);
    return value;
  }

  // Claves aceptables de una tarjeta: la vigente más las anteriores dentro del período de gracia.
  static acceptedKids(card) {
    return [card.sig, ...(card.previous || []).filter((p) => !p.until || Date.parse(p.until) > Date.now()).map((p) => p.sig)];
  }

  // Igual que agentCard, pero si el sobre viene firmado con una clave que la tarjeta en caché no
  // reconoce (rotación reciente), refresca la tarjeta una vez antes de rechazar.
  async agentCardForKid(address, kid) {
    let card = await this.agentCard(address);
    if (!Resolver.acceptedKids(card).includes(kid)) {
      const { local, domain } = parseAddress(address);
      this.invalidate(`agent:${local}@${domain}`);
      card = await this.agentCard(address);
    }
    return card;
  }
}
