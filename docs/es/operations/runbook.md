[English](../../operations/runbook.md) | [Español](runbook.md)

# Runbook

Operación diaria de la demo alojada: comprobarla, leer sus señales, gestionar rechazos, trabajo en segundo plano,
rotación de disputas y reserva. El despliegue está en [Despliegue](deployment.md); las copias de datos, en
[Copias de seguridad y recuperación](backup-and-recovery.md).

## Disponibilidad no es preparación funcional

| Señal | Qué demuestra | Qué no demuestra |
|---|---|---|
| `GET /healthz` 200 (cualquiera de los servicios) | El proceso está en marcha y responde. El health check de Render lo usa; no necesita coincidencia de Host y no cuesta nada | Que PayPal, los modelos, las vinculaciones o el disco funcionen |
| `GET /api/health` (ResolveKit) | El estado de PayPal tal como lo vio el servidor la última vez; los casos vinculados solo para el espacio de trabajo del vendedor | Health dice `unconfigured` hasta que la primera llamada a PayPal tiene éxito (comprobación diferida, con reintentos) |
| `GET /health` (MeterMCP) | `{ok, paypal, mcpSessions, mcpRejected, mcpExpired}` | Que ahora mismo se pueda aprobar o capturar un presupuesto |
| `npm run demo:check` → `READY` | Todas las líneas de abajo pasaron en ese momento | Qué commit está desplegado; que PayPal vaya a aceptar el próximo envío; que el navegador o la cuenta de PayPal de un revisor funcionen |
| Evidencia de un revisor mostrada como **Recorded by PayPal** (registrada por PayPal) | PayPal devolvió nueva evidencia del vendedor coincidente en la relectura | Que la disputa esté resuelta o ganada |

## La comprobación del operador: `npm run demo:check`

```bash
npm run demo:check                    # needs RESOLVEKIT_OPS_TOKEN in .env (exit 2 without it)
npm run demo:check -- --no-models     # skip the model probes
npm run demo:check -- --app https://<resolvekit host> --metermcp https://<metermcp host>
```

Qué hace (`apps/server/scripts/demo-check.ts`, `demo-check-lib.ts`, `apps/server/src/hosted.ts`):

- Envía el token solo por https o a esta misma máquina; si no, sale con código 2. Por defecto usa los hosts de la demo
  pública.
- En paralelo: `GET <app>/healthz`, `GET <app>/` (debe contener «ResolveKit»), `GET <metermcp>/healthz`, y
  `GET <app>/api/ops/status?probe=models` con `Authorization: Bearer <token>` (timeout de 120 s). Sin el token en el
  servidor, o con uno distinto, la ruta de ops responde 404.
- Imprime una línea `PASS`, `WARN` o `FAIL` por elemento y después `READY` o `NOT READY`. Sale con 0 solo cuando todas
  las líneas pasaron; `WARN` (menos de 2 disputas restantes en la reserva de un caso) sigue pasando.

**No está libre de efectos secundarios.** «Solo lectura» es cierto para lo que envía el script, no para el estado del
servidor:

