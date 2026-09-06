// Chasqui/1 — Cliente de agente: la app de correo y la billetera en una sola pieza.
// Correo: firma, cifra, envía, lee, confirma. Libro: cotiza, acepta, entrega, libera, afianza, manda, cobra.
// Las operaciones del Libro son sobres firmados a libro@<casa>; las respuestas vuelven como recibos al buzón.

import { Resolver, parseAddress } from './resolver.js';
import { generateKeys, signObject, verifyObject, signBytes, canonical, b64u, uuid, encryptContent, decryptContent, mintPow, sha256hex } from '../nucleo/crypto.js';
import { Libro, MEDIA } from '../libro/libro.js';

const iso = (t = Date.now()) => new Date(t).toISOString();

export class Agent {
  constructor({ address, keys, estafeta, resolver, hosts = {}, fetchImpl = globalThis.fetch }) {
    const { local, domain } = parseAddress(address);
    this.address = `${local}@${domain}`; this.local = local; this.domain = domain;
    this.keys = keys;
    this.estafeta = estafeta.replace(/\/$/, '');
    this.fetch = (...a) => fetchImpl(...a); // envuelto: workerd exige fetch con this=globalThis
    this.resolver = resolver || new Resolver({ hosts: { [domain]: { url: this.estafeta }, ...hosts }, fetchImpl });
  }

