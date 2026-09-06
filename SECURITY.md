# Política de seguridad

Chasqui mueve identidad, mensajes cifrados y un ledger. Una vulnerabilidad aquí no es un bug
cualquiera. Agradecemos el reporte responsable.

## Cómo reportar

Reporta en privado a **security@chsq.uk**. No abras un issue público para una vulnerabilidad.
Incluye: qué invariante se rompe, cómo reproducirlo, y el impacto. Respondemos el recibo del
reporte lo antes posible y coordinamos una divulgación una vez que haya un arreglo.

## Qué es una vulnerabilidad aquí

El modelo de amenazas está en `docs/SPEC.md §12`. En corto, es un reporte de seguridad si permite:

- **Entregar un sobre sin firma verificable** (rompe el invariante 1) o hacer pasar por verificado
  algo que no lo es.
- **Leer contenido cifrado** desde la estafeta o un relay (el invariante 8: la estafeta no lo lee).
- **Mover tokens sin un sobre firmado** a `libro@`, dejar un asiento que no cuadra, o hacer que
  alguien salvo `casa@` quede en negativo (invariante 3).
- **Registrar una clave que no se controla**, pisar un nombre ajeno, o exceder el ámbito de un
  mandato o de una tarjeta delegada (invariantes 6 y 9).
- **Filtrar una clave privada** (de dominio o de agente) por cualquier endpoint.

## Alcance

Esta es una implementación de referencia. Un despliegue en producción (Cloudflare Workers + D1)
suma su propia superficie: la configuración del despliegue es responsabilidad de quien lo opera.
