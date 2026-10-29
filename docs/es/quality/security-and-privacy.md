[English](../../quality/security-and-privacy.md) | [Español](security-and-privacy.md)

# Seguridad y privacidad

Los controles que implementa ResolveKit, cómo se prueban y los riesgos que quedan. Son medidas, no garantías. Para las
fronteras de confianza como diseño, consulta [Fronteras de confianza](../architecture/trust-boundaries.md); para informar
de una vulnerabilidad, consulta [SECURITY.es.md](../../../SECURITY.es.md).

Las palabras de estado siguen el vocabulario del proyecto. Salvo que una fila diga otra cosa: **Implementado · Probado
en local** (PayPal falso, modelo falso) en `c12faea`, desplegado en la demo del sandbox.

## Validez literal no es respaldo semántico

Dos comprobaciones distintas, que a menudo se confunden:

| Comprobación | Quién decide | Qué demuestra | Qué no demuestra |
|---|---|---|---|
| **Validez literal** de una cita | Código determinista (`isVerbatim`): la cita debe ser una subcadena exacta de su documento, normalizando solo los espacios en blanco | Que las palabras están realmente en ese documento | Que la afirmación construida sobre ellas sea cierta, o que el documento sea auténtico |
| **Respaldo semántico** de una frase | Una llamada a modelo aparte por frase, que recibe solo las citas de esa frase, y después reglas | Que el verificador consideró que las líneas citadas respaldan la frase | La verdad. Un modelo puede equivocarse; una frase cierta puede acabar en *needs review* (necesita revisión) |

Alrededor de ellas, reglas deterministas: una afirmación sin ninguna cita válida se elimina sin preguntar a un modelo;
los números que no aparecen en las citas mandan la frase a *needs review*; una frase que se apoya en un documento
marcado por inyección queda limitada a *needs review*; la acción de PayPal y el tipo de evidencia los eligen reglas, no
el modelo. Solo se pueden enviar las frases *supported* (respaldadas), y no se envía nada sin la aprobación del
comerciante. El «100% de validez de citas» de las [evaluaciones](evaluations.md) es una cifra de validez literal.

Las líneas que una persona corrigió o transcribió a mano se atribuyen en dos partes: el registro de la subida guarda
quién lo hizo (`correctedBy` / `by`, la etiqueta de la persona), y el analista ve un marcador fijo en su propia línea,
fuera del texto del documento y nunca citable («↳ corrected by the merchant» / «↳ transcribed manually by the
merchant»). Una frase que se apoya en una línea así necesita confirmación explícita antes de poder enviarse.

## Inyección de prompts

Todo documento (fixtures, datos de PayPal, subidas del comerciante, los mensajes del comprador) es texto no fiable.

| Capa | Qué hace |
|---|---|
| Delimitación | Los documentos se envuelven en delimitadores con una etiqueta aleatoria por llamada |
| Detección (solo marca) | Un escaneo de patrones sobre texto normalizado (inglés, español, francés, alemán, portugués; plegado de caracteres de ancho cero y homoglifos; cargas en base64/hex decodificadas), las marcas propias del modelo de extracción y una llamada a un clasificador. Cualquier señal añade una marca; ninguna la quita |
| Contención (no depende de la detección) | La regla literal, la verificación por frase, el límite para documentos marcados, las acciones elegidas por reglas y la aprobación del comerciante |
| Frases editadas | Una recomprobación acepta de 1 a 600 caracteres, sin saltos de línea ni caracteres de control, enviados como datos no fiables delimitados |
| El agente comprador | El modelo elige solo entre las herramientas ofrecidas; el código valida cada llamada (una acción por turno, esquema, precio dentro del presupuesto restante); MeterMCP mide. `open_budget`, `close_session` y `get_receipt` nunca se ofrecen al modelo |

Tests: `packages/analyst/test/injection.test.ts` (todas las variantes de evasión marcadas; la normalización deshace la
evasión; la frase de un documento marcado nunca se respalda automáticamente; *undetected injection: outcome unchanged,
no unsupported claim passes*). Evaluaciones: 10 variantes de inyección en el conjunto de desarrollo y 3 ataques en el
conjunto held-out ([Evaluaciones del analista](evaluations.md), secciones 4–5).

**Riesgo residual:** una frase que cita el propio texto inyectado la juzga un modelo que lee esa cita. La comprobación
de resultados prohibidos del held-out se basa en patrones y solo ve las paráfrasis que enumeró su autor.

