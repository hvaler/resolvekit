[English](../../user-guide/buying-agent.md) | [Español](buying-agent.md)

# Agente comprador

En `/agent` un modelo de IA trabaja hacia un objetivo que escribes eligiendo las herramientas de pago de MeterMCP, una
acción cada vez, dentro de un presupuesto que apruebas en PayPal (sandbox). El código comprueba cada acción antes de
hacerla, solo se cobran las llamadas con éxito, y la liquidación que se muestra es lo que dice el recibo de MeterMCP.
Cada paso muestra el breve motivo declarado por el modelo; el razonamiento interno del modelo no se muestra. Las salidas
de las herramientas son sintéticas.

Estado: Implementado · Probado en local · Desplegado · Verificado en sandbox (dos ejecuciones el 19/10/2026, más abajo;
son ejemplos, no una garantía de comportamiento). **Stop** en una ejecución en curso, el respaldo de Groq y la
recuperación tras un reinicio no se han demostrado en el sandbox: **Pendiente**.

Cómo funciona por dentro: [Agente comprador (técnico)](../technical/buying-agent.md), [Herramientas MCP](../technical/mcp-tools.md).

## Quién puede usarlo

- Evaluación en sandbox: cualquiera con sesión iniciada en el espacio del vendedor (Owner, Member, Reviewer). En la
  bandeja, **Try the buying agent**.
- Modo local: el operador, con una clave de modelo y MeterMCP en marcha.
- Sin sesión, `/agent` te lleva a **Sign in**. El inicio desde otro espacio de trabajo se rechaza: «On this public demo
  only the seller's workspace starts agent runs.»

## Qué puede comprar el agente

| Herramienta | Precio por llamada con éxito (USD) | Qué devuelve (sintético) |
|---|---|---|
| `quote_lookup` | 0.05 | Una cotización |
| `deep_report` | 0.40 | Un informe |
| `bulk_export` | 0.92 | Una exportación de filas |
| `price_list`, `get_balance` | gratis | Precios; el saldo del presupuesto |

Al modelo se le ofrecen estas más `finish`. Abrir el presupuesto, cerrarlo y leer el recibo lo hace el código, nunca el
modelo.

## Iniciar una ejecución

1. En **New run**, escribe un **Goal** (1–300 caracteres, texto plano) o elige uno de los ejemplos («they fill the
   field; edit them as you like»): uno que las herramientas pueden cumplir, uno que necesita la exportación cara y uno
   que no pueden cumplir.
2. Fija el **Budget cap (USD, 0.50 to 5.00)**, p. ej. `2.00`. El tope no se puede subir durante la ejecución.
3. Opcional: marca **Simulate an outage: the first call to Deep report fails (marked as injected)**.
4. **Start the run**. Puedes tener una sola ejecución en marcha a la vez («One run at a time: wait for yours to end, or
   stop it.»).

## Aprobar el presupuesto en PayPal

No se abre nada en PayPal hasta que el modelo elige su primera llamada de pago que cabe en el tope. Entonces MeterMCP
crea un pedido de PayPal para **autorizar exactamente el tope**, y la ejecución muestra **Waiting for approval in
PayPal** con: «The agent wants to spend up to <cap> USD. Approve the budget in PayPal (sandbox); nothing is charged
until calls succeed.»

1. Elige **Approve in PayPal** (se abre en una pestaña nueva; solo el autor de la ejecución ve este enlace).
2. Inicia sesión con una **cuenta personal (compradora) de sandbox** de PayPal: los revisores reciben una en las
   instrucciones de prueba del formulario de entrega. No uses la cuenta **business** de sandbox: es la cuenta a la que
   se paga el presupuesto. En nuestra ejecución en sandbox del 19/10/2026 PayPal rechazó la aprobación con la cuenta
   business del vendedor («Estás entrando en la cuenta del vendedor…» (texto recortado en el registro)). Esto se observó, no está
   documentado por PayPal.
3. Aprueba. MeterMCP vuelve a leer el pedido en PayPal y te devuelve a `/agent?run=<id>` (o muestra «Budget approved …
   You can close this tab and return to your agent»).
4. La ejecución continúa. Si cancelas en PayPal, la ejecución termina en **Not approved in PayPal** («Nothing was
   authorized or charged»). Si nadie aprueba en 15 minutos, termina en «Stopped: PayPal approval timed out». El tiempo
   de espera no cuenta para el límite de tiempo del agente.

## Leer la ejecución

