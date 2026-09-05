// D1 local: la API de Cloudflare D1 sobre node:sqlite (Node 20+ con --experimental-sqlite, 22.5+ nativo).
// Para tests y desarrollo: la misma D1Store corre aquí y en el edge sin cambiar una línea.
// Cubre el subconjunto que usa la D1Store: prepare().bind().first()/all()/run()/raw(), batch(), exec().

import { DatabaseSync } from 'node:sqlite';

class D1PreparedLocal {
  constructor(raw, sql, params = []) {
    this.raw = raw;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new D1PreparedLocal(this.raw, this.sql, params.map(normalize));
  }
  async first(column) {
    const row = this.raw.prepare(this.sql).get(...this.params) ?? null;
    if (row === null) return null;
    return column === undefined ? row : (row[column] ?? null);
  }
  async all() {
    const results = this.raw.prepare(this.sql).all(...this.params);
    return { results, success: true, meta: {} };
  }
  async run() {
    const info = this.raw.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
  async raw({ columnNames = false } = {}) {
    const stmt = this.raw.prepare(this.sql);
    const rows = stmt.all(...this.params);
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const values = rows.map(r => cols.map(c => r[c]));
    return columnNames ? [cols, ...values] : values;
  }
}

function normalize(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

export function openLocalD1(path = ':memory:') {
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys = ON');
  return {
    prepare: (sql) => new D1PreparedLocal(raw, sql),
    async batch(statements) {
      // D1 aplica el batch de forma atomica; aqui igual: una transaccion.
      raw.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
    async exec(sql) {
      raw.exec(sql);
      return { count: sql.split(';').filter(s => s.trim()).length, duration: 0 };
    },
    _raw: raw,
  };
}
