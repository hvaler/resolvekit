[English](security-and-privacy.md) | [Español](../es/quality/security-and-privacy.md)

# Security and privacy

The controls ResolveKit implements, how they are tested, and the risks that remain. These are measures, not
guarantees. For the trust boundaries as a design, see [Trust boundaries](../architecture/trust-boundaries.md); to
report a vulnerability, see [SECURITY.md](../../SECURITY.md).

Status words follow the project vocabulary. Unless a row says otherwise: **Implemented · Tested locally** (fake
PayPal, fake model) at `c12faea`, deployed on the sandbox demo.

## Literal validity is not semantic support

Two different checks, often confused:

| Check | Who decides | What it proves | What it does not prove |
|---|---|---|---|
| **Literal validity** of a quote | Deterministic code (`isVerbatim`): the quote must be an exact substring of its document, whitespace-normalised only | The words are really in that document | That the claim built on them is true, or that the document is authentic |
| **Semantic support** of a sentence | A separate model call per sentence, given only that sentence's quotes, then rules | The verifier judged the cited lines to support the sentence | Truth. A model can misjudge; a true sentence can go to *needs review* |

Around them, deterministic rules: a claim with no valid citation is removed without asking a model; numbers that do not
appear in the quotes send a sentence to *needs review*; a sentence resting on a document flagged for injection is
capped at *needs review*; the PayPal action and evidence type are chosen by rules, not by the model. Only *supported*
sentences can be sent, and nothing is sent without the merchant's approval. «100% citation validity» in the
[evaluations](evaluations.md) is a literal-validity figure.

