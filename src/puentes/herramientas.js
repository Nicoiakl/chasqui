// Nyx5/1 — Las herramientas que un modelo usa para operar Nyx5, en UN solo lugar.
// Las sirven dos puentes: el local por stdio (src/puentes/mcp.js, la llave del agente en el disco
// del usuario) y el remoto por HTTP (src/puentes/mcp-remoto.js, un subagente delegado cuya llave
// guarda la casa). Si cada puente tuviera su copia, una descripción o un arreglo llegaría a uno
// solo y el otro seguiría prometiendo lo de antes.
//
// Las descripciones son lo único que el modelo lee para decidir si usa Nyx5: dicen la capacidad,
// la garantía y el momento de uso, no el mecanismo. Las cuida test/mcp.test.js.

export const TOOLS = [
  { name: 'nyx5_send', description: 'Delegate a task to another agent even if it is switched off: it waits in their mailbox and their reply reaches you signed when they answer. Use it when you need someone to do something and do not know whether they are available now. The result says whether it went encrypted (it does when the recipient has a key).',
    inputSchema: { type: 'object', required: ['to', 'body'], properties: {
      to: { type: 'array', items: { type: 'string' }, description: 'Direcciones destino, ej. ["asistente@beta.local"]' },
      body: { description: 'Contenido: texto o JSON' },
      type: { type: 'string', enum: ['message', 'task', 'result', 'receipt', 'intro'], default: 'message' },
      thread: { type: 'string' }, in_reply_to: { type: 'string' },
      aval: { type: 'object', description: 'para entrar a un buzón con lista blanca sin estar en ella: { voucher, bond } de un tercero de la allowlist que te respaldó con una fianza', properties: { voucher: { type: 'string' }, bond: { type: 'string' } } },
      encrypt: { type: 'boolean', default: true } } } },
  { name: 'nyx5_inbox', description: 'What others sent you while you were not looking. Every envelope arrives with a verified signature (you know who really sent it) and comes decrypted. Check it when you start and before treating anything as unanswered: a reply may have landed between sessions.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', default: 20 } } } },
  { name: 'nyx5_ack', description: 'Close the envelopes in your mailbox that you already handled so they stop coming back. Use it after acting on a message; what you acknowledge stays in the record.',
    inputSchema: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string' } } } } },
  { name: 'nyx5_resolve', description: 'Check who an address really is before trusting it: returns their card, certified by their domain (verified identity, what they can do, how they charge). Use it before sending anything sensitive or paying them.',
    inputSchema: { type: 'object', required: ['address'], properties: { address: { type: 'string' } } } },
  { name: 'nyx5_outbox', description: 'What happened to the signed envelopes you sent: delivered, retrying, or bounced with the reason. Use it when you are unsure whether your message arrived; the estafeta records every attempt.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'nyx5_directory', description: 'Which agents a house offers and what each one does, every card certified by the domain. Use it when you are looking for a provider inside a house you already know.',
    inputSchema: { type: 'object', properties: { house: { type: 'string' }, capability: { type: 'string' }, accepts: { type: 'string' }, q: { type: 'string' }, limit: { type: 'integer' } } } },
  { name: 'nyx5_search', description: 'Find an agent that does what you need in any house, not just yours. Use it when you know nobody who solves your problem. The index answers signed and you verify the card before trusting: it is a hint, not an authority.',
    inputSchema: { type: 'object', required: ['index'], properties: { index: { type: 'string', description: 'dominio de la casa del índice, o URL' }, q: { type: 'string' }, capability: { type: 'string' }, accepts: { type: 'string' }, house: { type: 'string' }, limit: { type: 'integer' } } } },
  // ----- Libro -----
  { name: 'nyx5_quote', description: 'Offer another agent a service with a price and the exact condition that must be met to get paid. In escrow the payment is held until the proof passes. Use it to sell something with an agreement that carries weight, not a spoken promise.',
    inputSchema: { type: 'object', required: ['to', 'price', 'concept'], properties: {
      to: { type: 'string' }, contract: { type: 'string', enum: ['spot', 'escrow', 'metered'], default: 'spot' },
      price: { type: 'integer', description: 'tokens, entero' }, concept: { type: 'string' },
      terms: { type: 'object', description: 'criterio de aceptación, plazo, scope del mandato, etc.' },
      arbiter: { type: 'string' }, expires: { type: 'string', description: 'ISO-8601' },
      referrer: { type: 'object', description: 'comisión de referido: { address, share } en basis points; la paga el vendedor de su parte, el comprador paga igual', properties: { address: { type: 'string' }, share: { type: 'integer' } } } } } },
  { name: 'nyx5_accept', description: 'Accept an offer and commit the payment. In escrow the money is held: the seller does not get paid until they deliver and meet the condition. You receive a signed receipt that no party can deny later.',
    inputSchema: { type: 'object', required: ['quote'], properties: { quote: { type: 'object' } } } },
  { name: 'nyx5_libro', description: 'Move a deal forward in the ledger, leaving a signed and irreversible entry at every step: deliver, release the payment if the proof passed, refund if it failed, back a claim with money (you lose it if you lied), or delegate spending with a cap. ops: deliver {contract, evidence_sha256}, release {contract}, refund {contract}, bond {amount, claim, verifier}, forfeit {contract, reason}, mandate {grantee, cap, scope, expires, parent}, charge {mandate, amount, concept}, revoke {mandate}, balance, statement {limit}, contract {contract}. The answer arrives as a signed receipt in your mailbox.',
    inputSchema: { type: 'object', required: ['op'], properties: { house: { type: 'string', description: 'dominio de la casa; por defecto el propio' }, op: { type: 'string' }, args: { type: 'object' } } } },
  { name: 'nyx5_balance', description: 'How much you hold, which contracts and which spending permissions are active. Check it before committing a payment. A direct read authenticated with your signature, without going through the mail.',
    inputSchema: { type: 'object', properties: { house: { type: 'string' } } } },
  { name: 'nyx5_remind', description: 'Leave yourself a message that reaches you in the future, in your own mailbox, encrypted. Use it when a task must be picked up in hours or days and your session will end before then: your future self finds the context with the full thread, without depending on anyone waking you.',
    inputSchema: { type: 'object', required: ['cuando', 'body'], properties: { cuando: { type: 'string', description: 'ISO-8601: cuándo debe llegarte' }, body: { description: 'lo que tu yo futuro necesita saber' }, thread: { type: 'string' } } } },
  { name: 'nyx5_contract', description: 'The state and full history of a deal you are party to: every step with its hash and its signature. Use it to see where an escrow or a bond stands.',
    inputSchema: { type: 'object', required: ['contract'], properties: { house: { type: 'string' }, contract: { type: 'string' } } } },
  { name: 'nyx5_historial', description: 'The reputation of an agent is its ledger: deliveries accepted against returned, bonds standing against forfeited, with amounts. Check it before hiring a stranger. Every point of it cost tokens and is tied to a verified delivery, so it cannot be inflated by talking; with no record it returns null (nothing yet, not perfect).',
    inputSchema: { type: 'object', properties: { address: { type: 'string', description: 'a quién mirar; por defecto, tú mismo' } } } },
  { name: 'nyx5_tareas', description: 'Paid work a house publishes that you can take right now: what to do, what it pays, and the deterministic check it will be verified with. Use it when you just joined and have no record yet, or when you need tokens to back your own claims with a bond.',
    inputSchema: { type: 'object', properties: { house: { type: 'string' } } } },
  { name: 'nyx5_tomar', description: 'Take a published task: the house holds the payment in a signed entry before you work, and releases it on its own when the deterministic check passes. If it fails, it is refunded and stays in your record. Use it to earn your first tokens; terms are copied from the catalogue and are not negotiable.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string', description: 'id de la tarea, de nyx5_tareas' }, house: { type: 'string' } } } },
  { name: 'nyx5_email', description: 'Write by email to a human who is not on Nyx5 yet. Use it when the recipient has no agent address: their reply comes back to your mailbox (Reply-To). It enters unsigned, marked as not verified, never disguised; when they want the real thing, they register.',
    inputSchema: { type: 'object', required: ['to', 'body'], properties: { to: { type: 'string', description: 'dirección de correo, ej. persona@gmail.com' }, subject: { type: 'string' }, body: { description: 'el texto del correo' } } } },
  { name: 'nyx5_wait', description: 'Wait, up to a limit, for the next message in your mailbox (optionally only from one sender or one thread) and get it opened, with its signature verified, the moment it lands. Use it right after sending when the other side is live: it is how two agents hold a real-time conversation instead of polling.',
    inputSchema: { type: 'object', properties: { from: { type: 'string', description: 'only messages from this address' }, thread: { type: 'string', description: 'only messages in this thread' }, since: { type: 'string', description: 'ISO time: only messages received after it' }, seconds: { type: 'number', description: 'how long to wait, 1 to 90 (default 60)' } } } },
  { name: 'nyx5_conversation', description: 'The signed history between you and one address, both directions and oldest first, including what you already acknowledged; without an address, the list of your conversations. Use it to pick up where a conversation was left, from any device: the history lives in the house, not in your session.',
    inputSchema: { type: 'object', properties: { with: { type: 'string', description: 'the other address; omit it to list your conversations' }, limit: { type: 'number', description: 'how many messages, newest kept (default 30)' } } } },
  { name: 'nyx5_whoami', description: 'Your own address and what it may do: who delegated it, until when, whether the house holds its keys, and who may write to it. Check it before promising anything on behalf of your owner; the card is certified by the domain.',
    inputSchema: { type: 'object', properties: {} } },
];

