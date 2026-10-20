[English](../../technical/http-api.md) | [Español](http-api.md)

# API HTTP (apps/server)

> **Interfaz interna, no una API pública estable.** Estas rutas existen para la propia app web de ResolveKit, el
> webhook de PayPal y los scripts del operador. Cambian con el código, sin versionado ni aviso de obsolescencia. No
> construyas sobre ellas.

Fuente: `apps/server/src/app.ts`, `hosted.ts`, `auth.ts`, `webhook.ts`, `uploads/routes.ts`, `agent/routes.ts` en el
commit `fbe9621`; las acciones de disputa (`apps/server/src/actions/routes.ts`), en el commit `076c74f` (20/10/2026). Las rutas de MeterMCP están en [herramientas MCP](mcp-tools.md).

## Convenciones

| Elemento | Regla |
|---|---|
| Base | Local `http://127.0.0.1:8787` (a través del proxy de Vite); alojado: el origen público del servicio, el mismo origen que la app web |
| Cuerpos | `POST` solo acepta `application/json` (415 `UNSUPPORTED_MEDIA_TYPE`), salvo la ruta de subida, que también acepta `image/png`, `image/jpeg`, `application/pdf` en bruto con una cabecera `x-upload-name` |
| Tamaño del cuerpo | 256 KiB por defecto; 5 MiB en subida de imagen; 10 MiB en subida de PDF; como mucho 3 cuerpos grandes en curso, plazo de 30 s |
| Errores | JSON `{ "error": "<CODE>", "detail": "<sentence>", … }`; algunos añaden `reasons`, `blockers`, `retryAfterSec`, `paypalIssue` |
| Límites de tasa | 429 `RATE_LIMITED` con `Retry-After`; topes diarios 429 `DAILY_CAP`; almacén de topes ilegible 503 `CAPS_UNAVAILABLE` |
| Caché | `cache-control: no-store` en las respuestas de la API |
| Ids | El caso `PP-R-TVH-10190665` es el id del caso de demo estándar en el código; ejemplos ficticios: disputa `PP-D-EXAMPLE-0001`, ejecución `run-<32 hex>`, subida `upl-<24 hex>`, invitación `inv_…`, persona `p_…` |

## Autenticación

| Modo | Cómo se autentica una petición |
|---|---|
| Local | El Host debe ser `127.0.0.1:<port>` o `localhost:<port>` (403 `FORBIDDEN_HOST`); un Origin presente debe estar permitido (403 `FORBIDDEN_ORIGIN`); cabecera `x-resolvekit-token` con el token por arranque (401 `MISSING_OR_BAD_TOKEN`). Quien llama es el operador, un Owner; sin topes |
| Alojado | Cookie de sesión firmada (ver [fronteras de confianza](../architecture/trust-boundaries.md)); el Host debe ser público (403); las peticiones `/api` que cambian estado necesitan el Origin propio del servicio; límites por IP; cabeceras de seguridad |
| Operaciones | `Authorization: Bearer <RESOLVEKIT_OPS_TOKEN>`; sin la variable, o con un token incorrecto, 404 |
| Webhook | Clave secreta en la ruta más verificación con PayPal; sin sesión |

**Filtro de vendedor (alojado).** Las rutas de casos responden a un caso vinculado (de evaluación) solo al espacio de
trabajo del vendedor de ese mismo caso: el id de comerciante de su disputa en la última lectura, o el recordado para el
mismo caso y disputa cuando la lectura falla. Cualquier otro, incluido el vendedor de otro caso vinculado, y toda
petición mientras el vendedor es desconocido, recibe 404 `UNKNOWN_CASE` antes de hacer ningún trabajo. Los ids no
vinculados son casos de demo y solo viven en el navegador.

## Servicio y operaciones

