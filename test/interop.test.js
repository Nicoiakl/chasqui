// node --test test/
// Guard de los mapeos de interoperabilidad (docs/interop/).
//
// La regla que declara docs/interop/README.md es que cada fila de un mapeo dice de qué tipo es:
// equivalent, partial, missing here o missing there. Sirve para poder decir "esto no existe de
// nuestro lado", que es justo lo que un mapeo comercial nunca dice.
//
// Sin este guard la regla es una frase bonita: la primera fila sin veredicto pasa desapercibida y
// el documento empieza a insinuar compatibilidad que nadie puede reproducir. Falla cerrado: solo
// mira las tablas cuya última columna se llama "Verdict", así que una tabla de contexto (versiones,
// fuentes) no la retiene por error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'interop');
const VEREDICTOS = ['equivalent', 'partial', 'missing here', 'missing there'];
const celdas = (linea) => linea.trim().replace(/^\||\|$/g, '').split('|').map((s) => s.trim());
const esSeparador = (l) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.includes('-');

function tablasDeVeredicto(texto) {
  const lineas = texto.split('\n');
  const tablas = [];
  for (let i = 0; i < lineas.length - 1; i++) {
    if (!lineas[i].trim().startsWith('|') || !esSeparador(lineas[i + 1])) continue;
    if (celdas(lineas[i]).at(-1) !== 'Verdict') continue;
    const filas = [];
    for (let j = i + 2; j < lineas.length && lineas[j].trim().startsWith('|'); j++) filas.push({ n: j + 1, celdas: celdas(lineas[j]) });
    tablas.push({ n: i + 1, filas });
  }
  return tablas;
}

const mapeos = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md') : [];

test('hay al menos un mapeo escrito', () => {
  assert.ok(mapeos.length >= 1, 'docs/interop/ no tiene ningún mapeo');
});

test('cada fila de cada tabla de mapeo lleva uno de los cuatro veredictos', () => {
  for (const f of mapeos) {
    const texto = fs.readFileSync(path.join(dir, f), 'utf8');
    const tablas = tablasDeVeredicto(texto);
    assert.ok(tablas.length, `${f} no tiene ninguna tabla con columna "Verdict": no es un mapeo, es prosa`);
    for (const t of tablas) {
      assert.ok(t.filas.length, `${f}: la tabla de la línea ${t.n} está vacía`);
      for (const fila of t.filas) {
        const v = (fila.celdas.at(-1) || '').toLowerCase();
        assert.ok(VEREDICTOS.some((x) => v.includes(x)), `${f}:${fila.n} no declara veredicto: "${fila.celdas.at(-1)}"`);
      }
    }
  }
});

test('cada mapeo dice contra qué versión se comprobó y cuándo', () => {
  for (const f of mapeos) {
    const texto = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.match(texto, /Checked against/i, `${f} no dice contra qué versión se comprobó`);
    assert.match(texto, /\b20\d\d-\d\d-\d\d\b/, `${f} no lleva fecha de comprobación`);
  }
});

test('ningún mapeo afirma conformidad: lo que se reclama y lo que no queda escrito', () => {
  for (const f of mapeos) {
    const texto = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.match(texto, /We do not claim/i, `${f} no dice qué NO reclama`);
  }
});

test('el README de interop lista todo mapeo que existe', () => {
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  for (const f of mapeos) assert.ok(readme.includes(f), `${f} existe y el índice de interop no lo nombra`);
});
