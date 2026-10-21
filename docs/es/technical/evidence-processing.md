[English](../../technical/evidence-processing.md) | [Español](evidence-processing.md)

# Procesamiento de evidencia (subidas del comerciante)

Cómo convierte ResolveKit una captura de pantalla, un PDF o un texto pegado por el comerciante en evidencia que el
analista puede citar y PayPal puede recibir, sin que nada salga del servidor antes de que el comerciante haya tapado
lo que quiera y haya confirmado. Código en `apps/server/src/uploads/` en el commit `c12faea`. Cómo usarlo:
[casos y evidencias](../user-guide/cases-and-evidence.md), [revisión de PDF](../user-guide/pdf-review.md).

## Principios

- **Se lee en nuestro servidor.** Las imágenes y las páginas de PDF las lee un OCR local; ninguna subida, ni bytes
  ni texto, va a un proveedor de modelos ni a PayPal hasta que se tapa donde haga falta, se vuelve a leer y se
  confirma.
- **El comerciante decide qué tapar.** Nada se tapa automáticamente.
- **Una sola versión saneada** sirve para el analista y para el adjunto de PayPal.
- **Los logs solo llevan ids y códigos**, nunca nombres de archivo, texto de las subidas ni bytes. El nombre del
  archivo nunca sale del servidor: PayPal recibe `E<n>-upload.png` (`.jpg` si es una foto tapada), `E<n>-upload.pdf` o `E<n>-pasted.pdf`; el modelo
  ve los títulos «Uploaded screenshot», «Uploaded PDF», «Pasted text».

## Dependencias y compatibilidad

| Dependencia | Versión | Uso | Notas |
|---|---|---|---|
| `pdfjs-dist` | 6.4.299 (build legacy para Node) | Contar, renderizar y leer la pista de la capa de texto de las páginas de PDF, en el proceso hijo | Worker falso en el hilo principal del proceso hijo; en 6.x no hay ruta de eval |
| `@napi-rs/canvas` | 1.0.10 | Canvas para el renderizado de pdf.js | Binario nativo precompilado por plataforma |
| `tesseract.js` | 7.0.0 | OCR (WASM) | Worker creado bajo demanda, un trabajo a la vez, se detiene tras 60 s inactivo |
| `@tesseract.js-data/eng` | 1.0.0 | Datos del idioma inglés desde disco | `cacheMethod: 'none'`; no se descarga nada en tiempo de ejecución |
| `pngjs` | 7.0.0 | Decodificación y codificación PNG | |
| `jpeg-js` | 0.4.4 | Decodificación JPEG | |
| `@resolvekit/pdf` | workspace | Escribir el PDF del texto pegado y el PDF reconstruido solo de imagen | |

Funciona con Node 24. La suite pasó en Windows el 19/10/2026; el servicio funciona en el Linux de Render. La muerte
del proceso hijo de PDF por memoria lee `/proc/<pid>/statm` y, por tanto, solo funciona en Linux; en Windows y macOS
(desarrollo) solo se aplica el plazo. Ejecuciones de tests en Linux y una medición de memoria en Render con un PDF de
5 páginas: Pendiente.

## Pipelines

### Imagen (PNG o JPEG)

1. `POST /api/cases/:id/uploads` con los bytes en bruto y `x-upload-name`. El tipo se determina solo por los bytes
   mágicos; el tamaño se lee de la cabecera y se comprueba antes de decodificar ningún píxel.
2. Se decodifica una imagen a la vez en todo el servidor. Un JPEG se pone primero derecho según su EXIF Orientation,
   como lo muestra el navegador, para que las tapas y las cajas del OCR caigan donde la persona las vio (una foto vertical
   de móvil se guarda en horizontal). A partir de los píxeles decodificados se codifica un archivo saneado: sin
   metadatos, sin chunks ni segmentos auxiliares, sin ninguno de los bytes originales.
3. El OCR lee la imagen saneada (reducida solo para el OCR por encima de 4 MP).
4. El comerciante tapa rectángulos (`POST …/redact`, como mucho 5 pasadas); las tapas se incrustan en negro opaco y
   la imagen se vuelve a leer.
5. El comerciante revisa las líneas, corrige las que haga falta y confirma (`POST …/confirm`) con el `sha256` del
   archivo saneado revisado; si no coincide, se rechaza (`UPLOAD_CHANGED`). El original se elimina.

