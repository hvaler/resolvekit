[English](CONTRIBUTING.md) | [Español](CONTRIBUTING.es.md)

# Contribuir

ResolveKit se construyó para la PayPal AI Hackathon y lo mantiene su propietario. Las issues y las pull requests son
bienvenidas; no hay compromiso de plazos de revisión. Problemas de seguridad: consulta [SECURITY.es.md](SECURITY.es.md),
no abras una issue pública.

## Preparación

Requiere Node.js 24+ (TypeScript se ejecuta de forma nativa; el servidor no tiene paso de compilación).

```bash
npm ci
npm test              # every suite, fake PayPal and fake model: no network, no keys, no cost
npm run typecheck
```

Para ejecutar la app en local (simulador sin credenciales, sandbox de PayPal con ellas), consulta
[Desarrollo local](docs/es/technical/local-development.md). Copia `.env.example` a `.env` para las credenciales del
sandbox; `.env` está en `.gitignore` y no debe subirse nunca.

## Antes de abrir una pull request

- `npm test` y `npm run typecheck` pasan. Si un test es intermitente bajo carga (hay un caso conocido, consulta
  [Pruebas](docs/es/quality/testing.md)), indícalo en la pull request en lugar de reintentar hasta que salga en verde.
- Todo comportamiento nuevo llega con tests en la suite correspondiente (`packages/*/test`, `apps/server/test`,
  `apps/metermcp/test`, `apps/web/src/**.test.ts`). Los tests usan dobles: ningún test puede llamar a PayPal, a un
  proveedor de modelos ni a la red.
- Este repositorio no tiene CI: las comprobaciones anteriores se ejecutan a mano.
- No cambies la lógica del producto en una pull request de documentación, ni al revés.

## Cosas que cuestan dinero o tocan sistemas reales

No las ejecutes salvo que sea tu intención, con tus propias claves y cuentas de sandbox:

| Comando | Efecto |
|---|---|
| `npm run evals`, `npm run evals:heldout`, `npm run golden` | Llamadas de pago a modelos (Gemini) o cuota del nivel gratuito (Groq) |
| `npm run demo:prepare` | Crea pedidos en el **sandbox** de PayPal; con `--agent`, llamadas a modelos y un presupuesto en sandbox |
| `npm run demo-agent` | Llamadas a modelos y un presupuesto en sandbox |
| `npm run demo:check` | Una llamada a modelo por proveedor (salvo `--no-models`) y lecturas nuevas de PayPal en el servidor alojado, que pueden rotar un caso usado e iniciar un nuevo análisis en directo ([Runbook](docs/es/operations/runbook.md#la-comprobación-del-operador-npm-run-democheck)) |
| `npm run server` (modo alojado) | Lecturas del sandbox de PayPal al arrancar, análisis de precalentamiento |

`npm run evals:recompute` es gratuito: vuelve a puntuar los resultados guardados sin claves ni red.

## Evaluaciones

- Las cifras salen solo de [`packages/analyst/evals/results/summary.md`](packages/analyst/evals/results/summary.md) /
  `summary.json`, que escribe `npm run evals:recompute`. No los edites a mano y no compares tasas entre conjuntos de
  casos distintos. Consulta [Evaluaciones del analista](docs/es/quality/evaluations.md).
- El conjunto held-out está congelado en el commit `cefd171`, junto con su puntuador, su configuración, el prompt y el
  código del analista y el código del lote (`FROZEN_PATHS` en `packages/analyst/evals/runs.ts`). Cambiar un archivo
  congelado hace que `evals:heldout` se niegue a ejecutarse; los intentos guardados solo se añaden y nunca se
  sustituyen. Una nueva congelación es un lote nuevo, que se informa por separado.

## Reglas de datos y privacidad

- Solo datos sintéticos en el repositorio: nombres, direcciones e identificadores ficticios (`PP-D-EXAMPLE-0001`,
  `run-<32 hex>`, `mm-sess-…`). Ningún dato real de clientes, ningún documento real.
- Ningún secreto, token, credencial de sandbox, enlace de invitación, URL de consentimiento o aprobación, ni ids reales
  de disputas, pedidos o capturas en el código, los tests, la documentación o las capturas de pantalla.
- Los logs no deben llevar texto de documentos, contenido de archivos, claves ni tokens.

## Documentación

- Las páginas en inglés están en `README.md` y `docs/`; las páginas en español, en `README.es.md` y `docs/es/`, con
  los mismos nombres de archivo y la misma estructura. Cada página empieza con los enlaces `English | Español`; un
  cambio en un idioma exige el mismo cambio en el otro.
- Mantén los comandos, las variables de entorno, las rutas de la API y los nombres de los controles de la interfaz
  exactamente como en el producto.
- Indica el estado con las palabras del proyecto (Diseñado, Implementado, Probado en local, Verificado en sandbox,
  Desplegado, Disponible para usuarios, Pendiente) y da a cada cifra su fecha y su commit.
- `docs/superpowers/` guarda planes y especificaciones como historial: no lo reescribas.

## Licencia

Al contribuir aceptas que tu contribución se licencia bajo la [licencia MIT](LICENSE).
