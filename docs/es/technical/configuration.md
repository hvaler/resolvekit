[English](../../technical/configuration.md) | [Español](configuration.md)

# Configuración

Todas las variables de entorno que lee el código, sacadas de `apps/server/src/main.ts`, `apps/metermcp/src/main.ts`,
`packages/*` y los scripts en el commit `81c6242`. Hay una plantilla con valores de ejemplo seguros en
[`.env.example`](../../../.env.example). El servidor y MeterMCP cargan el `.env` de la raíz del repositorio con
`node --env-file-if-exists`; en Render, los valores vienen de los ajustes del servicio y de `render.yaml`.

Leyenda: **R** obligatoria, **O** opcional; **Secret** = no confirmar nunca en el repositorio, no registrar nunca en
logs. «Alojado» significa `RESOLVEKIT_MODE=hosted` (servidor) o `METERMCP_MODE=hosted` (MeterMCP).

## Servidor de ResolveKit (`apps/server`)

### Modo, red y almacenamiento

| Variable | R/O | Secret | Por defecto | Efecto |
|---|---|---|---|---|
| `RESOLVEKIT_MODE` | O | — | local | `hosted`: modo público (0.0.0.0, inicio de sesión, topes, sitio estático) |
| `PORT` | O | — | 10000 alojado, 8787 local | Puerto de escucha (lo establece Render) |
| `RENDER_EXTERNAL_URL` | R alojado | — | — | Origen público; el arranque falla si falta o no es `https` (salvo `localhost`) |
| `RESOLVEKIT_CUSTOM_DOMAINS` | O | — | — | Orígenes públicos adicionales (lista separada por comas, https) |
| `RESOLVEKIT_PUBLIC_URL` | O | — | `RENDER_EXTERNAL_URL` | Adónde devuelve PayPal al comprador de una ejecución: `<url>/agent?run=<id>`; si no hay ninguna de las dos → la propia página de aprobación de MeterMCP |
| `RESOLVEKIT_DATA_DIR` | O | — | `apps/server/data/` | Directorio de datos (Render: `/var/data`) |
| `RESOLVEKIT_WEB_DIST` | O | — | `apps/web/dist/` | App web compilada; el arranque alojado falla sin su `index.html` |
| `RESOLVEKIT_TOKEN_FILE` | O, local | — | `apps/server/.runtime-token` | Dónde se escribe el token de API por arranque (también lo lee el proxy de Vite) |
| `RESOLVEKIT_ALLOWED_ORIGINS` | O, local | — | `http://localhost:5173`, `http://127.0.0.1:5173`, variantes con `:4173` | Lista de Origins permitidos en local (separada por comas) |
| `TRUSTED_PROXY_HOPS` | O | — | 1 (blueprint de Render: 2) | Entradas de `X-Forwarded-For` que se recorren hacia atrás |
| `TRUSTED_PROXY_PEERS` | O | — | `private` | `private`, `any` o `none`: qué pares pueden establecer `X-Forwarded-For` |
| `ANALYSIS_CACHE_MAX_DAYS`, `ANALYSIS_CACHE_MAX_MB` | O | — | 30 / 100 | Retención de la caché de análisis: un análisis que no se escribe ni se lee durante estos días se elimina, y por encima de este tamaño se eliminan primero los usados hace más tiempo (barrido al arrancar y cada hora; nunca los golden ni el usado más recientemente). Mínimos: 1 día, 1 MiB; un valor que no es un número entero positivo da el valor por defecto |
| `ANALYST_USAGE_MAX_DAYS`, `ANALYST_USAGE_MAX_MB` | O | — | 90 / 10 | Retención de `analyst-usage.jsonl`: se descartan las líneas de más de esos días y después las más antiguas hasta que cabe en ese tamaño (mínimos: 1 día, 1 MiB). Los logs de auditoría y de envíos no tienen este ajuste: no caducan nunca |

### PayPal

