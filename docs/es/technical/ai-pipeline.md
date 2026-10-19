[English](../../technical/ai-pipeline.md) | [Español](ai-pipeline.md)

# Pipeline de IA (el analista de disputas)

`packages/analyst`, llamado por `apps/server`. Lee los documentos de un caso y redacta una respuesta en la que cada
frase cita evidencia literal; después comprueba cada frase. Código en el commit `fbe9621`. Las cifras de evaluación
no se repiten aquí: las únicas fuentes son [evaluaciones](../quality/evaluations.md) y
`packages/analyst/evals/results/summary.md`.

## Modelos y proveedores

| Elemento | Valor |
|---|---|
| Principal | Google Gemini `gemini-3.8-flash` mediante la API de Gemini (`generateContent`, `responseMimeType: application/json` con un esquema de respuesta, `thinkingLevel: low`, temperatura 0) |
| Respaldo | `openai/gpt-oss-120b` en Groq (chat completions compatibles con OpenAI, `json_schema` estricto, temperatura 0) |
| Elección | `ANALYST_PROVIDER=gemini\|groq` (por defecto `gemini`) elige el principal; el otro proveedor, si su clave está definida, es el respaldo automático ante errores y 429. La misma variable elige el principal del agente |
| Sustituciones | `GEMINI_MODEL`, `GROQ_MODEL` (un id distinto cambia la clave de caché) |
| Transporte | `fetch` simple, sin SDK; las claves solo van en la cabecera de autenticación del proveedor, nunca en el navegador |
| Timeout | 90 s por llamada (sondeo del modelo 20 s) |
| Reintentos | 2, respetando `Retry-After`, hasta 65 s entre intentos (el nivel gratuito de Groq se reinicia cada minuto) |
| Presupuesto de Groq | `GROQ_TPM` (por defecto 8 000): prompt + salida máxima deben caber |
| Registro de uso | `analyst-usage.jsonl` y el log del servidor: etapa, proveedor, modelo, tokens de entrada/salida/razonamiento, milisegundos. Nunca texto de prompts ni de documentos |

Sin ninguna clave, el servidor solo sirve análisis guardados (`ANALYST_UNCONFIGURED` para una ejecución en directo).

## Qué envía el servidor

El navegador solo envía el id del caso (y, para una recomprobación, la frase editada). El servidor construye la
entrada él mismo:

| Parte | Fuente |
|---|---|
| Documentos del caso | Fixtures de `packages/cases`, montados exactamente como los muestra la app web (sintéticos, nombres e ids ficticios) |
| Datos de PayPal | La propia lectura del servidor de la disputa de sandbox vinculada, reutilizada durante 60 s |
| Caso del agente | La propia lectura del servidor del recibo de MeterMCP; el registro de la ejecución del agente (E5) solo cuando la vinculación nombra esa ejecución |
| Subidas del comerciante | Solo subidas confirmadas: el texto OCR del archivo **saneado**, con las líneas corregidas y transcritas marcadas |
| Notas del comerciante | `merchantNotes`, redactadas como notas («From your notes»), nunca como evidencia documental |

En cuanto PayPal muestra la evidencia del vendedor, el caso conserva la entrada con la que se analizó antes de enviar
(`InputPins`, persistida), así que enviar no requiere una nueva ejecución del modelo. Solo llegan a un modelo los
documentos sintéticos de la demo, los datos del sandbox de PayPal y las subidas confirmadas y tapadas.

## Etapas

| Etapa | Llamada al modelo (tokens máximos de salida) | Código determinista |
|---|---|---|
| 0. Leer | — | Búsqueda de patrones de instrucciones sobre texto normalizado (NFKC, caracteres de ancho cero y bidi eliminados, homoglifos y leetspeak mapeados; EN/ES/FR/DE/PT; líneas de rol falsas y marcado; cargas en base64 y hex) |
| 1. Extraer | `extract` (12 000): hechos, cada uno con una cita literal; pasajes que contienen instrucciones. En paralelo, `screen` (1 500): un clasificador pequeño de instrucciones (solo puede añadir marcas) | Descarta toda cita que no sea una subcadena exacta de su documento (solo con espacios normalizados); ningún hecho verificable → la ejecución falla |
| 2. Analizar | `analyze` (12 000): cronología, contradicciones, lista de comprobación, frases del borrador que citan hechos, solo a partir de los hechos extraídos | Requisitos de la lista de comprobación por motivo de la disputa; las contradicciones necesitan dos documentos distintos y valores literales; cronología ordenada |
| 3. Verificar | `verify` (2 000): cada frase en su propia llamada, juzgada solo frente a sus propias citas: *supported* (respaldada), *needs review* (necesita revisión; motivo y reescritura) o *rejected* (rechazada) | Sin cita válida → rechazada **sin** el modelo; una frase «supported» con un número que no contiene ninguna de sus citas → needs review; una frase que se apoya en un documento marcado → como mucho needs review |
| 4. Recomendar | `explain` (2 000): dos frases que explican la acción elegida | **Las reglas eligen la acción** a partir de lo que PayPal permite ahora y de la evidencia que solicita; el modelo nunca elige la acción ni el tipo de evidencia |

