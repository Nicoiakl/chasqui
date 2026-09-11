-- 0006 · El puente remoto (conector MCP por HTTP con OAuth) y el historial de conversación.
--
-- nyx5_kv: clientes OAuth registrados, códigos de un solo uso, tokens (sólo su hash, nunca el
-- token) y la bóveda de llaves de subagentes delegados, cifradas con NYX5_VAULT_KEY. Es una tabla
-- genérica con vencimiento porque son cinco colecciones pequeñas con la misma forma: una clave,
-- un documento y el momento en que deja de valer. `expires` va en milisegundos; NULL no vence.
CREATE TABLE IF NOT EXISTS nyx5_kv (
  ns      TEXT NOT NULL,
  key     TEXT NOT NULL,
  doc     TEXT NOT NULL,
  expires INTEGER,
  created TEXT NOT NULL,
  PRIMARY KEY (ns, key)
);
CREATE INDEX IF NOT EXISTS idx_nyx5_kv_expires ON nyx5_kv (expires) WHERE expires IS NOT NULL;

-- Historial: el índice que ya existía sólo cubre lo pendiente (acked IS NULL). Una conversación
-- se lee entera, incluido lo que ya se confirmó; sin esto, leerla recorre el buzón completo.
CREATE INDEX IF NOT EXISTS idx_nyx5_mailbox_historial ON nyx5_mailbox (local, received);