| Variable | R/O | Secret | Por defecto | Efecto |
|---|---|---|---|---|
| `PAYPAL_ENV` | R alojado | — | sandbox (local) | Alojado: debe ser `sandbox`, o `live` con la activación de abajo; si no, el servicio se niega a arrancar. Local: `live` solo si se establece así |
| `RESOLVEKIT_ALLOW_LIVE_PAYPAL` | O | — | — | Debe ser `yes-real-money` para `live` en el modo alojado. Nunca se establece en `render.yaml`. Nada se ha ejecutado contra PayPal live |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | O | **Secret** | — | La app de sandbox del vendedor: lecturas de disputas, evidencia, verificación de webhooks. Si faltan → PayPal «unconfigured», todos los casos sobre el simulador |
| `PAYPAL_IDENTITY_CLIENT_ID`, `PAYPAL_IDENTITY_CLIENT_SECRET` | O alojado | **Secret** | — | La app de identidad de la plataforma (otra cuenta business de sandbox) para **Continue with PayPal**. Debe ser distinta de `PAYPAL_CLIENT_ID` (si no, el arranque falla). Si faltan → inicio de sesión con PayPal desactivado; las invitaciones siguen funcionando |
| `PAYPAL_WEBHOOK_ID` | O alojado | — | — | Id del webhook `CUSTOMER.DISPUTE.*` registrado en la app del vendedor; debe cumplir `^[A-Z0-9]{10,40}$` |
| `PAYPAL_WEBHOOK_KEY` | R con el id | **Secret** | — | 32–128 caracteres seguros para URL: el último segmento secreto de `/api/paypal/webhook/<key>`. Sin id y clave, la ruta no existe |

### Vinculaciones

| Variable | R/O | Secret | Por defecto | Efecto |
|---|---|---|---|---|
| `BINDINGS_JSON` | O alojado | sensible | — | Caso → `{dispute, capture[, session, run]}` (o una lista: reserva, el primero activo). En el modo alojado prevalece sobre el archivo; un JSON incorrecto, o una disputa listada dos veces (en cualquier caso), detiene el arranque |
| `RESOLVEKIT_BINDINGS` | O | — | alojado `<data>/bindings.json`, local `apps/server/bindings.json` | Archivo de vinculaciones; en el modo alojado sin `BINDINGS_JSON` se relee cada 30 s |

### Cuentas y operaciones

| Variable | R/O | Secret | Por defecto | Efecto |
|---|---|---|---|---|
| `RESOLVEKIT_SESSION_SECRET` | O alojado | **Secret** | aleatorio por arranque (aviso si < 32 caracteres) | Clave HMAC de las cookies de sesión y de inicio de sesión; sin ella, las sesiones terminan al reiniciar (Render la genera) |
| `RESOLVEKIT_OPS_TOKEN` | O alojado | **Secret** | — | 32–128 caracteres seguros para URL; activa `/api/ops/*` (Bearer). También lo leen `demo:check` y `demo:prepare --agent-run` |

### Enlace con MeterMCP

| Variable | R/O | Secret | Por defecto | Efecto |
|---|---|---|---|---|
| `METERMCP_URL` | O | — | `http://127.0.0.1:8790` | Base de MeterMCP; a un `host:port` sin más se le añade `http://` (Render pasa el `hostport` privado) |
| `METERMCP_ADMIN_TOKEN` | R alojado para el agente y los recibos | **Secret** | — | Token de administración de MeterMCP; si falta → aviso, las ejecuciones del agente se detienen con `meter_unavailable` y los recibos fallan |
| `METERMCP_TOKEN_FILE` | O, local | — | `apps/metermcp/.runtime-token` | Archivo local del token de administración que escribe MeterMCP |

### Modelos (analista y agente)

