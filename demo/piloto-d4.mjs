// D4 — Piloto con la flota propia.
//
// Una casa, un coordinador con presupuesto (topup por frente), trabajo delegado como escrow,
// un verificador que cobra por uso (metered), y un REPORTE DE COSTO POR ENTREGA leído del
// diario del Libro —no de la aritmética de este script—: el ledger es el terreno.
//
//   node demo/piloto-d4.mjs              # local, rápido y determinista (por defecto)
//
// Cada "frente" es una entrega: el coordinador delega una tarea al worker con un escrow
// (los fondos quedan retenidos hasta la entrega), el verificador la revisa cobrando metered,
// y recién ahí el coordinador libera el escrow. El costo de la entrega para el coordinador es
// lo que sus asientos muestran que salió de su cuenta: pago al worker (con fee de la casa) + verificación.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { sha256hex } from '../src/nucleo/crypto.js';

const DOM = 'pilot.local';
const URL = 'http://127.0.0.1:4090';
const hosts = { [DOM]: { url: URL } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chasqui-d4-'));

// La casa: fee 20% (como b.chsq.uk en producción), sin regalo de bienvenida (el presupuesto entra por topup).
const casa = await new Estafeta({ domain: DOM, port: 4090, dataDir: path.join(tmp, DOM), adminToken: 'p',
  hosts, workerIntervalMs: 80, libro: { feeBps: 2000, welcome: 0 }, log: () => {} }).start();

const coord = Agent.create(`coordinador@${DOM}`, URL, { hosts });
const worker = Agent.create(`worker@${DOM}`, URL, { hosts });
const verif = Agent.create(`verificador@${DOM}`, URL, { hosts });
for (const a of [coord, worker, verif]) await a.register({ adminToken: 'p' });

const money = (n) => String(n).padStart(6);
const bal = async (addr) => (await casa.store.libroState()).balances[addr] || 0;

// Los frentes del piloto: cada uno es una entrega con su precio de trabajo y su costo de verificación.
const FRENTES = [
  { frente: 'Sigo · edición diaria',      trabajo: 3000, verificacion: 500 },
  { frente: 'Rosetta · sellado de lote',  trabajo: 5000, verificacion: 800 },
  { frente: 'Q-Ready · barrido de sitio', trabajo: 2000, verificacion: 400 },
];

// Presupuesto: la casa carga el total a la cuenta del coordinador (topup por frente, un asiento por frente).
console.log('\n=== D4 · Piloto con la flota propia (casa pilot.local, fee 20%) ===\n');
let presupuesto = 0;
for (const f of FRENTES) {
  const monto = f.trabajo + f.verificacion;
  presupuesto += monto;
  await casa.libro.topup(coord.address, monto, `presupuesto ${f.frente}`);
}
console.log(`Presupuesto cargado al coordinador: ${presupuesto} tok (${FRENTES.length} frentes)\n`);

// Una entrega de punta a punta: escrow -> deliver -> verificación metered -> release.
async function entrega(f) {
  const salioAntes = await bal(coord.address);

  // 1. El worker cotiza la tarea como escrow; el coordinador acepta -> se retiene el monto.
  const q = await worker.quote({ to: coord.address, house: DOM, contract: 'escrow', price: f.trabajo,
    concept: f.frente, terms: { acceptance: 'entrega verificada' } });
  const qm = await coord.waitFor((e) => e.id === q.id);
  const cot = (await coord.open(qm.envelope)).content.body;
  const acc = await coord.accept(cot);
  const rAcc = await coord.awaitReceipt(acc.id);
  const contrato = rAcc.receipt.contract.id;

  // 2. El worker declara la entrega con el hash de la evidencia.
  const evidencia = sha256hex(`entregable de ${f.frente} @ ${new Date().toISOString()}`);
  const del = await worker.deliver(DOM, contrato, { evidence_sha256: evidencia, note: 'listo para verificar' });
  await worker.awaitReceipt(del.id);

  // 3. El verificador ofrece su servicio como metered; el coordinador acepta -> mandato de gasto.
  const qv = await verif.quote({ to: coord.address, house: DOM, contract: 'metered', price: f.verificacion,
    concept: `verificación · ${f.frente}`, terms: { scope: { concepts: ['verificación'] } } });
  const qvm = await coord.waitFor((e) => e.id === qv.id);
  const cotv = (await coord.open(qvm.envelope)).content.body;
  const accv = await coord.accept(cotv);
  const rAccv = await coord.awaitReceipt(accv.id);
  const mandato = rAccv.receipt.contract.mandate;

  // 4. El verificador cobra por la revisión (una pasada); el mandato descuenta del presupuesto.
  const chg = await verif.charge(DOM, { mandate: mandato, amount: f.verificacion, concept: 'verificación' });
  await verif.awaitReceipt(chg.id);

  // 5. Verificada, el coordinador libera el escrow: el worker cobra menos el fee de la casa.
  const rel = await coord.release(DOM, contrato);
  await coord.awaitReceipt(rel.id);

  const salioDespues = await bal(coord.address);
  return { ...f, contrato, costoReal: salioAntes - salioDespues };
}

const filas = [];
for (const f of FRENTES) { console.log(`→ ejecutando: ${f.frente} …`); filas.push(await entrega(f)); }

// ---- REPORTE DE COSTO POR ENTREGA, derivado del diario (el terreno, no la aritmética del script) ----
const { balances, journal } = { balances: (await casa.store.libroState()).balances, journal: await casa.libro.journal() };
const casaAddr = `casa@${DOM}`;
// Para cada contrato: cuánto recibió el worker (release), cuánto el fee de la casa, cuánto el verificador (charge).
const porContrato = {};
for (const fila of filas) porContrato[fila.contrato] = { worker: 0, fee: 0, verif: 0 };
for (const a of journal) {
  const c = a.meta?.contract;
  if (a.meta?.kind === 'release') {
    if (porContrato[c]) { porContrato[c].fee += a.meta.fee || 0;
      for (const l of a.lines) if (l.account === worker.address) porContrato[c].worker += l.delta; }
  }
}
// El cobro del verificador va por mandato: lo tomamos de las líneas que suman al verificador con kind charge.
for (const a of journal) {
  if (a.meta?.kind === 'charge') {
    for (const l of a.lines) if (l.account === verif.address) {
      // atribuir al frente por el concepto del mandato si está, si no, repartir por orden
      const fila = filas.find((f) => !porContrato[f.contrato]._verifDone);
      if (fila) { porContrato[fila.contrato].verif += l.delta; porContrato[fila.contrato]._verifDone = true; porContrato[fila.contrato].feeVerif = a.meta.fee || 0; }
    }
  }
}

console.log('\n=== Reporte de costo por entrega (leído del diario) ===\n');
console.log('FRENTE                        escrow  worker_neto  fee_casa  verif_neto  COSTO/ENTREGA');
let totCosto = 0, totWorker = 0, totFee = 0, totVerif = 0;
for (const fila of filas) {
  const p = porContrato[fila.contrato];
  const feeTotal = p.fee + (p.feeVerif || 0);
  console.log(`${fila.frente.padEnd(28)} ${money(fila.trabajo)}  ${money(p.worker)}     ${money(feeTotal)}   ${money(p.verif)}      ${money(fila.costoReal)}`);
  totCosto += fila.costoReal; totWorker += p.worker; totFee += feeTotal; totVerif += p.verif;
}
console.log(''.padEnd(28, '─') + ' ' + '─'.repeat(56));
console.log(`${'TOTAL'.padEnd(28)} ${' '.repeat(6)}  ${money(totWorker)}     ${money(totFee)}   ${money(totVerif)}      ${money(totCosto)}`);

console.log('\n=== Cierre presupuestario ===');
console.log(`presupuesto:        ${money(presupuesto)}`);
console.log(`gastado (entregas): ${money(totCosto)}`);
console.log(`restante coord:     ${money(await bal(coord.address))}`);
console.log(`fee recaudado casa: ${money(totFee)}  (sale del medio de cada pago, no se suma al costo)`);
console.log(`cobró worker:       ${money(balances[worker.address] || 0)}`);
console.log(`cobró verificador:  ${money(balances[verif.address] || 0)}`);
// Cuadre de doble entrada: todo lo cargado sigue en el sistema (worker + verif + fee de la casa).
const cuadre = (balances[worker.address] || 0) + (balances[verif.address] || 0) + totFee;
console.log(`cuadre:             ${money(cuadre)}  (worker + verificador + fee = presupuesto ${cuadre === presupuesto ? '✓' : '✗'})`);
console.log('\nCada token movido tiene su asiento firmado por la casa y su cadena de autoridad. El costo');
console.log('por entrega no es una estimación: es lo que el diario dice que salió de la cuenta del frente.\n');

await casa.stop();
