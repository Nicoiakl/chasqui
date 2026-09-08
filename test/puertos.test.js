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
  const propio = path.basename(fileURLToPath(import.meta.url));
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.test.js') && f !== propio)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // Solo declaraciones de puerto (`const P = 4141`, `const P1 = 4121, P2 = ...`),
    // no cualquier número de cuatro cifras que aparezca en el texto.
    const puertos = new Set();
    for (const m of src.matchAll(/\bP\d*\s*=\s*(4\d{3})\b/g)) puertos.add(Number(m[1]));
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
});
