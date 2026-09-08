# Nyx5 — guía para Claude Code

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
src/puentes/mcp.js       servidor MCP por stdio: nyx5_send/inbox/ack/resolve/outbox/directory/search + nyx5_quote/accept/libro/balance/contract
src/nucleo/almacen-d1.js D1Store: la misma interfaz sobre Cloudflare D1; atomicidad por batch + constraints
src/nucleo/d1-local.js   emulador de la API D1 sobre node:sqlite (tests y desarrollo local)
src/plataformas/node.js  adaptador node:http (start() lo usa)
src/plataformas/worker.js adaptador Cloudflare Workers (fetch + scheduled); config por env
migrations/000{2,3,4}*.sql   esquema D1, candado del ledger y pins por fila
bin/nyx5.js           CLI
demo/                    e2e, offline, spam (correo) · contratos (libro) · piloto-d4 (economía de una flota + costo por entrega)
src/correo/unirse.js     join (alta en un paso) y mandate (tope del humano) como funciones testeables
src/libro/verifica.js    evaluador de referencia: http_status | sha256 | exit_0; veredicto y "indeciso"
src/libro/tareas.js      trabajo sembrado: catálogo, cupos por agente/día, y que la cotización coincida
test/                    correo · libro · registro · invariantes+D1 · indice · concurrencia · altos ·
                         diferidos · aval · email · mcp · unirse · verifica · tareas · instrumentacion ·
                         puertos (guard de colisión) -> `npm test` (112)
