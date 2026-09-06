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
//   - opcionalmente, operar un índice federado de agentes (urn:chasqui:ext:indice)
//
// RUNTIME: esta clase no conoce node:http ni Workers. El transporte vive en src/plataformas/
// (node.js y worker.js) y habla con `handleRequest(rx)`: rx = { method, path, query, headers,
// body, ip } -> { status, body }. El almacenamiento es async (FileStore local, D1Store en el edge).

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
    domain, dataDir, store, adminToken,
    port = 4000, host = '127.0.0.1', publicUrl,
    hosts = {}, fetchImpl = globalThis.fetch,
    policy = {}, retry = {}, workerIntervalMs = 1000, libro = {},
    index = {},
    extensions = null,
    log = (...a) => console.log(`[estafeta ${domain}]`, ...a),
  }) {
    if (!domain || !adminToken || (!dataDir && !store)) throw new Error('domain, adminToken y (dataDir o store) son obligatorios');
    this.domain = domain.toLowerCase();
    this.port = port; this.host = host;
    this.publicUrl = (publicUrl || `http://${host}:${port}`).replace(/\/$/, '');
    this.authHost = new URL(this.publicUrl).host;
    this.adminToken = adminToken;
    this.fetch = (...a) => fetchImpl(...a); // envuelto: workerd exige fetch con this=globalThis
    this.log = log;
    // registration: 'admin' (solo la casa inscribe) | 'invite' (código emitido por la casa) | 'open' (cualquiera, con prueba de posesión de clave)
    this.policy = { inbound: 'verified', max_bytes: 1_048_576, rate_per_minute: 120, registration: 'admin', registrations_per_minute: 10, ...policy };
    this.retry = { baseMs: 1000, maxMs: 60_000, giveUpMs: 3 * 24 * 3600 * 1000, ...retry };
    this.workerIntervalMs = workerIntervalMs;
    this.index = { enabled: false, crawlMinutes: 15, maxHouses: 500, ...index };
    this.extensions = extensions || [
      'urn:chasqui:ext:mcp', 'urn:chasqui:ext:a2a', 'urn:chasqui:ext:libro',
      ...(this.index.enabled ? ['urn:chasqui:ext:indice'] : []),
    ];
    this.libroOpts = libro;
    this.hostsOverride = hosts;

    this.store = store || new FileStore(dataDir);
    this.rate = new RateLimiter({ perMinute: this.policy.rate_per_minute });
    this.regRate = new RateLimiter({ perMinute: this.policy.registrations_per_minute });
    this._ready = null;
    this._domainCardCache = null; // { value, until }
    this._lastCrawl = 0;
  }

  // Inicialización perezosa e idempotente (los adaptadores y cada request la esperan).
  async init() {
    if (!this._ready) this._ready = this._init();
    return this._ready;
  }
  async _init() {
    this.keys = await this._loadOrCreateDomainKeys();
    this.resolver = new Resolver({
      hosts: { [this.domain]: { url: this.publicUrl }, ...this.hostsOverride },
      pins: await this.store.getPins(),
      fetchImpl: this.fetch,
      onPin: (pins) => this.store.putPins(pins),
      // Resolución local de la propia casa: sin esto, verificar a un vendedor de casa exige un
      // fetch del Worker a su propio dominio público, que Cloudflare corta (522) y deja la
      // operación reintentando para siempre.
      self: { domain: this.domain, estafeta: this.publicUrl, domainCard: () => this.domainCard(), agentCard: (local) => this.agentCard(local) },
    });
    this.libro = new Libro({ domain: this.domain, store: this.store, keys: this.keys, resolver: this.resolver, log: this.log, ...this.libroOpts });
    await this._ensureSystemAgents();
    return this;
  }

  // ---------- identidad del dominio ----------
  async _loadOrCreateDomainKeys() {
    let rec = await this.store.getDomain();
    if (!rec) {
      const k = generateSigningKeys();
      rec = { domain: this.domain, keys: [{ ...k, created: iso() }], created: iso() };
      // Si otro proceso/isolate llegó primero, sus claves mandan (putDomainIfAbsent falla cerrado).
      const won = await (this.store.putDomainIfAbsent ? this.store.putDomainIfAbsent(rec) : (this.store.putDomain(rec), true));
      if (!won) rec = await this.store.getDomain();
    }
    return rec.keys[0];
  }
  async _ensureSystemAgents() {
    // Agentes de sistema, firman con la clave del dominio:
    //   postmaster@ -> avisos de entrega y rebotes    libro@ -> operaciones y recibos del Libro
    if (!await this.store.getAgent('postmaster')) await this.registerAgent({ local: 'postmaster', sig: this.keys.sig, capabilities: { accepts: [] }, inbox: { policy: 'allowlist', allowlist: [] } });
    if (!await this.store.getAgent('libro')) await this.registerAgent({ local: 'libro', sig: this.keys.sig, capabilities: { accepts: [MEDIA.op], libro: { fee_bps: this.libro.feeBps, ops: this.libro.ops } }, inbox: { policy: 'open' } });
  }
  isSystem(local) { return local === 'postmaster' || local === 'libro'; }
  static RESERVED = new Set(['postmaster', 'libro', 'casa', 'admin', 'root', 'abuse', 'security', 'hostmaster', 'noreply', 'no-reply', 'support', 'estafeta', 'chasqui', 'indice']);

  // ---------- servicio de registro ----------
  // Invitaciones: la casa emite códigos con usos y vencimiento; un agente los presenta al inscribirse.
  async createInvite({ uses = 1, expires = null, note = null, welcome = null } = {}) {
    const inv = { code: uuid().replace(/-/g, '').slice(0, 20), uses, used: 0, expires, note, welcome, created: iso(), by: 'admin' };
    await this.store.putInvite(inv);
    return inv;
  }
  async _consumeInvite(code) {
    const inv = code && await this.store.getInvite(String(code));
    if (!inv) throw Object.assign(new Error('invitación inexistente'), { status: 403 });
    if (inv.expires && Date.parse(inv.expires) < now()) throw Object.assign(new Error('invitación vencida'), { status: 403 });
    if (inv.used >= inv.uses) throw Object.assign(new Error('invitación agotada'), { status: 403 });
    inv.used += 1; inv.last_used = iso();
    await this.store.putInvite(inv);
    return inv;
  }
  // Directorio público de la casa: tarjetas sin datos privados, con filtros por capacidad.
  async directory({ capability, accepts, q, limit = 50, offset = 0 } = {}) {
    limit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 200) : 50;
    offset = Number.isInteger(Number(offset)) && Number(offset) >= 0 ? Number(offset) : 0;
    const locals = (await this.store.listAgents()).sort();
    const cards = [];
    for (const l of locals) { const c = await this.agentCard(l); if (c) cards.push(c); }
    let out = cards;
    if (capability) out = out.filter((c) => c.capabilities?.[capability]);
    if (accepts) out = out.filter((c) => c.capabilities?.accepts?.includes(accepts));
    if (q) { const needle = String(q).toLowerCase(); out = out.filter((c) => c.address.includes(needle) || JSON.stringify(c.capabilities).toLowerCase().includes(needle)); }
    return { total: out.length, offset, agents: out.slice(offset, offset + limit).map(({ delegation, ...c }) => ({ ...c, delegated_by: delegation?.by })) };
  }
  async domainCard() {
    // La tarjeta se re-firma solo cuando expira el caché (firmar en cada GET es CPU regalada).
    if (this._domainCardCache && this._domainCardCache.until > now()) return this._domainCardCache.value;
    const rec = await this.store.getDomain();
    const card = signObject({
      chasqui: '1', domain: this.domain, estafeta: this.publicUrl,
      keys: rec.keys.map((k) => ({ sig: k.sig, created: k.created })),
      policy: { inbound: this.policy.inbound, max_bytes: this.policy.max_bytes, registration: this.policy.registration, ...(this.policy.outbound ? { outbound: this.policy.outbound } : {}) },
      extensions: this.extensions,
      issued: iso(),
    }, this.keys);
    this._domainCardCache = { value: card, until: now() + 60_000 };
    return card;
  }

  // ---------- agentes ----------
  async registerAgent({ local, sig, enc = null, capabilities = {}, inbox = { policy: 'open' }, webhook = null, valid_until = null, delegation = null, welcome = null }) {
    local = String(local).toLowerCase();
    const address = `${local}@${this.domain}`;
    parseAddress(address);
    if (Estafeta.RESERVED.has(local) && !this.isSystem(local)) throw Object.assign(new Error(`nombre reservado: ${local}`), { status: 409 });
    if (delegation) {
      // Tarjeta delegada: el agente padre firma { by, address, sig, scope, valid_until }; el dominio la certifica igual.
      const { local: parentLocal, domain: parentDomain } = parseAddress(delegation.by);
      if (parentDomain !== this.domain || !local.endsWith(`.${parentLocal}`)) throw Object.assign(new Error(`un agente delegado de ${delegation.by} debe llamarse <nombre>.${parentLocal}@${this.domain}`), { status: 400 });
      const parent = await this.store.getAgent(parentLocal);
      if (!parent) throw Object.assign(new Error('agente padre inexistente'), { status: 404 });
      if (delegation.address !== address || delegation.sig !== sig || !verifyObject(delegation, parent.sig)) throw Object.assign(new Error('delegación inválida: debe estar firmada por el padre y coincidir con la tarjeta'), { status: 403 });
      if (parent.delegation?.scope?.cap != null && delegation.scope?.cap != null && delegation.scope.cap > parent.delegation.scope.cap) throw Object.assign(new Error('el delegado no puede tener más tope que su padre'), { status: 403 });
      valid_until = valid_until || delegation.valid_until || null;
    }
    const prev = await this.store.getAgent(local);
    const previous = [];
    if (prev && prev.sig !== sig) previous.push({ sig: prev.sig, until: iso(now() + 7 * 24 * 3600 * 1000) }, ...(prev.previous || []));
    const card = signObject({
      chasqui: '1', address, sig, enc,
      capabilities: { accepts: ['text/plain', 'application/json'], ...capabilities },
      inbox: { policy: 'open', ...inbox },
      valid_from: iso(), valid_until, previous: previous.slice(0, 3),
      delegation: delegation || undefined,
    }, this.keys, 'certification');
    await this.store.putAgent(local, { ...card, webhook });
    const gift = welcome ?? this.libro.welcome;
    if (!prev && !this.isSystem(local) && !delegation && gift > 0) await this.libro.topup(address, gift, 'regalo de bienvenida', { agent: address });
    return card;
  }
  async agentCard(local) {
    const rec = await this.store.getAgent(local);
    if (!rec) return null;
    const { webhook, ...card } = rec;
    return card;
  }

  // ---------- autenticación de agentes propios ----------
  // Authorization: Chasqui <b64u(canonical({address,ts,nonce,method,path,host}))>.<firma Ed25519>
  // `host` amarra el token a ESTA estafeta: el mismo header no sirve contra otra casa.
  // Con allowForeign, un agente de otra casa también puede autenticarse: su clave se obtiene por el
  // resolver (cadena DNS -> dominio -> agente). Así un foráneo consulta su cuenta en este Libro sin login.
  async _authenticate(rx, path, { allowForeign = false } = {}) {
    const h = rx.headers.authorization || '';
    const m = /^Chasqui\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(h);
    if (!m) throw Object.assign(new Error('falta Authorization: Chasqui <token>.<firma>'), { status: 401 });
    let claims;
    try { claims = JSON.parse(unb64u(m[1]).toString()); } catch { throw Object.assign(new Error('token ilegible'), { status: 401 }); }
    const { local, domain } = parseAddress(claims.address);
    let rec;
    if (domain === this.domain) {
      rec = await this.store.getAgent(local);
      if (!rec) throw Object.assign(new Error('agente no registrado'), { status: 401 });
    } else {
      if (!allowForeign) throw Object.assign(new Error('el agente no pertenece a este dominio'), { status: 401 });
      try { rec = await this.resolver.agentCard(claims.address); } catch (e) { throw Object.assign(new Error(`agente foráneo no verificable: ${e.message}`), { status: 401 }); }
    }
    if (Math.abs(now() - Date.parse(claims.ts)) > 300_000) throw Object.assign(new Error('token vencido (ventana de 5 min)'), { status: 401 });
    if (claims.method !== rx.method || claims.path !== path) throw Object.assign(new Error('token no corresponde a esta petición'), { status: 401 });
    if (claims.host !== this.authHost) throw Object.assign(new Error(`token emitido para otra casa (host ${claims.host || 'ausente'}, se espera ${this.authHost})`), { status: 401 });
    if (!verifyBytes(canonical(claims), m[2], rec.sig)) throw Object.assign(new Error('firma de token inválida'), { status: 401 });
    if (!await this.store.useNonce(`${claims.address}:${claims.nonce}`, now())) throw Object.assign(new Error('nonce reutilizado'), { status: 401 });
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
      await this.store.enqueue(job);
      await this._outbox(job);
      jobs.push({ job: job.id, domain, to });
    }
    return { ok: true, code: 202, id: env.id, jobs };
  }
  async _outbox(job, extra = {}) {
    await this.store.putOutbox(job.from_local, { job: job.id, id: job.envelope.id, domain: job.domain, to: job.to, status: job.status, attempts: job.attempts, next_attempt: job.next_attempt, updated: iso(), log: job.log, ...extra });
  }

  // ---------- trabajador de entrega (store-and-forward) ----------
  // El reclamo es exclusivo (claimDueJobs): dos ticks concurrentes (cron solapado, multi-isolate)
  // no toman el mismo trabajo. Un trabajo reclamado y no resuelto vuelve a ser reclamable al minuto.
  async tick() {
    await this.init();
    const due = await this.store.claimDueJobs(now(), 20);
    for (const job of due) await this._deliver(job);
    await this.store.pruneNonces?.(now() - 600_000);
    if (this.index.enabled) await this._indexCrawlIfDue();
  }
  async _deliver(job) {
    job.attempts += 1;
    let outcome;
    if (job.domain === this.domain) {
      // Entrega local: sin red, directo a inbound (misma verificación, cero riesgo de auto-fetch).
      const relay = `chasqui1 domain=${this.domain}; kid=${this.keys.sig}; sig=${signBytes(`relay:${job.envelope.id}:${this.domain}`, this.keys)}`;
      try {
        const r = await this.inbound(job.envelope, relay);
        outcome = { status: r.code, body: r };
      } catch (e) {
        outcome = { status: 500, error: e.message };
      }
    } else {
      try {
        const dc = await this.resolver.domainCard(job.domain);
        const relay = `chasqui1 domain=${this.domain}; kid=${this.keys.sig}; sig=${signBytes(`relay:${job.envelope.id}:${job.domain}`, this.keys)}`;
        const res = await this.fetch(`${dc._estafeta}/inbound`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-chasqui-relay': relay },
          body: JSON.stringify(job.envelope), signal: AbortSignal.timeout(10_000),
        });
        const body = await res.json().catch(() => null);
        // Un 200/202 sin cuerpo interpretable NO es una entrega: es un intermediario contestando
        // por la estafeta. Se trata como transitorio; jamás se declara entregado sin evidencia.
        if ((res.status === 200 || res.status === 202) && (!body || (!Array.isArray(body.accepted) && !Array.isArray(body.rejected)))) {
          outcome = { status: 502, error: 'respuesta sin forma de estafeta (¿intermediario?)' };
        } else {
          outcome = { status: res.status, body: body || {} };
        }
      } catch (e) {
        outcome = { status: 0, error: e.message };
      }
    }
    job.log.push({ at: iso(), attempt: job.attempts, status: outcome.status, detail: outcome.error || outcome.body?.reason || outcome.body?.rejected || 'ok' });

    // Clasificación por destinatario
    const delivered = [], failed = [], retry = [];
    if (outcome.status === 200 || outcome.status === 202) {
      for (const a of outcome.body.accepted || []) delivered.push(a);
      for (const r of outcome.body.rejected || []) (RETRYABLE.has(r.code) ? retry : failed).push(r);
      // Destinatarios que la respuesta no menciona: transitorio, no éxito silencioso.
      const mentioned = new Set([...delivered, ...(outcome.body.rejected || []).map((r) => r.to)]);
      for (const to of job.to) if (!mentioned.has(to)) retry.push({ to, code: outcome.status, reason: 'destinatario sin veredicto en la respuesta' });
    } else if (outcome.status === 0 || RETRYABLE.has(outcome.status)) {
      retry.push(...job.to.map((to) => ({ to, code: outcome.status, reason: outcome.error || outcome.body?.reason })));
    } else {
      failed.push(...job.to.map((to) => ({ to, code: outcome.status, reason: outcome.body?.reason || 'rechazo permanente' })));
    }

    for (const f of failed) await this._bounce(job, f.to, `rechazado (${f.code}): ${f.reason}`);
    if (delivered.length && job.envelope.receipt === 'delivered') for (const to of delivered) await this._notify(job, to, 'delivered', 'entregado en la estafeta destino');

    if (retry.length) {
      const age = now() - Date.parse(job.created);
      if (age > this.retry.giveUpMs) {
        for (const r of retry) await this._bounce(job, r.to, `sin respuesta tras ${job.attempts} intentos: ${r.reason}`);
        job.status = 'failed'; await this.store.removeJob(job.id); await this._outbox(job); return;
      }
      const backoff = Math.min(this.retry.baseMs * 2 ** (job.attempts - 1), this.retry.maxMs) * (0.8 + Math.random() * 0.4);
      job.to = retry.map((r) => r.to); job.status = 'retrying'; job.next_attempt = iso(now() + backoff); job.claimed_until = 0;
      await this.store.updateJob(job); await this._outbox(job);
      return;
    }
    job.status = failed.length && !delivered.length ? 'failed' : 'delivered';
    await this.store.removeJob(job.id); await this._outbox(job, { delivered: delivered.length, failed: failed.length });
  }

  // Sobres emitidos por los agentes de sistema (postmaster@, libro@), firmados con la clave del dominio.
  // Destinatarios locales: directo al buzón. Remotos: por la cola, como cualquier envío.
  async _systemSend(fromLocal, to, { type = 'receipt', content, thread = null, in_reply_to = null }) {
    const env = signObject({ chasqui: '1', id: uuid(), from: `${fromLocal}@${this.domain}`, to, created: iso(), expires: null, thread, in_reply_to, type, content }, this.keys);
    const byDomain = new Map();
    for (const t of to) {
      const { local, domain } = parseAddress(t);
      if (domain === this.domain) {
        if (await this.store.getAgent(local)) { await this.store.putMail(local, env, { via: fromLocal, from_verified: true }); this._push(local, env); }
        else this.log(`recibo de ${fromLocal}@ a ${t} descartado: agente inexistente`);
      } else byDomain.set(domain, [...(byDomain.get(domain) || []), t]);
    }
    for (const [domain, dest] of byDomain) await this.store.enqueue({ id: uuid(), envelope: env, domain, to: dest, from_local: fromLocal, attempts: 0, next_attempt: iso(), created: iso(), status: 'queued', log: [] });
    return env;
  }

  // Avisos del postmaster al remitente (rebotes y acuses de entrega). Llevan el hash del sobre original.
  async _notify(job, to, status, reason) {
    await this._systemSend('postmaster', [job.envelope.from], {
      in_reply_to: job.envelope.id, thread: job.envelope.thread || job.envelope.id,
      content: { media: 'application/json', body: { of: job.envelope.id, sha256: sha256hex(canonical(job.envelope)), to, status, reason } },
    });
  }
  async _bounce(job, to, reason) { this.log(`rebote ${job.envelope.id} -> ${to}: ${reason}`); await this._notify(job, to, 'failed', reason); }

  // ---------- entrada: otra estafeta nos entrega un sobre ----------
  async inbound(env, relayHeader) {
    const v = validateEnvelope(env, { maxBytes: this.policy.max_bytes });
    if (!v.ok) return v;
    if (env.expires && Date.parse(env.expires) < now()) return { ok: false, code: 410, reason: 'sobre vencido' };

    // Dedupe POR DESTINATARIO: lo ya aceptado no se re-procesa ni se re-cobra; lo pendiente
    // (una entrega parcial que la estafeta emisora reintenta) SÍ se procesa. La respuesta de un
    // duplicado dice la verdad: solo lo que de verdad se aceptó.
    const seen = await this.store.getSeen(env.id);
    const yaAceptados = new Set(seen?.accepted || []);

    const locals = env.to.filter((t) => parseAddress(t).domain === this.domain);
    if (!locals.length) return { ok: false, code: 404, reason: 'ningún destinatario pertenece a este dominio' };
    const pendientes = locals.filter((t) => !yaAceptados.has(t));
    if (!pendientes.length) return { ok: true, code: 200, duplicate: true, accepted: [...yaAceptados], rejected: [] };

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
    const mails = [], libroBundles = [];
    const recibosPendientes = [];
    let stampUsed = false;
    for (const to of pendientes) {
      const { local } = parseAddress(to);
      const rec = await this.store.getAgent(local);
      if (!rec) { rejected.push({ to, code: 404, reason: 'agente inexistente' }); continue; }
      const p = applyInboxPolicy(env, rec, senderCard._domain);
      if (!p.ok) { rejected.push({ to, ...p, ok: undefined }); continue; }
      try {
        if (local === 'libro') {
          // Operación del Libro: se ejecuta (idempotente por id de sobre), no se almacena;
          // los recibos salen firmados por la casa después del commit del sobre.
          const r = await this.libro.handle(env, senderCard);
          if (!r.ok) { rejected.push({ to, code: r.code, reason: r.reason }); continue; }
          for (const rc of r.recibos || []) recibosPendientes.push(rc);
          results[to] = r.result;
        } else if (p.stamp) {
          // Una estampilla paga UN buzón: el sobre declara un monto, no un monto por destinatario.
          if (stampUsed) { rejected.push({ to, code: 402, reason: 'la estampilla del sobre ya se usó en otro destinatario' }); continue; }
          const { asiento, bundle } = await this.libro.stamp(env, to, p.stamp.price);
          stampUsed = true;
          libroBundles.push(bundle);
          mails.push({ local, envelope: env, meta: { from_verified: true, relay_verified: relayVerified, sender_kid: env.signature.kid, stamp: asiento.id } });
        } else {
          mails.push({ local, envelope: env, meta: { from_verified: true, relay_verified: relayVerified, sender_kid: env.signature.kid } });
        }
      } catch (e) {
        if (e instanceof LibroError) { rejected.push({ to, code: e.code, reason: e.message }); continue; }
        throw e;
      }
      accepted.push(to);
    }

    // Un solo commit: buzones + estampillas + dedupe, juntos. En D1 es un batch atómico:
    // una reentrega concurrente no duplica buzón ni cobra la estampilla dos veces (invariante 4).
    const union = [...yaAceptados, ...accepted];
    if (accepted.length) {
      await this.store.inboundCommit({
        seen: { id: env.id, rec: { from: env.from, accepted: union } },
        mails, libro: libroBundles,
      });
      for (const m of mails) this._push(m.local, env);
    }
    for (const rc of recibosPendientes) await this._systemSend('libro', rc.to, { in_reply_to: env.id, thread: rc.thread || env.thread || null, content: { media: MEDIA.recibo, body: rc.body } });

    if (!union.length) return { ok: false, code: rejected[0].code, reason: rejected[0].reason, rejected, accepted: [] };
    return { ok: true, code: 202, accepted: union, rejected, results, ...(seen ? { duplicate: true } : {}) };
  }

  _push(local, env) {
    Promise.resolve(this.store.getAgent(local)).then((rec) => {
      if (!rec?.webhook) return;
      const body = JSON.stringify({ envelope: env });
      const sig = signBytes(`push:${env.id}`, this.keys);
      return this.fetch(rec.webhook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chasqui-push': `domain=${this.domain}; kid=${this.keys.sig}; sig=${sig}` }, body, signal: AbortSignal.timeout(5000) });
    }).catch((e) => this.log(`webhook ${local} falló: ${e.message}`));
  }

  // ---------- índice federado (opcional) ----------
  // Cualquier casa puede correr un índice: registra casas verificables, rastrea sus directorios
  // públicos y sirve la búsqueda. El índice es una PISTA, no una autoridad: cada tarjeta se
  // verifica igual por la cadena normal (DNS -> dominio -> agente) al momento de usarla.
  async indexAddHouse(domain) {
    domain = String(domain || '').toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(domain)) throw Object.assign(new Error('dominio inválido'), { status: 400 });
    const houses = await this.store.indexListHouses();
    if (houses.length >= this.index.maxHouses && !houses.some((h) => h.domain === domain)) throw Object.assign(new Error('índice lleno'), { status: 507 });
    // La verificación ES la puerta: solo se lista lo que resuelve y firma como casa Chasqui.
    const dc = await this.resolver.domainCard(domain).catch((e) => { throw Object.assign(new Error(`casa no verificable: ${e.message}`), { status: 422 }); });
    const h = { domain, estafeta: dc._estafeta, added: iso(), last_ok: null, fails: 0 };
    await this.store.indexPutHouse(h);
    await this._indexCrawlHouse(h);
    return h;
  }
  async _indexCrawlIfDue() {
    if (now() - this._lastCrawl < this.index.crawlMinutes * 60_000) return;
    this._lastCrawl = now();
    for (const h of await this.store.indexListHouses()) await this._indexCrawlHouse(h).catch((e) => this.log(`índice: ${h.domain} falló: ${e.message}`));
  }
  async _indexCrawlHouse(h) {
    try {
      const dc = await this.resolver.domainCard(h.domain); // re-verifica firma y ancla en cada pasada
      const cards = [];
      for (let offset = 0; offset < 2000;) {
        const res = await this.fetch(`${dc._estafeta}/agents?limit=200&offset=${offset}`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`GET /agents -> ${res.status}`);
        const page = await res.json();
        const batch = page.agents || [];
        // Solo tarjetas cuya certificación firma el dominio: el índice no ingiere lo que no verifica.
        const domainKeys = dc.keys.map((k) => k.sig);
        for (const c of batch) if (domainKeys.includes(c.certification?.kid) && verifyObject(c, c.certification.kid, 'certification')) cards.push({ ...c, _house: h.domain });
        offset += batch.length;
        if (batch.length < 200 || offset >= page.total) break;
      }
      await this.store.indexReplaceAgents(h.domain, cards);
      h.last_ok = iso(); h.fails = 0; h.agents = cards.length;
      await this.store.indexPutHouse(h);
    } catch (e) {
      h.fails = (h.fails || 0) + 1; h.last_error = `${iso()} ${e.message}`;
      await this.store.indexPutHouse(h);
      throw e;
    }
  }
  async indexSearch(params) {
    const out = await this.store.indexSearch(params);
    // Respuesta firmada por la casa del índice: otro índice (u otra casa) puede ingerirla verificada.
    return signObject({ chasqui: '1', index: this.domain, issued: iso(), ...out }, this.keys);
  }

  // ---------- HTTP (agnóstico de runtime) ----------
  // rx = { method, path, query: URLSearchParams, headers: {minúsculas}, body: objeto|null, ip }
  async handleRequest(rx) {
    await this.init();
    const path = rx.path;
    const send = (status, body) => ({ status, body });
    try {
      if (rx.method === 'GET' && path === '/health') return send(200, { ok: true, domain: this.domain, agents: (await this.store.listAgents()).length, queue: (await this.store.listQueue()).length });
      if (rx.method === 'GET' && path === '/.well-known/chasqui.json') return send(200, await this.domainCard());
      let m;
      if (rx.method === 'GET' && (m = /^\/agents\/([^/]+)$/.exec(path))) {
        const card = await this.agentCard(decodeURIComponent(m[1]).toLowerCase());
        return card ? send(200, card) : send(404, { reason: 'agente inexistente' });
      }
      if (rx.method === 'GET' && path === '/agents') {
        const p = Object.fromEntries(rx.query);
        return send(200, await this.directory({ capability: p.capability, accepts: p.accepts, q: p.q, limit: p.limit ?? 50, offset: p.offset ?? 0 }));
      }
      if (rx.method === 'POST' && path === '/agents') {
        const body = rx.body || {};
        const local = String(body.local || '').toLowerCase();
        const exists = !!(await this.store.getAgent(local));
        const isAdmin = (rx.headers.authorization || '') === `Bearer ${this.adminToken}`;
        let ok = isAdmin, via = 'admin';
        if (!ok && rx.headers.authorization?.startsWith('Chasqui ')) {
          const who = await this._authenticate(rx, path);
          ok = who.local === local || (body.delegation && who.address === body.delegation.by);
          via = body.delegation ? 'delegation' : 'self';
        }
        if (!ok) {
          // Auto-registro: el cuerpo viene firmado por la clave que se inscribe (prueba de posesión).
          if (exists) return send(409, { reason: 'ese nombre ya está tomado; solo su dueño o la casa pueden actualizarlo' });
          if (!body.signature || body.signature.kid !== body.sig || !verifyObject(body, body.sig)) return send(401, { reason: 'para auto-registrarse, firma el cuerpo con la clave sig que inscribes (prueba de posesión)' });
          if (Math.abs(now() - Date.parse(body.ts || 0)) > 300_000) return send(401, { reason: 'la solicitud firmada necesita ts (ISO) dentro de 5 minutos' });
          if (!this.regRate.allow(rx.ip || 'x')) return send(429, { reason: 'demasiados registros desde esta dirección' });
          if (this.policy.registration === 'open') via = 'open';
          else if (this.policy.registration === 'invite') { const inv = await this._consumeInvite(body.invite); via = `invite:${inv.code}`; if (inv.welcome != null) body._welcome = inv.welcome; }
          else return send(403, { reason: `esta casa no acepta auto-registro (registration=${this.policy.registration}); pide una invitación` });
        }
        const { signature: _s, ts: _t, invite: _i, _welcome, ...clean } = body;
        const card = await this.registerAgent({ ...clean, welcome: _welcome });
        this.log(`registro ${card.address} via ${via}`);
        return send(201, { ...card, registered_via: via });
      }
      if (rx.method === 'POST' && path === '/invitations') {
        if ((rx.headers.authorization || '') !== `Bearer ${this.adminToken}`) return send(401, { reason: 'solo la casa emite invitaciones' });
        return send(201, await this.createInvite(rx.body || {}));
      }
      if (rx.method === 'GET' && path === '/invitations') {
        if ((rx.headers.authorization || '') !== `Bearer ${this.adminToken}`) return send(401, { reason: 'solo la casa lista invitaciones' });
        return send(200, { invitations: await this.store.listInvites() });
      }
      if (rx.method === 'POST' && path === '/outbound') {
        const who = await this._authenticate(rx, path);
        const r = await this.outbound(rx.body, who);
        // kick: el adaptador dispara un tick tras responder (setImmediate en Node, waitUntil en Workers)
        return { ...send(r.code || 400, r), kick: true };
      }
      if (rx.method === 'POST' && path === '/inbound') {
        const r = await this.inbound(rx.body, rx.headers['x-chasqui-relay']);
        return { ...send(r.code || 400, r), kick: true };
      }
      if (rx.method === 'GET' && (m = /^\/mailbox\/([^/]+)$/.exec(path))) {
        const who = await this._authenticate(rx, path);
        if (who.local !== decodeURIComponent(m[1]).toLowerCase()) return send(403, { reason: 'buzón ajeno' });
        const limit = Number(rx.query.get('limit') || 50);
        return send(200, { messages: (await this.store.listMail(who.local)).slice(0, limit) });
      }
      if (rx.method === 'POST' && (m = /^\/mailbox\/([^/]+)\/ack$/.exec(path))) {
        const who = await this._authenticate(rx, path);
        if (who.local !== decodeURIComponent(m[1]).toLowerCase()) return send(403, { reason: 'buzón ajeno' });
        const { ids = [] } = rx.body || {};
        const acked = [];
        for (const id of ids) if (await this.store.ackMail(who.local, id)) acked.push(id);
        return send(200, { acked });
      }
      // ----- Libro (lecturas directas; las operaciones van por correo a libro@) -----
      if (rx.method === 'GET' && (m = /^\/libro\/cuenta\/([^/]+)$/.exec(path))) {
        const who = await this._authenticate(rx, path, { allowForeign: true });
        const address = decodeURIComponent(m[1]).toLowerCase();
        if (who.address !== address) return send(403, { reason: 'cuenta ajena' });
        return send(200, await this.libro.account(address));
      }
      if (rx.method === 'GET' && (m = /^\/libro\/contrato\/([^/]+)$/.exec(path))) {
        const who = await this._authenticate(rx, path, { allowForeign: true });
        const c = await this.store.libroGetContract(decodeURIComponent(m[1]));
        if (!c) return send(404, { reason: 'contrato inexistente' });
        if (![c.seller, c.buyer, c.verifier, c.arbiter].includes(who.address)) return send(403, { reason: 'no eres parte' });
        return send(200, c);
      }
      if (rx.method === 'POST' && path === '/libro/topup') {
        if ((rx.headers.authorization || '') !== `Bearer ${this.adminToken}`) return send(401, { reason: 'solo la casa carga saldo' });
        const { account, amount, concept } = rx.body || {};
        return send(201, await this.libro.topup(account, amount, concept || 'carga de la casa'));
      }
      if (rx.method === 'GET' && path === '/libro/diario') {
        if ((rx.headers.authorization || '') !== `Bearer ${this.adminToken}`) return send(401, { reason: 'solo la casa lee el diario completo' });
        return send(200, { balances: (await this.store.libroState()).balances, journal: await this.libro.journal() });
      }
      if (rx.method === 'GET' && (m = /^\/outbox\/([^/]+)$/.exec(path))) {
        const who = await this._authenticate(rx, path);
        if (who.local !== decodeURIComponent(m[1]).toLowerCase()) return send(403, { reason: 'bandeja ajena' });
        return send(200, { sent: await this.store.listOutbox(who.local) });
      }
      // ----- Índice federado -----
      if (this.index.enabled && rx.method === 'POST' && path === '/index/houses') {
        if (!this.rate.allow(`index:${rx.ip || 'x'}`)) return send(429, { reason: 'demasiadas solicitudes' });
        const h = await this.indexAddHouse((rx.body || {}).domain);
        return send(201, h);
      }
      if (this.index.enabled && rx.method === 'GET' && path === '/index/houses') {
        const houses = (await this.store.indexListHouses()).map(({ domain, estafeta, last_ok, agents }) => ({ domain, estafeta, last_ok, agents }));
        return send(200, { total: houses.length, houses });
      }
      if (this.index.enabled && rx.method === 'GET' && path === '/index/agents') {
        const p = Object.fromEntries(rx.query);
        const limit = Number.isInteger(Number(p.limit)) && Number(p.limit) > 0 ? Math.min(Number(p.limit), 200) : 50;
        const offset = Number.isInteger(Number(p.offset)) && Number(p.offset) >= 0 ? Number(p.offset) : 0;
        return send(200, await this.indexSearch({ q: p.q, capability: p.capability, accepts: p.accepts, house: p.house, limit, offset }));
      }
      return send(404, { reason: 'ruta desconocida' });
    } catch (e) {
      // Falla cerrado y con código HTTP válido: e.code puede ser un string del sistema ('ENOENT').
      const status = Number.isInteger(e.status) ? e.status : (Number.isInteger(e.code) ? e.code : 500);
      if (status >= 500) this.log(`error ${rx.method} ${path}: ${e.message}`);
      return send(status, { reason: e.message });
    }
  }

  // ---------- ciclo de vida en Node (los tests, demos y la CLI lo usan tal cual) ----------
  async start() {
    await this.init();
    const { startNodeServer } = await import('../plataformas/node.js');
    this._node = await startNodeServer(this, { port: this.port, host: this.host });
    this.timer = setInterval(() => this.tick().catch((e) => this.log('tick error', e.message)), this.workerIntervalMs);
    this.timer.unref?.();
    this.log(`escuchando en ${this.publicUrl}`);
    return this;
  }
  async stop() {
    clearInterval(this.timer);
    if (this._node) await this._node.close();
    this._node = null;
  }
}
