// node --test test/
// verifica@: el evaluador de referencia. Tres pruebas deterministas atadas a la liberación
// del escrow. Lo que se prueba aquí es que el dinero se mueve por lo que la prueba devolvió,
// nunca por lo que alguien afirmó — y que cuando la prueba no puede correr, NADIE decide.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Estafeta } from '../src/correo/estafeta.js';
import { join } from '../src/correo/unirse.js';
import { correrPrueba, veredicto, pruebasDe, pruebasDisponibles } from '../src/libro/verifica.js';
import { sha256hex } from '../src/nucleo/crypto.js';

const P = 4161;
const hosts = { 'v.test': { url: `http://127.0.0.1:${P}` } };
let tmp, casa;

// Un servidor de mentira que responde lo que se le pida: es el "mundo" que la prueba mira.
let mundo, mundoPort, estado = 200, cuerpo = 'ok';
const url = (p = '/health') => `http://127.0.0.1:${mundoPort}${p}`;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-verifica-'));
  mundo = http.createServer((req, res) => { res.writeHead(estado, { 'content-type': 'text/plain' }); res.end(cuerpo); });
  await new Promise((r) => mundo.listen(0, '127.0.0.1', r));
  mundoPort = mundo.address().port;
  casa = new Estafeta({
    domain: 'v.test', port: P, dataDir: path.join(tmp, 'v.test'), adminToken: 't', hosts,
    workerIntervalMs: 100, policy: { registration: 'open', registrations_per_minute: 200 },
    libro: { welcome: 1000, feeBps: 1000 }, verifica: { enabled: true }, log: () => {},
  });
  await casa.start();
});
after(async () => { await casa.stop(); await new Promise((r) => mundo.close(r)); });

