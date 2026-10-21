[English](../../technical/mcp-tools.md) | [Español](mcp-tools.md)

# MeterMCP: endpoints y herramientas MCP

> **Interfaz interna, no una API pública estable.** MeterMCP es una pasarela de demo: sus herramientas devuelven
> datos **sintéticos**, y sus rutas y la forma de sus herramientas cambian con el código. El `/mcp` público está
> abierto para que los revisores puedan probar sus propios clientes MCP contra el sandbox.

`apps/metermcp` es un servidor MCP mínimo de pago por uso. Un cliente MCP llama a herramientas de pago; el usuario
aprueba un presupuesto una vez en PayPal; MeterMCP cobra solo las llamadas que tienen éxito y libera el resto. Un
único vendedor (la app de sandbox de PayPal de su entorno), sin marketplace, sin pagos a terceros. Fuente:
`apps/metermcp/src/` en el commit `81c6242`.

Qué es real y qué es sintético: el flujo de dinero de PayPal (pedido de sandbox, autorización, captura parcial o
anulación), el ledger (libro contable), los hashes de peticiones y respuestas y los recibos son registros reales. Las salidas
de las herramientas son datos de demo deterministas y cada resultado indica `synthetic: true`.

## Rutas HTTP

| Método | Ruta | Exposición | Autenticación | Propósito |
|---|---|---|---|---|
| GET | `/healthz` | alojado, cualquier Host | ninguna | Comprobación de salud de Render |
| GET | `/health` | host público | ninguna | `{ok, paypal, mcpSessions, mcpRejected, mcpExpired}` |
| POST, GET, DELETE | `/mcp` | público | ninguna; alojado: `x-demo-code` permite crear presupuestos | Endpoint MCP (Streamable HTTP, con estado, respuestas JSON) |
| GET | `/approved`, `/cancelled` | público | ninguna (el pedido se vuelve a leer en PayPal; la query string no demuestra nada) | Páginas de retorno del comprador; 303 a un `return_to` permitido una vez que el presupuesto está activo |
| POST, GET, DELETE | `/agent/mcp` | **interno**: en el modo alojado solo cuando no se llega a través del proxy público | `x-metermcp-token` (alojado) + `x-agent-run: run-<32 hex>` | Las ejecuciones del agente de ResolveKit |
| GET | `/sessions?capture=<id>` | **interno** | token de administración | La sesión cuya captura de PayPal es `<id>` |
| GET | `/sessions/:id/receipt.json`, `/sessions/:id/receipt.pdf` | **interno** | token de administración | Recibo |
| POST | `/sessions/:id/close` | **interno** | token de administración | Cerrar y liquidar, o reintentar una liquidación fallida (409 mientras está ocupada) |
| POST | `/sessions/:id/reconcile` | **interno** | token de administración | Leer ahora de PayPal una captura `PENDING` |

Guardas: el modo local escucha en `127.0.0.1` y exige el Host `127.0.0.1:<port>` o `localhost:<port>`; cualquier
Origin presente debe estar en `METERMCP_ALLOWED_ORIGINS`; POST solo acepta JSON; cuerpo HTTP ≤ 256 KiB. Alojado: las
rutas de administración responden 404 cuando hay `X-Forwarded-For` o el Host es público, y necesitan el token de
administración. `close_session` no da esas rutas a los clientes MCP: su respuesta indica llamar a `get_receipt`
(`receipt_tool: "get_receipt"`).

## Herramientas

| Herramienta | Tipo | Precio (USD por llamada con éxito) | Argumentos | Ofrecida al modelo del agente |
|---|---|---|---|---|
| `quote_lookup` | de pago | 0.05 | `symbol` (1–32) | sí |
| `deep_report` | de pago | 0.40 | `topic` (1–200) | sí |
| `bulk_export` | de pago | 0.92 | `dataset` (1–64), `rows` (1–1000, por defecto 100) | sí |
| `price_list` | gratuita | — | — | sí |
| `get_balance` | gratuita | — | — (consultarla también recoge la aprobación del comprador) | sí |
| `open_budget` | gratuita (crea un pedido de PayPal) | — | `cap` (p. ej. `"2.50"`, dentro del rango de topes), `fail_first?` (≤ 3 herramientas de pago), `return_to?` (≤ 2048, solo orígenes permitidos) | no: solo el código |
| `close_session` | gratuita | — | — | no: solo el código |
| `get_receipt` | gratuita | — | — | no: solo el código |

