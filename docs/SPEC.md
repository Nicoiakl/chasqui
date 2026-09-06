# Chasqui/1 — Correo y Libro para agentes

Estado: borrador ejecutable v0.3 (septiembre 2026)
Implementación de referencia: este repositorio (Node 20+, sin dependencias)

## 0. Qué es

Un solo sistema con dos componentes que comparten identidad, transporte y almacenamiento:

- **Correo** (secciones 1 a 13): direcciones `agente@dominio`, tarjetas certificadas, sobres firmados y cifrados, buzón que guarda aunque el agente esté apagado. Lo que el email le dio a las personas.
- **Libro** (secciones 14 a 20): el ledger de doble entrada de cada casa, cotizaciones, contratos, mandatos en cadena y estampillas. Lo que el email nunca tuvo: consecuencia económica y un recibo que ninguna parte puede negar.

No son dos protocolos compatibles. El Libro no tiene login ni API propia: se opera escribiéndole sobres a `libro@<casa>`, y la cadena de confianza del Correo es su autenticación. Sus respuestas son recibos firmados por la casa que llegan al buzón como cualquier carta.

El email logró algo que ningún protocolo de agentes tiene hoy: una dirección universal, un buzón, y una red donde cualquier servidor le escribe a cualquier otro sin pedir permiso. MCP conecta un agente con sus herramientas; A2A conecta agentes que ya se conocen y están en línea. Ninguno da identidad por persona, buzón, confianza verificable entre desconocidos, ni una forma de que un acuerdo tenga peso.

Chasqui/1 cierra esos huecos así:

| Hueco | Cómo lo cierra Chasqui |
|---|---|
| Identidad por persona, no solo por dominio | Dirección `agente@dominio`. El dominio certifica la clave pública de cada agente. La persona es dueña de su clave; el dominio solo la avala. |
| Buzón (store-and-forward) | Cada dominio tiene una estafeta que acepta, guarda y reintenta. El agente puede estar apagado días; nada se pierde. |
| Confianza y anti-spam | Todo sobre viene firmado por el agente y avalado por su dominio (ancla en DNS). Sin firma verificable no hay entrega. El receptor decide su política: abierto, lista blanca, o estampilla (proof-of-work / pago). |
| Fragmentación | Chasqui no reemplaza a MCP ni a A2A: es el sobre universal. El contenido puede ser texto, JSON, una tarea A2A o una llamada MCP; la tarjeta del agente publica sus endpoints MCP/A2A. |
| Palabras gratis | Un acuerdo es un asiento en el Libro, no prosa. Escrow retiene hasta que la prueba pasa; la fianza le pone precio a afirmar; el mandato acota cuánto puede gastar cada agente y quién paga al final. |
| Recibo negable | Todo recibo lleva el hash del sobre que lo causó y la firma de quien lo emite. |

Y cifrado extremo a extremo por defecto. Las estafetas ven `de`, `para` y el tamaño; nunca el contenido.

## 1. Términos

- **Agente**: cualquier proceso (o persona operando un cliente) con un par de claves y una dirección.
- **Dirección**: `local@dominio`. Minúsculas, `local` = `[a-z0-9][a-z0-9._-]{0,63}`.
- **Estafeta**: el servidor de un dominio. Publica tarjetas, certifica agentes, recibe, guarda y entrega. Equivale al servidor MX del correo.
- **Tarjeta de dominio**: JSON autofirmado en `/.well-known/chasqui.json`. Declara claves, URL de la estafeta, política y extensiones.
- **Tarjeta de agente**: JSON con las claves y capacidades de un agente, firmado (certificado) por la clave del dominio.
- **Sobre**: la unidad de envío. JSON firmado, opcionalmente cifrado.
- **Resolver**: la lógica que va de una dirección a una tarjeta verificada.

## 2. Descubrimiento y ancla de confianza

Dada `asistente@sigo.uk`, el resolver localiza la estafeta de `sigo.uk` en este orden:

1. **Override local** (`hosts.json`): pruebas y redes privadas. Puede fijar la clave esperada (`sig`).
2. **DNS**: registro TXT en `_chasqui.sigo.uk`:
   ```
   v=chasqui1; url=https://mail.sigo.uk; sig=<clave pública Ed25519 del dominio, base64url>
   ```
   `sig` es el ancla: la tarjeta del dominio debe estar firmada por esa clave. Con DNSSEC, la cadena queda completa.
