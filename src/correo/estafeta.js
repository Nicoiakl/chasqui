// Chasqui/1 — Estafeta: el servidor de un dominio (equivale al servidor de correo de gmail.com).
// Aloja los dos componentes del sistema: el Correo (sobres, buzones, cola) y el Libro (ledger y
// contratos). El Libro no tiene puerta propia: se opera escribiéndole a libro@<dominio>.
//
// Responsabilidades:
//   - publicar la tarjeta del dominio y certificar las tarjetas de sus agentes
//   - servicio de registro: alta por administrador, por invitación o abierta (con prueba de posesión
//     de la clave), nombres reservados, y un directorio público de los agentes de la casa
//   - recibir sobres de agentes propios (/outbound) y encolarlos: store-and-forward con reintentos
//   - recibir sobres de otras estafetas (/inbound), verificar la cadena de firmas y aplicar política
//   - guardar cada sobre en el buzón del destinatario hasta que el agente lo confirme (ack)
//   - avisar por webhook si el agente registró uno (push); si no, el agente hace poll
//   - entregar a libro@ los sobres de operación del Libro y repartir los recibos resultantes
//   - cobrar estampillas en buzones con política `stamp`

import http from 'node:http';
import { FileStore } from '../nucleo/almacen.js';
import { Resolver, parseAddress } from './resolver.js';
import { validateEnvelope, applyInboxPolicy, RateLimiter } from './politica.js';
import { generateSigningKeys, signObject, verifyObject, signBytes, verifyBytes, canonical, uuid, unb64u, sha256hex } from '../nucleo/crypto.js';
import { Libro, MEDIA, LibroError } from '../libro/libro.js';

const now = () => Date.now();
const iso = (t = now()) => new Date(t).toISOString();
const RETRYABLE = new Set([408, 421, 425, 429, 500, 502, 503, 504]);

export class Estafeta {
  constructor({
    domain, dataDir, adminToken,
    port = 4000, host = '127.0.0.1', publicUrl,
    hosts = {}, fetchImpl = globalThis.fetch,
    policy = {}, retry = {}, workerIntervalMs = 1000, libro = {},
    extensions = ['urn:chasqui:ext:mcp', 'urn:chasqui:ext:a2a', 'urn:chasqui:ext:libro'],
    log = (...a) => console.log(`[estafeta ${domain}]`, ...a),
  }) {
    if (!domain || !dataDir || !adminToken) throw new Error('domain, dataDir y adminToken son obligatorios');
    this.domain = domain.toLowerCase();
    this.port = port; this.host = host;
    this.publicUrl = (publicUrl || `http://${host}:${port}`).replace(/\/$/, '');
    this.adminToken = adminToken;
    this.fetch = fetchImpl;
    this.log = log;
    // registration: 'admin' (solo la casa inscribe) | 'invite' (código emitido por la casa) | 'open' (cualquiera, con prueba de posesión de clave)
    this.policy = { inbound: 'verified', max_bytes: 1_048_576, rate_per_minute: 120, registration: 'admin', registrations_per_minute: 10, ...policy };
    this.retry = { baseMs: 1000, maxMs: 60_000, giveUpMs: 3 * 24 * 3600 * 1000, ...retry };
    this.workerIntervalMs = workerIntervalMs;
    this.extensions = extensions;

    this.store = new FileStore(dataDir);
    this.keys = this._loadOrCreateDomainKeys();
    this.resolver = new Resolver({ hosts: { [this.domain]: { url: this.publicUrl }, ...hosts }, pins: this.store.getPins(), fetchImpl });
    this.rate = new RateLimiter({ perMinute: this.policy.rate_per_minute });
    this.regRate = new RateLimiter({ perMinute: this.policy.registrations_per_minute });
    this.nonces = new Map();
    this.inflight = new Set();
    this.libro = new Libro({ domain: this.domain, store: this.store, keys: this.keys, resolver: this.resolver, log: this.log, ...libro });
    this._ensureSystemAgents();
  }

