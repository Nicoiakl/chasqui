# Bitácora

Lo que se hizo, con fecha, y lo que queda abierto. Lo autorizó Nicholas el 8-sep-2026: *"puedes
llevar tu propio to-do-list con fechas marchando los completados"*.

Regla de esta lista: una línea entra sólo si alguien puede comprobarla. "Avanzado" no es un
estado. O está hecho y verificado contra el terreno, o está abierto y dice qué falta.

## Abierto — de Nicholas

Nada de esto lo puede hacer la sesión: exige sus credenciales, su firma o su criterio.

| | Qué | Desde |
|---|---|---|
| ⏳ | **DNSSEC** en nyx5.com. NO es un clic pendiente: el panel dice "pending while we automatically add the DS record" y el único botón que ofrece es Cancel Setup, en rojo. Pero el DS no está en el registro .com y whois sigue diciendo `unsigned`, o sea que lleva colgado. Nadie debe tocar ese botón. Si sigue así, hay que cancelar y volver a encender, o abrir un ticket | 9-sep |
| ☐ | **Leer y aprobar `docs/TERMS.md`**. Se sirven sólo si él los enciende: son declaraciones vinculantes en su nombre | 8-sep |
| ☐ | **Smithery**: `smithery auth login && smithery mcp publish dist/nyx5-*.mcpb -n <namespace>/nyx5` | 8-sep |
| ☐ | **AP2**: ¿se queda mapeado o se le construye la segunda llave ECDSA? Recomendación: dejarlo mapeado | 9-sep |
| ☐ | **x402**: ¿la comisión de la casa puede seguir saliendo de lo que recibe el receptor? Si x402 responde que no, el binding exige cambiar cómo se asienta la comisión. Preguntado en su issue #3435 | 9-sep |

## Abierto — de la sesión

| | Qué | Desde |
|---|---|---|
| ☐ | Los ~20 hallazgos medios/bajos de la revisión adversarial | 5-sep |
| ☐ | Ancla DNS TXT `_nyx5.<dominio>` en producción | 5-sep |
| ☐ | Reclamar el listado de glama.ai con OAuth de GitHub | 8-sep |

## Hecho

### 9-sep-2026
- **Cerrada una brecha real: la puerta del correo se saltaba toda la política del buzón.** Un buzón
  que cobraba 500 y otro con lista blanca cerrada aceptaban los dos un correo de un desconocido,
  gratis. Lo peor no era el spam: el precio que la casa anuncia por x402 era evitable escribiendo un
  correo. Ahora el correo pasa por la política, comparada contra el remitente real, y falla cerrado
  cuando el mecanismo no existe sobre correo. El rechazo vuelve como rechazo SMTP, sin backscatter.
  Comprobado en producción con un buzón que cobra 25: el correo salió y no llegó nada.
- **PR a x402 desbloqueado.** Exigen commits firmados y cierran el PR tras una semana sin
  actividad. El commit se firmó con SSH usando la llave personal de Nicholas, y él la registró en
  GitHub como Signing Key, que es una entrada distinta de la de autenticación. `check-verified-commits`
  pasó. Queda esperando revisión humana. El rojo de Vercel NO es nuestro: para un PR externo, alguien
  del equipo de Coinbase tiene que autorizar el despliegue de vista previa.
- **Cerrado el hueco de los mandatos** (lo decidió Nicholas). Una restricción que el Libro no sabe
  aplicar ya no se guarda: el mandato se rechaza al crearlo diciendo qué clave sobra y qué sí se
  aplica, y un mandato viejo que la lleve no cobra. Se agregó `max_per_charge`, que se comprueba en
  cada eslabón de la cadena. Comprobado con el caso exacto que fallaba: antes 90.000 pasaban de un
  golpe contra un tope declarado de 500, ahora ni se crea. Escrito también en la spec y desplegado.
- **Propuesta abierta en el repo de x402** ([issue #3435](https://github.com/x402-foundation/x402/issues/3435)):
  el binding de Nyx5 y las dos preguntas que expuso. No se mandó el documento del binding porque
  el esquema `exact` exige que a `payTo` le llegue el monto anunciado, y nuestra casa descuenta la
  comisión de ahí. Filarlo igual sería leer por encima de un MUST.
- **PR enviado a x402** ([#3436](https://github.com/x402-foundation/x402/pull/3436)): §11.1 pasa a
  decir la gramática de CAIP-2 y que el punto no es legal en una reference. Comprobado contra el
  documento de CAIP-2, no contra un resumen. Es independiente de la pregunta anterior.
- **Adaptador x402 v2 desplegado y verificado en producción.** `GET /x402/supported`,
  `GET /x402/inbox/<nombre>`, y `POST /inbound` respondiendo 402 con `PAYMENT-REQUIRED` o 202 con
  `PAYMENT-RESPONSE`. Comprobado contra nyx5.com: un buzón de 25 tok anuncia "25", rechaza sin
  estampilla, cobra con estampilla, y el `transaction` publicado resuelve a un asiento cuadrado.
- **Mapeo AP2 v0.2 escrito** (`docs/interop/ap2.md`), contra los JSON Schema reales. Hallazgo que
  cambia el rumbo: AP2 prohíbe Ed25519 por nombre. No reclamamos conformidad en ninguna parte.
- **Guard de honestidad de los mapeos** (`test/interop.test.js`): cada fila lleva veredicto, cada
  documento dice contra qué versión se comprobó y qué NO reclama.
- Cuatro chequeos de x402 en `scripts/auditar-produccion.sh`. 30 chequeos, 0 rotos.
- 171 pruebas, 0 fallos.

### 8-sep-2026
- Sprint §6 completo (join, mandate, verifica, historial público, tareas sembradas, vocabulario
  ACP, instrumentación) desplegado y ejercido contra la casa real.
- Distribución §7: npm `@nyx5/nyx5` 0.2.4, registro oficial de MCP `io.github.Nicoiakl/nyx5`,
  inglés como idioma primario, bundle `.mcpb`.
- Auditoría externa aplicada: HEAD, cabeceras de seguridad y caché, favicon, sitemap, og:image,
  redirecciones de http y www, tarjeta del dominio persistida.
- Portada reescrita: en positivo, en una plana, y diciendo dónde se pega lo que se copia.
- Pie del correo saliente aprobado y encendido.
- Nombres de 1 a 3 caracteres reservados.
- Verificado que la Agentic Payments Alliance no es un estándar: sin especificación ni repositorio.

### 7-sep-2026
- Casa oficial migrada a nyx5.com con D1 limpio. Repositorio público, CI verde.
