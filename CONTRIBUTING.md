[English](CONTRIBUTING.md) | [Español](CONTRIBUTING.es.md)

# Contributing

ResolveKit was built for the PayPal AI Hackathon and is maintained by its owner. Issues and pull requests are welcome;
there is no promise of review times. Security problems: see [SECURITY.md](SECURITY.md), not a public issue.

## Set up

Requires Node.js 24+ (TypeScript runs natively, no build step for the server).

```bash
npm ci
npm test              # every suite, fake PayPal and fake model: no network, no keys, no cost
npm run typecheck
```

To run the app locally (simulator without credentials, PayPal sandbox with them), see
[Local development](docs/technical/local-development.md). Copy `.env.example` to `.env` for sandbox credentials;
`.env` is git-ignored and must never be committed.

## Before you open a pull request

- `npm test` and `npm run typecheck` pass. If a test is flaky under load (one known case, see
  [Testing](docs/quality/testing.md)), say so in the pull request rather than retrying until green.
- New behaviour comes with tests in the matching suite (`packages/*/test`, `apps/server/test`, `apps/metermcp/test`,
  `apps/web/src/**.test.ts`). Tests use fakes: no test may call PayPal, a model provider or the network.
- There is no CI in this repository: the checks above are run by hand.
- Do not change product logic in a documentation pull request, and vice versa.

## Things that cost money or touch real systems

Do not run these unless you mean to, with your own keys and sandbox accounts:

| Command | Effect |
|---|---|
| `npm run evals`, `npm run evals:heldout`, `npm run golden` | Paid model calls (Gemini) or free-tier quota (Groq) |
| `npm run demo:prepare` | Creates PayPal **sandbox** orders; with `--agent`, model calls and a sandbox budget |
| `npm run demo-agent` | Model calls and a sandbox budget |
| `npm run demo:check` | One model call per provider (unless `--no-models`) and fresh PayPal reads on the hosted server, which may rotate a used case and start a live re-analysis ([Runbook](docs/operations/runbook.md#the-operators-check-npm-run-democheck)) |
| `npm run server` (hosted mode) | PayPal sandbox reads at start, warm-up analyses |

`npm run evals:recompute` is free: it rescores the stored results without keys or network.

## Evaluations

- Figures come only from [`packages/analyst/evals/results/summary.md`](packages/analyst/evals/results/summary.md) /
  `summary.json`, written by `npm run evals:recompute`. Do not hand-edit them, and do not compare rates across
  different case sets. See [Analyst evaluations](docs/quality/evaluations.md).
- The held-out set is frozen at commit `cefd171`, together with its scorer, configuration, the analyst prompt and
  code and the batch code (`FROZEN_PATHS` in `packages/analyst/evals/runs.ts`). Changing a frozen file makes
  `evals:heldout` refuse to run; stored attempts are append-only and never replaced. A new freeze is a new batch,
  reported apart.

## Data and privacy rules

- Only synthetic data in the repository: fictional names, addresses and identifiers (`PP-D-EXAMPLE-0001`,
  `run-<32 hex>`, `mm-sess-…`). No real customer data, no real documents.
- No secrets, tokens, sandbox credentials, invite links, consent or approval URLs, or real dispute/order/capture ids in
  code, tests, docs or screenshots.
- Logs must not carry document text, file contents, keys or tokens.

## Documentation

- English pages live in `README.md` and `docs/`; Spanish pages in `README.es.md` and `docs/es/` with the same file
  names and structure. Each page starts with the `English | Español` links; a change to one language needs the same
  change in the other.
- Keep commands, environment variables, API routes and UI control names exactly as in the product.
- State status with the project's words (Designed, Implemented, Tested locally, Verified in sandbox, Deployed,
  Available to users, Pending), and give every figure its date and commit.
- `docs/superpowers/` holds plans and specs as history: do not rewrite it.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