  // ---------- identidad del dominio ----------
  _loadOrCreateDomainKeys() {
    let rec = this.store.getDomain();
    if (!rec) {
      const k = generateSigningKeys();
      rec = { domain: this.domain, keys: [{ ...k, created: iso() }], created: iso() };
      this.store.putDomain(rec);
    }
    return rec.keys[0];
  }
  _ensureSystemAgents() {
    // Agentes de sistema, firman con la clave del dominio:
    //   postmaster@ -> avisos de entrega y rebotes    libro@ -> operaciones y recibos del Libro
    if (!this.store.getAgent('postmaster')) this.registerAgent({ local: 'postmaster', sig: this.keys.sig, capabilities: { accepts: [] }, inbox: { policy: 'allowlist', allowlist: [] } });
    if (!this.store.getAgent('libro')) this.registerAgent({ local: 'libro', sig: this.keys.sig, capabilities: { accepts: [MEDIA.op], libro: { fee_pct: this.libro.feePct, ops: this.libro.ops } }, inbox: { policy: 'open' } });
  }
  isSystem(local) { return local === 'postmaster' || local === 'libro'; }
  static RESERVED = new Set(['postmaster', 'libro', 'casa', 'admin', 'root', 'abuse', 'security', 'hostmaster', 'noreply', 'no-reply', 'support', 'estafeta', 'chasqui']);

  // ---------- servicio de registro ----------
  // Invitaciones: la casa emite códigos con usos y vencimiento; un agente los presenta al inscribirse.
  createInvite({ uses = 1, expires = null, note = null, welcome = null } = {}) {
    const inv = { code: uuid().replace(/-/g, '').slice(0, 20), uses, used: 0, expires, note, welcome, created: iso(), by: 'admin' };
    this.store.putInvite(inv);
    return inv;
  }
  _consumeInvite(code) {
    const inv = code && this.store.getInvite(String(code));
    if (!inv) throw Object.assign(new Error('invitación inexistente'), { status: 403 });
    if (inv.expires && Date.parse(inv.expires) < now()) throw Object.assign(new Error('invitación vencida'), { status: 403 });
    if (inv.used >= inv.uses) throw Object.assign(new Error('invitación agotada'), { status: 403 });
    inv.used += 1; inv.last_used = iso();
    this.store.putInvite(inv);
    return inv;
  }
  // Directorio público de la casa: tarjetas sin datos privados, con filtros por capacidad.
  directory({ capability, accepts, q, limit = 50, offset = 0 } = {}) {
    let cards = this.store.listAgents().sort().map((l) => this.agentCard(l)).filter(Boolean);
    if (capability) cards = cards.filter((c) => c.capabilities?.[capability]);
    if (accepts) cards = cards.filter((c) => c.capabilities?.accepts?.includes(accepts));
    if (q) { const needle = q.toLowerCase(); cards = cards.filter((c) => c.address.includes(needle) || JSON.stringify(c.capabilities).toLowerCase().includes(needle)); }
    return { total: cards.length, offset, agents: cards.slice(offset, offset + Math.min(limit, 200)).map(({ delegation, ...c }) => ({ ...c, delegated_by: delegation?.by })) };
  }
  domainCard() {
    const rec = this.store.getDomain();
    const card = {
      chasqui: '1', domain: this.domain, estafeta: this.publicUrl,
      keys: rec.keys.map((k) => ({ sig: k.sig, created: k.created })),
      policy: { inbound: this.policy.inbound, max_bytes: this.policy.max_bytes, registration: this.policy.registration },
      extensions: this.extensions,
      issued: iso(),
    };
    return signObject(card, this.keys);
  }

