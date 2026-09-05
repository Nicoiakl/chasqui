// Chasqui/1 — Puente MCP (extensión urn:chasqui:ext:mcp).
// Expone un agente Chasqui (correo + libro) como servidor MCP por stdio, para que Claude Desktop,
// Claude Code, Cursor o cualquier cliente MCP pueda enviar sobres, leer el buzón, cotizar, aceptar,
// cobrar y consultar saldo como herramientas.
// Transporte stdio de MCP: JSON-RPC 2.0, un mensaje por línea. Sin dependencias.

import readline from 'node:readline';
import { Agent } from '../correo/agente.js';

const PROTOCOL = '2025-06-18';

const TOOLS = [
  { name: 'chasqui_send', description: 'Envía un sobre Chasqui firmado (y cifrado si el destinatario publica clave) a una o más direcciones agente@dominio.',
    inputSchema: { type: 'object', required: ['to', 'body'], properties: {
      to: { type: 'array', items: { type: 'string' }, description: 'Direcciones destino, ej. ["asistente@beta.local"]' },
      body: { description: 'Contenido: texto o JSON' },
      type: { type: 'string', enum: ['message', 'task', 'result', 'receipt', 'intro'], default: 'message' },
      thread: { type: 'string' }, in_reply_to: { type: 'string' },
      encrypt: { type: 'boolean', default: true } } } },
  { name: 'chasqui_inbox', description: 'Lee los sobres pendientes del buzón del agente, verificando firma y descifrando. Los sobres siguen en el buzón hasta chasqui_ack.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', default: 20 } } } },
  { name: 'chasqui_ack', description: 'Confirma sobres ya procesados para que salgan del buzón.',
    inputSchema: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string' } } } } },
  { name: 'chasqui_resolve', description: 'Resuelve una dirección agente@dominio y devuelve su tarjeta verificada (claves, capacidades, política de buzón, endpoints MCP/A2A).',
    inputSchema: { type: 'object', required: ['address'], properties: { address: { type: 'string' } } } },
  { name: 'chasqui_outbox', description: 'Estado de los envíos del agente (queued, retrying, delivered, failed).',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'chasqui_directory', description: 'Directorio público de los agentes de una casa (por defecto la propia). Filtra por capacidad (mcp, a2a, libro), media aceptado o texto.',
    inputSchema: { type: 'object', properties: { house: { type: 'string' }, capability: { type: 'string' }, accepts: { type: 'string' }, q: { type: 'string' }, limit: { type: 'integer' } } } },
  // ----- Libro -----
  { name: 'chasqui_quote', description: 'Cotiza a otro agente: crea un documento firmado (spot | escrow | metered) y lo envía cifrado. El comprador lo acepta con chasqui_accept.',
    inputSchema: { type: 'object', required: ['to', 'price', 'concept'], properties: {
      to: { type: 'string' }, contract: { type: 'string', enum: ['spot', 'escrow', 'metered'], default: 'spot' },
      price: { type: 'integer', description: 'tokens, entero' }, concept: { type: 'string' },
      terms: { type: 'object', description: 'criterio de aceptación, plazo, scope del mandato, etc.' },
      arbiter: { type: 'string' }, expires: { type: 'string', description: 'ISO-8601' } } } },
  { name: 'chasqui_accept', description: 'Acepta una cotización recibida (el objeto `content.body` de un sobre con media application/chasqui.cotizacion+json). Ejecuta el asiento en el Libro de la casa; el recibo llega al buzón.',
    inputSchema: { type: 'object', required: ['quote'], properties: { quote: { type: 'object' } } } },
  { name: 'chasqui_libro', description: 'Operación genérica del Libro, enviada como sobre firmado a libro@<casa>. ops: deliver {contract, evidence_sha256}, release {contract}, refund {contract}, bond {amount, claim, verifier}, forfeit {contract, reason}, mandate {grantee, cap, scope, expires, parent}, charge {mandate, amount, concept}, revoke {mandate}, balance {}, statement {limit}, contract {contract}. La respuesta llega como recibo de libro@ al buzón.',
    inputSchema: { type: 'object', required: ['op'], properties: { house: { type: 'string', description: 'dominio de la casa; por defecto el propio' }, op: { type: 'string' }, args: { type: 'object' } } } },
  { name: 'chasqui_balance', description: 'Saldo, contratos y mandatos del agente en una casa (lectura directa, sin correo).',
    inputSchema: { type: 'object', properties: { house: { type: 'string' } } } },
  { name: 'chasqui_contract', description: 'Detalle e historial de un contrato del que el agente es parte.',
    inputSchema: { type: 'object', required: ['contract'], properties: { house: { type: 'string' }, contract: { type: 'string' } } } },
];

export async function runMcpServer({ agentFile, hosts = {} }) {
  const agent = Agent.load(agentFile, { hosts });
  const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

  async function call(name, args = {}) {
    switch (name) {
      case 'chasqui_send': { const r = await agent.send({ to: args.to, body: args.body, type: args.type, thread: args.thread, inReplyTo: args.in_reply_to, encrypt: args.encrypt ?? true }); return text({ id: r.id, jobs: r.jobs }); }
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
      case 'chasqui_quote': { const r = await agent.quote({ to: args.to, contract: args.contract, price: args.price, concept: args.concept, terms: args.terms, arbiter: args.arbiter, expires: args.expires }); return text({ id: r.id, quote_id: r.quote.id, contract: r.quote.contract, price: r.quote.price }); }
      case 'chasqui_accept': { const r = await agent.accept(args.quote); return text({ id: r.id, note: 'el recibo de libro@ llegará al buzón (chasqui_inbox)' }); }
      case 'chasqui_libro': { const r = await agent.libroOp(args.house || agent.domain, { op: args.op, ...(args.args || {}) }); return text({ id: r.id, note: 'la respuesta llega como recibo de libro@ al buzón' }); }
      case 'chasqui_balance': return text(await agent.balance(args.house));
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
      if (method === 'initialize') result = { protocolVersion: params?.protocolVersion || PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'chasqui', version: '0.1.0' }, instructions: `Agente Chasqui ${agent.address}. Correo: chasqui_inbox para leer, chasqui_send para escribir, chasqui_ack para cerrar. Libro: chasqui_quote / chasqui_accept para transar, chasqui_libro para escrow, fianzas y mandatos, chasqui_balance para el saldo. Los recibos del Libro llegan al buzón.` };
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