Solo se pueden enviar las frases *supported*. Las rechazadas siguen visibles, tachadas, con el motivo.

**Recomprobación de una frase editada.** `POST /api/cases/:id/analysis/verify {text}` (1–600 caracteres, sin saltos
de línea ni caracteres de control) envía la frase, delimitada como dato no fiable, a `recheck` (3 000 tokens de
salida): el modelo vuelve a elegir citas entre los hechos extraídos y después se aplican las mismas comprobaciones
deterministas. Los veredictos se guardan por (clave del análisis, texto), se conservan 2 000, en la memoria del
servidor. El prompt de recomprobación no forma parte de `PROMPT_VERSION`; `rk-recheck-2026-10-09.2` lo identifica en
los logs y en las evaluaciones.

## Prompts y versiones

| Elemento | Valor | Dónde |
|---|---|---|
| `PROMPT_VERSION` | `rk-analyst-2026-10-09.7` | `packages/analyst/src/prompts.ts` |
| `RECHECK_PROMPT_VERSION` | `rk-recheck-2026-10-09.2` | el mismo |
| Regla | Incrementar `PROMPT_VERSION` cada vez que cambie un prompt o un esquema: forma parte de la clave de caché | el mismo |

Cada prompt indica que los documentos son datos, nunca instrucciones. Los documentos van envueltos en delimitadores
con una etiqueta aleatoria por llamada (`<<<DOC-<nonce> id=… type=… source=… title=…>>>`), de modo que un documento
no puede falsificar el final de su propio bloque. Una línea que corrigió el comerciante va seguida de «↳ corrected by
the merchant», y una línea tecleada a mano, de «↳ transcribed manually by the merchant», fuera del texto del
documento para que nunca pueda citarse. El modelo ve los títulos de las subidas («Uploaded screenshot», «Uploaded
PDF», «Pasted text»), nunca los nombres de archivo.

## Caché y análisis de referencia (golden)

| Elemento | Comportamiento |
|---|---|
| Clave | `sha256` del JSON canónico de `{input, model, promptVersion}`; la misma en Node y en el navegador (Web Crypto) |
| Caché en directo | `<data>/analysis-cache/<key>.json`, sin caducidad; se purga cuando se borra una subida que citaba |
| Análisis de referencia | `packages/analyst/golden/<case>.json`, generados por `gemini-3.8-flash` y confirmados en el repositorio con id del modelo, fecha, versión del prompt y uso de tokens; solo se usan cuando la clave coincide con los documentos en pantalla |
| Etiqueta | La barra del análisis indica cuál: «Analysis by gemini-3.8-flash · <date> · cached» o «… · live» (versión del prompt y tokens al pasar el ratón) |
| Casos vinculados | Sus documentos incluyen datos en directo de PayPal y MeterMCP, así que los análisis de referencia no coinciden; el servidor alojado **precalienta** cada caso vinculado una vez tras el arranque o un cambio de vinculaciones (ejecuciones del sistema, mismos límites y topes) |

## Controles y límites

| Control | Valor |
|---|---|
| Análisis en directo | 6 por hora por servidor (`LIVE_ANALYSES_PER_HOUR`); en el modo alojado, 60 por día (`DAILY_LIVE_ANALYSES`) |
| Recomprobaciones | 30 por hora (`RECHECKS_PER_HOUR`); en el modo alojado, 200 por día (`DAILY_RECHECKS`) |
| Quién puede ejecutarlos (alojado) | El espacio de trabajo del vendedor, solo en casos vinculados |
| Cambios en las subidas | Un análisis que leyó una subida borrada entretanto se descarta (409 `UPLOAD_CHANGED`) |

**La detección es un aviso, no la defensa.** La marca se muestra en el documento (E6 en la demo). El análisis está
construido para que una instrucción no detectada no pueda cambiar la acción, el tipo de evidencia ni lo que cuenta
como respaldado; hasta qué punto se cumple se mide con conjuntos sintéticos en
[evaluaciones](../quality/evaluations.md), no se demuestra.

## Comandos

| Comando | Efecto | Coste |
|---|---|---|
| `npm test` | Tests del pipeline con un modelo falso | ninguno |
| `npm run evals -- --provider gemini\|groq` | Conjunto de desarrollo contra un proveedor | Cuota de pago de Gemini / Groq |
| `npm run evals:heldout` | Ejecuciones repetidas del conjunto reservado (held-out) | Cuota de pago de Gemini / Groq |
| `npm run evals:recompute` | Repuntuar los resultados guardados | ninguno |
| `npm run golden` | Regenerar los análisis de referencia o la caché | Llamadas de pago al modelo |

## Estado

Implementado · Probado en local (`packages/analyst/test/`: 152 tests superados el 19/10/2026, `fbe9621`) ·
Desplegado. Se ejecutaron análisis en directo y recomprobaciones en el servicio desplegado durante la evaluación en
sandbox (17/10/2026, evidencia privada). El párrafo del README de evaluaciones de commits anteriores queda sustituido
por [evaluaciones](../quality/evaluations.md).
