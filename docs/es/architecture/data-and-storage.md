[English](../../architecture/data-and-storage.md) | [Español](data-and-storage.md)

# Datos y almacenamiento

Cada servicio guarda su estado en archivos dentro de un único directorio de datos: en Render, un disco persistente de
1 GB montado en `/var/data`; en local, `apps/server/data/` y `apps/metermcp/data/` (ambos ignorados por git). No hay
servidor de base de datos. Código en el commit `fbe9621`.

## Directorio de datos del servidor de ResolveKit

`RESOLVEKIT_DATA_DIR` (alojado `/var/data`; por defecto en local `apps/server/data/`).

| Ruta | Formato | Contenido | Lo escribe |
|---|---|---|---|
| `analysis-cache/<sha256 key>.json` | JSON, tmp + rename | Análisis en directo (citas de los documentos, veredictos, borrador) | `FileAnalysisStore` (`packages/analyst/src/cache.ts`) |
| `analyst-usage.jsonl` | JSONL de anexado | Recuentos de tokens y tiempos por llamada al modelo; sin texto de prompts ni de documentos | `main.ts` |
| `analysis-inputs.json` | Mapa JSON caso → entrada | La entrada con la que se analizó un caso antes de que entrara la evidencia del vendedor (`InputPins`) | `analysis.ts` |
| `intents.json` | JSON `{intents, sentDisputes}`, tmp + rename | Intents de envío, incluido el texto de las notas aprobadas | `intents.ts` |
| `audit-events.jsonl` | JSONL de anexado, compactado por encima de 4 MiB | Eventos de auditoría: códigos, hashes, ids, quién y cuándo; sin texto de documentos | `intents.ts` |
| `audit-events-sends.jsonl` | JSONL de anexado, nunca compactado | Eventos de envío (iniciado, enviado, fallido) | `intents.ts` |
| `uploads/<workspaceId>/<uploadId>/` | `record.json`, `original.bin`, `sanitised.png`, `sanitised.jpg` (una foto tapada) o `sanitised.pdf`, `page-<k>.png`, `page-<k>.orig.png`, `thumb-<n>.png` | Subidas del comerciante; el registro se escribe el último | `uploads/store.ts` |
| `agent-runs/<run-id>.json` | JSON por ejecución, tmp + rename | Registro de la ejecución del agente: objetivo, pasos con los motivos declarados, uso, liquidación, hash del recibo | `agent/runs.ts` |
| `accounts.json` (alojado) | JSON | Espacios de trabajo, personas (payer ids de PayPal, nombres visibles, correos enmascarados), claves públicas de passkeys, **hashes** de los tokens de invitación | `accounts.ts` |
| `sellers.json` (alojado) | JSON | Merchant ids de vendedor confirmados por última vez para las disputas vinculadas | `sellers.ts` |
| `daily-caps.json` (alojado) | JSON `{day, counts}` | Contadores diarios globales | `packages/hosting` |
| `agent-run-caps.json` (alojado) | JSON `{day, counts{person:n}}` | Ejecuciones del agente por persona y día UTC | `agent/person-caps.ts` |
| `bindings.json` (alojado, solo sin `BINDINGS_JSON`) | JSON | Vinculaciones caso → disputa y reservas; vigilado cada 30 s | operador |

Solo en local: `apps/server/.runtime-token` (token de API por arranque, se elimina al parar) y
`apps/server/bindings.json`. El `demo:prepare` del operador escribe `demo-prepare-runs/<run>.json` en la máquina
donde se ejecuta.

Un `accounts.json` o `sellers.json` ilegible detiene el arranque alojado (si no, se perderían membresías). Un
`daily-caps.json` ilegible o un guardado fallido hacen que las acciones con tope se rechacen (`CAPS_UNAVAILABLE`, 503).

## Directorio de datos de MeterMCP

`METERMCP_DATA_DIR` (alojado `/var/data`; local `apps/metermcp/data/`).

| Ruta | Formato | Contenido |
|---|---|---|
| `metermcp.sqlite` (o `METERMCP_DB`) | SQLite mediante el `node:sqlite` integrado en Node | Tablas `sessions` (un presupuesto de PayPal cada una: pedido, autorización, tope, estado, captura) y `calls` (herramienta, precio, estado, hashes de petición y respuesta) |
| `daily-caps.json` (alojado) | JSON | Contador diario de presupuestos (`DAILY_BUDGETS`) |
| `.runtime-token` (local, en `apps/metermcp/`) | texto | Token de administración por arranque, se elimina al parar |

La migración del esquema se ejecuta en una sola transacción; una migración fallida deja el archivo intacto y MeterMCP
no arranca.

## Estado solo en memoria (se pierde al reiniciar)

| Estado | Límite |
|---|---|
| Pistas de la capa de texto del PDF mostradas durante la revisión | una vez por página y revisión |
| Veredictos de frases recomprobadas (editadas) | 2 000, sale primero la más antigua (un intent conserva los veredictos con los que se compuso) |
| Ids de eventos de webhook ya vistos | 2 000 |
| Avisos de PayPal mostrados al vendedor | 50 |
| Desafíos de WebAuthn, inicios de sesión con PayPal pendientes | 5 min / 15 min |
| Tokens de inicio de sesión usados | 5 000 |
| Ventanas del limitador de tasa | 20 000 claves |
| Sesiones y transportes MCP activos | 200 (público), 10 (`/agent/mcp`) |
| Tokens OAuth de PayPal | se renuevan 60 s antes de caducar |

## Retención

