// Chasqui/1 — Libro: el ledger de doble entrada de una casa (dominio).
//
// El Libro es el segundo componente del sistema; el primero es el Correo. No tiene login propio:
// toda operación llega como un sobre firmado a `libro@<dominio>`, y la identidad del remitente ya
// viene verificada por la cadena de confianza del Correo. El Libro solo decide si la operación es
// válida (partes, estado, saldo) y ejecuta el asiento.
//
// Kernel: siete primitivas y nada más. Los contratos (contratos.js) se componen encima.
//   1. cotizar   -> no toca el libro: es un documento firmado por el vendedor (verifyQuote lo valida)
//   2. cobrar    -> transfer(de, a, monto)  con reparto de fee a la casa
//   3. retener   -> hold(de, escrow, monto)
//   4. liberar   -> release(escrow, a, monto) con fee
//   5. devolver  -> refund(escrow, a, monto) sin fee
//   6. repartir  -> post() con N líneas que suman cero (el fee de la casa es un reparto)
//   7. afianzar  -> hold() con condición de salida distinta (forfeit / release)
// Transversales: idempotencia (por id de sobre) y meta (contexto legible por máquina en cada asiento).
//
// Cuentas: `agente@dominio` (cualquier agente verificable, de esta casa o de otra), `casa@<dominio>`
// (la distribuidora: emite tokens, cobra fees; es la única que puede quedar en negativo) y
// `escrow:<contrato>` (fondos retenidos). Un asiento es una lista de líneas {cuenta, delta} que suman 0.

import { signObject, verifyObject, canonical, sha256hex, uuid } from '../nucleo/crypto.js';
import { Resolver, parseAddress } from '../correo/resolver.js';
import { CONTRATOS } from './contratos.js';
import { LibroError } from './errores.js';
export { LibroError };

export const MEDIA = {
  op: 'application/chasqui.libro+json',
  cotizacion: 'application/chasqui.cotizacion+json',
  recibo: 'application/chasqui.recibo+json',
};

const iso = () => new Date().toISOString();


export class Libro {
  constructor({ domain, store, keys, resolver, feePct = 0.10, welcome = 0, log = () => {} }) {
    this.domain = domain; this.store = store; this.keys = keys; this.resolver = resolver;
    this.feePct = feePct; this.welcome = welcome; this.log = log;
    this.casa = `casa@${domain}`;
    this.address = `libro@${domain}`;
  }

  // ---------- consultas ----------
  get ops() { return Object.keys(CONTRATOS.ops); }
  balance(account) { return this.store.libroState().balances[account] || 0; }
  fee(amount) { return Math.floor(amount * this.feePct); }
  account(address) {
    const contracts = this.store.libroListContracts().filter((c) => [c.seller, c.buyer, c.verifier, c.arbiter].includes(address));
    const mandates = this.store.libroListMandates().filter((m) => m.grantor === address || m.grantee === address);
    return { account: address, balance: this.balance(address), contracts, mandates };
  }
  journal() { return this.store.libroJournal(); }

  // ---------- el kernel: un asiento ----------
  // lines: [{ account, delta }]; suma cero; nadie salvo la casa queda negativo.
  post(concept, lines, meta = {}, refs = {}) {
    const total = lines.reduce((s, l) => s + l.delta, 0);
    if (total !== 0) throw new LibroError(500, `asiento descuadrado (${total})`);
    for (const l of lines) if (!Number.isInteger(l.delta)) throw new LibroError(400, 'los montos son enteros (tokens)');
    const state = this.store.libroState();
    const next = { ...state.balances };
    for (const l of lines) {
      next[l.account] = (next[l.account] || 0) + l.delta;
      if (next[l.account] < 0 && l.account !== this.casa) throw new LibroError(402, `saldo insuficiente en ${l.account} (tiene ${state.balances[l.account] || 0}, necesita ${-l.delta})`);
    }
    const asiento = signObject({ id: uuid(), n: state.seq + 1, at: iso(), house: this.domain, concept, lines, meta, refs }, this.keys);
    this.store.libroAppend(asiento);
    this.store.libroPutState({ seq: state.seq + 1, balances: next });
    return asiento;
  }

