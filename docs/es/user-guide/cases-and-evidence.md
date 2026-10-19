[English](../../user-guide/cases-and-evidence.md) | [Español](cases-and-evidence.md)

# Casos y evidencias

Cómo leer un expediente, qué significa cada etiqueta y cómo añadir tu propia evidencia (capturas y texto pegado; los
PDF tienen su propia página: [Revisión de PDF](pdf-review.md)).

## El expediente de un vistazo

| Zona | Qué muestra |
|---|---|
| Barra de la app | **Cases** / id del caso, el entorno, **PayPal sandbox · live** + id de disputa (una lectura en directo de una disputa del sandbox) o **Simulated PayPal**, el estado de sincronización («Synced with PayPal · last checked …», «Couldn't reach PayPal. Showing saved data.») |
| Cabecera | Importe y motivo, «Buyer declared: <item type>» (lo que eligió el comprador al abrir la disputa), **Stage**, **PayPal status** con cuándo se leyó, **Respond by**, **Disputed transaction** |
| Barra de análisis | Los pasos del analista, quién hizo el análisis y si está **cached** o es **live**, **Replay analysis** (sin llamada al modelo), **Re-run with AI** |
| Cronología | Todos los eventos de los documentos, en orden; las contradicciones aparecen en ella como tarjetas |
| Evidence | Una tarjeta por documento (E1, E2…), con su procedencia, su hash y los fragmentos citados resaltados al pasar el ratón por una cita |
| Borrador de respuesta | «Drafted by the analyst · you approve»: **What to do**, el tipo de evidencia, las frases, **Notes sent to PayPal**, **Attachments to send**, **Review what will be sent →** |

Un caso vinculado toma de PayPal todos los campos de PayPal (importe, motivo, estado, evidencia solicitada, fecha
límite). Si la vinculación no coincide con el pedido de la demo, la cabecera muestra **Demo binding mismatch** y el
motivo.

## Procedencia: de dónde viene cada documento

| Etiqueta en la tarjeta | Significado |
|---|---|
| «From PayPal · …» | El registro de PayPal del pago disputado, tal como se lee de PayPal |
| «PayPal · not read yet» | Un caso vinculado cuya lectura de PayPal no ha llegado; nunca se rellena con datos de demo |
| «From MeterMCP · session …» | El mandato, el recibo y la liquidación del caso de agente, del ledger (libro contable) real de MeterMCP |
| «From ResolveKit · run …» | El registro de ejecución del agente, mostrado solo cuando la vinculación del caso nombra esa ejecución (la versión del propio agente, no una prueba) |
| «Uploaded by <name>» | Evidencia que añadió una persona del espacio de trabajo |
| «Synthetic demo document» / «Demo data» | Datos de caso inventados |

Una línea que has corregido se marca como «corrected by <name>»; una línea escrita a mano en una página de un PDF se
marca como «Transcribed manually by <name>». Pasa el ratón sobre un valor para verlo en su documento. «used in 2
claims» / «not used in any claim» indica cómo usa el borrador el documento.

## El análisis

- La etiqueta dice quién lo hizo, p. ej. `<model> · cached` o `· live`; pasa el ratón por encima para ver la versión
  del prompt, las llamadas al modelo y los tokens. «golden analysis committed with the code» significa una salida real
  del modelo guardada que se distribuye con la app.
- **Re-run with AI** vuelve a ejecutar el analista en el servidor (puede tardar alrededor de un minuto). Se rechaza con
  un motivo: «Sign in required», «Seller workspace only», «Live-run limit reached (6/hour); next in N min», «No model
  key …».
- Cada frase es **Supported**, **Needs review** (con su motivo) o **Removed: no supporting evidence** (tachada, nunca
  se envía). Pasa el ratón por una cita para resaltar las palabras exactas.
- **Edit** en una frase (hasta 600 caracteres, una línea) y **Save and re-check**: el modelo del servidor vuelve a
  elegir sus citas y la juzga. Si no se puede volver a comprobar, se queda en **Needs review**.
- Donde se ofrece, **Rephrase to what the evidence shows** aplica la reescritura del analista y la vuelve a comprobar.
- La lista de comprobación marca lo que necesita el tipo de evidencia de PayPal: **Present**, **Missing**,
  **Contradicts**, **Resolved**.

## Contradicciones

Cuando dos documentos no coinciden (por ejemplo, una dirección en la etiqueta y en el registro del transportista), la
cronología muestra una tarjeta **Contradiction** con ambos valores lado a lado, de forma neutral, marcada como
**Needs review**. La aprobación queda bloqueada hasta que elijas:

- **Explain in response**: la frase neutral del analista, que indica ambos valores y sus fuentes, pasa al borrador. La
  tarjeta dice entonces «Explained in sentence N of the response.»
- **Mark resolved…**: escribe una «Note (saved to the audit log)» y pulsa **Resolve with note**.

## Qué hacer (las acciones de PayPal)

El cuadro **What to do** muestra las acciones que PayPal permite ahora para esta disputa, leídas hace unos segundos,
cada una con «✓ allowed». Desde ResolveKit solo se puede enviar **Provide evidence**. Elegir cualquier otra acción (por
ejemplo «Send message» o «Accept claim») solo muestra «only "Provide evidence" can be sent from this screen for now»;
no se envía nada a PayPal. «PayPal is asking for:» muestra la evidencia que ha pedido PayPal.

## Añadir tu propia evidencia

Disponible en la evaluación en sandbox y en modo local con el servidor; desactivado en la Explore demo. Cualquiera con
sesión iniciada en el espacio del vendedor puede añadir evidencia.

1. En **Evidence**, elige **+ Add evidence**. El panel dice: «It is read on this server only. Nothing of it is used,
   sent to an AI model or to PayPal until you have covered what must not be shared and confirmed it.»
2. Elige un archivo («A screenshot (PNG or JPEG, up to 5 MiB) or a PDF (up to 10 MiB and 30 pages)»), o pega texto en
   «Or paste text (an email thread, a chat)», dale un nombre (p. ej. «buyer email 9 Oct») y pulsa **Add pasted text**.
   Un PDF continúa en [Revisión de PDF](pdf-review.md).
3. Se abre la ventana **Review new evidence** sobre el original. Todavía no se usa nada.
4. Tapa lo que no debe compartirse:
   - Imagen: arrastra rectángulos por encima (números de cuenta, direcciones…); **×** quita un tapado.
   - Texto pegado: en «Select what must not be shared», selecciona fragmentos; se convierten en «[redacted]» en el PDF
     que se guarda y se envía.
5. Elige **Read again from the covered image** (texto: **Remove and read again**), aunque no haya nada que tapar. El
   servidor ennegrece los tapados en un archivo nuevo y vuelve a leer ese archivo desde cero, así que lo que había bajo
   un tapado nunca llega al analista ni a PayPal. Alterna entre **Your covers** y **Covered file** («what is stored and
   sent»).
6. Revisa «Text read from the covered file». Corrige cualquier línea que la lectura haya entendido mal; queda marcada
   con quién la corrigió, y **Undo** restaura lo leído.
7. **Confirm as evidence**. La subida pasa a ser el siguiente número de evidencia (E7, E8…) tras los documentos del
   caso. O **Discard**.
8. El expediente dice «Analysis pending: it does not include E7 yet … The draft is not based on it.» Pulsa
   **Re-run with AI**: el nuevo análisis puede citarla como cualquier documento.

### Estados que verás

| En pantalla | Significado | Quién puede actuar |
|---|---|---|
| «New · pending» · «Not used yet: review it first» · **Review** · **Discard** | Subida, aún sin confirmar | Quien la subió, el Owner y los Members |
| «pending · <name> · uploaded by <person>» | Una subida pendiente de otra persona que no puedes abrir | — |
| Tarjeta de evidencia «Uploaded by <name>» con **Delete** | Evidencia confirmada | Owner y Members (no Reviewers) |

Una subida que no se confirma en 24 horas se descarta sola. Hasta que se confirma, sus archivos y su texto solo se
muestran a quienes pueden editarla.

## Qué se comparte y con quién

| Destinatario | Qué recibe | Cuándo |
|---|---|---|
| El servidor de ResolveKit | El archivo original, mientras está pendiente o en revisión; después, solo el archivo tapado (saneado) y su texto | Al subirlo |
| El proveedor del modelo de IA (Google Gemini o Groq) | El texto de la evidencia confirmada (leído del archivo tapado, con tus correcciones y quién las hizo), con su número de evidencia, un título genérico («Uploaded screenshot», «Pasted text», «Uploaded PDF») y «Uploaded by <name>». Nunca el nombre del archivo, nunca el original | En el siguiente análisis que la incluya, y en las recomprobaciones |
| PayPal (sandbox) | El archivo tapado que adjuntas, nombrado solo con su número de evidencia: `E7-upload.png` (imagen), `E8-upload.pdf` (PDF), `E9-pasted.pdf` (texto pegado) | Solo cuando envías una respuesta que lo adjunta |

El texto se lee en el servidor (OCR local), no lo lee un proveedor de modelos ni PayPal. No subas datos personales que
te importen: el lado de PayPal es un sandbox y la app es una demo.

## Borrar y lo que queda

| Acción | Efecto | Qué queda |
|---|---|---|
| **Discard** (antes de confirmar) o la caducidad de 24 h | Se eliminan los archivos y el texto | Un registro (nombre, quién, cuándo, estado) para la auditoría |
| **Delete** (confirmada; Owner o Member) | Se eliminan los archivos y el texto; también se borran los análisis que la leyeron; se anulan las respuestas no enviadas que la usan. Se rechaza mientras hay en curso un envío que la usa | El registro |
| El caso pasa a su siguiente disputa de sandbox | Se archivan las subidas de la disputa anterior | El registro |
| Ya enviada a PayPal | No le afecta ningún borrado en ResolveKit | **PayPal conserva la evidencia enviada** |
| Enviada a un proveedor de modelos | No le afecta ningún borrado en ResolveKit | La retención se rige por la política de ese proveedor |

## Errores

| Mensaje (extracto) | Qué hacer |
|---|---|
| «Files up to 5 MiB» / «The image is larger than 4096 px on a side or 8,294,400 pixels» | Usa una captura más pequeña |
| «The text has "€" …only Latin-1 characters…» | Sustituye el carácter (p. ej. € por EUR, las comillas tipográficas por rectas) |
| «Pasted text up to 20000 characters» | Acórtalo |
| «A case takes at most 10 uploads; discard or delete one first» | Descarta o borra una |
| «An upload can be redacted 5 times; discard it and upload it again» | Descártala y empieza de nuevo |
| Archivo saneado demasiado grande | Sube una captura o una imagen más pequeña (las imágenes tapadas se guardan como PNG) |
| «A reviewer edits only their own uploads» | Pídeselo a quien la subió, al Owner o a un Member |
| «The case moved to another PayPal dispute since this was uploaded…» | Vuelve a subirla para la disputa actual |
| «The demo has no room for more uploads right now» | Inténtalo más tarde |

Más en [Solución de problemas](troubleshooting.md).