| Efecto | Por qué | Cómo evitarlo |
|---|---|---|
| **Una llamada a modelo por proveedor configurado** (Gemini y/o Groq), cada una por separado, sin reintento ni respaldo (fallback), timeout de proveedor de 20 s, 30 s en total, 256 tokens de salida como máximo | `?probe=models` está activado por defecto | `--no-models` |
| **Lecturas nuevas de PayPal de todas las disputas vinculadas** | El informe de ops verifica cada vinculación con una lectura nueva | — |
| **Un caso usado puede rotar a su siguiente disputa de reserva, y entonces el caso se vuelve a analizar en directo** (un precalentamiento: llamadas a modelos, contadas en el límite horario y en el tope diario) | Esas lecturas pasan por el mismo código que cualquier lectura de caso, que rota una disputa usada (consulta [Rotación de disputas](#rotación-de-disputas-y-reserva)) | Cuenta con ello después de una sesión de revisión; comprueba antes la reserva |
| Cuenta contra el límite de frecuencia de ops/auth (40 por dirección cada 15 min) | Cubo compartido con `POST /api/auth/*` | No lo ejecutes en bucle |

La salida contiene ids de disputas y capturas del sandbox: no la pegues en lugares públicos.

Ejecútalo después de cada despliegue y a diario durante la evaluación del jurado. Para interpretar las líneas `FAIL`: la
redacción propia del servidor va tras `server reports` (por ejemplo `binding … is used … and no dispute is left in
reserve`, `the PayPal webhook is off`, `AI model …: …`, `warm-up · case … · failed`).

## Monitorización

No hay alertas en el código. Lo que existe:

| Área | Dónde mirar | Qué vigilar |
|---|---|---|
| Memoria | Métricas del servicio en Render (512 MB por instancia) | La ruta de imagen/PDF/OCR es la pesada. Solo se ejecuta un trabajo de imagen o PDF a la vez en todo el servidor; el proceso hijo de PDF tiene un heap limitado a 160 MB y, en Linux, se mata por encima de 200 MiB de RSS; el worker de OCR se detiene tras 60 s de inactividad y nunca está residente a la vez que un hijo de PDF. Observado antes: ~250 MB residentes después de leer una imagen de 8 MP, pico de ~395 MB de 512 (seguimiento P1, 17/10/2026). **Memoria con un PDF de 5 páginas en Render: Pendiente.** Si la memoria crece, los seguimientos sugieren probar `MALLOC_ARENA_MAX=2` (no probado) |
| CPU | Métricas del servicio en Render (0.5 CPU) | Las miniaturas de PDF tienen 3 s cada una, los renders de página 20 s, una sesión de PDF 90 s en total; con 0.5 CPU, los PDF reales pueden alcanzar el plazo de las miniaturas (seguimiento, no medido) |
| Almacenamiento | Uso de disco en Render (1 GB cada uno) | Las subidas tienen un tope de 300 MiB en total (`507 STORAGE_FULL` por encima). La caché de análisis (sin usar 30 días, 100 MiB) y el log de uso del analista (90 días, 10 MiB) se barren al arrancar y cada hora (`ANALYSIS_CACHE_MAX_*`, `ANALYST_USAGE_MAX_*`). El log de auditoría de envíos y el ledger de MeterMCP son registros de auditoría y de dinero y **no caducan nunca**; crecen, y nada avisa del uso de disco |
| Proveedores | Líneas de log de ResolveKit `analyst call · <stage> · <provider>/<model> · in … out … thinking … · <ms> ms` y `analyst fallback · <why>`; `<data>/analyst-usage.jsonl` (solo recuentos de tokens y tiempos); líneas de modelos de `demo:check` | El nivel gratuito de Groq responde `429` cuando se agota su cuota (observado en las evaluaciones); el analista pasa entonces al respaldo, el agente elige su proveedor con la primera respuesta y lo mantiene |
| PayPal | Líneas de `demo:check`; el log al arrancar (`… → <dispute> · capture …`, resultados de `checkBindings`); líneas del webhook | `PayPal unconfigured`, vinculaciones que no están `verified` |
| Ejecuciones del agente | Líneas de log `agent runs · reconcile failed`, `agent run <id>: not saved …`, `agent runs · sweep · …` | Las ejecuciones con liquidación `open`, `capture_pending`, `failed` o `unverified` se reintentan cada 5 min |
| MeterMCP | Líneas de log `idle sweep failed`, `capture reconciliation failed`, `mcp sessions: closed … idle`; contadores de `/health` | Sesiones atascadas en `capture_pending` |

Líneas de log útiles (de ResolveKit salvo que se indique). Los logs nunca llevan texto de documentos, claves ni tokens.

| La línea empieza por | Significado |
|---|---|
| `Hosted mode · …` | Resumen del arranque: orígenes, inicio de sesión con PayPal on/OFF, webhook on/OFF, comprobación de ops on/OFF, directorio de datos |
| `WARNING: …` | Un arranque degradado (falta el secreto de sesión, la app de identidad, el token de administración de MeterMCP; en MeterMCP: sin `DEMO_CODE`, presupuesto mínimo por encima del máximo) |
| `warm-up · case …` | Análisis en segundo plano de un caso vinculado tras el arranque, un cambio de vinculación o una rotación: `done`, `cached`, `skipped` o `failed`, con el motivo |
| `reserve · case …` | Un caso pasó a su siguiente disputa de reserva; cuántas quedan; subidas archivadas |
| `bindings changed · …` / `bindings file changed but is invalid…` | El archivo de vinculaciones vigilado (solo sin `BINDINGS_JSON`) |
| `uploads · sweep …` | Subidas caducadas descartadas y restos eliminados (solo recuentos) |
| `AUDIT NOT DURABLE` | PayPal aceptó un envío pero su resultado no se pudo escribir en el log de auditoría |
| `TEST SWITCH: …` (MeterMCP) | `METERMCP_FAIL_FIRST` está definida: no debe aparecer en el servicio alojado |
| `ledger migration failed, rolled back …` (MeterMCP) | MeterMCP no arrancó; consulta [Despliegue](deployment.md#migración-del-ledger-de-metermcp) |

## Cuotas, límites y errores de persistencia

| Lo que ve el usuario o el log | Causa | Qué hacer |
|---|---|---|
| `429 DAILY_CAP` (análisis en directo 60, recomprobaciones 200, envíos de evidencia 20, subidas 40, ejecuciones del agente 20 por día UTC; envíos de mensajes 20 `DAILY_MESSAGE_SENDS`, acciones de liquidación 20 `DAILY_SETTLE_SENDS`) | Se alcanzó el tope diario global de esa acción | Espera a que cambie el día UTC (`GET /api/demo` muestra `resetsAt`), o sube el valor `DAILY_*` en Render (reinicia el servicio; los recuentos se conservan en disco) |
| `429 PERSON_CAP` | 5 ejecuciones del agente por persona y día UTC (no configurable) | Espera a la medianoche UTC |
| Se alcanzó `DAILY_BUDGETS` (20) de MeterMCP | Presupuestos abiertos hoy | Espera al día UTC siguiente, o sube `DAILY_BUDGETS` en MeterMCP |
| `429 RATE_LIMITED` con `Retry-After` | Límite por dirección u horario (p. ej., 6 análisis en directo o 30 recomprobaciones por hora en todo el servidor; subidas, tapados y lecturas de páginas de PDF, 20 cada 10 min por dirección) | Espera. Los límites por dirección son una cortesía, no la frontera de seguridad |
| `503 CAPS_UNAVAILABLE` (envíos, ejecuciones en directo, recomprobaciones, subidas y ejecuciones del agente rechazados) | `daily-caps.json` (o `agent-run-caps.json`) ilegible al arrancar, o falló el último guardado: los topes fallan en cerrado | Arregla o elimina el archivo en el disco; se vuelve a leer en la siguiente reserva, sin reiniciar. Eliminarlo pone a cero los recuentos de hoy |
| `503 AUDIT_UNAVAILABLE` al enviar | El estado `sending` y el evento `send_started` no llegaron al disco: no se envió nada | Revisa el disco (espacio, permisos); la persona puede volver a enviar |
| `AUDIT NOT DURABLE` en el log | PayPal aceptó, falló la escritura del resultado | La relectura de PayPal es la verdad; revisa el disco |
| `action outcome unknown · case … · intent … · request …` en el log; `409 DISPUTE_UNCERTAIN` (con `holder`: el intent y el caso que retienen la disputa) para la persona | Una acción de disputa agotó el tiempo o recibió una respuesta poco clara, o PayPal la aceptó y ninguna relectura la ha probado aún: la disputa queda retenida | No hay nada que forzar; nunca reenvíes a mano. Cualquiera del espacio de trabajo del vendedor pulsa **Check again** en la página del caso (encuentra la retención tras recargar y relee *ese* envío). El operador: `GET /api/ops/status` lista cada retención (`holds`): una retención de menos de 5 min es una línea en `notices` (demo:check la muestra como WARN «held dispute», sigue listo), una más antigua o una cuyo intent ya no existe es una línea en `problems`; `POST /api/ops/readback/<intent>` con el Bearer de operaciones la relee (nunca un envío). La retención termina cuando PayPal prueba la acción registrada, o ausente mientras se sigue ofreciendo (log `read-back · case … · intent …: recorded\|absent`) |
| Una retención con `intentKnown: false` (estado de operaciones: «its intent is gone»); la relectura sigue en «Outcome pending confirmation: this server no longer has the approved content…» | `intents.json` se perdió o no se pudo leer al arrancar; la retención se reconstruyó desde el log de envíos, que solo guarda hashes, así que ninguna relectura puede probar el envío registrado o ausente | 1. Si el archivo antiguo se conservó (`intents.json.corrupt-<time>`, nombrado en el log) o hay copia, devuélvelo como `intents.json`, reinicia y relee. 2. Si no, la disputa sigue retenida por diseño (ResolveKit nunca libera un envío sin probar): mira la disputa a mano en el sandbox de PayPal, nunca reenvíes, y quita esa disputa de `BINDINGS_JSON` para que el caso pase a su siguiente disputa; la retenida no vuelve a recibir escrituras |
| `… could not be read …; every action interrupted by the restart is held until a read-back settles it` | El log de envíos no se pudo leer al arrancar | Arregla el archivo; las disputas retenidas se liberan con sus relecturas |
| `503 ACCOUNTS_UNAVAILABLE` | No se pudo escribir un cambio en `accounts.json` (se deshace) | Revisa el disco |
| `503` con `STORAGE` (subidas), `507 STORAGE_FULL` | Falló la escritura de una subida (se deshace), o se agotó el presupuesto de 300 MiB para subidas | Revisa el disco; borra subidas innecesarias; las caducadas desaparecen en menos de una hora |
| `503 STORAGE` al iniciar el agente | No se pudo escribir el registro de ejecución: no se inició nada | Revisa el disco |
| Agente `stopped` / `persistence` | Falló un registro write-ahead durante una ejecución: no se hace ninguna llamada más a herramientas; el estado queda en memoria y el barrido de 5 min lo escribe | Revisa el disco |
| `503 MODEL_UNAVAILABLE`, `ANALYST_UNCONFIGURED` | No hay clave de modelo | Define `GEMINI_API_KEY` y/o `GROQ_API_KEY` |
| Agente `meter_unavailable` | Falta `METERMCP_ADMIN_TOKEN` en `resolvekit`, o MeterMCP está caído | Arregla el entorno (desde `fromService`) o MeterMCP |
| MeterMCP `demo_code_required` | Falta `x-demo-code` o es incorrecto; o `DEMO_CODE` no está definida (entonces no se puede crear ningún presupuesto) | Da el código correcto; define `DEMO_CODE` |

## Trabajo en segundo plano, trabajos pendientes y liquidaciones

| Trabajo | Cuándo se ejecuta | Qué pasa en un reinicio |
|---|---|---|
| **Recuperación de ejecuciones del agente** | En cada arranque, en segundo plano (un MeterMCP caído no retrasa la escucha) | Toda ejecución sin terminar pasa a `interrupted`; una llamada a MeterMCP anunciada pero nunca respondida pasa a `uncertain` y nunca se vuelve a hacer; la sesión se cierra mediante la ruta de administración de MeterMCP y el recibo se vuelve a leer. **Recuperación tras reinicio en el sandbox: Pendiente** |
| **Reconciliación y barrido del agente** | Cada 5 min | Se escriben los registros no guardados; las ejecuciones cuya liquidación es `open`, `capture_pending`, `failed` o `unverified` se cierran o se reconcilian y su recibo se vuelve a leer; las ejecuciones de más de 30 días se borran salvo que se conserven, estén sin liquidar, sin guardar o vinculadas a un caso |
| **Barrido de MeterMCP** | Cada 30 s | Sesiones inactivas cerradas (`METERMCP_IDLE_MINUTES`, 15) y liquidadas; las capturas `capture_pending` se releen hasta `COMPLETED` (→ `settled`) o `DECLINED`/`FAILED` (→ `capture_declined`); se liberan los transportes MCP inactivos. Las sesiones `settlement_failed` se reintentan al cerrar con el mismo `PayPal-Request-Id`. **`capture_pending` no se observó en el sandbox: Pendiente** |
| **Trabajos de subidas de PDF** (miniaturas, renders, OCR) | En segundo plano después de que responda la ruta de subida, una subida a la vez en todo el servidor | Un trabajo cortado por un reinicio se marca como fallido con *The server restarted while reading this PDF. Discard it and upload it again.* y se descartan sus archivos |
| **Barrido de subidas** | Al arrancar y cada hora | Las subidas pendientes/en revisión de más de 24 h se descartan (el registro se conserva, los archivos y el texto desaparecen); se eliminan los restos de escrituras interrumpidas (`*.tmp`, directorios a los que nada hace referencia). El mismo barrido acota la caché de análisis y el log de uso del analista (líneas de log `analysis cache · sweep …`, `analyst usage log · sweep …`, solo recuentos) |
| **Envíos de evidencia** | A petición | Un envío cortado por un reinicio (`sending`) vuelve como `failed` (*the server restarted during the send*) y se puede reintentar durante 30 min con el mismo intent y el mismo `PayPal-Request-Id`; la ruta de evidencia lee primero PayPal, y rechaza si ya hay evidencia del vendedor |
| **Análisis de precalentamiento** | Después del arranque, de un cambio de vinculación o de una rotación | Cada caso vinculado se analiza una vez si sus documentos no tienen análisis guardado (ejecuciones del sistema, mismo límite horario y mismo tope diario) |
| **Vigilancia del archivo de vinculaciones** | Cada 30 s, solo cuando `BINDINGS_JSON` no está definida | Un archivo no válido se registra y se ignora |

### Reinicios y apagado

Con `SIGTERM`/`SIGINT`, ResolveKit primero da a las ejecuciones del agente hasta 20 s para terminar como
`interrupted` y liquidarse; después vuelca los intents, detiene el barrido de subidas y el worker de OCR, elimina el
archivo de token local y cierra. MeterMCP detiene su barrido, cierra las sesiones MCP y el ledger. El estado en memoria
se pierde al reiniciar: pistas de texto de PDF, ids de eventos de webhook recordados (una entrega repetida se vuelve a
leer, sin daño), los últimos 50 avisos de webhook, retos WebAuthn y ventanas del limitador de frecuencia. La posición en
la reserva y los veredictos de recomprobación se guardan en el disco (ver abajo). Sin `RESOLVEKIT_SESSION_SECRET` (32 o más caracteres), cada reinicio cierra la sesión de todo
el mundo.

## Procesos auxiliares y archivos temporales

| Proceso / archivo | Ciclo de vida |
|---|---|
| Proceso hijo lector de PDF (`pdf-child.ts`, con fork, `--max-old-space-size=160`) | Uno por sesión de PDF. Se mata con `SIGKILL` al pasar su plazo (20 s por página, 3 s por miniatura, 90 s por sesión) y, solo en Linux, por encima de 200 MiB de RSS (leído cada 100 ms). Una caída nunca tumba el servidor; la siguiente sesión arranca un hijo nuevo. **Matar una bomba de descompresión real por RSS en Linux no se ha medido: Pendiente** |
| Worker de OCR (tesseract.js, datos de idioma locales, sin red) | Se crea bajo demanda, un trabajo a la vez; se detiene tras 60 s de inactividad y antes de que arranque cualquier hijo de PDF; un trabajo que agota su tiempo (45 s, arranque 30 s) lo termina. `closeOcr()` no tiene límite de tiempo propio (problema conocido) |
| Archivos `*.tmp` | Todos los almacenes escriben de forma duradera: `<file>.<pid>.<random>.tmp`, fsync, rename y después un fsync del directorio en la medida de lo posible (`packages/hosting/src/durable.ts`); una escritura fallida elimina su archivo temporal. Restos de una caída: los elimina el barrido de subidas (subidas), al arrancar (el propio directorio de datos de cada servicio, solo nombres con ese patrón de más de 10 min; la caché de análisis, las ejecuciones del agente) |
| Archivos `*.corrupt-<time>` | Un archivo de almacén que existe pero no se puede leer al arrancar (`intents.json`, `analysis-inputs.json`, `recheck-verdicts.json`, `reserve-position.json`) se renombra a `<file>.corrupt-<hora UTC>` cuando su contenido es malo, se registra como `ERROR …`, se señala en `/api/health` (`storage`: los nombres de los almacenes en local, `true` en modo alojado) y lo lista `demo:check` (`storage · …`); el almacén empieza vacío (`intents.json`: las disputas ya enviadas se reconstruyen desde el log de envíos). Revisa el archivo y después devuélvelo a su sitio (con el servicio parado) o bórralo. Un error de lectura (ocupado, permisos) o un renombrado que falla deja el archivo donde está, sin escribir nunca encima (para `intents.json`: se rechaza todo envío); arréglalo y reinicia |
| `apps/server/.runtime-token`, `apps/metermcp/.runtime-token` | Solo en modo local: se escriben al arrancar (modo 600) y se eliminan en una parada limpia |

## Rotación de disputas y reserva

Los casos de evaluación del sandbox están vinculados a disputas reales del sandbox de PayPal. En nuestras pruebas en el
sandbox, la acción `provide_evidence` desapareció después de un envío, así que un caso se puede vincular a una
**reserva**: una lista de entradas `{dispute, capture}`, la primera de ellas activa.

**Cómo funciona la rotación** (`apps/server/src/app.ts`, verificado en el sandbox el 17/10): en una lectura del caso,
si la disputa activa está `RESOLVED`, o tiene evidencia del vendedor de hace más de 15 minutos (para que quien la envió
pueda ver la relectura), la **siguiente** lectura pasa el caso a la entrada siguiente. Registra `reserve · case …`,
archiva las subidas de la disputa antigua (los registros se conservan, los archivos y el texto se descartan) y lanza un
análisis de precalentamiento. Un intent compuesto para la disputa anterior se rechaza (`BINDING_CHANGED`). Con la
reserva vacía no se mueve nada: el caso se queda en su disputa usada y `demo:check` falla con `… is used … and no
dispute is left in reserve`.

**La posición en la reserva se guarda en el disco** (`<data>/reserve-position.json`, `apps/server/src/reserve.ts`): allí
queda registrada cada disputa que un caso dejó atrás. Al arrancar, y cuando cambia un archivo de vinculaciones, el
servidor salta esas disputas al principio de la lista del caso en `BINDINGS_JSON` y registra `reserve · case …: … used
before (reserve-position.json) → …`. `BINDINGS_JSON` sigue siendo la fuente de verdad: solo se salta una disputa que
sigue en la lista de ese caso, las entradas que ya no coinciden con las vinculaciones se ignoran y la última disputa de la
lista nunca se salta. Quitar de `BINDINGS_JSON` las disputas usadas sigue siendo ordenado, pero ya no es necesario. Un
archivo ilegible se conserva como `reserve-position.json.corrupt-<time>` y los casos recorren sus listas como antes
(Probado en local, `apps/server/test/reserve.test.ts`; aún no observado en el servicio alojado).

**Una disputa retenida nunca se rota** (Probado en local, `reserve.test.ts`, `hosted.test.ts`): mientras una acción de
disputa sobre la disputa activa esté en curso, incierta o pendiente de su relectura, ni una lectura (`rotateIfUsed`),
ni un arranque, ni una recarga de vinculaciones (`reserve.apply()`, incluida una recarga completa que la liste en otro
sitio) mueven el caso fuera de ella, para que quien envió la acción lea la respuesta de PayPal en la misma disputa. El
log dice `reserve · case …: … is held by an action still settling → kept active`, y el informe de operaciones
(`GET /api/ops/status`) muestra el `held` de cada vinculación (`{intentId, since}`, o `null`). Una disputa retenida que
las vinculaciones nuevas ya no listan no se mantiene: manda la configuración.

**El caso de liquidación del propietario** `PP-R-STL-10190667` tiene su propia reserva en `BINDINGS_JSON` y rota como
cualquier caso. Cada disputa solo puede aparecer una vez en todo el archivo (un duplicado detiene el arranque). No tiene
análisis guardado, así que la evidencia compuesta ahí responde `NO_ANALYSIS`; está pensado para las acciones solo del
Owner.

**Estado el 19/10/2026 (evidencia privada):** la disputa activa del caso estándar está usada y su reserva está vacía,
así que los nuevos envíos a ese caso están **Pendientes** hasta que se rellene la reserva (previsto del 25 al 30/11).
PayPal documenta que la fase de consulta (inquiry) dura hasta 20 días salvo que se escale
(https://developer.paypal.com/platforms/disputes/handle-disputes/use-disputes-api); comprueba el
`seller_response_due_date` de cada disputa y prepara disputas para las fechas en que se necesiten.

### Preparar la reserva: `npm run demo:prepare`

Se ejecuta en la máquina del operador y solo contra el **sandbox** de PayPal (rechaza cualquier otra cosa). Tú actúas
como comprador del sandbox, con la sesión iniciada en la cuenta **personal (buyer)** del sandbox; nada es simulado.
Necesita `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` en `.env`.

```bash
npm run demo:prepare -- --dry-run                     # OAuth check, shows what it would create; creates nothing
npm run demo:prepare -- --standard --count 5          # five 7.00 USD CAPTURE orders for the standard case
npm run demo:prepare -- --agent --agent-count 3       # three model-driven agent sessions vs the hosted MeterMCP
npm run demo:prepare -- --agent-run run-<32 hex> --seller <merchant id>   # a run already made on /agent, read only
npm run demo:prepare -- --wait-disputes --captures <standard>,<agent>      # resume: wait, then print BINDINGS_JSON
```

| Modo | Qué hace | Necesita |
|---|---|---|
| `--standard [--count N]` (1–20) | Orders v2 `CAPTURE` para el pedido del caso estándar (1 × «Linen tote, natural», 7.00 USD); imprime la URL de aprobación; captura después de la aprobación | App de sandbox de PayPal |
| `--agent [--agent-count N]` (1–10) | Ejecuta el motor del agente dirigido por el modelo contra MeterMCP (por defecto el alojado), con `--agent-goal`, `--agent-cap` (0.50–5.00), `--agent-fail-first`. Aprueba cada presupuesto con la cuenta **personal (buyer)** del sandbox: PayPal rechazó la cuenta business (vendedor) en la ejecución del 19/10/2026 («Estás entrando en la cuenta del vendedor…» (texto recortado en el registro); observado, no documentado) | `METERMCP_DEMO_CODE` (el mismo valor que `DEMO_CODE` de MeterMCP), una clave de modelo (`GEMINI_API_KEY` / `GROQ_API_KEY`), `AGENT_*` opcionales. **Llamadas a modelos y un presupuesto en sandbox** |
| `--agent-run <id>` (repetible) | Lee una ejecución ya hecha en `/agent` (registro y recibo mediante `GET /api/ops/agent-run/<id>`); nunca vuelve a ejecutar ni a pagar | `--seller <merchant id>`, el `BINDINGS_JSON` **actual** en `.env` (para que ninguna captura quede vinculada dos veces), `RESOLVEKIT_OPS_TOKEN` para la app alojada |
| `--wait-disputes --captures …` | Consulta PayPal (cada 30 s, hasta `--dispute-minutes`, 45 por defecto) hasta que cada disputa aparece y llega a `WAITING_FOR_SELLER_RESPONSE`, y después imprime `BINDINGS_JSON` | — |

Una ejecución del agente entra en la reserva solo si ha terminado, tiene al menos una llamada cobrada, su liquidación es
`captured` con la captura de PayPal `COMPLETED`, y su sesión, su captura y el hash de su recibo coinciden con el
recibo; una ejecución que terminó por un límite o una interrupción se anota como *not a goal achieved* (objetivo no
logrado). Un registro de ejecución guardado en el servidor se barre a los 30 días salvo que se haya pulsado **Keep**
o esté vinculado: conserva las ejecuciones que pienses usar.

El script imprime lo que el comprador pulsa para abrir cada disputa, con la sesión iniciada en la cuenta **personal
(buyer)** del sandbox. Para el caso del agente la reclamación es la que responde su evidencia: tipo de artículo
«Service», «My AI agent paid for MeterMCP tool calls and I didn't receive their results» (el recibo lista cada llamada
entregada; las fallidas no se cobraron).

**Estado:** Implementado · Probado en local (`apps/server/test/demo-prepare.test.ts`). Uso de `--agent` /
`--agent-run` para la reserva alojada: **Pendiente** (previsto del 25 al 30/11). Ninguna vinculación nombra todavía una
ejecución dirigida por el modelo; la vinculación actual del caso del agente apunta a una sesión creada por el anterior
cliente con guion (scripted).

Después pega el `BINDINGS_JSON` impreso en el servicio `resolvekit` de Render (se reinicia), ejecuta `demo:check` y
confirma el recuento de la reserva en las líneas de vinculación.
