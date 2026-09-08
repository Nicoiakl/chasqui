// Nyx5/1 — Adaptador Node: sirve una Estafeta con node:http.
// La Estafeta no conoce el transporte; este archivo traduce req/res -> handleRequest(rx).

import http from 'node:http';

export function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('cuerpo demasiado grande'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}

export async function startNodeServer(estafeta, { port, host }) {
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url, 'http://x');
      const body = (req.method === 'POST' || req.method === 'PUT') ? await readJson(req) : null;
      const rx = {
        method: req.method,
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body,
        ip: req.socket?.remoteAddress || null,
      };
      const out = await estafeta.handleRequest(rx);
      if (out.contentType) { res.writeHead(out.status, { 'content-type': out.contentType }); res.end(out.body); }
      else send(out.status, out.body);
      if (out.pending) out.pending.catch(() => {});
      if (out.kick) setImmediate(() => estafeta.tick().catch((e) => estafeta.log('tick error', e.message)));
    } catch (e) {
      send(Number.isInteger(e.status) ? e.status : 500, { reason: e.message });
    }
  });
  await new Promise((r) => server.listen(port, host, r));
  return { server, close: () => new Promise((r) => server.close(r)) };
}
