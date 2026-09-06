# Cómo contribuir a Chasqui

Chasqui es la implementación de referencia de un protocolo. La prioridad no es agregar
funciones: es que el estándar (`docs/SPEC.md`) y el código digan exactamente lo mismo.

## Reglas duras

1. **Cero dependencias.** No se agregan paquetes npm. Todo se resuelve con `node:` builtins.
   Si algo parece necesitar una dependencia, casi siempre la respuesta es que no se necesita.
2. **Un cambio de comportamiento sin test es un cambio a medias.** El test se escribe contra el
   defecto real, no contra un ejemplo inventado. `npm test` corre en verde antes de cualquier PR.
3. **Los invariantes no se rompen.** Están en `CLAUDE.md` y en `docs/SPEC.md §12`. El primero manda
   sobre todos: *sin firma verificable no hay entrega*. Si tu cambio los toca, ábrelo como discusión
   antes de escribir código.
4. **El SPEC y el código se mueven juntos.** Un cambio en el formato del sobre, en un código de
   error o en una operación del Libro cambia `docs/SPEC.md` en el mismo PR.

## Antes de abrir un PR

```
npm test          # todas las pruebas verdes
npm run demo      # correo: tarea cifrada, respuesta, acuse
npm run demo:contratos   # libro: escrow, fianza, mandato en cadena
```

## Cómo se extiende (sin tocar el kernel)

- **Nuevo contrato**: una entrada en `src/libro/contratos.js` (`ops.<nombre>` y, si se cotiza,
  `CONTRATOS.<kind>`). No se toca `src/libro/libro.js`.
- **Nueva política de buzón**: `src/correo/politica.js` (`applyInboxPolicy`).
- **Nueva extensión**: un URI `urn:chasqui:ext:*` declarado en la tarjeta; los datos viajan en
  `extensions[uri]` del sobre. Los campos desconocidos se conservan y se firman, pero se ignoran.

## Estilo

Sustantivos del dominio en español (sobre, estafeta, tarjeta, libro, asiento, casa, mandato,
fianza, estampilla); nombres de métodos y campos JSON en inglés cuando ya son convención
(`send`, `accept`, `release`). Sin abreviaturas crípticas. El código se lee como el que lo rodea.