Un PNG tapado se guarda como un PNG nuevo (sin pérdida, para las capturas). Una foto JPEG tapada se guarda como un JPEG
baseline nuevo de calidad 90 (solo la cabecera JFIF: sin EXIF ni otros segmentos), así que ocupa más o menos lo mismo
que la foto y queda por debajo del límite de 9.9 MB; como PNG sin pérdida una foto de cámara puede crecer de tres a
cinco veces. Las tapas se incrustan antes de codificar, así que nada de lo que hay debajo llega al archivo. El OCR lee
ese archivo guardado. El envío a PayPal de un JPEG tapado solo está probado en local (**Pendiente** en el sandbox).

### PDF

1. Subida ≤ 10 MiB y ≤ 30 páginas (si no, «This PDF is larger than 10 MiB or has more than 30 pages. Prepare a
   smaller extract and upload it again.»). Se rechazan los PDF protegidos con contraseña o cifrados.
2. Un trabajo en segundo plano (consultado mediante `GET /uploads`) se ejecuta por etapas: `selecting` (miniaturas a
   36 dpi, 3 s cada una, para PDF de más de 5 páginas), `rendering` (las páginas seleccionadas), `reading` (OCR de
   cada renderizado), `reviewing`, o `failed` con un mensaje fijo (se libera todo lo de la subida).
3. Un PDF de hasta 5 páginas se toma entero; uno más largo necesita una selección de 1–5 páginas, una sola vez
   (`POST …/select`). Las demás páginas nunca se analizan ni se envían.
4. Cada página elegida se renderiza a 170 dpi (una página más grande, a menos dpi, para no pasar de 4 MP), pasa por
   la misma ruta de saneado que una imagen y después se tapa y se pasa por OCR. **El OCR lee la imagen tapada, nunca
   la capa de texto** (que puede contener texto invisible).
5. La capa de texto propia del PDF puede mostrarse como **pista** solo durante la revisión (una vez por página y
   revisión, en memoria, nunca guardada ni registrada; cada pista cuenta como lectura de PayPal para el límite por
   dirección).
6. El comerciante puede **transcribir** una línea que el OCR no captó, ligada a una zona visible (≥ 2×2 px, dentro de
   la página, sin solaparse con ninguna tapa: «A transcribed line cannot come from a covered area.»).
7. Al confirmar, el servidor construye `sanitised.pdf`, un PDF nuevo solo de imagen con las imágenes de las páginas
   tapadas (sin capa de texto, fuentes, anotaciones, adjuntos, metadatos ni scripts), comprueba que cabe en 9.9 MB y
   borra el original y sus renderizados sin tapar. El PDF original nunca sale del servidor.

Límites por sesión: 20 s por renderizado de página, 90 s para una sesión completa de pdf.js («This PDF takes too long
to read.»); un trabajo de PDF o de imagen a la vez en todo el servidor; las lecturas de páginas de PDF cuentan para
el límite de **subidas** por dirección (20 cada 10 min, alojado).

### Texto pegado

1. JSON `{text, name}`, como mucho 20 000 caracteres, solo Latin-1 (un texto con otro carácter se rechaza indicando
   cuál, porque el PDF enviado a PayPal no puede mostrarlo); los caracteres de control se sustituyen.
2. Las eliminaciones por posiciones de caracteres pasan a ser `[redacted]` (los tramos solapados se fusionan).
3. Se guarda y se calcula su hash como un PDF generado por ResolveKit (líneas ajustadas a 300 caracteres).

## El proceso hijo de PDF (entrada hostil)

pdf.js se ejecuta en un proceso hijo bifurcado (`pdf-child.ts`), nunca en el servidor: `--max-old-space-size=160`,
serialización avanzada por IPC (los píxeles de las páginas viajan como franjas binarias), stdio cerrado. Opciones:
`isEvalSupported: false`, `enableXfa: false`, `disableFontFace: true`, `useSystemFonts: false`,
`disableAutoFetch: true`, `verbosity: 0`; solo datos, nunca una URL; `fetch` y `XMLHttpRequest` sustituidos por
funciones que lanzan error, con los intentos contados en cada respuesta. El proceso padre mata al hijo con `SIGKILL`
al llegar al plazo de una operación y, en Linux, cuando su memoria residente supera 200 MiB (se comprueba cada
100 ms). El worker de OCR se cierra antes de que arranque un proceso hijo, porque la instancia alojada solo tiene
sitio para un heap grande. Un proceso hijo que falla o al que se mata nunca lanza un error en el padre.

`apps/server/test/uploads-pdf-recovery.test.ts` intenta recuperar una línea tapada, texto blanco, metadatos, una
anotación y un adjunto a partir de todo lo que sale de una subida. Estado: Implementado · Probado en local. La muerte
por RSS no se ha medido en Linux contra una bomba de descompresión real (seguimiento).