// Lo que el conector remoto expone: mensajería y nada que mueva saldo. El subagente de un teléfono
// es de alcance `messages_only` (la casa se lo niega igual si lo intenta); ofrecerle herramientas
// que van a fallar sólo le enseñaría al modelo a prometer lo que no puede cumplir.
export const MENSAJERIA = new Set(['nyx5_send', 'nyx5_inbox', 'nyx5_ack', 'nyx5_resolve', 'nyx5_outbox', 'nyx5_directory', 'nyx5_search', 'nyx5_remind', 'nyx5_historial', 'nyx5_wait', 'nyx5_conversation', 'nyx5_whoami']);

export const INSTRUCCIONES = `Nyx5 gives an agent three things it has no other way of getting: an address of its own, a mailbox that holds while it is off, and a ledger where an agreement carries weight (payment is held until the proof passes; a false claim forfeits its bond). Use it to reach an agent that may not be available now, to find someone who does X in any house, or to close a deal that must be worth more than a promise. Before trusting a stranger, read their record: it is a query on the ledger, so every point of it cost tokens. Every message is signed and every movement of money leaves a receipt no party can deny.`;

export function instrucciones({ remoto = false, address = null } = {}) {
  if (!remoto) return INSTRUCCIONES;
  return `You act through ${address}, a messages-only address your owner delegated to you. You can send signed messages to any agent address, read your mailbox, and wait for a reply live, which is how you hold a real-time conversation with another agent. You cannot move money or operate the ledger. The house holds this key on behalf of your owner, who can revoke it at any time. Before trusting a stranger, check who they really are: every card is certified by its domain.`;
}

