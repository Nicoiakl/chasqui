// Genera la imagen que se ve cuando alguien comparte un enlace de nyx5.com (og:image), como PNG
// y sin dependencias. Escribe src/plataformas/og-png.js con los bytes en base64.
//
//   node scripts/build-og.mjs
//
// Por qué a mano y no un SVG: los servicios que renderizan una vista previa (WhatsApp, Slack,
// LinkedIn, X) no aceptan SVG de forma fiable, así que un og:image en SVG equivale a no tener
// ninguno. Y por qué sin librerías: el proyecto tiene cero dependencias y esa regla no se rompe
// por una imagen. PNG es un formato simple de escribir: cabecera, datos filtrados y comprimidos
// con zlib (que Node trae), y un CRC por trozo.
//
// El texto se dibuja con una tipografía de bloques definida aquí abajo. Solo hacen falta unas
// pocas letras, así que no hay que cargar ninguna fuente ni medir nada.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = 1200, H = 630;

// Tipografía de bloques 5x7. Cada fila es una cadena de 5 caracteres: '#' pinta, ' ' no.
const GLIFOS = {
  n: [' ', ' ', '# ## ', '##  #', '#   #', '#   #', '#   #'],
  y: [' ', ' ', '#   #', '#   #', ' ####', '    #', ' ### '],
  x: [' ', ' ', '#   #', ' # # ', '  #  ', ' # # ', '#   #'],
  5: ['#####', '#    ', '#### ', '    #', '    #', '#   #', ' ### '],
  a: [' ', ' ', ' ### ', '    #', ' ####', '#   #', ' ####'],
  d: ['    #', '    #', ' ####', '#   #', '#   #', '#   #', ' ####'],
  r: [' ', ' ', '# ###', '##   ', '#    ', '#    ', '#    '],
  e: [' ', ' ', ' ### ', '#   #', '#####', '#    ', ' ### '],
  s: [' ', ' ', ' ####', '#    ', ' ### ', '    #', '#### '],
  c: [' ', ' ', ' ####', '#    ', '#    ', '#    ', ' ####'],
  o: [' ', ' ', ' ### ', '#   #', '#   #', '#   #', ' ### '],
  t: ['  #  ', '  #  ', '#####', '  #  ', '  #  ', '  #  ', '   ##'],
  i: ['  #  ', '     ', ' ##  ', '  #  ', '  #  ', '  #  ', ' ### '],
  m: [' ', ' ', '## # ', '# # #', '# # #', '# # #', '# # #'],
  g: [' ', ' ', ' ####', '#   #', ' ####', '    #', ' ### '],
  h: ['#    ', '#    ', '# ## ', '##  #', '#   #', '#   #', '#   #'],
  l: [' ##  ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
  b: ['#    ', '#    ', '#### ', '#   #', '#   #', '#   #', '#### '],
  k: ['#    ', '#    ', '#   #', '#  # ', '###  ', '#  # ', '#   #'],
  u: [' ', ' ', '#   #', '#   #', '#   #', '#   #', ' ####'],
  p: [' ', ' ', '#### ', '#   #', '#### ', '#    ', '#    '],
  v: [' ', ' ', '#   #', '#   #', '#   #', ' # # ', '  #  '],
  f: ['  ###', ' #   ', '#####', ' #   ', ' #   ', ' #   ', ' #   '],
  j: ['   ##', '     ', '   ##', '    #', '    #', '#   #', ' ### '],
  w: [' ', ' ', '#   #', '#   #', '# # #', '## ##', '#   #'],
  '.': [' ', ' ', ' ', ' ', ' ', ' ', '  #  '],
  ' ': [' ', ' ', ' ', ' ', ' ', ' ', ' '],
};

const lienzo = Buffer.alloc(W * H * 3);
const pintar = (x, y, [r, g, b]) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  lienzo[i] = r; lienzo[i + 1] = g; lienzo[i + 2] = b;
};
const rect = (x, y, w, h, color) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) pintar(x + i, y + j, color); };

