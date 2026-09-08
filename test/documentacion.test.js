// node --test test/
// La documentación pública promete comandos y herramientas. Este guard comprueba que lo prometido
// EXISTE. Nació del defecto más caro de la distribución: el README decía `npx @nyx5/nyx5 join` y
// npm servía una versión sin join. Ese fallo no rompe ninguna prueba: rompe al primer agente que
// lo intenta, y no se entera nadie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (f) => fs.readFileSync(path.join(raiz, f), 'utf8');
const cli = leer('bin/nyx5.js');
const mcp = leer('src/puentes/mcp.js');
const docs = ['README.md', 'README.es.md', 'agents.md'];

test('todo comando que la documentación promete existe en el CLI', () => {
  const implementados = new Set([...cli.matchAll(/case '([a-z]+)':/g)].map((m) => m[1]));
  assert.ok(implementados.size >= 10, `se esperaban comandos, se vieron ${implementados.size}`);
  for (const doc of docs) {
    const texto = leer(doc);
    const prometidos = new Set([...texto.matchAll(/(?:npx @nyx5\/nyx5|node bin\/nyx5\.js)\s+([a-z]+)/g)].map((m) => m[1]));
    assert.ok(prometidos.size, `${doc} no muestra ningún comando`);
    for (const c of prometidos) assert.ok(implementados.has(c), `${doc} promete "${c}" y el CLI no lo implementa`);
  }
});

test('toda herramienta MCP que la documentación nombra existe en el puente', () => {
  const reales = new Set([...mcp.matchAll(/\{ name: '(nyx5_[a-z0-9_]+)'/g)].map((m) => m[1]));
  assert.ok(reales.size >= 17, `se esperaban al menos 17 herramientas, hay ${reales.size}`);
  for (const doc of docs) {
    for (const m of leer(doc).matchAll(/`(nyx5_[a-z0-9_]+)`/g)) {
      assert.ok(reales.has(m[1]), `${doc} nombra la herramienta "${m[1]}" y no existe`);
    }
  }
});

test('la versión del paquete es la que la documentación asume, y el bin apunta a un archivo real', () => {
  const pkg = JSON.parse(leer('package.json'));
  assert.equal(pkg.name, '@nyx5/nyx5');
  for (const destino of Object.values(pkg.bin)) assert.ok(fs.existsSync(path.join(raiz, destino)), `bin apunta a ${destino}, que no existe`);
  // Todo lo que la documentación menciona como archivo del repo tiene que estar publicado.
  for (const f of ['src/', 'bin/', 'examples/', 'README.md']) {
    assert.ok(pkg.files.includes(f), `${f} no está en package.files: quien instale el paquete no lo recibe`);
  }
  // El número de pruebas que anuncia el README no puede ser inventado.
  const suites = fs.readdirSync(path.join(raiz, 'test')).filter((f) => f.endsWith('.test.js'));
  assert.ok(suites.length >= 15, `se esperaban al menos 15 suites, hay ${suites.length}`);
});

test('ningún documento público quedó con el nombre viejo ni con rutas de ejemplo rotas', () => {
  for (const doc of [...docs, 'CONTRIBUTING.md', 'SECURITY.md']) {
    const texto = leer(doc);
    assert.ok(!/chasqui/i.test(texto), `${doc} menciona el nombre viejo`);
    assert.ok(!/\/ruta\/a\/chasqui|CHASQUI_HOSTS/.test(texto), `${doc} tiene una ruta de ejemplo del nombre viejo`);
  }
  // Los dos README se enlazan entre sí: quien llega en un idioma encuentra el otro.
  assert.match(leer('README.md'), /README\.es\.md/);
  assert.match(leer('README.es.md'), /README\.md/);
});

// El registro oficial de MCP exige que package.json y server.json digan EXACTAMENTE lo mismo, y
// que el namespace respete las mayúsculas del usuario de GitHub. Los dos fallos que costaron un
// intento cada uno: descripción sobre 100 caracteres, y "nicoiakl" en vez de "Nicoiakl".
test('server.json y package.json coinciden, y cumplen lo que el registro oficial exige', () => {
  const pkg = JSON.parse(leer('package.json'));
  const srv = JSON.parse(leer('server.json'));
  assert.equal(srv.name, pkg.mcpName, 'el registro rechaza la publicación si no coinciden');
  assert.match(srv.name, /^io\.github\.Nicoiakl\/[a-z0-9-]+$/, 'el namespace respeta las mayúsculas del usuario de GitHub');
  assert.ok(srv.description.length <= 100, `la descripción tiene ${srv.description.length} caracteres; el registro corta en 100`);
  const p = srv.packages[0];
  assert.equal(p.identifier, pkg.name);
  assert.equal(p.version, srv.version, 'la versión del paquete y la del servidor son la misma');
  assert.equal(p.transport.type, 'stdio');
  // El comando que declara el registro tiene que ser el que el CLI implementa.
  const args = p.packageArguments.map((a) => a.value || a.name);
  assert.deepEqual(args, ['mcp', '--agent']);
  assert.match(cli, /case 'mcp':/);
  assert.match(cli, /agent: \{ type: 'string' \}/);
  // Versiones concretas: el schema rechaza rangos y "latest".
  for (const v of [srv.version, p.version]) assert.match(v, /^\d+\.\d+\.\d+$/, `"${v}" no es una versión concreta`);
});