  // Primitivas construidas sobre post()
  topup(account, amount, concept = 'carga', meta = {}) {
    parseAddress(account); this._amount(amount);
    return this.post(concept, [{ account: this.casa, delta: -amount }, { account, delta: amount }], { kind: 'topup', ...meta });
  }
  transfer(from, to, amount, concept, meta = {}, refs = {}) {
    this._amount(amount);
    const fee = this.fee(amount);
    const lines = [{ account: from, delta: -amount }, { account: to, delta: amount - fee }];
    if (fee) lines.push({ account: this.casa, delta: fee });
    return this.post(concept, lines, { kind: 'charge', fee, ...meta }, refs);
  }
  hold(from, contractId, amount, concept, meta = {}, refs = {}) {
    this._amount(amount);
    return this.post(concept, [{ account: from, delta: -amount }, { account: `escrow:${contractId}`, delta: amount }], { kind: 'hold', ...meta }, refs);
  }
  release(contractId, to, amount, concept, meta = {}, refs = {}) {
    this._amount(amount);
    const fee = this.fee(amount);
    const lines = [{ account: `escrow:${contractId}`, delta: -amount }, { account: to, delta: amount - fee }];
    if (fee) lines.push({ account: this.casa, delta: fee });
    return this.post(concept, lines, { kind: 'release', fee, ...meta }, refs);
  }
  refund(contractId, to, amount, concept, meta = {}, refs = {}) {
    this._amount(amount);
    return this.post(concept, [{ account: `escrow:${contractId}`, delta: -amount }, { account: to, delta: amount }], { kind: 'refund', ...meta }, refs);
  }
  _amount(a) { if (!Number.isInteger(a) || a <= 0) throw new LibroError(400, `monto inválido: ${a}`); }

  // ---------- cotizaciones: documentos firmados por el vendedor ----------
  // Una cotización viaja adentro de un sobre (cifrado si se quiere) y se presenta al Libro al aceptar.
  static buildQuote({ seller, buyer, house, contract = 'spot', price, concept, terms = {}, expires, arbiter = null }, sellerKeys) {
    if (!CONTRATOS[contract]?.quoteable) throw new LibroError(400, `contrato no cotizable: ${contract}`);
    return signObject({ tipo: 'cotizacion', id: uuid(), house, seller, buyer, contract, price, currency: 'tok', concept, terms, arbiter, issued: iso(), expires: expires || null }, sellerKeys);
  }
  async verifyQuote(q, buyer) {
    if (q?.tipo !== 'cotizacion' || !q.id || !q.seller || !q.signature) throw new LibroError(400, 'cotización malformada');
    if (q.house !== this.domain) throw new LibroError(400, `la cotización es para la casa ${q.house}, no ${this.domain}`);
    if (q.buyer !== buyer) throw new LibroError(403, 'la cotización no está dirigida a quien la acepta');
    if (q.expires && Date.parse(q.expires) < Date.now()) throw new LibroError(410, 'cotización vencida');
    this._amount(q.price);
    let card;
    try { card = await this.resolver.agentCardForKid(q.seller, q.signature.kid); } catch (e) { throw new LibroError(e.permanent ? 403 : 421, `no se pudo verificar al vendedor: ${e.message}`); }
    if (!Resolver.acceptedKids(card).includes(q.signature.kid) || !verifyObject(q, q.signature.kid)) throw new LibroError(403, 'firma de la cotización inválida');
    if (this.store.libroListContracts().some((c) => c.quote_id === q.id)) throw new LibroError(409, 'cotización ya aceptada');
    return card;
  }

  // ---------- entrada: un sobre dirigido a libro@<dominio> ----------
  // Devuelve { ok, code, reason, result, recibos: [{ to: [...], body }] }. Idempotente por id de sobre.
  async handle(env, senderCard) {
    const prev = this.store.libroGetOp(env.id);
    if (prev) return { ...prev, duplicate: true };
    if (!env.content || env.content.media !== MEDIA.op) return { ok: false, code: 400, reason: `el Libro solo acepta content.media = ${MEDIA.op} (sin cifrar: la casa debe leerlo)` };
    const body = env.content.body || {};
    const op = CONTRATOS.ops[body.op];
    if (!op) return { ok: false, code: 400, reason: `operación desconocida: ${body.op}. Válidas: ${Object.keys(CONTRATOS.ops).join(', ')}` };
    const ctx = { libro: this, env, from: env.from, body, senderCard, opHash: sha256hex(canonical(env)), scope: senderCard?.delegation?.scope || null };
    let result;
    try { result = await op(ctx); }
    catch (e) {
      if (e instanceof LibroError) return { ok: false, code: e.code, reason: e.message };
      throw e;
    }
    const out = { ok: true, code: 202, result: result.result, recibos: (result.recibos || []).map((r) => ({ ...r, body: { ...r.body, of: env.id, op: body.op, op_sha256: ctx.opHash, from: env.from } })) };
    this.store.libroPutOp(env.id, out);
    return out;
  }

  // Estampilla: un sobre con `stamp` hacia un buzón con política `stamp` paga al llegar.
  stamp(env, recipient, price) {
    const s = env.stamp;
    if (!s || s.house !== this.domain || !Number.isInteger(s.amount) || s.amount < price) throw new LibroError(402, `este buzón exige estampilla de ${price} tok en la casa ${this.domain} (campo stamp: {house, amount})`);
    return this.transfer(env.from, recipient, s.amount, `estampilla ${env.from} -> ${recipient}`, { kind: 'stamp' }, { envelope: env.id, envelope_sha256: sha256hex(canonical(env)) });
  }
}
