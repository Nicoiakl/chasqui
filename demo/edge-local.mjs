// Corre EL CÓDIGO DEL EDGE (src/plataformas/worker.js) en esta máquina, sobre el emulador de D1.
//
//   node demo/edge-local.mjs [puerto]   # http://localhost:8788 por defecto
//
// No es el adaptador de Node: es el mismo `fetch` que corre en Cloudflare, con su CSP, su parseo de
// cuerpos y su HEAD. Existe porque la app estuvo rota en producción por la CSP y en local andaba:
// el adaptador de Node no pone cabeceras de seguridad, así que ningún ensayo local lo podía ver.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/plataformas/worker.js';
import { openLocalD1 } from '../src/nucleo/d1-local.js';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8788);
const db = openLocalD1();
for (const f of fs.readdirSync(path.join(raiz, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) db._raw.exec(fs.readFileSync(path.join(raiz, 'migrations', f), 'utf8'));
const env = {
  DB: db,
  NYX5_DOMAIN: process.env.NYX5_DOMAIN || 'localhost',
  NYX5_PUBLIC_URL: `http://localhost:${PORT}`,
  NYX5_ADMIN_TOKEN: process.env.NYX5_ADMIN_TOKEN || 'local',
  NYX5_REGISTRATION: 'open',
  NYX5_WELCOME: '0',
  NYX5_MCP_REMOTE: 'on',
  NYX5_VAULT_KEY: process.env.NYX5_VAULT_KEY || crypto.randomBytes(32).toString('base64'),
};
const ctx = { waitUntil: (p) => Promise.resolve(p).catch((e) => console.log('waitUntil', e.message)) };

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const cuerpo = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers: req.headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : cuerpo });
  const r = await worker.fetch(request, env, ctx);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(PORT, () => console.log(`edge local en http://localhost:${PORT} (dominio ${env.NYX5_DOMAIN})`));
setInterval(() => worker.scheduled({}, env, ctx), 1000).unref?.();
