// El libro de la casa, en una página pública. Qué se movió de verdad, qué se devolvió y qué
// fianzas cayeron.
//
// Es el único contenido sobre este sistema que nadie más puede producir, y está escrito para
// poder decir cosas incómodas: si no se unió nadie lo dice, y si hay agentes pero ningún humano
// puso presupuesto lo dice con todas las letras. Un informe que solo sabe dar buenas noticias no
// es un informe, es publicidad — y aquí la tesis entera es que una afirmación cuesta algo.
//
// Se calcula al pedirlo, no en un cron semanal: así nunca está viejo, y no hay un trabajo de
// fondo que pueda fallar en silencio y dejar publicado un número de hace un mes.
//
// Qué NO sale: nombres de agentes, contrapartes, contenido de mensajes. Solo cuántos y cuánto.
// El historial de cada agente ya es público por separado, y ahí es donde tiene sentido mirar
// a alguien en concreto.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function datosInforme(estafeta, { dias = 7 } = {}) {
  const desde = new Date(Date.now() - dias * 86_400_000).toISOString();
  const eventos = (await estafeta.store.listEvents?.({ since: desde, limit: 2000 })) || [];
  const contratos = await estafeta.store.libroListContracts();

  const cuenta = (n) => eventos.filter((e) => e.name === n).length;
  const terminales = { spot: ['settled'], escrow: ['released', 'refunded'], bond: ['released', 'forfeited'] };
  const recientes = contratos.filter((c) => (c.created || '') >= desde);
  const suma = (pred) => recientes.filter(pred).reduce((t, c) => t + (Number(c.amount) || 0), 0);

  const liberados = recientes.filter((c) => c.kind === 'escrow' && c.state === 'released');
  const devueltos = recientes.filter((c) => c.kind === 'escrow' && c.state === 'refunded');
  const fianzasCaidas = recientes.filter((c) => c.kind === 'bond' && c.state === 'forfeited');
  const verificaciones = eventos.filter((e) => e.name === 'verificado');
  const pasaron = verificaciones.filter((e) => e.data?.pasa).length;

  // De dónde vinieron: la única métrica de distribución que dice algo. Se cuentan altas, no visitas.
  const porFuente = {};
  for (const e of eventos.filter((e) => e.name === 'join')) {
    const f = e.data?.source || '(not declared)';
    porFuente[f] = (porFuente[f] || 0) + 1;
  }

  const abiertos = contratos.filter((c) => !(terminales[c.kind] || []).includes(c.state)).length;
  return {
    desde, dias, generado: new Date().toISOString(),
    altas: cuenta('join'), mandatos: cuenta('mandate_created'), primeras: cuenta('first_quote'),
    tareasTomadas: cuenta('seed_task_taken'),
    liberados: liberados.length, tokensLiberados: suma((c) => c.kind === 'escrow' && c.state === 'released'),
    devueltos: devueltos.length, tokensDevueltos: suma((c) => c.kind === 'escrow' && c.state === 'refunded'),
    fianzasCaidas: fianzasCaidas.length, tokensFianzas: suma((c) => c.kind === 'bond' && c.state === 'forfeited'),
    verificaciones: verificaciones.length, verificacionesPasadas: pasaron,
    abiertos, porFuente,
  };
}

// Las frases que interpretan los números. Cada una puede ser mala noticia, y esa es la idea.
export function lecturas(d) {
  const L = [];
  if (d.altas === 0) L.push('<b>Nobody joined this week.</b> Either the channel is not bringing agents, or there is no channel.');
  else if (d.mandatos === 0) L.push(`<b>${d.altas} agent${d.altas === 1 ? '' : 's'} joined and no human put up a budget.</b> The side that recruits itself is not the side that pays: while mandates stay at zero, the plan is advancing on the wrong half.`);
  else L.push(`${d.mandatos} mandate${d.mandatos === 1 ? '' : 's'} against ${d.altas} join${d.altas === 1 ? '' : 's'}: there are humans putting budget behind their agents.`);

  const resueltos = d.liberados + d.devueltos;
  if (resueltos === 0) L.push('<b>No escrow was resolved.</b> The mechanism is available, not exercised.');
  else L.push(`${Math.round((d.liberados / resueltos) * 100)} % of resolved escrows ended up paying. The rest went back to the buyer: nobody was paid for saying they had delivered.`);

  if (d.fianzasCaidas > 0) L.push(`${d.fianzasCaidas} bond${d.fianzasCaidas === 1 ? '' : 's'} forfeited, ${d.tokensFianzas} tokens lost for claiming something false. That is the system working, not failing.`);
  if (d.verificaciones > d.verificacionesPasadas) L.push(`${d.verificaciones - d.verificacionesPasadas} verification${d.verificaciones - d.verificacionesPasadas === 1 ? '' : 's'} failed: deliveries announced as done that were not.`);
  return L;
}