// Escribe un texto con la tipografía de bloques. `escala` es el tamaño de cada bloque en píxeles.
function texto(cadena, x, y, escala, color) {
  let cx = x;
  for (const ch of cadena.toLowerCase()) {
    const g = GLIFOS[ch];
    if (!g) { cx += 6 * escala; continue; }
    for (let fila = 0; fila < 7; fila++) {
      const linea = (g[fila] || '').padEnd(5, ' ');
      for (let col = 0; col < 5; col++) if (linea[col] === '#') rect(cx + col * escala, y + fila * escala, escala, escala, color);
    }
    cx += 6 * escala;
  }
  return cx;
}

// Ancho que ocupará un texto: sirve para NO dibujar fuera del lienzo. Sin medir, "mailbox" y
// "agent" se salían por la derecha y la imagen que veía quien compartía el enlace estaba cortada.
const ancho = (cadena, escala) => cadena.length * 6 * escala;
// Dibuja ajustando la escala si no cabe en el ancho disponible, en vez de desbordar en silencio.
function textoCabiendo(cadena, x, y, escala, color, maxAncho) {
  let e = escala;
  while (e > 1 && ancho(cadena, e) > maxAncho) e -= 1;
  texto(cadena, x, y, e, color);
  return e;
}

const FONDO = [0x0c, 0x0c, 0x10];
const TINTA = [0xee, 0xec, 0xf4];
const ACENTO = [0x9b, 0x8c, 0xff];
const TENUE = [0x8f, 0x8c, 0xa0];

rect(0, 0, W, H, FONDO);

const MARGEN = 90;
const UTIL = W - MARGEN * 2;
texto('nyx5', MARGEN, 120, 20, ACENTO);
rect(MARGEN, 300, 220, 5, ACENTO);
textoCabiendo('an address a mailbox', MARGEN, 350, 10, TINTA, UTIL);
textoCabiendo('and a ledger for your agent', MARGEN, 425, 10, TINTA, UTIL);
textoCabiendo('npx nyx5 join', MARGEN, 530, 8, TENUE, UTIL);

// Comprobación dura: si algo se sale del lienzo, la imagen que ve quien comparte está rota y
// nadie lo nota hasta que ya circuló. Mejor fallar aquí.
for (const [t, e] of [['nyx5', 20], ['an address a mailbox', 10], ['and a ledger for your agent', 10], ['npx nyx5 join', 8]]) {
  let esc = e; while (esc > 1 && ancho(t, esc) > UTIL) esc -= 1;
  if (MARGEN + ancho(t, esc) > W) throw new Error(`"${t}" se sale del lienzo (${MARGEN + ancho(t, esc)} > ${W})`);
}

// ---- PNG: cabecera, IHDR, IDAT (filtro 0 por fila) e IEND ----
const crcTabla = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
const crc32 = (buf) => { let c = -1; for (const b of buf) c = crcTabla[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const trozo = (tipo, datos) => {
  const largo = Buffer.alloc(4); largo.writeUInt32BE(datos.length);
  const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), datos]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(cuerpo));
  return Buffer.concat([largo, cuerpo, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;  // 8 bits, RGB truecolor
const filas = Buffer.alloc(H * (W * 3 + 1));
for (let y = 0; y < H; y++) {
  filas[y * (W * 3 + 1)] = 0;                                        // filtro None
  lienzo.copy(filas, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  trozo('IHDR', ihdr),
  trozo('IDAT', zlib.deflateSync(filas, { level: 9 })),
  trozo('IEND', Buffer.alloc(0)),
]);

fs.writeFileSync(path.join(root, 'docs/site/og.png'), png);
fs.writeFileSync(path.join(root, 'src/plataformas/og-png.js'),
  `// GENERADO por scripts/build-og.mjs — no editar a mano.\nexport const OG_PNG_B64 = ${JSON.stringify(png.toString('base64'))};\n`);
console.log(`og:image generada: ${W}x${H}, ${(png.length / 1024).toFixed(1)} KB`);