| Dato | Se conserva | Dónde en el código |
|---|---|---|
| Subida pendiente o en revisión | 24 h; después se descarta (se conserva el registro, se eliminan archivos y texto); barrido cada hora | `uploads/limits.ts`, `uploads/store.ts` |
| Original de la subida | Hasta confirmar, descartar, borrar, caducar o archivar | `uploads/store.ts`, `uploads/routes.ts` |
| Subida descartada, borrada o archivada | Solo el registro (metadatos) | `uploads/store.ts` |
| Intent | 30 min para aprobar y enviar; reintento tras fallo 30 min; enviado 24 h | `intents.ts` |
| Eventos de auditoría | 200 por propietario (2 000 propietarios); el registro de envíos nunca se desaloja | `intents.ts` |
| Ejecuciones del agente | 30 días, salvo que se conserven, no estén liquidadas, no estén guardadas o su captura esté vinculada | `agent/runs.ts` |
| Caché de análisis, registro de uso, fijación de entradas | Sin caducidad en el código (borrar una subida purga los análisis que la citaban) | `cache.ts`, `main.ts` |
| Ledger (libro contable) de MeterMCP | Sin caducidad en el código | `ledger.ts` |
| Cookie de sesión | 12 h | `accounts.ts` |

Procedimientos operativos: [retención y borrado](../operations/retention-and-deletion.md).

## Copias de seguridad

No hay código de copias de seguridad. El disco de Render es la única copia del estado de cada servicio. La copia de
seguridad y la restauración están **Pendientes** (manuales): ver [copia de seguridad y recuperación](../operations/backup-and-recovery.md).

## Consistencia, concurrencia e idempotencia

| Aspecto | Mecanismo | Estado |
|---|---|---|
| Escrituras atómicas de archivos | Escribir en `<file>.tmp` y después renombrar; los registros JSONL anexan. Sin llamada a `fsync` | Implementado · Probado en local |
| Dos confirmaciones de un mismo intent | `approved → sending` se comprueba y se establece en un único paso síncrono | Implementado · Probado en local |
| Dos intents para una misma disputa | Bloqueo por disputa tomado en el mismo paso (`DISPUTE_BUSY`); en cuanto un envío se acepta y se persiste, se rechaza cualquier otro intent para esa disputa (`SELLER_EVIDENCE_EXISTS`) | Implementado · Probado en local |
| Durabilidad del envío | El estado `sending` y `send_started` deben escribirse antes de que nada vaya a PayPal; si no, 503 `AUDIT_UNAVAILABLE`; un resultado que no se puede escribir después de que PayPal aceptara se registra como `AUDIT NOT DURABLE` | Implementado · Probado en local |
| Envíos repetidos a PayPal | Un `PayPal-Request-Id` por intent, reutilizado en cada reintento. Si la API de Disputes deduplica con él **no está verificado** | Implementado · Probado en local; comportamiento de PayPal Pendiente |
| Envío incierto (timeout) | Ni éxito ni fallo: la app web vuelve a leer la disputa; solo se ofrece un reintento seguro si PayPal no muestra evidencia del vendedor | Implementado · Probado en local (simulador); no observado contra PayPal: Pendiente |
| Reservas del presupuesto de MeterMCP | SQLite `BEGIN IMMEDIATE`; una llamada solo se reserva si OK + PENDING + precio ≤ tope; las llamadas fallidas se liberan y nunca se cobran | Implementado · Probado en local |
| Liquidación de MeterMCP | Una captura final del total OK (`invoice_id <session>-settle`) o una anulación; `settlement_failed` se reintenta con el mismo `PayPal-Request-Id`; la captura `PENDING` se concilia cada 30 s | Implementado · Probado en local; captura parcial Verificada en sandbox; `capture_pending` no observado: Pendiente |
| Topes diarios | Se reservan de forma atómica antes del trabajo y se devuelven si no se llegó a hacer; fallan cerrados | Implementado · Probado en local |
| Pasos del agente | Paso escrito por adelantado (write-ahead) antes de cada llamada a MeterMCP; al reiniciar, un paso de pago pendiente pasa a `uncertain` y nunca se repite | Implementado · Probado en local; recuperación tras reinicio en sandbox: Pendiente |

## Recuperación tras un reinicio

| Qué estaba en curso | Qué ocurre |
|---|---|
| Un intent en `sending` | Se marca como `failed` («the server restarted during the send»); la app web vuelve a leer PayPal antes de cualquier reintento |
| Una ejecución del agente | Se marca como `interrupted`; su sesión de MeterMCP se cierra mediante la ruta de administración y se vuelve a leer el recibo (`agent.recover()`, sin esperar en el arranque) |
| Liquidación del agente no definitiva | Se concilia cada 5 min |
| `capture_pending` de MeterMCP | Se relee cada 30 s, bajo demanda y al cerrar |
| Subidas pendientes, escrituras interrumpidas | Las elimina el barrido al arrancar y cada hora |
| Vinculaciones | Se releen de `BINDINGS_JSON` o del archivo; cada una se verifica con una lectura fresca de PayPal en segundo plano |
| Análisis en el modo alojado | Precalentamiento: cada caso vinculado se analiza una vez tras el arranque o un cambio de vinculaciones (ejecuciones del sistema, mismos límites y topes) |

Apagado (`SIGINT`/`SIGTERM`): los bucles del agente tienen 20 s para terminar y liquidar; después se vuelcan los
intents, se cierra el worker de OCR y se eliminan los archivos de token.

## Límites de escala

Una instancia por servicio, estado en un disco local: sin escalado horizontal, sin despliegue sin tiempo de
inactividad. Los límites anteriores (intents, cuentas, sesiones, almacenamiento de 300 MiB para subidas) están
dimensionados para una demo. Ver [problemas conocidos](../quality/known-issues.md).