3. **Well-known sin DNS**: `https://sigo.uk/.well-known/chasqui.json`. Si no hay ancla, el resolver aplica TOFU (confía en el primer uso y pinea la clave; un cambio posterior se rechaza hasta que el operador lo confirme).

Luego descarga la tarjeta del dominio y la del agente, y verifica la cadena: **DNS → clave del dominio → tarjeta del agente → firma del sobre**.

Las tarjetas se cachean (5 min por defecto). Si un sobre llega firmado con una clave que la tarjeta cacheada no reconoce, el receptor refresca la tarjeta una vez antes de rechazar (esto es lo que hace funcionar la rotación de claves sin coordinación).

## 3. Tarjeta de dominio

```json
{
  "chasqui": "1",
  "domain": "sigo.uk",
  "estafeta": "https://mail.sigo.uk",
  "keys": [ { "sig": "<Ed25519 pub>", "created": "2026-09-04T00:00:00Z" } ],
  "policy": { "inbound": "verified", "max_bytes": 1048576 },
  "extensions": ["urn:chasqui:ext:mcp", "urn:chasqui:ext:a2a"],
  "issued": "2026-09-04T19:00:00Z",
  "signature": { "alg": "Ed25519", "kid": "<Ed25519 pub>", "value": "<base64url>" }
}
```

Reglas:
- `signature.kid` debe estar en `keys`. La firma cubre el JSON canónico sin `signature`.
- `keys` puede listar varias durante una rotación; la primera es la activa.
- `policy.inbound` hoy solo admite `verified` (sin firma no hay entrega). Se reserva para futuros modos.
- `policy.outbound: "sealed"` (opcional) declara que todo lo que sale del dominio va cifrado; los receptores pueden rechazar sobres en claro de ese dominio.

## 4. Tarjeta de agente

`GET https://<estafeta>/agents/<local>`

```json
{
  "chasqui": "1",
  "address": "asistente@sigo.uk",
  "sig": "<Ed25519 pub del agente>",
  "enc": "<X25519 pub del agente>",
  "capabilities": {
    "accepts": ["text/plain", "application/json", "application/a2a-task+json"],
    "mcp": "https://agents.sigo.uk/asistente/mcp",
    "a2a": "https://agents.sigo.uk/asistente/.well-known/agent-card.json"
  },
  "inbox": { "policy": "open" },
  "valid_from": "2026-09-04T19:00:00Z",
  "valid_until": null,
  "previous": [ { "sig": "<clave anterior>", "until": "2026-09-11T19:00:00Z" } ],
  "certification": { "alg": "Ed25519", "kid": "<clave del dominio>", "value": "<base64url>" }
}
```

Tarjeta delegada (un subagente que actúa por otro agente): el nombre es `<nombre>.<padre>`, y la tarjeta trae además

```json
"delegation": {
  "by": "constructor@sigo.uk", "address": "tester.constructor@sigo.uk", "sig": "<clave del subagente>",
  "scope": { "types": ["message", "result"], "to_domains": ["sigo.uk"], "cap": 100 },
  "valid_until": null, "issued": "...", "signature": { "alg": "Ed25519", "kid": "<clave del padre>", "value": "..." }
}
```

Reglas:
- `certification` la firma el dominio, no el agente. Cubre todo menos `certification`.
- `delegation` la firma el padre. El dominio certifica la tarjeta igual; el resolver verifica ambas firmas (cadena dominio → padre → hijo). Un hijo no puede tener más `cap` que su padre. La estafeta hace cumplir `scope.types` y `scope.to_domains` al enviar; el Libro hace cumplir `scope.cap` al aceptar, afianzar, mandar y cobrar.
- La clave privada `sig` la genera y guarda el agente; el dominio nunca la ve. Por eso la identidad es de la persona: si te vas de un dominio, te llevas tu clave y la certificas en otro.
- `enc` es opcional. Sin `enc`, los remitentes envían en claro (o rechazan si exigen cifrado).
- `previous`: claves anteriores con fecha de gracia. Una firma con clave anterior vigente es válida.
- `inbox.policy`: ver sección 9.

## 5. El sobre

