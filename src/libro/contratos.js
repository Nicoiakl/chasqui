// Chasqui/1 — Contratos: máquinas de estado sobre las primitivas del Libro.
//
// Cada operación recibe un contexto { libro, env, from, body, senderCard, opHash, scope } y devuelve
// { result, recibos: [{ to: [...], thread, body }] }. Los recibos los envía la estafeta desde
// `libro@<dominio>`, firmados con la clave de la casa: son la verdad compartida entre las partes.
//
// Agregar un contrato nuevo = agregar entradas a `ops` y, si se cotiza, a CONTRATOS.<kind>.
// El kernel (libro.js) no se toca.

import { sha256hex, canonical, uuid } from '../nucleo/crypto.js';
import { parseAddress } from '../correo/resolver.js';

import { LibroError } from './errores.js';

const iso = () => new Date().toISOString();
const fail = (code, msg) => { throw new LibroError(code, msg); };

// --- helpers ---
function getContract(libro, id) { const c = libro.store.libroGetContract(id); if (!c) fail(404, `contrato inexistente: ${id}`); return c; }
function getMandate(libro, id) { const m = libro.store.libroGetMandate(id); if (!m) fail(404, `mandato inexistente: ${id}`); return m; }
function record(libro, c, op, by, extra = {}) {
  c.history.push({ at: iso(), op, by, ...extra });
  c.updated = iso();
  libro.store.libroPutContract(c);
  return c;
}
function scopeCap(ctx, amount, what) {
  const cap = ctx.scope?.cap;
  if (cap != null && amount > cap) fail(403, `${what}: ${amount} tok supera el tope ${cap} del agente delegado`);
}
function must(cond, code, msg) { if (!cond) fail(code, msg); }
const parties = (c) => [c.seller, c.buyer, c.verifier, c.arbiter].filter(Boolean);

