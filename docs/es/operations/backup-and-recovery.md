[English](../../operations/backup-and-recovery.md) | [Español](backup-and-recovery.md)

# Copias de seguridad y recuperación

**No hay código de copias de seguridad en ResolveKit ni en MeterMCP.** Nada copia, exporta ni toma instantáneas de los
datos de forma programada, y no se ha probado ninguna restauración. Cada servicio guarda su estado en su propio disco
persistente de Render (1 GB en `/var/data`). Render describe instantáneas de los discos persistentes en su propia
documentación; no las hemos comprobado ni usado para este proyecto (**Pendiente**). Esta página explica qué copiar,
qué copias son coherentes y qué hace ya el código para recuperarse de una caída.

## Qué guarda cada servicio

### `resolvekit` (`RESOLVEKIT_DATA_DIR`, `/var/data` en Render; `apps/server/data/` en local)

| Ruta | Formato, cómo se escribe | Si se pierde |
|---|---|---|
| `accounts.json` | JSON, tmp + rename, archivo completo | Desaparecen todos los espacios de trabajo, personas, passkeys e invitaciones: el Owner vuelve a iniciar sesión con PayPal y reinvita a todo el mundo. Ilegible al arrancar: el servicio no arranca |
| `sellers.json` | JSON | Los vendedores vistos en disputas vinculadas se aprenden de nuevo en la siguiente lectura de PayPal. Ilegible al arrancar: el servicio no arranca |
| `intents.json` | JSON `{intents, sentDisputes}`, escritura diferida (200 ms), síncrona para `sending`; guarda el texto de las notas que aprobó el comerciante | Se pierden los intents abiertos (la gente vuelve a componerlos). Se pierde la memoria de «ya enviado para esta disputa»; la lectura nueva de PayPal antes de cada envío sigue rechazando cuando existe evidencia del vendedor. **Si es ilegible al arrancar se trata como vacío**, y la siguiente escritura lo sustituye |
| `audit-events.jsonl`, `audit-events-sends.jsonl` | JSONL de solo añadir (códigos, hashes, ids; sin texto de documentos). El primero se compacta por encima de 4 MiB; el log de envíos no se compacta nunca | El rastro de aprobaciones y envíos. Una última línea cortada se omite al leer |
| `analysis-cache/<sha256>.json` | JSON, tmp + rename | Los análisis en directo se recalculan (llamadas a modelos, dentro de los topes). Los análisis golden vienen con el código |
| `analysis-inputs.json` | JSON, tmp + rename | La entrada con la que se analizó un caso antes de que entrara la evidencia del vendedor; sin ella, un caso cuya evidencia ya está dentro puede necesitar un análisis nuevo |
| `analyst-usage.jsonl` | JSONL de añadir, solo recuentos de tokens y tiempos (en la medida de lo posible) | Solo el historial de uso |
| `uploads/<workspace>/<upload>/…` | `record.json` escrito al final, archivos tmp + rename | Las subidas del comerciante (archivos saneados, registros); la evidencia confirmada ya no se puede adjuntar |
| `agent-runs/<run-id>.json` | JSON por ejecución, tmp + rename | Registros de ejecución; un caso vinculado a una ejecución ya no puede mostrar su registro de ejecución (E5). El recibo de MeterMCP es aparte |
| `daily-caps.json`, `agent-run-caps.json` | `{day, counts}` | Los recuentos de hoy vuelven a cero (más cuota hoy) |
| `bindings.json` | JSON, solo se usa cuando `BINDINGS_JSON` no está definida | Las vinculaciones, salvo que estén en `BINDINGS_JSON` |

Fuera del disco: `BINDINGS_JSON` y todos los secretos viven en la configuración de entorno de Render; guarda las
vinculaciones que pegas (las imprime `demo:prepare`) en un lugar privado tuyo. `demo-prepare-runs/<run>.json` se
escribe en la máquina del operador, no en Render.

### `resolvekit-metermcp` (`METERMCP_DATA_DIR`, `/var/data` en Render)

| Ruta | Formato | Si se pierde |
|---|---|---|
| `metermcp.sqlite` (+ `metermcp.sqlite-wal`, `metermcp.sqlite-shm` mientras está abierta) | SQLite en modo WAL; tablas `sessions`, `calls`; cada decisión de dinero es una transacción | Todas las sesiones, llamadas, hashes y liquidaciones: los recibos no se pueden volver a generar y el caso del agente ya no puede mostrar su recibo. Los pedidos, autorizaciones y capturas de PayPal siguen en PayPal |
| `daily-caps.json` | `{day, counts}` (`budget`) | El recuento de presupuestos de hoy vuelve a cero |

## Copias coherentes

El código escribe cada archivo JSON de forma atómica (tmp + rename), así que un archivo copiado por sí solo es la
versión antigua o la nueva, nunca una a medias. **No** mantiene los archivos coherentes entre sí: una copia tomada
mientras el servicio funciona puede contener un intent sin su evento de auditoría, un registro de subida sin el
análisis que la cita, o un registro de ejecución por delante de su recibo de MeterMCP.

