// Nyx5/1 — La bóveda: las llaves de los subagentes delegados que la casa guarda para que un
// conector remoto (el Claude de un teléfono) pueda firmar en nombre de ese subagente.
//
// Qué se guarda aquí y qué NO: sólo llaves de subagentes `claude.<dueño>@<casa>`, de alcance
// limitado a mensajes, con vencimiento y revocables por el dueño. La llave raíz de una persona
// nunca pasa por la casa: vive en su navegador y es la que firma la delegación.
//
// Cifrado en reposo con AES-256-GCM y una llave que vive SÓLO en un secret del Worker
// (NYX5_VAULT_KEY). Un volcado de la base no entrega ninguna llave. La AAD amarra cada sello a
// su dueño: una fila copiada bajo otro nombre no abre.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { b64u, unb64u } from './crypto.js';

const AAD = (dueno) => Buffer.from(`nyx5/1 boveda ${dueno}`);

export function abrirBoveda(secreto) {
  if (!secreto) return null;
  const llave = Buffer.from(String(secreto).trim(), 'base64');
  if (llave.length !== 32) throw new Error('NYX5_VAULT_KEY must be exactly 32 bytes, base64-encoded');
  return {
    sellar(obj, dueno) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', llave, iv);
      c.setAAD(AAD(dueno));
      const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj))), c.final()]);
      return `v1.${b64u(iv)}.${b64u(ct)}.${b64u(c.getAuthTag())}`;
    },
    abrir(sello, dueno) {
      const [v, iv, ct, tag] = String(sello).split('.');
      if (v !== 'v1' || !iv || !ct || !tag) throw new Error('unreadable vault seal');
      const d = createDecipheriv('aes-256-gcm', llave, unb64u(iv));
      d.setAAD(AAD(dueno));
      d.setAuthTag(unb64u(tag));
      return JSON.parse(Buffer.concat([d.update(unb64u(ct)), d.final()]).toString());
    },
  };
}
