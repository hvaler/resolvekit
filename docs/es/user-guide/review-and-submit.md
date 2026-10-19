[English](../../user-guide/review-and-submit.md) | [Español](review-and-submit.md)

# Revisar y enviar

Enviar evidencia a una disputa de PayPal no se puede deshacer. Por eso ResolveKit solo te deja enviar contenido que el
**servidor** compuso a partir de su propia copia de los documentos y del análisis, que **tú** aprobaste exactamente y
que sigue siendo el mismo en una lectura nueva de PayPal en el momento del envío. Después relee la disputa e informa de
lo que registró PayPal.

Estado: Implementado · Probado en local · Verificado en sandbox (envíos de dos revisores registrados por PayPal,
17/10/2026; una subida de imagen, 18/10/2026) · Desplegado. Solo se envía **Provide evidence**; ver
[Limitaciones](../product/limitations.md).

Hay tres cosas distintas y la app las mantiene separadas: **el envío fue aceptado** (PayPal respondió al envío), **la
evidencia quedó registrada** (aparece en la disputa de PayPal al releer) y **la resolución de la disputa** (PayPal
decide más tarde).

## Antes de empezar

**Review what will be sent →** sigue desactivado mientras quede algo abierto. La barra de encima lista lo que falta,
por ejemplo: «sentence 3 needs review», «the address contradiction is open», «PayPal does not allow this action right
now», «only "Provide evidence" can be sent from this screen for now», «PayPal won't accept "<type>" here», «the case
file lacks what "<type>" needs», «the notes exceed ResolveKit's 2,000-character limit» (un tope propio de ResolveKit;
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

Tras el registro, «Actions PayPal allows now» explica qué cambió, por ejemplo «Removed by PayPal: evidence already
submitted» o «Not offered while PayPal reviews». El caso pasa a **Evidence recorded by PayPal**, «Sent · read-only»;
la cronología y el registro de auditoría (quién aprobó, cuándo, el hash del contenido, la respuesta de PayPal) muestran
el envío.

En nuestras pruebas en sandbox PayPal dejó de ofrecer `provide_evidence` tras un envío (una observación, no una regla
documentada). En la evaluación en sandbox, un caso usado pasa a la siguiente disputa de su reserva unos 15 minutos
después, en su siguiente lectura, **solo si** queda alguna (a 19/10/2026 el caso estándar no tiene ninguna).

## Qué se comparte y con quién

| Destinatario | Qué | Cuándo |
|---|---|---|
| Proveedor del modelo de IA (Gemini, o Groq como respaldo) | Los documentos del caso tal como los monta el servidor (documentos sintéticos del caso, campos leídos de la disputa de PayPal y, para el caso de agente, el recibo de MeterMCP), el texto de tus subidas confirmadas; las frases editadas para las recomprobaciones | En cada análisis en directo y recomprobación |
| PayPal (sandbox) | Tipo de evidencia; notas (solo frases con respaldo); transportista y seguimiento o referencia; PDF construidos en el servidor a partir de los documentos del caso (encabezados con «SYNTHETIC TEST DOCUMENT»); para el caso de agente, el PDF del recibo; las subidas tapadas que adjuntaste, con los nombres `E<n>-upload.png` (`.jpg` si es una foto tapada), `E<n>-upload.pdf`, `E<n>-pasted.pdf` | Solo al pulsar **Submit evidence to PayPal** |
| La auditoría del servidor de ResolveKit | Quién aprobó, cuándo, hash del contenido, id de petición, respuesta de PayPal; ningún texto de documentos | Al aprobar y al enviar |

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
| `DAILY_CAP` | Se han agotado los envíos de evidencia de la demo por hoy; el mensaje dice cuándo se restablecen |
| «The PayPal connection changed while you were reviewing. Close this and open the case again.» | Cierra y vuelve a abrir el caso |

Más en [Solución de problemas](troubleshooting.md). Cómo se hace cumplir: [Fronteras de confianza](../architecture/trust-boundaries.md).
