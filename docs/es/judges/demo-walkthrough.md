[English](../../judges/demo-walkthrough.md) | [Español](demo-walkthrough.md)

# Recorrido por la demo

Cada paso con los nombres que muestra la aplicación. Los nombres de los controles van en
**negrita** y el texto en pantalla en *cursiva*. Los ids de caso como `PP-R-TVH-10190665` son nombres de caso ficticios
del repositorio; el id de la disputa del sandbox de PayPal vinculada a un caso se muestra en la barra de la aplicación
y cambia a medida que rota la reserva. Versión corta: [guía de revisión](review-guide.md).

Demo: [resolvekit-i3j2.onrender.com](https://resolvekit-i3j2.onrender.com). Vídeo: Pendiente (llegará con la
entrega).

| Itinerario | Necesita | Tiempo |
|---|---|---|
| [A. Explore demo](#a-explore-demo-sin-cuenta) | Nada | 3 min |
| [B. Sandbox evaluation: responder a una disputa real del sandbox](#b-sandbox-evaluation-responder-a-una-disputa-real-del-sandbox) | El enlace de revisor del formulario de entrega | 5 min |
| [C. Añadir y sanear tu propia evidencia](#c-añadir-y-sanear-tu-propia-evidencia) | El itinerario B | 4 min |
| [D. El agente comprador](#d-el-agente-comprador) | El itinerario B y la cuenta buyer del sandbox del formulario de entrega | 4 min |
| [E. El caso de compra por agente](#e-el-caso-de-compra-por-agente) | El itinerario B | 2 min |
| [F. MeterMCP desde tu propio cliente MCP](#f-opcional-metermcp-desde-tu-propio-cliente-mcp) | Un cliente MCP y el código de demo del formulario de entrega | opcional |
| [G. La pantalla de espera del comerciante](#g-opcional-la-pantalla-de-espera-del-comerciante) | Cualquier cuenta del sandbox de PayPal distinta de la de Test Store | opcional |

## A. Explore demo (sin cuenta)

1. Abre la URL de la demo. La página de inicio dice *Answer PayPal disputes with evidence, not guesses.* Pulsa **Try
   the demo**.
2. La bandeja de entrada (`/demo`, barra de la aplicación *Explore demo · fictional cases, nothing is sent*) es una AG
   Grid: haz mayúsculas+clic en las cabeceras para ordenar por varias columnas, escribe en la caja de búsqueda, usa los
   chips de **Saved filters** (*Needs my approval*, *Agent purchase*, *Processing by PayPal*, *Due in … h*), mira la
   fila fija *Totals at risk*. Intro o un doble clic abre un caso.
3. Abre **PP-R-TVH-10190665** (*Buyer says the item was not received*). La franja **Analysis** lista los pasos y
   *Analysis by gemini-3.8-flash · 9 Oct 2026 · cached*; **Replay analysis** los reproduce sin llamar al modelo.
4. **Timeline** (izquierda), **Evidence** (centro) con la lista de comprobación *What "not received" disputes need*,
   **Response draft** (derecha). Pasa el ratón por un chip de cita como `E3 · UPS tracking`: las palabras citadas se
   iluminan en el documento.
5. La tarjeta de contradicción (*Contradiction: …*, **Needs review**): el pedido dice "Apt 4", el registro del
   transportista "Apt 4B". Pulsa **Explain in response** (añade una frase neutral que cita ambos) o **Mark resolved…**
   (registra una nota).
6. En el borrador, cada frase está **Supported**, **Needs review** o *Removed: no supporting evidence* (tachada, nunca
   se envía). **Edit** una frase para ver cómo se vuelve a comprobar (*Re-checking support…*).
7. Bajo **What to do** se listan las acciones que PayPal permite para esta disputa. El commit desplegado
   (`c12faea`) incluye las demás acciones de disputa, pero aún no se han ejercitado en el servicio alojado: elegir
   **Send message**, **Accept claim**, **Make an offer** o **Escalate** abre su propio editor, reproducido en el
   simulador solo con las transiciones de PayPal registradas; las acciones solo del Owner necesitan el caso de
   liquidación vinculado en el `BINDINGS_JSON` alojado, cosa que aún no ocurre, y los revisores pueden enviar mensajes
   en la disputa activa de un caso vinculado; las variantes no disponibles dicen por qué
   ([revisar y enviar](../user-guide/review-and-submit.md#otras-acciones-de-disputa)).
8. El botón de abajo dice **Review what will be sent →** cuando no queda nada abierto (antes, *Resolve N item to
   continue*). Púlsalo: el diálogo muestra *Exactly what goes to PayPal* (*Composed in this browser (simulator only)*),
   la lista afirmación ↔ prueba (*Number*, *Claim*, *Proof*) y *Not sent · removed by the analyst*.
9. **Continue to confirm →**, marca *I'm … and I approve submitting this evidence…*, **Submit evidence to PayPal**. En
   la demo esto va al simulador: los pasos terminan con *Recorded by the PayPal simulator* y una tabla *Field / Sent /
   Recorded (simulator) / Match*.
10. Otros casos de la demo: **PP-R-BLW-10187733** y **PP-R-PLN-10189901** (no es como se describió),
    **PP-R-KDA-10192258** (compra por agente, importe incorrecto), **PP-R-QZE-10181290** (evidencia ya registrada,
    borrador bloqueado), **PP-R-HFA-10176021** (resuelto a favor del vendedor), **PP-R-NKQ-10194410** (*PayPal is
    processing this new dispute*).

Añade `?dev` a la URL para ver el panel **Dev · simulator** (**PayPal re-read outcome**: esperando al comprador, en
revisión, tiempo agotado). Nunca aparece en un caso que funcione sobre PayPal real.

## B. Sandbox evaluation: responder a una disputa real del sandbox

1. Abre **el enlace de revisor del formulario de entrega**. Escribe tu nombre y pulsa **Create a passkey and join** o
   **Join for this browser only**.
2. La barra de la aplicación dice *Sandbox evaluation · Test Store · PayPal sandbox*; la bandeja de entrada muestra
   solo los casos vinculados a disputas del sandbox. Cualquier otro id de caso se abre en la Explore demo.
3. Abre **PP-R-TVH-10190665**. La barra de la aplicación muestra **PayPal sandbox · live** con el id de la disputa
   vinculada ("live" = una lectura en directo de una disputa del sandbox). El importe, la fase, el estado, la fecha límite
   y la transacción disputada de la cabecera proceden de esa lectura; los documentos son los documentos sintéticos del
   caso.
4. Comprueba que el caso sigue abierto a evidencia: si el botón dice **Evidence recorded by PayPal**, esta disputa ya
   se respondió. Ver [qué hacer](review-guide.md#si-una-disputa-ya-se-usó-la-reserva-está-vacía-o-se-alcanzó-un-límite).
5. Haz los pasos 4–8 del itinerario A. **Rephrase to what the evidence shows** en una frase **Needs review** aplica la
   reescritura del verificador y la comprueba en directo. **Re-run with AI** ejecuta todo el análisis en directo (30–60 s).
6. **Review what will be sent →**: ahora *Composed by the ResolveKit server · intent … · content sha256 …*. El servidor
   lo construyó a partir de su propia copia de los documentos y de su propio análisis; tu navegador solo envió tus
   elecciones.
7. **Continue to confirm →**. El paso dice *This sends test documents to a PayPal sandbox dispute. No real money
   moves.* Marca la aprobación (te nombra a ti, tu rol y *Test Store*) y después **Submit evidence to PayPal**.
8. Progreso: *Approved by …*, *Sending evidence to PayPal*, *Sent. Waiting for PayPal to confirm*, *Re-reading the
   dispute from PayPal*, y después **Recorded by PayPal** con la tabla *Field / Sent / Recorded by PayPal / Match*. Si
   PayPal muestra algo que no coincide, la página lo dice (*New seller evidence that doesn't match what we sent*); si
   no hay nada nuevo registrado, dice *no new evidence from you is recorded*.
9. **Audit log** lista la aprobación (con tu nombre y el hash del contenido) y el envío (PayPal-Request-Id y la
   respuesta de PayPal). Editar una frase después de aprobar anula la aprobación.

## C. Añadir y sanear tu propia evidencia

1. En un caso de Test Store pulsa **+ Add evidence**. El panel dice *It is read on this server only…*.
2. Elige un archivo en *A screenshot (PNG or JPEG, up to 5 MiB) or a PDF (up to 10 MiB and 30 pages)*, o pega en **Or
   paste text (an email thread, a chat)**, ponle un nombre y pulsa **Add pasted text**.
3. **Imagen**: *Drag over what must not be shared*, después **Read again from the covered image**. El panel de texto
   cambia a *Text read from the covered file*. Corrige una línea si la lectura se equivocó.
4. **Texto pegado**: bajo *Select what must not be shared*, selecciona pasajes; **Remove and read again**. Los pasajes
   eliminados pasan a ser “[redacted]”.
5. **PDF**: hasta 5 páginas se toman enteras; para uno más largo, marca hasta 5 miniaturas y pulsa **Add N pages**.
   Para cada página: arrastra tapados, **Cover this page and read it again** (también cuando no haya nada que tapar),
   corrige líneas, añade *Lines you transcribe* para el texto que la lectura no captó (marca la zona fuera de cualquier
   tapado). **Show it for this page** muestra el texto propio del PDF como pista, nunca se guarda. La página avisa:
   *Covering the text next to a barcode or QR code doesn't hide what the code contains. Cover the code too if it
   carries data you don't want to share.*
6. **Confirm as evidence** (o **Discard**). La subida se convierte en el siguiente número de evidencia (E7…). Pulsa
   **Re-run with AI** para que el análisis la lea.
7. Si una frase respaldada se apoya en una línea que corregiste o transcribiste, espera a **Confirm it reads …
   correctly** o **Confirm … is what the file shows (transcribed manually by …)**.
8. En la revisión, *Attachments to send* lista tus subidas confirmadas. PayPal recibe `E7-upload.png`
   (`E7-upload.jpg` si es una foto tapada), `E7-upload.pdf` o `E7-pasted.pdf`, nunca el nombre de tu archivo.

## D. El agente comprador

1. Desde la bandeja de entrada pulsa **Try the buying agent** (o abre `/agent`). Título: **Buying agent**.
2. En **New run**: **Goal** (elige uno de los *Examples*, p. ej. *Get the current quote for ACME-42 and a short report
   on its supplier risk, spending as little as possible.*), **Budget cap (USD, 0.50 to 5.00)** (por defecto 2.00) y,
   opcionalmente, *Simulate an outage: the first call to Deep report fails (marked as injected)*. Pulsa **Start the
   run**.
3. La ejecución muestra *Running*, después *Waiting for approval in PayPal* con *The agent wants to spend up to … USD.*
   Pulsa **Approve in PayPal**, inicia sesión con la cuenta buyer del sandbox del formulario de entrega y aprueba.
   Vuelves a `/agent?run=…`.
4. **Steps**: cada llamada a herramienta con su precio y *OK, charged* o *FAILED, not charged*, el resumen del
   resultado y el motivo breve declarado por el modelo (no su razonamiento interno). Un fallo inyectado se marca como
   inyectado.
5. **Answer** y la etiqueta del resultado: *Done*, *The tools cannot meet this goal*, *Out of budget*, *Stopped: …*,
   *Interrupted (stopped or server restart)*, *Model unavailable*, *Not approved in PayPal*.
6. **Budget and receipt**: *Captured … USD · … released* (o *Voided: nothing charged*, *Capture pending at PayPal (not
   final)*, *Not verified yet*), siempre a partir del recibo de MeterMCP. Debajo, la línea de uso del modelo, aparte
   del presupuesto.
7. **Your runs**: marca dos y pulsa **Compare** (*Two runs side by side*). **Stop** termina una ejecución en curso.
   **Keep** (solo el propietario) exime una ejecución del borrado a los 30 días.

## E. El caso de compra por agente

1. Abre **PP-R-MMC-10190702** en Test Store: un comprador disputa un pago que un agente hizo a través de MeterMCP.
2. El mandato, el recibo por llamada (AG Grid) y la liquidación están etiquetados *From MeterMCP · session …*. A fecha
   de 29/10/2026, la sesión vinculada es una hecha por el cliente con guion (scripted) anterior, no por una ejecución dirigida
   por el modelo; un registro de ejecución (*E5 Agent run record*, *From ResolveKit · run …*) aparece solo cuando la
   vinculación del caso nombra esa ejecución (Pendiente).
3. *How this goes to PayPal as digital delivery*: `PROOF_OF_FULFILLMENT`, transportista `OTHER`, el id de sesión como
   referencia, el PDF del recibo adjunto. Enviarlo sigue el itinerario B (envío del caso del agente a PayPal:
   Pendiente, sin evidencia registrada).
4. En la Explore demo, el mismo id de caso abre el ejemplo sintético (cuatro llamadas, un fallo no cobrado, 1.37 de
   5.00 USD), etiquetado *Demo data*.

## F. Opcional: MeterMCP desde tu propio cliente MCP

1. Conecta un cliente MCP de Streamable HTTP (por ejemplo MCP Inspector) al endpoint `/mcp` de MeterMCP
   (`https://resolvekit-metermcp.onrender.com/mcp`) con la cabecera HTTP `x-demo-code` con el valor del código de demo
   del formulario de entrega.
2. `price_list` y `get_balance` funcionan sin el código. Llama a `quote_lookup`: responde `payment_required` con una
   `approval_url`. Aprueba con la cuenta buyer del sandbox.
3. `get_balance` (estado `active`), después las herramientas de pago, después `close_session`: solo se capturan las
   llamadas que salieron bien. `get_receipt` lista cada llamada con el hash de su petición. Sin la cabecera, una
   herramienta de pago responde `demo_code_required`.

Estado: Implementado · Probado en local · Desplegado; una ejecución desde un cliente externo contra el endpoint alojado
no tiene evidencia registrada (Pendiente). Referencia: [herramientas MCP](../technical/mcp-tools.md).

## G. Opcional: la pantalla de espera del comerciante

**Sign in** → **Continue with PayPal** con cualquier cuenta del sandbox de PayPal distinta de la de Test Store.
Apruebas una solicitud sin cargo (*No money moves and no agreement is created.*) y llegas a *You're signed in with
PayPal. Access to your disputes isn't available yet.* con **Explore demo**. Este es el estado real: la conexión de
comerciantes está Pendiente.