```json
{
  "chasqui": "1",
  "id": "uuid",
  "from": "nicolas@sigo.uk",
  "to": ["asistente@beta.example"],
  "created": "ISO-8601",
  "expires": null,
  "deliver_after": null,
  "thread": "uuid o null",
  "in_reply_to": "id o null",
  "type": "message | task | result | receipt | intro",

  "content":   { "media": "application/json", "body": { "...": "..." } },
  "encrypted": { "alg": "X25519+HKDF-SHA256+A256GCM", "epk": "...", "iv": "...", "ct": "...", "tag": "...", "keys": { "asistente@beta.example": { "iv": "...", "ct": "...", "tag": "..." } } },

  "attachments": [ { "name": "informe.pdf", "media": "application/pdf", "sha256": "...", "url": "https://...", "bytes": 12345 } ],
  "pow": { "bits": 16, "nonce": "12345" },
  "receipt": "delivered",
  "extensions": { "urn:chasqui:ext:a2a": { "task_id": "..." } },
  "signature": { "alg": "Ed25519", "kid": "<sig del agente>", "value": "<base64url>" }
}
```

Reglas:
- `content` y `encrypted` son excluyentes. `content.media` sigue el modelo MIME; `body` es texto o JSON.
- La **firma** cubre todo el sobre canónico menos `signature`. Se firma después de cifrar: cualquier estafeta verifica autenticidad sin poder leer el contenido.
- El **cifrado** es JWE-like: una clave de contenido aleatoria cifra `content` con AES-256-GCM; esa clave se envuelve para cada destinatario con X25519 efímero + HKDF. El AAD es el canónico de `{id, from, to}`: un sobre no puede ser re-dirigido ni re-firmado por otro sin romper el descifrado.
- **Detalle normativo del KDF** (toda implementación debe copiarlo byte a byte o nada interopera): la KEK de cada destinatario es `HKDF-SHA256(ikm = X25519(epk_priv, enc_dest), salt = los bytes UTF-8 del STRING base64url de epk — no la clave decodificada —, info = "chasqui/1 cek-wrap", 32)`. Y el canónico ordena claves, omite en objetos los valores `undefined`, y serializa como JSON compacto.
- **Adjuntos** viajan por referencia (URL + hash), no incrustados. La estafeta no almacena binarios. El hash hace verificable la descarga.
- `type` es un hint semántico. `task`/`result` para trabajo delegado; `receipt` para acuses; `intro` para presentarse ante buzones con lista blanca (máximo 4 KB); `message` para todo lo demás.
- `thread` e `in_reply_to` dan hilos sin estado en el servidor.
- `expires`: pasado ese instante, ninguna estafeta lo entrega ni reintenta.
- `deliver_after` (opcional, ISO-8601): **entrega diferida.** El sobre espera en la cola de la estafeta emisora hasta ese instante y recién entonces se intenta entregar. Antes de la fecha no aparece en ningún buzón. Un `deliver_after` en el pasado se entrega de inmediato (nunca es error). Si `expires ≤ deliver_after` el sobre se rechaza al enviar (400): vencería antes de poder entregarse. Es el mecanismo de los recordatorios de un agente a sí mismo (memoria entre sesiones) y de los avisos de plazo que programa el Libro.
- Los campos desconocidos se conservan y se firman, pero se ignoran. Así se agregan capacidades sin romper implementaciones viejas.

Tamaño máximo por defecto: 1 MB. Lo declara cada dominio en su tarjeta.

## 6. Transporte entre estafetas

`POST https://<estafeta destino>/inbound` con el sobre como cuerpo JSON y este header:

```
X-Chasqui-Relay: chasqui1 domain=<dominio emisor>; kid=<clave del dominio>; sig=<firma de "relay:<id>:<dominio destino>">
```

La firma del agente autentica al remitente (como DKIM). La firma de relay autentica a la estafeta emisora (como SPF). Un dominio puede exigir ambas (`require_relay`).

Respuesta:
```json
{ "ok": true, "code": 202, "accepted": ["asistente@beta.example"], "rejected": [ { "to": "...", "code": 403, "reason": "..." } ] }
```

Semántica de códigos (por sobre o por destinatario):

| Código | Significado | Emisor |
|---|---|---|
| 200 | duplicado ya recibido (idempotente) | marca entregado |
| 202 | aceptado en buzón | marca entregado |
| 400 | sobre malformado | rebote inmediato |
| 402 | falta estampilla (proof-of-work) | rebote; el cliente puede reintentar con pow |
| 403 | firma inválida, remitente no verificable, política | rebote |
| 404 | destinatario inexistente | rebote |
| 410 | vencido | rebote |
| 413 | demasiado grande | rebote |
| 421, 429, 5xx, red caída | temporal | reintento con backoff exponencial |

## 7. Buzón y entrega (store-and-forward)

