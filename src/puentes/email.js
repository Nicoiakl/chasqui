// Chasqui/1 — Puente de correo electrónico (extensión urn:chasqui:ext:email).
//
// El puente conecta Chasqui con el mundo que ya existe. Dos direcciones:
//   ENTRADA  un email real a agente@casa entra al buzón como un sobre SIN FIRMA, marcado
//            from_verified:false y via:'email'. No se disfraza nunca (invariante 1): entra
//            explícitamente como lo que es, un mensaje externo no verificable.
//   SALIDA   un agente le escribe a una dirección de correo cualquiera; el humano responde por
//            email normal y su respuesta vuelve al buzón del agente (Reply-To = agente@casa).
//
// Este archivo son funciones puras + un adaptador de proveedor HTTP (Resend) que solo actúa si hay
// API key. Sin proveedor, la salida queda pendiente: el puente no inventa un canal que no tiene.

import { uuid } from '../nucleo/crypto.js';

export const EXT_EMAIL = 'urn:chasqui:ext:email';
const iso = () => new Date().toISOString();

// Un email entrante -> el sobre que se deposita en el buzón del destinatario. Sin firma, en claro,
// con el remitente real y el asunto guardados en la extensión. `to` es la dirección Chasqui local.
export function inboundEnvelope({ from, to, subject = '', text = '', messageId } = {}) {
  return {
    chasqui: '1',
    id: (messageId && /^[A-Za-z0-9._:-]{8,128}$/.test(messageId)) ? messageId : uuid(),
    from: `email@${addrDomain(to)}`,          // remitente de pasarela; el real va en la extensión
    to: [to],
    created: iso(),
    type: 'message',
    content: { media: 'text/plain', body: text },
    extensions: { [EXT_EMAIL]: { from, subject, message_id: messageId || null, verified: false } },
    // sin signature: es la marca de que no es un sobre Chasqui firmado
  };
}

function addrDomain(a) { const i = String(a).lastIndexOf('@'); return i > 0 ? a.slice(i + 1) : a; }
export function isEmailAddress(a) { return typeof a === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a); }

// Saca la dirección de un header "Nombre <a@b.com>" o "a@b.com". Para mostrar al remitente real.
export function addressFromHeader(h) {
  if (!h) return null;
  const m = /<([^>]+)>/.exec(h);
  const cand = (m ? m[1] : h).trim();
  return isEmailAddress(cand) ? cand : null;
}

// Decodifica palabras MIME RFC 2047 en headers: =?UTF-8?Q?...?= y =?UTF-8?B?...?= (asuntos con tildes).
export function decodeMimeWords(s) {
  if (!s) return '';
  return String(s).replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, txt) => {
    try {
      if (enc.toUpperCase() === 'B') return Buffer.from(txt, 'base64').toString('utf8');
      const bytes = [];
      const t = txt.replace(/_/g, ' ');
      for (let i = 0; i < t.length; i++) {
        if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.substr(i + 1, 2))) { bytes.push(parseInt(t.substr(i + 1, 2), 16)); i += 2; }
        else bytes.push(t.charCodeAt(i) & 0xff);
      }
      return Buffer.from(bytes).toString('utf8');
    } catch { return txt; }
  }).replace(/\?=\s+=\?/g, '');
}

// El cuerpo para el proveedor de salida. Reply-To = la dirección Chasqui del agente, para que la
// respuesta del humano vuelva por ENTRADA a su buzón.
export function outboundPayload({ fromAgent, to, subject, text }) {
  return {
    from: `${fromAgent}`,              // el proveedor reescribe el envelope-from a su dominio verificado
    reply_to: fromAgent,
    to: [to],
    subject: subject || `Mensaje de ${fromAgent}`,
    text,
  };
}

// Extrae el texto plano de un correo RFC822 crudo, sin dependencias. Best-effort: cubre un solo
// cuerpo text/plain y multipart/* eligiendo la primera parte text/plain, con quoted-printable y
// base64. Lo que no entiende, lo devuelve tal cual: el puente prefiere un cuerpo tosco a ninguno.
export function extractText(raw) {
  const s = String(raw);
  const sep = s.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n';
  const at = s.indexOf(sep);
  const head = at >= 0 ? s.slice(0, at) : s;
  const body = at >= 0 ? s.slice(at + sep.length) : '';
  const H = foldHeaders(head);
  const ctype = H['content-type'] || 'text/plain';
  const mb = /boundary="?([^";\r\n]+)"?/i.exec(ctype);
  if (/multipart\//i.test(ctype) && mb) {
    const parts = body.split(`--${mb[1]}`);
    for (const part of parts) {
      const p2 = part.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n';
      const pi = part.indexOf(p2); if (pi < 0) continue;
      const ph = foldHeaders(part.slice(0, pi));
      if (/text\/plain/i.test(ph['content-type'] || 'text/plain')) {
        return decodeBody(part.slice(pi + p2.length), ph['content-transfer-encoding']).trim();
      }
    }
    return '';
  }
  return decodeBody(body, H['content-transfer-encoding']).trim();
}
function foldHeaders(block) {
  const out = {}; let key = null;
  for (const line of block.split(/\r?\n/)) {
    if (/^\s/.test(line) && key) { out[key] += ' ' + line.trim(); continue; }
    const m = /^([A-Za-z0-9-]+):\s?(.*)$/.exec(line);
    if (m) { key = m[1].toLowerCase(); out[key] = m[2]; }
  }
  return out;
}
function decodeBody(b, cte = '') {
  const enc = String(cte).toLowerCase().trim();
  if (enc === 'base64') { try { return Buffer.from(b.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { return b; } }
  if (enc === 'quoted-printable') {
    const t = b.replace(/=\r?\n/g, ''); const bytes = [];
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.substr(i + 1, 2))) { bytes.push(parseInt(t.substr(i + 1, 2), 16)); i += 2; }
      else bytes.push(t.charCodeAt(i) & 0xff);
    }
    try { return Buffer.from(bytes).toString('utf8'); } catch { return t; }
  }
  return b;
}

// Adaptador Resend (HTTP, sin dependencias): devuelve una función emailOut(payload) o null si no hay key.
// El envelope-from debe ser un dominio verificado en el proveedor; por eso se pasa `sender`.
export function resendProvider({ apiKey, sender, fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey || !sender) return null;
  return async ({ reply_to, to, subject, text }) => {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: sender, reply_to, to, subject, text }),
    });
    if (!res.ok) throw new Error(`proveedor de correo respondió ${res.status}: ${await res.text().catch(() => '')}`);
    return res.json().catch(() => ({}));
  };
}
