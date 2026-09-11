// node --test test/
// El conector MCP remoto: que el Claude de un teléfono use Nyx5 sin instalar nada y sin copiar la
// llave de nadie. Nicholas lo aprobó el 10-sep-2026 con tres límites, y cada uno tiene aquí una
// prueba que falla si se rompe:
//   1. sólo mensajes: el subagente no opera el Libro, no paga estampillas y no vende;
//   2. vence y se revoca: al revocar, ningún token vuelve a servir y la llave no resucita;
//   3. la llave raíz del dueño nunca pasa por la casa: la delegación la firma él.
// Y el recorrido completo que hace Claude de verdad: descubrimiento, registro dinámico, PKCE,
// canje por form-urlencoded, refresco con rotación, y conversación en tiempo real con historial.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { signObject, b64u } from '../src/nucleo/crypto.js';

// Puerto propio de esta suite (npm test corre los archivos en paralelo). Lo cuida test/puertos.test.js.
const P = 4241;
const H = 'remoto.test';
const URL_CASA = `http://127.0.0.1:${P}`;
const hosts = { [H]: { url: URL_CASA } };
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
let tmp, casa, nico, amiga, extrano;

const s256 = (v) => b64u(createHash('sha256').update(v).digest());
const json = async (r) => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) });
const form = (ruta, datos) => fetch(`${URL_CASA}${ruta}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(datos).toString() }).then(json);
let rpcId = 0;
const mcp = (token, method, params = {}, extra = {}) => fetch(`${URL_CASA}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
  body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
}).then(json);
const herramienta = async (token, name, args = {}) => {
  const r = await mcp(token, 'tools/call', { name, arguments: args });
  assert.equal(r.status, 200, `tools/call ${name}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  const res = r.body.result;
  return { ...res, datos: (() => { try { return JSON.parse(res.content[0].text); } catch { return res.content[0].text; } })() };
};

// El recorrido que hace Claude, de punta a punta. `dueno` es el agente con la llave raíz (en la vida
// real vive en el navegador del dueño; aquí, en la prueba).
async function conectar(dueno, { allowlist = [], verificador } = {}) {
  const reg = await fetch(`${URL_CASA}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' }) }).then(json);
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const cliente = reg.body;
  const code_verifier = verificador || b64u(randomBytes(32));
  const pedido = { response_type: 'code', client_id: cliente.client_id, redirect_uri: CALLBACK, state: 'st4te', code_challenge: s256(code_verifier), code_challenge_method: 'S256', resource: `${URL_CASA}/mcp` };
  const pagina = await fetch(`${URL_CASA}/oauth/authorize?${new URLSearchParams(pedido)}`);
  assert.equal(pagina.status, 200);
  const html = await pagina.text();
  assert.match(html, /window\.NYX5_OAUTH=/, 'la pantalla de consentimiento recibe la solicitud ya validada');
  assert.match(html, /claude\.ai/, 'muestra a dónde vuelve el permiso');
  const prep = await dueno._call('POST', '/oauth/prepare', pedido);
  assert.equal(prep.address, `claude.${dueno.local}@${H}`);
  assert.deepEqual(prep.scope, { messages_only: true });
  const delegation = signObject({ by: dueno.address, address: prep.address, sig: prep.sig, scope: prep.scope, valid_until: prep.valid_until, issued: new Date().toISOString() }, dueno.keys);
  const ok = await dueno._call('POST', '/oauth/approve', { ...pedido, delegation, allowlist });
  const vuelta = new URL(ok.redirect);
  assert.equal(`${vuelta.origin}${vuelta.pathname}`, CALLBACK);
  assert.equal(vuelta.searchParams.get('state'), 'st4te');
  const code = vuelta.searchParams.get('code');
  const tok = await form('/oauth/token', { grant_type: 'authorization_code', code, code_verifier, client_id: cliente.client_id, redirect_uri: CALLBACK, resource: `${URL_CASA}/mcp` });
  assert.equal(tok.status, 200, JSON.stringify(tok.body));
  return { cliente, code, code_verifier, pedido, sub: prep.address, ...tok.body };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx5-remoto-'));
  casa = await new Estafeta({
    domain: H, port: P, dataDir: path.join(tmp, H), adminToken: 't', hosts, workerIntervalMs: 100,
    libro: { welcome: 0, feeBps: 0 }, log: () => {},
    remoto: { enabled: true, vaultKey: randomBytes(32).toString('base64') },
  }).start();
  nico = Agent.create(`nico@${H}`, URL_CASA, { hosts });
  amiga = Agent.create(`amiga@${H}`, URL_CASA, { hosts });
  extrano = Agent.create(`extrano@${H}`, URL_CASA, { hosts });
  for (const a of [nico, amiga, extrano]) await a.register({ adminToken: 't' });
});
after(async () => { await casa?.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('descubrimiento: /mcp sin token responde 401 con dónde leer los metadatos, y los metadatos dicen la verdad', async () => {
  const r = await mcp(null, 'initialize', { protocolVersion: '2025-06-18' });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /^Bearer resource_metadata="http:\/\/127\.0\.0\.1:4241\/\.well-known\/oauth-protected-resource\/mcp"/);
  for (const ruta of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const prm = await fetch(`${URL_CASA}${ruta}`).then(json);
    assert.equal(prm.status, 200);
    // Claude exige que `resource` sea EXACTAMENTE la URL que el usuario pega, con su ruta.
    assert.equal(prm.body.resource, `${URL_CASA}/mcp`);
    assert.deepEqual(prm.body.authorization_servers, [URL_CASA]);
  }
  const as = await fetch(`${URL_CASA}/.well-known/oauth-authorization-server`).then(json);
  assert.equal(as.body.issuer, URL_CASA);
  assert.deepEqual(as.body.code_challenge_methods_supported, ['S256']);
  assert.ok(as.body.token_endpoint_auth_methods_supported.includes('none'), 'Claude se registra como cliente público');
  assert.ok(as.body.registration_endpoint, 'sin registro dinámico, Claude no puede conectarse solo');
  // Un cliente MCP que corre en un navegador (el Inspector) necesita CORS en estas rutas.
  const pre = await fetch(`${URL_CASA}/mcp`, { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.match(pre.headers.get('access-control-expose-headers'), /www-authenticate/);
});

test('el recorrido completo de Claude: registro, PKCE, canje por formulario, y el conector sólo ofrece mensajería', async () => {
  const c = await conectar(nico);
  assert.equal(c.token_type, 'Bearer');
  assert.ok(c.refresh_token, 'sin refresh token Claude tendría que pedir permiso cada hora');
  const ini = await mcp(c.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '0' } });
  assert.equal(ini.status, 200);
  assert.equal(ini.body.result.protocolVersion, '2025-06-18');
  assert.match(ini.body.result.instructions, /claude\.nico@remoto\.test/);
  const notif = await fetch(`${URL_CASA}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${c.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(notif.status, 202, 'una notificación se acepta sin respuesta');
  const lista = await mcp(c.access_token, 'tools/list');
  const nombres = lista.body.result.tools.map((t) => t.name);
  for (const n of ['nyx5_send', 'nyx5_inbox', 'nyx5_wait', 'nyx5_conversation', 'nyx5_whoami']) assert.ok(nombres.includes(n), `falta ${n}`);
  for (const n of ['nyx5_libro', 'nyx5_accept', 'nyx5_quote', 'nyx5_balance', 'nyx5_tomar', 'nyx5_email']) assert.ok(!nombres.includes(n), `el conector de sólo mensajes ofrece ${n}`);
  const yo = await herramienta(c.access_token, 'nyx5_whoami');
  assert.equal(yo.datos.address, `claude.nico@${H}`);
  assert.equal(yo.datos.delegated_by, nico.address);
  assert.equal(yo.datos.scope.messages_only, true);
  // Quien le escribe a esta dirección tiene derecho a saber que la casa guarda su llave.
  assert.equal(yo.datos.custody.keys, 'house');
  const tarjeta = await casa.agentCard('claude.nico');
  assert.equal(tarjeta.custody.keys, 'house', 'la custodia se publica en la tarjeta');
});

test('conversación en tiempo real: Claude escribe, espera, y la respuesta le llega apenas se manda; el historial se lee entero', async () => {
  const c = await conectar(nico, { allowlist: [amiga.address] });
  const enviado = await herramienta(c.access_token, 'nyx5_send', { to: amiga.address, body: 'hola desde el teléfono' });
  assert.equal(enviado.datos.encrypted, true, 'la amiga publica llave de cifrado: tiene que ir cifrado, y decirlo');
  const llegado = await amiga.waitFor((e) => e.from === `claude.nico@${H}`, { timeoutMs: 5000 });
  const abierto = await amiga.open(llegado.envelope);
  assert.equal(abierto.content.body, 'hola desde el teléfono');
  // Claude se queda escuchando; la amiga contesta medio segundo después.
  const t0 = Date.now();
  const espera = herramienta(c.access_token, 'nyx5_wait', { from: amiga.address, seconds: 15 });
  setTimeout(() => amiga.reply(llegado.envelope, 'te leo').catch(() => {}), 500);
  const r = await espera;
  assert.equal(r.datos.content.body, 'te leo');
  assert.ok(Date.now() - t0 < 8000, `la respuesta tardó ${Date.now() - t0} ms: no es tiempo real`);
  // El historial trae los dos lados, y lo que Claude mismo mandó cifrado lo puede leer.
  const hist = await herramienta(c.access_token, 'nyx5_conversation', { with: amiga.address });
  const dirs = hist.datos.map((m) => m.dir);
  assert.ok(dirs.includes('out') && dirs.includes('in'), `el historial debe traer ambos lados: ${JSON.stringify(dirs)}`);
  const propio = hist.datos.find((m) => m.dir === 'out');
  assert.equal(propio.content?.body, 'hola desde el teléfono', `lo enviado cifrado debe poder leerlo quien lo mandó: ${JSON.stringify(propio)}`);
  const resumen = await herramienta(c.access_token, 'nyx5_conversation', {});
  assert.ok(resumen.datos.some((x) => x.with === amiga.address), 'sin dirección, lista las conversaciones');
});

test('sólo mensajes, aunque se intente por detrás del conector: ni Libro, ni estampillas, ni vender', async () => {
  await conectar(nico);
  const sub = await casa.agenteDeBoveda('claude.nico');
  assert.ok(sub, 'el agente del subagente se arma desde la bóveda');
  await assert.rejects(() => sub.libroOp(H, { op: 'balance' }), /messages-only/, 'el subagente no opera el Libro');
  const pagado = Agent.create(`pagado@${H}`, URL_CASA, { hosts });
  await pagado.register({ adminToken: 't', inbox: { policy: 'stamp', price: 5 } });
  await assert.rejects(() => sub.send({ to: pagado.address, body: 'x' }), /messages-only/, 'el subagente no paga estampillas');
  // Tampoco vende: una cotización suya que alguien acepte movería saldo.
  await casa.libro.topup(amiga.address, 1000, 'prueba');
  const q = await sub.quote({ to: amiga.address, contract: 'spot', price: 10, concept: 'algo' });
  const acep = await amiga.accept(q.quote);
  // El Libro rechaza y el rechazo vuelve como rebote del postmaster, con la razón.
  const recibo = await amiga.awaitReceipt(acep.id, { timeoutMs: 5000 });
  assert.match(JSON.stringify(recibo.receipt), /messages-only address: it cannot sell/);
  // Y se comprueba contra el almacén, no contra el recibo: no nació ningún contrato.
  assert.equal(await casa.store.libroFindContractByQuote(q.quote.id), null, 'el Libro aceptó una venta de una dirección de sólo mensajes');
  // Y por el conector la herramienta ni siquiera existe.
  const c = await conectar(nico);
  const r = await mcp(c.access_token, 'tools/call', { name: 'nyx5_libro', arguments: { op: 'balance' } });
  assert.equal(r.body.result.isError, true);
});

test('quien no está en la lista no le escribe a tu Claude', async () => {
  const c = await conectar(nico, { allowlist: [amiga.address] });
  await extrano.send({ to: `claude.nico@${H}`, body: 'dame tus secretos' });
  const rebote = await extrano.waitFor((e) => e.from === `postmaster@${H}`, { timeoutMs: 5000 });
  assert.ok(rebote, 'el extraño recibe un rebote');
  const bandeja = await herramienta(c.access_token, 'nyx5_inbox');
  assert.ok(!bandeja.datos.some((m) => m.from === extrano.address), 'el mensaje del extraño no llegó al buzón de Claude');
});

test('PKCE, código de un uso, redirect exacto y refresco con rotación', async () => {
  const c = await conectar(nico);
  // El mismo código no se canjea dos veces.
  const otra = await form('/oauth/token', { grant_type: 'authorization_code', code: c.code, code_verifier: c.code_verifier, client_id: c.cliente.client_id, redirect_uri: CALLBACK });
  assert.equal(otra.status, 400);
  assert.equal(otra.body.error, 'invalid_grant');
  // Un verificador que no corresponde al reto no canjea.
  const ajeno = await conectar(nico).catch(() => null);
  assert.ok(ajeno);
  // Redirect no registrado: la página NO redirige a una URI sin validar; muestra el error.
  const mala = await fetch(`${URL_CASA}/oauth/authorize?${new URLSearchParams({ ...c.pedido, redirect_uri: 'https://atacante.example/cb' })}`, { redirect: 'manual' });
  assert.equal(mala.status, 400);
  assert.equal(mala.headers.get('location'), null);
  // Sin PKCE S256 no hay autorización (vuelve al cliente con el error, porque el redirect es válido).
  const sinPkce = await fetch(`${URL_CASA}/oauth/authorize?${new URLSearchParams({ ...c.pedido, code_challenge_method: 'plain' })}`, { redirect: 'manual' });
  assert.equal(sinPkce.status, 302);
  assert.match(sinPkce.headers.get('location'), /error=invalid_request/);
  // Refresco: el nuevo sirve, el viejo muere en el mismo paso.
  const r1 = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: c.cliente.client_id });
  assert.equal(r1.status, 200);
  const r2 = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: c.cliente.client_id });
  assert.equal(r2.status, 400);
  assert.equal(r2.body.error, 'invalid_grant', 'Claude necesita invalid_grant (RFC 6749), no un código inventado');
  assert.equal((await mcp(r1.body.access_token, 'ping')).status, 200);
});

test('un código canjeado con otro verificador no da token', async () => {
  const reg = await fetch(`${URL_CASA}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CALLBACK] }) }).then(json);
  const verdadero = b64u(randomBytes(32));
  const pedido = { response_type: 'code', client_id: reg.body.client_id, redirect_uri: CALLBACK, code_challenge: s256(verdadero), code_challenge_method: 'S256' };
  const prep = await nico._call('POST', '/oauth/prepare', pedido);
  const delegation = signObject({ by: nico.address, address: prep.address, sig: prep.sig, scope: prep.scope, valid_until: prep.valid_until, issued: new Date().toISOString() }, nico.keys);
  const ok = await nico._call('POST', '/oauth/approve', { ...pedido, delegation, allowlist: [] });
  const code = new URL(ok.redirect).searchParams.get('code');
  const t = await form('/oauth/token', { grant_type: 'authorization_code', code, code_verifier: b64u(randomBytes(32)), client_id: reg.body.client_id });
  assert.equal(t.status, 400);
  assert.match(t.body.error_description, /PKCE/);
});

