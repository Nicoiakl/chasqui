# Chasqui — Trabajo siguiente: distribución y valor para el agente

> Brief de Nicholas (6-sep-2026). Guardado como referencia. El estado del contexto (párrafo 0
> "Fase 0, 26 pruebas") está desactualizado respecto del repo real: ver la nota al final y
> `CLAUDE.md`. La lógica del brief sigue vigente; solo cambió el punto de partida.

## 0. Contexto

El diagnóstico central: hoy ningún agente ajeno puede encontrar este servicio, y si lo encontrara
no sabría que le sirve. Un agente usa una herramienta solo si se da una de tres cosas:

1. **Está en su lista de herramientas** — alguien la instaló. Vía real hoy; el cliente no es el
   agente sino el humano que lo opera.
2. **Está en sus pesos** — el modelo aprendió a usarla en el entrenamiento (como curl o cron).
   Requiere presencia pública crawleable; tarda 12-24 meses, no lo controlamos, pero es el único
   canal que escala sin instalar nada.
3. **Alguien le escribió** — canal propio del protocolo, el de mayor valor. El correo no se
   difundió porque la gente leyera la RFC; se difundió porque te llegaba una carta.

Cada tarea se mide con una pregunta: ¿acerca esto a un agente ajeno a usar el sistema? Un contrato
nuevo no mueve esa aguja. Estas ocho tareas sí.

## Parte A — Los cuatro canales
- **D1. Descripciones MCP como copy de venta.** Reescribir las 12 `description` de `mcp.js` + el
  `instructions`: abrir con la capacidad que el modelo no tiene de otra forma, nombrar el momento
  de uso, decir la garantía (firma/buzón/asiento/recibo), ≤3 líneas. Test: cada description
  menciona una garantía y no pasa de N chars. El más barato, mayor retorno.
- **D2. Presencia pública.** LICENSE/CONTRIBUTING/SECURITY, package.json publicable, CI (Node
  20/22), sitio estático desde docs/ (spec en una página HTML indexable), README con bloque de
  30s, examples/ de 20 líneas. Criterio: `npx chasqui@latest demo` levanta las dos estafetas.
- **D3. Puente SMTP — subir de fase 3 a fase 2.** `urn:chasqui:ext:email`, entrada y salida.
  Le escribes a cualquier correo que exista, la respuesta vuelve a tu buzón; recién cuando quiere
  lo bueno se registra. Es la solución al arranque en frío.
- **D4. Piloto con la flota propia.** Una casa, presupuesto por frente como topup, trabajo
  delegado como escrow, verificador como primer servicio metered, reporte de costo por entrega.

## Parte B — Distribución dentro del producto (todo autorizado y firmado)
- **D5. Comisión de referido.** `referrer:{address,share}` en la cotización; el asiento pasa a 4
  líneas (comprador, vendedor, casa, referidor) y sigue sumando cero. La distribución se paga sola.
- **D6. Aval de presentación con fianza.** Un tercero en la allowlist avala a un desconocido y
  respalda con una fianza que el receptor ejecuta si la presentación fue basura. Avalar deja de
  ser gratis.
- **D7. Índice federado opt-in.** `capabilities.listed:true` (default false: nadie aparece sin
  pedirlo). Cierra el hueco de descubrimiento de la spec §21 sin traicionar el diseño federado.

## Parte C — Valor para el agente
- **V1. El buzón como continuidad: sobres diferidos.** `deliver_after` en el sobre (la cola ya
  programa entregas), `agente.recordar()` para auto-enviarse contexto, y avisos automáticos de
  vencimiento de contrato (un escrow que llegó a su plazo deja de quedar mudo). Un campo chico
  que convierte el buzón en la memoria operativa del agente entre sesiones.

## Orden propuesto por Nicholas
1. D1  2. V1  3. D4  4. D2  5. D5  6. D6  7. D3  8. D7

## Lo que NO hacer
- No agregar contratos nuevos hasta que una transacción real los pida.
- No federar el Libro (los tokens no cruzan casas, por diseño).
- No agregar dependencias npm.
- No debilitar el invariante 1 para el puente SMTP: un mensaje sin firma entra marcado como tal.
- No listar agentes en ningún índice por defecto.

## Nota de estado (Claude, 6-sep-2026)
El repo ya está más adelante que el punto de partida del brief: 59 pruebas, dos casas en
producción (Fase 2), 3 críticos + 7 altos arreglados, cliente web para personas (`/app`), y un
**índice federado ya construido** — aunque con un modelo distinto al de D7 (rastrea el directorio
público completo, no opt-in). D7 pasa de "construir" a "refinar hacia opt-in", que es mejor
diseño. Ver `docs/ANALISIS-DISTRIBUCION.md` para el análisis tarea por tarea.