export async function llamar(agent, name, args = {}, { permitidas = null, esperaMaxS = 90 } = {}) {
  const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
  if (permitidas && !permitidas.has(name)) return { ...text(`${name} is not available here: this is a messages-only address (no ledger, no payments)`), isError: true };
  switch (name) {
    case 'nyx5_send': { const r = await agent.send({ to: args.to, body: args.body, type: args.type, thread: args.thread, inReplyTo: args.in_reply_to, encrypt: args.encrypt ?? true, extensions: args.aval ? { 'urn:nyx5:ext:aval': args.aval } : undefined }); return text({ id: r.id, jobs: r.jobs, encrypted: r.encrypted }); }
    case 'nyx5_inbox': {
      const msgs = await agent.inbox({ limit: args.limit ?? 20 });
      const opened = [];
      for (const m of msgs) { try { opened.push(await agent.open(m.envelope)); } catch (e) { opened.push({ id: m.envelope.id, from: m.envelope.from, error: e.message }); } }
      return text(opened.map(({ sender, ...o }) => o));
    }
    case 'nyx5_ack': return text({ acked: await agent.ack(args.ids) });
    case 'nyx5_resolve': { const { _domain, ...card } = await agent.resolver.agentCard(args.address); return text(card); }
    case 'nyx5_outbox': return text(await agent.outbox());
    case 'nyx5_directory': return text(await agent.directory(args.house, args));
    case 'nyx5_search': return text(await agent.search(args.index, args));
    case 'nyx5_quote': { const r = await agent.quote({ to: args.to, contract: args.contract, price: args.price, concept: args.concept, terms: args.terms, arbiter: args.arbiter, expires: args.expires, referrer: args.referrer }); return text({ id: r.id, quote_id: r.quote.id, contract: r.quote.contract, price: r.quote.price }); }
    case 'nyx5_accept': { const r = await agent.accept(args.quote); return text({ id: r.id, note: 'el recibo de libro@ llegará al buzón (nyx5_inbox)' }); }
    case 'nyx5_libro': { const r = await agent.libroOp(args.house || agent.domain, { op: args.op, ...(args.args || {}) }); return text({ id: r.id, note: 'la respuesta llega como recibo de libro@ al buzón' }); }
    case 'nyx5_balance': return text(await agent.balance(args.house));
    case 'nyx5_remind': { const r = await agent.recordar({ cuando: args.cuando, body: args.body, thread: args.thread }); return text({ id: r.id, note: `te llegará a tu buzón el ${args.cuando}` }); }
    case 'nyx5_historial': return text(await agent.historial(args.address || agent.address));
    case 'nyx5_tareas': {
      const dc = await agent.resolver.domainCard(args.house || agent.domain);
      const res = await agent.fetch(`${dc._estafeta}/tareas`);
      const j = await res.json();
      if (!res.ok) return text({ error: j.reason || `HTTP ${res.status}` });
      return text(j);
    }
    case 'nyx5_tomar': {
      const dc = await agent.resolver.domainCard(args.house || agent.domain);
      const j = await (await agent.fetch(`${dc._estafeta}/tareas`)).json();
      const t = (j.tasks || j.tareas || []).find((x) => x.id === args.id);
      if (!t) return text({ error: `no task with id ${args.id}`, available: (j.tasks || j.tareas || []).map((x) => x.id) });
      const enviada = await agent.quote({ to: (j.desk || j.mostrador), contract: 'escrow', price: t.price, concept: t.concept, arbiter: (j.arbiter || j.arbitro), terms: t.terms });
      return text({ enviada: enviada.id, tarea: t.id, price: t.price, siguiente: 'si hay cupo, el contrato te llega al buzón (nyx5_inbox); al terminar, nyx5_libro op=deliver' });
    }
    case 'nyx5_email': { const r = await agent.email({ to: args.to, subject: args.subject, body: args.body }); return text(r); }
    case 'nyx5_contract': return text(await agent.contract(args.house || agent.domain, args.contract));
    case 'nyx5_wait': {
      const secs = Math.max(1, Math.min(Number(args.seconds ?? 60) || 60, esperaMaxS));
      const m = await agent.wait({ from: args.from, thread: args.thread, since: args.since, seconds: secs });
      if (!m) return text({ message: null, waited_seconds: secs, note: 'nothing arrived; call again to keep listening' });
      let abierto;
      try { const { sender, ...o } = await agent.open(m.envelope); abierto = o; } catch (e) { abierto = { id: m.envelope.id, from: m.envelope.from, error: e.message }; }
      return text({ ...abierto, received: m.received });
    }
    case 'nyx5_conversation': {
      if (!args.with) return text(await agent.conversations());
      const msgs = await agent.conversation(args.with, { limit: args.limit ?? 30 });
      const out = [];
      for (const m of msgs) {
        try { const { sender, ...o } = await agent.open(m.envelope); out.push({ dir: m.dir, at: m.at, status: m.status, ...o }); }
        catch (e) { out.push({ dir: m.dir, at: m.at, id: m.envelope?.id, from: m.envelope?.from, error: e.message }); }
      }
      return text(out);
    }
    case 'nyx5_whoami': return text(await agent.whoami());
    default: return { ...text(`unknown tool: ${name}`), isError: true };
  }
}
