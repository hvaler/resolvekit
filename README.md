# ResolveKit

**Evidence-first PayPal dispute workspace for small merchants.** For each PayPal dispute, ResolveKit builds a
case file (timeline + evidence), an AI analyst drafts a response in which every sentence cites its evidence,
unsupported sentences are rejected, and the merchant approves before anything is sent to PayPal. After sending,
ResolveKit re-reads the dispute and shows what PayPal actually recorded.

> Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) (October–November 2026).
> **Status: early development.** This README grows with the project.

## How PayPal is used

ResolveKit runs on the PayPal **Customer Disputes API (v1)** against the free sandbox:

| Capability | Endpoint | Why |
|---|---|---|
| Find the dispute for a payment | `GET /v1/customer/disputes?disputed_transaction_id={capture}` | Link the dispute to the order and its evidence |
| Read the dispute | `GET /v1/customer/disputes/{id}` | Reason, stage, status, **evidence PayPal requests from the seller**, allowed actions |
| Submit evidence | `POST /v1/customer/disputes/{id}/provide-evidence` (multipart: JSON + files) | Send the approved response with its documents |
| Message the buyer | `POST /v1/customer/disputes/{id}/send-message` | Answer in the inquiry stage |
| Accept the claim | `POST /v1/customer/disputes/{id}/accept-claim` | When the evidence does not support a defence |
| Refunds | `POST /v2/payments/captures/{id}/refund` | Partial or full refunds |

Every behaviour above was verified in the sandbox before building on it. See
[`docs/sandbox-findings.md`](docs/sandbox-findings.md).

## Principles

1. **Nothing is claimed without evidence.** Every sentence links to its source; unsupported sentences are not sent.
2. **The merchant has the final say.** Submitting evidence is irreversible in PayPal, so nothing is sent without
   explicit approval.
3. **What you see is what PayPal recorded.** After any action the dispute is re-read from PayPal.

## Run

Requires Node.js 24+ (TypeScript runs natively, no build step).

```bash
cp .env.example .env   # PayPal sandbox app credentials
npm test
```

## AI tools

To be documented as the analyst is built: model, what it does, and how its output is checked.

## License

[MIT](LICENSE)
