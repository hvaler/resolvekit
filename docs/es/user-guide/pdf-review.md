[English](../../user-guide/pdf-review.md) | [Español](pdf-review.md)

# Revisión de PDF

Un PDF nunca se usa como PDF. El servidor convierte en imágenes las páginas que eliges, tú tapas cada página y haces
que se vuelva a leer, y al confirmar ResolveKit construye un PDF nuevo, solo de imágenes, a partir de tus páginas
tapadas. Después se borra el archivo original. Su capa de texto, sus fuentes, adjuntos, anotaciones y metadatos nunca
se usan.

Estado: Implementado · Probado en local · Desplegado. Enviar una subida PDF al sandbox de PayPal: **Pendiente** (aún no
observado).

## Límites

| Límite | Valor |
|---|---|
| Archivo | hasta 10 MiB y 30 páginas |
| Páginas usadas | como máximo 5 |
| Pasadas de tapado | 5 por página |
| Texto del PDF (leído + transcrito) | 20,000 caracteres |
| PDF reconstruido | menos de 9,900,000 bytes (debe quedar por debajo de los 10 MB por archivo de PayPal) |
| Lecturas de página | cada lectura de página cuenta para el límite de **subidas** de tu dirección (20 cada 10 minutos) |
| Pista de texto | una vez por página y revisión; cuenta para el límite de lecturas de PayPal de tu dirección (60 cada 5 minutos) |

## Pasos

1. **+ Add evidence** → elige el PDF. «Checking the PDF…».
2. **Hasta 5 páginas**: el servidor las lee de una vez («Reading page 2 of 3…»). Salta al paso 4.
3. **Más de 5 páginas**: el servidor prepara miniaturas («Preparing thumbnails (4 of 12)…») y después la subida
   muestra **Choose pages**:
   - «This document has 12 pages. Choose up to 5 to add as evidence.»
   - «Keep the context the dispute needs: don't leave out pages with relevant or contradicting information.»
   - Haz clic en las miniaturas para elegirlas («Page 8 of the original document») y después pulsa **Add N pages**. La
     elección se hace una sola vez; para elegir otras, descarta y vuelve a subir.
4. Cuando las páginas estén leídas, elige **Review** en la subida pendiente. Se abre **Review new evidence** con
   «<name> · PDF · N pages chosen · uploaded by <person>» y una pestaña por página: «Page 8 · not covered», «Page 8 ✓»,
   «Page 8 · changed».
5. En cada página:
   1. Lee el aviso: «Covering the text next to a barcode or QR code doesn't hide what the code contains. Cover the code
      too if it carries data you don't want to share.»
   2. Con **Cover** seleccionado, arrastra sobre lo que no debe compartirse.
   3. **Cover this page and read it again** (aunque no haya nada que tapar). La página se vuelve a renderizar con los
      tapados incrustados y se vuelve a leer desde cero.
   4. En «Text read from the covered page» corrige cualquier línea mal leída («This is what the analyst will read.
      Correct a line where the reading is wrong; each correction is marked with who made it.»).
   5. Una línea que la lectura no detectó: elige **Add text**, arrastra sobre la línea en la página (nunca sobre un
      tapado) y escríbela en «Type the line as it is on the page». Se muestra como «Transcribed manually by <you>».
      **Remove** la quita.
   6. Opcional: en «Text found in the PDF (a hint for your review; never stored or sent)» elige **Show it for this
      page** para compararlo con el texto propio del PDF. Puede contener texto que no se ve en la página.
6. **Review the pages included**: «These pages become evidence», una línea por página («Page 2 of the original document
   · 2 lines read, 1 corrected»), y «Only the covered pages and the text above are stored and used; the original PDF is
   deleted.»
7. **Confirm as evidence**, o **← Back to the pages**. El PDF pasa a ser el siguiente número de evidencia.

**← Back to case** cierra la ventana: lo que has escrito y dibujado se queda en esta página hasta que la recargues;
nada se usa antes de confirmar. **Discard** elimina la subida («What you typed and drew on its pages is lost.»).

## Qué verás después

- Las citas nombran la página del documento **original**: las líneas se citan como «line 2 of page 8» y se agrupan en
  «Page 8 of the original document» en la tarjeta de evidencia.
- Una frase que se apoya en una línea corregida o transcrita necesita tu confirmación explícita antes de poder enviarse
  (ver [Revisar y enviar](review-and-submit.md)).
- Al analista se le indica qué líneas corrigió o transcribió una persona; no las toma como leídas del archivo.
- PayPal solo recibe el PDF reconstruido, con el nombre `E<n>-upload.pdf`.

## Mensajes y bloqueos

| Mensaje | Significado / qué hacer |
|---|---|
| «Cover <page> first, even if nothing needs covering.» | Cada página debe taparse y volver a leerse antes de confirmar |
| «You changed what is covered on <page>: cover it again before confirming.» | Los tapados cambiaron tras la última lectura |
| «No text was read on this page. Transcribe what matters, or the analyst can't use it.» | Usa **Add text** |
| «A transcribed line cannot come from a covered area.» | Saca la zona de encima del tapado |
| «Type the text of each transcribed line on <page>, or remove it.» | Rellena o quita las líneas transcritas vacías |
| «Page 8 of the original document changed; check it again.» | La página cambió en el servidor; revísala de nuevo |
| «Once rebuilt from its covered pages, this PDF is larger than … ; upload it again and choose fewer pages» | Descarta, vuelve a subir y elige menos páginas (un escaneo con ruido puede ocupar unos 2 MB por página) |
| «A page can be covered 5 times; discard this PDF and upload it again» | Empieza de nuevo |
| «Reading is taking longer than expected. Reload the page to check again.» | Recarga; leer cinco páginas puede tardar minutos |
| «Failed: …» | Descarta y vuelve a subir |
| Miniatura «No preview» | La miniatura no pudo cargarse tras 3 intentos; aun así puedes elegir la página |

## Privacidad y retención

- Hasta que se confirma, el PDF original, los renderizados de sus páginas sin tapar y la pista de texto solo los ven
  quienes pueden editar la subida. La pista solo se muestra durante la revisión y nunca se guarda, registra ni envía.
- Al confirmar se borran el PDF original y los renderizados sin tapar; las páginas tapadas y su texto se quedan como
  evidencia. Un PDF pendiente que no se confirma en 24 horas se descarta.
- Borrar y lo que queda en PayPal o en un proveedor de modelos: ver [Casos y evidencias](cases-and-evidence.md#borrar-y-lo-que-queda).
- Cómo se aísla el renderizado (un proceso aparte con límites de memoria y tiempo): ver
  [Procesamiento de evidencia](../technical/evidence-processing.md).
