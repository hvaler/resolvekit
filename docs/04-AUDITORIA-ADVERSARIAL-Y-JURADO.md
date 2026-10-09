# ResolveKit — auditoría adversaria, revisión como jurado y traspaso de trabajo

**Fecha:** 9 de octubre de 2026 (Europe/Madrid)  
**Repositorio auditado:** `C:\nexus\dev\resolvekit`  
**Demo publicada examinada:** https://resolvekit-i3j2.onrender.com/  
**Estado de este informe:** hallazgos de código y pruebas reproducibles; observaciones de interfaz pública; sin operaciones de pago ni envío de evidencia real.

## 0. Resumen para la siguiente sesión

ResolveKit es una aplicación funcional de revisión de disputas con un analista de IA que cita documentos, un flujo de aprobación visual y una pasarela MeterMCP que autoriza un presupuesto en PayPal, cobra llamadas exitosas y produce un recibo. La implementación es sustancial: 304 pruebas pasan, el chequeo de tipos pasa y el frontend compila. El problema principal es una **brecha entre la promesa de producto y la frontera de confianza del servidor**: las restricciones «solo afirmaciones sustentadas y aprobadas» existen en la interfaz, pero la ruta que escribe en PayPal no las impone.

**Orden recomendado:**

1. Cerrar en servidor la autorización del contenido exacto que se envía a PayPal (H1).
2. Bloquear vinculaciones de disputa incorrectas antes de cualquier envío (H2).
3. Separar capturas `PENDING` de capturas `COMPLETED` y reconciliarlas (H3).
4. Confirmar el estado real del despliegue: en mi visita pública los casos examinados se presentaban como `Simulated PayPal`, pese a que el repositorio documenta casos vinculados (D1).
5. Corregir la atribución del read-back, poner límites globales a sesiones MCP y preparar los entregables Devpost.

Este documento está pensado para que otra sesión implemente y verifique los cambios. No exige rehacer la interfaz ni añadir ideas de producto nuevas.

## 1. Alcance y nivel de evidencia