// La prueba pura, sin protocolo alrededor.
test('http_status: pasa con el código esperado y falla con otro, diciendo cuál vio', async () => {
  const ok = await correrPrueba({ type: 'http_status', url: 'https://ejemplo.invalid/x' }, {
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(ok.pasa, true);
  const mal = await correrPrueba({ type: 'http_status', url: 'https://ejemplo.invalid/x' }, {
    fetchImpl: async () => ({ status: 500 }),
  });
  assert.equal(mal.pasa, false);
  assert.match(mal.razon, /responded 500, expected 200/g);
  // http, no https: no se verifica contra un canal que cualquiera puede alterar.
  const inseguro = await correrPrueba({ type: 'http_status', url: 'http://ejemplo.invalid/x' });
  assert.equal(inseguro.pasa, false);
  assert.match(inseguro.razon, /https/);
});

test('sha256: compara el hash del contenido entregado y no acepta un expect mal formado', async () => {
  const texto = 'el informe entregado';
  const bien = await correrPrueba({ type: 'sha256', expect: sha256hex(texto) }, { entregado: texto });
  assert.equal(bien.pasa, true);
  const mal = await correrPrueba({ type: 'sha256', expect: sha256hex('otra cosa') }, { entregado: texto });
  assert.equal(mal.pasa, false);
  assert.match(mal.razon, /el hash no coincide/);
  const basura = await correrPrueba({ type: 'sha256', expect: 'no-es-un-hash' }, { entregado: texto });
  assert.equal(basura.pasa, false);
  assert.match(basura.razon, /sha256 en hexadecimal/);
});

test('sha256 sin url: compara el hash que el agente DECLARÓ al entregar', async () => {
  const esperado = sha256hex('el resultado correcto');
  const bien = await correrPrueba({ type: 'sha256', expect: esperado }, { entregadoSha256: esperado });
  assert.equal(bien.pasa, true);
  assert.equal(bien.evidencia.fuente, 'evidence_sha256');
  const mal = await correrPrueba({ type: 'sha256', expect: esperado }, { entregadoSha256: sha256hex('otra cosa') });
  assert.equal(mal.pasa, false);
  assert.match(mal.razon, /no es el esperado/);
  // Entregó sin declarar hash: no se puede verificar, así que NO se decide (ni cobra ni pierde).
  const sinNada = await correrPrueba({ type: 'sha256', expect: esperado }, {});
  assert.equal(sinNada.pasa, false);
  assert.equal(sinNada.indeciso, true, 'sin evidencia no se castiga a nadie');
});

test('exit_0: corre un comando real, exige argv y no acepta una línea de shell', async () => {
  assert.ok(pruebasDisponibles().includes('exit_0'), 'en Node sí hay shell');
  assert.ok(pruebasDisponibles().includes('json_path'), 'json_path corre en cualquier runtime');
  const ok = await correrPrueba({ type: 'exit_0', argv: ['node', '-e', 'process.exit(0)'] });
  assert.equal(ok.pasa, true);
  const mal = await correrPrueba({ type: 'exit_0', argv: ['node', '-e', 'process.exit(3)'] });
  assert.equal(mal.pasa, false);
  assert.match(mal.razon, /salió con 3/);
  // Una línea de shell abriría inyección de comandos: se rechaza de plano.
  const shell = await correrPrueba({ type: 'exit_0', argv: 'echo hola && rm -rf /' });
  assert.equal(shell.pasa, false);
  assert.match(shell.razon, /no se acepta una línea de shell/);
});

test('json_path: compara un campo por igualdad estricta y dice qué vio', async () => {
  const doc = { status: 'ready', version: 3, data: [{ id: 'a7' }], nested: { flag: false }, obj: { b: 2, a: 1 } };
  const con = (p) => correrPrueba(p, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(doc) }) });

  assert.equal((await con({ type: 'json_path', url: 'https://x/', path: 'status', expect: 'ready' })).pasa, true);
  assert.equal((await con({ type: 'json_path', url: 'https://x/', path: 'version', expect: 3 })).pasa, true);
  assert.equal((await con({ type: 'json_path', url: 'https://x/', path: 'data.0.id', expect: 'a7' })).pasa, true);
  // false y 0 son valores, no ausencias: comparar por igualdad estricta importa.
  assert.equal((await con({ type: 'json_path', url: 'https://x/', path: 'nested.flag', expect: false })).pasa, true);
  assert.equal((await con({ type: 'json_path', url: 'https://x/', path: 'nested.flag', expect: true })).pasa, false);
  // El orden de las claves no cambia el valor.
  assert.equal((await con({ type: 'json_path', url: 'https://x/', path: 'obj', expect: { a: 1, b: 2 } })).pasa, true);
  // Un campo que no existe falla y lo dice, en vez de pasar por ser "vacío == vacío".
  const falta = await con({ type: 'json_path', url: 'https://x/', path: 'no.existe', expect: 'algo' });
  assert.equal(falta.pasa, false);
  assert.match(falta.razon, /expected/);
  // Un expect ausente no puede colarse comparando null con null.
  assert.match((await con({ type: 'json_path', url: 'https://x/', path: 'status' })).razon, /needs an expect/);
  assert.match((await con({ type: 'json_path', url: 'https://x/' })).razon, /needs a path/);
  assert.match((await con({ type: 'json_path', url: 'http://x/', path: 'a', expect: 1 })).razon, /https/);

  // No es JSON: no se decide a ciegas.
  const malo = await correrPrueba({ type: 'json_path', url: 'https://x/', path: 'a', expect: 1 },
    { fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>' }) });
  assert.equal(malo.pasa, false);
  assert.match(malo.razon, /did not return valid JSON/);
  // Y una red caída deja indeciso, como las demás.
  const caida = await correrPrueba({ type: 'json_path', url: 'https://x/', path: 'a', expect: 1 },
    { fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
  assert.equal(caida.indeciso, true);
});

test('veredicto: exige que TODAS pasen, y una prueba que no pudo correr deja indeciso', async () => {
  const t = 'x';
  const todas = await veredicto([{ type: 'sha256', expect: sha256hex(t) }, { type: 'exit_0', argv: ['node', '-e', ''] }], { entregado: t });
  assert.equal(todas.pasa, true);
  const una = await veredicto([{ type: 'sha256', expect: sha256hex(t) }, { type: 'exit_0', argv: ['node', '-e', 'process.exit(1)'] }], { entregado: t });
  assert.equal(una.pasa, false);
  // Red caída: no es "la afirmación es falsa", es "no se pudo verificar".
  const caida = await veredicto([{ type: 'http_status', url: 'https://ejemplo.invalid/x' }], {
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
  });
  assert.equal(caida.indeciso, true);
  assert.equal(caida.pasa, false);
  assert.match(caida.razon, /no se pudo verificar/);
  // Sin pruebas declaradas no hay nada que decidir.
  assert.equal((await veredicto([])).indeciso, true);
  assert.equal(pruebasDe({ terms: {} }), null);
  assert.deepEqual(pruebasDe({ terms: { verify: { type: 'http_status', url: 'https://x/' } } }).length, 1);
});

test('verifica@ existe como agente de sistema y declara qué puede correr', async () => {
  const card = await casa.agentCard('verifica');
  assert.ok(card, 'la casa levanta verifica@ sola');
  assert.deepEqual(card.capabilities.verifica.pruebas, pruebasDisponibles());
  // Es de sistema: nadie más puede tomar ese nombre.
  const usurpador = await fetch(`http://127.0.0.1:${P}/agents`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ local: 'verifica', sig: 'x' }),
  });
  assert.equal(usurpador.status, 409);
});