Los precios aparecen en el título, la descripción y `_meta["metermcp/price"]` de cada herramienta de pago. Cada
resultado de pago lleva `limits`, lo que no contiene (por ejemplo «Qualitative findings only: no row-level figures»),
para que quien llama pueda juzgar si merece la pena comprar otra herramienta. El campo `free` de `price_list` lista
`price_list`, `get_balance`, `close_session` y `get_receipt`; ninguna se mide ni se cobra nunca.

Las respuestas de las herramientas son resultados de herramientas MCP cuyo contenido de texto es JSON; los errores
establecen `isError: true` con un código `error`:

| `error` | Cuándo |
|---|---|
| `payment_required` | Llamada de pago sin presupuesto activo: incluye el precio, la propuesta de presupuesto y una `approval_url` |
| `budget_exceeded` | Precio por encima del presupuesto restante: se rechaza antes de ejecutar la herramienta (restante, precio, sugerencia de recarga) |
| `demo_code_required` | Alojado: crear un presupuesto sin un `x-demo-code` válido |
| `daily_cap`, `caps_unavailable` | Se alcanzó el tope diario de presupuestos del modo alojado, o su almacén es ilegible |
| `invalid_cap`, `invalid_fail_first` | Argumentos de `open_budget` fuera de rango o de formato (`^\d{1,2}(\.\d{1,2})?$`) |
| `budget_exists` | Ya hay un presupuesto abierto (o cerrándose, con liquidación fallida o con captura pendiente) para esta sesión MCP |
| `payment_declined` | PayPal rechazó la fuente de fondos o la autorización; la sesión termina |
| `authorization_expired` | La autorización que respalda la sesión falta o ha caducado; no puede ejecutarse ninguna llamada de pago; llama a `close_session` |
| `upstream_failed` | La herramienta falló (incluido un fallo inyectado); se libera, nunca se cobra |
| `session_closed` | La sesión de pago se está cerrando, espera la liquidación o ya no está activa |
| `no_session` | Esta sesión MCP aún no tiene sesión de pago (`get_receipt`, `close_session`) |
| `no_mcp_session` | La petición no usó una sesión MCP con estado (`Mcp-Session-Id`) |
| `unknown_tool` | No es una herramienta de pago (también cuando `fail_first` nombra una) |
| `price_unavailable` | La herramienta no tiene un precio válido; la llamada no se hizo |
| `paypal_unconfigured`, `paypal_unavailable`, `ledger_unavailable` | Infraestructura no disponible |

## Flujo

1. Una llamada de pago sin presupuesto responde `payment_required`, o el cliente llama a `open_budget` con su propio
   tope. MeterMCP crea un pedido `AUTHORIZE` de Orders v2 de PayPal por el tope: un artículo `DIGITAL_GOODS`,
   `custom_id` = el id de la sesión (`mm-sess-<32 hex>`), `NO_SHIPPING`, URL de retorno y cancelación en MeterMCP.
2. El comprador aprueba en PayPal con una cuenta compradora (personal); en nuestra ejecución en sandbox del
   19/10/2026, PayPal rechazó la cuenta business del vendedor («Estás entrando en la cuenta del vendedor…» (texto recortado en el registro)): observado, no documentado. En la página de retorno o en una consulta de `get_balance`, MeterMCP
   vuelve a leer el pedido, lo autoriza y abre la sesión **solo si** PayPal informa de exactamente una autorización
   `CREATED` por exactamente el tope, para el pedido de esta sesión, con una caducidad futura (falla cerrado).
   `INSTRUMENT_DECLINED` o `DENIED` terminan la sesión; `PENDING` espera; una autorización que llega tarde se anula, igual que cualquier autorización aún no definitiva (`PENDING`, o `CREATED` pero rechazada por estas comprobaciones) cuando la sesión se cierra antes de abrirse.