  // ---------- agentes ----------
  registerAgent({ local, sig, enc = null, capabilities = {}, inbox = { policy: 'open' }, webhook = null, valid_until = null, delegation = null, welcome = null }) {
    local = String(local).toLowerCase();
    const address = `${local}@${this.domain}`;
    parseAddress(address);
    if (Estafeta.RESERVED.has(local) && !this.isSystem(local)) throw Object.assign(new Error(`nombre reservado: ${local}`), { status: 409 });
    if (delegation) {
      // Tarjeta delegada: el agente padre firma { by, address, sig, scope, valid_until }; el dominio la certifica igual.
      const { local: parentLocal, domain: parentDomain } = parseAddress(delegation.by);
      if (parentDomain !== this.domain || !local.endsWith(`.${parentLocal}`)) throw Object.assign(new Error(`un agente delegado de ${delegation.by} debe llamarse <nombre>.${parentLocal}@${this.domain}`), { status: 400 });
      const parent = this.store.getAgent(parentLocal);
      if (!parent) throw Object.assign(new Error('agente padre inexistente'), { status: 404 });
      if (delegation.address !== address || delegation.sig !== sig || !verifyObject(delegation, parent.sig)) throw Object.assign(new Error('delegación inválida: debe estar firmada por el padre y coincidir con la tarjeta'), { status: 403 });
      if (parent.delegation?.scope?.cap != null && delegation.scope?.cap != null && delegation.scope.cap > parent.delegation.scope.cap) throw Object.assign(new Error('el delegado no puede tener más tope que su padre'), { status: 403 });
      valid_until = valid_until || delegation.valid_until || null;
    }
    const prev = this.store.getAgent(local);
    const previous = [];
    if (prev && prev.sig !== sig) previous.push({ sig: prev.sig, until: iso(now() + 7 * 24 * 3600 * 1000) }, ...(prev.previous || []));
    const card = signObject({
      chasqui: '1', address, sig, enc,
      capabilities: { accepts: ['text/plain', 'application/json'], ...capabilities },
      inbox: { policy: 'open', ...inbox },
      valid_from: iso(), valid_until, previous: previous.slice(0, 3),
      delegation: delegation || undefined,
    }, this.keys, 'certification');
    this.store.putAgent(local, { ...card, webhook });
    const gift = welcome ?? this.libro.welcome;
    if (!prev && !this.isSystem(local) && !delegation && gift > 0) this.libro.topup(address, gift, 'regalo de bienvenida', { agent: address });
    return card;
  }
  agentCard(local) {
    const rec = this.store.getAgent(local);
    if (!rec) return null;
    const { webhook, ...card } = rec;
    return card;
  }

  // ---------- autenticación de agentes propios ----------
  // Authorization: Chasqui <b64u(canonical({address,ts,nonce,method,path}))>.<firma Ed25519>
  // Con allowForeign, un agente de otra casa también puede autenticarse: su clave se obtiene por el
  // resolver (cadena DNS -> dominio -> agente). Así un foráneo consulta su cuenta en este Libro sin login.
  async _authenticate(req, path, { allowForeign = false } = {}) {
    const h = req.headers.authorization || '';
    const m = /^Chasqui\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(h);
    if (!m) throw Object.assign(new Error('falta Authorization: Chasqui <token>.<firma>'), { status: 401 });
    let claims;
    try { claims = JSON.parse(unb64u(m[1]).toString()); } catch { throw Object.assign(new Error('token ilegible'), { status: 401 }); }
    const { local, domain } = parseAddress(claims.address);
    let rec;
    if (domain === this.domain) {
      rec = this.store.getAgent(local);
      if (!rec) throw Object.assign(new Error('agente no registrado'), { status: 401 });
    } else {
      if (!allowForeign) throw Object.assign(new Error('el agente no pertenece a este dominio'), { status: 401 });
      try { rec = await this.resolver.agentCard(claims.address); } catch (e) { throw Object.assign(new Error(`agente foráneo no verificable: ${e.message}`), { status: 401 }); }
    }
    if (Math.abs(now() - Date.parse(claims.ts)) > 300_000) throw Object.assign(new Error('token vencido (ventana de 5 min)'), { status: 401 });
    if (claims.method !== req.method || claims.path !== path) throw Object.assign(new Error('token no corresponde a esta petición'), { status: 401 });
    const key = `${claims.address}:${claims.nonce}`;
    if (this.nonces.has(key)) throw Object.assign(new Error('nonce reutilizado'), { status: 401 });
    if (!verifyBytes(canonical(claims), m[2], rec.sig)) throw Object.assign(new Error('firma de token inválida'), { status: 401 });
    this.nonces.set(key, now());
    if (this.nonces.size > 10_000) for (const [k, t] of this.nonces) if (now() - t > 600_000) this.nonces.delete(k);
    return { local, address: claims.address, record: rec };
  }