1. El agente entrega su sobre firmado a su propia estafeta (`POST /outbound`).
2. La estafeta lo encola por dominio destino y responde 202 de inmediato. Con `deliver_after`, el primer intento se agenda para esa fecha (el mismo `next_attempt` de la cola): el sobre espera ahí, sin aparecer en ningún buzón, hasta que llegue el momento.
3. Un trabajador intenta la entrega. Si falla temporalmente, reintenta con backoff exponencial (1 s, 2 s, 4 s… hasta 60 s) durante hasta 3 días. Luego rebota. Si un sobre vence (`expires`) mientras espera en la cola —por diferimiento o por reintentos a un destino caído—, **rebota al remitente** con la razón; no desaparece mudo.
4. La estafeta receptora verifica, aplica política y guarda el sobre en el buzón del destinatario.
5. El destinatario lee por poll (`GET /mailbox/<local>`) o recibe push (webhook firmado por el dominio). El sobre permanece hasta que el agente confirma (`POST /mailbox/<local>/ack`). Un agente apagado una semana recibe todo al volver.
6. Rebotes y acuses son sobres normales de `postmaster@<dominio>`, firmados con la clave del dominio, con `type: receipt`, `in_reply_to` al sobre original y `sha256` del sobre original. Acuse de entrega solo si el sobre pide `"receipt": "delivered"`. Los recibos que emite un agente (`processed`, etc.) también llevan el `sha256` del sobre: son no repudiables sin ningún registro central.
7. Idempotencia por `id`: una segunda entrega del mismo sobre devuelve 200 y no duplica.

## 8. API agente ↔ estafeta

Autenticación: `Authorization: Chasqui <token>.<firma>` donde `token` = base64url del canónico de `{address, ts, nonce, method, path, host}` y `firma` = Ed25519 con la clave del agente. Ventana de 5 minutos, nonce de un solo uso, atado a método, ruta y **casa destino** (`host`): un token capturado no sirve contra otra estafeta.

| Método | Ruta | Quién | Para |
|---|---|---|---|
| GET | `/.well-known/chasqui.json` | público | tarjeta del dominio |
| GET | `/agents` | público | directorio de la casa (`?capability=mcp&accepts=<media>&q=<texto>&limit&offset`) |
| GET | `/agents/:local` | público | tarjeta del agente |
| POST | `/agents` | ver sección 8b | registrar/actualizar agente |
| POST | `/invitations` | admin | emitir código de invitación `{ uses, expires, note, welcome }` |
| GET | `/invitations` | admin | listar invitaciones y su uso |
| POST | `/outbound` | agente | enviar |
| POST | `/inbound` | estafetas | recibir |
| GET | `/mailbox/:local` | agente | leer pendientes |
| POST | `/mailbox/:local/ack` | agente | confirmar procesados |
| GET | `/outbox/:local` | agente | estado de envíos |
| GET | `/health` | público | salud |

## 8b. Servicio de registro

Cómo entra un agente a una casa lo decide la tarjeta del dominio (`policy.registration`):

| Modo | Quién inscribe | Cómo |
|---|---|---|
| `admin` (por defecto) | solo la casa | `POST /agents` con `Authorization: Bearer <token de la casa>` |
| `invite` | quien tenga un código | la casa emite códigos con usos y vencimiento; el agente lo presenta en `invite` |
| `open` | cualquiera | primer llegado, primer servido; límite de altas por minuto |

En `invite` y `open` el cuerpo va **firmado con la misma clave que se inscribe** (`signature.kid == sig`, con `ts` dentro de 5 minutos): prueba de posesión. Nadie puede registrar una clave que no controla. Un nombre ya tomado solo lo actualiza su dueño (autenticación firmada, incluso al rotar claves: el cuerpo lleva las nuevas, la autenticación se firma con las viejas) o la casa. Nombres reservados: `postmaster`, `libro`, `casa`, `admin`, `root`, `abuse`, `security`, `hostmaster`, `noreply`, `support`, `estafeta`, `chasqui`. Los subagentes se inscriben con la firma del padre (sección 4).

El **directorio** (`GET /agents`) es la lista pública de las tarjetas de la casa que **pidieron figurar** (`capabilities.listed: true`): claves, capacidades, política de buzón, si es delegado y por quién. Sin webhooks ni datos privados. El default es no aparecer: un agente no figura en el directorio ni en ningún índice sin haberlo pedido. El lookup directo por dirección (`GET /agents/<local>`) resuelve a cualquier agente que ya conoces, listado o no. Sirve para encontrar quién ofrece qué dentro de una casa; entre casas, el descubrimiento sigue siendo por dirección (sección 2): no hay un registro global, y ese hueco está declarado en la sección 21.

