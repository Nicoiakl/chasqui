// Chasqui/1 — Puente MCP (extensión urn:chasqui:ext:mcp).
// Expone un agente Chasqui (correo + libro) como servidor MCP por stdio, para que Claude Desktop,
// Claude Code, Cursor o cualquier cliente MCP pueda enviar sobres, leer el buzón, cotizar, aceptar,
// cobrar y consultar saldo como herramientas.
// Transporte stdio de MCP: JSON-RPC 2.0, un mensaje por línea. Sin dependencias.

import readline from 'node:readline';
import { Agent } from '../correo/agente.js';

const PROTOCOL = '2025-06-18';
const SUPPORTED = new Set(['2025-06-18', '2025-03-26']);

const TOOLS = [
  { name: 'chasqui_send', description: 'Delega una tarea a otro agente aunque esté apagado: queda en su buzón y su respuesta te llega firmada cuando responda. Úsalo cuando necesites que alguien haga algo y no sabes si está disponible ahora. El destinatario verifica que eres tú y nadie más puede leer el contenido (cifrado).',
    inputSchema: { type: 'object', required: ['to', 'body'], properties: {
      to: { type: 'array', items: { type: 'string' }, description: 'Direcciones destino, ej. ["asistente@beta.local"]' },
      body: { description: 'Contenido: texto o JSON' },
      type: { type: 'string', enum: ['message', 'task', 'result', 'receipt', 'intro'], default: 'message' },
      thread: { type: 'string' }, in_reply_to: { type: 'string' },
      aval: { type: 'object', description: 'para entrar a un buzón con lista blanca sin estar en ella: { voucher, bond } de un tercero de la allowlist que te respaldó con una fianza', properties: { voucher: { type: 'string' }, bond: { type: 'string' } } },
      encrypt: { type: 'boolean', default: true } } } },
  { name: 'chasqui_inbox', description: 'Lo que otros te mandaron mientras no mirabas. Cada sobre trae firma verificada (sabes quién lo envió de verdad) y viene descifrado. Revísalo al empezar y antes de dar algo por no-respondido: una respuesta pudo llegar a tu buzón entre sesiones.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', default: 20 } } } },
  { name: 'chasqui_ack', description: 'Cierra los sobres del buzón que ya procesaste para que no vuelvan a aparecer. Úsalo después de actuar sobre un mensaje.',
    inputSchema: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string' } } } } },
  { name: 'chasqui_resolve', description: 'Comprueba quién es de verdad una dirección antes de confiar: devuelve su tarjeta certificada por su dominio (identidad verificada, qué sabe hacer, cómo cobra). Úsalo antes de mandarle algo sensible o de pagarle.',
    inputSchema: { type: 'object', required: ['address'], properties: { address: { type: 'string' } } } },
  { name: 'chasqui_outbox', description: 'Qué pasó con lo que enviaste desde tu buzón de salida: entregado, reintentando o rebotado con la razón. Úsalo si dudas de si tu mensaje llegó.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'chasqui_directory', description: 'Qué agentes ofrece una casa y qué sabe hacer cada uno, cada uno con su tarjeta certificada por el dominio. Úsalo cuando buscas un proveedor dentro de una casa que ya conoces.',
    inputSchema: { type: 'object', properties: { house: { type: 'string' }, capability: { type: 'string' }, accepts: { type: 'string' }, q: { type: 'string' }, limit: { type: 'integer' } } } },
  { name: 'chasqui_search', description: 'Encuentra un agente que haga lo que necesitas en cualquier casa, no solo en la tuya. Úsalo cuando no conoces a nadie que resuelva tu problema. El índice responde firmado y tú verificas la tarjeta antes de confiar: es una pista, no una autoridad.',
    inputSchema: { type: 'object', required: ['index'], properties: { index: { type: 'string', description: 'dominio de la casa del índice, o URL' }, q: { type: 'string' }, capability: { type: 'string' }, accepts: { type: 'string' }, house: { type: 'string' }, limit: { type: 'integer' } } } },
  // ----- Libro -----
  { name: 'chasqui_quote', description: 'Ofrécele un servicio a otro agente con precio y con la condición exacta que debe cumplirse para cobrar. En escrow el pago queda retenido hasta que la prueba pase. Úsalo para vender algo con un acuerdo que pesa, no de palabra.',
    inputSchema: { type: 'object', required: ['to', 'price', 'concept'], properties: {
      to: { type: 'string' }, contract: { type: 'string', enum: ['spot', 'escrow', 'metered'], default: 'spot' },
      price: { type: 'integer', description: 'tokens, entero' }, concept: { type: 'string' },
      terms: { type: 'object', description: 'criterio de aceptación, plazo, scope del mandato, etc.' },
      arbiter: { type: 'string' }, expires: { type: 'string', description: 'ISO-8601' },
      referrer: { type: 'object', description: 'comisión de referido: { address, share } en basis points; la paga el vendedor de su parte, el comprador paga igual', properties: { address: { type: 'string' }, share: { type: 'integer' } } } } } },
  { name: 'chasqui_accept', description: 'Acepta una oferta y compromete el pago. En escrow el dinero queda retenido: el vendedor no cobra hasta entregar y cumplir la condición. Te llega un recibo firmado que ninguna parte puede negar después.',
    inputSchema: { type: 'object', required: ['quote'], properties: { quote: { type: 'object' } } } },
  { name: 'chasqui_libro', description: 'Mueve un trato adelante en el Libro y deja un asiento firmado e irreversible en cada paso: entregar, liberar el pago si la prueba pasó, devolver si falló, afianzar una afirmación con dinero (la pierdes si mientes), o delegar gasto con tope. ops: deliver {contract, evidence_sha256}, release {contract}, refund {contract}, bond {amount, claim, verifier}, forfeit {contract, reason}, mandate {grantee, cap, scope, expires, parent}, charge {mandate, amount, concept}, revoke {mandate}, balance, statement {limit}, contract {contract}. La respuesta llega como recibo firmado a tu buzón.',
    inputSchema: { type: 'object', required: ['op'], properties: { house: { type: 'string', description: 'dominio de la casa; por defecto el propio' }, op: { type: 'string' }, args: { type: 'object' } } } },
  { name: 'chasqui_balance', description: 'Cuánto tienes, qué contratos y qué permisos de gasto tienes activos. Consúltalo antes de comprometer un pago. Lectura directa autenticada con tu firma, sin pasar por el correo.',
    inputSchema: { type: 'object', properties: { house: { type: 'string' } } } },
  { name: 'chasqui_remind', description: 'Déjate un mensaje a ti mismo que te llega en el futuro, a tu propio buzón, cifrado. Úsalo cuando una tarea debe retomarse en horas o días y tu sesión va a terminar antes: tu yo futuro encuentra el contexto con el hilo completo, sin depender de que alguien te despierte.',
    inputSchema: { type: 'object', required: ['cuando', 'body'], properties: { cuando: { type: 'string', description: 'ISO-8601: cuándo debe llegarte' }, body: { description: 'lo que tu yo futuro necesita saber' }, thread: { type: 'string' } } } },
  { name: 'chasqui_contract', description: 'El estado y la historia completa de un trato del que eres parte: cada paso con su hash y su firma. Úsalo para saber en qué va un escrow o una fianza.',
    inputSchema: { type: 'object', required: ['contract'], properties: { house: { type: 'string' }, contract: { type: 'string' } } } },
];

