[English](../../user-guide/review-and-submit.md) | [Español](review-and-submit.md)

# Revisar y enviar

Enviar evidencia a una disputa de PayPal no se puede deshacer. Por eso ResolveKit solo te deja enviar contenido que el
**servidor** compuso a partir de su propia copia de los documentos y del análisis, que **tú** aprobaste exactamente y
que sigue siendo el mismo en una lectura nueva de PayPal en el momento del envío. Después relee la disputa e informa de
lo que registró PayPal.

Estado de la evidencia: Implementado · Probado en local · Verificado en sandbox (envíos de dos revisores registrados
por PayPal, 17/10/2026; una subida de imagen, 18/10/2026) · Desplegado. Las demás acciones de disputa (mensaje,
aceptación, oferta, escalado) están **Verificadas en sandbox** a través de la app (20/10/2026); el código está desplegado, pero estas acciones aún no se han ejercitado en el servicio alojado: ver [Otras acciones de disputa](#otras-acciones-de-disputa)
y [Limitaciones](../product/limitations.md).

Hay tres cosas distintas y la app las mantiene separadas: **el envío fue aceptado** (PayPal respondió al envío), **la
evidencia quedó registrada** (aparece en la disputa de PayPal al releer) y **la resolución de la disputa** (PayPal
decide más tarde).

## Antes de empezar

**Review what will be sent →** sigue desactivado mientras quede algo abierto. La barra de encima lista lo que falta,
por ejemplo: «sentence 3 needs review», «the address contradiction is open», «PayPal does not allow this action right
now», «PayPal won't accept "<type>" here», «"Proof of refund" is not available: Not verified with PayPal: pending
sandbox test (W-11)», «the case file lacks what "<type>" needs», «the notes exceed ResolveKit's 2,000-character limit» (un tope propio de ResolveKit;
no encontramos documentación de PayPal sobre un límite de notas), «evidence was already submitted to PayPal». Cuando no queda nada: «All claims are supported or removed. You review everything
before it is sent.»

- Elige el **Evidence type** («PayPal is asking for: …» muestra lo que pidió PayPal; un tipo que PayPal no aceptará
  para este motivo se rechaza).
- Una frase que se apoya en una línea que corregiste o transcribiste muestra un botón como «Confirm it reads line 2 of
  E7 correctly» o «Confirm line 4 of page 8 of E7 is what the file shows (transcribed manually by <name>)». La
  confirmación forma parte de lo que apruebas.
- Debes tener la sesión iniciada en el espacio del vendedor (en la Explore demo el flujo funciona sobre el simulador).

## Paso 1 · Revisar

Elige **Review what will be sent →**. «The ResolveKit server is composing exactly what will be sent, from its own copy
of the documents and the analysis…», y después la revisión muestra:

- «Composed by the ResolveKit server» (en la demo: «Composed in this browser (simulator only)»).
- **Exactly what goes to PayPal**: la acción (Provide evidence · <type>), el transportista y el seguimiento o la
  referencia, «Notes text, as PayPal will receive it», y los archivos.
- **Claims to be sent**: cada frase con respaldo junto a su prueba, «Quoted from the source».
- «Not sent · removed by the analyst»: las frases eliminadas.
- **Attachments**: los documentos del caso y tus subidas confirmadas como casillas. «Your uploads go to PayPal as the
  covered files you confirmed; changing this list composes the response again.»
- «Nothing has been sent. Next you confirm.»

Si el servidor se niega a componer, la ventana dice «Nothing can be sent yet» (o «Only the seller's workspace can send
this») con los motivos; **← Back to edit** o **Try again**.

## Paso 2 · Confirmar

**Continue to confirm →** muestra un resumen (Action, Notes «N supported sentences · N characters», Files, Not sent),
«This can't be undone», y en la evaluación en sandbox: «This sends test documents to a PayPal sandbox dispute. No real
money moves.»

