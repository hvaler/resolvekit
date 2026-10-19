[English](../../technical/paypal-integration.md) | [Español](paypal-integration.md)

# Integración con PayPal

Qué API de PayPal llama ResolveKit, con qué credencial, en qué se apoya y qué solo se ha observado en el sandbox.
Código en el commit `fbe9621`; documentación de PayPal consultada el 19/10/2026 (developer.paypal.com).

En esta página se separan tres tipos de afirmación:

- **Documentado**: lo dice PayPal, con enlace.
- **Observado en sandbox**: visto en nuestras propias pruebas en sandbox, con fecha. El comportamiento del sandbox no
  se generaliza a producción.
- **Desconocido**: ni documentado ni resuelto.

**Todo lo que sigue se ejecutó contra el sandbox de PayPal. Nada se ha ejecutado contra PayPal live.** La
etiqueta de la UI «PayPal sandbox · live» seguida de un id de disputa significa una lectura en directo de una disputa de
**sandbox**.

## Credenciales

| Credencial | Variables | Pertenece a | Se usa para |
|---|---|---|---|
| App del vendedor | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | La cuenta business de sandbox que es el vendedor en las disputas vinculadas («Test Store» en nuestro sandbox) | Lecturas de disputas, provide-evidence, verificación de webhooks (servidor); presupuestos, capturas, anulaciones (MeterMCP, la misma app); pagos de prueba (`demo:prepare`) |
| App de identidad | `PAYPAL_IDENTITY_CLIENT_ID`, `PAYPAL_IDENTITY_CLIENT_SECRET` | **Otra** cuenta business de sandbox (la plataforma) | **Continue with PayPal**: solo el token de acuerdo sin cargo. Debe ser distinta de la app del vendedor |
| App Platform (Partner) | ninguna | — | **Sin código.** Partner Referrals y `PayPal-Auth-Assertion` solo se probaron fuera de la app: ver [alta de comerciantes](merchant-onboarding.md) |

Cada cliente se autentica con credenciales de cliente OAuth 2.0 (`POST /v1/oauth2/token`), guarda el token en caché
y lo renueva 60 s antes de que caduque. Las peticiones expiran a los 30 s (ajuste de los servidores).

## Endpoints que se llaman realmente

| Endpoint | Quién llama | Credencial |
|---|---|---|
| `POST /v1/oauth2/token` | `packages/paypal/src/client.ts` | cada app la suya |
| `GET /v1/customer/disputes/{id}` | servidor: lectura del caso, composición, envío, comprobación de vinculaciones, relectura tras webhook; `demo:prepare` | app del vendedor |
| `GET /v1/customer/disputes?disputed_transaction_id={capture}` | solo `demo:prepare` | app del vendedor |
| `POST /v1/customer/disputes/{id}/provide-evidence` (multipart) | servidor, `POST /api/disputes/:case/evidence` | app del vendedor |
| `POST /v1/notifications/verify-webhook-signature` | manejador del webhook en el servidor | app del vendedor (el webhook está registrado en ella) |
| `POST /v1/billing-agreements/agreement-tokens`, `GET /v1/billing-agreements/agreement-tokens/{id}` | inicio de sesión en el servidor | app de identidad |
| `POST /v2/checkout/orders` (intent `AUTHORIZE`), `GET /v2/checkout/orders/{id}`, `POST /v2/checkout/orders/{id}/authorize` | presupuesto de MeterMCP | app del vendedor (en el servicio MeterMCP) |
| `GET /v2/payments/authorizations/{id}`, `POST …/capture`, `POST …/void`, `GET /v2/payments/captures/{id}` | liquidación y conciliación de MeterMCP | app del vendedor |
| `POST /v2/checkout/orders` (intent `CAPTURE`), `GET …`, `POST …/capture` | `demo:prepare` (el pago de prueba de 7.00 USD del caso estándar) | app del vendedor |

Definidos en `packages/paypal` pero **nunca llamados por ninguna ruta**: `send-message`, `accept-claim`. No hay
código para hacer una oferta, escalar ni reembolsar en ninguna parte. La pantalla de revisión lista las acciones que
PayPal permite sobre la disputa; si el comerciante elige una distinta de **Provide evidence**, el envío se bloquea
con «only "Provide evidence" can be sent from this screen for now».

## Comportamiento del cliente