| Copia | ¿Coherente? |
|---|---|
| Ambos discos con ambos servicios **parados** (suspendidos en Render) | Sí: la copia de referencia |
| Un servicio parado | Los archivos de ese servicio son coherentes entre sí; pueden ir por delante o por detrás del otro servicio (un registro de ejecución frente a su sesión de MeterMCP) |
| `metermcp.sqlite` sola mientras MeterMCP funciona | **No**: las transacciones confirmadas pueden estar aún en `metermcp.sqlite-wal`. Copia los tres archivos juntos con MeterMCP parado, o usa la copia en línea propia de SQLite (`VACUUM INTO` o la API de backup; no está automatizado aquí, no está probado) |
| Un archivo JSON mientras funciona | Ese archivo es coherente internamente |
| Logs JSONL mientras funciona | Todas las líneas completas son válidas; una última línea cortada se omite al leer |

Procedimiento manual sugerido (no automatizado, no probado: **Pendiente**):

1. Avisa a los revisores; asegúrate de que no hay ninguna ejecución del agente ni ningún envío de evidencia en curso.
2. Suspende `resolvekit` y después `resolvekit-metermcp` (las ejecuciones del agente tienen 20 s para terminar como
   `interrupted` y liquidarse).
3. Copia `/var/data` de cada servicio con una herramienta de confianza (la shell o SSH de Render, donde tu plan lo
   ofrezca). Mantén las copias en privado: `accounts.json`, `intents.json` y las subidas contienen datos personales y
   textos aprobados.
4. Reanuda primero MeterMCP, después ResolveKit, y ejecuta `npm run demo:check`.

## Restauración

1. Suspende ambos servicios.
2. Vuelve a poner los archivos en cada `/var/data`, los tres archivos SQLite de MeterMCP juntos.
3. Arranca MeterMCP (migra el ledger si la copia es más antigua; una migración fallida no cambia nada y detiene el
   arranque), y después ResolveKit.
4. Comprueba: `demo:check`; inicia sesión como Owner; abre un caso vinculado y el rastro de auditoría.

Restaurar una copia antigua tiene consecuencias fuera de ResolveKit. PayPal conserva todo lo que se envió y todas las
capturas; puede que el estado restaurado no lo sepa. El servidor lee PayPal antes de cada envío, así que una disputa que
ya tiene evidencia del vendedor se rechaza (`SELLER_EVIDENCE_EXISTS`), pero las ejecuciones del agente y las sesiones
de MeterMCP posteriores a la copia desaparecen de la vista de ResolveKit. Nunca se ha ensayado una restauración
(**Pendiente**).

## Qué recupera el código por sí solo

| Situación | Comportamiento (código) |
|---|---|
| Caída a mitad de la escritura de cualquier almacén JSON | tmp + rename: el archivo antiguo sobrevive. Los `*.tmp` sobrantes se eliminan al arrancar (caché de análisis) o con el barrido horario de subidas (subidas) |
| Caída durante un envío de evidencia | El estado `sending` del envío y el evento `send_started` estaban en disco antes de llamar a PayPal (si no, `503 AUDIT_UNAVAILABLE`, no se envía nada). Al arrancar pasa a `failed` (*the server restarted during the send*), reintentable durante 30 min con el mismo intent y el mismo `PayPal-Request-Id`; primero se lee PayPal |
| PayPal aceptó, el resultado no se escribió | Se registra `AUDIT NOT DURABLE`; la relectura de PayPal es la verdad |
| Caída durante una ejecución del agente | Al arrancar la ejecución pasa a `interrupted`; una llamada anunciada sin respuesta pasa a `uncertain` y nunca se repite; la sesión se cierra y el recibo se vuelve a leer (recuperación tras reinicio en el sandbox: **Pendiente**) |
| Caída durante un trabajo de PDF | La subida se marca como fallida (*The server restarted while reading this PDF…*) y se descartan sus archivos |
| Caída durante una captura de MeterMCP | La sesión se queda en `closing` / `settlement_failed` / `capture_pending`; el barrido de 30 s, un cierre o una reconciliación reintentan con el mismo `PayPal-Request-Id` |
| Falla la migración del ledger | Se revierte en una transacción; MeterMCP no arranca |
| `daily-caps.json` ilegible | Se deja tal cual (no se sobrescribe); los topes lo rechazan todo (`503 CAPS_UNAVAILABLE`) hasta que se arregle o se elimine; se vuelve a leer sin reiniciar |
| `accounts.json`, `sellers.json`, vinculaciones ilegibles | El servicio no arranca (en lugar de funcionar sin membresías) |
| `intents.json` ilegible | Se trata como vacío (una carencia conocida: consulta [Problemas conocidos](../quality/known-issues.md)) |
| Falla la escritura del archivado de una subida en la rotación | La subida sigue `confirmed` pero vinculada a la disputa antigua (así que no está en ninguna entrada); sus archivos siguen contando para los 300 MiB; **no se reintenta** (problema conocido) |

Consulta también [Retención y borrado](retention-and-deletion.md) para saber qué se elimina a propósito y cuándo.
