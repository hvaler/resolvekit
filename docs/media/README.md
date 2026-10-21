# Devpost images

Screenshots of the real app (1500×1000 PNG, 3:2, light theme, recording mode: no Dev panel). Images 1–4 and the
thumbnail run on the in-browser simulator with the committed golden analysis (real `gemini-3.8-flash` output) on the
synthetic demo case; 5 and 6 are real PayPal sandbox disputes read through the local server on 9 Oct 2026.

| File | Caption |
|---|---|
| `thumbnail.png` | ResolveKit case file: timeline, cited evidence, response draft. Synthetic demo case, simulated PayPal. |
| `01-inbox.png` | Dispute inbox on AG Grid: due dates, readiness, saved filters, totals. Demo data. |
| `02-case-file.png` | Hover a citation: the exact words light up. Unsupported sentence struck, never sent. Demo data. |
| `03-contradiction.png` | Order says Apt 4, carrier says Apt 4B: shown side by side, neutrally. Demo data. |
| `04-approve-ledger.png` | Before sending: every claim beside its proof, exactly what goes to PayPal. Simulated PayPal. |
| `05-recorded-by-paypal.png` | Real sandbox dispute re-read after sending: evidence recorded by PayPal, buyer's turn. |
| `06-agent-metermcp-receipt.png` | Agent purchase: real MeterMCP receipt, failed call not charged, real sandbox dispute. |

Notes: in 5 the bound sandbox dispute is for 1.37 USD while the demo order is 7.00 USD, and the app says so
("Demo binding mismatch"). In 6 the failed call is injected by MeterMCP's test switch, and the tool outputs are
synthetic; the budget, capture and dispute are real sandbox records.

## Brand

| File | Use |
|---|---|
| `brand/banner-light.png`, `brand/banner-dark.png` | README header (2560×640), chosen by the reader's colour scheme. The draft card is illustrative: a struck sentence is one without evidence, never sent. |
| `brand/logo.svg` | The mark (same shape as the web app's favicon), teal `#0E5E61`, `#5BBDB8` in dark mode. |
