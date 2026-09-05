#!/usr/bin/env node
// Chasqui/1 — CLI
//
//   chasqui estafeta --domain alfa.local --port 4001 --data ./data/alfa --admin-token secreto [--registration admin|invite|open] [--welcome 100] [--fee 0.10]
//   chasqui keygen   --address nicolas@alfa.local --estafeta http://127.0.0.1:4001 --out ./keys/nicolas.json
//   chasqui register --agent ./keys/nicolas.json --admin-token secreto [--policy open|allowlist|pow|stamp] [--allow a@b,c@d] [--pow-bits 16] [--webhook URL] [--mcp URL] [--a2a URL]
//   chasqui register --agent ./keys/nicolas.json --invite CODIGO        (o sin nada, si la casa tiene registration=open)
//   chasqui invite   --estafeta http://127.0.0.1:4001 --admin-token secreto [--uses 1] [--expires ISO] [--note "para Marta"]
//   chasqui directory [--house alfa.local | --estafeta URL] [--capability mcp] [--accepts media] [--q texto]
//   chasqui card     --address asistente@beta.local
//   chasqui send     --agent ./keys/nicolas.json --to asistente@beta.local --body "hola" [--json] [--type task] [--plain]
//   chasqui inbox    --agent ./keys/nicolas.json [--ack]
//   chasqui ack      --agent ./keys/nicolas.json --id <id>[,<id>]
//   chasqui outbox   --agent ./keys/nicolas.json
//   chasqui mcp      --agent ./keys/nicolas.json          (servidor MCP por stdio)
//   --- Libro ---
//   chasqui topup    --estafeta http://127.0.0.1:4001 --admin-token secreto --account nicolas@alfa.local --amount 1000
//   chasqui balance  --agent ./keys/nicolas.json [--house alfa.local]
//   chasqui quote    --agent ./keys/verifica.json --to nicolas@alfa.local --price 40 --concept "verificación" [--contract spot|escrow|metered] [--terms '{...}']
//   chasqui accept   --agent ./keys/nicolas.json --quote <archivo.json o JSON>     (o `inbox` te muestra la cotización; cópiala)
//   chasqui libro    --agent ./keys/nicolas.json --op release --json '{"contract":"..."}' [--house alfa.local]
//   chasqui contract --agent ./keys/nicolas.json --id <contrato>
//   chasqui delegate --agent ./keys/constructor.json --name tester --scope '{"types":["message","result"],"cap":100}' --out ./keys/tester.json
//
// Resolución local: --hosts hosts.json, o CHASQUI_HOSTS, o ./hosts.local.json si existe.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Estafeta } from '../src/correo/estafeta.js';
import { Agent } from '../src/correo/agente.js';
import { Resolver } from '../src/correo/resolver.js';
import { runMcpServer } from '../src/puentes/mcp.js';

const [cmd, ...rest] = process.argv.slice(2);
const { values: o } = parseArgs({ args: rest, allowPositionals: true, options: {
  domain: { type: 'string' }, port: { type: 'string' }, data: { type: 'string' }, 'admin-token': { type: 'string' }, 'public-url': { type: 'string' },
  'require-relay': { type: 'boolean' }, hosts: { type: 'string' }, registration: { type: 'string' }, welcome: { type: 'string' }, fee: { type: 'string' },
  invite: { type: 'string' }, uses: { type: 'string' }, expires: { type: 'string' }, note: { type: 'string' }, capability: { type: 'string' }, accepts: { type: 'string' }, q: { type: 'string' },
  address: { type: 'string' }, estafeta: { type: 'string' }, out: { type: 'string' }, agent: { type: 'string' },
  policy: { type: 'string' }, allow: { type: 'string' }, 'pow-bits': { type: 'string' }, webhook: { type: 'string' }, mcp: { type: 'string' }, a2a: { type: 'string' },
  to: { type: 'string' }, body: { type: 'string' }, type: { type: 'string' }, json: { type: 'boolean' }, plain: { type: 'boolean' }, thread: { type: 'string' }, 'reply-to': { type: 'string' },
  ack: { type: 'boolean' }, id: { type: 'string' },
  account: { type: 'string' }, amount: { type: 'string' }, house: { type: 'string' }, price: { type: 'string' }, concept: { type: 'string' }, contract: { type: 'string' }, terms: { type: 'string' },
  quote: { type: 'string' }, op: { type: 'string' }, name: { type: 'string' }, scope: { type: 'string' },
} });

const need = (k) => { if (!o[k]) { console.error(`falta --${k}`); process.exit(2); } return o[k]; };
const loadHosts = () => {
  const file = o.hosts || process.env.CHASQUI_HOSTS || (fs.existsSync('hosts.local.json') ? 'hosts.local.json' : null);
  return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
};
const loadAgent = () => Agent.load(need('agent'), { hosts: loadHosts() });
const print = (v) => console.log(JSON.stringify(v, null, 2));

