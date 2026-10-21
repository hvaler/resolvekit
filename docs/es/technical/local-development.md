[English](../../technical/local-development.md) | [Español](local-development.md)

# Desarrollo local

Cómo instalar, ejecutar y probar ResolveKit en tu máquina, y qué comandos llegan a PayPal, a los proveedores de
modelos o cuestan dinero. Código en el commit `c12faea`.

## Requisitos

| Elemento | Versión | Notas |
|---|---|---|
| Node.js | `>=24` (`engines` del `package.json` raíz); Render y la última ejecución completa de tests usan 24.19.0 | TypeScript se ejecuta de forma nativa en Node (type stripping): sin paso de build para el servidor, MeterMCP ni los paquetes |
| npm | el que viene con Node 24 | workspaces de npm (`packages/*`, `apps/*`) |
| Sistema operativo | Windows, macOS, Linux | `@napi-rs/canvas` instala un binario nativo precompilado por plataforma. La muerte por memoria del proceso hijo de PDF solo funciona en Linux. La suite completa se ejecutó por última vez en Windows (19/10/2026); ejecuciones de tests en Linux: Pendiente |
| App de sandbox de PayPal | opcional | developer.paypal.com → Apps & Credentials → Sandbox. Sin ella, todos los casos funcionan sobre el simulador |
| Clave de Gemini / Groq | opcional | Sin clave, los análisis de referencia (golden) confirmados en el repositorio para los casos de demo siguen funcionando; el análisis en directo y el agente quedan desactivados |

Las versiones fijadas de las dependencias están en cada `package.json` (por ejemplo React 18.3.1, Vite 8.3.4,
Vitest 5.0.5, AG Grid 33.3.2, `@modelcontextprotocol/sdk` 1.32.1, `pdfjs-dist` 6.4.299, `tesseract.js` 7.0.0).

## Instalación

```bash
git clone <repository URL> resolvekit && cd resolvekit
cp .env.example .env      # fill in only what you need; .env is git-ignored
npm install
npm test                  # no network: fake PayPal and fake models
```

Cada variable se describe en [configuración](configuration.md) y en [`.env.example`](../../../.env.example).

## Ejecución

### Solo la app web (simulador)

```bash
npm run dev               # http://localhost:5173
```

Sin el servidor, todos los casos funcionan sobre el simulador del navegador con los análisis de referencia. En
desarrollo, un pequeño control **Dev · simulator** (abajo a la izquierda, oculto en los casos que funcionan sobre
PayPal real) elige qué hace el PayPal simulado tras un envío (*Waiting for buyer*, *Under review*, *Timeout*), puede
abrir la nueva disputa en ese momento o simular que PayPal no está accesible. En otros builds, añade `?dev` a la URL,
o `?outcome=under_review|timeout`. `?record` activa **Recording mode** (modo grabación: reproducción más lenta del
análisis, control Dev oculto); `?record=0` lo desactiva.

### Servidor con disputas reales de sandbox

```bash
cp apps/server/bindings.example.json apps/server/bindings.json   # { "<case id>": { "dispute": "PP-D-EXAMPLE-0001", "capture": "<capture id>" } }
npm run server            # http://127.0.0.1:8787, loads ../../.env
npm run dev               # or: npm run build && npm run preview  (port 4173)
```

Los servidores de desarrollo y de previsualización de Vite redirigen `/api` a `RESOLVEKIT_API` (por defecto
`http://127.0.0.1:8787`) y añaden en el lado del servidor el token por arranque de `apps/server/.runtime-token`; las
peticiones entre sitios se rechazan antes de añadir el token. Un caso usa PayPal real solo cuando está vinculado en
`bindings.json` **y** `/api/health` informa de que PayPal está conectado; entonces la barra de la app dice
**PayPal sandbox · live** seguido del id de la disputa. «live» significa aquí una lectura en directo de una disputa de
**sandbox**, no el entorno de producción de PayPal.

Al arrancar, el servidor lee y verifica una vez cada disputa vinculada (llamadas al sandbox de PayPal). El modo local
no tiene inicio de sesión: eres el operador y actúas como Owner.

### MeterMCP y el agente

```bash
npm run metermcp          # http://127.0.0.1:8790/mcp; writes apps/metermcp/.runtime-token
npm run demo-agent -- --goal "Quote for ACME-42" --cap 2.00 [--fail-first deep_report] [--no-wait] [--out run.json]
```

La página `/agent` del servidor local se conecta al `/agent/mcp` de MeterMCP en `METERMCP_URL` (por defecto
`http://127.0.0.1:8790`). El `/agent/mcp` del modo local no tiene test automatizado (seguimiento). `--no-wait` se
detiene tras imprimir la URL de aprobación y cierra la sesión, de modo que nada queda autorizado.

### Ensayar el modo alojado en local

Compila la app web y después arranca ambos servicios en modo alojado con variables de Render de sustitución.
`localhost` puede ser `http`; cualquier otro origen público debe ser `https`.

```bash
npm run build
# MeterMCP
METERMCP_MODE=hosted PORT=10001 RENDER_EXTERNAL_URL=http://localhost:10001 \
  METERMCP_ADMIN_TOKEN=<32+ random characters> METERMCP_DATA_DIR=<dir> DEMO_CODE=<code> \
  node --env-file-if-exists=.env apps/metermcp/src/main.ts
# Server
RESOLVEKIT_MODE=hosted PORT=10000 RENDER_EXTERNAL_URL=http://localhost:10000 RESOLVEKIT_DATA_DIR=<dir> \
  METERMCP_URL=127.0.0.1:10001 METERMCP_ADMIN_TOKEN=<same token> BINDINGS_JSON='<json>' \
  node --env-file-if-exists=.env apps/server/src/main.ts
```