| Método | Ruta | Modo | Autenticación | Respuesta | Errores principales |
|---|---|---|---|---|---|
| GET, HEAD | `/healthz` | alojado | ninguna | Comprobación de salud de Render | 405 |
| GET | `/api/health` | ambos | ninguna (cada vinculación solo se lista para el espacio de trabajo de su propio vendedor) | `{paypal: "sandbox"\|"live"\|"unconfigured", error?, bound, bindings{status, reasons, checkedAt}, storage?}` (`storage`, solo cuando un archivo de almacén no se pudo leer al arrancar: los nombres de los almacenes en modo local, `true` en modo alojado) | — |
| GET | `/api/demo` | ambos | ninguna | alojado `{hosted:true, day, resetsAt, caps, reasons}`; local `{hosted:false}` | 405 |
| GET | `/api/ops/status[?probe=models]` | alojado | Bearer de operaciones | Estado de PayPal, webhook activado/desactivado, cada vinculación verificada con una lectura fresca (puede rotar un caso usado), precalentamiento, topes, archivos de almacén ilegibles (`storage`, también en `problems`); con `probe=models`, una llamada mínima por cada modelo configurado | 404, 405, 429 |
| GET | `/api/ops/agent-run/<run-id>` | alojado | Bearer de operaciones | Registro de la ejecución + recibo, para `demo:prepare --agent-run` | 400 `INVALID_RUN_ID`, 404 |
| GET | `/api/paypal/notices` | ambos | alojado: solo el vendedor de las disputas | Últimos avisos de webhook verificados (≤ 50) | 405 |
| POST | `/api/paypal/webhook/<key>` | alojado, con el entorno del webhook | clave + verificación con PayPal | 200 (evento atendido o ignorado) | 404 clave incorrecta, 405, 400 `BAD_TRANSMISSION`/`NOT_AN_EVENT`/`NOT_VERIFIED`, 408, 413, 429, 503 `BUSY`/`VERIFY_UNAVAILABLE` |
| GET | todo lo demás | alojado | — | App web compilada (las rutas desconocidas caen en `index.html`; los archivos desconocidos dan 404) | 404 |

## Cuentas (alojado)

| Método | Ruta | Autenticación | Propósito | Errores principales |
|---|---|---|---|---|
| GET | `/api/auth/me` | — | Sesión, métodos de inicio de sesión, conexión del espacio de trabajo (`evaluation`, `not_connected`, `checking`) | — |
| POST | `/api/auth/paypal/start` `{next?}` | — | `{approvalUrl}` y una cookie de inicio de sesión pendiente (lleva `next`, firmado; un `next` inseguro se ignora) | 503 `PAYPAL_SIGNIN_OFF`, 502 `PAYPAL_UNAVAILABLE` |
| GET | `/api/auth/paypal/return/<k>?ba_token=…` | cookie pendiente + clave | Iniciar sesión como Owner → 303 a `next` (una ruta del mismo sitio); si no, `/?signed-in=paypal` | 303 `/signin?error=session_mismatch\|not_approved\|paypal_unavailable\|full\|unavailable\|paypal_off` |
| GET | `/api/auth/paypal/cancel` | — | 303 `/signin?error=cancelled` | — |
| POST | `/api/auth/invite/inspect`, `/api/auth/invite/join` | token de invitación | Inspeccionar una invitación / unirse en este navegador | 404 `INVITE_UNKNOWN`, 410 `INVITE_*`, 400 `INVALID_NAME`, 409, 503 `ACCOUNTS_UNAVAILABLE` |
| POST | `/api/auth/passkey/register/options`, `…/register/verify`, `/api/auth/passkey/login/options`, `…/login/verify` | invitación (registro) / passkey | WebAuthn | 400 `CHALLENGE_UNKNOWN`/`PASSKEY_REJECTED`, 401 `PASSKEY_UNKNOWN`, 403 `ACCESS_REVOKED`/`ACCESS_ENDED` |
| POST | `/api/auth/signout` `{everywhere?}` | sesión | Borrar la cookie; `everywhere` termina todas las sesiones | 503 |
| GET | `/api/workspace/members` | Owner | Miembros e invitaciones | 401, 403 `OWNER_ONLY` |
| POST | `/api/workspace/invites` | Owner | Crear una invitación → `{invite, url: <origin>/join#<token>}` (se muestra una vez) | 400 `INVALID_LABEL\|USES\|TTL\|ACCESS_END`, 409 `TOO_MANY_INVITES` |
| POST | `/api/workspace/invites/<inv_…>/revoke`, `/api/workspace/members/<p_…>/revoke` | Owner | Revocar | 404 |