Lines a person corrected or transcribed by hand are attributed in two parts: the upload record keeps who did it
(`correctedBy` / `by`, the person's label), and the analyst sees a fixed marker on its own line, outside the document
text and never quotable («↳ corrected by the merchant» / «↳ transcribed manually by the merchant»). A sentence
resting on such a line needs explicit confirmation before it can be
sent.

## Prompt injection

Every document (fixtures, PayPal data, merchant uploads, the buyer's messages) is untrusted text.

| Layer | What it does |
|---|---|
| Delimiting | Documents are wrapped in delimiters with a random per-call tag |
| Detection (flags only) | A pattern scan on normalised text (English, Spanish, French, German, Portuguese; zero-width and homoglyph folding; base64/hex payloads decoded), the extraction model's own flags, and a classifier call. Any signal adds a flag; none clears one |
| Containment (does not rely on detection) | The verbatim rule, per-sentence verification, the cap on flagged documents, rule-chosen actions, and merchant approval |
| Edited sentences | A re-check accepts 1–600 characters, no line breaks or control characters, sent as delimited untrusted data |
| The buying agent | The model chooses among offered tools only; code validates every call (one action per turn, schema, price within the remaining budget); MeterMCP meters. `open_budget`, `close_session` and `get_receipt` are never offered to the model |

Tests: `packages/analyst/test/injection.test.ts` (every bypass variant flagged; normalisation undoes evasion; a flagged
document's sentence is never supported automatically; *undetected injection: outcome unchanged, no unsupported claim
passes*). Evaluations: 10 injection variants on the development set and 3 attacks on the held-out set
([Analyst evaluations](evaluations.md), sections 4–5).

**Residual risk:** a sentence that cites the injected text itself is judged by a model that reads that quote. The
held-out forbidden-outcome check is pattern-based and sees only the paraphrases its author listed.

## Untrusted files

Merchant uploads are hostile input. Covered (redacted) content must not reach anything downstream.

| Control | Detail | Tests |
|---|---|---|
| Type by content | PNG/JPEG decided by magic bytes, whatever the name; GIF, PDF-as-image, random bytes refused | `uploads-image.test.ts` |
| Size before decoding | 5 MiB per image; at most 4096 px a side and 8 294 400 pixels; interlaced PNGs, double `IHDR`, bad bit depths and `IDAT` that inflates past its declared size refused; an absolute inflate cap | `uploads-image.test.ts` |
| Re-encoding | Every stored image is a fresh, opaque PNG with only `IHDR`, `IDAT` and `IEND` (a covered JPEG photo: a fresh baseline JPEG, quality 90, JFIF header only, no EXIF or comments); transparent pixels composited onto white; covered pixels black whatever the OCR read, set before encoding (two photos that differ only under a cover give the same bytes) | `uploads-image.test.ts`; verified in the sandbox on 18/10 (PayPal's copy had only those chunks, the cover burned in) |
| PDFs in a separate process | pdf.js runs in a forked child (160 MB heap), killed at its deadline and, on Linux, above 200 MiB RSS; encrypted PDFs refused; ≤10 MiB, ≤30 pages; metadata never decoded | `uploads-pdf-input.test.ts` (hang, crash, spawn failure, memory ceiling, decompression bombs in content and fonts). **RSS kill on Linux against a real bomb: Pending** |
| Rebuilt PDF | At confirm the PDF is rebuilt as image-only pages from the covered renders: no fonts, annotations, embedded files, JavaScript or XMP. The original and uncovered renders are dropped | `pdf-image.test.ts` |
| OCR | tesseract.js with local language data, no network fetch, on the **sanitised** image or page only | `uploads-ocr.test.ts` |
| PDF text-layer hint | Shown during review only; never stored or logged; read once per page per review | `uploads-pdf-routes.test.ts` |
| Transcription | Must come from a visible area inside the page (≥2×2 px); refused over a covered area | `uploads-pdf-routes.test.ts` |
| Pasted text | Latin-1 only, control characters replaced, removals become `[redacted]`, stored as a ResolveKit-made PDF; ≤20 000 characters | `uploads-text.test.ts` |
| Content-bound confirm | The SHA-256 of the sanitised file the person reviewed must match | `uploads-routes.test.ts` |
| File names | Never leave the server: PayPal gets `E<n>-upload.png` (`.jpg` for a covered photo), `E<n>-upload.pdf` or `E<n>-pasted.pdf`; the model sees titles only | `uploads-documents.test.ts`; sandbox 18/10 (image) |
| Pending access | Until confirmed, only people who can edit see files and text; others get metadata with `restricted: true` | `uploads-routes.test.ts` |

**Covered-content recovery test.** `apps/server/test/uploads-pdf-recovery.test.ts` builds a PDF holding six distinct
secrets: a visible line that gets covered, white text, the document info dictionary, XMP metadata, an annotation and an
embedded file. It uploads, covers and confirms it, and asserts that **none** of them reaches the rebuilt PDF, its page
image, the analysis, the request to PayPal, the logs or the audit. A second test checks that 8 pt account and tracking
numbers are still read exactly at the render resolution. Barcodes and QR codes are not decoded; the PDF review warns
about them.

## Isolation

| Boundary | Control | Tests |
|---|---|---|
| Workspaces | Case routes (`/api/disputes/<case>…`, `/api/cases/<case>/analysis…`, `/api/cases/<case>/uploads…`) answer only bound cases and only the seller's workspace; anyone else gets `404 UNKNOWN_CASE` before any work. Before composing and before sending, the person's workspace merchant id must be the dispute's seller (`403 NOT_THE_SELLER`) | `environments.test.ts`, `sellers.test.ts`, `auth.test.ts` (*only the seller's workspace answers the dispute…*), `uploads-pdf-routes.test.ts` (*another workspace, a signed-out visitor or an unbound case get 404*) |
| Analysis progress and caches | `/progress` answers only the seller's workspace, also after a restart; cache keys are SHA-256 of (input, prompt, model); the input is built by the server, never taken from the browser | `hosted.test.ts` (*cross-tenant…*), `analysis.test.ts` |
| Intents | An intent belongs to its session: another person, a teammate included, cannot read, approve, cancel or send it (404); another session's edits do not invalidate it; floods are bounded per session and per address | `intent-sessions.test.ts`, `review-fixes.test.ts` |
| Agent runs | The author sees their runs; an Owner sees the workspace's only with `?scope=workspace` (logged; approval link, order and session hidden); another workspace's run is 404 even for an Owner | `agent-routes.test.ts` |
| Agent ↔ MeterMCP | Private `/agent/mcp` needs the admin token and `x-agent-run: run-<32 hex>`; the session is bound to that run; not reachable through the public proxy | `apps/metermcp/test/hosted.test.ts` |
| MCP sessions | An MCP session reaches only its own payment session (`apps/metermcp/src/mcp.ts`) | No dedicated test identified for this page |
| Run records on cases | The «Agent run record» evidence appears only when the case's binding names that run and its session matches | `agent.test.ts` |
| Documents | Attachments: only confirmed uploads of this workspace, case and active dispute; bytes re-hashed at send | `intent.test.ts`, `uploads-routes.test.ts` |

Multi-merchant isolation is untested in practice: only one seller workspace is connected (merchant connection is
**Pending**), so the cross-workspace tests use test fixtures, not several real merchants.

## Sending and sign-in

- Sending: the server composes the intent; approval is by content hash, owner session only, 30-minute TTL; any edit,
  newer intent or binding change invalidates it; the send re-reads PayPal and refuses on any difference; one
  `PayPal-Request-Id` per intent; a per-dispute lock; a durable audit entry before anything goes to PayPal. Details:
  [HTTP API](../technical/http-api.md).
- Dispute actions (Deployed; Verified in sandbox through the app, not yet exercised on the hosted service): the same chain, plus the role checked at compose, approve, confirm
  and send (accept, offer and escalate are the Owner's only, `403 OWNER_ONLY`); a second confirmation bound to the
  intent id, content hash, action, canonical amount, currency and consequence; amounts as exact decimal strings, never
  floats; a dispute held after any send whose outcome PayPal does not prove, until a read-back settles it; no automatic
  retry of an action POST; «Recorded by PayPal» only on an entry attributable to the send, never on a state change
  alone. No variant is offered without a recorded contract
  ([functional specification](../product/functional-specification.md#56-dispute-actions-other-than-evidence)).
- Webhooks: a secret URL key, header checks, a certificate-host allowlist, body and rate caps, verification with
  PayPal's documented postback method on the raw body; the payload is only a hint, the dispute is re-read.
- **Continue with PayPal** is an identity check built on a no-charge Billing Agreements v1 agreement token (a
  deprecated API family), not Log in with PayPal or OpenID. It grants ResolveKit no access to the merchant's disputes.
  Tied to the browser that started it; one attempt per token.
- Sessions: `HttpOnly; Secure; SameSite=Strict` cookies, HMAC-signed, 12 h; revocation and **Sign out of all devices**
  end every session of the person.
- Hosted guards: Host allowlist, own `Origin` for state-changing requests, JSON-only POST, security headers (CSP,
  HSTS, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`). Per-address limits are a courtesy, not
  the boundary: the signed-in person, their workspace and the global caps are.
- Hosted mode refuses to start on live PayPal without an explicit opt-in that the blueprint never sets.

## Privacy

- **What reaches the model providers** (Google Gemini; Groq as fallback): the documents of the case being analysed —
  synthetic demo documents, PayPal **sandbox** dispute data for bound cases, the MeterMCP receipt for the agent case,
  and the sanitised text of confirmed merchant uploads — and, for a re-check, the edited sentence. Not file names, not
  covered content, not secrets. Their handling of that data is governed by each provider's terms, not by ResolveKit.
- **What is stored**: see [Retention and deletion](../operations/retention-and-deletion.md). Personal data held:
  PayPal payer ids, display names, masked emails, passkey public keys, invite token hashes (`accounts.json`), approved
  notes texts and approved message texts (`intents.json`; a message is kept like evidence notes, for as long as its
  intent's record), uploads. The PayPal message thread is shown from each read but not stored, and never given to the
  analyst. There is no account deletion or export feature (**Pending**).
- **Logs** carry ids, codes, counts and timings; never document text, file contents, keys or tokens. The audit and
  send logs record a message only by the SHA-256 of its text (a short text can be guessed from its hash; the logs are
  server-only). The analyst usage
  log holds token counts and timings only.
- **Secrets** come from environment variables only; no `VITE_*` variable is read, so nothing secret reaches the web
  bundle. `.env` is git-ignored.
- Examples in these docs use fictional ids.

## Residual risks and gaps

- Semantic support is a model judgement; true notes often go to *needs review* (held-out: 17 of 66 supported) and a
  misjudged sentence is possible. The merchant's approval is the last control.
- Injection detection can miss (the pattern scan missed one held-out attack in every run); containment does not
  depend on it, but a sentence citing the injected text is still judged by a model.
- Verbatim quotes say nothing about a document's authenticity: a forged upload quoted exactly is still forged.
- OCR can misread; corrected and transcribed lines rest on the person's word and are labelled so.
- Barcodes and QR codes in uploads are not decoded or covered automatically (the PDF review shows a warning).
- Linux-only protections (RSS kill) are not measured on the hosted platform; memory with large PDFs on Render is not
  measured.
- The sign-in relies on a deprecated PayPal API family and may stop working.
- Dispute actions rest on one sandbox write per variant (20/10/2026); PayPal may behave differently on other disputes,
  reasons or stages, and in production. The approved message text sits on the server's disk with the intents.
- No external security audit or penetration test is recorded. Internal reviews are recorded in the maintainers' follow-up lists.
- See [Known issues](known-issues.md) for the open items.