Se leyó el código de `apps/server`, `apps/metermcp`, `packages/paypal`, `packages/analyst`, `packages/hosting`, el flujo web y la documentación. Se comparó con las [reglas oficiales de Devpost](https://paypalaihackathon.devpost.com/rules) y la [documentación de estados de captura de PayPal](https://developer.paypal.com/docs/multiparty/checkout/apm/reference/subscribe-to-webhooks/).

Se ejecutó `npm test` completo con **304 pruebas aprobadas**: PayPal 13, hosting 11, casos 6, analista 35, servidor 80, MeterMCP 32 y web 127. También pasaron `npm run typecheck` y `npm run build`. El primer intento de pruebas falló porque el sandbox de auditoría impedía escribir temporales; al usar un directorio temporal autorizado y permitir a Vite generar su configuración, pasó la batería completa. Por tanto, aquel fallo inicial no es un defecto del proyecto.

Una búsqueda de patrones comunes de secretos en el código fuente, excluyendo `.env` y datos de resultados, no encontró coincidencias. `npm audit --offline` informó cero vulnerabilidades en la base local; el resultado offline no sustituye una consulta actualizada. No se inspeccionaron ni reprodujeron credenciales. No se hizo una prueba de carga, un pago ni un envío a PayPal.

**Niveles de confianza empleados:** `confirmado por código` indica que el flujo se deduce directamente de rutas y estados; `observado en demo` indica una pantalla vista en el sitio publicado; `riesgo potencial` necesita una prueba de carga o un estado externo para cuantificarse.

## 2. Hallazgos adversarios

### H1 — Alta: el servidor permite saltarse la verificación y aprobación de afirmaciones

**Evidencia:** `apps/server/src/validate.ts:23-85` valida forma, caracteres, longitud, tipo de evidencia y estado de PayPal. `apps/server/src/app.ts:304-391` recibe `notes` del cliente y lo pasa a `paypal.disputes.provideEvidence` sin comparar ese texto con las frases respaldadas del análisis ni exigir una aprobación persistida. El filtrado de frases y el checkbox se encuentran en `apps/web/src/domain/draft.ts:86-94` y `apps/web/src/components/ApproveFlow.tsx:203-207`.

**Escenario adversario:** un visitante autorizado con el código de demo obtiene la cookie y envía un JSON válido directamente a `/api/disputes/:caseId/evidence`, con una nota no sustentada. El servidor comprueba que el caso esté vinculado, que PayPal permita aportar evidencia, que el tipo sea aceptable y que el texto no exceda 2.000 caracteres; no comprueba que haya pasado el analista ni la revisión humana de la UI. La barrera del código de demo limita quién puede hacerlo, pero no protege la integridad de la evidencia entre usuarios autorizados.

**Impacto:** envío irreversible de una afirmación falsa bajo la marca de un producto que promete que ninguna afirmación no respaldada sale hacia PayPal. Este hallazgo no afirma que un atacante anónimo pueda enviar evidencia sin código.

**Cambio propuesto:** crear en servidor una `submission intent` ligada a `caseId`, disputa PayPal, firma del conjunto de documentos, texto exacto, archivos, tipo de evidencia y usuario/sesión autorizada. Generar allí mismo las notas a partir de las frases verificadas o volver a verificar cada frase editada. Al confirmar, firmar o persistir la intención; en `/evidence`, aceptar únicamente su identificador y rechazar cualquier diferencia de contenido, documento, vínculo o estado. Registrar en servidor quién aprobó y qué hash aprobó. Para la hackathon basta un flujo de demo con cookie y aprobación de intención; no hace falta introducir un sistema multiempresa completo.

**Criterio de aceptación:** una prueba de API con PayPal simulado intenta enviar una nota arbitraria y recibe 4xx sin llamada `provide-evidence`; la misma prueba con intención aprobada envía exactamente el texto y archivos aprobados; editar una frase tras aprobar invalida la intención; dos confirmaciones concurrentes no producen dos envíos.

### H2 — Alta: una vinculación equivocada solo se advierte en el log

**Evidencia:** `apps/server/src/bindings.ts:19-34` lee cada disputa al iniciar y compara el importe, pero solo registra `MISMATCH`. `apps/server/src/app.ts:331-381` usa después el ID vinculado sin bloquear por la alerta. La comprobación de importe ni siquiera distingue dos disputas de igual cuantía.

**Escenario adversario/operativo:** `BINDINGS_JSON` apunta un caso de 7 USD a otra disputa de 7 USD o a una de importe distinto. La UI conserva los documentos sintéticos del caso local y el endpoint puede enviarlos a esa disputa real si PayPal permite la acción.

**Impacto:** evidencia de un comprador u operación presentada en una disputa ajena. El error puede ser de configuración; la consecuencia es grave porque el envío no se deshace.

**Cambio propuesto:** mantener un estado de vínculo `verified/invalid/unavailable`; exigirlo justo antes de enviar, con lectura fresca. Verificar al menos disputa esperada, captura/transacción del vendedor, moneda e importe, y una referencia de pedido inequívoca cuando esté disponible. Si falta un dato necesario, fallar cerrado. Al cambiar `BINDINGS_JSON`, invalidar verificaciones previas. No usar la verificación de arranque como único control.

**Criterio de aceptación:** pruebas de vínculo con importe distinto, mismo importe pero captura distinta, moneda distinta y disputa no accesible terminan en 409/422 sin `provide-evidence`; un vínculo correcto sí progresa. La UI explica por qué se bloqueó.

### H3 — Alta: `PENDING` se registra y presenta como captura consumada

**Evidencia:** `apps/metermcp/src/meter.ts:439-457` acepta respuesta de captura con `status === 'PENDING'` o `COMPLETED` y llama en ambos casos a `ledger.settled`. `apps/metermcp/src/receipt.ts:61-116` convierte `settled` en `captured`, calcula el remanente como liberado y prepara un recibo que puede enviarse como evidencia. PayPal distingue `PAYMENT.CAPTURE.PENDING` de `PAYMENT.CAPTURE.COMPLETED`; la primera indica que la iniciación tuvo éxito pero la finalización sigue pendiente ([PayPal](https://developer.paypal.com/docs/multiparty/checkout/apm/reference/subscribe-to-webhooks/)).

**Impacto:** recibo y disputa que afirman «cobrado» y «remanente liberado» antes de confirmar el resultado financiero. El código conserva `capture_status`, lo que ayuda al diagnóstico, pero el estado de sesión y la redacción final contradicen ese dato.

**Cambio propuesto:** introducir un estado `capture_pending` distinto de `settled`; no emitir lenguaje de cobro final ni de remanente liberado mientras PayPal responda `PENDING`. Consultar el recurso de captura y/o procesar webhooks verificados para transicionar a `COMPLETED`, `DECLINED` o `FAILED`; hacer la reconciliación idempotente. La disputa no debe usar el recibo como prueba de cobro final antes de la confirmación.

**Criterio de aceptación:** prueba con PayPal simulado que devuelve `PENDING`: el ledger y el recibo dicen pendiente, `remainder_released` es falso, y la transición posterior a `COMPLETED` cambia una sola vez a cobrado. Un rechazo posterior conserva evidencia histórica del intento, sin afirmar cobro.

### M1 — Media: el read-back puede atribuir evidencia de otra operación

**Evidencia:** `apps/web/src/domain/recorded.ts:24-33` identifica cualquier evidencia nueva del vendedor respecto al snapshot previo. `apps/web/src/domain/gateway.ts:65-94` clasifica eso como `recorded`, incluso en un reintento, sin requerir coincidencia con la solicitud actual.

**Impacto:** si dos operadores o procesos actúan sobre una misma disputa, la pantalla puede atribuir al envío propio una entrada que hizo otro. La pantalla de comparación puede mostrar diferencias, pero la clasificación inicial ya es positiva.

**Cambio propuesto:** comparar la nueva entrada con el tipo, notas, tracking y archivos esperados, o devolver un estado explícito `new_seller_evidence_but_mismatch`. Preservar el identificador idempotente y el baseline. Una evidencia diferente debe detener reintentos automáticos y pedir revisión.

**Criterio de aceptación:** prueba de concurrencia simulada donde aparece evidencia ajena; el resultado no dice «registrado nuestro envío».

### M2 — Media, riesgo potencial: sesiones MCP en memoria sin límite global

**Evidencia:** `apps/metermcp/src/mcp.ts:83-119` crea servidor y transporte por inicialización y los conserva en `Map` hasta cierre. `apps/metermcp/src/app.ts:104-139` limita `/mcp` por IP, pero no define máximo global de sesiones vivas. La barrida de `apps/metermcp/src/main.ts:80` cierra sesiones de pago ociosas; no se observa que cierre transportes MCP sin uso.

**Impacto:** un cliente que inicializa muchas sesiones, o varios clientes desde IP distintas, puede consumir memoria. No se ha medido el umbral real.

**Cambio propuesto:** máximo global y por IP de sesiones inicializadas; caducidad de transporte por inactividad; cierre seguro de sesiones de pago asociadas; métricas de sesiones vivas y rechazos.

**Criterio de aceptación:** prueba de inicializaciones repetidas que nunca supera el máximo y permite nuevas sesiones tras la caducidad.

### M3 — Media para producto comercial: aprobación e historial solo en el navegador

**Evidencia:** `apps/web/src/app/services.tsx:197-199` incorpora entradas de auditoría en estado React; `apps/web/src/components/ApproveFlow.tsx:203-207` añade «Approved submission» tras marcar la confirmación. No representa una autorización durable e inalterable en el servidor.

**Impacto:** la historia visible puede perderse al recargar y no prueba quién aprobó la evidencia enviada. Para una demo unipersonal es aceptable; para un servicio de disputas real no.

**Cambio propuesto:** persistir el evento de aprobación, hash de contenido, actor, instante, disputa, resultado PayPal e identificador idempotente en el servidor. Mostrar ese evento en la UI en lugar de un registro local como fuente de verdad.

## 3. Observación de la demo publicada

El 9 de octubre de 2026 abrí https://resolvekit-i3j2.onrender.com/ en el navegador integrado. La SPA cargó, sincronizó su bandeja y mostró ocho casos, filtros, búsqueda, totales y navegación con teclado/doble clic. Abrí `PP-R-MMC-10190702` (compra con agente) y `PP-R-TVH-10190665` (entrega con contradicción de dirección). En el primero vi recibo por llamada, fallo no cobrado, frases respaldadas y dos frases rechazadas; en el segundo, `Apt 4` frente a `Apt 4B`, un adjunto con instrucción maliciosa marcado como contenido, y la frase sin prueba del supuesto teléfono. El flujo `Review what will be sent` mostraba las cinco frases que se incluirían, sus fuentes y el texto exacto de notas. No avancé al envío.

**Señal que requiere revisión de despliegue (D1):** la cabecera de la bandeja y de ambos casos mostraba `Simulated PayPal`; el caso estándar etiquetaba la captura como `Simulated PayPal · demo data`; el caso de agente etiquetaba sus cuatro documentos como `Demo data`. En la visita no apareció un distintivo de disputa vinculada en vivo. Esto **no demuestra que el backend carezca de credenciales o bindings**: la API directa `/api/health` no fue accesible desde el navegador de auditoría y no se usó el código de demo. Sí demuestra que, para este visitante, el recorrido público observado era simulado, mientras que `docs/judges.md` describe dos casos marcados `PayPal sandbox · live`.

**Acción D1:** comprobar en el despliegue `GET /api/health`, los logs de lectura de bindings, `BINDINGS_JSON`, credenciales sandbox y el distintivo de cada caso. Asegurar que las instrucciones Devpost describen el estado que el juez realmente verá. Si el servidor está intencionalmente en simulación, indicarlo con claridad y ofrecer un caso de PayPal real reproducible antes de afirmar integración viva en la demo.

No tenía el código de demo ni una cuenta compradora sandbox de pruebas. Por eso no se verificaron en producción un nuevo análisis de IA, un envío de evidencia, la aprobación de presupuesto MCP ni una captura. El contenido cacheado visible en la página acredita que la UI reproduce análisis almacenados; no prueba por sí solo una ejecución reciente del modelo en ese despliegue.

## 4. Fortalezas verificadas

- Integración PayPal no trivial: disputas, validación de acciones y tipo de evidencia, envío multipart, `PayPal-Request-Id`, Orders `AUTHORIZE`, captura parcial final y anulación si no hubo consumo.
- MeterMCP usa importes enteros en céntimos y reserva transaccional antes de llamar a una herramienta; las pruebas cubren concurrencia, fallo de herramienta, sobrepresupuesto y reintento de liquidación.
- La API local y alojada comprueban `Host`/`Origin`; la demo alojada exige código para acciones costosas, usa cookie `HttpOnly`, `Secure`, `SameSite=Strict`, límites diarios y por IP. Ambos listeners limitan el cuerpo a 256 KB.
- El analista comprueba citas textuales, rechaza frases sin fuente, eleva contradicciones a revisión y detecta múltiples estilos de prompt injection. Los resultados de evaluación publican tanto aciertos como fallos.
- La interfaz integra AG Grid Community para búsqueda, filtros, ordenación, totales y recibos. Las pantallas revisadas muestran de forma comprensible qué se envía y qué se rechaza.

Estas fortalezas no anulan H1–H3: son controles diferentes en fronteras diferentes.

## 5. Revisión como jurado de la hackathon

Las [reglas oficiales](https://paypalaihackathon.devpost.com/rules) exigen PayPal y AI centrales, demo funcional, repositorio público con licencia y vídeo público de YouTube de menos de tres minutos. La primera criba temática se superaría en principio: ambas tecnologías intervienen en el flujo principal. La valoración numérica es **provisional**, no una predicción de premio.

| Criterio, mismo peso en Devpost | Nota provisional / 5 | Justificación |
|---|---:|---|
| Implementación tecnológica | 4,0 | Arquitectura y pruebas fuertes; H1–H3 reducen confianza en envío y liquidación. |
| Diseño | 4,0 | Flujo coherente y visualmente claro. La interfaz pública observada funciona, aunque no se completó una operación externa. |
| Impacto potencial | 3,0 | Problema concreto para comerciantes; los documentos y casos siguen predefinidos, sin carga de evidencia propia ni incorporación de comercios. |
| Innovación | 3,5 | Análisis de disputas con IA es una categoría existente; el vínculo entre comercio agéntico, presupuesto, llamadas MCP y recibo probatorio diferencia esta demo. |
| Presentación | No calificable | No se inspeccionó vídeo final ni ficha Devpost; las instrucciones en `docs/judges.md` aún tienen placeholders. |

**Posibles premios especiales:** PayPal + AI y Agentic Commerce por el flujo central; AG Grid y Render por uso real de ambas herramientas. Elegibilidad no equivale a competitividad ni a premio. El jurado puede basarse solo en vídeo e imágenes, así que una demo pública simulada sin narración clara de lo que es real puede perjudicar especialmente presentación e implementación.

**Limitación de producto:** `apps/server/src/documents.ts` genera PDFs de datos sintéticos del repositorio y el navegador no sube bytes reales. Es una decisión correcta para una demo controlada, pero no una solución comercial completa para evidencias de comerciantes. Las evaluaciones del analista cubren 18 casos ficticios; Gemini ofrece buenos resultados en ese conjunto y el último run de Groq cubrió 7/18 por cuota. Véase `docs/evals.md`. No trasladar esos porcentajes a precisión en producción.

## 6. Entrega Devpost: comprobaciones pendientes

1. Publicar y verificar una URL de repositorio visible sin inicio de sesión, con `LICENSE` detectable. El archivo MIT existe localmente; no se pudo confirmar el estado público del repositorio.
2. Reemplazar los placeholders de `docs/judges.md` en las instrucciones finales y probarlas desde un navegador limpio.
3. Confirmar que la demo ofrece al menos un caso vinculado visible a PayPal Sandbox o explicar de manera exacta qué acciones puede repetir el juez. Mantener acceso gratuito hasta el fin del periodo de evaluación, según las reglas.
4. Producir vídeo público en YouTube de menos de tres minutos que muestre: disputa real leída, contradicción, frase falsa eliminada, aprobación humana, envío y read-back; si se muestra MeterMCP, distinguir outputs sintéticos de transacciones PayPal sandbox reales.
5. Verificar que el código de demo, cuenta compradora sandbox y límites se comunican de modo seguro y funcional a los jueces; no poner secretos reales en el repositorio.
6. Revisar que `PAYPAL_ENV` permanece en `sandbox` en el despliegue de hackathon. `render.yaml` lo fija así, pero `apps/server/src/main.ts:30` y `apps/metermcp/src/main.ts:29` aceptan `live` si una variable se cambia.

## 7. Instrucción sugerida para la sesión que continúa

> Implementa H1, H2 y H3 de `docs/04-AUDITORIA-ADVERSARIAL-Y-JURADO.md` en ese orden. Mantén el flujo actual de la demo, añade pruebas con PayPal simulado para cada criterio de aceptación, ejecuta los 304 tests, typecheck y build. Después investiga D1 en el despliegue `https://resolvekit-i3j2.onrender.com/` y actualiza las instrucciones para jueces según el estado real. No envíes evidencia ni hagas capturas de pago sin una instrucción específica del usuario; las pruebas deben ser locales con fakes. Informa por separado de cambios confirmados, riesgos restantes y comprobaciones que dependen de credenciales o infraestructura.

## Referencias clave de código

- `apps/server/src/app.ts` — rutas, envío a PayPal, gate de la demo.
- `apps/server/src/validate.ts` — validación de la solicitud.
- `apps/server/src/bindings.ts` — comprobación actual de vínculos.
- `apps/web/src/components/ApproveFlow.tsx` y `apps/web/src/domain/draft.ts` — aprobación y composición de notas en navegador.
- `apps/web/src/domain/gateway.ts` y `apps/web/src/domain/recorded.ts` — envío, reintento y read-back.
- `apps/metermcp/src/meter.ts`, `ledger.ts`, `receipt.ts` — captura, estados y recibo.
- `apps/metermcp/src/mcp.ts` — ciclo de vida de transportes MCP.
- `docs/judges.md`, `docs/evals.md`, `render.yaml` — instrucciones, métricas y despliegue.
