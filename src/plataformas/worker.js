// Chasqui/1 — Adaptador Cloudflare Workers: la misma Estafeta, en el edge.
//
//   fetch     -> handleRequest(rx); los ticks post-respuesta van por ctx.waitUntil
//   scheduled -> tick() (cola de reintentos + rastreo del índice federado)
//
// Configuración por variables (wrangler.toml / secrets):
//   CHASQUI_DOMAIN        dominio de la casa (ej: chasqui.nicholasiakl.workers.dev)
//   CHASQUI_PUBLIC_URL    URL pública de la estafeta (https://<CHASQUI_DOMAIN>)
//   CHASQUI_ADMIN_TOKEN   token de administración (secret; write-only)
//   CHASQUI_REGISTRATION  admin | invite | open        (default invite)
//   CHASQUI_WELCOME       tokens de regalo de bienvenida (default 0)
//   CHASQUI_FEE_BPS       fee de la casa en basis points (default 1000 = 10%)
//   CHASQUI_INDEX         'on' para operar el índice federado (default off)
//   DB                    binding D1

import { Estafeta } from '../correo/estafeta.js';
import { D1Store } from '../nucleo/almacen-d1.js';

let instancia = null;
function estafetaDesde(env) {
  if (instancia) return instancia;
  instancia = new Estafeta({
    domain: env.CHASQUI_DOMAIN,
    publicUrl: env.CHASQUI_PUBLIC_URL || `https://${env.CHASQUI_DOMAIN}`,
    adminToken: env.CHASQUI_ADMIN_TOKEN,
    store: new D1Store(env.DB),
    policy: { registration: env.CHASQUI_REGISTRATION || 'invite' },
    libro: { welcome: Number(env.CHASQUI_WELCOME || 0), feeBps: Number(env.CHASQUI_FEE_BPS || 1000) },
    index: { enabled: env.CHASQUI_INDEX === 'on' },
    log: (...a) => console.log(...a),
  });
  return instancia;
}

export default {
  async fetch(request, env, ctx) {
    const estafeta = estafetaDesde(env);
    const url = new URL(request.url);
    let body = null;
    if (request.method === 'POST' || request.method === 'PUT') {
      const len = Number(request.headers.get('content-length') || 0);
      if (len > 2 * 1024 * 1024) return Response.json({ reason: 'cuerpo demasiado grande' }, { status: 413 });
      try { body = await request.json(); } catch { return Response.json({ reason: 'JSON inválido' }, { status: 400 }); }
    }
    const rx = {
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      headers: Object.fromEntries([...request.headers].map(([k, v]) => [k.toLowerCase(), v])),
      body,
      ip: request.headers.get('cf-connecting-ip') || null,
    };
    const out = await estafeta.handleRequest(rx);
    if (out.pending) ctx.waitUntil(out.pending);
    if (out.kick) ctx.waitUntil(estafeta.tick().catch((e) => console.log('tick error', e.message)));
    return Response.json(out.body, { status: out.status });
  },

  async scheduled(_event, env, ctx) {
    const estafeta = estafetaDesde(env);
    ctx.waitUntil(estafeta.tick().catch((e) => console.log('tick error', e.message)));
  },
};
