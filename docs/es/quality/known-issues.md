[English](../../quality/known-issues.md) | [Español](known-issues.md)

# Problemas conocidos

Seguimientos abiertos, actualizados para el código en `667abb3` (desplegado el 31/10/2026); revisados línea a línea por primera vez en `fbe9621` (19/10/2026). Cada punto indica su fuente (las listas de seguimiento de los mantenedores, con la clave de abajo) y, cuando procede,
la ubicación en el código. Los puntos marcados **por diseño** se mantienen a propósito, pero conviene conocerlos. Los límites del producto
(lo que ResolveKit no hace) están en [Limitaciones](../product/limitations.md).

Fuentes: **P1** seguimientos del trabajo de evidencia del comerciante (17/10) · **PDF** seguimientos del trabajo de PDF (18/10)
· **AG** seguimientos del agente comprador (18/10) · **ENV** seguimientos de los tres entornos (18/10) ·
**EV** seguimientos de las evaluaciones del analista (19/10) · **TR** la ejecución de tests del 19/10 ([Pruebas](testing.md)) ·
**DA** el diseño de las acciones de disputa (19/10) y el código
en `076c74f` (20/10/2026), ahora en `667abb3`.

## Subidas y PDF

| Problema | Efecto | Fuente |
|---|---|---|
| Un archivado fallido nunca se reintenta | Si falla la escritura de un registro archivado en la rotación, la subida sigue `confirmed` para la disputa antigua (en ninguna entrada) y sus archivos y texto se quedan en disco, contando para los 300 MiB; el barrido horario no lo reintenta | P1; `uploads/store.ts` (`archiveCase`, `sweep`) |
| `closeOcr()` no tiene límite de tiempo | Se espera dentro de la franja pesada antes de que arranque un hijo de PDF; un arranque del worker que nunca terminara retendría la franja hasta un reinicio (el presupuesto de 30 s para arrancar el OCR lo acota por el lado del OCR) | PDF; `uploads/pdf-input.ts` |
| Memoria en Render con un PDF de 5 páginas no medida | Se desconoce el pico de memoria en la instancia de 512 MB para la ruta de PDF; una lectura anterior de una imagen de 8 MP llegó a ~395 MB (seguimiento P1, 17/10/2026). Se sugiere `MALLOC_ARENA_MAX=2`, no probado | P1, PDF (ops) |
| Plazo de las miniaturas con 0.5 CPU | 3 s por miniatura puede quedarse corto para PDF reales | PDF (ops) |
| Tamaño de la reconstrucción | Reconstruir 5 páginas retiene unos 60 MB de RGB antes de escribir | PDF (ops) |
| Matar por RSS en Linux no medido con una bomba real | El techo de memoria del hijo de PDF se prueba con un lector falso; no se ha medido en el Linux del alojamiento | `uploads/pdf-input.ts`; `uploads-pdf-input.test.ts` |
| Las pistas de PDF comparten el cubo de lecturas de PayPal | Las pistas de la capa de texto cuentan contra el límite por dirección de 60 lecturas / 5 min | PDF (por diseño); `hosted.ts` |
| `evidenceNumber` duplicado | La misma función auxiliar existe en 4 archivos (`app.ts`, `uploads/documents.ts`, `uploads/routes.ts`, `web/domain/uploads.ts`) | P1 |
| Finales de línea CRLF en `apps/server/test/uploads-kit.ts` | Finales de línea mezclados en una función auxiliar de test | PDF |

## Agente comprador y MeterMCP

| Problema | Efecto | Fuente |
|---|---|---|
| `budget_exists` bloquea mientras se liquida | Se rechaza un presupuesto nuevo en la misma sesión MCP mientras el anterior está `closing`, `settlement_failed` o `capture_pending` | AG; `ledger.ts`, `meter.ts` |
| `PERSON_CAP` se reinicia a medianoche UTC | No a medianoche local | AG (por diseño); `agent/person-caps.ts` |
| Vinculación del caso del agente (31/10/2026) | Hasta el 31/10/2026 el caso del agente alojado apuntaba a una sesión creada por el anterior cliente MCP con guion (vinculación del 18/10). Desde el 31/10/2026 está vinculado a la disputa de una ejecución dirigida por el modelo (tope de 0.50 USD, 0.45 capturados), comprobada contra el importe que capturó su recibo de MeterMCP; la disputa anterior está en reserva. La vinculación nombra la captura, la ejecución y su sesión de MeterMCP; el caso alojado mostró E4 y E5 el 31/10/2026 (grabación del propietario) | AG; configuración en tiempo de ejecución; evidencia del propietario del 31/10/2026 |
| La vinculación del caso del agente caduca hacia el 07/11/2026 | La disputa de sandbox anterior del caso del agente (vinculada el 18/10/2026, ahora en reserva) caduca hacia el 07/11/2026; la disputa vinculada el 31/10/2026 tiene «Respond by» el 20 nov 2026 (visto en la cabecera del caso alojado), así que la cubre el relleno del 28–30/11 como las demás; antes de la evaluación del jurado hay que volver a vincularlo con `demo:prepare --agent-run <id>`, que imprime una vinculación que nombra la ejecución. Previsto, aún no hecho: **Pendiente** | Notas de estado del propietario del 19/10/2026 (notas privadas de la entrega, no están en este repositorio) |
| Pasos de cierre sin evidencia | No constan **Stop** en una ejecución real, la CLI `npm run demo-agent` contra el MeterMCP alojado, ni la retirada de `METERMCP_FAIL_FIRST` del servicio alojado (sí constan las dos ejecuciones en `/agent`, Compare, Keep y la vuelta) | AG; evidencia privada 19/10 |

