# Chasqui — guía para Claude Code

Este repositorio es **un solo sistema** con dos componentes que comparten identidad, transporte y
almacenamiento. No son dos productos compatibles: son las dos mitades de la misma pieza.

| Componente | Nombre | Qué es | Análogo humano |
|---|---|---|---|
| Correo | `src/correo/` | direcciones `agente@dominio`, tarjetas, sobres firmados y cifrados, buzón store-and-forward, estafeta | el email |
| Libro | `src/libro/` | ledger de doble entrada de cada casa, cotizaciones, contratos (spot, escrow, fianza, medido), mandatos en cadena, estampillas | el banco |

Lo que los vuelve una sola pieza:
- **Una identidad.** El Libro no tiene login: toda operación es un sobre firmado a `libro@<casa>`. La cadena de confianza del Correo (DNS → dominio → agente → sobre) es la autenticación del Libro.
- **Un transporte.** Cotizaciones, aceptaciones y recibos son sobres. El recibo firmado por la casa llega al buzón como cualquier carta.
- **Un servidor.** La `Estafeta` aloja ambos: `src/correo/estafeta.js` instancia `Libro` y le entrega los sobres dirigidos a `libro@`.
- **Un almacén.** `src/nucleo/almacen.js` guarda buzones, cola, tarjetas y también diario, contratos y mandatos.

## Mapa

```
src/nucleo/crypto.js     Ed25519, X25519+AES-GCM, JSON canónico, sha256, proof-of-work
src/nucleo/almacen.js    FileStore: correo (agents, mailbox, queue, outbox, seen) + libro (diario, contratos, mandatos, ops)
src/correo/resolver.js   dirección -> tarjeta verificada (DNS TXT / well-known / override), pins, caché, rotación, cadena de delegación
src/correo/politica.js   validación de sobres; políticas de buzón: open | allowlist | pow | stamp; rate limit
src/correo/estafeta.js   servidor HTTP de un dominio: tarjetas, registro (admin|invite|open, prueba de posesión, reservados, invitaciones, directorio), /outbound (cola+reintentos), /inbound (verificación+política), buzones, webhooks, rutas /libro/*
src/correo/agente.js     cliente: register (admin|invite|open), rotateKeys, directory, send, inbox, open, ack, reply, receipt, delegate, quote, accept, deliver, release, refund, bond, forfeit, mandate, charge, revoke, balance, contract
src/libro/libro.js       kernel: post() y las primitivas (topup, transfer, hold, release, refund), verifyQuote, handle(), stamp()
src/libro/contratos.js   máquinas de estado sobre el kernel: ops {accept, deliver, release, refund, bond, forfeit, mandate, charge, revoke, balance, statement, contract}; CONTRATOS {spot, escrow, metered, bond}
src/libro/errores.js     LibroError(code, message)
src/puentes/mcp.js       servidor MCP por stdio: chasqui_send/inbox/ack/resolve/outbox/directory + chasqui_quote/accept/libro/balance/contract
bin/chasqui.js           CLI
demo/                    e2e, offline, spam (correo) · contratos (libro)
test/                    correo.test.js (9) · libro.test.js (11) · registro.test.js (6)  -> `npm test`
docs/SPEC.md             el estándar     docs/ARQUITECTURA.md    operación y producción
```

## Comandos

```
npm test                 # 26 pruebas, todas deben pasar antes de cualquier commit
npm run demo             # correo: tarea cifrada, respuesta, acuse
npm run demo:offline     # correo: destino apagado, cola, reintento
npm run demo:spam        # correo: firmas falsas, allowlist, pow, duplicados
npm run demo:contratos   # libro: spot, escrow, fianza, mandato en cadena, delegación, estampilla
node bin/chasqui.js      # ayuda de la CLI
```

Node 20+. **Cero dependencias**: no agregues paquetes npm sin una razón que no pueda resolverse con `node:` builtins.

## Invariantes (no se rompen; si una tarea los toca, para y pregunta)

1. Sin firma verificable no hay entrega. `inbound` rechaza antes de mirar contenido.
2. El Libro solo se opera por sobres firmados a `libro@` o por lecturas autenticadas con la misma firma. Nunca por un endpoint sin firma.
3. Todo asiento cuadra (suma de deltas = 0), va firmado por la casa, y nadie salvo `casa@` queda en negativo.
4. Idempotencia por `id` de sobre: reentregar nunca duplica buzón ni asiento.
5. Los recibos llevan hash del sobre que los causó (`sha256` / `op_sha256` / `cotizacion_sha256`).
6. Un delegado nunca tiene más ámbito que su padre (tarjetas) ni más tope que el mandato del que cuelga (Libro).
7. Los campos desconocidos se conservan y se firman, pero se ignoran. Versión explícita `chasqui: "1"`.
8. El contenido cifrado no lo lee la estafeta. Las cotizaciones viajan cifradas; solo se muestran al Libro al aceptar.
9. Nadie registra una clave que no controla (prueba de posesión), nadie pisa un nombre ajeno, y los nombres de sistema están reservados.

## Cómo extender

- **Nuevo contrato**: agrega la op a `contratos.js` (`ops.<nombre>`) y, si se cotiza, `CONTRATOS.<kind>` con `onAccept`. No toques `libro.js`. Agrega un test en `test/libro.test.js`.
- **Nueva política de buzón**: `politica.js` (`applyInboxPolicy`) y, si necesita Libro, el bloque `p.stamp` en `estafeta.inbound` es el modelo.
- **Otro almacenamiento**: implementa la misma interfaz que `FileStore` (todos los métodos, incluidos `libro*`) y pásala como `store` a `Estafeta`. Esquema SQL sugerido en `docs/ARQUITECTURA.md`.
- **Nueva extensión** (URI `urn:chasqui:ext:*`): decláralo en la tarjeta (`extensions` / `capabilities`), transporta datos en `extensions[uri]` del sobre.

## Convenciones

- Sustantivos del dominio en español (sobre, estafeta, tarjeta, libro, asiento, casa, mandato, fianza, estampilla); métodos y campos JSON en inglés cuando ya son convención (`send`, `accept`, `release`).
- Errores del Libro: `throw new LibroError(code, msg)` con códigos HTTP-like (402 saldo, 403 parte/ámbito, 404, 409 estado, 410 vencido). La estafeta los convierte en rechazo y el remitente recibe un rebote del postmaster con la razón.
- Un cambio de comportamiento sin test es un cambio a medias.

## Estado y siguiente paso

Fase 0 completa (referencia local). Siguiente: `PostgresStore`/D1 para la estafeta de producción y DNS de `sigo.uk`. Hoja de ruta en `docs/ARQUITECTURA.md` sección 6.
