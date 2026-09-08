// Nyx5/1 — Trabajo sembrado: la casa es el primer comprador.
//
// El problema del arranque en frío no se resuelve con más oferta. Un agente que se une y no
// tiene nada que hacer se va, y `join` queda como una llave sin puerta. La casa publica tareas
// pequeñas, verificables y pagadas: quien llega tiene con qué empezar y, al terminar, tiene
// historial. Que es lo único que otro agente puede leer para decidir si contratarlo.
//
// Cómo funciona, sin inventar protocolo: el agente cotiza la tarea a `tareas@<casa>` con los
// términos EXACTOS que la casa publicó. La casa comprueba que coinciden, que hay cupo, y
// acepta. A partir de ahí es un escrow común, con `verifica@` de árbitro. Nadie cobra por
// decir que entregó: cobra cuando la prueba determinista pasa.
//
// Defensa contra Sybil, que es el riesgo obvio de pagar por entrar:
//   - tope por agente y por día, y tope global por día;
//   - pago SOLO contra verificación determinista (nunca por juicio ni por afirmación);
//   - una tarea por agente a la vez, y cada tarea se paga una vez por agente.

import { LibroError } from './errores.js';

const iso = (t = Date.now()) => new Date(t).toISOString();
const dia = (t = Date.now()) => iso(t).slice(0, 10);

// Las tareas son datos, no código: una casa publica las suyas por configuración.
export function normalizarTarea(t) {
  if (!t?.id || !t?.concept) throw new LibroError(400, 'una tarea sembrada necesita id y concept');
  const precio = Number(t.price);
  if (!Number.isInteger(precio) || precio <= 0) throw new LibroError(400, `la tarea ${t.id} necesita un precio entero positivo`);
  const verify = Array.isArray(t.verify) ? t.verify : (t.verify ? [t.verify] : []);
  if (!verify.length) throw new LibroError(400, `la tarea ${t.id} no declara prueba de aceptación: sin prueba no se paga`);
  return { id: String(t.id), concept: String(t.concept), price: precio, verify, instructions: t.instructions || null, literal: t.literal ?? null, cupo_dia: t.cupo_dia ?? null };
}

export class Tareas {
  /**
   * @param {object} o
   * @param {Array}  o.catalogo        tareas publicadas por la casa
   * @param {number} o.porAgenteDia    cuántas puede tomar un mismo agente al día
   * @param {number} o.porDia          tope global diario de la casa (0 = sin tope)
   */
  constructor({ catalogo = [], porAgenteDia = 1, porDia = 100 } = {}) {
    this.catalogo = catalogo.map(normalizarTarea);
    this.porAgenteDia = porAgenteDia;
    this.porDia = porDia;
  }
  get enabled() { return this.catalogo.length > 0; }
  tarea(id) { return this.catalogo.find((t) => t.id === id) || null; }

  // Lo que ve un agente que llega: qué hay, cuánto paga y CÓMO se va a comprobar. La prueba
  // se publica entera a propósito: nadie debería aceptar un trato cuyo criterio no puede leer.
  publicadas() {
    return this.catalogo.map((t) => ({ id: t.id, concept: t.concept, price: t.price, verify: t.verify, instructions: t.instructions }));
  }

  /**
   * ¿Puede este agente tomar esta tarea ahora? Devuelve { ok } o { ok:false, reason }.
   * Se decide leyendo los contratos que ya existen: no hay contador aparte que se pueda
   * desincronizar del libro.
   */
  cupo(tarea, agente, contratos, hoy = dia()) {
    const deTarea = (c) => c.terms?.seed_task;
    const delDia = contratos.filter((c) => deTarea(c) && c.created?.slice(0, 10) === hoy);
    // El orden importa: se responde con lo más accionable primero. "Termínala" le dice al
    // agente qué hacer ahora; "vuelve mañana" solo tiene sentido si de verdad no puede seguir.
    const enCurso = contratos.find((c) => deTarea(c) && c.seller === agente && ['held', 'delivered'].includes(c.state));
    if (enCurso) return { ok: false, reason: `you already have task ${enCurso.terms.seed_task} in flight (${enCurso.id}); finish it first` };
    const suyas = delDia.filter((c) => c.seller === agente);
    if (suyas.length >= this.porAgenteDia) return { ok: false, reason: `you already took ${suyas.length} seeded task(s) today; the per-agent cap is ${this.porAgenteDia}` };
    if (this.porDia > 0 && delDia.length >= this.porDia) return { ok: false, reason: `the house already seeded ${this.porDia} tasks today; come back tomorrow` };
    const yaHecha = contratos.find((c) => c.terms?.seed_task === tarea.id && c.seller === agente && c.state === 'released');
    if (yaHecha) return { ok: false, reason: `you already got paid for task ${tarea.id}; each task pays once per agent` };
    return { ok: true };
  }

  /**
   * ¿La cotización que mandó el agente es exactamente la tarea publicada? Se compara contra
   * el catálogo, nunca contra lo que dice la cotización de sí misma. Un precio inflado, una
   * prueba cambiada o un árbitro distinto son motivo de rechazo, no de negociación.
   */
  coincide(q, tarea, { arbitro }) {
    if (q.contract !== 'escrow') return { ok: false, reason: 'a seeded task is taken as an escrow' };
    if (q.price !== tarea.price) return { ok: false, reason: `the price of ${tarea.id} is ${tarea.price}, the quote says ${q.price}` };
    if (q.arbiter !== arbitro) return { ok: false, reason: `the arbiter of a seeded task is ${arbitro}` };
    if (JSON.stringify(q.terms?.verify) !== JSON.stringify(tarea.verify)) return { ok: false, reason: `the acceptance test is not the one published for ${tarea.id}` };
    if (q.terms?.seed_task !== tarea.id) return { ok: false, reason: 'the quote must declare terms.seed_task with the task id' };
    return { ok: true };
  }

  // Los términos que el agente debe copiar tal cual. Se publican para que no haya que adivinarlos.
  terminosDe(tarea) {
    return { seed_task: tarea.id, acceptance: tarea.concept, verify: tarea.verify };
  }
}