test('el escrow se libera SOLO si la prueba pasa, y el recibo dice por qué', async () => {
  const vendedor = await join({ house: 'v.test', hosts, name: 'obrero' });
  const comprador = await join({ house: 'v.test', hosts, name: 'jefe' });
  estado = 200;

  const saldoAntes = (await vendedor._agente.balance()).balance;
  await vendedor._agente.quote({
    to: comprador.address, contract: 'escrow', price: 200, concept: 'levantar el endpoint',
    arbiter: `verifica@v.test`,
    terms: { acceptance: 'el endpoint responde 200', verify: { type: 'http_status', url: url('/health').replace('http://', 'https://') } },
  });
  const sobre = await comprador._agente.waitFor((e) => e.from === vendedor.address && e.type === 'message', { timeoutMs: 5000 });
  const cot = (await comprador._agente.open(sobre.envelope)).content.body;
  const aceptada = await comprador._agente.accept(cot);
  await comprador._agente.awaitReceipt(aceptada.id);

  const contrato = (await comprador._agente.balance()).contracts.find((c) => c.kind === 'escrow' && c.amount === 200);
  assert.equal(contrato.state, 'held');
  const entrega = await vendedor._agente.deliver('v.test', contrato.id, { note: 'listo' });
  await vendedor._agente.awaitReceipt(entrega.id);

  // Nadie libera a mano: el cron corre la prueba y decide. La URL es https y no resuelve
  // desde el edge de mentira, así que la prueba se sustituye por el mundo local.
  casa.fetch = async (u, o) => fetch(String(u).replace('https://127.0.0.1', 'http://127.0.0.1'), o);
  await casa.tick();
  await vendedor._agente.waitFor((e) => e.thread === contrato.id && e.from === 'libro@v.test', { timeoutMs: 5000 });

  const fin = await vendedor._agente.contract('v.test', contrato.id);
  assert.equal(fin.state, 'released', 'la prueba pasó, el escrow se liberó');
  assert.equal((await vendedor._agente.balance()).balance, saldoAntes + 180, '200 menos 10% de la casa');
  const paso = fin.history.find((h) => h.op === 'release');
  assert.equal(paso.by, 'verifica@v.test', 'quien liberó fue el verificador, no una parte');

  // Y queda en el historial como entrega aceptada: reputación = el libro.
  assert.equal((await vendedor._agente.historial()).resumen.entregas, 1);
});

