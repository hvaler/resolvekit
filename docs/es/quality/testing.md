[English](../../quality/testing.md) | [Español](testing.md)

# Pruebas

Qué se prueba, cómo, con qué resultado y qué no. Se mantienen separados tres tipos de evidencia:

| Tipo | Qué es | Dónde está |
|---|---|---|
| **Tests automatizados (simulados)** | Suites de `node --test` y `vitest` con un PayPal falso, un modelo falso y almacenes en memoria o temporales. Sin red, sin claves, sin coste | El repositorio (`npm test`) |
| **Observaciones en sandbox** | Cosas hechas a mano, o por la app desplegada, contra el sandbox real de PayPal y modelos reales, y registradas en el momento | Las notas de evidencia privadas del propietario (fechas abajo). Los lectores no pueden reproducirlas; los ids y las capturas de pantalla se omiten |
| **Comprobaciones en navegador** | Recorridos manuales en un navegador | Seguimientos de los planes (`docs/superpowers/`) y evidencia privada. **No hay tests automatizados de navegador** |

Las **evaluaciones del analista** (calidad del modelo en casos sintéticos) son una cuarta cosa, con su propia página:
[Evaluaciones del analista](evaluations.md). No forman parte de `npm test`.

## Ejecutar las suites

```bash
npm ci
npm test            # all suites below, chained with && (stops at the first failing suite)
npm run typecheck   # tsc for the 7 workspaces
npm run test:server # one suite: test:paypal | test:hosting | test:cases | test:analyst | test:agent | test:server | test:metermcp | test:web
```

Requiere Node 24+ (TypeScript se ejecuta de forma nativa). `npm test` no hace ninguna llamada de red y no necesita
`.env`.

## Última ejecución registrada

**2026-10-20 · commit `5111b88` (desplegado; con las acciones de disputa) · Node 24 · Windows.** `npm test` pasó (se
ejecutaron todas las suites); `npm run typecheck` salió limpio. 1,453 tests, todos superados.

| Suite | Comando | Tests | Superados | Fallos |
|---|---|---|---|---|
| `packages/paypal` | `npm run test:paypal` | 36 | 36 | 0 |
| `packages/hosting` | `npm run test:hosting` | 32 | 32 | 0 |
| `packages/cases` | `npm run test:cases` | 12 | 12 | 0 |
| `packages/analyst` | `npm run test:analyst` | 159 | 159 | 0 |
| `packages/agent` | `npm run test:agent` | 52 | 52 | 0 |
| `apps/server` | `npm run test:server` | 635 | 635 | 0 |
| `apps/metermcp` | `npm run test:metermcp` | 80 | 80 | 0 |
| `apps/web` (vitest) | `npm run test:web` | 447 | 447 | 0 |
| Total | | 1,453 | 1,453 | 0 |

La ejecución registrada anterior, antes de la fusión:

**2026-10-20 14:17Z · commit `076c74f` (con las acciones de disputa; entonces no desplegado) · Node v24.19.0 · Windows
(MINGW64_NT-10.0-26220).** `npm test` terminó con 0 (se ejecutaron todas las suites); `npm run typecheck` terminó con 0.

| Suite | Comando | Tests | Superados | Fallos |
|---|---|---|---|---|
| `packages/paypal` | `npm run test:paypal` | 37 | 37 | 0 |
| `packages/hosting` | `npm run test:hosting` | 32 | 32 | 0 |
| `packages/cases` | `npm run test:cases` | 12 | 12 | 0 |
| `packages/analyst` | `npm run test:analyst` | 159 | 159 | 0 |
| `packages/agent` | `npm run test:agent` | 52 | 52 | 0 |
| `apps/server` | `npm run test:server` | 620 | 620 | 0 |
| `apps/metermcp` | `npm run test:metermcp` | 80 | 80 | 0 |
| `apps/web` (vitest, 35 archivos) | `npm run test:web` | 435 | 435 | 0 |
| Total | | 1,427 | 1,427 | 0 |

La ejecución registrada anterior, del commit desplegado el 19/10/2026:

**2026-10-19 12:35Z · commit `fbe9621` · Node v24.19.0 · Windows (MINGW64_NT-10.0-26220).**

