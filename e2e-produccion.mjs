// E2E contra PRODUCCIÓN: dos casas reales en Cloudflare, resolución por well-known (sin overrides).
// Criterio de la fase 2 del roadmap: "un agente externo te escribe, cotiza y paga estampilla desde afuera".
// Uso: node --env-file=.env e2e-produccion.mjs
import { Agent } from './src/correo/agente.js';

const CASA = 'chsq.uk';
const BETA = 'b.chsq.uk';
const T1 = (process.env.NYX5_ADMIN_TOKEN || process.env.CHASQUI_ADMIN_TOKEN);
const T2 = (process.env.NYX5_BETA_ADMIN_TOKEN || process.env.CHASQUI_BETA_ADMIN_TOKEN);
if (!T1 || !T2) throw new Error('faltan tokens en .env');

const sello = Date.now().toString(36);
const log = (t, v) => console.log(`\n== ${t}`, v === undefined ? '' : JSON.stringify(v, null, 1).slice(0, 600));
const invite = async (base, token, welcome) => (await (await fetch(`${base}/invitations`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ uses: 1, welcome }) })).json()).code;

// 1. Invitaciones (el modo de la casa es invite: nadie entra sin código)
const inv1 = await invite(`https://${CASA}`, T1, 20000);
const inv2 = await invite(`https://${CASA}`, T1, null);
const inv3 = await invite(`https://${BETA}`, T2, 5000);
log('1. invitaciones emitidas', { casa: 2, beta: 1 });

// 2. Registro con prueba de posesión, entre casas de verdad
const nico = Agent.create(`nico-${sello}@${CASA}`, `https://${CASA}`);
const vende = Agent.create(`vende-${sello}@${CASA}`, `https://${CASA}`);
const ana = Agent.create(`ana-${sello}@${BETA}`, `https://${BETA}`);
log('2a. nico registrado', (await nico.register({ invite: inv1 })).registered_via);
log('2b. vende registrado (buzón stamp precio 100)', (await vende.register({ invite: inv2, inbox: { policy: 'stamp', price: 100 } })).registered_via);
log('2c. ana registrada en beta', (await ana.register({ invite: inv3 })).registered_via);
log('2d. saldo de bienvenida de nico', await nico.balance());

// 3. Correo cifrado entre casas (beta -> casa), resuelto por well-known público
const saludo = await ana.send({ to: nico.address, body: { hola: 'desde beta' }, type: 'task' });
const m = await nico.waitFor((e) => e.id === saludo.id, { timeoutMs: 60_000, everyMs: 1500 });
log('3. sobre cifrado de ana llegó a nico', { cifrado: !!m.envelope.encrypted, relay: m.relay_verified });
const abierto = await nico.open(m.envelope);
log('3b. contenido', abierto.content.body);
await nico.ack(saludo.id);

// 4. El Libro federado: nico (casa) cotiza; ana (beta) acepta y paga EN LA CASA DE NICO
//    (una foránea tiene cuenta ahí sin registrarse: su identidad ya viene probada)
const topup = await fetch(`https://${CASA}/libro/topup`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${T1}` }, body: JSON.stringify({ account: ana.address, amount: 1000, concept: 'carga para la demo' }) });
log('4a. carga admin a la cuenta foránea de ana', (await topup.json()).lines);
const q = await nico.quote({ to: ana.address, contract: 'spot', price: 400, concept: `informe premium ${sello}`, house: CASA });
const qm = await ana.waitFor((e) => e.id === q.id, { timeoutMs: 60_000, everyMs: 1500 });
const cot = (await ana.open(qm.envelope)).content.body;
log('4b. cotización cifrada recibida en beta', { de: cot.seller, precio: cot.price, casa: cot.house });
const acc = await ana.accept(cot);
const recibo = await ana.awaitReceipt(acc.id, { timeoutMs: 90_000 });
log('4c. recibo del Libro (tres firmas: cotización, aceptación, casa)', {
  estado: recibo.receipt.contract.state,
  asiento_n: recibo.receipt.asiento.n,
  cot_hash: recibo.receipt.cotizacion_sha256.slice(0, 12),
  op_hash: recibo.receipt.op_sha256.slice(0, 12),
});
await ana.ack(recibo.envelope.id); await ana.ack(qm.envelope.id);
log('4d. saldos tras el spot', { ana: (await ana.balance(CASA)).balance, nico: (await nico.balance()).balance });

// 5. Estampilla: escribirle al buzón pagado de vende cuesta 100 tok, y los cobra vende
const carta = await ana.send({ to: vende.address, body: 'te escribo pagando' });
await new Promise((r) => setTimeout(r, 8000));
const vm = await vende.waitFor((e) => e.id === carta.id, { timeoutMs: 60_000, everyMs: 1500 });
log('5. estampilla cobrada al aceptar', { stamp_asiento: vm.stamp, saldo_vende: (await vende.balance()).balance });

// 6. Índice global: ambas casas se listan y una búsqueda federada encuentra a ana desde afuera
for (const d of [CASA, BETA]) {
  const r = await fetch(`https://${CASA}/index/houses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: d }) });
  log(`6a. casa listada en el índice: ${d}`, (await r.json()).agents ?? (r.status));
}
const hallazgo = await ana.search(CASA, { q: `ana-${sello}` });
log('6b. búsqueda federada firma del índice', { index: hallazgo.index, total: hallazgo.total, hit: hallazgo.agents[0]?.address, casa_origen: hallazgo.agents[0]?._house });

console.log('\nE2E COMPLETO');