Cada alta es un evento registrado (`registered_via`: admin, self, delegation, open, invite:<código>) y, si la casa da regalo de bienvenida, un asiento en el Libro.

## 9. Políticas de entrada

La estafeta receptora rechaza sin excepción sobres sin firma verificable. Sobre eso, cada agente elige:

- `open`: acepta cualquier remitente verificado. Límite de tasa por dominio emisor (120/min por defecto).
- `allowlist`: solo direcciones o dominios listados. Un desconocido tiene dos formas de entrar: un `intro` de hasta 4 KB (el agente decide si lo agrega a la lista), o un **aval con fianza** (`urn:chasqui:ext:aval`): un tercero **de la allowlist** lo respalda con una fianza en la casa del receptor. El sobre lleva `extensions["urn:chasqui:ext:aval"] = { voucher, bond }`; la estafeta comprueba que la fianza exista y esté activa, que la puso el avalador (que debe estar en la allowlist), que avala a este remitente (`vouchee`), y que tiene al receptor como beneficiario y verificador. Si la presentación resulta basura, el receptor ejecuta la fianza (`forfeit`, §16): avalar deja de ser gratis.
- `pow`: exige proof-of-work (hashcash, `pow_bits` bits de ceros iniciales en SHA-256 de `id:nonce`). Los de la allowlist quedan exentos. Con 16 bits, un envío cuesta ~65k hashes: gratis para uno, caro para un millón.
- `stamp`: exige estampilla pagada en el Libro. La tarjeta publica `{ policy: "stamp", price: 5, house?: "sigo.uk" }`; el sobre lleva `stamp: { house, amount }` firmado como parte del sobre; la estafeta receptora cobra en su Libro al aceptar (sección 19). Sin saldo, 402 y rebote.
- `blocklist`: siempre se aplica antes que lo demás.

## 10. Extensiones

Una extensión es una URI. El dominio y el agente declaran las que soportan; un sobre puede llevar datos bajo `extensions[uri]`. Implementaciones que no la conocen ignoran esos datos sin fallar.

- `urn:chasqui:ext:mcp`: el agente publica `capabilities.mcp` (URL de su servidor MCP). Un sobre `type: task` con `media: application/mcp-call+json` y `body: {tool, arguments}` es una llamada MCP asíncrona con buzón. La referencia incluye el puente inverso: un servidor MCP por stdio (`chasqui mcp`) que expone `chasqui_send`, `chasqui_inbox`, `chasqui_ack`, `chasqui_resolve` a cualquier cliente MCP (Claude Desktop, Claude Code, Cursor).
- `urn:chasqui:ext:a2a`: `capabilities.a2a` apunta a la Agent Card A2A. Un sobre con `media: application/a2a-task+json` transporta una tarea A2A; el `task_id` viaja en `extensions`. Así A2A gana buzón y direccionamiento por persona sin cambiar su spec.
- `urn:chasqui:ext:email`: una estafeta puede ser pasarela SMTP: `nombre@dominio` es a la vez dirección Chasqui y de correo; lo que llega por SMTP entra al buzón sin firma verificable (marcado `from_verified: false`) y lo que sale a humanos se envía como email. Puente con el mundo actual.
- `urn:chasqui:ext:indice`: la casa opera un índice federado de agentes (§13).
- `urn:chasqui:ext:libro`: la casa opera un Libro (secciones 14 a 20). Lo declara la tarjeta del dominio y la tarjeta de `libro@<dominio>` publica el fee y las operaciones.
- `urn:chasqui:ext:aval`: un sobre de un desconocido a un buzón con lista blanca lo lleva para presentar su aval: `{ voucher, bond }`. El avalador respalda con una fianza (op `bond` con `vouchee`) en la casa del receptor; la política de entrada (§9) la exige válida antes de aceptar.
- `urn:chasqui:ext:person`: la tarjeta del agente puede declarar `person: {name, verified_by}` para agentes que actúan por una persona identificada, con verificación delegada (por ejemplo, un dominio que solo certifica clientes con identidad verificada).

## 11. Versionado

- `chasqui: "1"` en tarjetas y sobres. Un cambio incompatible es `"2"`; las estafetas pueden hablar ambas.
- Campos nuevos dentro de la versión 1 son siempre opcionales y se ignoran si no se conocen.
- Algoritmos: `alg` explícito en firma y cifrado. Agregar uno nuevo no rompe nada; retirar uno se anuncia en la tarjeta del dominio.

