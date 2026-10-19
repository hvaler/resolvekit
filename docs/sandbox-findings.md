[English](sandbox-findings.md) | [Español](es/sandbox-findings.md)

# PayPal sandbox findings (moved)

This page moved. The findings are now in
[PayPal integration → Sandbox findings](technical/paypal-integration.md#sandbox-findings), next to the endpoints they
shaped and kept apart from PayPal's documented rules.

What it held, with its dates:

- **08/10/2026**: findings verified by hand in the PayPal sandbox (dispute lookup by capture, about 5 minutes for a
  new dispute to appear, `UNDER_REVIEW` first, requested evidence, the evidence type PayPal accepts for "not
  received", buyer-declared item type, multipart `provide-evidence`, the `provide_evidence` action disappearing after
  one submission, a partial refund done by hand).
- **09/10/2026**: an end-to-end submission through ResolveKit and its read-back.

Two lines of the old table are corrected there: ResolveKit has no refund action (the refund was a manual sandbox
observation), and only **Provide evidence** is built among the inquiry-stage actions.