| Variable | R/O | Secret | Por defecto | Efecto |
|---|---|---|---|---|
| `GEMINI_API_KEY` | O | **Secret** | — | Gemini para el analista y el agente |
| `GROQ_API_KEY` | O | **Secret** | — | Groq para el analista y el agente. Sin ninguna clave: solo análisis guardados, agente `MODEL_UNAVAILABLE` |
| `ANALYST_PROVIDER` | O | — | `gemini` | `gemini` o `groq`: el **principal** tanto del analista como del agente; el otro proveedor, si su clave está definida, es el respaldo |
| `GEMINI_MODEL`, `GROQ_MODEL` | O | — | `gemini-3.8-flash`, `openai/gpt-oss-120b` | Ids de modelo del analista (un id distinto cambia la clave de caché) |
| `AGENT_GEMINI_MODEL`, `AGENT_GROQ_MODEL` | O | — | las mismas constantes | Ids de modelo del agente |
| `GROQ_TPM` | O | — | 8000 | Tokens por minuto de Groq; una petición (prompt + salida máxima) debe caber |
| `LIVE_ANALYSES_PER_HOUR` | O | — | 6 | Límite por hora de análisis en directo para todo el servidor |
| `RECHECKS_PER_HOUR` | O | — | 30 | Límite por hora de recomprobaciones de frases para todo el servidor |

### Topes diarios (alojado, por día UTC, persistidos)

| Variable | Por defecto | Cuenta |
|---|---|---|
| `DAILY_LIVE_ANALYSES` | 60 | Análisis en directo, incluidos los de precalentamiento |
| `DAILY_RECHECKS` | 200 | Recomprobaciones de frases |
| `DAILY_EVIDENCE_SENDS` | 20 | Envíos de evidencia a PayPal |
| `DAILY_UPLOADS` | 40 | Subidas (no está en `render.yaml`: se aplica el valor por defecto) |
| `DAILY_AGENT_RUNS` | 20 | Ejecuciones del agente iniciadas (más 5 por persona y día, no configurable) |
| `DAILY_MESSAGE_SENDS` | 20 | Mensajes enviados al comprador a través de PayPal (no está en `render.yaml`: se aplica el valor por defecto) |
| `DAILY_SETTLE_SENDS` | 20 | Acciones de liquidación enviadas: aceptar la reclamación, hacer una oferta, escalar (y apelar, que no está disponible) (no está en `render.yaml`: se aplica el valor por defecto) |

**El caso de liquidación del propietario.** `BINDINGS_JSON` puede vincular `PP-R-STL-10190667`, el caso solo del Owner
para aceptar, ofertar y escalar, a una lista de disputas de sandbox propias (su reserva), separada de la del caso
estándar; cada disputa aparece una sola vez en todo el archivo. Forma de ejemplo (ids ficticios):
`"PP-R-STL-10190667": [{"dispute": "PP-R-YYY-00000001", "capture": "YYYYYYYYYYYYYYYY1"}, …]`
(`apps/server/bindings.example.json`). En modo alojado, solo el Owner del espacio del vendedor ve ese caso.

### Límites de las ejecuciones del agente (ambos modos)

Un valor ausente o mal formado (que no sea un entero positivo) mantiene el valor por defecto.

| Variable | Por defecto | Límite |
|---|---|---|
| `AGENT_MAX_ACTIONS` | 8 | Acciones por ejecución |
| `AGENT_MAX_MS` | 180000 | Tiempo del agente, sin contar la espera de aprobación de PayPal |
| `AGENT_APPROVAL_TIMEOUT_MS` | 900000 | Espera de la aprobación del comprador |
| `AGENT_MAX_MODEL_CALLS` | 12 | Llamadas al modelo por ejecución |
| `AGENT_MAX_INPUT_TOKENS` | 8000 | Tokens de entrada estimados por llamada |
| `AGENT_MAX_OUTPUT_TOKENS` | 1024 | Tokens de salida solicitados por llamada |
| `AGENT_RUN_TOKEN_BUDGET` | 60000 | Tokens de entrada + salida por ejecución, contando todos los intentos |

## MeterMCP (`apps/metermcp`)