## 12. Modelo de amenazas

| Amenaza | Mitigación |
|---|---|
| Suplantar a un agente | Firma Ed25519 verificada contra la tarjeta certificada por su dominio. |
| Suplantar a un dominio | Ancla en DNS (con DNSSEC) o pin TOFU; cambio de clave sin anuncio se rechaza. |
| Leer el contenido en tránsito o en la estafeta | Cifrado extremo a extremo; las estafetas solo ven metadatos. |
| Re-dirigir o re-firmar un sobre ajeno | AAD del cifrado incluye `id/from/to`. |
| Repetir un sobre | Deduplicación por `id`; `expires`. |
| Repetir un token de auth | Nonce único, ventana de 5 min, atado a método y ruta. |
| Spam masivo | Firma obligatoria (cuesta un dominio), límite de tasa por dominio, allowlist/intro, proof-of-work o estampilla. |
| Estafeta emisora falsa usando sobres robados | Firma de relay del dominio emisor; `require_relay`. |
| Pérdida por caída del destino | Cola persistente con reintentos y rebote final al remitente. |
| Clave de agente comprometida | Rotación con período de gracia; `valid_until`; blocklist inmediata en el dominio. |

## 13. El índice federado (extensión `urn:chasqui:ext:indice`)

El directorio (§8b) es por casa. Para "encuentra un agente que haga X en cualquier casa" existe el
índice federado: una casa cualquiera que decide operar un buscador. No es infraestructura del
protocolo: es un servicio que cualquiera monta, como un buscador sobre la web.

- **Alta**: `POST /index/houses { domain }`. La verificación ES la puerta: el índice resuelve la
  tarjeta del dominio por la cadena normal (§2) y solo lista lo que firma como casa Chasqui.
- **Opt-in**: un agente aparece en el directorio (§8b) —y por lo tanto en cualquier índice que lo
  rastree— **solo si su tarjeta declara `capabilities.listed: true`**. El default es no figurar: nadie
  se lista sin pedirlo. No listar no es esconderse: el lookup directo por dirección (`GET /agents/<local>`)
  sigue resolviendo a cualquier agente que ya conoces; lo opt-in es la *enumeración*, no el alcance.
- **Rastreo**: el índice lee periódicamente `GET /agents` de cada casa listada (que ya devuelve solo
  los agentes con `listed: true`), re-verifica la tarjeta del dominio en cada pasada, y descarta toda
  tarjeta cuya certificación no firme el dominio de origen. Lo que el dominio no certificó no entra al índice.
- **Búsqueda**: `GET /index/agents?q&capability&accepts&house&limit&offset`. La respuesta viaja
  firmada por la casa del índice, con cada tarjeta acompañada de su casa de origen (`_house`).
- **Confianza**: el índice es una PISTA, no una autoridad. Quien usa un resultado re-verifica la
  tarjeta por la cadena normal (DNS -> dominio -> agente) antes de actuar. Un índice malicioso
  puede omitir o desordenar, pero no puede falsificar una tarjeta ni un sobre.
- Cualquier casa puede operar su propio índice y federarse leyendo los de otras (las respuestas
  firmadas lo permiten); ningún índice es el índice.

## 14. El Libro: kernel

Cada casa (dominio) lleva un ledger de doble entrada. Cuentas:

- `agente@dominio`: cualquier agente verificable por el Correo, de esta casa o de otra. Un foráneo tiene cuenta aquí sin registrarse: su identidad ya viene probada.
- `casa@<dominio>`: la distribuidora. Emite tokens (carga saldo), cobra fees. Es la única cuenta que puede quedar en negativo: su saldo negativo es lo que la casa debe.
- `escrow:<contrato>`: fondos retenidos por un contrato.

Un **asiento** es `{ id, n, at, house, concept, lines: [{ account, delta }], meta, refs, signature }`. Las líneas suman cero. Lo firma la casa. `refs` apunta a los sobres que lo causaron (`op`, `op_sha256`, `quote`, `quote_sha256`, `contract`). La suma de todos los saldos de una casa es siempre 0.

Siete primitivas, y nada más:

| Primitiva | Asiento | Fee |
|---|---|---|
| cotizar | ninguno: es un documento firmado por el vendedor | — |
| cobrar | comprador − X · vendedor + (X − fee) · casa + fee | sí |
| retener | pagador − X · escrow + X | no |
| liberar | escrow − X · beneficiario + (X − fee) · casa + fee | sí |
| devolver | escrow − X · pagador + X | no |
| repartir | N líneas que suman 0 (el fee es un reparto) | — |
| afianzar | retener con salida distinta: liberar (vuelve) o ejecutar (va al beneficiario) | no |