Marca «I'm <your name> (<role>, <workspace>) and I approve submitting this evidence for the <dispute>.» y elige
**Submit evidence to PayPal**.

Qué ocurre en el servidor, por orden:
1. Se registra tu aprobación de ese contenido exacto con su hash de contenido («Approved intent … · content sha256 …»).
   Si esto falla: «The approval was not recorded, so nothing was sent».
2. El servidor vuelve a leer la disputa en PayPal, comprueba que sigue siendo el pago de este caso y que eres el espacio
   del vendedor, vuelve a componer el contenido y lo compara. Cualquier diferencia hace que se rechace el envío.
3. El inicio del envío se escribe en disco; si no se puede, no se envía nada (`AUDIT_UNAVAILABLE`).
4. `provide-evidence` se envía una sola vez, con un único id de petición.

Una aprobación deja de valer si editas una frase, vuelves a componer, cambia la vinculación del caso o pasan 30
minutos.

## Paso 3 · Enviar y releer

Progreso: «Approved by <name> · <time> UTC» → «Sending evidence to PayPal» → «Sent. Waiting for PayPal to confirm» →
«Re-reading the dispute from PayPal». «Live PayPal sandbox: we only show "Recorded" after reading the dispute back from
PayPal.»

| Resultado | Qué significa |
|---|---|
| **Recorded by PayPal** | PayPal muestra nueva evidencia del vendedor que antes no estaba y que coincide con lo enviado (tipo de evidencia, notas, transportista y seguimiento, nombres de archivo). «Sent versus recorded» muestra cada campo con **Sent**, **Recorded**, **Match**; «Read back from PayPal sandbox (dispute …) at … This is what PayPal stored, not what we expect it stored.» |
| «New seller evidence that doesn't match what we sent» | Otra persona u otra cosa registró evidencia. Nunca se presenta como tuya y no se reintenta nada automáticamente |
| **Submission not confirmed** · «PayPal didn't confirm the submission» | PayPal lo rechazó, o la relectura no muestra nada registrado. **Try again**: «We read the dispute back before any retry. Evidence is only re-sent if PayPal shows none recorded.» Un envío fallido puede reintentarse durante 30 minutos con la misma aprobación |
| «The request timed out.» | Ni éxito ni fracaso: ResolveKit relee primero. Si PayPal no muestra nada: «PayPal showed nothing recorded, so the evidence was sent once more.» (Probado con dobles; no observado contra PayPal) |
| «Your evidence was not sent» | El servidor la retuvo (`DISPUTE_UNCERTAIN`): un envío anterior en esta disputa (tuyo, o de un compañero) aún no está confirmado por PayPal, y nada de tu evidencia llegó a PayPal. En un reintento tras un intento anterior que pudo llegar a PayPal (su respuesta se perdió: un timeout, sin respuesta, un error del servidor), dice «This attempt was held back», y la evidencia nueva del vendedor se sigue comparando con lo que enviaste, frente a la disputa leída antes de tu primer intento. La ventana muestra el mismo aviso que la página del caso, con **Check again** sobre ese envío anterior (solo una relectura). Cuando nada retiene la disputa, **Send it now** vuelve a leer la disputa y envía tu evidencia con todas las comprobaciones del servidor: si el envío anterior dejó evidencia del vendedor en la disputa, la tuya se rechaza (`SELLER_EVIDENCE_EXISTS`), y esa evidencia nunca se muestra como tuya. Si el servidor no puede decir qué retiene la disputa, la ventana muestra el error con **Try again**, que vuelve a preguntar y nunca envía (Probado en local; no observado contra PayPal) |

Tras el registro, «Actions PayPal allows now» explica qué cambió, por ejemplo «Removed by PayPal: evidence already
submitted» o «Not offered while PayPal reviews». El caso pasa a **Evidence recorded by PayPal**, «Sent · read-only»;
la cronología y el registro de auditoría (quién aprobó, cuándo, el hash del contenido, la respuesta de PayPal) muestran
el envío.

