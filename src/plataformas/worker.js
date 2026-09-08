// Nyx5/1 — Adaptador Cloudflare Workers: la misma Estafeta, en el edge.
//
//   fetch     -> handleRequest(rx); los ticks post-respuesta van por ctx.waitUntil
//   scheduled -> tick() (cola de reintentos + rastreo del índice federado)
//
// Configuración por variables (wrangler.toml / secrets). Los nombres NYX5_* mandan;
// los CHASQUI_* se siguen leyendo como respaldo para no romper un despliegue viejo.
//   NYX5_DOMAIN        dominio de la casa (ej: nyx5.com)
//   NYX5_PUBLIC_URL    URL pública de la estafeta (https://<NYX5_DOMAIN>)
//   NYX5_ADMIN_TOKEN   token de administración (secret; write-only)
//   NYX5_REGISTRATION  admin | invite | open        (default invite)
//   NYX5_WELCOME       tokens de regalo de bienvenida (default 0)
//   NYX5_FEE_BPS       fee de la casa en basis points (default 1000 = 10%)
//   NYX5_INDEX         'on' para operar el índice federado (default off)
//   NYX5_EMAIL         'on' para habilitar el puente de correo
//   DB                    binding D1

import { Estafeta } from '../correo/estafeta.js';
import { D1Store } from '../nucleo/almacen-d1.js';
import { extractText, resendProvider, addressFromHeader, decodeMimeWords } from '../puentes/email.js';

let instancia = null;
function estafetaDesde(env) {
  if (instancia) return instancia;
  // Salida de correo: solo si hay proveedor + remitente verificado. Sin eso, la salida queda pendiente.
  const provider = resendProvider({ apiKey: env.RESEND_KEY, sender: env.EMAIL_SENDER });
  // NYX5_* manda; CHASQUI_* queda como respaldo (rename de sep-2026, ver docs/ARQUITECTURA.md).
  const cfg = (nombre) => env[`NYX5_${nombre}`] ?? env[`CHASQUI_${nombre}`];
  const domain = cfg('DOMAIN');
  instancia = new Estafeta({
    domain,
    publicUrl: cfg('PUBLIC_URL') || `https://${domain}`,
    adminToken: cfg('ADMIN_TOKEN'),
    store: new D1Store(env.DB),
    policy: { registration: cfg('REGISTRATION') || 'invite' },
    libro: { welcome: Number(cfg('WELCOME') || 0), feeBps: Number(cfg('FEE_BPS') || 1000) },
    index: { enabled: cfg('INDEX') === 'on' },
    email: { enabled: cfg('EMAIL') === 'on' || !!provider, provider },
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
    if (out.contentType) return new Response(out.body, { status: out.status, headers: { 'content-type': out.contentType } });
    return Response.json(out.body, { status: out.status });
  },

  async scheduled(_event, env, ctx) {
    const estafeta = estafetaDesde(env);
    ctx.waitUntil(estafeta.tick().catch((e) => console.log('tick error', e.message)));
  },

  // ENTRADA del puente de correo (Cloudflare Email Workers): un email real a agente@casa entra al
  // buzón como sobre sin firma, marcado from_verified:false. Se activa cuando la casa enruta su
  // dominio a este Worker en Email Routing; hasta entonces, este handler no se invoca.
  async email(message, env, ctx) {
    const estafeta = estafetaDesde(env);
    let raw = '';
    try { raw = await new Response(message.raw).text(); } catch { /* sin cuerpo legible */ }
    const r = await estafeta.receiveEmail({
      // El remitente que se muestra es el del header From (el humano real); message.from es el
      // return-path del envelope (a veces la dirección de rebote del proveedor), sirve de respaldo.
      from: addressFromHeader(message.headers.get('from')) || message.from,
      to: message.to,
      subject: decodeMimeWords(message.headers.get('subject') || ''),
      text: extractText(raw),
      messageId: (message.headers.get('message-id') || '').replace(/[<>]/g, '').slice(0, 128) || undefined,
    });
    if (!r.ok && !r.duplicate) message.setReject(r.reason || 'no aceptado');
  },
};
