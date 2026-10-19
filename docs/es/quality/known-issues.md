[English](../../quality/known-issues.md) | [Español](known-issues.md)

# Problemas conocidos

Seguimientos abiertos, comprobados contra el código en `fbe9621` el 19/10/2026. Cada punto indica su fuente: el
archivo de seguimiento en [`docs/superpowers/plans/`](../../superpowers/plans/) y, cuando procede, la ubicación en el
código. Los puntos marcados **por diseño** se mantienen a propósito, pero conviene conocerlos. Los límites del producto
(lo que ResolveKit no hace) están en [Limitaciones](../product/limitations.md).

Fuentes: **P1** `2026-10-17-merchant-evidence-phase1-followups.md` · **PDF** `2026-10-18-merchant-evidence-pdf-followups.md`
· **AG** `2026-10-18-model-driven-agent-followups.md` · **ENV** `2026-10-18-three-environments-followups.md` ·
**EV** `2026-10-19-analyst-evals-h04-followups.md` · **TR** la ejecución de tests del 19/10 ([Pruebas](testing.md)).

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
| Caso del agente vinculado a una sesión del cliente con guion (scripted) | La vinculación del caso del agente alojado (18/10) apunta a una sesión creada por el anterior cliente MCP con guion, no por el agente dirigido por el modelo; ninguna vinculación nombra todavía una ejecución | AG; configuración en tiempo de ejecución |
| La vinculación del caso del agente caduca hacia el 07/11/2026 | La vinculación actual del caso del agente (su disputa de sandbox, vinculada el 18/10/2026) caduca hacia el 07/11/2026; antes de la evaluación del jurado hay que volver a vincularlo con `demo:prepare --agent-run <id>`, que imprime una vinculación que nombra la ejecución. Previsto, aún no hecho: **Pendiente** | Notas de estado del propietario del 19/10/2026 (notas privadas de la entrega, no están en este repositorio) |
| Pasos de cierre sin evidencia | No constan **Stop** en una ejecución real, la CLI `npm run demo-agent` contra el MeterMCP alojado, ni la retirada de `METERMCP_FAIL_FIRST` del servicio alojado (sí constan las dos ejecuciones en `/agent`, Compare, Keep y la vuelta) | AG; evidencia privada 19/10 |

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
| Reserva estándar vacía | Los nuevos envíos en el caso estándar están **Pendientes** hasta que se rellene la reserva (previsto del 25 al 30/11) | evidencia privada 19/10 |
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
