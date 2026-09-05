// Chasqui/1 — Almacenamiento de una estafeta (Correo) y su Libro en archivos JSON.
// Es deliberadamente simple e inspeccionable. En producción se reemplaza por una clase con la
// misma interfaz sobre Postgres/Supabase (ver docs/ARQUITECTURA.md). Todo es síncrono para
// evitar carreras dentro de un solo proceso.

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
    for (const d of ['agents', 'mailbox', 'queue', 'outbox', 'invitations', 'libro/diario', 'libro/contratos', 'libro/mandatos', 'libro/ops']) fs.mkdirSync(path.join(dir, d), { recursive: true });
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
  hasSeen(id) { return fs.existsSync(path.join(this.dir, 'seen', `${id}.json`)); }
  markSeen(id, meta = {}) { writeJson(path.join(this.dir, 'seen', `${id}.json`), { id, at: new Date().toISOString(), ...meta }); }

  // --- buzones ---
  putMail(local, envelope, meta = {}) {
    writeJson(path.join(this.dir, 'mailbox', local, `${envelope.id}.json`), { received: new Date().toISOString(), ...meta, envelope });
  }
  listMail(local) {
    const dir = path.join(this.dir, 'mailbox', local);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f)))
      .sort((a, b) => a.received.localeCompare(b.received));
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

  // --- historial de salida por agente (estado de cada envío) ---
  putOutbox(local, entry) { writeJson(path.join(this.dir, 'outbox', local, `${entry.job}.json`), entry); }
  listOutbox(local) {
    const dir = path.join(this.dir, 'outbox', local);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f)));
  }

  // --- pins de claves de dominios ajenos (TOFU) ---
  getPins() { return readJson(path.join(this.dir, 'pins.json'), {}); }
  putPins(v) { writeJson(path.join(this.dir, 'pins.json'), v); }

  // ===== Libro (ledger de doble entrada) =====
  // saldos.json = { seq: <último asiento>, balances: { cuenta: saldo } }
  libroState() { return readJson(path.join(this.dir, 'libro', 'saldos.json'), { seq: 0, balances: {} }); }
  libroPutState(v) { writeJson(path.join(this.dir, 'libro', 'saldos.json'), v); }
  libroAppend(asiento) { writeJson(path.join(this.dir, 'libro', 'diario', `${String(asiento.n).padStart(8, '0')}.json`), asiento); }
  libroJournal() {
    const dir = path.join(this.dir, 'libro', 'diario');
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => readJson(path.join(dir, f)));
  }
  libroGetContract(id) { return readJson(path.join(this.dir, 'libro', 'contratos', `${id}.json`)); }
  libroPutContract(c) { writeJson(path.join(this.dir, 'libro', 'contratos', `${c.id}.json`), c); }
  libroListContracts() { const d = path.join(this.dir, 'libro', 'contratos'); return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(d, f))); }
  libroGetMandate(id) { return readJson(path.join(this.dir, 'libro', 'mandatos', `${id}.json`)); }
  libroPutMandate(m) { writeJson(path.join(this.dir, 'libro', 'mandatos', `${m.id}.json`), m); }
  libroListMandates() { const d = path.join(this.dir, 'libro', 'mandatos'); return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(d, f))); }
  libroGetOp(id) { return readJson(path.join(this.dir, 'libro', 'ops', `${id}.json`)); }
  libroPutOp(id, v) { writeJson(path.join(this.dir, 'libro', 'ops', `${id}.json`), v); }
}