| Tarjeta | Qué muestra |
|---|---|
| Cabecera | La etiqueta de resultado o estado, el objetivo, «<who> · <time>», «simulated outage: deep_report» si se marcó, **Stop**, **Keep** |
| **Steps** | Una línea por acción: `#2 deep_report · 0.40 USD · FAILED, not charged · <result>`, y después «Reason: <the model's stated reason>». Distintivos: **in progress**, **injected**, **not charged**, **uncertain** (el servidor se reinició durante esa llamada; nunca se repite). Una herramienta gratuita muestra «free»; una llamada que supera el saldo muestra «not called: insufficient balance»; una respuesta ilegible o múltiple muestra «invalid action» |
| **Answer** | Lo que el modelo dice que encontró y lo que falta |
| **Budget and receipt** | **Budget cap**; **Charged per call (MeterMCP metering)**; **Failed calls (not charged)**; **Settlement (MeterMCP receipt)**; ids de la captura de PayPal, el pedido de PayPal y la sesión de MeterMCP (solo el autor); **Receipt SHA-256** |
| Línea de uso | «Model: <provider> <model> · N calls · X in / Y out tokens (provider-reported or estimated) · not charged to the PayPal budget» |

**El uso del modelo va aparte del presupuesto.** El presupuesto de PayPal solo paga las llamadas a herramientas de
MeterMCP. Las llamadas del modelo las paga el servicio con su propia cuota del proveedor y nunca se cobran al comprador.

**Charged per call** es la medición de MeterMCP durante la ejecución; **Settlement** es la única declaración de lo que
capturó PayPal, y los importes solo aparecen tal como los indica el recibo.

## Resultados

Cómo terminó la ejecución, tal como lo dice la página. Una ejecución que se detuvo o se interrumpió nunca se da por
terminada (done).

| Etiqueta | Significado |
|---|---|
| **Done** | El modelo terminó con `done`: dice que el objetivo se ha cumplido |
| **The tools cannot meet this goal** | El modelo terminó con `cannot_do` |
| **Out of budget** | El modelo terminó con `out_of_budget`: lo que queda no alcanza para pagar lo que hace falta |
| «Stopped: action limit (8)» | Se usaron 8 acciones |
| «Stopped: time limit» | 180 s de tiempo del agente (sin contar la espera de aprobación) |
| «Stopped: model call limit» / «Stopped: model token budget» | 12 llamadas al modelo / 60,000 tokens por ejecución |
| «Stopped: the model gave invalid actions» | Dos acciones no válidas seguidas (ninguna, varias o no permitida) |
| «Stopped: PayPal approval timed out» | No se aprobó en 15 minutos |
| «Stopped: MeterMCP did not open a budget» / «Stopped: MeterMCP unreachable» | MeterMCP se negó o no se pudo contactar |
| «Stopped: the run could not be saved» / «Stopped: internal error» | Fallo en el servidor |
| **Model unavailable** | Ningún modelo respondió (tras los reintentos y, cuando hay una segunda clave configurada, el proveedor de respaldo) |
| **Not approved in PayPal** | El comprador canceló o PayPal lo rechazó |
| **Interrupted (stopped or server restart)** | Se pulsó **Stop**, o el servidor se apagó o se reinició; el registro no dice cuál de las dos |

## Liquidación

| Texto | Significado |
|---|---|
| «Captured X USD · Y released» | MeterMCP capturó las llamadas con éxito; el resto de la autorización deja de estar retenido (observado en sandbox) |
| «Capture pending at PayPal (not final)» | PayPal respondió `PENDING`; no se da por cobrado nada hasta que se complete |
| «Voided: nothing charged» | Ninguna llamada con éxito; la autorización se anuló |
| «Capture declined by PayPal: nothing charged» | PayPal rechazó la captura o esta falló |
| «Not approved in PayPal: nothing charged» | El presupuesto nunca se aprobó |
| «Settlement failed: nothing charged as far as MeterMCP knows; will be retried» | MeterMCP lo reintentará |
| «Not verified yet» | Aún no se pudo leer el recibo; el servidor concilia cada 5 minutos |
| «Budget open in PayPal (not settled yet)» | Aprobado, aún sin cerrar |
| «Waiting for approval in PayPal: nothing charged yet» / «Not settled yet: the run is still going» | Mientras se ejecuta |
| «Nothing opened in PayPal» | La ejecución terminó antes de cualquier llamada de pago |

La página sigue leyendo una ejecución terminada cuya liquidación aún puede cambiar, durante hasta 30 minutos.

## Fallo inyectado

