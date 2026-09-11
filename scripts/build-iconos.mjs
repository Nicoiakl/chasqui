// Genera los íconos de la app para la pantalla de inicio (PNG, sin dependencias) y los escribe en
// src/plataformas/iconos.js como base64.
//
//   node scripts/build-iconos.mjs
//
// Por qué importan: en iPhone, Safari BORRA lo que una página guarda (incluida la llave del agente)
// si pasan siete días sin abrirla. Una app agregada a la pantalla de inicio está exenta. Sin ícono,
// iOS pone una captura borrosa y la gente no la agrega. iOS pide /apple-touch-icon.png solo.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONDO = [0x12, 0xa5, 0x94], TINTA = [0xff, 0xff, 0xff];
// Bloques 5x7, los mismos glifos que la imagen de compartir (scripts/build-og.mjs).
const GLIFOS = {
  n: ['     ', '     ', '# ## ', '##  #', '#   #', '#   #', '#   #'],
  5: ['#####', '#    ', '#### ', '    #', '    #', '#   #', ' ### '],
};

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function trozo(tipo, datos) {
  const len = Buffer.alloc(4); len.writeUInt32BE(datos.length);
  const td = Buffer.concat([Buffer.from(tipo), datos]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function icono(S) {
  const px = Buffer.alloc(S * S * 3);
  for (let i = 0; i < S * S; i++) px.set(FONDO, i * 3);
  // "n5" centrado: 11 columnas de bloque (5 + 1 de aire + 5) por 7 filas, con márgenes generosos
  // porque iOS recorta las esquinas del ícono.
  const b = Math.floor((S * 0.56) / 11);
  const x0 = Math.floor((S - 11 * b) / 2), y0 = Math.floor((S - 7 * b) / 2);
  const pintar = (g, dx) => GLIFOS[g].forEach((fila, fy) => [...fila].forEach((ch, fx) => {
    if (ch !== '#') return;
    for (let y = 0; y < b; y++) for (let x = 0; x < b; x++) px.set(TINTA, ((y0 + fy * b + y) * S + (x0 + (dx + fx) * b + x)) * 3);
  }));
  pintar('n', 0); pintar(5, 6);
  const filas = Buffer.alloc(S * (S * 3 + 1));
  for (let y = 0; y < S; y++) { filas[y * (S * 3 + 1)] = 0; px.copy(filas, y * (S * 3 + 1) + 1, y * S * 3, (y + 1) * S * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), trozo('IHDR', ihdr), trozo('IDAT', zlib.deflateSync(filas, { level: 9 })), trozo('IEND', Buffer.alloc(0))]);
}

const tamanos = [180, 192, 512];
const lineas = tamanos.map((s) => `  ${s}: '${icono(s).toString('base64')}',`);
fs.writeFileSync(path.join(root, 'src/plataformas/iconos.js'),
  '// Generado por scripts/build-iconos.mjs — NO editar a mano.\n' +
  `export const ICONOS = {\n${lineas.join('\n')}\n};\n`);
console.log('iconos.js:', tamanos.map((s) => `${s}px ${icono(s).length} B`).join(' · '));
