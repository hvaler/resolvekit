[English](../../judges/review-guide.md) | [Español](review-guide.md)

# Guía de revisión para el jurado

**Demo:** [resolvekit-i3j2.onrender.com](https://resolvekit-i3j2.onrender.com) · **Vídeo:** Pendiente (llegará con la
entrega) · **Código:** [github.com/hvaler/resolvekit](https://github.com/hvaler/resolvekit) · **Evidencia:**
[matriz de verificación](verification-matrix.md) · [evaluaciones](../quality/evaluations.md) ·
[integración con PayPal y hallazgos en sandbox](../technical/paypal-integration.md)

Nombres exactos de los controles, clic a clic: [recorrido por la demo](demo-walkthrough.md).

## Qué es ResolveKit

- **Problema.** Una disputa de PayPal es un plazo más pruebas dispersas. Los pequeños comerciantes responden tarde, o
  con afirmaciones que no pueden probar. Las compras hechas por agentes (una IA que paga herramientas) añaden disputas
  sin etiqueta de envío que mostrar.
- **Público.** Un pequeño comerciante que responde a disputas de PayPal sin un equipo de disputas.
- **Valor.** Un expediente y un borrador de respuesta en el que cada frase cita las palabras exactas en las que se
  apoya, las frases sin respaldo se tachan y nunca se envían, el comerciante aprueba el contenido exacto y el resultado
  se relee desde PayPal. En las compras hechas por agentes, la evidencia es el recibo por llamada de MeterMCP de un
  presupuesto que el comprador aprobó en PayPal.

## El recorrido de 5 minutos

| Minuto | Haz | Fíjate en |
|---|---|---|
| 1 | Abre el enlace de revisor del formulario de entrega y únete (**Join for this browser only** es lo más rápido) | La barra de la aplicación: *Sandbox evaluation · Test Store · PayPal sandbox*; la bandeja de entrada con los casos vinculados |
| 2 | Abre **PP-R-TVH-10190665** | **PayPal sandbox · live** con un id de disputa en la barra de la aplicación; la cronología; pasa el ratón por una cita para iluminar sus palabras; una frase tachada |
| 3 | Resuelve la contradicción de la dirección ("Apt 4" frente a "Apt 4B") con **Explain in response** | El botón cambia de *Resolve 1 item to continue* a **Review what will be sent →** |
| 4 | **Review what will be sent →** → **Continue to confirm →** → marca la aprobación → **Submit evidence to PayPal** (en la Explore demo es la ruta por defecto: va al simulador; al sandbox real solo mientras el caso tenga una disputa nueva, ver la nota de abajo) | El contenido compuesto por el servidor con el id de intención y el hash del contenido; después **Recorded by PayPal** con una comparación campo a campo |
| 5 | Abre `/agent` (**Try the buying agent** en la bandeja de entrada) e inicia una ejecución con un objetivo de ejemplo | Pasos con los motivos breves del modelo, el enlace de aprobación, el recibo de MeterMCP |

A 29/10/2026 las reservas de disputas nuevas del sandbox de ambos casos están vacías; las disputas nuevas se preparan el 31/10/2026 y la reserva se rellena para la evaluación el 28–30/11/2026. Hasta entonces la ruta por defecto es la Explore demo, y el envío al sandbox real puede no estar disponible. Haz los minutos 2–4 en el mismo caso en la **Explore demo** (`/demo/cases/PP-R-TVH-10190665`): el flujo es idéntico,
pero se envía al simulador del navegador en lugar de a PayPal. Más [más abajo](#si-una-disputa-ya-se-usó-la-reserva-está-vacía-o-se-alcanzó-un-límite).

## Qué aportan PayPal, la IA y MeterMCP

| Parte | Aportación | Estado |
|---|---|---|
| PayPal Customer Disputes API v1 | Lee la disputa vinculada (estado, fase, motivo, evidencia solicitada, acciones permitidas, fecha límite); envía `provide-evidence` con notas y archivos; relee la disputa | Verificado en sandbox (dos revisores enviaron evidencia, «Recorded by PayPal · 6 of 6 fields», 17/10/2026) · Desplegado |
| Webhooks de PayPal | Eventos `CUSTOMER.DISPUTE.*` verificados con el método de postback documentado por PayPal; el evento es solo un aviso y la disputa se relee | Verificado en sandbox (17/10/2026) · Desplegado |
| PayPal Orders v2 / Payments v2 | El presupuesto de MeterMCP: un pedido `AUTHORIZE` por exactamente el tope; al cerrar, una captura parcial final de las llamadas que salieron bien (en nuestras ejecuciones en sandbox el resto dejó de estar retenido) o una anulación (void) | Verificado en sandbox (09/10 y 19/10/2026) · Desplegado |
| **Continue with PayPal** | Identifica la cuenta de PayPal de un comerciante con un agreement token de Billing Agreements v1 sin cargo (familia de API obsoleta). No es Log in with PayPal y no da acceso a las disputas | Verificado en sandbox (10/10/2026) · Desplegado |
| Analista de IA (Gemini `gemini-3.8-flash`, Groq `openai/gpt-oss-120b` como respaldo) | Extrae hechos con citas literales, construye la cronología, encuentra contradicciones, redacta; una llamada aparte verifica cada frase frente a sus propias citas | Desplegado; evaluado solo en conjuntos sintéticos ([evaluaciones](../quality/evaluations.md)) |
| Código determinista | Descarta las citas no literales; limita las frases con números sin citar o con documentos marcados; las reglas eligen la acción y el tipo de evidencia | Implementado · Probado en local · Desplegado |
| Agente comprador (mismos modelos, function calling) | Elige una herramienta de MeterMCP por turno; el código valida la herramienta, los argumentos, el precio y los límites antes de cada llamada | Verificado en sandbox (dos ejecuciones, 19/10/2026, ejemplos) · Desplegado |
| MeterMCP | Una pasarela MCP de pago por uso: herramientas de pago (`quote_lookup` 0.05, `deep_report` 0.40, `bulk_export` 0.92 USD), las llamadas fallidas nunca se cobran, recibos con hashes de las peticiones | Verificado en sandbox · Desplegado |

Solo `provide-evidence` se ha ejercitado de extremo a extremo a través de la app en el servicio alojado. Las demás
acciones de disputa están en el código desplegado (`c12faea`, 21/10/2026), pero aún no se han ejercitado en el servicio
alojado; un estado por variante
([especificación funcional](../product/functional-specification.md#56-acciones-de-disputa-distintas-de-la-evidencia)):

| Acción de disputa | Estado |
|---|---|
| Enviar mensaje; aceptar la reclamación (reembolso total, o parcial, que PayPal registra como oferta); hacer una oferta de reembolso parcial; escalar; evidencia tras un escalado | **Verificado en sandbox** a través de la app (20/10/2026: el servidor de la rama ejecutado en local, un envío cada una, releído). El código está Desplegado (`c12faea`, 21/10/2026); estas acciones **no** se han ejercitado todavía en el servicio alojado |
| Un mensaje con adjunto | Verificado en sandbox a través de la app (V-7, 21/10/2026, ejecución local: una subida confirmada, registrada por PayPal con 1 documento); también Probado en local en el servidor y en el editor web. El código con este estado está Desplegado (`c12faea`, 21/10/2026) |
| Oferta de sustitución · retirar una oferta · apelación · prueba de reembolso · tipos con devolución | **No disponible**, cada una con su motivo en el producto |

Cada variante disponible se apoya en una escritura que el propietario aprobó en el sandbox el 20/10/2026 y en su
relectura ([contratos de las acciones de disputa](../technical/paypal-integration.md#contratos-de-las-acciones-de-disputa));
esas escrituras se hicieron fuera del flujo de la app, así que muestran el comportamiento de PayPal. Después se ejecutó
el flujo propio de la app una vez por variante verificada (V-1 a V-7, misma página); solo la aceptación total (V-4)
movió dinero, un reembolso de sandbox de 7.00 USD.
Los revisores solo pueden enviar mensajes (en la disputa activa de un caso vinculado); aceptar, ofertar y escalar son
del Owner, con una segunda confirmación, y los demás ven una vista previa. Las acciones solo del Owner necesitan el
caso de liquidación vinculado en el `BINDINGS_JSON` alojado, cosa que aún no ocurre. ResolveKit nunca crea un reembolso.

## Qué es real, sintético, simulado o almacenado

| Elemento | Tipo | Notas |
|---|---|---|
| Las disputas de PayPal vinculadas en la Sandbox evaluation | **Real (sandbox)** | Pagos reales del sandbox y disputas reales de compradores; las lecturas y los envíos llaman de verdad a PayPal. Sin dinero real |
| «PayPal sandbox · live `PP-R-…`» en la barra de la aplicación | **Real (sandbox)** | "live" significa una lectura en directo de una disputa del sandbox, no el entorno de producción (live) de PayPal |
| Pedido, etiqueta, registro del transportista y mensaje del comprador de cada caso | **Sintético** | Documentos inventados; los PDF que se envían a PayPal llevan una cabecera que los identifica como documentos de prueba sintéticos |
| Lo que tú subes | **Entrada real** | Se lee en el servidor, se tapa, se cita y, una vez confirmado, se envía a la disputa del sandbox |
| Análisis de IA y recomprobaciones | **Salida real del modelo** | "cached" = resultado almacenado de una ejecución anterior del modelo; "live" = recién ejecutado |
| Decisiones del agente comprador en `/agent` | **Salida real del modelo** | Las elecciones de un modelo, comprobadas por código; una ejecución es un ejemplo, no una garantía |
| Presupuesto, captura, anulación y recibo de MeterMCP | **Real (sandbox)** | Registros reales de Orders v2 / Payments v2 |
| Salidas de las herramientas de MeterMCP | **Sintético** | Datos de demostración deterministas; cada resultado lo dice |
| Un fallo inyectado | **Simulado a propósito** | Solo cuando se marca *Simulate an outage*; etiquetado como *injected*, nunca se cobra |
| Todos los casos de la Explore demo | **Simulado** | Simulador en el navegador, análisis almacenados ("golden"); nada llega a PayPal |
| El caso del agente de 1.37 USD tal como se abre en la demo | **Datos de demostración sintéticos** | Datos de demostración inventados cuyas cifras coinciden con una sesión de sandbox hecha por un cliente con guion (scripted) el 09/10/2026; pone a prueba al analista, no al agente |
| El caso del agente vinculado **PP-R-MMC-10190702** | **Real (sandbox)**, cliente con guion | Su recibo procede de una sesión hecha por el cliente con guion anterior, no de una ejecución dirigida por el modelo (a fecha de 19/10/2026) |

## Acceso y entorno recomendado

- **Recomendado:** la **Sandbox evaluation** (Test Store), a la que se entra con **el enlace de revisor del formulario
  de entrega**. Ábrelo, escribe tu nombre y pulsa **Create a passkey and join** o **Join for this browser only**. Tu
  nombre aparece en el registro de auditoría de lo que apruebes. El enlace de revisor fija cuándo termina tu acceso.
- **Sin cuenta:** la **Explore demo** en `/demo`, abierta a todo el mundo. Las mismas pantallas con casos ficticios;
  no se envía nada; **+ Add evidence** está desactivado ahí.
- **No esperes** que funcione tu propia cuenta de PayPal: **Continue with PayPal** lleva al comerciante a una pantalla
  de espera (*Connecting disputes for new merchants is being validated and isn't available yet…*). Ese es el estado
  real (Pendiente), no un error.
- Para aprobar un presupuesto del agente, usa **la cuenta buyer (personal) del sandbox de PayPal del formulario de
  entrega**. En nuestra ejecución en sandbox del 19/10/2026, PayPal rechazó la aprobación cuando se hizo con la cuenta
  business del vendedor («Estás entrando en la cuenta del vendedor…» (texto recortado en el registro)); es una observación, no una
  regla documentada de PayPal.

## Recorrido principal: responder a una disputa

1. En la bandeja de entrada de Test Store abre **PP-R-TVH-10190665** («item not received», fase de consulta (inquiry)).
2. Lee la cabecera del caso (todos los campos de PayPal proceden de la última lectura de PayPal), la **Timeline**, la
   columna **Evidence** y el **Response draft**. Pasa el ratón por un chip de cita (por ejemplo `E3 · UPS tracking`):
   las palabras citadas se iluminan.
3. Estados de las frases: **Supported** (respaldada), **Needs review** (necesita revisión, con el motivo; **Rephrase to
   what the evidence shows** aplica la reescritura del verificador y la vuelve a comprobar) y **Removed: no supporting
   evidence** (tachada, nunca se envía). **Edit** cualquier frase: el servidor comprueba el texto nuevo frente al
   expediente.
4. Resuelve la tarjeta de contradicción (**Explain in response**, o **Mark resolved…** con una nota).
5. **Review what will be sent →** muestra *Exactly what goes to PayPal*, compuesto por el servidor de ResolveKit (id de
   intención, sha256 del contenido), junto a la lista afirmación ↔ prueba. **Continue to confirm →**, marca *I'm … and I
   approve submitting this evidence…* y después **Submit evidence to PayPal**. El paso de confirmación dice *This sends
   test documents to a PayPal sandbox dispute. No real money moves.*
6. El servidor vuelve a comprobar sobre una lectura nueva de PayPal, envía, y la página relee la disputa. **Recorded by
   PayPal** aparece solo cuando PayPal lista evidencia nueva del vendedor que coincide con lo enviado (tipo de
   evidencia, notas, transportista, seguimiento, nombres de archivo); si no, dice qué difiere o que no hay nada nuevo
   registrado.

Aceptado por PayPal ≠ disputa ganada: después decide PayPal. Opcional: **Re-run with AI** ejecuta el analista en directo
(unos 30–60 s; 35 s observados el 17/10/2026).

## Opcional: el agente comprador

1. Abre `/agent` (bandeja de entrada: **Try the buying agent**).
2. Elige un objetivo de ejemplo o escribe uno (hasta 300 caracteres); fija **Budget cap (USD, 0.50 to 5.00)**;
   opcionalmente marca *Simulate an outage: the first call to Deep report fails (marked as injected)*; **Start the
   run**.
3. En la primera llamada de pago que quepa aparece **Approve in PayPal**: aprueba con la cuenta buyer del sandbox del
   formulario de entrega. La ejecución continúa tras la aprobación.
4. Observa **Steps** (herramienta, precio, OK o FAILED, resultado, el motivo breve declarado por el modelo),
   **Answer**, **Budget and receipt** (capturado y liberado, según dice el recibo de MeterMCP) y la línea de uso del
   modelo (nunca se cobra en PayPal).
5. Marca dos ejecuciones en **Your runs** y pulsa **Compare**. **Stop** termina una ejecución en curso (Stop en el
   sandbox: Pendiente).

Observado el 19/10/2026 (ejemplos): con un fallo inyectado, la ejecución terminó en *The tools cannot meet this goal*
(capturados 0.05, liberados 1.95 de 2.00 USD); otro objetivo terminó en *Done* (capturados 0.92, liberados 1.08).
Límites: una ejecución en curso por persona, 5 por persona y día, 20 al día en total.

Opcional para usuarios de MCP: el endpoint público `/mcp` de MeterMCP funciona desde tu propio cliente MCP con el
código de demo del formulario de entrega; ver [herramientas MCP](../technical/mcp-tools.md).

## Subir y sanear un documento

En un caso de Test Store pulsa **+ Add evidence**:

1. Elige una captura PNG/JPEG (hasta 5 MiB, 4096 px por lado, 8,294,400 píxeles) o un PDF (hasta 10 MiB y 30 páginas),
   o pega texto en **Or paste text (an email thread, a chat)** y pulsa **Add pasted text** (solo Latin-1, hasta
   20,000 caracteres).
2. Tapa lo que no debe compartirse: arrastra rectángulos sobre una imagen o una página del PDF; en el texto pegado,
   selecciona los pasajes que quieres quitar. Después **Read again from the covered image** (imagen), **Cover this page
   and read it again** (página de PDF) o **Remove and read again** (texto). El texto que se muestra se lee desde el
   archivo tapado mediante OCR local en el servidor.
3. Corrige una línea mal leída si hace falta (queda marcada como *corrected by* con tu nombre). En un PDF puedes transcribir una
   línea que no se leyó marcando su zona fuera de cualquier tapado. **Show it for this page** muestra el texto propio
   del PDF solo como pista.
4. **Confirm as evidence** (o **Discard**; una subida sin confirmar se elimina pasadas 24 horas). Se convierte en el
   siguiente número de evidencia (E7, E8…). Pulsa **Re-run with AI** para que el análisis pueda citarla.
5. Una frase que se apoya en una línea corregida o transcrita pide tu confirmación explícita antes de poder enviarse.

PayPal recibe solo el archivo saneado, llamado `E<n>-upload.png` (`.jpg` si es una foto tapada), `E<n>-upload.pdf` o `E<n>-pasted.pdf`. Un PDF más
largo te pide elegir hasta 5 páginas. Tapar el texto junto a un código de barras o un código QR no oculta lo que
contiene el código. No subas datos personales que te importen. Estado: subida de imagen enviada a PayPal y registrada
(18/10/2026); envíos de PDF y de texto pegado a PayPal Pendiente. Detalles: [revisión de PDF](../user-guide/pdf-review.md).

## Si una disputa ya se usó, la reserva está vacía o se alcanzó un límite

| Ves | Por qué | Qué hacer |
|---|---|---|
| El botón de envío dice **Evidence recorded by PayPal** y el borrador es de solo lectura | Alguien ya envió evidencia a esta disputa del sandbox; en nuestras pruebas en sandbox la acción `provide_evidence` de PayPal desapareció tras un envío (observado, no es una regla documentada) | Lee la relectura y vuelve más tarde: unos 15 minutos después de un envío, la siguiente lectura pasa el caso a la siguiente disputa de su reserva, **si a la reserva le queda alguna**. O recorre el mismo flujo en la Explore demo |
| El caso sigue en una disputa usada | La reserva de disputas nuevas del sandbox está vacía (a 29/10/2026 en ambos casos; las disputas nuevas se preparan el 31/10/2026 y la reserva se rellena para la evaluación el 28–30/11/2026) | Usa la Explore demo para el paso de envío (la ruta por defecto hasta entonces); todo lo demás en Test Store sigue funcionando |
| *PayPal is processing this new dispute. Actions appear shortly.* | Una disputa nueva del sandbox muestra primero `UNDER_REVIEW` sin acciones para el vendedor; en nuestras pruebas se abrió al cabo de unos minutos | Espera unos minutos y vuelve a abrir el caso |
| Un mensaje con una hora de reinicio (por ejemplo *The demo's daily agent runs are used up; they reset at …*) | Límites compartidos: al día 60 análisis en directo, 200 recomprobaciones, 20 envíos de evidencia, 40 subidas, 20 ejecuciones del agente (5 por persona), 20 presupuestos de MeterMCP; por hora 6 análisis en directo y 30 recomprobaciones; límites de peticiones por dirección | Espera a la hora indicada, o usa el análisis almacenado y la Explore demo |
| *Seller workspace only* / *Sign in required* en **Re-run with AI** | No estás en el espacio de trabajo de Test Store | Vuelve a abrir el enlace de revisor |
| Uno o dos minutos de errores (502) justo después de un despliegue (observado, evidencia privada) | Cada servicio tiene un disco, así que un despliegue lo reinicia y no hay cambio sin interrupción (zero-downtime) | Recarga pasados dos minutos |

## Enlaces

- Demo: [resolvekit-i3j2.onrender.com](https://resolvekit-i3j2.onrender.com) (Explore demo en `/demo`)
- Vídeo: Pendiente (llegará con la entrega)
- Código: [github.com/hvaler/resolvekit](https://github.com/hvaler/resolvekit) · [README](../../../README.es.md)
- Evidencia: [matriz de verificación](verification-matrix.md) · [evaluaciones](../quality/evaluations.md) ·
  [tests](../quality/testing.md) · [limitaciones](../product/limitations.md)