// ============ Operaciones ============
const ops = {

  // --- aceptar una cotización: crea el contrato y ejecuta el primer asiento ---
  async accept(ctx) {
    const { libro, from, body } = ctx;
    const q = body.quote;
    await libro.verifyQuote(q, from);
    scopeCap(ctx, q.price, 'aceptar cotización');
    const kind = CONTRATOS[q.contract];
    const c = {
      id: uuid(), kind: q.contract, house: libro.domain, seller: q.seller, buyer: from, amount: q.price,
      concept: q.concept, terms: q.terms || {}, arbiter: q.arbiter || null,
      quote_id: q.id, quote_sha256: sha256hex(canonical(q)), accept_sha256: ctx.opHash,
      state: 'accepted', created: iso(), history: [],
    };
    const refs = { contract: c.id, quote: q.id, quote_sha256: c.quote_sha256, op: ctx.env.id, op_sha256: ctx.opHash };
    const out = kind.onAccept({ libro, c, q, refs });
    record(libro, c, 'accept', from, { asiento: out.asiento?.id, mandate: out.mandate?.id });
    return { result: { contract: c, asiento: out.asiento, mandate: out.mandate },
      recibos: [{ to: [c.buyer, c.seller], thread: c.id, body: { contract: c, asiento: out.asiento, mandate: out.mandate, cotizacion_sha256: c.quote_sha256 } }] };
  },

  // --- escrow: el vendedor declara entregado, con hash de la evidencia ---
  async deliver(ctx) {
    const { libro, from, body } = ctx;
    const c = getContract(libro, body.contract);
    must(c.kind === 'escrow', 409, 'deliver solo aplica a escrow');
    must(from === c.seller, 403, 'solo el vendedor puede declarar la entrega');
    must(c.state === 'held', 409, `estado ${c.state}, se esperaba held`);
    c.state = 'delivered'; c.evidence_sha256 = body.evidence_sha256 || null;
    record(libro, c, 'deliver', from, { evidence_sha256: c.evidence_sha256, note: body.note });
    return { result: { contract: c }, recibos: [{ to: parties(c), thread: c.id, body: { contract: c } }] };
  },

  // --- liberar fondos retenidos: escrow -> vendedor (con fee); fianza -> vuelve al que afianzó ---
  async release(ctx) {
    const { libro, from, body } = ctx;
    const c = getContract(libro, body.contract);
    let asiento;
    if (c.kind === 'escrow') {
      must([c.buyer, c.arbiter].includes(from), 403, 'solo el comprador o el árbitro liberan el escrow');
      must(['held', 'delivered'].includes(c.state), 409, `estado ${c.state}`);
      asiento = libro.release(c.id, c.seller, c.amount, `liberación escrow ${c.id}: ${c.concept}`, { contract: c.id }, { op: ctx.env.id, op_sha256: ctx.opHash });
      c.state = 'released';
    } else if (c.kind === 'bond') {
      const expired = c.expires && Date.parse(c.expires) < Date.now();
      must([c.verifier, c.arbiter].includes(from) || (from === c.seller && expired), 403, 'la fianza la libera el verificador o el árbitro; el afianzado solo cuando vence');
      must(c.state === 'posted', 409, `estado ${c.state}`);
      asiento = libro.refund(c.id, c.seller, c.amount, `fianza liberada ${c.id}: ${c.claim}`, { contract: c.id, kind: 'bond-release' }, { op: ctx.env.id, op_sha256: ctx.opHash });
      c.state = 'released';
    } else fail(409, `release no aplica a ${c.kind}`);
    record(libro, c, 'release', from, { asiento: asiento.id });
    return { result: { contract: c, asiento }, recibos: [{ to: parties(c), thread: c.id, body: { contract: c, asiento } }] };
  },

  // --- devolver escrow al comprador (sin fee) ---
  async refund(ctx) {
    const { libro, from, body } = ctx;
    const c = getContract(libro, body.contract);
    must(c.kind === 'escrow', 409, 'refund solo aplica a escrow');
    must([c.seller, c.arbiter].includes(from) || (from === c.buyer && c.state === 'held'), 403, 'devuelven el vendedor o el árbitro; el comprador solo si aún no hay entrega');
    must(['held', 'delivered'].includes(c.state), 409, `estado ${c.state}`);
    const asiento = libro.refund(c.id, c.buyer, c.amount, `devolución escrow ${c.id}: ${c.concept}`, { contract: c.id }, { op: ctx.env.id, op_sha256: ctx.opHash });
    c.state = 'refunded';
    record(libro, c, 'refund', from, { asiento: asiento.id, note: body.note });
    return { result: { contract: c, asiento }, recibos: [{ to: parties(c), thread: c.id, body: { contract: c, asiento } }] };
  },

  // --- fianza: el que afirma deposita; si la verificación lo derriba, la pierde ---
  async bond(ctx) {
    const { libro, from, body } = ctx;
    must(typeof body.claim === 'string' && body.claim.length > 0, 400, 'la fianza necesita claim (la afirmación)');
    parseAddress(body.verifier); must(body.verifier !== from, 400, 'el verificador no puede ser el mismo afianzado');
    scopeCap(ctx, body.amount, 'afianzar');
    const c = {
      id: uuid(), kind: 'bond', house: libro.domain, seller: from, verifier: body.verifier, arbiter: body.arbiter || null,
      beneficiary: body.beneficiary || libro.casa, amount: body.amount, claim: body.claim, evidence_sha256: body.evidence_sha256 || null,
      expires: body.expires || null, claim_sha256: ctx.opHash, state: 'posted', created: iso(), history: [],
    };
    const asiento = libro.hold(from, c.id, c.amount, `fianza ${c.id}: ${c.claim}`, { contract: c.id, kind: 'bond' }, { op: ctx.env.id, op_sha256: ctx.opHash });
    record(libro, c, 'bond', from, { asiento: asiento.id });
    return { result: { contract: c, asiento }, recibos: [{ to: [c.seller, c.verifier], thread: c.id, body: { contract: c, asiento } }] };
  },

  // --- ejecutar la fianza: la afirmación era falsa ---
  async forfeit(ctx) {
    const { libro, from, body } = ctx;
    const c = getContract(libro, body.contract);
    must(c.kind === 'bond', 409, 'forfeit solo aplica a fianzas');
    must([c.verifier, c.arbiter].includes(from), 403, 'solo el verificador o el árbitro ejecutan la fianza');
    must(c.state === 'posted', 409, `estado ${c.state}`);
    const asiento = libro.post(`fianza ejecutada ${c.id}: ${c.claim}`, [{ account: `escrow:${c.id}`, delta: -c.amount }, { account: c.beneficiary, delta: c.amount }], { kind: 'forfeit', contract: c.id, reason: body.reason }, { op: ctx.env.id, op_sha256: ctx.opHash });
    c.state = 'forfeited';
    record(libro, c, 'forfeit', from, { asiento: asiento.id, reason: body.reason });
    return { result: { contract: c, asiento }, recibos: [{ to: parties(c), thread: c.id, body: { contract: c, asiento } }] };
  },

  // --- mandato: autoridad de gasto delegada, en cadena ---
  async mandate(ctx) {
    const { libro, from, body } = ctx;
    parseAddress(body.grantee);
    must(Number.isInteger(body.cap) && body.cap > 0, 400, 'cap debe ser entero positivo');
    scopeCap(ctx, body.cap, 'otorgar mandato');
    let parent = null;
    if (body.parent) {
      parent = getMandate(libro, body.parent);
      must(parent.state === 'active', 409, 'el mandato padre no está activo');
      must(parent.grantee === from, 403, 'solo el mandatario del padre puede sub-delegar');
      must(body.cap <= parent.cap - parent.spent, 403, `el sub-mandato (${body.cap}) supera lo disponible del padre (${parent.cap - parent.spent})`);
      if (parent.expires) must(!body.expires || Date.parse(body.expires) <= Date.parse(parent.expires), 403, 'el sub-mandato no puede durar más que el padre');
    }
    const m = { id: uuid(), house: libro.domain, grantor: from, grantee: body.grantee, cap: body.cap, spent: 0, scope: body.scope || {}, expires: body.expires || parent?.expires || null,
      parent: parent?.id || null, root: parent ? parent.root : from, chain: parent ? [...parent.chain, null] : [], state: 'active', created: iso(), op_sha256: ctx.opHash };
    m.chain = parent ? [...parent.chain, m.id] : [m.id];
    libro.store.libroPutMandate(m);
    return { result: { mandate: m }, recibos: [{ to: [m.grantor, m.grantee], thread: m.root ? m.chain[0] : m.id, body: { mandate: m } }] };
  },

  // --- cobrar bajo mandato: paga el mandante raíz; toda la cadena descuenta ---
  async charge(ctx) {
    const { libro, from, body } = ctx;
    const m = getMandate(libro, body.mandate);
    must(from === m.grantee, 403, 'solo el mandatario cobra bajo el mandato');
    must(Number.isInteger(body.amount) && body.amount > 0, 400, 'monto inválido');
    scopeCap(ctx, body.amount, 'cobrar');
    const chain = [];
    for (let cur = m; cur; cur = cur.parent ? getMandate(libro, cur.parent) : null) {
      must(cur.state === 'active', 409, `mandato ${cur.id} no está activo`);
      must(!cur.expires || Date.parse(cur.expires) > Date.now(), 410, `mandato ${cur.id} vencido`);
      must(cur.cap - cur.spent >= body.amount, 402, `mandato ${cur.id}: quedan ${cur.cap - cur.spent}, se piden ${body.amount}`);
      if (cur.scope?.concepts?.length) must(cur.scope.concepts.includes(body.concept), 403, `concepto "${body.concept}" fuera del ámbito del mandato`);
      chain.push(cur);
    }
    const asiento = libro.transfer(m.root, m.grantee, body.amount, body.concept || `cobro bajo mandato ${m.id}`, { mandate: m.id, chain: chain.map((x) => x.id) }, { op: ctx.env.id, op_sha256: ctx.opHash });
    for (const cur of chain) { cur.spent += body.amount; libro.store.libroPutMandate(cur); }
    const everyone = [...new Set(chain.flatMap((x) => [x.grantor, x.grantee]))];
    return { result: { asiento, mandate: chain[0] }, recibos: [{ to: everyone, thread: chain.at(-1).id, body: { asiento, mandate: chain[0], chain: chain.map((x) => ({ id: x.id, grantor: x.grantor, grantee: x.grantee, cap: x.cap, spent: x.spent })) } }] };
  },

  // --- revocar un mandato y todo lo que cuelga de él ---
  async revoke(ctx) {
    const { libro, from, body } = ctx;
    const m = getMandate(libro, body.mandate);
    const ancestors = []; for (let cur = m; cur; cur = cur.parent ? getMandate(libro, cur.parent) : null) ancestors.push(cur.grantor);
    must(ancestors.includes(from), 403, 'solo el mandante o un mandante superior revoca');
    const affected = libro.store.libroListMandates().filter((x) => x.chain.includes(m.id) && x.state === 'active');
    for (const x of affected) { x.state = 'revoked'; x.revoked = { at: iso(), by: from }; libro.store.libroPutMandate(x); }
    return { result: { revoked: affected.map((x) => x.id) }, recibos: [{ to: [...new Set(affected.flatMap((x) => [x.grantor, x.grantee]))], thread: m.chain[0], body: { revoked: affected.map((x) => x.id), by: from } }] };
  },

  // --- lecturas: la respuesta vuelve por correo como recibo ---
  async balance(ctx) {
    const acc = ctx.libro.account(ctx.from);
    return { result: acc, recibos: [{ to: [ctx.from], body: { account: acc.account, balance: acc.balance, contracts: acc.contracts.length, mandates: acc.mandates.length } }] };
  },
  async statement(ctx) {
    const n = ctx.body.limit || 20;
    const entries = ctx.libro.journal().filter((a) => a.lines.some((l) => l.account === ctx.from)).slice(-n);
    return { result: { entries }, recibos: [{ to: [ctx.from], body: { entries } }] };
  },
  async contract(ctx) {
    const c = getContract(ctx.libro, ctx.body.contract);
    must(parties(c).includes(ctx.from), 403, 'no eres parte de este contrato');
    return { result: { contract: c }, recibos: [{ to: [ctx.from], thread: c.id, body: { contract: c } }] };
  },
};

