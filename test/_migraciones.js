// Todas las migraciones, en orden, leídas del directorio: agregar una nueva no exige tocar
// cada suite (la 0004 se sumó y dos suites quedaron con el esquema viejo hasta que falló todo).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
export const MIGRACIONES = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
