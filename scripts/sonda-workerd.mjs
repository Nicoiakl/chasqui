// Qué criptografía existe de verdad en workerd, el runtime de Cloudflare. No es Node: correr el
// código del edge sobre Node (demo/edge-local.mjs) NO prueba esto. Nació de un defecto real: el
// conector cifraba con diffieHellman de node:crypto, que en workerd no existe.
//
//   cd /tmp && npx wrangler dev <ruta>/scripts/sonda-workerd.mjs --port 8799 \
//     --compatibility-date 2026-08-01 --compatibility-flags nodejs_compat
//   curl localhost:8799
//
// Resultado del 10-sep-2026: node_dh_* ERROR (no existe), web_x25519 ok, web_importa_jwk_de_node ok,
// node_hkdf ok. Correrla otra vez antes de usar una primitiva nueva de node:crypto en el edge.
import nc from 'node:crypto';
export default {
  async fetch() {
    const out = {};
    const probar = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = 'ERROR: ' + e.message; } };
    let a, b;
    await probar('node_generar_x25519', () => { a = nc.generateKeyPairSync('x25519'); b = nc.generateKeyPairSync('x25519'); return 'ok'; });
    await probar('node_exportar_jwk', () => a.publicKey.export({ format: 'jwk' }).x.length);
    await probar('node_dh_objetos', () => nc.diffieHellman({ privateKey: a.privateKey, publicKey: b.publicKey }).length);
    await probar('node_dh_desde_jwk', () => {
      const ja = a.privateKey.export({ format: 'jwk' }), jb = b.publicKey.export({ format: 'jwk' });
      return nc.diffieHellman({ privateKey: nc.createPrivateKey({ key: ja, format: 'jwk' }), publicKey: nc.createPublicKey({ key: jb, format: 'jwk' }) }).length;
    });
    await probar('node_hkdf', () => Buffer.from(nc.hkdfSync('sha256', Buffer.alloc(32, 1), Buffer.from('s'), Buffer.from('i'), 32)).length);
    await probar('node_aes_gcm', () => { const c = nc.createCipheriv('aes-256-gcm', Buffer.alloc(32, 2), Buffer.alloc(12, 3)); c.update('x'); c.final(); return c.getAuthTag().length; });
    await probar('web_x25519', async () => {
      const k1 = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
      const k2 = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
      return (await crypto.subtle.deriveBits({ name: 'X25519', public: k2.publicKey }, k1.privateKey, 256)).byteLength;
    });
    await probar('web_importa_jwk_de_node', async () => {
      const ja = a.privateKey.export({ format: 'jwk' }), jb = b.publicKey.export({ format: 'jwk' });
      const pa = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'X25519', x: ja.x, d: ja.d }, { name: 'X25519' }, false, ['deriveBits']);
      const pb = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'X25519', x: jb.x }, { name: 'X25519' }, true, []);
      const web = Buffer.from(await crypto.subtle.deriveBits({ name: 'X25519', public: pb }, pa, 256));
      return web.length;
    });
    await probar('web_hkdf', async () => { const k = await crypto.subtle.importKey('raw', new Uint8Array(32), 'HKDF', false, ['deriveBits']); return (await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(1), info: new Uint8Array(1) }, k, 256)).byteLength; });
    return Response.json(out);
  },
};
