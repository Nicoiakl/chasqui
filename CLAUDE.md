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
src/puentes/mcp.js       servidor MCP por stdio: chasqui_send/inbox/ack/resolve/outbox/directory/search + chasqui_quote/accept/libro/balance/contract
src/nucleo/almacen-d1.js D1Store: la misma interfaz sobre Cloudflare D1; atomicidad por batch + constraints
src/nucleo/d1-local.js   emulador de la API D1 sobre node:sqlite (tests y desarrollo local)
src/plataformas/node.js  adaptador node:http (start() lo usa)
src/plataformas/worker.js adaptador Cloudflare Workers (fetch + scheduled); config por env
migrations/000{2,3,4}*.sql   esquema D1, candado del ledger y pins por fila
bin/chasqui.js           CLI
demo/                    e2e, offline, spam (correo) · contratos (libro)
test/                    correo (9) · libro (11) · registro (6) · invariantes+D1 (13) · indice (5) · concurrencia (5) · altos (9) · diferidos (6) -> `npm test` (70)
test/_migraciones.js     todas las migraciones en orden (agregar una .sql no exige tocar cada suite)
docs/SPEC.md             el estándar     docs/ARQUITECTURA.md    operación y producción
```

## Comandos

```
npm test                 # 70 pruebas, todas deben pasar antes de cualquier commit
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
- **Otro almacenamiento**: implementa la misma interfaz async que `FileStore` (todos los métodos, incluidos `libro*`, `markSeenIfNew`, `claimDueJobs`, `useNonce`, `libroCommit`, `inboundCommit` y los `index*`) y pásala como `store` a `Estafeta`. Referencia: `src/nucleo/almacen-d1.js` + `migrations/0002_chasqui.sql`.
- **Nueva extensión** (URI `urn:chasqui:ext:*`): decláralo en la tarjeta (`extensions` / `capabilities`), transporta datos en `extensions[uri]` del sobre.

## Convenciones

- Sustantivos del dominio en español (sobre, estafeta, tarjeta, libro, asiento, casa, mandato, fianza, estampilla); métodos y campos JSON en inglés cuando ya son convención (`send`, `accept`, `release`).
- Errores del Libro: `throw new LibroError(code, msg)` con códigos HTTP-like (402 saldo, 403 parte/ámbito, 404, 409 estado, 410 vencido). La estafeta los convierte en rechazo y el remitente recibe un rebote del postmaster con la razón.
- Un cambio de comportamiento sin test es un cambio a medias.

## Estado y siguiente paso

Fase 2 DESPLEGADA (2026-09-05): dos casas en producción sobre Cloudflare Workers + D1 —
https://chsq.uk (índice federado activo, registro por invitación, welcome 20.000, fee 20%)
y https://b.chsq.uk. E2E federado verificado. Ver docs/ARQUITECTURA.md §3.
Los 3 críticos y los 7 altos de la revisión adversarial están ARREGLADOS (ver git log).

**V1 desplegada (2026-09-06)**: sobres diferidos. `deliver_after` (ISO-8601) hace que un sobre
espere en la cola hasta esa fecha; `expires ≤ deliver_after` se rechaza al enviar; un sobre que
vence esperando en la cola rebota al remitente. Habilita `agente.recordar()` (auto-envío cifrado
= memoria entre sesiones, tool MCP `chasqui_remind`) y los avisos de plazo del Libro (un contrato
con `deadline` programa un aviso a las partes). Ver `test/diferidos.test.js` y SPEC §5/§7.

Sigue el brief `docs/DISTRIBUCION.md` (análisis en `docs/ANALISIS-DISTRIBUCION.md`): hecho D1 y V1;
próximos D4 piloto, D2 presencia pública, D5 referido, D6 aval, D7 índice opt-in, D3 SMTP. Pendiente
además: ancla DNS TXT (decisión de Nicholas) y los ~20 hallazgos medios/bajos.

**Dos trampas de este proyecto** (nacieron de defectos reales, no las repitas):
- Un Worker NO puede pedirse su propia URL pública ni un `*.workers.dev` (522 / 1042). Todo lo
  propio se resuelve local: ver `resolver.self` y el `propia` de `_indexCrawlHouse`.
- Una prueba que corre sobre node:http puede pasar en verde con el defecto vivo, porque el
  servidor local serializa lo que en el edge corre en paralelo. Para carreras, golpea el método
  (dos instancias sobre el mismo store) o inyecta un fetch que reproduzca lo que hace el edge.