Con **Simulate an outage** marcado, MeterMCP hace fallar a propósito la **primera** llamada a `deep_report` de esa
ejecución. Ese paso muestra **injected** y **not charged**; el recibo lo marca igual. El modelo recibe
«UPSTREAM_UNAVAILABLE (injected for this run at the person's request)» y decide qué hacer después. Es una prueba de
comportamiento ante fallos, no una caída real.

## Stop, Keep, Compare, Workspace runs

| Control | Quién | Qué hace |
|---|---|---|
| **Stop** | El autor de la ejecución, mientras se ejecuta | Aborta la ejecución: termina en **Interrupted (stopped or server restart)** y MeterMCP liquida lo usado. En sandbox: **Pendiente** |
| **Keep** | El Owner del espacio de trabajo (y el operador local) | «A kept run is never deleted by the 30-day retention.» |
| **Compare** | Cualquiera, sobre dos ejecuciones de la lista | Marca dos ejecuciones («Pick to compare») y después **Compare (2/2)**: «Two runs side by side», paso a paso, con el resultado, la liquidación y el uso de cada una |
| **Workspace runs** | El Owner del espacio de trabajo (modo alojado) | Muestra las ejecuciones de todos en el espacio de trabajo, en solo lectura, marcadas con «Viewed as workspace owner», sin el enlace de aprobación, el pedido de PayPal ni el id de sesión de MeterMCP. Cada una de estas consultas queda registrada |

## Dos ejecuciones observadas (19/10/2026, sandbox de PayPal)

Solo ejemplos; el mismo objetivo puede llevar a elecciones distintas.

| Ejecución | Tope | Caída simulada | Resultado | Liquidación |
|---|---|---|---|---|
| A | 2.00 USD | sí | **The tools cannot meet this goal** | «Captured 0.05 USD · 1.95 released» |
| B | 2.00 USD | no | **Done** | «Captured 0.92 USD · 1.08 released» |

Ambas usaron Gemini. **Compare**, **Keep** y la vuelta a `/agent?run=` tras la aprobación se comprobaron el mismo día.

Estas ejecuciones no son el ejemplo «1.37 of 5.00 USD» del caso de compra de agente: ese son datos de demo (y coincide
con una sesión de sandbox hecha el 09/10/2026 por un cliente con guion (scripted)). Iniciar una ejecución nunca abre una disputa.

## Límites

1 ejecución en curso por persona y 3 por servidor; 5 ejecuciones por persona y 20 por servidor por día UTC (se
restablecen a medianoche UTC); 20 presupuestos de MeterMCP al día. Por ejecución: 8 acciones, 12 llamadas al modelo,
180 s, 15 min para aprobar.

## Qué se comparte y qué se conserva

| Destinatario | Qué |
|---|---|
| Proveedor del modelo (Gemini; Groq como respaldo) | Tu objetivo (como dato), el tope, la lista de herramientas y precios, cada resultado de herramienta (sintético) y los turnos anteriores del propio modelo |
| PayPal (sandbox) | Un pedido por el tope (bienes digitales, con el id de sesión de MeterMCP como referencia), su autorización, una captura o una anulación |
| Servidor de ResolveKit | Un registro por ejecución (objetivo, pasos, motivos, uso, liquidación, ids), conservado 30 días salvo que se marque con Keep, esté sin liquidar, sin guardar o vinculado como evidencia de un caso. No hay botón de borrar |
| Ledger (libro contable) de MeterMCP | Sesión, llamadas con hashes de petición y respuesta, liquidación; sin caducidad en el código |

El sandbox de PayPal conserva sus propios registros de pedido, autorización y captura. Los proveedores de modelos
conservan lo que recibieron según sus propias políticas.

## Errores

| Mensaje | Qué hacer |
|---|---|
| «You already have a run going: wait for it to end, or stop it.» | Espera o pulsa **Stop** |
| «The server is running as many agent runs as it allows; try again in a few minutes.» | Inténtalo más tarde |
| «No AI model is configured on this server, so the agent cannot run.» | Modo local: define `GEMINI_API_KEY` o `GROQ_API_KEY` |
| «The demo's daily agent runs are used up; they reset at …» / «You have used your agent runs for today; try again in N h.» | Espera al restablecimiento |
| «The cap is an amount in USD from 0.50 to 5.00, e.g. 2.50.» | Corrige el tope |
| «This run is not one you can see.» | La ejecución pertenece a otra persona |
| Página de MeterMCP «Payment method declined» | No se autorizó ni se cobró nada; en `/agent` la ejecución termina en **Not approved in PayPal**. Inicia una ejecución nueva |
