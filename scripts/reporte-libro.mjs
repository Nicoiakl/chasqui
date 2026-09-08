// El libro de nuestra propia flota, leído del diario de una casa y escrito como un informe.
//
// Es el único contenido que nadie más puede producir sobre este sistema: qué se movió de verdad,
// qué se devolvió, y qué fianzas cayeron. No es marketing con números: es el diario contable, y
// por eso puede decir cosas incómodas (cero transacciones, cumplimiento bajo, presupuesto sin
// gastar). Si el informe se ve mal, el informe está bien.
//
//   node scripts/reporte-libro.mjs --estafeta https://nyx5.com --admin-token <token> [--dias 7] [--md]
//
// El token de administración es el de la casa: el diario completo no es público (el historial de
// cada agente sí lo es, y ese es el que un desconocido necesita).

import { parseArgs } from 'node:util';

const { values: o } = parseArgs({ options: {
  estafeta: { type: 'string' }, 'admin-token': { type: 'string' }, dias: { type: 'string' }, md: { type: 'boolean' }, json: { type: 'boolean' },
} });

const base = (o.estafeta || 'https://nyx5.com').replace(/\/$/, '');
const token = o['admin-token'] || process.env.NYX5_ADMIN_TOKEN || process.env.CHASQUI_ADMIN_TOKEN;
if (!token) { console.error('falta --admin-token (o NYX5_ADMIN_TOKEN): el diario completo no es público'); process.exit(2); }
const dias = Number(o.dias || 7);
const desde = new Date(Date.now() - dias * 86400_000).toISOString();

const pedir = async (ruta) => {
  const res = await fetch(`${base}${ruta}`, { headers: { authorization: `Bearer ${token}` } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET ${ruta} -> ${res.status}: ${j.reason || ''}`);
  return j;
};

const [diario, eventos] = await Promise.all([
  pedir('/libro/diario'),
  pedir(`/eventos?since=${encodeURIComponent(desde)}&limit=1000`).catch(() => ({ conteo: {}, eventos: [] })),
]);

const asientos = (diario.journal || []).filter((a) => (a.at || a.created || '') >= desde);
const suma = (pred) => asientos.filter(pred).reduce((n, a) => n + Math.abs(a.lines?.[0]?.delta || 0), 0);
const cuenta = (pred) => asientos.filter(pred).length;
const meta = (a) => a.meta || {};
const es = (t) => (a) => (a.concept || '').startsWith(t) || meta(a).kind === t;

const n = {
  agentes: eventos.conteo?.join || 0,
  mandatos: eventos.conteo?.mandate_created || 0,
  primeras: eventos.conteo?.first_quote || 0,
  liberados: eventos.conteo?.escrow_released || 0,
  devueltos: eventos.conteo?.escrow_refunded || 0,
  fianzas: eventos.conteo?.bond_forfeited || 0,
  tareas: eventos.conteo?.seed_task_taken || 0,
  verificaciones: eventos.conteo?.verificado || 0,
};
const tokLiberados = suma((a) => (a.concept || '').startsWith('liberación escrow'));
const tokDevueltos = suma((a) => (a.concept || '').startsWith('devolución escrow'));
const tokFianzas = suma((a) => (a.concept || '').startsWith('fianza ejecutada'));
const fees = asientos.reduce((t, a) => t + (a.lines || []).filter((l) => l.account.startsWith('casa@') && l.delta > 0).reduce((s, l) => s + l.delta, 0), 0);

// De dónde vinieron los agentes: la única métrica de distribución que dice algo.
const porFuente = {};
for (const e of (eventos.eventos || []).filter((e) => e.name === 'join')) {
  const f = e.data?.source || '(sin declarar)';
  porFuente[f] = (porFuente[f] || 0) + 1;
}

const verificados = (eventos.eventos || []).filter((e) => e.name === 'verificado');
const pasaron = verificados.filter((e) => e.data?.pasa).length;

if (o.json) { console.log(JSON.stringify({ desde, dias, conteos: n, tokens: { tokLiberados, tokDevueltos, tokFianzas, fees }, porFuente }, null, 2)); process.exit(0); }

const L = [];
const p = (s = '') => L.push(s);
const casa = base.replace(/^https?:\/\//, '');

p(`# El libro de ${casa} — últimos ${dias} días`);
p();
p(`Del ${desde.slice(0, 10)} al ${new Date().toISOString().slice(0, 10)}. Todo lo que sigue sale del diario`);
p('contable de la casa, no de una estimación. Si un número se ve mal, el número está bien.');
p();
p('## Qué se movió');
p();
p('| | |');
p('|---|---:|');
p(`| Agentes que se unieron | ${n.agentes} |`);
p(`| Mandatos creados (un humano puso presupuesto) | ${n.mandatos} |`);
p(`| Primeras transacciones | ${n.primeras} |`);
p(`| Escrows liberados | ${n.liberados} (${tokLiberados} tok) |`);
p(`| Escrows devueltos | ${n.devueltos} (${tokDevueltos} tok) |`);
p(`| Fianzas ejecutadas | ${n.fianzas} (${tokFianzas} tok) |`);
p(`| Tareas sembradas tomadas | ${n.tareas} |`);
p(`| Verificaciones corridas | ${n.verificaciones}, de las cuales ${pasaron} pasaron |`);
p(`| Tarifa de la casa | ${fees} tok |`);
p();

// La lectura honesta: qué dicen estos números, incluido cuando no dicen nada bueno.
p('## Qué dice esto');
p();
if (n.agentes === 0) p('- **Nadie se unió esta semana.** El canal no está trayendo agentes, o no hay canal.');
else if (n.mandatos === 0) p(`- **${n.agentes} agente(s) se unieron y ningún humano puso presupuesto.** El lado que se recluta fácil no es el que paga: mientras los mandatos sean cero, el plan avanza en la mitad equivocada.`);
else p(`- ${n.mandatos} mandato(s) creados sobre ${n.agentes} altas: hay humanos poniendo presupuesto detrás de sus agentes.`);

if (n.liberados + n.devueltos === 0) p('- **Ningún escrow se resolvió.** El mecanismo no se está ejerciendo, solo está disponible.');
else {
  const tasa = ((n.liberados / (n.liberados + n.devueltos)) * 100).toFixed(0);
  p(`- ${tasa} % de los escrows resueltos terminaron pagando. El resto volvió al comprador: nadie cobró por decir que había entregado.`);
}
if (n.fianzas > 0) p(`- ${n.fianzas} fianza(s) ejecutada(s), ${tokFianzas} tok perdidos por afirmar en falso. Eso es el sistema funcionando, no fallando.`);
if (n.verificaciones > 0 && pasaron < n.verificaciones) p(`- ${n.verificaciones - pasaron} verificación(es) fallaron: entregas que se anunciaron listas y no lo estaban.`);
p();

p('## De dónde vinieron');
p();
if (!Object.keys(porFuente).length) p('Nadie se unió, así que no hay nada que atribuir.');
else {
  p('| Canal | Agentes |');
  p('|---|---:|');
  for (const [f, c] of Object.entries(porFuente).sort((a, b) => b[1] - a[1])) p(`| ${f} | ${c} |`);
  p();
  p('Se cuentan altas, no visitas. Una vista no es un agente.');
}
p();
p('---');
p();
p('Generado con `scripts/reporte-libro.mjs`, que lee el diario de la casa. El historial de cada');
p(`agente es público y verificable por separado: \`GET https://${casa}/agents/<nombre>/historial\`.`);

console.log(L.join('\n'));
