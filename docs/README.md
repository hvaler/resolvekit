[English](README.md) | [Español](es/README.md)

# ResolveKit documentation

Start from your role. Every page uses the same status words: Designed · Implemented · Tested locally · Verified in
sandbox · Deployed · Available to users · Pending. The project overview is the [README](../README.md).

## Judges and reviewers

| Page | What it answers |
|---|---|
| [Review guide](judges/review-guide.md) | What to look at in about 5 minutes, what is real, how to get in, what to do if a case is used |
| [Demo walkthrough](judges/demo-walkthrough.md) | Every step with the exact names of the controls |
| [Verification matrix](judges/verification-matrix.md) | Each public claim, its evidence and its status, unsupported claims marked |

## Merchants and users

| Page | What it answers |
|---|---|
| [Product overview](product/overview.md) | What ResolveKit does and for whom |
| [Getting started](user-guide/getting-started.md) | The three environments and how to enter each |
| [Cases and evidence](user-guide/cases-and-evidence.md) | The case file, citations, contradictions, adding your own evidence |
| [PDF review](user-guide/pdf-review.md) | Choosing pages, covering, reading again, transcribing |
| [Review and submit](user-guide/review-and-submit.md) | Approving exact content, sending, reading back |
| [Buying agent](user-guide/buying-agent.md) | Goals, budgets, approval in PayPal, receipts, Compare and Keep |
| [Accounts and permissions](user-guide/accounts-and-permissions.md) | Continue with PayPal, invites, passkeys, roles |
| [Troubleshooting](user-guide/troubleshooting.md) | Messages you may see and what to do |
| [Limitations](product/limitations.md) | What does not work, or is not available yet |
| [Functional specification](product/functional-specification.md) | Behaviour in detail, screen by screen |

## Developers

| Page | What it answers |
|---|---|
| [Local development](technical/local-development.md) | Install, run, test |
| [Configuration](technical/configuration.md) | Every environment variable |
| [HTTP API](technical/http-api.md) | Routes, guards, errors |
| [MCP tools](technical/mcp-tools.md) | MeterMCP's tools, prices, admin routes |
| [PayPal integration](technical/paypal-integration.md) | Endpoints called, what is documented, what was only observed in the sandbox |
| [Merchant onboarding](technical/merchant-onboarding.md) | Status of connecting merchants' own disputes (Pending) |
| [AI pipeline](technical/ai-pipeline.md) | Analyst steps and deterministic checks |
| [Buying agent](technical/buying-agent.md) | Engine, validation, limits, settlement |
| [Evidence processing](technical/evidence-processing.md) | Images, PDFs, OCR, sanitised files |
| [Architecture overview](architecture/overview.md) · [Components](architecture/components.md) · [Data and storage](architecture/data-and-storage.md) · [Trust boundaries](architecture/trust-boundaries.md) | How the parts fit and where trust stops |
| [Contributing](../CONTRIBUTING.md) | How to propose changes |

## Operators

| Page | What it answers |
|---|---|
| [Deployment](operations/deployment.md) | Render Blueprint, secrets, order of deploys |
| [Runbook](operations/runbook.md) | `demo:check`, `demo:prepare`, reserves, caps |
| [Backup and recovery](operations/backup-and-recovery.md) | What exists (and what does not) |
| [Retention and deletion](operations/retention-and-deletion.md) | How long each kind of data is kept |

## Quality and security

| Page | What it answers |
|---|---|
| [Testing](quality/testing.md) | Test suites and the latest dated run |
| [Evaluations](quality/evaluations.md) | Analyst evaluations on synthetic sets: the only source of evaluation figures |
| [Security and privacy](quality/security-and-privacy.md) | Measures and their limits |
| [Known issues](quality/known-issues.md) | Open follow-ups |
| [Security policy](../SECURITY.md) | How to report a vulnerability |

## Older pages

These addresses keep working and point to the new pages: [judges.md](judges.md) → review guide,
[evals.md](evals.md) → evaluations, [sandbox-findings.md](sandbox-findings.md) → PayPal integration.
Screenshots and their captions: [media](media/README.md).
