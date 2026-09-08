-- Instrumentación mínima del sprint join/mandate/verifica. Sin esto, la distribución es ciega:
-- no se sabe si llegan agentes (join), si alguien les pone presupuesto (mandate_created), ni
-- si el mecanismo se ejerce de verdad (escrow_released, bond_forfeited).
--
-- Qué NO se guarda, a propósito: contenido de sobres, direcciones de correo humanas, IPs.
-- Un evento lleva el nombre, la fecha, el actor (dirección del agente, que ya es pública) y
-- un puñado de datos numéricos. Sirve para contar, no para perfilar.
CREATE TABLE IF NOT EXISTS nyx5_eventos (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  ts      TEXT NOT NULL,
  actor   TEXT,
  data    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS nyx5_eventos_name_ts ON nyx5_eventos (name, ts);
CREATE INDEX IF NOT EXISTS nyx5_eventos_ts ON nyx5_eventos (ts);