test('si la prueba falla, el escrow se DEVUELVE y nadie cobra por haber dicho que entregó', async () => {
  const vendedor = await join({ house: 'v.test', hosts, name: 'mentiroso' });
  const comprador = await join({ house: 'v.test', hosts, name: 'clienta' });
  estado = 500; // el endpoint está caído, aunque el vendedor diga lo contrario

  const antesV = (await vendedor._agente.balance()).balance;
  const antesC = (await comprador._agente.balance()).balance;
  await vendedor._agente.quote({
    to: comprador.address, contract: 'escrow', price: 150, concept: 'arreglar el sitio',
    arbiter: `verifica@v.test`,
    terms: { acceptance: 'el endpoint responde 200', verify: { type: 'http_status', url: url('/health').replace('http://', 'https://') } },
  });
  const sobre = await comprador._agente.waitFor((e) => e.from === vendedor.address && e.type === 'message', { timeoutMs: 5000 });
  const aceptada = await comprador._agente.accept((await comprador._agente.open(sobre.envelope)).content.body);
  await comprador._agente.awaitReceipt(aceptada.id);
  const contrato = (await comprador._agente.balance()).contracts.find((c) => c.kind === 'escrow' && c.amount === 150);

  // El vendedor AFIRMA que entregó. Afirmar sigue siendo gratis; cobrar, no.
  const entrega = await vendedor._agente.deliver('v.test', contrato.id, { note: 'desplegado y verificado' });
  await vendedor._agente.awaitReceipt(entrega.id);

  casa.fetch = async (u, o) => fetch(String(u).replace('https://127.0.0.1', 'http://127.0.0.1'), o);
  await casa.tick();
  await comprador._agente.waitFor((e) => e.thread === contrato.id && e.from === 'libro@v.test', { timeoutMs: 5000 });

  const fin = await comprador._agente.contract('v.test', contrato.id);
  assert.equal(fin.state, 'refunded');
  assert.equal((await vendedor._agente.balance()).balance, antesV, 'el que afirmó en falso no cobró un token');
  assert.equal((await comprador._agente.balance()).balance, antesC, 'y el comprador recuperó todo, sin fee');
  const paso = fin.history.find((h) => h.op === 'refund');
  assert.match(paso.note, /responded 500, expected 200/g, 'la razón queda escrita en el contrato');

  const h = await vendedor._agente.historial();
  assert.equal(h.resumen.entregas_falladas, 1);
  assert.equal(h.resumen.cumplimiento, 0);
});

test('sin árbitro verifica@ o sin prueba declarada, la casa no toca el escrow', async () => {
  const vendedor = await join({ house: 'v.test', hosts, name: 'ajeno' });
  const comprador = await join({ house: 'v.test', hosts, name: 'ajena' });
  estado = 500;
  // Mismo contrato, pero sin nombrar árbitro: es un trato entre dos, la casa no se mete.
  await vendedor._agente.quote({
    to: comprador.address, contract: 'escrow', price: 90, concept: 'sin árbitro',
    terms: { verify: { type: 'http_status', url: url('/health').replace('http://', 'https://') } },
  });
  const sobre = await comprador._agente.waitFor((e) => e.from === vendedor.address && e.type === 'message', { timeoutMs: 5000 });
  const aceptada = await comprador._agente.accept((await comprador._agente.open(sobre.envelope)).content.body);
  await comprador._agente.awaitReceipt(aceptada.id);
  const contrato = (await comprador._agente.balance()).contracts.find((c) => c.kind === 'escrow' && c.amount === 90);
  const entrega = await vendedor._agente.deliver('v.test', contrato.id, {});
  await vendedor._agente.awaitReceipt(entrega.id);

  casa.fetch = async (u, o) => fetch(String(u).replace('https://127.0.0.1', 'http://127.0.0.1'), o);
  await casa.tick();
  await casa.tick();
  assert.equal((await comprador._agente.contract('v.test', contrato.id)).state, 'delivered', 'la casa no decide donde no la llamaron');
});