3. Cada llamada de pago reserva su precio en una transacción SQLite antes de que se ejecute la herramienta; dos
   llamadas concurrentes no pueden quedarse ambas con lo último del presupuesto. El éxito se cobra (`OK`), el fallo
   se libera (`FAILED`). Cada llamada registra el `sha256` del `{session, n, tool, args}` canónico y de la respuesta.
4. `close_session` (o el cierre de administración, o el timeout por inactividad) captura exactamente la suma de las
   llamadas OK con `final_capture: true` (`invoice_id <session>-settle`, `note_to_payer` ≤ 255 caracteres con la
   lista de las llamadas), o anula la autorización si no se usó nada. Una liquidación fallida queda en
   `settlement_failed` y se reintenta con el mismo `PayPal-Request-Id`. Una captura a la que PayPal responde
   `PENDING` pone la sesión en `capture_pending`: el recibo indica que no es un cargo definitivo, ResolveKit no la
   usará como evidencia y MeterMCP la relee cada 30 s, bajo demanda y al cerrar (`COMPLETED` → liquidada;
   `DECLINED`/`FAILED` → `capture_declined`).
5. El recibo (JSON y PDF) contiene el mandato (pedido, autorización, tope, hora de aprobación), cada llamada (hora,
   herramienta, precio, estado, hashes, marca de inyectada), los totales, la liquidación y `receipt_sha256`.

Fallos inyectados: por presupuesto con `fail_first` (≤ 3 herramientas de pago) o, solo para las sesiones abiertas
desde una propuesta `payment_required`, con el interruptor de pruebas local `METERMCP_FAIL_FIRST`; una sesión
abierta con `open_budget` solo sigue su propio `fail_first` (ninguno si está vacío), nunca el interruptor. La primera
llamada de cada herramienta nombrada falla, nunca se cobra y se marca como inyectada en el resultado y en el recibo.

## Límites

| Límite | Valor |
|---|---|
| Rango del tope de presupuesto | 0.50–5.00 USD (`METERMCP_MIN_BUDGET`, `METERMCP_BUDGET`) |
| Sesiones MCP activas | 200 en total, 20 por IP de cliente; 15 min de inactividad → se libera el transporte y se cierra la sesión de pago |
| Sesiones de `/agent/mcp` | 10 en total, 10 por ejecución; una sesión debe usarla la clave de ejecución que la abrió (si no, 404) |
| Peticiones | `/mcp` 600 / 5 min por IP; `/agent/mcp` 600 / 5 min por ejecución; códigos de demo erróneos 5 / 15 min por IP |
| Presupuestos por día (alojado) | `DAILY_BUDGETS` (20), reservados de forma atómica, devueltos si no se creó ningún pedido |
| Cierre por inactividad de la sesión de pago | `METERMCP_IDLE_MINUTES` (15) |
| Timeout de PayPal | 30 s |

## Estado

| Capacidad | Estado |
|---|---|
| `/mcp` público | Implementado · Probado en local · Verificado en sandbox (cliente con guion (scripted), 09/10/2026) · Desplegado. El agente de línea de comandos contra el `/mcp` alojado: Pendiente |
| Herramientas y precios a través de `/agent/mcp` | Implementado · Probado en local · Verificado en sandbox (agente dirigido por el modelo, 19/10/2026) · Desplegado |
| Comprobación de aprobación que falla cerrada | Implementado · Probado en local |
| Captura parcial con `final_capture`, liberación del resto | Implementado · Probado en local · Verificado en sandbox (09/10, 19/10). Que el resto se libera está observado en sandbox, no citado de PayPal |
| Anulación de una autorización sin usar | Implementado · Probado en local · Verificado en sandbox (08/10) |
| `capture_pending` / `capture_declined` | Implementado · Probado en local; no observado en sandbox: Pendiente |
| Rutas de administración, `/agent/mcp` | Implementado · Probado en local · Desplegado |

Lagunas conocidas: `budget_exists` también bloquea mientras un presupuesto anterior se está cerrando, ha fallado o está pendiente. Ver
[problemas conocidos](../quality/known-issues.md).