try {
  switch (cmd) {
    case 'estafeta': {
      const e = new Estafeta({
        domain: need('domain'), port: Number(o.port || 4000), dataDir: need('data'),
        adminToken: o['admin-token'] || process.env.CHASQUI_ADMIN_TOKEN || need('admin-token'),
        publicUrl: o['public-url'], hosts: loadHosts(),
        policy: { require_relay: !!o['require-relay'], registration: o.registration || 'admin' },
        libro: { welcome: Number(o.welcome || 0), feePct: o.fee != null ? Number(o.fee) : 0.10 },
      });
      await e.start();
      process.on('SIGINT', async () => { await e.stop(); process.exit(0); });
      break;
    }
    case 'keygen': {
      const a = Agent.create(need('address'), need('estafeta'));
      const out = o.out || `./keys/${a.local}.json`;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify({ address: a.address, estafeta: a.estafeta, keys: a.keys }, null, 2), { mode: 0o600 });
      console.log(`claves de ${a.address} guardadas en ${out} (guárdalo como una contraseña)`);
      console.log(`clave pública de firma: ${a.keys.sig}`);
      break;
    }
    case 'register': {
      const a = loadAgent();
      const inbox = { policy: o.policy || 'open' };
      if (o.allow) inbox.allowlist = o.allow.split(',').map((s) => s.trim());
      if (o['pow-bits']) inbox.pow_bits = Number(o['pow-bits']);
      const capabilities = {};
      if (o.mcp) capabilities.mcp = o.mcp;
      if (o.a2a) capabilities.a2a = o.a2a;
      print(await a.register({ adminToken: o['admin-token'] || process.env.CHASQUI_ADMIN_TOKEN, invite: o.invite, inbox, capabilities, webhook: o.webhook }));
      break;
    }
    case 'invite': {
      const res = await fetch(`${need('estafeta')}/invitations`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${o['admin-token'] || process.env.CHASQUI_ADMIN_TOKEN}` }, body: JSON.stringify({ uses: Number(o.uses || 1), expires: o.expires || null, note: o.note || null, welcome: o.welcome != null ? Number(o.welcome) : null }) });
      print(await res.json()); break;
    }
    case 'directory': {
      const params = new URLSearchParams(Object.entries({ capability: o.capability, accepts: o.accepts, q: o.q }).filter(([, v]) => v));
      let base = o.estafeta;
      if (!base) { const r = new Resolver({ hosts: loadHosts() }); base = (await r.domainCard(need('house')))._estafeta; }
      const d = await (await fetch(`${base}/agents?${params}`)).json();
      console.log(`${d.total} agente(s)`);
      for (const a of d.agents) console.log(`  ${a.address.padEnd(36)} ${Object.keys(a.capabilities || {}).filter((k) => k !== 'accepts').join(',') || '-'}  buzón=${a.inbox?.policy}${a.delegated_by ? '  delegado por ' + a.delegated_by : ''}`);
      break;
    }
    case 'card': {
      const r = new Resolver({ hosts: loadHosts() });
      const { _domain, ...card } = await r.agentCard(need('address'));
      print(card);
      break;
    }
    case 'send': {
      const a = loadAgent();
      const body = o.json ? JSON.parse(need('body')) : need('body');
      const r = await a.send({ to: need('to').split(',').map((s) => s.trim()), body, type: o.type || 'message', encrypt: !o.plain, thread: o.thread, inReplyTo: o['reply-to'] });
      print({ id: r.id, jobs: r.jobs, encrypted: !!r.envelope.encrypted });
      break;
    }
    case 'inbox': {
      const a = loadAgent();
      const msgs = await a.inbox();
      if (!msgs.length) { console.log('buzón vacío'); break; }
      for (const m of msgs) {
        try { const op = await a.open(m.envelope); const { sender, ...rest } = op; print({ ...rest, received: m.received, relay_verified: m.relay_verified }); }
        catch (e) { print({ id: m.envelope.id, from: m.envelope.from, error: e.message }); }
      }
      if (o.ack) console.log('ack:', await a.ack(msgs.map((m) => m.envelope.id)));
      break;
    }
    case 'ack': print({ acked: await loadAgent().ack(need('id').split(',')) }); break;
    case 'outbox': print(await loadAgent().outbox()); break;
    case 'mcp': await runMcpServer({ agentFile: need('agent'), hosts: loadHosts() }); break;

    // ----- Libro -----
    case 'topup': {
      const res = await fetch(`${need('estafeta')}/libro/topup`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${o['admin-token'] || process.env.CHASQUI_ADMIN_TOKEN}` }, body: JSON.stringify({ account: need('account'), amount: Number(need('amount')), concept: o.concept }) });
      print(await res.json()); break;
    }
    case 'balance': print(await loadAgent().balance(o.house)); break;
    case 'quote': {
      const a = loadAgent();
      const r = await a.quote({ to: need('to'), contract: o.contract || 'spot', price: Number(need('price')), concept: need('concept'), terms: o.terms ? JSON.parse(o.terms) : undefined, house: o.house });
      print({ sent: r.id, quote: r.quote }); break;
    }
    case 'accept': {
      const raw = need('quote');
      const q = fs.existsSync(raw) ? JSON.parse(fs.readFileSync(raw, 'utf8')) : JSON.parse(raw);
      print(await loadAgent().accept(q.content?.body || q)); break;
    }
    case 'libro': {
      const a = loadAgent();
      print(await a.libroOp(o.house || a.domain, { op: need('op'), ...(o.json ? JSON.parse(o.body || '{}') : {}) })); break;
    }
    case 'contract': { const a = loadAgent(); print(await a.contract(o.house || a.domain, need('id'))); break; }
    case 'delegate': {
      const a = loadAgent();
      const sub = await a.delegate(need('name'), { scope: o.scope ? JSON.parse(o.scope) : {} });
      const out = o.out || `./keys/${sub.local}.json`;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify({ address: sub.address, estafeta: sub.estafeta, keys: sub.keys }, null, 2), { mode: 0o600 });
      console.log(`agente delegado ${sub.address} creado; claves en ${out}`); break;
    }
    default:
      console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 25).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
      process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error('error:', e.message);
  process.exit(1);
}