test('el ciclo completo con sha256: se cobra por el hash correcto, no por afirmar', async () => {
  const bueno = await join({ house: 'v.test', hosts, name: 'aplicado' });
  const malo = await join({ house: 'v.test', hosts, name: 'flojo' });
  const secreto = 'nyx5';
  const esperado = sha256hex(secreto);

  for (const [agente, entrega, resultado] of [[bueno, esperado, 'released'], [malo, sha256hex('cualquier cosa'), 'refunded']]) {
    await agente._agente.quote({
      to: agente.address === bueno.address ? malo.address : bueno.address,
      contract: 'escrow', price: 60, concept: `hashea "${secreto}"`, arbiter: 'verifica@v.test',
      terms: { acceptance: `sha256 de "${secreto}"`, verify: { type: 'sha256', expect: esperado } },
    });
  }
  // El comprador de cada trato acepta.
  for (const [vendedor, comprador] of [[bueno, malo], [malo, bueno]]) {
    const s = await comprador._agente.waitFor((e) => e.from === vendedor.address && e.type === 'message', { timeoutMs: 5000 });
    const q = (await comprador._agente.open(s.envelope)).content.body;
    await comprador._agente.awaitReceipt((await comprador._agente.accept(q)).id);
  }
  const contratoDe = async (a) => (await a._agente.balance()).contracts.find((c) => c.kind === 'escrow' && c.amount === 60 && c.seller === a.address);
  for (const [agente, hash] of [[bueno, esperado], [malo, sha256hex('cualquier cosa')]]) {
    const c = await contratoDe(agente);
    await agente._agente.awaitReceipt((await agente._agente.deliver('v.test', c.id, { evidence_sha256: hash })).id);
  }
  await casa.tick();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await bueno._agente.contract('v.test', (await contratoDe(bueno)).id)).state, 'released');
  assert.equal((await malo._agente.contract('v.test', (await contratoDe(malo)).id)).state, 'refunded');
});

// La tarjeta de un agente de sistema describe lo que la casa puede hacer HOY. Nació de un
// defecto real: al añadir json_path, verifica@ siguió anunciando las tres pruebas viejas porque
// la tarjeta se escribió una sola vez. Un agente que la lee para decidir si puede pactar una
// verificación habría creído que la prueba no existe.
test('la tarjeta de verifica@ se reescribe si cambian las pruebas que la casa puede correr', async () => {
  const P2 = 4162;
  const dir = path.join(tmp, 'refresco');
  const mk = () => new Estafeta({
    domain: 'r.test', port: P2, dataDir: dir, adminToken: 't', hosts: { 'r.test': { url: `http://127.0.0.1:${P2}` } },
    workerIntervalMs: 5000, policy: { registration: 'open' }, log: () => {},
  });
  const uno = mk();
  await uno.start();
  assert.deepEqual((await uno.agentCard('verifica')).capabilities.verifica.pruebas, pruebasDisponibles());
  // Se ensucia la tarjeta a mano, como si la hubiera escrito una versión vieja de la casa.
  const rec = await uno.store.getAgent('verifica');
  rec.capabilities.verifica.pruebas = ['http_status'];
  await uno.store.putAgent('verifica', rec);
  assert.deepEqual((await uno.agentCard('verifica')).capabilities.verifica.pruebas, ['http_status']);
  await uno.stop();

  // Al levantar de nuevo, la casa corrige lo que anuncia.
  const dos = mk();
  await dos.start();
  try {
    assert.deepEqual((await dos.agentCard('verifica')).capabilities.verifica.pruebas, pruebasDisponibles(),
      'la casa debe corregir la tarjeta al arrancar');
  } finally { await dos.stop(); }
});

