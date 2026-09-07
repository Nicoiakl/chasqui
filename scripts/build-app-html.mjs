// Genera src/plataformas/app-html.js desde web/app.html (el HTML no se edita a mano; §6).
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'web/app.html'), 'utf8');
fs.writeFileSync(path.join(root, 'src/plataformas/app-html.js'),
  '// Generado desde web/app.html — NO editar a mano; edita el .html y regenera (node scripts/build-app-html.mjs).\n' +
  'export const APP_HTML = ' + JSON.stringify(html) + ';\n');
console.log('app-html.js regenerado:', (html.length/1024).toFixed(1), 'KB');