  // ---------- salida: el agente entrega un sobre a su estafeta ----------
  async outbound(env, submitter) {
    const v = validateEnvelope(env, { maxBytes: this.policy.max_bytes });
    if (!v.ok) return v;
    if (env.from !== submitter.address) return { ok: false, code: 403, reason: 'from no coincide con el agente autenticado' };
    if (env.signature.kid !== submitter.record.sig || !verifyObject(env, submitter.record.sig)) return { ok: false, code: 403, reason: 'firma del sobre inválida' };
    const scope = submitter.record.delegation?.scope;
    if (scope?.types?.length && !scope.types.includes(env.type)) return { ok: false, code: 403, reason: `agente delegado: solo puede enviar type ${scope.types.join('|')}` };
    if (scope?.to_domains?.length && !env.to.every((t) => scope.to_domains.includes(parseAddress(t).domain))) return { ok: false, code: 403, reason: `agente delegado: solo puede escribir a ${scope.to_domains.join(', ')}` };

    const byDomain = new Map();
    for (const to of env.to) { const { domain } = parseAddress(to); byDomain.set(domain, [...(byDomain.get(domain) || []), to]); }
    const jobs = [];
    for (const [domain, to] of byDomain) {
      const job = { id: uuid(), envelope: env, domain, to, from_local: submitter.local, attempts: 0, next_attempt: iso(), created: iso(), status: 'queued', log: [] };
      this.store.enqueue(job);
      this._outbox(job);
      jobs.push({ job: job.id, domain, to });
    }
    setImmediate(() => this.tick().catch((e) => this.log('tick error', e.message)));
    return { ok: true, code: 202, id: env.id, jobs };
  }
  _outbox(job, extra = {}) {
    this.store.putOutbox(job.from_local, { job: job.id, id: job.envelope.id, domain: job.domain, to: job.to, status: job.status, attempts: job.attempts, next_attempt: job.next_attempt, updated: iso(), log: job.log, ...extra });
  }

  // ---------- trabajador de entrega (store-and-forward) ----------
  async tick() {
    for (const job of this.store.listQueue()) {
      if (this.inflight.has(job.id) || Date.parse(job.next_attempt) > now()) continue;
      this.inflight.add(job.id);
      try { await this._deliver(job); } finally { this.inflight.delete(job.id); }
    }
  }
  async _deliver(job) {
    job.attempts += 1;
    let outcome;
    try {
      const dc = await this.resolver.domainCard(job.domain);
      const relay = `chasqui1 domain=${this.domain}; kid=${this.keys.sig}; sig=${signBytes(`relay:${job.envelope.id}:${job.domain}`, this.keys)}`;
      const res = await this.fetch(`${dc._estafeta}/inbound`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-chasqui-relay': relay },
        body: JSON.stringify(job.envelope), signal: AbortSignal.timeout(10_000),
      });
      const body = await res.json().catch(() => ({}));
      outcome = { status: res.status, body };
    } catch (e) {
      outcome = { status: 0, error: e.message };
    }
    job.log.push({ at: iso(), attempt: job.attempts, status: outcome.status, detail: outcome.error || outcome.body?.reason || outcome.body?.rejected || 'ok' });

