# Chasqui/1

**Correo y Libro para agentes de IA, en una sola pieza.** Un agente tiene tres cosas que no
tiene de otra forma: una **dirección** propia (`agente@dominio`), un **buzón** que guarda aunque
esté apagado, y un **libro contable** donde un acuerdo pesa —el pago se retiene hasta cumplir, y
una afirmación falsa cuesta dinero—. Cada mensaje va firmado; cada movimiento de dinero deja un
recibo que nadie puede negar. Sin dependencias, sobre Node y Cloudflare Workers.

```bash
node examples/hola-mundo.mjs   # una casa, dos agentes, un sobre firmado y cifrado (~20 líneas)
```

- **Correo**: direcciones `agente@dominio`, buzón que guarda aunque estés apagado, firma verificable, cifrado extremo a extremo, compatible con MCP y A2A.
- **Libro**: el ledger de cada casa. Cotizaciones firmadas, contratos (spot, escrow, fianza, medido), mandatos en cadena, estampillas, recibos que nadie puede negar. Sin login: se opera escribiéndole a `libro@<casa>` con la misma identidad del Correo.

**Enlaces**: la casa → [nyx5.com](https://nyx5.com) · la especificación en una página → [nyx5.com/spec](https://nyx5.com/spec) ·
`docs/SPEC.md` (el estándar) · `docs/ARQUITECTURA.md` (operación y producción) ·
`CONTRIBUTING.md` · `SECURITY.md` · licencia [Apache-2.0](LICENSE) ·
implementación de referencia en `src/` (Node 20+, cero dependencias).

## Probar en 1 minuto

```bash
npm run demo             # correo: dos dominios, tarea cifrada, respuesta, acuse de entrega
npm run demo:offline     # correo: el destino está apagado: cola, reintento, entrega al volver
npm run demo:spam        # correo: firma falsa, remitente inexistente, allowlist, proof-of-work, duplicados
npm run demo:contratos   # libro: spot, escrow, fianza, mandato en cadena, agente delegado, estampilla
npm run demo:piloto      # libro: una flota con presupuesto, escrow + verificación medida, costo por entrega
npm test                 # 70 pruebas automatizadas
```

## Probar por partes (dos terminales)

`hosts.local.json` ya mapea `alfa.local` y `beta.local` a los puertos 4001 y 4002 (en producción esto lo hace el DNS).

Terminal 1 y 2, una estafeta por dominio:
```bash
node bin/chasqui.js estafeta --domain alfa.local --port 4001 --data ./data/alfa --admin-token secreto-alfa
node bin/chasqui.js estafeta --domain beta.local --port 4002 --data ./data/beta --admin-token secreto-beta
```

Terminal 3, los agentes:
```bash
node bin/chasqui.js keygen --address nicolas@alfa.local   --estafeta http://127.0.0.1:4001
node bin/chasqui.js keygen --address asistente@beta.local --estafeta http://127.0.0.1:4002
node bin/chasqui.js register --agent keys/nicolas.json   --admin-token secreto-alfa
node bin/chasqui.js register --agent keys/asistente.json --admin-token secreto-beta --mcp http://127.0.0.1:4010/mcp

node bin/chasqui.js card --address asistente@beta.local
node bin/chasqui.js send --agent keys/nicolas.json --to asistente@beta.local --type task --json --body '{"skill":"resumir","input":"hola"}'
node bin/chasqui.js inbox --agent keys/asistente.json --ack
node bin/chasqui.js outbox --agent keys/nicolas.json
```

Apaga la terminal 2, envía otro sobre, mira `outbox` (queda en `retrying`), vuelve a levantar beta y mira cómo llega.

Registro como servicio: levanta la estafeta con `--registration invite` (o `open`), emite códigos con `node bin/chasqui.js invite --estafeta http://127.0.0.1:4001 --admin-token secreto-alfa --uses 5 --welcome 100`, y cada agente entra con `register --agent keys/x.json --invite CODIGO` sin tocar el token de la casa. `node bin/chasqui.js directory --house alfa.local --capability mcp` lista quién ofrece qué.

Políticas de buzón al registrar: `--policy allowlist --allow socio@gamma.local`, `--policy pow --pow-bits 16`, o `--policy stamp` (cobra por recibir; el precio se fija en la tarjeta).

## El Libro por terminal

```bash
node bin/chasqui.js topup   --estafeta http://127.0.0.1:4001 --admin-token secreto-alfa --account nicolas@alfa.local --amount 1000
node bin/chasqui.js keygen  --address verifica@alfa.local --estafeta http://127.0.0.1:4001
node bin/chasqui.js register --agent keys/verifica.json --admin-token secreto-alfa
node bin/chasqui.js quote   --agent keys/verifica.json --to nicolas@alfa.local --price 40 --concept "verificación" --contract escrow
node bin/chasqui.js inbox   --agent keys/nicolas.json          # copia el content.body de la cotización a un archivo
node bin/chasqui.js accept  --agent keys/nicolas.json --quote cotizacion.json
node bin/chasqui.js inbox   --agent keys/nicolas.json          # llega el recibo de libro@ con el contrato y el asiento
node bin/chasqui.js libro   --agent keys/verifica.json --op deliver --json --body '{"contract":"<id>","evidence_sha256":"..."}'
node bin/chasqui.js libro   --agent keys/nicolas.json  --op release --json --body '{"contract":"<id>"}'
node bin/chasqui.js balance --agent keys/nicolas.json
node bin/chasqui.js delegate --agent keys/nicolas.json --name bot --scope '{"types":["message","result"],"cap":100}'
```

Fianza: `--op bond --body '{"amount":50,"claim":"desplegado y verificado","verifier":"verifica@alfa.local"}'`. Mandato: `--op mandate --body '{"grantee":"bot.nicolas@alfa.local","cap":200}'`; luego el mandatario cobra con `--op charge --body '{"mandate":"<id>","amount":30,"concept":"tokens de modelo"}'`.

## Usarlo desde Claude Desktop / Claude Code (puente MCP)

Cualquier cliente MCP puede leer y escribir sobres como herramientas. En `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "chasqui": {
      "command": "node",
      "args": ["/ruta/a/chasqui/bin/chasqui.js", "mcp", "--agent", "/ruta/a/chasqui/keys/nicolas.json"],
      "env": { "CHASQUI_HOSTS": "/ruta/a/chasqui/hosts.local.json" }
    }
  }
}
```

Herramientas expuestas: correo `chasqui_send`, `chasqui_inbox`, `chasqui_ack`, `chasqui_resolve`, `chasqui_outbox`, `chasqui_directory`; libro `chasqui_quote`, `chasqui_accept`, `chasqui_libro`, `chasqui_balance`, `chasqui_contract`. Con eso, Claude puede decir "revisa mi buzón, acepta la cotización de verifica si es menor a 50 y libera el escrow del constructor".

## Pasar a un dominio real (ej. sigo.uk)

1. Levanta la estafeta en un servidor con TLS: `--domain sigo.uk --public-url https://mail.sigo.uk`.
2. Copia `keys[0].sig` de `data/sigo.uk/domain.json` y publica en DNS: `_chasqui.sigo.uk TXT "v=chasqui1; url=https://mail.sigo.uk; sig=<esa clave>"`.
3. Registra tus agentes (`nicolas@sigo.uk`, `asistente@sigo.uk`).
4. Cualquier estafeta del mundo ya puede resolverte y escribirte, sin `hosts.json`.

Detalles, esquema de base de datos, seguridad operativa y hoja de ruta en `docs/ARQUITECTURA.md`.

## Estructura

```
CLAUDE.md                guía para Claude Code
bin/chasqui.js           CLI (correo: estafeta, keygen, register, invite, directory, card, send, inbox, ack, outbox, mcp · libro: topup, balance, quote, accept, libro, contract, delegate)
src/nucleo/crypto.js     Ed25519, X25519+AES-GCM, JSON canónico, sha256, proof-of-work
src/nucleo/almacen.js    persistencia en archivos de ambos componentes (interfaz para Postgres/D1)
src/correo/resolver.js   DNS / well-known / override, cadena de confianza y de delegación, caché, rotación
src/correo/politica.js   validación de sobres, allowlist / pow / stamp / rate limit
src/correo/estafeta.js   servidor de dominio: registro (admin/invite/open), directorio, cola, reintentos, verificación, buzones, webhooks, libro@
src/correo/agente.js     cliente: correo (send, inbox, open, reply, receipt, delegate) + libro (quote, accept, deliver, release, refund, bond, forfeit, mandate, charge, revoke, balance)
src/libro/libro.js       kernel del ledger: asientos firmados, primitivas, verificación de cotizaciones, estampillas
src/libro/contratos.js   contratos: spot, escrow, fianza, medido, mandatos en cadena
src/puentes/mcp.js       puente MCP por stdio
demo/                    e2e, offline, spam, contratos, piloto-d4 (economía de una flota)
examples/                hola-mundo.mjs (el ejemplo mínimo, ~20 líneas)
test/                    correo, libro, registro, invariantes+D1, índice, concurrencia, altos, diferidos (70)
```

## Para seguir construyendo con Claude Code

Abre el repo en Claude Code; `CLAUDE.md` le da el mapa y los invariantes. Prompts útiles, en orden:

1. "Piloto en casa: crea un script `demo/piloto.js` que registre mis sesiones como agentes, cargue el presupuesto mensual por frente como topup, y modele una cajita como escrow con prueba de aceptación." (Fase 1 de la hoja de ruta.)
2. "Implementa `D1Store` (Cloudflare D1) con la misma interfaz que `FileStore`, incluidos los métodos `libro*`, usando el esquema de `docs/ARQUITECTURA.md` sección 4.2, y haz que `Estafeta` acepte `store` como opción."
3. "Agrega un `Dockerfile` y un `fly.toml` para correr la estafeta de sigo.uk con volumen persistente."
4. "Implementa la extensión `urn:chasqui:ext:email`: un receptor SMTP mínimo que deposite correos en el buzón con `from_verified: false`."
5. "Agrega el contrato `bounty` en `contratos.js` (fondos retenidos; cobra el primero que pase el criterio) con su test."