## Archivos no fiables

Las subidas del comerciante son entrada hostil. El contenido tapado no debe llegar a nada posterior.

| Control | Detalle | Tests |
|---|---|---|
| Tipo por contenido | PNG/JPEG decidido por los bytes mágicos, sea cual sea el nombre; GIF, PDF como imagen y bytes aleatorios rechazados | `uploads-image.test.ts` |
| Tamaño antes de decodificar | 5 MiB por imagen; como máximo 4096 px por lado y 8 294 400 píxeles; rechazados los PNG entrelazados, `IHDR` dobles, profundidades de bits incorrectas e `IDAT` que se inflan más allá de su tamaño declarado; un tope absoluto de inflado | `uploads-image.test.ts` |
| Recodificación | Toda imagen guardada es un PNG nuevo y opaco con solo `IHDR`, `IDAT` e `IEND` (una foto JPEG tapada: un JPEG baseline nuevo, calidad 90, solo la cabecera JFIF, sin EXIF ni comentarios); los píxeles transparentes se componen sobre blanco; los píxeles tapados son negros, lea lo que lea el OCR, y se fijan antes de codificar (dos fotos que solo difieren bajo una tapa dan los mismos bytes) | `uploads-image.test.ts`; verificado en el sandbox el 18/10 (la copia de PayPal solo tenía esos chunks, con el tapado incrustado) |
| PDF en un proceso aparte | pdf.js se ejecuta en un proceso hijo con fork (heap de 160 MB), que se mata al llegar a su plazo y, en Linux, por encima de 200 MiB de RSS; PDF cifrados rechazados; ≤10 MiB, ≤30 páginas; los metadatos nunca se decodifican | `uploads-pdf-input.test.ts` (bloqueo, caída, fallo al lanzar, techo de memoria, bombas de descompresión en el contenido y en las fuentes). **Matar por RSS en Linux con una bomba real: Pendiente** |
| PDF reconstruido | Al confirmar, el PDF se reconstruye como páginas solo de imagen a partir de los renders tapados: sin fuentes, anotaciones, archivos incrustados, JavaScript ni XMP. El original y los renders sin tapar se descartan | `pdf-image.test.ts` |
| OCR | tesseract.js con datos de idioma locales, sin descargas de red, solo sobre la imagen o página **saneada** | `uploads-ocr.test.ts` |
| Pista de la capa de texto del PDF | Se muestra solo durante la revisión; nunca se guarda ni se registra; se lee una vez por página y revisión | `uploads-pdf-routes.test.ts` |
| Transcripción | Debe salir de una zona visible dentro de la página (≥2×2 px); se rechaza sobre una zona tapada | `uploads-pdf-routes.test.ts` |
| Texto pegado | Solo Latin-1, caracteres de control sustituidos, lo eliminado pasa a `[redacted]`, guardado como un PDF generado por ResolveKit; ≤20 000 caracteres | `uploads-text.test.ts` |
| Confirmación ligada al contenido | El SHA-256 del archivo saneado que revisó la persona debe coincidir | `uploads-routes.test.ts` |
| Nombres de archivo | Nunca salen del servidor: PayPal recibe `E<n>-upload.png` (`.jpg` si es una foto tapada), `E<n>-upload.pdf` o `E<n>-pasted.pdf`; el modelo solo ve títulos | `uploads-documents.test.ts`; sandbox 18/10 (imagen) |
| Acceso a pendientes | Hasta la confirmación, solo quienes pueden editar ven archivos y texto; los demás reciben metadatos con `restricted: true` | `uploads-routes.test.ts` |

**Test de recuperación de contenido tapado.** `apps/server/test/uploads-pdf-recovery.test.ts` construye un PDF con seis
secretos distintos: una línea visible que se tapa, texto blanco, el diccionario de información del documento, metadatos
XMP, una anotación y un archivo incrustado. Lo sube, lo tapa y lo confirma, y comprueba que **ninguno** llega al PDF
reconstruido, a su imagen de página, al análisis, a la petición a PayPal, a los logs ni a la auditoría. Un segundo test
comprueba que los números de cuenta y de seguimiento de 8 pt se siguen leyendo exactamente a la resolución del render.
Los códigos de barras y los códigos QR no se decodifican; la revisión de PDF avisa de ellos.

## Aislamiento