## Disputas, intents y evidencia

| Método | Ruta | Autenticación / permiso | Propósito | Errores principales |
|---|---|---|---|---|
| GET | `/api/disputes/:case` | espacio de trabajo del vendedor; cuenta como lectura de PayPal | Lectura fresca de PayPal, mapeada (estado, fase, motivo, tipo de artículo, acciones permitidas, evidencia solicitada, entradas de evidencia, fecha límite); recibo de MeterMCP para el caso del agente | 404 `UNKNOWN_CASE`/`NOT_BOUND`, 503 `PAYPAL_UNCONFIGURED`, 422/502/504 de PayPal |
| POST | `/api/disputes/:case/intent` | con sesión iniciada (alojado) | Componer un intent de envío → 201. Cuerpo: `{evidenceType, edits?, resolutions?, confirmedCorrections?, attachments?}`; cualquier otro campo (notas, archivos, seguimiento) se rechaza | 400 `INVALID_INTENT_REQUEST`, 401, 403 `NOT_THE_SELLER`, 409 `BINDING_UNAVAILABLE`/`BINDING_INVALID`/`NO_ANALYSIS`/`RECEIPT_NOT_FINAL`/`UPLOAD_CHANGED`, 422 `DRAFT_BLOCKED`/`EDIT_NOT_VERIFIED`/`UNKNOWN_UPLOAD`/`ATTACHMENTS_TOO_LARGE`, 429 `TOO_MANY_INTENTS` |
| GET | `/api/disputes/:case/intent/:id` | el propietario del intent | Leer el intent | 404 `UNKNOWN_INTENT` |
| POST | `/api/disputes/:case/intent/:id/approve` `{contentHash}` | el propietario del intent | Aprobar ese contenido exacto | 400 `INVALID_APPROVAL`, 409 `CONTENT_HASH_MISMATCH`/`INTENT_<STATUS>` |
| POST | `/api/disputes/:case/intent/:id/cancel` | el propietario del intent | Cancelar | 409 |
| POST | `/api/disputes/:case/evidence` `{intentId}` | el propietario del intent; una unidad del tope `evidence` | Enviar el intent aprobado → 202 `{sent:true}` | 400 `INVALID_SUBMISSION`, 404 `UNKNOWN_INTENT`, 409 `BINDING_CHANGED`/`DOCUMENTS_CHANGED`/`INTENT_STALE`/`UPLOAD_CHANGED`/`SELLER_EVIDENCE_EXISTS`/`DISPUTE_BUSY`/`NOT_BOUND`, 503 `AUDIT_UNAVAILABLE`, 422/502/504 de PayPal (con `paypalIssue`, p. ej. `EVIDENCE_TYPE_IS_NOT_ALLOWED`) |
| GET | `/api/disputes/:case/audit` | alojado: el rastro del espacio de trabajo; local: todo el caso | Eventos de auditoría: intents compuestos, aprobaciones (quién, cuándo, hash), envíos (`PayPal-Request-Id`, respuesta de PayPal), rechazos, notificaciones | 405 |

El envío nunca informa de «registrado». `202 {sent:true}` significa que PayPal aceptó la petición; después la app web
vuelve a leer la disputa y muestra **Recorded by PayPal** solo para evidencia `SUBMITTED_BY_SELLER` nueva que
coincide con lo enviado. Aceptado ≠ registrado ≠ disputa resuelta.

## Acciones de disputa