## De la subida a la evidencia

| Paso | Regla |
|---|---|
| Numeración | Una subida confirmada pasa a ser `E<n>`, después de los documentos del caso (E7, E8…) |
| Citas | `E7.l<n>` para una imagen o un texto; `E7.p<page>.l<n>` para un PDF, con el número de página **original**; una cita no sale de una página |
| Atribución | El registro de la subida guarda la etiqueta de la persona en cada línea corregida (`correctedBy`) y transcrita (`by`); la app web muestra «corrected by <label>» y «transcribed manually by <label>». El analista ve marcadores fijos fuera del texto del documento: «↳ corrected by the merchant» y «↳ transcribed manually by the merchant» |
| Confirmación de las frases dependientes | Una frase que se apoya en una línea corregida o transcrita necesita la confirmación explícita de la persona (`confirmedCorrections`, ≤ 50 pares `S1@E7.l2`) antes de poder enviarse |
| Notas del comerciante | Una explicación que no está en el documento es una nota del comerciante, nunca evidencia documental |
| Adjuntos | Solo subidas confirmadas de este espacio de trabajo, caso y disputa activa; ≤ 10; en el orden de la evidencia; se vuelve a calcular el hash de los bytes al enviar |
| Qué recibe PayPal | El archivo saneado: tapas incrustadas en el PNG (o en el JPEG, si es una foto), el PDF reconstruido solo de imagen o el PDF del texto pegado |

## Visibilidad, vida útil y borrado

| Regla | Detalle |
|---|---|
| Antes de la confirmación | Archivos y texto visibles solo para quienes pueden editar la subida (quien la subió, Owners, miembros completos); los demás ven metadatos con `restricted: true`; los archivos dan 404 |
| Permisos | Owners y miembros editan cualquier subida; un revisor solo edita las suyas; borrar: solo Owners y miembros completos |
| Vida útil pendiente | 24 h; después se descarta al encontrarla y en el barrido de cada hora |
| Descartar | Antes de la confirmación, por un editor |
| Borrar | Elimina los archivos, purga los análisis, veredictos y fijaciones que la citaban, anula los intents no enviados; se rechaza mientras haya en curso un envío que la usa (`SEND_IN_PROGRESS`) |
| Rotación | Cuando el caso pasa a su siguiente disputa, sus subidas se archivan (se conserva el registro, se eliminan archivos y texto) |
| Aviso de código de barras / QR | Tapar el texto que hay junto a un código no oculta lo que el código codifica; la revisión de PDF lo advierte |

## Límites (de `uploads/limits.ts`)

| Límite | Valor |
|---|---|
| Archivo de imagen | 5 MiB |
| Tamaño de imagen | 4096 px por lado y 8 294 400 px en total (3840 × 2160 cabe; 4096 × 2025 también) |
| OCR | 4 000 000 px leídos; 45 s por lectura, 30 s para arrancar el worker |
| PDF | 10 MiB, 30 páginas, 5 seleccionadas, 170 dpi, 4 MP por página |
| Pasadas de tapado | 5 por subida de imagen o de texto; 5 por página en un PDF |
| Archivo saneado guardado | 9 900 000 bytes |
| Todos los archivos de una respuesta a PayPal | 50 000 000 bytes |
| Texto pegado, y texto leído + transcrito de un PDF | 20 000 caracteres |
| Subidas por caso | 10 (pendientes, en revisión y confirmadas) |
| Subidas por día (alojado) | 40 (`DAILY_UPLOADS`) |
| Todos los archivos de subidas | 300 MiB (`STORAGE_FULL`, 507) |
| Por petición | 200 rectángulos o eliminaciones, líneas de 1 000 caracteres, nombres de 120 caracteres |

## Estado

| Capacidad | Estado |
|---|---|
| Subida de imagen, tapado, OCR, confirmación, envío | Implementado · Probado en local · Verificado en sandbox (un PNG tapado registrado por PayPal, 18/10/2026; la copia de PayPal solo contenía los datos de píxeles de la imagen, con la tapa incrustada) · Desplegado |
| Subida de PDF, selección, reconstrucción | Implementado · Probado en local · Desplegado; enviado al sandbox de PayPal: Pendiente |
| Texto pegado | Implementado · Probado en local · Desplegado; enviado al sandbox de PayPal: Pendiente |

Seguimientos abiertos (un fallo al archivar nunca se reintenta, `closeOcr()` sin límite de tiempo, huecos en los tests
de la UI de PDF): ver [problemas conocidos](../quality/known-issues.md).
