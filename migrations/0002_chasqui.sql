-- Chasqui/1 — esquema D1 (SQLite). Conviven con las tablas del token-wallet v0 (0001) en la
-- misma base; el Libro de Chasqui es el sucesor del ledger v0 y usa sus propias tablas.
--
-- Los invariantes viven en constraints, no en chequeos de aplicación:
--   diario.n  PRIMARY KEY  -> dos asientos concurrentes con el mismo número: el segundo falla cerrado
--   ops.id    PRIMARY KEY  -> una operación reentregada jamás se ejecuta dos veces
--   contratos.quote_id UNIQUE -> una cotización se acepta una sola vez
--   seen.id   PRIMARY KEY  -> un sobre se procesa una sola vez por destinatario (lista en doc)

CREATE TABLE IF NOT EXISTS chasqui_domain (
  id  INTEGER PRIMARY KEY CHECK (id = 1),
  doc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chasqui_agents (
  local   TEXT PRIMARY KEY,
  doc     TEXT NOT NULL,
  updated TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chasqui_invitations (
  code TEXT PRIMARY KEY,
  doc  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chasqui_seen (
  id  TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chasqui_mailbox (
  local    TEXT NOT NULL,
  id       TEXT NOT NULL,
  doc      TEXT NOT NULL,
  received TEXT NOT NULL,
  acked    TEXT,
  PRIMARY KEY (local, id)
);
CREATE INDEX IF NOT EXISTS idx_chasqui_mailbox_pendiente ON chasqui_mailbox (local, received) WHERE acked IS NULL;

CREATE TABLE IF NOT EXISTS chasqui_queue (
  id            TEXT PRIMARY KEY,
  doc           TEXT NOT NULL,
  next_attempt  TEXT NOT NULL,
  status        TEXT NOT NULL,
  claimed_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chasqui_queue_due ON chasqui_queue (next_attempt) WHERE status IN ('queued','retrying','inflight');

CREATE TABLE IF NOT EXISTS chasqui_outbox (
  local TEXT NOT NULL,
  job   TEXT NOT NULL,
  doc   TEXT NOT NULL,
  PRIMARY KEY (local, job)
);

CREATE TABLE IF NOT EXISTS chasqui_nonces (
  key TEXT PRIMARY KEY,
  ts  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chasqui_pins (
  id  INTEGER PRIMARY KEY CHECK (id = 1),
  doc TEXT NOT NULL
);

-- ===== Libro =====
CREATE TABLE IF NOT EXISTS chasqui_libro_state (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  seq      INTEGER NOT NULL,
  balances TEXT NOT NULL
);
INSERT OR IGNORE INTO chasqui_libro_state (id, seq, balances) VALUES (1, 0, '{}');

CREATE TABLE IF NOT EXISTS chasqui_libro_diario (
  n   INTEGER PRIMARY KEY,
  id  TEXT NOT NULL UNIQUE,
  doc TEXT NOT NULL
);

-- Líneas desnormalizadas del diario: statement/balance por cuenta sin escanear todo.
CREATE TABLE IF NOT EXISTS chasqui_libro_lineas (
  n       INTEGER NOT NULL,
  account TEXT NOT NULL,
  delta   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chasqui_lineas_account ON chasqui_libro_lineas (account, n);

CREATE TABLE IF NOT EXISTS chasqui_libro_contratos (
  id       TEXT PRIMARY KEY,
  quote_id TEXT UNIQUE,
  doc      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chasqui_libro_mandatos (
  id  TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chasqui_libro_ops (
  id  TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);

-- ===== Índice federado =====
CREATE TABLE IF NOT EXISTS chasqui_indice_casas (
  domain TEXT PRIMARY KEY,
  doc    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chasqui_indice_agentes (
  house   TEXT NOT NULL,
  address TEXT NOT NULL,
  doc     TEXT NOT NULL,
  PRIMARY KEY (house, address)
);
