// Construye el bundle .mcpb: un zip con el manifiesto y el servidor dentro, que un cliente MCP
// instala de un doble clic y sin depender de npx ni de la red.
//
//   node scripts/build-mcpb.mjs [--version 0.4.0] [--out ./dist]
//
// Por qué se empaqueta el código en vez de invocar `npx @nyx5/nyx5`: el manifiesto EXIGE que
// `entry_point` exista dentro del bundle (el empaquetador lo comprueba y falla si no), y no hay
// garantía documentada de que `npx` esté en el PATH del proceso que lanza el cliente, ni de que
// haya red en el primer arranque. Con cero dependencias, copiar `bin/` y `src/` basta: no hay
// node_modules que traer.
//
// El manifiesto NO declara el bloque `tools` a propósito: el CLI de Smithery reenvía esos tools
// al registro como herramientas MCP (que exigen inputSchema) mientras el esquema del bundle
// prohíbe inputSchema, y la publicación falla con un 400. Las herramientas ya las lista el
// servidor por `tools/list`, que es donde el cliente las lee de verdad.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const version = arg('version', pkg.version);
const outDir = path.resolve(root, arg('out', 'dist'));
const trabajo = path.join(outDir, `mcpb-${version}`);

fs.rmSync(trabajo, { recursive: true, force: true });
fs.mkdirSync(path.join(trabajo, 'server'), { recursive: true });

// El código sale del repositorio, no de npm: así el bundle se puede construir y probar antes
// de publicar la versión, y lo que se empaqueta es exactamente lo que se acaba de verificar.
for (const dir of ['bin', 'src', 'migrations']) {
  fs.cpSync(path.join(root, dir), path.join(trabajo, 'server', dir), { recursive: true });
}
for (const f of ['package.json', 'LICENSE', 'README.md']) {
  if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(trabajo, 'server', f));
}

const manifest = {
  manifest_version: '0.3',
  name: 'nyx5',
  display_name: 'Nyx5',
  version,
  description: 'An address, a mailbox and a ledger for your agent, where a claim costs something.',
  long_description: 'Nyx5 gives an AI agent an agent@domain address, a store-and-forward mailbox that holds while it is off, and a ledger where an agreement carries weight. Payment is held until a deterministic check passes, a false claim forfeits its bond, and reputation is a public query on the ledger rather than a score. Create your agent key first with: npx -y @nyx5/nyx5 join',
  author: { name: 'Nicolas Iakl', url: 'https://nyx5.com' },
  repository: { type: 'git', url: 'https://github.com/Nicoiakl/nyx5.git' },
  homepage: 'https://nyx5.com',
  documentation: 'https://nyx5.com/spec',
  support: 'https://github.com/Nicoiakl/nyx5/issues',
  server: {
    type: 'node',
    entry_point: 'server/bin/nyx5.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/bin/nyx5.js', 'mcp', '--agent', '${user_config.agent_key}'],
      env: {},
    },
  },
  user_config: {
    agent_key: {
      type: 'file',
      title: 'Agent key file',
      description: 'Path to your Nyx5 agent key file. Create one first by running: npx -y @nyx5/nyx5 join',
      required: true,
    },
  },
  keywords: ['agents', 'mcp', 'mailbox', 'ledger', 'escrow', 'reputation', 'agent-identity'],
  license: 'Apache-2.0',
  compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: '>=20.0.0' } },
};
fs.writeFileSync(path.join(trabajo, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const salida = path.join(outDir, `nyx5-${version}.mcpb`);
const mcpb = (...a) => execFileSync('npx', ['-y', '@anthropic-ai/mcpb@latest', ...a], { cwd: trabajo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
mcpb('validate', 'manifest.json');
mcpb('pack', '.', salida);

const bytes = fs.statSync(salida).size;
console.log(`bundle: ${salida} (${(bytes / 1024).toFixed(1)} KB, versión ${version})`);
console.log('probarlo:  unzip -q ' + salida + ' -d /tmp/nyx5-mcpb && node /tmp/nyx5-mcpb/server/bin/nyx5.js mcp --agent <llave>');
console.log('publicar:  smithery auth login && smithery mcp publish ' + salida + ' -n <namespace>/nyx5');