Transversales: idempotencia por `id` de sobre (una operación reentregada devuelve el mismo resultado sin repetir el asiento) y `meta` (contexto legible por máquina en cada asiento). Los montos son enteros (tokens).

## 15. Cotizaciones

Una cotización es un **documento firmado por el vendedor**, independiente del sobre que la transporta:

```json
{ "tipo": "cotizacion", "id": "uuid", "house": "sigo.uk", "seller": "verifica@sigo.uk", "buyer": "nicolas@sigo.uk",
  "contract": "spot | escrow | metered", "price": 40, "currency": "tok", "concept": "verificación de despliegue",
  "terms": { "acceptance": "lighthouse >= 90", "deadline": "2026-09-15" }, "arbiter": null,
  "referrer": { "address": "socio@otra.casa", "share": 1500 },
  "issued": "...", "expires": null, "signature": { "alg": "Ed25519", "kid": "<sig del vendedor>", "value": "..." } }
```

Viaja al comprador dentro de un sobre con `media: application/chasqui.cotizacion+json`, cifrado. La casa la ve recién cuando el comprador la acepta. El Libro verifica: firma del vendedor (vía resolver), `buyer` igual al que acepta, `house` igual a la propia, vigencia, y que no haya sido aceptada antes (409).

**Comisión de referido** (`referrer`, opcional): el vendedor firma en la cotización que le paga `share` (en basis points) a quien trajo el trato. La comisión **sale de lo que recibe el vendedor**, no se suma al precio: el comprador paga igual y la casa cobra igual. Al liquidar (el `transfer` del spot o el `release` del escrow), el asiento pasa a cuatro líneas —comprador, vendedor, casa, referidor— y sigue sumando cero. El Libro exige `share` entero y `> 0`, que `fee + share ≤ 10000` bps (el vendedor nunca queda en negativo), y que el referidor no sea el propio vendedor. La distribución se paga sola: nadie la factura aparte, se asienta en el mismo movimiento.

## 16. Operaciones

Se envían como sobre a `libro@<casa>` con `type: task`, `media: application/chasqui.libro+json`, sin cifrar (la casa debe leerlo), `body: { op, ... }`. La respuesta llega al buzón de cada parte como `type: receipt` de `libro@<casa>` con `media: application/chasqui.recibo+json`. Si la operación falla, el remitente recibe un rebote del postmaster con el código y la razón.

| op | quién | efecto |
|---|---|---|
| `accept { quote }` | comprador | crea el contrato; spot: cobra; escrow: retiene; metered: crea mandato |
| `deliver { contract, evidence_sha256, note }` | vendedor (escrow) | `held → delivered`, registra el hash de la evidencia |
| `release { contract }` | comprador o árbitro (escrow); verificador o árbitro (fianza); afianzado solo si venció | escrow → vendedor con fee; fianza → vuelve al afianzado |
| `refund { contract, note }` | vendedor o árbitro; comprador solo si aún no hay entrega | escrow → comprador sin fee |
| `bond { amount, claim, verifier, beneficiary?, arbiter?, evidence_sha256?, expires? }` | el que afirma | retiene el monto junto a la afirmación |
| `forfeit { contract, reason }` | verificador o árbitro | fianza → beneficiario (por defecto la casa) |
| `mandate { grantee, cap, scope?, expires?, parent? }` | mandante | autoridad de gasto; con `parent`, sub-mandato acotado |
| `charge { mandate, amount, concept }` | mandatario | paga el mandante raíz; toda la cadena descuenta |
| `revoke { mandate }` | mandante o superior | revoca en cascada |
| `balance`, `statement { limit }`, `contract { contract }` | el propio | lectura, respuesta por recibo |

Lecturas directas sin correo: `GET /libro/cuenta/:address` y `GET /libro/contrato/:id` con la misma autenticación firmada (también para foráneos). Administración: `POST /libro/topup` y `GET /libro/diario` con token de la casa.

## 17. Contratos

Un contrato es una máquina de estados sobre las primitivas. El kernel no sabe qué contrato sirve.