## Acciones de disputa

| Problema | Efecto | Fuente |
|---|---|---|
| Importe reembolsable en otra moneda | Si el importe reembolsable de PayPal estuviera en una moneda distinta de la de la disputa, un importe se rechaza con `AMOUNT_ABOVE_REFUNDABLE` («The amount must be below / at most what PayPal would refund, <amount>») citando la otra moneda, sin decir que las monedas difieren. Nunca visto en el sandbox (todas las disputas eran en USD) | DA; `apps/web/src/domain/actions.ts` (comprobaciones de importe en `composeActionWith`) |
| README de contratos desactualizado | `packages/paypal/contracts/README.md` sigue diciendo que no se envió ninguna escritura y que todas las variantes están «Not available»; el registro (`actionContracts.ts`) y los archivos registrados son el estado actual | DA; `packages/paypal/contracts/README.md` |
| Mensaje con archivo: una sola observación | El editor adjunta una subida confirmada (`send_message:file`); se envió una vez a través de la app en el sandbox (V-7, 21/10/2026, ejecución local) y se releyó «Recorded by PayPal» con 1 documento; la relectura prueba el texto y la presencia del documento, no su contenido; una sola observación; el estado del registro está desplegado (`667abb3`) | DA; `apps/web/src/components/ActionComposer.tsx` |
| La respuesta del comprador a una oferta nunca se registró | Una oferta pendiente se juzga por el enlace `make_offer` en directo de PayPal y, como respaldo, cualquier entrada de oferta posterior la termina; los nombres de evento del comprador son desconocidos | DA; `actions.ts` (`pendingSellerOffer`) |
| Las reglas cubren un motivo, una fase y los estados registrados | Aceptar, ofertar y escalar solo se componen en disputas de artículo no recibido que esperan al vendedor, un mensaje también mientras PayPal espera al comprador, y toda acción solo en `INQUIRY`, porque las escrituras registradas no cubrieron nada más; lo demás se rechaza, no se adivina (**por diseño**) | DA; `actions.ts` (`RECORDED_STAGES`, `RECORDED_STATUSES`, `ACTION_RULES`) |
| «Ausente» tras 60 s es un riesgo residual | Una relectura prueba un envío ausente cuando PayPal no muestra ninguna entrada nueva del vendedor 60 s después de `send_started` y sigue ofreciendo la acción (`absentAfterMs`, el doble del retraso que mostró el sandbox). Si PayPal registrara alguna vez una entrada más tarde, un reintento tras «ausente» podría publicar la acción dos veces; nunca observado en el sandbox | DA; `actionContracts.ts` (`absentAfterMs`), `actionReadback.ts` (`proveSend`) |
| Una retención cuyo intent se perdió no se puede releer | Si se pierde `intents.json`, una disputa retenida se reconstruye desde el log de envíos (solo hashes) y sigue retenida: ninguna relectura puede probarla; el operador restaura el archivo o revincula el caso (Runbook) (**por diseño**) | DA; `intents.ts` (`seedFromSendLog`), `actions/routes.ts` |
| Apelación no implementada | El único intento de preparación (W-7, 20/10/2026, una cuenta de comprador normal) fue rechazado, así que la apelación sigue «Not available». PayPal documenta que el sandbox permite apelaciones cuando el email de la cuenta de comprador del sandbox contiene `allowappeal` (y `noappeal` para lo contrario; [PayPal](https://developer.paypal.com/disputes/test-go-live), según PayPal DevRel dijo en el Discord de la hackathon el 30/10/2026); ResolveKit no lo ha probado | DA; `packages/paypal/contracts/appeal-setup-adjudicate.json` |
| `provide_supporting_info` no soportado | PayPal lo ofrece tras evidencia en una reclamación; ResolveKit no muestra nada que enviar | DA; `apps/web/src/domain/simulatedActions.ts` |
| Prueba de reembolso no enviada | Si PayPal solo pide esa, en esta entrega no se puede enviar evidencia en esa disputa; W-11 es una prueba de sandbox pendiente | DA; `actionContracts.ts` |
| El flujo de la app, verificado una vez por variante, ejercitado en el servicio alojado solo para hacer una oferta | Cada variante verificada se envió una vez a través de la app en un servidor local (20/10/2026, V-1 a V-6; el mensaje con archivo el 21/10/2026, V-7): observaciones únicas. Las variantes No disponibles no se ejecutaron a través de la app; el código está desplegado (`667abb3`) y en el servicio alojado solo se envió hacer una oferta (31/10/2026, cuatro ofertas de 3.50 USD (en cuatro disputas); código `f1b7236`, después `d654478` y `667abb3`), mientras que mensaje, aceptación y escalado no (**Pendiente**) | DA |

## Entornos, inicio de sesión y health

| Problema | Efecto | Fuente |
|---|---|---|
| Health dice `unconfigured` antes del primer contacto con PayPal | `/api/health` informa PayPal como no configurado hasta que la primera comprobación diferida tiene éxito | ENV; `app.ts` |
| La pantalla de comprobación relee cada 5 s | Consulta periódica mientras la conexión del espacio de trabajo está en `checking` | ENV; `web/src/domain/environment.ts` |
| `joinUrl` solo lo usa su test | Función auxiliar muerta | ENV; `environment.ts` |
| Conexión de comerciantes no construida | No hay código de PayPal Platform / Partner Referrals; los comerciantes nuevos ven la pantalla de espera (**Pendiente**) | ENV; no hay código `partner-referrals` ni `PayPal-Auth-Assertion` en `apps/` ni en `packages/` |

## Operaciones

| Problema | Efecto | Fuente |
|---|---|---|
| Auto-deploy sigue en `commit` para ambos servicios | El orden de despliegue MeterMCP → ResolveKit no está garantizado en un push; el seguimiento recomienda desactivarlo para `resolvekit` | AG; `render.yaml` |
| Caso estándar sin reserva (a 31/10/2026, noche) | Los nuevos envíos de evidencia al sandbox real ahí están **Pendientes**; el caso de liquidación está vinculado y el del agente está vinculado con 1 en reserva; la reserva se rellena para la evaluación el 28–30/11/2026; hasta entonces la ruta por defecto es la Explore demo | evidencia privada 19/10 |
| Sin copias de seguridad, exportación ni borrado de cuentas | Consulta [Copias de seguridad y recuperación](../operations/backup-and-recovery.md), [Retención y borrado](../operations/retention-and-deletion.md) | no hay código de copias de seguridad en el repositorio |
| Los registros de auditoría y de dinero no caducan nunca | El log de envíos (`audit-events-sends.jsonl`) y el ledger de MeterMCP crecen sin límite en discos de 1 GB (**por diseño**: son los registros de auditoría y de dinero; la caché de análisis y el log de uso están acotados) | `intents.ts`, `apps/metermcp/src/ledger.ts` |
| Un registro de subida corrupto se barre | Un directorio de subida cuyo `record.json` no se puede leer lo elimina el barrido horario como resto (sus archivos también); no se conserva como en los demás almacenes. Las escrituras duraderas lo hacen improbable | `uploads/store.ts` (`readRecord`, `sweepDisk`) |

## Pruebas y evaluaciones

| Problema | Efecto | Fuente |
|---|---|---|
| Sin tests del DOM para la interfaz de subidas y PDF | `useUploads`, `PdfSelect`, `PdfReview`, `CasePage` y el cableado del borrado del borrador solo están cubiertos como funciones puras y por un recorrido manual en navegador | PDF |
| Suites no ejecutadas en Linux / Render | Solo constan ejecuciones en Windows | TR |
| Lote held-out de Groq no ejecutado | Se detuvo por cuota en el primer intento; 35 ejecuciones de caso sin ejecutar; reanudación prevista cuando se renueve la cuota gratuita | EV; `packages/analyst/evals/results/summary.md` |

## Sin recomprobar

Aparecen en los seguimientos pero no se han verificado contra el código para esta página: la validación de PNG que
infla dos veces (P1); los puntos menores de P1 (stub del test de OCR, «[redacted]» literal, orden del almacén, rutas,
`confirmedCorrections` en intents antiguos); el límite de acciones web mostrado en `/agent` (la página usa el valor del
registro de ejecución cuando existe) (AG); los puntos menores del puntuador, el runner y los tests de EV (EV).
