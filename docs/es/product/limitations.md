[English](../../product/limitations.md) | [Español](limitations.md)

# Limitaciones

Lo que ResolveKit no hace, todavía no hace o no se ha demostrado que haga. Comprobado frente al código en el commit
`f1b7236` (desplegado el 29/10/2026) y las listas de seguimiento de los mantenedores; las acciones de disputa, frente al
commit `076c74f` (20/10/2026). Los problemas de código para
colaboradores están en [Problemas conocidos](../quality/known-issues.md); esta página recoge lo que necesita saber un
usuario, un comerciante o un jurado.

## No disponible

| Función | Situación hoy | Estado |
|---|---|---|
| Conectar las disputas de PayPal propias de un comerciante | Un comerciante que inicia sesión con **Continue with PayPal** recibe la pantalla de espera. La app no tiene código de Partner Referrals, `merchant-integrations` ni `PayPal-Auth-Assertion`. Se hicieron experimentos en sandbox fuera de la app (ver [Alta de comerciantes](../technical/merchant-onboarding.md)); no son una función | **Pendiente** (no implementado, no desplegado, no disponible) |
| Enviar mensaje, aceptar la reclamación (total o parcial), hacer una oferta de reembolso parcial, escalar, evidencia tras un escalado | Construidos sobre contratos registrados y ejecutados con fakes; el 20/10/2026 cada uno se envió una vez por el flujo propio de la app en el sandbox y se releyó (el servidor de la rama ejecutado en local). El código está desplegado (`f1b7236`, 29/10/2026), pero estas acciones aún no se han ejercitado en el servicio alojado; las solo del Owner necesitan el caso de liquidación vinculado en el `BINDINGS_JSON` alojado, cosa que aún no ocurre. Estado por variante: [Especificación funcional](functional-specification.md#56-acciones-de-disputa-distintas-de-la-evidencia) | Verificado en sandbox · Desplegado (código); aún no ejercitado en el servicio alojado |
| Un mensaje con adjunto | La ruta del servidor y el editor web están probados (una subida confirmada del caso); un mensaje con archivo se envió a PayPal a través de la app en el sandbox (V-7, 21/10/2026, ejecución local) | Verificado en sandbox a través de la app (V-7); Desplegado (`f1b7236`, 29/10/2026), aún no ejercitado en el servicio alojado |
| Oferta de sustitución | No disponible: «Not verified with PayPal: never offered on a sandbox dispute» | No disponible |
| Retirar una oferta | No disponible: «PayPal documents no route to withdraw an offer» | No disponible |
| Apelación | No disponible: «Not verified with PayPal: the sandbox could not produce an appealable dispute» | No disponible |
| Prueba de reembolso (evidencia) | No disponible: «Not verified with PayPal: pending sandbox test (W-11)». Si PayPal solo pide esa, en esta entrega no se puede enviar evidencia en esa disputa | No disponible |
| Tipos con devolución (reembolso con devolución, etiqueta de envío de devolución) | No disponible: «Not in this delivery (owner decision)» | No disponible |
| `provide_supporting_info` | PayPal lo ofreció tras evidencia en una reclamación; ResolveKit no lo soporta | No disponible |
| Crear reembolsos | Ningún código crea o cambia un reembolso. El dinero solo se mueve con una aceptación total en PayPal, o cuando el comprador acepta una oferta. En el sandbox, un pago en disputa quedó retenido y no se pudo reembolsar fuera del caso (observado el 19/10/2026) | No previsto en esta entrega |
| PayPal live (producción) | Nada se ha ejecutado contra PayPal live. El modo alojado se niega a arrancar en `live` sin una activación explícita. «PayPal sandbox · live» significa una lectura en directo de una disputa del **sandbox** | **Pendiente** |
| Borrar una cuenta o un espacio de trabajo | El Owner puede revocar miembros e invitaciones; no hay borrado autoservicio de personas, espacios de trabajo ni ejecuciones del agente | **Pendiente** |
| Copias de seguridad | No hay código de copias de seguridad; los datos viven en el disco del servicio | **Pendiente** (ver [Copias de seguridad y recuperación](../operations/backup-and-recovery.md)) |

## Evaluación en sandbox

- **Solo los casos vinculados.** El espacio de evaluación solo ve los casos vinculados a disputas reales del sandbox
  (hoy un caso estándar y un caso de compra de agente); cualquier otro caso se abre en la Explore demo.
- **Una respuesta por disputa, según lo observado.** En nuestras pruebas en sandbox PayPal dejó de ofrecer
  `provide_evidence` tras un envío. Es una observación, no una regla documentada de PayPal. El caso muestra entonces
  **Evidence recorded by PayPal** y un borrador de solo lectura.
- **Las reservas están vacías** (a 29/10/2026, ambos casos): sus disputas ya se usaron, así que los nuevos envíos al
  sandbox real están **Pendiente**. Las disputas nuevas del sandbox se preparan el 31/10/2026 y la reserva se rellena
  para la evaluación el 28–30/11/2026; hasta entonces la ruta por defecto es la Explore demo. Un caso solo pasa a la siguiente
  disputa de su reserva si queda alguna, en su siguiente lectura, unos 15 minutos después de registrarse la evidencia.
- **Los documentos del caso son sintéticos.** Lo que subes es real en lo que hace; el pedido, la etiqueta, el registro
  del transportista y los mensajes del comprador que lo rodean son inventados, así que una captura real puede aparecer
  como contradicción.
- **Límites diarios compartidos** (día UTC, para todo el servidor): 60 análisis en directo, 200 recomprobaciones, 20
  envíos de evidencia, 40 subidas, 20 ejecuciones del agente (5 por persona), 20 presupuestos de MeterMCP; 20 envíos de mensajes y 20 acciones de liquidación (aceptar, ofertar, escalar). Por hora: 6
  análisis en directo y 30 recomprobaciones. Por dirección: 300 peticiones a la API y 60 lecturas de PayPal cada 5
  minutos; 20 subidas, tapados y lecturas de páginas de PDF cada 10 minutos. Un rechazo dice cuándo se restablece.
- **Los redespliegues** provocan 1–2 minutos de errores (un servicio con disco no tiene despliegue sin interrupción).
- **Qué commit está desplegado** no se puede demostrar desde fuera: `f1b7236` se trata como desplegado por la
  decisión del propietario de subirlo y un `demo:check` del 29/10/2026 correcto salvo la reserva vacía conocida del caso
  estándar (`c12faea` y `81c6242` el 21/10/2026, `5111b88` el 20/10/2026 y `fbe9621` el 19/10/2026 se trataron como desplegados del mismo modo).

## Acciones de disputa

- Solo el Owner puede aceptar, ofertar o escalar; los miembros y los revisores solo envían mensajes y ven una vista
  previa del resto. El caso de liquidación del propietario (`PP-R-STL-10190667`) existe para estas acciones; solo lo ve
  el Owner.
- Cada regla sale de una escritura registrada en el sandbox por variante (20/10/2026), todas en disputas de «artículo
  no recibido» en la fase de consulta, enviadas mientras PayPal esperaba al vendedor (un mensaje también mientras
  esperaba al comprador): otros motivos, fases y estados se rechazan, no se adivinan.
- Una aceptación parcial es una oferta que el comprador debe aceptar; por sí sola no reembolsa ni cierra nada.
- Un envío cuyo resultado PayPal aún no prueba retiene la disputa («Outcome pending confirmation») hasta que **Check
  again** lo resuelve; mientras tanto no se puede enviar nada más en esa disputa.
- Lo que hace el comprador tras una oferta (aceptar, rechazar, contraofertar) nunca se registró: ResolveKit sigue las
  acciones que PayPal ofrece en cada lectura fresca y, como respaldo (fallback), toma cualquier entrada de oferta
  posterior como fin de la oferta pendiente.

## Subidas de evidencia

| Límite | Valor |
|---|---|
| Imagen | PNG o JPEG, 5 MiB, como máximo 4096 px por lado y 8,294,400 píxeles (3840×2160) |
| PDF | 10 MiB y 30 páginas; se usan como máximo 5 páginas; un PDF cuenta como una subida |
| Archivo saneado guardado y enviado | menos de 9,900,000 bytes (PayPal acepta archivos de menos de 10 MB) |
| Todos los archivos de una respuesta | 50,000,000 bytes (PayPal: hasta 50 MB por llamada) |
| Texto pegado | 20,000 caracteres, **solo Latin-1** (un carácter como € o las comillas tipográficas se rechaza) |
| Tapados | 5 pasadas de tapado por imagen o texto; por página en un PDF |
| Por caso | 10 subidas (pendientes, en revisión y confirmadas) |
| Pendientes | se descartan a las 24 horas si no se confirman |

Carencias conocidas:
- Un escaneo de PDF de varias páginas con mucho ruido puede no caber en 9.9 MB una vez reconstruido; elige menos
  páginas.
- Los códigos de barras y QR conservan su contenido salvo que tapes el propio código.
- Enviar al sandbox de PayPal una subida PDF o un texto pegado: **Pendiente** (solo se ha verificado una subida de
  imagen, 18/10/2026).
- Uso de memoria de un PDF de 5 páginas en el servicio alojado: medición **Pendiente**.
- Si falla el archivado de las subidas de una disputa antigua, no se reintenta automáticamente.

## Análisis de IA

- Una cita literal prueba que las palabras están en el documento, no que el documento sea cierto ni que la frase se
  deduzca de él. El verificador es un modelo; sus veredictos pueden ser erróneos. Tú apruebas lo que se envía.
- Solo hay cifras para conjuntos de evaluación sintéticos; ver [Evaluaciones](../quality/evaluations.md). No compares
  tasas entre conjuntos distintos. La ejecución held-out en Groq se detuvo por cuota y no se ha reanudado.
- Los proveedores de modelos procesan lo que se les envía según sus propias políticas; ResolveKit no controla su
  retención.

## Agente comprador

- Dos ejecuciones observadas en sandbox (19/10/2026) son ejemplos, no una garantía de cómo se comporta el modelo. El
  modelo puede elegir mal dentro de los límites; el código solo comprueba cada acción.
- Aún no demostrado en el sandbox: **Stop** en una ejecución en curso, el respaldo de Groq, la recuperación tras un
  reinicio durante una ejecución, una captura que PayPal notifica como `PENDING` y el `demo-agent` de línea de comandos
  contra el MeterMCP alojado: **Pendiente**.
- El registro de ejecución del caso de agente (evidencia «From ResolveKit · run …») solo aparece cuando la vinculación
  del caso nombra la ejecución; ninguna vinculación lo hace todavía, y la vinculación del caso de agente apunta a una
  sesión hecha por el cliente con guion (scripted) anterior: **Pendiente**.
- Las ejecuciones del agente por persona se restablecen a medianoche UTC, no 24 horas después de la primera ejecución.
- Las salidas de las herramientas son sintéticas; los presupuestos son de 0.50–5.00 USD en el sandbox.

## Inicio de sesión y cuentas

- **Continue with PayPal** es una comprobación de identidad construida sobre un agreement token de Billing Agreements v1
  sin cargo (una familia de APIs de PayPal que figura bajo una ruta obsoleta), no Log in with PayPal ni OpenID
  Connect. No da a ResolveKit acceso a tus disputas.
- «Join for this browser only» dura una sesión (12 horas). Después, abre un enlace de invitación que aún tenga usos
  (esto crea una nueva entrada de miembro) o pide ayuda al Owner.
- Mientras se comprueba la conexión con PayPal de un espacio de trabajo nuevo, la pantalla vuelve a preguntar cada 5
  segundos.

## Comportamiento de PayPal del que dependemos pero que no controlamos

- Los tiempos (la aparición de una disputa nueva, los cambios de estado tras un envío) son lo que mostró el sandbox, no
  promesas.
- Una lista de disputas vacía no significa que no haya ninguna cuando el acceso es incierto.
- Un agotamiento de tiempo en un envío se trata como desconocido: ResolveKit relee antes de cualquier reintento. Este
  camino está probado con dobles (fakes); no se ha observado contra PayPal (**Pendiente**).
- Los ids de eventos de webhook solo se recuerdan en memoria (2,000): tras un reinicio, un evento repetido provoca una
  relectura inofensiva.

Ver también: [Solución de problemas](../user-guide/troubleshooting.md), [Problemas conocidos](../quality/known-issues.md),
[Especificación funcional](functional-specification.md).