`DEMO_CODE` solo lo lee MeterMCP; el servidor nunca lo lee. El modo alojado necesita `PAYPAL_ENV=sandbox`.

## Scripts

Todos desde la raíz del repositorio.

| Script | Qué hace | Red / coste |
|---|---|---|
| `npm test` | Todas las suites de los workspaces (`node --test`; Vitest para la web) | Ninguno (dobles de prueba) |
| `npm run test:<paypal\|hosting\|cases\|analyst\|agent\|server\|metermcp\|web>` | Un workspace | Ninguno |
| `npm run typecheck` | `tsc --noEmit` para siete workspaces | Ninguno |
| `npm run dev` / `build` / `preview` | Servidor de desarrollo de Vite / comprobación de tipos y build de `apps/web/dist` / previsualización | Ninguno |
| `npm run server` | Servidor de ResolveKit (local salvo con `RESOLVEKIT_MODE=hosted`) | Lecturas del sandbox de PayPal al arrancar cuando hay credenciales y vinculaciones; los análisis en directo consumen cuota de modelos; el modo alojado además precalienta los casos vinculados (llamadas al modelo) |
| `npm run metermcp` | MeterMCP | Pedidos y autorizaciones en el sandbox de PayPal cuando se usan presupuestos |
| `npm run evals -- --provider gemini\|groq` | Evaluación del analista en el conjunto de desarrollo, un proveedor; `--metrics-only`, `--recompute` sin modelo | Llamadas **de pago** a Gemini; cuota del nivel gratuito de Groq |
| `npm run evals:heldout` | Ejecuciones repetidas del conjunto reservado (held-out); se niega a ejecutarse si los archivos congelados no coinciden; guarda de gasto de Gemini | Gemini **de pago**; cuota de Groq |
| `npm run evals:recompute` | Repuntuar los resultados guardados en `summary.json` / `summary.md` | Ninguno |
| `npm run golden` | Ejecutar el analista sobre los casos de demo, escribir la caché o `packages/analyst/golden/` | Llamadas **de pago** al modelo |
| `npm run demo:prepare` | Crear pagos y disputas nuevos en sandbox para los casos de evaluación; `--dry-run` solo comprueba las credenciales OAuth | Solo el **sandbox** de PayPal (rechaza otro `PAYPAL_ENV`; sin dinero real); llamadas al modelo y un presupuesto de MeterMCP con `--agent` |
| `npm run demo:check` | Comprueba la demo alojada: `/healthz`, página de inicio, `/healthz` de MeterMCP, `GET /api/ops/status?probe=models` | Una llamada mínima **por cada modelo configurado** salvo con `--no-models`; las lecturas de PayPal del servidor sobre las disputas vinculadas pueden rotar un caso usado a su siguiente disputa de reserva y provocar un nuevo análisis en directo |
| `npm run demo-agent` | Agente comprador de línea de comandos contra el `/mcp` de MeterMCP | Llamadas al modelo y un presupuesto en el sandbox de PayPal |

`demo:check` necesita `RESOLVEKIT_OPS_TOKEN` (sale con código 2 sin él) y solo lo envía por https o a localhost. Sus
valores por defecto son `https://resolvekit-i3j2.onrender.com` y `https://resolvekit-metermcp.onrender.com` (`--app`,
`--metermcp` para cambiarlos). Sale con 0 solo cuando todas las líneas pasan. «Solo lectura» es cierto para lo que
envía el script, no estrictamente para el estado del servidor.

Opciones de `demo:prepare` (ver `USAGE` en `apps/server/scripts/demo-prepare-lib.ts`): `--standard [--count N]`,
`--agent [--agent-count N]` con `--agent-goal`, `--agent-cap`, `--agent-fail-first`, `--metermcp URL`;
`--agent-run <run id>` (lee una ejecución terminada de `/agent`; nunca la vuelve a ejecutar ni a pagar);
`--wait-disputes --captures …`; `--approval-minutes`, `--dispute-minutes`; `--seller <merchant id>`. Imprime el
`BINDINGS_JSON` que hay que pegar. Uso operativo: [runbook](../operations/runbook.md).

## Tests

Última ejecución completa: 21/10/2026, commit `c12faea`, Node 24, Windows: 1,479 tests, todos superados; typecheck
limpio, build web correcto (21/10/2026, `81c6242`: 1,479; 20/10/2026, `5111b88`: 1,453). Fuente: el registro de la ejecución guardado con el trabajo de documentación.

| Suite | Tests | Resultado |
|---|---|---|
| `test:paypal` | 36 | pasa |
| `test:hosting` | 32 | pasa |
| `test:cases` | 12 | pasa |
| `test:analyst` | 159 | pasa |
| `test:agent` | 52 | pasa |
| `test:server` | 635 | pasa |
| `test:metermcp` | 80 | pasa |
| `test:web` | 447 | pasa |
| `typecheck` | — | pasa |

La ejecución completa anterior (19/10/2026 12:35 UTC, commit `fbe9621`, Node 24.19.0, Windows) contó 1,131 tests con un
fallo (`uploads-pdf-recovery.test.ts`, «size: five dense A4 pages…»), 429 `RATE_LIMITED` con la carga de la suite
completa; ejecutado solo, pasó dos veces. Es intermitente y no se repitió el 20/10/2026. Prácticas de pruebas:
[pruebas](../quality/testing.md).
