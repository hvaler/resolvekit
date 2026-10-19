[English](SECURITY.md) | [Español](SECURITY.es.md)

# Security policy

ResolveKit is a hackathon project: a public demo on the PayPal **sandbox** (no real money), not a production service.
No live PayPal environment is used.

## Reporting a vulnerability

**There is no dedicated security channel yet** (no security email, no bug bounty). GitHub private vulnerability
reporting for this repository is not confirmed as enabled (**Pending**).

Until one exists:

1. **Do not open a public issue with details** of a vulnerability, and do not include exploit code, tokens, invite
   links or personal data in any public place.
2. Contact the repository owner through their GitHub profile (the owner of this repository on GitHub) and ask for a
   private channel. Share the details only once one is agreed.
3. Say what you found, how to reproduce it against the sandbox demo or a local run, and what it affects.

We will acknowledge what we can, as soon as we can; we make no promise of response times. Please test only against
your own local run or the public demo within its limits: do not send evidence to disputes that are not yours, do not
try to exhaust the shared daily caps, and do not use real PayPal accounts or real customer data.

## Scope

In scope: the code in this repository (`apps/server`, `apps/metermcp`, `apps/web`, `packages/*`) and the hosted demo
built from it. Out of scope: PayPal, Google Gemini, Groq and Render themselves (report to them), and findings that
need a compromised operator machine or Render account.

## What to read first

- [Security and privacy](docs/quality/security-and-privacy.md): the controls, their tests and the residual risks.
- [Trust boundaries](docs/architecture/trust-boundaries.md): what is trusted, and where.
- [Known issues](docs/quality/known-issues.md): open items already known.

## Supported versions

Only the current `main` branch. There are no releases or backports.
