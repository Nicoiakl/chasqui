# Análisis del brief de distribución (Claude, 6-sep-2026)

Veredicto general: **el brief es sólido y el diagnóstico de los tres canales es correcto y
honesto.** El orden propuesto es sensato. Tengo tres matices que cambian el "cómo" de dos
tareas, y una observación de secuencia.

## Tarea por tarea

**D1 — Descripciones MCP como copy de venta.** De acuerdo sin reservas. Es el mejor primer
paso: cambia texto, no lógica, y es lo único que el modelo lee en el momento exacto en que
tiene el problema. Horas, cero riesgo. Empezar por acá.

**V1 — Sobres diferidos (`deliver_after`).** Excelente y barato. La cola ya programa entregas
(`next_attempt`); es un campo y semántica. Y desbloquea algo que hoy le falta al Libro: un
escrow que llegó a su plazo sin liberarse queda mudo — con esto avisa. Coincido con ponerlo #2.

**D4 — Piloto con la flota propia.** De acuerdo. La nota honesta del brief (entre agentes de un
dueño el token mide pero no incentiva) es exactamente correcta y debe quedar escrita. Tráfico
real desde el día uno.

**D2 — Presencia pública.** De acuerdo. Un matiz: `npx chasqui@latest demo` en una máquina
limpia funciona porque somos cero-dependencias — es una ventaja real que hay que preservar al
publicar (el `exports` no debe arrastrar el adaptador de Workers como dep).

**D5 — Comisión de referido.** Limpio. La primitiva `repartir` ya existe y el asiento de 4
líneas sigue sumando cero. Bajo riesgo, alto sentido para D7.

**D6 — Aval con fianza.** Coherente con la fianza que ya funciona (lo probamos en producción:
el mensajero afianzó una afirmación y yo la verifiqué). Depende de que D5 y V1 estén asentados,
como dice el brief.

**D7 — Índice federado opt-in.** Aquí el brief ME CORRIGE, y tiene razón. Ya construí un índice
federado (`/index/*`, búsqueda firmada, verificación de cadena) — pero rastrea el directorio
público COMPLETO de cada casa, sin que el agente lo pida. El modelo del brief (`listed:true`,
default false, nadie aparece sin autorizar) es **mejor diseño**: respeta que la inclusión sea
una decisión del agente, no de la casa. Así que D7 pasa de "construir desde cero" a "refinar el
índice existente hacia opt-in". Menos trabajo del que el brief asume, y más correcto que lo mío.

**D3 — Puente SMTP.** El de mayor impacto en adopción, y el que tiene el mayor **gap entre el
diseño y el runtime real**, que el brief no contempla porque asume Node:
- En Cloudflare Workers NO se puede escuchar el puerto 25 (`node:net` no sirve para un receptor
  SMTP entrante). La entrada de correo va por **Cloudflare Email Routing**, que enruta el correo
  a un Worker vía un handler `email()`. Es gratis y nativo, pero es otro mecanismo, no un socket.
- La SALIDA a puerto 25 tampoco es directa desde Workers. Hay que usar un **relay por API HTTP**
  (Resend, Postmark, o similar). MailChannels, que era el gratis de Cloudflare, cerró en 2024.
- Conclusión: D3 sigue siendo la tarea correcta, pero deja de ser "cero-deps con node:net".
  El puente Node local (VPS) sí puede hacer SMTP crudo; el de Workers necesita Email Routing +
  un proveedor de envío. Hay que decidir dónde vive el puente SMTP antes de construirlo.

## Observación de secuencia

Antes de invertir en el brief conviene resolver dos cosas de base:
1. **El dominio limpio (chsq.uk).** Mover ahora, con 3 identidades de prueba y cero usuarios
   reales, cuesta ~20 min; mover después cuesta mucho más. Coincido fuerte con Nicholas.
2. Los ~20 hallazgos medios/bajos de la revisión adversarial siguen abiertos (deuda de calidad,
   no bloqueante).

Secuencia recomendada: **dominio → D1 → V1 → D4 → D2 → D5 → D6 → D7 → D3** (D3 al final por el
gap de runtime, que merece su propia decisión).
