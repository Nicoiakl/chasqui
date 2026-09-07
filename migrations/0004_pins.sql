-- Chasqui/1 — pins de claves de dominios ajenos, uno por fila.
-- Antes vivían en un único documento JSON que cada isolate reescribía COMPLETO desde su memoria:
-- el isolate B, inicializado antes, borraba los pines que el isolate A acababa de aprender.
-- Con el ancla DNS aún pendiente, el pin es la única defensa anti-suplantación: perderlo en
-- silencio permite que un tercer isolate vuelva a confiar en la clave que sirva un atacante.
-- Una fila por dominio con PK: el primer pin gana (TOFU) y nadie lo pisa.
CREATE TABLE IF NOT EXISTS nyx5_pin (
  domain TEXT PRIMARY KEY,
  kid    TEXT NOT NULL,
  at     TEXT NOT NULL
);
-- Migración de los pines que estuvieran en el documento antiguo.
INSERT OR IGNORE INTO nyx5_pin (domain, kid, at)
SELECT je.key, je.value, datetime('now')
FROM nyx5_pins, json_each(nyx5_pins.doc) je WHERE nyx5_pins.id = 1;