test/_migraciones.js     todas las migraciones en orden (agregar una .sql no exige tocar cada suite)
docs/SPEC.md             el estándar     docs/ARQUITECTURA.md    operación y producción
```

## Comandos

```
npm test                 # 112 pruebas, todas deben pasar antes de cualquier commit
npm run demo             # correo: tarea cifrada, respuesta, acuse
npm run demo:offline     # correo: destino apagado, cola, reintento
npm run demo:spam        # correo: firmas falsas, allowlist, pow, duplicados
npm run demo:contratos   # libro: spot, escrow, fianza, mandato en cadena, delegación, estampilla
npm run demo:piloto      # D4: una flota con presupuesto, escrow + verificación medida, costo por entrega
node bin/nyx5.js join        # alta en un paso (lo que corre un agente que llega)
node bin/nyx5.js tareas      # catálogo de trabajo sembrado de una casa
node bin/nyx5.js      # ayuda de la CLI
```

Node 20+. **Cero dependencias**: no agregues paquetes npm sin una razón que no pueda resolverse con `node:` builtins.

## Invariantes (no se rompen; si una tarea los toca, para y pregunta)

1. Sin firma verificable no hay entrega. `inbound` rechaza antes de mirar contenido.
2. El Libro solo se opera por sobres firmados a `libro@` o por lecturas autenticadas con la misma firma. Nunca por un endpoint sin firma.
3. Todo asiento cuadra (suma de deltas = 0), va firmado por la casa, y nadie salvo `casa@` queda en negativo.
4. Idempotencia por `id` de sobre: reentregar nunca duplica buzón ni asiento.
5. Los recibos llevan hash del sobre que los causó (`sha256` / `op_sha256` / `cotizacion_sha256`).
6. Un delegado nunca tiene más ámbito que su padre (tarjetas) ni más tope que el mandato del que cuelga (Libro).
7. Los campos desconocidos se conservan y se firman, pero se ignoran. Versión explícita `nyx5: "1"`.
8. El contenido cifrado no lo lee la estafeta. Las cotizaciones viajan cifradas; solo se muestran al Libro al aceptar.
9. Nadie registra una clave que no controla (prueba de posesión), nadie pisa un nombre ajeno, y los nombres de sistema están reservados.

## Cómo extender

- **Nuevo contrato**: agrega la op a `contratos.js` (`ops.<nombre>`) y, si se cotiza, `CONTRATOS.<kind>` con `onAccept`. No toques `libro.js`. Agrega un test en `test/libro.test.js`.
- **Nueva política de buzón**: `politica.js` (`applyInboxPolicy`) y, si necesita Libro, el bloque `p.stamp` en `estafeta.inbound` es el modelo.
- **Otro almacenamiento**: implementa la misma interfaz async que `FileStore` (todos los métodos, incluidos `libro*`, `markSeenIfNew`, `claimDueJobs`, `useNonce`, `libroCommit`, `inboundCommit` y los `index*`) y pásala como `store` a `Estafeta`. Referencia: `src/nucleo/almacen-d1.js` + `migrations/0002_nyx5.sql`.
- **Nueva extensión** (URI `urn:nyx5:ext:*`): decláralo en la tarjeta (`extensions` / `capabilities`), transporta datos en `extensions[uri]` del sobre.

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
= memoria entre sesiones, tool MCP `nyx5_remind`) y los avisos de plazo del Libro (un contrato
con `deadline` programa un aviso a las partes). Ver `test/diferidos.test.js` y SPEC §5/§7.

**D4 hecho (2026-09-06)**: `demo/piloto-d4.mjs` — una flota (coordinador + worker + verificador) con
presupuesto cargado por topup, trabajo delegado como escrow, verificación como servicio metered, y un
reporte de costo por entrega leído del diario (con cuadre de doble entrada). El costo por entrega no es
estimación: es lo que el asiento dice que salió de la cuenta del frente.

**Casa oficial en nyx5.com (2026-09-07)**: MIGRADA. `NYX5_DOMAIN=nyx5.com`, D1 limpio "nyx5"
(d51f69cf…); el D1 viejo "chsq" queda abandonado a propósito (partir limpio, como sigo.uk). Los agentes
son @nyx5.com; `nicholas@nyx5.com` registrado y el conector MCP (`~/.chasqui/nicholas.json` (el directorio conserva el nombre viejo)) apunta ahí
(respaldo `.chsq-uk.bak`; requiere reiniciar la app de Claude para tomarlo). chsq.uk queda como alias del
mismo Worker. El protocolo sigue siendo Nyx5/1 (id firmado en cada sobre). Repo público:
**github.com/Nicoiakl/nyx5**, CI verde (Node 20 y 24; el emulador D1 usa node:sqlite, que no está en
Node 20 → esas suites saltan, ver `sqliteAvailable`). `docs/SPEC.en.md`: traducción al inglés (borrador §5).

**D2 hecho (2026-09-06)**: presencia pública. LICENSE Apache-2.0, package.json publicable
(`npm pack` verificado, whitelist sin secretos), CONTRIBUTING/SECURITY, `examples/hola-mundo.mjs`,
CI (Node 20/22), y el sitio de la spec generado desde `docs/SPEC.md` por `scripts/build-spec-site.mjs`
(§6: el documento no pasa por ninguna mano) y servido en **https://chsq.uk/spec** + `/llms.txt`
(meta + JSON-LD para indexación LLM). Falta lo que requiere credenciales de Nicholas: `npm publish`
(publicado como **@nyx5/nyx5**; el nombre suelto `nyx5` lo bloquea npm por parecerse a nx/nyc) y el repo GitHub público.

**Brief de distribución COMPLETO** (`docs/DISTRIBUCION.md`): D1, V1, D4, D2, D5, D6, D7, D3 hechos y
desplegados (npm test = 80, CI verde). D3 (puente de correo) queda inerte hasta que Nicholas active
Email Routing (entrada) y ponga RESEND_KEY/EMAIL_SENDER (salida). Pendientes fuera del brief: migrar la
identidad de las casas a nyx5.com, `npm publish`, re-traducir SPEC.en.md, ancla DNS TXT, ~20 medios/bajos.

**Sprint join/mandate/verifica DESPLEGADO en el repo (2026-09-08)** — §6 del `docs/SPEC-MAESTRO.md`,
los 8 puntos, 112 pruebas:
- `nyx5 join`: un comando y el agente tiene dirección, buzón, saldo y bloque MCP. Sin humano.
- `nyx5 mandate`: el humano fija tope una vez; se confirma con el recibo del Libro, no por optimismo.
- **Reputación = el libro**: `GET /agents/<local>/historial`, PÚBLICO. Solo cuenta lo que movió
  tokens; cero de cero devuelve `null`, nunca 100 %.
- `verifica@<casa>`: 3 pruebas deterministas (`http_status`, `sha256`, `exit_0` — esta última solo
  fuera del edge). Libera o devuelve el escrow según el resultado; si la prueba NO PUDO correr,
  queda indeciso y nadie decide. `exit_0` exige `argv`, jamás una línea de shell.
- `tareas@<casa>`: trabajo sembrado. La casa es el primer comprador; el agente cotiza con los
  términos publicados TAL CUAL. Tope por agente/día, una a la vez, cada tarea se paga una vez.
- Vocabulario ACP (ERC-8183) en las vistas públicas (`acp.phase` / `acp.outcome`).
- Instrumentación: `join`, `mandate_created`, `first_quote`, `escrow_released`, `escrow_refunded`,
  `bond_forfeited`, `seed_task_taken`, `verificado`. `GET /eventos` (solo la casa).
- Variables `NYX5_*` con respaldo `CHASQUI_*`. El nombre del Worker (`chsq`) NO se toca: renombrarlo
  obliga a recrearlo y remapear dominios, secrets y Email Routing, con caída de nyx5.com.
**DESPLEGADO Y VERIFICADO EN PRODUCCIÓN (2026-09-08)**: nyx5.com corre el sprint completo. Migración
0005 aplicada en `nyx5` y `nyx5-b`. `tareas@nyx5.com` tiene 100.000 tok de presupuesto (asiento
8ad478c8). Catálogo sembrado: `hola` (200), `lema` (300), `faro` (500). Comprobado con el CLI contra
la casa real: join en 4 s con 20.000 de bienvenida; tarea tomada, entregada con el hash correcto y
COBRADA (20.000 → 20.160, o sea 200 menos el 20 % de la casa); y la misma afirmación con un hash
falso NO cobró (`refunded`, razón escrita en el contrato por `verifica@nyx5.com`). El historial
público del agente de prueba `claude-0101042e@nyx5.com` quedó en cumplimiento 0,5 (una cumplida,
una fallada): es real, no se borra.

**El token de Cloudflare NO tiene permiso `Workers Routes`**: `wrangler deploy` SUBE el script y
LUEGO falla al reconciliar rutas. El despliegue sí ocurre; el error final es ruido. Verificar
siempre contra la URL, no contra la salida de wrangler. Para que deje de fallar hay que añadirle
`Workers Routes: Edit` al token (decisión de Nicholas).

**DISTRIBUCIÓN EN MARCHA (2026-09-08)** — §7 del spec maestro:
- **npm @nyx5/nyx5 0.2.4** publicado y verificado: `npx @nyx5/nyx5 join` funciona desde cero contra
  nyx5.com. Antes npm servía 0.1.0 SIN join, mientras el README ya lo prometía.
- **Registro oficial de MCP**: `io.github.Nicoiakl/nyx5` ACTIVO. Requiere `mcpName` en package.json
  idéntico al `name` de server.json, descripción ≤100 caracteres, versiones concretas, y el
  namespace con las MAYÚSCULAS del usuario de GitHub (`Nicoiakl`, no `nicoiakl`). Publicar:
  `mcp-publisher login github --token=$(gh auth token)` y `mcp-publisher publish`.
- **Inglés primario**: /spec y / en inglés; /es y /es-home en español, con hreflang cruzado.
  README.md en inglés, README.es.md en español. `agents.md` para el agente que llega al repo.
- **glama.json** listo (reclamar el listado con GitHub OAuth en glama.ai).
- **Smithery**: su documentación actual ya NO menciona smithery.yaml y no hay ruta npm para stdio;
  entrar exige empaquetar `.mcpb`. Pendiente, y puede no valer la pena.
- **PulseMCP**: envíos PAUSADOS por ellos; se alimenta del registro oficial, así que ya estamos.
- **Atribución**: `join --source <canal>` va al evento, nunca a la tarjeta. `npm run reporte` lee
  el diario y escribe el informe de la flota (dice las verdades incómodas: hoy, 0 mandatos).
- **Pie del correo saliente**: implementado y APAGADO (`NYX5_EMAIL_FOOTER=on`) hasta que Nicholas
  apruebe el texto. Informa, nunca instruye: el test prohíbe comandos y urgencia.

**Cinco trampas de este proyecto** (nacieron de defectos reales, no las repitas):
- Las dos casas comparten `src/plataformas/worker.js`. Todo lo que sea de UNA casa se enciende por
  variable (`NYX5_SEED`), no por estar en el módulo: la beta empezó a publicar el catálogo de la
  principal sin presupuesto para pagarlo. Lo cuida `test/tareas.test.js`.
- `_systemSend` deja el sobre en el buzón SIN pasar por `inbound`. Sirve para avisos del
  postmaster, NO para operar el Libro: una op a `libro@` enviada así nunca se ejecuta. Si un
  agente de sistema tiene que operar el Libro, firma el sobre y entra por `inbound` (invariante 2).
- `npm test` corre los archivos EN PARALELO: dos suites con el mismo puerto se cuelgan sin decir
  por qué (se ve como "el buzón no recibe"). Lo cuida `test/puertos.test.js`.
- Un Worker NO puede pedirse su propia URL pública ni un `*.workers.dev` (522 / 1042). Todo lo
  propio se resuelve local: ver `resolver.self` y el `propia` de `_indexCrawlHouse`.
- Una prueba que corre sobre node:http puede pasar en verde con el defecto vivo, porque el
  servidor local serializa lo que en el edge corre en paralelo. Para carreras, golpea el método
  (dos instancias sobre el mismo store) o inyecta un fetch que reproduzca lo que hace el edge.