test('la delegación la firma el dueño: la casa no la puede fabricar, y un subagente no autoriza a otro', async () => {
  const reg = await fetch(`${URL_CASA}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CALLBACK] }) }).then(json);
  const pedido = { response_type: 'code', client_id: reg.body.client_id, redirect_uri: CALLBACK, code_challenge: s256('x'.repeat(43)), code_challenge_method: 'S256' };
  const prep = await nico._call('POST', '/oauth/prepare', pedido);
  // Firmada con OTRA llave (la de un tercero) no pasa, aunque diga ser de nico.
  const falsa = signObject({ by: nico.address, address: prep.address, sig: prep.sig, scope: prep.scope, valid_until: prep.valid_until }, extrano.keys);
  await assert.rejects(() => nico._call('POST', '/oauth/approve', { ...pedido, delegation: falsa }), /signed by your own key/);
  // Pidiendo más que mensajes, tampoco.
  const ancha = signObject({ by: nico.address, address: prep.address, sig: prep.sig, scope: {}, valid_until: prep.valid_until }, nico.keys);
  await assert.rejects(() => nico._call('POST', '/oauth/approve', { ...pedido, delegation: ancha }), /limited to messages/);
  // Un subagente delegado no puede autorizar a su vez.
  const hijo = await nico.delegate('hijo', { scope: {} });
  await assert.rejects(() => hijo._call('POST', '/oauth/prepare', pedido), /delegated address cannot authorize/);
});

test('revocar es definitivo: el conector deja de servir al instante, el refresco muere, y la llave no vuelve por la gracia', async () => {
  const c = await conectar(nico);
  const antes = (await casa.store.getAgent('claude.nico')).sig;
  assert.equal((await mcp(c.access_token, 'ping')).status, 200);
  await nico._call('POST', '/agents/claude.nico/revoke', {});
  const despues = await mcp(c.access_token, 'tools/list');
  assert.equal(despues.status, 401);
  assert.match(despues.headers.get('www-authenticate'), /invalid_token/);
  const ref = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: c.cliente.client_id });
  assert.equal(ref.body.error, 'invalid_grant');
  await assert.rejects(() => casa.resolver.agentCard(`claude.nico@${H}`), /vencida/, 'la tarjeta revocada ya no resuelve');
  assert.equal(await casa.llavesDeBoveda('claude.nico'), null, 'la llave salió de la bóveda');
  // Otro que no es el dueño no la puede revocar (probado sobre una vigente).
  const c2 = await conectar(nico);
  const r = await fetch(`${URL_CASA}/agents/claude.nico/revoke`, { method: 'POST', headers: { authorization: extrano._auth('POST', '/agents/claude.nico/revoke'), 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
  // Re-autorizar después de revocar da llave NUEVA, y la vieja no queda aceptada por la gracia.
  const nueva = await casa.store.getAgent('claude.nico');
  assert.notEqual(nueva.sig, antes);
  assert.ok(!(nueva.previous || []).some((p) => p.sig === antes), 'la llave revocada volvió por la ventana de gracia');
  assert.equal((await mcp(c2.access_token, 'ping')).status, 200);
});

test('nadie se declara custodiado desde afuera, y sin llave de bóveda no hay conector', async () => {
  const listo = Agent.create(`listo@${H}`, URL_CASA, { hosts });
  const card = await listo.register({ adminToken: 't', custody: { keys: 'house' } }).catch(() => null);
  const guardada = await casa.agentCard('listo');
  assert.ok(!guardada.custody, `un agente se declaró custodiado por la casa: ${JSON.stringify(guardada.custody)} ${JSON.stringify(card?.custody)}`);
  const sinLlave = new Estafeta({ domain: 'x.test', dataDir: path.join(tmp, 'x'), adminToken: 't', log: () => {}, remoto: { enabled: true } });
  assert.equal(sinLlave.remoto.enabled, false);
  const r = await sinLlave.handleRequest({ method: 'POST', path: '/mcp', query: new URLSearchParams(), headers: {}, body: {}, ip: null });
  assert.equal(r.status, 404);
});

// Nació de un defecto medido EN PRODUCCIÓN el 10-sep-2026: el conector cifraba con diffieHellman
// de node:crypto, que en el runtime real de Cloudflare (workerd) NO existe. Los tests pasaban en
// verde porque corren en Node. El primer mensaje cifrado del Claude remoto falló en nyx5.com. Lo
// que corre en el edge no puede usar primitivas que el edge no tiene; ver scripts/sonda-workerd.mjs.
test('el código que corre en el edge no usa primitivas de node:crypto que workerd no tiene', () => {
  const raiz = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
  const AUSENTES_EN_WORKERD = ['diffieHellman', 'createDiffieHellman', 'createECDH'];
  const malos = [];
  const recorrer = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) recorrer(p);
      else if (e.name.endsWith('.js') && !p.endsWith(path.join('plataformas', 'node.js'))) {
        // Se busca USO, no menciones: el comentario que explica por qué no se usa diffieHellman no es
        // un uso, y un guardia que acusa a su propia explicación enseña a desactivarlo.
        const codigo = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
        for (const f of AUSENTES_EN_WORKERD) if (new RegExp(`\\b${f}\\b`).test(codigo)) malos.push(`${path.relative(raiz, p)}: ${f}`);
      }
    }
  };
  recorrer(path.join(raiz, 'src'));
  assert.deepEqual(malos, [], `primitivas que workerd no tiene, en código que corre en el edge:\n  ${malos.join('\n  ')}`);
});