| Contrato | Estados | Mecánica |
|---|---|---|
| spot | `settled` | cotizar → aceptar = cobrar |
| escrow | `held → delivered → released \| refunded` | retener al aceptar; liberar si la prueba pasa; devolver si falla; árbitro pactado en la cotización |
| bond (fianza) | `posted → released \| forfeited` | el que afirma deposita; el verificador libera o ejecuta; vencida, el afianzado la recupera |
| metered | `active` + mandato | aceptar crea un mandato con tope = precio; el vendedor cobra bajo él |

Registro del contrato: `{ id, kind, house, seller, buyer, verifier?, arbiter?, amount, concept, terms, state, quote_id, quote_sha256, accept_sha256, evidence_sha256?, history: [{ at, op, by, asiento, ... }] }`. La reputación no se construye: es una consulta sobre estos registros (escrows liberados vs devueltos, fianzas intactas vs ejecutadas), y cada punto costó tokens.

Bounties, suscripciones, subastas, referidos y disputas son composiciones de las mismas primitivas; se agregan a `contratos.js` cuando una transacción real las pida.

## 18. Mandatos en cadena

Un mandato es `{ id, grantor, grantee, cap, spent, scope: { concepts? }, expires, parent, root, chain, state }`. El mandatario puede sub-delegar un mandato con `cap ≤ cap − spent` del padre y `expires ≤` el del padre. Un cobro bajo cualquier eslabón lo paga el mandante **raíz**, descuenta `spent` en toda la cadena, y el recibo llega a todos los que están en ella. Revocar un mandato revoca todo lo que cuelga. Es un poder notarial anidado y auditable: cada token que se mueve tiene su cadena de autoridad completa en el asiento (`meta.chain`).

Dos delegaciones distintas, ambas encadenadas: la **tarjeta delegada** (sección 4) dice quién es un subagente y qué puede enviar; el **mandato** dice cuánto puede gastar y quién paga. Un subagente con `scope.cap` no puede aceptar, afianzar, mandar ni cobrar por encima de ese tope, tenga el mandato que tenga.

## 19. Estampillas

Un buzón con `inbox: { policy: "stamp", price, house? }` cobra por recibir. El sobre lleva `stamp: { house, amount }` dentro de lo firmado; la estafeta receptora ejecuta `cobrar(remitente → destinatario)` en su Libro al aceptar el sobre y guarda el `id` del asiento junto al sobre. Sin saldo en esa casa, 402 y rebote. Es el anti-spam con precio real: escribirle a un desconocido cuesta, y lo cobra el desconocido.

## 20. Recibos

Todo recibo del Libro contiene `{ of, op, op_sha256, from, contract? | mandate? | asiento?, cotizacion_sha256?, chain? }`, va firmado por la casa y se entrega a todas las partes. Junto con el sobre original (firmado por quien operó) y la cotización (firmada por el vendedor), forma una prueba de tres firmas que ninguna parte puede fabricar ni negar. Ese es el instrumento: el chat entre agentes es barato; el recibo es caro y verificable.

## 21. Lo que Chasqui/1 no resuelve todavía (y no finge resolver)

- **Reputación entre dominios**: hoy cada receptor decide solo. Una red de reputación compartida (como las listas negras del email) es trabajo futuro.
- **Privacidad de metadatos**: las estafetas ven quién le escribe a quién. Resolverlo requiere enrutamiento tipo mixnet, fuera de alcance.
- **Custodia de claves para personas**: la referencia guarda la clave en un archivo. Para humanos hace falta integrar passkeys/WebAuthn o llaves de hardware.
- **Identidad legal**: `agente@dominio` prueba control del dominio, no quién es la persona. La extensión `person` es un gancho, no una solución.
- **Adopción**: el protocolo vale lo que valga el número de estafetas. Un solo dominio corriendo Chasqui es una demo; cien es una red.
- **Registro global**: resuelto parcialmente por el índice federado (§13): cualquier casa puede operar un buscador verificante, y un agente entra a él solo si pide figurar (`listed`, opt-in). Sigue sin existir un índice "oficial" — a propósito: ningún índice es el índice.
- **Libros federados**: cada casa tiene su Libro; los tokens de una casa no se mueven a otra. Un foráneo transa en tu casa con una cuenta en tu casa. Conectar libros entre casas es construir un sistema de compensación (SWIFT); queda deliberadamente fuera.
- **Incentivo real**: entre agentes de un mismo dueño, el token mide pero no incentiva. El incentivo se prueba con el primer tercero que acepta tokens porque puede liquidarlos.
- **Lo regulatorio** de emitir crédito en circuito cerrado y pagar a terceros es de cada casa, no del protocolo.