| Variable | R/O | Secret | Por defecto | Efecto |
|---|---|---|---|---|
| `METERMCP_MODE` | O | — | local | `hosted`: 0.0.0.0, código de demo, presupuestos diarios |
| `PORT` (alojado) / `METERMCP_PORT` (local) | O | — | 10000 / 8790 | Puerto de escucha |
| `METERMCP_PUBLIC_URL` | O | — | alojado `RENDER_EXTERNAL_URL`; local `http://127.0.0.1:<port>` | URL de retorno/cancelación del pedido de presupuesto; en el modo alojado debe ser `https` (salvo `localhost`). Prevalece sobre `RENDER_EXTERNAL_URL` |
| `RENDER_EXTERNAL_URL` | alojado | — | — | URL pública de respaldo |
| `METERMCP_CUSTOM_DOMAINS` | O | — | — | Hosts públicos adicionales |
| `PAYPAL_ENV`, `RESOLVEKIT_ALLOW_LIVE_PAYPAL` | como en el servidor | — | | La misma guarda |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | O | **Secret** | — | La app del vendedor a la que cobra MeterMCP; si faltan → `paypal_unconfigured` |
| `METERMCP_ADMIN_TOKEN` | R alojado (≥ 32 caracteres) | **Secret** | local: aleatorio por arranque, escrito en el archivo de token | Rutas de administración y `/agent/mcp` |
| `METERMCP_TOKEN_FILE` | O, local | — | `apps/metermcp/.runtime-token` | |
| `DEMO_CODE` | O alojado | **Secret** | — | Valor que los clientes MCP envían en `x-demo-code` para crear un presupuesto; si falta → no se puede crear ningún presupuesto. No se exige longitud mínima (≤ 200 caracteres) |
| `METERMCP_BUDGET`, `METERMCP_MIN_BUDGET` | O | — | 5.00 / 0.50 | Tope de presupuesto máximo y mínimo; un mínimo por encima del máximo (o un importe que no es dinero) impide el arranque |
| `METERMCP_RETURN_ORIGINS` | O | — | ninguno | Orígenes a los que puede apuntar el `return_to` de un `open_budget` (lista separada por comas); un valor no válido detiene el arranque. En Render: el origen público de ResolveKit, establecido a mano |
| `METERMCP_IDLE_MINUTES` | O | — | 15 | Cierre por inactividad de la sesión de pago |
| `METERMCP_FAIL_FIRST` | O (interruptor de pruebas) | — | ninguno | Lista separada por comas de herramientas cuya primera llamada por sesión `payment_required` falla (nunca se cobra, se marca como inyectada). No debe estar presente en el servicio alojado |
| `METERMCP_DATA_DIR`, `METERMCP_DB` | O | — | `apps/metermcp/data/`, `<data>/metermcp.sqlite` | Ubicación del ledger (libro contable) |
| `METERMCP_ALLOWED_ORIGINS` | O | — | ninguno | Origins de navegador permitidos (lista separada por comas) |
| `DAILY_BUDGETS` | O alojado | — | 20 | Presupuestos creados por día UTC |
| `TRUSTED_PROXY_HOPS`, `TRUSTED_PROXY_PEERS` | O | — | 1 / `private` | Como en el servidor |

## Build de la web (`apps/web`)

| Variable | La lee | Efecto |
|---|---|---|
| `RESOLVEKIT_API` | `vite.config.ts` | Destino del proxy para `/api` (por defecto `http://127.0.0.1:8787`) |
| `RESOLVEKIT_TOKEN_FILE` | `vite.config.ts` | Token que inyecta el proxy (por defecto `apps/server/.runtime-token`) |
| `import.meta.env.DEV` | Vite | Controles de desarrollo |

No se lee ninguna variable `VITE_*`: nada del entorno se incluye en el bundle.

## Scripts