// ============ Tipos de contrato cotizables ============
export const CONTRATOS = {
  ops,
  // Spot: cotizar -> cobrar. Comprar un dato, un informe, una verificación.
  spot: { quoteable: true, onAccept({ libro, c, refs }) {
    c.state = 'settled';
    return { asiento: libro.transfer(c.buyer, c.seller, c.amount, `spot ${c.id}: ${c.concept}`, { contract: c.id }, refs) };
  } },
  // Escrow: retener al encargar -> liberar si la prueba pasa, devolver si falla. La cajita con dientes.
  escrow: { quoteable: true, onAccept({ libro, c, refs }) {
    c.state = 'held';
    return { asiento: libro.hold(c.buyer, c.id, c.amount, `escrow ${c.id}: ${c.concept}`, { contract: c.id }, refs) };
  } },
  // Medido: la aceptación crea un mandato del comprador al vendedor con tope = precio cotizado.
  metered: { quoteable: true, onAccept({ libro, c, q, refs }) {
    const m = { id: uuid(), house: libro.domain, grantor: c.buyer, grantee: c.seller, cap: c.amount, spent: 0, scope: q.terms?.scope || {}, expires: q.terms?.expires || q.expires || null,
      parent: null, root: c.buyer, chain: [], state: 'active', created: iso(), contract: c.id, op_sha256: refs.op_sha256 };
    m.chain = [m.id];
    libro.store.libroPutMandate(m);
    c.state = 'active'; c.mandate = m.id;
    return { mandate: m };
  } },
  // Bond (fianza) no se cotiza: se deposita directamente con la operación `bond`.
  bond: { quoteable: false },
};