  static create(address, estafeta, opts = {}) { return new Agent({ address, estafeta, keys: generateKeys(), ...opts }); }
  // load/save usan node:fs por import dinámico: el módulo carga limpio en Workers (donde no se usan).
  static async load(file, opts = {}) { const fs = await import('node:fs'); const j = JSON.parse(fs.readFileSync(file, 'utf8')); return new Agent({ ...j, ...opts }); }
  async save(file) { const fs = await import('node:fs'); fs.mkdirSync(require_dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ address: this.address, estafeta: this.estafeta, keys: this.keys }, null, 2), { mode: 0o600 }); }

  // ---------- auth ante la propia estafeta ----------
  _auth(method, path, keys = this.keys, base = this.estafeta) {
    // `host` amarra el token a la casa destino: capturado, no sirve contra otra estafeta.
    const claims = { address: this.address, ts: iso(), nonce: uuid(), method, path, host: new URL(base).host };
    const token = b64u(canonical(claims));
    return `Chasqui ${token}.${signBytes(canonical(claims), keys)}`;
  }
  async _call(method, path, body, { admin, noAuth, authKeys } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (admin) headers.authorization = `Bearer ${admin}`; else if (!noAuth) headers.authorization = this._auth(method, path.split('?')[0], authKeys);
    const res = await this.fetch(`${this.estafeta}${path}`, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.reason || `HTTP ${res.status}`), { status: res.status, body: json });
    return json;
  }

  // ---------- registro ----------
  // Tres caminos: adminToken (la casa inscribe), invite (código de la casa) o abierto si la casa lo permite.
  // Sin adminToken y sin estar registrado, el cuerpo va firmado con la propia clave (prueba de posesión).
  async register({ adminToken, invite, capabilities, inbox, webhook, valid_until } = {}) {
    const body = { local: this.local, sig: this.keys.sig, enc: this.keys.enc, capabilities, inbox, webhook, valid_until };
    if (adminToken) this.card = await this._call('POST', '/agents', body, { admin: adminToken });
    else if (this.card) this.card = await this._call('POST', '/agents', body);
    else this.card = await this._call('POST', '/agents', signObject({ ...body, invite: invite || undefined, ts: iso() }, this.keys), { noAuth: true });
    this.resolver.invalidate(`agent:${this.address}`);
    return this.card;
  }
  // Directorio público de una casa (por defecto la propia): filtra por capacidad, media aceptado o texto.
  async directory(house, { capability, accepts, q, limit, offset } = {}) {
    const params = new URLSearchParams(Object.entries({ capability, accepts, q, limit, offset }).filter(([, v]) => v != null));
    const base = !house || house === this.domain ? this.estafeta : (await this.resolver.domainCard(house))._estafeta;
    const res = await this.fetch(`${base}/agents?${params}`, { signal: AbortSignal.timeout(10_000) });
    return res.json();
  }
  // Rotación: el cuerpo lleva las claves nuevas; la autenticación se firma con las viejas (o usa adminToken).
  async rotateKeys({ adminToken } = {}) {
    const old = this.keys;
    const fresh = { ...this.keys, ...generateKeys() };
    const body = { local: this.local, sig: fresh.sig, enc: fresh.enc, capabilities: this.card?.capabilities, inbox: this.card?.inbox };
    // Las claves nuevas se adoptan DESPUÉS de que la estafeta confirma: si el POST falla,
    // este agente sigue firmando con las viejas y no queda inutilizable.
    this.card = await this._call('POST', '/agents', body, adminToken ? { admin: adminToken } : { authKeys: old });
    this.keys = fresh;
    this.resolver.invalidate(`agent:${this.address}`);
    return this.card;
  }

  // ---------- envío ----------
  async send({ to, type = 'message', body, media, encrypt = true, thread, inReplyTo, expires, deliverAfter, attachments, extensions, receipt }) {
    const recipients = Array.isArray(to) ? to : [to];
    const id = uuid();
    const base = {
      chasqui: '1', id, from: this.address, to: recipients, created: iso(),
      expires: expires ?? null, deliver_after: deliverAfter ?? undefined, thread: thread ?? null, in_reply_to: inReplyTo ?? null, type,
      attachments, extensions, receipt,
    };
    const content = { media: media || (typeof body === 'string' ? 'text/plain' : 'application/json'), body };

    // Tarjetas de los destinatarios: para cifrar (clave enc) y para saber si exigen proof-of-work.
    const cards = await Promise.all(recipients.map((r) => this.resolver.agentCard(r).catch((e) => ({ address: r, _error: e.message }))));
    const missing = cards.filter((c) => c._error);
    if (missing.length) throw new Error(`no se pudo resolver: ${missing.map((c) => `${c.address} (${c._error})`).join(', ')}`);

    let env;
    if (encrypt && cards.every((c) => c.enc)) {
      env = { ...base, encrypted: encryptContent(content, cards.map((c) => ({ address: c.address, enc: c.enc })), aad(base)) };
    } else {
      if (encrypt === 'required') throw new Error('algún destinatario no publica clave de cifrado');
      env = { ...base, content };
    }
    const powBits = Math.max(0, ...cards.map((c) => (c.inbox?.policy === 'pow' ? c.inbox.pow_bits ?? 16 : 0)));
    if (powBits) env.pow = mintPow(id, powBits);
    const stamped = cards.find((c) => c.inbox?.policy === 'stamp');
    if (stamped) {
      if (recipients.length > 1) throw new Error('un sobre con estampilla lleva un solo destinatario');
      env.stamp = { house: stamped.inbox.house || parseAddress(stamped.address).domain, amount: stamped.inbox.price ?? 1 };
    }

    const signed = signObject(env, this.keys);
    const r = await this._call('POST', '/outbound', signed);
    return { id, envelope: signed, jobs: r.jobs };
  }
  // Un mensaje a tu yo futuro: llega a tu propio buzón en la fecha indicada, cifrado (solo tú lo abres).
  // La cola ya lo sostiene; esto le da a un agente memoria operativa entre sesiones.
  recordar({ cuando, body, thread, type = 'message' } = {}) {
    return this.send({ to: this.address, body, type, thread, deliverAfter: cuando, encrypt: true });
  }
  reply(envelope, body, opts = {}) {
    return this.send({ to: envelope.from, thread: envelope.thread || envelope.id, inReplyTo: envelope.id, type: opts.type || 'result', body, ...opts });
  }
  // Recibo no repudiable: firmado por este agente e incluye el hash del sobre original.
  receipt(envelope, status, reason) {
    return this.send({ to: envelope.from, type: 'receipt', inReplyTo: envelope.id, thread: envelope.thread || envelope.id, body: { of: envelope.id, sha256: sha256hex(canonical(envelope)), status, reason }, encrypt: false });
  }

  // ---------- delegación de identidad: un subagente con tarjeta firmada por este agente ----------
  // El subagente genera sus propias claves; este agente firma { by, address, sig, scope, valid_until };
  // la estafeta certifica la tarjeta. scope: { types?: [...], to_domains?: [...], cap?: tokens }.
  async delegate(name, { scope = {}, valid_until = null, capabilities, inbox } = {}) {
    const sub = Agent.create(`${name}.${this.local}@${this.domain}`, this.estafeta, { resolver: this.resolver, fetchImpl: this.fetch });
    const delegation = signObject({ by: this.address, address: sub.address, sig: sub.keys.sig, scope, valid_until, issued: iso() }, this.keys);
    const body = { local: sub.local, sig: sub.keys.sig, enc: sub.keys.enc, capabilities, inbox, delegation };
    sub.card = await this._call('POST', '/agents', body);
    return sub;
  }

  // ---------- Libro: cotizaciones y contratos ----------
  // Una cotización es un documento firmado por el vendedor; viaja dentro de un sobre (cifrado) al comprador.
  async quote({ to, contract = 'spot', price, concept, terms, expires, arbiter, house, referrer }) {
    const q = Libro.buildQuote({ seller: this.address, buyer: to, house: house || parseAddress(to).domain, contract, price, concept, terms, expires, arbiter, referrer }, this.keys);
    const sent = await this.send({ to, type: 'message', media: MEDIA.cotizacion, body: q, expires: expires ?? null });
    return { quote: q, ...sent };
  }
  // Operación genérica: sobre firmado, sin cifrar, a libro@<casa>. La respuesta llega como recibo.
  libroOp(house, body, opts = {}) {
    return this.send({ to: `libro@${house}`, type: 'task', media: MEDIA.op, body, encrypt: false, ...opts });
  }
  accept(quote) { return this.libroOp(quote.house, { op: 'accept', quote }); }
  deliver(house, contract, { evidence_sha256, note } = {}) { return this.libroOp(house, { op: 'deliver', contract, evidence_sha256, note }); }
  release(house, contract) { return this.libroOp(house, { op: 'release', contract }); }
  refund(house, contract, note) { return this.libroOp(house, { op: 'refund', contract, note }); }
  bond(house, { amount, claim, verifier, beneficiary, arbiter, evidence_sha256, expires }) { return this.libroOp(house, { op: 'bond', amount, claim, verifier, beneficiary, arbiter, evidence_sha256, expires }); }
  forfeit(house, contract, reason) { return this.libroOp(house, { op: 'forfeit', contract, reason }); }
  mandate(house, { grantee, cap, scope, expires, parent }) { return this.libroOp(house, { op: 'mandate', grantee, cap, scope, expires, parent }); }
  charge(house, { mandate, amount, concept }) { return this.libroOp(house, { op: 'charge', mandate, amount, concept }); }
  revoke(house, mandate) { return this.libroOp(house, { op: 'revoke', mandate }); }

  // Lecturas directas (sin pasar por correo) en la casa indicada; por defecto, la propia estafeta.
  async balance(house) { return this._callAt(house, 'GET', `/libro/cuenta/${encodeURIComponent(this.address)}`); }
  async contract(house, id) { return this._callAt(house, 'GET', `/libro/contrato/${encodeURIComponent(id)}`); }
  async _callAt(house, method, path) {
    if (!house || house === this.domain) return this._call(method, path);
    const dc = await this.resolver.domainCard(house);
    const res = await this.fetch(`${dc._estafeta}${path}`, { method, headers: { authorization: this._auth(method, path.split('?')[0], this.keys, dc._estafeta) }, signal: AbortSignal.timeout(10_000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.reason || `HTTP ${res.status}`), { status: res.status });
    return json;
  }

  // Espera el recibo del Libro que responde a una operación (por in_reply_to) y lo abre.
  async awaitReceipt(sentId, { timeoutMs = 10_000 } = {}) {
    const m = await this.waitFor((e) => e.type === 'receipt' && e.in_reply_to === sentId, { timeoutMs });
    const opened = await this.open(m.envelope);
    return { ...opened, receipt: opened.content.body, envelope: m.envelope };
  }

  // Búsqueda en un índice federado (urn:chasqui:ext:indice): por casa que lo opera o URL directa.
  // El índice es una pista: cada tarjeta se re-verifica por la cadena normal al usarla.
  async search(index, { q, capability, accepts, house, limit, offset } = {}) {
    const params = new URLSearchParams(Object.entries({ q, capability, accepts, house, limit, offset }).filter(([, v]) => v != null));
    const base = index.startsWith('http') ? index.replace(/\/$/, '') : (await this.resolver.domainCard(index))._estafeta;
    const res = await this.fetch(`${base}/index/agents?${params}`, { signal: AbortSignal.timeout(10_000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.reason || `HTTP ${res.status}`), { status: res.status });
    return json;
  }

  // ---------- lectura ----------
  async inbox({ limit = 50 } = {}) { return (await this._call('GET', `/mailbox/${this.local}?limit=${limit}`)).messages; }
  async ack(ids) { return (await this._call('POST', `/mailbox/${this.local}/ack`, { ids: Array.isArray(ids) ? ids : [ids] })).acked; }
  async outbox() { return (await this._call('GET', `/outbox/${this.local}`)).sent; }

  // Verifica la cadena de confianza del remitente y descifra si corresponde.
  async open(envelope) {
    const card = await this.resolver.agentCardForKid(envelope.from, envelope.signature?.kid);
    const verified = Resolver.acceptedKids(card).includes(envelope.signature?.kid) && verifyObject(envelope, envelope.signature.kid);
    if (!verified) throw new Error(`firma inválida en sobre ${envelope.id} de ${envelope.from}`);
    if (envelope.expires && Date.parse(envelope.expires) < Date.now()) throw new Error(`sobre vencido: ${envelope.id}`);
    if (!envelope.encrypted && !envelope.to.includes(this.address)) throw new Error(`sobre ${envelope.id} no dirigido a ${this.address}`);
    const content = envelope.encrypted ? decryptContent(envelope.encrypted, this.address, this.keys, aad(envelope)) : envelope.content;
    return { id: envelope.id, from: envelope.from, to: envelope.to, type: envelope.type, thread: envelope.thread, in_reply_to: envelope.in_reply_to, created: envelope.created, encrypted: !!envelope.encrypted, sender: card, content };
  }

  // Espera hasta que llegue un sobre que cumpla el filtro (útil para pruebas y flujos síncronos).
  async waitFor(predicate = () => true, { timeoutMs = 10_000, everyMs = 250 } = {}) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      for (const m of await this.inbox({ limit: 200 })) if (predicate(m.envelope, m)) return m;
      await new Promise((r) => setTimeout(r, everyMs));
    }
    throw new Error(`timeout esperando sobre en ${this.address}`);
  }
}

// AAD del cifrado: amarra el contenido a id/from/to para que un relay no pueda re-dirigir el sobre.
function aad(env) { return canonical({ id: env.id, from: env.from, to: env.to }); }
function require_dirname(p) { return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.'; }