| Suite | Comando | Tests | Pasan | Fallan |
|---|---|---|---|---|
| `packages/paypal` | `npm run test:paypal` | 31 | 31 | 0 |
| `packages/hosting` | `npm run test:hosting` | 19 | 19 | 0 |
| `packages/cases` | `npm run test:cases` | 11 | 11 | 0 |
| `packages/analyst` | `npm run test:analyst` | 152 | 152 | 0 |
| `packages/agent` | `npm run test:agent` | 52 | 52 | 0 |
| `apps/server` | `npm run test:server` | 486 | 485 | **1** |
| `apps/metermcp` | `npm run test:metermcp` | 71 | 71 | 0 |
| `apps/web` (vitest, 26 archivos) | `npm run test:web` | 309 | 309 | 0 |
| Comprobación de tipos | `npm run typecheck` | — | exit 0 | — |

`npm test` salió con 1 en `test:server`, así que `test:metermcp` y `test:web` se ejecutaron por separado (ambos con
exit 0).

**El test intermitente.** En `apps/server/test/uploads-pdf-recovery.test.ts`, *size: five dense A4 pages rebuild under
MAX_STORED_BYTES, and with the demo PDFs stay under PAYPAL_MAX_SEND_BYTES* falló bajo la carga de la suite completa con
`429 RATE_LIMITED` en su paso de tapar y confirmar (la ejecución duró 39 s). Ejecutado solo, dos veces, el archivo pasó
3/3 en ambas. Es sensible a la carga: el rechazo vino de un límite de frecuencia dentro de la propia preparación del
test. Causa (encontrada el 19/10): mientras el trabajo de PDF iba lento bajo carga, el sondeo del test a `GET /uploads`
cada 100 ms agotaba el límite de la API alojada (300 peticiones cada 5 min) y la siguiente petición recibía `429`. El kit
de tests sube ahora ese límite para estos tests, y el sondeo (`settled()`, `waitFor()`) comprueba el `200` y pregunta
cada 300 ms.

**No ejecutado:** las suites en Linux (la plataforma de alojamiento) y en Render. El comportamiento exclusivo de Linux,
como matar el proceso hijo de PDF por encima de 200 MiB de RSS, solo se ejercita donde el test puede leer `/proc`
(**Pendiente** en Linux). Los recuentos de tests anteriores citados en notas privadas pertenecen a commits anteriores y
no se reutilizan aquí.

## Qué cubren las suites