| Frontera | Control | Tests |
|---|---|---|
| Espacios de trabajo | Las rutas de casos (`/api/disputes/<case>…`, `/api/cases/<case>/analysis…`, `/api/cases/<case>/uploads…`) solo responden para casos vinculados y solo al espacio de trabajo del vendedor; cualquier otro recibe `404 UNKNOWN_CASE` antes de hacer nada. Antes de componer y antes de enviar, el merchant id del espacio de trabajo de la persona debe ser el vendedor de la disputa (`403 NOT_THE_SELLER`) | `environments.test.ts`, `sellers.test.ts`, `auth.test.ts` (*only the seller's workspace answers the dispute…*), `uploads-pdf-routes.test.ts` (*another workspace, a signed-out visitor or an unbound case get 404*) |
| Progreso y cachés del análisis | `/progress` solo responde al espacio de trabajo del vendedor, también después de un reinicio; las claves de caché son SHA-256 de (entrada, prompt, modelo); la entrada la construye el servidor, nunca se toma del navegador | `hosted.test.ts` (*cross-tenant…*), `analysis.test.ts` |
| Intents | Un intent pertenece a su sesión: otra persona, incluido un compañero de equipo, no puede leerlo, aprobarlo, cancelarlo ni enviarlo (404); las ediciones de otra sesión no lo invalidan; las avalanchas se acotan por sesión y por dirección | `intent-sessions.test.ts`, `review-fixes.test.ts` |
| Ejecuciones del agente | El autor ve sus ejecuciones; un Owner ve las del espacio de trabajo solo con `?scope=workspace` (se registra; enlace de aprobación, pedido y sesión ocultos); la ejecución de otro espacio de trabajo da 404 incluso para un Owner | `agent-routes.test.ts` |
| Agente ↔ MeterMCP | El `/agent/mcp` privado necesita el token de administración y `x-agent-run: run-<32 hex>`; la sesión queda ligada a esa ejecución; no es accesible a través del proxy público | `apps/metermcp/test/hosted.test.ts` |
| Sesiones MCP | Una sesión MCP solo llega a su propia sesión de pago (`apps/metermcp/src/mcp.ts`) | No se identificó un test específico para esta página |
| Registros de ejecución en casos | La evidencia «Agent run record» (registro de ejecución del agente) solo aparece cuando la vinculación del caso nombra esa ejecución y su sesión coincide | `agent.test.ts` |
| Documentos | Adjuntos: solo subidas confirmadas de este espacio de trabajo, caso y disputa activa; los bytes se vuelven a hashear al enviar | `intent.test.ts`, `uploads-routes.test.ts` |

El aislamiento entre varios comerciantes no se ha probado en la práctica: solo hay un espacio de trabajo de vendedor
conectado (la conexión de comerciantes está **Pendiente**), así que los tests entre espacios de trabajo usan fixtures de
test, no varios comerciantes reales.

## Envío e inicio de sesión

- Envío: el servidor compone el intent; la aprobación es por hash del contenido, solo desde la sesión propietaria, con
  un TTL de 30 minutos; cualquier edición, un intent más nuevo o un cambio de vinculación lo invalidan; el envío vuelve
  a leer PayPal y rechaza ante cualquier diferencia; un `PayPal-Request-Id` por intent; un bloqueo por disputa; una
  entrada de auditoría duradera antes de que nada vaya a PayPal. Detalles: [API HTTP](../technical/http-api.md).
- Acciones de disputa (Desplegadas; Verificadas en sandbox a través de la app, aún no ejercitadas en el servicio alojado): la misma cadena, más el rol comprobado al componer, aprobar,
  confirmar y enviar (aceptar, ofertar y escalar son solo del Owner, `403 OWNER_ONLY`); una segunda confirmación ligada
  al id del intent, el hash del contenido, la acción, el importe canónico, la moneda y la consecuencia; importes como
  cadenas decimales exactas, nunca números de coma flotante; una disputa retenida tras cualquier envío cuyo resultado
  PayPal no prueba, hasta que una relectura lo resuelva; ningún reintento automático de un POST de acción; «Recorded by
  PayPal» solo ante una entrada atribuible al envío, nunca ante un cambio de estado por sí solo. Ninguna variante se
  ofrece sin un contrato registrado
  ([especificación funcional](../product/functional-specification.md#56-acciones-de-disputa-distintas-de-la-evidencia)).
- Webhooks: una clave secreta en la URL, comprobación de cabeceras, una lista de hosts de certificado permitidos, topes
  de cuerpo y de frecuencia, verificación con el método de postback documentado por PayPal sobre el cuerpo en bruto; la
  carga útil es solo una pista, la disputa se vuelve a leer.
- **Continue with PayPal** es una comprobación de identidad construida sobre un token de acuerdo sin cargo de Billing
  Agreements v1 (una familia de API obsoleta), no Log in with PayPal ni OpenID. No concede a ResolveKit acceso a las
  disputas del comerciante. Está ligada al navegador que la inició; un intento por token.
- Sesiones: cookies `HttpOnly; Secure; SameSite=Strict`, firmadas con HMAC, 12 h; la revocación y **Sign out of all
  devices** terminan todas las sesiones de la persona.
- Guardas del modo alojado: lista de Hosts permitidos, `Origin` propio para las peticiones que cambian estado, POST solo
  JSON, cabeceras de seguridad (CSP, HSTS, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`). Los
  límites por dirección son una cortesía, no la frontera: lo son la persona con sesión iniciada, su espacio de trabajo
  y los topes globales.
- El modo alojado se niega a arrancar con PayPal live sin una activación explícita que el blueprint nunca define.

## Privacidad

- **Qué llega a los proveedores de modelos** (Google Gemini; Groq como respaldo (fallback)): los documentos del caso que se
  analiza —documentos sintéticos de la demo, datos de disputas del **sandbox** de PayPal para los casos vinculados, el
  recibo de MeterMCP para el caso del agente y el texto saneado de las subidas confirmadas del comerciante— y, en una
  recomprobación, la frase editada. No los nombres de archivo, no el contenido tapado, no los secretos. Su tratamiento
  de esos datos se rige por los términos de cada proveedor, no por ResolveKit.
- **Qué se guarda**: consulta [Retención y borrado](../operations/retention-and-deletion.md). Datos personales
  guardados: payer ids de PayPal, nombres visibles, correos enmascarados, claves públicas de passkey, hashes de tokens
  de invitación (`accounts.json`), textos de notas aprobados y textos de mensajes aprobados (`intents.json`; un mensaje
  se conserva como las notas de evidencia, mientras dure el registro de su intent), subidas. El hilo de mensajes de
  PayPal se muestra en cada lectura, pero no se guarda y nunca se entrega al analista. No hay función de borrado ni de
  exportación de cuentas (**Pendiente**).
- **Los logs** llevan ids, códigos, recuentos y tiempos; nunca texto de documentos, contenido de archivos, claves ni
  tokens. Los logs de auditoría y de envíos registran un mensaje solo por el SHA-256 de su texto (un texto corto se
  puede adivinar a partir de su hash; los logs solo están en el servidor). El log de uso del analista solo guarda recuentos de tokens y tiempos.
- **Los secretos** vienen solo de variables de entorno; no se lee ninguna variable `VITE_*`, así que nada secreto llega
  al bundle web. `.env` está en `.gitignore`.
- Los ejemplos de esta documentación usan ids ficticios.

## Riesgos residuales y carencias

- El respaldo semántico es un juicio de un modelo; las notas ciertas acaban a menudo en *needs review* (held-out: 17
  de 66 respaldadas) y es posible una frase mal juzgada. La aprobación del comerciante es el último control.
- La detección de inyección puede fallar (al escaneo de patrones se le escapó un ataque del held-out en cada
  ejecución); la contención no depende de ella, pero una frase que cita el texto inyectado la sigue juzgando un modelo.
- Las citas literales no dicen nada sobre la autenticidad de un documento: una subida falsificada citada exactamente
  sigue siendo falsa.
- El OCR puede leer mal; las líneas corregidas y transcritas se apoyan en la palabra de la persona y se etiquetan así.
- Los códigos de barras y QR de las subidas no se decodifican ni se tapan automáticamente (la revisión de PDF muestra
  un aviso).
- Las protecciones exclusivas de Linux (matar por RSS) no se han medido en la plataforma de alojamiento; la memoria con
  PDF grandes en Render no se ha medido.
- El inicio de sesión depende de una familia de API de PayPal obsoleta y puede dejar de funcionar.
- Las acciones de disputa se apoyan en una escritura de sandbox por variante (20/10/2026); PayPal puede comportarse de
  otro modo en otras disputas, motivos o fases, y en producción. El texto aprobado del mensaje está en el disco del
  servidor, con los intents.
- No consta ninguna auditoría de seguridad externa ni prueba de penetración. Las revisiones internas constan en las
  listas de seguimiento de los mantenedores.
- Consulta [Problemas conocidos](known-issues.md) para los puntos abiertos.
