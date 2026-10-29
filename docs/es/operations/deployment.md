[English](../../operations/deployment.md) | [Español](deployment.md)

# Despliegue

Cómo se despliegan en Render los dos servicios de ResolveKit, en qué orden y qué comprobar cuando cambia una versión.
Para cada variable de entorno consulta [Configuración](../technical/configuration.md); para la operación diaria, el
[Runbook](runbook.md).

**Estado (29/10/2026).** Desplegado. El commit `f1b7236` (`main`; las correcciones previas a la entrega sobre `c12faea`: el listener de MeterMCP ya no cae ante un cliente que aborta, una petición que no se puede construir o un error de un handler; provide-evidence se envía una sola vez, sin reintento; el libro de MeterMCP resuelve al reiniciar las liquidaciones a medias y las llamadas en curso; el barrido de subidas aparta las carpetas ilegibles en vez de borrarlas; un tiempo límite de 60 s por test; más documentación) se avanzó y se subió el 29/10, y Render volvió a desplegar ambos servicios (los dos se reiniciaron hacia las 12:15, hora de Madrid). `npm run demo:check` contra las URL
alojadas dio entonces el mismo resultado que tras `c12faea`: PASS en ResolveKit activo, página de inicio, MeterMCP activo, sandbox de PayPal conectado,
webhook activo, ambas vinculaciones verificadas, ambos modelos de IA respondieron y ambos precalentamientos en caché;
WARN en ambas reservas (0 disputas nuevas); y un FAIL, el conocido: la vinculación del caso estándar está usada y su
reserva está vacía; estado a 29/10/2026: ambas reservas están vacías, las disputas nuevas del sandbox se preparan el 31/10/2026 y el relleno para la evaluación está previsto el 28–30/11/2026, cuando también se vinculará el caso de liquidación, solo del Owner, en el `BINDINGS_JSON` alojado (consulta [Runbook](runbook.md#rotación-de-disputas-y-reserva)).
`demo:check` no puede demostrar qué commit está desplegado. Las acciones de disputa de ese commit aún no se han
ejercitado en el servicio alojado. Los despliegues anteriores registrados fueron `c12faea` el 21/10 (el estado del registro de `send_message:file` Verificado en sandbox tras V-7, sobre `81c6242`; se observó un bundle web nuevo), `81c6242` el 21/10 (antes, el mismo día; el mismo resultado de `demo:check`), `5111b88` el 20/10 (el propietario avanzó `main` hasta él y lo subió; el mismo resultado de `demo:check`), `fbe9621` el 19/10 (confirmación del
propietario; `demo:check` pasó todas las líneas excepto la misma reserva vacía) y `bdd1fd9` el 19/10, ambos servicios,
primero MeterMCP y ResolveKit a mano.

## Servicios

Ambos servicios salen de [`render.yaml`](../../../render.yaml) (un Blueprint de Render).

| | `resolvekit-metermcp` | `resolvekit` |
|---|---|---|
| Qué es | La pasarela MCP de pago por uso (`apps/metermcp`, `METERMCP_MODE=hosted`) | La app web y su API en un solo origen (`apps/server`, `RESOLVEKIT_MODE=hosted`) |
| Build | `npm ci` | `npm ci && npm run build` |
| Arranque | `node apps/metermcp/src/main.ts` | `node apps/server/src/main.ts` |
| Health check | `/healthz` | `/healthz` |
| Plan, región, runtime | `starter` (0.5 CPU, 512 MB), `oregon`, Node `24.19.0` | igual |
| Disco | 1 GB en `/var/data`: el ledger SQLite y el tope diario de presupuestos | 1 GB en `/var/data`: consulta [Copias de seguridad y recuperación](backup-and-recovery.md#qué-guarda-cada-servicio) |
| Auto-deploy en el blueprint | `autoDeployTrigger: commit` | `autoDeployTrigger: commit` |
| Rutas públicas | `/mcp`, `/approved`, `/cancelled`, `/health`, `/healthz` | la app web, `/api`, `/healthz` |
| Rutas internas | `/agent/mcp` y las rutas de administración `/sessions…`, accesibles solo desde `resolvekit` por la red privada de Render con el token de administración | `/api/ops/*` (token de operador), `/api/paypal/webhook/<key>` (PayPal) |

`resolvekit` recibe dos valores de MeterMCP mediante `fromService`: `METERMCP_URL` (el `host:port` privado de
MeterMCP) y `METERMCP_ADMIN_TOKEN` (generado por Render en MeterMCP). `RESOLVEKIT_SESSION_SECRET` lo genera Render.
`PORT` y `RENDER_EXTERNAL_URL` los define Render. Los secretos son `sync: false`: Render los pide cuando se crea el
Blueprint por primera vez.

Ambos servicios se niegan a arrancar en modo alojado salvo con `PAYPAL_ENV=sandbox` (o `live` con
`RESOLVEKIT_ALLOW_LIVE_PAYPAL=yes-real-money`, que el blueprint nunca define). Nada se ha ejecutado contra PayPal live.

## Orden: primero MeterMCP, después ResolveKit

ResolveKit es cliente de MeterMCP; MeterMCP nunca llama a ResolveKit (solo redirige el navegador de un comprador a un
origen `return_to` permitido). Un build de ResolveKit puede depender de rutas, herramientas o columnas del ledger de
MeterMCP añadidas en el mismo commit (por ejemplo el endpoint privado `/agent/mcp`, `fail_first` y `return_to` de
`open_budget`, la ruta de administración `/sessions/<id>/reconcile`). Así que:

1. Despliega `resolvekit-metermcp`. Espera a que Render lo muestre en marcha y `GET https://<metermcp host>/healthz`
   responda 200. Busca en su log `MeterMCP on http://0.0.0.0:…` y que no aparezca `ledger migration failed`.
2. Despliega `resolvekit`. Espera a `/healthz` y después busca en su log `Hosted mode · …`, los casos vinculados y las
   líneas de precalentamiento (`warm-up · case … · done | cached | skipped`).
3. Ejecuta `npm run demo:check` (consulta [Runbook](runbook.md#la-comprobación-del-operador-npm-run-democheck)).

El blueprint en sí no tiene un orden explícito: `fromService` crea una dependencia para los valores, no para los
despliegues.

### Auto-deploy activado o desactivado

El blueprint define `autoDeployTrigger: commit` en ambos servicios, así que un push a la rama desplegada inicia los dos
despliegues a la vez y el orden anterior no está garantizado. La práctica usada el 19/10 fue: desplegar primero
MeterMCP y después ResolveKit a mano, y los seguimientos del agente recomiendan **desactivar** el auto-deploy de
`resolvekit` (panel de Render → el servicio → Settings → Auto-Deploy, o `autoDeployTrigger: off` en el blueprint).
**Pendiente:** el blueprint sigue diciendo `commit` para ambos; no consta si se cambió el ajuste del panel.

Cambiar una variable de entorno en Render (por ejemplo un `BINDINGS_JSON` nuevo) reinicia ese servicio.

### Tiempo sin servicio

Un servicio con disco persistente no puede tener despliegues sin tiempo de inactividad en Render, y funciona como una
única instancia. Durante un despliegue se observaron unos 1–2 minutos de respuestas HTTP 502 (evidencia privada,
19/10). Programa los despliegues fuera de las sesiones de revisión y avisa a los revisores cuando haga falta uno.

## Primer despliegue (resumen)

1. En Render: **New → Blueprint**, elige el repositorio; Render lee `render.yaml`.
2. Introduce los valores `sync: false`. Ambos servicios necesitan la app de vendedor del **sandbox** de PayPal
   (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`). `resolvekit` necesita además las claves de los modelos, la app de
   identidad (`PAYPAL_IDENTITY_CLIENT_ID` / `_SECRET`, otra app de sandbox propiedad de otra cuenta business de
   sandbox), el webhook (`PAYPAL_WEBHOOK_ID`, `PAYPAL_WEBHOOK_KEY`), `BINDINGS_JSON` y `RESOLVEKIT_OPS_TOKEN`. MeterMCP
   necesita además `DEMO_CODE` y `METERMCP_RETURN_ORIGINS` (el origen público de ResolveKit, definido a mano).
3. Despliega en el orden anterior; después inicia sesión una vez como comerciante y crea la invitación de revisor
   ([Cuentas y permisos](../user-guide/accounts-and-permissions.md)).

El arranque se rechaza, y el servicio no arranca, cuando: `PAYPAL_ENV` no es `sandbox` (o es `live` sin `RESOLVEKIT_ALLOW_LIVE_PAYPAL=yes-real-money`, que nunca se establece); falta
`RENDER_EXTERNAL_URL` o no es https; `PAYPAL_IDENTITY_CLIENT_ID` es igual a `PAYPAL_CLIENT_ID`; `PAYPAL_WEBHOOK_ID` no
parece un id de webhook o llega sin un `PAYPAL_WEBHOOK_KEY` válido; `RESOLVEKIT_OPS_TOKEN` no tiene 32 o más caracteres
seguros para URL; `BINDINGS_JSON` (o el archivo de vinculaciones) no es válido; `accounts.json` o `sellers.json` son
ilegibles; falta el build web; en MeterMCP, `METERMCP_ADMIN_TOKEN` tiene menos de 32 caracteres, la URL pública no es
https, `METERMCP_BUDGET` / `METERMCP_MIN_BUDGET` / `METERMCP_RETURN_ORIGINS` no son válidos (incluido un
`METERMCP_MIN_BUDGET` por encima de `METERMCP_BUDGET`; los 5.00 / 0.50 del blueprint pasan), o el ledger no se puede
migrar. Que falte `METERMCP_ADMIN_TOKEN` en `resolvekit`, que falte `DEMO_CODE` en MeterMCP o un secreto de sesión
corto solo registran un `WARNING` (las ejecuciones del agente se detienen como `meter_unavailable`; no se puede crear
ningún presupuesto; las sesiones se cierran en cada reinicio).

## Actualizaciones, reversiones y migraciones

### Migración del ledger de MeterMCP

Al arrancar, MeterMCP abre `metermcp.sqlite` (modo WAL), crea las tablas si no existen y añade las columnas
introducidas después del primer despliegue (`fail_first`, `return_to` en `sessions`). Las columnas se añaden en **una
transacción**: o se añaden todas o ninguna. Si la migración falla, se revierte, el log dice
`ledger migration failed, rolled back (nothing changed): …` y MeterMCP sale sin arrancar
(`apps/metermcp/src/ledger.ts`, `apps/metermcp/src/main.ts`). Un ledger al día no cambia nada.

El comentario del código dice que el despliegue anterior sigue sirviendo cuando el nuevo no puede migrar. No se ha
comprobado ni probado aquí cómo gestiona Render un arranque fallido de un servicio con disco, ni si la versión anterior
sigue o vuelve a servir (**Pendiente**). Cuenta con que MeterMCP esté caído hasta que reviertas o corrijas la causa.

### Archivos de datos de ResolveKit

Los almacenes del servidor en `/var/data` (archivos JSON y JSONL, consulta
[Copias de seguridad y recuperación](backup-and-recovery.md#qué-guarda-cada-servicio)) no llevan versión de formato. No
hay paso de migración: el código nuevo lee los archivos existentes. Algunos archivos se comprueban al arrancar
(`accounts.json`, `sellers.json`, vinculaciones: si son ilegibles se detiene el arranque); otros se leen con
tolerancia: un `intents.json`, `analysis-inputs.json`, `recheck-verdicts.json` o `reserve-position.json` ilegible se
aparta como `<file>.corrupt-<time>`, se registra y se informa, y el almacén empieza vacío. No se ha probado la compatibilidad de una versión antigua
con archivos escritos por una más nueva (**Pendiente**).

### Revertir

Usa la reversión de Render a un despliegue anterior, servicio por servicio, **primero ResolveKit y después MeterMCP**
(el orden inverso al del despliegue), para que ResolveKit nunca funcione contra un MeterMCP más antiguo que aquel para
el que se construyó. Antes de revertir MeterMCP por encima de una migración del ledger, ten en cuenta que las columnas
añadidas se quedan en la base de datos; no se ha probado un MeterMCP antiguo leyendo un ledger migrado
(**Pendiente**). Haz antes una copia de los discos si los datos importan
([Copias de seguridad y recuperación](backup-and-recovery.md)).

### Antes y después de cada despliegue

| Cuándo | Comprobación |
|---|---|
| Antes | Ninguna ejecución del agente en curso y ningún envío de evidencia en marcha (una parada da a las ejecuciones del agente 20 s para terminar como `interrupted` y liquidarse; consulta [Runbook](runbook.md#reinicios-y-apagado)). Revisores avisados si es durante una ventana de revisión |
| Antes | `render.yaml` y el panel coinciden en los valores que esperas (el panel manda para los valores `sync: false`) |
| Después de MeterMCP | `/healthz` 200; ningún `ledger migration failed` en el log; `TEST SWITCH` ausente del log salvo que sea intencionado (`METERMCP_FAIL_FIRST` no debe estar definida en el servicio alojado) |
| Después de ResolveKit | `/healthz` 200; `Hosted mode · … PayPal sign-in on · PayPal webhook on · ops check on`; líneas de precalentamiento; después `npm run demo:check` |

## Ensayo local del modo alojado

Para ensayar el modo alojado en tu máquina antes de desplegar, sigue los comandos de
[Desarrollo local](../technical/local-development.md).