| Script | Variables |
|---|---|
| `demo:check` | `RESOLVEKIT_OPS_TOKEN` (R; sale con código 2 sin ella) |
| `demo:prepare` | `PAYPAL_CLIENT_ID/SECRET` (R), `PAYPAL_ENV` (debe ser sandbox), `RESOLVEKIT_DATA_DIR`, `METERMCP_DEMO_CODE` (R con `--agent` contra el MeterMCP alojado), `BINDINGS_JSON` (R con `--agent-run`), `RESOLVEKIT_OPS_TOKEN` (R con `--agent-run` en el modo alojado), `METERMCP_TOKEN_FILE` (local), claves de los modelos, `ANALYST_PROVIDER` y `AGENT_*` (con `--agent`) |
| `demo-agent` | `METERMCP_URL` (aquí, el **endpoint MCP público**, por defecto `http://127.0.0.1:8790/mcp`; se añaden `http://` y `/mcp` si faltan), `METERMCP_DEMO_CODE`, claves de los modelos, `ANALYST_PROVIDER`, `AGENT_*` |
| `evals`, `evals:heldout` | `GEMINI_API_KEY`, `GROQ_API_KEY`, `GROQ_TPM` |
| `golden` | Variables del analista (`modelFromEnv`) |

Dos nombres a vigilar: `METERMCP_URL` es la base de MeterMCP para el servidor (su `/agent/mcp` privado y sus rutas de
administración), pero el endpoint MCP público para `demo-agent`, que añade `http://` y `/mcp` si faltan. Ambos leen el
mismo `.env` raíz, así que un valor puesto ahí para el servidor también hace que `demo-agent` apunte a ese MeterMCP:
sobrescríbelo en la línea de comandos cuando difieran.
`DEMO_CODE` (MeterMCP) y `METERMCP_DEMO_CODE` (scripts) llevan el mismo valor con dos nombres.

## Valores de `render.yaml`

Establecidos en el blueprint: `NODE_VERSION=24.19.0`; servidor `RESOLVEKIT_MODE=hosted`, `RESOLVEKIT_DATA_DIR=/var/data`,
`PAYPAL_ENV=sandbox`, `DAILY_LIVE_ANALYSES=60`, `DAILY_RECHECKS=200`, `DAILY_EVIDENCE_SENDS=20`,
`DAILY_AGENT_RUNS=20`, los siete valores por defecto `AGENT_*`, `TRUSTED_PROXY_HOPS=2`, `RESOLVEKIT_SESSION_SECRET`
generado, `METERMCP_URL` y `METERMCP_ADMIN_TOKEN` desde el servicio MeterMCP; MeterMCP `METERMCP_MODE=hosted`,
`METERMCP_DATA_DIR=/var/data`, `PAYPAL_ENV=sandbox`, `METERMCP_BUDGET=5.00`, `METERMCP_MIN_BUDGET=0.50`,
`DAILY_BUDGETS=20`, `TRUSTED_PROXY_HOPS=2`, `METERMCP_ADMIN_TOKEN` generado. Introducidos a mano (`sync: false`):
credenciales de PayPal (ambos servicios), app de identidad, id y clave del webhook, `BINDINGS_JSON`,
`RESOLVEKIT_OPS_TOKEN`, claves de los modelos, `DEMO_CODE`, `METERMCP_RETURN_ORIGINS`. No están en el blueprint (se
aplican los valores por defecto; aparecen allí como comentarios YAML con su valor por defecto): `DAILY_UPLOADS`,
`RESOLVEKIT_PUBLIC_URL`, `RESOLVEKIT_CUSTOM_DOMAINS`, `RESOLVEKIT_BINDINGS`, `TRUSTED_PROXY_PEERS`, la elección de
modelos (`ANALYST_PROVIDER`, `GEMINI_MODEL`, `GROQ_MODEL`, `AGENT_*_MODEL`, `GROQ_TPM`), `LIVE_ANALYSES_PER_HOUR`,
`RECHECKS_PER_HOUR`, los ajustes de retención (`ANALYSIS_CACHE_MAX_*`, `ANALYST_USAGE_MAX_*`); en MeterMCP
`METERMCP_PUBLIC_URL`, `METERMCP_CUSTOM_DOMAINS`, `METERMCP_IDLE_MINUTES`, `METERMCP_ALLOWED_ORIGINS`, `METERMCP_DB`,
`TRUSTED_PROXY_PEERS`. `DAILY_MESSAGE_SENDS` y `DAILY_SETTLE_SENDS` no están en el blueprint, ni siquiera como
comentarios: se aplican sus valores por defecto. Procedimiento: [despliegue](../operations/deployment.md).