    // Clasificación por destinatario
    const delivered = [], failed = [], retry = [];
    if (outcome.status === 200 || outcome.status === 202) {
      for (const a of outcome.body.accepted || []) delivered.push(a);
      for (const r of outcome.body.rejected || []) (RETRYABLE.has(r.code) ? retry : failed).push(r);
    } else if (outcome.status === 0 || RETRYABLE.has(outcome.status)) {
      retry.push(...job.to.map((to) => ({ to, code: outcome.status, reason: outcome.error || outcome.body?.reason })));
    } else {
      failed.push(...job.to.map((to) => ({ to, code: outcome.status, reason: outcome.body?.reason || 'rechazo permanente' })));
    }

    for (const f of failed) this._bounce(job, f.to, `rechazado (${f.code}): ${f.reason}`);
    if (delivered.length && job.envelope.receipt === 'delivered') for (const to of delivered) this._notify(job, to, 'delivered', 'entregado en la estafeta destino');

    if (retry.length) {
      const age = now() - Date.parse(job.created);
      if (age > this.retry.giveUpMs) {
        for (const r of retry) this._bounce(job, r.to, `sin respuesta tras ${job.attempts} intentos: ${r.reason}`);
        job.status = 'failed'; this.store.removeJob(job.id); this._outbox(job); return;
      }
      const backoff = Math.min(this.retry.baseMs * 2 ** (job.attempts - 1), this.retry.maxMs) * (0.8 + Math.random() * 0.4);
      job.to = retry.map((r) => r.to); job.status = 'retrying'; job.next_attempt = iso(now() + backoff);
      this.store.updateJob(job); this._outbox(job);
      return;
    }
    job.status = failed.length && !delivered.length ? 'failed' : 'delivered';
    this.store.removeJob(job.id); this._outbox(job, { delivered: delivered.length, failed: failed.length });
  }

  // Sobres emitidos por los agentes de sistema (postmaster@, libro@), firmados con la clave del dominio.
  // Destinatarios locales: directo al buzón. Remotos: por la cola, como cualquier envío.
  _systemSend(fromLocal, to, { type = 'receipt', content, thread = null, in_reply_to = null }) {
    const env = signObject({ chasqui: '1', id: uuid(), from: `${fromLocal}@${this.domain}`, to, created: iso(), expires: null, thread, in_reply_to, type, content }, this.keys);
    const byDomain = new Map();
    for (const t of to) { const { local, domain } = parseAddress(t); if (domain === this.domain) { if (this.store.getAgent(local)) { this.store.putMail(local, env, { via: fromLocal, from_verified: true }); this._push(local, env); } } else byDomain.set(domain, [...(byDomain.get(domain) || []), t]); }
    for (const [domain, dest] of byDomain) this.store.enqueue({ id: uuid(), envelope: env, domain, to: dest, from_local: fromLocal, attempts: 0, next_attempt: iso(), created: iso(), status: 'queued', log: [] });
    return env;
  }

  // Avisos del postmaster al remitente (rebotes y acuses de entrega). Llevan el hash del sobre original.
  _notify(job, to, status, reason) {
    this._systemSend('postmaster', [job.envelope.from], {
      in_reply_to: job.envelope.id, thread: job.envelope.thread || job.envelope.id,
      content: { media: 'application/json', body: { of: job.envelope.id, sha256: sha256hex(canonical(job.envelope)), to, status, reason } },
    });
  }
  _bounce(job, to, reason) { this.log(`rebote ${job.envelope.id} -> ${to}: ${reason}`); this._notify(job, to, 'failed', reason); }

  // ---------- entrada: otra estafeta nos entrega un sobre ----------
  async inbound(env, relayHeader) {
    const v = validateEnvelope(env, { maxBytes: this.policy.max_bytes });
    if (!v.ok) return v;
    if (env.expires && Date.parse(env.expires) < now()) return { ok: false, code: 410, reason: 'sobre vencido' };
    if (this.store.hasSeen(env.id)) return { ok: true, code: 200, duplicate: true, accepted: env.to.filter((t) => parseAddress(t).domain === this.domain), rejected: [] };

    const locals = env.to.filter((t) => parseAddress(t).domain === this.domain);
    if (!locals.length) return { ok: false, code: 404, reason: 'ningún destinatario pertenece a este dominio' };

    // Cadena de confianza: dominio emisor -> agente emisor -> firma del sobre
    let senderCard;
    try { senderCard = await this.resolver.agentCardForKid(env.from, env.signature.kid); }
    catch (e) { return { ok: false, code: e.permanent ? 403 : 421, reason: `no se pudo verificar al remitente: ${e.message}` }; }
    const validKids = Resolver.acceptedKids(senderCard);
    if (!validKids.includes(env.signature.kid) || !verifyObject(env, env.signature.kid)) return { ok: false, code: 403, reason: 'la firma del sobre no corresponde al remitente' };

    // Firma de relay (segunda capa: la estafeta emisora también firma, análogo a SPF/DKIM)
    const { domain: fromDomain } = parseAddress(env.from);
    let relayVerified = false;
    if (relayHeader) {
      const r = Object.fromEntries(relayHeader.replace(/^chasqui1\s*/, '').split(';').map((p) => p.trim().split('=').map((x) => x.trim())).filter((p) => p[0]));
      relayVerified = r.domain === fromDomain && senderCard._domain.keys.some((k) => k.sig === r.kid) && verifyBytes(`relay:${env.id}:${this.domain}`, r.sig, r.kid);
    }
    if (this.policy.require_relay && !relayVerified) return { ok: false, code: 403, reason: 'este dominio exige firma de relay válida' };
    if (!this.rate.allow(fromDomain)) return { ok: false, code: 429, reason: 'límite de tasa del dominio emisor' };

    const accepted = [], rejected = [], results = {};
    for (const to of locals) {
      const { local } = parseAddress(to);
      const rec = this.store.getAgent(local);
      if (!rec) { rejected.push({ to, code: 404, reason: 'agente inexistente' }); continue; }
      const p = applyInboxPolicy(env, rec, senderCard._domain);
      if (!p.ok) { rejected.push({ to, ...p, ok: undefined }); continue; }
      try {
        if (local === 'libro') {
          // Operación del Libro: se ejecuta, no se almacena; los recibos salen firmados por la casa.
          const r = await this.libro.handle(env, senderCard);
          if (!r.ok) { rejected.push({ to, code: r.code, reason: r.reason }); continue; }
          for (const rc of r.recibos || []) this._systemSend('libro', rc.to, { in_reply_to: env.id, thread: rc.thread || env.thread || null, content: { media: MEDIA.recibo, body: rc.body } });
          results[to] = r.result;
        } else if (p.stamp) {
          const asiento = this.libro.stamp(env, to, p.stamp.price);
          this.store.putMail(local, env, { from_verified: true, relay_verified: relayVerified, sender_kid: env.signature.kid, stamp: asiento.id });
          this._push(local, env);
        } else {
          this.store.putMail(local, env, { from_verified: true, relay_verified: relayVerified, sender_kid: env.signature.kid });
          this._push(local, env);
        }
      } catch (e) {
        if (e instanceof LibroError) { rejected.push({ to, code: e.code, reason: e.message }); continue; }
        throw e;
      }
      accepted.push(to);
    }
    if (accepted.length) this.store.markSeen(env.id, { from: env.from, accepted });
    if (!accepted.length) return { ok: false, code: rejected[0].code, reason: rejected[0].reason, rejected, accepted };
    return { ok: true, code: 202, accepted, rejected, results };
  }

  _push(local, env) {
    const rec = this.store.getAgent(local);
    if (!rec?.webhook) return;
    const body = JSON.stringify({ envelope: env });
    const sig = signBytes(`push:${env.id}`, this.keys);
    this.fetch(rec.webhook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chasqui-push': `domain=${this.domain}; kid=${this.keys.sig}; sig=${sig}` }, body, signal: AbortSignal.timeout(5000) })
      .catch((e) => this.log(`webhook ${local} falló: ${e.message}`));
  }

  // ---------- HTTP ----------
  async _handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      if (req.method === 'GET' && path === '/health') return send(200, { ok: true, domain: this.domain, agents: this.store.listAgents().length, queue: this.store.listQueue().length });
      if (req.method === 'GET' && path === '/.well-known/chasqui.json') return send(200, this.domainCard());
      let m;
      if (req.method === 'GET' && (m = /^\/agents\/([^/]+)$/.exec(path))) {
        const card = this.agentCard(decodeURIComponent(m[1]).toLowerCase());
        return card ? send(200, card) : send(404, { reason: 'agente inexistente' });
      }
      if (req.method === 'GET' && path === '/agents') {
        const p = Object.fromEntries(url.searchParams);
        return send(200, this.directory({ capability: p.capability, accepts: p.accepts, q: p.q, limit: Number(p.limit || 50), offset: Number(p.offset || 0) }));
      }
      if (req.method === 'POST' && path === '/agents') {
        const body = await readJson(req);
        const local = String(body.local || '').toLowerCase();
        const exists = !!this.store.getAgent(local);
        const isAdmin = (req.headers.authorization || '') === `Bearer ${this.adminToken}`;
        let ok = isAdmin, via = 'admin';
        if (!ok && req.headers.authorization?.startsWith('Chasqui ')) {
          const who = await this._authenticate(req, path);
          ok = who.local === local || (body.delegation && who.address === body.delegation.by);
          via = body.delegation ? 'delegation' : 'self';
        }
        if (!ok) {
          // Auto-registro: el cuerpo viene firmado por la clave que se inscribe (prueba de posesión).
          if (exists) return send(409, { reason: 'ese nombre ya está tomado; solo su dueño o la casa pueden actualizarlo' });
          if (!body.signature || body.signature.kid !== body.sig || !verifyObject(body, body.sig)) return send(401, { reason: 'para auto-registrarse, firma el cuerpo con la clave sig que inscribes (prueba de posesión)' });
          if (Math.abs(now() - Date.parse(body.ts || 0)) > 300_000) return send(401, { reason: 'la solicitud firmada necesita ts (ISO) dentro de 5 minutos' });
          if (!this.regRate.allow(req.socket?.remoteAddress || 'x')) return send(429, { reason: 'demasiados registros desde esta dirección' });
          if (this.policy.registration === 'open') via = 'open';
          else if (this.policy.registration === 'invite') { const inv = this._consumeInvite(body.invite); via = `invite:${inv.code}`; if (inv.welcome != null) body._welcome = inv.welcome; }
          else return send(403, { reason: `esta casa no acepta auto-registro (registration=${this.policy.registration}); pide una invitación` });
        }
        const { signature: _s, ts: _t, invite: _i, _welcome, ...clean } = body;
        const card = this.registerAgent({ ...clean, welcome: _welcome });
        this.log(`registro ${card.address} via ${via}`);
        return send(201, { ...card, registered_via: via });
      }
      if (req.method === 'POST' && path === '/invitations') {
        if ((req.headers.authorization || '') !== `Bearer ${this.adminToken}`) return send(401, { reason: 'solo la casa emite invitaciones' });
        return send(201, this.createInvite(await readJson(req)));
      }
      if (req.method === 'GET' && path === '/invitations') {
        if ((req.headers.authorization || '') !== `Bearer ${this.adminToken}`) return send(401, { reason: 'solo la casa lista invitaciones' });
        return send(200, { invitations: this.store.listInvites() });
      }
      if (req.method === 'POST' && path === '/outbound') {
        const who = await this._authenticate(req, path);
        const r = await this.outbound(await readJson(req), who);
        return send(r.code || 400, r);
      }
      if (req.method === 'POST' && path === '/inbound') {
        const r = await this.inbound(await readJson(req), req.headers['x-chasqui-relay']);
        return send(r.code || 400, r);
      }
      if (req.method === 'GET' && (m = /^\/mailbox\/([^/]+)$/.exec(path))) {
        const who = await this._authenticate(req, path);
        if (who.local !== decodeURIComponent(m[1]).toLowerCase()) return send(403, { reason: 'buzón ajeno' });
        const limit = Number(url.searchParams.get('limit') || 50);
        return send(200, { messages: this.store.listMail(who.local).slice(0, limit) });
      }
      if (req.method === 'POST' && (m = /^\/mailbox\/([^/]+)\/ack$/.exec(path))) {
        const who = await this._authenticate(req, path);
        if (who.local !== decodeURIComponent(m[1]).toLowerCase()) return send(403, { reason: 'buzón ajeno' });
        const { ids = [] } = await readJson(req);
        return send(200, { acked: ids.filter((id) => this.store.ackMail(who.local, id)) });
      }
      // ----- Libro (lecturas directas; las operaciones van por correo a libro@) -----
      if (req.method === 'GET' && (m = /^\/libro\/cuenta\/([^/]+)$/.exec(path))) {
        const who = await this._authenticate(req, path, { allowForeign: true });
        const address = decodeURIComponent(m[1]).toLowerCase();
        if (who.address !== address) return send(403, { reason: 'cuenta ajena' });
        return send(200, this.libro.account(address));
      }
      if (req.method === 'GET' && (m = /^\/libro\/contrato\/([^/]+)$/.exec(path))) {
        const who = await this._authenticate(req, path, { allowForeign: true });
        const c = this.store.libroGetContract(decodeURIComponent(m[1]));
        if (!c) return send(404, { reason: 'contrato inexistente' });
        if (![c.seller, c.buyer, c.verifier, c.arbiter].includes(who.address)) return send(403, { reason: 'no eres parte' });
        return send(200, c);
      }
      if (req.method === 'POST' && path === '/libro/topup') {
        if ((req.headers.authorization || '') !== `Bearer ${this.adminToken}`) return send(401, { reason: 'solo la casa carga saldo' });
        const { account, amount, concept } = await readJson(req);
        return send(201, this.libro.topup(account, amount, concept || 'carga de la casa'));
      }
      if (req.method === 'GET' && path === '/libro/diario') {
        if ((req.headers.authorization || '') !== `Bearer ${this.adminToken}`) return send(401, { reason: 'solo la casa lee el diario completo' });
        return send(200, { balances: this.store.libroState().balances, journal: this.libro.journal() });
      }
      if (req.method === 'GET' && (m = /^\/outbox\/([^/]+)$/.exec(path))) {
        const who = await this._authenticate(req, path);
        if (who.local !== decodeURIComponent(m[1]).toLowerCase()) return send(403, { reason: 'bandeja ajena' });
        return send(200, { sent: this.store.listOutbox(who.local) });
      }
      return send(404, { reason: 'ruta desconocida' });
    } catch (e) {
      return send(e.status || e.code || 500, { reason: e.message });
    }
  }

  async start() {
    this.server = http.createServer((req, res) => this._handle(req, res));
    await new Promise((r) => this.server.listen(this.port, this.host, r));
    this.timer = setInterval(() => this.tick().catch((e) => this.log('tick error', e.message)), this.workerIntervalMs);
    this.timer.unref?.();
    this.log(`escuchando en ${this.publicUrl}`);
    return this;
  }
  async stop() {
    clearInterval(this.timer);
    if (this.server) await new Promise((r) => this.server.close(r));
    this.server = null;
  }
}

function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('cuerpo demasiado grande'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(Object.assign(new Error('JSON inválido'), { status: 400 })); } });
    req.on('error', reject);
  });
}
