// Chasqui/1 — Almacenamiento de una estafeta (Correo) y su Libro en archivos JSON.
// Es deliberadamente simple e inspeccionable. En producción se reemplaza por una clase con la
// misma interfaz sobre D1/Postgres (ver almacen-d1.js y docs/ARQUITECTURA.md).
//
// CONTRATO: la interfaz es async — todo método puede devolver Promise y los llamadores hacen
// await siempre. FileStore implementa en síncrono (un solo proceso Node: sin carreras); D1Store
// implementa en async real y da la atomicidad por transacción donde aquí la da el proceso único.
//
// Operaciones compuestas del contrato (las que en D1 son una transacción):
//   markSeenIfNew(id, meta)  -> boolean   dedupe atómico de sobres
//   claimDueJobs(nowMs, max) -> jobs[]    reclamo exclusivo de trabajos de la cola
//   useNonce(key, ts)        -> boolean   anti-replay de tokens de auth
//   libroCommit(bundle)                   un asiento del Libro con todo lo que lo acompaña
//   inboundCommit(bundle)                 la entrega de un sobre: seen + buzones + Libro, junto

import fs from 'node:fs';
import path from 'node:path';

const readJson = (p, fallback = null) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback);
const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, p);
};

export class FileStore {
  constructor(dir) {
    this.dir = dir;
    for (const d of ['agents', 'mailbox', 'queue', 'outbox', 'invitations', 'libro/diario', 'libro/contratos', 'libro/mandatos', 'libro/ops', 'indice/casas', 'indice/agentes']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    this.nonces = new Map(); // anti-replay: en FileStore basta memoria (un proceso)
  }

  // --- dominio ---
  getDomain() { return readJson(path.join(this.dir, 'domain.json')); }
  putDomain(v) { writeJson(path.join(this.dir, 'domain.json'), v); }

  // --- agentes ---
  getAgent(local) { return readJson(path.join(this.dir, 'agents', `${local}.json`)); }
  putAgent(local, v) { writeJson(path.join(this.dir, 'agents', `${local}.json`), v); }
  listAgents() { return fs.readdirSync(path.join(this.dir, 'agents')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); }

  // --- invitaciones de registro ---
  getInvite(code) { return readJson(path.join(this.dir, 'invitations', `${code}.json`)); }
  putInvite(inv) { writeJson(path.join(this.dir, 'invitations', `${inv.code}.json`), inv); }
  listInvites() { const d = path.join(this.dir, 'invitations'); return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(d, f))); }

  // --- deduplicación de sobres recibidos ---
  getSeen(id) { return readJson(path.join(this.dir, 'seen', `${id}.json`)); }
  putSeen(id, rec) { writeJson(path.join(this.dir, 'seen', `${id}.json`), { id, at: new Date().toISOString(), ...rec }); }
  // Dedupe atómico: true si es la primera vez. En D1: INSERT con PK y changes === 1.
  markSeenIfNew(id, meta = {}) {
    if (this.getSeen(id)) return false;
    this.putSeen(id, meta);
    return true;
  }

  // --- buzones ---
  putMail(local, envelope, meta = {}) {
    // `received` es del sistema: la meta no puede pisarlo.
    writeJson(path.join(this.dir, 'mailbox', local, `${envelope.id}.json`), { ...meta, received: new Date().toISOString(), envelope });
  }
  listMail(local) {
    const dir = path.join(this.dir, 'mailbox', local);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f)))
      .sort((a, b) => String(a.received).localeCompare(String(b.received)));
  }
  ackMail(local, id) {
    const p = path.join(this.dir, 'mailbox', local, `${id}.json`);
    if (!fs.existsSync(p)) return false;
    const archived = path.join(this.dir, 'archive', local, `${id}.json`);
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.renameSync(p, archived);
    return true;
  }

  // --- cola de salida (store-and-forward) ---
  enqueue(job) { writeJson(path.join(this.dir, 'queue', `${job.id}.json`), job); }
  listQueue() { return fs.readdirSync(path.join(this.dir, 'queue')).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(this.dir, 'queue', f))); }
  updateJob(job) { this.enqueue(job); }
  removeJob(id) { const p = path.join(this.dir, 'queue', `${id}.json`); if (fs.existsSync(p)) fs.unlinkSync(p); }
  // Reclamo exclusivo: devuelve los trabajos vencidos y los marca en vuelo con un plazo.
  // En D1 es un solo UPDATE ... RETURNING; aquí, el proceso único lo hace seguro.
  claimDueJobs(nowMs, max = 20) {
    const due = this.listQueue().filter((j) =>
      Date.parse(j.next_attempt) <= nowMs &&
      (j.status === 'queued' || j.status === 'retrying' || (j.status === 'inflight' && (j.claimed_until || 0) < nowMs)))
      .slice(0, max);
    for (const j of due) { j.status = 'inflight'; j.claimed_until = nowMs + 60_000; this.updateJob(j); }
    return due;
  }

  // --- historial de salida por agente (estado de cada envío) ---
  putOutbox(local, entry) { writeJson(path.join(this.dir, 'outbox', local, `${entry.job}.json`), entry); }
  listOutbox(local) {
    const dir = path.join(this.dir, 'outbox', local);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f)));
  }

  // --- anti-replay de tokens de auth ---
  useNonce(key, tsMs) {
    if (this.nonces.has(key)) return false;
    this.nonces.set(key, tsMs);
    if (this.nonces.size > 10_000) { const cut = Date.now() - 600_000; for (const [k, t] of this.nonces) if (t < cut) this.nonces.delete(k); }
    return true;
  }
  pruneNonces(beforeMs) { for (const [k, t] of this.nonces) if (t < beforeMs) this.nonces.delete(k); }

  // --- pins de claves de dominios ajenos (TOFU) ---
  getPins() { return readJson(path.join(this.dir, 'pins.json'), {}); }
  putPins(v) { writeJson(path.join(this.dir, 'pins.json'), v); }

  // ===== Libro (ledger de doble entrada) =====
  // saldos.json = { seq: <último asiento>, balances: { cuenta: saldo } }
  libroState() { return readJson(path.join(this.dir, 'libro', 'saldos.json'), { seq: 0, balances: {} }); }
  libroPutState(v) { writeJson(path.join(this.dir, 'libro', 'saldos.json'), v); }
  libroAppend(asiento) { writeJson(path.join(this.dir, 'libro', 'diario', `${String(asiento.n).padStart(12, '0')}.json`), asiento); }
  libroJournal() {
    const dir = path.join(this.dir, 'libro', 'diario');
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f))).sort((a, b) => a.n - b.n);
  }
  libroGetContract(id) { return readJson(path.join(this.dir, 'libro', 'contratos', `${id}.json`)); }
  libroPutContract(c) { writeJson(path.join(this.dir, 'libro', 'contratos', `${c.id}.json`), c); }
  libroListContracts() { const d = path.join(this.dir, 'libro', 'contratos'); return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(d, f))); }
  libroFindContractByQuote(quoteId) { return this.libroListContracts().find((c) => c.quote_id === quoteId) || null; }
  libroGetMandate(id) { return readJson(path.join(this.dir, 'libro', 'mandatos', `${id}.json`)); }
  libroPutMandate(m) { writeJson(path.join(this.dir, 'libro', 'mandatos', `${m.id}.json`), m); }
  libroListMandates() { const d = path.join(this.dir, 'libro', 'mandatos'); return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(d, f))); }
  libroGetOp(id) { return readJson(path.join(this.dir, 'libro', 'ops', `${id}.json`)); }
  libroPutOp(id, v) { writeJson(path.join(this.dir, 'libro', 'ops', `${id}.json`), v); }
  libroStatement(account, limit) {
    return this.libroJournal().filter((a) => a.lines.some((l) => l.account === account)).slice(-limit);
  }

  // Un movimiento completo del Libro, junto. En D1: un batch atómico donde el PK del asiento (n)
  // y el PK de la op (id de sobre) hacen fallar cerrado la concurrencia y la reentrega.
  // bundle = { state, asientos: [], contracts: [], mandates: [], op: { id, result } | null }
  libroCommit(bundle) {
    // Mismo candado que D1: si otra operación cometió desde que ésta leyó el estado, el número de
    // asiento ya está tomado y esto falla cerrado en vez de pisar. Sin esto, FileStore sería más
    // permisivo que producción y un defecto de concurrencia no se vería en las pruebas locales.
    if (bundle.base) {
      const actual = this.libroState();
      if (actual.seq !== bundle.base.seq) {
        const e = new Error(`conflicto de concurrencia en el ledger: el estado cambió (seq ${bundle.base.seq} -> ${actual.seq})`);
        e.code = 421; e.transient = true;
        throw e;
      }
    }
    for (const a of bundle.asientos || []) this.libroAppend(a);
    if (bundle.state) this.libroPutState(bundle.state);
    for (const c of bundle.contracts || []) this.libroPutContract(c);
    for (const m of bundle.mandates || []) this.libroPutMandate(m);
    if (bundle.op) this.libroPutOp(bundle.op.id, bundle.op.result);
  }

  // La entrega de un sobre entero, junta: dedupe + buzones + movimientos del Libro (estampillas, ops).
  // bundle = { seen: { id, rec } | null, mails: [{ local, envelope, meta }], libro: [libroBundle...] }
  inboundCommit(bundle) {
    for (const m of bundle.mails || []) this.putMail(m.local, m.envelope, m.meta);
    for (const lb of bundle.libro || []) this.libroCommit(lb);
    if (bundle.seen) this.putSeen(bundle.seen.id, bundle.seen.rec);
  }

  // ===== Índice federado (opcional: solo casas que corren un índice) =====
  indexGetHouse(domain) { return readJson(path.join(this.dir, 'indice', 'casas', `${domain}.json`)); }
  indexPutHouse(h) { writeJson(path.join(this.dir, 'indice', 'casas', `${h.domain}.json`), h); }
  indexListHouses() { const d = path.join(this.dir, 'indice', 'casas'); return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(d, f))); }
  indexReplaceAgents(domain, cards) { writeJson(path.join(this.dir, 'indice', 'agentes', `${domain}.json`), { domain, cards, updated: new Date().toISOString() }); }
  indexSearch({ q, capability, accepts, house, limit = 50, offset = 0 } = {}) {
    const d = path.join(this.dir, 'indice', 'agentes');
    let cards = fs.readdirSync(d).filter((f) => f.endsWith('.json'))
      .filter((f) => !house || f === `${house}.json`)
      .flatMap((f) => (readJson(path.join(d, f))?.cards || []));
    if (capability) cards = cards.filter((c) => c.capabilities?.[capability]);
    if (accepts) cards = cards.filter((c) => c.capabilities?.accepts?.includes(accepts));
    if (q) { const needle = String(q).toLowerCase(); cards = cards.filter((c) => c.address.includes(needle) || JSON.stringify(c.capabilities || {}).toLowerCase().includes(needle)); }
    return { total: cards.length, offset, agents: cards.slice(offset, offset + limit) };
  }
}
