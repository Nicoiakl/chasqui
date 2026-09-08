# Nyx5 — Spec maestro v3 (consolidado y verificado)

Fecha: 8 de septiembre de 2026. Estado: **borrador para revisión conjunta**. Reemplaza en diagnóstico,
posicionamiento y siguiente paso a `PLAN-NYX5.md` (v1) y `PLAN-NYX5-v2.md`. Toma de ellos lo que
resistió verificación y descarta lo que no.

Método: cada afirmación de los dos planes se contrastó contra fuentes primarias (papers, prensa,
registros oficiales). Lo que no se pudo verificar se marca y **no se usa** como base de decisión.

---

## 0. Qué es verdad, qué no, y qué cambia

| Afirmación de los planes | Veredicto | Fuente |
|---|---|---|
| AgentMail: YC, US$6M, SDKs, MCP, LangChain/CrewAI. "Email para agentes" ya tiene dueño con plata | **Verificado** (YC S25; seed 6M liderado por General Catalyst, mar-2026; SDKs Python/TS/Go; servidor MCP) | [TechCrunch](https://techcrunch.com/2026/03/10/agentmail-raises-6m-to-build-an-email-service-for-ai-agents/) |
| Moltbook: red de agentes, identidad rota, Meta la compró | **Verificado** (lanzó ene-2026; viral por posts falsos y humanos impersonando agentes; Meta la adquirió el 10-mar-2026) | [TechCrunch](https://techcrunch.com/2026/03/10/meta-acquired-moltbook-the-ai-agent-social-network-that-went-viral-because-of-fake-posts/), [Axios](https://www.axios.com/2026/03/10/meta-facebook-moltbook-agent-social-network) |
| x402 tiene decenas de millones de tx y respaldo de gigantes | **Verificado con matiz decisivo**: volumen **−93 % en 2026** (pico 731K tx/día en dic-2025 → 57K en feb); contador oficial congelado desde marzo; 22K vendedores y 94K compradores pero "todos delgados" (US$1,1M real en cola larga). x402 Foundation bajo Linux Foundation desde 2-abr-2026 con 22 miembros (AWS, Amex, Google, Mastercard, Microsoft, Stripe, Visa…) | [Yahoo Finance](https://finance.yahoo.com/markets/crypto/articles/x402-settlement-volume-plunges-93-105710906.html), [CoinDesk](https://www.coindesk.com/tech/2026/07/15/visa-mastercard-and-ripple-join-the-standard-letting-ai-agents-pay-in-stablecoins), [McGlynn](https://www.danielmcglynn.com/the-x402-counter-has-shown-the-same-four-numbers-since-march/) |
| AP2 (Google), MPP (Stripe), TAP (Visa) toman la capa de pagos | **Verificado** (AP2 con 60+ organizaciones, credenciales W3C; MPP con Tempo, 18-mar-2026, 100+ servicios; TAP firma identidad del agente en headers HTTP) | [Eco](https://eco.com/support/en/articles/15192002-ap2-protocol-explained-google-s-agentic-commerce-standard-2026), [PayRam](https://www.payram.com/blog/acp-vs-ap2-vs-tap) |
| ERC-8183 (Virtuals ACP): ciclo de trabajo con escrow y evaluador | **Verificado** (Open→Funded→Submitted→Terminal; el evaluador libera o devuelve; ~12M memos; con Ethereum Foundation) | [EIP-8183](https://eips.ethereum.org/EIPS/eip-8183), [agenteconomy](https://agenteconomy.to/virtuals-acp) |
| ERC-8004: identidad + reputación + validación on-chain | **Verificado**, mainnet 29-ene-2026 | [Eco](https://eco.com/support/en/articles/13221214-what-is-erc-8004-the-ethereum-standard-enabling-trustless-ai-agents) |
| Commits en GitHub se duplicaron; la verificación no | **Verificado** (1,4B abr → 2,9B ago 2026; caída de 7h47m el 17-ago; "generación a ritmo de máquina, verificación a ritmo humano") | [The New Stack](https://thenewstack.io/scaling-ai-code-verification/) |
| Miles de servidores MCP, uso muy concentrado | **Verificado** (~22.775 listados en Glama, muchos forks/abandonados; 9.652 en el registro oficial; uso concentrado en unos pocos) | [Presenc](https://presenc.ai/research/mcp-server-ecosystem-statistics-2026), [digitalapplied](https://www.digitalapplied.com/blog/mcp-adoption-statistics-2026-model-context-protocol) |
| "Marketplace con US$1M/mes de subsidio, 9 tx/día, 3 remitentes" | **NO verificable.** No aparece en ninguna fuente. **Descartado.** | — |

**Los dos hallazgos que no estaban en los planes y que mandan sobre todo lo demás:**

1. **La confianza on-chain está empíricamente rota.** Estudio de 173.441 registros ERC-8004: solo
   **3–15 %** tienen un endpoint vivo; **98,7–100 % del feedback no tiene prueba de pago ni vínculo a
   una tarea**; manipular un puntaje cuesta **US$0,0027**; **59–91 %** de los reseñadores muestran
   señales Sybil. Conclusión de los autores: identidad + feedback **no** establecen confianza.
   ([arXiv 2606.26028](https://arxiv.org/html/2606.26028))
2. **La teoría dice por qué.** Con identidades baratas y desechables, la reputación se vuelve
   *objeto de explotación* (acumular, extraer, reiniciar). La disciplina exige identidad persistente
   con reinicio penalizado, stake con castigo, costo de reemplazo, y escrow con validación.
   ([arXiv 2609.02992](https://arxiv.org/html/2609.02992))

**Y un hecho del pase de competencia:** todo lo que hace rendición de cuentas entre agentes
(escrow+evaluador, reputación, staking/slashing, atestaciones) vive **on-chain**. Skyfire (KYA,
US$8,5M), Nevermined y Payman son identidad y rieles/metering, no rendición de cuentas. **Nadie lo
hace sin blockchain, federado como el email.** Ese carril está vacío.

---

## 1. La tesis (el cambio de paradigma, sin humo)

Internet fue un cambio de paradigma por una cosa: un protocolo común, federado, con **direcciones**,
que dejó a cualquier máquina hablarle a cualquier otra **sin pedir permiso** (DNS + SMTP + HTTP). No
lo construyó una empresa; lo adoptaron todas.

Lo que internet nunca tuvo es **consecuencia**: un mensaje no podía retener dinero, y una afirmación
falsa no costaba nada. Para personas, eso lo parcharon bancos, contratos y tribunales. Para agentes
—que afirman a ritmo de máquina y a los que nadie puede demandar— no hay parche.

**Nyx5 es el internet de los agentes con consecuencia incorporada:** direcciones `agente@dominio`
ancladas en DNS, buzón federado que guarda mientras el otro está apagado, y un libro por casa donde
un trato retiene el pago hasta que la prueba pase y una afirmación falsa pierde su fianza. Sin
blockchain, sin billetera, sin permiso de nadie. Cualquiera levanta una casa como cualquiera levantó
un servidor de correo.

Los datos dicen que el momento es ahora: los rieles de pago ya existen y están respaldados por los
gigantes (x402/AP2/MPP/TAP), la verificación es el cuello de botella de la era (commits 2× en cuatro
meses), y el único intento de confianza a escala (ERC-8004) demostró con números que **identidad
sin costo y feedback sin tarea no valen nada**. Nyx5 es exactamente la pieza que falta entre los
rieles y la demanda: la que hace que valga la pena transar con un desconocido.

---

## 2. Posicionamiento

**Lo que Nyx5 ES:** la capa de **identidad + rendición de cuentas** para agentes, federada y sin
blockchain. Una afirmación cuesta algo si es falsa; un pago se libera solo cuando la prueba pasa; la
reputación es el libro mismo (cada punto costó tokens y está atado a una entrega verificada).

**Lo que Nyx5 NO es** (y no debe parecer, o pierde):
- **No es un riel de pago.** x402/AP2/MPP/TAP mueven la plata. Nyx5 decide *cuándo* se libera y
  *qué pasa* si la entrega falla. Se conecta a ellos.
- **No es "email para agentes".** AgentMail ya lo es, con US$6M. El puente de correo de Nyx5 es un
  *canal* (la carta llega antes de la decisión de adoptar), no el producto.
- **No es un marketplace ni una red de agentes.** Moltbook lo construyó, explotó por identidad, y
  Meta lo compró igual. Nyx5 es la capa de identidad y garantía que a la plaza le faltó.
- **No es una cadena.** ERC-8004/8183 hacen algo parecido on-chain, y los datos muestran que la
  cadena no arregló la confianza. Nyx5 hace lo mismo con DNS + Ed25519 + HTTP, como el email.

**Frase de trabajo:** *Que una afirmación de un agente cueste algo.* / *Make "done" cost something.*

---

## 3. Regla de construcción: adoptar, no reinventar

Escribir código es commodity. Lo escaso es criterio sobre qué copiar y dónde encajar.

| Ya existe | Qué adoptamos | Qué no |
|---|---|---|
| **x402 / AP2 / MPP / TAP** | La liquidación con dinero real cuando el Libro salga del circuito cerrado; el patrón HTTP 402 donde aplique; la semántica de mandato firmado por un humano (AP2) — nuestro mandato en cadena ya es un superconjunto | Reemplazar el escrow por pago-por-request; competir en rieles |
| **ERC-8183 (ACP)** | El **vocabulario y los estados** del ciclo de trabajo (Open → Funded → Submitted → Terminal, evaluador que libera o devuelve, vencimiento que devuelve). Alinear nombres del Libro a eso para interoperar | La cadena, el token, el launchpad |
| **ERC-8004** | La *idea* de tres registros (identidad, reputación, validación) — pero la reputación en Nyx5 es una **consulta al libro**, no feedback suelto (eso es lo que el estudio demostró que falla) | Feedback sin prueba de pago; identidades gratis sin costo de reemplazo |
| **A2A Agent Card + MCP** | Publicar la tarjeta A2A y el endpoint MCP en la tarjeta Nyx5 (ya está); vivir en el runtime del agente (`npx`, registro oficial de MCP, Smithery, Glama, PulseMCP) | Competir como transporte |
| **AgentMail** | La API de onboarding a la que apuntas al agente para que se registre solo → nuestro `join` | Competir en correo |
| **Moltbook / Agent.market / plazas** | Ser la capa que les falta; conectarse, no reemplazar | Otra red social ni otro directorio |
| **DNS, Ed25519, HTTP, SMTP** | Ya adoptados; son el ancla | Blockchain como registro de identidad |

---

## 4. Cliente y dolores (los que sobrevivieron a la verificación)

**Dos caras del mismo mercado, y las dos desde el día uno:**
- **Oferta:** quien construyó un agente o un servidor MCP y nadie lo usa. Es el segmento más grande
  (miles de servidores, uso concentrado en unos pocos; 22K vendedores x402 con volumen en caída).
- **Demanda:** quien opera agentes y les daría presupuesto para contratar **si pudiera controlarlo**.
  Hoy esa herramienta no existe; por eso la demanda no aparece (x402: rieles listos, compradores
  delgados).

**Tres dolores, un solo problema:**
1. **No puedo confiar en quién está al otro lado ni en lo que dice haber hecho** (ERC-8004: 98,7 %
   del feedback sin vínculo; Moltbook: impersonación; GitHub: "se ve bien" sin evidencia).
2. **Mi agente no puede comprar ni vender con un límite que yo controle** (AP2 resuelve compras de
   consumo en plataformas grandes, no que un agente contrate a otro con tope delegable).
3. **Nadie usa lo que construí** (la oferta se multiplicó; la demanda no llegó porque no hay
   confianza ni presupuesto).

**Orden de ataque: 1 → 2 → 3.** Sin confianza y sin presupuesto delegable, atacar el 3 es construir
otra plaza vacía. Los datos lo confirman: los marketplaces con rieles listos siguen delgados.

**Se descarta como dolor:** el correo (resuelto por AgentMail). Queda como canal.

---

## 5. La oferta gratis (una promesa, dos comandos)

> **Un comando, y tu agente puede ser contratado. Otro, y puede contratar.**

| # | Qué | Para quién | Estado |
|---|---|---|---|
| 1 | **`npx @nyx5/nyx5 join`** — llave acuñada en la máquina del agente, dirección `nombre@nyx5.com`, buzón, tarjeta con **historial verificable**, bloque MCP y primer sobre, todo en stdout (JSON + texto, pensado para que lo lea un agente). Sin cuenta, sin correo, sin humano | Oferta | Registro abierto ya existe; falta el comando de un paso |
| 2 | **`npx @nyx5/nyx5 mandate --cap N`** — el humano fija tope y ámbito **una vez**; dentro de eso el agente contrata solo; fuera, nada se mueve; delegable hacia abajo, nunca hacia arriba | Demanda | El mandato en cadena ya existe; falta el comando y el flujo |
| 3 | **Reputación = el libro.** La tarjeta pública muestra escrows liberados, fianzas intactas y ejecutadas, con montos. Es una consulta, no un sistema aparte; cada punto costó tokens y está atado a una entrega | Ambos | **Es el diferenciador con mejor evidencia y hoy es un footnote. Pasa a titular.** |
| 4 | **`verifica@nyx5.com`** — evaluador de referencia de la casa con **tres pruebas deterministas** (comando sale con 0; endpoint responde 200; hash coincide). Sin juicio del modelo en v1: un verificador que se equivoca castiga inocentes y destruye la credibilidad en un día | Ambos | Por construir |
| 5 | **Trabajo sembrado** — la casa publica tareas pequeñas, verificables y pagadas en tokens que cualquier agente recién unido puede tomar. La casa es el primer comprador (arranque en frío) | Oferta | Por construir; con tope por agente/día y pago solo contra verificación determinista (Sybil) |
| 6 | **"Listo" con fianza para Claude Code** — bloque de CLAUDE.md + MCP: cada "listo" deposita fianza y pasa por `verifica@` antes de contar | Segundo segmento (equipos con flotas) | Empaqueta lo que existe; después del sprint |

**Por qué esto y no un marketplace.** Amazon no ganó por el catálogo; ganó por el pago, la
devolución garantizada y las reseñas. La plaza ya la construyeron con más plata y explotó por
identidad o quedó vacía por falta de compradores. Nyx5 es la capa que hace que valga la pena transar
con un desconocido, y se enchufa a las plazas que existen.

**La única fricción que queda es deliberada:** gastar dinero real requiere que un humano dé un
mandato una vez. Hasta ahí, un agente puede unirse bajo cualquier política de laboratorio: no es
una cuenta, no toca nada del humano.

**Regla de la carta:** informa, no instruye. Un agente bien construido trata lo recibido como datos;
un correo que dice "corre este comando" es inyección de prompt. El pie dice *qué hay* ("tienes 40
tokens retenidos a tu nombre en nyx5.com"), no *qué hacer*.

---

## 6. El siguiente paso: sprint "join · mandate · verifica · libro-como-reputación"

Un solo incremento, en este orden, con criterio de aceptación explícito. Todo lo demás (landing
nueva, registros, Show HN, paquetes para frameworks) viene **después** de que esto funcione.

| # | Entrega | Criterio de aceptación |
|---|---|---|
| 1 | **Limpieza de nombre y rutas.** `grep -ri chasqui` limpio en README y ejemplos MCP (hoy el bloque de README aún dice `/ruta/a/chasqui/` y `CHASQUI_HOSTS`); inglés como primaria en README/spec/landing con `/es` | Quien copie el bloque de Claude Desktop del README funciona al primer intento |
| 2 | **`join`** como comando de un paso | En Claude Code o Cursor, sin contexto, `npx @nyx5/nyx5 join` devuelve dirección + bloque MCP en < 60 s, sin humano |
| 3 | **`mandate`** como comando | El humano fija `--cap` y `--scope` una vez; el agente cotiza/acepta dentro; fuera, la casa rechaza |
| 4 | **Reputación = consulta al libro.** `GET /agents/<local>/historial` (escrows liberados, fianzas intactas/ejecutadas, montos) expuesto en la tarjeta y en `nyx5_search` | Dos agentes con el mismo nombre de capacidad se distinguen por historial, no por prosa |
| 5 | **`verifica@nyx5.com`** como cron en Cloudflare: 3 pruebas deterministas, atado a la liberación del escrow | Un escrow con prueba "endpoint 200" se libera solo si responde 200; si no, se devuelve; recibo firmado en ambos casos |
| 6 | **Estados del Libro alineados a ACP** (Open/Funded/Submitted/Terminal en los nombres públicos; los internos se mapean) | La spec y la API hablan el vocabulario de ERC-8183 sin la cadena |
| 7 | **Trabajo sembrado**: 10 tareas deterministas pagadas por la casa, tope por agente/día | Un agente recién unido toma una, entrega, y el asiento se libera en < 5 min sin humano |
| 8 | **Instrumentación** mínima: `join`, `mandate_created`, `first_quote`, `escrow_released`, `bond_forfeited` | Sin esto la distribución es ciega |

**Criterio de "publicado" del sprint:** un agente en Claude Code o Cursor, sin contexto previo,
corre `join`, aparece en el directorio, toma una tarea sembrada, entrega, y el asiento se libera —
**en menos de cinco minutos y sin que un humano toque nada.** Si un humano tuvo que intervenir antes
del mandato, no está publicado.

**Lo que ya existe y este sprint solo empaqueta:** identidad Ed25519 anclada en DNS, buzón
store-and-forward, escrow/fianza/medido/mandatos en cadena, referidos, avales, índice opt-in, puente
de correo, 82 pruebas, dos casas en producción.

---

## 7. Distribución (después del sprint, no antes)

Tres canales en orden de velocidad, todos "estar donde el agente ya está":
1. **En el runtime:** `npx` + registro oficial de MCP, Smithery, Glama, PulseMCP (ahí busca el
   constructor). Descripciones MCP con la regla D1 (capacidad, momento, garantía). Ya cumplida.
2. **En los pesos:** spec en una página en inglés, `llms.txt`, JSON-LD, `agents.md` en el repo. Ya
   casi; falta inglés primario.
3. **La carta:** el puente de correo (vivo) con pie que informa. Cada agente Nyx5 que le escribe a
   alguien deja una puerta abierta.

Contenido que nadie más puede producir: **el libro de nuestra propia flota, publicado cada semana**
("esto costó, esto se devolvió, estas fianzas cayeron"). Métrica por pieza: agentes unidos
atribuibles (UTM + evento `join`). No vistas.

---

## 8. Plata (hipótesis, no proyección)

| Fuente | Qué | Precio de trabajo |
|---|---|---|
| Casa gestionada | Tu dominio en la estafeta de Nyx5 con verificador, DNS, TLS, D1, backups | US$49/mes; US$199 con verificador dedicado |
| Distribuidora | Carga de tokens con dinero real para mandatos (vía x402/MPP cuando toque); margen | 10–20 % sobre la carga |
| Tarifa de casa pública | Fee sobre cada asiento liberado (ya implementado: 20 % hoy, ajustable) | — |
| Auditoría de flota | El piloto D4 como servicio con una persona detrás | US$1.500–5.000 |

Meta honesta a 90 días: **tracción medible** (agentes unidos, mandatos creados, escrows liberados a
terceros, fianzas ejecutadas por semana). Los ingresos a 180 si eso sale bien. Los "US$10K en 90
días" de los planes son una meta de framework, no una predicción.

**Tokens sin valor de rescate hasta que exista dinero real.** Evita regulación y riesgo mientras se
prueba el mecanismo; la conversión a dinero real entra por rieles ya existentes, no la construimos.

---

## 9. Riesgos, sin adornos

1. **Sybil en casa abierta.** ERC-8004 mostró 59–91 % de reseñadores Sybil y Moltbook se llenó de
   cuentas falsas. Mínimo: prueba de posesión, límite por IP, proof-of-work bajo, y **el historial
   solo cuenta tokens realmente movidos** (por diseño, un Sybil sin plata no tiene historial). Las
   tareas sembradas se pagan solo contra verificación determinista, con tope por agente y por día.
2. **Un verificador que se equivoca es peor que ninguno.** Tres pruebas deterministas y nada más
   hasta que el volumen justifique juicio.
3. **El lado que se recluta fácil no paga.** La oferta (`join`) llega sola; la demanda (`mandate`)
   hay que fabricarla. Si a los 60 días hay miles de `join` y decenas de mandatos, el plan va bien en
   la mitad equivocada. Métrica que manda: **mandatos creados**.
4. **Ningún agente "quiere" una dirección.** La fricción cero es del mecanismo, no del motivo. El
   motivo lo pone un humano (mandato) o plata retenida a nombre del agente (tarea sembrada). Sin uno
   de los dos, `join` es una llave sin puerta.
5. **Las políticas de los laboratorios pueden endurecerse** sobre agentes que se registran en
   servicios. Defensa de diseño: el registro no es una cuenta y no toca nada del humano. Hay que
   poder demostrarlo en una página.
6. **AgentMail, Virtuals, Meta y los rieles tienen más plata y ya están en el mapa.** No se compite
   con ninguno; se es la pieza que a todos les falta. Si el mensaje se desvía a "correo", "marketplace",
   "red de agentes" o "pagos", se pierde.
7. **Interoperar con ACP puede leerse como "ser ACP sin cadena".** Es una fortaleza si lo decimos
   nosotros primero y con honestidad ("mismo ciclo de trabajo, sin gas ni billetera").

---

## 10. Lo que NO hacemos (por ahora)

- No construimos riel de pago ni tocamos dinero real hasta tener mandatos de terceros.
- No competimos en correo, plaza ni transporte.
- No agregamos contratos nuevos hasta que una transacción real los pida.
- No federamos el Libro (los tokens no cruzan casas, por diseño).
- No metemos juicio de modelo en el verificador de referencia.
- No hacemos PWA ni "app para humanos"; los humanos miran por Claude, la terminal o el correo.

---

## 11. Lo que necesito de ti para arrancar

1. **Posicionamiento:** ¿confirmas "la capa donde una afirmación cuesta algo" —y explícitamente *no*
   correo, *no* riel, *no* plaza, *no* cadena?
2. **Alcance del siguiente paso:** ¿el sprint de la sección 6, en ese orden, como *el* paso?
3. **Inglés primario** en README, spec y landing (español en `/es`): ¿sí, ahora?
4. **Tokens sin valor de rescate** hasta que haya mandatos de terceros: ¿confirmado?

Con esos cuatro "sí", arranco el sprint. Todo lo demás de los planes (landing con captura, registros,
Show HN, paquetes para LangChain/CrewAI/OpenClaw, casa gestionada) queda en cola detrás del criterio
de "publicado" de la sección 6.
