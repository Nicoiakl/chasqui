// node --test test/
// Guard nacido de un defecto real: dos suites declararon el puerto 4141. Aisladas pasaban
// las dos; con `npm test` (que corre los archivos en paralelo) la segunda se colgaba 45 s
// sin decir por qué. Un choque de puertos no se ve como choque de puertos: se ve como
// "el buzón no recibe". Este chequeo falla cerrado y nombra el archivo culpable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

test('ninguna suite comparte puerto con otra', () => {
  const porArchivo = new Map();
  const contadores = [];
  const BLOQUE = 10;
  const propio = path.basename(fileURLToPath(import.meta.url));
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.test.js') && f !== propio)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // Declaraciones de puerto (`const P = 4141`, `const P1 = 4121, P2 = ...`) Y los derivados
    // de ellas (`P1 + 10`). Lo segundo se agregó después de que un puerto CALCULADO se comiera
    // el guard: indice.test.js abre `P1 + 10` = 4151, que era el puerto de unirse.test.js.
    // En Node 24 los archivos se intercalaban y no chocaban; en Node 20 sí, y CI se colgó.
    const puertos = new Set();
    const base = new Map();
    for (const m of src.matchAll(/\b(P\d*)\s*=\s*(4\d{3})\b/g)) { base.set(m[1], Number(m[2])); puertos.add(Number(m[2])); }
    for (const m of src.matchAll(/\b(P\d*)\s*\+\s*(\d+)\b/g)) {
      const b = base.get(m[1]);
      if (b != null) puertos.add(b + Number(m[2]));
    }
    // Contadores: `let puerto = 4230` y un helper que hace `puerto++` en cada casa que levanta. El
    // contador reserva un bloque que empieza en la base y crece con cada llamada. Nació de un choque
    // real (11-sep-2026): aval.test.js contaba 4230, 4231, 4232 y custodia.test.js declaró 4231. Una de
    // cada dos corridas fallaba en 4 ms y este guard daba verde porque sólo veía constantes.
    for (const m of src.matchAll(/\blet\s+([a-zA-Z_]\w*)\s*=\s*(4\d{3})\s*;/g)) {
      const [, nombre, base] = m;
      if (!new RegExp(`\\b${nombre}\\+\\+`).test(src)) continue;
      const helper = new RegExp(`function\\s+(\\w+)\\s*\\([^)]*\\)\\s*\\{[^}]*?\\b${nombre}\\+\\+`).exec(src)?.[1];
      // Si no se sabe cuántas veces se llama, se reserva el bloque entero: falla cerrado.
      const usos = helper ? (src.match(new RegExp(`\\b${helper}\\(`, 'g')) || []).length - 1 : BLOQUE;
      assert.ok(usos <= BLOQUE, `${f}: el contador ${nombre} levanta ${usos} casas y el bloque es de ${BLOQUE}`);
      for (let i = 0; i < Math.max(usos, 1); i++) puertos.add(Number(base) + i);
      contadores.push(`${f}:${nombre}`);
    }
    if (puertos.size) porArchivo.set(f, puertos);
  }
  const dueno = new Map();
  const choques = [];
  for (const [archivo, puertos] of porArchivo) {
    for (const p of puertos) {
      if (dueno.has(p)) choques.push(`${p}: ${dueno.get(p)} y ${archivo}`);
      else dueno.set(p, archivo);
    }
  }
  assert.deepEqual(choques, [], `puertos repetidos entre suites:\n  ${choques.join('\n  ')}`);
  assert.ok(dueno.size >= 8, `se esperaban puertos declarados en varias suites, se vieron ${dueno.size}`);
  // El guard tiene que estar viendo los calculados: si esta cuenta baja, alguien lo desarmó.
  assert.ok(dueno.has(4151), 'el puerto calculado P1+10 de indice.test.js debe estar contado');
  // Y tiene que estar viendo los contadores: si esta cuenta baja, alguien lo desarmó.
  assert.ok(contadores.length >= 4, `se esperaban al menos 4 contadores de puertos, se vieron ${contadores.length}: ${contadores.join(', ')}`);
});
