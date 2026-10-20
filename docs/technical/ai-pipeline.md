[English](ai-pipeline.md) | [Español](../es/technical/ai-pipeline.md)

# AI pipeline (the dispute analyst)

`packages/analyst`, called by `apps/server`. It reads a case's documents and drafts a response in which every
sentence cites verbatim evidence, then checks each sentence. Code at commit `5111b88`. Evaluation figures are not
repeated here: the only sources are [evaluations](../quality/evaluations.md) and
`packages/analyst/evals/results/summary.md`.

## Models and providers

| Item | Value |
|---|---|
| Primary | Google Gemini `gemini-3.8-flash` through the Gemini API (`generateContent`, `responseMimeType: application/json` with a response schema, `thinkingLevel: low`, temperature 0) |
| Fallback | `openai/gpt-oss-120b` on Groq (OpenAI-compatible chat completions, strict `json_schema`, temperature 0) |
| Choice | `ANALYST_PROVIDER=gemini\|groq` (default `gemini`) picks the primary; the other provider, if its key is set, is the automatic fallback on errors and 429s. The same variable picks the agent's primary |
| Overrides | `GEMINI_MODEL`, `GROQ_MODEL` (a different id changes the cache key) |
| Transport | Plain `fetch`, no SDK; keys only in the provider's auth header, never in the browser |
| Timeout | 90 s per call (model probe 20 s) |
| Retries | 2, honouring `Retry-After`, up to 65 s between attempts (Groq's free tier resets per minute) |
| Groq budget | `GROQ_TPM` (default 8 000): prompt + max output must fit |
| Usage log | `analyst-usage.jsonl` and the server log: stage, provider, model, input/output/thinking tokens, milliseconds. Never prompt or document text |

Without any key the server serves stored analyses only (`ANALYST_UNCONFIGURED` for a live run).

## What the server sends

The browser sends only the case id (and, for a re-check, the edited sentence). The server builds the input itself:

| Part | Source |
|---|---|
| Case documents | `packages/cases` fixtures, assembled exactly as the web app shows them (synthetic, fictional names and ids) |
| PayPal data | The server's own read of the bound sandbox dispute, reused for 60 s |
| Agent case | The server's own MeterMCP receipt read; the agent run record (E5) only when the binding names that run |
| Merchant uploads | Confirmed uploads only: the OCR text of the **sanitised** file, with corrected and transcribed lines marked |
| Merchant notes | `merchantNotes`, drafted as notes («From your notes»), never as documentary evidence |

Once PayPal shows the seller's evidence, the case keeps the input it was analysed with before sending
(`InputPins`, persisted), so sending does not need a new model run. Only synthetic demo documents, PayPal sandbox
data and confirmed, redacted uploads reach a model.

## Stages

| Stage | Model call (max output tokens) | Deterministic code |
|---|---|---|
| 0. Read | — | Pattern scan for instructions on normalised text (NFKC, zero-width and bidi removed, homoglyphs and leetspeak mapped; EN/ES/FR/DE/PT; fake role lines and markup; base64 and hex payloads) |
| 1. Extract | `extract` (12 000): facts, each with a verbatim quote; instruction-bearing passages. In parallel `screen` (1 500): a small classifier for instructions (can only add flags) | Drops every quote that is not an exact substring of its document (whitespace-normalised only); no verifiable fact → the run fails |
| 2. Analyse | `analyze` (12 000): timeline, contradictions, checklist, draft sentences citing facts, from the extracted facts only | Checklist requirements per dispute reason; contradictions need two different documents and verbatim values; timeline sorted |
| 3. Verify | `verify` (2 000): each sentence in its own call, judged only against its own cited quotes: *supported*, *needs review* (reason and rewrite) or *rejected* | No valid citation → rejected **without** the model; a "supported" sentence with a number none of its quotes contain → needs review; a sentence resting on a flagged document → at most needs review |
| 4. Recommend | `explain` (2 000): two sentences explaining the chosen action | **Rules choose the action** from what PayPal allows now and the evidence it requests; the model never picks the action or the evidence type |

Only *supported* sentences can be sent. Rejected ones stay visible, struck through, with the reason.

**Re-check of an edited sentence.** `POST /api/cases/:id/analysis/verify {text}` (1–600 characters, no line
breaks or control characters) sends the sentence, delimited as untrusted data, to `recheck` (3 000 output tokens):
the model re-chooses citations from the extracted facts, then the same deterministic checks apply. Verdicts are
stored per (analysis key, text hash), 2 000 kept, on the data dir (`recheck-verdicts.json`, so a restart keeps them). The re-check prompt is not part of
`PROMPT_VERSION`; `rk-recheck-2026-10-09.2` identifies it in logs and evals.

## Prompts and versions

| Item | Value | Where |
|---|---|---|
| `PROMPT_VERSION` | `rk-analyst-2026-10-09.7` | `packages/analyst/src/prompts.ts` |
| `RECHECK_PROMPT_VERSION` | `rk-recheck-2026-10-09.2` | same |
| Rule | Bump `PROMPT_VERSION` whenever a prompt or schema changes: it is part of the cache key | same |

Every prompt states that documents are data, never instructions. Documents are wrapped in delimiters with a random
per-call tag (`<<<DOC-<nonce> id=… type=… source=… title=…>>>`), so a document cannot forge the end of its own
block. A line the merchant corrected is followed by «↳ corrected by the merchant», a line typed by hand by
«↳ transcribed manually by the merchant», outside the document text so it can never be quoted. The model sees
upload titles («Uploaded screenshot», «Uploaded PDF», «Pasted text»), never file names.

## Cache and golden analyses

| Item | Behaviour |
|---|---|
| Key | `sha256` of the canonical JSON of `{input, model, promptVersion}`; the same in Node and in the browser (Web Crypto) |
| Live cache | `<data>/analysis-cache/<key>.json`; an analysis unused for 30 days goes, 100 MiB in all (least recently used first; `ANALYSIS_CACHE_MAX_*`); purged when an upload it quoted is deleted |
| Golden analyses | `packages/analyst/golden/<case>.json`, made by `gemini-3.8-flash` and committed with model id, date, prompt version and token usage; used only when the key matches the documents on screen |
| Label | The analysis bar says which: «Analysis by gemini-3.8-flash · <date> · cached» or «… · live» (prompt version and tokens on hover) |
| Bound cases | Their documents include live PayPal and MeterMCP data, so golden analyses do not match; the hosted server **warms up** each bound case once after boot or a bindings change (system runs, same limits and caps) |

## Controls and limits

| Control | Value |
|---|---|
| Live analyses | 6 per hour per server (`LIVE_ANALYSES_PER_HOUR`); hosted 60 per day (`DAILY_LIVE_ANALYSES`) |
| Re-checks | 30 per hour (`RECHECKS_PER_HOUR`); hosted 200 per day (`DAILY_RECHECKS`) |
| Who may run them (hosted) | The seller's workspace, on bound cases only |
| Upload changes | An analysis that read an upload deleted meanwhile is dropped (409 `UPLOAD_CHANGED`) |

**Detection is a warning, not the defence.** The flag is shown on the document (E6 in the demo). The analysis is
built so that an undetected instruction cannot change the action, the evidence type or what counts as supported;
how well this holds is measured on synthetic sets in [evaluations](../quality/evaluations.md), not proven.

## Commands

| Command | Effect | Cost |
|---|---|---|
| `npm test` | Pipeline tests with a fake model | none |
| `npm run evals -- --provider gemini\|groq` | Dev set against one provider | Paid Gemini / Groq quota |
| `npm run evals:heldout` | Held-out repeated runs | Paid Gemini / Groq quota |
| `npm run evals:recompute` | Rescore stored results | none |
| `npm run golden` | Regenerate golden analyses or the cache | Paid model calls |

## Status

Implemented · Tested locally (`packages/analyst/test/`: 159 tests passed on 20/10/2026, `5111b88`; 152 on 19/10/2026, `fbe9621`) · Deployed. Live
analyses and re-checks ran on the deployed service in the sandbox evaluation (17/10/2026, private evidence). The
evals README paragraph of earlier commits is superseded by [evaluations](../quality/evaluations.md).