| Comportamiento | Detalle |
|---|---|
| `PayPal-Request-Id` | En cada POST: el id de quien llama o uno aleatorio. Un intent conserva un único id para todos sus envíos. Si la API de Disputes deduplica con él **no está verificado**; el código vuelve a leer la disputa antes de cualquier reintento |
| 429 | Se reintenta hasta 3 veces con el mismo id y cuerpo, esperando `Retry-After` (≤ 5 s) |
| GET fallido | 408, 500, 502, 503, 504 se reintentan tras 300 ms y 900 ms |
| Otros errores | Se devuelven a quien llama como `PayPalError` con estado, cuerpo y `paypal-debug-id`; la API responde `{error, paypalIssue}` (p. ej. `EVIDENCE_TYPE_IS_NOT_ALLOWED`) |
| Verificación de webhooks | Sin reintento: una entrega que PayPal no puede confirmar en ese momento se responde con 503 y PayPal la vuelve a entregar |

## Disputas

### Lectura y mapeo

El servidor lee la disputa vinculada en fresco (reutilizada 60 s como entrada del analista) y mapea el estado, la
fase, el motivo, el tipo de artículo declarado por el comprador, las acciones permitidas al vendedor (a partir de los
`links` de la disputa: `provide_evidence`, `send_message`, `make_offer`, `accept_claim`, `escalate`), la evidencia
que solicita PayPal (`source: REQUESTED_FROM_SELLER`), cada entrada de evidencia con su fuente, la fecha límite de
respuesta y el merchant id del vendedor. Estado: Implementado · Probado en local · Verificado en sandbox (09/10,
17/10/2026) · Desplegado.

**Vinculaciones.** Un caso está vinculado a `{dispute, capture}`. En cada lectura fresca antes de componer y antes de
enviar, la disputa debe ser la vinculada, con exactamente una transacción disputada que sea la captura vinculada, y
con los importes disputado y bruto iguales al importe y la moneda del caso; si faltan datos, falla. Un caso puede
tener una **reserva** (una lista, la primera activa): una disputa usada (resuelta, o con evidencia del vendedor desde
hace más de 15 minutos) hace que el caso pase a la siguiente en su próxima lectura, si la reserva no está vacía. La
reserva del caso estándar estaba vacía el 19/10/2026 (los envíos nuevos quedan Pendientes hasta que se reponga).

### Envío de evidencia

`provide-evidence` es multipart: una parte JSON `input` con `{"evidences":[…]}` y una parte `evidence-file` por
archivo. ResolveKit envía `evidence_type`, `notes` (las frases respaldadas, ≤ 2 000 caracteres, un límite propio) y,
para la prueba de entrega, `evidence_info.tracking_info` con transportista y seguimiento (transportista `OTHER` con
`carrier_name_other: "Digital delivery"` para el caso del agente). Archivos: los PDF sintéticos del caso (con la
cabecera «SYNTHETIC TEST DOCUMENT»), el PDF real del recibo de MeterMCP para el caso del agente cuando existe una
sesión, y las subidas confirmadas seleccionadas como `E<n>-upload.png`, `E<n>-upload.pdf` o `E<n>-pasted.pdf` (el
nombre de archivo original nunca sale del servidor). Los bytes enviados son exactamente aquellos cuyo `sha256` cubre
la aprobación.