// Un bloque mal cerrado dejó el alta de tareas@ ANIDADA dentro de la de verifica@: el mostrador
// solo se creaba si el verificador no existía. Pasó desapercibido porque en un arranque limpio
// ambos se crean a la vez. Cada agente de sistema tiene que levantarse por su cuenta.
test('cada agente de sistema se levanta solo, sin depender de que falte otro', async () => {
  const P2 = 4163;
  const dir = path.join(tmp, 'sistema');
  const cat = [{ id: 'x', concept: 'algo', price: 10, verify: { type: 'http_status', url: 'https://x.invalid/' } }];
  const mk = () => new Estafeta({
    domain: 's.test', port: P2, dataDir: dir, adminToken: 't', hosts: { 's.test': { url: `http://127.0.0.1:${P2}` } },
    workerIntervalMs: 5000, policy: { registration: 'open' }, tareas: { catalogo: cat }, log: () => {},
  });
  // Primer arranque: están los cuatro.
  const uno = mk(); await uno.start();
  for (const a of ['postmaster', 'libro', 'verifica', 'tareas']) assert.ok(await uno.agentCard(a), `falta ${a}@ en el primer arranque`);
  await uno.stop();

  // Segundo arranque con verifica@ YA presente: tareas@ debe seguir existiendo igual.
  const dos = mk(); await dos.start();
  try {
    for (const a of ['postmaster', 'libro', 'verifica', 'tareas']) assert.ok(await dos.agentCard(a), `${a}@ desapareció al rearrancar`);
  } finally { await dos.stop(); }
});

// La casa no puede anunciar lo que no puede hacer. Con nodejs_compat, Workers expone `process`
// pero no puede lanzar un proceso: mirar `process.versions.node` hacía que el edge declarara
// exit_0 y luego fallara al pedirla. La detección tiene que INTENTAR cargar el módulo.
test('la detección de shell prueba a cargar el módulo, no a mirar una variable', async () => {
  const src = fs.readFileSync(new URL('../src/libro/verifica.js', import.meta.url), 'utf8');
  assert.match(src, /await import\('node:child_process'\)/, 'la detección debe intentar el import');
  assert.ok(!/conShell = typeof process/.test(src), 'mirar process.versions.node no prueba que haya shell');
  // Y tiene que descartar el edge explícitamente: allí el import funciona pero no hay proceso.
  assert.match(src, /Cloudflare-Workers/, 'la detección debe reconocer el runtime del edge');
  // Y en Node, donde sí hay, la lista completa está disponible.
  assert.deepEqual(pruebasDisponibles(), ['http_status', 'sha256', 'json_path', 'exit_0']);
});

// Un 52x lo emite la infraestructura que hay delante, no el servidor que se comprueba. Nació de
// un caso real: una tarea sembrada apuntaba a la propia casa, el Worker no puede pedirse a sí
// mismo (trampa conocida de este proyecto), el borde devolvió 522 y el trabajo del agente se
// devolvió como si hubiera mentido. Castigar por una red que no controla destruye el sistema.
test('un error del borde deja indeciso, no declara falsa la afirmación', async () => {
  for (const code of [520, 521, 522, 523, 525, 527]) {
    const r = await correrPrueba({ type: 'http_status', url: 'https://x.example/' }, { fetchImpl: async () => ({ status: code }) });
    assert.equal(r.indeciso, true, `${code} debería dejar indeciso`);
    assert.equal(r.pasa, false);
    assert.match(r.razon, /could not reach/);
  }
  // Un 500 del servidor comprobado SÍ es un fallo suyo: ahí la afirmación es falsa.
  const quinientos = await correrPrueba({ type: 'http_status', url: 'https://x.example/' }, { fetchImpl: async () => ({ status: 500 }) });
  assert.equal(quinientos.pasa, false);
  assert.ok(!quinientos.indeciso, 'un 500 del propio servidor sí decide');
  assert.match(quinientos.razon, /responded 500, expected 200/);
});

// Ninguna tarea sembrada puede apuntar a la casa que la verifica: el Worker no puede pedirse su
// propia URL pública y la comprobación nunca podría pasar.
test('el catálogo sembrado no se verifica contra la propia casa', async () => {
  const { NYX5_TAREAS } = await import('../src/plataformas/worker.js');
  for (const t of NYX5_TAREAS.catalogo) {
    for (const v of (Array.isArray(t.verify) ? t.verify : [t.verify])) {
      if (!v.url) continue;
      assert.ok(!/nyx5\.com/.test(v.url), `la tarea "${t.id}" se verifica contra la propia casa (${v.url}): nunca podrá pasar`);
    }
  }
});