Mensaje, aceptar la reclamación, hacer una oferta y escalar usan la misma cadena de intents que la evidencia, con su
propia ruta de envío. Estado: Probado en local; no desplegado (estado por variante:
[Especificación funcional](../product/functional-specification.md#56-acciones-de-disputa-distintas-de-la-evidencia)).
El rol se comprueba al componer, aprobar, confirmar y enviar: `accept_claim`, `make_offer` y `escalate` responden
`403 OWNER_ONLY` a cualquiera que no sea el Owner del espacio de trabajo (un revisor nunca pasa).

| Método | Ruta | Autenticación / permiso | Propósito | Errores principales |
|---|---|---|---|---|
| POST | `/api/disputes/:case/intent` `{action, …}` | con sesión (modo alojado); acciones solo del Owner: el Owner | Componer contra una lectura fresca de PayPal → 201 (el intent, con `repeat: true` cuando PayPal ya registró el mismo contenido). Cuerpos: `{action:"send_message", text, attachments:[]}` (como máximo un `upl-…` confirmado), `{action:"accept_claim", acceptType:"REFUND"\|"PARTIAL_REFUND", note, amount?}`, `{action:"make_offer", offerType:"REFUND", note, amount}`, `{action:"escalate", note}`; `amount` es `{value, currency}` con `value` como cadena decimal | 400 `INVALID_ACTION_REQUEST`, 403 `OWNER_ONLY`/`NOT_THE_SELLER`, 409 `SIMULATED_CASE`/`ACTION_NOT_OFFERED`/`VARIANT_NOT_AVAILABLE`/`ACTION_STAGE`/`DUPLICATE_ACTION`/`UPLOAD_CHANGED`, 422 `TEXT_REQUIRED`/`TEXT_TOO_LONG`/`INVALID_AMOUNT`/`AMOUNT_REQUIRED`/`AMOUNT_NOT_ALLOWED`/`AMOUNT_ABOVE_DISPUTE`/`AMOUNT_ABOVE_REFUNDABLE`/`CURRENCY_MISMATCH`/`UNKNOWN_CURRENCY`/`DISPUTE_AMOUNT_UNKNOWN`, 429 `TOO_MANY_INTENTS` |
| POST | `/api/disputes/:case/intent/:id/approve` `{contentHash}` | el propietario del intent | Aprobar ese contenido exacto → 200 con `confirmation`: los términos de la segunda confirmación, o `null` si no hace falta | 400 `INVALID_APPROVAL`, 403 `OWNER_ONLY`, 409 `CONTENT_HASH_MISMATCH`/`INTENT_<STATUS>` |
| POST | `/api/disputes/:case/intent/:id/confirm` `{terms}` | el Owner (o el autor, para un mensaje repetido) | La segunda confirmación: los términos deben ser exactamente los emitidos (`intentId`, `contentHash`, `action`, `amount`, `currency`, `consequence`) | 400 `INVALID_CONFIRMATION`, 403 `OWNER_ONLY`, 409 `NO_CONFIRMATION`/`CONFIRMATION_MISMATCH` |
| POST | `/api/disputes/:case/intent/:id/acknowledge` `{contentHash, shownMessageKeys}` | el propietario del intent | Tras `NEEDS_REVIEW`: la persona vio los mensajes nuevos del comprador y mantiene el mismo contenido | 400 `INVALID_ACKNOWLEDGEMENT`, 409 `CONTENT_HASH_MISMATCH`/`INTENT_<STATUS>`/`BINDING_CHANGED`/`NEEDS_REVIEW` |
| POST | `/api/disputes/:case/send` `{intentId}` | el propietario del intent; una unidad del tope `message` o `settle` | Recomprobar sobre una lectura fresca, escribir en disco la base de relectura y `send_started`, y después un único POST → 202 `{sent:true}` o `{sent:"unknown"}`; para un intent incierto, releer primero → 200 `{reconciled:true}` cuando PayPal lo muestra | 400 `INVALID_SUBMISSION`, 403 `OWNER_ONLY`, 404 `UNKNOWN_INTENT`, 409 `WRONG_SEND_ROUTE`/`BINDING_CHANGED`/`DISPUTE_BUSY`/`DISPUTE_UNCERTAIN`/`INTENT_STALE`/`DUPLICATE_ACTION`/`NEEDS_REVIEW`/`CONFIRMATION_REQUIRED`/`VARIANT_NOT_AVAILABLE`/`SIMULATED_CASE`/`NOT_BOUND`, 422 `PAYPAL_REFUSED` (con `paypalIssue`), 429 `DAILY_CAP`, 503 `AUDIT_UNAVAILABLE`/`PAYPAL_UNCONFIGURED` |
| GET | `/api/disputes/:case/intent/:id/readback` | el propietario del intent | Leer ahora la disputa fijada → `{readBack:{state:"recorded"\|"absent"\|"pending", detail, at}, snapshot, intent}`. Nunca envía («Check again») | 409 `SIMULATED_CASE`/`INTENT_SENDING`/`INTENT_NOT_SENT`, 503 `AUDIT_UNAVAILABLE`/`PAYPAL_UNCONFIGURED`, 502/504 de PayPal |

`202 {sent:true}` significa que PayPal aceptó la petición; la disputa sigue retenida hasta que una relectura pruebe la
acción («Recorded by PayPal») o pruebe su ausencia. `{sent:"unknown"}` (un tiempo de espera agotado, un 5xx, 408, 429 o
una respuesta poco clara) es «Outcome pending confirmation»: no se reintenta nada, y toda escritura en esa disputa
responde `409 DISPUTE_UNCERTAIN` hasta que una relectura lo resuelva. Un intent de evidencia enviado aquí, o un intent
de acción enviado a `/evidence`, responde `409 WRONG_SEND_ROUTE` antes de cambiar nada. Topes diarios (modo alojado):
`DAILY_MESSAGE_SENDS` para mensajes, `DAILY_SETTLE_SENDS` para aceptar, ofertar, escalar y apelar (ambos 20 por
defecto).

## Análisis

| Método | Ruta | Autenticación / permiso | Propósito | Errores principales |
|---|---|---|---|---|
| POST | `/api/cases/:id/analysis[?refresh=1]` | espacio de trabajo del vendedor (alojado); una ejecución en directo consume una unidad `live-analysis` | `{}` → análisis guardado `200`, o ejecución en directo `202` con `input` y `key`; `refresh=1` fuerza una ejecución en directo | 404 `UNKNOWN_CASE`, 503 `ANALYST_UNAVAILABLE`/`ANALYST_UNCONFIGURED`, 429 `RATE_LIMITED`/`DAILY_CAP`, 409 `UPLOAD_CHANGED` |
| GET | `/api/cases/:id/analysis/progress?key=<64 hex>` | como arriba | Etapas hechas hasta ahora y después el resultado | 400 `INVALID_KEY` |
| POST | `/api/cases/:id/analysis/verify` `{text}` | como arriba; una unidad `recheck` | Recomprobar una frase editada (1–600 caracteres, sin saltos de línea ni caracteres de control) → veredicto y citas | 400 `INVALID_TEXT`, 429, 502 `ANALYST_FAILED` |

## Subidas

Las rutas siguientes están bajo `/api/cases/:id/uploads`. «Editores» = quien subió el archivo, los Owners y los
miembros completos (un revisor solo edita sus propias subidas). Detalles: [procesamiento de evidencia](evidence-processing.md).

| Método | Ruta | Permiso | Propósito | Errores principales |
|---|---|---|---|---|
| POST | `` (la colección) | persona con sesión iniciada del espacio de trabajo del vendedor; una unidad `upload` | Añadir: PNG/JPEG/PDF en bruto con `x-upload-name`, o JSON `{text, name}` | 401 `SIGN_IN_REQUIRED`, 404, 409 `TOO_MANY_UPLOADS`, 413 `TOO_LARGE`/`TOO_LONG`, 415, 422 `TEXT_UNSUPPORTED`/`UNREADABLE`, 503 `PDF_READER_UNAVAILABLE`, 507 `STORAGE_FULL` |
| GET | `` (la colección) | espacio de trabajo | Listar; las subidas aún no confirmadas aparecen como `restricted: true` para quienes no son editores | — |
| GET | `/:u/image?v=original\|sanitised` | editores hasta la confirmación | Bytes de la imagen | 404 |
| POST | `/:u/select` `{pages}` | editores | Elegir 1–5 páginas de un PDF más largo (una vez) | 400 `BAD_SELECTION`, 409 `WRONG_STATUS`/`JOB_FAILED`/`UPLOAD_CHANGED` |
| GET | `/:u/page/:k?v=`, `/:u/page/:k/hint`, `/:u/thumb/:n` | editores | Imagen de la página, pista de la capa de texto (solo revisión, cuenta como lectura de PayPal), miniatura | 400 `BAD_PAGE`, 404, 422/503 (pista) |
| POST | `/:u/redact` | editores | Añadir tapas y volver a leer | 400 `BAD_REDACTION`, 403, 409 `TOO_MANY_REDACTS`/`UPLOAD_ARCHIVED`/`WRONG_STATUS`, 413 |
| POST | `/:u/confirm` | editores | Confirmar el archivo saneado revisado (ligado a su `sha256`) → pasa a ser `E<n>` | 400 `BAD_CONFIRMATION`/`BAD_LINES`, 409 `UPLOAD_CHANGED`/`WRONG_STATUS`, 422 `BAD_TRANSCRIPTION`, 413 |
| POST | `/:u/discard` | editores | Descartar una subida pendiente | 409 |
| DELETE | `/:u` | Owners y miembros completos | Borrar; purga los análisis que la citaban; anula los intents no enviados | 403, 409 `SEND_IN_PROGRESS`, 500 `PURGE_FAILED` |

## Ejecuciones del agente

| Método | Ruta | Permiso | Propósito | Errores principales |
|---|---|---|---|---|
| POST | `/api/agent/runs` `{goal, cap, failFirst?}` | con sesión iniciada (local: el operador); alojado: espacio de trabajo del vendedor, unidades `agent-run` diarias y por persona | Arrancar una ejecución en segundo plano → 201 `{run}`. `goal` 1–300 caracteres; `cap` `"0.50"`–`"5.00"`; `failFirst` ≤ 3 nombres de herramienta | 400 `INVALID_GOAL`/`INVALID_CAP`/`INVALID_FAIL_FIRST`/`INVALID_SCOPE` (una ejecución se arranca para uno mismo), 401, 403 `SELLER_WORKSPACE_ONLY`, 409 `RUN_IN_PROGRESS`, 429 `DAILY_CAP`/`PERSON_CAP`, 503 `BUSY`/`MODEL_UNAVAILABLE`/`STORAGE`/`STOPPING`/`AGENT_UNAVAILABLE`/`CAPS_UNAVAILABLE` |
| GET | `/api/agent/runs[?scope=workspace]` | autor; Owner con scope | Listar las ejecuciones propias, la más reciente primero; las del espacio de trabajo para el Owner | 400 `INVALID_SCOPE`, 403 `OWNER_ONLY` |
| GET | `/api/agent/runs/:id[?scope=workspace]` | autor; Owner con scope (queda registrado) | Una ejecución. El enlace de aprobación y los ids de pedido y sesión solo se muestran al autor | 404 para cualquier ejecución que quien llama no pueda ver |
| POST | `/api/agent/runs/:id/stop` | autor; Owner con scope | Abortar → 202; la ejecución termina en `interrupted` y liquida | 409 `NOT_RUNNING` |
| POST | `/api/agent/runs/:id/keep` `{kept}` | Owner | Excluir del barrido de 30 días | 400 `INVALID_KEPT`, 403, 503 |

Detalles: [agente comprador](buying-agent.md).