Documentado: provide-evidence acepta `multipart/form-data` con partes `evidence-file`; «In case the link is not
present in the response, you can't provide evidence for the dispute»; archivos `.jpg`, `.jpeg`, `.gif`, `.png`,
`.pdf`, «Less than 10 MB per file», «Up to 50 MB per API call»
([API de Disputes](https://developer.paypal.com/docs/api/customer-disputes/v1/),
[especificación](https://developer.paypal.com/api/customer-disputes/v1/schema.yaml),
[tipos y tamaños de archivo](https://developer.paypal.com/platforms/disputes/reference/supported-file-types-sizes)).
ResolveKit mantiene cada archivo guardado por debajo de 9.9 MB y todos los archivos de una respuesta por debajo de
50 000 000 bytes. Tipos de evidencia por motivo: [motivos y evidencia](https://developer.paypal.com/disputes/reasons-evidence/).

Tras un envío, el servidor responde `202 {sent:true}`; eso significa que PayPal aceptó la petición, no que la
evidencia haya quedado registrada ni que se haya ganado la disputa. La app web vuelve a leer la disputa y muestra
**Recorded by PayPal** solo para evidencia `SUBMITTED_BY_SELLER` / `PROVIDE_EVIDENCE` nueva que no estaba antes y que
coincide con lo enviado (tipo de evidencia, notas completas, transportista y seguimiento, nombres de archivo). La
evidencia nueva del vendedor que no coincide se muestra como tal y detiene cualquier reintento automático. Un timeout
no es ni éxito ni fallo: la app relee y solo ofrece un reintento seguro si PayPal no muestra evidencia del vendedor.
Estado: Implementado · Probado en local · Verificado en sandbox («6 of 6 fields», 17/10 y 18/10/2026, incluida una
imagen subida) · Desplegado. Comportamiento ante timeout contra PayPal: Pendiente.

### Ciclo de vida (documentado)

Fases `INQUIRY`, `CHARGEBACK` (una fase de disputa de PayPal, no un contracargo de tarjeta), `PRE_ARBITRATION`,
`ARBITRATION`; estados `OPEN`, `WAITING_FOR_BUYER_RESPONSE`, `WAITING_FOR_SELLER_RESPONSE`, `UNDER_REVIEW`,
`RESOLVED`, `OTHER`. «the `WAITING_FOR_SELLER_RESPONSE` status indicates that you need to provide evidence»; la fase
de consulta «lasts up to 20 days unless escalated». Enviar mensaje y hacer una oferta requieren la fase `INQUIRY`
([referencia de disputas](https://developer.paypal.com/docs/disputes/disputes-reference/),
[usar la API de Disputes](https://developer.paypal.com/platforms/disputes/handle-disputes/use-disputes-api)).

## Webhooks

`POST /api/paypal/webhook/<key>` existe en el modo alojado cuando `PAYPAL_WEBHOOK_ID` y `PAYPAL_WEBHOOK_KEY` están
definidas.

1. La clave de la ruta se compara en tiempo constante (cualquier otra clave: 404 antes de leer el cuerpo).
2. Las cinco cabeceras de transmisión deben estar presentes, con la URL del certificado en un host de la API de
   PayPal.
3. El cuerpo (≤ 64 KiB, leído en 10 s) debe ser un evento JSON con un id `WH-`. Solo se verifican los eventos
   `CUSTOMER.DISPUTE.*` con un id de disputa `PP-…`; los demás se responden con 200 y se ignoran. Un id de evento
   repetido se responde con 200 (memoria, 2 000 ids, se pierden al reiniciar: una relectura inofensiva).
4. La verificación está limitada para todos los que llaman (60 por minuto, 4 a la vez; por encima, 503) y usa el
   método de **postback** documentado por PayPal, `verify-webhook-signature`, con el cuerpo en bruto insertado byte a
   byte.
5. Después, 200, y el evento es solo una pista: el servidor vuelve a leer la disputa (tras 0, 2 y 10 s), descarta su
   lectura en caché, registra `paypal_notified` en la auditoría del espacio de trabajo del vendedor y conserva los
   últimos 50 avisos para ese vendedor.

Documentado: eventos `CUSTOMER.DISPUTE.CREATED`, `.UPDATED`, `.RESOLVED`
([nombres de eventos](https://developer.paypal.com/api/rest/webhooks/event-names/)); dos métodos de verificación, de
los cuales PayPal llama a la autoverificación «the preferred method»; el receptor debe responder 2xx y PayPal
reintenta «up to 25 times over 3 days»; los eventos simulados del simulador solo pueden autoverificarse, así que no
pasan la comprobación por postback de ResolveKit ([webhooks](https://developer.paypal.com/api/rest/webhooks/rest/)).
A qué eventos se suscribe el webhook registrado es un ajuste del lado de PayPal, no se comprueba en el código.

Estado: Implementado · Probado en local · Verificado en sandbox (eventos reenviados y una entrega automática,
17/10/2026) · Desplegado.

## Token de inicio de sesión (app de identidad)

**Continue with PayPal** crea con la app de identidad un token de acuerdo de Billing Agreements v1 sin cargo, envía
al comerciante a aprobarlo, lo vuelve a leer y toma `payer_info.payer_id`. No es Log in with PayPal ni un inicio de
sesión OpenID u OAuth para el comerciante; no se crea ningún acuerdo y no se cobra nada. Flujo y vinculación con el
navegador: [fronteras de confianza](../architecture/trust-boundaries.md#continue-with-paypal-inicio-de-sesión-del-owner-alojado).

Documentado: Log in with PayPal es el producto de identidad de PayPal («OAuth 2.0 and OpenID Connect»,
[Log in with PayPal](https://developer.paypal.com/docs/log-in-with-paypal/)); Billing Agreements v1 aparece bajo una
ruta obsoleta ([Billing Agreements](https://developer.paypal.com/docs/api/payments.billing-agreements/v1/)); no se
encontró ninguna página de referencia actual para los tokens de acuerdo (19/10/2026). Observado en sandbox
(10/10/2026): un token aprobado se releyó como `APPROVED` con un `payer_id` que, para una cuenta business, coincidía
con el merchant id del vendedor en sus disputas; el userinfo de Log in with PayPal respondió 400; un vendedor no pudo
aprobar un token de su propia app. Estado: Implementado · Probado en local · Verificado en sandbox · Desplegado. Este
enfoque podría dejar de funcionar (familia obsoleta).

## Pedidos y pagos (MeterMCP)

| Paso | Llamada | Detalle |
|---|---|---|
| Presupuesto | `POST /v2/checkout/orders` `AUTHORIZE` | Un artículo `DIGITAL_GOODS`, `custom_id` = id de la sesión, `NO_SHIPPING`, retorno/cancelación en MeterMCP |
| Comprobación de la aprobación | `GET` del pedido, `POST …/authorize` | Abre la sesión solo con exactamente una autorización `CREATED` por exactamente el tope, del pedido propio, con `expiration_time` futura |
| Liquidación | `POST /v2/payments/authorizations/{id}/capture` con `final_capture: true` | Exactamente la suma de las llamadas OK; `invoice_id <session>-settle` |
| Nada usado | `POST …/void` | |
| Captura pendiente | `GET /v2/payments/captures/{id}` | Cada 30 s, bajo demanda, al cerrar |

Documentado: «An authorization places a hold on the funds and is valid for 29 days», con un periodo de cortesía de 3
días ([autorización](https://developer.paypal.com/docs/checkout/standard/customize/authorization/)); «You can
capture any amount up to the authorized total», «The remainder can be voided or left to expire»
([captura diferida](https://developer.paypal.com/checkout/delay-capture/)); `final_capture` «Indicates whether you
can make additional captures against the authorized payment»
([especificación de Payments v2](https://developer.paypal.com/api/payments/v2/schema.yaml)). Observado en sandbox
(08/10, 09/10 y 19/10/2026): una captura parcial con `final_capture: true` dejó la autorización en `CAPTURED` y el
resto dejó de estar retenido; una autorización sin usar se anuló y pasó a `VOIDED`. Que el resto se libera al
comprador está observado, no citado de PayPal. Resultados `PENDING` de captura: no observados, Pendiente.

## Hallazgos en sandbox

Traídos aquí desde el antiguo `docs/sandbox-findings.md`. Verificados a mano en el sandbox de PayPal con una app de
sandbox, una cuenta de prueba business y una cuenta de prueba personal (compradora). Son observaciones, no reglas de
PayPal.

### 08/10/2026

| Hallazgo | Consecuencia de diseño |
|---|---|
| La lista simple de disputas no incluye `disputed_transactions`; hay que filtrar con `disputed_transaction_id={capture}` | Buscar las disputas por captura |
| Una disputa abierta por el comprador tardó unos 5 minutos en aparecer en la API (PayPal: «wait a few minutes», [test and go live](https://developer.paypal.com/platforms/disputes/test-go-live)) | Estado «Syncing with PayPal»; las disputas de demo se crean con antelación |
| Una disputa nueva muestra primero `UNDER_REVIEW` sin acciones del vendedor y después `WAITING_FOR_SELLER_RESPONSE` | Estado «PayPal is processing this new dispute» |
| Cada disputa lista la evidencia que PayPal solicita al vendedor (`source: REQUESTED_FROM_SELLER`) | Mostrar «PayPal is asking for…» y enviar ese tipo |
| Para «item or service not received», PayPal solicitó `PROOF_OF_FULFILLMENT` incluso cuando el comprador declaró un servicio, y rechazó `PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED` con `EVIDENCE_TYPE_IS_NOT_ALLOWED` (coherente con la tabla de motivos de PayPal, que no lista ese tipo para este motivo) | El tipo de evidencia sigue la solicitud de PayPal; la entrega digital va como transportista `OTHER` con una referencia |
| El tipo de artículo (físico, descarga digital, servicio, reserva) lo elige el comprador en el formulario de la disputa, no es la categoría del artículo del pedido | Mostrar el tipo de artículo declarado por el comprador en la cabecera del caso |
| `provide-evidence` acepta multipart: parte JSON `input` (`{"evidences":[…]}`) y partes `evidence-file` (PDF/JPG/PNG/GIF) | Implementado en `packages/paypal` |
| Tras enviar la evidencia, `provide_evidence` desapareció de las acciones de la disputa; el estado pasó a `WAITING_FOR_BUYER_RESPONSE` o `UNDER_REVIEW` | Confirmación de acción irreversible; releer y mostrar el estado registrado. «Una vez por disputa» es esta observación, no una regla documentada |
| En la fase de consulta, el vendedor tenía `send_message`, `make_offer`, `accept_claim`, `provide_evidence`, `escalate` | La pantalla de revisión lista las acciones permitidas; solo está construido provide-evidence |
| Los reembolsos parciales sobre una captura se completaron de inmediato (a mano) | Ninguna: ResolveKit no tiene código de reembolso |
| Una disputa real siempre lista la entrada propia del comprador (`evidence_type: CREATE`, `source: SUBMITTED_BY_BUYER`) junto a la solicitud de PayPal (`REQUESTED_FROM_SELLER`, sin documentos) | «Recorded» (registrado) es solo la evidencia `SUBMITTED_BY_SELLER` nueva comparada con la lectura previa al envío |

### 09/10/2026: envío de extremo a extremo a través de ResolveKit

Se envió `PROOF_OF_FULFILLMENT` (seguimiento de UPS, notas de 502 caracteres, dos PDF generados) a una disputa de
«not received» en `WAITING_FOR_SELLER_RESPONSE` a través de `apps/server`, con nuestro propio `PayPal-Request-Id`. El
envío tardó unos 1.9 s (lectura y POST multipart); PayPal lo aceptó, y la relectura, unos 2.5 s después, ya mostraba:

| Hallazgo | Consecuencia de diseño |
|---|---|
| La entrada del vendedor volvió como `source: SUBMITTED_BY_SELLER`, `action_info.action: PROVIDE_EVIDENCE`, con el seguimiento, las notas literales y `documents[]` (nombre de archivo y URL de descarga) | La relectura compara tipo, transportista, seguimiento, nombres de archivo y las notas completas; los seis campos coincidieron |
| Justo después del envío, el estado era `UNDER_REVIEW` sin acciones del vendedor; alrededor de un minuto después, `WAITING_FOR_BUYER_RESPONSE` con `send_message`, `accept_claim`, `escalate` | Mostrar el estado que devuelve PayPal en el momento de la relectura; no inferir nunca el estado final. Los tiempos varían |
| Una vez dentro la evidencia del vendedor, dejaron de devolverse la entrada `REQUESTED_FROM_SELLER` y `seller_response_due_date` | «No se solicita nada» no significa que PayPal pida algo; la fecha límite sale de la cabecera del caso |

### 10/10 a 19/10/2026

| Fecha | Observación |
|---|---|
| 10/10 | El enfoque del token de identidad funciona en el sandbox (ver arriba) |
| 17/10 | Dos revisores enviaron evidencia a través del servicio desplegado; relectura «Recorded by PayPal», 6 de 6 campos. Entregas de webhook verificadas |
| 18/10 | PayPal registró un PNG subido y tapado como `E7-upload.png`; la copia de PayPal solo contenía los chunks de imagen del PNG, con la tapa incrustada |
| 18/10 | Pruebas de acceso de plataforma / terceros fuera de la app: [alta de comerciantes](merchant-onboarding.md) |
| 19/10 | Dos ejecuciones del agente dirigido por el modelo se liquidaron en el sandbox: [agente comprador](buying-agent.md) |

## Desconocido y no afirmado

- Si, en general, se puede aportar evidencia más de una vez por disputa o por fase.
- Si la API de Disputes deduplica `PayPal-Request-Id` (PayPal: «Not all APIs support this header»,
  [idempotencia](https://developer.paypal.com/api/rest/reference/idempotency/)).
- Cualquier límite de longitud de las notas en el lado de PayPal; el tope de 2 000 caracteres es de ResolveKit.
- El número máximo de archivos por llamada.
- El comportamiento en el entorno de producción de todo lo que aparece en esta página.