export async function runMcpServer({ agentFile, hosts = {} }) {
  const agent = await Agent.load(agentFile, { hosts });
  const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

  async function call(name, args = {}) {
    switch (name) {
      case 'chasqui_send': { const r = await agent.send({ to: args.to, body: args.body, type: args.type, thread: args.thread, inReplyTo: args.in_reply_to, encrypt: args.encrypt ?? true, extensions: args.aval ? { 'urn:chasqui:ext:aval': args.aval } : undefined }); return text({ id: r.id, jobs: r.jobs }); }
      case 'chasqui_inbox': {
        const msgs = await agent.inbox({ limit: args.limit ?? 20 });
        const opened = [];
        for (const m of msgs) { try { opened.push(await agent.open(m.envelope)); } catch (e) { opened.push({ id: m.envelope.id, from: m.envelope.from, error: e.message }); } }
        return text(opened.map(({ sender, ...o }) => o));
      }
      case 'chasqui_ack': return text({ acked: await agent.ack(args.ids) });
      case 'chasqui_resolve': { const { _domain, ...card } = await agent.resolver.agentCard(args.address); return text(card); }
      case 'chasqui_outbox': return text(await agent.outbox());
      case 'chasqui_directory': return text(await agent.directory(args.house, args));
      case 'chasqui_search': return text(await agent.search(args.index, args));
      case 'chasqui_quote': { const r = await agent.quote({ to: args.to, contract: args.contract, price: args.price, concept: args.concept, terms: args.terms, arbiter: args.arbiter, expires: args.expires, referrer: args.referrer }); return text({ id: r.id, quote_id: r.quote.id, contract: r.quote.contract, price: r.quote.price }); }
      case 'chasqui_accept': { const r = await agent.accept(args.quote); return text({ id: r.id, note: 'el recibo de libro@ llegará al buzón (chasqui_inbox)' }); }
      case 'chasqui_libro': { const r = await agent.libroOp(args.house || agent.domain, { op: args.op, ...(args.args || {}) }); return text({ id: r.id, note: 'la respuesta llega como recibo de libro@ al buzón' }); }
      case 'chasqui_balance': return text(await agent.balance(args.house));
      case 'chasqui_remind': { const r = await agent.recordar({ cuando: args.cuando, body: args.body, thread: args.thread }); return text({ id: r.id, note: `te llegará a tu buzón el ${args.cuando}` }); }
      case 'chasqui_contract': return text(await agent.contract(args.house || agent.domain, args.contract));
      default: return { ...text(`herramienta desconocida: ${name}`), isError: true };
    }
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let req;
    try { req = JSON.parse(line); } catch { out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
    const { id, method, params } = req;
    if (method === 'notifications/initialized' || method?.startsWith('notifications/')) continue;
    try {
      let result;
      if (method === 'initialize') result = { protocolVersion: SUPPORTED.has(params?.protocolVersion) ? params.protocolVersion : PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'chasqui', version: '0.1.0' }, instructions: `Chasqui te da tres cosas que no tienes de otra forma: dirección propia, un buzón que guarda aunque estés apagado, y un libro contable donde un acuerdo pesa (el pago se retiene hasta cumplir; una afirmación falsa cuesta dinero). Úsalo cuando necesites hablar con un agente que puede no estar disponible ahora, encontrar a alguien que haga X en cualquier casa, o cerrar un trato que debe valer más que una promesa. Cada mensaje va firmado y cada movimiento de dinero deja un recibo que nadie puede negar.` };
      else if (method === 'ping') result = {};
      else if (method === 'tools/list') result = { tools: TOOLS };
      else if (method === 'tools/call') { try { result = await call(params?.name, params?.arguments); } catch (e) { result = { ...text(`error: ${e.message}`), isError: true }; } }
      else { out({ jsonrpc: '2.0', id, error: { code: -32601, message: `método no soportado: ${method}` } }); continue; }
      if (id !== undefined) out({ jsonrpc: '2.0', id, result });
    } catch (e) {
      out({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
    }
  }
}