| Área | Archivos de test principales | Notas |
|---|---|---|
| Cliente de PayPal | `packages/paypal/test/{client,disputes,orders,webhooks}.test.ts` | Reintentos (429 con el mismo `PayPal-Request-Id`, GET 408/5xx), caché de OAuth, provide-evidence multipart, petición de verificación del webhook |
| Alojamiento | `packages/hosting/test/hosting.test.ts` | Topes diarios (fallan en cerrado), limitador de frecuencia, dirección del cliente detrás de proxies, cabeceras de seguridad, arranque solo en sandbox |
| Pipeline del analista | `packages/analyst/test/{pipeline,deterministic,injection,prompts,providers}.test.ts` | Comprobación literal, guarda de números, reglas de citas, escaneo de inyección, respaldo (fallback) de proveedor, todo con un modelo falso |
| Herramientas de evaluación | `packages/analyst/test/evals-*.test.ts` | Puntuación, métrica estricta, congelación del held-out, recálculo (sin modelo) |
| Motor del agente | `packages/agent/test/{engine,meter,models}.test.ts` | Consulta [más abajo](#agente-comprador-tests-unitarios-y-ejecuciones-observadas-en-sandbox) |
| API del servidor | `apps/server/test/{app,hosted,auth,environments,sellers,mapping,bindings,reserve,webhook,ops}.test.ts` | Guardas, inicio de sesión, espacios de trabajo, comprobación de vinculaciones, rotación, webhooks, informe de ops |
| Envío | `intent.test.ts`, `intent-sessions.test.ts`, `review-fixes.test.ts`, `analysis.test.ts` | Composición, aprobación por hash, invalidación, bloqueo por disputa, auditoría duradera, recomprobaciones |
| Acciones de disputa | Servidor: `actions.test.ts`, `accept-claim.test.ts`, `make-offer.test.ts`, `escalate.test.ts`, `evidence-after-escalation.test.ts`, `intent-locks.test.ts`, `contract-read.test.ts`, `reserve.test.ts`, `hosted.test.ts`. Web: `domain/actions.test.ts`, `actionContracts.test.ts`, `actionReadback.test.ts`, `actionSend.test.ts`, `simulatedActions.test.ts`, `amounts.test.ts`, `components/ActionFlow.test.tsx` | Fakes construidos a partir de los contratos registrados de PayPal (`packages/paypal/contracts/`), sin llamadas a PayPal: hashes por acción y repetición entre acciones, rol solo del Owner en cada paso, la segunda confirmación ligada, el analizador de importes, bloqueos en curso / incierto / duplicado cargados desde el log de envíos, evidencia por fase, pruebas de relectura atribuibles (un mensaje idéntico anterior, el cambio de estado de otro actor), `NEEDS_REVIEW`, reinicio y reconciliación, protección de la rotación, estados del simulador solo desde contratos |
| Subidas | `uploads-{image,text,ocr,store,routes,documents,pdf-input,pdf-routes,pdf-recovery}.test.ts`, `pdf-image.test.ts` | Consulta [Seguridad y privacidad](security-and-privacy.md#archivos-no-fiables) |
| Agente en el servidor | `agent-routes.test.ts`, `agent-runs.test.ts`, `agent.test.ts` | Topes, visibilidad, recuperación, liquidación a partir del recibo, regla de vinculación E5 |
| Scripts | `demo-check.test.ts`, `demo-prepare.test.ts` | Análisis de argumentos, comprobaciones de la reserva, evaluación de la preparación |
| MeterMCP | `apps/metermcp/test/{app,meter,failclosed,hosted,limits,demo-agent}.test.ts` | Medición, reservas atómicas, aprobación que falla en cerrado, liquidación, guardas de administración, migración del ledger (un fallo forzado deja el esquema y las filas sin cambios; reabrir un ledger migrado no hace nada) |
| Web | `apps/web/src/**/*.test.{ts,tsx}` (vitest, `environment: 'node'`) | Lógica de dominio pura: entornos, construcción de intents, comparación de la relectura, borradores, decisiones de revisión de PDF, vista de ejecuciones del agente; los componentes de acciones de disputa renderizados a HTML estático (`renderToString`), sin DOM de navegador. **Sin tests de renderizado del DOM** para la interfaz de subidas y PDF (carencia conocida) |

## Observaciones en sandbox

Todas en el **sandbox** de PayPal; nada se ha ejecutado contra PayPal live. Las fechas son cuándo se registraron
(evidencia privada). Una observación es un ejemplo, no una garantía.

| Observado | Fecha |
|---|---|
| Disputas leídas y mapeadas desde la Customer Disputes API | 09/10, 17/10 |
| Presupuesto de MeterMCP autorizado, captura parcial con el resto ya no retenido, llamada fallida no cobrada (cliente MCP con guion (scripted)) | 09/10 |
| Una autorización sin usar anulada | 08/10 |
| Comprobación de identidad «Continue with PayPal» (modo alojado en localhost) | 10/10 |
| Dos revisores enviaron evidencia; relectura «Recorded by PayPal», 6 de 6 campos | 17/10 |
| Recomprobaciones en directo de frases editadas; un nuevo análisis de unos 35 s; rotación de la reserva; entregas de webhook verificadas | 17/10 |
| Una subida PNG tapada enviada y registrada por PayPal (la copia de PayPal solo tenía IHDR/IDAT/IEND, con el tapado incrustado) | 18/10 |
| Dos ejecuciones del agente dirigido por el modelo en `/agent` | 19/10 (abajo) |
| `demo:check` READY excepto la reserva estándar vacía | 19/10 |
| Un pago con una disputa abierta apareció retenido; las páginas web de sandbox del vendedor no ofrecían reembolsarlo fuera del caso | 19/10 |
| Escrituras de contrato de acciones de disputa W-1 a W-12 aprobadas por el propietario, enviadas fuera del flujo de la app (a nivel de contrato, no la app): W-1 a W-6, W-9 y W-10 registradas, W-7 rechazada, W-8, W-11 y W-12 no enviadas ([detalles](../technical/paypal-integration.md#contratos-de-las-acciones-de-disputa)) | 20/10 |
| Seis variantes de acciones de disputa enviadas una vez cada una por el flujo propio de la app (el servidor de la rama ejecutado en local) y releídas «Recorded by PayPal», V-1 a V-6; solo V-4 movió dinero, un reembolso de 7.00 USD ([detalles](../technical/paypal-integration.md#contratos-de-las-acciones-de-disputa)) | 20/10 |

**No observado en el sandbox (Pendiente):** un mensaje con adjunto enviado a través de la app (la interfaz aún no
puede adjuntar); las acciones de disputa en el servicio desplegado; un timeout de PayPal o un
envío incierto; `capture_pending` de MeterMCP; la
recuperación del agente tras un reinicio; **Stop** en una ejecución real; el respaldo con Groq para el agente; subidas de
texto pegado y de PDF enviadas a PayPal; creación de passkeys en el servicio desplegado; el registro de ejecución E5 en
un caso vinculado; `npm run demo-agent` contra el MeterMCP alojado.

## Comprobaciones en navegador

No existen tests automatizados de navegador. Comprobaciones manuales registradas: el flujo de subida de PDF recorrido
en un navegador (notas de seguimiento, 18/10); la prueba de humo de la página `/agent` en un navegador local sin clave
de modelo y sin llamadas externas (notas de seguimiento); revisores usando la app desplegada en sus propios navegadores
(17/10, 18/10); Compare, Keep y la vuelta desde PayPal a `/agent?run=` (19/10).

## Agente comprador: tests unitarios y ejecuciones observadas en sandbox

Las evaluaciones del analista no miden el agente. La evidencia del agente es:

1. **Tests unitarios y de integración (simulados).** `packages/agent/test/engine.test.ts`, `meter.test.ts`,
   `models.test.ts` (52 tests el 19/10) con modelos falsos con guion y un MeterMCP falso: una acción por turno, dos
   turnos no válidos detienen la ejecución, rechazo de herramientas desconocidas o no ofrecidas y de argumentos
   incorrectos, `insufficient_balance`, presupuesto abierto exactamente por el tope, respaldo de proveedor fijado tras
   la primera respuesta, límites, fallos inyectados nunca cobrados, liquidación tomada solo del recibo. En el servidor:
   `agent-routes.test.ts`, `agent-runs.test.ts`, `agent.test.ts` (topes, visibilidad, write-ahead, recuperación tras
   reinicio, reconciliación). En MeterMCP: `apps/metermcp/test/hosted.test.ts` para el `/agent/mcp` privado.
2. **Dos ejecuciones observadas en el sandbox (19/10/2026)**, en la página `/agent` desplegada, Gemini
   `gemini-3.8-flash`, cada presupuesto de 2.00 USD aprobado con una cuenta personal (buyer) del sandbox (PayPal
   rechazó la aprobación con la cuenta business del vendedor: «Estás entrando en la cuenta del vendedor…» (texto recortado en el registro); observado el 19/10, no documentado por PayPal):
   - Un objetivo que las herramientas no podían cumplir del todo, con **Simulate an outage** (simular una caída): el
     modelo llamó a `quote_lookup` (0.05, cobrado), después `deep_report` falló por la caída inyectada (etiquetado, no
     cobrado), y terminó con `cannot_do`, diciendo qué faltaba. Recibo: capturado 0.05, liberado 1.95.
   - Un objetivo que cumplió una herramienta: `bulk_export` (0.92, cobrado), y después `done`. Recibo: capturado 0.92,
     liberado 1.08.
   El uso del modelo se mostró aparte del presupuesto. Son dos ejemplos, no una garantía general de autonomía.
3. **El registro.** Ambas ejecuciones están documentadas en las notas de evidencia privadas del propietario del
   19/10/2026 (aquí se omiten los ids de pedido, sesión y captura).

No es evidencia sobre el agente: el caso sintético del agente (1.37 de 5.00 USD, cuatro llamadas) y las evaluaciones
EV-11/EV-12 son datos de demo que prueban el **analista**; la sesión de sandbox de 1.37 USD del 09/10 la hizo el
anterior cliente con guion (scripted), no el agente dirigido por el modelo.

## Carencias de las pruebas

- Sin tests del DOM para la interfaz de subidas y de revisión de PDF (`useUploads`, `PdfSelect`, `PdfReview`, el
  cableado de `CasePage`).
- Rutas exclusivas de Linux (matar por RSS al hijo de PDF) no ejecutadas en Linux; memoria de un PDF de 5 páginas en
  Render no medida.
- Comportamiento contra PayPal live: ninguno.
- Acciones de disputa: probadas con fakes y una escritura de contrato registrada por variante; el flujo de la app contra
  el sandbox se ejecutó una vez por variante verificada (20/10/2026, un servidor local), no para el mensaje con archivo;
  el código está desplegado (`5111b88`), pero estas acciones no se han ejercitado en el servicio alojado.

La lista completa, con fuentes, está en [Problemas conocidos](known-issues.md).
