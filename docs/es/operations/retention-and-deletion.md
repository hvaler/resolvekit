[English](../../operations/retention-and-deletion.md) | [Español](retention-and-deletion.md)

# Retención y borrado

Qué guardan ResolveKit y MeterMCP, durante cuánto tiempo y qué lo borra. Todo lo que aparece aquí sale del código en
`fbe9621` (Implementado · Probado en local salvo que se indique otra cosa). No hay función de borrado de cuentas ni de
exportación de datos; una solicitud para borrar los datos de alguien la gestiona el operador a mano en el disco
(**Pendiente**: no hay procedimiento ni herramienta).

**Lo que guarda PayPal queda fuera de ResolveKit.** La evidencia enviada con provide-evidence (notas, seguimiento,
archivos llamados `E<n>-upload.png` (`.jpg` si es una foto tapada), `E<n>-upload.pdf` o `E<n>-pasted.pdf`) queda en el registro de la disputa en
PayPal, y los pedidos, autorizaciones y capturas de MeterMCP quedan en PayPal. Borrar algo en ResolveKit no lo elimina
de PayPal.

## Subidas del comerciante, por estado

| Estado | Qué existe | Cómo termina |
|---|---|---|
| `pending`, `reviewing` | Archivo original, renders/miniaturas (PDF), el texto leído, el registro. Solo quienes pueden editar ven archivos y texto; los demás ven metadatos con `restricted: true` | **Confirm as evidence** (confirmar como evidencia), **Discard** (descartar) o caducidad: 24 h después de subirla se descarta la próxima vez que se toca y con el barrido horario |
| `confirmed` (`E<n>`) | El archivo saneado (PNG recodificado, o JPEG si es una foto tapada, o un PDF reconstruido solo con imágenes de las páginas tapadas), sus líneas y el registro. El original y los renders sin tapar se descartan al confirmar | **Delete** (borrar; owners y miembros completos), o archivado cuando el caso pasa a la siguiente disputa. Sin límite de tiempo en otro caso |
| `discarded` | Solo el registro (metadatos): sin archivo ni texto | Se conserva |
| `deleted` | Solo el registro (metadatos) | Se conserva |
| `archived` | Solo el registro (el caso rotó a otra disputa) | Se conserva. Si falló la escritura del archivado, los archivos y el texto se quedan y la subida sigue `confirmed` para la disputa antigua (no se reintenta: problema conocido) |

**Delete** de una subida confirmada se rechaza mientras haya en curso un envío que la adjunte o la cite
(`409 SEND_IN_PROGRESS`). En otro caso, primero elimina todo lo que la cita: los análisis guardados que la leyeron (y sus
trabajos, progreso y veredictos de recomprobación) y el pin de entrada del caso; después anula todos los intents no
enviados que la adjuntan o que se compusieron con ella, y registra `upload_deleted` en la auditoría. Si la purga falla,
la subida no se borra (`500 PURGE_FAILED`, reintenta).

Los nombres de archivo nunca salen del servidor: PayPal recibe nombres `E<n>-…`; el modelo solo ve títulos.

## Otros datos en el disco de `resolvekit`

| Datos | Se conservan | Los borra |
|---|---|---|
| Intents de envío (`intents.json`, incl. el texto de las notas aprobadas) | Abiertos: TTL de 30 min. Envío fallido: reintentable 30 min. Enviados: 24 h. Como máximo 2 000 guardados | Caducidad, sustitución, cancelación, invalidación (salen del almacén de inmediato; una lápida acotada de 2 000 guarda el último estado para los mensajes de error, en memoria) |
| Marcas de «ya enviado para esta disputa» | Con `intents.json` | No caducan en el código |
| Eventos de auditoría (`audit-events.jsonl`) | 200 por propietario de sesión, 2 000 propietarios; se compacta por encima de 4 MiB | Expulsión de los más antiguos por propietario |
| Log de auditoría de envíos (`audit-events-sends.jsonl`) | **Solo añadir, nunca se expulsa ni se compacta** | Nada |
| Registros de ejecución del agente (`agent-runs/`) | 30 días | Se barren cada 5 min pasados 30 días, **salvo** que se conserven (**Keep**, owner), estén sin liquidar (`open`, `capture_pending`, `failed`, `unverified` con sesión), aún no se hayan guardado, o su captura esté vinculada a un caso (activo o de reserva) |
| Caché de análisis, log de uso del analista, pins de entrada | **Sin caducidad en el código** | Solo el borrado de una subida purga los análisis que citan esa subida |
| Veredictos de recomprobación | Se guardan 2 000, en memoria (se pierden al reiniciar); un intent conserva los veredictos con los que se compuso | Se descartan los más antiguos; borrado de subida |
| Cuentas (`accounts.json`: payer ids, nombres visibles, correos enmascarados, claves públicas de passkey, hashes de tokens de invitación) | No caducan | **Sin borrado.** Revocar a un miembro o una invitación lo marca con `revokedAt` y termina sus sesiones; el registro se queda. Los owners no se pueden revocar |
| Sesiones (cookies) | 12 h | Caducidad; **Sign out of all devices** (cerrar sesión en todos los dispositivos); revocación; fin del acceso de revisor |
| Vendedores vistos (`sellers.json`) | No caducan | Se actualizan cuando cambian las vinculaciones |
| Archivos de topes diarios | Un día UTC de recuentos | Se sustituyen cada día |
| Solo en memoria (se pierden al reiniciar) | Pistas de texto de PDF (una vez por página y revisión, nunca se guardan ni se registran), ids de eventos de webhook (2 000), avisos de webhook (50), retos WebAuthn (5 min), inicios de sesión de PayPal pendientes (15 min) | Reinicio, o sus propios límites |

## Disco de MeterMCP

| Datos | Se conservan | Los borra |
|---|---|---|
| Ledger (`metermcp.sqlite`: sesiones, llamadas con hashes de petición/respuesta, liquidaciones) | **Sin caducidad en el código** | Nada |
| Recuento diario de presupuestos | Un día UTC | Se sustituye cada día |
| Transportes MCP | 15 min de inactividad | El barrido de 30 s los cierra (y su sesión de pago) |

## Logs

Ambos servicios escriben los logs en la salida estándar (en Render, el log del servicio). Las líneas de log llevan ids,
códigos, recuentos, tiempos y recuentos de tokens; nunca texto de documentos, contenido de archivos, claves ni tokens
(la primera petición registra, enmascarado, cómo se obtuvo la dirección del cliente). Su retención es la de Render, no
la fija el código.

## Borrar datos a mano (operador)

No hay herramienta. Si alguien pide que se eliminen sus datos, el operador, con ambos servicios suspendidos (consulta
[Copias de seguridad y recuperación](backup-and-recovery.md#copias-coherentes)), borraría primero sus subidas desde la
app (para que se purguen los análisis que las citan) y después editaría `accounts.json` a mano. Las ediciones a mano no
están probadas y pueden impedir un arranque (un `accounts.json` ilegible detiene el servicio). El log de envíos de solo
añadir y los registros propios de PayPal no se pueden borrar así. **Pendiente:** un procedimiento con soporte.