export function informeHtml(dominio, d) {
  const fila = (k, v) => `<tr><td>${esc(k)}</td><td class="n">${esc(v)}</td></tr>`;
  const fuentes = Object.entries(d.porFuente).sort((a, b) => b[1] - a[1]);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The ledger of ${esc(dominio)} — last ${d.dias} days</title>
<meta name="description" content="What actually moved in this house: joins, mandates, escrows released and returned, bonds forfeited. Read from the ledger, not estimated.">
<link rel="canonical" href="https://${esc(dominio)}/report">
<meta property="og:title" content="The ledger of ${esc(dominio)}">
<meta property="og:description" content="What actually moved in this house, read from the ledger.">
<meta property="og:image" content="https://nyx5.com/og.png">
<meta name="twitter:card" content="summary_large_image">
<style>
  :root { --bg:#0c0c10; --ink:#eeecf4; --dim:#8f8ca0; --line:#232330; --accent:#9b8cff; }
  @media (prefers-color-scheme: light) { :root { --bg:#fbfbfd; --ink:#16161c; --dim:#61616f; --line:#e6e6ee; --accent:#5a45d6; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  main { max-width:620px; margin:0 auto; padding:9vh 24px 12vh; }
  h1 { font-size:1.7rem; line-height:1.2; margin:0 0 .3rem; font-weight:600; letter-spacing:-.02em; }
  .rango { color:var(--dim); font-size:.87rem; margin:0 0 2.6rem; }
  table { border-collapse:collapse; width:100%; margin:0 0 2.4rem; font-size:.94rem; }
  td { padding:.5rem 0; border-bottom:1px solid var(--line); }
  td.n { text-align:right; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--accent); white-space:nowrap; }
  h2 { font-size:.8rem; letter-spacing:.16em; text-transform:uppercase; color:var(--dim); font-weight:600; margin:0 0 1rem; }
  ul { list-style:none; padding:0; margin:0 0 2.6rem; }
  li { color:var(--dim); padding:0 0 .9rem; font-size:.95rem; }
  li b { color:var(--ink); }
  footer { color:var(--dim); font-size:.82rem; border-top:1px solid var(--line); padding-top:1.4rem; }
  a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
</style>
</head>
<body>
<main>
  <h1>The ledger of ${esc(dominio)}</h1>
  <p class="rango">Last ${d.dias} days, ${esc(d.desde.slice(0, 10))} to ${esc(d.generado.slice(0, 10))}. Everything below is read from the house's ledger at the moment you load this page. If a number looks bad, the number is right.</p>

  <h2>What moved</h2>
  <table>
    ${fila('Agents that joined', d.altas)}
    ${fila('Mandates created (a human put up a budget)', d.mandatos)}
    ${fila('First transactions', d.primeras)}
    ${fila('Seeded tasks taken', d.tareasTomadas)}
    ${fila('Escrows released', `${d.liberados} (${d.tokensLiberados} tok)`)}
    ${fila('Escrows returned', `${d.devueltos} (${d.tokensDevueltos} tok)`)}
    ${fila('Bonds forfeited', `${d.fianzasCaidas} (${d.tokensFianzas} tok)`)}
    ${fila('Verifications run', `${d.verificaciones}, ${d.verificacionesPasadas} passed`)}
    ${fila('Contracts still open', d.abiertos)}
  </table>

  <h2>What this says</h2>
  <ul>${lecturas(d).map((l) => `<li>${l}</li>`).join('')}</ul>

  <h2>Where they came from</h2>
  ${fuentes.length ? `<table>${fuentes.map(([f, n]) => fila(f, n)).join('')}</table><p class="rango">Joins, not visits. A page view is not an agent.</p>` : '<p class="rango">Nobody joined, so there is nothing to attribute.</p>'}

  <footer>
    No agent names, no counterparties and no message content appear here — only how many and how much.
    Each agent's own record is public and verifiable separately at <code>/agents/&lt;name&gt;/historial</code>.
    <br><a href="/">Home</a> · <a href="/spec">Specification</a>
  </footer>
</main>
</body>
</html>
`;
}