En nuestras pruebas en sandbox PayPal dejó de ofrecer `provide_evidence` tras un envío (una observación, no una regla
documentada). En la evaluación en sandbox, un caso usado pasa a la siguiente disputa de su reserva unos 15 minutos
después, en su siguiente lectura, **solo si** queda alguna (a 19/10/2026 el caso estándar no tiene ninguna).

## Otras acciones de disputa

Estado: **Probado en local** (con fakes construidos a partir de respuestas registradas de PayPal) · **Verificado en
sandbox** a través de la app (20/10/2026, un envío cada una en un servidor local; salvo el mensaje con archivo). El
código está Desplegado (`5111b88`, 20/10/2026), pero estas acciones aún no se han ejercitado en el servicio alojado;
las solo del Owner necesitan el caso de liquidación vinculado en el `BINDINGS_JSON` alojado, cosa que aún no ocurre, y
los revisores pueden enviar mensajes en la disputa activa de un caso vinculado. Estado y reglas por variante:
[Especificación funcional](../product/functional-specification.md#56-acciones-de-disputa-distintas-de-la-evidencia).

Elige la acción en **What to do**. Solo se puede componer lo que PayPal ofrece ahora mismo en la disputa, y cada
variante muestra su estado («Verified in sandbox», «Tested locally», o «Not available: <motivo>»).

| Acción | Quién | Qué escribes | Qué hace PayPal |
|---|---|---|---|
| Send message | Owner, miembros, revisores | **Message to the buyer** (hasta 2,000 caracteres). «The buyer sees exactly this text in PayPal.» Opcionalmente, en **Attach a file (optional, at most one)**, una de las subidas confirmadas del caso, listadas por número de evidencia y título («Message with a file · Tested locally») | Añade el mensaje, con el archivo si elegiste uno, al hilo. No fusiona repeticiones |
| Accept claim · full refund | Owner | **Note to PayPal** | «PayPal refunds <amount> to the buyer and closes the dispute in the buyer’s favour. This cannot be undone.» (reembolsa al comprador y cierra la disputa a su favor; no se puede deshacer) |
| Accept claim · partial refund offer | Owner | Importe y **Note to PayPal** | «PayPal offers the buyer a partial refund of <amount>. The buyer has to agree to it: unless they accept, no money moves and the dispute stays open.» (el comprador debe aceptarlo; si no, no se mueve dinero y la disputa sigue abierta) |
| Make offer · refund offer | Owner | Importe (menor que el de la disputa) y **Note to PayPal** | «The buyer is offered <amount>; no money moves unless the buyer accepts.» |
| Escalate | Owner | **Note to PayPal** | «The inquiry becomes a claim decided by PayPal. Inquiry actions end; what you can do next is what PayPal offers on the claim.» (la consulta pasa a reclamación que decide PayPal) |

Los miembros y los revisores ven las acciones solo del Owner como vista previa con su consecuencia; no pueden
componerlas ni enviarlas.

Pasos: **Review the message →** (o **Review the accept →**, **Review the offer →**, **Review the escalation →**) pide
al servidor que componga exactamente lo que se enviará; la revisión lo cita. **Approve and send** registra tu
aprobación de ese contenido. En una acción solo del Owner, **Confirm before sending** muestra después la consecuencia y
el importe, ligados a ese intent; **Confirm and send** la envía. Un mensaje que repite otro que PayPal ya muestra en la
disputa pide la misma confirmación («PayPal already shows this exact message on this dispute…»).

**Un mensaje con archivo.** Solo se ofrecen subidas confirmadas del caso (aquí no se sube nada nuevo: añade la evidencia
antes), una como máximo; «No confirmed upload of this case to attach» si no hay ninguna. La revisión y la confirmación
lo muestran tal como lo recibe PayPal, «Attached file: E8-pasted.pdf · 2 KB · E8 <título>, uploaded by <nombre>». El
servidor solo lo adjunta si sigue siendo una subida confirmada de la disputa activa del caso en tu espacio de trabajo (si
no, `UNKNOWN_UPLOAD`). «Recorded by PayPal» prueba el texto del mensaje; el archivo en sí no se comprueba. Esta variante
está Probada en local: no se ha enviado a PayPal a través de la app. Sin el servidor de ResolveKit dice «Not available:
attaching a file needs the ResolveKit server». Solo se ofrece mientras PayPal espera al comprador, el estado desde el
que se envió la escritura registrada; mientras PayPal te espera a ti dice «Not available: not verified with PayPal from
this dispute status», y el mensaje de texto solo se sigue ofreciendo. En el simulador, un estado desde el que no se
registró la escritura del sandbox dice «Not available: the simulator plays this only from a state PayPal’s sandbox
recorded it from».

Si el comprador escribió después de que aprobaras un mensaje, una aceptación o una oferta, la ventana dice «The buyer
wrote since you approved this» y muestra el mensaje nuevo: **Send it anyway** envía el mismo contenido, **Edit**
compone uno nuevo.

| Resultado | Qué significa |
|---|---|
| **Recorded by PayPal** (con «claim accepted», «offer waiting for the buyer» o «inquiry escalated») | Una lectura fresca muestra la entrada que hizo este envío |
| **Outcome pending confirmation** | PayPal aún no ha mostrado prueba en ningún sentido. La disputa queda retenida: no se puede enviar nada más en ella hasta que **Check again** (solo una relectura, nunca un envío) lo resuelva. Si otro envío retiene la disputa (uno tuyo anterior, o de un compañero), el tuyo no se envió, y **Check again** relee *ese* envío; cuando queda resuelto, **Send it now** envía el tuyo repitiendo todas las comprobaciones |
| Not recorded by PayPal | PayPal no muestra rastro del envío y sigue ofreciendo la acción |
| Not sent | PayPal lo rechazó; no se hizo nada |

**Una disputa retenida tras recargar.** La página del caso pregunta al servidor qué retiene su disputa: si un envío
sigue sin probar, muestra «Outcome pending confirmation» con ese envío (el tuyo, o «an earlier send by someone in your
workspace») y **Check again** sobre él. Cualquiera del espacio de trabajo del vendedor (Owner, miembros, revisores)
puede pulsarlo; solo lee PayPal. Registrado, o probado ausente mientras PayPal sigue ofreciendo la acción, libera la
disputa. Si el aviso dice que el servidor ya no tiene el contenido aprobado de ese envío, una relectura no puede
resolverlo: avisa al operador (ver el [Runbook](../operations/runbook.md)).

Cada acción solo se ofrece desde el estado de la disputa desde el que se envió su escritura registrada en el sandbox:
aceptar, ofertar y escalar solo mientras PayPal espera tu respuesta (`WAITING_FOR_SELLER_RESPONSE`); un mensaje también
mientras PayPal espera al comprador; un mensaje con archivo solo mientras PayPal espera al comprador
(`WAITING_FOR_BUYER_RESPONSE`). Desde cualquier otro estado la acción dice «Not available: not verified with PayPal
from this dispute status».

Tras un escalado, el caso muestra «PayPal is reviewing; the claim stage can take a few minutes» hasta que se abre la
reclamación. Nada se reintenta automáticamente. La evidencia de prueba de reembolso no está disponible en esta entrega;
si PayPal solo pide esa, no se puede enviar evidencia en esa disputa.

## Qué se comparte y con quién

| Destinatario | Qué | Cuándo |
|---|---|---|
| Proveedor del modelo de IA (Gemini, o Groq como respaldo) | Los documentos del caso tal como los monta el servidor (documentos sintéticos del caso, campos leídos de la disputa de PayPal y, para el caso de agente, el recibo de MeterMCP), el texto de tus subidas confirmadas; las frases editadas para las recomprobaciones | En cada análisis en directo y recomprobación |
| PayPal (sandbox), otras acciones | El texto exacto del mensaje (y la subida tapada que le adjuntaste, con nombre como los archivos de evidencia), o el tipo, el importe y la nota de una aceptación, oferta o escalado | Solo cuando se envía la acción |
| PayPal (sandbox) | Tipo de evidencia; notas (solo frases con respaldo); transportista y seguimiento o referencia; PDF construidos en el servidor a partir de los documentos del caso (encabezados con «SYNTHETIC TEST DOCUMENT»); para el caso de agente, el PDF del recibo; las subidas tapadas que adjuntaste, con los nombres `E<n>-upload.png` (`.jpg` si es una foto tapada), `E<n>-upload.pdf`, `E<n>-pasted.pdf` | Solo al pulsar **Submit evidence to PayPal** |
| La auditoría del servidor de ResolveKit | Quién aprobó, cuándo, hash del contenido, id de petición, respuesta de PayPal; ningún texto de documentos; un mensaje solo por su hash | Al aprobar y al enviar |
| Los intents del servidor de ResolveKit | El texto aprobado del mensaje, como las notas de evidencia aprobadas (el hilo en sí no se guarda ni se entrega a la IA) | Mientras se conserve el registro del intent |

Tus credenciales de PayPal y las del servidor nunca llegan al navegador.

## Qué se puede deshacer

Nada de lo que llegó a PayPal. **PayPal conserva la evidencia enviada**; borrar después una subida en ResolveKit no la
elimina de PayPal. Antes de enviar, puedes cerrar la ventana, editar o dejar que caduque la aprobación. Los proveedores
de modelos conservan lo que recibieron según sus propias políticas.

## Errores durante el envío

| Código / mensaje | Qué hacer |
|---|---|
| `INTENT_STALE` «What would be sent now differs from what you approved…» | Revisa de nuevo y aprueba el nuevo contenido |
| `UPLOAD_CHANGED`, `DOCUMENTS_CHANGED`, `BINDING_CHANGED` | Algo cambió desde que aprobaste: revisa de nuevo |
| `SELLER_EVIDENCE_EXISTS` «PayPal already has seller evidence for this dispute; nothing more can be sent» | Lee la evidencia registrada |
| `DISPUTE_BUSY` | Hay otro envío en curso para esta disputa: espera y después relee |
| `NOT_THE_SELLER` | Solo el espacio del vendedor puede responder |
| `DAILY_CAP` | Se han agotado los envíos de evidencia (o de mensajes, o las acciones de liquidación) de la demo por hoy; el mensaje dice cuándo se restablecen |
| `OWNER_ONLY` | Solo el Owner puede aceptar, ofertar o escalar |
| `DISPUTE_UNCERTAIN` | Un envío anterior a esta disputa (nombrado en la respuesta) aún no está confirmado, y el tuyo no se envió: **Check again** relee ese envío; cuando queda resuelto, **Send it now**. La ventana de evidencia muestra el mismo aviso integrado. Tras recargar, la página del caso muestra la misma retención con **Check again** |
| `VARIANT_NOT_AVAILABLE` «Not available: not verified with PayPal from this dispute status» | La acción nunca se registró desde el estado actual de la disputa: espera a que cambie el estado en PayPal, o usa otra acción |
| `NEEDS_REVIEW` | El comprador escribió después de tu aprobación: léelo y después envía el mismo contenido o edítalo |
| «The PayPal connection changed while you were reviewing. Close this and open the case again.» | Cierra y vuelve a abrir el caso |

Más en [Solución de problemas](troubleshooting.md). Cómo se hace cumplir: [Fronteras de confianza](../architecture/trust-boundaries.md).
